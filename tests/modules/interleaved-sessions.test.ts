/**
 * **交错会话**：A turn → B turn → A tool call → B tool call，断言状态没有串味。
 *
 * 这是 task-7 的核心判据。它跑**真实装配**（真内核 + 真模块 + 真 SQLite），
 * 因为要证明的是生产路径上的一条不变式：
 *
 * ```
 * 宿主 exec.agent.id  →  dsh 桥（ToolCallContext）  →  工具执行体  →  按会话选库/写溯源
 * ```
 *
 * 修复前的形态：工具归属读的是模块自己记的 `lastActiveSession`（"最近一个会话"）。
 * 于是 `A turn → B turn → A 工具调用` 这条顺序里，A 的调用读到的是 **B**：
 * 记忆写进 B 的项目库、`sourceRef` 记成 B、压力和档位也读 B 的。
 *
 * 现在每一格断言都指向"**这次调用自己的**会话"：
 * ① A 的写入落在 A 的项目库、B 的落在 B 的项目库，两个库互不含对方的正文
 * ② `sourceRef` = `session:A#turn-1` / `session:B#turn-1`（不是"最近那个"）
 * ③ `project` 字段是各自会话的 cwd，且两者不同
 * ④ 归属未知（宿主没给 agent）时**不借用**任何会话：只写用户库、`project` 为 null
 * ⑤ 读路径同样按会话取库，且归属未知时**明说**"只查了用户库"
 * ⑥ 桥把宿主 exec 的 agent 一路传到执行体（来源不在边界上被丢掉）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createKernel, type KernelHandle } from '../../kernel/index.js'
import type { MemoryRecord, ModuleRegistration, ToolDefinition } from '../../kernel/abi/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { toolCallContext } from '../../kernel/sessionRuntime.js'
import { createMemoryRegistration } from '../../modules/memory/index.js'
import { asMemoryStore, type MemoryStoresService } from '../../modules/memory/store.js'
import { toRegistrable } from '../../dsh/tool-bridge.js'
import { capturingLogger, fixedClock, testPort } from './memory/helpers.js'

/** 两个项目目录（各自有独立的项目库文件）。 */
function twoProjects(): { readonly a: string; readonly b: string } {
  const root = mkdtempSync(join(tmpdir(), 'omb-interleave-'))
  return { a: join(root, 'A'), b: join(root, 'B') }
}

const kernelRow: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.2.0',
    requires: [],
    capabilities: [],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试替身' }),
  },
  apply: () => {},
}

interface Fixture {
  readonly handle: KernelHandle
  readonly service: MemoryStoresService
  readonly projectA: string
  readonly projectB: string
  tool(name: string): ToolDefinition
  /** 观测到一次回合边界（`dsh/` 在 `session/event` 里做的事）。 */
  turn(sessionId: string, turn: number): void
  dispose(): Promise<void>
}

async function fixture(): Promise<Fixture> {
  const projects = twoProjects()
  const port = testPort(join(projects.a, 'dsh-home'))
  const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
  const registration = createMemoryRegistration({ storageHost: port })
  expect(handle.start([kernelRow, registration])).toEqual([])

  const service = handle.kernel.service<MemoryStoresService>(SERVICES.stores)
  const sessions = handle.kernel.service<{ remember(session: string, cwd?: string): void }>(
    SERVICES.activeSession,
  )
  if (service === undefined || sessions === undefined) throw new Error('装配缺失：stores / activeSession')

  // 会话 cwd 登记到**唯一来源**（内核登记处）；记忆模块从这里解析项目库
  sessions.remember('A', projects.a)
  sessions.remember('B', projects.b)

  const tools = handle.kernel.service<readonly ToolDefinition[]>('tools:omb-memory') ?? []
  return {
    handle,
    service,
    projectA: projects.a,
    projectB: projects.b,
    tool: name => {
      const found = tools.find(candidate => candidate.name === name)
      if (found === undefined) throw new Error(`没有工具 ${name}`)
      return found
    },
    turn: (sessionId, turn) => {
      handle.kernel.emit('turn/start', { sessionId, turn })
    },
    async dispose() {
      handle.dispose()
      await service.close()
    },
  }
}

/** 指定库里的全部正文。空库 → `[]`。 */
async function textsOf(
  set: { readonly store: (scope: 'project') => unknown } | undefined,
  query: string,
): Promise<readonly string[]> {
  const store = asMemoryStore(set?.store('project') as never)
  if (store === undefined) return []
  const hits = await store.searchLexical({ text: query, scope: 'project', limit: 10 })
  const out: string[] = []
  for (const hit of hits) {
    const record = await store.get(hit.id)
    if (record !== undefined) out.push(record.text)
  }
  return out
}

/** 在（项目）库里读回一条记录。 */
async function recordIn(
  set: { readonly store: (scope: 'project') => unknown } | undefined,
  query: string,
): Promise<MemoryRecord | undefined> {
  const store = asMemoryStore(set?.store('project') as never)
  if (store === undefined) return undefined
  const hits = await store.searchLexical({ text: query, scope: 'project', limit: 5 })
  return hits[0] === undefined ? undefined : await store.get(hits[0].id)
}

describe('交错会话：A/B 的回合与工具调用交错，状态绝不串味', () => {
  it('A turn → B turn → A 写 → B 写：各写各的项目库、溯源与 project', async () => {
    const fx = await fixture()
    try {
      // ① 回合边界交错到达（旧实现正是在这里把归属停在了 B）
      fx.turn('A', 1)
      fx.turn('B', 1)
      await fx.service.forSession('A')
      await fx.service.forSession('B')

      const remember = fx.tool('omb_remember')
      const a = await remember.execute(
        { text: 'A 项目的端口是 8081', kind: 'episodic', userAsserted: true },
        toolCallContext({ sessionId: 'A', callId: 'call-A' }),
      )
      const b = await remember.execute(
        { text: 'B 项目的端口是 9091', kind: 'episodic', userAsserted: true },
        toolCallContext({ sessionId: 'B', callId: 'call-B' }),
      )
      expect(a.kind).toBe('text')
      expect(b.kind).toBe('text')

      const setA = await fx.service.forSession('A')
      const setB = await fx.service.forSession('B')
      const recordA = await recordIn(setA, '8081')
      const recordB = await recordIn(setB, '9091')

      // ② 归属正确：正文、溯源、project 三处都对
      expect(recordA?.text).toBe('A 项目的端口是 8081')
      expect(recordB?.text).toBe('B 项目的端口是 9091')
      expect(recordA?.sourceRef).toBe('session:A#turn-1')
      expect(recordB?.sourceRef).toBe('session:B#turn-1')
      expect(recordA?.project).toBe(setA?.projectScope)
      expect(recordB?.project).toBe(setB?.projectScope)
      expect(recordA?.project).not.toBe(recordB?.project)

      // ③ **关键反证**：A 的库里没有 B 的正文，B 的库里没有 A 的正文
      expect(await textsOf(setA, '端口')).toEqual(['A 项目的端口是 8081'])
      expect(await textsOf(setB, '端口')).toEqual(['B 项目的端口是 9091'])
      // 两者都是 episodic → 项目库；用户库为空
      expect((await fx.service.snapshot().user?.store('user')?.stats())?.rows).toBe(0)
    } finally {
      await fx.dispose()
    }
  })

  it('归属未知（宿主没给 agent）时**不借用**任何会话：只写用户库、project 为 null', async () => {
    const fx = await fixture()
    try {
      fx.turn('A', 1)
      fx.turn('B', 1)
      await fx.service.forSession('A')
      await fx.service.forSession('B')

      const remember = fx.tool('omb_remember')
      const unknown = toolCallContext({})
      expect(unknown.attribution).toBe('unknown')

      const outcome = await remember.execute(
        {
          text: '没有会话归属时写下的条目',
          kind: 'semantic',
          // 用户陈述（本进程拿不到用户消息原文 → 如实记为"自报未核对"），
          // 避开"可由工件复现"那条需要 git 核验的准入路径（临时目录不在 git 里）
          userAsserted: true,
          sourceRef: 'file:docs/x.md#L1',
        },
        unknown,
      )
      expect(outcome.kind).toBe('text')
      expect(outcome.kind === 'text' ? outcome.text : '').toContain('已记住')

      // 落到**用户库**（没有会话 → 拿不到项目库），project 必须是 null
      const user = fx.service.snapshot().user?.store('user')
      const hits = await user?.searchLexical({ text: '没有会话归属', scope: 'user', limit: 5 })
      const record = await user?.get(hits?.[0]?.id ?? 'x')
      expect(record?.text).toBe('没有会话归属时写下的条目')
      expect(record?.project).toBeNull()
      expect(record?.sourceRef).toBe('file:docs/x.md#L1')

      // 两个项目库都没被写
      expect(await textsOf(await fx.service.forSession('A'), '端口')).toEqual([])
      expect(await textsOf(await fx.service.forSession('B'), '端口')).toEqual([])
    } finally {
      await fx.dispose()
    }
  })

  it('召回按本次调用的会话取库：A 召回不到 B 的项目记忆；归属未知时明说"只查了用户库"', async () => {
    const fx = await fixture()
    try {
      fx.turn('A', 1)
      fx.turn('B', 1)
      await fx.service.forSession('A')
      await fx.service.forSession('B')
      await fx.tool('omb_remember').execute(
        { text: 'B 项目的端口是 9091', kind: 'episodic', userAsserted: true },
        toolCallContext({ sessionId: 'B', callId: 'call-B' }),
      )

      const recall = fx.tool('omb_recall')
      const fromA = await recall.execute({ query: '端口' }, toolCallContext({ sessionId: 'A', callId: 'call-A1' }))
      expect(fromA.kind).toBe('text')
      // A 的会话里没有这条项目记忆（它属于 B 的项目库）
      expect(fromA.kind === 'text' ? fromA.text : '').not.toContain('9091')

      // 归属未知：只查用户库，而且**明说**——不让读者以为"那里本来就没有记忆"
      const unknown = await recall.execute({ query: '端口' }, toolCallContext({}))
      const text = unknown.kind === 'text' ? unknown.text : ''
      expect(text).toContain('归属未知')
      expect(text).toContain('只查了用户库')
    } finally {
      await fx.dispose()
    }
  })

  it('桥：宿主 exec 的 agent 一路传到执行体（A/B 各拿各的会话，来源不在边界上丢掉）', async () => {
    const seen: (string | undefined)[] = []
    const tool: ToolDefinition = {
      name: 'probe',
      description: 'probe',
      parameters: { parse: (input: unknown) => input } as ToolDefinition['parameters'],
      execute(_args: unknown, call) {
        seen.push(call?.sessionId)
        return { kind: 'text', text: call?.sessionId ?? 'none' }
      },
    }
    // 走与生产同一条转换路径（`dsh/tool-bridge.ts` 的 `toRegistrable`）
    const spec = toRegistrable(tool)
    expect(spec).toBeDefined()
    await spec?.run({}, toolCallContext({ sessionId: 'A', callId: 'c1' }))
    await spec?.run({}, toolCallContext({ sessionId: 'B', callId: 'c2' }))
    await spec?.run({}, toolCallContext({}))
    expect(seen).toEqual(['A', 'B', undefined])
  })
})
