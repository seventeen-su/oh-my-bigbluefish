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
    policy: { min_shadow_samples: 0, max_shadow_failure_rate: 0.1, cost_degradation_tolerance: 0.1 },
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

    // 显式 promotion_gate → 显式值优先
    const withGate = EvolvePolicySchema.parse({
      daily_evolution_cost: 100,
      roi_min: 1.0,
      maintenance_rate: 0.5,
      promotion_gate: { min_shadow_samples: 8, max_shadow_failure_rate: 0.2, cost_degradation_tolerance: 0.3 },
    });
    const resolved2 = resolvePromotionGate(withGate);
    expect(resolved2).toEqual({ min_shadow_samples: 8, max_shadow_failure_rate: 0.2, cost_degradation_tolerance: 0.3 });

    // 数据化阈值生效：容忍 0.05 → ratio 0.1 拒绝；容忍 0.3 → ratio 0.1 通过
    const p1: PromotionGatePolicy = { min_shadow_samples: 0, max_shadow_failure_rate: 0.1, cost_degradation_tolerance: 0.05 };
    expect(shouldPromoteToStable(gateInput({ cost_degradation_ratio: 0.1, policy: p1 })).ok).toBe(false);
    const p2: PromotionGatePolicy = { min_shadow_samples: 0, max_shadow_failure_rate: 0.1, cost_degradation_tolerance: 0.3 };
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
