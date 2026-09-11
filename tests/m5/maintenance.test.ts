// T5.4 行为测试：维护调度升级完整版（supervisor/maintenance.ts，架构 §12.3 Maintenance Queue/
// Debt/Quantum + §9.1 Predictive Invalidation + §9.5 ROI + §4.4 Fingerprint）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-8）：
//   ① ROI 排序：value/cost 不同的任务 → requestQuantum 先跑 ROI 高者
//   ② 优先级 tie-break：ROI 相同 → priority 高者先
//   ③ 债务累计：任务失败 → debtSnapshot 含该任务（value 累加）；持久化文件存在且重载一致
//   ④ soft 限：债务超 soft → quantum 频率提升（tick 计数断言）；hard 限：非必要任务被跳过；
//      critical：立即优先执行
//   ⑤ 维护量子可中断：run 中 abort → 任务让出（skipped 记录，不挂起）
//   ⑥ Predictive Invalidation：fingerprint 变化（node 版本字段不同）→ markSuspicious 被调 +
//      CapabilityDecayRecord 结构完整（含 regression_set）
//   ⑦ 退出即停：stop() 清定时器/队列 → tick/requestQuantum 无动作（无遗留任务）；
//      挂起中的任务被中断（skipped/aborted 路径，不挂起）
//   ⑧ 经调度跑 consolidation：M3 consolidate 经 scheduler.enqueue 执行成功（升级兼容验证）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import type { Memory } from '../../kernel/schemas/m.js';
import {
  MaintenanceScheduler,
  type MaintenanceTaskInput,
} from '../../supervisor/maintenance.js';
import { SqliteMemoryBackend } from '../../memory/backend.js';
import { consolidate } from '../../memory/consolidate.js';
import { PROV, TS, base } from '../m1/ir-samples.js';

// ---- 测试工具 ----

let tmpRoot: string;
const schedulers: MaintenanceScheduler[] = [];

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-maint-'));
});

afterEach(async () => {
  for (const s of schedulers.splice(0)) {
    s.stop();
  }
  vi.useRealTimers();
  await rm(tmpRoot, { recursive: true, force: true });
});

function mkScheduler(over: Partial<ConstructorParameters<typeof MaintenanceScheduler>[0]> = {}) {
  const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), ...over });
  schedulers.push(s);
  return s;
}

/** MaintenanceTaskInput 工厂：{id, run} 必需；value/cost/priority/urgency 可缺省（M3 最小形状） */
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

const fail = async (): Promise<void> => {
  throw new Error('maintenance task failed');
};

// ---- ① ROI 排序 ----

describe('维护调度（§12.3）', () => {
  it('ROI 排序：requestQuantum 先跑 value/estimated_cost 高者（ROI 降序）', async () => {
    const s = mkScheduler();
    const ran: string[] = [];
    s.enqueue(task({ id: 'low', value: 1, estimated_cost: 10, run: async () => { ran.push('low'); } }));
    s.enqueue(task({ id: 'high', value: 10, estimated_cost: 1, run: async () => { ran.push('high'); } }));
    const r1 = await s.requestQuantum();
    expect(r1.ran).toEqual(['high']);
    const r2 = await s.requestQuantum();
    expect(r2.ran).toEqual(['low']);
    expect(ran).toEqual(['high', 'low']);
  });

  // ---- ② 优先级 tie-break ----

  it('优先级 tie-break：ROI 相同 → priority 高者先', async () => {
    const s = mkScheduler();
    const ran: string[] = [];
    s.enqueue(task({ id: 'p0', value: 2, estimated_cost: 2, priority: 0, run: async () => { ran.push('p0'); } }));
    s.enqueue(task({ id: 'p5', value: 3, estimated_cost: 3, priority: 5, run: async () => { ran.push('p5'); } }));
    const r1 = await s.requestQuantum();
    expect(r1.ran).toEqual(['p5']);
    const r2 = await s.requestQuantum();
    expect(r2.ran).toEqual(['p0']);
    expect(ran).toEqual(['p5', 'p0']);
  });

  // ---- ③ 债务累计 + 持久化 ----

  it('债务累计：任务失败 → debtSnapshot 含该任务（value 累加）；持久化文件存在且重载一致', async () => {
    const s = mkScheduler();
    s.enqueue(task({ id: 'boom', value: 3, estimated_cost: 1, run: fail }));
    const r = await s.requestQuantum();
    expect(r.ran).toEqual(['boom']); // 执行过（失败）→ ran + 债务
    const debt = s.debtSnapshot();
    expect(debt).toHaveLength(1);
    expect(debt[0]).toMatchObject({
      task_id: 'boom',
      value: 3,
      priority: 0,
      estimated_cost: 1,
      urgency: 'normal',
    });
    expect(typeof debt[0]!.accumulated_at).toBe('number');
    // 持久化：文件存在且与快照一致
    expect(existsSync(join(tmpRoot, 'debt.json'))).toBe(true);
    const onDisk = JSON.parse(await readFile(join(tmpRoot, 'debt.json'), 'utf8'));
    expect(onDisk).toEqual(debt);
    // 再次失败 → value 累加（3+3=6）
    s.enqueue(task({ id: 'boom', value: 3, estimated_cost: 1, run: fail }));
    await s.requestQuantum();
    expect(s.debtSnapshot()[0]!.value).toBe(6);
    // 重载一致：新实例读同一文件 → 债务快照相同
    const s2 = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json') });
    schedulers.push(s2);
    expect(s2.debtSnapshot()).toEqual(s.debtSnapshot());
  });

  it('债务加载剪除：debt.json 中的历史僵尸（turn-finalize:* 与 gc）加载时跳过，健康条目 value 原样保留', async () => {
    // 预写含僵尸（turn-finalize:ghost/gc）与健康条目的债务文件，再构造调度器（调度只执行 enqueue 队列，
    // 恢复的债务永不清偿 → 加载即剪除；僵尸为重启后无属主/无人再入队的残留）
    await writeFile(
      join(tmpRoot, 'debt.json'),
      JSON.stringify([
        { task_id: 'turn-finalize:ghost', value: 999, accumulated_at: 1, priority: 0, estimated_cost: 1, urgency: 'normal' },
        { task_id: 'gc', value: 555, accumulated_at: 2, priority: 0, estimated_cost: 1, urgency: 'normal' },
        { task_id: 'candidate_validation', value: 8, accumulated_at: 3, priority: 0, estimated_cost: 1, urgency: 'normal' },
        { task_id: 'memory_consolidation', value: 2, accumulated_at: 4, priority: 0, estimated_cost: 1, urgency: 'normal' },
      ]),
      'utf8',
    );
    const s = mkScheduler();
    const debt = s.debtSnapshot();
    expect(debt.map((d) => d.task_id)).toEqual(['candidate_validation', 'memory_consolidation']); // 已按 task_id 排序
    expect(debt.find((d) => d.task_id === 'candidate_validation')!.value).toBe(8); // value 原样保留
    expect(debt.find((d) => d.task_id === 'memory_consolidation')!.value).toBe(2);
    expect(debt.some((d) => d.task_id === 'turn-finalize:ghost' || d.task_id === 'gc')).toBe(false);
  });

  // ---- ④ soft / hard / critical ----

  it('soft 限：债务超 soft → quantum 频率提升（tick 计数断言）', async () => {
    vi.useFakeTimers();
    const s = mkScheduler({ tickIntervalMs: 1000, softLimit: 10, hardLimit: 100 });
    s.start();
    // 无债务：基准间隔 1000ms → 3s 内 3 次 tick
    await vi.advanceTimersByTimeAsync(3000);
    const before = s.tickCount;
    expect(before).toBe(3);
    // 制造债务：两次失败（value 6×2 = 12 ≥ soft 10）→ 频率提升（间隔减半 500ms）
    s.enqueue(task({ id: 'd1', value: 6, estimated_cost: 1, run: fail }));
    s.enqueue(task({ id: 'd2', value: 6, estimated_cost: 1, run: fail }));
    await s.requestQuantum();
    await s.requestQuantum();
    const total = s.debtSnapshot().reduce((a, d) => a + d.value, 0);
    expect(total).toBeGreaterThanOrEqual(10);
    const after = s.tickCount;
    await vi.advanceTimersByTimeAsync(3000);
    const more = s.tickCount;
    expect(more - after).toBeGreaterThan(after - before); // 同一 3s 窗口 tick 更多 → 频率提升
  });

  it('hard 限：债务超 hard → 非必要任务（urgency normal）被跳过', async () => {
    const s = mkScheduler({ softLimit: 5, hardLimit: 8 });
    const ran: string[] = [];
    // 先制造债务：两次失败（value 6×2 = 12 ≥ hard 8）
    s.enqueue(task({ id: 'f1', value: 6, estimated_cost: 1, run: fail }));
    s.enqueue(task({ id: 'f2', value: 6, estimated_cost: 1, run: fail }));
    await s.requestQuantum();
    await s.requestQuantum();
    // 债务 ≥ hard → normal 任务被跳过（不执行）
    s.enqueue(task({ id: 'normal-work', value: 1, estimated_cost: 1, run: async () => { ran.push('normal-work'); } }));
    const r = await s.requestQuantum();
    expect(r.ran).toEqual([]);
    expect(r.skipped).toContain('normal-work');
    expect(ran).toEqual([]);
  });

  it('死亡螺旋回归：硬跳过不累计债务（跳过 = 调度延迟非失败）；必要维护豁免硬限', async () => {
    const s = mkScheduler({ softLimit: 5, hardLimit: 8 });
    const ran: string[] = [];
    // 制造债务超硬限（12 ≥ 8）
    s.enqueue(task({ id: 'f1', value: 6, estimated_cost: 1, run: fail }));
    await s.requestQuantum();
    s.enqueue(task({ id: 'f2', value: 6, estimated_cost: 1, run: fail }));
    await s.requestQuantum();
    const debtBefore = s.debtSnapshot().reduce((acc, d) => acc + d.value, 0);
    // 非必要任务被跳过但不累计债务（债务快照不变——2026-08-25 死亡螺旋修复）
    s.enqueue(task({ id: 'normal-work', value: 1, estimated_cost: 1, run: async () => { ran.push('normal-work'); } }));
    const r1 = await s.requestQuantum();
    expect(r1.skipped).toContain('normal-work');
    const debtAfterSkip = s.debtSnapshot().reduce((acc, d) => acc + d.value, 0);
    expect(debtAfterSkip).toBe(debtBefore);
    // 必要维护任务（gc/turn-finalize:/memory_consolidation/environment_check）豁免硬限——照样执行并清偿
    s.enqueue(task({ id: 'gc', value: 1, estimated_cost: 1, run: async () => { ran.push('gc'); } }));
    s.enqueue(task({ id: 'turn-finalize:s1', value: 1, estimated_cost: 1, run: async () => { ran.push('tf'); } }));
    s.enqueue(task({ id: 'memory_consolidation', value: 1, estimated_cost: 1, run: async () => { ran.push('mc'); } }));
    s.enqueue(task({ id: 'environment_check', value: 1, estimated_cost: 1, run: async () => { ran.push('ec'); } }));
    const r2 = await s.requestQuantum(); // 每次一个：四个必要任务分四次 quantum（同 ROI/priority → id 字典序）
    expect(r2.ran).toEqual(['environment_check']); // ran = 任务 id
    await s.requestQuantum();
    await s.requestQuantum();
    await s.requestQuantum();
    expect(ran).toEqual(['ec', 'gc', 'mc', 'tf']); // 执行序按 id 字典序
    // 演化类任务（candidate_validation）仍受硬限约束
    s.enqueue(task({ id: 'candidate_validation', value: 1, estimated_cost: 1, run: async () => { ran.push('cv'); } }));
    const r3 = await s.requestQuantum();
    expect(r3.skipped).toContain('candidate_validation');
  });

  it('critical：markCritical/urgency=critical → 下一 quantum/tick 优先执行（先于 ROI 更高者）', async () => {
    const s = mkScheduler({ batchSize: 4 }); // 显式批量：tick 为批量消费路径（缺省单量子语义见 maintenance-scheduling.test.ts）
    const ran: string[] = [];
    s.enqueue(task({ id: 'roi-top', value: 100, estimated_cost: 1, priority: 10, run: async () => { ran.push('roi-top'); } }));
    s.enqueue(task({ id: 'crit', value: 1, estimated_cost: 100, priority: 0, run: async () => { ran.push('crit'); } }));
    s.markCritical('crit');
    const r1 = await s.requestQuantum();
    expect(r1.ran[0]).toBe('crit'); // 强制插入 → 先于 ROI 100 的 roi-top（同批执行，顺序证明优先级）
    expect(r1.ran).toEqual(['crit', 'roi-top']);
    expect(ran).toEqual(['crit', 'roi-top']);
    // urgency='critical' 入队自动强制优先（经 tick 路径）
    s.enqueue(task({ id: 'crit2', value: 1, estimated_cost: 100, urgency: 'critical', run: async () => { ran.push('crit2'); } }));
    s.enqueue(task({ id: 'roi2', value: 50, estimated_cost: 1, run: async () => { ran.push('roi2'); } }));
    const r2 = await s.tick();
    expect(r2.ran[0]).toBe('crit2'); // tick 批量：crit2 优先（先于 ROI 50 的 roi2）
    expect(r2.ran).toEqual(['crit2', 'roi2']);
    expect(ran).toEqual(['crit', 'roi-top', 'crit2', 'roi2']);
  });

  // ---- ⑤ 维护量子可中断 ----

  it('维护量子可中断：run 中 abort → 任务让出（skipped 记录，不挂起）；留队可重试', async () => {
    const s = mkScheduler();
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
          }, 50);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err; // 协作式中断：让出
        }
      },
    }));
    const q = s.requestQuantum({ signal: ac.signal });
    ac.abort(); // 立即中断（模拟请求到达）
    const r = await q;
    expect(r.ran).toEqual([]);
    expect(r.skipped).toContain('slow'); // 量子正常返回，不挂起
    // 任务留队：下一量子无中断 → 执行成功
    const r2 = await s.requestQuantum();
    expect(r2.ran).toEqual(['slow']);
  });

  // ---- ⑥ Predictive Invalidation ----

  it('Predictive Invalidation：node 版本变化 → markSuspicious 被调 + CapabilityDecayRecord 结构完整', async () => {
    const s = mkScheduler();
    const oldFp: Fingerprint = { os: 'win32', node: 'v22.0.0', dsh_version: '0.5.0', project: 'omb-v2' };
    const newFp: Fingerprint = { os: 'win32', node: 'v24.0.0', dsh_version: '0.5.0', project: 'omb-v2' };
    const affected = [
      { id: 'exp:1', kind: 'experience' },
      { id: 'proc:2', kind: 'process' },
    ];
    const marked: string[] = [];
    const records = s.predictiveInvalidate(newFp, oldFp, {
      affectedObjects: affected,
      markSuspicious: (obj) => {
        marked.push(`${obj.kind}:${obj.id}`);
      },
    });
    expect(marked).toEqual(['experience:exp:1', 'process:proc:2']); // 受影响对象提前降级 suspicious
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.environment_delta).toEqual({ node: { from: 'v22.0.0', to: 'v24.0.0' } });
    expect(rec.affected_objects).toEqual(affected);
    expect(rec.regression_set).toEqual(['exp:1', 'proc:2']); // 最小回归子集 = 受影响对象列表
    expect(rec.capability_before).toBe(1);
    expect(rec.capability_after).toBeLessThan(rec.capability_before); // 能力衰减
    expect(rec.attribution).toContain('node');
    // 无指纹差异 → 无记录、不标记
    const marked2: string[] = [];
    const records2 = s.predictiveInvalidate(newFp, { ...newFp }, {
      affectedObjects: affected,
      markSuspicious: (obj) => {
        marked2.push(obj.id);
      },
    });
    expect(records2).toEqual([]);
    expect(marked2).toEqual([]);
  });

  // ---- ⑦ 退出即停 ----

  it('退出即停：stop() 清定时器/队列 → tick/requestQuantum 无动作（无遗留任务）', async () => {
    const s = mkScheduler({ tickIntervalMs: 1000 });
    const ran: string[] = [];
    s.start();
    s.enqueue(task({ id: 'left', value: 1, estimated_cost: 1, run: async () => { ran.push('left'); } }));
    s.stop();
    const r = await s.tick();
    expect(r).toEqual({ ran: [], skipped: [] });
    const q = await s.requestQuantum();
    expect(q).toEqual({ ran: [], skipped: [] });
    expect(ran).toEqual([]); // 队列已清空，任务未执行
    s.stop(); // 幂等
  });

  it('退出即停：stop() 中断在飞任务（run 挂起中 stop → 任务让出 skipped/aborted，不挂起）', async () => {
    const s = mkScheduler();
    s.enqueue(task({
      id: 'hang',
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
          throw err; // 协作式中断：让出（skipped/aborted 路径）
        }
      },
    }));
    const q = s.requestQuantum(); // requestQuantum 同步推进到 run 挂起（listener 已注册）
    s.stop(); // 退出即停：inFlight abort → 在飞任务被中断
    const r = await q;
    expect(r.ran).toEqual([]); // 未自然跑完
    expect(r.skipped).toContain('hang'); // 中断路径：skipped/aborted 记录
    // 不挂起：q 已正常返回。若 inFlight 未接入执行 signal，此处会等 200ms 任务自然跑完
    // → ran 含 'hang'、skipped 不含 → 本断言失败（RED）。
  });

  it('退出即停：stop 后 enqueue 被忽略（新任务不入队，tick 无动作）；start 不复活已停调度器', async () => {
    const s = mkScheduler({ tickIntervalMs: 1000 });
    const ran: string[] = [];
    s.start();
    s.stop();
    // stop 后入队 → 静默忽略（不再产生定时器/队列任务）
    await s.enqueue(task({ id: 'post-stop', value: 1, estimated_cost: 1, run: async () => { ran.push('post-stop'); } }));
    const r = await s.tick();
    expect(r).toEqual({ ran: [], skipped: [] });
    const q = await s.requestQuantum();
    expect(q).toEqual({ ran: [], skipped: [] });
    expect(ran).toEqual([]); // 任务从未执行
    // start 不复活已停调度器（stop 语义为终态；幂等）
    s.start();
    const r2 = await s.tick();
    expect(r2).toEqual({ ran: [], skipped: [] });
    expect(ran).toEqual([]);
  });

  // ---- ⑧ 经调度跑 consolidation（M3 升级兼容） ----

  it('经调度跑 consolidation：M3 consolidate 经 scheduler.enqueue 入队 → requestQuantum 执行成功', async () => {
    const db = join(tmpRoot, 'memory.db');
    const b = new SqliteMemoryBackend(db);
    try {
      // 两条同内容记忆 → consolidation dedup 应冻结 1 条（证明批处理确实经调度执行）
      const m1 = makeMemory({ payload: '重复内容', updated: '2026-08-01T00:00:00.000Z' });
      const m2 = makeMemory({ payload: '重复内容', updated: '2026-08-20T00:00:00.000Z' });
      await b.ingest(m1);
      await b.ingest(m2);
      const s = mkScheduler();
      // 完整调度器直接满足 M3 最小接口：接口已收窄为 consolidate 实际使用的 enqueue 形状
      // （requestQuantum 报告形状不再被 M3 接口声明）→ 无 cast 接缝，直接传参。
      const p = consolidate(b, { now: Date.parse(TS), scheduler: s });
      const q = await s.requestQuantum();
      expect(q.ran).toEqual(['memory-consolidation']); // M3 形状任务 {id, run} 经完整调度器执行
      await p;
      const page = await b.query({ scope: 'Project', limit: 10, budget: 100 });
      expect(page.items.filter((m) => m.lifecycle === 'Frozen')).toHaveLength(1); // dedup 生效
      expect(s.debtSnapshot()).toEqual([]); // 成功执行 → 无债务
    } finally {
      await b.close();
    }
  });

  // ---- ⑨ 关停真正排空（已知问题《关停不是真正排空》） ----

  it('drain：等长任务真正跑完（不是只等 running 标志回落）——任务体完成前不返回', async () => {
    const s = mkScheduler();
    let done = false;
    await s.enqueue(
      task({
        id: 'long',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          done = true;
        },
      }),
    );
    const q = s.requestQuantum();
    s.stop(); // 关停：中断在飞 signal（任务体不检查 → 照跑到底）
    const d = await s.drain({ timeoutMs: 3000 });
    await q;
    expect(done).toBe(true); // 长任务体已真正结束（旧实现只轮询 running，可能提前返回）
    expect(d.drained).toBe(true);
    expect(s.isIdle).toBe(true);
  });

  it('drain：等待已发出的落盘写入（观测 JSONL/债务快照落完才算静默）', async () => {
    const s = mkScheduler();
    await s.enqueue(task({ id: 'quick', run: async () => {} }));
    await s.requestQuantum();
    // 任务已跑完，但观测/债务写入可能仍在飞——drain 必须等到它们落完
    const d = await s.drain({ timeoutMs: 3000 });
    expect(d.drained).toBe(true);
    expect(s.pendingWriteCount).toBe(0);
    expect(s.isIdle).toBe(true);
  });

  it('drain：任务体不检查 signal 且超时 → drained=false + 可读原因（不静默假称已排空）', async () => {
    const s = mkScheduler();
    await s.enqueue(
      task({
        id: 'stuck',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
        },
      }),
    );
    const q = s.requestQuantum();
    s.stop();
    const d = await s.drain({ timeoutMs: 50 });
    expect(d.drained).toBe(false);
    expect(d.reason ?? '').toMatch(/排空超时|在飞任务/);
    await q; // 收尾（避免悬挂）
  });

  it('idle()：静默点判据 = 无在飞任务 + 无在飞任务体 + 无待落盘写入', async () => {
    const s = mkScheduler();
    expect(s.isIdle).toBe(true);
    await s.idle(); // 已静默 → 立即返回（不挂起）
    await s.enqueue(task({ id: 'x', run: async () => {} }));
    expect(s.isIdle).toBe(true); // 有队列任务但未执行 → 仍属静默（无人写盘）
    await s.requestQuantum();
    expect(s.isIdle).toBe(true);
  });
});

// ---- ⑩ 观测摘要缓存（已知问题《观测摘要同步读当日日志》） ----

describe('观测摘要缓存（kern_status 可读入口不再每次同步读全文件）', () => {
  it('文件未变的重复调用命中缓存（读盘次数不再随调用次数增长）', async () => {
    const s = mkScheduler();
    await s.enqueue(task({ id: 'gc', value: 1, estimated_cost: 1, run: async () => {} }));
    await s.requestQuantum(); // 产生一条观测记录
    const first = await s.observationsSummaryAsync();
    expect(first.total).toBe(1);
    const stats1 = s.observationCacheStats();
    // 重复调用（文件未变）→ 全部命中缓存
    for (let i = 0; i < 25; i++) {
      const again = await s.observationsSummaryAsync();
      expect(again).toEqual(first);
    }
    const stats2 = s.observationCacheStats();
    expect(stats2.reads_avoided).toBeGreaterThanOrEqual(25);
    expect(stats2.cached).toBe(true);
    expect(stats2.reads_avoided).toBeGreaterThan(stats1.reads_avoided);
  });

  it('同步入口与异步入口共用缓存与口径（同一摘要对象，不产生两条分叉路径）', async () => {
    const s = mkScheduler();
    await s.enqueue(task({ id: 'gc', value: 1, estimated_cost: 1, run: async () => {} }));
    await s.requestQuantum();
    const a = await s.observationsSummaryAsync();
    const b = s.observationsSummary();
    expect(b).toEqual(a);
  });

  it('观测文件变化 → 缓存失效重新读取（摘要不陈旧）', async () => {
    const s = mkScheduler();
    const first = await s.observationsSummaryAsync();
    expect(first.total).toBe(0);
    // 追加一条观测（模拟维护任务落盘）→ 摘要必须反映新数据
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(tmpRoot, 'maintenance-observations');
    await writeFile(
      join(dir, `${date}.jsonl`),
      `${JSON.stringify({ ts: Date.now(), task_id: 'gc', duration_ms: 100, result: 'success', debt_before: 0, debt_after: 0 })}\n`,
      'utf8',
    ).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${date}.jsonl`),
        `${JSON.stringify({ ts: Date.now(), task_id: 'gc', duration_ms: 100, result: 'success', debt_before: 0, debt_after: 0 })}\n`,
        'utf8',
      );
    });
    const second = await s.observationsSummaryAsync();
    expect(second.total).toBe(1);
    expect(second.per_task[0]).toEqual({ task_id: 'gc', count: 1, avg_duration_ms: 100 });
  });
});

/** M1 Memory 工厂（T3.3 同款）：provenance.event 每次唯一（幂等键）；over 覆盖字段 */
function makeMemory(over: { payload: string; updated?: string }): Memory {
  const updated = over.updated ?? TS;
  return {
    ...base({ id: makeMutableId('memory'), schema: 'omb/M1' }),
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: updated,
    updated,
    provenance: { ...PROV, event: makeMutableId('evt'), timestamp: updated },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload: over.payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as unknown as Memory;
}
