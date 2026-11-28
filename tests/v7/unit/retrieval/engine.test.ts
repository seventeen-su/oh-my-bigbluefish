import { describe, expect, it } from 'vitest'
import { createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import type { EntitySummary } from '../../../../packages/v7/src/ports/search.js'
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
    expect(result.hits[0]?.why).toContain('channel:fulltext#1 raw=0.5000 contribution=0.0164')
    expect(result.hits[0]?.why).toContain('channel:vector#1 raw=0.8000 contribution=0.0164')
    expect(result.hits[0]?.why).toContain('rrf=0.0328')
    expect(result.emptyReason).toBeUndefined()
  })

  it('给定场景权重不同当同一触发命中召回则 fusedScore 按 weight/(k+rank) 加权', async () => {
    const store = new FakeStore()
    store.channelHits.trigger = [hit('mem_b', 1, 1, 'trigger')]
    seedMemory(store, ['mem_b'])
    const engine = makeEngine(store)

    const manual = await engine.recall({ query: 'TS2304 handleFix', scenario: 'manual', now: FIXED_NOW })
    const toolBefore = await engine.recall({ query: 'TS2304 handleFix', scenario: 'tool-before', now: FIXED_NOW })

    expect(manual.hits[0]?.fusedScore).toBeCloseTo(0.4 / 61, 9)
    expect(toolBefore.hits[0]?.fusedScore).toBeCloseTo(1.4 / 61, 9)
  })

  it('给定部分候选低于原始分下限当仍有命中则用 warning 暴露 below 统计而不静默', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext'), hit('mem_b', 2, 0.1, 'fulltext')]
    seedMemory(store, ['mem_a', 'mem_b'])
    const config = createRetrievalConfig({ channelFloors: { fulltext: 0.2 } })

    const result = await makeEngine(store, config).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_a'])
    expect(result.warnings.some(warning => warning.includes('belowRaw=1') && warning.includes('belowFused=0'))).toBe(true)
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
    expect(result.emptyReason?.message).toContain(
      'whyNot：below-raw entity=mem_a channel=fulltext raw=0.1000 floor=0.2000',
    )
  })

  it('给定融合分低于 fusedFloor 当原始分够高则仍不返回', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    seedMemory(store, ['mem_a'])
    const config = createRetrievalConfig({ fusedFloor: 0.02 })

    const result = await makeEngine(store, config).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.details).toEqual({ belowRaw: 0, belowFused: 1 })
    expect(result.emptyReason?.message).toContain(
      'whyNot：below-fused entity=mem_a fused=0.0164 floor=0.0200',
    )
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

  it('给定查询没有路径/标识符/错误码当 regex 文本存在则 trigger 通道仍执行并带 regexText', async () => {
    const store = new FakeStore()
    store.channelHits.trigger = [hit('mem_b', 1, 1.2, 'trigger')]
    seedMemory(store, ['mem_b'])

    const result = await makeEngine(store).recall({ query: '服务报错了，请看看', now: FIXED_NOW })

    // 动态 regex 触发键在应用层执行；没有显式 key 时不能直接 skip，否则正则触发永远无候选。
    expect(store.calls.trigger).toHaveLength(1)
    expect(store.calls.trigger[0]?.keys).toEqual([])
    expect(store.calls.trigger[0]?.regexText).toBe('服务报错了，请看看')
    expect(result.channels.find(report => report.channel === 'trigger')?.status).toBe('ok')
    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_b'])
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
    expect(result.emptyReason?.message).toContain('whyNot：empty-query')
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
    expect(result.emptyReason?.message).toContain('whyNot：filtered-archived entity=mem_a')
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
    expect(result.emptyReason?.message).toContain('whyNot：summaries-failed')
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
      utilityConfidence: 0.9,
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

describe('通道 deadline 与取消（RET-10）', () => {
  it('给定通道超过 provider deadline 当召回则只标记该通道 deadline，并把服务端超时预算传给 store', async () => {
    const store = new FakeStore()
    store.latencyMs.fulltext = 200

    const result = await makeEngine(store, undefined, new FakeEmbedder(), { providerTimeoutMs: 20 })
      .recall({ query: 'needle', now: FIXED_NOW })

    const fulltext = result.channels.find(report => report.channel === 'fulltext')
    expect(fulltext?.status).toBe('failed')
    expect(fulltext?.reason ?? '').toMatch(/^deadline:/)
    // provider issue 为空（runner 级 deadline），但审计表仍必须有一行。
    expect(result.channelErrors).toEqual([])
    expect(store.recallChannelErrors).toHaveLength(1)
    expect(store.recallChannelErrors[0]).toMatchObject({
      traceId: result.traceId,
      query: 'needle',
      channel: 'fulltext',
      code: 'timeout',
      retryable: true,
    })
    expect(store.recallChannelErrors[0]?.message).toContain('deadline')
    expect(result.warnings.some(warning => warning.includes('在 deadline 内未完成'))).toBe(true)
    // 取消能力不只停留在 runner：store 拿到的是本 provider 的剩余预算，适配器用它设置 statement_timeout。
    expect(store.calls.fulltext[0]?.timeoutMs).toBeLessThanOrEqual(20)
    expect(store.calls.state_board[0]?.timeoutMs).toBeLessThanOrEqual(20)
    // 其它通道不被连坐：看板/时间等仍然执行。
    expect(store.calls.state_board).toHaveLength(1)
    expect(result.emptyReason?.code).toBe('no-stage-one-hits')
  })

  it('给定通道错误文本为空当召回则 channelErrors 与审计行都有最小可读原因', async () => {
    const store = new FakeStore()
    for (const channel of ['trigger', 'fulltext', 'vector', 'time', 'state_board'] as const) {
      store.failures[channel] = new Error('')
    }

    const result = await makeEngine(store).recall({ query: 'err', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('all-channels-failed')
    expect(result.channelErrors).toHaveLength(5)
    expect(result.channelErrors.every(error => error.message.trim().length > 0)).toBe(true)
    expect(result.channelErrors.every(error => error.message.includes('失败但没有给出错误详情'))).toBe(true)
    expect(store.recallChannelErrors).toHaveLength(5)
    expect(store.recallChannelErrors.every(error => error.message.trim().length > 0)).toBe(true)
  })

  it('给定所有被尝试通道都失败或不可用当召回则标全部失败，而不是“没有相关内容”', async () => {
    const store = new FakeStore()
    for (const channel of ['trigger', 'fulltext', 'time', 'state_board'] as const) {
      store.failures[channel] = new Error(`${channel} down`)
    }
    const embedder = new FakeEmbedder()
    embedder.availableResult = false

    const result = await makeEngine(store, undefined, embedder)
      .recall({ query: 'find the bug in production', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('all-channels-failed')
    expect(result.emptyReason?.details).toEqual({
      channels: ['trigger:failed', 'fulltext:failed', 'vector:unavailable', 'time:failed', 'state_board:failed'],
    })
  })
})

describe('RET-11 最小通道召回（T0 状态看板）', () => {
  it('给定 channels 只含 state_board 当召回则只打看板通道、不跑图扩展，事件也只记 state_board', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_a', 1, 0.5, 'fulltext')]
    store.channelHits.state_board = [hit('st_1', 1, 0.9, 'state_board')]
    store.summariesById.set('st_1', summary({ id: 'st_1', kind: 'state', status: 'in_progress' }))

    const result = await makeEngine(store).recall({
      query: '当前项目 进行中 阻塞中',
      scenario: 'session-start',
      kind: 'state',
      status: ['in_progress', 'blocked'],
      channels: ['state_board'],
      now: FIXED_NOW,
    })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['st_1'])
    expect(store.calls.state_board).toHaveLength(1)
    expect(store.calls.fulltext).toHaveLength(0)
    expect(store.calls.trigger).toHaveLength(0)
    expect(store.calls.vector).toHaveLength(0)
    expect(store.calls.time).toHaveLength(0)
    expect(store.expandCalls).toHaveLength(0)
    expect(store.recallEvents.map(event => event.channel)).toEqual(['state_board'])
    expect(result.channels.filter(report => report.status !== 'skipped').map(report => report.channel)).toEqual(['state_board'])
  })
})
