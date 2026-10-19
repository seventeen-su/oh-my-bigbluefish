/**
 * 自主捕获（3.7 Wave 2；v4.1 §3.5 生命周期）。
 *
 * 判据：
 * ① 规则是**确定性纯函数**（偏好/活动分类可直接断言）；
 * ② 事件驱动落地：用户消息 → 用户库 semantic/user；工具**结果成功** → 项目库 episodic/execution；
 * ③ v4.1 生命周期：`tool/call` 只建 pending，`tool/result` 决定写什么（成功写旧文本、
 *    失败写"未生效：…"、ok=undefined 不写、无 pending 不写）；回合结束丢弃未解决并计数；
 * ④ 有界与幂等：每会话活动上限、每会话/全局 pending 上限、同会话去重、密钥拒写；
 * ⑤ 冷启动：项目库首次未就绪 → 重试一次；仍失败则**不写用户库**；
 * ⑥ 隐私闸门：写许可为假时一条都不写。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord, MemoryScope, MemoryStore } from '../../../kernel/abi/index.js'
import {
  classifySessionOutcome,
  classifyToolActivity,
  classifyUserMessage,
  createCapture,
  extractCommand,
  extractPaths,
  hasSecret,
  isCommandOrCode,
  isQuestion,
  MAX_PENDING_GLOBAL,
  MAX_PENDING_PER_SESSION,
} from '../../../modules/memory/capture.js'
import { asRecordScanner, openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { fixedClock, tempWorkspace, testPort, type TempWorkspace } from './helpers.js'

async function rowsOf(store: MemoryStore): Promise<readonly MemoryRecord[]> {
  const scanner = asRecordScanner(store)
  if (scanner === undefined) throw new Error('测试库必须支持 listRecentRecords')
  return await scanner.listRecentRecords({ limit: 50 })
}

interface CaptureFixture {
  readonly user: SqliteMemoryStore
  readonly project: SqliteMemoryStore
  readonly capture: ReturnType<typeof createCapture>
  readonly written: { id: string; scope: string; kind: string }[]
  close(): Promise<void>
}

function captureFixture(options: { readonly withProject?: boolean; readonly privacyAllows?: boolean; readonly retryMs?: number } = {}): CaptureFixture {
  const ws: TempWorkspace = tempWorkspace('omb-capture-')
  const clock = fixedClock()
  const port = testPort(ws.dir)
  const logger = { debug: () => {}, info: () => {}, warn: () => {} }
  const user = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })
  const project = openMemoryStore({
    scope: 'project',
    dbPath: join(ws.dir, 'proj', '.omb', 'memory', 'session.db'),
    port,
    logger,
    clock,
  })
  const withProject = options.withProject ?? true
  const written: { id: string; scope: string; kind: string }[] = []
  let calls = 0
  const capture = createCapture({
    clock,
    resolveStore: async (scope: MemoryScope): Promise<MemoryStore | undefined> => {
      calls += 1
      if (scope === 'user') return user
      if (!withProject) return undefined
      // 冷启动：项目库**第一次**解析失败，重试（第二次）才给句柄
      if (options.retryMs !== undefined && options.retryMs > 0 && calls === 1) return undefined
      return project
    },
    currentProject: () => '/work/demo',
    privacyAllowsWrite: () => options.privacyAllows ?? true,
    onMemoryWritten: payload => void written.push(payload),
    enabledPreferences: true,
    enabledActivity: true,
    enabledOutcome: true,
    projectRetryMs: options.retryMs ?? 0,
  })
  return {
    user,
    project,
    capture,
    written,
    async close(): Promise<void> {
      await user.close()
      await project.close()
      ws.cleanup()
    },
  }
}

describe('规则（纯函数）', () => {
  it('偏好：标记 + 长度，疑问/命令/代码/密钥一律拒', () => {
    const ok = '以后回答请简洁一点，不要分点。'
    expect(classifyUserMessage(ok)).toMatchObject({ ok: true })
    expect(classifyUserMessage('我们决定采用 Rust 重写核心。')).toMatchObject({ ok: true })
    expect(classifyUserMessage('今天天气不错呀，心情很好')).toEqual({ ok: false, reason: 'no-marker' })
    expect(classifyUserMessage('以后这种情况怎么办？')).toEqual({ ok: false, reason: 'question' })
    expect(classifyUserMessage('为什么必须这样？')).toEqual({ ok: false, reason: 'question' })
    expect(classifyUserMessage('/compact')).toEqual({ ok: false, reason: 'command-or-code' })
    expect(classifyUserMessage('```ts\nconst x = 1\n``` 以后都用这个')).toEqual({ ok: false, reason: 'command-or-code' })
    expect(classifyUserMessage('以后必须用 sk-abcdefghijklmnopqrstuvwxyz 这个 key')).toEqual({ ok: false, reason: 'secret' })
    expect(isQuestion('是否要记住？')).toBe(true)
    expect(isCommandOrCode('$ pnpm test')).toBe(true)
    expect(hasSecret('password: hunter2hunter2')).toBe(true)
  })

  it('活动：改文件/命令；读操作与密钥参数不记', () => {
    expect(classifyToolActivity('edit', '{"path":"src/memory/store.ts"}')).toEqual({
      ok: true,
      text: '编辑文件：src/memory/store.ts',
      dedupeKey: 'edit:src/memory/store.ts',
    })
    expect(classifyToolActivity('pwsh', '{"command":"pnpm test tests/modules/memory"}')).toMatchObject({
      ok: true,
      text: '执行命令：pnpm test tests/modules/memory',
    })
    expect(classifyToolActivity('read', '{"path":"README.md"}')).toEqual({ ok: false, reason: 'not-activity' })
    expect(classifyToolActivity('edit', '{"path":"x.ts","content":"token=abcdefgh"}')).toEqual({
      ok: false,
      reason: 'secret',
    })
    expect(extractPaths('C:\\repo\\src\\a.ts')).toContain('C:\\repo\\src\\a.ts')
    expect(extractCommand('{"command":"git commit -m x"}')).toBe('git commit -m x')
  })

  it('会话结局：≥3 次调用且没有捕获活动才写一条', () => {
    expect(classifySessionOutcome({ toolCalls: 3, capturedActivity: 1, topTools: ['read'] })).toEqual({
      ok: false,
      reason: 'already-captured',
    })
    expect(classifySessionOutcome({ toolCalls: 2, capturedActivity: 0, topTools: ['read'] })).toEqual({
      ok: false,
      reason: 'too-few-calls',
    })
    expect(classifySessionOutcome({ toolCalls: 4, capturedActivity: 0, topTools: ['read', 'grep'] })).toMatchObject({
      ok: true,
      text: '会话活动：4 次工具调用（read、grep）',
    })
  })
})

describe('事件落地（真实 SQLite）', () => {
  it('用户消息 → 用户库 semantic/user，逐字 + sourceRef=session:<id>#<seq>', async () => {
    const f = captureFixture()
    await f.capture.onUserMessage({ sessionId: 's1', text: '以后回答请简洁一点，不要分点。', at: 1000, seq: 42 })
    const rows = await rowsOf(f.user)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: 'user',
      kind: 'semantic',
      text: '以后回答请简洁一点，不要分点。',
      assertedBy: 'user',
      sourceRef: 'session:s1#42',
      project: '/work/demo',
    })
    expect(f.written).toHaveLength(1)
    expect(f.capture.stats().preferences).toBe(1)
    await f.close()
  })

  it('同一条消息重复投递只写一次；每会话偏好上限 5', async () => {
    const f = captureFixture()
    await f.capture.onUserMessage({ sessionId: 's1', text: '以后回答请简洁一点，不要分点。', at: 1, seq: 1 })
    await f.capture.onUserMessage({ sessionId: 's1', text: '以后回答请简洁一点，不要分点。', at: 2, seq: 2 })
    expect(await rowsOf(f.user)).toHaveLength(1)

    for (let index = 0; index < 8; index += 1) {
      await f.capture.onUserMessage({ sessionId: 's1', text: `约定 ${index}：以后都用中文回答。`, at: 10 + index, seq: 10 + index })
    }
    const rows = await rowsOf(f.user)
    expect(rows).toHaveLength(5) // 1 + 4（达到上限后不再写）
    expect(f.capture.stats().skipped.cap).toBeGreaterThan(0)
    await f.close()
  })

  it('工具调用的成功结果 → 项目库 episodic/execution；read 不写；活动上限 10', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'read', args: '{"path":"README.md"}', at: 1, callId: 'c0' })
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c0', tool: 'read', ok: true, text: '', at: 2 })
    expect(await rowsOf(f.project)).toHaveLength(0)

    for (let index = 0; index < 12; index += 1) {
      await f.capture.onToolCall({
        sessionId: 's1',
        tool: 'pwsh',
        args: `{"command":"pnpm test -t case-${index}"}`,
        at: 10 + index * 2,
        callId: `c-${index}`,
      })
      await f.capture.onToolResult({ sessionId: 's1', callId: `c-${index}`, tool: 'pwsh', ok: true, text: '', at: 11 + index * 2 })
    }
    const rows = await rowsOf(f.project)
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({ scope: 'project', kind: 'episodic', assertedBy: 'execution' })
    expect(rows[0]?.sourceRef).toContain('session:s1#call:')
    expect(f.capture.stats().activity).toBe(10)
    await f.close()
  })

  it('密钥内容不出现在任何库里', async () => {
    const f = captureFixture()
    await f.capture.onUserMessage({
      sessionId: 's1',
      text: '以后都用这个 key：sk-abcdefghijklmnopqrstuvwxyz',
      at: 1,
      seq: 1,
    })
    await f.capture.onToolCall({
      sessionId: 's1',
      tool: 'edit',
      args: '{"path":"a.ts","content":"password: hunter2hunter2"}',
      at: 2,
      callId: 'c1',
    })
    expect(await rowsOf(f.user)).toHaveLength(0)
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(f.capture.stats().skipped.secret).toBe(2)
    await f.close()
  })

  it('冷启动：项目库第一次未就绪 → 结果写入时重试一次并成功', async () => {
    const f = captureFixture({ retryMs: 5 })
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    expect(await rowsOf(f.project)).toHaveLength(0) // call 不写
    const started = Date.now()
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'edit', ok: true, text: '', at: 2 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4) // 真的等过（不是立即放弃）
    expect(await rowsOf(f.project)).toHaveLength(1)
    await f.close()
  })

  it('项目库始终不可用 → 跳过（**绝不写用户库**）', async () => {
    const f = captureFixture({ withProject: false })
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'edit', ok: true, text: '', at: 2 })
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(await rowsOf(f.user)).toHaveLength(0)
    expect(f.capture.stats().skipped['no-project-store']).toBe(1)
    await f.close()
  })

  it('隐私闸门不允许写 → 一条都不写（即使规则命中）', async () => {
    const f = captureFixture({ privacyAllows: false })
    await f.capture.onUserMessage({ sessionId: 's1', text: '以后回答请简洁一点，不要分点。', at: 1, seq: 1 })
    await f.capture.onToolCall({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm build"}', at: 2, callId: 'c1' })
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'pwsh', ok: true, text: '', at: 3 })
    expect(await rowsOf(f.user)).toHaveLength(0)
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(f.capture.stats().skipped.privacy).toBe(2)
    await f.close()
  })

  it('会话结局：3 次读调用且无活动 → 回合结束时写 1 条 episodic；只写一次', async () => {
    const f = captureFixture()
    for (let index = 0; index < 3; index += 1) {
      await f.capture.onToolCall({ sessionId: 's1', tool: 'read', args: `{"path":"f${index}.ts"}`, at: index, callId: `c${index}` })
      await f.capture.onToolResult({ sessionId: 's1', callId: `c${index}`, tool: 'read', ok: true, text: '', at: index + 100 })
    }
    await f.capture.onTurnEnd({ sessionId: 's1', turn: 1 })
    await f.capture.onTurnEnd({ sessionId: 's1', turn: 2 })
    const rows = await rowsOf(f.project)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toContain('会话活动：3 次工具调用')
    expect(f.capture.stats().outcomes).toBe(1)
    await f.close()
  })
})

describe('生命周期（v4.1 §3.5）', () => {
  it('成功写旧文本；失败写"未生效："前缀（同一调用两种事实分开记）', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'edit', ok: true, text: '', at: 2 })
    await f.capture.onToolCall({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm test"}', at: 3, callId: 'c2' })
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c2', tool: 'pwsh', ok: false, text: '1 failed', at: 4 })

    const rows = await rowsOf(f.project)
    const texts = rows.map(row => row.text)
    expect(texts).toContain('编辑文件：src/a.ts')
    expect(texts).toContain('未生效：执行命令：pnpm test')
    expect(rows.every(row => row.assertedBy === 'execution')).toBe(true)
    expect(rows.find(row => row.text.startsWith('未生效：'))?.sourceRef).toContain('#call:c2')
    const stats = f.capture.stats()
    expect(stats.failed).toBe(1)
    expect(stats.activity).toBe(2)
    expect(stats.pending).toBe(0)
    await f.close()
  })

  it('结果 ok=undefined：不写、计 unknown-result、pending 释放', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'edit', ok: undefined, text: '', at: 2 })
    expect(await rowsOf(f.project)).toHaveLength(0)
    const stats = f.capture.stats()
    expect(stats.unknownResult).toBe(1)
    expect(stats.pending).toBe(0)
    // 已释放：再来一次结果只能算 no-pending
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'edit', ok: true, text: '', at: 3 })
    expect(f.capture.stats().noPending).toBe(1)
    await f.close()
  })

  it('无匹配 pending：结果不写，计 no-pending（乱序/超界/重放）', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    await f.capture.onToolResult({ sessionId: 's1', callId: 'nope', tool: 'edit', ok: true, text: '', at: 2 })
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(f.capture.stats().noPending).toBe(1)
    expect(f.capture.stats().pending).toBe(1) // c1 仍挂着
    await f.close()
  })

  it('非活动调用（read）的结果不产生 pending，也不计 no-pending', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'read', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    await f.capture.onToolResult({
      sessionId: 's1',
      callId: 'c1',
      tool: 'read',
      args: '{"path":"src/a.ts"}',
      ok: true,
      text: '',
      at: 2,
    })
    const stats = f.capture.stats()
    // 读文件本来就不挂 pending：把它算成"丢结果"会让这个计数被每次 read 撑大。
    expect(stats.noPending).toBe(0)
    expect(stats.skipped['no-pending']).toBeUndefined()
    await f.close()
  })

  it('无 callId：调用时**不写**，只挂派生 pending 并计 unconfirmed-call', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1 })
    // v4.5.3：没有结果确认就保持 unknown，不能把"尝试过"写成"完成过"
    expect(await rowsOf(f.project)).toHaveLength(0)
    const stats = f.capture.stats()
    expect(stats.unconfirmedCall).toBe(1)
    expect(stats.skipped['unconfirmed-call']).toBe(1)
    expect(stats.pending).toBe(1)
    // 结果事件带同样的 tool+args：可按派生键配对，配对后才写
    await f.capture.onToolResult({
      sessionId: 's1',
      tool: 'edit',
      args: '{"path":"src/a.ts"}',
      ok: true,
      text: '',
      at: 2,
    })
    expect(await rowsOf(f.project)).toHaveLength(1)
    expect(f.capture.stats().pending).toBe(0)
    await f.close()
  })

  it('无 callId 且结果无法关联：不写，回合结束计 unconfirmed', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1 })
    await f.capture.onToolResult({ sessionId: 's1', ok: true, text: '', at: 2 })
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(f.capture.stats().unknownCorrelation).toBe(0) // 连 tool 都没有：不臆测是不是活动
    await f.capture.onTurnEnd({ sessionId: 's1', turn: 1 })
    expect(f.capture.stats().unconfirmed).toBe(1)
    expect(f.capture.stats().pending).toBe(0)
    await f.close()
  })

  it('turn/end：丢弃未解决 pending 并计 unconfirmed；迟到的结果只计 no-pending', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    await f.capture.onTurnEnd({ sessionId: 's1', turn: 1 })
    expect(f.capture.stats().unconfirmed).toBe(1)
    expect(f.capture.stats().pending).toBe(0)
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'edit', ok: true, text: '', at: 2 })
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(f.capture.stats().noPending).toBe(1)
    await f.close()
  })

  it('pending 有界：每会话 20，超出不挂起（pending-cap）', async () => {
    const f = captureFixture()
    for (let index = 0; index < MAX_PENDING_PER_SESSION + 1; index += 1) {
      await f.capture.onToolCall({
        sessionId: 's1',
        tool: 'pwsh',
        args: `{"command":"pnpm test -t pending-${index}"}`,
        at: index,
        callId: `c-${index}`,
      })
    }
    expect(f.capture.stats().pending).toBe(MAX_PENDING_PER_SESSION)
    expect(f.capture.stats().skipped['pending-cap']).toBe(1)
    // 第 21 个没有被挂起：它的结果只能算 no-pending
    await f.capture.onToolResult({ sessionId: 's1', callId: `c-${MAX_PENDING_PER_SESSION}`, tool: 'pwsh', ok: true, text: '', at: 99 })
    expect(f.capture.stats().noPending).toBe(1)
    expect(await rowsOf(f.project)).toHaveLength(0)
    await f.close()
  })

  it('pending 全局上限 512（跨会话兜底）', async () => {
    const f = captureFixture()
    const sessions = Math.ceil(MAX_PENDING_GLOBAL / MAX_PENDING_PER_SESSION) + 1
    for (let session = 0; session < sessions; session += 1) {
      for (let index = 0; index < MAX_PENDING_PER_SESSION; index += 1) {
        await f.capture.onToolCall({
          sessionId: `s${session}`,
          tool: 'pwsh',
          args: `{"command":"pnpm test -t g-${session}-${index}"}`,
          at: session * 100 + index,
          callId: `g-${session}-${index}`,
        })
      }
    }
    expect(f.capture.stats().pending).toBe(MAX_PENDING_GLOBAL)
    expect(f.capture.stats().skipped['pending-cap']).toBeGreaterThan(0)
    await f.close()
  })

  it('stats.pending 是瞬时量（不是累计）', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    expect(f.capture.stats().pending).toBe(1)
    await f.capture.onToolResult({ sessionId: 's1', callId: 'c1', tool: 'edit', ok: true, text: '', at: 2 })
    expect(f.capture.stats().pending).toBe(0)
    await f.close()
  })

  it('主动性提示：命中用户信号时给一行，普通消息/回合结束清空', async () => {
    const f = captureFixture()
    await f.capture.onUserMessage({ sessionId: 's1', text: '记住：以后都用 pnpm。', at: 1 })
    expect(f.capture.nudge('s1')).toContain('omb_remember')
    // 下一条普通消息覆盖（不继续念叨上一条）
    await f.capture.onUserMessage({ sessionId: 's1', text: '好的，继续。', at: 2 })
    expect(f.capture.nudge('s1')).toBeUndefined()
    // 再命中后，回合结束清空
    await f.capture.onUserMessage({ sessionId: 's1', text: '之前说的方案不对，改成 B。', at: 3 })
    expect(f.capture.nudge('s1')).toContain('supersedes')
    await f.capture.onTurnEnd({ sessionId: 's1', turn: 1 })
    expect(f.capture.nudge('s1')).toBeUndefined()
    await f.close()
  })
})
