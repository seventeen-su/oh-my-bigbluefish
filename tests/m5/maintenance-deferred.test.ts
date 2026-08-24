// R5（P0+P1）DeferredMaintenanceError 调度器级语义测试（supervisor/maintenance.ts；
// 评估依据 下一步说明.md 第十三节：未实现任务 return/throw 被当成功清债 = 假清债）。
// 覆盖：
//   ① Deferred（未实现/不可执行）→ 出队但债务保留（accrueDebt 任务不清零）+ deferredEvents 记录
//      + 不视为失败崩溃（队列继续，后续任务照常执行）
//   ② 真实失败（普通 Error）→ 债务保留但不进 deferredEvents（可观测性区分）
//   ③ 成功 → 清偿归零（对照）
//   ④ 非 accrueDebt 的 Deferred 任务 → 债务累计（与失败同语义：未完成 → debt 保留）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeferredMaintenanceError,
  MaintenanceScheduler,
  type MaintenanceTaskInput,
} from '../../supervisor/maintenance.js';

let tmpRoot: string;
const schedulers: MaintenanceScheduler[] = [];

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-r5-deferred-'));
});

afterEach(async () => {
  for (const s of schedulers.splice(0)) {
    s.stop();
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

function mkScheduler(): MaintenanceScheduler {
  const s = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json') });
  schedulers.push(s);
  return s;
}

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

describe('R5 DeferredMaintenanceError 清债语义（§13：未实现/未完成 → debt 保留，不假成功清债）', () => {
  it('Deferred → 出队但债务保留（不清零）+ deferredEvents 记录 + 队列继续（不视为失败崩溃）', async () => {
    const s = mkScheduler();
    const ran: string[] = [];
    // accrueDebt 入队（§10.1 事件入队即累计）→ 任务抛 Deferred（未实现）
    await s.enqueue(
      task({ id: 'deferred', value: 5, estimated_cost: 1, run: async () => { throw new DeferredMaintenanceError('候选管线未实现'); } }),
      { accrueDebt: true },
    );
    const r = await s.requestQuantum();
    expect(r.ran).toEqual(['deferred']); // 执行过（尝试）→ ran
    // 债务保留（不清零——不再是空实现假成功清债）
    const debt = s.debtSnapshot();
    expect(debt).toHaveLength(1);
    expect(debt[0]).toMatchObject({ task_id: 'deferred', value: 5 });
    // deferred 事件记录（可观测）
    expect(s.deferredEvents().map((e) => e.task_id)).toEqual(['deferred']);
    expect(s.deferredEvents()[0]!.reason).toContain('候选管线未实现');
    // 队列继续：后续任务照常执行（不视为失败崩溃）
    s.enqueue(task({ id: 'after', value: 1, estimated_cost: 1, run: async () => { ran.push('after'); } }));
    const r2 = await s.requestQuantum();
    expect(r2.ran).toEqual(['after']);
    expect(ran).toEqual(['after']);
  });

  it('真实失败（普通 Error）→ 债务保留但不进 deferredEvents；成功 → 清偿归零', async () => {
    const s = mkScheduler();
    await s.enqueue(
      task({ id: 'boom', value: 3, estimated_cost: 1, run: async () => { throw new Error('真实失败'); } }),
      { accrueDebt: true },
    );
    await s.requestQuantum();
    expect(s.debtSnapshot().map((d) => d.task_id)).toEqual(['boom']);
    expect(s.deferredEvents()).toEqual([]); // 真实失败不进 deferred 记录（可观测性区分）
    // 成功任务 → 清偿归零（对照）
    await s.enqueue(task({ id: 'ok', value: 2, estimated_cost: 1, run: async () => {} }), { accrueDebt: true });
    await s.requestQuantum();
    expect(s.debtSnapshot().map((d) => d.task_id)).toEqual(['boom']); // ok 已清偿，boom 保留
  });

  it('非 accrueDebt 的 Deferred 任务 → 债务累计（与失败同语义：未完成 → debt 保留）', async () => {
    const s = mkScheduler();
    await s.enqueue(
      task({ id: 'deferred-m3', value: 7, estimated_cost: 1, run: async () => { throw new DeferredMaintenanceError('旧布局不可执行'); } }),
    );
    await s.requestQuantum();
    const debt = s.debtSnapshot();
    expect(debt).toHaveLength(1);
    expect(debt[0]).toMatchObject({ task_id: 'deferred-m3', value: 7 });
    expect(s.deferredEvents().map((e) => e.task_id)).toEqual(['deferred-m3']);
  });
});
