// M5 出口整体连通测试：演化全自动闭环（信号 → 候选 → 验证 → 晋升 → 污染回滚 → 维护无饥饿）。
// 用户强化指示（CONVENTIONS §5.1）：每里程碑出口必须有整体连通测试——把 M5 全产物
// （T5.1 candidates 信任池 / T5.2 validate 验证链 / T5.4 maintenance 调度 / T5.5 evolution-evaluator+activation 晋升闭环）
// 串成端到端闭环，并连通前置链：候选对象过 M1 schema（G1 校验）、快照注册表（T1.6/M1）、记忆 DB（M3）。
// 真实模块 + 真实 SQLite，禁 mock；仅依赖注入 fake（T5.5 deps 注入模式）：
//   switchStableHead（Recovery Root 注入点，T0.4）与 writeEvolutionObject（git 落库注入点——versions.git 接 M6/M7）。
// 纪律（T5.1 Minor ④ load-before-guard）：消费候选前必须 pool.load(id) 取盘上最新记录再 assertTrusted。
// 工具与工厂见 loop-helpers.ts（LOC 预算，CONVENTIONS §9）。
// 覆盖：① 候选注册与验证链 ② 评估与晋升 ③ 快照语义 ④ 污染回滚（核心） ⑤ 维护无饥饿 ⑥ 确定性 ⑦ schema 合规抽查。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActivationContractSchema,
  EvolutionObjectSchema,
  MemorySchema,
  RuntimeSnapshotSchema,
  type ActivationContract,
  type RuntimeSnapshot,
} from '../../kernel/schemas/m.js';
import type { CapabilityVector } from '../../runtime/evaluator.js';
import { evaluate } from '../../runtime/evolution-evaluator.js';
import { activate, resetActivationLog, rollback } from '../../supervisor/activation.js';
import { CandidatePool } from '../../supervisor/candidates.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { runVerification, type CandidateTestPlan } from '../../supervisor/validate.js';
import { SnapshotRegistry } from '../../supervisor/versioning.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { CONSOLIDATION_TASK_ID, consolidate, type ConsolidationReport } from '../../memory/consolidate.js';
import {
  ENV,
  NOW,
  OK_BASELINE,
  STABLE_HEAD,
  WS,
  evoFileName,
  makeMemory,
  mkDeps,
  mkRec,
  mkSignals,
  mkSnapshot,
  mkTrusted,
} from './loop-helpers.js';

// ---- 共享 fixture（m3/m4 milestone-loop 同款：beforeAll 建一次共享根，跨 it 状态流动） ----

let tmpRoot: string;
let evo: string; // CandidatePool 临时 .evolution 根（共享：① 的候选 ② 消费，全文件一个池）
let evoStoreDir: string; // EvolutionObject 真实临时落库目录
let initial: RuntimeSnapshot;
let nextSnap: RuntimeSnapshot;
let registry: SnapshotRegistry;
const backends: RetrievalBackend[] = [];
const schedulers: MaintenanceScheduler[] = [];
/** ① 晋升的闭环候选 id（② 激活消费） */
let loopCandId = '';
/** ① 候选目录（object.json；⑦ 前置链 M1 schema 抽查） */
let loopCandDir = '';
/** ② 激活契约与落库的 EvolutionObject id（⑦ schema 抽查） */
let loopContract: ActivationContract | null = null;
let loopEvoId = '';

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-m5loop-'));
  evo = join(tmpRoot, '.evolution');
  evoStoreDir = join(tmpRoot, 'evolution-objects');
  await mkdir(evo, { recursive: true });
  await mkdir(evoStoreDir, { recursive: true });
});

afterAll(async () => {
  for (const s of schedulers.splice(0)) s.stop();
  for (const b of backends.splice(0)) await b.close(); // Windows：WAL 侧车文件锁 → 先 close 再 rm
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  resetActivationLog();
  // 注意：seq 不重置——共享 evo 下候选 id 必须全文件唯一（内容寻址语义，防跨测试 id 冲突）
  initial = mkSnapshot('rev-initial');
  nextSnap = mkSnapshot('rev-activated');
  registry = new SnapshotRegistry(initial);
});

// ---- 主测试：演化全自动闭环（信号 → 候选 → 验证 → 晋升 → 污染回滚 → 维护） ----

describe('M5 演化闭环整体连通（信号 → 候选 → 验证 → 晋升 → 污染回滚 → 维护无饥饿）', () => {
  it('① 候选注册与验证链：合法 IR 候选 → registerCandidate(untrusted) → G1 schema 校验全过 → promote → load+assertTrusted 放行', async () => {
    const pool = new CandidatePool(evo);
    const cand = mkRec({ kind: 'memory', gates_passed: ['G1'] });
    await pool.registerCandidate(cand);
    const reg = await pool.load(cand.id);
    expect(reg.status).toBe('untrusted'); // 硬边界：一律落 untrusted（T5.1）
    expect(() => pool.assertTrusted(reg)).toThrow(/仅 trusted/); // 消费守卫：untrusted 不可消费

    // 验证链 G1：候选对象 = 合法 M1 Memory（前置链：M1 schema 校验）→ 全过
    loopCandDir = join(tmpRoot, 'candidate-object');
    await mkdir(loopCandDir, { recursive: true });
    await writeFile(join(loopCandDir, 'object.json'), JSON.stringify(makeMemory({ payload: '演化闭环候选记忆' })), 'utf8');
    const plan: CandidateTestPlan = { candidate_id: cand.id, gates: [{ gate: 'G1', checks: ['schema:M1'] }] };
    const results = await runVerification(plan, { candidateDir: loopCandDir, workspace: WS });
    expect(results).toHaveLength(1);
    expect(results[0]!.gate).toBe('G1');
    expect(results[0]!.ok).toBe(true); // 验证链全过（供晋升）

    // 晋升 → load-before-guard 纪律（T5.1 Minor ④）：消费前 load 盘上最新记录再 assertTrusted
    await pool.promote(mkRec({ id: cand.id }));
    const trusted = await pool.load(cand.id);
    pool.assertTrusted(trusted); // 放行（不抛）
    expect(trusted.status).toBe('trusted');
    loopCandId = trusted.id;
  });

  it('② 评估与晋升：信号序列 → 真实 evaluate/classify → activate（switch 收 candidate.id + M4 落库 + 快照晋升）', async () => {
    const pool = new CandidatePool(evo);
    const cand = await pool.load(loopCandId); // load-before-guard：消费前取盘上最新记录
    pool.assertTrusted(cand);

    // 信号序列 → 真实 evaluate（T5.5 deps 注入模式）；基线 = 真实 evaluate（同形状、更低分）
    const signals = mkSignals(cand.id, 0.95);
    const baseline = evaluate(mkSignals('baseline:stable', 0.9), 'baseline:stable', { environment: ENV });
    // classify：correctness 0.95 > 0.9 → Better-in-domain（过门禁，非 Regressed/Unknown）
    const { deps, switched, written } = mkDeps(registry, nextSnap, evoStoreDir, {
      evaluate: (t) => evaluate(signals, t, { environment: ENV }),
      checkLineage: (r) => pool.checkLineage(r), // 真实信任池谱系守卫
    });

    const contract = await activate({
      activation_id: 'loop-activate',
      candidate: cand,
      evidence_certificate: 'cert/loop-1',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline,
      diff: 'diff --git a/x b/x\n+loop improvement',
      deps,
    });

    // ActivationContract 完整（M6 schema）+ 原子切换收 candidate.id + predecessor/rollback_snapshot
    expect(ActivationContractSchema.safeParse(contract).success).toBe(true);
    expect(contract.candidate).toBe(cand.id);
    expect(contract.predecessor).toBe(STABLE_HEAD);
    expect(contract.rollback_snapshot).toBe(initial.id); // 切换前快照
    expect(contract.required_capabilities).toContain('memory');
    expect(switched).toEqual([cand.id]); // switchStableHead 收到 candidate.id

    // EvolutionObject（M4）落真实临时库：id=sha256(内容) + verifications 聚合
    expect(written).toHaveLength(1);
    const evoObj = written[0]!;
    expect(EvolutionObjectSchema.safeParse(evoObj).success).toBe(true);
    expect(evoObj.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evoObj.verifications).toEqual(expect.arrayContaining(['cert/loop-1', 'G1']));
    const stored = JSON.parse(await readFile(join(evoStoreDir, evoFileName(evoObj.id)), 'utf8')) as unknown;
    expect(stored).toEqual(evoObj); // 盘上物化保真

    expect(registry.currentSnapshot).toBe(nextSnap); // 快照晋升（新请求用新快照）
    loopContract = contract;
    loopEvoId = evoObj.id;
  });

  it('③ 快照语义：promote 后新请求新快照、进行中请求旧快照（T1.6 真实 registry）', async () => {
    const pool = new CandidatePool(evo);
    const cand = await mkTrusted(pool);
    const reqA = registry.begin('req-loop-A'); // 激活前绑定 → 全程旧快照
    expect(reqA).toBe(initial);

    const { deps } = mkDeps(registry, nextSnap, evoStoreDir, { checkLineage: (r) => pool.checkLineage(r) });
    await activate({
      activation_id: 'loop-snapshot',
      candidate: cand,
      evidence_certificate: 'cert/loop-snap',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline: OK_BASELINE,
      deps,
    });

    expect(registry.currentSnapshot).toBe(nextSnap); // 晋升已生效
    expect(registry.get('req-loop-A')).toBe(initial); // 进行中请求仍旧快照
    expect(registry.begin('req-loop-B')).toBe(nextSnap); // 新请求新快照
    registry.end('req-loop-A');
    registry.end('req-loop-B');
  });

  it('④ 污染回滚：谱系含 untrusted → activate 拒绝；已激活候选祖先被 revoke → rollback 切回 predecessor（核心）', async () => {
    const pool = new CandidatePool(evo);
    // 链：A(根) → B(子)；全部晋升（checkLineage 放行）
    const A = mkRec();
    await pool.registerCandidate(A);
    await pool.promote(mkRec({ id: A.id }));
    const B = mkRec({ parent: A.id, lineage: [A.id] });
    await pool.registerCandidate(B);
    await pool.promote(mkRec({ id: B.id }));

    // 已激活候选 B：谱系全 trusted → 激活成功（switch 收到 B.id）
    const { deps, switched } = mkDeps(registry, nextSnap, evoStoreDir, { checkLineage: (r) => pool.checkLineage(r) });
    const contract = await activate({
      activation_id: 'loop-pollute-act',
      candidate: await pool.load(B.id),
      evidence_certificate: 'cert/loop-pollute',
      activation_scope: 'Project',
      compatible_schema: 'omb/2.0',
      baseline: OK_BASELINE,
      deps,
    });
    expect(switched).toEqual([B.id]);

    // 污染发生：祖先 A 被 revoke → B re-suspect（盘上记录 = untrusted）
    await pool.revoke(A.id);
    const recB = await pool.load(B.id); // load-before-guard：以盘上最新记录为准
    expect(recB.status).toBe('untrusted');

    // untrusted 候选（注册后未处 trusted 态）→ activate 拒绝（checkLineage 真实拒绝；switch 未被调）
    await expect(
      activate({
        activation_id: 'loop-pollute-rej',
        candidate: recB,
        evidence_certificate: 'cert/loop-pollute-rej',
        activation_scope: 'Project',
        compatible_schema: 'omb/2.0',
        baseline: OK_BASELINE,
        deps,
      }),
    ).rejects.toThrow(/谱系|untrusted|污染/);
    expect(switched).toHaveLength(1); // 仍是激活 B 的那一次（拒绝路径零切换）

    // 污染回滚：rollback(contract) → switchStableHead(predecessor) 被调（head 切回切换前）
    const res = await rollback(contract, { switchStableHead: deps.switchStableHead });
    expect(res.new).toBe(contract.predecessor);
    expect(switched.at(-1)).toBe(contract.predecessor);
  });

  it('⑤ 维护无饥饿：真实 MaintenanceScheduler → 真实 consolidate 经调度 → requestQuantum 执行 → DB 效果（dedup Frozen）', async () => {
    const backend = new RetrievalBackend(join(tmpRoot, 'memory.db'));
    backends.push(backend);
    // 同 scope+kind 同内容 ×2：旧 dup + 新 keep → consolidation dedup 冻结旧项
    const dup = makeMemory({ payload: '维护调度的整合目标', updated: '2026-08-01T00:00:00.000Z' });
    const keep = makeMemory({ payload: '维护调度的整合目标', updated: '2026-08-20T00:00:00.000Z' });
    await backend.ingest(dup);
    await backend.ingest(keep);

    const scheduler = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json') });
    schedulers.push(scheduler);
    let report: ConsolidationReport | null = null;
    // 真实 consolidate 经调度器入队（高 ROI）
    await scheduler.enqueue({
      id: CONSOLIDATION_TASK_ID,
      value: 3,
      estimated_cost: 1,
      run: async () => {
        report = await consolidate(backend, { now: NOW });
      },
    });
    // 低 ROI 第二任务：两个任务都必须在量子内被执行——无饥饿
    let markerRan = false;
    await scheduler.enqueue({ id: 'loop-marker', value: 1, estimated_cost: 10, run: async () => { markerRan = true; } });

    const q1 = await scheduler.requestQuantum();
    expect(q1.ran).toEqual([CONSOLIDATION_TASK_ID]); // ROI 高者先
    const q2 = await scheduler.requestQuantum();
    expect(q2.ran).toEqual(['loop-marker']); // 次量子执行：无饥饿
    expect(report!.deduped).toBe(1);

    // DB 效果：dedup 冻结旧项（盘上记忆 DB 生效，M3 链连通）
    expect((await backend.getById(dup.id))?.lifecycle).toBe('Frozen');
    expect((await backend.getById(keep.id))?.lifecycle).toBe('Active');
    expect(scheduler.debtSnapshot()).toEqual([]); // 成功 → 清债（无债务堆积）
    expect(markerRan).toBe(true);
  });

  it('⑥ 确定性：同一信号序列 evaluate ×2 → 相同 CapabilityVector（深相等，去评估元数据 id/created）', () => {
    const T = `sha256:${'d'.repeat(64)}`;
    const signals = mkSignals(T, 0.95);
    const a = evaluate(signals, T, { environment: ENV });
    const b = evaluate(signals, T, { environment: ENV });
    // id（vector:<uuid>）与 created（epoch ms）为可变对象评估元数据（§4.1），非内容——归一后深相等
    const strip = (v: CapabilityVector): CapabilityVector => ({
      ...v,
      id: 'vector:00000000-0000-4000-8000-000000000000',
      created: 0,
    });
    expect(b.facts).toEqual(a.facts); // 维度事实逐维一致（value/sample_size/sources/refs）
    expect(strip(b)).toEqual(strip(a)); // 全向量深相等（同输入同输出，P7）
  });

  it('⑦ schema 合规抽查：ActivationContract/EvolutionObject 过 M6/M4 schema（盘上物化产物）+ 前置链 M1/M5 抽查', async () => {
    // M6 ActivationContract（② 产物）：schema 合规 + 关键字段
    expect(loopContract).not.toBeNull();
    expect(ActivationContractSchema.safeParse(loopContract).success).toBe(true);
    expect(loopContract!.rollback_snapshot).toMatch(/^sha256:/); // 切换前快照 id（M5 语义）

    // M4 EvolutionObject（② 经注入落真实临时库）：盘上物化过 schema
    const raw = JSON.parse(await readFile(join(evoStoreDir, evoFileName(loopEvoId)), 'utf8')) as unknown;
    expect(EvolutionObjectSchema.safeParse(raw).success).toBe(true);
    expect(EvolutionObjectSchema.parse(raw).id).toBe(loopEvoId);

    // 前置链抽查：M1 记忆候选（① 的 object.json）过 M1 schema；快照过 M5 schema
    const obj = JSON.parse(await readFile(join(loopCandDir, 'object.json'), 'utf8')) as unknown;
    expect(MemorySchema.safeParse(obj).success).toBe(true);
    expect(RuntimeSnapshotSchema.safeParse(initial).success).toBe(true);
  });
});
