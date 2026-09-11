// P1e 晋升门禁判定纯函数测试（kernel/promotion-gate.ts，架构 §6.5.3 防退化 + §7 三层信号 +
// 实现规格 §10 Activation 事务；P1e）。
// 覆盖（brief 测试清单 1）：
//   ① fitness 不降 → 通过（L1 硬门）
//   ② fitness 降 → 拒绝（reasons 含 L1 拒绝）
//   ③ 成本劣化超容忍 → 拒绝（L1 数据化阈值）
//   ④ 无 shadow 数据 → 不阻塞（记录「无 shadow 数据，以基准门禁为准」）
//   ⑤ shadow 样本不足（< min_shadow_samples）→ 不阻塞（记录）
//   ⑥ shadow 失败率超限 → 拒绝（L2 统计纳入）
//   ⑦ shadow 失败率达标 → 通过
//   ⑧ 阈值数据化：promotion_gate 缺省回退 candidate_gate.cost_degradation_tolerance（向后兼容）
//   ⑨ L3 judge 旁证占位（P4 后接入；本次仅注释——不阻塞、无副作用）
import { describe, expect, it } from 'vitest';
import { EvolvePolicySchema } from '../../kernel/schemas/policy.js';
import {
  executionEvidenceFromVerifications,
  resolvePromotionGate,
  shouldPromoteToStable,
  type PromotionGateInput,
  type PromotionGatePolicy,
} from '../../kernel/promotion-gate.js';

/** 门禁输入工厂（缺省：fitness 不降 + 成本无劣化 + 无 shadow 数据 + 显式 policy） */
function gateInput(over: Partial<PromotionGateInput> = {}): PromotionGateInput {
  return {
    baseline: { stable_commit: 'a'.repeat(40), stable_bench: { passed: 20, total: 20 } },
    candidate: { latest_commit: 'b'.repeat(40), latest_bench: { passed: 20, total: 20 } },
    cost_degradation_ratio: 0,
    shadow_signals: { n: 0, failures: 0 },
    // 缺省 policy 显式声明"不要求执行型验证"——本条测试只针对 L1 基准/成本与 L2 统计；
    // 执行型验证证据的判定见下方独立 describe（默认 fail-closed 语义在那里锚定）
    policy: {
      min_shadow_samples: 0,
      max_shadow_failure_rate: 0.1,
      cost_degradation_tolerance: 0.1,
      require_execution_verification: false,
    },
    ...over,
  };
}

describe('shouldPromoteToStable 纯函数（§6.5.3 防退化 + §7 三层信号）', () => {
  it('① fitness 不降（20/20 vs 20/20）+ 成本无劣化 → 通过', () => {
    const r = shouldPromoteToStable(gateInput());
    expect(r.ok).toBe(true);
    // L1 硬门 reason 含 fitness 对照（stable → latest commit 可追溯）
    expect(r.reasons.some((x) => /L1 硬门/.test(x) && /20\/20/.test(x) && /不降|≥|通过/.test(x))).toBe(true);
  });

  it('② fitness 降（候选 19/20 < 基线 20/20）→ 拒绝（reasons 含 L1 拒绝）', () => {
    const r = shouldPromoteToStable(
      gateInput({ candidate: { latest_commit: 'b'.repeat(40), latest_bench: { passed: 19, total: 20 } } }),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /L1 硬门/.test(x) && /拒绝/.test(x) && /19\/20/.test(x))).toBe(true);
  });

  it('③ 成本劣化超容忍（ratio 0.2 > 0.1）→ 拒绝（L1 数据化阈值）', () => {
    const r = shouldPromoteToStable(gateInput({ cost_degradation_ratio: 0.2 }));
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /成本/.test(x) && /劣化|容忍/.test(x))).toBe(true);
  });

  it('④ 无 shadow 数据 → 不阻塞（记录「无 shadow 数据，以基准门禁为准」）', () => {
    const r = shouldPromoteToStable(gateInput({ shadow_signals: { n: 0, failures: 0 } }));
    expect(r.ok).toBe(true);
    expect(r.reasons.some((x) => /无 shadow 数据|无 shadow 样本/.test(x) && /基准门禁/.test(x))).toBe(true);
  });

  it('⑤ shadow 样本不足（n=3 < min_shadow_samples=10）→ 不阻塞（记录）', () => {
    const r = shouldPromoteToStable(
      gateInput({
        shadow_signals: { n: 3, failures: 1 },
        policy: { min_shadow_samples: 10, max_shadow_failure_rate: 0.1, cost_degradation_tolerance: 0.1 },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.reasons.some((x) => /样本不足/.test(x) && /3/.test(x) && /10/.test(x))).toBe(true);
  });

  it('⑥ shadow 失败率超限（n=5、failures=2 → 0.4 > 0.1）→ 拒绝（L2 统计纳入）', () => {
    const r = shouldPromoteToStable(gateInput({ shadow_signals: { n: 5, failures: 2 } }));
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /L2/.test(x) && /失败率/.test(x) && /拒绝|超限/.test(x))).toBe(true);
  });

  it('⑦ shadow 失败率达标（n=5、failures=0）→ 通过（L2 纳入且不劣化）', () => {
    const r = shouldPromoteToStable(gateInput({ shadow_signals: { n: 5, failures: 0 } }));
    expect(r.ok).toBe(true);
    expect(r.reasons.some((x) => /L2/.test(x) && /失败率/.test(x) && !/拒绝/.test(x))).toBe(true);
  });

  it('⑧ 阈值数据化：promotion_gate 缺省 → 成本容忍回退 candidate_gate（向后兼容）；显式段 → 用显式值', () => {
    // 无 promotion_gate 的旧 evolve.policy → resolvePromotionGate 回退 candidate_gate.cost_degradation_tolerance
    const oldPolicy = EvolvePolicySchema.parse({
      daily_evolution_cost: 100,
      roi_min: 1.0,
      maintenance_rate: 0.5,
      candidate_gate: { max_candidates_per_run: 3, max_step_ratio: 0.2, cost_degradation_tolerance: 0.05 },
    });
    const resolved = resolvePromotionGate(oldPolicy);
    expect(resolved.cost_degradation_tolerance).toBe(0.05); // 回退 candidate_gate
    expect(resolved.min_shadow_samples).toBe(0);
    expect(resolved.max_shadow_failure_rate).toBe(0.1);
    // 执行型验证开关与候选门禁同源（单一开关，缺省 fail-closed）
    expect(resolved.require_execution_verification).toBe(true);

    // 显式 promotion_gate → 显式值优先
    const withGate = EvolvePolicySchema.parse({
      daily_evolution_cost: 100,
      roi_min: 1.0,
      maintenance_rate: 0.5,
      promotion_gate: { min_shadow_samples: 8, max_shadow_failure_rate: 0.2, cost_degradation_tolerance: 0.3 },
    });
    const resolved2 = resolvePromotionGate(withGate);
    expect(resolved2).toMatchObject({
      min_shadow_samples: 8,
      max_shadow_failure_rate: 0.2,
      cost_degradation_tolerance: 0.3,
    });

    // 数据化阈值生效：容忍 0.05 → ratio 0.1 拒绝；容忍 0.3 → ratio 0.1 通过
    const p1: PromotionGatePolicy = {
      min_shadow_samples: 0,
      max_shadow_failure_rate: 0.1,
      cost_degradation_tolerance: 0.05,
      require_execution_verification: false,
    };
    expect(shouldPromoteToStable(gateInput({ cost_degradation_ratio: 0.1, policy: p1 })).ok).toBe(false);
    const p2: PromotionGatePolicy = {
      min_shadow_samples: 0,
      max_shadow_failure_rate: 0.1,
      cost_degradation_tolerance: 0.3,
      require_execution_verification: false,
    };
    expect(shouldPromoteToStable(gateInput({ cost_degradation_ratio: 0.1, policy: p2 })).ok).toBe(true);
  });

  it('⑨ L3 judge 旁证占位（P4 后接入；本次仅注释——reasons 含说明，不阻塞）', () => {
    const r = shouldPromoteToStable(gateInput());
    expect(r.ok).toBe(true);
    expect(r.reasons.some((x) => /L3/.test(x) && /judge|旁证/.test(x))).toBe(true);
  });

  it('reasons 为空输入（fitness 全过 + L2 达标）也含三层信号说明——可审计', () => {
    const r = shouldPromoteToStable(gateInput({ shadow_signals: { n: 10, failures: 0 } }));
    expect(r.ok).toBe(true);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3); // L1 + L2 + L3
  });
});

/**
 * 执行型验证证据门禁（已知问题《Linux 适配不完整》派生条：候选验证"降级也当通过"）。
 * 语义锚点：
 *   - 缺省（require_execution_verification 未声明/true）时，**显式记录为降级**（没跑成）或**跑失败**
 *     的候选不得晋升；
 *   - 「无留痕」（本门禁项引入前的旧对象）不构成拒绝理由——缺证据 ≠ 证据为负；
 *   - 部署方显式 require_execution_verification=false → 降级候选可晋升，但理由里如实标注。
 */
describe('L1 执行型验证证据门禁（降级不再等于通过）', () => {
  const strictPolicy: PromotionGatePolicy = {
    min_shadow_samples: 0,
    max_shadow_failure_rate: 0.1,
    cost_degradation_tolerance: 0.1,
    require_execution_verification: true,
  };

  it('degraded（通道不可用、候选没跑过）+ 要求执行验证 → 拒绝，理由点明"未真实发生"', () => {
    const r = shouldPromoteToStable(
      gateInput({
        policy: strictPolicy,
        verify_evidence: { kind: 'degraded', detail: '候选留痕 G3-exec:degraded(no-channel)' },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /执行型验证未真实发生/.test(x) && /拒绝晋升/.test(x))).toBe(true);
  });

  it('rejected（跑了但失败）+ 要求执行验证 → 拒绝', () => {
    const r = shouldPromoteToStable(
      gateInput({ policy: strictPolicy, verify_evidence: { kind: 'rejected', detail: '候选留痕 G3-exec:rejected' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /执行型验证未通过/.test(x) && /拒绝晋升/.test(x))).toBe(true);
  });

  it('verified（真实跑过并通过）+ 要求执行验证 → 通过', () => {
    const r = shouldPromoteToStable(
      gateInput({
        policy: strictPolicy,
        verify_evidence: { kind: 'verified', detail: '候选留痕 G3-exec:strict(win32-restricted-token)' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.reasons.some((x) => /执行型验证证据 verified/.test(x) && /通过/.test(x))).toBe(true);
  });

  it('无留痕（旧对象）+ 要求执行验证 → 不阻塞（缺证据 ≠ 证据为负，防既有信任链级联停摆）', () => {
    const r = shouldPromoteToStable(gateInput({ policy: strictPolicy }));
    expect(r.ok).toBe(true);
    expect(r.reasons.some((x) => /执行型验证证据 unknown/.test(x) && /无留痕不阻塞/.test(x))).toBe(true);
  });

  it('部署方显式接受降级（require=false）→ degraded 不阻塞，但理由如实标注"未真实执行"', () => {
    const r = shouldPromoteToStable(
      gateInput({
        policy: { ...strictPolicy, require_execution_verification: false },
        verify_evidence: { kind: 'degraded', detail: '候选留痕 G3-exec:degraded(no-channel)' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.reasons.some((x) => /未真实执行/.test(x) && /显式接受/.test(x))).toBe(true);
  });

  it('候选 gates_passed 留痕 → 证据解析（strict/na → verified；degraded/rejected → 对应负项；无条目 → undefined）', () => {
    expect(executionEvidenceFromVerifications(['G1', 'G3', 'G3-exec:strict(posix-bwrap)'])?.kind).toBe('verified');
    expect(executionEvidenceFromVerifications(['G1', 'G3', 'G3-exec:na(no-script)'])?.kind).toBe('verified');
    expect(executionEvidenceFromVerifications(['G1', 'G3', 'G3-exec:degraded(no-channel)'])?.kind).toBe('degraded');
    expect(executionEvidenceFromVerifications(['G1', 'G3', 'G3-exec:rejected'])?.kind).toBe('rejected');
    expect(executionEvidenceFromVerifications(['G1', 'G3'])).toBeUndefined();
    expect(executionEvidenceFromVerifications(undefined)).toBeUndefined();
  });
});
