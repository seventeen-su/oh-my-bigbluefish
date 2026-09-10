// layer 2（memory/）：关系边生成（已知问题《关系图为空图》——"关系由词法 + 向量召回共同驱动"）。
//
// 问题：原关系图只有 kind 邻接规则（Decision→Episodic / Constraint→Semantic / Episodic→Procedural）
// 三条建边路径，而生产记忆几乎全是 Episodic+Profile → 规则永不匹配 → 关系表 0 行，扩展/度数恒空转。
//
// 本模块的建边判据（与检索的两条召回通道**同口径**，不另立一套相似度标准）：
//   - 词法：payload 经 `tokenizeForFts`（CJK bigram + 拉丁词，与 FTS 索引完全同源）后的 **Jaccard 重叠**；
//   - 向量：库内已存向量的**余弦相似度**（未编码条目缺失 → 只用词法，绝不假装有向量证据）；
//   - 合成强度 = 0.5×词法 + 0.5×向量（仅词法可用时 = 词法），≥ 阈值才建边，权重即强度。
// 边来源如实标注 `lexical` / `vector` / `both`（`relationSource`）——"这条边凭什么存在"可回查。
//
// 规模与节律：单次建图只扫一批（`RELATION_BUILD_BATCH`）且每点最多留 `RELATION_MAX_NEIGHBORS` 条最强边，
// 纯 CPU、无模型调用、可中断（幂等 upsert，重跑不放大权重）；是否该建图由 `relationNeedsBuild` 判定
// （图稀疏才建，不空转）。
//
// layer 2（memory/）：仅 node: 内置 + 同层模块 + kernel/schemas/。
import type { Memory } from '../kernel/schemas/m.js';
import type { RelationBackend, RelationSource } from './backend-relation.js';
import { tokenizeForFts } from './cjk-ngram.js';
import { cosineSimilarity } from './embeddings.js';

/** 相似度边类型（与规则边 informs/constrains/exemplifies、谱系边 merged 并列） */
export const SIMILAR_LINK_TYPE = 'similar';

/** 建边阈值（合成强度下限；0.45 = "词法或向量至少一路明显相近"，§17 待标定） */
export const RELATION_SIM_THRESHOLD = 0.45;

/** 合成权重（词法保精度、向量保召回，等权起步；§17 待标定） */
export const RELATION_LEXICAL_WEIGHT = 0.5;
export const RELATION_VECTOR_WEIGHT = 0.5;

/** 单源通道显著下限（来源标注用：低于此值的通道不算"驱动了这条边"） */
export const RELATION_CHANNEL_MIN = 0.2;

/** 单次建图批次上限与每点邻居上限（防一次维护占用过久 / 防度数膨胀） */
export const RELATION_BUILD_BATCH = 200;
export const RELATION_MAX_NEIGHBORS = 5;

/** 建图最少记忆数（少于 2 条无边可建） */
export const RELATION_MIN_MEMORIES = 2;

/** 向量来源（结构类型：VectorBackend 提供；纯词法后端不满足 → 只用词法证据） */
export interface VectorSource {
  vectorsFor(ids: readonly string[]): Map<string, Float32Array>;
}

/** 结构判定：后端是否带向量读取面（不带 → 词法驱动，仍可建图） */
export function asVectorSource(b: unknown): VectorSource | null {
  const f = (b as { vectorsFor?: unknown } | null | undefined)?.vectorsFor;
  return typeof f === 'function' ? (b as VectorSource) : null;
}

/** 计划中的一条边（建图纯函数输出；写入由 applySimilarityEdges 承担） */
export interface PlannedEdge {
  from_id: string;
  to_id: string;
  weight: number;
  source: RelationSource;
}

/** payload token 集合（与 FTS 索引同口径：CJK bigram + 拉丁词；空 token 丢弃） */
export function payloadTokenSet(payload: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenizeForFts(payload).split(' ')) {
    if (t.length > 0) out.add(t);
  }
  return out;
}

/** Jaccard 重叠（空集合 → 0：无 token 即无词法证据） */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) {
    if (large.has(t)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 合成强度（向量缺失 → 仅词法；两路都算不出 → 0） */
export function relationStrength(lexical: number, vector: number | null): number {
  const lex = Math.max(0, lexical);
  if (vector === null) return Math.min(1, lex);
  return Math.min(1, RELATION_LEXICAL_WEIGHT * lex + RELATION_VECTOR_WEIGHT * Math.max(0, vector));
}

/** 来源标注（哪条通道显著驱动了这条边；都不显著 → 取较强的一路，不虚构 'both'） */
export function relationSource(lexical: number, vector: number | null): RelationSource {
  if (vector === null) return 'lexical';
  const l = lexical >= RELATION_CHANNEL_MIN;
  const v = vector >= RELATION_CHANNEL_MIN;
  if (l && v) return 'both';
  return v && vector >= lexical ? 'vector' : 'lexical';
}

/**
 * 建图计划（纯函数，确定性）：只考虑 Active/Dormant 记忆，逐点取强度最高的若干邻居，
 * 双向去重（同一对只出一条边，方向 = 排序在前者为 from——边语义是"相近"，方向不承载含义）。
 */
export function planSimilarityEdges(
  memories: readonly Memory[],
  vectors: ReadonlyMap<string, Float32Array>,
  opts: { threshold?: number; maxNeighbors?: number } = {},
): PlannedEdge[] {
  const threshold = opts.threshold ?? RELATION_SIM_THRESHOLD;
  const maxNeighbors = Math.max(1, Math.floor(opts.maxNeighbors ?? RELATION_MAX_NEIGHBORS));
  const pool = memories
    .filter((m) => m.lifecycle === 'Active' || m.lifecycle === 'Dormant')
    .slice()
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  const tokens = new Map<string, Set<string>>();
  for (const m of pool) {
    tokens.set(m.id, payloadTokenSet(m.payload));
  }
  const scored: { from: string; to: string; weight: number; source: RelationSource }[] = [];
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i]!;
    const ta = tokens.get(a.id)!;
    const va = vectors.get(a.id) ?? null;
    const mine: { to: string; weight: number; source: RelationSource }[] = [];
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const b = pool[j]!;
      if (a.payload === b.payload) continue; // 完全重复属 dedup 的职责，不建相似边
      const lex = jaccard(ta, tokens.get(b.id)!);
      const vb = vectors.get(b.id) ?? null;
      const vec = va !== null && vb !== null ? cosineSimilarity(va, vb) : null;
      const weight = relationStrength(lex, vec);
      if (weight < threshold) continue;
      mine.push({ to: b.id, weight: Number(weight.toFixed(4)), source: relationSource(lex, vec) });
    }
    mine.sort((x, y) => y.weight - x.weight || x.to.localeCompare(y.to));
    for (const m of mine.slice(0, maxNeighbors)) {
      const [from, to] = a.id < m.to ? [a.id, m.to] : [m.to, a.id];
      scored.push({ from, to, weight: m.weight, source: m.source });
    }
  }
  // 同一条边可能被两端各推一次 → 按 (from,to) 去重取最大权重（方向已归一，来源随之取该次判定）
  const best = new Map<string, PlannedEdge>();
  for (const e of scored) {
    const key = `${e.from}\u0000${e.to}`;
    const cur = best.get(key);
    if (cur === undefined || e.weight > cur.weight) {
      best.set(key, { from_id: e.from, to_id: e.to, weight: e.weight, source: e.source });
    }
  }
  return [...best.values()].sort((a, b) => a.from_id.localeCompare(b.from_id) || a.to_id.localeCompare(b.to_id));
}

/** 计划落地（幂等：重复建图只抬高权重，不新增重复边；返回新建/更新/未变计数） */
export async function applySimilarityEdges(
  backend: RelationBackend,
  planned: readonly PlannedEdge[],
  now: number = Date.now(),
): Promise<{ created: number; updated: number; unchanged: number }> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const e of planned) {
    const r = await backend.upsertRelation(e.from_id, e.to_id, SIMILAR_LINK_TYPE, {
      weight: e.weight,
      source: e.source,
      created: now,
    });
    if (r.created) created++;
    else if (r.updated) updated++;
    else unchanged++;
  }
  return { created, updated, unchanged };
}

/** 建图结果（维护任务摘要/测试断言面） */
export interface RelationBuildOutcome {
  /** 新建边数 */
  created: number;
  /** 权重被抬高的边数 */
  updated: number;
  /** 已存在且权重不低的边数 */
  unchanged: number;
  /** 本轮计划边数（强度达标） */
  planned: number;
  /** 本轮扫描记忆数 */
  scanned: number;
  /** 建图后的边总数 */
  edges: number;
}

/**
 * 是否该建图：有 ≥2 条记忆且边数低于"每两条记忆一条边"的稀疏线（edges < memories/2）时建。
 * 图稠密后不再空转；完全无相似内容时每轮重试有界（单批 200 条，纯 CPU）——不引入时间节律，
 * 避免"到点必跑"的隐式周期语义。
 */
export function relationNeedsBuild(edges: number, memories: number): boolean {
  return memories >= RELATION_MIN_MEMORIES && edges < Math.floor(memories / 2);
}
