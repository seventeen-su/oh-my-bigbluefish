// T7.2 行为测试：元演化门禁（supervisor/evolve-meta.ts + kernel/schemas/policy.ts，
// 架构 §9.5 元演化：governance.policy/evolve.policy 演化需冻结基线对照 + 人工评审；
// §14.2 哲学自身可演化：invariant changes + frozen regression corpus）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-7 + applyMetaChange 防呆守卫）：
//   ① 无冻结基线对照拒绝（核心验收）：frozenBaseline null 或 change 未附 baseline_report → 拒绝
//   ② 基线回归拒绝：应用后新基线任一任务 passed true→false → 拒绝；change.baseline_report 与
//      当前 frozenBaseline 快照 hash 不一致（基线漂移）→ 拒绝
//   ③ 无人工评审拒绝：approved 缺失/false → 拒绝（awaiting_human_review）
//   ④ 全过应用：基线对照 + 无回归 + 人工批准 → ok；applyMetaChange 原子写回 policy 文件（内容 = diff.to）
//      + 事件记录（evolution/policy-applied）
//   ⑤ 非法 target（非 governance.policy/evolve.policy）→ 拒绝
//   ⑥ diff 校验：from/to 必须过对应 policy schema（T2.1 复用：GovernorPolicySchema；evolve.policy 用
//      EvolvePolicySchema）→ 非法拒绝
//   ⑦ 幂等：同 change 重复 evaluate → 同结果
//   ⑧ applyMetaChange 防呆：未批准/基线缺失/diff 非法/文件与 diff.from 不一致 → 抛错不写
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import type { BenchLine, BenchReport, CognitiveCost } from '../../kernel/schemas/bench.js';
import { zeroCost } from '../../supervisor/bench.js';
import { EventStore } from '../../supervisor/event-store.js';
import {
  applyMetaChange,
  evaluateMetaChange,
  type MetaChange,
  type EvaluateMetaChangeDeps,
} from '../../supervisor/evolve-meta.js';

// ---- 测试工具 ----

/** 测试环境指纹（§4.4） */
const ENV: Fingerprint = { os: 'test', node: 'v24', dsh_version: '0.7.0', project: 'omb-v2' };

/** 合法 governor.yaml 内容 V1（默认规则 Stop） */
const GOV_V1 = ['rules:', '  - id: default', '    decision: Stop'].join('\n');

/** 合法 governor.yaml 内容 V2（默认规则 RunProcess——决策表合法改动） */
const GOV_V2 = ['rules:', '  - id: default', '    decision: RunProcess'].join('\n');

/** 非法 governor.yaml（applicability 枚举 Maybe → schema 拒绝） */
const GOV_BAD = [
  'rules:',
  '  - id: bad',
  '    when: { applicability: Maybe, evidence_gaps: none, budget_ok: true }',
  '    decision: Stop',
  '  - id: default',
  '    decision: Stop',
].join('\n');

/** 非法 YAML（语法错误） */
const NOT_YAML = 'rules: [unclosed';

/** 合法 evolve.yaml 内容（§9.5：Daily Evolution Budget / Learning ROI / maintenance rate） */
const EVOLVE_V1 = ['daily_evolution_cost: 100', 'roi_min: 1.0', 'maintenance_rate: 0.5'].join('\n');

/** 非法 evolve.yaml（daily_evolution_cost 负值 → 拒绝） */
const EVOLVE_BAD = ['daily_evolution_cost: -5', 'roi_min: 1.0', 'maintenance_rate: 0.5'].join('\n');

/** CognitiveCost 工厂（全零） */
function cost(): CognitiveCost {
  return zeroCost();
}

/** BenchReport 工厂：line + (task_id, passed) 列表 */
function report(line: BenchLine, tasks: Array<[string, boolean]>): BenchReport {
  return {
    line,
    results: tasks.map(([task_id, passed]) => ({ task_id, line, passed, cost: cost() })),
  };
}

/** 冻结基线（全部通过） */
const FROZEN = report('baseline', [
  ['bench:data-01', true],
  ['bench:code-01', true],
  ['bench:sys-01', true],
]);

/** 回归基线（code-01 true→false） */
const REGRESSED = report('baseline', [
  ['bench:data-01', true],
  ['bench:code-01', false],
  ['bench:sys-01', true],
]);

/** 漂移后的冻结基线（任务集/结果与 FROZEN 不同 → hash 不一致） */
const DRIFTED = report('baseline', [
  ['bench:data-01', true],
  ['bench:code-01', true],
  ['bench:sys-01', false],
]);

/** MetaChange 工厂（overrides 覆盖单字段） */
function change(over: Partial<MetaChange> = {}): MetaChange {
  return {
    id: 'MC-001',
    target: 'governance.policy',
    diff: { from: GOV_V1, to: GOV_V2 },
    proposed_by: 'tester',
    human_review: { required: true },
    ...over,
  };
}

/** 全通过 deps（frozenBaseline = FROZEN；runBaseline = FROZEN 无回归） */
const ALL_PASS_DEPS: EvaluateMetaChangeDeps = {
  frozenBaseline: async () => FROZEN,
  runBaseline: async () => FROZEN,
};

/** 无冻结基线 deps（frozenBaseline → null） */
const NO_BASELINE_DEPS: EvaluateMetaChangeDeps = {
  frozenBaseline: async () => null,
  runBaseline: async () => FROZEN,
};

// ---- applyMetaChange fixture ----

const roots: string[] = [];
const stores: EventStore[] = [];

async function tmpPolicyDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-meta-'));
  roots.push(root);
  return root;
}

async function tmpStore(): Promise<EventStore> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-meta-ev-'));
  roots.push(dir);
  const store = new EventStore(join(dir, 'events.db'));
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('① 无冻结基线对照拒绝（核心验收：元层变更默认冻结基线对照）', () => {
  it('frozenBaseline 返回 null 且 change 未附 baseline_report → 拒绝', async () => {
    const r = await evaluateMetaChange(change(), NO_BASELINE_DEPS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_frozen_baseline');
  });

  it('frozenBaseline 返回 null（即使 change 附了 baseline_report）→ 拒绝（当前无冻结基线可比对）', async () => {
    const r = await evaluateMetaChange(change({ baseline_report: FROZEN }), NO_BASELINE_DEPS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_frozen_baseline');
  });

  it('frozenBaseline 有值但 change 未附 baseline_report → 拒绝（提案缺对照基线）', async () => {
    const r = await evaluateMetaChange(change(), ALL_PASS_DEPS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_baseline_report');
  });
});

describe('② 基线回归拒绝（冻结基线对照：hash 一致性 + 无回归）', () => {
  it('应用后新基线任一任务 passed true→false → 拒绝（回归检测）', async () => {
    const deps: EvaluateMetaChangeDeps = {
      frozenBaseline: async () => FROZEN,
      runBaseline: async () => REGRESSED,
    };
    const r = await evaluateMetaChange(change({ baseline_report: FROZEN }), deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/baseline_regression/);
    expect(r.reason).toContain('bench:code-01');
  });

  it('change.baseline_report 与当前 frozenBaseline 快照 hash 不一致（冻结基线已漂移）→ 拒绝', async () => {
    const deps: EvaluateMetaChangeDeps = {
      frozenBaseline: async () => DRIFTED,
      runBaseline: async () => FROZEN,
    };
    const r = await evaluateMetaChange(change({ baseline_report: FROZEN }), deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/frozen_baseline_mismatch/);
  });
});

describe('③ 无人工评审拒绝', () => {
  it('基线 OK 但 human_review.approved 缺失 → 拒绝（awaiting_human_review）', async () => {
    const r = await evaluateMetaChange(change({ baseline_report: FROZEN }), ALL_PASS_DEPS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('awaiting_human_review');
  });

  it('approved: false → 拒绝（awaiting_human_review）', async () => {
    const r = await evaluateMetaChange(
      change({ baseline_report: FROZEN, human_review: { required: true, approved: false } }),
      ALL_PASS_DEPS,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('awaiting_human_review');
  });
});

describe('④ 全过应用：ok + applyMetaChange 写回 policy 文件 + 事件记录', () => {
  it('基线对照 + 无回归 + 人工批准 → evaluate ok', async () => {
    const r = await evaluateMetaChange(
      change({
        baseline_report: FROZEN,
        human_review: { required: true, approved: true, reviewed_by: 'human-1' },
      }),
      ALL_PASS_DEPS,
    );
    expect(r).toEqual({ ok: true, reason: 'ok' });
  });

  it('applyMetaChange 原子写回 policy 文件（内容 = diff.to）+ 记录 evolution/policy-applied 事件', async () => {
    const policyDir = await tmpPolicyDir();
    await writeFile(join(policyDir, 'governor.yaml'), GOV_V1, 'utf8'); // 当前文件 = diff.from
    const store = await tmpStore();
    const mc = change({
      baseline_report: FROZEN,
      human_review: { required: true, approved: true, reviewed_by: 'human-1' },
    });
    await applyMetaChange(mc, { policyDir, eventStore: store, environment: ENV });

    // 文件内容 = diff.to
    expect(await readFile(join(policyDir, 'governor.yaml'), 'utf8')).toBe(GOV_V2);
    // 事件记录（type=evolution/policy-applied，payload 含 change_id/target）
    const { events } = await store.query({ type: 'evolution/policy-applied' });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.change_id).toBe('MC-001');
    expect(events[0]!.payload.target).toBe('governance.policy');
    expect(events[0]!.payload.from).toBe(GOV_V1);
    expect(events[0]!.payload.to).toBe(GOV_V2);
  });

  it('evolve.policy target 全过 → applyMetaChange 创建/写回 evolve.yaml', async () => {
    const policyDir = await tmpPolicyDir();
    const store = await tmpStore();
    const mc = change({
      id: 'MC-002',
      target: 'evolve.policy',
      diff: { from: EVOLVE_V1, to: EVOLVE_V1 },
      baseline_report: FROZEN,
      human_review: { required: true, approved: true, reviewed_by: 'human-1' },
    });
    await applyMetaChange(mc, { policyDir, eventStore: store, environment: ENV });
    expect(await readFile(join(policyDir, 'evolve.yaml'), 'utf8')).toBe(EVOLVE_V1);
    const { events } = await store.query({ type: 'evolution/policy-applied' });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.target).toBe('evolve.policy');
  });
});

describe('⑤ 非法 target 拒绝', () => {
  it('target 非 governance.policy/evolve.policy → 拒绝', async () => {
    const r = await evaluateMetaChange(change({ target: 'kernel.policy' as never }), ALL_PASS_DEPS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_target/);
  });
});

describe('⑥ diff 校验（from/to 必须过对应 policy schema，T2.1 schema 复用）', () => {
  it('governance.policy：from 非法（applicability=Maybe）→ 拒绝', async () => {
    const r = await evaluateMetaChange(change({ diff: { from: GOV_BAD, to: GOV_V2 } }), ALL_PASS_DEPS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_diff/);
  });

  it('governance.policy：to 非法（非 YAML 语法）→ 拒绝', async () => {
    const r = await evaluateMetaChange(change({ diff: { from: GOV_V1, to: NOT_YAML } }), ALL_PASS_DEPS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_diff/);
  });

  it('governance.policy：from/to 均合法 → 通过 diff 关（继续走到基线门）', async () => {
    const r = await evaluateMetaChange(
      change({ diff: { from: GOV_V1, to: GOV_V2 } }),
      NO_BASELINE_DEPS,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).not.toMatch(/invalid_diff/);
  });

  it('evolve.policy：from 非法（daily_evolution_cost 负值）→ 拒绝', async () => {
    const r = await evaluateMetaChange(
      change({
        target: 'evolve.policy',
        diff: { from: EVOLVE_BAD, to: EVOLVE_V1 },
      }),
      ALL_PASS_DEPS,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_diff/);
  });

  it('evolve.policy：from/to 均合法 → 通过 diff 关', async () => {
    const r = await evaluateMetaChange(
      change({
        target: 'evolve.policy',
        diff: { from: EVOLVE_V1, to: EVOLVE_V1 },
      }),
      ALL_PASS_DEPS,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).not.toMatch(/invalid_diff/);
  });
});

describe('⑦ 幂等：同 change 重复 evaluate → 同结果', () => {
  it('同 change + 同 deps 评估两次 → 结果完全一致', async () => {
    const mc = change({
      baseline_report: FROZEN,
      human_review: { required: true, approved: true, reviewed_by: 'human-1' },
    });
    const deps: EvaluateMetaChangeDeps = {
      frozenBaseline: async () => FROZEN,
      runBaseline: async () => FROZEN,
    };
    const r1 = await evaluateMetaChange(mc, deps);
    const r2 = await evaluateMetaChange(mc, deps);
    expect(r2).toEqual(r1);
    expect(r2).toEqual({ ok: true, reason: 'ok' });
  });

  it('被拒绝的 change 重复评估 → 同拒绝结果（reason 稳定）', async () => {
    const mc = change();
    const r1 = await evaluateMetaChange(mc, NO_BASELINE_DEPS);
    const r2 = await evaluateMetaChange(mc, NO_BASELINE_DEPS);
    expect(r2).toEqual(r1);
  });
});

describe('⑧ applyMetaChange 防呆守卫（不满足校验 → 抛错不写）', () => {
  it('未获人工批准 → 抛错，不写文件', async () => {
    const policyDir = await tmpPolicyDir();
    await writeFile(join(policyDir, 'governor.yaml'), GOV_V1, 'utf8');
    const store = await tmpStore();
    await expect(
      applyMetaChange(change({ baseline_report: FROZEN }), { policyDir, eventStore: store, environment: ENV }),
    ).rejects.toThrow(/approved|评审/);
    expect(await readFile(join(policyDir, 'governor.yaml'), 'utf8')).toBe(GOV_V1);
    expect(await store.count()).toBe(0);
  });

  it('缺 baseline_report → 抛错，不写文件', async () => {
    const policyDir = await tmpPolicyDir();
    await writeFile(join(policyDir, 'governor.yaml'), GOV_V1, 'utf8');
    const store = await tmpStore();
    await expect(
      applyMetaChange(
        change({ human_review: { required: true, approved: true, reviewed_by: 'human-1' } }),
        { policyDir, eventStore: store, environment: ENV },
      ),
    ).rejects.toThrow(/baseline/);
    expect(await readFile(join(policyDir, 'governor.yaml'), 'utf8')).toBe(GOV_V1);
  });

  it('diff.to 非法 → 抛错，不写文件', async () => {
    const policyDir = await tmpPolicyDir();
    await writeFile(join(policyDir, 'governor.yaml'), GOV_V1, 'utf8');
    const store = await tmpStore();
    await expect(
      applyMetaChange(
        change({
          diff: { from: GOV_V1, to: GOV_BAD },
          baseline_report: FROZEN,
          human_review: { required: true, approved: true, reviewed_by: 'human-1' },
        }),
        { policyDir, eventStore: store, environment: ENV },
      ),
    ).rejects.toThrow(/diff/);
    expect(await readFile(join(policyDir, 'governor.yaml'), 'utf8')).toBe(GOV_V1);
  });

  it('当前 policy 文件内容与 diff.from 不一致（并发漂移）→ 抛错，不覆盖', async () => {
    const policyDir = await tmpPolicyDir();
    await writeFile(join(policyDir, 'governor.yaml'), GOV_V2, 'utf8'); // 文件已是 V2 ≠ diff.from(V1)
    const store = await tmpStore();
    await expect(
      applyMetaChange(
        change({
          baseline_report: FROZEN,
          human_review: { required: true, approved: true, reviewed_by: 'human-1' },
        }),
        { policyDir, eventStore: store, environment: ENV },
      ),
    ).rejects.toThrow(/diff\.from/);
    expect(await readFile(join(policyDir, 'governor.yaml'), 'utf8')).toBe(GOV_V2);
  });

  it('非法 target → 抛错', async () => {
    const policyDir = await tmpPolicyDir();
    const store = await tmpStore();
    await expect(
      applyMetaChange(
        change({
          target: 'kernel.policy' as never,
          baseline_report: FROZEN,
          human_review: { required: true, approved: true, reviewed_by: 'human-1' },
        }),
        { policyDir, eventStore: store, environment: ENV },
      ),
    ).rejects.toThrow(/target/);
  });
});
