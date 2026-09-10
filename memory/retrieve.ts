// OMB v2 记忆检索路由（架构 §7.3 六阶段读取 / §7.4 Memory Operator Algebra Retrieve 算子）：
// Query → Scope（覆盖链：Session 覆盖 Project 覆盖 Global，会话优先无则降级）→ Kind（显式 kind 或
// task_type 偏好表）→ Channel（lexical FTS5 / relation 关系遍历 / temporal updated 排序 /
// episode payload 时间排序）→ Expansion（结果不足 limit → top-1 depth-1 关系扩展，受 limit 约束）→
// Rank（Memory Value 统一价值模型）→ 结果（RankedMemory[] + channel_used + scope_chain + episode）。
// Memory Value（§7.4，初值权重待标定 §17）：
//   value = 0.4×utility_score + 0.3×reliability(prov_class) + 0.2×retrievability(FTS命中/关系度数)
//         + 0.1×transferability(scope) − pollution(Suspicious 代理 untrusted) − maintenance(payload 大小)
// Retrieval Episode 每次记录（recordEpisode，opts.episode=false 关闭）；outcome 由 reportEpisodeOutcome
// 事后归因（六计数器 + utility 更新入口，M5 ranking 学习输入）。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import { MemoryQuerySchema, type MemoryQuery } from '../kernel/schemas/a.js';
import type { Scope } from '../kernel/schemas/base.js';
import type { Memory, MemoryKind, MemoryProvClass } from '../kernel/schemas/m.js';
import type { RetrievalBackend } from './backend-retrieval.js';
import { deriveUtilityScore, recordEpisode, type RetrievalEpisode } from './utility.js';

// ---- 类型 ----

/** RetrieveQuery = MemoryQuery + 形态偏好声明（§7.3 task_type → 偏好表） */
export interface RetrieveQuery extends MemoryQuery {
  task_type?: 'qa' | 'planning' | 'debug' | 'generic';
}

/** Channel（§7.3 阶段 3：Memory Traversal Operator 选择结果）。
 *  已知问题《重构方向：双通道记忆系统》把通道重组成两组：
 *    - **语义检索组**（有文本查询）：lexical（词法）+ vector（向量）**先融合** → 关系图扩展重排；
 *      对外报告为 `semantic`（两组通道融合语义，旧的 `lexical` 单通道已不再是唯一路径）；
 *    - **时序组**（无文本 / 情景偏好）：episode（情景，payload 事件时间）+ temporal（更新时间兜底）。
 *  `relation` 作为独立通道仅在「显式给 relation 且无文本」的旧调用形态下使用（兼容保留）。 */
export type ChannelName = 'semantic' | 'lexical' | 'vector' | 'relation' | 'temporal' | 'episode';

/** 通道组（双通道记忆系统：语义检索组 / 时序组） */
export type RetrievalGroup = 'semantic' | 'relation' | 'episode' | 'temporal';

/** 融合权重（§17 可标定；初值：词法保精度、向量保召回，词法略高——精确术语/代号应优先） */
export const FUSION_WEIGHT_LEXICAL = 0.6;
export const FUSION_WEIGHT_VECTOR = 0.4;
/** 关系扩展的分数衰减（相邻节点按父分打折；深度 1；§17 可标定） */
export const RELATION_DECAY = 0.5;
/** 融合候选池上限（每通道取多少条参与融合；§17 可标定） */
export const FUSION_POOL_LIMIT = 30;
/** 单种子参与扩展的出边上限（边属性化后按权重而非全量入池；§17 可标定） */
export const RELATION_EXPAND_EDGE_LIMIT = 20;

/** RankedMemory：rank = 序位（0 起），value = Memory Value（§7.4 统一价值模型） */
export interface RankedMemory {
  memory: Memory;
  rank: number;
  value: number;
}

export interface RetrievalResult {
  items: RankedMemory[];
  /** 主通道（兼容字段：融合路径报告 'semantic'；时序路径报告 'episode'/'temporal'；旧形态 'lexical' 保留） */
  channel_used: ChannelName;
  /** 覆盖链（§7.3 阶段 1）：实际咨询的 scope 序列（止于首命中；全部无结果 = 全链） */
  scope_chain: Scope[];
  /** 本次实际参与召回的通道（多通道融合可观测面：如 ['lexical','vector']；时序组为 ['episode']） */
  channels_used: ChannelName[];
  /** Retrieval Episode（opts.episode=false 时无） */
  episode?: RetrievalEpisode;
}

// ---- 偏好/权重常量表（初值，待标定 §17） ----

/** task_type → 形态偏好（§7.3：问答→结构关系=Semantic/Decision、长程规划→程序性=Procedural、
 *  调试→episodic=Episodic、generic→全部）。偏好进能力向量反馈学习（M5 接）。 */
export const TASK_KIND_PREFERENCE: Record<'qa' | 'planning' | 'debug' | 'generic', MemoryKind[] | null> = {
  qa: ['Semantic', 'Decision'],
  planning: ['Procedural'],
  debug: ['Episodic'],
  generic: null,
};

/** prov_class → reliability 权重（初值，待标定 §17；用户声明/外部证明最高，模型推断最低） */
export const PROV_CLASS_RELIABILITY: Record<MemoryProvClass, number> = {
  'User-declared': 1.0,
  'Externally-attested': 0.9,
  Observation: 0.8,
  'Tool-derived': 0.7,
  'System-derived': 0.6,
  'Model-inferred': 0.5,
};

/** scope → transferability 权重（Global 最可迁移 > Project > Session；初值待标定 §17） */
export const SCOPE_TRANSFERABILITY: Record<Scope, number> = {
  Global: 1.0,
  Project: 0.7,
  Session: 0.4,
};

/** Memory Value 分量权重（§7.4 统一价值模型，初值待标定 §17；和为 1） */
export const VALUE_WEIGHTS = {
  future_utility: 0.4,
  reliability: 0.3,
  retrievability: 0.2,
  transferability: 0.1,
} as const;

/** pollution 扣减（untrusted 代理标记 = Suspicious lifecycle——M1 无 untrusted 字段，M5 加字段则替换） */
export const POLLUTION_PENALTY = 0.2;

/** maintenance 扣减（payload 大小；初值：100KB 达上限 0.2，线性） */
export const MAINTENANCE_MAX_PENALTY = 0.2;
export const MAINTENANCE_SCALE = 100_000;

/** retrievability（§7.4：FTS 命中 / 关系度数；初值待标定 §17） */
export const RETRIEVABILITY_FTS_HIT = 1.0;
export const RETRIEVABILITY_DEGREE_POS = 0.7;
export const RETRIEVABILITY_NO_DEGREE = 0.3;

/** episode channel 候选 payload 时间字段候选键（数值或 ISO 字符串） */
const PAYLOAD_TIME_KEYS = ['ts', 'timestamp', 'time'] as const;

const SCOPE_ORDER: Scope[] = ['Session', 'Project', 'Global'];

// ---- 纯函数 ----

/** 覆盖链：q.scope 起至 Global（§7.3 阶段 1：Session 覆盖 Project 覆盖 Global） */
function scopeChain(scope: Scope): Scope[] {
  return SCOPE_ORDER.slice(SCOPE_ORDER.indexOf(scope));
}

/** 有效 kind 过滤：显式 kind 优先；否则 task_type 偏好表（generic/无 task_type → 不限） */
function resolveKindFilter(q: RetrieveQuery): MemoryKind[] | null {
  if (q.kind !== undefined) {
    return [q.kind];
  }
  if (q.task_type === undefined) {
    return null;
  }
  return TASK_KIND_PREFERENCE[q.task_type] ?? null;
}

/** 通道组选择（双通道分流）：
 *  有文本查询 → 'semantic'（语义检索组：词法 + 向量融合 → 关系扩展重排）；
 *  无文本但显式 relation → 'relation'（关系遍历，兼容旧调用形态）；
 *  无文本且情景偏好 → 'episode'（时序组）；其余 → 'temporal'（时序组兜底）。 */
function selectGroup(q: RetrieveQuery, kindFilter: MemoryKind[] | null): RetrievalGroup {
  if ((q.text ?? '').trim().length > 0) {
    return 'semantic';
  }
  if (q.relation !== undefined) {
    return 'relation';
  }
  if (kindFilter !== null && kindFilter.includes('Episodic')) {
    return 'episode';
  }
  return 'temporal';
}

/** (updated, id) 复合降序（最新优先，id 兜底确定性；与 backend 非 FTS 排序一致） */
function cmpNewestFirst(a: Memory, b: Memory): number {
  const u = b.updated.localeCompare(a.updated);
  return u !== 0 ? u : b.id.localeCompare(a.id);
}

/** payload 时间提取：JSON 解析后取 ts/timestamp/time（数值或 ISO 字符串）→ epoch ms；不可解析 → null */
function payloadTime(payload: string): number | null {
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    for (const key of PAYLOAD_TIME_KEYS) {
      const v = obj[key];
      if (typeof v === 'number') {
        return v;
      }
      if (typeof v === 'string') {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) {
          return t;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** episode channel 排序：payload 时间字段降序（最新事件在前）；不可解析 → updated 降序 */
function cmpEpisodeNewestFirst(a: Memory, b: Memory): number {
  const ta = payloadTime(a.payload);
  const tb = payloadTime(b.payload);
  if (ta !== null && tb !== null && ta !== tb) {
    return tb - ta;
  }
  return cmpNewestFirst(a, b);
}

// ---- 各阶段实现 ----

/** 单 scope 候选收集：执行选定 channel 算子（backend.query 透传 text/relation，kind 过滤后置） */
async function collectChannel(
  backend: RetrievalBackend,
  query: MemoryQuery,
  kindFilter: MemoryKind[] | null,
  channel: ChannelName,
): Promise<Memory[]> {
  const page = await backend.query(query);
  let base = page.items;
  if (kindFilter !== null) {
    base = base.filter((m) => kindFilter.includes(m.kind));
  }
  if (channel === 'relation') {
    return collectRelation(backend, base, query.relation ?? '');
  }
  if (channel === 'episode') {
    return [...base].sort(cmpEpisodeNewestFirst);
  }
  return base; // lexical：FTS bm25 序；temporal：updated 降序（backend 默认序）
}

/** relation channel（§7.3：causal/dependency 等按 type 走 relation 表）：池内记忆为 seed，
 *  relationTraverse(seed, [type], 1) 的 depth-1 邻接记忆为候选（去重，发现序） */
async function collectRelation(backend: RetrievalBackend, pool: Memory[], type: string): Promise<Memory[]> {
  const out: Memory[] = [];
  const seen = new Set<string>();
  for (const seed of pool) {
    const walk = await backend.relationTraverse(seed.id, [type], 1);
    for (const node of walk.nodes) {
      if (node.depth !== 1 || seen.has(node.id)) {
        continue;
      }
      const m = await backend.getById(node.id);
      if (m) {
        seen.add(node.id);
        out.push(m);
      }
    }
  }
  return out;
}

/** Expansion（§7.3 阶段 4）：结果不足 limit → 对 top-1（当前序首位）做 relationTraverse depth 1
 *  全类型扩展，补充去重邻接记忆，受预算 maxAdd 约束；返回新增记忆（发现序；不改动 seen/order，
 *  由调用方统一写入，避免双写竞态）。 */
async function expand(backend: RetrievalBackend, seen: Map<string, Memory>, order: string[], maxAdd: number): Promise<Memory[]> {
  const top1 = order[0];
  if (top1 === undefined || maxAdd <= 0) {
    return [];
  }
  const walk = await backend.relationTraverse(top1, [], 1);
  const out: Memory[] = [];
  for (const node of walk.nodes) {
    if (out.length >= maxAdd) {
      break;
    }
    if (node.depth !== 1 || seen.has(node.id)) {
      continue;
    }
    const m = await backend.getById(node.id);
    if (m) {
      out.push(m);
    }
  }
  return out;
}

/** retrievability（§7.4）：关系度数 > 0 → 有边分；无关系 → 基线分（§7.4，初值待标定） */
async function degreeRetrievability(backend: RetrievalBackend, m: Memory): Promise<number> {
  const walk = await backend.relationTraverse(m.id, [], 0);
  const seed = walk.nodes.find((n) => n.id === m.id);
  const degree = seed?.relations.length ?? 0;
  return degree > 0 ? RETRIEVABILITY_DEGREE_POS : RETRIEVABILITY_NO_DEGREE;
}

/** 向量通道 retrievability 分（双通道命中之一；介于词法命中与纯关系度数之间——§17 可标定） */
export const RETRIEVABILITY_VECTOR_HIT = 0.9;

/** Memory Value（§7.4 统一价值模型，初值权重）：0.4×utility + 0.3×reliability + 0.2×retrievability
 *  + 0.1×transferability − pollution − maintenance。
 *  retrievability（已知问题《重构方向：双通道记忆系统》第 ④ 层改动）：由「词法是否命中」扩展为
 *  **词法命中 / 向量命中 / 关系度数** 三态——词法命中 1.0 > 向量命中 0.9 > 有边 0.7 > 无边 0.3。 */
async function computeValue(
  backend: RetrievalBackend,
  m: Memory,
  ftsHit: boolean,
  vectorHit = false,
): Promise<number> {
  const utility = deriveUtilityScore(m.utility_counts);
  const reliability = PROV_CLASS_RELIABILITY[m.prov_class] ?? 0.5;
  const retrievability = ftsHit
    ? RETRIEVABILITY_FTS_HIT
    : vectorHit
      ? RETRIEVABILITY_VECTOR_HIT
      : await degreeRetrievability(backend, m);
  const transferability = SCOPE_TRANSFERABILITY[m.scope] ?? 0.5;
  const pollution = m.lifecycle === 'Suspicious' ? POLLUTION_PENALTY : 0;
  const maintenance = Math.min(MAINTENANCE_MAX_PENALTY, (m.payload.length / MAINTENANCE_SCALE) * MAINTENANCE_MAX_PENALTY);
  return (
    VALUE_WEIGHTS.future_utility * utility +
    VALUE_WEIGHTS.reliability * reliability +
    VALUE_WEIGHTS.retrievability * retrievability +
    VALUE_WEIGHTS.transferability * transferability -
    pollution -
    maintenance
  );
}

/** Rank（§7.3 阶段 5）：按 Memory Value 降序；平局保留通道候选序（稳定排序——通道序编码了
 *  各算子的自然序：lexical=bm25 相关度、temporal=updated 降序、episode=payload 时间降序、
 *  relation=发现序）；返回 {memory, value} 序对 */
async function rankCandidates(
  backend: RetrievalBackend,
  seen: Map<string, Memory>,
  order: string[],
  channel: ChannelName,
  ftsHitIds: ReadonlySet<string>,
): Promise<{ memory: Memory; value: number }[]> {
  const scored: { memory: Memory; value: number }[] = [];
  for (const id of order) {
    const m = seen.get(id);
    if (!m) {
      continue;
    }
    scored.push({ memory: m, value: await computeValue(backend, m, ftsHitIds.has(id)) });
  }
  scored.sort((x, y) => y.value - x.value); // 稳定排序：平局保持通道序
  return scored;
}

// ---- 双通道融合（语义检索组：lexical + vector → 融合 → relation 扩展重排） ----

/** 融合候选（id → 合并分数与来源通道） */
interface FusedCandidate {
  memory: Memory;
  lexical: number;
  vector: number;
  relation: number;
}

/**
 * 词法候选归一化：按 bm25 序位给分（首位 1、末位趋近 0；确定性且不依赖 bm25 绝对值）。
 * 说明：bm25 原始分在同一候选集内可比，但跨查询/跨库不可比；序位归一化使融合权重可解释（§17 可标定）。
 */
function rankNormalize(index: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - index / total;
}

/**
 * 语义检索组：lexical 与 vector 各自召回 → 并集去重 → 加权合并（FUSION_WEIGHT_LEXICAL/VECTOR）。
 * 部分命中同样计分（这正是"互补融合"的意义：词法保精确命中、向量保近似召回）。
 */
async function collectSemanticGroup(
  backend: RetrievalBackend,
  query: MemoryQuery,
  kindFilter: MemoryKind[] | null,
  scope: Scope,
  channels: Set<ChannelName>,
): Promise<FusedCandidate[]> {
  const fused = new Map<string, FusedCandidate>();
  const upsert = (m: Memory): FusedCandidate => {
    let c = fused.get(m.id);
    if (c === undefined) {
      c = { memory: m, lexical: 0, vector: 0, relation: 0 };
      fused.set(m.id, c);
    }
    return c;
  };

  // ① 词法（FTS5 bm25 序）——精确命中、术语、代号、文件名
  const lexical = await collectChannel(backend, { ...query, scope, limit: FUSION_POOL_LIMIT }, kindFilter, 'lexical');
  lexical.forEach((m, i) => {
    upsert(m).lexical = rankNormalize(i, lexical.length);
  });
  if (lexical.length > 0) channels.add('lexical');

  // ② 向量（CPU 哈希词袋余弦）——改写、词序、token 集合近似
  if (typeof backend.vectorSearch === 'function') {
    try {
      const hits = await backend.vectorSearch(query.text ?? '', {
        scope,
        ...(kindFilter !== null ? { kinds: kindFilter } : {}),
        topK: FUSION_POOL_LIMIT,
      });
      if (hits.length > 0) channels.add('vector');
      for (const h of hits) {
        const c = upsert(h.memory);
        c.vector = Math.max(0, Math.min(1, h.score)); // 余弦 ∈ [-1,1]；负值已被 vectorSearch 过滤
      }
    } catch {
      // 向量通道不可用/失败 → 降级为纯词法（诚实降级，不影响其余通道）
    }
  }

  return [...fused.values()];
}

/** 融合分（加权合并；关系扩展追加衰减分——由 relationDecay 传入） */
function fusionScore(c: FusedCandidate): number {
  return FUSION_WEIGHT_LEXICAL * c.lexical + FUSION_WEIGHT_VECTOR * c.vector + c.relation;
}

/**
 * 关系图扩展与重排（语义检索组的第二阶段）：以融合候选为种子做 depth-1 关系扩展，
 * 邻接节点以 `RELATION_DECAY × 边权重 × 种子融合分` 入池（`relation` 分量），随后统一按融合分重排。
 * 边权重（已知问题《关系图为空图》新增的边属性）：规则/谱系边权重恒为 1 → 与既有数值完全一致；
 * 相似度边权重即「词法 + 向量」合成强度（弱相似 → 弱扩展，不再与强规则边同权）。
 * 只在结果不足 limit 时扩展（预算守卫；与既有 §7.3 阶段 4 同语义）。
 */
async function expandRelations(
  backend: RetrievalBackend,
  fused: FusedCandidate[],
  maxAdd: number,
  limit: number,
): Promise<FusedCandidate[]> {
  if (maxAdd <= 0 || fused.length === 0) return [];
  const ranked = [...fused].sort((a, b) => fusionScore(b) - fusionScore(a));
  const seeds = ranked.slice(0, Math.min(3, ranked.length)); // 前 3 个种子（§17 可标定）
  const known = new Set(fused.map((c) => c.memory.id));
  const added: FusedCandidate[] = [];
  for (const seed of seeds) {
    if (added.length >= maxAdd) break;
    const edges = backend
      .relationEdges({ from: seed.memory.id, limit: RELATION_EXPAND_EDGE_LIMIT })
      .slice()
      .sort((a, b) => b.weight - a.weight || a.to_id.localeCompare(b.to_id)); // 权重优先（同权按 id 确定性）
    for (const edge of edges) {
      if (added.length >= maxAdd) break;
      if (known.has(edge.to_id)) continue;
      const m = await backend.getById(edge.to_id);
      if (m === undefined) continue;
      known.add(edge.to_id);
      const weight = edge.weight > 0 && edge.weight <= 1 ? edge.weight : 1;
      added.push({
        memory: m,
        lexical: 0,
        vector: 0,
        relation: RELATION_DECAY * weight * fusionScore(seed),
      });
    }
  }
  void limit;
  return added;
}

// ---- 入口 ----

/**
 * 分层路由检索（双通道结构，已知问题《重构方向：双通道记忆系统》）：
 *
 * ```
 * 有文本查询        ──→ 【语义检索组】lexical ┐
 *                                            ┴─→ 融合去重 ─→ relation 扩展/重排 ─→ 候选
 *                              vector  ┘
 * 无文本 / 情景偏好 ──→ 【时序组】episode / temporal ─────────────────────────────→ 候选
 * ```
 *
 * - scope：覆盖链（会话优先，无则降级）；kind：显式 kind 或 task_type 偏好表；
 * - 语义组：词法与向量**先融合**（加权合并），结果共同作用于关系图扩展与重排；
 *   向量通道不可用/无候选 → 自动退回纯词法（`channels_used` 如实报告实际参与通道）；
 * - 时序组：episode（payload 事件时间）/ temporal（updated 兜底）；
 * - rank：Memory Value 降序（retrievability 已扩展为词法命中 / 向量相似 / 关系度数）。
 * Retrieval Episode 每次记录（opts.episode=false 关闭）；outcome 事后经 reportEpisodeOutcome 归因。
 */
export async function retrieve(
  backend: RetrievalBackend,
  q: RetrieveQuery,
  opts: { episode?: boolean } = {},
): Promise<RetrievalResult> {
  const parsed = MemoryQuerySchema.safeParse(q);
  if (!parsed.success) {
    throw new Error(`retrieve: 查询校验失败 — ${parsed.error.message}`);
  }
  if (q.task_type !== undefined && !(q.task_type in TASK_KIND_PREFERENCE)) {
    throw new Error(`retrieve: 非法 task_type: ${String(q.task_type)}`);
  }
  const chain = scopeChain(parsed.data.scope);
  const kindFilter = resolveKindFilter(q);
  const group = selectGroup(q, kindFilter);
  const channels = new Set<ChannelName>();

  // 阶段 1-3：覆盖链逐层收集（会话优先，首个非空 scope 停止）
  const seen = new Map<string, Memory>();
  const order: string[] = [];
  const ftsHitIds = new Set<string>();
  const vectorHitIds = new Set<string>();
  const consulted: Scope[] = [];
  /** 融合分（语义组；时序组为空——时序组按通道自然序，再由 Memory Value 排序） */
  const fusedScores = new Map<string, number>();
  let channel: ChannelName = group === 'semantic' ? 'lexical' : group === 'episode' ? 'episode' : group === 'relation' ? 'relation' : 'temporal';

  for (const scope of chain) {
    consulted.push(scope);
    if (group === 'semantic') {
      const fused = await collectSemanticGroup(backend, parsed.data, kindFilter, scope, channels);
      for (const c of fused) {
        if (!seen.has(c.memory.id)) {
          seen.set(c.memory.id, c.memory);
          order.push(c.memory.id);
        }
        fusedScores.set(c.memory.id, fusionScore(c));
        if (c.lexical > 0) ftsHitIds.add(c.memory.id);
        if (c.vector > 0) vectorHitIds.add(c.memory.id);
      }
    } else {
      const cands = await collectChannel(
        backend,
        { ...parsed.data, scope },
        kindFilter,
        group === 'episode' ? 'episode' : group === 'relation' ? 'relation' : 'temporal',
      );
      channels.add(group === 'episode' ? 'episode' : group === 'relation' ? 'relation' : 'temporal');
      for (const m of cands) {
        if (!seen.has(m.id)) {
          seen.set(m.id, m);
          order.push(m.id);
        }
      }
    }
    if (order.length > 0) {
      break;
    }
  }

  // 阶段 4：结果不足 limit → 扩展（语义组 = 关系图扩展重排；时序组 = top-1 depth-1 邻接补充）
  if (order.length < parsed.data.limit && order.length > 0) {
    const maxAdd = parsed.data.limit - order.length;
    if (group === 'semantic') {
      const fused = order.map((id) => ({
        memory: seen.get(id)!,
        lexical: 0,
        vector: 0,
        relation: fusedScores.get(id) ?? 0,
      }));
      // 重建融合分量（保留原分量：从 fusedScores 无法反推，故重新计算一次——纯函数、廉价）
      const rebuilt = await rebuildFused(backend, parsed.data, kindFilter, chain, order, seen);
      const extra = await expandRelations(backend, rebuilt.length > 0 ? rebuilt : fused, maxAdd, parsed.data.limit);
      for (const c of extra) {
        if (!seen.has(c.memory.id)) {
          seen.set(c.memory.id, c.memory);
          order.push(c.memory.id);
          fusedScores.set(c.memory.id, c.relation);
        }
      }
    } else {
      const extra = await expand(backend, seen, order, maxAdd);
      for (const m of extra) {
        if (!seen.has(m.id)) {
          seen.set(m.id, m);
          order.push(m.id);
        }
      }
    }
  }

  // 阶段 5：Rank（语义组：融合分降序 → 同分按 Memory Value；时序组：Memory Value 降序保持通道序）
  let ranked: { memory: Memory; value: number }[];
  if (group === 'semantic') {
    const scored: { memory: Memory; value: number; fused: number }[] = [];
    for (const id of order) {
      const m = seen.get(id);
      if (!m) continue;
      scored.push({
        memory: m,
        value: await computeValue(backend, m, ftsHitIds.has(id), vectorHitIds.has(id)),
        fused: fusedScores.get(id) ?? 0,
      });
    }
    scored.sort((x, y) => y.fused - x.fused || y.value - x.value || x.memory.id.localeCompare(y.memory.id));
    ranked = scored.map((s) => ({ memory: s.memory, value: s.value }));
    // 主通道报告：向量实际参与融合 → 'semantic'（双通道）；仅词法可用 → 'lexical'（诚实降级）
    channel = channels.has('vector') ? 'semantic' : 'lexical';
  } else {
    ranked = await rankCandidates(backend, seen, order, channel, ftsHitIds);
  }
  const injected = ranked.slice(0, parsed.data.limit);
  const items: RankedMemory[] = injected.map((s, rank) => ({ memory: s.memory, rank, value: s.value }));

  const result: RetrievalResult = {
    items,
    channel_used: channel,
    channels_used: [...channels].sort(),
    scope_chain: consulted,
  };
  if (opts.episode !== false) {
    const ep = await recordEpisode(backend, {
      query: JSON.stringify(q),
      scope: q.scope,
      candidate_ids: order, // 初始候选（rank 前全池，含扩展）
      ranked_ids: ranked.map((s) => s.memory.id), // rank 后全序
      injected_ids: injected.map((s) => s.memory.id), // 最终注入
    });
    result.episode = ep;
  }
  return result;
}

/** 重建语义组融合分量（扩展阶段需要"种子融合分"；按 id 序重算一次，纯函数且廉价） */
async function rebuildFused(
  backend: RetrievalBackend,
  query: MemoryQuery,
  kindFilter: MemoryKind[] | null,
  chain: Scope[],
  order: string[],
  seen: Map<string, Memory>,
): Promise<FusedCandidate[]> {
  const byId = new Map<string, FusedCandidate>();
  for (const id of order) {
    const m = seen.get(id);
    if (m !== undefined) byId.set(id, { memory: m, lexical: 0, vector: 0, relation: 0 });
  }
  for (const scope of chain) {
    const scratch = new Set<ChannelName>();
    const fused = await collectSemanticGroup(backend, query, kindFilter, scope, scratch);
    for (const c of fused) {
      const hit = byId.get(c.memory.id);
      if (hit !== undefined) {
        hit.lexical = c.lexical;
        hit.vector = c.vector;
      }
    }
    if (byId.size > 0) break;
  }
  return [...byId.values()];
}
