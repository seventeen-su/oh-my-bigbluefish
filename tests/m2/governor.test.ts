// T2.2 行为测试：Cognitive Governor 决策核心（架构 §5.1）。
// 八类：① task_done 输入位（主会话裁决 2026-08-21） ② 决策表（真实 T2.1 表）
//       ③ 决策带全字段 ④ 决策表驱动（改 fixture 表 → 输出变，无代码改动）
//       ⑤ 同输入同输出（确定性） ⑥ allocate 六维约束 ⑦ utilityEstimate 单调性。
// fixture：真实 kernel/policy（loadPolicy，不动真实目录）+ mkdtemp 覆盖版 governor.yaml。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, type PolicyBundle } from '../../kernel/policy-loader.js';
import {
  allocate,
  decide,
  utilityEstimate,
  type BudgetAllocation,
  type GovernorInput,
} from '../../runtime/governor.js';

const POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const BUDGET_DIMS = ['depth', 'breadth', 'tools', 'retrieval', 'branches', 'context'] as const;

let policy: PolicyBundle;
beforeAll(async () => {
  policy = await loadPolicy(POLICY_DIR);
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** 复制真实 policy 目录到临时 fixture；overrides: 文件名 → 覆盖内容 */
async function policyFixture(overrides: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-governor-'));
  roots.push(root);
  await cp(POLICY_DIR, join(root, 'policy'), { recursive: true });
  for (const [file, content] of Object.entries(overrides)) {
    await writeFile(join(root, 'policy', file), content, 'utf8');
  }
  return join(root, 'policy');
}

/** 完整 GovernorInput 工厂（每用例显式覆盖；task_done 缺省 false，主会话裁决） */
function baseInput(overrides: Partial<GovernorInput> = {}): GovernorInput {
  return {
    task_contract: { goal: '验证 Cognitive Governor 决策', success_criteria: ['决策正确', '确定性'] },
    state_snapshot: { snapshot_hash: 'sha256:test-snapshot' },
    environment: 'test',
    candidate_processes: ['retrieve-verify'],
    applicability_results: [{ process_id: 'retrieve-verify', applicability: 'Strong' }],
    budget: {
      envelope: policy.budget,
      remaining: { depth: 8, breadth: 4, tools: 12, retrieval: 6, branches: 8, context: 16000 },
    },
    risk: 0.1,
    progress_vector: {
      constraint_reduction: 0.5,
      hypothesis_reduction: 0.5,
      hypothesis_discrimination: 0.5,
      evidence_strengthening: 0.5,
      goal_completion: 0.5,
      reproducibility: 0.5,
      uncertainty_reduction: 0.5,
    },
    uncertainty_vector: { goal: 0.2, method: 0.3 },
    maintenance_state: { debt: 0 },
    evidence_sufficiency: { covered_success_conditions: ['决策正确'], critical_gaps: [], score: 1 },
    task_done: false,
    ...overrides,
  };
}

/** 六维和（测试侧断言辅助） */
function sum6(a: BudgetAllocation): number {
  return BUDGET_DIMS.reduce((s, d) => s + a[d], 0);
}

describe('① task_done 输入位（主会话裁决 2026-08-21：true → Stop）', () => {
  it('任务完成 + 缺口空 → Stop，reason 含"任务完成"与"证据充分"', () => {
    const d = decide(baseInput({ task_done: true }), policy.governor);
    expect(d.decision).toBe('Stop');
    expect(d.reason).toMatch(/任务完成/);
    expect(d.reason).toMatch(/证据充分/);
  });

  it('任务完成 + 缺口非空 → 仍 Stop（完成语义优先于缺口验证，无条件下达 Stop）', () => {
    const d = decide(
      baseInput({
        task_done: true,
        evidence_sufficiency: {
          covered_success_conditions: ['决策正确'],
          critical_gaps: ['缺口-1'],
          score: 0.5,
        },
      }),
      policy.governor,
    );
    expect(d.decision).toBe('Stop');
  });
});

describe('② 决策表（task_done=false，真实 T2.1 决策表）', () => {
  it('Strong + 缺口空 + 预算足 → RunProcess', () => {
    const d = decide(baseInput(), policy.governor);
    expect(d.decision).toBe('RunProcess');
  });

  it('Strong + 缺口非空 → Verify（最小充分验证优先，非阈值）', () => {
    const d = decide(
      baseInput({
        evidence_sufficiency: {
          covered_success_conditions: ['决策正确'],
          critical_gaps: ['缺口-1'],
          score: 0.5,
        },
      }),
      policy.governor,
    );
    expect(d.decision).toBe('Verify');
  });

  it('applicability=OOD → GenerateProcess（陌生才生成，§5.3 阶梯最后手段）', () => {
    const d = decide(
      baseInput({ applicability_results: [{ process_id: 'retrieve-verify', applicability: 'OOD' }] }),
      policy.governor,
    );
    expect(d.decision).toBe('GenerateProcess');
  });

  it('applicability=Failed → ExpandSearch（候选失败优先于缺口验证）', () => {
    const d = decide(
      baseInput({ applicability_results: [{ process_id: 'retrieve-verify', applicability: 'Failed' }] }),
      policy.governor,
    );
    expect(d.decision).toBe('ExpandSearch');
  });

  it('applicability=Contradictory → RetrieveMemory（§5.2 矛盾 → 检索记忆补充上下文）', () => {
    const d = decide(
      baseInput({
        applicability_results: [{ process_id: 'retrieve-verify', applicability: 'Contradictory' }],
      }),
      policy.governor,
    );
    expect(d.decision).toBe('RetrieveMemory');
  });

  it('预算不足（remaining.depth=0）→ Delegate（降级/慢路径，Fast path 无法廉价决策）', () => {
    const d = decide(
      baseInput({
        budget: {
          envelope: policy.budget,
          remaining: { depth: 0, breadth: 4, tools: 12, retrieval: 6, branches: 8, context: 16000 },
        },
      }),
      policy.governor,
    );
    expect(d.decision).toBe('Delegate');
  });

  it('无候选（applicability_results 空）→ default 规则 → Stop（保守停止，不执行未授权动作）', () => {
    const d = decide(baseInput({ applicability_results: [] }), policy.governor);
    expect(d.decision).toBe('Stop');
    expect(d.reason).toMatch(/default/);
  });

  it('Partial + 缺口空 → Stop（架构：候选已现且缺口空 → Stop）', () => {
    const d = decide(
      baseInput({ applicability_results: [{ process_id: 'retrieve-verify', applicability: 'Partial' }] }),
      policy.governor,
    );
    expect(d.decision).toBe('Stop');
  });
});

describe('③ 决策带全字段（reason/budget_allocation/expected_gain/snapshot）', () => {
  it('decide 返回结构与输入快照绑定', () => {
    const input = baseInput({
      evidence_sufficiency: {
        covered_success_conditions: ['决策正确'],
        critical_gaps: ['缺口-1'],
        score: 0.5,
      },
    });
    const d = decide(input, policy.governor);
    expect(d.reason.length).toBeGreaterThan(0);
    expect(d.budget_allocation).toMatchObject({
      depth: expect.any(Number),
      breadth: expect.any(Number),
      tools: expect.any(Number),
      retrieval: expect.any(Number),
      branches: expect.any(Number),
      context: expect.any(Number),
    });
    expect(Number.isFinite(d.expected_gain)).toBe(true);
    expect(d.snapshot).toBe(input.state_snapshot.snapshot_hash);
  });
});

describe('④ 决策表驱动（机制即数据：改 fixture 表 → 输出变，无代码改动）', () => {
  it('覆盖版 governor.yaml（OOD → ExpandSearch）→ decide 输出随之改变', async () => {
    const dir = await policyFixture({
      'governor.yaml': [
        'rules:',
        '  - id: ood-none-ok',
        '    when: { applicability: OOD, evidence_gaps: none, budget_ok: true }',
        '    decision: ExpandSearch',
        '  - id: ood-some-ok',
        '    when: { applicability: OOD, evidence_gaps: some, budget_ok: true }',
        '    decision: ExpandSearch',
        '  - id: default',
        '    decision: Stop',
      ].join('\n'),
    });
    const modified = await loadPolicy(dir);
    const input = baseInput({
      applicability_results: [{ process_id: 'retrieve-verify', applicability: 'OOD' }],
    });
    // 同一输入：真实表 → GenerateProcess；覆盖表 → ExpandSearch（行为完全由数据驱动）
    expect(decide(input, policy.governor).decision).toBe('GenerateProcess');
    expect(decide(input, modified.governor).decision).toBe('ExpandSearch');
  });
});

describe('⑤ 同输入同输出（确定性：无随机、无时间依赖）', () => {
  it('同一矩阵跑 3 次 → 相同 decision/reason/budget_allocation/expected_gain/snapshot', () => {
    const input = baseInput({
      evidence_sufficiency: {
        covered_success_conditions: ['决策正确'],
        critical_gaps: ['缺口-1'],
        score: 0.5,
      },
    });
    const a = decide(input, policy.governor);
    const b = decide(input, policy.governor);
    const c = decide(input, policy.governor);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // budget_allocation 逐维钉死
    expect(a.budget_allocation).toEqual(b.budget_allocation);
  });

  it('allocate 同输入两次 → 相同分配', () => {
    const input = baseInput();
    expect(allocate(policy.budget, input)).toEqual(allocate(policy.budget, input));
  });
});

describe('⑥ allocate 六维分配（纯函数约束）', () => {
  it('六维全非负；每维 ≤ policy 上限；总和 ≤ 预算；context 维 ≤ context_budget_tokens', () => {
    const allocation = allocate(policy.budget, baseInput());
    for (const d of BUDGET_DIMS) {
      expect(allocation[d]).toBeGreaterThanOrEqual(0);
      expect(allocation[d]).toBeLessThanOrEqual(policy.budget[d]);
    }
    expect(sum6(allocation)).toBeLessThanOrEqual(
      BUDGET_DIMS.reduce((s, d) => s + policy.budget[d], 0),
    );
    expect(allocation.context).toBeLessThanOrEqual(policy.budget.context_budget_tokens);
  });

  it('受剩余预算约束：remaining.context=100 → context 分配 ≤ 100', () => {
    const allocation = allocate(
      policy.budget,
      baseInput({
        budget: {
          envelope: policy.budget,
          remaining: { depth: 8, breadth: 4, tools: 12, retrieval: 6, branches: 8, context: 100 },
        },
      }),
    );
    expect(allocation.context).toBeLessThanOrEqual(100);
    expect(allocation.depth).toBeLessThanOrEqual(8);
  });
});

describe('⑦ utilityEstimate 单调性（Reasoning Utility 初值：加权和/成本）', () => {
  it('progress 全维 +0.1（成本不变）→ 值升', () => {
    const p = baseInput().progress_vector;
    const raised: typeof p = {} as typeof p;
    for (const k of Object.keys(p) as Array<keyof typeof p>) {
      raised[k] = p[k] + 0.1;
    }
    expect(utilityEstimate(raised, 100)).toBeGreaterThan(utilityEstimate(p, 100));
  });

  it('成本下降（progress 不变）→ 值升', () => {
    const p = baseInput().progress_vector;
    expect(utilityEstimate(p, 50)).toBeGreaterThan(utilityEstimate(p, 100));
  });

  it('相同输入 → 相同值（确定性）', () => {
    const p = baseInput().progress_vector;
    expect(utilityEstimate(p, 100)).toBe(utilityEstimate(p, 100));
  });
});
