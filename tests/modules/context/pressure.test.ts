/**
 * 软压力塑形（规划 §6.3）。
 *
 * 核心断言：三档行为差异、`null` → relaxed（不臆断）、
 * 阈值非法不抛、**任何档位都不丢弃**（`recoverable` 恒为 true）。
 */
import { describe, expect, it } from 'vitest'
import type { ContextPressure } from '../../../kernel/abi/index.js'
import {
  DEFAULT_PRESSURE_BANDS,
  bandOf,
  bandsFromPair,
  behaviorFor,
  normalizeBands,
  readingOf,
} from '../../../modules/context/pressure.js'

const pressure = (fillRatio: number | null): ContextPressure => ({
  totalTokens: 1000,
  fillRatio,
  band: 'relaxed',
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  nodes: [],
})

describe('bandOf：三档判定', () => {
  it('宽松：fillRatio < 0.3', () => {
    for (const ratio of [0, 0.1, 0.299]) expect(bandOf(ratio, DEFAULT_PRESSURE_BANDS)).toBe('relaxed')
  })

  it('适中：0.3 ≤ fillRatio < 0.6（边界含下不含上）', () => {
    for (const ratio of [0.3, 0.45, 0.599]) expect(bandOf(ratio, DEFAULT_PRESSURE_BANDS)).toBe('moderate')
  })

  it('紧张：fillRatio ≥ 0.6（含超过 1 的畸形读数）', () => {
    for (const ratio of [0.6, 0.9, 1, 5]) expect(bandOf(ratio, DEFAULT_PRESSURE_BANDS)).toBe('tight')
  })

  it('fillRatio === null → relaxed：宿主未声明窗口就不施压，不臆断', () => {
    expect(bandOf(null)).toBe('relaxed')
    expect(bandOf(null, { moderate: 0, tight: 0 })).toBe('relaxed')
  })

  it('NaN / Infinity 按"未声明"处理，不产生紧张档', () => {
    expect(bandOf(Number.NaN)).toBe('relaxed')
    expect(bandOf(Number.POSITIVE_INFINITY)).toBe('relaxed')
    expect(bandOf(Number.NEGATIVE_INFINITY)).toBe('relaxed')
  })

  it('阈值可从配置标定', () => {
    const bands = { moderate: 0.5, tight: 0.9 }
    expect(bandOf(0.45, bands)).toBe('relaxed')
    expect(bandOf(0.5, bands)).toBe('moderate')
    expect(bandOf(0.9, bands)).toBe('tight')
  })
})

describe('behaviorFor：档位是行为切换，不是丢弃', () => {
  it('宽松：不做任何注入裁决、不主动推', () => {
    const behavior = behaviorFor('relaxed')
    expect(behavior.mode).toBe('none')
    expect(behavior.pushAllowed).toBe(false)
    expect(behavior.pushLimit).toBe(0)
    expect(behavior.indexOnly).toBe(false)
    expect(behavior.announcePressure).toBe(false)
  })

  it('适中：按边际价值只推最有价值的一条', () => {
    const behavior = behaviorFor('moderate')
    expect(behavior.mode).toBe('single-best')
    expect(behavior.pushAllowed).toBe(true)
    expect(behavior.pushLimit).toBe(1)
    expect(behavior.indexOnly).toBe(false)
  })

  it('紧张：只留索引，内容全部转工具拉取，并主动提示', () => {
    const behavior = behaviorFor('tight')
    expect(behavior.mode).toBe('index-only')
    expect(behavior.pushAllowed).toBe(false)
    expect(behavior.pushLimit).toBe(0)
    expect(behavior.indexOnly).toBe(true)
    expect(behavior.announcePressure).toBe(true)
  })

  it('三档都表明"被推迟的内容仍可通过工具取回"——不允许静默丢失', () => {
    for (const band of ['relaxed', 'moderate', 'tight'] as const) {
      const behavior = behaviorFor(band)
      expect(behavior.recoverable).toBe(true)
      expect(behavior.detail.length).toBeGreaterThan(0)
    }
  })

  it('未知档位回落宽松（不抛、不猜）', () => {
    expect(behaviorFor('bogus' as never).band).toBe('relaxed')
  })
})

describe('normalizeBands / bandsFromPair', () => {
  it('非法阈值各自回落缺省', () => {
    expect(normalizeBands(undefined)).toEqual(DEFAULT_PRESSURE_BANDS)
    expect(normalizeBands({ moderate: Number.NaN, tight: 0.8 })).toEqual({ moderate: 0.3, tight: 0.8 })
  })

  it('阈值反序时交换（而不是产生永不触发的档位）', () => {
    expect(normalizeBands({ moderate: 0.9, tight: 0.4 })).toEqual({ moderate: 0.4, tight: 0.9 })
  })

  it('越界阈值收敛到 [0,1]', () => {
    expect(normalizeBands({ moderate: -1, tight: 3 })).toEqual({ moderate: 0, tight: 1 })
  })

  it('从 cordis.patch.yml 的 [0.3, 0.6] 解析；畸形输入回落缺省且不抛', () => {
    expect(bandsFromPair([0.3, 0.6])).toEqual({ moderate: 0.3, tight: 0.6 })
    expect(bandsFromPair([0.5, 0.9])).toEqual({ moderate: 0.5, tight: 0.9 })
    expect(bandsFromPair(undefined)).toEqual(DEFAULT_PRESSURE_BANDS)
    expect(bandsFromPair('0.3,0.6')).toEqual(DEFAULT_PRESSURE_BANDS)
    expect(bandsFromPair([0.4])).toEqual({ moderate: 0.4, tight: DEFAULT_PRESSURE_BANDS.tight })
    expect(bandsFromPair([Number.NaN, Number.NaN])).toEqual(DEFAULT_PRESSURE_BANDS)
  })
})

describe('readingOf：一次拿全档位与行为', () => {
  it('按配置阈值判档（不是固定缺省）', () => {
    expect(readingOf(pressure(0.45)).band).toBe('moderate')
    expect(readingOf(pressure(0.45), { moderate: 0.5, tight: 0.9 }).band).toBe('relaxed')
  })

  it('压力缺失 / fillRatio null → relaxed + 空推入', () => {
    for (const input of [null, undefined, pressure(null)]) {
      const reading = readingOf(input)
      expect(reading.band).toBe('relaxed')
      expect(reading.behavior.pushLimit).toBe(0)
      expect(reading.fillRatio).toBeNull()
    }
  })

  it('fillRatio 原样带出（供状态面显示）', () => {
    expect(readingOf(pressure(0.72)).fillRatio).toBe(0.72)
    expect(readingOf(pressure(0.72)).behavior.indexOnly).toBe(true)
  })
})
