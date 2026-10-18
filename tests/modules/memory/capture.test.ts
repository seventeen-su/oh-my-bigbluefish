/**
 * 3.7 Wave 2：自主捕获（task-17 §1）。
 *
 * 判据：
 * ① 规则是**确定性纯函数**（偏好/活动分类可直接断言）；
 * ② 事件驱动落地：用户消息 → 用户库 semantic/user；工具调用 → 项目库 episodic/execution；
 * ③ 有界与幂等：每会话上限、同会话去重、密钥拒写；
 * ④ 冷启动：项目库首次未就绪 → 重试一次；仍失败则**不写用户库**；
 * ⑤ 隐私闸门：写许可为假时一条都不写。
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

  it('工具调用 → 项目库 episodic/execution；读操作不写；活动上限 10', async () => {
    const f = captureFixture()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'read', args: '{"path":"README.md"}', at: 1, callId: 'c1' })
    expect(await rowsOf(f.project)).toHaveLength(0)

    for (let index = 0; index < 12; index += 1) {
      await f.capture.onToolCall({
        sessionId: 's1',
        tool: 'pwsh',
        args: `{"command":"pnpm test -t case-${index}"}`,
        at: 10 + index,
        callId: `c-${index}`,
      })
    }
    const rows = await rowsOf(f.project)
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({ scope: 'project', kind: 'episodic', assertedBy: 'execution' })
    expect(rows[0]?.sourceRef).toContain('session:s1#call:')
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

  it('冷启动：项目库第一次未就绪 → 重试一次并写入成功', async () => {
    const f = captureFixture({ retryMs: 5 })
    const started = Date.now()
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4) // 真的等过（不是立即放弃）
    expect(await rowsOf(f.project)).toHaveLength(1)
    await f.close()
  })

  it('项目库始终不可用 → 跳过（**绝不写用户库**）', async () => {
    const f = captureFixture({ withProject: false })
    await f.capture.onToolCall({ sessionId: 's1', tool: 'edit', args: '{"path":"src/a.ts"}', at: 1, callId: 'c1' })
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(await rowsOf(f.user)).toHaveLength(0)
    expect(f.capture.stats().skipped['no-project-store']).toBe(1)
    await f.close()
  })

  it('隐私闸门不允许写 → 一条都不写（即使规则命中）', async () => {
    const f = captureFixture({ privacyAllows: false })
    await f.capture.onUserMessage({ sessionId: 's1', text: '以后回答请简洁一点，不要分点。', at: 1, seq: 1 })
    await f.capture.onToolCall({ sessionId: 's1', tool: 'pwsh', args: '{"command":"pnpm build"}', at: 2, callId: 'c1' })
    expect(await rowsOf(f.user)).toHaveLength(0)
    expect(await rowsOf(f.project)).toHaveLength(0)
    expect(f.capture.stats().skipped.privacy).toBe(2)
    await f.close()
  })

  it('会话结局：3 次读调用且无活动 → 回合结束时写 1 条 episodic；只写一次', async () => {
    const f = captureFixture()
    for (let index = 0; index < 3; index += 1) {
      await f.capture.onToolCall({ sessionId: 's1', tool: 'read', args: `{"path":"f${index}.ts"}`, at: index, callId: `c${index}` })
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
