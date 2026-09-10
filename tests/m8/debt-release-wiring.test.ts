// 债务释放的装配面接线测试（对应 docs/known-issues.md《债务是保护性自锁…》修复判定第 2–5 条）：
//   - 组合根 runDebtRelease：来源子系统自检通过 → 按条释放；无主债务 → 待人工裁决清单（不清除）
//   - 维护任务执行后「确认 → 释放」自动接线（memory_consolidation 跑完 → 该子系统债务被释放）
//   - 状态面暴露债务来源/释放审计/阈值档位（回答「为什么停下来了」）
// fixture：mkdtemp 临时 root；预写 debt.json 模拟跨重启的历史欠债。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-debt-asm-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

const PAST = Date.parse('2026-08-25T00:00:00.000Z');

/** 预写债务文件（模拟跨重启的历史欠债；debt.json 落 <root>/.evolution/） */
async function seedDebt(rows: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(join(root, '.evolution'), { recursive: true });
  await writeFile(join(root, '.evolution', 'debt.json'), JSON.stringify(rows), 'utf8');
}

describe('组合根债务释放（修复 → 确认 → 释放）', () => {
  it('子系统自检通过才释放；无主债务保留并进入人工裁定清单', async () => {
    // 历史欠债：① 带来源（memory-consolidation）② 无主（长年无来源）
    await seedDebt([
      {
        task_id: 'memory_consolidation',
        value: 4,
        accumulated_at: PAST,
        priority: 0,
        estimated_cost: 4,
        urgency: 'normal',
        subsystem: 'memory-consolidation',
        reason: '经验待整合',
      },
      {
        task_id: 'candidate_validation',
        value: 12,
        accumulated_at: PAST,
        priority: 0,
        estimated_cost: 10,
        urgency: 'soft',
      },
    ]);
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    const rt = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    await rt.ready();
    expect(scheduler.debtSnapshot().map((d) => d.task_id)).toEqual(['candidate_validation', 'memory_consolidation']);

    // ① 未跑自检 → 不释放（绝不周期清除）
    const cold = await rt.runDebtRelease();
    expect(cold.released).toEqual([]);
    expect(cold.kept.map((k) => k.task_id)).toEqual(['memory_consolidation']);
    expect(scheduler.debtSnapshot()).toHaveLength(2);

    // ② 记忆整合执行体成功跑完 → 自检通过 → 按条释放该子系统债务
    await rt.runMemoryConsolidation();
    const r = await rt.runDebtRelease({ reviewed_by: 'test:release' });
    expect(r.released.map((x) => x.task_id)).toEqual(['memory_consolidation']);
    expect(r.released[0]).toMatchObject({ subsystem: 'memory-consolidation', released_by: 'test:release' });
    expect(r.released[0]!.evidence).toContain('记忆整合执行体成功跑完');

    // ③ 无主债务不被释放（保护语义：无主 → 人工裁定，不自动清除）
    expect(scheduler.debtSnapshot().map((d) => d.task_id)).toEqual(['candidate_validation']);
    expect(r.manual_pending.map((d) => d.task_id)).toEqual(['candidate_validation']);
  });

  it('维护任务执行后自动接线「确认 → 释放」（memory_consolidation 任务跑完即释放其子系统债务）', async () => {
    await seedDebt([
      {
        task_id: 'memory_consolidation',
        value: 4,
        accumulated_at: PAST,
        priority: 0,
        estimated_cost: 4,
        urgency: 'normal',
        subsystem: 'memory-consolidation',
        reason: '经验待整合',
      },
    ]);
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    const rt = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    await rt.ready();
    // 经维护任务路径执行（维护量子 → memory_consolidation 执行体 → 成功 → 标记子系统健康）
    await scheduler.enqueue({ id: 'memory_consolidation', run: () => rt.runMemoryConsolidation() });
    const report = await scheduler.requestQuantum();
    expect(report.ran).toEqual(['memory_consolidation']);
    // 任务成功 → 自身债务清偿；释放流程随修复一并执行（此处没有其它来源债务 → 审计为空）
    expect(scheduler.debtSnapshot()).toEqual([]);
  });

  it('状态面暴露债务来源、释放审计与阈值档位', async () => {    await seedDebt([
      {
        task_id: 'repair',
        value: 20,
        accumulated_at: PAST,
        priority: 0,
        estimated_cost: 25,
        urgency: 'soft',
        subsystem: 'repair-chain',
        reason: '受影响对象需重验证',
      },
    ]);
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    const rt = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    await rt.ready();
    // 释放前：状态面看得到来源（回答「这条债是哪来的」）
    const before = await rt.status();
    expect(before.debt_sources?.map((d) => d.task_id)).toEqual(['repair']);
    expect(before.debt_sources?.[0]).toMatchObject({ subsystem: 'repair-chain', value: 20, evolution_mutating: true });
    expect(before.debt_release_audit).toEqual([]);
    // 修复链自检：repair 执行体成功跑完（无 decay 记录 → 合法完成）→ 确认 → 释放
    await rt.runRepair();
    await rt.runDebtRelease();
    const after = await rt.status();
    expect(after.debt_sources).toEqual([]); // 已释放
    expect(after.debt_release_audit.map((a) => a.task_id)).toEqual(['repair']);
    expect(after.debt_release_audit[0]!.evidence.length).toBeGreaterThan(0);
    expect(after.debt_limits).toMatchObject({ soft: 10, hard: 50, critical: 100, band: 'normal' });
  });
});
