/**
 * 3.7 Wave 2 / R9 C1+C3：效用估计与自适应下限的纯函数行为。
 *
 * 这里钉住的是**数学性质**（不是实现细节）：
 * ① Beta 后验 + 经验贝叶斯收缩；② "曝光多但没人用 → 效用下降"（打断旧的反馈环）；
 * ③ 相对分位阈值的单调性、小库保护、fixed 回滚；④ 校准器步长/窗口/夹紧/可持久化。
 */
import { describe, expect, it } from 'vitest'
import {
  AdaptiveFloorCalibrator,
  EMPTY_UTILITY_COUNTERS,
  LEXICAL_ABS_MAX,
  LEXICAL_ABS_MIN,
  LEXICAL_QUANTILE_INITIAL,
  UTILITY_BASE_RATE,
  betaPosterior,
  estimateUtility,
  lexicalFloorFor,
  quantileOf,
} from '../../../modules/memory/utility.js'

describe('效用估计（R9 C1）', () => {
  it('从未曝光 → utility = 基率 0.2（不是 0、不是 1）', () => {
    expect(estimateUtility(EMPTY_UTILITY_COUNTERS)).toBeCloseTo(UTILITY_BASE_RATE, 12)
    expect(UTILITY_BASE_RATE).toBeCloseTo(0.2, 12)
  })

  it('曝光增加但没人用 → utility **下降**（旧 useCount 公式会上升）', () => {
    const once = estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 1 })
    const many = estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 20 })
    expect(many).toBeLessThan(once)
    const oldFormula = (exposed: number): number => exposed / (1 + exposed)
    expect(oldFormula(20)).toBeGreaterThan(oldFormula(1)) // 对照：旧公式方向相反
  })

  it('使用/显式 useful 提高效用；stale/noise/wrong 降低效用', () => {
    const base = estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 10, used: 2 })
    expect(estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 10, used: 6 })).toBeGreaterThan(base)
    expect(estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 10, used: 2, useful: 2 })).toBeGreaterThan(base)
    expect(estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 10, used: 2, stale: 2 })).toBeLessThan(base)
    expect(estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 10, used: 2, noise: 3 })).toBeLessThan(base)
    expect(estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 10, used: 2, wrong: 1 })).toBeLessThan(base)
  })

  it('经验贝叶斯收缩：曝光少时更靠近基率（不会因一次 used 就冲到 1）', () => {
    const rare = estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 1, used: 1 })
    const rich = estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 20, used: 20 })
    expect(rare).toBeLessThan(rich)
    expect(rare).toBeLessThan(0.6) // 一次使用不该把效用顶满
    expect(betaPosterior({ ...EMPTY_UTILITY_COUNTERS, exposed: 1, used: 1 })).toBeGreaterThan(rare)
  })

  it('计数异常（负数/NaN/used>exposed）不产生 NaN 或越界', () => {
    const weird = estimateUtility({ exposed: Number.NaN, used: -5, useful: -1, wrong: 0, stale: 0, noise: 0 })
    expect(Number.isFinite(weird)).toBe(true)
    expect(weird).toBeGreaterThanOrEqual(0)
    expect(weird).toBeLessThanOrEqual(1)
    const capped = estimateUtility({ ...EMPTY_UTILITY_COUNTERS, exposed: 2, used: 99 })
    expect(capped).toBeLessThanOrEqual(1)
  })
})

describe('自适应相对下限（R9 C3）', () => {
  it('分位数线性插值（确定性）', () => {
    expect(quantileOf([], 0.5)).toBe(0)
    expect(quantileOf([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantileOf([1, 2, 3, 4], 0)).toBe(1)
    expect(quantileOf([1, 2, 3, 4], 1)).toBe(4)
  })

  it('relative：阈值 = clamp(max(top×0.35, Q_q), [0.2,1.5])；q 越高阈值不降', () => {
    const scores = [10, 8, 6, 4, 2, 1]
    const low = lexicalFloorFor({ scores, mode: 'relative', fixedFloor: 0.5, quantile: 0.3 })
    const high = lexicalFloorFor({ scores, mode: 'relative', fixedFloor: 0.5, quantile: 0.8 })
    expect(low.mode).toBe('relative')
    expect(low.threshold).toBeCloseTo(LEXICAL_ABS_MAX, 12) // 相对阈值被绝对夹紧
    expect(high.threshold).toBeGreaterThanOrEqual(low.threshold)
    expect(high.threshold).toBeLessThanOrEqual(LEXICAL_ABS_MAX)
  })

  it('小库保护：top 极小（bm25≈1e-6）时退回旧 min(top×0.5, fixed)，保住唯一命中', () => {
    const decision = lexicalFloorFor({ scores: [1e-6], mode: 'relative', fixedFloor: 0.5, quantile: 0.5 })
    expect(decision.mode).toBe('fixed')
    expect(decision.threshold).toBeLessThanOrEqual(1e-6)
  })

  it('fixed 回滚模式：直接用绝对下限，不受分位影响', () => {
    expect(lexicalFloorFor({ scores: [10, 1], mode: 'fixed', fixedFloor: 0.5, quantile: 0.9 })).toEqual({
      threshold: 0.5,
      mode: 'fixed',
    })
  })

  it('绝对夹紧：相对分位算出的值不会超出 [0.2,1.5]', () => {
    const huge = lexicalFloorFor({ scores: [100, 90, 80], mode: 'relative', fixedFloor: 0.5, quantile: 0.5 })
    expect(huge.threshold).toBeLessThanOrEqual(LEXICAL_ABS_MAX)
    expect(huge.threshold).toBeGreaterThanOrEqual(LEXICAL_ABS_MIN)
  })
})

describe('校准器（目标精度 EWMA）', () => {
  it('窗口内精度高于目标 → q 上调 0.05；低于目标 → 下调；无曝光 → 不动', () => {
    const good = new AdaptiveFloorCalibrator({}, 0.6)
    for (let i = 0; i < 19; i += 1) {
      expect(good.observe({ exposures: 10, used: 9 })).toBe(false)
    }
    expect(good.observe({ exposures: 10, used: 9 })).toBe(true)
    expect(good.q).toBeCloseTo(LEXICAL_QUANTILE_INITIAL + 0.05, 12)

    const bad = new AdaptiveFloorCalibrator({}, 0.6)
    for (let i = 0; i < 20; i += 1) bad.observe({ exposures: 10, used: 1 })
    expect(bad.q).toBeCloseTo(0.45, 12)

    const idle = new AdaptiveFloorCalibrator({}, 0.6)
    for (let i = 0; i < 20; i += 1) idle.observe({ exposures: 0, used: 0 })
    expect(idle.q).toBe(LEXICAL_QUANTILE_INITIAL)
  })

  it('q 夹在 [0.3,0.8]，状态可序列化/恢复（跨重启确定）', () => {
    const up = new AdaptiveFloorCalibrator({ q: 0.79 })
    for (let i = 0; i < 20; i += 1) up.observe({ exposures: 10, used: 10 })
    expect(up.q).toBeCloseTo(0.8, 12)
    const restored = new AdaptiveFloorCalibrator(up.state())
    expect(restored.q).toBe(up.q)
    expect(restored.state().recalls).toBe(up.state().recalls)
  })
})
