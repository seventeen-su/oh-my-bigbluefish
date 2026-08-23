// P1d 候选生成器测试（kernel/candidate-generator.ts，架构 §6.5.2 候选生成 / §6.5.3 验证链 G1 数据候选）。
// 首个候选源 = 信号驱动的策略参数微调确定性生成器（无需 LLM）：
//   ① 确定性：同信号摘要同策略 → 同候选集（id/内容/顺序完全一致）
//   ② 上限约束：候选数 ≤ evolve.policy.candidate_gate.max_candidates_per_run（数据化）
//   ③ 信号→候选映射：corrections/oracle_fail/untrusted_object → evolve.yaml trigger strength 上调；
//      scope_miss → context.yaml 重获取成本上调；步长受 max_step_ratio 约束（防激进）
//   ④ id 内容寻址：同内容 → 同 id（幂等键 candidate_id；与其它候选并存不影响）
//   ⑤ 空信号 → 空候选集；无映射信号 → 空候选集
//   ⑥ content 为完整 YAML（js-yaml 可解析，改动可读回）
import { describe, expect, it } from 'vitest';
import { load as parseYaml } from 'js-yaml';
import {
  generatePolicyAdjustmentCandidates,
  POLICY_ADJUSTMENT_RULES,
} from '../../kernel/candidate-generator.js';
import { loadPolicy } from '../../kernel/policy-loader.js';
import type { SignalSummary, CandidateDraft } from '../../kernel/schemas/evolution.js';

/** 信号摘要构造（零窗口；counts 按需） */
function summary(counts: Record<string, number>): SignalSummary {
  return { window: { from: 0, to: 0 }, counts };
}

describe('① 确定性（同信号摘要同策略 → 同候选集）', () => {
  it('两次生成 → 候选 id/内容/顺序完全一致', async () => {
    const policy = await loadPolicy();
    const signals = summary({ corrections: 3, scope_miss: 2, tool_calls: 5 });
    const a = generatePolicyAdjustmentCandidates(signals, policy);
    const b = generatePolicyAdjustmentCandidates(signals, policy);
    expect(a.map((d) => d.id)).toEqual(b.map((d) => d.id));
    expect(a.map((d) => d.content)).toEqual(b.map((d) => d.content));
    expect(a.map((d) => d.change)).toEqual(b.map((d) => d.change));
    // 对象身份不同（新生成，非复用）
    expect(a).not.toBe(b);
  });

  it('信号顺序无关：counts 键序不同 → 同候选集（内部字典序迭代）', async () => {
    const policy = await loadPolicy();
    const s1 = summary({ corrections: 1, scope_miss: 1 });
    const s2 = summary({ scope_miss: 1, corrections: 1 });
    expect(generatePolicyAdjustmentCandidates(s1, policy)).toEqual(
      generatePolicyAdjustmentCandidates(s2, policy),
    );
  });
});

describe('② 上限约束（max_candidates_per_run 数据化）', () => {
  it('全部规则触发 → 候选数 ≤ 策略上限（默认 3）', async () => {
    const policy = await loadPolicy();
    const k = policy.evolve.candidate_gate.max_candidates_per_run;
    expect(k).toBeGreaterThanOrEqual(1);
    const drafts = generatePolicyAdjustmentCandidates(
      summary({ corrections: 5, oracle_fail: 5, scope_miss: 5, untrusted_object: 5 }),
      policy,
    );
    expect(drafts.length).toBeLessThanOrEqual(k);
    expect(drafts.length).toBeGreaterThan(0);
  });

  it('自定义上限策略 → 按上限截断（取排序后前 K 个）', async () => {
    const policy = await loadPolicy();
    const small = {
      ...policy,
      evolve: { ...policy.evolve, candidate_gate: { ...policy.evolve.candidate_gate, max_candidates_per_run: 2 } },
    };
    const drafts = generatePolicyAdjustmentCandidates(
      summary({ corrections: 1, oracle_fail: 1, scope_miss: 1, untrusted_object: 1 }),
      small,
    );
    expect(drafts.length).toBe(2);
  });
});

describe('③ 信号→候选映射（corrections 高频 → evolve.yaml strength 上调）', () => {
  it('corrections×3 → signal_triggers.corrections.strength 0.9→1.0（步长 0.05×3 上限 1，防激进）', async () => {
    const policy = await loadPolicy();
    const drafts = generatePolicyAdjustmentCandidates(summary({ corrections: 3 }), policy);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.signal).toBe('corrections');
    expect(d.target).toBe('kernel/policy/evolve.yaml');
    expect(d.kind).toBe('policy');
    expect(d.change.path).toBe('signal_triggers.corrections.strength');
    expect(d.change.old).toBeCloseTo(0.9, 5);
    expect(d.change.new).toBeCloseTo(1.0, 5);
    expect(d.motivation).toContain('corrections');
    // content = 完整 YAML，可解析且含新值
    const parsed = parseYaml(d.content) as { signal_triggers: Record<string, { strength: number }> };
    expect(parsed.signal_triggers['corrections']!.strength).toBeCloseTo(1.0, 5);
    // 其余 trigger strength 未被改动（最小 diff 语义）
    expect(parsed.signal_triggers['scope_miss']!.strength).toBeCloseTo(0.5, 5);
  });

  it('corrections×1 → strength 0.9→0.95（步长 = min(0.05×count, max_step_ratio)）', async () => {
    const policy = await loadPolicy();
    const d = generatePolicyAdjustmentCandidates(summary({ corrections: 1 }), policy)[0]!;
    expect(d.change.new).toBeCloseTo(0.95, 5);
  });

  it('oracle_fail ×2 → oracle_fail.strength 0.8→0.9', async () => {
    const policy = await loadPolicy();
    const d = generatePolicyAdjustmentCandidates(summary({ oracle_fail: 2 }), policy)[0]!;
    expect(d.signal).toBe('oracle_fail');
    expect(d.change.path).toBe('signal_triggers.oracle_fail.strength');
    expect(d.change.old).toBeCloseTo(0.8, 5);
    expect(d.change.new).toBeCloseTo(0.9, 5);
  });

  it('scope_miss 高频 → context.yaml kind_costs.reacquisition.retrieval 相对步长上调（40→46）', async () => {
    const policy = await loadPolicy();
    const d = generatePolicyAdjustmentCandidates(summary({ scope_miss: 3 }), policy)[0]!;
    expect(d.target).toBe('kernel/policy/context.yaml');
    expect(d.change.path).toBe('kind_costs.reacquisition.retrieval');
    expect(d.change.old).toBeCloseTo(40, 5);
    expect(d.change.new).toBeCloseTo(46, 5);
    const parsed = parseYaml(d.content) as { kind_costs: { reacquisition: { retrieval: number } } };
    expect(parsed.kind_costs.reacquisition.retrieval).toBeCloseTo(46, 5);
  });

  it('untrusted_object 高频 → evolve.yaml untrusted_object.strength 上调', async () => {
    const policy = await loadPolicy();
    const d = generatePolicyAdjustmentCandidates(summary({ untrusted_object: 4 }), policy)[0]!;
    expect(d.change.path).toBe('signal_triggers.untrusted_object.strength');
    expect(d.change.new).toBeGreaterThan(d.change.old);
  });

  it('规则表非空且每条规则有 signal/路径/步长（数据自洽）', () => {
    expect(POLICY_ADJUSTMENT_RULES.length).toBeGreaterThan(0);
    for (const r of POLICY_ADJUSTMENT_RULES) {
      expect(r.signal.length).toBeGreaterThan(0);
      expect(r.path).toContain('.');
      expect(r.baseStep).toBeGreaterThan(0);
      expect(r.minCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('④ id 内容寻址（幂等键 candidate_id）', () => {
  it('同内容（同 target+content）→ 同 id，与信号集并存无关', async () => {
    const policy = await loadPolicy();
    const solo = generatePolicyAdjustmentCandidates(summary({ corrections: 1 }), policy);
    const mixed = generatePolicyAdjustmentCandidates(summary({ corrections: 1, scope_miss: 3 }), policy);
    const soloCorr = solo.find((d) => d.signal === 'corrections')!;
    const mixedCorr = mixed.find((d) => d.signal === 'corrections')!;
    expect(soloCorr.id).toBe(mixedCorr.id);
    expect(soloCorr.content).toBe(mixedCorr.content);
  });

  it('id 为 sha256 前缀格式（内容寻址；同前缀防碰撞追加序号不破坏主键确定性）', async () => {
    const policy = await loadPolicy();
    for (const d of generatePolicyAdjustmentCandidates(summary({ corrections: 1, scope_miss: 1 }), policy)) {
      expect(d.id).toMatch(/^sha256:[0-9a-f]{12}(-\d+)?$/);
    }
  });

  it('不同内容 → 不同 id', async () => {
    const policy = await loadPolicy();
    const c1 = generatePolicyAdjustmentCandidates(summary({ corrections: 1 }), policy)[0]!;
    const c2 = generatePolicyAdjustmentCandidates(summary({ corrections: 2 }), policy)[0]!;
    expect(c1.change.new).not.toBe(c2.change.new);
    expect(c1.id).not.toBe(c2.id);
  });
});

describe('⑤ 空/无映射信号 → 空候选集', () => {
  it('零信号 → []', async () => {
    const policy = await loadPolicy();
    expect(generatePolicyAdjustmentCandidates(summary({}), policy)).toEqual([]);
  });

  it('仅无映射信号（tool_calls 等正向信号）→ []', async () => {
    const policy = await loadPolicy();
    expect(generatePolicyAdjustmentCandidates(summary({ tool_calls: 9, hits: 9 }), policy)).toEqual([]);
  });

  it('信号计数为 0 → 不产出候选', async () => {
    const policy = await loadPolicy();
    expect(generatePolicyAdjustmentCandidates(summary({ corrections: 0 }), policy)).toEqual([]);
  });
});

describe('⑥ 候选集排序与顺序确定性', () => {
  it('多候选按 id 升序（确定性顺序，与信号遍历无关）', async () => {
    const policy = await loadPolicy();
    const drafts = generatePolicyAdjustmentCandidates(
      summary({ corrections: 1, oracle_fail: 1, scope_miss: 1, untrusted_object: 1 }),
      policy,
    );
    const ids = drafts.map((d) => d.id);
    expect([...ids].sort()).toEqual(ids);
    // seq 为 0..n-1
    drafts.forEach((d: CandidateDraft, i: number) => expect(d.seq).toBe(i));
  });
});
