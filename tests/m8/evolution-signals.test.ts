// P1c 行为测试：演化信号落盘 + evolve.policy 数据化判定 + MaintenanceDebt 生产路径
// （架构 §6.5.1 触发链 / §6.5.7 维护债务 / 实现规格 §10.1 权重语义）。
// 覆盖：
//   ① signals 落盘：追加写 .evolution/signals/<yyyy-mm-dd>.jsonl、JSONL 每行可解析、幂等建目录
//   ② readSignals 往返一致 + 损坏行跳过计数 + 目录缺失安全降级
//   ③ evolve.policy schema：真实 evolve.yaml 过校验；旧形状（§9.5 三字段）经缺省合法；非法值 fail-loud
//   ④ 判定纯函数：确定性（同输入同输出）；corrections 触发 → L1/strength 0.9；无触发不演化；
//      债务 ≥ hard → 限制非必要演化
//   ⑤ 债务权重映射：repair+20/candidate+8/memory+2/gc+1；priority = EV/C × debt
//   ⑥ 生产路径：finalizeTurn 信号 → §10.1 债务入队累计 → debt.json 落盘 → quantum 清偿归零
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { fallbackFinalizeDecision, fallbackWorkingState } from '../../runtime/loop-hooks.js';
import { appendSignals, readSignals, signalFileName } from '../../runtime/evolution-signals.js';
import { makeRuntimeEvent } from '../../runtime/turn-helpers.js';
import {
  candidateValidationAccrual,
  decideEvolution,
  debtAccrualsFromSummary,
  summarizeSignals,
} from '../../kernel/evolve-decision.js';
import { EvolvePolicySchema, loadPolicy } from '../../kernel/policy-loader.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import type { SignalRecord } from '../../kernel/schemas/evolution.js';

const REPO_POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const SESSION = 'sess-p1c-1';

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-p1c-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

// ---- ① signals 落盘 ----

describe('① signals 落盘（§6.5.1 → .evolution/signals/ JSONL）', () => {
  it('追加写 <dir>/<yyyy-mm-dd>.jsonl；幂等建目录；JSONL 每行一个信号对象 {ts, kind, session_id?, payload}', async () => {
    const dir = join(base, 'signals');
    const ts = Date.UTC(2026, 7, 23, 10, 0, 0); // 2026-08-23
    const r1: SignalRecord = { ts, kind: 'tool_calls', session_id: 's1', payload: { count: 2 } };
    const r2: SignalRecord = { ts, kind: 'corrections', session_id: 's1', payload: { count: 1 } };
    const a1 = await appendSignals(dir, [r1]); // 目录不存在 → 幂等建目录
    expect(a1.appended).toBe(1);
    const file = join(dir, signalFileName(ts));
    expect(existsSync(file)).toBe(true);
    // 追加（同文件追加，不覆盖）
    await appendSignals(dir, [r2]);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(typeof obj.ts).toBe('number');
      expect(typeof obj.kind).toBe('string');
      expect(obj.session_id).toBe('s1');
    }
    // 空输入 → 零写入（不建文件）
    const empty = await appendSignals(join(base, 'nope'), []);
    expect(empty.appended).toBe(0);
    expect(existsSync(join(base, 'nope'))).toBe(false);
  });

  it('readSignals 往返一致；损坏行跳过计数；目录缺失 → 空安全', async () => {
    const dir = join(base, 'signals2');
    const ts = Date.UTC(2026, 7, 23);
    await appendSignals(dir, [
      { ts, kind: 'tool_calls', payload: { count: 1 } },
      { ts, kind: 'corrections', payload: { count: 2 } },
    ]);
    const r1 = await readSignals(dir, { day: signalFileName(ts) });
    expect(r1.records.map((r) => r.kind)).toEqual(['tool_calls', 'corrections']);
    expect(r1.skipped).toBe(0);
    // 损坏行（非法 JSON）→ skipped 计数，合法行照常
    await appendFile(join(dir, signalFileName(ts)), '{bad json}\n', 'utf8');
    const r2 = await readSignals(dir, { day: signalFileName(ts) });
    expect(r2.records).toHaveLength(2);
    expect(r2.skipped).toBe(1);
    // 目录/文件缺失 → 空 + 0 skipped（判定安全降级）
    const r3 = await readSignals(join(base, 'missing'));
    expect(r3.records).toEqual([]);
    expect(r3.skipped).toBe(0);
  });
});

// ---- ③ evolve.policy schema ----

describe('③ evolve.policy schema（数据化判定；fail-loud）', () => {
  it('真实 evolve.yaml 过 EvolvePolicySchema（signal_triggers/debt_thresholds 齐备）', async () => {
    const p = await loadPolicy(REPO_POLICY_DIR);
    expect(p.evolve.signal_triggers['corrections']).toEqual({ evolve: true, strength: 0.9, object_layer: 'L1' });
    expect(p.evolve.signal_triggers['tool_calls']).toEqual({ evolve: false, strength: 0.0, object_layer: 'L0' });
    expect(p.evolve.debt_thresholds).toEqual({ soft: 10, hard: 50, critical: 100 });
    expect(p.evolve.daily_evolution_cost).toBeGreaterThan(0);
  });

  it('旧形状（仅 §9.5 三字段）经缺省合法——元演化门禁 T7.2 向后兼容', () => {
    const r = EvolvePolicySchema.safeParse({ daily_evolution_cost: 100, roi_min: 1.0, maintenance_rate: 0.5 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.signal_triggers).toEqual({});
      expect(r.data.debt_thresholds).toEqual({ soft: 10, hard: 50, critical: 100 });
    }
  });

  it('非法 evolve.policy 拒绝（fail-loud）：strength>1 / 负债务阈值', () => {
    expect(
      EvolvePolicySchema.safeParse({
        daily_evolution_cost: 100,
        roi_min: 1.0,
        maintenance_rate: 0.5,
        signal_triggers: { corrections: { evolve: true, strength: 1.5, object_layer: 'L1' } },
      }).success,
    ).toBe(false);
    expect(
      EvolvePolicySchema.safeParse({
        daily_evolution_cost: 100,
        roi_min: 1.0,
        maintenance_rate: 0.5,
        debt_thresholds: { soft: -1, hard: 50, critical: 100 },
      }).success,
    ).toBe(false);
    expect(
      EvolvePolicySchema.safeParse({
        daily_evolution_cost: 100,
        roi_min: 1.0,
        maintenance_rate: 1.5, // >1 越界
      }).success,
    ).toBe(false);
  });
});

// ---- ④ 判定纯函数 ----

describe('④ 演化判定纯函数（§6.5.1：信号摘要 + 策略 → 确定性输出）', () => {
  it('确定性：同输入同输出；corrections 触发 → should_evolve + L1 + strength 0.9', async () => {
    const policy = await loadPolicy(REPO_POLICY_DIR);
    const summary = { window: { from: 0, to: 1 }, counts: { corrections: 3, tool_calls: 5 } };
    const d1 = decideEvolution({ summary, policy: policy.evolve });
    const d2 = decideEvolution({ summary, policy: policy.evolve });
    expect(d2).toEqual(d1);
    expect(d1.should_evolve).toBe(true);
    expect(d1.strength).toBe(0.9);
    expect(d1.object_layer).toBe('L1');
    expect(d1.triggers.map((t) => t.kind)).toEqual(['corrections']); // tool_calls evolve:false 不触发
    expect(d1.budget_estimate).toBeGreaterThan(0);
    expect(d1.reason).toMatch(/trigger:corrections/);
  });

  it('无触发 → 不演化（should_evolve false, strength 0）', async () => {
    const policy = await loadPolicy(REPO_POLICY_DIR);
    const d = decideEvolution({ summary: { window: { from: 0, to: 0 }, counts: {} }, policy: policy.evolve });
    expect(d.should_evolve).toBe(false);
    expect(d.strength).toBe(0);
    expect(d.budget_estimate).toBe(0);
    // 正向信号（evolve:false 条目）也不触发
    const d2 = decideEvolution({
      summary: { window: { from: 0, to: 1 }, counts: { tool_calls: 9, hits: 3 } },
      policy: policy.evolve,
    });
    expect(d2.should_evolve).toBe(false);
  });

  it('债务 ≥ hard 阈值 → 限制非必要演化（§6.5.7）；日预算耗尽 → 不演化（§6.5.6）', async () => {
    const policy = await loadPolicy(REPO_POLICY_DIR);
    const d = decideEvolution({
      summary: { window: { from: 0, to: 1 }, counts: { corrections: 1 } },
      policy: policy.evolve,
      debt: 60, // ≥ hard 50
    });
    expect(d.should_evolve).toBe(false);
    expect(d.reason).toMatch(/debt_over_hard/);
    const d2 = decideEvolution({
      summary: { window: { from: 0, to: 1 }, counts: { corrections: 1 } },
      policy: policy.evolve,
      daily_cost_spent: 100, // ≥ daily_evolution_cost 100
    });
    expect(d2.should_evolve).toBe(false);
    expect(d2.reason).toMatch(/daily_budget_exhausted/);
  });
});

// ---- ⑤ 债务权重映射 ----

describe('⑤ §10.1 债务权重（memory+2/candidate+8/repair+20/GC+1）', () => {
  it('debtAccrualsFromSummary 按实际信号类型累计权重；priority = EV/C × debt', () => {
    const acc = debtAccrualsFromSummary({
      window: { from: 0, to: 1 },
      counts: { corrections: 1, tool_calls: 2, memory_ops: 3 },
    });
    const byId = new Map(acc.map((a) => [a.task_id, a]));
    expect(byId.get('repair')!.value).toBe(20);
    expect(byId.get('candidate_validation')!.value).toBe(8);
    expect(byId.get('memory_consolidation')!.value).toBe(2);
    expect(byId.get('gc')!.value).toBe(1); // 每收尾常驻
    // priority = EV/C × debt（EV=value、C=estimated_cost、debt=value）
    expect(byId.get('repair')!.priority).toBe(Math.round((20 / 25) * 20));
    expect(byId.get('candidate_validation')!.priority).toBe(Math.round((8 / 10) * 8));
    // 零计数信号不产生对应债务
    const none = debtAccrualsFromSummary({ window: { from: 0, to: 0 }, counts: {} });
    expect(none.map((a) => a.task_id)).toEqual(['gc']); // 仅常驻 gc
  });

  it('candidateValidationAccrual 单一入账（演化判定触发用）', () => {
    const acc = candidateValidationAccrual();
    expect(acc.task_id).toBe('candidate_validation');
    expect(acc.value).toBe(8);
    expect(acc.estimated_cost).toBe(10);
  });

  it('summarizeSignals 窗口与计数聚合', () => {
    const s = summarizeSignals([
      { ts: 100, kind: 'tool_calls', payload: { count: 2 } },
      { ts: 200, kind: 'tool_calls', payload: { count: 1 } },
      { ts: 150, kind: 'corrections', payload: { count: 1 } },
    ]);
    expect(s.counts).toEqual({ tool_calls: 3, corrections: 1 });
    expect(s.window).toEqual({ from: 100, to: 200 });
  });
});

// ---- ⑥ 生产路径：finalizeTurn → 债务 → 落盘 → 清偿 ----

describe('⑥ MaintenanceDebt 生产路径（finalizeTurn 信号 → §10.1 入队累计 → 落盘 → 清偿）', () => {
  it('finalizeTurn 信号 → 债务权重入队累计 → debt.json 落盘（存在且有内容）→ quantum 执行清偿归零', async () => {
    const debtFile = join(base, 'debt.json');
    const scheduler = new MaintenanceScheduler({ debtFile });
    const runtime = track(createCognitiveRuntime({ root, maintenance: scheduler }));

    // 会话事件：工具调用 → utility_counts.tool_calls = 1（reducer 计数）
    await runtime.eventStore.append(
      makeRuntimeEvent('tool/call', SESSION, runtime.snapshotHash, { callId: 'c1', name: 'read' }, ['test']),
    );
    const res = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: fallbackFinalizeDecision(runtime.snapshotHash),
      working_state: fallbackWorkingState('P1c 目标'),
    });

    // ① 信号落盘（finalizeTurn 收尾聚合点 → signals/ JSONL）
    expect(res.signals_log.appended).toBeGreaterThan(0);
    expect(res.signals_log.degraded).toBeNull();
    const sigFile = join(root, '.evolution', 'signals', signalFileName(Date.now()));
    expect(existsSync(sigFile)).toBe(true);

    // ② §10.1 债务权重入队累计（candidate_validation +8 因 tool_calls；gc +1 常驻）
    const debt = scheduler.debtSnapshot();
    const byId = new Map(debt.map((d) => [d.task_id, d]));
    expect(byId.get('candidate_validation')!.value).toBe(8);
    expect(byId.get('gc')!.value).toBe(1);
    expect(byId.has('repair')).toBe(false); // 无 corrections → 无 repair 债务

    // ③ debt.json 落盘（存在且有内容，与快照一致）
    expect(existsSync(debtFile)).toBe(true);
    const onDisk = JSON.parse(await readFile(debtFile, 'utf8')) as unknown[];
    expect(onDisk).toEqual(debt);

    // ④ 清偿：quantum 逐个执行 → 任务完成 → 债务归零
    const ran: string[] = [];
    for (let i = 0; i < 10; i++) {
      const report = await scheduler.requestQuantum();
      if (report.ran.length === 0) break;
      ran.push(...report.ran);
    }
    expect(ran).toContain(`turn-finalize:${SESSION}`); // 会话收尾先执行（ROI 1 > 债务任务）
    expect(ran).toContain('candidate_validation');
    expect(ran).toContain('gc');
    expect(scheduler.debtSnapshot()).toEqual([]); // 全部完成 → 清偿归零
    scheduler.stop();
  });

  it('enqueue accrueDebt：入队即累计 + 落盘；任务失败不重复双计；成功清偿', async () => {
    const debtFile = join(base, 'debt2.json');
    const scheduler = new MaintenanceScheduler({ debtFile });
    // accrueDebt 入队（§10.1 事件入队累加）
    await scheduler.enqueue(
      { id: 'repair', value: 20, estimated_cost: 25, priority: 16, urgency: 'soft', run: async () => {} },
      { accrueDebt: true },
    );
    expect(scheduler.debtSnapshot()).toHaveLength(1);
    expect(existsSync(debtFile)).toBe(true);
    // 中断路径：已入账任务不重复累计（防双计）
    const aborted = new AbortController();
    aborted.abort();
    await scheduler.requestQuantum({ signal: aborted.signal });
    expect(scheduler.debtSnapshot()[0]!.value).toBe(20);
    // 成功 → 清偿归零
    await scheduler.requestQuantum();
    expect(scheduler.debtSnapshot()).toEqual([]);
    scheduler.stop();
  });
});
