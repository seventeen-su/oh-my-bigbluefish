import { describe, expect, it } from 'vitest'
import { formatRecall, type RecallToolInput } from '../../../packages/v7/src/app/recall.js'
import { ENTITY_LIFECYCLES, isCurrentLifecycle, isEntityLifecycle, LIFECYCLE_LABELS } from '../../../packages/v7/src/domain/lifecycle.js'
import type { RecallHit } from '../../../packages/v7/src/retrieval/types.js'
import type { EntitySummary } from '../../../packages/v7/src/ports/search.js'
import { rerankPrior } from '../../../packages/v7/src/retrieval/rerank.js'
import { DEFAULT_RETRIEVAL_CONFIG } from '../../../packages/v7/src/retrieval/config.js'
import { entity, FIXED_NOW, hit, makeEngine, summary } from './retrieval/fake.js'
import { FakeStore } from './retrieval/fake.js'

const MANUAL = DEFAULT_RETRIEVAL_CONFIG.scenarios.manual

function seedMemory(store: FakeStore, id: string, overrides: Partial<EntitySummary> = {}): void {
  store.summariesById.set(id, summary({ ...overrides, id }))
}

function priorContext(overrides: {
  readonly lifecycle?: 'superseded' | 'retracted' | 'archived'
  readonly supersededAt?: string
  readonly supersededBy?: string
  readonly pinned?: boolean
  readonly adoptionCount?: number
  readonly accessCount?: number
  readonly linkStrength?: number
}) {
  const id = 'mem_prior'
  return {
    summary: summary({
      id,
      lifecycle: overrides.lifecycle ?? 'active',
      ...(overrides.supersededAt === undefined ? {} : { supersededAt: overrides.supersededAt }),
      ...(overrides.supersededBy === undefined ? {} : { supersededBy: overrides.supersededBy }),
    }),
    entity: entity({
      id,
      ...(overrides.pinned === undefined ? {} : { pinned: overrides.pinned }),
      ...(overrides.adoptionCount === undefined ? {} : { adoptionCount: overrides.adoptionCount }),
      ...(overrides.accessCount === undefined ? {} : { accessCount: overrides.accessCount }),
    }),
    linkStrength: overrides.linkStrength ?? 0,
    scenario: MANUAL,
    config: DEFAULT_RETRIEVAL_CONFIG,
    request: { query: '部署回滚', scenario: 'manual' as const },
    now: FIXED_NOW,
  }
}

describe('生命周期词表', () => {
  it('给定四种生命周期当校验则只接受 active/superseded/retracted/archived', () => {
    expect(ENTITY_LIFECYCLES).toEqual(['active', 'superseded', 'retracted', 'archived'])
    for (const value of ENTITY_LIFECYCLES) expect(isEntityLifecycle(value)).toBe(true)
    expect(isEntityLifecycle('deleted')).toBe(false)
    expect(isEntityLifecycle(undefined)).toBe(false)
  })

  it('给定 active 之外的三种状态当判当前有效则全部为 false', () => {
    expect(isCurrentLifecycle('active')).toBe(true)
    expect(isCurrentLifecycle('superseded')).toBe(false)
    expect(isCurrentLifecycle('retracted')).toBe(false)
    expect(isCurrentLifecycle('archived')).toBe(false)
    // 三种历史状态的标签必须区分「被取代」与「被证伪」，不能都叫旧事实。
    expect(LIFECYCLE_LABELS.superseded).not.toBe(LIFECYCLE_LABELS.retracted)
    expect(LIFECYCLE_LABELS.retracted).toContain('证伪')
  })
})

describe('重排先验与生命周期', () => {
  it('给定被取代条目当重排则降权且不叠加采用率/置顶/图扩展加分', () => {
    const active = rerankPrior(priorContext({ pinned: true, adoptionCount: 9, accessCount: 10, linkStrength: 0.9 }))
    const superseded = rerankPrior(priorContext({
      lifecycle: 'superseded',
      supersededAt: '2026-11-20T00:00:00.000Z',
      supersededBy: 'mem_new',
      pinned: true,
      adoptionCount: 9,
      accessCount: 10,
      linkStrength: 0.9,
    }))

    // 旧事实的采用率/置顶/图扩展不得继续作为“当前”信号加分。
    expect(superseded.reasons.some(reason => reason.includes('adoption'))).toBe(false)
    expect(superseded.reasons.some(reason => reason.includes('pinned'))).toBe(false)
    expect(superseded.reasons.some(reason => reason.includes('link'))).toBe(false)
    expect(superseded.reasons).toContain('prior:lifecycle:superseded=×0.6000')
    expect(superseded.factor).toBeLessThan(active.factor)
  })

  it('给定被证伪条目当重排则与被取代同样降权且标记区分', () => {
    const retracted = rerankPrior(priorContext({ lifecycle: 'retracted' }))
    expect(retracted.reasons).toContain('prior:lifecycle:retracted=×0.6000')
  })
})

describe('引擎默认排除历史条目', () => {
  it('给定通道命中被取代条目当普通召回则过滤并说明原因', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_old', 1, 0.5, 'fulltext')]
    seedMemory(store, 'mem_old', {
      lifecycle: 'superseded',
      supersededAt: '2026-11-20T00:00:00.000Z',
      supersededBy: 'mem_new',
    })

    const result = await makeEngine(store).recall({ query: '部署回滚', now: FIXED_NOW })

    expect(result.hits).toEqual([])
    expect(result.emptyReason?.message).toContain('filtered-superseded')
    expect(result.emptyReason?.message).toContain('lifecycle=superseded')
  })

  it('给定显式历史检索当召回则返回被取代条目并带有效期/取代者', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_old', 1, 0.5, 'fulltext')]
    seedMemory(store, 'mem_old', {
      lifecycle: 'superseded',
      supersededAt: '2026-11-20T00:00:00.000Z',
      supersededBy: 'mem_new',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-11-20T00:00:00.000Z',
    })

    const result = await makeEngine(store).recall({ query: '部署回滚', now: FIXED_NOW, includeSuperseded: true })

    expect(result.hits.map(item => item.entityId)).toEqual(['mem_old'])
    const first = result.hits[0]
    expect(first?.lifecycle).toBe('superseded')
    expect(first?.supersededBy).toBe('mem_new')
    expect(first?.supersededAt).toBe('2026-11-20T00:00:00.000Z')
    expect(first?.validTo).toBe('2026-11-20T00:00:00.000Z')
    expect(first?.why.some(reason => reason.includes('lifecycle:superseded'))).toBe(true)
  })

  it('给定被证伪条目当普通召回则过滤原因写到 retracted', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_refuted', 1, 0.5, 'fulltext')]
    seedMemory(store, 'mem_refuted', { lifecycle: 'retracted', retractedAt: '2026-11-21T00:00:00.000Z' })

    const result = await makeEngine(store).recall({ query: '部署回滚', now: FIXED_NOW })

    expect(result.hits).toEqual([])
    expect(result.emptyReason?.message).toContain('filtered-retracted')
  })
})

describe('检索计划携带历史开关', () => {
  it('给定 includeSuperseded 当编译计划则 filters 记录 true 且哈希随内容变化', async () => {
    const engine = makeEngine(new FakeStore())
    const plain = engine.compilePlan({ query: '部署回滚', now: FIXED_NOW })
    const historical = engine.compilePlan({ query: '部署回滚', now: FIXED_NOW, includeSuperseded: true })

    expect(plain.filters.includeSuperseded).toBe(false)
    expect(historical.filters.includeSuperseded).toBe(true)
    expect(historical.hash).not.toBe(plain.hash)
  })
})

describe('召回文本的历史标记', () => {
  function hitOf(overrides: Partial<RecallHit>): RecallHit {
    return {
      entityId: 'mem_old',
      kind: 'memory',
      title: '旧的部署回滚结论',
      snippet: '旧的部署回滚结论',
      scope: { kind: 'global' },
      updatedAt: '2026-11-20T00:00:00.000Z',
      score: 0.02,
      fusedScore: 0.02,
      why: ['channel:fulltext#1'],
      channels: ['fulltext'],
      rawScores: { fulltext: 0.5 },
      chainSiblings: [],
      historyCount: 0,
      lifecycle: 'active',
      ...overrides,
    }
  }

  const base = {
    traceId: 'trc_format',
    configVersion: 'test',
    scenario: 'manual' as const,
    query: '部署回滚',
    channelErrors: [],
    channels: [],
    expansion: { seeds: 1, expanded: 0, chains: 0 },
    warnings: [],
  }

  it('给定被取代命中当格式化则写明被谁在何时取代且不能冒充当前有效', () => {
    const text = formatRecall({
      ...base,
      hits: [hitOf({
        lifecycle: 'superseded',
        supersededAt: '2026-11-20T00:00:00.000Z',
        supersededBy: 'mem_new',
        validFrom: '2026-11-01T00:00:00.000Z',
        validTo: '2026-11-20T00:00:00.000Z',
      })],
    })

    expect(text).toContain('生命周期：已被取代')
    expect(text).toContain('已于 2026-11-20T00:00:00.000Z 被 mem_new 取代')
    expect(text).toContain('有效期 2026-11-01T00:00:00.000Z ~ 2026-11-20T00:00:00.000Z')
    expect(text).toContain('历史证据，不是当前有效')
    expect(text).toContain('含历史条目')
  })

  it('给定被证伪命中当格式化则写证伪时间而不是取代', () => {
    const text = formatRecall({
      ...base,
      hits: [hitOf({ lifecycle: 'retracted', retractedAt: '2026-11-21T00:00:00.000Z' })],
    })

    expect(text).toContain('生命周期：已被证伪')
    expect(text).toContain('已于 2026-11-21T00:00:00.000Z 证伪')
    expect(text).not.toContain('生命周期：已被取代')
  })

  it('给定当前有效命中当格式化则不出现历史标记', () => {
    const text = formatRecall({ ...base, hits: [hitOf({})] })
    expect(text).toContain('旧的部署回滚结论')
    expect(text).not.toContain('生命周期：')
    expect(text).not.toContain('含历史条目')
  })
})

describe('RecallToolInput 形状', () => {
  it('历史检索开关是可选布尔，不影响其它字段', () => {
    const input: RecallToolInput = { query: '部署回滚', includeSuperseded: true }
    expect(input.includeSuperseded).toBe(true)
  })
})
