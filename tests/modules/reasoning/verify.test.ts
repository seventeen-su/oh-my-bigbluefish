/**
 * Verify：结论的**形式核对** + 台账（可观测）。
 *
 * 三条不能含糊的边界，测试逐条钉住：
 * ① 判定只做形式核对，**不声称内容为真**（回执文本里必须自己说清）
 * ② 台账能回答"本回合验证了几次 / 结果如何"，未闭合条数会随重核下降
 * ③ 不是"每个 claim 都要跑一遍"——空请求、畸形输入都给出可执行下一步，不抛
 */
import { describe, expect, it } from 'vitest'
import {
  VERDICT_TEXT,
  VERIFY_LEDGER_MAX,
  VERIFY_SEGMENT_MAX,
  type VerifyLedger,
  type VerifyRecord,
  describeVerify,
  evidenceFormOf,
  isCitableEvidence,
  judgeClaim,
  recordVerify,
  summarizeVerify,
  trackVerify,
  createVerifyTracker,
  summarizeTracker,
  verifyLine,
} from '../../../modules/reasoning/verify.js'

const record = (over: Partial<VerifyRecord> & { claim: string }): VerifyRecord => ({
  verdict: 'checkable',
  at: 0,
  depth: 'standard',
  turn: 0,
  overBudget: false,
  ...over,
})

describe('isCitableEvidence：形式清单（不是真值判断）', () => {
  it('认得出可核对的来源形式', () => {
    expect(isCitableEvidence('src/modules/recall.ts:42 里 searchLexical 提前返回')).toBe(true)
    expect(isCitableEvidence('运行 npm test -- --run 的输出第 3 行')).toBe(true)
    expect(isCitableEvidence('用户原话：“我不想每次都被打断”')).toBe(true)
    expect(isCitableEvidence('提交 4f2a91c 改掉了这个分支')).toBe(true)
    expect(isCitableEvidence('见 https://example.com/doc')).toBe(true)
    expect(isCitableEvidence('工件 build/report.json 存在')).toBe(true)
  })

  it('指不出来源的表述不算证据', () => {
    expect(isCitableEvidence('一般来说是这样')).toBe(false)
    expect(isCitableEvidence('我记得好像可以')).toBe(false)
    expect(isCitableEvidence('通常没问题')).toBe(false)
    expect(isCitableEvidence('')).toBe(false)
    expect(isCitableEvidence(undefined)).toBe(false)
    expect(isCitableEvidence(42)).toBe(false)
  })

  it('证据形式三态：none / citable / uncited', () => {
    expect(evidenceFormOf('')).toBe('none')
    expect(evidenceFormOf('   ')).toBe('none')
    expect(evidenceFormOf('src/a.ts:1')).toBe('citable')
    expect(evidenceFormOf('大概是吧')).toBe('uncited')
  })
})

describe('judgeClaim：形式核对的四个结论', () => {
  it('没给来源 → needs-evidence，并告诉下一步要什么', () => {
    const judgement = judgeClaim({ claim: '这个函数是纯的' })
    expect(judgement.verdict).toBe('needs-evidence')
    expect(judgement.evidenceForm).toBe('none')
    expect(judgement.next).toContain('来源')
    expect(judgement.next).toContain('待确认')
  })

  it('来源指不出来 → self-report（不是"证据不足"，是"这不算证据"）', () => {
    const judgement = judgeClaim({ claim: '这个函数是纯的', evidence: '我看过了，没问题' })
    expect(judgement.verdict).toBe('self-report')
    expect(judgement.note).toContain('指不出来源')
  })

  it('有来源但说不出否证条件 → needs-falsifier', () => {
    const judgement = judgeClaim({ claim: '这个函数是纯的', evidence: 'src/a.ts:12' })
    expect(judgement.verdict).toBe('needs-falsifier')
    expect(judgement.next).toContain('否证条件')
  })

  it('来源 + 否证条件 → checkable，且回执明说"不代表内容为真"', () => {
    const judgement = judgeClaim({
      claim: '这个函数是纯的',
      evidence: 'src/a.ts:12',
      falsifier: '如果它对同一输入返回不同结果就说明不纯',
    })
    expect(judgement.verdict).toBe('checkable')
    expect(judgement.evidenceForm).toBe('citable')
    expect(judgement.note).toContain('不代表内容为真')
    expect(judgement.note).toContain('核对该来源')
    expect(judgement.next).toContain('待确认')
  })

  it('空结论也给出下一步，不抛', () => {
    const judgement = judgeClaim({ claim: '   ' })
    expect(judgement.verdict).toBe('needs-evidence')
    expect(judgement.claim).toBe('')
    expect(judgement.next.length).toBeGreaterThan(0)
    expect(judgeClaim(null as never).verdict).toBe('needs-evidence')
    expect(judgeClaim({ claim: 42 as never }).verdict).toBe('needs-evidence')
  })
})

describe('台账：可观测、可回落', () => {
  it('recordVerify 追加并保留最近 VERIFY_LEDGER_MAX 条（纯函数）', () => {
    let ledger = recordVerify([], record({ claim: 'a' }))
    const before = ledger
    for (let index = 0; index < VERIFY_LEDGER_MAX + 5; index += 1) {
      ledger = recordVerify(ledger, record({ claim: `c${index}`, verdict: 'needs-evidence' }))
    }
    expect(before.length).toBe(1)
    expect(ledger.length).toBe(VERIFY_LEDGER_MAX)
    expect(recordVerify(null as never, record({ claim: 'x' })).length).toBe(1)
  })

  it('汇总给出调用次数、可核对数、未闭合数与最近一条', () => {
    const ledger = [
      record({ claim: '甲', verdict: 'needs-evidence' }),
      record({ claim: '乙', verdict: 'checkable' }),
      record({ claim: '丙', verdict: 'self-report', overBudget: true }),
    ]
    const summary = summarizeVerify(ledger, 3)
    expect(summary.calls).toBe(3)
    expect(summary.checkable).toBe(1)
    expect(summary.unresolved).toBe(2)
    expect(summary.overBudget).toBe(1)
    expect(summary.budget).toBe(3)
    expect(summary.lastVerdict).toBe('self-report')
    expect(summary.lastClaim).toBe('丙')
  })

  it('同一条结论补上来源后未闭合数会降下来（衡量待办，不是历史）', () => {
    let ledger: VerifyLedger = [record({ claim: '甲', verdict: 'needs-evidence' })]
    expect(summarizeVerify(ledger, 1).unresolved).toBe(1)
    ledger = recordVerify(ledger, record({ claim: '甲', verdict: 'checkable' }))
    const summary = summarizeVerify(ledger, 1)
    expect(summary.calls).toBe(2)
    expect(summary.unresolved).toBe(0)
  })

  it('畸形台账被当成空台账（不抛、不产出非有限数）', () => {
    const summary = summarizeVerify(null as never, Number.NaN)
    expect(summary.calls).toBe(0)
    expect(summary.unresolved).toBe(0)
    expect(summary.budget).toBe(0)
    expect(summarizeVerify([{ claim: 1 } as never], 1).lastVerdict).toBe('needs-evidence')
  })
})

describe('verifyLine / describeVerify：注入与状态面', () => {
  it('没有未闭合项 → 注入空串（不注入"当前没有待验证项"这种废话）', () => {
    expect(verifyLine(summarizeVerify([record({ claim: '甲' })], 1))).toBe('')
    expect(verifyLine(summarizeVerify([], 0))).toBe('')
  })

  it('有未闭合项 → 一行，且 ≤ VERIFY_SEGMENT_MAX', () => {
    const ledger = [
      record({ claim: '这个函数是纯的', verdict: 'needs-falsifier' }),
      record({ claim: '缓存没生效', verdict: 'self-report' }),
    ]
    const line = verifyLine(summarizeVerify(ledger, 3))
    expect(line).toContain('2 条结论未过形式核对')
    expect(line).toContain('待确认')
    expect(line).toContain('本档验证预算 2/3')
    expect(line.length).toBeLessThanOrEqual(VERIFY_SEGMENT_MAX)
  })

  it('quick 档（预算 0）的验证段如实说"本档不要求验证"', () => {
    const line = verifyLine(summarizeVerify([record({ claim: '甲', verdict: 'needs-evidence' })], 0))
    expect(line).toContain('本档不要求验证')
  })

  it('"本回合验证了几次"：给了回合号才算，不给时为 null（不假装 0）', () => {
    const ledger = [
      record({ claim: '甲', verdict: 'needs-evidence', turn: 1 }),
      record({ claim: '乙', verdict: 'checkable', turn: 2 }),
      record({ claim: '丙', verdict: 'self-report', turn: 2 }),
    ]
    expect(summarizeVerify(ledger, 3).thisTurn).toBeNull()
    expect(summarizeVerify(ledger, 3, 2).thisTurn).toBe(2)
    expect(summarizeVerify(ledger, 3, 1).thisTurn).toBe(1)
    expect(summarizeVerify(ledger, 3, 9).thisTurn).toBe(0)
    // 未给回合号时状态面不写"本回合"，给了才写
    expect(describeVerify(summarizeVerify(ledger, 3))).not.toContain('本回合')
    expect(describeVerify(summarizeVerify(ledger, 3, 2))).toContain('本回合 2 次')
  })

  it('状态面读数：次数、可核对数、未闭合数、超预算数', () => {
    const ledger = [
      record({ claim: '甲', verdict: 'checkable' }),
      record({ claim: '乙', verdict: 'needs-evidence', overBudget: true }),
    ]
    const text = describeVerify(summarizeVerify(ledger, 1))
    expect(text).toContain('验证：2 次')
    expect(text).toContain('形式可核对 1')
    expect(text).toContain('未闭合 1')
    expect(text).toContain('超预算 1')
    expect(text).toContain(VERDICT_TEXT['needs-evidence'])
  })

  it('还没核对过时状态面如实说"尚无"', () => {
    expect(describeVerify(summarizeVerify([], 1))).toContain('尚无')
  })
})

/**
 * G3（P1）：台账的 32 条上限**只限制复盘窗口**，累计读数与未闭合数不受它影响。
 *
 * 修复前：`summarizeVerify(ledger,…).calls` 就是被 `slice` 后的长度，
 * 于是第 33 次之后回执永远说"这是第 33 次"、状态面永远"验证：32 次"。
 */
describe('trackVerify / summarizeTracker：窗口滚动不改累计（G3）', () => {
  it('超过 VERIFY_LEDGER_MAX 之后：台账只留最近 32 条，累计数仍是真实累计', () => {
    const tracker = createVerifyTracker()
    const total = VERIFY_LEDGER_MAX + 8
    for (let index = 0; index < total; index += 1) {
      trackVerify(tracker, record({ claim: `c${index}`, verdict: 'needs-evidence', overBudget: true }))
    }
    expect(tracker.ledger.length).toBe(VERIFY_LEDGER_MAX)
    const summary = summarizeTracker(tracker, 1)
    expect(summary.calls).toBe(total)
    expect(summary.overBudget).toBe(total)
    expect(summary.unresolved).toBe(total)
    // 状态面这一行以前会停在 32
    expect(describeVerify(summary)).toContain(`验证：${total} 次`)
    expect(describeVerify(summary)).toContain(`超预算 ${total}`)
  })

  it('未闭合结论不随台账滚动消失；同一条结论重核后可核对 → 未闭合降下来', () => {
    const tracker = createVerifyTracker()
    trackVerify(tracker, record({ claim: 'c1', verdict: 'needs-evidence' }))
    for (let index = 0; index < VERIFY_LEDGER_MAX + 4; index += 1) {
      trackVerify(tracker, record({ claim: `later${index}`, verdict: 'checkable' }))
    }
    // c1 早已滚出窗口，但它仍是"未闭合的待办"
    expect(tracker.ledger.some(item => item.claim === 'c1')).toBe(false)
    expect(summarizeTracker(tracker, 3).unresolved).toBe(1)
    // 补上来源重核 c1 → 待办清掉（数字按最新判定算，不是历史）
    trackVerify(tracker, record({ claim: 'c1', verdict: 'checkable' }))
    expect(summarizeTracker(tracker, 3).unresolved).toBe(0)
  })

  it('累计可核对数与"本回合几次"各自按自己的口径给：前者不滚动，后者按回合复位', () => {
    const tracker = createVerifyTracker()
    trackVerify(tracker, record({ claim: 'a', verdict: 'checkable', turn: 1 }))
    trackVerify(tracker, record({ claim: 'b', verdict: 'checkable', turn: 1 }))
    trackVerify(tracker, record({ claim: 'c', verdict: 'needs-evidence', turn: 2 }))
    const summary = summarizeTracker(tracker, 3, 2)
    expect(summary.calls).toBe(3)
    expect(summary.checkable).toBe(2)
    expect(summary.thisTurn).toBe(1)
    // 换到第 3 回合：本回合 0 次（不是"上一次那个回合的数"）
    expect(summarizeTracker(tracker, 3, 3).thisTurn).toBe(0)
    // 不给回合号 → null（不猜、也不写 0）
    expect(summarizeTracker(tracker, 3).thisTurn).toBeNull()
  })

  it('畸形记录也照常计数（累计不能因为一条脏数据丢数）', () => {
    const tracker = createVerifyTracker()
    trackVerify(tracker, { claim: 1, verdict: '瞎写' } as never)
    expect(tracker.total).toBe(1)
    expect(summarizeTracker(tracker, 1).lastVerdict).toBe('needs-evidence')
  })
})
