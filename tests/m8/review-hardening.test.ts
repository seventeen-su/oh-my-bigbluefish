// 审查加固回归（运行时接线，防复发）：
//   ① 累计口径信号不得跨轮相加（summarizeSignals：cumulative → 取最大值）
//   ② 验证债务复核任务在生产中有**入队路径**（此前只有执行体 → S2 闭环断在消费端）
//   ③ close() 先停维护定时器并排空在飞任务（不再出现"库已关而任务仍在写"）
//   ④ 记录降级日志有上限（不再无界增长）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeSignals } from '../../kernel/evolve-decision.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { DEGRADATION_LOG_LIMIT, clearDegradations, degradationLog, recordDegradation } from '../../runtime/loop-hooks.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-rt-hard-'));
  root = join(base, '.omb');
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await rm(base, { recursive: true, force: true, maxRetries: 3 });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

function record(kind: string, count: number, cumulative: boolean, ts: number): unknown {
  return { ts, kind, payload: { layer: 'L1', count, target: 't', cumulative } };
}

describe('① 信号聚合口径', () => {
  it('cumulative 记录取最大值；增量记录照常累加', () => {
    const records = [
      record('scope_recorded', 22, true, 1),
      record('scope_recorded', 22, true, 2),
      record('scope_recorded', 22, true, 3),
      record('scope_hit', 4, false, 1),
      record('scope_hit', 4, false, 2),
    ];
    const s = summarizeSignals(records as never);
    expect(s.counts.scope_recorded).toBe(22); // 40 轮 × 22 不再放大成 880
    expect(s.counts.scope_hit).toBe(8);
  });
});

describe('② 验证债务复核入队路径', () => {
  it('存在待复核债务 → 收尾入队 verification_review → 量子执行后债务清偿', async () => {
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    const rt = track(
      createCognitiveRuntime({
        root,
        maintenance: scheduler,
        judgeExecutor: {
          available: true,
          judge: async () => ({ verdict: 'PASS', detail: 'fake judge' }),
        } as never,
      }),
    );
    // 直接写入一条 shadow 验证债务（生产由 writeShadowOutcome 产生），再走一次收尾入队
    await rt.verificationDebt.enqueue({
      key: 'shadow:test-session',
      kind: 'shadow',
      contract_id: 'c:test',
      materials: { goal: 'g', success_criteria: ['c'] },
    } as never);
    expect((await rt.verificationDebt.listPending(1)).length).toBeGreaterThan(0);

    const workingState = {
      id: 'ws:sess-ver',
      goal: 'g',
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: [],
      next_best_action: '',
      environment: 'test',
    };
    await rt.prepareTurn({
      session_id: 'sess-ver',
      messages: [{ role: 'user', content: '验证契约的边界说明' }],
      goal: 'g',
      success_criteria: ['c'],
      working_state: workingState,
    } as never);
    await rt.finalizeTurn({
      session_id: 'sess-ver',
      decision: {
        decision: 'Verify',
        reason: 'review hardening',
        budget_allocation: { depth: 1, breadth: 1, tools: 1, retrieval: 1, branches: 1, context: 1 },
        expected_gain: 0.5,
        snapshot: 'rs:test',
      } as never,
      working_state: workingState as never,
    });
    // 生产入队点（此前 verification_review 只有执行体、无任何入队路径）——批量消费逐个跑
    const ran: string[] = [];
    for (let i = 0; i < 15; i++) {
      const q = await scheduler.requestQuantum();
      ran.push(...q.ran);
      if (ran.includes('verification_review')) break;
    }
    expect(ran).toContain('verification_review');
    expect((await rt.verificationDebt.listPending(5)).length).toBe(0); // PASS → resolved
    scheduler.stop();
  });
});

describe('③ 关闭顺序与降级日志上界', () => {
  it('close() 可重复调用（幂等 + 先停表排空）', async () => {
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') });
    scheduler.start();
    const rt = createCognitiveRuntime({ root, maintenance: scheduler });
    await rt.close();
    await rt.close(); // 幂等
    expect(scheduler.debtSnapshot()).toEqual([]); // 关闭后无在飞写入产生的虚假债务
    runtimes = runtimes.filter((r) => r !== rt);
  });

  it('降级日志环形保留最近 N 条，且同一条连续重复只记一次', () => {
    recordDegradation('hook/a', 'same');
    recordDegradation('hook/a', 'same'); // 连续重复 → 不追加
    expect(degradationLog()).toHaveLength(1);
    for (let i = 0; i < DEGRADATION_LOG_LIMIT + 50; i++) {
      recordDegradation('hook/b', `r-${i}`);
    }
    expect(degradationLog().length).toBeLessThanOrEqual(DEGRADATION_LOG_LIMIT);
    expect(degradationLog()[degradationLog().length - 1]?.reason).toBe(`r-${DEGRADATION_LOG_LIMIT + 49}`);
  });
});
