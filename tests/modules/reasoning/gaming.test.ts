/**
 * v3.6 C：糊弄倾向观察面（`modules/reasoning/gaming.ts`）。
 *
 * 这一组测的是**口径**而不是"检测能力"：证据（CoT 自述承认作弊 <2%、72% 的作弊者
 * 自认合理、内部压力高时输出可以毫无痕迹）决定了这个面只能报**可核对的事实**，
 * 所以每一条断言都在钉三件事：
 * ① 只有真发生了才报（没发生就是没信号）；
 * ② 报出来的是事实（次数、回合数、判定），**不是结论**；
 * ③ "未测量"与"0 个信号"必须分开说。
 */
import { describe, expect, it } from 'vitest'
import {
  GAMING_BANNED_WORDS,
  GAMING_FACTS_PER_SESSION,
  GAMING_SESSIONS,
  GAMING_UNMEASURED,
  observeGaming,
  renderGamingReport,
} from '../../../modules/reasoning/gaming.js'
import type { LoopSignal } from '../../../modules/reasoning/loop.js'
import { createVerifyTracker, trackVerify } from '../../../modules/reasoning/verify.js'
import type { VerifyTracker, VerifyVerdict } from '../../../modules/reasoning/verify.js'

function signalOf(kind: LoopSignal['kind']): LoopSignal {
  return { kind, detail: `${kind} 的依据`, hint: 'hint' }
}

function trackerWith(records: readonly { claim: string; verdict: VerifyVerdict; turn: number }[]): VerifyTracker {
  const tracker = createVerifyTracker()
  for (const record of records) {
    trackVerify(tracker, { claim: record.claim, verdict: record.verdict, at: 1, depth: 'standard', turn: record.turn, overBudget: false })
  }
  return tracker
}

const emptyTracker = createVerifyTracker()

describe('observeGaming：只报真的发生了的事实', () => {
  it('没有任何信号时返回空数组（不报"一切正常"这类废话）', () => {
    expect(observeGaming({ signal: null, tracker: emptyTracker })).toEqual([])
    // 有循环信号但不是"无进展"两类：不属于这个面的范围
    expect(observeGaming({ signal: signalOf('repeat-action'), tracker: emptyTracker })).toEqual([])
    expect(observeGaming({ signal: signalOf('oscillation'), tracker: emptyTracker })).toEqual([])
  })

  it('无进展信号：事实里带 kind 与 Loop 的审计依据（逐字，不复述）', () => {
    const signals = observeGaming({ signal: signalOf('no-new-evidence'), tracker: emptyTracker })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.id).toBe('loop-no-progress')
    expect(signals[0]?.fact).toContain('no-new-evidence')
    expect(signals[0]?.fact).toContain('no-new-evidence 的依据')
  })

  it('同一条结论跨回合反复核对且仍未闭合 → 报出回合数与次数；补上来源后不再报', () => {
    const repeated = trackerWith([
      { claim: '甲的结论', verdict: 'needs-evidence', turn: 1 },
      { claim: '甲的结论', verdict: 'needs-evidence', turn: 2 },
      { claim: '甲的结论', verdict: 'needs-evidence', turn: 3 },
    ])
    const signals = observeGaming({ signal: null, tracker: repeated })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.id).toBe('claim-rechecked-unresolved')
    expect(signals[0]?.fact).toContain('跨 3 个回合被核对 3 次')
    expect(signals[0]?.fact).toContain('仍未过形式核对')

    // 最新判定变成 checkable → 它是待办被清掉，不是历史被抹掉
    const resolved = trackerWith([
      { claim: '甲的结论', verdict: 'needs-evidence', turn: 1 },
      { claim: '甲的结论', verdict: 'needs-evidence', turn: 2 },
      { claim: '甲的结论', verdict: 'checkable', turn: 3 },
    ])
    expect(observeGaming({ signal: null, tracker: resolved })).toEqual([])
  })

  it('阈值：同一回合里核对两次不算"反复"；只核对一次也不算', () => {
    // 同一回合两次：那是正常补证据，不是"没有进展"
    expect(observeGaming({
      signal: null,
      tracker: trackerWith([
        { claim: '乙的结论', verdict: 'needs-evidence', turn: 1 },
        { claim: '乙的结论', verdict: 'self-report', turn: 1 },
      ]),
    })).toEqual([])
    // 跨两个回合但只出现过一次的那一条不算
    expect(observeGaming({
      signal: null,
      tracker: trackerWith([
        { claim: '丙的结论', verdict: 'needs-evidence', turn: 1 },
        { claim: '丁的结论', verdict: 'needs-evidence', turn: 2 },
      ]),
    })).toEqual([])
  })

  it('畸形输入不抛，按"没有信号"处理（观察面不得把状态面拖挂）', () => {
    expect(observeGaming(undefined as never)).toEqual([])
    expect(observeGaming({ signal: null, tracker: undefined as never })).toEqual([])
    expect(observeGaming({ signal: null, tracker: { ledger: null } as never })).toEqual([])
    expect(observeGaming({
      signal: null,
      tracker: { ledger: [null, undefined, {}] } as never,
    }).length).toBeGreaterThanOrEqual(0)
  })
})

describe('renderGamingReport：一行报告，含灵敏度上限与未测量项', () => {
  it('无信号：明说"无信号"，但**同时**写出未测量项（不把"没测"读成"没有"）', () => {
    const line = renderGamingReport([{ session: 's', signals: [] }])
    expect(line).toContain('糊弄倾向：无信号')
    expect(line).toContain('低召回高精度')
    expect(line).toContain(GAMING_UNMEASURED)
    // 未测量项里必须点名那个测不到的东西，而不是一句笼统的"仅供参考"
    expect(line).toContain('测试被改写/跳过')
  })

  it('有信号：报总数、会话归属与事实明细', () => {
    const line = renderGamingReport([
      { session: 's1', signals: [{ id: 'loop-no-progress', fact: '事实一' }] },
      { session: 's2', signals: [] },
    ])
    expect(line).toContain('糊弄倾向：1 个信号')
    expect(line).toContain('会话 s1：事实一')
    expect(line).not.toContain('会话 s2')
  })

  it('超出列举上限时只报总数，不静默丢（另有 N 条/会话）', () => {
    const many = Array.from({ length: GAMING_FACTS_PER_SESSION + 2 }, (_, index) => ({
      id: 'loop-no-progress' as const,
      fact: `事实${index}`,
    }))
    const line = renderGamingReport([{ session: 's1', signals: many }])
    expect(line).toContain(`另有 ${many.length - GAMING_FACTS_PER_SESSION} 条同类未列出`)
    const sessions = Array.from({ length: GAMING_SESSIONS + 1 }, (_, index) => ({
      session: `s${index}`,
      signals: [{ id: 'loop-no-progress' as const, fact: '事实' }],
    }))
    expect(renderGamingReport(sessions)).toContain('另有 1 个会话未列出')
  })

  it('**禁止结论性措辞**：任何组合下都不许出现禁用词表里的词', () => {
    const cases = [
      renderGamingReport([]),
      renderGamingReport([{ session: 's', signals: [] }]),
      renderGamingReport([{ session: 's', signals: observeGaming({ signal: signalOf('stalled'), tracker: emptyTracker }) }]),
      renderGamingReport([{
        session: 's',
        signals: observeGaming({
          signal: signalOf('no-new-evidence'),
          tracker: trackerWith([
            { claim: '甲的结论', verdict: 'needs-evidence', turn: 1 },
            { claim: '甲的结论', verdict: 'self-report', turn: 2 },
          ]),
        }),
      }]),
    ]
    for (const text of cases) {
      for (const banned of GAMING_BANNED_WORDS) {
        expect(text.includes(banned), `报告出现禁用词"${banned}"：${text}`).toBe(false)
      }
    }
  })
})
