/**
 * 档位 → 控制参数，以及失败分类器 + 恢复策略。
 *
 * 这一组测试是本次改造的**判据**：
 * ① `deep` 与 `standard` 的差异必须落在**结构化参数**上（不是注入更多文本）
 * ② 失败处置必须是**分类 → 策略**，旧的全阈值只能作为某一类下的预算存在
 * ③ 控制读数有硬上限（它是一行参数，不是散文）
 */
import { describe, expect, it } from 'vitest'
import type { LoopSignal } from '../../../modules/reasoning/loop.js'
import {
  AUTO_INJECT_CARD_CAP,
  CONTROL_BY_DEPTH,
  CONTROL_LINE_MAX,
  FAILURE_CLASSES,
  FAILURE_PLAYBOOK,
  REPEAT_WITHOUT_EVIDENCE_HINT,
  classifyFailure,
  controlLine,
  controlOf,
  describeControl,
  failureSignalsFromLoop,
  isFailureClass,
  recoveryFor,
  renderRecovery,
} from '../../../modules/reasoning/control.js'

describe('档位控制表：deep 变的是参数', () => {
  it('三档的参数逐条列出（这是"deep 到底要求什么"的唯一真源）', () => {
    expect(CONTROL_BY_DEPTH).toEqual({
      quick: {
        depth: 'quick',
        verifyBudget: 0,
        evidenceLevel: 'none',
        branchBudget: 1,
        reviewBudget: 0,
        stopRule: 'first-answer',
        injectCard: null,
      },
      standard: {
        depth: 'standard',
        verifyBudget: 1,
        evidenceLevel: 'cite-source',
        branchBudget: 2,
        reviewBudget: 1,
        stopRule: 'evidence-backed',
        injectCard: null,
      },
      deep: {
        depth: 'deep',
        verifyBudget: 3,
        evidenceLevel: 'cite-and-label',
        branchBudget: 3,
        reviewBudget: 2,
        stopRule: 'verified-or-labeled',
        injectCard: 'R4',
      },
    })
  })

  it('deep 与 standard 在**每一项**控制参数上都不同', () => {
    const standard = CONTROL_BY_DEPTH.standard
    const deep = CONTROL_BY_DEPTH.deep
    expect(deep.verifyBudget).not.toBe(standard.verifyBudget)
    expect(deep.evidenceLevel).not.toBe(standard.evidenceLevel)
    expect(deep.branchBudget).not.toBe(standard.branchBudget)
    expect(deep.reviewBudget).not.toBe(standard.reviewBudget)
    expect(deep.stopRule).not.toBe(standard.stopRule)
  })

  it('严格度逐档递增（验证预算 / 分支 / 复核都不随档位下降）', () => {
    const order = ['quick', 'standard', 'deep'] as const
    for (let index = 1; index < order.length; index += 1) {
      const previous = CONTROL_BY_DEPTH[order[index - 1] as 'quick' | 'standard']
      const current = CONTROL_BY_DEPTH[order[index] as 'standard' | 'deep']
      expect(current.verifyBudget).toBeGreaterThan(previous.verifyBudget)
      expect(current.branchBudget).toBeGreaterThan(previous.branchBudget)
      expect(current.reviewBudget).toBeGreaterThanOrEqual(previous.reviewBudget)
    }
  })

  it('自动注入的卡片上限是 1，且只有 deep 用掉它', () => {
    expect(AUTO_INJECT_CARD_CAP).toBe(1)
    expect(controlOf('quick').injectCard).toBeNull()
    expect(controlOf('standard').injectCard).toBeNull()
    expect(controlOf('deep').injectCard).toBe('R4')
  })

  it('未知档位回落 standard（不抛）', () => {
    expect(controlOf('bogus' as never).depth).toBe('standard')
  })
})

describe('controlLine：一行参数读数，有上限', () => {
  it('三档都 ≤ CONTROL_LINE_MAX，且读数里含验证预算与收尾条件', () => {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      const line = controlLine(depth)
      expect(line.length, `${depth} 控制读数过长`).toBeLessThanOrEqual(CONTROL_LINE_MAX)
      expect(line).toContain(`档位 ${depth}`)
      expect(line).toContain(`验证 0/${controlOf(depth).verifyBudget}`)
      expect(line).toContain('收尾')
      expect(line).toContain('失败先分类')
    }
  })

  it('已用次数反映在读数里，并被夹在该档预算内', () => {
    expect(controlLine('deep', 2)).toContain('验证 2/3')
    expect(controlLine('deep', 99)).toContain('验证 3/3')
    expect(controlLine('deep', -5)).toContain('验证 0/3')
    expect(controlLine('deep', Number.NaN)).toContain('验证 0/3')
  })

  it('读数里没有"你要思考"这类形容词（全是参数与门槛）', () => {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      const line = controlLine(depth)
      for (const banned of ['深入', '仔细', '认真', '更多思考', '努力']) {
        expect(line.includes(banned), `${depth} 读数出现"${banned}"`).toBe(false)
      }
    }
  })

  it('controlLine 是纯函数：同参数同输出', () => {
    expect(controlLine('deep', 1)).toBe(controlLine('deep', 1))
  })

  it('describeControl 逐档给出人可读摘要', () => {
    expect(describeControl('quick')).toContain('验证预算 0 次')
    expect(describeControl('standard')).toContain('可并列至多 2 个互斥方案')
    expect(describeControl('deep')).toContain('指出来源并标注未验证项')
    expect(describeControl('deep')).toContain('可复核 2 次')
  })
})

describe('失败分类器：分类 → 恢复策略', () => {
  it('五类齐全，映射与用户给的处置一一对应', () => {
    expect(FAILURE_CLASSES).toEqual([
      'transient',
      'parameter-error',
      'strategy-error',
      'environment-error',
      'unknown',
    ])
    expect(FAILURE_PLAYBOOK.transient.strategy).toBe('retry')
    expect(FAILURE_PLAYBOOK['parameter-error'].strategy).toBe('alter')
    expect(FAILURE_PLAYBOOK['strategy-error'].strategy).toBe('branch')
    expect(FAILURE_PLAYBOOK['environment-error'].strategy).toBe('inspect')
    expect(FAILURE_PLAYBOOK.unknown.strategy).toBe('verify')
    expect(FAILURE_PLAYBOOK.unknown.action).toContain('问用户')
  })

  it('每一类都有预算、动作与理由（无空字段，预算都是正数）', () => {
    for (const failureClass of FAILURE_CLASSES) {
      const policy = FAILURE_PLAYBOOK[failureClass]
      expect(policy.failureClass).toBe(failureClass)
      expect(policy.budget).toBeGreaterThan(0)
      expect(policy.action.length).toBeGreaterThan(4)
      expect(policy.why.length).toBeGreaterThan(4)
    }
  })

  it('旧阈值只作为 transient 一类下的预算存在，并写明理由', () => {
    const transient = FAILURE_PLAYBOOK.transient
    expect(transient.budget).toBe(2)
    // 预算不是禁令：理由里必须说清它是"这一类的上限"
    expect(transient.why).toContain('这一类的上限')
    expect(transient.why).toContain('瞬时')
    // 没有任何一类把"禁止"写进动作
    for (const failureClass of FAILURE_CLASSES) {
      expect(FAILURE_PLAYBOOK[failureClass].action).not.toContain('禁止')
      expect(FAILURE_PLAYBOOK[failureClass].why).not.toContain('禁止')
    }
  })

  it('方向错→换方向（branch），不是"再试一次"', () => {
    expect(recoveryFor('strategy-error').strategy).toBe('branch')
    expect(recoveryFor('strategy-error').action).toContain('换一个方向')
  })

  it('模型给定的分类是权威（除 unknown）', () => {
    expect(classifyFailure({ declared: 'transient', parameterHint: true })).toBe('transient')
    expect(classifyFailure({ declared: 'environment-error', repeatedWithoutEvidence: 9 })).toBe('environment-error')
  })

  it('unknown 会被结构信号细化；没有信号时保持 unknown', () => {
    expect(classifyFailure({ declared: 'unknown' })).toBe('unknown')
    expect(
      classifyFailure({ declared: 'unknown', repeatedWithoutEvidence: REPEAT_WITHOUT_EVIDENCE_HINT }),
    ).toBe('strategy-error')
    expect(classifyFailure({ repeatedWithoutEvidence: 1 })).toBe('unknown')
  })

  it('线索优先级：参数线索先于环境线索，环境线索先于结构信号', () => {
    expect(classifyFailure({ parameterHint: true, environmentHint: true })).toBe('parameter-error')
    expect(classifyFailure({ environmentHint: true, repeatedWithoutEvidence: 5 })).toBe('environment-error')
  })

  it('畸形输入不抛，落到 unknown', () => {
    expect(classifyFailure()).toBe('unknown')
    expect(classifyFailure({ declared: '不存在的类' as never })).toBe('unknown')
    expect(classifyFailure({ repeatedWithoutEvidence: Number.NaN })).toBe('unknown')
    expect(recoveryFor('不存在' as never).strategy).toBe('verify')
    expect(isFailureClass('transient')).toBe(true)
    expect(isFailureClass('transientt')).toBe(false)
    expect(isFailureClass(null)).toBe(false)
  })

  it('Loop → 分类：绕圈（重复/来回/空转）会被判成方向问题', () => {
    const signal = (kind: LoopSignal['kind']): LoopSignal => ({ kind, detail: 'd', hint: 'h' })
    expect(failureSignalsFromLoop(signal('repeat-action')).repeatedWithoutEvidence).toBe(
      REPEAT_WITHOUT_EVIDENCE_HINT,
    )
    expect(failureSignalsFromLoop(signal('oscillation')).repeatedWithoutEvidence).toBe(
      REPEAT_WITHOUT_EVIDENCE_HINT,
    )
    expect(failureSignalsFromLoop(signal('stalled')).repeatedWithoutEvidence).toBe(
      REPEAT_WITHOUT_EVIDENCE_HINT,
    )
    expect(failureSignalsFromLoop(signal('no-new-evidence')).repeatedWithoutEvidence).toBe(1)
    expect(failureSignalsFromLoop(null)).toEqual({})
    // 接线后的实际效果：模型说"分不清"，但 Loop 看到绕圈 → 换方向
    expect(classifyFailure({ declared: 'unknown', ...failureSignalsFromLoop(signal('oscillation')) })).toBe(
      'strategy-error',
    )
  })

  it('回执含分类、策略、预算、动作与依据', () => {
    const text = renderRecovery(FAILURE_PLAYBOOK['parameter-error'])
    expect(text).toContain('parameter-error')
    expect(text).toContain('alter')
    expect(text).toContain('预算 1 次')
    expect(text).toContain('依据：')
  })
})
