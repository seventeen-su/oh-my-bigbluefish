import { describe, expect, it } from 'vitest'
import type { ChannelHit, EntitySummary } from '../../../../packages/v7/src/ports/store.js'
import {
  compileRetrievalPlan,
  parseRetrievalPlan,
  planFingerprint,
  rebaseRetrievalPlan,
  PROVIDER_CHANNELS,
  type RetrievalPlan,
} from '../../../../packages/v7/src/retrieval/compiler.js'
import { DEFAULT_RETRIEVAL_CONFIG, createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import { RecallEngine } from '../../../../packages/v7/src/retrieval/engine.js'
import { createExpansionProviders, createStageOneProviders, runProviderSet } from '../../../../packages/v7/src/retrieval/providers/index.js'
import { FakeClock, FakeEmbedder, FakeStore, FIXED_NOW, hit, makeEngine, summary } from './fake.js'

const ANCHOR = Date.parse(FIXED_NOW)
const COMPILE = { config: DEFAULT_RETRIEVAL_CONFIG, now: FIXED_NOW, executionAnchorMs: ANCHOR }

function seedMemory(store: FakeStore, ids: readonly string[], overrides: Partial<EntitySummary> = {}): void {
  for (const id of ids) store.summariesById.set(id, summary({ id, ...overrides }))
}

/** 计划只能是 JSON 数据：递归检查没有函数/类实例/连接混进来。 */
function assertJsonData(value: unknown): void {
  if (value === null) return
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) assertJsonData(item)
    return
  }
  expect(['string', 'number', 'boolean']).toContain(typeof value)
}

class HangingFulltextStore extends FakeStore {
  override async fulltext(): Promise<ChannelHit[]> {
    // 永不 resolve：只有 deadline 能结束等待，测试因此是确定性的（不依赖 DNS/慢查询）。
    return new Promise<ChannelHit[]>(() => {})
  }
}

describe('RetrievalPlan 编译（纯函数）', () => {
  it('给定召回请求当编译则计划覆盖场景/作用域/查询/词表/时间窗/provider/limit/deadline 且可 JSON 往返', () => {
    const plan = compileRetrievalPlan({
      query: 'TS2304 handleFix /src/main.ts 昨天',
      scenario: 'tool-error',
      scope: 'project',
      projectKey: 'D:/repo',
      limit: 7,
    }, COMPILE)

    expect(plan.schema).toBe('omb.retrieval-plan/1')
    expect(plan.configVersion).toBe(DEFAULT_RETRIEVAL_CONFIG.version)
    expect(plan.scenario).toBe('tool-error')
    expect(plan.filters).toEqual({
      scope: 'project',
      projectKey: 'D:/repo',
      includeArchived: false,
      includeHistory: false,
    })
    expect(plan.query).toBe('TS2304 handleFix /src/main.ts 昨天')
    expect(plan.normalizedQuery).toBe(plan.query.toLowerCase())
    expect(plan.limit).toBe(7)
    expect(plan.terms.length).toBeGreaterThan(0)
    expect(plan.terms.every(term => typeof term.term === 'string' && term.weight > 0)).toBe(true)
    expect(plan.signals.paths).toContain('/src/main.ts')
    expect(plan.signals.identifiers).toContain('TS2304')
    // 查询时间锚点按 FIXED_NOW 展开“昨天”，与执行 deadline 锚点无关。
    expect(plan.time.now).toBe(FIXED_NOW)
    expect(plan.time.lookback).toEqual({ from: '2026-11-21T00:00:00.000Z', to: FIXED_NOW })
    expect(plan.providers.map(provider => provider.channel)).toEqual([...PROVIDER_CHANNELS])
    expect(plan.deadline).toEqual({ atMs: ANCHOR + 1500, ms: 1500 })
    expect(plan.budget).toEqual({
      terms: 48,
      candidates: DEFAULT_RETRIEVAL_CONFIG.channelLimit,
      seeds: DEFAULT_RETRIEVAL_CONFIG.seedLimit,
      chainGroups: DEFAULT_RETRIEVAL_CONFIG.maxChainGroups,
    })

    const stored = JSON.parse(JSON.stringify(plan)) as unknown
    expect(stored).toEqual(plan)
    expect(parseRetrievalPlan(stored)).toEqual(plan)
    assertJsonData(plan)
  })

  it('给定同一请求当重复编译则 hash 稳定，场景变化则 hash 改变且可复算', () => {
    const first = compileRetrievalPlan({ query: 'needle' }, COMPILE)
    const second = compileRetrievalPlan({ query: 'needle' }, COMPILE)

    expect(first.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(second.hash).toBe(first.hash)
    expect(planFingerprint(first)).toBe(first.hash)

    const otherScenario = compileRetrievalPlan({ query: 'needle', scenario: 'tool-error' }, COMPILE)
    const otherQuery = compileRetrievalPlan({ query: 'needle 2' }, COMPILE)
    expect(otherScenario.hash).not.toBe(first.hash)
    expect(otherQuery.hash).not.toBe(first.hash)
  })

  it('给定权重版本变化当编译则计划带该 configVersion 且 hash 改变', () => {
    const oldConfig = createRetrievalConfig({ version: 'v7-retrieval-old' })
    const plan = compileRetrievalPlan({ query: 'needle' }, { ...COMPILE, config: oldConfig })
    const current = compileRetrievalPlan({ query: 'needle' }, COMPILE)

    expect(plan.configVersion).toBe('v7-retrieval-old')
    expect(current.configVersion).toBe(DEFAULT_RETRIEVAL_CONFIG.version)
    expect(plan.hash).not.toBe(current.hash)
  })

  it('给定计划被篡改当解析则按 hash/schema/结构拒绝', () => {
    const plan = compileRetrievalPlan({ query: 'needle' }, COMPILE)

    expect(() => parseRetrievalPlan({ ...plan, limit: 99 })).toThrow(/hash 不匹配/)
    expect(() => parseRetrievalPlan({ ...plan, schema: 'omb.retrieval-plan/0' })).toThrow(/schema 不匹配/)
    expect(() => parseRetrievalPlan('not-a-plan')).toThrow(/必须是对象/)
    expect(() => parseRetrievalPlan({ ...plan, scenario: 'nope' })).toThrow(/scenario 非法/)
  })

  it('给定长查询当编译则词表有界、信号词权重最高且顺序确定', () => {
    const keywords = Array.from({ length: 80 }, (_, index) => `kw${index}`)
    // 信号词必须在查询前部：extractQuerySignals 对 identifiers 有 24 条上限（长文本后部标识符不参与触发）。
    const query = `TS2304 handleFix /src/main.ts ${keywords.join(' ')}`
    const plan = compileRetrievalPlan({ query }, COMPILE)
    const again = compileRetrievalPlan({ query }, COMPILE)

    expect(plan.terms).toHaveLength(48)
    expect(again.terms).toEqual(plan.terms)
    // 错误码/标识符权重 1.5，必须排在最前；普通词与 CJK 单字排在后面。
    expect(plan.terms[0]?.weight).toBe(1.5)
    expect(plan.terms[0]?.kind).toBe('signal')
    expect(plan.terms.some(term => term.term === 'ts2304' && term.weight === 1.5)).toBe(true)
    expect(plan.terms.some(term => term.term === 'handlefix' && term.weight === 1.5)).toBe(true)
    expect(plan.terms.some(term => term.term === 'kw79')).toBe(false)
  })

  it('给定显式 timeWindow 当编译则 lookback 与 explicit 都用它且无回退原因', () => {
    const window = { from: '2026-11-15T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' }

    const plan = compileRetrievalPlan({ query: 'deploy', timeWindow: window }, COMPILE)

    expect(plan.time.explicit).toEqual(window)
    expect(plan.time.lookback).toEqual(window)
    expect(plan.time.fallbackReason).toBeUndefined()
  })

  it('给定非法 timeWindow 当编译则回退场景默认窗并把原因写进计划', () => {
    const plan = compileRetrievalPlan({
      query: 'deploy',
      timeWindow: { from: '2026-11-20T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' },
    }, COMPILE)

    expect(plan.time.explicit).toBeUndefined()
    expect(plan.time.fallbackReason).toContain('timeWindow')
    // manual 场景默认回看 7 天；非法窗不能把候选静默截断。
    expect(plan.time.lookback).toEqual({ from: '2026-11-15T00:00:00.000Z', to: FIXED_NOW })
  })

  it('给定 expand=none 当编译则 links/expand provider 禁用、其它六个启用', () => {
    const plan = compileRetrievalPlan({ query: 'needle', expand: 'none' }, COMPILE)

    expect(plan.expand).toBe('none')
    expect(plan.hops).toBe(2)
    expect(plan.providers.filter(provider => !provider.enabled).map(provider => provider.channel)).toEqual(['links', 'expand'])
    expect(plan.providers.filter(provider => provider.enabled)).toHaveLength(6)
  })

  it('给定历史计划当重锚 deadline 则查询语义不变、deadline 前移且 hash 更新', () => {
    const plan = compileRetrievalPlan({ query: 'deploy' }, {
      ...COMPILE,
      executionAnchorMs: Date.parse('2020-01-01T00:00:00.000Z'),
    })

    // 查询时间锚点是 2026，执行 deadline 却锚在 2020：两层时间互不影响。
    expect(plan.time.now).toBe(FIXED_NOW)
    expect(plan.deadline.atMs).toBe(Date.parse('2020-01-01T00:00:00.000Z') + 1500)

    const rebased = rebaseRetrievalPlan(plan, ANCHOR, 500)

    expect(rebased.deadline).toEqual({ atMs: ANCHOR + 500, ms: 500 })
    expect(rebased.query).toBe(plan.query)
    expect(rebased.terms).toEqual(plan.terms)
    expect(rebased.time).toEqual(plan.time)
    expect(rebased.hash).not.toBe(plan.hash)
    expect(parseRetrievalPlan(JSON.parse(JSON.stringify(rebased))).hash).toBe(rebased.hash)
  })

  it('给定引擎预算覆盖当编译计划则 deadline 与 provider 超时按覆盖值', () => {
    const engine = new RecallEngine({
      store: new FakeStore(),
      embedder: new FakeEmbedder(),
      clock: new FakeClock(),
      stageOneBudgetMs: 800,
      providerTimeoutMs: 300,
    })

    const plan = engine.compilePlan({ query: 'needle', now: FIXED_NOW })

    expect(plan.deadline).toEqual({ atMs: ANCHOR + 800, ms: 800 })
    expect(plan.providers.every(provider => provider.timeoutMs === 300)).toBe(true)
  })
})

describe('统一 Provider 执行（deadline / 失败隔离 / 状态）', () => {
  it('给定 provider 工厂当枚举则八个通道统一接口且 channel 唯一', () => {
    const providers = [...createStageOneProviders(), ...createExpansionProviders()]

    expect(providers).toHaveLength(8)
    expect(new Set(providers.map(provider => provider.channel))).toEqual(new Set(PROVIDER_CHANNELS))
    for (const provider of providers) expect(typeof provider.search).toBe('function')
  })

  it('给定一个通道抛错当并行执行则失败隔离，其它通道仍是 empty/ok', async () => {
    const store = new FakeStore()
    store.failures.fulltext = new Error('fulltext boom')
    store.channelHits.vector = [hit('mem_v', 1, 0.8, 'vector')]
    const plan = compileRetrievalPlan({ query: 'needle' }, COMPILE)
    const parallel = createStageOneProviders().filter(provider => provider.afterStageOne !== true)

    const outcomes = await runProviderSet(parallel, plan, { store, embedder: new FakeEmbedder() }, { nowMs: ANCHOR })
    const byChannel = new Map(outcomes.map(outcome => [outcome.channel, outcome]))

    expect(byChannel.get('fulltext')?.status).toBe('failed')
    expect(byChannel.get('fulltext')?.issues).toEqual([
      { code: 'internal', message: 'fulltext boom', retryable: false },
    ])
    expect(byChannel.get('vector')?.status).toBe('ok')
    expect(byChannel.get('vector')?.hits.map(entry => entry.entityId)).toEqual(['mem_v'])
    expect(byChannel.get('trigger')?.status).toBe('empty')
    expect(byChannel.get('time')?.status).toBe('empty')
    expect(byChannel.get('state_board')?.status).toBe('empty')
    // 依赖阶段一的 single_char 不在这一组里，由 orchestrator 串行调度。
    expect(byChannel.has('single_char')).toBe(false)
  })

  it('给定 provider 永不返回当 deadline 触发则状态为 deadline 且其它通道不受影响', async () => {
    const store = new HangingFulltextStore()
    store.channelHits.vector = [hit('mem_v', 1, 0.8, 'vector')]
    const plan = compileRetrievalPlan({ query: 'needle' }, {
      ...COMPILE,
      budgetMs: 300,
      providerTimeoutMs: 20,
    })
    const parallel = createStageOneProviders().filter(provider => provider.afterStageOne !== true)

    const outcomes = await runProviderSet(parallel, plan, { store, embedder: new FakeEmbedder() }, { nowMs: ANCHOR })
    const byChannel = new Map(outcomes.map(outcome => [outcome.channel, outcome]))

    expect(byChannel.get('fulltext')?.status).toBe('deadline')
    expect(byChannel.get('fulltext')?.reason).toContain('deadline 20ms')
    expect(byChannel.get('fulltext')?.issues).toEqual([])
    expect(byChannel.get('vector')?.status).toBe('ok')
    expect(byChannel.get('vector')?.hits.map(entry => entry.entityId)).toEqual(['mem_v'])
  })

  it('给定计划 deadline 已过期当执行则全部 deadline 且不发任何存储查询', async () => {
    const store = new FakeStore()
    const plan = compileRetrievalPlan({ query: 'needle' }, {
      ...COMPILE,
      executionAnchorMs: Date.parse('2020-01-01T00:00:00.000Z'),
    })
    const parallel = createStageOneProviders().filter(provider => provider.afterStageOne !== true)

    const outcomes = await runProviderSet(parallel, plan, { store, embedder: new FakeEmbedder() }, { nowMs: ANCHOR })

    expect(outcomes.every(outcome => outcome.status === 'deadline')).toBe(true)
    expect(outcomes[0]?.reason).toContain('deadline 已过期')
    expect(store.calls.fulltext).toHaveLength(0)
    expect(store.calls.vector).toHaveLength(0)
    expect(store.calls.time).toHaveLength(0)
  })

  it('给定计划禁用某 provider 当执行则 skipped 且不查存储', async () => {
    const store = new FakeStore()
    const plan = compileRetrievalPlan({ query: 'needle' }, COMPILE)
    const disabled: RetrievalPlan = {
      ...plan,
      providers: plan.providers.map(provider => provider.channel === 'vector' ? { ...provider, enabled: false } : provider),
    }
    const vectorProviders = createStageOneProviders().filter(provider => provider.channel === 'vector')

    const outcomes = await runProviderSet(vectorProviders, disabled, { store, embedder: new FakeEmbedder() }, { nowMs: ANCHOR })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['skipped'])
    expect(outcomes[0]?.reason).toBe('计划未启用该 provider')
    expect(store.calls.vector).toHaveLength(0)
  })

  it('给定嵌入器不可用当 vector provider 执行则 unavailable 且不查存储', async () => {
    const store = new FakeStore()
    store.channelHits.vector = [hit('mem_v', 1, 0.8, 'vector')]
    const embedder = new FakeEmbedder()
    embedder.availableResult = false
    const plan = compileRetrievalPlan({ query: 'needle' }, COMPILE)
    const vectorProviders = createStageOneProviders().filter(provider => provider.channel === 'vector')

    const outcomes = await runProviderSet(vectorProviders, plan, { store, embedder }, { nowMs: ANCHOR })

    expect(outcomes[0]?.status).toBe('unavailable')
    expect(outcomes[0]?.reason).toBe('嵌入器不可用')
    expect(outcomes[0]?.issues).toEqual([])
    expect(store.calls.vector).toHaveLength(0)
  })

  it('给定全文零命中且查询很短当 single_char 执行则用归一化查询走 search_text 回退', async () => {
    const store = new FakeStore()
    store.channelHits.single_char = [hit('mem_c', 1, 0.5, 'single_char')]
    const plan = compileRetrievalPlan({ query: '猫' }, COMPILE)
    const providers = createStageOneProviders().filter(provider => provider.channel === 'single_char')

    const outcomes = await runProviderSet(providers, plan, { store, embedder: new FakeEmbedder() }, {
      nowMs: ANCHOR,
      previous: new Map(),
    })

    expect(outcomes[0]?.status).toBe('ok')
    expect(outcomes[0]?.hits.map(entry => entry.entityId)).toEqual(['mem_c'])
    expect(store.calls.single_char[0]?.query).toBe('猫')
  })

  it('给定全文已有命中当 single_char 执行则跳过并说明原因', async () => {
    const store = new FakeStore()
    const plan = compileRetrievalPlan({ query: '猫' }, COMPILE)
    const providers = createStageOneProviders().filter(provider => provider.channel === 'single_char')

    const outcomes = await runProviderSet(providers, plan, { store, embedder: new FakeEmbedder() }, {
      nowMs: ANCHOR,
      previous: new Map([['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]]]),
    })

    expect(outcomes[0]?.status).toBe('skipped')
    expect(outcomes[0]?.reason).toContain('全文已有命中')
    expect(store.calls.single_char).toHaveLength(0)
  })

  it('给定查询超过单字回退长度上限当 single_char 执行则跳过并给出长度原因', async () => {
    const store = new FakeStore()
    const plan = compileRetrievalPlan({ query: 'find the bug' }, COMPILE)
    const providers = createStageOneProviders().filter(provider => provider.channel === 'single_char')

    const outcomes = await runProviderSet(providers, plan, { store, embedder: new FakeEmbedder() }, {
      nowMs: ANCHOR,
      previous: new Map(),
    })

    expect(outcomes[0]?.status).toBe('skipped')
    expect(outcomes[0]?.reason).toContain('查询长度')
    expect(store.calls.single_char).toHaveLength(0)
  })
})

describe('引擎用计划执行与重放', () => {
  it('给定 plan JSON 往返当 recallFromPlan 则命中/分数/通道报告与 recall 一致', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'], { title: 'A' })
    const engine = makeEngine(store)

    const direct = await engine.recall({ query: 'needle', now: FIXED_NOW })
    const plan = engine.compilePlan({ query: 'needle', now: FIXED_NOW })
    expect(engine.compilePlan({ query: 'needle', now: FIXED_NOW }).hash).toBe(plan.hash)
    const stored = JSON.parse(JSON.stringify(plan)) as unknown

    const replayed = await engine.recallFromPlan(stored, { traceId: 'trc_replay' })

    expect(replayed.traceId).toBe('trc_replay')
    expect(replayed.scenario).toBe(direct.scenario)
    expect(replayed.hits.map(entry => entry.entityId)).toEqual(direct.hits.map(entry => entry.entityId))
    expect(replayed.hits[0]?.score).toBeCloseTo(direct.hits[0]?.score ?? 0, 9)
    expect(replayed.hits[0]?.why).toEqual(direct.hits[0]?.why)
    expect(replayed.channels).toEqual(direct.channels)
    expect(replayed.expansion).toEqual(direct.expansion)
  })

  it('给定计划被篡改当 recallFromPlan 则拒绝执行且不查存储', async () => {
    const store = new FakeStore()
    const engine = makeEngine(store)
    const plan = engine.compilePlan({ query: 'needle', now: FIXED_NOW })
    const tampered = { ...JSON.parse(JSON.stringify(plan)) as RetrievalPlan, limit: 99 }

    await expect(engine.recallFromPlan(tampered)).rejects.toMatchObject({ error: { code: 'invalid-input' } })
    expect(store.calls.fulltext).toHaveLength(0)
  })

  it('给定计划配置版本与当前配置不同当重放则 warning 暴露漂移但仍按计划检索', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])
    const plan = compileRetrievalPlan({ query: 'needle' }, {
      config: createRetrievalConfig({ version: 'v7-retrieval-old' }),
      now: FIXED_NOW,
      executionAnchorMs: ANCHOR,
    })

    const replayed = await makeEngine(store).recallFromPlan(JSON.parse(JSON.stringify(plan)))

    expect(replayed.warnings.some(warning => warning.includes('v7-retrieval-old') && warning.includes('当前配置'))).toBe(true)
    expect(replayed.hits.map(entry => entry.entityId)).toEqual(['mem_a'])
  })

  it('给定计划预算里的种子数当重放则图扩展按计划而不是当前配置取种子', async () => {
    const store = new FakeStore()
    const ids = Array.from({ length: 5 }, (_, index) => `mem_${index + 1}`)
    store.channelHits.fulltext = ids.map((id, index) => hit(id, index + 1, 0.5, 'fulltext'))
    seedMemory(store, ids)
    const plan = compileRetrievalPlan({ query: 'needle' }, {
      config: createRetrievalConfig({ seedLimit: 2 }),
      now: FIXED_NOW,
      executionAnchorMs: ANCHOR,
    })
    expect(plan.budget.seeds).toBe(2)

    await makeEngine(store).recallFromPlan(JSON.parse(JSON.stringify(plan)))

    // 当前引擎配置 seedLimit=8，但计划是 2：重放必须按计划取种子。
    expect(store.expandCalls[0]?.seeds).toEqual(['mem_1', 'mem_2'])
  })

  it('给定通道 deadline 当引擎召回则报告 failed + deadline reason、留 warning，其它通道命中保留', async () => {
    const store = new HangingFulltextStore()
    store.channelHits.vector = [hit('mem_v', 1, 0.8, 'vector')]
    seedMemory(store, ['mem_v'])
    const engine = new RecallEngine({
      store,
      embedder: new FakeEmbedder(),
      clock: new FakeClock(),
      stageOneBudgetMs: 300,
      providerTimeoutMs: 20,
    })

    const result = await engine.recall({ query: 'needle', now: FIXED_NOW })

    const fulltext = result.channels.find(report => report.channel === 'fulltext')
    expect(fulltext?.status).toBe('failed')
    expect(fulltext?.reason).toContain('deadline')
    expect(result.warnings.some(warning => warning.includes('deadline'))).toBe(true)
    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_v'])
  })
})
