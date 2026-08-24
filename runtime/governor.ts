// OMB v2 Cognitive Governor 决策核心（架构 §5.1）。
// Fast Governor + Rare Generator：常态结构化 policy 廉价决策（表驱动，代码不感知内容——
// 改 kernel/policy/governor.yaml 即改行为）；困难提高 compute；陌生才调 Generator。
// layer 2（runtime/）：仅 import 同层 kernel/（CONVENTIONS §4）；纯函数——无 I/O、无随机、无时间依赖。
import type { BudgetPolicy, GovernorPolicy, GovernorRule } from '../kernel/policy-loader.js';
import type { Applicability } from './generator-ops.js';

// ---- 值域（类型从 T2.1 决策表 schema 派生，防漂移） ----

/** Governor 决策并集（§5.1 GovernorDecision；值域锚定 T2.1 GOVERNOR_DECISIONS） */
export type GovernorDecisionKind = GovernorRule['decision'];
// Process Applicability（§5.1：Strong/Partial/Failed/Contradictory/OOD）——复用 generator-ops 导出
// （同一 APPLICABILITY 枚举派生，防漂移；Governor 决策表 when.applicability 与其同源）
/** 证据缺口二值（§5.1 evidence_sufficiency → none/some） */
type EvidenceGaps = NonNullable<GovernorRule['when']>['evidence_gaps'];

/** 六维预算维度（§5.1 计算分配器：深度/广度/工具/检索/分支/上下文） */
export const BUDGET_DIMENSIONS = [
  'depth',
  'breadth',
  'tools',
  'retrieval',
  'branches',
  'context',
] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/** Progress 向量（§5.1 非标量：七维 Reasoning Utility 空间） */
export const PROGRESS_DIMENSIONS = [
  'constraint_reduction',
  'hypothesis_reduction',
  'hypothesis_discrimination',
  'evidence_strengthening',
  'goal_completion',
  'reproducibility',
  'uncertainty_reduction',
] as const;
export type ProgressDimension = (typeof PROGRESS_DIMENSIONS)[number];

// ---- 类型（架构 §5.1 字段级转录；本任务 TS 类型即可，数据侧校验由 T2.1 policy 覆盖） ----

/** Progress 向量（§5.1：非标量，Reasoning Utility 在该向量空间计算） */
export interface ProgressVector {
  constraint_reduction: number;
  hypothesis_reduction: number;
  hypothesis_discrimination: number;
  evidence_strengthening: number;
  goal_completion: number;
  reproducibility: number;
  uncertainty_reduction: number;
}

/** 证据充分性（§5.1：covered_success_conditions/critical_gaps/score——候选已现且缺口空 → Stop） */
export interface EvidenceSufficiency {
  covered_success_conditions: string[];
  critical_gaps: string[];
  score: number;
}

/** 候选过程适用性结果（与 candidate_processes 按优先级对齐） */
export interface ApplicabilityResult {
  process_id: string;
  applicability: Applicability;
}

/** 六维剩余可用预算（0 = 该维耗尽 → budget_ok=false → 决策表 Delegate） */
export interface RemainingBudget {
  depth: number;
  breadth: number;
  tools: number;
  retrieval: number;
  branches: number;
  context: number;
}

/** GovernorInput.budget：预算包络（= BudgetPolicy）+ 剩余可用 */
export interface GovernorBudget {
  envelope: BudgetPolicy;
  remaining: RemainingBudget;
}

/** GovernorInput（§5.1 字段级转录；task_done 为表外短路位——架构级维度，非策略数据维度，不入输入位：
 *  由 isSuccessCriteriaCovered(task_contract, evidence_sufficiency) 在 decide 内计算，主会话裁决 2026-08-21 归一） */
export interface GovernorInput {
  task_contract: { goal: string; success_criteria: string[] }; // S1 最小视图
  state_snapshot: { snapshot_hash: string }; // S2 最小视图
  environment: string;
  candidate_processes: string[];
  applicability_results: ApplicabilityResult[];
  budget: GovernorBudget;
  risk: number;
  progress_vector: ProgressVector;
  uncertainty_vector: Record<string, number>;
  maintenance_state: { debt: number }; // M8 最小视图（§12.3）
  evidence_sufficiency: EvidenceSufficiency;
}

/** 六维分配（§5.1 计算分配器输出） */
export interface BudgetAllocation {
  depth: number;
  breadth: number;
  tools: number;
  retrieval: number;
  branches: number;
  context: number;
}

/** GovernorDecision（§5.1）：决策 + reason/budget_allocation/expected_gain/snapshot 字段 */
export interface GovernorDecision {
  decision: GovernorDecisionKind;
  reason: string;
  budget_allocation: BudgetAllocation;
  expected_gain: number;
  snapshot: string;
  /** R3：Governor→Scheduler 调度结果（prepareTurn 调度步骤写入；Governor 纯决策本身不含——optional） */
  process?: ProcessDecisionInfo;
}

/**
 * R3：调度结果并入决策载荷（架构 §5.1/§4.6.1：Governor 决策 → ProcessScheduler → 选定/生成过程）。
 * kind=known/generated 时 process_id/name/steps/budget_tokens 非空；kind=none（无过程可选/生成被拒/
 * scheduler 异常）→ degraded 记录降级原因（decision/made 事件 payload 已由 finalizeTurn 记录 chosen/reason，
 * 调度结果并入 decision 即可——不新增事件类型）。
 */
export interface ProcessDecisionInfo {
  /** 调度结果分类：known=复用已有过程；generated=Ephemeral 生成；none=无过程（含降级） */
  kind: 'known' | 'generated' | 'none';
  /** 过程 id（kind=none → null；ProcessDef.id 即过程名，无独立 name 字段） */
  process_id: string | null;
  /** 过程名（= process_id；kind=none → null） */
  name: string | null;
  /** 步骤摘要（算子名序列；kind=none → []） */
  steps: string[];
  /** 生成/复用方法（阶梯命中：reuse/compose/mutate/generate；无 → none） */
  method: 'reuse' | 'compose' | 'mutate' | 'generate' | 'none';
  /** 已知过程适用性（kind=known 时 meaningful；其余 → null） */
  applicability: Applicability | null;
  /** 过程预算 token（ProcessDef.budget.tokens；kind=none → null） */
  budget_tokens: number | null;
  /** 降级原因（scheduler 异常/无过程可选/生成被拒；无降级 → null） */
  degraded: string | null;
}

// ---- isSuccessCriteriaCovered：task_done 唯一判定源（主会话裁决 2026-08-21 归一） ----

/**
 * task_done 的**唯一**判定源（防漂移：调用方不得自行拼 task_done——decide 内部经此函数计算，
 * 输入不再含 task_done 位，彻底归一）。语义：task_done = TaskContract.success_criteria 全覆盖
 * （由 verifier 判定硬信号，与架构 §5.1 evidence_sufficiency"关键缺口为空"同一语义）——
 * success_criteria 每项 ∈ covered_success_conditions → true。空 success_criteria → 空洞真（无未覆盖项）。
 * task_done 是**表外短路位**（架构级维度，非策略数据维度）：决策表三维
 * applicability/evidence_gaps/budget_ok 不含它；全覆盖在查表前短路 → Stop。
 */
export function isSuccessCriteriaCovered(
  task: { success_criteria: string[] },
  evidence: EvidenceSufficiency,
): boolean {
  return task.success_criteria.every((c) => evidence.covered_success_conditions.includes(c));
}

// ---- decide：Fast path 决策（表驱动，代码不硬编码决策） ----

/**
 * 决策核心。task_done（= isSuccessCriteriaCovered(task_contract, evidence_sufficiency)，
 * 主会话裁决 2026-08-21 归一：success_criteria 全覆盖，表外短路位——架构级维度，非策略数据维度，
 * 决策表三维 applicability/evidence_gaps/budget_ok 不含它）= true → Stop，不查决策表
 * （架构 §5.1 "候选已现且缺口空 → Stop"在完成语境成立，reason 含"任务完成/证据充分"）；
 * 未全覆盖 → 查 T2.1 决策表（Strong+缺口空→RunProcess、缺口非空→Verify、OOD→GenerateProcess、
 * Failed→ExpandSearch、Contradictory→RetrieveMemory、预算耗尽→Delegate、未命中→默认规则→Stop）。
 */
export function decide(input: GovernorInput, policy: GovernorPolicy): GovernorDecision {
  const allocation = allocate(input.budget.envelope, input);
  const snapshot = input.state_snapshot.snapshot_hash;

  // 表外短路：success_criteria 全覆盖（唯一判定源，无第二个输入位）→ Stop
  if (isSuccessCriteriaCovered(input.task_contract, input.evidence_sufficiency)) {
    return {
      decision: 'Stop',
      reason: '任务完成且证据充分：目标成功条件已全覆盖（verifier 判定硬信号），候选已现，停止',
      budget_allocation: allocation,
      expected_gain: utilityEstimate(input.progress_vector, allocatedCost(allocation)),
      snapshot,
    };
  }

  // 决策表查找：(applicability, evidence_gaps, budget_ok) → 命中规则；未命中（理论不可达）→ default
  const applicability = input.applicability_results[0]?.applicability;
  const evidenceGaps: EvidenceGaps = input.evidence_sufficiency.critical_gaps.length > 0 ? 'some' : 'none';
  const budgetOk = isBudgetOk(input.budget);
  const rule =
    policy.rules.find(
      (r) =>
        r.when?.applicability === applicability &&
        r.when?.evidence_gaps === evidenceGaps &&
        r.when?.budget_ok === budgetOk,
    ) ?? policy.rules.find((r) => r.id === 'default')!; // T2.1 schema refine：恰一条默认规则

  return {
    decision: rule.decision,
    reason: `${rule.id}: applicability=${applicability ?? 'none'}, evidence_gaps=${evidenceGaps}, budget_ok=${budgetOk} → ${rule.decision}`,
    budget_allocation: allocation,
    expected_gain: utilityEstimate(input.progress_vector, allocatedCost(allocation)),
    snapshot,
  };
}

// ---- allocate：六维分配纯函数 ----

/**
 * 六维统一分配（§5.1 计算分配器）：每维上限 = min(policy 上限, 剩余可用)，
 * context 维另受 Context Compiler 投影预算约束（§6.1 context_budget_tokens）。
 * 初值：均分（六维等权、确定性；"按输入权重"为 §17 参数标定项，输入侧暂等权）。
 */
export function allocate(budget: BudgetPolicy, input: GovernorInput): BudgetAllocation {
  const ceilings: RemainingBudget = {
    depth: Math.min(budget.depth, input.budget.remaining.depth),
    breadth: Math.min(budget.breadth, input.budget.remaining.breadth),
    tools: Math.min(budget.tools, input.budget.remaining.tools),
    retrieval: Math.min(budget.retrieval, input.budget.remaining.retrieval),
    branches: Math.min(budget.branches, input.budget.remaining.branches),
    context: Math.min(budget.context, budget.context_budget_tokens, input.budget.remaining.context),
  };
  const total = BUDGET_DIMENSIONS.reduce((s, d) => s + ceilings[d], 0);
  const base = Math.floor(total / BUDGET_DIMENSIONS.length);
  const remainder = total % BUDGET_DIMENSIONS.length;
  const allocation = {} as BudgetAllocation;
  BUDGET_DIMENSIONS.forEach((d, i) => {
    allocation[d] = Math.min(ceilings[d], base + (i < remainder ? 1 : 0));
  });
  return allocation;
}

// ---- utilityEstimate：Reasoning Utility 初值 ----

/**
 * Reasoning Utility 初值（§5.1：Progress 向量空间 + 成本）：七维等权加权和 / 成本。
 * 单调：progress 增 / 成本降 → 值升（测试钉死）。权重为 §17 参数标定项，初值等权。
 * cost ≤ 0 → Infinity（边际成本为零 → 效用无界；正常调用 cost > 0）。
 */
export function utilityEstimate(progress: ProgressVector, cost: number): number {
  if (!(cost > 0)) {
    return Infinity;
  }
  return PROGRESS_DIMENSIONS.reduce((s, d) => s + progress[d], 0) / cost;
}

// ---- 内部辅助 ----

/** 预算可用判定：六维剩余全部 > 0（任一维耗尽 = Fast path 预算不足 → Delegate） */
function isBudgetOk(budget: GovernorBudget): boolean {
  return BUDGET_DIMENSIONS.every((d) => budget.remaining[d] > 0);
}

/** 决策分配的总计算成本（expected_gain 分母：ΔCompute 近似） */
function allocatedCost(allocation: BudgetAllocation): number {
  return BUDGET_DIMENSIONS.reduce((s, d) => s + allocation[d], 0);
}
