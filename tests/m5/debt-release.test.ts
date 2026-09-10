// 债务「修复 → 确认 → 释放」行为测试（对应 docs/known-issues.md《债务是保护性自锁，需要"修复后释放"
// 而不是"定时清除"》修复判定第 1–5 条）：
//   ① 债务带来源记录：入账即带 subsystem/reason；首见时间跨多次累计保持不变、最近失败时间更新
//   ② 修复后按条释放：只有来源子系统自检通过才释放；subsystem 不匹配 → 拒绝（不误释放别人的债）
//   ③ 释放留审计：每次释放落 debt-releases.jsonl（依据/触发者/时间/释放前累计值），可回溯
//   ④ 无主债务进人工裁定：无来源子系统的历史条目 → manualPendingDebt 列出，**不做自动清除**
//   ⑤ 与硬限策略解耦：改动类演化任务（candidate_validation/repair）仍受硬限；检查/判定类不被自身
//      存量债务锁死（保护语义保留——见 maintenance-scheduling.test.ts 的同名断言）
//   ⑥ 绝不周期清除：只读访问（debtSourceView / manualPendingDebt）不改变债务；无自检则不释放
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEBT_MANUAL_REVIEW_AFTER_MS,
  MaintenanceScheduler,
  type MaintenanceTaskInput,
} from '../../supervisor/maintenance.js';

let tmpRoot: string;
const schedulers: MaintenanceScheduler[] = [];
let nowMs = 1_700_000_000_000;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-debt-'));
  nowMs = 1_700_000_000_000;
});

afterEach(async () => {
  for (const s of schedulers.splice(0)) s.stop();
  await rm(tmpRoot, { recursive: true, force: true });
});

function mkScheduler(over: Partial<ConstructorParameters<typeof MaintenanceScheduler>[0]> = {}) {
  const s = new MaintenanceScheduler({
    debtFile: join(tmpRoot, 'debt.json'),
    now: () => nowMs,
    ...over,
  });
  schedulers.push(s);
  return s;
}

function task(over: Partial<MaintenanceTaskInput> & { id: string }): MaintenanceTaskInput {
  return { value: 1, estimated_cost: 1, priority: 0, urgency: 'normal', run: async () => {}, ...over };
}

/** 预写债务文件（模拟历史条目 / 跨重启恢复） */
async function writeDebt(rows: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(join(tmpRoot, 'debt.json'), JSON.stringify(rows), 'utf8');
}

describe('① 债务带来源记录', () => {
  it('入账写入 subsystem/reason；多次累计保持 first_seen、更新 last_failure', async () => {
    const s = mkScheduler();
    s.enqueue(task({
      id: 'repair',
      value: 5,
      subsystem: 'repair-chain',
      reason: '修正/复现失败信号——受影响对象需重验证',
      run: async () => { throw new Error('boom'); },
    }));
    await s.requestQuantum();
    const [first] = s.debtSourceView();
    expect(first).toMatchObject({
      task_id: 'repair',
      value: 5,
      subsystem: 'repair-chain',
      reason: '修正/复现失败信号——受影响对象需重验证',
      orphan: false,
      manual_pending: false,
      evolution_mutating: true,
    });
    // 时间推进后再失败一次 → value 累加、first_seen 不变、last_failure 前进
    nowMs += 60_000;
    s.enqueue(task({
      id: 'repair',
      value: 5,
      subsystem: 'repair-chain',
      reason: '修正/复现失败信号——受影响对象需重验证',
      run: async () => { throw new Error('boom'); },
    }));
    await s.requestQuantum();
    const [second] = s.debtSourceView();
    expect(second!.value).toBe(10);
    expect(second!.first_seen).toBe(first!.first_seen);
    expect(second!.last_failure).toBe(nowMs);
  });

  it('历史条目（无来源记录）加载后标为无主；超过人工裁定阈值 → manual_pending', async () => {
    await writeDebt([
      // 无 subsystem 的历史条目：30 天前首见 → 进人工裁定清单
      {
        task_id: 'candidate_validation',
        value: 33,
        accumulated_at: nowMs - 30 * 24 * 60 * 60 * 1000,
        priority: 0,
        estimated_cost: 10,
        urgency: 'soft',
      },
    ]);
    const s = mkScheduler();
    const [view] = s.debtSourceView();
    expect(view).toMatchObject({ task_id: 'candidate_validation', value: 33, subsystem: null, orphan: true });
    expect(view!.first_seen).toBe(nowMs - 30 * 24 * 60 * 60 * 1000);
    expect(view!.manual_pending).toBe(true);
    expect(s.manualPendingDebt().map((d) => d.task_id)).toEqual(['candidate_validation']);
    // 读访问不改变债务（绝不周期清除）
    expect(s.debtSnapshot()).toHaveLength(1);
  });

  it('无主但未超人工裁定阈值 → 只标 orphan，不进待裁定清单', async () => {
    await writeDebt([
      {
        task_id: 'evolution_decision',
        value: 33,
        accumulated_at: nowMs - 1000,
        priority: 0,
        estimated_cost: 2,
        urgency: 'normal',
      },
    ]);
    const s = mkScheduler();
    const [view] = s.debtSourceView();
    expect(view!.orphan).toBe(true);
    expect(view!.manual_pending).toBe(false);
    expect(s.manualPendingDebt()).toEqual([]);
    expect(DEBT_MANUAL_REVIEW_AFTER_MS).toBeGreaterThan(0);
  });
});

describe('② 修复后按条释放', () => {
  it('自检通过 → 按条释放并落审计；subsystem 不匹配 → 拒绝释放', async () => {
    const s = mkScheduler();
    // 制造一条带来源的债务
    s.enqueue(task({
      id: 'memory_consolidation',
      value: 4,
      subsystem: 'memory-consolidation',
      reason: '经验待整合',
      run: async () => { throw new Error('boom'); },
    }));
    await s.requestQuantum();
    expect(s.debtSnapshot()).toHaveLength(1);
    // 子系统不匹配 → 拒绝（不误释放别人的债）
    const wrong = await s.releaseDebt({
      taskId: 'memory_consolidation',
      expectedSubsystem: 'repair-chain',
      evidence: 'wrong',
      releasedBy: 'test',
    });
    expect(wrong.released).toBe(false);
    expect(wrong.reason).toBe('subsystem_mismatch:memory-consolidation!=repair-chain');
    expect(s.debtSnapshot()).toHaveLength(1); // 债仍在
    // 正确的子系统 + 自检依据 → 释放
    const ok = await s.releaseDebt({
      taskId: 'memory_consolidation',
      expectedSubsystem: 'memory-consolidation',
      evidence: 'staging 整合跑完，无待整合条目',
      releasedBy: 'maintenance:runRepair',
    });
    expect(ok).toMatchObject({ released: true, task_id: 'memory_consolidation', value: 4 });
    expect(s.debtSnapshot()).toEqual([]);
    // 未知 task → no_debt（幂等：重复释放不报错）
    const again = await s.releaseDebt({
      taskId: 'memory_consolidation',
      expectedSubsystem: 'memory-consolidation',
      evidence: 'x',
      releasedBy: 'test',
    });
    expect(again).toMatchObject({ released: false, reason: 'no_debt' });
  });

  it('释放留审计：debt-releases.jsonl 记录依据/触发者/时间/释放前累计值', async () => {
    const s = mkScheduler();
    s.enqueue(task({
      id: 'repair',
      value: 20,
      subsystem: 'repair-chain',
      reason: '受影响对象需重验证',
      run: async () => { throw new Error('boom'); },
    }));
    await s.requestQuantum();
    await s.releaseDebt({
      taskId: 'repair',
      expectedSubsystem: 'repair-chain',
      evidence: 'repair 审计记录全部 PASS',
      releasedBy: 'maintenance:runRepair',
    });
    const audit = s.debtReleaseAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      task_id: 'repair',
      value: 20,
      subsystem: 'repair-chain',
      evidence: 'repair 审计记录全部 PASS',
      released_by: 'maintenance:runRepair',
      ts: nowMs,
    });
    // 落盘可回溯
    const file = s.debtReleaseLogFile;
    expect(existsSync(file)).toBe(true);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ task_id: 'repair', released_by: 'maintenance:runRepair' });
  });

  it('释放后债务文件同步更新（重启恢复不再见到已释放条目）', async () => {
    const s = mkScheduler();
    s.enqueue(task({
      id: 'environment_check',
      value: 2,
      subsystem: 'environment-check',
      run: async () => { throw new Error('boom'); },
    }));
    await s.requestQuantum();
    await s.releaseDebt({
      taskId: 'environment_check',
      expectedSubsystem: 'environment-check',
      evidence: '环境检查跑完',
      releasedBy: 'test',
    });
    const s2 = new MaintenanceScheduler({ debtFile: join(tmpRoot, 'debt.json'), now: () => nowMs });
    schedulers.push(s2);
    expect(s2.debtSnapshot()).toEqual([]);
  });
});

describe('⑥ 绝不周期清除（保护语义边界）', () => {
  it('仅读访问与多次量子执行都不会清掉未确认的债务', async () => {
    const s = mkScheduler({ batchSize: 4 });
    s.enqueue(task({
      id: 'candidate_validation',
      value: 8,
      subsystem: 'candidate-pipeline',
      run: async () => { throw new Error('boom'); },
    }));
    await s.requestQuantum();
    for (let i = 0; i < 5; i++) {
      s.debtSourceView();
      s.manualPendingDebt();
      s.limitsSnapshot();
      await s.tick();
    }
    expect(s.debtSnapshot().map((d) => d.task_id)).toEqual(['candidate_validation']);
    expect(s.debtSnapshot()[0]!.value).toBe(8); // 未被跳过路径重复累计、也未被清除
  });
});

describe('⑤ 与硬限策略解耦', () => {
  it('硬限下：改动类债务可被释放，但改动类任务本身仍被硬限拦住（保护语义保留）', async () => {
    const s = mkScheduler({ softLimit: 1, hardLimit: 2, criticalLimit: 100, batchSize: 8 });
    const ran: string[] = [];
    // 制造超硬限债务（改动类来源）
    s.enqueue(task({
      id: 'repair',
      value: 6,
      subsystem: 'repair-chain',
      run: async () => { throw new Error('boom'); },
    }));
    await s.requestQuantum();
    expect(s.limitsSnapshot().band).toBe('hard');
    // 改动类任务在硬限下仍被跳过
    s.enqueue(task({ id: 'candidate_validation', value: 1, run: async () => { ran.push('cv'); } }));
    const r = await s.tick();
    expect(r.skipped).toContain('candidate_validation');
    expect(ran).toEqual([]);
    // 但修复确认后可按条释放该债务 → 硬限随之解除（不是「定时清除」，而是「修好才放」）
    const rel = await s.releaseDebt({
      taskId: 'repair',
      expectedSubsystem: 'repair-chain',
      evidence: 'repair 全部 PASS',
      releasedBy: 'test',
    });
    expect(rel.released).toBe(true);
    expect(s.limitsSnapshot().band).toBe('normal');
    const r2 = await s.tick();
    expect(r2.ran).toContain('candidate_validation');
  });
});
