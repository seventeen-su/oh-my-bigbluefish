import { describe, expect, it } from 'vitest'
import { createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import type { EntitySummary } from '../../../../packages/v7/src/ports/search.js'
import { FakeStore, FIXED_NOW, entity, expansion, hit, makeEngine, summary } from './fake.js'

function seedMemory(store: FakeStore, ids: readonly string[], overrides: Partial<EntitySummary> = {}): void {
  for (const id of ids) store.summariesById.set(id, summary({ id, ...overrides }))
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
