import { describe, expect, it } from 'vitest'
import {
  compileRetrievalPlan,
  parseRetrievalPlan,
  planFingerprint,
  type RetrievalPlan,
} from '../../../../packages/v7/src/retrieval/compiler.js'
import { DEFAULT_RETRIEVAL_CONFIG, createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import {
  isValidTimeZone,
  localDateAt,
  localDayStartDaysAgo,
  localDayStartMs,
  timeZoneOffsetMs,
} from '../../../../packages/v7/src/retrieval/timezone.js'
import type { RecallRequest } from '../../../../packages/v7/src/retrieval/types.js'
import { FIXED_NOW, FakeStore, makeEngine } from './fake.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function compile(request: RecallRequest, options: { now?: string; config?: typeof DEFAULT_RETRIEVAL_CONFIG; timezone?: string } = {}): RetrievalPlan {
  const now = options.now ?? request.now ?? FIXED_NOW
  return compileRetrievalPlan({ ...request, now }, {
    config: options.config ?? DEFAULT_RETRIEVAL_CONFIG,
    now,
    executionAnchorMs: Date.parse(now),
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  })
}

/**
 * RET-09 回归：「今天/昨天/前天」是 IANA 时区的当地日历日，不是 UTC 日历日，
 * 也不是 `now - 24h`（DST 日不是 24 小时）。集成层另有
 * tests/v7/integration/recall-time-window.test.ts 用真实 PG 验证上海/东京窗口。
 */
describe('时区工具：IANA 偏移与当地日历日（RET-09 回归）', () => {
  it('给定 Asia/Shanghai 当求当地日边界则按 +08:00 而不是 UTC 日历日', () => {
    const anchor = Date.parse('2026-11-22T00:30:00.000Z')

    expect(localDateAt('Asia/Shanghai', anchor)).toEqual({ year: 2026, month: 11, day: 22 })
    expect(new Date(localDayStartMs('Asia/Shanghai', anchor)).toISOString()).toBe('2026-11-21T16:00:00.000Z')
    expect(new Date(localDayStartDaysAgo('Asia/Shanghai', anchor, 1)).toISOString()).toBe('2026-11-20T16:00:00.000Z')
    expect(new Date(localDayStartDaysAgo('Asia/Shanghai', anchor, 2)).toISOString()).toBe('2026-11-19T16:00:00.000Z')
    expect(timeZoneOffsetMs('Asia/Shanghai', anchor) / HOUR_MS).toBe(8)
    // 当地 00:30 的锚点必须归到同一天，不能因为 UTC 还是前一天就退回昨天。
    expect(localDateAt('Asia/Shanghai', Date.parse('2026-11-21T16:30:00.000Z'))).toEqual({ year: 2026, month: 11, day: 22 })
  })

  it('给定 Asia/Tokyo 当求昨天与前天则按 +09:00 的日历日', () => {
    const anchor = Date.parse('2026-11-22T00:30:00.000Z')

    expect(new Date(localDayStartMs('Asia/Tokyo', anchor)).toISOString()).toBe('2026-11-21T15:00:00.000Z')
    expect(new Date(localDayStartDaysAgo('Asia/Tokyo', anchor, 1)).toISOString()).toBe('2026-11-20T15:00:00.000Z')
    expect(new Date(localDayStartDaysAgo('Asia/Tokyo', anchor, 2)).toISOString()).toBe('2026-11-19T15:00:00.000Z')
  })

  it('给定 America/Los_Angeles 夏令时开始时当求昨天则那一天只有 23 小时', () => {
    // 2026-03-08 02:00 当地 PST → 03:00 PDT；当地 2026-03-09 05:00 的锚点。
    const anchor = Date.parse('2026-03-09T12:00:00.000Z')
    const yesterday = localDayStartDaysAgo('America/Los_Angeles', anchor, 1)
    const today = localDayStartDaysAgo('America/Los_Angeles', anchor, 0)

    expect(new Date(today).toISOString()).toBe('2026-03-09T07:00:00.000Z')
    expect(new Date(yesterday).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(new Date(localDayStartDaysAgo('America/Los_Angeles', anchor, 2)).toISOString()).toBe('2026-03-07T08:00:00.000Z')
    // 当地 3 月 8 日只有 23 小时：今天零点 - 昨天零点。
    expect(today - yesterday).toBe(23 * HOUR_MS)
    // 用 now-24h 会得到 2026-03-08T12:00Z：那既不是当地零点，也跨进了前一天的时刻。
    expect(yesterday).not.toBe(anchor - DAY_MS)
  })

  it('给定 America/Los_Angeles 夏令时结束时当求昨天则那一天有 25 小时', () => {
    // 2026-11-01 02:00 当地 PDT → 01:00 PST；当地 2026-11-02 04:00 的锚点。
    const anchor = Date.parse('2026-11-02T12:00:00.000Z')
    const yesterday = localDayStartDaysAgo('America/Los_Angeles', anchor, 1)
    const today = localDayStartDaysAgo('America/Los_Angeles', anchor, 0)

    expect(new Date(today).toISOString()).toBe('2026-11-02T08:00:00.000Z')
    expect(new Date(yesterday).toISOString()).toBe('2026-11-01T07:00:00.000Z')
    expect(today - yesterday).toBe(25 * HOUR_MS)
  })

  it('给定当地零点不存在（America/Santiago 夏令时从 00:00 起跳）当求日边界则取缺口后的第一个当地时刻', () => {
    // 2026-09-06 00:00 当地 -04:00 直接跳到 01:00 -03:00（UTC 04:00）。
    const anchor = Date.parse('2026-09-06T12:00:00.000Z')
    const start = localDayStartMs('America/Santiago', anchor)

    expect(new Date(start).toISOString()).toBe('2026-09-06T04:00:00.000Z')
    expect(localDateAt('America/Santiago', start)).toEqual({ year: 2026, month: 9, day: 6 })
    // 起点落在当地 01:00（缺口后的第一个存在时刻），不是前一天的 23:00。
    expect((start + timeZoneOffsetMs('America/Santiago', start)) % DAY_MS).toBe(HOUR_MS)
  })

  it('给定时区名当校验则只接受可解析的 IANA 名称', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Nope/Nope')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone(' Asia/Shanghai ')).toBe(false)
  })
})

describe('计划里的日历日：时区是显式参数', () => {
  it('给定 Asia/Shanghai 当查询含昨天/今天/前天则计划按当地零点给出时间窗', () => {
    const now = '2026-11-22T00:30:00.000Z'

    const yesterday = compile({ query: '昨天的构建错误', timezone: 'Asia/Shanghai' }, { now })
    const today = compile({ query: '今天做了什么', timezone: 'Asia/Shanghai' }, { now })
    const before = compile({ query: '前天的报错', timezone: 'Asia/Shanghai' }, { now })

    expect(yesterday.time.timezone).toBe('Asia/Shanghai')
    expect(yesterday.time.lookback).toEqual({ from: '2026-11-20T16:00:00.000Z', to: now })
    expect(today.time.lookback).toEqual({ from: '2026-11-21T16:00:00.000Z', to: now })
    expect(before.time.lookback).toEqual({ from: '2026-11-19T16:00:00.000Z', to: now })
  })

  it('给定 Asia/Tokyo 当查询含昨天则按 +09:00 的日历日', () => {
    const now = '2026-11-22T00:30:00.000Z'
    const plan = compile({ query: '昨天做了什么', timezone: 'Asia/Tokyo' }, { now })

    expect(plan.time.lookback).toEqual({ from: '2026-11-20T15:00:00.000Z', to: now })
  })

  it('给定 America/Los_Angeles 当查询含昨天则跨夏令时也按当地日历日', () => {
    const springNow = '2026-03-09T12:00:00.000Z'
    const spring = compile({ query: '昨天的错误', timezone: 'America/Los_Angeles' }, { now: springNow })
    const fallNow = '2026-11-02T12:00:00.000Z'
    const fall = compile({ query: '昨天的错误', timezone: 'America/Los_Angeles' }, { now: fallNow })

    // 春季：昨天当地零点 = 2026-03-08 00:00 PST；不是 now-24h（2026-03-08T12:00Z）。
    expect(spring.time.lookback).toEqual({ from: '2026-03-08T08:00:00.000Z', to: springNow })
    // 秋季：昨天当地零点 = 2026-11-01 00:00 PDT。
    expect(fall.time.lookback).toEqual({ from: '2026-11-01T07:00:00.000Z', to: fallNow })
  })

  it('给定「最近 N 天」当查询则时长语义不随时区改变（只有日历日才用当地零点）', () => {
    const now = '2026-11-22T00:00:00.000Z'
    const utc = compile({ query: '最近3天 error', timezone: 'UTC' }, { now })
    const shanghai = compile({ query: '最近3天 error', timezone: 'Asia/Shanghai' }, { now })

    expect(utc.time.lookback).toEqual({ from: '2026-11-19T00:00:00.000Z', to: now })
    expect(shanghai.time.lookback).toEqual(utc.time.lookback)
  })

  it('给定请求没带时区当编译则依次取编译上下文、配置的显式时区，而不是宿主本地时区', () => {
    const fromContext = compile({ query: '昨天' }, { timezone: 'Asia/Tokyo' })
    const fromConfig = compile({ query: '昨天' }, { config: createRetrievalConfig({ timezone: 'Asia/Shanghai' }) })
    const fallback = compile({ query: '昨天' })

    expect(fromContext.time.timezone).toBe('Asia/Tokyo')
    expect(fromConfig.time.timezone).toBe('Asia/Shanghai')
    expect(fromConfig.time.lookback.from).toBe('2026-11-20T16:00:00.000Z')
    // 缺省是配置里的显式 UTC，不是宿主的 Asia/Shanghai。
    expect(DEFAULT_RETRIEVAL_CONFIG.timezone).toBe('UTC')
    expect(fallback.time.timezone).toBe('UTC')
    expect(fallback.time.lookback.from).toBe('2026-11-21T00:00:00.000Z')
  })

  it('给定宿主 TZ 环境变量指向别处当编译则计划仍按配置时区（不隐式依赖 Node 本地时区）', () => {
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const plan = compile({ query: '昨天' })
      expect(plan.time.timezone).toBe('UTC')
      expect(plan.time.lookback.from).toBe('2026-11-21T00:00:00.000Z')
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  it('给定非法时区当编译或解析计划则按 invalid-input 拒绝，不静默换成 UTC', () => {
    expect(() => compile({ query: '昨天', timezone: 'Not/AZone' })).toThrow(/IANA/)
    expect(() => compile({ query: '昨天' }, { config: createRetrievalConfig({ timezone: '2026' }) })).toThrow(/IANA/)

    const plan = compile({ query: '昨天', timezone: 'Asia/Shanghai' })
    const tampered = {
      ...plan,
      time: { ...plan.time, timezone: 'Not/AZone' },
    } as unknown as RetrievalPlan
    const withHash = { ...tampered, hash: planFingerprint(tampered) }
    expect(() => parseRetrievalPlan(withHash)).toThrow(/time\.timezone/)
  })

  it('给定计划 JSON 往返当解析则时区与门控快照一起保留', () => {
    const plan = compile({ query: '昨天', timezone: 'Asia/Shanghai', scenario: 'session-start' })
    const restored = parseRetrievalPlan(JSON.parse(JSON.stringify(plan)) as unknown)

    expect(restored.time).toEqual(plan.time)
    expect(restored.thresholds.fusionGate).toEqual({
      relativeFloor: 0.35,
      minChannels: 2,
      singleChannelRank: 10,
    })
    expect(restored.thresholds.fusedFloor).toBe(DEFAULT_RETRIEVAL_CONFIG.fusedFloor)
  })

  it('给定引擎配置时区当召回则时间通道直接用当地日历日零点', async () => {
    const store = new FakeStore()
    const engine = makeEngine(store, createRetrievalConfig({ timezone: 'Asia/Shanghai' }))
    const now = '2026-11-22T00:30:00.000Z'

    const plan = engine.compilePlan({ query: '昨天的构建错误', now })
    await engine.recall({ query: '昨天的构建错误', now })

    expect(plan.time.timezone).toBe('Asia/Shanghai')
    expect(store.calls.time[0]).toMatchObject({ from: '2026-11-20T16:00:00.000Z', to: now })
  })
})
