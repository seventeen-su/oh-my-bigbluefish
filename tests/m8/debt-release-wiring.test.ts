// 债务释放的装配面接线测试（对应《债务是保护性自锁…》修复判定第 2–5 条）：
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
import type { VersionLayout } from '../../substrate/snapshot.js';
import { buildLayoutFixture, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];
/** 真布局 fixture（仅在需要"线快照含 kernel/policy"的用例里构造；afterEach 统一拆除） */
let layoutFx: LayoutFixture | null;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-debt-asm-'));
  root = join(base, '.omb');
  runtimes = [];
  layoutFx = null;
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  if (layoutFx !== null) {
    teardownLayoutFixture(layoutFx);
    layoutFx = null;
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

/**
 * 证据路由按来源子系统分流（已知问题《候选流水线借用 repair 的证据签字 / memory-vector、
 * memory-relation 无释放分支》）。三条锚点：
 *   ① `candidate-pipeline` **不借** repair 的签字——repair 跑完不放它的债；
 *   ② `memory-vector` / `memory-relation` 有**自己的**释放分支（旧实现落 default → 永不放行，
 *      债务永久滞留并占用硬限额度）；
 *   ③ 各自的释放依据来自各自子系统的真实状态（编码缺口清零 / 稀疏门已满足），不是别人代签。
 */
describe('债务释放证据按来源子系统分流', () => {
  it('candidate-pipeline 不借 repair 签字：repair 跑完不放候选管线的债', async () => {
    await seedDebt([
      {
        task_id: 'candidate_validation',
        value: 8,
        accumulated_at: PAST,
        priority: 0,
        estimated_cost: 10,
        urgency: 'soft',
        subsystem: 'candidate-pipeline',
        reason: '候选待生成与验证',
      },
    ]);
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    const rt = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    await rt.ready();
    // repair 执行体跑完（repair-chain 自检通过）——但候选管线一次都没跑过
    await rt.runRepair();
    const r = await rt.runDebtRelease({ reviewed_by: 'test:candidate-signing' });
    expect(r.released).toEqual([]); // 修了 repair 不能替候选管线签字
    expect(r.kept.map((k) => k.task_id)).toEqual(['candidate_validation']);
    expect(scheduler.debtSnapshot().map((d) => d.task_id)).toEqual(['candidate_validation']);
  });

  it('candidate-pipeline 自证放行：候选管线真实跑完 → 该子系统债务按自己的回执释放', async () => {
    // 真布局 fixture（候选管线的前置：线快照含 kernel/policy）——旧布局下执行体会 Deferred，不产回执
    const fx = buildLayoutFixture();
    layoutFx = fx;
    const layout: VersionLayout = { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
    const fxRoot = join(fx.root, 'workspace', '.omb');
    await mkdir(join(fxRoot, '.evolution'), { recursive: true });
    await writeFile(
      join(fxRoot, '.evolution', 'debt.json'),
      JSON.stringify([
        {
          task_id: 'candidate_validation',
          value: 8,
          accumulated_at: Date.now() - 60_000,
          priority: 0,
          estimated_cost: 10,
          urgency: 'soft',
          subsystem: 'candidate-pipeline',
          reason: '候选待生成与验证',
        },
      ]),
      'utf8',
    );
    const scheduler = new MaintenanceScheduler({ debtFile: join(fxRoot, '.evolution', 'debt.json') });
    const rt = track(createCognitiveRuntime({ root: fxRoot, layout, maintenance: scheduler }));
    await rt.ready();
    // 候选管线执行体跑完（无触发信号 → 0 候选也是真实跑完：它回答了"这条债对应的事做了没"）
    await rt.runCandidateValidation('sess-cand');
    expect(rt.candidatePipelineRun()).not.toBeNull();
    const r = await rt.runDebtRelease({ reviewed_by: 'test:candidate-self' });
    expect(r.released.map((x) => x.task_id)).toEqual(['candidate_validation']);
    expect(r.released[0]!.evidence).toMatch(/候选管线自行跑完/);
    expect(r.released[0]!.evidence).toMatch(/非 repair 代签/);
  });

  it('memory-vector 有释放分支：编码缺口清零才放行，仍有缺口则保留', async () => {
    await seedDebt([
      {
        task_id: 'memory_vector_encode',
        value: 2,
        accumulated_at: Date.now() - 60_000,
        priority: 0,
        estimated_cost: 2,
        urgency: 'normal',
        subsystem: 'memory-vector',
        reason: '存在未编码记忆',
      },
    ]);
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    const rt = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    await rt.ready();
    // 未跑过编码执行体 → 不放行（证据必须来自该子系统自己）
    const cold = await rt.runDebtRelease();
    expect(cold.released).toEqual([]);
    expect(cold.kept.map((k) => k.task_id)).toEqual(['memory_vector_encode']);
    // 编码执行体跑完（空库 → 缺口本就是 0）→ 缺口清零 → 放行
    await rt.runVectorEncode();
    const r = await rt.runDebtRelease({ reviewed_by: 'test:vector' });
    expect(r.released.map((x) => x.task_id)).toEqual(['memory_vector_encode']);
    expect(r.released[0]!.evidence).toMatch(/编码缺口清零/);
  });

  it('memory-relation 有释放分支：稀疏门已满足才放行（图仍稀疏 → 保留）', async () => {
    await seedDebt([
      {
        task_id: 'memory_relation_build',
        value: 2,
        accumulated_at: Date.now() - 60_000,
        priority: 0,
        estimated_cost: 2,
        urgency: 'normal',
        subsystem: 'memory-relation',
        reason: '关系图稀疏',
      },
    ]);
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    const rt = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    await rt.ready();
    // 关系建图执行体跑完：库小（memories < 门限）→ 稀疏门已满足 → 放行
    await rt.runRelationBuild();
    const r = await rt.runDebtRelease({ reviewed_by: 'test:relation' });
    expect(r.released.map((x) => x.task_id)).toEqual(['memory_relation_build']);
    expect(r.released[0]!.evidence).toMatch(/稀疏门已满足/);
  });
});
