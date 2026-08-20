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

/** Channel（§7.3 阶段 3：Memory Traversal Operator 选择结果） */
export type ChannelName = 'lexical' | 'relation' | 'temporal' | 'episode';

/** RankedMemory：rank = 序位（0 起），value = Memory Value（§7.4 统一价值模型） */
export interface RankedMemory {
  memory: Memory;
  rank: number;
  value: number;
}

export interface RetrievalResult {
  items: RankedMemory[];
  channel_used: ChannelName;
  /** 覆盖链（§7.3 阶段 1）：实际咨询的 scope 序列（止于首命中；全部无结果 = 全链） */
  scope_chain: Scope[];
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

/** Channel 选择（§7.3 阶段 3）：text → lexical；relation → relation；episodic 偏好 → episode；否则 temporal */
function selectChannel(q: RetrieveQuery, kindFilter: MemoryKind[] | null): ChannelName {
  if ((q.text ?? '').trim().length > 0) {
    return 'lexical';
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

/** retrievability（非 FTS 通道）：关系度数 > 0 → 有边分；无关系 → 基线分（§7.4，初值待标定） */
async function degreeRetrievability(backend: RetrievalBackend, m: Memory): Promise<number> {
  const walk = await backend.relationTraverse(m.id, [], 0);
  const seed = walk.nodes.find((n) => n.id === m.id);
  const degree = seed?.relations.length ?? 0;
  return degree > 0 ? RETRIEVABILITY_DEGREE_POS : RETRIEVABILITY_NO_DEGREE;
}

/** Memory Value（§7.4 统一价值模型，初值权重）：0.4×utility + 0.3×reliability + 0.2×retrievability
 *  + 0.1×transferability − pollution − maintenance；retrievability：lexical 通道中仅真正 FTS 命中的
 *  候选记 1.0，扩展/其它候选按关系度数（§7.4 "FTS 命中/关系度数"）。 */
async function computeValue(
  backend: RetrievalBackend,
  m: Memory,
  channel: ChannelName,
  ftsHit: boolean,
): Promise<number> {
  const utility = deriveUtilityScore(m.utility_counts);
  const reliability = PROV_CLASS_RELIABILITY[m.prov_class] ?? 0.5;
  const retrievability =
    channel === 'lexical' && ftsHit ? RETRIEVABILITY_FTS_HIT : await degreeRetrievability(backend, m);
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
    scored.push({ memory: m, value: await computeValue(backend, m, channel, ftsHitIds.has(id)) });
  }
  scored.sort((x, y) => y.value - x.value); // 稳定排序：平局保持通道序
  return scored;
}

// ---- 入口 ----

/**
 * 分层路由检索（§7.3 六阶段：Scope → Kind → Channel → Expansion → Rank）：
 * - scope：覆盖链（会话优先，无则降级）；kind：显式 kind 或 task_type 偏好表；
 * - channel：lexical（FTS5）/ relation（关系遍历）/ episode（payload 时间排序）/ temporal（updated 排序）；
 * - expansion：结果不足 limit → top-1 depth-1 关系扩展；rank：Memory Value 降序。
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
  const channel = selectChannel(q, kindFilter);

  // 阶段 1-3：覆盖链逐层收集（会话优先，首个非空 scope 停止）；lexical 通道记录真正 FTS 命中集
  const seen = new Map<string, Memory>();
  const order: string[] = [];
  const ftsHitIds = new Set<string>();
  const consulted: Scope[] = [];
  for (const scope of chain) {
    consulted.push(scope);
    const cands = await collectChannel(backend, { ...parsed.data, scope }, kindFilter, channel);
    for (const m of cands) {
      if (!seen.has(m.id)) {
        seen.set(m.id, m);
        order.push(m.id);
      }
      if (channel === 'lexical') {
        ftsHitIds.add(m.id);
      }
    }
    if (order.length > 0) {
      break;
    }
  }

  // 阶段 4：Expansion（结果不足 limit → top-1 depth-1 关系扩展）
  if (order.length < parsed.data.limit && order.length > 0) {
    const extra = await expand(backend, seen, order, parsed.data.limit - order.length);
    for (const m of extra) {
      if (!seen.has(m.id)) {
        seen.set(m.id, m);
        order.push(m.id);
      }
    }
  }

  // 阶段 5：Rank（Memory Value 降序）
  const ranked = await rankCandidates(backend, seen, order, channel, ftsHitIds);
  const injected = ranked.slice(0, parsed.data.limit);
  const items: RankedMemory[] = injected.map((s, rank) => ({ memory: s.memory, rank, value: s.value }));

  const result: RetrievalResult = { items, channel_used: channel, scope_chain: consulted };
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
