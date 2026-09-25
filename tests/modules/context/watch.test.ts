/**
 * 拉取计数台账与杀死判据（规划 §6.4 / §6.6 / §6.9）。
 *
 * 杀死判据必须是**可执行的**：某个视图长期趋近 0 次拉取 → 建议删除，
 * 而且要出现在 `health().detail` 里。
 */
import { describe, expect, it } from 'vitest'
import type { ContextPressure } from '../../../kernel/abi/index.js'
import {
  DEAD_VIEW_PULLS_PER_TURN,
  EMPTY_LEDGER,
  MIN_TURNS_FOR_VERDICT,
  VIEW_TOOLS,
  cacheHitRate,
  healthDetail,
  noteTurn,
  recordPull,
  summarize,
} from '../../../modules/context/watch.js'

const ledgerAfter = (pulls: Readonly<Record<string, number>>, turns: number) => {
  let ledger = noteTurn(EMPTY_LEDGER, turns)
  for (const [view, count] of Object.entries(pulls)) {
    for (let index = 0; index < count; index += 1) ledger = recordPull(ledger, view, turns)
  }
  return ledger
}

describe('recordPull / noteTurn：不可变台账', () => {
  it('记一次拉取会更新次数与轮次范围，且返回新台账', () => {
    const before = EMPTY_LEDGER
    const once = recordPull(before, 'omb_recall', 3)
    expect(before.views).toEqual({})
    expect(once.views.omb_recall).toEqual({ pulls: 1, firstTurn: 3, lastTurn: 3 })
    expect(once.turns).toBe(3)

    const twice = recordPull(recordPull(once, 'omb_recall', 7), 'omb_recall', 7)
    expect(twice.views.omb_recall?.pulls).toBe(3)
    expect(twice.views.omb_recall?.firstTurn).toBe(3)
    expect(twice.views.omb_recall?.lastTurn).toBe(7)
  })

  it('空视图名被忽略（垃圾键不进台账）；非法轮次按 0 处理但轮次单调不减', () => {
    const ledger = recordPull(recordPull(EMPTY_LEDGER, '   ', 5), 'omb_method', Number.NaN)
    expect(Object.keys(ledger.views)).toEqual(['omb_method'])
    expect(ledger.views.omb_method?.firstTurn).toBe(0)
    expect(noteTurn(ledger, 9).turns).toBe(9)
    expect(noteTurn(noteTurn(ledger, 9), 4).turns).toBe(9)
  })

  it('畸形台账不抛', () => {
    expect(noteTurn(null as never, 1).turns).toBe(1)
    expect(recordPull(undefined as never, 'omb_recall', 1).views.omb_recall?.pulls).toBe(1)
  })
})

describe('summarize：pullsPerTurn 与杀死判据', () => {
  it('总数与每轮拉取次数', () => {
    const ledger = ledgerAfter({ omb_recall: 4, omb_method: 2 }, 8)
    const snapshot = summarize(ledger, { views: VIEW_TOOLS })
    expect(snapshot.turns).toBe(8)
    expect(snapshot.totalPulls).toBe(6)
    expect(snapshot.pullsPerTurn).toBeCloseTo(0.75, 6)
    const recall = snapshot.views.find(view => view.view === 'omb_recall')
    expect(recall?.pullsPerTurn).toBeCloseTo(0.5, 6)
  })

  it('传入"当前注册的视图"后，从未被拉过的视图也出现（拉取 0 次）', () => {
    const snapshot = summarize(ledgerAfter({ omb_recall: 1 }, 3), { views: VIEW_TOOLS })
    expect(snapshot.views.map(view => view.view).sort()).toEqual([...VIEW_TOOLS].sort())
    expect(snapshot.views.find(view => view.view === 'omb_files')?.pulls).toBe(0)
  })

  it('不传 views 时只看台账里出现过的视图（不为关掉的模块记账）', () => {
    const snapshot = summarize(ledgerAfter({ omb_recall: 1 }, 3))
    expect(snapshot.views.map(view => view.view)).toEqual(['omb_recall'])
  })

  it('轮数不足时**不下杀死结论**（诚实：样本不够就不装懂）', () => {
    const ledger = ledgerAfter({ omb_recall: 1 }, MIN_TURNS_FOR_VERDICT - 1)
    const snapshot = summarize(ledger, { views: VIEW_TOOLS })
    expect(snapshot.deadViews).toEqual([])
    expect(snapshot.verdict).toContain('暂不下')
  })

  it('达到判定轮数且长期 0 拉取 → 进入待删除列表，verdict 写明原因', () => {
    const ledger = ledgerAfter({ omb_recall: 30 }, MIN_TURNS_FOR_VERDICT)
    const snapshot = summarize(ledger, { views: VIEW_TOOLS })
    expect(snapshot.deadViews).toEqual(['omb_files', 'omb_focus', 'omb_method', 'omb_relate'])
    expect(snapshot.verdict).toContain('建议删除视图')
    expect(snapshot.verdict).toContain('omb_files')
    expect(DEAD_VIEW_PULLS_PER_TURN).toBe(0.05)
  })

  it('全部视图都有稳定拉取 → 无待删除', () => {
    const ledger = ledgerAfter(
      { omb_recall: 30, omb_relate: 30, omb_files: 30, omb_method: 30, omb_focus: 30 },
      MIN_TURNS_FOR_VERDICT,
    )
    const snapshot = summarize(ledger, { views: VIEW_TOOLS })
    expect(snapshot.deadViews).toEqual([])
    expect(snapshot.verdict).toContain('全部保留')
  })

  it('阈值可覆盖（标定用）', () => {
    const ledger = ledgerAfter({ omb_recall: 1 }, 3)
    const snapshot = summarize(ledger, { views: VIEW_TOOLS, minTurns: 3, deadBelow: 1 })
    expect(snapshot.deadViews).toContain('omb_files')
    expect(snapshot.views.every(view => Number.isFinite(view.pullsPerTurn))).toBe(true)
  })

  it('零轮次不会产生 Infinity / NaN', () => {
    const snapshot = summarize(EMPTY_LEDGER, { views: VIEW_TOOLS })
    expect(snapshot.pullsPerTurn).toBe(0)
    expect(snapshot.verdict).toContain('暂不下')
  })
})

describe('healthDetail：杀死判据必须出现在 detail 里', () => {
  it('有视图趋近 0 → detail 写明待删除对象', () => {
    const snapshot = summarize(ledgerAfter({ omb_recall: 30 }, MIN_TURNS_FOR_VERDICT), { views: VIEW_TOOLS })
    const detail = healthDetail(snapshot)
    expect(detail).toContain('待删除视图：omb_files')
    expect(detail).toContain('次/轮')
  })

  it('没有待删除视图 → 明确说"无"（不留空）', () => {
    const ledger = ledgerAfter(
      { omb_recall: 30, omb_relate: 30, omb_files: 30, omb_method: 30, omb_focus: 30 },
      MIN_TURNS_FOR_VERDICT,
    )
    expect(healthDetail(summarize(ledger, { views: VIEW_TOOLS }))).toContain('无视图趋近 0')
  })
})

describe('cacheHitRate：前缀稳定性的健康度', () => {
  const pressure = (read: number, write: number): ContextPressure => ({
    totalTokens: 0,
    fillRatio: null,
    band: 'relaxed',
    cacheReadTokens: read,
    cacheWriteTokens: write,
    nodes: [],
  })

  it('读 / (读 + 写)', () => {
    expect(cacheHitRate(pressure(750, 250))).toBeCloseTo(0.75, 6)
    expect(cacheHitRate(pressure(0, 100))).toBe(0)
    expect(cacheHitRate(pressure(100, 0))).toBe(1)
  })

  it('没有缓存数据时返回 null（不臆断为 0）', () => {
    expect(cacheHitRate(pressure(0, 0))).toBeNull()
    expect(cacheHitRate(null)).toBeNull()
    expect(cacheHitRate(undefined)).toBeNull()
  })
})
