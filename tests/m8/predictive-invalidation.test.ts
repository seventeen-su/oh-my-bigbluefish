// R5（P0+P1）Predictive Invalidation 对象定位 + 空任务清债语义测试
// （专项计划 2026-08-24-architecture-closure.md R5；评估依据 下一步说明.md 第六节/第十三节；
//  设计 §14.5 + 实现规格 §15.4）。
// 覆盖：
//   ① 环境声明索引（findAffectedObjects）：有环境声明的 memory 可被 delta 命中；无声明 → 空；
//      可选键 from=undefined（字段新增）→ 匹配未声明该键的记录；多字段命中去重
//   ② 环境变化 → affected_objects 真实填充 + 受影响对象降级 suspicious（lifecycle）+ decay 落盘含对象
//   ③ repair 执行：读 decay 记录 → 契约化重验证（P3：对象契约 → 最小验证计划 → 损坏分类 → 处置语义，
//      RepairRecord.objects 逐对象记录）+ 清债；空（无受影响对象）→ 合法完成清债；幂等
//   ④ Deferred 语义：candidate_validation 旧布局（lineSnapshot===null）→ 抛 Deferred → debt 保留不清零
//     （调度器级 Deferred 语义见 tests/m5/maintenance-deferred.test.ts）
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import type { Memory } from '../../kernel/schemas/m.js';
import type { EnvironmentFieldDelta } from '../../kernel/schemas/evolution.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { appendSignals } from '../../runtime/evolution-signals.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { PROV, TS, base } from '../m1/ir-samples.js';

const REPO_POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const REPO_PROCESSES_DIR = fileURLToPath(new URL('../../kernel/processes', import.meta.url));

// ---- 测试工具 ----

const roots: string[] = [];
const schedulers: MaintenanceScheduler[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-r5-inval-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  for (const s of schedulers.splice(0)) {
    s.stop();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function mkScheduler(root: string): MaintenanceScheduler {
  const s = new MaintenanceScheduler({ debtFile: join(root, '.omb', '.evolution', 'debt.json') });
  schedulers.push(s);
  return s;
}

function trackRuntime(rt: ReturnType<typeof createCognitiveRuntime>): ReturnType<typeof createCognitiveRuntime> {
  runtimes.push(rt);
  return rt;
}

/** M1 Memory 工厂（环境声明经 provenance.environment 注入；event_id 幂等键唯一） */
function makeMemory(payload: string, env: Fingerprint): Memory {
  return {
    ...base({ id: makeMutableId('memory'), schema: 'omb/M1' }),
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: { ...PROV, event: makeMutableId('evt'), environment: env },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as unknown as Memory;
}

const FP_V22: Fingerprint = { os: 'win32', node: 'v22.0.0', dsh_version: '0.1.0', project: 'omb-v2' };

// ---- ① 环境声明索引（findAffectedObjects） ----

describe('① 环境声明索引：findAffectedObjects 按 delta 字段匹配声明环境的 memory 记录', () => {
  it('有环境声明的 memory 可命中（声明旧值）；无声明匹配 → 空（诚实）', async () => {
    const root = await tmpRoot();
    const b = new RetrievalBackend(join(root, 'memory.db'));
    try {
      const mOld = await b.ingest(makeMemory('旧环境记忆', FP_V22));
      const mNew = await b.ingest(
        makeMemory('新环境记忆', { ...FP_V22, node: 'v24.0.0' }),
      );
      const delta: Record<string, EnvironmentFieldDelta> = { node: { from: 'v22.0.0', to: 'v24.0.0' } };
      const affected = await b.findAffectedObjects(delta);
      expect(affected).toEqual([{ id: mOld, kind: 'memory' }]); // 仅声明旧值（v22）的记录
      expect(affected.map((a) => a.id)).not.toContain(mNew); // 声明新值（v24）不受影响
      // 无声明匹配 → 空（诚实：不臆造受影响对象）
      expect(await b.findAffectedObjects({ dsh_version: { from: '9.9.9', to: '10.0.0' } })).toEqual([]);
      expect(await b.findAffectedObjects({})).toEqual([]);
    } finally {
      await b.close();
    }
  });

  it('可选键 from=undefined（字段新增）→ 匹配未声明该键的记录', async () => {
    const root = await tmpRoot();
    const b = new RetrievalBackend(join(root, 'memory.db'));
    try {
      await b.ingest(makeMemory('无 gpu 声明', FP_V22));
      await b.ingest(makeMemory('声明 gpu', { ...FP_V22, gpu: 'RTX' }));
      // gpu 从无到有：受影响 = 未声明 gpu 的记录（曾在无 gpu 环境下验证）
      const affected = await b.findAffectedObjects({ gpu: { from: undefined, to: 'RTX' } });
      expect(affected).toEqual([expect.objectContaining({ kind: 'memory' })]);
      expect(affected).toHaveLength(1);
      // gpu 从有到无（from 声明值）→ 匹配声明旧值（gpu=RTX）的记录
      const removed = await b.findAffectedObjects({ gpu: { from: 'RTX', to: undefined } });
      expect(removed).toHaveLength(1);
    } finally {
      await b.close();
    }
  });

  it('多字段命中同一记录 → 去重为单引用（B 声明新值不命中）', async () => {
    const root = await tmpRoot();
    const b = new RetrievalBackend(join(root, 'memory.db'));
    try {
      await b.ingest(makeMemory('A 旧环境', FP_V22));
      await b.ingest(makeMemory('B 新环境', { os: 'win32', node: 'v24.0.0', dsh_version: '0.2.0', project: 'omb-v2' }));
      const multi = await b.findAffectedObjects({
        node: { from: 'v22.0.0', to: 'v24.0.0' },
        dsh_version: { from: '0.1.0', to: '0.2.0' },
      });
      expect(multi).toHaveLength(1); // 仅 A（node + dsh_version 均匹配，去重为单引用）
    } finally {
      await b.close();
    }
  });
});

// ---- ② 环境变化 → 受影响对象定位 + suspicious 降级 + decay 记录 ----

describe('② 环境变化：affected_objects 真实填充 + 受影响对象降级 suspicious + decay 落盘含对象', () => {
  it('memory 声明基线环境 → 环境变化 → 受影响对象定位 + 降级 Suspicious + decay 记录含对象 + repair 债务', async () => {
    const root = await tmpRoot();
    const scheduler = mkScheduler(root);
    let fp: Fingerprint = { ...FP_V22 };
    const runtime = trackRuntime(
      createCognitiveRuntime({ root, maintenance: scheduler, environmentFingerprint: () => fp }),
    );
    // 在基线建立前摄入声明 v22 环境的记忆
    const memId = await runtime.memory.ingest(makeMemory('受环境影响的旧记忆', FP_V22));
    expect(await runtime.runEnvironmentCheck()).toBeNull(); // 基线 v22，不动作
    // 环境变化（node v22 → v24）
    fp = { ...fp, node: 'v24.0.0' };
    const rec = await runtime.runEnvironmentCheck();
    expect(rec).not.toBeNull();
    // affected_objects 真实填充（不再是恒空）
    expect(rec!.affected_objects).toEqual([{ id: memId, kind: 'memory' }]);
    expect(rec!.regression_set).toEqual([memId]); // 最小回归子集 = 受影响对象 id
    expect(rec!.attribution[memId]).toBeDefined(); // 对象级归因
    // 受影响对象降级 suspicious（lifecycle 更新；检索面已按 Suspicious 扣 pollution 降权 §7.4）
    const after = await runtime.memory.getById(memId);
    expect(after!.lifecycle).toBe('Suspicious');
    // decay 落盘含对象（审计）
    const decayDir = join(root, '.evolution', 'decay');
    const files = await readdir(decayDir);
    expect(files).toHaveLength(1);
    const onDisk = JSON.parse(await readFile(join(decayDir, files[0]!), 'utf8')) as {
      affected_objects: unknown[];
      regression_set: unknown[];
    };
    expect(onDisk.affected_objects).toEqual([{ id: memId, kind: 'memory' }]);
    expect(onDisk.regression_set).toEqual([memId]);
    // repair 债务入队（§14.5 局部重验证）
    const debt = scheduler.debtSnapshot();
    expect(debt.find((d) => d.task_id === 'repair')!.value).toBe(20);
  });
});

// ---- ③ repair 任务执行 ----

describe('③ repair：受影响对象重验证 + 清债；空 → 合法完成；幂等', () => {
  it('repair 经调度执行 → 重验证审计记录落盘 + 债务清偿；幂等（重复执行同结果）', async () => {
    const root = await tmpRoot();
    const scheduler = mkScheduler(root);
    let fp: Fingerprint = { ...FP_V22 };
    const runtime = trackRuntime(
      createCognitiveRuntime({ root, maintenance: scheduler, environmentFingerprint: () => fp }),
    );
    const memId = await runtime.memory.ingest(makeMemory('旧环境记忆', FP_V22));
    await runtime.runEnvironmentCheck(); // 基线
    fp = { ...fp, node: 'v24.0.0' };
    await runtime.runEnvironmentCheck(); // 变化 → decay 记录 + repair 债务
    expect(scheduler.debtSnapshot().find((d) => d.task_id === 'repair')).toBeDefined();

    // 调度器量子执行 repair（唯一任务）→ 成功 → 清债
    const q = await scheduler.requestQuantum();
    expect(q.ran).toContain('repair');
    expect(scheduler.debtSnapshot()).toEqual([]); // 成功 → 清偿归零
    // 重验证审计记录落盘 .evolution/repair/<ts>.json
    const repairDir = join(root, '.evolution', 'repair');
    const files = await readdir(repairDir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(await readFile(join(repairDir, files[0]!), 'utf8')) as {
      task: string;
      decay_records: number;
      affected_objects: unknown[];
      reverified: unknown[];
      missing: unknown[];
      objects: Array<{
        id: string;
        kind: string;
        contract_id: string;
        verdict: string;
        evidence_quality: number;
        disposition: string;
        score_eligible: boolean;
        reason: string;
      }>;
    };
    expect(record.task).toBe('repair');
    expect(record.decay_records).toBe(1);
    expect(record.affected_objects).toEqual([{ id: memId, kind: 'memory' }]);
    // P3：契约化重验证——对象存在（getById 命中 → hard pass）但 outcome 无执行器 → 诚实 UNKNOWN；
    // 所属 decay 记录带 environment_delta → environment_change → local_regression（对象保持 Suspicious，
    // 处置仅记录；degrade_or_rollback/quarantine 落地动作属后续语义）
    expect(record.reverified).toEqual([]); // reverified 语义（P3）= verdict=PASS 的对象（UNKNOWN 不属通过）
    expect(record.missing).toEqual([]);
    expect(record.objects).toEqual([
      {
        id: memId,
        kind: 'memory',
        contract_id: `repair:${memId}`,
        verdict: 'UNKNOWN',
        evidence_quality: 0.33, // 1/3 应查检查有结果（getById 命中，outcome 无证据）
        disposition: 'local_regression',
        score_eligible: true,
        reason: expect.stringContaining('环境变化'),
      },
    ]);
    // 幂等：直接再跑一次 → 同结果（判定确定性；不抛、不重复副作用）
    const again = await runtime.runRepair();
    expect(again.objects).toEqual(record.objects);
    expect(again.reverified).toEqual([]);
    expect(again.decay_records).toBe(1);
    expect(await readdir(repairDir)).toHaveLength(2); // 审计记录追加（每 run 一条）
  });

  it('repair 空任务（无受影响对象）→ 合法完成 + 清债', async () => {
    const root = await tmpRoot();
    const scheduler = mkScheduler(root);
    let fp: Fingerprint = { ...FP_V22 };
    const runtime = trackRuntime(
      createCognitiveRuntime({ root, maintenance: scheduler, environmentFingerprint: () => fp }),
    );
    await runtime.runEnvironmentCheck(); // 基线
    fp = { ...fp, node: 'v24.0.0' };
    const rec = await runtime.runEnvironmentCheck(); // 变化（memory 库空 → 无受影响对象，诚实空）
    expect(rec!.affected_objects).toEqual([]);
    expect(scheduler.debtSnapshot().find((d) => d.task_id === 'repair')!.value).toBe(20);
    // 无对象可修 = 合法完成 → 清债
    const q = await scheduler.requestQuantum();
    expect(q.ran).toContain('repair');
    expect(scheduler.debtSnapshot()).toEqual([]);
    const files = await readdir(join(root, '.evolution', 'repair'));
    const record = JSON.parse(await readFile(join(root, '.evolution', 'repair', files[0]!), 'utf8')) as {
      affected_objects: unknown[];
      reverified: unknown[];
      objects: unknown[];
    };
    expect(record.affected_objects).toEqual([]);
    expect(record.reverified).toEqual([]);
    expect(record.objects).toEqual([]);
  });
});

// ---- ④ Deferred 语义（assembly 级：candidate_validation 旧布局） ----

describe('④ DeferredMaintenanceError：candidate_validation 旧布局 → 债务保留不清零', () => {
  it('旧布局（显式目录注入 → lineSnapshot===null）→ 抛 Deferred → debt 保留 + deferredEvents 记录', async () => {
    const root = await tmpRoot();
    const scheduler = mkScheduler(root);
    // 显式 policyDir/processesDir → resolveLineDirs 短路 → lineSnapshot=null（旧布局生产降级路径）
    const runtime = trackRuntime(
      createCognitiveRuntime({
        root,
        maintenance: scheduler,
        policyDir: REPO_POLICY_DIR,
        processesDir: REPO_PROCESSES_DIR,
      }),
    );
    // 触发信号：corrections → 演化判定应演化 → candidate_validation 债务入账（accrueDebt）
    await appendSignals(runtime.signalsDir, [
      { ts: Date.now(), kind: 'corrections', session_id: 'sess-r5', payload: { count: 2 } },
    ]);
    const res = await runtime.runEvolutionNow({ session_id: 'sess-r5' });
    expect(res.enqueued).toContain('candidate_validation');
    expect(res.degraded).toMatch(/旧布局/); // 候选管线跳过（生产降级记录）
    // quantum 已执行 candidate_validation → Deferred（不再 return 假成功）→ 债务保留
    expect(res.quantum.ran).toContain('candidate_validation');
    const cv = scheduler.debtSnapshot().find((d) => d.task_id === 'candidate_validation');
    expect(cv).toBeDefined();
    expect(cv!.value).toBe(8); // §10.1 candidate 权重，未清偿
    expect(scheduler.deferredEvents().map((e) => e.task_id)).toContain('candidate_validation');
    scheduler.stop();
  });
});
