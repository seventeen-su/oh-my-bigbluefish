import { describe, expect, it } from 'vitest'
import type { ChannelHit } from '../../../../packages/v7/src/ports/search.js'
import { createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import { collectSeeds } from '../../../../packages/v7/src/retrieval/expand.js'
import { explainHit } from '../../../../packages/v7/src/retrieval/explain.js'
import { applyExpansions, fuseStageOne } from '../../../../packages/v7/src/retrieval/fuse.js'
import type { StageOneChannel } from '../../../../packages/v7/src/retrieval/types.js'
import type { EntitySummary } from '../../../../packages/v7/src/ports/search.js'
import { FakeStore, FIXED_NOW, entity, expansion, hit, makeEngine, summary } from './fake.js'

function seedMemory(store: FakeStore, ids: readonly string[], overrides: Partial<EntitySummary> = {}): void {
  for (const id of ids) store.summariesById.set(id, summary({ id, ...overrides }))
}

function hitsOf(
  ...entries: readonly (readonly [StageOneChannel, readonly ChannelHit[]])[]
): ReadonlyMap<StageOneChannel, readonly ChannelHit[]> {
  return new Map(entries)
}

describe('阶段二图扩展', () => {
  it('给定阶段一多通道命中当取种子则每通道最多前 8 名去重', async () => {
    const store = new FakeStore()
    const ids = Array.from({ length: 10 }, (_, index) => `mem_${index + 1}`)
    store.channelHits.fulltext = ids.map((id, index) => hit(id, index + 1, 0.5, 'fulltext'))
    seedMemory(store, ids)

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, hops: 1 })

    expect(store.expandCalls).toHaveLength(1)
    expect(store.expandCalls[0]?.seeds).toEqual(ids.slice(0, 8))
    expect(store.expandCalls[0]?.hops).toBe(1)
    expect(result.expansion).toEqual({ seeds: 8, expanded: 0, chains: 0 })
  })

  it('给定 1 跳与 2 跳扩展当融合则按跳数衰减 0.5/0.25 且同实体只留一条', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.8, 'fulltext'), hit('mem_c', 2, 0.4, 'fulltext')]
    seedMemory(store, ['mem_a', 'mem_b', 'mem_c', 'mem_d'])
    store.expansions = [
      expansion({ entityId: 'mem_b', fromId: 'mem_a', hop: 1, score: 0.5, viaLinkId: 'lnk_1' }),
      expansion({ entityId: 'mem_b', fromId: 'mem_c', hop: 2, score: 0.25, viaLinkId: 'lnk_2' }),
      expansion({ entityId: 'mem_a', fromId: 'mem_a', hop: 1, score: 0.5, viaLinkId: 'lnk_3' }),
      expansion({ entityId: 'mem_d', fromId: 'mem_a', hop: 2, score: 0.25, viaLinkId: 'lnk_4' }),
    ]
    const config = createRetrievalConfig({ scenarios: { manual: { weights: { links: 1 } } } })

    const result = await makeEngine(store, config).recall({ query: 'needle', now: FIXED_NOW })

    expect(store.expandCalls[0]?.seeds).toEqual(['mem_a', 'mem_c'])
    expect(result.expansion).toEqual({ seeds: 2, expanded: 4, chains: 0 })
    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_a', 'mem_c', 'mem_b', 'mem_d'])

    const b = result.hits.find(entry => entry.entityId === 'mem_b')
    expect(result.hits.filter(entry => entry.entityId === 'mem_b')).toHaveLength(1)
    expect(b?.channels).toEqual(['links'])
    expect(b?.rawScores.links).toBeCloseTo(0.4, 9)
    expect(b?.why.some(line => line.includes('link:hop1 seed=mem_a'))).toBe(true)

    const a = result.hits.find(entry => entry.entityId === 'mem_a')
    expect(a?.channels).toEqual(['fulltext', 'links'])

    const d = result.hits.find(entry => entry.entityId === 'mem_d')
    expect(d?.rawScores.links).toBeCloseTo(0.2, 9)
    expect(b?.score).toBeGreaterThan(d?.score ?? 0)
  })

  it('给定命中思维链成员当召回则带出组标题与同组成员标题', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_x', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_x'], { title: '成员X', historyCount: 3 })
    seedMemory(store, ['mem_m'], { title: '成员M' })
    store.summariesById.set('mem_z', summary({ id: 'mem_z', title: '成员Z' }))
    store.entitiesById.set('ch_c', entity({ id: 'ch_c', kind: 'chain', title: '组标题', group: ['mem_x', 'mem_m', 'mem_z'] }))
    store.expansions = [
      expansion({ entityId: 'mem_m', fromId: 'ch_c', chainId: 'ch_c', hop: 1, score: 0.5, relation: 'chain' }),
    ]

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    const x = result.hits.find(entry => entry.entityId === 'mem_x')
    expect(x?.chainSiblings).toEqual(['组标题', '成员M', '成员Z'])
    expect(x?.historyCount).toBe(3)
    const m = result.hits.find(entry => entry.entityId === 'mem_m')
    expect(m?.chainSiblings).toEqual(['组标题', '成员X', '成员Z'])
    expect(store.summaryCalls.some(call => call.includes('mem_z'))).toBe(true)
  })

  it('给定 expand=none 当召回则不执行阶段二图扩展', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a', 'mem_b'])
    store.expansions = [expansion({ entityId: 'mem_b', fromId: 'mem_a', hop: 1 })]

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, expand: 'none' })

    expect(store.expandCalls).toHaveLength(0)
    expect(result.expansion).toEqual({ seeds: 1, expanded: 0, chains: 0 })
    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_a'])
    expect(result.hits[0]?.expanded).toBeUndefined()
  })

  it('给定 expand=links 当召回则只保留链接扩展且不读思维链组', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_x', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_x', 'mem_b', 'mem_m'])
    store.entitiesById.set('ch_c', entity({ id: 'ch_c', kind: 'chain', title: '组标题', group: ['mem_x', 'mem_m'] }))
    store.expansions = [
      expansion({ entityId: 'mem_b', fromId: 'mem_x', hop: 1, viaLinkId: 'lnk_b' }),
      expansion({ entityId: 'mem_m', fromId: 'ch_c', chainId: 'ch_c', hop: 1, viaLinkId: 'lnk_m', relation: 'chain' }),
    ]

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, expand: 'links' })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_x', 'mem_b'])
    expect(result.expansion).toEqual({ seeds: 1, expanded: 1, chains: 0 })
    expect(store.getCalls).not.toContain('ch_c')
    const b = result.hits.find(entry => entry.entityId === 'mem_b')
    expect(b?.expanded).toBe(true)
  })

  it('给定 expand=chain 当召回则只保留思维链成员扩展并带同组标题', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_x', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_x', 'mem_b', 'mem_m'])
    seedMemory(store, ['mem_x'], { title: '成员X' })
    seedMemory(store, ['mem_m'], { title: '成员M' })
    store.entitiesById.set('ch_c', entity({ id: 'ch_c', kind: 'chain', title: '组标题', group: ['mem_x', 'mem_m'] }))
    store.expansions = [
      expansion({ entityId: 'mem_b', fromId: 'mem_x', hop: 1, viaLinkId: 'lnk_b' }),
      expansion({ entityId: 'mem_m', fromId: 'ch_c', chainId: 'ch_c', hop: 1, viaLinkId: 'lnk_m', relation: 'chain' }),
    ]

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, expand: 'chain' })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_x', 'mem_m'])
    expect(result.expansion).toEqual({ seeds: 1, expanded: 1, chains: 1 })
    expect(store.getCalls).toContain('ch_c')
    const x = result.hits.find(entry => entry.entityId === 'mem_x')
    expect(x?.chainSiblings).toEqual(['组标题', '成员M'])
    expect(x?.expanded).toBeUndefined()
    const m = result.hits.find(entry => entry.entityId === 'mem_m')
    expect(m?.expanded).toBe(true)
  })

  it('给定缺省 expand 当召回则默认 both 同时保留链接与思维链扩展', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_x', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_x', 'mem_b', 'mem_m'])
    store.entitiesById.set('ch_c', entity({ id: 'ch_c', kind: 'chain', title: '组标题', group: ['mem_x', 'mem_m'] }))
    store.expansions = [
      expansion({ entityId: 'mem_b', fromId: 'mem_x', hop: 1, viaLinkId: 'lnk_b' }),
      expansion({ entityId: 'mem_m', fromId: 'ch_c', chainId: 'ch_c', hop: 1, viaLinkId: 'lnk_m', relation: 'chain' }),
    ]

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_x', 'mem_b', 'mem_m'])
    expect(result.expansion).toEqual({ seeds: 1, expanded: 2, chains: 1 })
  })

  it('给定图扩展抛错当召回则保留阶段一结果并留 warning', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])
    store.expandError = new Error('graph boom')

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_a'])
    expect(result.expansion).toEqual({ seeds: 1, expanded: 0, chains: 0 })
    expect(result.warnings.some(warning => warning.includes('graph boom'))).toBe(true)
  })
})

describe('图扩展归因（RET-05）', () => {
  it('给定 2 跳扩展当融合则继承 1 跳祖先种子，而不是全局最强种子', () => {
    const config = createRetrievalConfig({ scenarios: { manual: { weights: { links: 1 } } } })
    const weights = config.scenarios.manual.weights
    const stageOne = hitsOf(['fulltext', [
      hit('mem_top', 1, 0.8, 'fulltext'),
      hit('mem_deep', 8, 0.2, 'fulltext'),
    ]])
    const seedSet = collectSeeds(stageOne, config)
    const candidates = fuseStageOne(stageOne, weights, config.rrfK)

    const result = applyExpansions(
      candidates,
      [
        expansion({ entityId: 'mem_mid', fromId: 'mem_deep', hop: 1, score: 0.5, viaLinkId: 'lnk_1' }),
        expansion({ entityId: 'mem_far', fromId: 'mem_mid', hop: 2, score: 0.25, viaLinkId: 'lnk_2' }),
      ],
      seedSet,
      new Map(),
      weights,
      config,
    )

    const far = candidates.get('mem_far')
    expect(result).toEqual({ applied: 2, unresolved: 0 })
    // 旧实现的 fallback 是 bestSeedOverall=mem_top(rank 1)：贡献与原始分都会被放大。
    expect(far?.link?.seedId).toBe('mem_deep')
    expect(far?.link?.hop).toBe(2)
    expect(far?.rawByChannel.get('links')).toBeCloseTo(0.2 * 0.25, 12)
    expect(far?.contributionByChannel.get('links')).toBeCloseTo(0.25 / (config.rrfK + 8), 12)
    if (far === undefined) throw new Error('候选缺失：测试夹具不成立')
    const why = explainHit({ candidate: far, prior: { factor: 1, reasons: [] }, score: far.fused })
    expect(why).toContain('link:hop2 seed=mem_deep decay=0.2500 via=lnk_2')
    expect(why.some(line => line.includes('seed=mem_top'))).toBe(false)
  })

  it('给定 2 跳祖先不在扩展结果里当融合则跳过并计数，不伪造种子', () => {
    const config = createRetrievalConfig({ scenarios: { manual: { weights: { links: 1 } } } })
    const weights = config.scenarios.manual.weights
    const stageOne = hitsOf(['fulltext', [hit('mem_top', 1, 0.8, 'fulltext')]])
    const candidates = fuseStageOne(stageOne, weights, config.rrfK)

    const result = applyExpansions(
      candidates,
      [expansion({ entityId: 'mem_far', fromId: 'mem_orphan', hop: 2, score: 0.25, viaLinkId: 'lnk_orphan' })],
      collectSeeds(stageOne, config),
      new Map(),
      weights,
      config,
    )

    expect(result).toEqual({ applied: 0, unresolved: 1 })
    expect(candidates.has('mem_far')).toBe(false)
    expect(candidates.get('mem_top')?.link).toBeUndefined()
  })

  it('给定思维链组超出 maxChainGroups 当召回则跳过来自未解析组的成员，不借用全局最强种子', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_seed', 1, 0.8, 'fulltext')]
    seedMemory(store, ['mem_seed', 'mem_a1'])
    store.entitiesById.set('ch_a', entity({ id: 'ch_a', kind: 'chain', title: '组A', group: ['mem_seed', 'mem_a1'] }))
    store.expansions = [
      expansion({ entityId: 'mem_a1', fromId: 'ch_a', chainId: 'ch_a', hop: 1, score: 0.5, relation: 'chain' }),
      expansion({ entityId: 'mem_b1', fromId: 'ch_b', chainId: 'ch_b', hop: 1, score: 0.5, relation: 'chain' }),
    ]

    const result = await makeEngine(store, createRetrievalConfig({ maxChainGroups: 1 }))
      .recall({ query: 'needle', now: FIXED_NOW })

    const ids = result.hits.map(entry => entry.entityId)
    expect(ids).toContain('mem_seed')
    expect(ids).toContain('mem_a1')
    // 未解析组（ch_b）的成员不再带着全局最强种子 mem_seed 出现在结果里。
    expect(ids).not.toContain('mem_b1')
    expect(result.warnings.some(warning => warning.includes('无法归因到阶段一种子') && warning.includes('已跳过'))).toBe(true)
    expect(result.warnings.some(warning => warning.includes('只解析前 1 个'))).toBe(true)
  })
})
