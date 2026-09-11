// 维护调度修复行为测试（对应「维护定时器未启动」「单量子名额导致 ROI 饥饿」
// 「债务阈值未与策略接线」三条修复判定）：
//   ① 定时器启动：start() → 进程内 tick 真正消费队列（不只是计数）；stop() 后定时器不再触发
//   ② 批量消费消饥饿：高 ROI 收尾任务不再独占名额——同一 tick 内低 ROI 判定类任务也得到执行
//   ③ batchSize 语义：缺省 1 = 既有单量子；显式 >1 → 单次调用最多消费 N 个；硬上限截断
//   ④ 可中断：批量执行中 signal abort → 停止取新任务（不挂起）
//   ⑤ 债务阈值接线：setLimits 生效（soft 影响 tick 频率、hard 影响改动类任务跳过）+ limitsSnapshot
//   ⑥ 判定类任务不被自身存量债务锁死（保护语义保留：改动类仍受硬限约束）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CRITICAL_LIMIT,
  DEFAULT_HARD_LIMIT,
  DEFAULT_MAINTENANCE_BATCH,
  DEFAULT_SOFT_LIMIT,
  MAINTENANCE_BATCH_MAX,
  MaintenanceScheduler,
  type MaintenanceTaskInput,
} from '../../supervisor/maintenance.js';

let tmpRoot: string;
const schedulers: MaintenanceScheduler[] = [];

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-maint-sch-'));
});

afterEach(async () => {
  for (const s of schedulers.splice(0)) s.stop();
  vi.useRealTimers();
  await rm(tmpRoot, { recursive: true, force: true });
});

function mkScheduler(over: Partial<ConstructorParameters<typeof MaintenanceScheduler>[0]> = {}) {
  const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), ...over });
  schedulers.push(s);
  return s;
}

function task(over: Partial<MaintenanceTaskInput> & { id: string }): MaintenanceTaskInput {
  return { value: 1, estimated_cost: 1, priority: 0, urgency: 'normal', run: async () => {}, ...over };
}

const fail = async (): Promise<void> => {
  throw new Error('boom');
};

describe('维护定时器启动（修复「维护定时器未启动」）', () => {
  it('start() 后定时器真正消费队列（不只是 tick 计数）；stop() 后不再触发', async () => {
    vi.useFakeTimers();
    const s = mkScheduler({ tickIntervalMs: 1000 });
    const ran: string[] = [];
    s.start();
    s.enqueue(task({ id: 'w1', run: async () => { ran.push('w1'); } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual(['w1']); // 定时器把队列任务真正跑掉（未启动时此处为空）
    // stop 后不再触发新任务
    s.enqueue(task({ id: 'w2', run: async () => { ran.push('w2'); } }));
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toEqual(['w1']);
  });

  it('队列空时定时器零开销：tick 计数增长但不产生执行记录', async () => {
    vi.useFakeTimers();
    const s = mkScheduler({ tickIntervalMs: 1000 });
    s.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.tickCount).toBe(3);
  });
});

describe('批量消费消饥饿（修复「单量子名额导致 ROI 饥饿」）', () => {
  it('缺省批量 1：既有单量子语义不变（每次最多执行 1 个任务）', async () => {
    const s = mkScheduler();
    const ran: string[] = [];
    s.enqueue(task({ id: 'top', value: 10, run: async () => { ran.push('top'); } }));
    s.enqueue(task({ id: 'low', value: 1, estimated_cost: 2, run: async () => { ran.push('low'); } }));
    const r = await s.requestQuantum();
    expect(r.ran).toEqual(['top']);
    expect(ran).toEqual(['top']);
  });

  it('批量上限：一次 tick 连续消费多个任务（高 ROI 收尾任务不再独占名额，低 ROI 判定类任务同批执行）', async () => {
    const s = mkScheduler({ batchSize: 4 });
    const ran: string[] = [];
    // 复刻生产队形：会话收尾（ROI 1.0，value 1 / cost 1）+ 三个判定/检查类（ROI 0.5，value 1 / cost 2）
    s.enqueue(task({ id: 'turn-finalize:s1', value: 1, estimated_cost: 1, run: async () => { ran.push('finalize'); } }));
    s.enqueue(task({ id: 'evolution_decision', value: 1, estimated_cost: 2, run: async () => { ran.push('decision'); } }));
    s.enqueue(task({ id: 'promotion_check', value: 1, estimated_cost: 2, run: async () => { ran.push('promotion'); } }));
    s.enqueue(task({ id: 'environment_check', value: 1, estimated_cost: 2, run: async () => { ran.push('environment'); } }));
    const r = await s.tick();
    expect(r.ran).toEqual(['turn-finalize:s1', 'environment_check', 'evolution_decision', 'promotion_check']); // ROI 降序，同 ROI 按 id
    expect(ran).toEqual(['finalize', 'environment', 'decision', 'promotion']); // 全部真正执行（单量子时只有 finalize）
    expect(s.debtSnapshot()).toEqual([]); // 全部成功 → 无债务残留
  });

  it('批量上限截断：batchSize 超硬上限被截断，配置 0 视为 1', () => {
    const s = mkScheduler({ batchSize: 999 });
    expect(s.limitsSnapshot().batch_size).toBe(MAINTENANCE_BATCH_MAX);
    const s0 = mkScheduler({ batchSize: 0 });
    expect(s0.limitsSnapshot().batch_size).toBe(1);
  });

  it('批量执行可中断：signal abort → 停止取新任务，剩余任务留队', async () => {
    const s = mkScheduler({ batchSize: 8 });
    const ac = new AbortController();
    const ran: string[] = [];
    s.enqueue(task({
      id: 'first',
      value: 100,
      run: async () => {
        ran.push('first');
        ac.abort(); // 第一个任务执行中中断（模拟请求到达）
      },
    }));
    s.enqueue(task({ id: 'second', value: 1, run: async () => { ran.push('second'); } }));
    const r = await s.tick({ signal: ac.signal });
    expect(r.ran).toEqual(['first']);
    expect(ran).toEqual(['first']); // 中断后不再取新任务
    // 留队可重试
    const r2 = await s.tick();
    expect(r2.ran).toEqual(['second']);
  });

  it('生产批量缺省常量：批量 > 1（装配面据此消除饥饿）', () => {
    expect(DEFAULT_MAINTENANCE_BATCH).toBeGreaterThan(1);
    expect(DEFAULT_MAINTENANCE_BATCH).toBeLessThanOrEqual(MAINTENANCE_BATCH_MAX);
  });
});

describe('债务阈值接线（修复「债务阈值未与策略接线」）', () => {
  it('setLimits：阈值整体替换并即时生效（soft 影响 tick 频率）', async () => {
    vi.useFakeTimers();
    const s = mkScheduler({ tickIntervalMs: 1000 });
    // 缺省值 = 出厂缺省（与原先代码缺省一致）
    expect(s.limitsSnapshot()).toMatchObject({
      soft: DEFAULT_SOFT_LIMIT,
      hard: DEFAULT_HARD_LIMIT,
      critical: DEFAULT_CRITICAL_LIMIT,
      band: 'normal',
    });
    s.start();
    await vi.advanceTimersByTimeAsync(2000);
    const baseTicks = s.tickCount;
    // 注入策略阈值（soft 3 / hard 6 / critical 12）
    expect(s.setLimits({ soft: 3, hard: 6, critical: 12 })).toEqual([]);
    expect(s.limitsSnapshot()).toMatchObject({ soft: 3, hard: 6, critical: 12 });
    // 制造债务 4（≥ soft 3 且 < hard 6）→ 频率提升（间隔 1000ms → 500ms）
    s.enqueue(task({ id: 'd', value: 4, run: fail }));
    await s.requestQuantum();
    expect(s.limitsSnapshot()).toMatchObject({ total: 4, band: 'soft' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.tickCount - baseTicks).toBeGreaterThan(2);
  });

  it('setLimits：非法项丢弃并返回说明，其余项照常生效；soft>hard 记为非法', () => {
    const s = mkScheduler();
    const bad = s.setLimits({ soft: 5, hard: Number.NaN, critical: 20 });
    expect(bad).toContain('hard=NaN');
    expect(s.limitsSnapshot()).toMatchObject({ soft: 5, hard: DEFAULT_HARD_LIMIT, critical: 20 });
    const bad2 = s.setLimits({ soft: 30, hard: 10, critical: 40 });
    expect(bad2.some((b) => b.startsWith('soft(30)>hard(10)'))).toBe(true);
  });

  it('债务档位：total 依次跨 soft/hard/critical → band 逐级提升', async () => {
    const s = mkScheduler({ softLimit: 2, hardLimit: 4, criticalLimit: 6 });
    expect(s.limitsSnapshot().band).toBe('normal');
    s.enqueue(task({ id: 'd1', value: 2, run: fail }));
    await s.requestQuantum();
    expect(s.limitsSnapshot()).toMatchObject({ total: 2, band: 'soft' });
    s.enqueue(task({ id: 'd2', value: 2, run: fail }));
    await s.requestQuantum();
    expect(s.limitsSnapshot()).toMatchObject({ total: 4, band: 'hard' });
    // total 已达 hard → normal 任务被硬限跳过；critical 任务不受硬限约束 → 继续累计
    s.enqueue(task({ id: 'd3', value: 2, urgency: 'critical', run: fail }));
    await s.requestQuantum();
    expect(s.limitsSnapshot()).toMatchObject({ total: 6, band: 'critical' });
  });
});

describe('保护语义守恒（债务不得把检查/判定类任务自身锁死）', () => {
  it('hard 限下：改动类演化任务被跳过，检查/判定类仍可运行', async () => {
    const s = mkScheduler({ softLimit: 1, hardLimit: 2, criticalLimit: 100, batchSize: 8 });
    const ran: string[] = [];
    // 制造债务超硬限 + 队列中同时存在改动类与判定类任务
    s.enqueue(task({ id: 'debt', value: 6, run: fail }));
    await s.requestQuantum();
    expect(s.limitsSnapshot().band).toBe('hard'); // 6 ≥ hard(2) 且 < critical(100)
    s.enqueue(task({ id: 'candidate_validation', value: 1, run: async () => { ran.push('cv'); } }));
    s.enqueue(task({ id: 'repair', value: 1, run: async () => { ran.push('repair'); } }));
    s.enqueue(task({ id: 'evolution_decision', value: 1, run: async () => { ran.push('decision'); } }));
    s.enqueue(task({ id: 'promotion_check', value: 1, run: async () => { ran.push('promotion'); } }));
    s.enqueue(task({ id: 'verification_review', value: 1, run: async () => { ran.push('review'); } }));
    const r = await s.tick();
    // 改动类被硬限挡住（保护语义保留：不在带病状态下改版本线/改对象）
    expect(r.skipped).toContain('candidate_validation');
    expect(r.skipped).toContain('repair');
    // 检查/判定类照常执行（否则债务永远不会被诊断与清偿）
    expect(ran).toContain('decision');
    expect(ran).toContain('promotion');
    expect(ran).toContain('review');
    expect(ran).not.toContain('cv');
    expect(ran).not.toContain('repair');
  });
});
