// layer 2：R7 Context 候选来源扩展（架构 §6.1 候选全集——Memory/Evidence/Capability/Process/Artifact）。
// 评估依据（.omb/drafts/下一步说明.md §14A）：buildContextProjection 输入 = WorkingState + retrieved.items
// （仅 Memory）→ 三视图结构已实现、内容来源不完整。本模块为候选统一入口：
//   gatherContextCandidates —— 从各来源收集（确定性：同来源状态 → 同候选序列，无随机/时钟依赖；
//     I/O 仅限注入来源的只读查询面）→ ContextCandidate[]；
//   toCandidateItems —— 映射为 renderer CandidateItem（marginal 贪心预算选择语义复用，编译面零感知）。
// ΔInfoValue（§17 开放项）：info_value 仍为来源侧提供/启发式——memory 沿用检索价值 r.value（调用方
//   近似），其余来源为固定启发式初值；**不实现动态 ΔInfoValue 估计**（估计规则留待 §17）。
// 层 DAG（CONVENTIONS §4）：runtime(2) → kernel(2)/memory(2)/runtime(2)/supervisor(1) 均满足
//   "import 目标层 ≤ 源层"；仅 type-only import supervisor（结构查询面，无运行时依赖）。
import type { RankedMemory } from '../memory/retrieve.js';
import type { Event } from '../kernel/schemas/m.js';
import type { CapabilityLike } from '../supervisor/capability.js';
import type { ArtifactMeta } from '../supervisor/artifact-store.js';
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

// ---- ΔInfoValue 启发式初值（§17 开放项：当前为来源侧固定启发式，非动态估计——动态 ΔInfoValue
//      估计规则留待 §17；memory 除外——沿用既有检索价值 r.value） ----

/** evidence 候选信息价值（最近事实链相关性；待标定 §17） */
export const EVIDENCE_INFO_VALUE = 120;
/** capability 候选信息价值（当前可用能力；待标定 §17） */
export const CAPABILITY_INFO_VALUE = 100;
/** process 候选信息价值（决策过程——**全源最高** → 贪心首选，R3「认知过程」section 语义保持；待标定 §17） */
export const PROCESS_INFO_VALUE = 200;
/** artifact 候选信息价值（可 restore 制品；待标定 §17） */
export const ARTIFACT_INFO_VALUE = 150;

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
  /** Δ信息价值（§17 开放项：来源侧提供/启发式，非动态估计） */
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

/** artifact 来源：制品索引面（最近/关联制品；get 范围恢复为编译面职责，收集只需 meta） */
export interface ArtifactSource {
  index(): Promise<Map<string, ArtifactMeta>>;
}

/** R7 候选来源集（缺省无 artifactStore → artifact 候选空——CognitiveRuntime 未装配 artifact-store） */
export interface ContextCandidateSources {
  eventStore: EvidenceEventSource;
  capabilities: CapabilitySource;
  artifactStore?: ArtifactSource;
}

/** gatherContextCandidates 输入（working_state/goal 为契约预留——ΔInfoValue 动态估计 §17 接入点，最小实现暂不读取） */
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
 * ΔInfoValue 文档化：memory 沿用 r.value（既有近似）；其余来源为固定启发式初值（§17 开放项：
 *   动态 ΔInfoValue 估计规则留待，本函数**不实现动态估计**）。
 */
export async function gatherContextCandidates(input: GatherContextCandidatesInput): Promise<ContextCandidate[]> {
  const { memory_items, runtime, process, session_id } = input;
  const out: ContextCandidate[] = [];

  // Memory：既有检索项（kind=memory；info_value 沿用检索价值 r.value——调用方近似，§17 开放项）
  for (const r of memory_items) {
    out.push({
      kind: 'memory',
      ref: r.memory.id,
      view: 'summary',
      content: r.memory.payload,
      tokens_est: estimateTokens(r.memory.payload),
      info_value: r.value,
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
          info_value: EVIDENCE_INFO_VALUE,
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
        info_value: CAPABILITY_INFO_VALUE,
      });
    }
  } catch {
    // 注册表查询失败 → 无 capability 候选（尽力而为）
  }

  // Process：R3 调度结果（复用 process section 渲染；info_value 全源最高 → 贪心首选——决策过程始终入投影）
  if (process !== undefined && process !== null) {
    const content = renderProcessContent(process);
    out.push({
      kind: 'process',
      ref: `process:${process.process_id}`,
      view: 'original',
      content,
      tokens_est: estimateTokens(content),
      info_value: PROCESS_INFO_VALUE,
    });
  }

  // Artifact：最近制品（created 降序，K 条封顶；缺省空——CognitiveRuntime 未装配 artifact-store，
  // 装配方注入来源后生效；「关联制品」（按任务/会话）无既有数据面 → 留待 §17）
  if (runtime.artifactStore !== undefined) {
    try {
      const index = await runtime.artifactStore.index();
      const metas = [...index.entries()]
        .sort((a, b) =>
          a[1].created === b[1].created
            ? a[0] < b[0]
              ? -1
              : 1
            : a[1].created < b[1].created
              ? 1
              : -1,
        )
        .slice(0, ARTIFACT_CANDIDATE_LIMIT);
      for (const [id, meta] of metas) {
        const content = `制品：${meta.type}（${meta.scope}）`;
        out.push({
          kind: 'artifact',
          ref: id,
          view: 'pointer',
          content,
          tokens_est: estimateTokens(content),
          info_value: ARTIFACT_INFO_VALUE,
        });
      }
    } catch {
      // 制品索引失败 → 无 artifact 候选（尽力而为）
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
