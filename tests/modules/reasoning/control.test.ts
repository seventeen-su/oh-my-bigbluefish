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
import { NO_PROGRESS_KINDS } from '../../../modules/reasoning/loop.js'
import {
  AUTO_INJECT_CARD_CAP,
  CONTROL_BY_DEPTH,
  CONTROL_LINE_MAX,
  EXIT_SEGMENT_MAX,
  FAILURE_CLASSES,
  FAILURE_PLAYBOOK,
  REPEAT_WITHOUT_EVIDENCE_HINT,
  classifyFailure,
  controlForBand,
  controlLine,
  controlOf,
  describeControl,
  failureSignalsFromLoop,
  isFailureClass,
  pressureRaisedFloor,
  recoveryFor,
  renderExitOptions,
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

/**
 * v3.6 A②：压力带 → 控制参数。
 *
 * 缺陷形态：`stopRule` / `evidenceLevel` 只由 depth 决定、与 band 无关，
 * 于是压力最大时门槛与压力最小时**一模一样**——而证据方向相反。
 */
describe('压力带 → 控制参数（只升不降）', () => {
  const EVIDENCE_RANK = ['none', 'cite-source', 'cite-and-label'] as const
  const STOP_RANK = ['first-answer', 'evidence-backed', 'verified-or-labeled'] as const
  const strictness = (control: { evidenceLevel: string; stopRule: string }): [number, number] => [
    EVIDENCE_RANK.indexOf(control.evidenceLevel as never),
    STOP_RANK.indexOf(control.stopRule as never),
  ]

  it('tight 把 quick 的证据要求与收尾条件抬到 standard 的水平（是下限，不是"越紧越好"）', () => {
    const quickTight = controlForBand('quick', 'tight')
    expect(quickTight.evidenceLevel).toBe(controlForBand('standard', 'relaxed').evidenceLevel)
    expect(quickTight.stopRule).toBe(controlForBand('standard', 'relaxed').stopRule)
    // 抬的是下限，不是连续量：不会超过 standard
    expect(strictness(quickTight)).toEqual(strictness(controlForBand('standard', 'relaxed')))
  })

  it('standard / deep 在 tight 下逐字节不变（本来就在下限之上，抬不动）', () => {
    expect(controlForBand('standard', 'tight')).toEqual(controlForBand('standard', 'relaxed'))
    expect(controlForBand('deep', 'tight')).toEqual(controlForBand('deep', 'relaxed'))
    // 同对象返回：没有变化就不产生新对象（调用方可以据此判断"这一档没被改")
    expect(controlForBand('standard', 'tight')).toBe(CONTROL_BY_DEPTH.standard)
  })

  it('任何 depth × band 组合都不低于同档的 relaxed（只升不降）', () => {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      const base = strictness(controlForBand(depth, 'relaxed'))
      for (const band of ['relaxed', 'moderate', 'tight'] as const) {
        const current = strictness(controlForBand(depth, band))
        expect(current[0], `${depth}/${band} 证据要求被降了`).toBeGreaterThanOrEqual(base[0])
        expect(current[1], `${depth}/${band} 收尾条件被降了`).toBeGreaterThanOrEqual(base[1])
      }
    }
  })

  it('非 tight 与未知取值都不改参数、不抛', () => {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      expect(controlForBand(depth, 'relaxed')).toEqual(CONTROL_BY_DEPTH[depth])
      expect(controlForBand(depth, 'moderate')).toEqual(CONTROL_BY_DEPTH[depth])
      expect(controlForBand(depth, 'bogus' as never)).toEqual(CONTROL_BY_DEPTH[depth])
    }
    expect(() => controlForBand('bogus' as never, 'tight')).not.toThrow()
    expect(controlForBand('bogus' as never, 'tight').depth).toBe('standard')
  })

  it('pressureRaisedFloor 只说"真的抬了"的那一种（quick + tight）；否则读数不许多加字', () => {
    expect(pressureRaisedFloor('quick', 'tight')).toBe(true)
    expect(pressureRaisedFloor('quick', 'relaxed')).toBe(false)
    expect(pressureRaisedFloor('quick', 'moderate')).toBe(false)
    expect(pressureRaisedFloor('standard', 'tight')).toBe(false)
    expect(pressureRaisedFloor('deep', 'tight')).toBe(false)
  })

  it('读数把压力带读出来（来源维度），且 tight 下的证据/收尾不低于 standard 的读数', () => {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      for (const band of ['relaxed', 'moderate', 'tight'] as const) {
        const line = controlLine(depth, 0, band)
        expect(line.length, `${depth}/${band} 读数过长`).toBeLessThanOrEqual(CONTROL_LINE_MAX)
        expect(line).toContain(`压力 ${band}`)
      }
    }
    const quickTight = controlLine('quick', 0, 'tight')
    expect(quickTight).toContain('证据 指出来源')
    expect(quickTight).toContain('收尾 首选方案有证据支撑')
    expect(quickTight).not.toContain('不要求')
    expect(quickTight).not.toContain('给出答案即可')
  })

  it('describeControl 在 tight 抬了门槛时写明"只升不降"（回执与注入同一口径）', () => {
    expect(describeControl('quick', 'tight')).toContain('门槛只升不降')
    expect(describeControl('quick', 'tight')).toContain('指出来源')
    expect(describeControl('quick', 'relaxed')).not.toContain('门槛只升不降')
    expect(describeControl('standard', 'tight')).not.toContain('门槛只升不降')
  })
})

/**
 * v3.6 B：合法出口段。三条硬约束都要有会失败的判据：
 * ① ≤200 字符；② 只由无进展信号触发；③ 不写反例清单里的措辞。
 */
describe('renderExitOptions：合法出口段（≤EXIT_SEGMENT_MAX）', () => {
  type LoopSignalKind = LoopSignal['kind']
  const signalOf = (kind: LoopSignalKind, hint = 'h'): LoopSignal => ({ kind, detail: '依据', hint })

  it('只有 stalled / no-new-evidence 触发；其余信号与空信号都是空串（不注入废话）', () => {
    for (const kind of NO_PROGRESS_KINDS) {
      expect(renderExitOptions(signalOf(kind), controlOf('standard')), `${kind} 应当触发`).not.toBe('')
    }
    expect(renderExitOptions(signalOf('repeat-action'), controlOf('standard'))).toBe('')
    expect(renderExitOptions(signalOf('oscillation'), controlOf('standard'))).toBe('')
    expect(renderExitOptions(null, controlOf('standard'))).toBe('')
    expect(renderExitOptions(undefined as never, controlOf('standard'))).toBe('')
    // 无进展集合是两处共用的唯一真源：集合里每一个都必须有文案（加了 kind 会红）
    expect([...NO_PROGRESS_KINDS]).toEqual(['stalled', 'no-new-evidence'])
  })

  it('每种（无进展信号 × 档位 × 压力）组合都 ≤EXIT_SEGMENT_MAX，且重述的就是读数里那套判据', () => {
    for (const kind of NO_PROGRESS_KINDS) {
      for (const depth of ['quick', 'standard', 'deep'] as const) {
        for (const band of ['relaxed', 'moderate', 'tight'] as const) {
          const control = controlForBand(depth, band)
          const line = renderExitOptions(signalOf(kind), control)
          expect(line.length, `${kind}/${depth}/${band} 出口段过长`).toBeLessThanOrEqual(EXIT_SEGMENT_MAX)
          expect(line).toContain('三个合法出口')
          // 判据重述必须与**同一档同一压力下注入的读数**一致（两个面不许各说一套）
          const readout = controlLine(depth, 0, band)
          const stopText = /收尾 ([^｜]+)/.exec(readout)?.[1] ?? ''
          const evidenceText = /证据 ([^｜]+)/.exec(readout)?.[1] ?? ''
          expect(stopText).not.toBe('')
          expect(line).toContain(`完成判据：${stopText}；`)
          expect(line).toContain(`证据要求：${evidenceText}。`)
        }
      }
    }
  })

  it('不含"不许作弊 / 你被监控 / 加油"这类反例措辞（§3.5 有据）', () => {
    for (const kind of NO_PROGRESS_KINDS) {
      const line = renderExitOptions(signalOf(kind), controlOf('standard'))
      for (const banned of ['不许', '作弊', '被监控', '监控', '评测', '加油', '很好', '努力']) {
        expect(line.includes(banned), `出口段出现"${banned}"`).toBe(false)
      }
    }
  })

  it('纯函数：同参数同输出（可以安全地每轮重算）', () => {
    expect(renderExitOptions(signalOf('stalled'), controlOf('deep'))).toBe(
      renderExitOptions(signalOf('stalled'), controlOf('deep')),
    )
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
