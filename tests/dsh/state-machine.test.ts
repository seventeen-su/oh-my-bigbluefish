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
  MAX_SITUATION_ENTRIES,
  SESSION_STATE_SERVICE,
  absPathOf,
  createSessionStateMachine,
  extractShellWritePaths,
  formatGap,
  normalizePath,
  parsePorcelainV2Paths,
  pathOfArguments,
  renderNotice,
  shellCommandOf,
  wireEditGuard,
  type ContentHashResult,
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
  content?: FakeContent
  instruction?: (cwd: string) => string | null
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
    ...(options.content === undefined
      ? {}
      : { contentHash: options.content.hashOf, fileExists: options.content.exists }),
    ...(options.instruction === undefined ? {} : { instructionDigest: options.instruction }),
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

/**
 * 假内容存储：`hashOf/exists` 就是注入给状态机的 `contentHash/fileExists` 端口。
 * 测试**不造真实文件**；`failHash` 用来触发"端口内部异常 → fail-open"一行。
 */
interface FakeContent {
  readonly files: Map<string, ContentHashResult>
  failHash: boolean
  hashOf(absPath: string): ContentHashResult | null
  exists(absPath: string): boolean
  set(absPath: string, hash: string, size?: number): void
  remove(absPath: string): void
}

function fakeContent(): FakeContent {
  const files = new Map<string, ContentHashResult>()
  const api: FakeContent = {
    files,
    failHash: false,
    hashOf: absPath => {
      if (api.failHash) throw new Error('hash port exploded')
      const found = files.get(absPath)
      return found === undefined ? null : { hash: found.hash, size: found.size }
    },
    exists: absPath => files.has(absPath),
    set: (absPath, hash, size = 10) => {
      files.set(absPath, { hash, size })
    },
    remove: absPath => {
      files.delete(absPath)
    },
  }
  return api
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
      instructionsChanged: false,
      shellWrites: 0,
      shellUnknown: 0,
      shellInferred: 0,
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
    // v4.2：指令指纹与 shell 写是独立事实，字段顺序固定、同一事实同一字节串。
    const v42 = renderNotice('e12345678', {
      gapMs: undefined,
      headFrom: null,
      headTo: null,
      branch: null,
      externalChanges: 0,
      instructionsChanged: true,
      shellWrites: 2,
      shellUnknown: 1,
      shellInferred: 3,
      interruptedAtTurn: null,
      openGoals: 0,
      deepStale: false,
      degraded: false,
    }, 120)
    expect(v42).toContain('指令已变')
    expect(v42).toContain('shell 写 2')
    expect(v42).toContain('shell 未知写 1')
    expect(v42.length).toBeLessThanOrEqual(120)
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
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    // v4.1：writeIntent 只在**成功写之后**由 post-execute 记，且 turn/start 会清空；
    // 所以归因事件必须发生在第 2 个回合内（这里模拟第 2 回合内的一次成功 edit）。
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'edit', arguments: { path: 'src/ours.ts' } }))
    m.port.observe(event(S1, 'tool/result', clock.now(), { name: 'edit', arguments: { path: 'src/ours.ts' }, ok: true }))
    m.port.observe(event(S1, 'turn/end', clock.now(), { turn: 2, reason: 'completed' }))
    m.port.observe(event(S1, 'workspace/changes', clock.now(), { turn: 2 }, 9))
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 3 }))
    const line = m.port.consumeNotice(S1)
    // 回合之间 tree 未变（before=b = 上一 after=b）→ 只剩未归因文件 1
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

describe('资源级写守卫（v4.1 §4 判定表；edit+write 统一）', () => {
  function fixture(): {
    m: SessionStateMachine
    clock: FakeClock
    content: FakeContent
    abs: (path: string) => string
    read: (path: string, hash?: string) => void
  } {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'aaa1111', status: '' })
    const content = fakeContent()
    const m = machine({ clock, git, cwd: 'C:/repo', content })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    const abs = (path: string): string => absPathOf('C:/repo', path) ?? path
    const read = (path: string, hash = 'h1'): void => {
      content.set(abs(path), hash)
      m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path } }))
    }
    return { m, clock, content, abs, read }
  }

  it('判定表：无印记且文件不存在 → allow，无计数', () => {
    const { m } = fixture()
    expect(m.guardEdit(S1, 'edit', 'src/new.ts')).toMatchObject({ kind: 'allow' })
    expect(m.port.snapshot(S1)?.blindWrites).toBe(0)
    expect(m.port.snapshot(S1)?.guard.unverifiable).toBe(0)
    m.dispose()
  })

  it('判定表：无印记且文件存在 → allow + blindWrites++', () => {
    const { m, content, abs } = fixture()
    content.set(abs('src/existing.ts'), 'h0')
    expect(m.guardEdit(S1, 'edit', 'src/existing.ts').kind).toBe('allow')
    expect(m.port.snapshot(S1)?.blindWrites).toBe(1)
    m.dispose()
  })

  it('判定表：印记 hash=null（读时读不到）→ allow + unverifiable++', () => {
    const { m, clock } = fixture()
    // 不 set 内容：读取时 contentHash 返回 null → 印记 hash=null
    m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path: 'src/nohash.ts' } }))
    expect(m.port.readStamps(S1)[0]?.hash).toBeNull()
    expect(m.guardEdit(S1, 'edit', 'src/nohash.ts').kind).toBe('allow')
    expect(m.port.snapshot(S1)?.guard.unverifiable).toBe(1)
    m.dispose()
  })

  it('判定表：当前内容读不到/超限 → allow + unverifiable++', () => {
    const { m, content, abs, read } = fixture()
    read('src/gone.ts')
    content.remove(abs('src/gone.ts'))
    expect(m.guardEdit(S1, 'write', 'src/gone.ts').kind).toBe('allow')
    expect(m.port.snapshot(S1)?.guard.unverifiable).toBe(1)
    m.dispose()
  })

  it('判定表：hash 相同 → allow（edit 与 write 同表）', () => {
    const { m, read } = fixture()
    read('src/same.ts', 'h1')
    expect(m.guardEdit(S1, 'edit', 'src/same.ts').kind).toBe('allow')
    expect(m.guardEdit(S1, 'write', 'src/same.ts').kind).toBe('allow')
    m.dispose()
  })

  it('判定表：hash 不同 → deny（≤120 事实句）', () => {
    const { m, content, abs, read } = fixture()
    read('src/changed.ts', 'h1')
    content.set(abs('src/changed.ts'), 'h2')
    const decision = m.guardEdit(S1, 'edit', 'src/changed.ts')
    expect(decision.kind).toBe('deny')
    expect(decision.reason ?? '').toContain('已变化')
    expect((decision.reason ?? '').length).toBeLessThanOrEqual(120)
    m.dispose()
  })

  it('判定表：hash 不同时 write 也 deny（v4.1 统一表）', () => {
    const { m, content, abs, read } = fixture()
    read('src/w.ts', 'h1')
    content.set(abs('src/w.ts'), 'h2')
    expect(m.guardEdit(S1, 'write', 'src/w.ts').kind).toBe('deny')
    m.dispose()
  })

  it('逃生门：同路径同回合前 2 次 deny、第 3 次 allow + gaveUps；step/start 不清预算', () => {
    const { m, clock, content, abs, read } = fixture()
    read('src/a.ts', 'h1')
    content.set(abs('src/a.ts'), 'h2')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    m.port.observe(event(S1, 'step/start', clock.now(), { turn: 1, step: 2 }))
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('allow')
    expect(m.port.snapshot(S1)?.guard.gaveUps).toBe(1)
    expect(m.port.snapshot(S1)?.guard.denies).toBe(2)
    m.dispose()
  })

  it('判定表：守卫内部异常 → allow（fail-open，不计数）', () => {
    const { m, content, read } = fixture()
    read('src/boom.ts', 'h1')
    content.failHash = true
    expect(() => m.guardEdit(S1, 'edit', 'src/boom.ts')).not.toThrow()
    expect(m.guardEdit(S1, 'edit', 'src/boom.ts').kind).toBe('allow')
    expect(m.port.snapshot(S1)?.guard.denies).toBe(0)
    m.dispose()
  })

  it('post-execute 成功刷新印记哈希（自己的写不误伤自己）；失败不刷新', () => {
    const { m, content, abs, read } = fixture()
    read('src/self.ts', 'h1')
    content.set(abs('src/self.ts'), 'h2')
    m.noteWriteResult(S1, 'edit', 'src/self.ts', true)
    expect(m.port.readStamps(S1).find(stamp => stamp.path === 'src/self.ts')?.hash).toBe('h2')
    expect(m.guardEdit(S1, 'edit', 'src/self.ts').kind).toBe('allow')
    // 失败不刷新：内容再被改成 h1 时，印记仍是 h2 → deny
    content.set(abs('src/self.ts'), 'h1')
    m.noteWriteResult(S1, 'edit', 'src/self.ts', false)
    expect(m.guardEdit(S1, 'edit', 'src/self.ts').kind).toBe('deny')
    m.dispose()
  })

  it('writeIntent：post-execute 成功加入、turn/start 边界清空', () => {
    const { m, clock } = fixture()
    m.port.observe(event(S1, 'tool/result', clock.now(), { name: 'edit', arguments: { path: 'src/i.ts' }, ok: true }))
    expect(m.port.snapshot(S1)?.writeIntent).toBe(1)
    clock.advance(1_000)
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    expect(m.port.snapshot(S1)?.writeIntent).toBe(0)
    m.dispose()
  })

  it('非写工具 / 未知会话 / 空路径一律 allow', () => {
    const { m } = fixture()
    expect(m.guardEdit(S1, 'pwsh', 'a.ts').kind).toBe('allow')
    expect(m.guardEdit('nope', 'edit', 'a.ts').kind).toBe('allow')
    expect(m.guardEdit(S1, 'edit', '').kind).toBe('allow')
    m.dispose()
  })

  it('wireEditGuard 同时注册 pre/post；deny 不调用 next；post 成功后刷新', async () => {
    const { m, content, abs, read } = fixture()
    const registered: { event: string; fn: (...args: unknown[]) => Promise<unknown> }[] = []
    const ctx = {
      on: (event: string, fn: (...args: unknown[]) => Promise<unknown>) => {
        registered.push({ event, fn })
        return () => {}
      },
    }
    const dispose = wireEditGuard({ ctx: ctx as never, machine: m })
    expect(registered.map(entry => entry.event)).toEqual(['tools/pre-execute', 'tools/post-execute'])
    read('src/a.ts', 'h1')
    content.set(abs('src/a.ts'), 'h2')
    let nextCalls = 0
    const next = async (): Promise<unknown> => {
      nextCalls += 1
      return { kind: 'allow' }
    }
    const denied = await registered[0]?.fn({
      name: 'edit', arguments: { path: 'src/a.ts' }, agent: { session: { id: S1 } },
    }, next)
    expect(denied).toMatchObject({ kind: 'deny' })
    expect(nextCalls).toBe(0)
    const post = await registered[1]?.fn({
      name: 'edit', arguments: { path: 'src/a.ts' }, agent: { session: { id: S1 } },
    }, { isError: false }, next)
    expect(post).toEqual({ kind: 'allow' })
    expect(nextCalls).toBe(1)
    expect(m.port.readStamps(S1).find(stamp => stamp.path === 'src/a.ts')?.hash).toBe('h2')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('allow')
    dispose()
    m.dispose()
  })
})

describe('situation 快照（v4.1 §3.3：只读 / 同步 / 绝不抛 / ≤16 条）', () => {
  function fixture(): {
    m: SessionStateMachine
    content: FakeContent
    abs: (path: string) => string
    read: (path: string, hash: string) => void
  } {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'aaa1111', status: '' })
    const content = fakeContent()
    const m = machine({ clock, git, cwd: 'C:/repo', content })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    const abs = (path: string): string => absPathOf('C:/repo', path) ?? path
    const read = (path: string, hash: string): void => {
      content.set(abs(path), hash)
      m.port.observe(event(S1, 'tool/call', clock.now(), { name: 'read', arguments: { path } }))
    }
    return { m, content, abs, read }
  }

  it('结构化字段 + same/changed/unknown，entries 按 path 排序', () => {
    const { m, content, abs, read } = fixture()
    read('src/b.ts', 'hb')
    read('src/a.ts', 'ha')
    read('src/c.ts', 'hc')
    content.set(abs('src/b.ts'), 'hb2')
    content.remove(abs('src/c.ts'))
    m.port.observe(event(S1, 'goal/change', 1_000_000, { id: 'g1', objective: '目标', phase: 'open' }))
    m.port.observe(event(S1, 'todo/write', 1_000_000, {
      todos: [{ id: 't1', status: 'pending' }, { id: 't2', status: 'completed' }],
    }))
    const situation = m.port.situation(S1)
    expect(situation).toBeDefined()
    expect(situation?.cwd).toBe('C:/repo')
    expect(situation?.reads.count).toBe(3)
    expect(situation?.reads.changed).toBe(1)
    expect(situation?.reads.unknown).toBe(1)
    expect(situation?.reads.entries).toEqual([
      { path: 'src/a.ts', status: 'same', hash: 'ha' },
      { path: 'src/b.ts', status: 'changed', hash: 'hb' },
      { path: 'src/c.ts', status: 'unknown', hash: 'hc' },
    ])
    expect(situation?.goals).toEqual({ open: 1, total: 1 })
    expect(situation?.todos).toEqual({ open: 1, total: 2 })
    expect(situation?.sideEffects.blindWrites).toBe(0)
    expect(situation?.epoch?.source).toBe('git')
    m.dispose()
  })

  it('entries 上限 16：20 条读取只返回 16 条，count 仍是 20', () => {
    const { m, read } = fixture()
    for (let index = 0; index < 20; index += 1) {
      read(`src/f${String(index).padStart(2, '0')}.ts`, `h${index}`)
    }
    const situation = m.port.situation(S1)
    expect(situation?.reads.count).toBe(20)
    expect(situation?.reads.entries.length).toBe(MAX_SITUATION_ENTRIES)
    const paths = situation?.reads.entries.map(entry => entry.path) ?? []
    expect([...paths].sort()).toEqual(paths)
    m.dispose()
  })

  it('绝不抛：contentHash 端口抛错时状态为 unknown，而不是异常冒泡', () => {
    const { m, content, read } = fixture()
    read('src/a.ts', 'h1')
    content.failHash = true
    expect(() => m.port.situation(S1)).not.toThrow()
    expect(m.port.situation(S1)?.reads.entries[0]?.status).toBe('unknown')
    m.dispose()
  })

  it('未知会话 / 注销后返回 undefined', () => {
    const { m } = fixture()
    expect(m.port.situation('missing')).toBeUndefined()
    m.dispose()
    expect(m.port.situation(S1)).toBeUndefined()
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

describe('v4.2 留白收尾：指令指纹 / shell 写 / 跨会话 / 盲写策略', () => {
  it('指令文件指纹从无到有、再到变化：只在真变化时给"指令已变"', () => {
    const clock = new FakeClock()
    const git = fakeGit({ head: 'abc1234', status: '' })
    let digest: string | null = null
    const m = machine({ clock, git, cwd: 'C:/repo', instruction: () => digest })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    expect(m.port.consumeNotice(S1)).toBeNull() // 第一次见到 null：只记录
    digest = 'aaa111'
    clock.advance(1000)
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 2 }))
    expect(m.port.consumeNotice(S1)).toBeNull() // 从无到有不算"变了"
    digest = 'bbb222'
    clock.advance(1000)
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 3 }))
    expect(m.port.consumeNotice(S1)).toContain('指令已变')
    m.dispose()
  })

  it('shell 命令写路径提取：重定向 / PowerShell 路径参数 / sed -i / git 未知写', () => {
    expect(extractShellWritePaths('echo hi > out.txt').paths).toContain('out.txt')
    expect(extractShellWritePaths('Set-Content -Path src/a.ts -Value x').paths).toContain('src/a.ts')
    expect(extractShellWritePaths('Remove-Item -LiteralPath "dist/tmp.log"').paths).toContain('dist/tmp.log')
    expect(extractShellWritePaths('sed -i "s/a/b/" src/x.ts').paths).toContain('src/x.ts')
    expect(extractShellWritePaths('git apply patch.diff').unknown).toBe(true)
    expect(extractShellWritePaths('ls -la').unknown).toBe(false)
    expect(shellCommandOf({ arguments: JSON.stringify({ command: 'echo x' }) })).toBe('echo x')
  })

  it('读后 shell 写过且读取时无法核验内容 → deny（不是"未知就放行"）', () => {
    const clock = new FakeClock()
    const m = createSessionStateMachine({
      clock,
      cwdOf: () => 'C:/repo',
      contentHash: () => null,
      fileExists: () => true,
      instructionDigest: () => null,
      config: { persist: false },
    })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1, step: 1 }))
    m.port.observe(event(S1, 'tool/call', clock.now(), {
      name: 'read',
      arguments: JSON.stringify({ path: 'src/a.ts' }),
    }))
    clock.advance(1)
    m.port.observe(event(S1, 'tool/call', clock.now(), {
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'Set-Content -Path src/a.ts -Value x' }),
    }))
    const decision = m.guardEdit(S1, 'edit', 'src/a.ts')
    expect(decision.kind).toBe('deny')
    expect(decision.reason ?? '').toContain('shell')
    expect(m.port.situation(S1)?.sideEffects.shellWrites).toBe(1)
    m.dispose()
  })

  it('其他会话（子代理）写过本会话读过的文件 → 无法核验时 deny；situation 计数可见', () => {
    const clock = new FakeClock()
    const m = createSessionStateMachine({
      clock,
      cwdOf: () => 'C:/repo',
      contentHash: () => null,
      fileExists: () => true,
      instructionDigest: () => null,
      config: { persist: false },
    })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'tool/call', clock.now(), {
      name: 'read',
      arguments: JSON.stringify({ path: 'src/a.ts' }),
    }))
    clock.advance(1)
    m.port.observe(event('s2', 'turn/start', clock.now(), { turn: 1 }))
    m.noteWriteResult('s2', 'edit', 'src/a.ts', true)
    const decision = m.guardEdit(S1, 'edit', 'src/a.ts')
    expect(decision.kind).toBe('deny')
    expect(decision.reason ?? '').toContain('其他会话')
    expect(m.port.situation(S1)?.sideEffects.otherSessionWrites).toBe(1)
    m.dispose()
  })

  it('盲写策略 deny：无印记且文件存在 → 前两次 deny，第 3 次按逃生门放行', () => {
    const clock = new FakeClock()
    const m = createSessionStateMachine({
      clock,
      cwdOf: () => 'C:/repo',
      fileExists: () => true,
      contentHash: () => null,
      instructionDigest: () => null,
      config: { persist: false, blindWritePolicy: 'deny' },
    })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('deny')
    expect(m.guardEdit(S1, 'edit', 'src/a.ts').kind).toBe('allow')
    const snap = m.port.snapshot(S1)
    expect(snap?.blindWrites).toBe(3)
    expect(snap?.guard.gaveUps).toBe(1)
    m.dispose()
  })
})

describe('v4.4：shell 未知写推断与冲突材料', () => {
  it('未知写 shell 成功后按 git status 差分推断写集，并可拒绝后续编辑', () => {
    const clock = new FakeClock()
    const state = { status: '' }
    const m = createSessionStateMachine({
      clock,
      cwdOf: () => 'C:/repo',
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined.startsWith('status --porcelain=v2')) return { ok: true, stdout: state.status }
        if (joined.startsWith('rev-parse')) return { ok: true, stdout: 'abc1234\n' }
        return { ok: false, stdout: '' }
      },
      contentHash: () => null,
      fileExists: () => true,
      instructionDigest: () => null,
      config: { persist: false },
    })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'tool/call', clock.now(), {
      name: 'read',
      arguments: JSON.stringify({ path: 'src/x.ts' }),
    }))
    clock.advance(1)
    m.port.observe(event(S1, 'tool/call', clock.now(), {
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'git apply patch.diff' }),
    }))
    // 基线为空；命令执行后出现新脏文件
    state.status = '? src/x.ts\u0000'
    clock.advance(1)
    m.noteShellResult(S1, 'pwsh', true)

    expect(m.port.situation(S1)?.sideEffects.shellInferred).toBe(1)
    const decision = m.guardEdit(S1, 'edit', 'src/x.ts')
    expect(decision.kind).toBe('deny')
    expect(decision.reason ?? '').toContain('shell')
    m.dispose()
  })

  it('读后被改且已有 base 正文 → 写冲突材料（base/current），拒绝理由指向材料', () => {
    const clock = new FakeClock()
    let text = 'v1'
    let hash = 'h1'
    const writes: { base: string | null; current: string | null; path: string }[] = []
    const m = createSessionStateMachine({
      clock,
      cwdOf: () => 'C:/repo',
      contentHash: () => ({ hash, size: text.length }),
      fileExists: () => true,
      contentOf: () => text,
      instructionDigest: () => null,
      writeConflict: input => {
        writes.push({ base: input.base, current: input.current, path: input.path })
        return '.omb/conflicts/demo.md'
      },
      config: { persist: false },
    })
    m.port.observe(event(S1, 'turn/start', clock.now(), { turn: 1 }))
    m.port.observe(event(S1, 'tool/call', clock.now(), {
      name: 'read',
      arguments: JSON.stringify({ path: 'src/a.ts' }),
    }))
    text = 'v2'
    hash = 'h2'
    clock.advance(1)
    const decision = m.guardEdit(S1, 'edit', 'src/a.ts')
    expect(decision.kind).toBe('deny')
    expect(decision.reason ?? '').toContain('冲突材料')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.base).toBe('v1')
    expect(writes[0]?.current).toBe('v2')
    m.dispose()
  })
})

