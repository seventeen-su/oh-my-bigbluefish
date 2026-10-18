/**
 * 状态机行为测试（R10 §12 的 AT-4/5/7/9/10/11/12 + 新增宿主 tree id / 守卫 / 持久化）。
 *
 * 全部用**假时钟 / 假宿主事件 / 假 git / 内存 fs**：不碰真实仓库、不跑子进程。
 * 每条断言都对应一个可判死的机制——测试绿而生产不生效是审计里记过的老问题。
 */
import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SESSION_STATE_CONFIG,
  MAX_SESSION_FILES,
  SESSION_STATE_SERVICE,
  createSessionStateMachine,
  formatGap,
  normalizePath,
  parsePorcelainV2Paths,
  pathOfArguments,
  renderNotice,
  wireEditGuard,
  type GitResult,
  type SessionStateConfig,
  type SessionStateEvent,
  type SessionStateMachine,
  type StateFs,
  type WorkspaceChangesLike,
  type WorkspaceChangesSummaryLike,
} from '../../dsh/state-machine.js'

class FakeClock {
  t = 1_000_000
  now(): number {
    return this.t
  }
  advance(ms: number): number {
    this.t += ms
    return this.t
  }
}

interface GitState {
  head: string
  branch?: string
  status: string
  ok?: boolean
}

function fakeGit(initial: GitState): {
  run: (cwd: string, args: readonly string[]) => GitResult
  state: GitState
  calls: number
} {
  const holder = { state: { ...initial }, calls: 0 }
  return {
    get state() {
      return holder.state
    },
    get calls() {
      return holder.calls
    },
    run: (_cwd, args) => {
      holder.calls += 1
      if (holder.state.ok === false) return { ok: false, stdout: '', error: 'not a git repository' }
      const joined = args.join(' ')
      if (joined.startsWith('rev-parse HEAD')) return { ok: true, stdout: `${holder.state.head}\n` }
      if (joined.startsWith('rev-parse --abbrev-ref')) {
        return { ok: true, stdout: `${holder.state.branch ?? 'main'}\n` }
      }
      if (joined.startsWith('status --porcelain=v2')) return { ok: true, stdout: holder.state.status }
      return { ok: false, stdout: '', error: `unexpected git args: ${joined}` }
    },
  }
}

interface MemFs extends StateFs {
  files: Map<string, string>
  dirs: Set<string>
  failWrites: boolean
}

function memoryFs(): MemFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const state = { failWrites: false }
  const api: MemFs = {
    files,
    dirs,
    get failWrites() {
      return state.failWrites
    },
    set failWrites(value: boolean) {
      state.failWrites = value
    },
    readFileSync: file => {
      const value = files.get(file)
      if (value === undefined) throw new Error(`ENOENT ${file}`)
      return value
    },
    writeFileSync: (file, data) => {
      if (state.failWrites) throw new Error('EACCES simulated')
      files.set(file, data)
    },
    renameSync: (from, to) => {
      const value = files.get(from)
      if (value === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from)
      files.set(to, value)
    },
    mkdirSync: dir => {
      dirs.add(dir)
    },
    existsSync: path => files.has(path) || dirs.has(path),
    readdirSync: dir => [...files.keys()].filter(file => dirname(file) === dir).map(file => file.slice(dir.length + 1)),
    statSync: () => ({ mtimeMs: 0 }),
    unlinkSync: file => {
      files.delete(file)
    },
  }
  return api
}

function machine(options: {
  clock: FakeClock
  git?: ReturnType<typeof fakeGit>
  cwd?: string
  summaries?: (sessionId: string, seq: number) => WorkspaceChangesSummaryLike | undefined
  fs?: MemFs
  stateDir?: string
  persist?: boolean
  config?: Partial<SessionStateConfig>
}): SessionStateMachine {
  const summaries = options.summaries
  const workspaceChanges: (() => WorkspaceChangesLike) | undefined = summaries === undefined
    ? undefined
    : () => ({ summary: summaries })
  return createSessionStateMachine({
    clock: options.clock,
    cwdOf: options.cwd === undefined ? undefined : () => options.cwd,
    git: options.git?.run,
    stateDirOf: options.stateDir === undefined ? undefined : () => options.stateDir,
    fs: options.fs,
    workspaceChanges,
    config: {
      persist: options.persist === true,
      persistMinIntervalMs: 0,
      epochRefreshMs: 0,
      epochTtlMs: 0,
      ...options.config,
    },
  })
}

function event(
  sessionId: string,
  type: string,
  at: number,
  data?: unknown,
  seq?: number,
): SessionStateEvent {
  return { sessionId, type, at, ...(data === undefined ? {} : { data }), ...(seq === undefined ? {} : { seq }) }
}

const S1 = 'session-1'

describe('纯函数：Epoch 解析与通知行', () => {
  it('porcelain v2 路径解析（普通/改名/未跟踪/跳过原路径）', () => {
    const out = [
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
      'src/old.ts',
      '? notes.txt',
    ].join('\u0000')
    expect(parsePorcelainV2Paths(out)).toEqual(['src/a.ts', 'src/new.ts', 'notes.txt'])
  })

  it('路径归一化与工具参数提取只认明确字段', () => {
    expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts')
    expect(pathOfArguments({ arguments: '{"path":"D:\\\\repo\\\\a.ts"}' })).toBe('D:/repo/a.ts')
    expect(pathOfArguments({ arguments: { file_path: 'a.ts' } })).toBe('a.ts')
    expect(pathOfArguments({ arguments: '{bad json' })).toBeUndefined()
    expect(pathOfArguments({ arguments: { patch: '***' } })).toBeUndefined()
  })

  it('通知行字段顺序固定、空字段省略、超长从尾部丢字段且绝不超上限', () => {
    const line = renderNotice('e12345678', {
      gapMs: 26 * 3_600_000 + 14 * 60_000,
      headFrom: 'abc1234567',
      headTo: 'def5678901',
      branch: 'feature/very-long-branch-name-here',
      externalChanges: 7,
      interruptedAtTurn: 12,
      openGoals: 2,
      deepStale: true,
      degraded: false,
    }, 120)
    expect(line.startsWith('[OMB] e12345678 距上次 1d2h')).toBe(true)
    expect(line).toContain('HEAD abc1234→def5678')
    expect(line).toContain('外部改动 7')
    expect(line).toContain('上次回合中断@12')
    expect(line).toContain('未闭合目标 2')
    expect(line.length).toBeLessThanOrEqual(120)
    expect(formatGap(7 * 60_000)).toBe('7m')
    expect(formatGap(2 * 3_600_000)).toBe('2h')
  })

  it('服务名是唯一字面量（Lead 接 SERVICES.sessionState 前）', () => {
    expect(SESSION_STATE_SERVICE).toBe('omb:session-state')
  })
})

describe('空闲分级与恢复（AT-4 / AT-5）', () => {
  it('5min/1h/24h 三档分级；长间隔产出恰好一行，取走后为 null', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc1234', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now()))
    expect(m.port.snapshot(S1)?.tier).toBe('fresh')
    expect(m.port.consumeNotice(S1)).toBeNull()

    clock.advance(6 * 60_000)
    m.port.observe(event(S1, 'turn/start', clock.now()))
    expect(m.port.snapshot(S1)?.tier).toBe('idle')
    expect(m.port.snapshot(S1)?.state).toBe('recovering')
    const idleLine = m.port.consumeNotice(S1)
    expect(idleLine).toContain('距上次 6m')
    expect(m.port.consumeNotice(S1)).toBeNull()

    clock.advance(2 * 3_600_000)
    m.port.observe(event(S1, 'turn/start', clock.now()))
    expect(m.port.snapshot(S1)?.tier).toBe('stale')

    clock.advance(26 * 3_600_000)
    m.port.observe(event(S1, 'turn/start', clock.now()))
    expect(m.port.snapshot(S1)?.tier).toBe('deep-stale')
    const deepLine = m.port.consumeNotice(S1) ?? ''
    expect(deepLine).toContain('结论可能过期')
    expect(deepLine.length).toBeLessThanOrEqual(120)
    m.dispose()
  })

  it('无变化时 0 字节：10 个 step 也不产出通知', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    for (let step = 0; step < 10; step += 1) {
      clock.advance(1_000)
      m.port.observe(event(S1, 'step/start', clock.now(), { step }))
      m.port.observe(event(S1, 'step/end', clock.now(), { step }))
      m.port.observe(event(S1, 'tool/result', clock.now(), { ok: true }))
    }
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    expect(m.port.consumeNotice(S1)).toBeNull()
    expect(m.port.snapshot(S1)?.state).toBe('active')
    m.dispose()
  })

  it('恢复窗口在首个成功 tool/result 或 step/end 后回到 active（AT-4 后半）', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now()))
    clock.advance(6 * 60_000)
    m.port.observe(event(S1, 'turn/start', clock.now()))
    expect(m.port.snapshot(S1)?.state).toBe('recovering')
    m.port.observe(event(S1, 'tool/result', clock.now(), { ok: true }))
    expect(m.port.snapshot(S1)?.state).toBe('active')
    m.dispose()
  })
})

describe('外部改动：宿主 tree id 优先（零 subprocess），git 仅回退', () => {
  it('workspace/changes + summary：epoch 来自 tree id，不调用 git', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const summaries = (_id: string, seq: number): WorkspaceChangesSummaryLike | undefined => seq === 5
      ? { turn: 1, cwd: 'C:/repo', files: [], total: 0, snapshot: { before: 'tree-a', after: 'tree-b' } }
      : undefined
    const m = machine({ clock, git, cwd: 'C:/repo', summaries })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    const callsBefore = git.calls
    m.port.observe(event(S1, 'workspace/changes', clock.now(), { turn: 1 }, 5))
    const snapshot = m.port.snapshot(S1)
    expect(snapshot?.epoch?.source).toBe('host')
    expect(snapshot?.epoch?.treeAfter).toBe('tree-b')
    expect(git.calls).toBe(callsBefore)
    m.dispose()
  })

  it('上一回合 after ≠ 本回合 before → 外部改动；本回合未归因文件也计入', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const summaries = (_id: string, seq: number): WorkspaceChangesSummaryLike | undefined => {
      if (seq === 5) {
        return { turn: 1, cwd: 'C:/repo', files: [], total: 0, snapshot: { before: 'a', after: 'b' } }
      }
      if (seq === 9) {
        return {
          turn: 2,
          cwd: 'C:/repo',
          files: [{ path: 'src/user.ts', display: 'src/user.ts' }, { path: 'src/ours.ts', display: 'src/ours.ts' }],
          total: 2,
          snapshot: { before: 'b', after: 'c' },
        }
      }
      return undefined
    }
    const m = machine({ clock, git, cwd: 'C:/repo', summaries })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    m.port.observe(event(S1, 'workspace/changes', clock.now(), { turn: 1 }, 5))
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'edit', arguments: { path: 'src/ours.ts' } }))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 2, reason: 'completed' }))
    m.port.observe(event(S1, 'workspace/changes', clock.now(), { turn: 2 }, 9))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 3 }))
    const line = m.port.consumeNotice(S1)
    // 回合之间 tree 变了（b→b 不变；这里 before=b 与上一 after=b 相同）→ 只剩未归因文件 1
    expect(line).toContain('外部改动 1')
    m.dispose()
  })

  it('无宿主事件时回退 git：HEAD/dirty 变化进通知；git 调用有界', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc1234', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    const before = git.calls
    git.state.head = 'def5678'
    git.state.status = '? new.ts\u0000'
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    const line = m.port.consumeNotice(S1)
    expect(line).toContain('HEAD abc1234→def5678')
    expect(line).toContain('外部改动 1')
    expect(git.calls - before).toBeLessThanOrEqual(6)
    m.dispose()
  })

  it('非 git 仓库：degraded + "无git" + "数据不确定"，绝不抛（AT-9）', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: '', status: '', ok: false })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    expect(() => m.port.observe(event(S1, 'turn/start', clock.now()))).not.toThrow()
    expect(m.port.snapshot(S1)?.flags.degraded).toBe(true)
    expect(m.port.workspaceEpoch('C:/repo').degraded).toBe(true)
    clock.advance(26 * 3_600_000)
    m.port.observe(event(S1, 'turn/start', clock.now()))
    const line = m.port.consumeNotice(S1)
    expect(line).toContain('无git')
    expect(line).toContain('数据不确定')
    m.dispose()
  })
})

describe('目标台账与中断标记（R10 §6.1 / §7c）', () => {
  it('goal/todo 事件计数；goal 完成与 todo completed 不再计入', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now()))
    m.port.observe(event(S1, 'goal/change', clock.now(), { id: 'g1', objective: '修 tsc 报错', phase: 'open' }))
    m.port.observe(event(S1, 'todo/write', clock.now(), {
      todos: [{ id: 't1', status: 'pending' }, { id: 't2', status: 'in_progress' }, { id: 't3', status: 'completed' }],
    }))
    expect(m.port.snapshot(S1)).toMatchObject({ openGoals: 1, openTodos: 2, flags: { unresolved: true } })
    m.port.observe(event(S1, 'goal/change', clock.now(), { id: 'g1', phase: 'complete' }))
    m.port.observe(event(S1, 'todo/write', clock.now(), { todos: [{ id: 't1', status: 'completed' }] }))
    expect(m.port.snapshot(S1)).toMatchObject({ openGoals: 0, openTodos: 0, flags: { unresolved: false } })
    m.dispose()
  })

  it('turn/end abnormal → interrupted 标记；下一次 turn/start 注入一行并清零', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'aborted' }))
    expect(m.port.snapshot(S1)?.flags.interrupted).toBe(true)
    expect(m.port.snapshot(S1)?.interruptedAtTurn).toBe(1)
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    const line = m.port.consumeNotice(S1)
    expect(line).toContain('上次回合中断@1')
    expect(m.port.snapshot(S1)?.interruptedAtTurn).toBeNull()
    // 正常结束不再带中断标记
    clock.advance(6 * 60_000)
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 2, reason: 'completed' }))
    expect(m.port.snapshot(S1)?.flags.interrupted).toBe(false)
    m.dispose()
  })
})

describe('读印记与 edit 守卫（R10 §6.5；含逃生门与 fail-open）', () => {
  function guardMachine(): { m: SessionStateMachine; clock: FakeClock; git: ReturnType<typeof fakeGit> } {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'aaa1111', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    return { m, clock, git }
  }

  function changeWorktree(git: ReturnType<typeof fakeGit>, head: string): void {
    git.state.head = head
  }

  it('读后 epoch 未变 → edit 放行；epoch 变后 → deny，理由 ≤120 且是事实句', () => {
    const { m, clock, git } = guardMachine()
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path: 'src/a.ts' } }))
    expect(m.guardEdit(S1, 'edit', 'src/a.ts')).toMatchObject({ kind: 'allow' })
    changeWorktree(git, 'bbb2222')
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    const decision = m.guardEdit(S1, 'edit', 'src/a.ts')
    expect(decision.kind).toBe('deny')
    expect(decision.reason ?? '').toContain('变更')
    expect((decision.reason ?? '').length).toBeLessThanOrEqual(120)
    m.dispose()
  })

  it('逃生门：同路径同回合前 2 次 deny、第 3 次放行并记 gaveUp；重读后放行（AT-2/3）', () => {
    const { m, clock, git } = guardMachine()
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path: 'src/a.ts' } }))
    changeWorktree(git, 'bbb2222')
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('allow')
    expect(m.port.snapshot(S1)?.guard.gaveUps).toBe(1)
    // 重读后 stamp 更新到新 epoch → 放行
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path: 'src/a.ts' } }))
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('allow')
    m.dispose()
  })

  it('write 只 warn 不 deny；未读文件的 edit 不拦（本版偏差），只计 blindWrites', () => {
    const { m, clock, git } = guardMachine()
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'edit', arguments: { path: 'src/never-read.ts' } }))
    expect(m.port.snapshot(S1)?.blindWrites).toBe(1)
    expect(m.guardEdit(S1, 'edit', 'src/never-read.ts')).toMatchObject({ kind: 'allow' })
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path: 'src/w.ts' } }))
    changeWorktree(git, 'ccc3333')
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    expect(m.guardEdit(S1, 'write', 'src/w.ts').kind).toBe('warn')
    expect(m.port.snapshot(S1)?.guard.writeWarnings).toBe(1)
    m.dispose()
  })

  it('step/start 不清空回合 deny 预算（只有 turn/start 是边界）', () => {
    const { m, clock, git } = guardMachine()
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path: 'src/a.ts' } }))
    changeWorktree(git, 'bbb2222')
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    m.port.observe(event(S1, 'step/start', clock.now(), { turn: 2, step: 3 }))
    // 若 step/start 被当成回合边界，第 3 次会再次 deny（denies=3）；正确语义是放行。
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('allow')
    expect(m.port.snapshot(S1)?.guard.gaveUps).toBe(1)
    m.dispose()
  })

  it('wireEditGuard 接在 tools/pre-execute：deny 直接返回且不调用 next；allow 走 next', async () => {
    const { m, clock, git } = guardMachine()
    const registered: { event: string; fn: (exec: unknown, next: unknown) => Promise<unknown> }[] = []
    const ctx = {
      on: (event: string, fn: (exec: unknown, next: unknown) => Promise<unknown>) => {
        registered.push({ event, fn })
        return () => {}
      },
    }
    const dispose = wireEditGuard({ ctx: ctx as never, machine: m })
    expect(registered[0]?.event).toBe('tools/pre-execute')
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path: 'src/a.ts' } }))
    changeWorktree(git, 'bbb2222')
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    let nextCalls = 0
    const next = async (): Promise<unknown> => {
      nextCalls += 1
      return { kind: 'allow' }
    }
    const denied = await registered[0]?.fn({
      name: 'edit',
      arguments: { path: 'src/a.ts' },
      agent: { session: { id: S1 } },
    }, next)
    expect(denied).toMatchObject({ kind: 'deny' })
    expect(nextCalls).toBe(0)
    const allowed = await registered[0]?.fn({
      name: 'edit',
      arguments: { path: 'src/untouched.ts' },
      agent: { session: { id: S1 } },
    }, next)
    expect(allowed).toEqual({ kind: 'allow' })
    expect(nextCalls).toBe(1)
    dispose()
    m.dispose()
  })

  it('未知会话 / 空参数 / 非写工具一律放行且不抛', () => {
    const { m } = guardMachine()
    expect(m.guardEdit('nope', 'edit', 'a.ts').kind).toBe('allow')
    expect(m.guardEdit(S1, 'pwsh', 'a.ts').kind).toBe('allow')
    expect(m.guardEdit(S1, 'edit', '').kind).toBe('allow')
    m.dispose()
  })
})

describe('持久化（R10 §6.4）：跨重启保留 lastEventAt / epoch / stamps，且有界', () => {
  it('重启后第一条 turn/start 用持久化的 lastEventAt 算 gap 并产出通知', () => {
    const fs = memoryFs()
    const statDir = 'state-test'
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const first = machine({ clock, git, cwd: 'C:/repo', fs, stateDir: statDir, persist: true })
    first.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    first.port.observe(event(S1, 'goal/change', clock.now(), { id: 'g1', objective: '目标', phase: 'open' }))
    first.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    expect([...fs.files.keys()].some(file => file.endsWith('.json') && file.includes('sessions'))).toBe(true)
    first.dispose()

    clock.advance(26 * 3_600_000)
    const second = machine({ clock, git, cwd: 'C:/repo', fs, stateDir: statDir, persist: true })
    second.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    const line = second.port.consumeNotice(S1)
    expect(line).toContain('距上次 1d2h')
    expect(second.port.snapshot(S1)?.openGoals).toBe(1)
    second.dispose()
  })

  it('持久化写失败：不抛、标记 degraded，状态仍可用（AT-12 同源）', () => {
    const fs = memoryFs()
    fs.failWrites = true
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo', fs, stateDir: 'state-test', persist: true })
    expect(() => {
      m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
      m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    }).not.toThrow()
    expect(m.port.snapshot(S1)?.persistence.error).toBeTruthy()
    expect(m.port.snapshot(S1)?.flags.degraded).toBe(true)
    m.dispose()
  })

  it('会话文件数上界存在（常量可断言；清理失败不影响状态）', () => {
    expect(MAX_SESSION_FILES).toBe(100)
    const fs = memoryFs()
    const sessionDir = join('state-test', 'sessions')
    for (let index = 0; index < MAX_SESSION_FILES + 5; index += 1) {
      fs.files.set(join(sessionDir, `old-${index}.json`), '{}')
    }
    fs.files.set(join(sessionDir, 'active.json'), '{}')
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo', fs, stateDir: 'state-test', persist: true })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'completed' }))
    const sessionFiles = [...fs.files.keys()].filter(file => dirname(file) === sessionDir)
    expect(sessionFiles.length).toBeLessThanOrEqual(MAX_SESSION_FILES + 1)
    m.dispose()
  })
})

describe('通知去重、确定性与未知会话安全', () => {
  it('同一事实不重复：距上次超阈值后只产出一行，第二次访问为 null', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    m.port.observe(event(S1, 'turn/start', clock.now()))
    clock.advance(6 * 60_000)
    m.port.observe(event(S1, 'turn/start', clock.now()))
    expect(m.port.consumeNotice(S1)).toContain('距上次 6m')
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    expect(m.port.consumeNotice(S1)).toBeNull()
    m.dispose()
  })

  it('相同输入 → 逐字节相同的通知（确定性）', () => {
    const build = (): string | null => {
      const clock = new FakeClock()
      const git = fakeGit({ head: 'aaa', status: '' })
      const m = machine({ clock, git, cwd: 'C:/repo' })
      m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
      m.port.observe(event(S1, 'goal/change', clock.now(), { id: 'g', objective: 'x', phase: 'open' }))
      m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 1, reason: 'aborted' }))
      clock.advance(26 * 3_600_000)
      m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
      const line = m.port.consumeNotice(S1)
      m.dispose()
      return line
    }
    expect(build()).toBe(build())
  })

  it('未知会话：所有读方法返回安全值，observe 不抛', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc', status: '' })
    const m = machine({ clock, git, cwd: 'C:/repo' })
    expect(m.port.snapshot('missing')).toBeUndefined()
    expect(m.port.idleMs('missing')).toBeUndefined()
    expect(m.port.consumeNotice('missing')).toBeNull()
    expect(m.port.readStamps('missing')).toEqual([])
    expect(() => m.port.observe({ sessionId: '', type: 'turn/start' })).not.toThrow()
    expect(() => m.port.observe({ sessionId: S1, type: 'turn/start', data: 42, at: Number.NaN })).not.toThrow()
    expect(m.port.workspaceEpoch('').degraded).toBe(true)
    m.dispose()
  })

  it('配置默认值有界且与常量一致', () => {
    expect(DEFAULT_SESSION_STATE_CONFIG.persist).toBe(true)
    expect(DEFAULT_SESSION_STATE_CONFIG.noticeMaxChars).toBe(120)
    expect(DEFAULT_SESSION_STATE_CONFIG.suppressTurns).toBe(2)
    expect(DEFAULT_SESSION_STATE_CONFIG.maxSessions).toBe(128)
  })
})

