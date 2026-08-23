// layer 2（kernel/）：P1c 演化判定与维护债务累计纯函数（架构 §6.5.1 触发链 / §6.5.7 维护债务 /
// 实现规格 §10.1 MaintenanceDebt）。
// 零 I/O、零副作用、零随机：同输入 → 同输出（确定性；测试锚定）。
// 依赖：仅契约层 kernel/schemas/（policy.ts：EvolvePolicy/SignalTrigger；evolution.ts：类型）。
// 层 DAG（CONVENTIONS §4）：kernel(2) → kernel/schemas(2) 满足"import 目标层 ≤ 源层"；
// 消费方 = runtime(2)（assembly/plugin）与 tests（豁免）；supervisor 不依赖本文件（契约例外仅限 kernel/schemas）。
import type { EvolvePolicy, SignalTrigger } from './schemas/policy.js';
import type {
  EvolutionDecision,
  MaintenanceUrgency,
  SignalRecord,
  SignalSummary,
} from './schemas/evolution.js';

// ---- §10.1 维护任务权重/成本（数据可演化；初值待冻结基准标定 §17） ----

/** §10.1 维护任务权重（memory:+2 / candidate:+8 / repair:+20 / GC:+1） */
export const MAINTENANCE_WEIGHTS = {
  memory_consolidation: 2,
  candidate_validation: 8,
  repair: 20,
  gc: 1,
} as const;
export type MaintenanceTaskId = keyof typeof MAINTENANCE_WEIGHTS;

/** 维护任务成本估计（§10.1 estimated_cost，priority = EV/C × debt 的 C；待标定 §17）。
 *  取值 ≥ 权重 → 债务任务 ROI ≤ 1，低于会话级收尾任务（turn-finalize ROI 1）——
 *  会话收尾（事件库 GC）先执行、信号债务任务随后（既有调度顺序不破坏，既有测试锚定）。
 *  §17 标定留档（2026-08-23，P6）：维护任务真实执行数据（real-v2-stable 基准 cost 中
 *  tool_calls/retrieval_calls 全 0、无维护执行观测）尚未产出 → 常量保持初值不臆造，
 *  待维护任务真实执行数据产出后按 ROI 观测标定（同一 EV/C×debt 机制，改本表即生效）。 */
export const MAINTENANCE_COSTS: Record<MaintenanceTaskId, number> = {
  memory_consolidation: 4,
  candidate_validation: 10,
  repair: 25,
  gc: 2,
};

/** 债务任务紧迫度（§10.1：repair/candidate 高价值维护 → soft 提升 quantum 频率；memory/gc 常规） */
const ACCRUAL_URGENCY: Record<MaintenanceTaskId, MaintenanceUrgency> = {
  repair: 'soft',
  candidate_validation: 'soft',
  memory_consolidation: 'normal',
  gc: 'normal',
};

/** 单位信号量的演化成本（decideEvolution.budget_estimate 估算基数；待标定 §17） */
const EVOLUTION_UNIT_COST = 10;

// ---- 债务入账（§10.1：事件入队累加 value；priority = ExpectedValue/Cost × debt） ----

/** §10.1 维护债务入账（finalizeTurn/演化判定 → maintenance.enqueue(accrueDebt)） */
export interface DebtAccrual {
  task_id: string;
  value: number;
  estimated_cost: number;
  /** §10.1 priority = EV/C × debt（EV=value、C=estimated_cost、debt=value） */
  priority: number;
  urgency: MaintenanceUrgency;
}

/** 信号摘要 → §10.1 维护债务入账（按实际信号类型累计权重；零计数不产生债务；gc 为每收尾常驻 +1） */
export function debtAccrualsFromSummary(summary: SignalSummary): DebtAccrual[] {
  const out: DebtAccrual[] = [];
  const push = (taskId: MaintenanceTaskId, value: number): void => {
    const cost = MAINTENANCE_COSTS[taskId];
    out.push({
      task_id: taskId,
      value,
      estimated_cost: cost,
      priority: Math.round((value / cost) * value),
      urgency: ACCRUAL_URGENCY[taskId],
    });
  };
  const n = (k: string): number => summary.counts[k] ?? 0;
  // repair：修正/复现失败（suspicious 模式）
  if (n('corrections') > 0 || n('oracle_fail') > 0) push('repair', MAINTENANCE_WEIGHTS.repair);
  // candidate_validation：工具/检索活跃 + 泛化缺口 + 信任池污染信号
  if (
    n('tool_calls') > 0 ||
    n('retrieval_calls') > 0 ||
    n('scope_miss') > 0 ||
    n('untrusted_object') > 0
  ) {
    push('candidate_validation', MAINTENANCE_WEIGHTS.candidate_validation);
  }
  // memory_consolidation：记忆写入/读取 + 正向采集信号
  if (
    n('memory_ops') > 0 ||
    n('reads') > 0 ||
    n('scope_hit') > 0 ||
    n('oracle_pass') > 0 ||
    n('trusted_object') > 0
  ) {
    push('memory_consolidation', MAINTENANCE_WEIGHTS.memory_consolidation);
  }
  // gc：每次收尾常驻维护（事件库 compact）
  push('gc', MAINTENANCE_WEIGHTS.gc);
  return out;
}

/** 应演化时入队 candidate_validation 的债务入账（§6.5.1 → §10.1；P1d 接真实候选生成/验证） */
export function candidateValidationAccrual(): DebtAccrual {
  const taskId: MaintenanceTaskId = 'candidate_validation';
  const value = MAINTENANCE_WEIGHTS[taskId];
  const cost = MAINTENANCE_COSTS[taskId];
  return {
    task_id: taskId,
    value,
    estimated_cost: cost,
    priority: Math.round((value / cost) * value),
    urgency: ACCRUAL_URGENCY[taskId],
  };
}

// ---- 信号记录转换（纯函数；零 I/O） ----

/** UtilityCounts 形状 → 信号记录（每 kind 一行；零计数不产出——避免噪声信号） */
export function countsToSignalRecords(
  counts: Record<string, number>,
  ts: number,
  sessionId?: string,
): SignalRecord[] {
  const out: SignalRecord[] = [];
  for (const kind of Object.keys(counts).sort()) {
    const count = counts[kind];
    if (typeof count === 'number' && count > 0) {
      out.push({ ts, kind, session_id: sessionId, payload: { count } });
    }
  }
  return out;
}

/** 采集器 EvaluationSignal 输出面 → 信号记录（layer 并入 payload；count 缺失/零 → 跳过；结构形状避免跨层依赖） */
export function evaluationSignalsToRecords(
  signals: ReadonlyArray<{ layer: string; kind: string; count?: number; target?: string }>,
  ts: number,
  sessionId?: string,
): SignalRecord[] {
  const out: SignalRecord[] = [];
  for (const s of signals) {
    const count = typeof s.count === 'number' ? s.count : 0;
    if (count <= 0) continue;
    out.push({
      ts,
      kind: s.kind,
      session_id: sessionId,
      payload: { layer: s.layer, count, target: s.target ?? null },
    });
  }
  return out;
}

/** 信号记录流 → 摘要（窗口 = 记录 ts 最小/最大；counts 按 kind 累计；空流 → 零窗口空计数） */
export function summarizeSignals(records: readonly SignalRecord[]): SignalSummary {
  const counts: Record<string, number> = {};
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of records) {
    const n = typeof r.payload?.count === 'number' ? r.payload.count : 1;
    counts[r.kind] = (counts[r.kind] ?? 0) + n;
    if (r.ts < min) min = r.ts;
    if (r.ts > max) max = r.ts;
  }
  return {
    window: { from: records.length === 0 ? 0 : min, to: records.length === 0 ? 0 : max },
    counts,
  };
}

// ---- 演化判定（§6.5.1 数据化：信号摘要 + evolve.policy → 确定性输出） ----

export interface EvolutionDecisionInput {
  summary: SignalSummary;
  policy: EvolvePolicy;
  /** 当前维护债务合计（可选；≥ hard 阈值 → 限制非必要演化，§6.5.7） */
  debt?: number;
  /** 今日已耗演化成本（可选；≥ daily_evolution_cost → 预算耗尽不演化，§6.5.6） */
  daily_cost_spent?: number;
}

/**
 * 演化判定纯函数（§6.5.1）：输入信号摘要 + evolve.policy → {should_evolve, strength, object_layer,
 * budget_estimate}。确定性：同输入 → 同输出（kind 字典序迭代；最强触发决定强度/对象层）。
 * 门禁顺序：无触发 → 不演化；债务 ≥ hard → 限制非必要演化；日预算耗尽 → 不演化。
 */
export function decideEvolution(input: EvolutionDecisionInput): EvolutionDecision {
  const { summary, policy } = input;
  const noEvolve = (reason: string): EvolutionDecision => ({
    should_evolve: false,
    strength: 0,
    object_layer: 'L0',
    budget_estimate: 0,
    triggers: [],
    reason,
  });

  const triggered: Array<{ kind: string; rule: SignalTrigger }> = [];
  for (const kind of Object.keys(summary.counts).sort()) {
    const count = summary.counts[kind];
    if (count === undefined || count <= 0) continue;
    const rule = policy.signal_triggers[kind];
    if (rule !== undefined && rule.evolve) triggered.push({ kind, rule });
  }
  if (triggered.length === 0) {
    return noEvolve('no_trigger');
  }
  // §6.5.7 hard 债务限：debt ≥ hard → 限制非必要演化
  if (input.debt !== undefined && input.debt >= policy.debt_thresholds.hard) {
    return noEvolve(`debt_over_hard:${input.debt}>=${policy.debt_thresholds.hard}`);
  }
  // §6.5.6 日预算限：已耗 ≥ daily_evolution_cost → 预算耗尽不演化
  if (input.daily_cost_spent !== undefined && input.daily_cost_spent >= policy.daily_evolution_cost) {
    return noEvolve(`daily_budget_exhausted:${input.daily_cost_spent}>=${policy.daily_evolution_cost}`);
  }
  // 最强触发决定强度与对象层（同强度取字典序最小 kind——确定性）
  const strongest = [...triggered].sort((a, b) =>
    b.rule.strength !== a.rule.strength
      ? b.rule.strength - a.rule.strength
      : a.kind.localeCompare(b.kind),
  )[0]!;
  const budget = Math.round(
    triggered.reduce((acc, t) => acc + t.rule.strength * (summary.counts[t.kind] ?? 0), 0) *
      EVOLUTION_UNIT_COST,
  );
  return {
    should_evolve: true,
    strength: strongest.rule.strength,
    object_layer: strongest.rule.object_layer,
    budget_estimate: budget,
    triggers: triggered.map((t) => ({
      kind: t.kind,
      strength: t.rule.strength,
      object_layer: t.rule.object_layer,
    })),
    reason: `trigger:${triggered.map((t) => t.kind).sort().join(',')}`,
  };
}
