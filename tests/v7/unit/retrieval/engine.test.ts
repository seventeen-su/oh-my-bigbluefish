import { describe, expect, it } from 'vitest'
import { createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import type { EntitySummary } from '../../../../packages/v7/src/ports/store.js'
import { FakeEmbedder, FakeStore, FIXED_NOW, entity, hit, makeEngine, summary } from './fake.js'

function seedMemory(store: FakeStore, ids: readonly string[], overrides: Partial<EntitySummary> = {}): void {
  for (const id of ids) store.summariesById.set(id, summary({ id, ...overrides }))
}

describe('RecallEngine 阶段一与融合', () => {
  it('给定多通道命中当 RRF 融合则按名次贡献求和并去重', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext'), hit('mem_b', 2, 0.4, 'fulltext')]
    store.channelHits.vector = [hit('mem_a', 1, 0.8, 'vector')]
    seedMemory(store, ['mem_a', 'mem_b'])

    const result = await makeEngine(store).recall({ query: 'needle bug', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_a', 'mem_b'])
    expect(result.hits[0]?.fusedScore).toBeCloseTo(2 / 61, 9)
    expect(result.hits[1]?.fusedScore).toBeCloseTo(1 / 62, 9)
    expect(result.hits[0]?.channels).toEqual(['fulltext', 'vector'])
    expect(result.hits[0]?.rawScores).toEqual({ fulltext: 0.5, vector: 0.8 })
    expect(result.hits[0]?.why.some(line => line.startsWith('channel:fulltext#1'))).toBe(true)
    expect(result.emptyReason).toBeUndefined()
  })

  it('给定通道原始分低于下限当门控则整条候选不返回', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.1, 'fulltext')]
    seedMemory(store, ['mem_a'])
    const config = createRetrievalConfig({ channelFloors: { fulltext: 0.2 } })

    const result = await makeEngine(store, config).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('below-threshold')
    expect(result.emptyReason?.details).toEqual({ belowRaw: 1, belowFused: 0 })
  })

  it('给定融合分低于 fusedFloor 当原始分够高则仍不返回', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])
    const config = createRetrievalConfig({ fusedFloor: 0.02 })

    const result = await makeEngine(store, config).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.details).toEqual({ belowRaw: 0, belowFused: 1 })
  })

  it('给定 manual 当比较 tool-before 则触发命中与全文命中的先后顺序不同', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    store.channelHits.trigger = [hit('mem_b', 1, 1, 'trigger')]
    seedMemory(store, ['mem_a', 'mem_b'])
    const engine = makeEngine(store)

    const manual = await engine.recall({ query: 'TS2304 handleFix', scenario: 'manual', now: FIXED_NOW })
    const toolBefore = await engine.recall({ query: 'TS2304 handleFix', scenario: 'tool-before', now: FIXED_NOW })

    expect(manual.hits.map(entry => entry.entityId)).toEqual(['mem_a', 'mem_b'])
    expect(toolBefore.hits.map(entry => entry.entityId)).toEqual(['mem_b', 'mem_a'])
    expect(toolBefore.hits[0]?.score).toBeGreaterThan(toolBefore.hits[1]?.score ?? 0)
  })

  it('给定单通道抛错当其它通道有命中则失败隔离并记录 channelErrors', async () => {
    const store = new FakeStore()
    store.failures.fulltext = new Error('fulltext boom')
    store.channelHits.vector = [hit('mem_b', 1, 0.8, 'vector')]
    seedMemory(store, ['mem_b'])

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_b'])
    expect(result.channelErrors).toEqual([
      { channel: 'fulltext', code: 'internal', message: 'fulltext boom', retryable: false },
    ])
    expect(result.channels.find(report => report.channel === 'fulltext')?.status).toBe('failed')
    expect(result.channels.find(report => report.channel === 'vector')?.status).toBe('ok')
  })

  it('给定所有被尝试的通道都失败当召回则返回 all-channels-failed 而不抛错', async () => {
    const store = new FakeStore()
    for (const channel of ['trigger', 'fulltext', 'vector', 'time', 'state_board'] as const) {
      store.failures[channel] = new Error(`${channel} boom`)
    }

    const result = await makeEngine(store).recall({ query: 'err', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.channelErrors).toHaveLength(5)
    expect(result.emptyReason?.code).toBe('all-channels-failed')
  })

  it('给定向量嵌入不可用当召回则通道标 unavailable 且不算 0 分错误', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])
    const embedder = new FakeEmbedder()
    embedder.availableResult = false

    const result = await makeEngine(store, undefined, embedder).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_a'])
    expect(result.channels.find(report => report.channel === 'vector')?.status).toBe('unavailable')
    expect(result.channelErrors).toHaveLength(0)
    expect(store.calls.vector).toHaveLength(0)
  })

  it('给定全文已有命中当查询很短则不跑单字回退', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])

    await makeEngine(store).recall({ query: '猫', now: FIXED_NOW })

    expect(store.calls.single_char).toHaveLength(0)
  })

  it('给定全文零命中且查询很短当召回则跑单字回退', async () => {
    const store = new FakeStore()
    store.channelHits.single_char = [hit('mem_c', 1, 0.5, 'single_char')]
    seedMemory(store, ['mem_c'])

    const result = await makeEngine(store).recall({ query: '猫', now: FIXED_NOW })

    expect(store.calls.single_char).toHaveLength(1)
    expect(store.calls.single_char[0]?.query).toBe('猫')
    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_c'])
  })

  it('给定全文零命中但查询很长当召回则不跑单字回退', async () => {
    const store = new FakeStore()

    const result = await makeEngine(store).recall({ query: 'find the bug', now: FIXED_NOW })

    expect(store.calls.single_char).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('no-stage-one-hits')
  })

  it('给定所有通道零命中当召回则返回 no-stage-one-hits 原因', async () => {
    const store = new FakeStore()

    const result = await makeEngine(store).recall({ query: 'no such memory', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('no-stage-one-hits')
    expect(result.emptyReason?.message.length).toBeGreaterThan(0)
  })

  it('给定空查询当时间与看板也零命中则返回 empty-query 原因', async () => {
    const store = new FakeStore()

    const result = await makeEngine(store).recall({ query: '', now: FIXED_NOW })

    expect(result.emptyReason?.code).toBe('empty-query')
    expect(store.calls.fulltext).toHaveLength(0)
    expect(store.calls.trigger).toHaveLength(0)
    expect(store.calls.single_char).toHaveLength(0)
  })

  it('给定归档命中当未显式 includeArchived 则过滤并给 filtered-out 原因', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'], { archived: true })

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('filtered-out')
    expect(result.emptyReason?.details).toEqual({ filteredOut: 1 })
  })

  it('给定归档命中当 includeArchived=true 则返回', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'], { archived: true })

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, includeArchived: true })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_a'])
  })

  it('给定摘要读取失败当召回则返回 summaries-failed 原因', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    store.summariesError = new Error('summary boom')

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('summaries-failed')
    expect(result.warnings.some(warning => warning.includes('summary boom'))).toBe(true)
  })

  it('给定 last-time 当召回则时间窗放宽到 60 天且保留场景名', async () => {
    const store = new FakeStore()
    const engine = makeEngine(store)

    const manual = await engine.recall({ query: 'needle', now: FIXED_NOW })
    const lastTime = await engine.recall({ query: 'needle', scenario: 'last-time', now: FIXED_NOW })

    expect(manual.scenario).toBe('manual')
    expect(lastTime.scenario).toBe('last-time')
    expect(store.calls.time[0]?.from).toBe('2026-11-15T00:00:00.000Z')
    expect(store.calls.time[1]?.from).toBe('2026-09-23T00:00:00.000Z')
  })

  it('给定查询含“昨天”当召回则时间通道从昨天零点开始', async () => {
    const store = new FakeStore()

    await makeEngine(store).recall({ query: '昨天的构建错误 bug', now: FIXED_NOW })

    expect(store.calls.time[0]?.from).toBe('2026-11-21T00:00:00.000Z')
    expect(store.calls.time[0]?.to).toBe(FIXED_NOW)
  })

  it('给定查询含“最近3天”当召回则时间窗收窄到三天', async () => {
    const store = new FakeStore()

    await makeEngine(store).recall({ query: '最近3天 error', now: FIXED_NOW })

    expect(store.calls.time[0]?.from).toBe('2026-11-19T00:00:00.000Z')
  })

  it('给定先验叠加超过上限当重排则乘数夹到 1.5 并在 why 里标注', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    store.summariesById.set('mem_a', summary({
      id: 'mem_a',
      category: 'fact',
      historyCount: 3,
      scope: { kind: 'project', projectKey: 'D:/repo' },
    }))
    store.entitiesById.set('mem_a', entity({
      id: 'mem_a',
      pinned: true,
      tags: ['偏好'],
      confidence: 1,
      adoptionCount: 10,
      accessCount: 10,
      origin: 'user',
    }))

    const result = await makeEngine(store).recall({
      query: 'needle',
      scenario: 'session-start',
      projectKey: 'D:/repo',
      now: FIXED_NOW,
    })

    const hit0 = result.hits[0]
    expect(hit0?.score).toBeCloseTo((hit0?.fusedScore ?? 0) * 1.5, 9)
    expect(hit0?.why.some(line => line.includes('prior:clamp[0.5,1.5]'))).toBe(true)
  })

  it('给定项目键当状态机看板通道执行则按项目收窄', async () => {
    const store = new FakeStore()

    await makeEngine(store).recall({ query: 'needle', projectKey: 'D:/repo', now: FIXED_NOW })

    expect(store.calls.state_board[0]?.scope).toBe('project')
    expect(store.calls.state_board[0]?.projectKey).toBe('D:/repo')
  })

  it('给定召回有命中当写 recall_event 则 traceId 一致且记录通道与原始分', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, sessionId: 's1', turnId: 't1' })

    expect(result.traceId).toMatch(/^trc_/)
    expect(result.timings?.stageOneMs).toBeGreaterThanOrEqual(0)
    expect(result.timings?.totalMs).toBeGreaterThanOrEqual(result.timings?.stageOneMs ?? 0)
    expect(store.recallEvents.length).toBeGreaterThan(0)
    for (const event of store.recallEvents) {
      expect(event.traceId).toBe(result.traceId)
      expect(event.entityId).toBe('mem_a')
      expect(event.channel).toBe('fulltext')
      expect(event.rank).toBe(1)
      expect(event.rawScore).toBe(0.5)
      expect(event.injected).toBe(false)
      expect(event.sessionId).toBe('s1')
      expect(event.turnId).toBe('t1')
    }

    const explicit = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, traceId: 'trc_fixed' })
    expect(explicit.traceId).toBe('trc_fixed')
  })

  it('给定 recall_event 写入失败当召回则结果仍返回并留 warning', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])
    store.recallError = new Error('recall boom')

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits).toHaveLength(1)
    expect(result.warnings.some(warning => warning.includes('recall boom'))).toBe(true)
  })
})
