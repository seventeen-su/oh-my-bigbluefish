/**
 * 3.7 Wave 2 / R9 C3：`retrieve` 的自适应相对下限 + utility 重排。
 *
 * 判据：
 * ① relative 模式：阈值 = clamp(max(top×0.35, Q_q), [0.2,1.5])；q 升高 → 保留条数不增；
 * ② fixed 回滚模式与显式关闭（lexicalFloor:0）；
 * ③ 读数（mode / dropped / threshold）可审计；
 * ④ rerank：记录带 utility 时**不再用** raw `useCount/(1+useCount)`。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import {
  DEFAULT_LEXICAL_SCORE_FLOOR,
  rerankPrior,
  retrieve,
} from '../../../modules/memory/retrieve.js'
import { clockAt, fakeStore, makeRecord, tagged } from '../retrieval/fakes.js'

const CLOCK = clockAt(1_700_000_000_000)

function fixtureScores() {
  const records = [
    makeRecord({ id: 'r0', text: '端口 8080' }),
    makeRecord({ id: 'r1', text: '端口 8081' }),
    makeRecord({ id: 'r2', text: '端口 8082' }),
    makeRecord({ id: 'r3', text: '端口 8083' }),
  ]
  const scores: Record<string, number> = { r0: 10, r1: 6, r2: 1, r3: 0.3 }
  const store = fakeStore({
    scope: 'user',
    records,
    search: () => records.map(record => ({ id: record.id, score: scores[record.id] ?? 0, channel: 'lexical' as const })),
  })
  return { store, records }
}

describe('自适应相对下限（R9 C3）', () => {
  it('relative：top=10 → 阈值 3.5，保留 [10,6]；读数含 mode/dropped', async () => {
    const { store } = fixtureScores()
    const result = await retrieve([tagged(store)], { text: '端口', limit: 5, lexicalFloorMode: 'relative', lexicalFloorQuantile: 0.5 }, { clock: CLOCK })
    expect(result.items.map(item => item.id)).toEqual(['r0', 'r1'])
    expect(result.stats.lexicalFloorMode).toBe('relative')
    expect(result.stats.lexicalFloorDropped).toBe(2)
    expect(result.stats.lexicalFloor).toBeCloseTo(1.5, 12) // 绝对夹紧 [0.2,1.5]
  })

  it('q 越高阈值不降（单调性）：q=0.8 不会保留得比 q=0.3 多', async () => {
    const { store } = fixtureScores()
    const low = await retrieve([tagged(store)], { text: '端口', limit: 10, lexicalFloorMode: 'relative', lexicalFloorQuantile: 0.3 }, { clock: CLOCK })
    const high = await retrieve([tagged(store)], { text: '端口', limit: 10, lexicalFloorMode: 'relative', lexicalFloorQuantile: 0.8 }, { clock: CLOCK })
    expect(high.items.length).toBeLessThanOrEqual(low.items.length)
    expect(high.stats.lexicalFloor).toBeGreaterThanOrEqual(low.stats.lexicalFloor)
  })

  it('fixed 回滚：用旧绝对下限；显式 0 = 关闭', async () => {
    const { store } = fixtureScores()
    const fixed = await retrieve([tagged(store)], { text: '端口', limit: 10, lexicalFloorMode: 'fixed' }, { clock: CLOCK })
    expect(fixed.stats.lexicalFloorMode).toBe('fixed')
    expect(fixed.items.map(item => item.id)).toEqual(['r0', 'r1', 'r2']) // ≥0.5
    expect(fixed.stats.lexicalFloor).toBe(DEFAULT_LEXICAL_SCORE_FLOOR)

    const off = await retrieve([tagged(store)], { text: '端口', limit: 10, lexicalFloor: 0 }, { clock: CLOCK })
    expect(off.stats.lexicalFloorMode).toBe('off')
    expect(off.items).toHaveLength(4)
    expect(off.stats.lexicalFloorDropped).toBe(0)
  })

  it('小库保护：分数都在 bm25≈1e-6 量级时唯一命中不被误杀', async () => {
    const record = makeRecord({ id: 'tiny', text: '记忆' })
    const store = fakeStore({ scope: 'user', records: [record], search: () => [{ id: 'tiny', score: 1e-6, channel: 'lexical' }] })
    const result = await retrieve([tagged(store)], { text: '记忆', limit: 5, lexicalFloorMode: 'relative' }, { clock: CLOCK })
    expect(result.items.map(item => item.id)).toEqual(['tiny'])
    expect(result.stats.lexicalFloorMode).toBe('fixed') // 小库走旧规则
  })
})

describe('rerank：utility 取代 raw useCount（R9 C1）', () => {
  const base: MemoryRecord = makeRecord({
    id: 'u1',
    text: '端口 8080',
    useCount: 10,
    lastUsedAt: 1_700_000_000_000,
    observedAt: 1_700_000_000_000,
  })
  const options = { now: 1_700_000_000_000, position: 0 }

  it('带 utility 时使用 utility（曝光多但没人用 → 先验更低）', () => {
    const legacy = rerankPrior({ candidate: { id: 'u1', score: 0, scopes: ['user'], channels: ['lexical'], matches: [] }, record: base }, options)
    const withUtility = { ...base, utility: 0.1 } as MemoryRecord
    const modern = rerankPrior(
      { candidate: { id: 'u1', score: 0, scopes: ['user'], channels: ['lexical'], matches: [] }, record: withUtility },
      options,
    )
    expect(modern).toBeLessThan(legacy)
  })

  it('没有 utility 时退回旧公式（假库/旧库降级可见）', () => {
    const record: MemoryRecord = { ...base, useCount: 1 }
    const legacy = rerankPrior({ candidate: { id: 'u1', score: 0, scopes: ['user'], channels: ['lexical'], matches: [] }, record }, options)
    expect(Number.isFinite(legacy)).toBe(true)
    // usage 分量 = 1/2（旧公式），其它分量为确定值；只断言与"没有 utility"一致即可
    expect(legacy).toBeCloseTo(
      0.55 * 1 + 0.25 * 1 + 0.12 * (1 / 2) + 0.08 * 0.3,
      12,
    )
  })
})
