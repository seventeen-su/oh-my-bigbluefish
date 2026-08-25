// S2 维护成本观测与数据化测试（清扫计划 2026-08-24-completion-sweep.md S2）：
//   ① 观测采集：每维护任务执行后追加 .evolution/maintenance-observations/<yyyy-mm-dd>.jsonl
//      （字段齐全：ts/task_id/duration_ms/result/debt_before/debt_after；按日分文件追加）
//   ② 结果全覆盖：success / failed / deferred / interrupted 均记录（含债务前后值）
//   ③ 观测摘要：observationsSummary 今日任务数 + 各任务平均耗时；kern_status 集成（可读入口）
//   ④ 成本注入面：MaintenanceScheduler maintenanceCosts 缺省成本按任务 id 取 policy 成本（未列出仍 1）
//   ⑤ 装配传 policy：finalizeTurn 债务 estimated_cost 从 policy.evolve.maintenance_costs 读取（改 YAML 即生效）
//   ⑥ 债务入账纯函数支持注入成本（缺省 → 出厂初值，既有测试语义不变）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { fallbackFinalizeDecision, fallbackWorkingState } from '../../runtime/loop-hooks.js';
import { makeRuntimeEvent } from '../../runtime/turn-helpers.js';
import type { KernStatusSummary } from '../../runtime/kern-tools.js';
import {
  candidateValidationAccrual,
  debtAccrualsFromSummary,
} from '../../kernel/evolve-decision.js';
import {
  DeferredMaintenanceError,
  MaintenanceScheduler,
  type MaintenanceTaskInput,
} from '../../supervisor/maintenance.js';

const REPO_POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const SESSION = 'sess-s2-obs';

let tmpRoot: string;
const schedulers: MaintenanceScheduler[] = [];
const runtimes: CognitiveRuntime[] = [];

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-maint-obs-'));
});

afterEach(async () => {
  for (const s of schedulers.splice(0)) {
    s.stop();
  }
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

/** MaintenanceTaskInput 工厂（M3 最小形状 + 缺省） */
function task(over: Partial<MaintenanceTaskInput> & { id: string }): MaintenanceTaskInput {
  return {
    value: 1,
    estimated_cost: 1,
    priority: 0,
    urgency: 'normal',
    run: async () => {},
    ...over,
  };
}

/** 观测文件路径（缺省 observationsDir = debtFile 同目录 maintenance-observations/；UTC 日期，与 signals 同约定） */
function obsFile(ts: number): string {
  return join(tmpRoot, 'maintenance-observations', `${new Date(ts).toISOString().slice(0, 10)}.jsonl`);
}

async function readObs(ts: number): Promise<Array<Record<string, unknown>>> {
  const file = obsFile(ts);
  expect(existsSync(file)).toBe(true);
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 复制真实 kernel/policy 到 fixture 并覆盖 evolve.yaml（S2 装配传 policy 测试用） */
async function policyFixtureDir(evolveYaml: string): Promise<string> {
  const dir = join(tmpRoot, 'policy-fixture');
  await cp(REPO_POLICY_DIR, dir, { recursive: true });
  await writeFile(join(dir, 'evolve.yaml'), evolveYaml, 'utf8');
  return dir;
}

// ---- ① 观测采集：成功 ----

describe('S2 维护观测采集（supervisor/maintenance.ts）', () => {
  it('成功任务 → 观测行落盘（字段齐全：ts/task_id/duration_ms/result=success/debt_before/debt_after）', async () => {
    let now = Date.UTC(2026, 7, 23, 10, 0, 0);
    const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), now: () => now });
    schedulers.push(s);
    await s.enqueue(
      task({ id: 'gc', value: 1, estimated_cost: 2, run: async () => { now += 250; } }),
      { accrueDebt: true },
    );
    const r = await s.requestQuantum();
    expect(r.ran).toEqual(['gc']);
    expect(s.debtSnapshot()).toEqual([]); // 成功 → 清偿归零
    const obs = await readObs(now);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      ts: Date.UTC(2026, 7, 23, 10, 0, 0),
      task_id: 'gc',
      duration_ms: 250,
      result: 'success',
      debt_before: 1, // accrueDebt 入队即累计
      debt_after: 0, // 成功清偿
    });
  });

  it('同日多次执行 → 同文件追加（JSONL 多行，不覆盖）', async () => {
    let now = Date.UTC(2026, 7, 23, 10, 0, 0);
    const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), now: () => now });
    schedulers.push(s);
    await s.enqueue(task({ id: 'gc', value: 1, estimated_cost: 2, run: async () => { now += 100; } }), { accrueDebt: true });
    await s.requestQuantum();
    await s.enqueue(task({ id: 'gc', value: 1, estimated_cost: 2, run: async () => { now += 200; } }), { accrueDebt: true });
    await s.requestQuantum();
    const obs = await readObs(now);
    expect(obs).toHaveLength(2);
    expect(obs.map((o) => o.duration_ms)).toEqual([100, 200]);
  });

  // ---- ② 结果全覆盖 ----

  it('失败 → result=failed；Deferred → result=deferred（债务保留 → debt_after 非零）', async () => {
    let now = Date.UTC(2026, 7, 23, 10, 0, 0);
    const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), now: () => now });
    schedulers.push(s);
    await s.enqueue(
      task({ id: 'boom', value: 3, estimated_cost: 1, run: async () => { now += 100; throw new Error('真实失败'); } }),
      { accrueDebt: true },
    );
    await s.requestQuantum();
    await s.enqueue(
      task({ id: 'd', value: 5, estimated_cost: 1, run: async () => { now += 300; throw new DeferredMaintenanceError('未实现'); } }),
      { accrueDebt: true },
    );
    await s.requestQuantum();
    const obs = await readObs(now);
    const failed = obs.find((o) => o.task_id === 'boom');
    const deferred = obs.find((o) => o.task_id === 'd');
    expect(failed).toMatchObject({ result: 'failed', debt_before: 3, debt_after: 3, duration_ms: 100 });
    expect(deferred).toMatchObject({ result: 'deferred', debt_before: 5, debt_after: 5, duration_ms: 300 });
    // 债务保留（未完成不清债）
    expect(s.debtSnapshot().map((d) => d.task_id).sort()).toEqual(['boom', 'd']);
  });

  it('中断 → result=interrupted（债务累计；任务留队可重试）', async () => {
    const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json') });
    schedulers.push(s);
    const ac = new AbortController();
    s.enqueue(task({
      id: 'slow',
      value: 1,
      estimated_cost: 1,
      run: async (signal) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            clearTimeout(timer);
            resolve();
          }, 200);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      },
    }));
    const q = s.requestQuantum({ signal: ac.signal });
    ac.abort();
    const r = await q;
    expect(r.skipped).toContain('slow'); // 中断让出（不挂起）
    const obs = await readObs(Date.now());
    expect(obs[0]).toMatchObject({ task_id: 'slow', result: 'interrupted', debt_before: 0, debt_after: 1 });
    // 任务留队：下一量子成功执行 → 第二行 success
    const r2 = await s.requestQuantum();
    expect(r2.ran).toEqual(['slow']);
    const obs2 = await readObs(Date.now());
    expect(obs2).toHaveLength(2);
    expect(obs2[1]).toMatchObject({ task_id: 'slow', result: 'success' });
  });

  // ---- ③ 观测摘要 ----

  it('观测摘要：今日任务数 + 各任务平均耗时（observationsSummary；无观测 → 全零）', async () => {
    let now = Date.UTC(2026, 7, 23, 10, 0, 0);
    const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), now: () => now });
    schedulers.push(s);
    await s.enqueue(task({ id: 'gc', value: 1, estimated_cost: 2, run: async () => { now += 200; } }), { accrueDebt: true });
    await s.requestQuantum();
    await s.enqueue(task({ id: 'gc', value: 1, estimated_cost: 2, run: async () => { now += 400; } }), { accrueDebt: true });
    await s.requestQuantum();
    await s.enqueue(task({ id: 'repair', value: 1, estimated_cost: 25, run: async () => { now += 600; } }), { accrueDebt: true });
    await s.requestQuantum();
    const sum = s.observationsSummary();
    expect(sum.date).toBe(new Date(now).toISOString().slice(0, 10));
    expect(sum.total).toBe(3);
    const gc = sum.per_task.find((p) => p.task_id === 'gc');
    const repair = sum.per_task.find((p) => p.task_id === 'repair');
    expect(gc).toEqual({ task_id: 'gc', count: 2, avg_duration_ms: 300 }); // (200+400)/2
    expect(repair).toEqual({ task_id: 'repair', count: 1, avg_duration_ms: 600 });
    // 无观测目录 → 全零（安全降级）
    const s2 = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt2.json') });
    schedulers.push(s2);
    expect(s2.observationsSummary()).toEqual({ date: expect.any(String), total: 0, per_task: [] });
  });

  it('kern_status 集成：maintenance_observations 可读（今日任务数/各任务平均耗时）；无调度器 → null 不炸', async () => {
    let now = Date.UTC(2026, 7, 23, 10, 0, 0);
    const scheduler = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), now: () => now });
    const runtime = createCognitiveRuntime({ root: tmpRoot, maintenance: scheduler });
    runtimes.push(runtime);
    await scheduler.enqueue(task({ id: 'gc', value: 1, estimated_cost: 2, run: async () => { now += 150; } }), { accrueDebt: true });
    await scheduler.requestQuantum();
    const summary = (await runtime.status()) as KernStatusSummary;
    expect(summary.maintenance_observations).not.toBeNull();
    expect(summary.maintenance_observations!.total).toBe(1);
    expect(summary.maintenance_observations!.per_task[0]).toEqual({ task_id: 'gc', count: 1, avg_duration_ms: 150 });
    expect(summary.observations_degraded).toBeNull();
    // 未注入调度器 → null（摘要面保持结构完整）
    const rt2 = createCognitiveRuntime({ root: tmpRoot });
    runtimes.push(rt2);
    const s2 = (await rt2.status()) as KernStatusSummary;
    expect(s2.maintenance_observations).toBeNull();
    expect(s2.observations_degraded).toBeNull();
  });

  // ---- ④ 成本注入面 ----

  it('成本注入面：maintenanceCosts 提供时 enqueue 缺省 estimated_cost 按任务 id 取 policy 成本（未列出 id 仍 1）', async () => {
    const s = new MaintenanceScheduler({
      debtFile: join(tmpRoot, 'debt.json'),
      maintenanceCosts: { gc: 2, repair: 25 },
    });
    schedulers.push(s);
    await s.enqueue({ id: 'gc', value: 1, run: async () => {} }, { accrueDebt: true });
    await s.enqueue({ id: 'other', value: 1, run: async () => {} }, { accrueDebt: true });
    const byId = new Map(s.debtSnapshot().map((d) => [d.task_id, d]));
    expect(byId.get('gc')!.estimated_cost).toBe(2); // policy 成本
    expect(byId.get('other')!.estimated_cost).toBe(1); // 未列出 → M3 缺省 1
  });

  // ---- ⑤ 装配传 policy ----

  it('装配传 policy：finalizeTurn 债务 estimated_cost 从 policy.evolve.maintenance_costs 读取（改 YAML 即生效）', async () => {
    const policyDir = await policyFixtureDir([
      'daily_evolution_cost: 100',
      'roi_min: 1.0',
      'maintenance_rate: 0.5',
      'maintenance_costs:',
      '  memory_consolidation: 4',
      '  candidate_validation: 123', // 覆盖：candidate 成本 10 → 123
      '  repair: 25',
      '  promotion_check: 2',
      '  environment_check: 2',
      '  evolution_decision: 2',
      '  gc: 2',
    ].join('\n'));
    const scheduler = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json') });
    const runtime = createCognitiveRuntime({ root: tmpRoot, policyDir, maintenance: scheduler });
    runtimes.push(runtime);
    await runtime.eventStore.append(
      makeRuntimeEvent('tool/call', SESSION, runtime.snapshotHash, { callId: 'c1', name: 'read' }, ['test']),
    );
    await runtime.finalizeTurn({
      session_id: SESSION,
      decision: fallbackFinalizeDecision(runtime.snapshotHash),
      working_state: fallbackWorkingState('S2 目标'),
    });
    const byId = new Map(scheduler.debtSnapshot().map((d) => [d.task_id, d]));
    expect(byId.get('candidate_validation')).toMatchObject({ value: 8, estimated_cost: 123 });
    // 7701fde：GC 不再每收尾常驻入账——事件库 compact 由 turn-finalize 覆盖
    expect(byId.get('gc')).toBeUndefined();
  });

  // ---- ⑥ 债务入账注入 ----

  it('债务入账支持注入成本（缺省 → 出厂初值，既有语义不变）', () => {
    const acc = candidateValidationAccrual({ candidate_validation: 123 });
    expect(acc.estimated_cost).toBe(123);
    expect(acc.priority).toBe(Math.round((8 / 123) * 8)); // §10.1 priority = EV/C × debt
    expect(candidateValidationAccrual().estimated_cost).toBe(10); // 缺省 → 出厂初值
    const accs = debtAccrualsFromSummary(
      { window: { from: 0, to: 1 }, counts: { corrections: 1 } },
      { repair: 7 },
    );
    expect(accs.find((a) => a.task_id === 'repair')).toMatchObject({ value: 20, estimated_cost: 7 });
  });
});
