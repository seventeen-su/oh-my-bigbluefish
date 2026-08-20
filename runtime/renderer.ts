// OMB v2 Context Compiler（架构 §6.1：Compilation 而非 Compression）。
// 五步：① ContentRouter 分型（code→ast_marker | json→schema_marker | logs→重复消除 |
//        retrieval→保证据 | memory→语义投影 | working_state→绝不盲压缩 verbatim | artifact→指针）
//       ② 边际价值 marginal = w·ΔInfoValue − w·token − w·reacquisition − w·attention_pollution − w·regression_risk
//       ③ 贪心选择：marginal 降序逐个加入，预算耗尽或 marginal ≤ 0 停止
//       ④ 投影决策：原文 | 摘要 | 指针（ArtifactRef，可 context_restore）
//       ⑤ 输出 ContextProjection（A3 schema，T1.1）
// 三视图：planning（永不被执行痕迹污染）/ execution_scratch（默认隔离）/ evidence_artifact（可 restore）——
//   功能分层投影是 A3 ContextProjection.type 的来源（单一视图 → 对应类型；多视图 → mixed）。
// 确定性纯函数：不读时钟/随机/IO——IRBase 时间戳为固定纪元值（由调用层/未来 runtime 包装负责覆写真实时间）；
//   同输入同输出（测试钉死）。权重取 kernel/policy/context.yaml 初值（T2.1）；kind 成本表为 §17 参数标定项。
// layer 2（runtime/）：仅 import 同层 kernel/（CONVENTIONS §4）；模块顶层无副作用。
import type { ContextProjection } from '../kernel/schemas/a.js';
import { canonicalJson, makeImmutableId } from '../kernel/schemas/base.js';
import type { ContextPolicy } from '../kernel/policy-loader.js';

// ---- 值域 ----

/** 候选分型（§6.1 ContentRouter 输入分型） */
export const CANDIDATE_KINDS = [
  'code',
  'json',
  'logs',
  'retrieval',
  'memory',
  'working_state',
  'artifact',
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/** 候选声明的功能视图（输入侧三视图；输出映射为 A3 view 名） */
export const CANDIDATE_VIEWS = ['planning', 'scratch', 'evidence'] as const;
export type CandidateView = (typeof CANDIDATE_VIEWS)[number];

/** ContentRouter 处理策略（分型结果；M2 最小实现：logs 去重、memory 摘要、working_state 原文，code/json 只打 marker 保留原文） */
export type RouteStrategy =
  | 'ast_marker'
  | 'schema_marker'
  | 'dedup'
  | 'kept_as_evidence'
  | 'semantic'
  | 'verbatim'
  | 'pointer';

// ---- 输入类型（§6.1 字段级转录） ----

/** 候选集条目（memory/evidence/capability/process 的投影候选） */
export interface CandidateItem {
  id: string;
  kind: CandidateKind;
  content: string;
  tokens: number; // 输入侧 token 估算（精确计费为 §17 参数标定项，M2 透传）
  view: CandidateView;
  info_value: number; // Δ信息价值（§17 开放项：当前由调用方提供；缺口匹配度启发式后续接入）
  source_ref: string;
}

/** WorkingState 最小视图（S3 字段级子集，架构 §4.2；compile 仅需 verbatim 投影） */
export interface WorkingStateView {
  goal: string;
  confirmed_facts: string[];
  active_hypotheses: string[];
  contradictions: string[];
  open_questions: string[];
  evidence_gaps: string[];
  next_best_action: string;
  environment: string;
}

/** TaskContract 最小视图（S1 字段级子集，架构 §4.2；M2 为输入契约占位，compile 不读取——ΔInfoValue 估计为 §17 开放项） */
export interface TaskContractView {
  goal: string;
  success_criteria: string[];
}

/** compile 输入（§6.1：TaskContract + WorkingState + 候选集 + 预算 + 策略） */
export interface CompileInput {
  task_contract: TaskContractView;
  /** 工作状态（可选）：提供时 verbatim 原文进入 planning 视图（绝不盲压缩），token 计入 total_tokens */
  working_state?: WorkingStateView;
  candidates: CandidateItem[];
  budget_tokens: number;
  policy: ContextPolicy;
}

// ---- kind 成本表（§6.1 reacquisition/attention_pollution/regression_risk；§17 参数标定初值，冻结基准产出后修正） ----

/** 重获取成本初值：按 kind 恢复该内容的代价（working_state 每请求自带 → 0） */
export const REACQUISITION_COST: Record<CandidateKind, number> = {
  code: 30,
  json: 25,
  logs: 15,
  retrieval: 40,
  memory: 20,
  working_state: 0,
  artifact: 35,
};

/** 注意力污染初值：噪音/无关内容对注意力的干扰（日志噪音最高） */
export const ATTENTION_POLLUTION_COST: Record<CandidateKind, number> = {
  code: 15,
  json: 10,
  logs: 30,
  retrieval: 8,
  memory: 5,
  working_state: 5,
  artifact: 10,
};

/** 回归风险初值：投影干扰任务执行的风险 */
export const REGRESSION_RISK_COST: Record<CandidateKind, number> = {
  code: 10,
  json: 8,
  logs: 12,
  retrieval: 5,
  memory: 8,
  working_state: 5,
  artifact: 6,
};

// ---- ① ContentRouter 分型 ----

/**
 * 分型路由（§6.1）：kind → 处理策略。M2 最小实现——logs 去重、memory 摘要、working_state 原文；
 * code/json 的 AST/schema 深度处理留 M2 之后（当前只打 marker 保留原文）。
 */
export function route(item: Pick<CandidateItem, 'kind'>): RouteStrategy {
  switch (item.kind) {
    case 'code':
      return 'ast_marker';
    case 'json':
      return 'schema_marker';
    case 'logs':
      return 'dedup';
    case 'retrieval':
      return 'kept_as_evidence';
    case 'memory':
      return 'semantic';
    case 'working_state':
      return 'verbatim';
    case 'artifact':
      return 'pointer';
  }
}

// ---- ② 边际价值 ----

/**
 * 边际价值（§6.1）：marginal = w_info·ΔInfoValue − w_token·token − w_reacq·reacquisition
 *   − w_poll·attention_pollution − w_regr·regression_risk；权重取 context.yaml 初值（T2.1）。
 * 纯函数；预算交互（剩余预算裁剪）由 compile 贪心循环处理。
 */
export function marginal(item: CandidateItem, policy: ContextPolicy): number {
  const w = policy.marginal_weights;
  return (
    w.info_value * item.info_value -
    w.token_cost * item.tokens -
    w.reacquisition * REACQUISITION_COST[item.kind] -
    w.attention_pollution * ATTENTION_POLLUTION_COST[item.kind] -
    w.regression_risk * REGRESSION_RISK_COST[item.kind]
  );
}

// ---- ⑤ compile：分型 → 排序 → 贪心 → 投影（确定性纯函数） ----

/**
 * Context Compiler 入口（§6.1 五步，确定性纯函数：同输入同输出）。
 * working_state（可选）verbatim 原文进入 planning 视图（绝不盲压缩，token 计入 total_tokens）；
 * 其余预算（budget − working_state tokens）用于候选贪心：marginal 降序，预算耗尽（放不下）或
 * marginal ≤ 0 即停止（不跳过继续）；logs 重复内容只保留输入序首个。
 * 输出 A3 ContextProjection（immutable：id = sha256 内容哈希，改内容 → 新 id）。
 */
export function compile(input: CompileInput): ContextProjection {
  const policy = input.policy;
  const wsSection = input.working_state === undefined ? [] : [projectWorkingState(input.working_state)];
  const candidateBudget = Math.max(0, input.budget_tokens - sectionTokens(wsSection));

  const ranked = dedupLogs(input.candidates)
    .map((item) => ({ item, marginal: marginal(item, policy) }))
    .sort(byMarginalDesc);

  const selected: CandidateItem[] = [];
  let used = 0;
  for (const { item, marginal: m } of ranked) {
    if (m <= 0) {
      break; // 边际 ≤ 0 停止（降序：后续全部 ≤ 0）
    }
    if (used + item.tokens > candidateBudget) {
      break; // 预算耗尽停止（溢出即停止，不跳过继续）
    }
    selected.push(item);
    used += item.tokens;
  }

  const sections = [...wsSection, ...selected.map(projectItem)].sort(byViewOrder);
  const type = deriveType(sections);
  const original_artifact_ids = selected.filter((i) => i.kind === 'artifact').map((i) => i.id);

  const body = {
    ir_version: '2.0',
    schema: 'omb/A3',
    type,
    sections,
    original_artifact_ids,
    total_tokens: sections.reduce((s, x) => s + x.tokens, 0),
    restore_capable: selected.some((i) => i.kind === 'artifact'),
    deterministic: true,
    scope: 'Session',
    lifecycle: 'active',
    immutable: true,
    owner: 'kernel',
    created: FIXED_TS,
    updated: FIXED_TS,
    provenance: FIXED_PROVENANCE,
    refs: [],
  };

  // immutable 对象：id = 内容哈希（确定性；改内容 → 新 id），符合 irBase 语义（§4.1）
  return { id: makeImmutableId(canonicalJson(body)), ...body } as ContextProjection;
}

// ---- ④ 投影决策 ----

/** 候选视图 → A3 section view 名（三视图命名：planning/execution_scratch/evidence_artifact） */
const PROJECT_VIEW: Record<CandidateView, string> = {
  planning: 'planning',
  scratch: 'execution_scratch',
  evidence: 'evidence_artifact',
};

type ProjectionSection = ContextProjection['sections'][number];

/** 投影决策（§6.1）：原文 | 摘要 | 指针。verbatim/ast_marker/schema_marker/kept_as_evidence 保留原文 */
function projectItem(item: CandidateItem): ProjectionSection {
  return {
    source_ref: item.source_ref,
    view: PROJECT_VIEW[item.view],
    content: projectContent(item),
    tokens: item.tokens,
  };
}

/** working_state：verbatim 原文（绝不盲压缩）→ planning 视图；tokens 用字符/4 估算（无输入估算） */
function projectWorkingState(ws: WorkingStateView): ProjectionSection {
  const content = JSON.stringify(ws);
  return { source_ref: 'working_state', view: 'planning', content, tokens: estimateTokens(content) };
}

/** 按分型投影内容：semantic → 摘要；pointer → ArtifactRef 指针；其余保留原文 */
function projectContent(item: CandidateItem): string {
  switch (route(item)) {
    case 'semantic':
      return summarize(item.content);
    case 'pointer':
      return `ref:${item.source_ref}`;
    default:
      return item.content;
  }
}

// ---- 内部辅助（纯函数） ----

/** memory 语义投影初值（§6.1：确定性摘要——超长截断加省略号；精确摘要为 §17 标定项） */
const MEMORY_SUMMARY_LIMIT = 120;

function summarize(content: string): string {
  return content.length <= MEMORY_SUMMARY_LIMIT ? content : `${content.slice(0, MEMORY_SUMMARY_LIMIT)}…`;
}

/** logs 重复消除（§6.1）：同 content 的 logs 只保留输入序首个 */
function dedupLogs(candidates: CandidateItem[]): CandidateItem[] {
  const seen = new Set<string>();
  const out: CandidateItem[] = [];
  for (const c of candidates) {
    if (c.kind === 'logs') {
      if (seen.has(c.content)) {
        continue;
      }
      seen.add(c.content);
    }
    out.push(c);
  }
  return out;
}

/** 贪心排序：marginal 降序；同边际按 id 升序（确定性 tie-break） */
function byMarginalDesc(
  a: { item: CandidateItem; marginal: number },
  b: { item: CandidateItem; marginal: number },
): number {
  return b.marginal - a.marginal || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
}

/** 三视图分组：planning → execution_scratch → evidence_artifact（组内保持选择序，sort 稳定） */
const VIEW_ORDER: Record<string, number> = { planning: 0, execution_scratch: 1, evidence_artifact: 2 };

function byViewOrder(a: { view: string }, b: { view: string }): number {
  return (VIEW_ORDER[a.view] ?? 0) - (VIEW_ORDER[b.view] ?? 0);
}

/** type 映射（§6.1）：单一视图 → 对应类型；多视图/空 → mixed */
function deriveType(sections: readonly ProjectionSection[]): ContextProjection['type'] {
  const views = new Set(sections.map((s) => s.view));
  if (views.size === 1) {
    return [...views][0] as ContextProjection['type'];
  }
  return 'mixed';
}

/** token 估算（无输入估算时的兜底：字符/4；精确计费为 §17 参数标定项） */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function sectionTokens(sections: readonly ProjectionSection[]): number {
  return sections.reduce((s, x) => s + x.tokens, 0);
}

// ---- 确定性 IRBase 字段（纯函数不读时钟；真实时间/provenance 由调用层注入） ----

/** 固定纪元时间戳（确定性） */
const FIXED_TS = '2026-08-21T00:00:00.000Z';

/** 固定 Provenance（确定性占位；环境指纹固定，跨环境迁移语义由调用层负责） */
const FIXED_PROVENANCE = {
  source: 'renderer',
  event: 'context/compile',
  actor: 'kernel',
  environment: { os: 'win32', node: '24.12.0', dsh_version: '0.2.0', project: 'omb-v2' },
  runtime_snapshot: 'rs:compile',
  timestamp: FIXED_TS,
  transformation_chain: ['content_router', 'marginal_greedy', 'view_projection'],
  verification: 'deterministic-pure',
};
