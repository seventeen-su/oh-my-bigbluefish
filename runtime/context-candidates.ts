// layer 2：R7 Context 候选来源扩展（架构 §6.1 候选全集——Memory/Evidence/Capability/Process/Artifact）。
// 评估依据（.omb/drafts/下一步说明.md §14A）：buildContextProjection 输入 = WorkingState + retrieved.items
// （仅 Memory）→ 三视图结构已实现、内容来源不完整。本模块为候选统一入口：
//   gatherContextCandidates —— 从各来源收集（确定性：同来源状态 → 同候选序列，无随机/时钟依赖；
//     I/O 仅限注入来源的只读查询面）→ ContextCandidate[]；
//   toCandidateItems —— 映射为 renderer CandidateItem（marginal 贪心预算选择语义复用，编译面零感知）。
// ΔInfoValue（S3，§17 首版承诺）：info_value 经 estimateInfoValue 缺口匹配启发式动态估计——
//   按 WorkingState 缺口（evidence_gaps/open_questions）与候选内容的 token 匹配度计算，替代来源侧固定值
//   （memory 亦统一启发式——r.value 保留为检索排序信号，不直接作为投影价值；取较高者因尺度不可比
//   等价恒取启发式，故统一；空闲期反馈修正（Retrieval Episode 归因）留待 §17）。
// 层 DAG（CONVENTIONS §4）：runtime(2) → kernel(2)/memory(2)/runtime(2)/supervisor(1) 均满足
//   "import 目标层 ≤ 源层"；仅 type-only import supervisor（结构查询面，无运行时依赖）。
import type { RankedMemory } from '../memory/retrieve.js';
// S3：匹配 token 化复用 cjk-ngram 双侧分词（CJK bigram / 非 CJK 空白分词）——memory(2) 同层，层 DAG ✓
import { tokenizeForFts } from '../memory/cjk-ngram.js';
import type { Event } from '../kernel/schemas/m.js';
import type { CapabilityLike } from '../supervisor/capability.js';
import {
  estimateTokens,
  renderProcessContent,
  type CandidateItem,
  type CandidateView,
  type ProcessSectionInput,
} from './renderer.js';

// ---- 封顶常量（N/M/K，待标定 §17：以真实会话数据回写；初值 = 保守窗口） ----

/** evidence 候选封顶（N：最近会话 Observation/decision 事件条数；待标定 §17） */
export const EVIDENCE_CANDIDATE_LIMIT = 6;
/** capability 候选封顶（M：能力注册表当前可用能力条数；待标定 §17） */
export const CAPABILITY_CANDIDATE_LIMIT = 5;
/** artifact 候选封顶（K：最近/关联制品条数；待标定 §17） */
export const ARTIFACT_CANDIDATE_LIMIT = 3;
/** evidence 拉取窗口（先取至多 FE 条会话事件、过滤后取最近 N 条——event-store 仅支持 seq ASC 分页；
 * 会话事件数超窗口时只保证窗口内最近 N 条；待标定 §17） */
const EVIDENCE_FETCH_LIMIT = 200;

// ---- ΔInfoValue 缺口匹配启发式（S3：§17 首版承诺——WorkingState 缺口匹配度动态估计，替代来源侧固定值） ----
// 语义：info_value = 基础值 + gap 命中加权 + question 命中加权 − confirmed_facts 冲突减分（防重复信息）。
// 匹配度 = 候选内容 token 集与各缺口/问题 token 集的重叠比例（token 化复用 memory/cjk-ngram bigram）。
// 确定性纯函数：同 candidate + 同 working_state → 同值（无随机/时钟/I/O）。
// 边界：gap/open_questions 空 → 均匀基础值；候选内容空 → 0；confirmed_facts 冲突可减至 0。
// 首版权重为基础启发式（§17：空闲期反馈修正——Retrieval Episode 归因标定权重——留待后续，本版不实现）。

/** 基础信息价值（无缺口/无匹配时的低基础值——不臆造高价值；所有来源同尺度可比） */
export const INFO_VALUE_BASE = 60;
/** evidence_gaps 命中加权（缺口命中权重 > 问题命中权重——缺什么比问什么更关键） */
export const INFO_VALUE_GAP_BONUS = 120;
/** open_questions 命中加权 */
export const INFO_VALUE_QUESTION_BONUS = 60;
/** confirmed_facts 冲突减分（候选内容与已确认事实重叠 → 重复信息 → 减分，防重复投影） */
export const INFO_VALUE_CONFLICT_PENALTY = 60;

/** 缺口匹配启发式输入（WorkingState 缺口子集：evidence_gaps/open_questions/confirmed_facts） */
export interface InfoValueContext {
  evidence_gaps: readonly string[];
  open_questions: readonly string[];
  confirmed_facts: readonly string[];
}

/** token 化（复用 memory/cjk-ngram 双侧分词：CJK bigram / 非 CJK 空白分词）→ token 集 */
function tokenSet(text: string): Set<string> {
  return new Set(tokenizeForFts(text).split(' ').filter((t) => t.length > 0));
}

/** 候选 token 集与单个缺口文本 token 集的重叠比例（|cand ∩ entry| / |entry|；entry 空 → 0） */
function overlapRatio(cand: Set<string>, entry: string): number {
  const entryTokens = tokenSet(entry);
  if (entryTokens.size === 0) return 0;
  let hit = 0;
  for (const t of entryTokens) {
    if (cand.has(t)) hit += 1;
  }
  return hit / entryTokens.size;
}

/** 对一组缺口/问题取最大重叠比例（空组 → 0） */
function maxOverlap(cand: Set<string>, entries: readonly string[]): number {
  let best = 0;
  for (const entry of entries) {
    const r = overlapRatio(cand, entry);
    if (r > best) best = r;
  }
  return best;
}

/**
 * S3：首版 ΔInfoValue 缺口匹配启发式（§17 首版承诺——动态估计，替代来源侧固定值/ r.value 近似）。
 * info_value = BASE + GAP_BONUS·gapOverlap + QUESTION_BONUS·questionOverlap − CONFLICT_PENALTY·factOverlap，
 * 下限 0（冲突全命中可减至 0）。候选内容空 → 0。确定性纯函数。
 */
export function estimateInfoValue(content: string, working_state: InfoValueContext): number {
  if (content.trim().length === 0) return 0;
  const cand = tokenSet(content);
  if (cand.size === 0) return 0;
  const gap = maxOverlap(cand, working_state.evidence_gaps);
  const question = maxOverlap(cand, working_state.open_questions);
  const conflict = maxOverlap(cand, working_state.confirmed_facts);
  const raw = INFO_VALUE_BASE + INFO_VALUE_GAP_BONUS * gap + INFO_VALUE_QUESTION_BONUS * question - INFO_VALUE_CONFLICT_PENALTY * conflict;
  return Math.max(0, Math.round(raw));
}

/** evidence 候选事件类型（Observation/decision 类；会话事实链——与 state-reducer 已注册处理类型对齐） */
export const EVIDENCE_EVENT_TYPES: readonly string[] = [
  'decision/made',
  'tool/result',
  'claim/update',
  'observation/contradictory',
  'evidence/revoked',
];

// ---- 候选统一形态（R7：来源侧投影候选；view = 投影决策：原文|摘要|指针，§6.1 ④） ----

/** R7 Context 候选（统一入口产物；编译面经 toCandidateItems 接入 renderer 贪心选择） */
export interface ContextCandidate {
  kind: 'memory' | 'evidence' | 'capability' | 'process' | 'artifact';
  /** 来源引用（memory=记忆 id；evidence=event:<id>；capability=能力 id；process=process:<id>；artifact=制品 id） */
  ref: string;
  /** 投影决策（来源侧声明；编译面按 kind 路由实际执行——semantic/pointer/original） */
  view: 'original' | 'summary' | 'pointer';
  content: string;
  tokens_est: number;
  /** Δ信息价值（S3：缺口匹配启发式动态估计——estimateInfoValue；空闲期反馈修正留待 §17） */
  info_value: number;
}

// ---- 来源查询面（结构最小面；CognitiveRuntime 结构上满足——装配期直接传入） ----

/** evidence 来源：事件查询面（最近会话 Observation/decision 事件） */
export interface EvidenceEventSource {
  query(opts: { session_id?: string; limit?: number }): Promise<{ events: Event[] }>;
}

/** capability 来源：能力注册表发现面（当前可用能力） */
export interface CapabilitySource {
  list(): CapabilityLike[];
}

/** artifact 来源：制品索引查询面（S4 Artifact Index——goal 为任务关联查询预留；当前索引提供最近 N 条） */
export interface ArtifactQueryItem {
  id: string;
  payload: string;
}

/** artifact 来源函数（goal=当前任务 goal——关联查询预留；limit=封顶；返回 {id, payload} 最小形状） */
export type ArtifactSource = (goal: string, limit: number) => Promise<ArtifactQueryItem[]>;

/** R7 候选来源集（缺省无 artifacts 来源 → artifact 候选空——未装配 Artifact Index，装配方注入后生效） */
export interface ContextCandidateSources {
  eventStore: EvidenceEventSource;
  capabilities: CapabilitySource;
  artifacts?: ArtifactSource;
}

/** gatherContextCandidates 输入（working_state 被 estimateInfoValue 缺口匹配启发式读取——S3；goal 契约预留） */
export interface GatherContextCandidatesInput {
  working_state: {
    goal: string;
    confirmed_facts: string[];
    active_hypotheses: string[];
    contradictions: string[];
    open_questions: string[];
    evidence_gaps: string[];
    next_best_action: string;
    environment: string;
  };
  goal: string;
  memory_items: RankedMemory[];
  runtime: ContextCandidateSources;
  /** R3 调度结果（process 来源；复用 process section 渲染；null/缺省 → 无 process 候选） */
  process?: ProcessSectionInput | null;
  /** 会话 id（evidence 候选按会话事件链查询；缺省 → 无 evidence 候选——不跨会话臆造） */
  session_id?: string;
}

// ---- 候选收集 ----

/**
 * R7：候选统一入口——从各来源收集 ContextCandidate[]（Memory/Evidence/Capability/Process/Artifact）。
 * 确定性：同来源状态 → 同候选序列（来源查询只读、无随机/时钟；排序与封顶均为确定性规则）；
 * 各来源失败降级（查询异常/空）→ 该来源候选空（不阻塞其余来源——尽力而为）。
 * ΔInfoValue（S3，§17 首版承诺）：五来源 info_value 统一经 estimateInfoValue 缺口匹配启发式动态估计
 *   （memory 亦统一——r.value 为检索排序信号不直接作为投影价值；固定来源值已移除）。空闲期反馈修正
 *   （Retrieval Episode 归因标定权重）留待 §17，本函数不实现。
 */
export async function gatherContextCandidates(input: GatherContextCandidatesInput): Promise<ContextCandidate[]> {
  const { memory_items, runtime, process, session_id, working_state } = input;
  const out: ContextCandidate[] = [];
  const valueOf = (content: string): number => estimateInfoValue(content, working_state);

  // Memory：既有检索项（kind=memory；info_value 经缺口匹配启发式——统一语义，见函数文档）
  for (const r of memory_items) {
    out.push({
      kind: 'memory',
      ref: r.memory.id,
      view: 'summary',
      content: r.memory.payload,
      tokens_est: estimateTokens(r.memory.payload),
      info_value: valueOf(r.memory.payload),
    });
  }

  // Evidence：最近会话 Observation/decision 事件（event-store 查询，N 条封顶；无 session_id → 不查询）
  if (session_id !== undefined) {
    try {
      const { events } = await runtime.eventStore.query({ session_id, limit: EVIDENCE_FETCH_LIMIT });
      const evidence = events.filter((e) => EVIDENCE_EVENT_TYPES.includes(e.type)).slice(-EVIDENCE_CANDIDATE_LIMIT);
      for (const e of evidence) {
        const content = `${e.type}: ${JSON.stringify(e.payload)}`;
        out.push({
          kind: 'evidence',
          ref: `event:${e.id}`,
          view: 'original',
          content,
          tokens_est: estimateTokens(content),
          info_value: valueOf(content),
        });
      }
    } catch {
      // 事件查询失败 → 无 evidence 候选（尽力而为，不阻塞收集）
    }
  }

  // Capability：能力注册表当前可用能力（M 条封顶）
  try {
    const caps = runtime.capabilities.list().slice(0, CAPABILITY_CANDIDATE_LIMIT);
    for (const c of caps) {
      const content = `能力：${c.name}（${c.authority_scope}）`;
      out.push({
        kind: 'capability',
        ref: c.id,
        view: 'original',
        content,
        tokens_est: estimateTokens(content),
        info_value: valueOf(content),
      });
    }
  } catch {
    // 注册表查询失败 → 无 capability 候选（尽力而为）
  }

  // Process：R3 调度结果（复用 process section 渲染；info_value 经缺口匹配启发式——固定 200 已移除，
  // 「若未来引入更高价值来源过程可能让位」成为真实语义：决策过程不再恒全源最高，缺口匹配时才优先）
  if (process !== undefined && process !== null) {
    const content = renderProcessContent(process);
    out.push({
      kind: 'process',
      ref: `process:${process.process_id}`,
      view: 'original',
      content,
      tokens_est: estimateTokens(content),
      info_value: valueOf(content),
    });
  }

  // Artifact：制品索引最近产物（K 条封顶；缺省空——未装配 Artifact Index 时无 artifact 候选，装配方
  // 注入后生效；「关联制品」（按任务/会话匹配）为查询面预留——S4 索引当前提供最近 N 条，任务关联匹配留待 §17）
  if (runtime.artifacts !== undefined) {
    try {
      const artifacts = await runtime.artifacts(input.goal, ARTIFACT_CANDIDATE_LIMIT);
      for (const a of artifacts) {
        out.push({
          kind: 'artifact',
          ref: a.id,
          view: 'pointer',
          content: a.payload,
          tokens_est: estimateTokens(a.payload),
          info_value: valueOf(a.payload),
        });
      }
    } catch {
      // 制品索引查询失败 → 无 artifact 候选（尽力而为）
    }
  }

  return out;
}

// ---- 编译面映射 ----

/** 候选 kind → 功能视图（输入侧三视图：planning/scratch/evidence；编译面 PROJECT_VIEW 映射为 A3 视图名） */
const KIND_VIEW: Record<ContextCandidate['kind'], CandidateView> = {
  memory: 'planning',
  evidence: 'evidence',
  capability: 'planning',
  process: 'planning',
  artifact: 'evidence',
};

/**
 * R7：ContextCandidate[] → renderer CandidateItem[]（编译面接入——marginal 贪心/预算/视图投影语义复用，
 * 编译函数零感知新来源；ref 透传 id/source_ref——artifact 候选 id 进入 original_artifact_ids）。
 */
export function toCandidateItems(candidates: readonly ContextCandidate[]): CandidateItem[] {
  return candidates.map((c) => ({
    id: c.ref,
    kind: c.kind,
    content: c.content,
    tokens: c.tokens_est,
    view: KIND_VIEW[c.kind],
    info_value: c.info_value,
    source_ref: c.ref,
  }));
}
