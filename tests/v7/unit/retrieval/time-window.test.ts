import { describe, expect, it } from 'vitest'
import { FIXED_NOW, FakeStore, hit, makeEngine, summary } from './fake.js'

const IN_WINDOW = '2026-11-20T00:00:00.000Z'
const OUT_OF_WINDOW = '2026-10-01T00:00:00.000Z'
const WINDOW = { from: '2026-11-15T00:00:00.000Z', to: FIXED_NOW }

function seed(store: FakeStore, entries: readonly { readonly id: string; readonly eventTime?: string }[]): void {
  for (const entry of entries) {
    store.summariesById.set(entry.id, summary({
      id: entry.id,
      ...(entry.eventTime === undefined ? {} : { eventTime: entry.eventTime }),
    }))
  }
}

describe('RecallEngine 时间窗全局收窄', () => {
  it('给定候选事件时间在 timeWindow 外当召回则不进最终 hits，窗内候选保留', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_in', 1, 0.5, 'fulltext'), hit('mem_out', 2, 0.5, 'fulltext')]
    seed(store, [{ id: 'mem_in', eventTime: IN_WINDOW }, { id: 'mem_out', eventTime: OUT_OF_WINDOW }])

    const result = await makeEngine(store).recall({ query: 'deploy', now: FIXED_NOW, timeWindow: WINDOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_in'])
  })

  it('给定无 timeWindow 当召回则事件时间远早于场景窗口的候选照常返回', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_in', 1, 0.5, 'fulltext'), hit('mem_out', 2, 0.5, 'fulltext')]
    seed(store, [{ id: 'mem_in', eventTime: IN_WINDOW }, { id: 'mem_out', eventTime: '2025-01-01T00:00:00.000Z' }])

    const result = await makeEngine(store).recall({ query: 'deploy', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId).sort()).toEqual(['mem_in', 'mem_out'])
  })

  it('给定候选没有 eventTime 当带 timeWindow 则按未知处理不凭空排除', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_unknown', 1, 0.5, 'fulltext'), hit('mem_out', 2, 0.5, 'fulltext')]
    seed(store, [{ id: 'mem_unknown' }, { id: 'mem_out', eventTime: OUT_OF_WINDOW }])

    const result = await makeEngine(store).recall({ query: 'deploy', now: FIXED_NOW, timeWindow: WINDOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_unknown'])
  })

  it('给定 timeWindow 的 from 晚于 to 当召回则按非法窗口处理不收窄', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_in', 1, 0.5, 'fulltext'), hit('mem_out', 2, 0.5, 'fulltext')]
    seed(store, [{ id: 'mem_in', eventTime: IN_WINDOW }, { id: 'mem_out', eventTime: OUT_OF_WINDOW }])

    const result = await makeEngine(store).recall({
      query: 'deploy',
      now: FIXED_NOW,
      timeWindow: { from: '2026-11-20T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' },
    })

    expect(result.hits.map(entry => entry.entityId).sort()).toEqual(['mem_in', 'mem_out'])
  })

  it('给定全部候选都在 timeWindow 外当召回则返回 filtered-out 并说明时间过滤数', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_out', 1, 0.5, 'fulltext')]
    seed(store, [{ id: 'mem_out', eventTime: OUT_OF_WINDOW }])

    const result = await makeEngine(store).recall({ query: 'deploy', now: FIXED_NOW, timeWindow: WINDOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('filtered-out')
    expect(result.emptyReason?.details).toEqual({ filteredOut: 1, timeFiltered: 1 })
  })
})
