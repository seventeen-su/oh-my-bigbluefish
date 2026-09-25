/**
 * `omb_recall` / `omb_forget` 工具测试（规划 §5.4 / §5.6 / H-3）。
 *
 * 重点：
 * - 执行体**绝不抛异常**：服务缺失、参数非法、库故障一律 `{kind:'error'}` 或降级
 * - 召回文本**逐字 + 溯源**（sourceRef / observedAt / 通道排名），空结果是正常结论
 * - 遗忘走端口 `forget(ids)`（唯一硬删除路径），给出可审计回执（删了几条 / 哪些没找到）
 */
import { describe, expect, it } from 'vitest'
import { FORGET_TOOL, RECALL_TOOL, createMemoryTools, parseForgetArgs, parseRecallArgs } from '../../../modules/memory/recall.js'
import { clockAt, fakeStore, hits, makeRecord, tagged } from './fakes.js'

const CLOCK = clockAt(1_700_000_000_000)

function toolNamed(tools: readonly { readonly name: string }[], name: string): { execute(args: unknown): unknown; parameters: { parse(input: unknown): unknown; jsonSchema?: Record<string, unknown> }; description: string } {
  const found = tools.find(tool => tool.name === name)
  expect(found, `缺少工具 ${name}`).toBeDefined()
  return found as never
}

describe('参数校验：零抛异常，给可读原因', () => {
  it('omb_recall', () => {
    expect(parseRecallArgs({ query: '项目用什么包管理器' })).toEqual({
      ok: true,
      value: { query: '项目用什么包管理器' },
    })
    expect(parseRecallArgs({ query: 'x', limit: 3, scope: 'user', kinds: ['semantic'], rerank: true })).toEqual({
      ok: true,
      value: { query: 'x', limit: 3, scope: 'user', kinds: ['semantic'], rerank: true },
    })
    for (const bad of [null, 42, [], {}, { query: '' }, { query: 'x', limit: 0 }, { query: 'x', limit: 99 }, { query: 'x', scope: 'global' }, { query: 'x', kinds: [] }, { query: 'x', kinds: ['nope'] }, { query: 'x', rerank: 'yes' }]) {
      const parsed = parseRecallArgs(bad)
      expect(parsed.ok, `${JSON.stringify(bad)} 应被拒绝`).toBe(false)
    }
  })

  it('omb_forget：不接受空参数（不做整库擦除）', () => {
    expect(parseForgetArgs({ ids: ['a', 'a', 'b'] })).toEqual({ ok: true, value: { ids: ['a', 'b'] } })
    expect(parseForgetArgs({ id: 'a' })).toEqual({ ok: true, value: { ids: ['a'] } })
    for (const bad of [null, {}, { ids: [] }, { ids: 'a' }, { ids: [1] }, { id: 7 }, { ids: [' '] }]) {
      expect(parseForgetArgs(bad).ok, `${JSON.stringify(bad)} 应被拒绝`).toBe(false)
    }
    const tooMany = parseForgetArgs({ ids: Array.from({ length: 501 }, (_, i) => `id-${i}`) })
    expect(tooMany.ok).toBe(false)
  })
})

describe('omb_recall：逐字 + 溯源 + 一等结果的空召回', () => {
  const records = [
    makeRecord({
      id: 'trace-1',
      text: '用户的偏好：所有回复用中文，术语保留英文原文',
      sourceRef: 'session:s1#turn:7',
      observedAt: 1_699_000_000_000,
      assertedBy: 'user',
    }),
    makeRecord({ id: 'trace-2', text: '项目用 pnpm 而不是 npm', sourceRef: 'session:s1#turn:9', observedAt: 1_699_100_000_000 }),
  ]

  it('工具名/描述/参数 schema 齐全，且带 jsonSchema（模型看不到我们的校验器）', () => {
    const store = fakeStore({ scope: 'user', records })
    const tools = createMemoryTools({ resolveStores: () => [tagged(store)], clock: CLOCK, ports: () => ({ clock: CLOCK }) })
    expect(tools.map(t => t.name)).toEqual([RECALL_TOOL, FORGET_TOOL])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20)
      const schema = (tool.parameters as { jsonSchema?: Record<string, unknown> }).jsonSchema
      expect(schema, `${tool.name} 缺少 jsonSchema`).toBeDefined()
      expect(schema?.type).toBe('object')
    }
  })

  it('正常召回：逐字文本、sourceRef、observedAt、通道排名都在', async () => {
    const store = fakeStore({ scope: 'user', records })
    const tool = toolNamed(createMemoryTools({ resolveStores: () => [tagged(store)], clock: CLOCK, ports: () => ({ clock: CLOCK }) }), RECALL_TOOL)
    const outcome = (await tool.execute({ query: 'pnpm 包管理器' })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('项目用 pnpm 而不是 npm') // 逐字
    expect(outcome.text).toContain('sourceRef=session:s1#turn:9')
    expect(outcome.text).toContain('observedAt=2023-11-04')
    expect(outcome.text).toContain('通道 lexical#1')
  })

  it('零命中 → 仍是 text（一等结果），并明确要求不要编造', async () => {
    const store = fakeStore({ scope: 'user', records })
    const tool = toolNamed(createMemoryTools({ resolveStores: () => [tagged(store)], clock: CLOCK, ports: () => ({ clock: CLOCK }) }), RECALL_TOOL)
    const outcome = (await tool.execute({ query: 'zzz-nonexistent-topic' })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('零命中')
    expect(outcome.text).toContain('不要编造')
  })

  it('tight 压力 → 门控跳过，文本解释原因（软信号可被 dsh 关掉）', async () => {
    const store = fakeStore({ scope: 'user', records })
    const tools = createMemoryTools({
      resolveStores: () => [tagged(store)],
      clock: CLOCK,
      ports: () => ({ clock: CLOCK }),
      pressureBand: () => 'tight',
    })
    const tool = toolNamed(tools, RECALL_TOOL)
    const outcome = (await tool.execute({ query: 'pnpm' })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('pressure-tight')
    expect(store.calls.searchLexical).toBe(0) // 门控跳过 → 零 I/O
  })

  it('时钟故障（clock.now 抛异常）→ 不抛，降级并继续（纯词法路径完整）', async () => {
    const store = fakeStore({ scope: 'user', records })
    const tools = createMemoryTools({
      resolveStores: () => [tagged(store)],
      clock: {
        now: () => {
          throw new Error('宿主时钟未就绪')
        },
      },
    })
    const outcome = (await toolNamed(tools, RECALL_TOOL).execute({ query: 'pnpm', rerank: true })) as {
      kind: string
      text: string
    }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('时钟不可用')
    expect(outcome.text).toContain('项目用 pnpm 而不是 npm')
  })

  it('服务缺失 / resolveStores 抛异常 / 参数非法 → kind:error，绝不抛', async () => {
    const missing = toolNamed(createMemoryTools({ resolveStores: () => undefined, clock: CLOCK }), RECALL_TOOL)
    const throwing = toolNamed(
      createMemoryTools({
        resolveStores: () => {
          throw new Error('内核服务表被清空')
        },
        clock: CLOCK,
      }),
      RECALL_TOOL,
    )
    const store = fakeStore({ scope: 'user', records })
    const ok = toolNamed(createMemoryTools({ resolveStores: () => [tagged(store)], clock: CLOCK }), RECALL_TOOL)

    for (const [tool, args] of [
      [missing, { query: 'x' }],
      [throwing, { query: 'x' }],
      [ok, {}],
      [ok, { query: '' }],
    ] as const) {
      const outcome = (await tool.execute(args)) as { kind: string; text: string }
      expect(outcome.kind).toBe('error')
      expect(outcome.text.length).toBeGreaterThan(6)
    }
  })

  it('库故障 → 降级文本（仍返回 text，不抛）', async () => {
    const broken = fakeStore({ scope: 'user', failSearch: '库文件损坏' })
    const tool = toolNamed(createMemoryTools({ resolveStores: () => [tagged(broken)], clock: CLOCK }), RECALL_TOOL)
    const outcome = (await tool.execute({ query: 'x' })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('库文件损坏')
  })

  it('第二通道经 ports 注入后参与融合（文本里能看到 vector#1）', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'a', text: '契约边界' })],
      search: () => hits(['a']),
    })
    const tools = createMemoryTools({
      resolveStores: () => [tagged(store)],
      clock: CLOCK,
      ports: () => ({
        clock: CLOCK,
        channels: [{ name: 'vector', search: () => Promise.resolve([{ id: 'a', score: 1, channel: 'vector' }]) }],
      }),
    })
    const outcome = (await toolNamed(tools, RECALL_TOOL).execute({ query: '契约' })) as { kind: string; text: string }
    expect(outcome.text).toContain('lexical#1+vector#1')
  })
})

describe('omb_forget：唯一硬删除路径 + 可审计回执', () => {
  it('删除存在与不存在的 id：回执如实（删了几条 / 哪些没找到）', async () => {
    const user = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'u1', text: '关于我的偏好' }), makeRecord({ id: 'u2', text: '我的时区' })],
    })
    const project = fakeStore({ scope: 'project', records: [makeRecord({ id: 'p1', scope: 'project', text: '项目约定' })] })
    const tool = toolNamed(createMemoryTools({ resolveStores: () => [tagged(user), tagged(project)], clock: CLOCK }), FORGET_TOOL)

    const outcome = (await tool.execute({ ids: ['u1', 'p1', 'ghost'] })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('已硬删除 2 条')
    expect(outcome.text).toContain('user 1')
    expect(outcome.text).toContain('project 1')
    expect(outcome.text).toContain('未找到 1 条')
    expect(outcome.text).toContain('ghost')
    // 每库一次批量定位 + 一次 forget；不是 N+1
    expect(user.calls.getMany).toBe(1)
    expect(project.calls.getMany).toBe(1)
    expect(user.forgetCalls).toEqual([['u1']])
    expect(project.forgetCalls).toEqual([['p1']])
  })

  it('单条写法 { id } 等价于 { ids: [id] }', async () => {
    const store = fakeStore({ scope: 'user', records: [makeRecord({ id: 'u1', text: 'x' })] })
    const tool = toolNamed(createMemoryTools({ resolveStores: () => [tagged(store)], clock: CLOCK }), FORGET_TOOL)
    const outcome = (await tool.execute({ id: 'u1' })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('已硬删除 1 条')
  })

  it('服务缺失 / 参数非法 / forget 抛异常 → kind:error，绝不抛', async () => {
    const store = fakeStore({ scope: 'user', records: [makeRecord({ id: 'u1', text: 'x' })], failForget: '库只读' })
    const missing = toolNamed(createMemoryTools({ resolveStores: () => undefined, clock: CLOCK }), FORGET_TOOL)
    const broken = toolNamed(createMemoryTools({ resolveStores: () => [tagged(store)], clock: CLOCK }), FORGET_TOOL)

    const missingOutcome = (await missing.execute({ ids: ['u1'] })) as { kind: string }
    expect(missingOutcome.kind).toBe('error')
    const badArgs = (await broken.execute({})) as { kind: string }
    expect(badArgs.kind).toBe('error')
    const failed = (await broken.execute({ ids: ['u1'] })) as { kind: string; text: string }
    expect(failed.kind).toBe('text') // 单项失败只降级
    expect(failed.text).toContain('库只读')
  })

  it('forget 走端口：删掉的条目不再被召回（唯一硬删除路径）', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'u1', text: '要被遗忘的偏好' }), makeRecord({ id: 'u2', text: '保留的偏好' })],
    })
    const tools = createMemoryTools({ resolveStores: () => [tagged(store)], clock: CLOCK, ports: () => ({ clock: CLOCK }) })
    const before = (await toolNamed(tools, RECALL_TOOL).execute({ query: '偏好' })) as { text: string }
    expect(before.text).toContain('要被遗忘的偏好')

    await toolNamed(tools, FORGET_TOOL).execute({ ids: ['u1'] })
    const after = (await toolNamed(tools, RECALL_TOOL).execute({ query: '偏好' })) as { text: string }
    expect(after.text).not.toContain('要被遗忘的偏好')
    expect(after.text).toContain('保留的偏好')
  })
})
