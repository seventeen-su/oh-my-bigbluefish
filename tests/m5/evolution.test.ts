// T5.5 行为测试：演化晋升闭环（runtime/evolution-evaluator.ts + supervisor/activation.ts，
// 架构 §9.4 晋升与回滚 / §10.1 能力向量 / §4.2 M4 EvolutionObject + M6 ActivationContract /
// §11.3 Evolution 事务=git 事务（candidate_id 幂等）、Activation=Recovery Root 原子切换（activation_id 幂等））。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-7）：
//   ① e2e 全自动闭环：信号 → evaluate → classify stable → activate（真实 evaluator + fake switch/write）
//   ② 能力向量各维独立：correctness 优 + cost 差互不污染；缺信号维 value null
//   ③ 分类正确：7 种信号模式 → 7 分类匹配（含 regressed 拒晋升：activate 拒绝且 switch 未被调）
//   ④ 污染回滚：谱系含 untrusted → activate 拒绝；已激活 → rollback 调 switchStableHead(predecessor)
//   ⑤ 幂等：同 activation_id 重复 activate → no-op（switch/write 只调一次）
//   ⑥ 快照语义：activate 后 promote → 新请求新快照、旧请求旧快照（T1.6 registry 复用）
//   ⑦ rollback_snapshot：= 切换前快照（可回退）；predecessor = 切换前 stable_head
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ActivationContractSchema,
  EvolutionObjectSchema,
  type EvolutionObject,
  type RuntimeSnapshot,
} from '../../kernel/schemas/m.js';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import type { CapabilityVector, DimensionFact, EvaluationSignal } from '../../runtime/evaluator.js';
import { classify, evaluate, getFact } from '../../runtime/evolution-evaluator.js';
import {
  activate,
  resetActivationLog,
  rollback,
  type ActivationDeps,
} from '../../supervisor/activation.js';
import { CandidatePool, type CandidateRecord } from '../../supervisor/candidates.js';
import {
  SnapshotRegistry,
  createSnapshot,
  type ComponentHashes,
} from '../../supervisor/versioning.js';

// ---- 测试工具 ----

/** 测试环境指纹（§4.4） */
const ENV: Fingerprint = { os: 'test', node: 'v24', dsh_version: '0.5.0', project: 'omb-v2' };

/** fake switchStableHead 的"切换前 stable_head"（Recovery Root 语义，T0.4） */
const STABLE_HEAD = 'stable-head-0001';

/** e2e 候选 id（sha256:<64hex>，与 M5 Evolution Object id 同风格） */
const CAND = `sha256:${'c'.repeat(64)}`;

/** 组件 sha256 清单（全部 64-hex；versioning.createSnapshot 的六键校验要求） */
const COMPONENTS: ComponentHashes = {
  scheduler: 'a'.repeat(64),
  memory: 'b'.repeat(64),
  verifier: 'c'.repeat(64),
  renderer: 'd'.repeat(64),
  capability: 'e'.repeat(64),
  philosophy: 'f'.repeat(64),
};

/** RuntimeSnapshot 工厂（不同 gitRevision → 不同 id） */
function mkSnapshot(gitRevision: string): RuntimeSnapshot {
  return createSnapshot({ components: COMPONENTS, gitRevision });
}

let seq = 0;
/** 确定性候选 id（sha256:<64hex>） */
function nextId(): string {
  return `sha256:${String(seq++).padStart(64, '0')}`;
}

/** CandidateRecord 工厂（缺省：process / untrusted / 无父 / G1+G2 已过） */
function mkRec(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: nextId(),
    kind: 'process',
    status: 'untrusted',
    parent: null,
    lineage: [],
    gates_passed: ['G1', 'G2'],
    created: Date.now(),
    provenance: 'test/fixture',
    ...over,
  };
}

/** DimensionFact 工厂（缺省：L2 统计源、样本 30 ≥ MIN_SAMPLES） */
function fact(dim: DimensionFact['dimension'], value: number | null, over: Partial<DimensionFact> = {}): DimensionFact {
  return {
    dimension: dim,
    value,
    signal_sources: ['L2_statistical'],
    evidence_refs: [],
    sample_size: 30,
    ...over,
  };
}

/** CapabilityVector 工厂（classification 占位；classify 只读 facts） */
function mkVector(facts: DimensionFact[], over: Partial<CapabilityVector> = {}): CapabilityVector {
  return {
    id: 'vector:00000000-0000-4000-8000-000000000001',
    target: 'sha256:t',
    facts,
    classification: 'Unknown',
    classification_confidence: 0,
    environment: ENV,
    created: 0,
    provenance: { source: 'test', events: [] },
    ...over,
  };
}

/** deps 工厂：记录 switch/write 调用；evaluate 缺省返回达标向量（classify → Stable） */
function mkDeps(
  registry: SnapshotRegistry,
  nextSnap: RuntimeSnapshot,
  over: Partial<ActivationDeps> = {},
): { deps: ActivationDeps; switched: string[]; written: EvolutionObject[] } {
  const switched: string[] = [];
  const written: EvolutionObject[] = [];
  const deps: ActivationDeps = {
    switchStableHead: async (h: string) => {
      switched.push(h);
      return { previous: STABLE_HEAD, new: h };
    },
    writeEvolutionObject: async (o: EvolutionObject) => {
      written.push(o);
    },
    snapshotRegistry: registry,
    nextSnapshot: () => nextSnap,
    evaluate: () => mkVector([fact('correctness', 0.9)]),
    classify,
    checkLineage: () => ({ ok: true }),
    ...over,
  };
  return { deps, switched, written };
}

/** 注册并晋升一个根候选（parent=null），返回 trusted 记录 */
async function mkTrusted(pool: CandidatePool, over: Partial<CandidateRecord> = {}): Promise<CandidateRecord> {
  const r = mkRec(over);
  await pool.registerCandidate(r);
  await pool.promote(mkRec({ id: r.id }));
  return pool.load(r.id);
}

/** 达标基线（correctness 0.9，样本 30 ≥ MIN_SAMPLES） */
const OK_BASELINE = mkVector([fact('correctness', 0.9)]);

// ---- 测试主体 ----

describe('演化晋升闭环（§9.4 / §10.1 / §4.2 M4+M6 / §11.3）', () => {
  let evo: string; // 临时 .evolution 根
  let initial: RuntimeSnapshot;
  let nextSnap: RuntimeSnapshot;
  let registry: SnapshotRegistry;

  beforeEach(async () => {
    resetActivationLog();
    seq = 0;
    const base = await mkdtemp(join(tmpdir(), 'omb-evolution-'));
    evo = join(base, '.evolution');
    await mkdir(evo, { recursive: true });
    initial = mkSnapshot('rev-initial');
    nextSnap = mkSnapshot('rev-activated');
    registry = new SnapshotRegistry(initial);
  });

  afterEach(async () => {
    await rm(dirname(evo), { recursive: true, force: true });
  });

  it('① e2e 全自动闭环：信号 → evaluate → classify stable → activate（契约完整 + switch/evo 落库 + 快照晋升）', async () => {
    const pool = new CandidatePool(evo);
    const cand = await mkTrusted(pool, { id: CAND, kind: 'code' });

    // 信号序列：L1 成功率高 + L2 分数（brief：e2e 造信号 → evaluate → classify stable）
    const signals: EvaluationSignal[] = [
      { layer: 'L1', kind: 'tool_success', target: CAND, count: 98, window: { from: 0, to: 1000 } },
      { layer: 'L1', kind: 'tool_failure', target: CAND, count: 2, window: { from: 0, to: 1000 } },
      { layer: 'L2', kind: 'bench_score', target: CAND, value: 0.95, sample_size: 30, bench_ref: 'bench/frozen-001' },
    ];
    const baseline = mkVector([fact('correctness', 0.95)]);

    const { deps, switched, written } = mkDeps(registry, nextSnap, {
      evaluate: (t) => evaluate(signals, t, { environment: ENV }),
      checkLineage: (r) => pool.checkLineage(r),
    });

    const contract = await activate({
      activation_id: 'e2e-1',
      candidate: cand,
      evidence_certificate: 'cert/e2e-1',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline,
      diff: 'diff --git a/x b/x\n+improved',
      deps,
    });

    // ActivationContract 结构完整（M6 schema 校验）
    expect(ActivationContractSchema.safeParse(contract).success).toBe(true);
    expect(contract.predecessor).toBe(STABLE_HEAD); // 切换前 stable_head
    expect(contract.candidate).toBe(CAND);
    expect(contract.evidence_certificate).toBe('cert/e2e-1');
    expect(contract.compatible_schema).toBe('omb/2.0');
    expect(contract.activation_scope).toBe('Project');
    expect(contract.rollback_snapshot).toBe(initial.id); // 切换前快照
    expect(contract.required_capabilities).toContain('code');

    // 原子切换被调（candidate_hash）
    expect(switched).toEqual([CAND]);

    // EvolutionObject 落 git（结构校验：id=sha256/protocol_version/parent/diff/compat/bench/provenance/spdx/verifications）
    expect(written).toHaveLength(1);
    const evoObj = written[0]!;
    expect(EvolutionObjectSchema.safeParse(evoObj).success).toBe(true);
    expect(evoObj.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evoObj.protocol_version.length).toBeGreaterThan(0);
    expect(evoObj.parent).toBeNull();
    expect(evoObj.diff).toContain('improved');
    expect(evoObj.compat).toBe('omb/2.0');
    expect(evoObj.bench.length).toBeGreaterThan(0);
    expect(evoObj.provenance.source).toBe('supervisor/activation');
    expect(evoObj.spdx.length).toBeGreaterThan(0);
    expect(evoObj.verifications).toContain('cert/e2e-1');

    // 快照晋升：当前快照已切换（新请求用新快照）
    expect(registry.currentSnapshot).toBe(nextSnap);
  });

  it('② 能力向量各维独立：correctness 优 + cost 差互不污染；缺信号维 value null', () => {
    const T = `sha256:${'t'.repeat(64)}`;
    const signals: EvaluationSignal[] = [
      { layer: 'L1', kind: 'tool_success', target: T, count: 98, window: { from: 0, to: 1000 } },
      { layer: 'L1', kind: 'tool_failure', target: T, count: 2, window: { from: 0, to: 1000 } },
      { layer: 'L2', kind: 'token_cost', target: T, value: 5000, sample_size: 10, bench_ref: 'bench/cost-001' },
    ];
    const v = evaluate(signals, T, { environment: ENV });

    // correctness 事实（L1 成功率）：不受 cost 信号污染
    const correctness = getFact(v, 'correctness');
    expect(correctness?.value).toBeCloseTo(0.98);
    expect(correctness?.sample_size).toBe(100);
    expect(correctness?.signal_sources).toContain('L1_mechanical');

    // cost 事实（L2 token_cost）：不受 correctness 信号污染
    const cost = getFact(v, 'cost');
    expect(cost?.value).toBe(5000);
    expect(cost?.sample_size).toBe(10);
    expect(cost?.signal_sources).toContain('L2_statistical');

    // 缺信号维 → 无事实（value null 语义：getFact 返回 null）
    expect(getFact(v, 'generalization')).toBeNull();
    expect(getFact(v, 'robustness')).toBeNull();
    expect(getFact(v, 'regression')).toBeNull();
    expect(getFact(v, 'contamination_risk')).toBeNull();
  });

  it('③ 分类正确：7 种信号模式 → 7 分类匹配（含 regressed 拒晋升：activate 拒绝且 switch 未被调）', async () => {
    const base = mkVector([
      fact('correctness', 0.9),
      fact('cost', 100),
      fact('robustness', 0.8),
      fact('regression', 0.5),
    ]);
    const mk = (facts: DimensionFact[]): CapabilityVector => mkVector(facts);

    // regressed：regression 维 < 基线
    expect(classify(mk([fact('correctness', 0.9), fact('cost', 100), fact('robustness', 0.8), fact('regression', 0.3)]), base)).toBe('Regressed');
    // stable：各维达标（与基线持平）
    expect(classify(mk([fact('correctness', 0.9), fact('cost', 100), fact('robustness', 0.8), fact('regression', 0.5)]), base)).toBe('Stable');
    // better-in-domain：domain 内 correctness 优于基线
    expect(classify(mk([fact('correctness', 0.95), fact('cost', 100), fact('robustness', 0.8), fact('regression', 0.5)]), base)).toBe('Better-in-domain');
    // cheaper-but-weaker：cost 更优 + correctness 略低（容差内）
    expect(classify(mk([fact('correctness', 0.88), fact('cost', 50), fact('robustness', 0.8), fact('regression', 0.5)]), base)).toBe('Cheaper-but-weaker');
    // more-robust：robustness 优于基线
    expect(classify(mk([fact('correctness', 0.9), fact('cost', 100), fact('robustness', 0.95), fact('regression', 0.5)]), base)).toBe('More-robust');
    // unknown：样本不足（sample_size < MIN_SAMPLES）
    expect(classify(mk([fact('correctness', 0.9, { sample_size: 2 })]), base)).toBe('Unknown');
    // candidate：部分维未达标（correctness 显著低于基线且非 cheaper-but-weaker）
    expect(classify(mk([fact('correctness', 0.7), fact('cost', 100), fact('robustness', 0.8), fact('regression', 0.5)]), base)).toBe('Candidate');

    // regressed 拒晋升：注入评估返回 regressed 向量 → activate 拒绝（switch 未被调）
    const regressedVector = mk([fact('correctness', 0.9), fact('cost', 100), fact('robustness', 0.8), fact('regression', 0.3)]);
    const { deps, switched } = mkDeps(registry, nextSnap, { evaluate: () => regressedVector });
    await expect(
      activate({
        activation_id: 'regress-1',
        candidate: mkRec(),
        evidence_certificate: 'cert/r',
        activation_scope: 'Project',
        compatible_schema: 'omb/2.0',
        baseline: base,
        deps,
      }),
    ).rejects.toThrow(/Regressed|拒绝晋升/);
    expect(switched).toHaveLength(0);
  });

  it('④ 污染回滚：谱系含 untrusted → activate 拒绝；已激活 → rollback 调 switchStableHead(predecessor)（验收核心）', async () => {
    const pool = new CandidatePool(evo);
    // 链：A(根) → B；全部晋升后撤销 A → B re-suspect（谱系含 untrusted）
    const A = mkRec();
    await pool.registerCandidate(A);
    await pool.promote(mkRec({ id: A.id }));
    const B = mkRec({ parent: A.id, lineage: [A.id] });
    await pool.registerCandidate(B);
    await pool.promote(mkRec({ id: B.id }));
    await pool.revoke(A.id);
    const recB = await pool.load(B.id);
    expect(recB.status).toBe('untrusted');

    // 谱系含 untrusted → activate 拒绝（switch 未被调）
    const { deps, switched } = mkDeps(registry, nextSnap, { checkLineage: (r) => pool.checkLineage(r) });
    await expect(
      activate({
        activation_id: 'pollute-1',
        candidate: recB,
        evidence_certificate: 'cert/p',
        activation_scope: 'Project',
        compatible_schema: 'omb/2.0',
        baseline: OK_BASELINE,
        deps,
      }),
    ).rejects.toThrow(/谱系|untrusted|污染|G1/);
    expect(switched).toHaveLength(0);

    // 已激活 → 污染回滚：rollback 调 switchStableHead(predecessor)（回滚路径）
    const recT = await mkTrusted(pool);
    const contract = await activate({
      activation_id: 'pollute-2',
      candidate: recT,
      evidence_certificate: 'cert/p2',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline: OK_BASELINE,
      deps,
    });
    const before = switched.length;
    const res = await rollback(contract, { switchStableHead: deps.switchStableHead });
    expect(res.new).toBe(contract.predecessor);
    expect(switched.length).toBe(before + 1);
    expect(switched.at(-1)).toBe(contract.predecessor);
  });

  it('⑤ 幂等：同 activation_id 重复 activate → no-op（switch/write 只调一次）', async () => {
    const pool = new CandidatePool(evo);
    const recT = await mkTrusted(pool);
    const { deps, switched, written } = mkDeps(registry, nextSnap, { checkLineage: (r) => pool.checkLineage(r) });
    const input = {
      activation_id: 'idem-1',
      candidate: recT,
      evidence_certificate: 'cert/i',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline: OK_BASELINE,
      deps,
    };
    const c1 = await activate(input);
    const c2 = await activate(input);
    expect(c2).toEqual(c1);
    expect(switched).toHaveLength(1);
    expect(written).toHaveLength(1);
  });

  it('⑥ 快照语义：activate 后 promote → 新请求新快照、旧请求旧快照（T1.6 registry 复用）', async () => {
    const pool = new CandidatePool(evo);
    const recT = await mkTrusted(pool);
    // 请求 A 在激活前绑定（全程 v_initial）
    const reqA = registry.begin('reqA');
    expect(reqA).toBe(initial);

    const { deps } = mkDeps(registry, nextSnap, { checkLineage: (r) => pool.checkLineage(r) });
    await activate({
      activation_id: 'snap-1',
      candidate: recT,
      evidence_certificate: 'cert/s',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline: OK_BASELINE,
      deps,
    });

    // 晋升只影响后续请求：进行中请求 A 仍旧快照；新请求 B 新快照
    expect(registry.currentSnapshot).toBe(nextSnap);
    expect(registry.get('reqA')).toBe(initial);
    expect(registry.begin('reqB')).toBe(nextSnap);
    registry.end('reqA');
    registry.end('reqB');
  });

  it('⑦ rollback_snapshot：= 切换前快照（可回退）；predecessor = 切换前 stable_head', async () => {
    const pool = new CandidatePool(evo);
    const recT = await mkTrusted(pool);
    const { deps, switched } = mkDeps(registry, nextSnap, { checkLineage: (r) => pool.checkLineage(r) });
    const contract = await activate({
      activation_id: 'rsnap-1',
      candidate: recT,
      evidence_certificate: 'cert/rs',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline: OK_BASELINE,
      deps,
    });

    expect(contract.rollback_snapshot).toBe(initial.id); // 切换前快照
    expect(contract.predecessor).toBe(STABLE_HEAD); // 切换前 stable_head

    // 可回退：rollback 用 predecessor 切回（switchStableHead 被调）
    await rollback(contract, { switchStableHead: deps.switchStableHead });
    expect(switched.at(-1)).toBe(STABLE_HEAD);
  });
});
