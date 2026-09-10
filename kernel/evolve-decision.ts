// layer 2（kernel/）：P1c 演化判定与维护债务累计纯函数（架构 §6.5.1 触发链 / §6.5.7 维护债务 /
// 实现规格 §10.1 MaintenanceDebt）。
// 零 I/O、零副作用、零随机：同输入 → 同输出（确定性；测试锚定）。
// 依赖：仅契约层 kernel/schemas/（policy.ts：EvolvePolicy/SignalTrigger；evolution.ts：类型）。
// 层 DAG（CONVENTIONS §4）：kernel(2) → kernel/schemas(2) 满足"import 目标层 ≤ 源层"；
// 消费方 = runtime(2)（assembly/plugin）与 tests（豁免）；supervisor 不依赖本文件（契约例外仅限 kernel/schemas）。
import type { EvolvePolicy, SignalTrigger } from './schemas/policy.js';
// S2：维护任务成本单一来源（DEFAULT_MAINTENANCE_COSTS = policy 缺省初值；MaintenanceTaskId = 七任务全集）
import { DEFAULT_MAINTENANCE_COSTS, type MaintenanceTaskId } from './schemas/policy.js';
export type { MaintenanceTaskId } from './schemas/policy.js';
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

/**
 * 维护任务成本估计（§10.1 estimated_cost，priority = EV/C × debt 的 C）。
 * S2 成本数据化：运行期来源 = policy.evolve.maintenance_costs（装配时注入——改 evolve.yaml 即生效）；
 * 本常量 = 出厂缺省初值（与 policy 缺省同源）。
 * 初值 + 观测中：无真实维护执行数据 → 不臆造标定；最终值待 .evolution/maintenance-observations
 * 观测数据积累后按 §10.1 ROI 观测标定（同一 EV/C×debt 机制，改 policy maintenance_costs 即生效）。
 */
export const MAINTENANCE_COSTS: Readonly<Record<MaintenanceTaskId, number>> = { ...DEFAULT_MAINTENANCE_COSTS };

/** 债务任务紧迫度（§10.1：repair/candidate 高价值维护 → soft 提升 quantum 频率；其余常规） */
const ACCRUAL_URGENCY: Record<MaintenanceTaskId, MaintenanceUrgency> = {
  repair: 'soft',
  candidate_validation: 'soft',
  memory_consolidation: 'normal',
  gc: 'normal',
  promotion_check: 'normal',
  environment_check: 'normal',
  evolution_decision: 'normal',
};

/**
 * 债务来源子系统（已知问题「债务是保护性自锁，需要修复后释放」第 1 条：债务带来源记录）——
 * 每条债务必须能对应到「待修复项」，释放流程按 subsystem 逐条核对（防「修了 A 顺手清掉 B 的债」）。
 * 取值 = 完成该项修复所需的自检面（release 时 expectedSubsystem 必须与之一致）。
 */
const DEBT_SUBSYSTEM: Record<MaintenanceTaskId, string> = {
  repair: 'repair-chain',
  candidate_validation: 'candidate-pipeline',
  memory_consolidation: 'memory-consolidation',
  environment_check: 'environment-check',
  evolution_decision: 'evolution-decision',
  promotion_check: 'promotion-check',
  gc: 'event-store',
};

/** 入账原因（可读；写入债务来源记录，供状态面回答「这条债是哪来的」） */
const ACCRUAL_REASON: Record<MaintenanceTaskId, string> = {
  repair: '修正/复现失败信号（corrections/oracle_fail）——受影响对象需重验证',
  candidate_validation: '工具/检索活跃或泛化缺口/信任池污染信号——候选需生成与验证',
  memory_consolidation: '记忆读写或正向采集信号——经验待整合入长期记忆',
  environment_check: '环境变化待核对（预测性失效）',
  evolution_decision: '演化判定待执行',
  promotion_check: '晋升检查待执行',
  gc: '事件库待整理',
};

/** S2：可注入的维护成本表（装配时传 policy.evolve.maintenance_costs；缺省 → 出厂初值） */
export type MaintenanceCostsLike = Readonly<Partial<Record<MaintenanceTaskId, number>>>;

/** 成本解析：注入值优先，缺省 → 出厂初值（0 为合法注入值，不回落） */
function costOf(costs: MaintenanceCostsLike | undefined, taskId: MaintenanceTaskId): number {
  return costs?.[taskId] ?? MAINTENANCE_COSTS[taskId];
}

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
  /** 债务来源子系统（release 时按此逐条核对；见 DEBT_SUBSYSTEM） */
  subsystem: string;
  /** 债务原因（可读；写入债务来源记录） */
  reason: string;
}

/** 信号摘要 → §10.1 维护债务入账（按实际信号类型累计权重；零计数不产生债务；
 *  GC 不再每收尾常驻入账——事件库 compact 已由 turn-finalize 任务覆盖，见下方 gc 段注释）。
 *  @param costs S2 成本注入（policy.evolve.maintenance_costs）；缺省 → 出厂初值 */
export function debtAccrualsFromSummary(summary: SignalSummary, costs?: MaintenanceCostsLike): DebtAccrual[] {
  const out: DebtAccrual[] = [];
  const push = (taskId: MaintenanceTaskId, value: number): void => {
    const cost = costOf(costs, taskId);
    out.push({
      task_id: taskId,
      value,
      estimated_cost: cost,
      priority: Math.round((value / cost) * value),
      urgency: ACCRUAL_URGENCY[taskId],
      subsystem: DEBT_SUBSYSTEM[taskId],
      reason: ACCRUAL_REASON[taskId],
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
  // gc：不再每收尾常驻入账（2026-08-25 修复）——事件库 compact 已由 turn-finalize 任务
  // （ROI 1，每次收尾执行）覆盖；重复入账导致 gc 债务无限增长且 gc 任务（ROI 0.5）在
  // 请求间隙量子中几乎轮不到（实测 gc 债务 1340 只入账不清偿）。§10.1 GC:+1 权重保留于
  // MAINTENANCE_WEIGHTS/成本表（供显式 gc 任务使用），此处不再自动入账。
  return out;
}

/** 应演化时入队 candidate_validation 的债务入账（§6.5.1 → §10.1；P1d 接真实候选生成/验证）。
 *  @param costs S2 成本注入（policy.evolve.maintenance_costs）；缺省 → 出厂初值 */
export function candidateValidationAccrual(costs?: MaintenanceCostsLike): DebtAccrual {
  const taskId: MaintenanceTaskId = 'candidate_validation';
  const value = MAINTENANCE_WEIGHTS[taskId];
  const cost = costOf(costs, taskId);
  return {
    task_id: taskId,
    value,
    estimated_cost: cost,
    priority: Math.round((value / cost) * value),
    urgency: ACCRUAL_URGENCY[taskId],
    subsystem: DEBT_SUBSYSTEM[taskId],
    reason: ACCRUAL_REASON[taskId],
  };
}

/** R4：经验已入 staging → memory_consolidation 债务入账（§10.1 同形状；finalizeTurn 在
 *  Experience Admission 后入队——保证「经验 → 长期记忆」生产闭环在无 memory 信号时也可调度）。
 *  @param costs S2 成本注入（policy.evolve.maintenance_costs）；缺省 → 出厂初值 */
export function memoryConsolidationAccrual(costs?: MaintenanceCostsLike): DebtAccrual {
  const taskId: MaintenanceTaskId = 'memory_consolidation';
  const value = MAINTENANCE_WEIGHTS[taskId];
  const cost = costOf(costs, taskId);
  return {
    task_id: taskId,
    value,
    estimated_cost: cost,
    priority: Math.round((value / cost) * value),
    urgency: ACCRUAL_URGENCY[taskId],
    subsystem: DEBT_SUBSYSTEM[taskId],
    reason: ACCRUAL_REASON[taskId],
  };
}

/** P7：环境变化 → 受影响对象重新验证入队（repair 债务；§14.5 Predictive Invalidation 触发面，
 *  与 debtAccrualsFromSummary 的 corrections/oracle_fail → repair 同语义）。
 *  @param costs S2 成本注入（policy.evolve.maintenance_costs）；缺省 → 出厂初值 */
export function repairAccrual(costs?: MaintenanceCostsLike): DebtAccrual {
  const taskId: MaintenanceTaskId = 'repair';
  const value = MAINTENANCE_WEIGHTS[taskId];
  const cost = costOf(costs, taskId);
  return {
    task_id: taskId,
    value,
    estimated_cost: cost,
    priority: Math.round((value / cost) * value),
    urgency: ACCRUAL_URGENCY[taskId],
    subsystem: DEBT_SUBSYSTEM[taskId],
    reason: ACCRUAL_REASON[taskId],
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
