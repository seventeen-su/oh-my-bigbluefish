/**
 * 离线整合（规划 §5.6）——**纯逻辑**，无 I/O、无 LLM、无摘要。
 *
 * 四级流程 + 一条专门的反作弊：
 * 1. 精确去重 by `contentHash`；近重复用**哈希分块**（SimHash + 波段 LSH）生成候选
 *    —— **绝不 all-pairs**（修掉旧实现真二次方合并）
 * 2. **回响检测**：N 条痕迹同源（同 `contentHash`，或同 `sourceRef` 链且内容相近）
 *    塌缩为一条并累加 `useCount`。这是防「相关性痕迹导致的假晋升」——
 *    智能体第二次看到同一件错事，是因为它自己第一次写下了它。
 *    **独立性只能在离线计算**（在线时你还看不到第二条痕迹是不是回响）
 * 3. 矛盾：发 `conflicts_with` 边；当新条目 `assertedBy` 是 `user` / `execution`
 *    且来源等级不低于旧条目时，发 `supersedes` 边并设 `validTo`
 * 4. **衰减排序，不衰减行**——不删除（隐私除外，且隐私走 `erasureIds` → 端口的 `forget`）
 *
 * 每次运行的**合并次数硬上限**（默认 200），超限即停并如实报告 `truncated`。
 *
 * 与规划的一处**刻意的收窄**（安全性优先）：§5.6 字面写「同 `sourceRef` 链即同源」。
 * 但一条会话链里可以有很多**互不相同**的事实，"同链即塌缩"会丢记忆。因此这里要求
 * 「同链 **∧** 内容相近（或 sourceRef 完全相同）」——精确对上"同一件错事被重复写下"的形态。
 */
import type { AssertedBy, Edge, MemoryRecord } from '../../kernel/abi/index.js'
import { tokenizeForFts } from './text.js'

/** 合并次数的硬上限（每次运行）。 */
export const DEFAULT_MERGE_LIMIT = 200
/** 近重复判定的 token 集合 Jaccard 阈值。 */
export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.7
/** 哈希分块的键数（bottom-K）。 */
export const DEFAULT_BLOCKING_KEYS = 3
/** 单次运行允许的候选对比较上限（二次方合并的第二道保险）。 */
export const DEFAULT_MAX_PAIR_COMPARISONS = 20_000
/** 衰减半衰期（排序先验，不改数据）。 */
export const DEFAULT_DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000
/** 单条记录参与分块的 token 上限。 */
export const MAX_TOKENS_PER_RECORD = 256
/** 矛盾检测的**核心 token** Jaccard 阈值（比近重复更保守）。 */
export const DEFAULT_CONTRADICTION_THRESHOLD = 0.6

/** 来源等级：`user` > `execution` > `model`（可检验的置信度替代品）。 */
export const ASSERTED_RANK: Readonly<Record<AssertedBy, number>> = { user: 3, execution: 2, model: 1 }

/** 否定标记（**长者优先**，避免 `不要` 被拆成 `不` 而位翻转两次）。 */
const NEGATION_RE =
  /(?:不要|不能|不会|不许|不再|没有|取消|禁止|停止|移除|删除|关闭|无|不|没|未|非|别|勿|never|not|no|cannot|can't|don't|doesn't|won't|without|cancel|stop|disable|remove|delete)/gi

export interface ContradictionSignal {
  readonly aId: string
  readonly bId: string
  readonly detail?: string
}

export interface ConsolidationInput {
  readonly records: readonly MemoryRecord[]
  /** 既有边（用于避免重复发边）。 */
  readonly edges?: readonly Edge[]
  /** 已检测到的矛盾对；省略则跑内置的廉价启发式检测。 */
  readonly contradictions?: readonly ContradictionSignal[]
}

export interface ConsolidationOptions {
  /** 事件时间中的"现在"（纯函数：不由内部取墙钟）。 */
  readonly now: number
  readonly mergeLimit?: number
  readonly nearDuplicateThreshold?: number
  /** 哈希分块的键数（bottom-K）。 */
  readonly blockingKeys?: number
  readonly maxPairComparisons?: number
  readonly contradictionThreshold?: number
  /** 是否运行内置廉价矛盾检测（默认 true）；给出 `contradictions` 时以它为准。 */
  readonly detectContradictions?: boolean
  readonly decayHalfLifeMs?: number
  /** 显式隐私擦除（**唯一允许的删除路径**）：这些 id 走端口的 `forget`。 */
  readonly erasureIds?: readonly string[]
}

export type MergeReason = 'exact-duplicate' | 'near-duplicate' | 'echo-same-source'

export interface MergePlan {
  readonly keepId: string
  /** 被塌缩掉的痕迹（写侧应把它们的 `validTo` 设上，**不删除**）。 */
  readonly absorbedIds: readonly string[]
  readonly reason: MergeReason
  /** 累计使用次数（所有痕迹之和）。 */
  readonly useCount: number
  /** 原始痕迹条数。 */
  readonly traces: number
  /** **独立来源数**（去重后的 `sourceRef` 链）——假晋升防线的关键量。 */
  readonly independentSources: number
  readonly sources: readonly string[]
}

export interface SupersedePlan {
  readonly id: string
  readonly supersededBy: string
  readonly validTo: number
  readonly reason: 'contradiction' | 'merge'
}

export interface DecayPrior {
  readonly id: string
  /** 排序先验（越大越靠前）。**不是数据改动**。 */
  readonly prior: number
}

export interface ConsolidationStats {
  readonly records: number
  /** 精确去重 / 近重复 / 回响 各自的组数。 */
  readonly exactGroups: number
  readonly nearGroups: number
  readonly echoGroups: number
  readonly mergedRecords: number
  /** **实际做过的候选对比较次数**——这个数字证明它不是 all-pairs。 */
  readonly pairComparisons: number
  readonly candidatePairs: number
  readonly blockingKeys: number
  readonly newEdges: number
  readonly supersessions: number
  /** 独立性 ≥ 2 的组数（够格谈晋升的单元）。 */
  readonly independentUnits: number
}

export interface ConsolidationPlan {
  readonly merges: readonly MergePlan[]
  /** 新增边（`conflicts_with` / `supersedes`），写侧 upsert。 */
  readonly edges: readonly Edge[]
  /** 需要设 `validTo` + `supersededBy` 的行（**非破坏性**）。 */
  readonly supersessions: readonly SupersedePlan[]
  /** 衰减后的排序先验（**不动任何行**）。 */
  readonly decay: readonly DecayPrior[]
  /** 显式隐私擦除（走端口 `forget`）。 */
  readonly erasures: readonly string[]
  readonly truncated: boolean
  readonly stats: ConsolidationStats
  readonly notes: readonly string[]
}

// ---------- 纯原语 ----------

/** `sourceRef` 的链：`#` 之前的部分（同一观察的不同轮次共享同一条链）。 */
export function sourceChain(sourceRef: string): string {
  const index = sourceRef.indexOf('#')
  return index < 0 ? sourceRef : sourceRef.slice(0, index)
}

/** FNV-1a 32 位（确定性、零依赖）。 */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 分块用的 token 集合（复用 `text.ts` 的双语分词，保证与词法通道同源）。 */
export function shingles(text: string): readonly string[] {
  const tokens = tokenizeForFts(text).split(' ').filter(token => token.length > 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokens) {
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_TOKENS_PER_RECORD) break
  }
  return out
}

/**
 * 哈希分块（bottom-K MinHash 风格）：取 token 集合中最有区分度的 K 个作为分块键。
 *
 * 两个**相近**集合（共享大部分 token）几乎必然共享至少一个键 → 成为候选对；
 * **不相交**集合只有在哈希碰撞时才同键。于是需要验证的对数与"内容相似度"成正比，
 * 而不是与 `n²` 成正比——这就是"绝不 all-pairs"的结构性保证。
 *
 * 给了 `frequency`（文档频率）时优先选**低频 token**：模板化的语料（大量记录共享
 * 相同的套话）否则会退化成一个稠密桶；低频 token 正好是区分"这两条在说同一件事"的信号。
 */
export function blockingKeys(
  tokens: readonly string[],
  keys: number = DEFAULT_BLOCKING_KEYS,
  frequency?: ReadonlyMap<string, number>,
): readonly string[] {
  if (tokens.length === 0) return []
  const seen = new Set<string>()
  const candidates: { readonly token: string; readonly hash: number; readonly df: number }[] = []
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    candidates.push({ token, hash: fnv1a(token), df: frequency?.get(token) ?? 0 })
  }
  candidates.sort((a, b) => a.df - b.df || a.hash - b.hash || compareText(a.token, b.token))
  const count = Math.max(1, Math.min(16, Math.floor(keys)))
  return candidates.slice(0, count).map(entry => `k${entry.hash}`)
}

/** 一次遍历算文档频率（有多少条记录含该 token）——分块选键用。 */
export function documentFrequency(tokenSets: readonly ReadonlySet<string>[]): ReadonlyMap<string, number> {
  const df = new Map<string, number>()
  for (const set of tokenSets) {
    for (const token of set) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return df
}

/** Jaccard 相似度；任一边为空集 → 0（空对空不算重复）。 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const value of small) if (large.has(value)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** 否定极性：标记出现次数为奇数 → 否定。 */
export function isNegated(text: string): boolean {
  NEGATION_RE.lastIndex = 0
  const matches = text.match(NEGATION_RE)
  NEGATION_RE.lastIndex = 0
  return matches !== null && matches.length % 2 === 1
}

/** 核心 token（去掉否定标记与单字噪声）：用于判断"在说同一件事"。 */
export function coreTokens(text: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (const token of shingles(text)) {
    // 带 `g` 的正则 `test` 会推进 lastIndex：每次都重置，避免状态泄漏（确定性）。
    NEGATION_RE.lastIndex = 0
    const negative = NEGATION_RE.test(token)
    NEGATION_RE.lastIndex = 0
    if (negative) continue
    if (token.length >= 2) out.add(token)
  }
  return out
}

/**
 * 衰减**排序先验**（越大越靠前）。
 *
 * 明确：这只重排先验，**不改数据、不删除**——"衰减行"会让"我当时相信什么"无法回答。
 */
export function decayPrior(record: MemoryRecord, now: number, halfLifeMs: number = DEFAULT_DECAY_HALF_LIFE_MS): number {
  const halfLife = halfLifeMs > 0 && Number.isFinite(halfLifeMs) ? halfLifeMs : DEFAULT_DECAY_HALF_LIFE_MS
  const age = Math.max(0, now - record.observedAt)
  const recency = Math.pow(0.5, age / halfLife)
  const usage = 1 + Math.log1p(Math.max(0, record.useCount)) * 0.2
  return recency * usage
}

/** 一条痕迹的**独立来源**标识：`sourceRef` 链。 */
export function independenceKey(record: MemoryRecord): string {
  return sourceChain(record.sourceRef)
}

/**
 * 反作弊判据：只有**独立来源 ≥ 2** 的痕迹才够格谈晋升。
 *
 * 同源回响（同一条链上的多次痕迹）在结构上无法提供新证据——
 * 这就是 `When Not to Write Memory` 命名的「相关性痕迹导致的假晋升」。
 */
export function isIndependentlyEvidenced(merge: MergePlan): boolean {
  return merge.independentSources >= 2
}

/** 本轮够格谈晋升的 keep id（同源回响被排除在外）。 */
export function promotionCandidates(plan: ConsolidationPlan): readonly string[] {
  return plan.merges.filter(isIndependentlyEvidenced).map(merge => merge.keepId)
}

/**
 * 廉价矛盾检测（离线、无 LLM）。
 *
 * 判据：**核心 token 高度重叠 ∧ 否定极性相反**。故意保守——
 * 一条错误的 `conflicts_with` 会被"只呈现不裁决"直接呈现给用户。
 * 命中时只发边（不裁决）；是否 `supersedes` 由来源等级与时间决定。
 */
export function detectLexicalContradictions(
  records: readonly MemoryRecord[],
  options: { readonly threshold?: number; readonly blockingKeys?: number; readonly maxPairs?: number } = {},
): readonly ContradictionSignal[] {
  const threshold = options.threshold ?? DEFAULT_CONTRADICTION_THRESHOLD
  const keyCount = options.blockingKeys ?? DEFAULT_BLOCKING_KEYS
  const maxPairs = normalizeLimit(options.maxPairs, DEFAULT_MAX_PAIR_COMPARISONS)
  const usable = records.filter(record => record.id.length > 0 && record.text.trim().length > 0)
  const cores = usable.map(record => coreTokens(record.text))
  const df = documentFrequency(cores)
  const buckets = new Map<string, number[]>()
  usable.forEach((record, index) => {
    const tokens = [...(cores[index] ?? [])]
    for (const key of blockingKeys(tokens, keyCount, df)) {
      const bucketKey = `${record.scope}|${key}`
      const bucket = buckets.get(bucketKey)
      if (bucket === undefined) buckets.set(bucketKey, [index])
      else bucket.push(index)
    }
  })
  const compared = new Set<string>()
  const signals: ContradictionSignal[] = []
  let comparisons = 0
  outer: for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i]
        const right = bucket[j]
        if (left === undefined || right === undefined || left === right) continue
        const a = usable[left]
        const b = usable[right]
        const coreA = cores[left]
        const coreB = cores[right]
        if (a === undefined || b === undefined || coreA === undefined || coreB === undefined) continue
        if (a.id === b.id || a.scope !== b.scope) continue
        const key = left < right ? `${left}:${right}` : `${right}:${left}`
        if (compared.has(key)) continue
        if (comparisons >= maxPairs) break outer
        compared.add(key)
        comparisons += 1
        if (isNegated(a.text) === isNegated(b.text)) continue
        let shared = 0
        for (const token of coreA) if (coreB.has(token)) shared += 1
        if (shared < 2) continue
        if (jaccard(coreA, coreB) < threshold) continue
        const ordered = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
        signals.push({
          aId: ordered[0] ?? a.id,
          bId: ordered[1] ?? b.id,
          detail: '核心 token 高度重叠且否定极性相反（廉价启发式，可能误报）',
        })
      }
    }
  }
  signals.sort((x, y) => compareText(x.aId, y.aId) || compareText(x.bId, y.bId))
  return signals
}

// ---------- 整合计划 ----------

/** 生成整合计划。**纯函数**：不改任何东西，只产出"写侧该做什么"。 */
export function planConsolidation(
  input: ConsolidationInput,
  options: ConsolidationOptions,
): ConsolidationPlan {
  const mergeLimit = normalizeLimit(options.mergeLimit, DEFAULT_MERGE_LIMIT)
  const threshold = normalizeThreshold(options.nearDuplicateThreshold, DEFAULT_NEAR_DUPLICATE_THRESHOLD)
  const keyCount = options.blockingKeys ?? DEFAULT_BLOCKING_KEYS
  const maxPairs = normalizeLimit(options.maxPairComparisons, DEFAULT_MAX_PAIR_COMPARISONS)
  const notes: string[] = []

  // 去重并按 id 排序，保证同输入同输出。
  const records: MemoryRecord[] = []
  const seenIds = new Set<string>()
  for (const record of input.records) {
    if (record.id.length === 0 || seenIds.has(record.id)) continue
    seenIds.add(record.id)
    records.push(record)
  }
  if (records.length < input.records.length) {
    notes.push(`已忽略 ${input.records.length - records.length} 条空 id / 重复 id 的输入`)
  }

  const uf = new UnionFind(records.length)
  const indexById = new Map<string, number>()
  records.forEach((record, index) => indexById.set(record.id, index))

  // ⓪ 先算矛盾信号：**矛盾优先于合并**。
  //    否则"肯定/否定"这种近重复会被当成重复塌缩掉——那等于系统**静默裁决**了冲突，
  //    而规划 §5.6/§5.8 要求冲突只呈现、不裁决。
  const signals =
    input.contradictions ??
    (options.detectContradictions === false
      ? []
      : detectLexicalContradictions(records, {
          ...(options.contradictionThreshold !== undefined
            ? { threshold: options.contradictionThreshold }
            : {}),
          blockingKeys: keyCount,
          maxPairs,
        }))
  const contradictoryPairs = new Set<string>()
  for (const signal of signals) {
    contradictoryPairs.add(signal.aId < signal.bId ? `${signal.aId}|${signal.bId}` : `${signal.bId}|${signal.aId}`)
  }
  const isContradictoryPair = (a: MemoryRecord, b: MemoryRecord): boolean => {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
    return contradictoryPairs.has(key)
  }
  /** 近重复合并的两道闸：① 已知矛盾对 ② 否定极性相反（廉价但有效的第二道网）。 */
  const blocksNearDuplicate = (a: MemoryRecord, b: MemoryRecord): boolean => {
    if (isNegated(a.text) !== isNegated(b.text)) return true
    return isContradictoryPair(a, b)
  }

  // ① 精确去重 by contentHash（**同作用域内**：跨库不能合并，位置即权威）。
  const exactBuckets = new Map<string, number[]>()
  records.forEach((record, index) => {
    const key = `${record.scope}|${record.contentHash}`
    const bucket = exactBuckets.get(key)
    if (bucket === undefined) exactBuckets.set(key, [index])
    else bucket.push(index)
  })
  let exactGroups = 0
  for (const bucket of exactBuckets.values()) {
    if (bucket.length < 2) continue
    exactGroups += 1
    const first = bucket[0]
    if (first === undefined) continue
    for (const index of bucket) uf.union(first, index)
  }

  // ② 近重复：哈希分块生成候选（绝不 all-pairs），再逐一验证。
  const tokenSets = records.map(record => new Set(shingles(record.text)))
  const tokenDf = documentFrequency(tokenSets)
  const buckets = new Map<string, number[]>()
  records.forEach((record, index) => {
    const tokens = [...(tokenSets[index] ?? [])]
    for (const key of blockingKeys(tokens, keyCount, tokenDf)) {
      const bucketKey = `${record.scope}|${key}`
      const bucket = buckets.get(bucketKey)
      if (bucket === undefined) buckets.set(bucketKey, [index])
      else bucket.push(index)
    }
  })
  const compared = new Set<string>()
  let pairComparisons = 0
  let candidatePairs = 0
  let pairCapHit = false
  outer: for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i]
        const right = bucket[j]
        if (left === undefined || right === undefined || left === right) continue
        const a = records[left]
        const b = records[right]
        if (a === undefined || b === undefined || a.scope !== b.scope) continue
        candidatePairs += 1 // 分块生成的原始候选对（去重与上限之前）
        const key = left < right ? `${left}:${right}` : `${right}:${left}`
        if (compared.has(key)) continue
        // 触顶即停（连迭代也停）：保证结构上不可能是 all-pairs。
        if (pairComparisons >= maxPairs) {
          pairCapHit = true
          break outer
        }
        compared.add(key)
        pairComparisons += 1
        const setA = tokenSets[left]
        const setB = tokenSets[right]
        if (setA === undefined || setB === undefined) continue
        if (blocksNearDuplicate(a, b)) continue
        if (jaccard(setA, setB) >= threshold) uf.union(left, right)
      }
    }
  }

  // ③ 回响：**完全相同的 sourceRef** = 同一个观察事件（内容不同也塌缩）；
  //    同链 + 内容相近的情形已由 ② 覆盖（差值只在 reason 上体现）。
  const exactRefBuckets = new Map<string, number[]>()
  records.forEach((record, index) => {
    const key = `${record.scope}|${record.sourceRef}`
    const bucket = exactRefBuckets.get(key)
    if (bucket === undefined) exactRefBuckets.set(key, [index])
    else bucket.push(index)
  })
  for (const bucket of exactRefBuckets.values()) {
    if (bucket.length < 2) continue
    const first = bucket[0]
    if (first === undefined) continue
    const firstRecord = records[first]
    for (const index of bucket) {
      const other = records[index]
      // 同一个 sourceRef 就是同一次观察：内容不同也塌缩。
      // 但如果这一对已被判为**矛盾**，就绝不能静默合并（冲突只呈现、不裁决）。
      if (firstRecord !== undefined && other !== undefined && isContradictoryPair(firstRecord, other)) continue
      uf.union(first, index)
    }
  }

  // ④ 组装组（只保留 ≥2 条痕迹的组），按首现顺序处理，超上限即停。
  const groups = new Map<number, number[]>()
  records.forEach((_record, index) => {
    const root = uf.find(index)
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [index])
    else group.push(index)
  })
  const multiGroups: number[][] = []
  for (const group of groups.values()) {
    if (group.length >= 2) multiGroups.push(group)
  }
  multiGroups.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))

  const merges: MergePlan[] = []
  const supersessions: SupersedePlan[] = []
  const newEdges: Edge[] = []
  const edgeKeys = new Set<string>()
  for (const existing of input.edges ?? []) edgeKeys.add(edgeKey(existing))
  const supersededThisRun = new Set<string>()
  let truncated = false
  let nearGroups = 0
  let echoGroups = 0
  let mergedRecords = 0

  for (const group of multiGroups) {
    if (merges.length >= mergeLimit) {
      truncated = true
      break
    }
    const members = group
      .map(index => records[index])
      .filter((record): record is MemoryRecord => record !== undefined)
    if (members.length < 2) continue
    const keep = pickKeeper(members)
    const absorbed = members
      .filter(record => record.id !== keep.id)
      .map(record => record.id)
      .sort(compareText)
    const hashes = new Set(members.map(record => record.contentHash))
    const chains = new Set(members.map(independenceKey))
    const sameRef = new Set(members.map(record => record.sourceRef)).size === 1
    let reason: MergeReason
    if (hashes.size === 1) reason = 'exact-duplicate'
    else if (chains.size === 1 || sameRef) reason = 'echo-same-source'
    else reason = 'near-duplicate'
    if (reason === 'near-duplicate') nearGroups += 1
    if (reason === 'echo-same-source') echoGroups += 1
    const merge: MergePlan = {
      keepId: keep.id,
      absorbedIds: absorbed,
      reason,
      useCount: members.reduce((sum, record) => sum + Math.max(0, record.useCount), 0),
      traces: members.length,
      independentSources: chains.size,
      sources: [...new Set(members.map(record => record.sourceRef))].sort(compareText),
    }
    merges.push(merge)
    mergedRecords += absorbed.length
    for (const record of members) {
      if (record.id === keep.id) continue
      const validTo = Math.max(keep.observedAt, record.observedAt)
      supersessions.push({ id: record.id, supersededBy: keep.id, validTo, reason: 'merge' })
      supersededThisRun.add(record.id)
      const edge: Edge = { fromId: keep.id, toId: record.id, type: 'supersedes', createdAt: options.now }
      const key = edgeKey(edge)
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        newEdges.push(edge)
      }
    }
  }

  // ⑤ 矛盾：发 conflicts_with；来源等级够时发 supersedes 并设 validTo。
  //    （信号已在 ⓪ 算好；这里只负责发边与设 validTo。）
  const groupRoots = new Map<string, number>()
  records.forEach((record, index) => groupRoots.set(record.id, uf.find(index)))
  for (const signal of signals) {
    const left = records[indexById.get(signal.aId) ?? -1]
    const right = records[indexById.get(signal.bId) ?? -1]
    if (left === undefined || right === undefined || left.id === right.id) continue
    if (left.scope !== right.scope) continue
    if (groupRoots.get(left.id) === groupRoots.get(right.id)) continue // 已塌缩成一条
    const conflict: Edge = {
      fromId: left.id < right.id ? left.id : right.id,
      toId: left.id < right.id ? right.id : left.id,
      type: 'conflicts_with',
      createdAt: options.now,
    }
    const conflictKey = edgeKey(conflict)
    if (!edgeKeys.has(conflictKey)) {
      edgeKeys.add(conflictKey)
      newEdges.push(conflict)
    }
    const newer = newerOf(left, right)
    const older = newer.id === left.id ? right : left
    const canSupersede =
      (newer.assertedBy === 'user' || newer.assertedBy === 'execution') &&
      ASSERTED_RANK[newer.assertedBy] >= ASSERTED_RANK[older.assertedBy] &&
      older.validTo === null &&
      older.supersededBy === null &&
      !supersededThisRun.has(older.id)
    if (!canSupersede) continue
    supersededThisRun.add(older.id)
    supersessions.push({
      id: older.id,
      supersededBy: newer.id,
      validTo: Math.max(newer.observedAt, older.observedAt),
      reason: 'contradiction',
    })
    const edge: Edge = { fromId: newer.id, toId: older.id, type: 'supersedes', createdAt: options.now }
    const key = edgeKey(edge)
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key)
      newEdges.push(edge)
    }
  }

  // ⑥ 衰减排序（**不改数据**）。
  const halfLife = options.decayHalfLifeMs ?? DEFAULT_DECAY_HALF_LIFE_MS
  const decay: DecayPrior[] = records
    .map(record => ({ id: record.id, prior: decayPrior(record, options.now, halfLife) }))
    .sort((a, b) => b.prior - a.prior || compareText(a.id, b.id))

  // ⑦ 隐私擦除（唯一允许的删除路径）。
  const erasures = (options.erasureIds ?? [])
    .filter(id => indexById.has(id))
    .slice()
    .sort(compareText)
  if (erasures.length > 0) notes.push(`隐私擦除 ${erasures.length} 条：走端口 forget（唯一硬删除路径）`)

  newEdges.sort(
    (a, b) => compareText(a.fromId, b.fromId) || compareText(a.toId, b.toId) || compareText(a.type, b.type),
  )
  supersessions.sort((a, b) => compareText(a.id, b.id))

  notes.push(
    `精确去重 ${exactGroups} 组 / 近重复 ${nearGroups} 组 / 回响 ${echoGroups} 组；` +
      `候选对比较 ${pairComparisons} 次（不是 all-pairs），分块键 ${buckets.size} 个`,
  )
  if (truncated) {
    notes.push(`达到合并上限 ${mergeLimit}：剩余 ${multiGroups.length - merges.length} 组留到下次运行`)
  }
  if (pairCapHit) notes.push(`候选对比较达到上限 ${maxPairs}：本轮只验证了前 ${maxPairs} 对`)
  notes.push('衰减只重排先验，不修改任何行；删除只发生在隐私擦除路径')

  const independentUnits = merges.filter(isIndependentlyEvidenced).length
  return {
    merges,
    edges: newEdges,
    supersessions,
    decay,
    erasures,
    truncated,
    stats: {
      records: records.length,
      exactGroups,
      nearGroups,
      echoGroups,
      mergedRecords,
      pairComparisons,
      candidatePairs,
      blockingKeys: buckets.size,
      newEdges: newEdges.length,
      supersessions: supersessions.length,
      independentUnits,
    },
    notes,
  }
}

// ---------- 内部工具 ----------

/** 并查集（路径压缩 + 按大小合并）。 */
class UnionFind {
  readonly #parent: number[]
  readonly #size: number[]

  constructor(count: number) {
    this.#parent = Array.from({ length: count }, (_, i) => i)
    this.#size = new Array<number>(count).fill(1)
  }

  find(index: number): number {
    let root = index
    while (this.#parent[root] !== root) {
      const parent = this.#parent[root]
      if (parent === undefined) break
      root = parent
    }
    let cursor = index
    while (this.#parent[cursor] !== root) {
      const next = this.#parent[cursor]
      if (next === undefined) break
      this.#parent[cursor] = root
      cursor = next
    }
    return root
  }

  union(a: number, b: number): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    const sizeA = this.#size[rootA] ?? 1
    const sizeB = this.#size[rootB] ?? 1
    if (sizeA < sizeB) {
      this.#parent[rootA] = rootB
      this.#size[rootB] = sizeA + sizeB
    } else {
      this.#parent[rootB] = rootA
      this.#size[rootA] = sizeA + sizeB
    }
  }
}

/** 保留者：来源等级最高 → 观测最早 → id ASCII（确定性）。 */
function pickKeeper(members: readonly MemoryRecord[]): MemoryRecord {
  let best = members[0]
  if (best === undefined) throw new Error('pickKeeper 需要至少一条记录')
  for (const record of members) {
    const rank = ASSERTED_RANK[record.assertedBy]
    const bestRank = ASSERTED_RANK[best.assertedBy]
    if (rank !== bestRank) {
      if (rank > bestRank) best = record
      continue
    }
    if (record.observedAt !== best.observedAt) {
      if (record.observedAt < best.observedAt) best = record
      continue
    }
    if (compareText(record.id, best.id) < 0) best = record
  }
  return best
}

/** 谁更新：观测时间 → 来源等级 → id ASCII（确定性）。 */
function newerOf(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b
  const rankA = ASSERTED_RANK[a.assertedBy]
  const rankB = ASSERTED_RANK[b.assertedBy]
  if (rankA !== rankB) return rankA > rankB ? a : b
  return compareText(a.id, b.id) >= 0 ? a : b
}

function edgeKey(edge: Edge): string {
  return `${edge.fromId}=>${edge.toId}#${edge.type}`
}

/** ASCII 安全比较（**不用 `localeCompare`**）。 */
function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) return fallback
  return value
}
