/**
 * 3.7-M4：写入可核验（见证端口 + 回顾体护栏 + 弃权分档）。
 *
 * 四条判据：
 * ① `claimedUserAssertion` 的核对真的走 `SessionWitnessPort.lastUserMessage`；
 * ② `execution-confirmed` 只认 `hasExecution` 命中，**不再认 `sourceRef` 前缀**；
 * ③ 回顾体（>240 字符 + ≥3 路径 + 总结词）被改路由到 episodic/项目库；
 * ④ 弃权带 `category`（健康面据此分档计数）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryScope, MemoryStore, ToolCallContext, ToolDefinition, ToolOutcome } from '../../../kernel/abi/index.js'
import { toolCallContext } from '../../../kernel/sessionRuntime.js'
import type { SessionWitnessPort } from '../../../modules/memory/witness.js'
import { createRememberTool, type MemoryWriteDeps } from '../../../modules/memory/remember.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { fixedClock, tempWorkspace, testPort, type TempWorkspace, type TestClock } from './helpers.js'

interface Fixture {
  readonly tool: ToolDefinition
  readonly user: SqliteMemoryStore
  readonly project: SqliteMemoryStore
  readonly abstained: { reason: string; text: string; category: string }[]
  close(): Promise<void>
}

function witnessOf(overrides: Partial<SessionWitnessPort> = {}): SessionWitnessPort {
  return {
    lastUserMessage: () => undefined,
    hasExecution: () => false,
    surfaceGeneration: () => 1,
    ...overrides,
  }
}

function fixture(witness?: SessionWitnessPort): Fixture {
  const ws: TempWorkspace = tempWorkspace()
  const clock: TestClock = fixedClock()
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
  const abstained: { reason: string; text: string; category: string }[] = []
  const deps: MemoryWriteDeps = {
    resolveStore: async (scope: MemoryScope, sessionId?: string): Promise<MemoryStore | undefined> => {
      if (scope === 'user') return user
      return sessionId === undefined ? undefined : project
    },
    clock,
    currentTurn: () => 7,
    currentProject: () => '/work/demo',
    // 工件核验：真实现会查文件系统；这里把"来源串是 execution:"的显式来源判为不可核验，
    // 免得 ②b 分支把 sourceRef 当成真实工件（那正是旧缺陷的另一个入口）。
    verifyArtifact: candidate => !candidate.startsWith('execution:'),
    ...(witness === undefined ? {} : { witness: () => witness }),
    onAbstained: info => void abstained.push(info),
  }
  return {
    tool: createRememberTool(deps),
    user,
    project,
    abstained,
    async close(): Promise<void> {
      await user.close()
      await project.close()
      ws.cleanup()
    },
  }
}

const SESSION_CALL: ToolCallContext = toolCallContext({ sessionId: 's1', callId: 'call-1' })

async function run(tool: ToolDefinition, args: unknown): Promise<ToolOutcome> {
  return await tool.execute(args, SESSION_CALL)
}

describe('用户陈述核对（3.7-M4）', () => {
  it('见证有原话且包含陈述 → verified；记录 assertedBy=user', async () => {
    const f = fixture(witnessOf({ lastUserMessage: () => '以后回答请简洁一点——回答请简洁，不要分点。谢谢！' }))
    const outcome = await run(f.tool, { text: '回答请简洁，不要分点。', kind: 'semantic', userAsserted: true })
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('核对到原话')
    const stored = await f.user.searchLexical({ text: '简洁', scope: 'user', limit: 5 })
    expect(stored).toHaveLength(1)
    const record = await f.user.get(stored[0]?.id ?? '')
    expect(record?.assertedBy).toBe('user')
    await f.close()
  })

  it('见证有原话但核对不到 → 弃权，category=user-claim-unverified', async () => {
    const f = fixture(witnessOf({ lastUserMessage: () => '今天天气不错，帮我看看这个 bug。' }))
    const outcome = await run(f.tool, {
      text: '用户偏好：以后都用中文回答。',
      kind: 'semantic',
      userAsserted: true,
    })
    expect(outcome.text).toContain('未写入')
    expect(f.abstained[0]?.category).toBe('user-claim-unverified')
    await f.close()
  })

  it('没有见证服务 → 退回旧行为（claimed-unverified，仍写入）', async () => {
    const f = fixture()
    const outcome = await run(f.tool, { text: '回答请简洁，不要分点。', kind: 'semantic', userAsserted: true })
    expect(outcome.text).toContain('已记住')
    expect(outcome.text).toContain('未能核对')
    await f.close()
  })
})

describe('执行结果确认只认真实台账（3.7-M4）', () => {
  it('hasExecution 命中 → 准入，且 assertedBy=execution（这次真的执行过）', async () => {
    const f = fixture(witnessOf({ hasExecution: (_session, reference) => reference === 'execution:pnpm test' }))
    const outcome = await run(f.tool, {
      text: '这条结论已由测试结果确认。',
      kind: 'procedural',
      sourceRef: 'execution:pnpm test',
      userAsserted: false,
    })
    expect(outcome.text).toContain('已记住')
    expect(outcome.text).toContain('执行台账')
    const hits = await f.project.searchLexical({ text: '测试结果', scope: 'project', limit: 5 })
    const record = await f.project.get(hits[0]?.id ?? '')
    expect(record?.assertedBy).toBe('execution')
    // v4.5.3 生命周期：一次执行结果不能直接成为可复用经验，降级为事件
    expect(record?.kind).toBe('episodic')
    expect(outcome.text).toContain('路由已调整')
    await f.close()
  })

  it('执行确认 + semantic：有实测依据，不会被当成"未确认经验"降级', async () => {
    const f = fixture(witnessOf({ hasExecution: (_session, reference) => reference === 'execution:pnpm test' }))
    const outcome = await run(f.tool, {
      text: '项目使用 pnpm 作为包管理器。',
      kind: 'semantic',
      scope: 'project',
      sourceRef: 'execution:pnpm test',
      userAsserted: false,
    })
    expect(outcome.text).toContain('已记住')
    expect(outcome.text).not.toContain('路由已调整')
    const hits = await f.project.searchLexical({ text: 'pnpm', scope: 'project', limit: 5 })
    const record = await f.project.get(hits[0]?.id ?? '')
    expect(record?.kind).toBe('semantic')
    await f.close()
  })

  it('前缀自证但台账没命中 → 弃权，category=no-ground', async () => {
    const f = fixture(witnessOf({ hasExecution: () => false }))
    const outcome = await run(f.tool, {
      text: '这条结论已由测试结果确认。',
      kind: 'procedural',
      sourceRef: 'execution:pnpm test',
      userAsserted: false,
    })
    expect(outcome.text).toContain('未写入')
    expect(f.abstained[0]?.category).toBe('no-ground')
    await f.close()
  })
})

describe('回顾体护栏（3.7-M4）', () => {
  const recapText =
    '本会话完成：修改了 src/memory/remember.ts 与 tests/modules/memory/remember.test.ts，'
    + '并更新 docs/v3.7-redesign.md。回顾整个流程，先定位再修复，最后总结为三条经验。'
    + '（附加说明：' + '这一段是无关的填充内容。'.repeat(30) + '）'

  it('回顾体默认改写为 episodic/项目库，并在回执里说明改路由', async () => {
    const f = fixture(witnessOf({ lastUserMessage: () => '随便聊聊' }))
    expect(recapText.length).toBeGreaterThan(240)
    const outcome = await run(f.tool, { text: recapText, kind: 'semantic', userAsserted: false })
    expect(outcome.text).toContain('已记住')
    expect(outcome.text).toContain('路由已调整')
    expect(outcome.text).toContain('项目库')
    const hits = await f.project.searchLexical({ text: '本会话完成', scope: 'project', limit: 5 })
    expect(hits).toHaveLength(1)
    const record = await f.project.get(hits[0]?.id ?? '')
    expect(record?.scope).toBe('project')
    expect(record?.kind).toBe('episodic')
    await f.close()
  })

  it('显式同时给 kind:semantic + scope:user → 护栏不覆盖，进用户库', async () => {
    const f = fixture(witnessOf({ lastUserMessage: () => '随便聊聊' }))
    const outcome = await run(f.tool, {
      text: recapText,
      kind: 'semantic',
      scope: 'user',
      userAsserted: false,
    })
    expect(outcome.text).toContain('已记住')
    expect(outcome.text).not.toContain('路由已调整')
    const hits = await f.user.searchLexical({ text: '本会话完成', scope: 'user', limit: 5 })
    expect(hits).toHaveLength(1)
    await f.close()
  })

  it('短结论不触发护栏（长度与路径数任一不满足都不改路由）', async () => {
    const f = fixture()
    const outcome = await run(f.tool, {
      text: '端口固定为 8080，见 src/config/server.ts。',
      kind: 'semantic',
      userAsserted: true,
    })
    expect(outcome.text).toContain('用户库')
    expect(outcome.text).not.toContain('路由已调整')
    await f.close()
  })
})
