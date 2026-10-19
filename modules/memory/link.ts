/**
 * 记忆自动连边（3.7 Wave 2，task-17 §4）。
 *
 * ## 规则（确定性、零 LLM）
 *
 * 新写入一条记忆后：
 * 1. 取它的**实体键**（`capture.ts` 的 `extractEntityKeys`：路径/命令/包名/项目名）；
 * 2. 键数 < `MIN_KEYS`（2）→ 不连（单个键重合不足以说明同一主题，例如都用 `README.md`）；
 * 3. 用键的"人类可读部分"做一次**词法检索**（同库同作用域，候选上限 20）；
 * 4. 对候选逐条算键交集，**共享 ≥2 个键**才连，最多连 `maxLinks`（5）条；
 * 5. 边方向：新条目 → 旧条目（`related`），无权重（与既有边表一致）。
 *
 * ## 为什么是"写入后连边"而不是离线批处理
 *
 * 成本有界：一次词法检索 + 最多 5 次 upsertEdge，只在"新记忆有 ≥2 个键"时发生。
 * 收益是可解释的：`omb_relate` 能沿 `related` 看到"同一批文件/同一条命令"的邻居，
 * 召回侧也能按 1 hop 扩展（`retrieve.ts` 的 `expandRelated`）。
 *
 * 失败**不抛**：连边只是附加索引，不能影响"记忆已写入"这个事实。
 */
import type { Edge, EdgeType, Embedder, MemoryRecord, MemoryStore } from '../../kernel/abi/index.js'
import { extractEntityKeys } from './capture.js'

/** 便利 re-export：连边与实体键是同一套语义，调用方不必 import 两个模块。 */
export { extractEntityKeys } from './capture.js'

/** 自动连边最多连几条（任务书：≤5）。 */
export const MAX_AUTO_LINKS = 5
/** 至少共享几个实体键才连边（任务书：≥2）。 */
export const MIN_SHARED_KEYS = 2
/** 候选池上限（一次词法检索）。 */
export const AUTO_LINK_CANDIDATES = 20
/** 新条目自身至少要有的键数（少于这个数连检索都不做）。 */
export const MIN_KEYS = MIN_SHARED_KEYS
/** `related` 边的类型常量（ABI 已加入 `EDGE_TYPES`）。 */
export const RELATED_EDGE: EdgeType = 'related'

/**
 * 从实体键生成检索文本：去掉 `path:`/`cmd:`/`token:`/`project:` 前缀，
 * 用空格连接（`text.ts` 的分词器会保留英文/标识符、CJK 走 bigram）。
 */
export function keysAsQuery(keys: readonly string[]): string {
  const parts: string[] = []
  for (const key of keys) {
    const value = key.slice(key.indexOf(':') + 1).trim()
    if (value.length >= 2) parts.push(value)
  }
  return parts.slice(0, 20).join(' ')
}

/** 两条记忆共享的实体键（用于测试与解释）。 */
export function sharedEntityKeys(a: readonly string[], b: readonly string[]): readonly string[] {
  const right = new Set(b)
  return a.filter(key => right.has(key)).sort()
}

export interface AutoLinkOptions {
  /** 最多连几条（默认 5）。 */
  readonly maxLinks?: number
  /** 至少共享几个键（默认 2）。 */
  readonly minSharedKeys?: number
  /** 候选上限（默认 20）。 */
  readonly candidates?: number
  /** 时间戳（边创建时间；由调用方注入，模块层不读墙钟）。 */
  readonly now: number
  /** 该会话的项目身份（用于 `project:` 实体键）。 */
  readonly projectName?: string | null
}

export interface AutoLinkResult {
  readonly linked: readonly { readonly toId: string; readonly shared: readonly string[] }[]
  readonly skipped: 'too-few-keys' | 'no-candidates' | 'no-overlap' | null
}

/**
 * 给一条新写入的记忆自动连 `related` 边。**绝不抛**（异常在内部吞掉并返回 skipped）。
 *
 * @param store 该记录所在的库（必须与 `record.scope` 一致；调用方保证）。
 * @param record 刚 put 成功的记录。
 */
export async function autoLinkRelated(
  store: MemoryStore,
  record: MemoryRecord,
  options: AutoLinkOptions,
): Promise<AutoLinkResult> {
  const maxLinks = options.maxLinks ?? MAX_AUTO_LINKS
  const minSharedKeys = options.minSharedKeys ?? MIN_SHARED_KEYS
  const candidateLimit = options.candidates ?? AUTO_LINK_CANDIDATES
  try {
    const keys = extractEntityKeys(record.text, options.projectName ?? record.project)
    if (keys.length < MIN_KEYS) return { linked: [], skipped: 'too-few-keys' }

    const query = keysAsQuery(keys)
    if (query.length === 0) return { linked: [], skipped: 'too-few-keys' }

    let hits
    try {
      hits = await store.searchLexical({ text: query, scope: record.scope, limit: candidateLimit })
    } catch {
      return { linked: [], skipped: 'no-candidates' }
    }
    if (hits.length === 0) return { linked: [], skipped: 'no-candidates' }

    const candidates = await store.getMany(hits.map(hit => hit.id))
    const linked: { toId: string; shared: readonly string[] }[] = []
    let sawCandidate = false
    for (const candidate of candidates) {
      if (candidate.id === record.id) continue
      if (candidate.scope !== record.scope) continue
      if (candidate.validTo !== null) continue
      sawCandidate = true
      const shared = sharedEntityKeys(keys, extractEntityKeys(candidate.text, options.projectName ?? candidate.project))
      if (shared.length < minSharedKeys) continue
      const edge: Edge = {
        fromId: record.id,
        toId: candidate.id,
        type: RELATED_EDGE,
        createdAt: options.now,
      }
      try {
        await store.upsertEdge(edge)
      } catch {
        // 单条失败不拦其它（重复边由主键去重，失败多为库忙）
        continue
      }
      linked.push({ toId: candidate.id, shared })
      if (linked.length >= maxLinks) break
    }
    if (!sawCandidate) return { linked: [], skipped: 'no-candidates' }
    return { linked, skipped: linked.length === 0 ? 'no-overlap' : null }
  } catch {
    return { linked: [], skipped: 'no-candidates' }
  }
}

/** 一条"可能相关/冲突"的既有记录（只读，不建边、不改库）。 */
export interface RelatedRecord {
  readonly record: MemoryRecord
  readonly shared: readonly string[]
  /** 判据来源：实体键词法（v4.9.0）或向量通道（v4.9.1）。 */
  readonly via: 'lexical' | 'vector'
}

export interface RelatedLookupOptions {
  /** 最多返回几条（默认 3）。 */
  readonly maxResults?: number
  /** 至少共享几个实体键（默认 2，与自动连边同阈值）。 */
  readonly minSharedKeys?: number
  /** 候选池上限（默认 20）。 */
  readonly candidates?: number
  /** 该会话的项目身份（用于 `project:` 实体键）。 */
  readonly projectName?: string | null
}

/**
 * 找与给定记录共享实体键的**活跃**既有记录（v4.9.0：冲突/相关性可见）。
 *
 * 与 `autoLinkRelated` 同一套判据（实体键 + 共享 ≥2），但**只读**：
 * 不建边、不改库、不决定是否冲突。调用方把结果放进回执让**用户/模型**判断
 * （"若这条是对旧结论的更正，用 supersedes；若两条都成立，忽略提示"）。
 *
 * 排除：自身、非活跃（失效/被取代）、同作用域之外、完全相同内容。
 * 失败一律返回空数组（可见性提示不能影响写入本身）。
 */
export async function findRelatedRecords(
  store: MemoryStore,
  record: MemoryRecord,
  options: RelatedLookupOptions = {},
): Promise<readonly RelatedRecord[]> {
  const maxResults = options.maxResults ?? 3
  const minSharedKeys = options.minSharedKeys ?? MIN_SHARED_KEYS
  try {
    const keys = extractEntityKeys(record.text, options.projectName ?? record.project)
    if (keys.length < MIN_KEYS) return []
    const query = keysAsQuery(keys)
    if (query.length === 0) return []
    let hits
    try {
      hits = await store.searchLexical({
        text: query,
        scope: record.scope,
        limit: options.candidates ?? AUTO_LINK_CANDIDATES,
      })
    } catch {
      return []
    }
    if (hits.length === 0) return []
    const candidates = await store.getMany(hits.map(hit => hit.id))
    const related: RelatedRecord[] = []
    for (const candidate of candidates) {
      if (candidate.id === record.id) continue
      if (candidate.scope !== record.scope) continue
      if (candidate.validTo !== null || candidate.supersededBy !== null) continue
      if (candidate.contentHash === record.contentHash) continue
      const shared = sharedEntityKeys(keys, extractEntityKeys(candidate.text, options.projectName ?? candidate.project))
      if (shared.length < minSharedKeys) continue
      related.push({ record: candidate, shared, via: 'lexical' })
      if (related.length >= maxResults) break
    }
    return related
  } catch {
    return []
  }
}

export interface SemanticLookupOptions {
  /** 最多返回几条（默认 2；语义通道在词法之外补充，不抢主位）。 */
  readonly maxResults?: number
  /** 向量检索候选上限（默认 5）。 */
  readonly limit?: number
  /** 余弦下限（由装配层给 `cosineFloorFor(embedder)`；缺省 0 = 只丢非正）。 */
  readonly minScore?: number
}

/**
 * 向量通道的"可能相关"（v4.9.1）：补上**没有共享实体键**的自然语言条目。
 *
 * 与词法通道同一约束：只读、同作用域、活跃、内容不同、排除自身；
 * 归属（model/dim/revision）由 `searchVector` 校验，跨空间向量宁可不召回。
 * 任何一步失败（无嵌入器、无向量、库报错）都返回空数组——提示不能影响写入。
 *
 * **不改变写入决定**：语义相似只能说明"可能相关"，由回执交给用户/模型判断。
 */
export async function findSemanticRelated(
  store: MemoryStore,
  record: MemoryRecord,
  embedder: Embedder,
  options: SemanticLookupOptions = {},
): Promise<readonly RelatedRecord[]> {
  try {
    const vectors = await embedder.embed([record.text])
    const embedding = vectors[0]
    if (!(embedding instanceof Float32Array)) return []
    if (embedding.length !== embedder.dimensions) return []
    let hits
    try {
      hits = await store.searchVector({
        embedding,
        expect: { modelId: embedder.id, dim: embedder.dimensions, revision: embedder.revision },
        limit: options.limit ?? 5,
        minScore: options.minScore ?? 0,
      })
    } catch {
      return []
    }
    if (hits.length === 0) return []
    const candidates = await store.getMany(hits.map(hit => hit.id))
    const related: RelatedRecord[] = []
    for (const candidate of candidates) {
      if (candidate.id === record.id) continue
      if (candidate.scope !== record.scope) continue
      if (candidate.validTo !== null || candidate.supersededBy !== null) continue
      if (candidate.contentHash === record.contentHash) continue
      related.push({ record: candidate, shared: [], via: 'vector' })
      if (related.length >= (options.maxResults ?? 2)) break
    }
    return related
  } catch {
    return []
  }
}
