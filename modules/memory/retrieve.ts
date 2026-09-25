/**
 * 检索主路径（规划 §5.4 七阶段）。
 *
 * ```
 * ① 门控     先决定【要不要检索】。"不需要记忆"是合法的一等结果，不是错误
 * ② 扇出     两个库都查，**绝不短路**
 * ③ 词法为主 FTS5/BM25 通道优先
 * ④ 排名融合 第二通道存在 → RRF（k=60，可配置）
 * ⑤ 每库配额 防一个库饿死另一个
 * ⑥ 上限+重排 硬候选上限，可选廉价重排
 * ⑦ 返回     逐字文本 + sourceRef + observedAt（溯源免费随行）
 * ```
 *
 * **为什么是 RRF 而不是加权求和**：旧实现把「词法排名归一值」与「原始余弦」相加，
 * 两者量纲不同；又用「评分 ÷ 池大小」归一，使同一条记忆的分数随候选池大小漂移。
 * RRF 只消费**排名**（`1/(k+rank)`），因此天然无量纲、天然与候选池大小无关——
 * 旧的两个缺陷是**被消解**，而不是被修补。代价：通道内的原始分（bm25/余弦）
 * 只用于通道内排序，绝不跨通道做算术。
 *
 * 分层约束：本文件只依赖 `kernel/abi` 与同模块的**纯契约面**（`overturned.ts` 的
 * 结构契约、无 I/O）。I/O 只经端口，逻辑是纯函数。
 */
import type {
  AssertedBy,
  Clock,
  Embedder,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  PressureBand,
  ScoredHit,
  TaggedStore,
} from '../../kernel/abi/index.js'
import { RESERVED_SOURCE_PREFIX } from '../../kernel/abi/index.js'
import { asOverturnedProbe, type OverturnedHit } from './overturned.js'

/** RRF 常数 k 的惯例默认值。⚠️ 这是惯例，不是最优值——规划 §5.4 明确标注，故暴露为配置项。 */
export const DEFAULT_RRF_K = 60
/** 默认注入条数。 */
export const DEFAULT_LIMIT = 5
/** 融合后、重排前的硬候选上限。 */
export const DEFAULT_MAX_CANDIDATES = 20
/** 无偏好作用域时的作用域优先级（跨界结论比项目情境更稳定）。 */
export const SCOPE_PRIORITY: Readonly<Record<MemoryScope, number>> = { user: 0, project: 1 }
/** 廉价重排权重（和 = 1）。全部是 [0,1] 的无量纲先验，不做任何跨通道分数算术。 */
export const RERANK_WEIGHTS = { fusion: 0.55, recency: 0.25, usage: 0.12, asserted: 0.08 } as const
/** 重排的时间半衰期（默认 30 天）。 */
export const RERANK_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000
/**
 * 状态里最多列出多少个"已被取代"的候选 id。
 *
 * 这是**输出体积**限制，不是语义限制：计数（`supersededSkipped`）永远是精确的，
 * 只有 id 列表会被截到这么多条（给 id 是为了让后续会话能追到那条历史痕迹）。
 */
export const MAX_REPORTED_SUPERSEDED = 5

const ASSERTED_WEIGHT: Readonly<Record<AssertedBy, number>> = { user: 1, execution: 0.7, model: 0.3 }

export type ChannelName = ScoredHit['channel']
/** 库内 FTS 之外的通道（向量 / 图）。缺省即纯词法，路径依然完整可用（§5.7）。 */
export type SecondaryChannelName = Exclude<ChannelName, 'lexical'>

/** 一次通道查询。`store` 是被查的库句柄；`embedding` 由 `ports.embedder` 预计算（可缺）。 */
export interface ChannelQuery {
  readonly store: TaggedStore
  readonly text: string
  readonly scope: MemoryScope
  readonly kinds?: readonly MemoryKind[]
  readonly limit: number
  readonly embedding?: Float32Array
}

/**
 * 可选第二通道——**这是向量/图通道的注入缝，故意不写进 `MemoryStore` 端口**。
 *
 * 三个理由（lead 已裁决采纳）：
 * ① `MemoryStore` 端口保持纯净（词法为主），纯词法路径完整可用（§5.7 的硬要求）
 * ② 第二通道由 `ports` 注入而非写进 store 接口，存储层因此**不必知道向量存在**
 * ③ `Text`/`LexicalQuery` 的既有契约不需要为「可选的第二个通道」做任何妥协
 *
 * 通道只返回 `ScoredHit[]`，顺序即相关度降序；它的 `score` 只允许用于**通道内**排序。
 */
export interface RetrievalChannel {
  readonly name: SecondaryChannelName
  search(query: ChannelQuery): Promise<readonly ScoredHit[]>
}

/**
 * 端口集合。给定的签名 `{ embedder?, clock }` 是其子集（可选字段，结构兼容）。
 */
export interface RetrievePorts {
  readonly clock: Clock
  readonly embedder?: Embedder
  readonly channels?: readonly RetrievalChannel[]
}

/** 检索请求。除 `text` 外全部可选：默认值即规划里的默认路径。 */
export interface RetrieveQuery {
  readonly text: string
  /**
   * 查询侧重的作用域。**只用于每库配额与确定性排序，不作为过滤条件**
   * （§5.3：位置即权威，标签不用于过滤）。
   */
  readonly scope?: MemoryScope
  readonly kinds?: readonly MemoryKind[]
  readonly limit?: number
  /** 融合后的硬候选上限（默认 20）。 */
  readonly maxCandidates?: number
  /** 每库每通道的候选池大小（默认 = maxCandidates）。 */
  readonly poolLimit?: number
  /** 每库在首次填充中最多占的注入位次；默认 `ceil(limit / 库数)`。 */
  readonly perStoreQuota?: number
  /** 可选廉价重排（top-maxCandidates → top-limit）；默认关闭。 */
  readonly rerank?: boolean
  readonly rerankHalfLifeMs?: number
  /** RRF 常数 k（默认 60）。 */
  readonly rrfK?: number
  /** 门控模式：`auto`（默认）/ `always` / `never`。 */
  readonly mode?: 'auto' | 'always' | 'never'
  /** 上下文压力档位（软信号）。仅在显式给出且为 `tight` 时参与门控。 */
  readonly pressureBand?: PressureBand
  /** tight 压力下是否跳过检索（默认 true）；`mode: 'always'` 时忽略。 */
  readonly skipOnTightPressure?: boolean
}

export type GateReason = 'ok' | 'empty-query' | 'explicit-never' | 'no-stores' | 'no-kinds' | 'pressure-tight'

/** 门控结论。跳过时给出**可读原因**——空结果是一等结果，不是错误。 */
export interface GateDecision {
  readonly retrieve: boolean
  readonly reason: GateReason
  readonly detail: string
}

/** 通道内的一位（rank 从 1 起）。 */
export interface RankedHit {
  readonly id: string
  readonly rank: number
}

/** 某一库某一通道的排名表。顺序即相关度降序（**原始分不参与跨通道计算**）。 */
export interface ChannelRanking {
  readonly channel: ChannelName
  readonly scope: MemoryScope
  readonly hits: readonly RankedHit[]
}

export interface ChannelMatch {
  readonly channel: ChannelName
  readonly scope: MemoryScope
  readonly rank: number
}

export interface FusedCandidate {
  readonly id: string
  /** RRF 原始和：`Σ 1/(k+rank)`。有界、无量纲、与候选池大小无关。 */
  readonly score: number
  readonly scopes: readonly MemoryScope[]
  readonly channels: readonly ChannelName[]
  readonly matches: readonly ChannelMatch[]
}

/** 返回给消费者的逐字条目：溯源随行，输出因此可审计。 */
export interface RetrievedItem {
  readonly rank: number
  readonly id: string
  /** 逐字原文（**不做抽取式结构化**）。 */
  readonly text: string
  readonly sourceRef: string
  readonly observedAt: number
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly assertedBy: AssertedBy
  readonly project: string | null
  readonly validTo: number | null
  readonly supersededBy: string | null
  /** RRF 分（同 `FusedCandidate.score`）。 */
  readonly score: number
  readonly channels: readonly ChannelName[]
  readonly ranks: readonly ChannelMatch[]
}

export interface RetrieveStats {
  readonly storesQueried: number
  readonly channelsUsed: readonly ChannelName[]
  readonly candidatesFused: number
  readonly candidatesCapped: number
  readonly dropped: number
  /** 因是保留来源（画像一类）而被排除的候选数。 */
  readonly reservedSkipped: number
  /**
   * 因已失效（`validTo` 非空）而未注入的、与本次查询匹配的条目数。
   *
   * 来源是**过时探测 + 水合后的兜底过滤**（按 id 去重）：真实实现的通道在 SQL 层
   * 就排除了过时行，所以这个数几乎总是由探测给出——它回答的是
   * "这条查询匹配到多少**已经不算数**的记忆"，而不是"候选池里丢了多少"。
   */
  readonly expiredSkipped: number
  /**
   * 其中**已被取代**（`supersededBy` 非空）的条数。
   *
   * 为什么要单独计数：这些条目不是"没有记忆"，而是"有过结论、已被推翻"。
   * 只报零命中会让后续会话以为这里从来没有结论——那正是过时结论的镜像缺陷
   * （信息不是被误导，而是被悄悄抹掉）。
   */
  readonly supersededSkipped: number
  /**
   * 被排除的已取代条目 id（确定性排序、上限 `MAX_REPORTED_SUPERSEDED`）。
   *
   * 给出 id 而不是只给数字：后续会话要能**追到那条历史痕迹**
   * （`omb_relate <id> depth=1 types=["supersedes"]`），而不是只知道"有 2 条被丢了"。
   */
  readonly supersededSkippedIds: readonly string[]
  readonly perStore: readonly {
    readonly scope: MemoryScope
    readonly candidates: number
    readonly selected: number
  }[]
  readonly rrfK: number
  readonly reranked: boolean
}

export interface RetrieveResult {
  readonly items: readonly RetrievedItem[]
  readonly gate: GateDecision
  /** 通道/库级降级说明（如「向量通道故障」）。**不是异常**：可用的部分照常返回。 */
  readonly degraded: readonly string[]
  readonly stats: RetrieveStats
  /**
   * 本次检索的时钟读数；**时钟不可用时为 `null`**。
   *
   * 不用 `0` 兜底：epoch 0 是一个**看起来合法的假时间**，任何拿它做新旧判断的消费方
   * 都会把全部记忆当成"1970 年的事"。未知就是未知（未测量 ≠ 测到 0）。
   */
  readonly now: number | null
  /** 人类可读结论；门控跳过与零命中都是正常结论。 */
  readonly note: string
}

/**
 * 保留来源（`omb-doc:` 前缀）判定：画像这类"单文档结构化状态"**不是经验痕迹**，
 * 不得参与经验召回排名（`kernel/abi/catalog.ts` 的 `RESERVED_SOURCE_PREFIX`）。
 * 离线整合侧（`consolidate.ts`）复用同一判定。
 */
export function isReservedSource(sourceRef: string): boolean {
  return sourceRef.startsWith(RESERVED_SOURCE_PREFIX)
}

// ---------- 纯逻辑：门控 ----------

/**
 * ① 门控：先决定要不要检索。
 *
 * 「不需要记忆」是合法的一等结果——门控跳过时**零 I/O**，返回空结果 + 原因。
 */
export function gateRetrieval(
  stores: readonly TaggedStore[],
  query: RetrieveQuery,
): GateDecision {
  if (query.mode === 'never') {
    return { retrieve: false, reason: 'explicit-never', detail: '调用方显式声明不检索（mode: never）' }
  }
  if (stores.length === 0) {
    return { retrieve: false, reason: 'no-stores', detail: '没有可查的库（双库均未打开）' }
  }
  if (query.kinds !== undefined && query.kinds.length === 0) {
    return { retrieve: false, reason: 'no-kinds', detail: '调用方把 kinds 限为空集——没有任何类型可命中' }
  }
  if (query.mode !== 'always' && query.text.trim().length === 0) {
    return { retrieve: false, reason: 'empty-query', detail: '查询文本为空，无可匹配内容' }
  }
  if (
    query.mode !== 'always' &&
    query.pressureBand === 'tight' &&
    query.skipOnTightPressure !== false
  ) {
    return {
      retrieve: false,
      reason: 'pressure-tight',
      detail: '上下文压力 tight（软信号）：跳过检索以免挤占预算；需要时可用 mode: always 强制',
    }
  }
  return { retrieve: true, reason: 'ok', detail: '门控通过' }
}

// ---------- 纯逻辑：排名与融合 ----------

/** ID 的 ASCII 安全比较（**不用 `localeCompare`**：它的结果依赖 locale，破坏确定性）。 */
export function asciiCompare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * epoch ms → ISO-8601 UTC（纯算术）。
 *
 * 为什么不用 `new Date`：① 模块层不得直接取时间（`omb/no-direct-clock`，一律 `kernel.clock`）
 * ② 算术版**逐字节确定**、不依赖宿主时区/locale——与"排序不用 localeCompare"同一条纪律。
 * 与 `new Date(ms).toISOString()` 的等价性由测试差分验证。
 */
export function isoUtc(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return String(epochMs)
  const ms = Math.floor(epochMs)
  const days = Math.floor(ms / 86_400_000)
  let rest = ms - days * 86_400_000
  const hours = Math.floor(rest / 3_600_000)
  rest -= hours * 3_600_000
  const minutes = Math.floor(rest / 60_000)
  rest -= minutes * 60_000
  const seconds = Math.floor(rest / 1000)
  const millis = rest - seconds * 1000
  const civil = civilFromDays(days)
  return (
    `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}` +
    `T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}Z`
  )
}

/** Howard Hinnant 的 civil-from-days（纯整数运算）。 */
function civilFromDays(daysSinceEpoch: number): { year: number; month: number; day: number } {
  const z = daysSinceEpoch + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  )
  const year = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: month <= 2 ? year + 1 : year, month, day }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** 去重（保留首次出现）并赋 1 起的排名。通道原始分在此被**丢弃**。 */
export function rankHits(hits: readonly ScoredHit[]): readonly RankedHit[] {
  const seen = new Set<string>()
  const out: RankedHit[] = []
  for (const hit of hits) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    out.push({ id: hit.id, rank: out.length + 1 })
  }
  return out
}

/** 作用域优先级：偏好作用域最优先，其余按 `SCOPE_PRIORITY`（未给偏好时直接用常量）。 */
export function scopeOrder(scope: MemoryScope, preferred?: MemoryScope): number {
  if (preferred === undefined) return SCOPE_PRIORITY[scope]
  return scope === preferred ? 0 : SCOPE_PRIORITY[scope] + 1
}

/**
 * ④ RRF 融合：`score(d) = Σ_channels 1/(k + rank_c(d))`。
 *
 * **只用排名**，因此天然无量纲、天然与候选池大小无关——旧实现的
 * 「排名归一值 + 原始余弦」与「评分 ÷ 池大小」两个缺陷在此被消解。
 */
export function fuseByRank(rankings: readonly ChannelRanking[], k: number): readonly FusedCandidate[] {
  const effectiveK = normalizeK(k)
  const acc = new Map<string, { score: number; matches: ChannelMatch[] }>()
  for (const ranking of rankings) {
    for (const hit of ranking.hits) {
      let entry = acc.get(hit.id)
      if (entry === undefined) {
        entry = { score: 0, matches: [] }
        acc.set(hit.id, entry)
      }
      entry.score += 1 / (effectiveK + hit.rank)
      entry.matches.push({ channel: ranking.channel, scope: ranking.scope, rank: hit.rank })
    }
  }
  const out: FusedCandidate[] = []
  for (const [id, entry] of acc) {
    out.push({
      id,
      score: entry.score,
      matches: entry.matches,
      scopes: unique(entry.matches.map(m => m.scope)),
      channels: unique(entry.matches.map(m => m.channel)),
    })
  }
  out.sort((a, b) => (a.score !== b.score ? (a.score > b.score ? -1 : 1) : asciiCompare(a.id, b.id)))
  return out
}

/** 候选首选作用域：优先级最高者；同优先级取先出现者（确定性）。 */
export function primaryScope(candidate: FusedCandidate): MemoryScope {
  const first = candidate.scopes[0]
  if (first === undefined) return 'user'
  let best = first
  for (const scope of candidate.scopes) {
    if (SCOPE_PRIORITY[scope] < SCOPE_PRIORITY[best]) best = scope
  }
  return best
}

/** 确定性总序：**RRF 分 desc → 作用域优先级 → id（ASCII）**。 */
export function compareCandidates(a: FusedCandidate, b: FusedCandidate, preferred?: MemoryScope): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1
  const pa = scopeOrder(primaryScope(a), preferred)
  const pb = scopeOrder(primaryScope(b), preferred)
  if (pa !== pb) return pa - pb
  return asciiCompare(a.id, b.id)
}

/** 按确定性总序排序（返回新数组，不改入参）。 */
export function totalOrder(
  candidates: readonly FusedCandidate[],
  preferred?: MemoryScope,
): readonly FusedCandidate[] {
  return [...candidates].sort((a, b) => compareCandidates(a, b, preferred))
}

// ---------- 纯逻辑：配额与重排 ----------

export interface QuotaCandidate {
  readonly id: string
  readonly scope: MemoryScope
}

/**
 * ⑤ 每库配额：两遍填充。
 *
 * 第一遍每个库最多占 `quota` 个位次（保证弱库不被强库饿死），
 * 第二遍忽略配额把剩余位次按全局序补齐（不留空位）。
 */
export function selectWithQuota(
  ordered: readonly QuotaCandidate[],
  limit: number,
  quota: number,
): readonly QuotaCandidate[] {
  if (limit <= 0) return []
  const cap = quota >= 1 ? Math.floor(quota) : 1
  const taken = new Set<string>()
  const perScope = new Map<MemoryScope, number>()
  const out: QuotaCandidate[] = []
  for (const candidate of ordered) {
    if (out.length >= limit) break
    if (taken.has(candidate.id)) continue
    const used = perScope.get(candidate.scope) ?? 0
    if (used >= cap) continue
    perScope.set(candidate.scope, used + 1)
    taken.add(candidate.id)
    out.push(candidate)
  }
  for (const candidate of ordered) {
    if (out.length >= limit) break
    if (taken.has(candidate.id)) continue
    taken.add(candidate.id)
    out.push(candidate)
  }
  return out
}

export interface RerankInput {
  readonly candidate: FusedCandidate
  readonly record: MemoryRecord
}

export interface RerankOptions {
  readonly now: number
  readonly halfLifeMs?: number
  readonly preferredScope?: MemoryScope
  /** 融合位次（0 起），用于把融合信号折算成固定映射的分量。 */
  readonly position: number
}

/**
 * ⑥ 廉价重排的单一候选先验。
 *
 * 三个先验都是 [0,1] 的无量纲量，融合分量用**固定**的位置映射 `1/(1+pos)`
 * （不除以池大小——那正是旧缺陷）。这不是「分数融合」：没有任何通道原始分参与。
 */
export function rerankPrior(input: RerankInput, options: RerankOptions): number {
  const halfLife = normalizeHalfLife(options.halfLifeMs)
  const age = Math.max(0, options.now - input.record.observedAt)
  const recency = Math.pow(0.5, age / halfLife)
  const useCount = Math.max(0, input.record.useCount)
  const usage = useCount / (1 + useCount)
  const asserted = ASSERTED_WEIGHT[input.record.assertedBy]
  const fusion = 1 / (1 + Math.max(0, options.position))
  return (
    RERANK_WEIGHTS.fusion * fusion +
    RERANK_WEIGHTS.recency * recency +
    RERANK_WEIGHTS.usage * usage +
    RERANK_WEIGHTS.asserted * asserted
  )
}

/** 重排：按先验 desc → 作用域优先级 → id 重排前 `top` 条（返回新数组）。 */
export function cheapRerank<T extends RerankInput>(
  inputs: readonly T[],
  options: { readonly now: number; readonly halfLifeMs?: number; readonly preferredScope?: MemoryScope },
): readonly T[] {
  const scored = inputs.map((input, position) => ({
    input,
    prior: rerankPrior(input, {
      now: options.now,
      position,
      ...(options.halfLifeMs !== undefined ? { halfLifeMs: options.halfLifeMs } : {}),
    }),
  }))
  scored.sort((a, b) => {
    if (a.prior !== b.prior) return a.prior > b.prior ? -1 : 1
    const pa = scopeOrder(primaryScope(a.input.candidate), options.preferredScope)
    const pb = scopeOrder(primaryScope(b.input.candidate), options.preferredScope)
    if (pa !== pb) return pa - pb
    return asciiCompare(a.input.candidate.id, b.input.candidate.id)
  })
  return scored.map(s => s.input)
}

// ---------- 主流程 ----------

/** ⑦ 检索。**I/O 失败降级不抛**；纯逻辑错误照常暴露（工具执行体会兜底）。 */
export async function retrieve(
  stores: readonly TaggedStore[],
  query: RetrieveQuery,
  ports: RetrievePorts,
): Promise<RetrieveResult> {
  const now = readNow(ports)
  const k = normalizeK(query.rrfK)
  const gate = gateRetrieval(stores, query)
  if (!gate.retrieve) {
    return {
      items: [],
      gate,
      degraded: now === undefined ? ['时钟不可用：本次没有时间读数（now=未知，不是 0）'] : [],
      stats: emptyStats(k),
      now: now ?? null,
      note: `门控跳过检索（${gate.reason}）：${gate.detail}（一等结果，不是错误）`,
    }
  }

  const degraded: string[] = []
  if (now === undefined) {
    degraded.push('时钟不可用：已跳过廉价重排（时间先验不可信）')
  }
  const rerankRequested = query.rerank === true && now !== undefined
  const limit = normalizePositive(query.limit, DEFAULT_LIMIT)
  const maxCandidates = normalizePositive(query.maxCandidates, DEFAULT_MAX_CANDIDATES)
  const poolLimit = normalizePositive(query.poolLimit, maxCandidates)
  const ordered = orderStores(stores)
  const channels = ports.channels ?? []

  // 查询向量只算一次；算不出就退化为纯词法（诚实降级，不抛）。
  const channelsUsable = channels.length > 0
  let embedding: Float32Array | undefined
  if (channelsUsable && ports.embedder !== undefined) {
    try {
      const vectors = await ports.embedder.embed([query.text])
      const first = vectors[0]
      if (first === undefined) degraded.push(`嵌入器 ${ports.embedder.id} 未返回向量：退化为纯词法`)
      else embedding = first
    } catch (err) {
      degraded.push(`嵌入器 ${ports.embedder.id} 失败（${messageOf(err)}）：退化为纯词法`)
    }
  }

  // ② 扇出：两个库都查，**绝不短路**（`Promise.all` 覆盖全部库，任何一库为空都不提前结束）。
  const searches = await Promise.all(
    ordered.map(async (tagged): Promise<StoreSearch> => {
      const rankings: ChannelRanking[] = []
      const lexical = await safeSearch(
        () =>
          tagged.store.searchLexical({
            text: query.text,
            scope: tagged.scope,
            ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
            limit: poolLimit,
          }),
        degraded,
        `库 ${tagged.scope} 词法通道失败`,
      )
      if (lexical !== null && lexical.length > 0) {
        rankings.push({ channel: 'lexical', scope: tagged.scope, hits: rankHits(lexical) })
      }
      for (const channel of channels) {
        const hits = await safeSearch(
          () =>
            channel.search({
              store: tagged,
              text: query.text,
              scope: tagged.scope,
              ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
              limit: poolLimit,
              ...(embedding !== undefined ? { embedding } : {}),
            }),
          degraded,
          `库 ${tagged.scope} ${channel.name} 通道失败`,
        )
        if (hits !== null && hits.length > 0) {
          rankings.push({ channel: channel.name, scope: tagged.scope, hits: rankHits(hits) })
        }
      }
      return { tagged, rankings }
    }),
  )

  const rankings = searches.flatMap(s => s.rankings)
  const fused = fuseByRank(rankings, k)
  const orderedFused = totalOrder(fused, query.scope)

  // ⑦ 批量水合：每个作用域一次 `getMany`（**禁止 N+1**）。
  //    水合在**截断之前**做：保留来源（画像）与已失效条目因此不会占用候选上限的位次，
  //    否则一条 `omb-doc:` 记录就能把一个真正的经验候选挤出窗口。
  const hydrated = await hydrate(ordered, orderedFused, degraded)

  /**
   * 未注入的**过时**条目（按 id 去重）。两个来源，缺一不可：
   * ① 水合后的兜底过滤：通道实现若没排除过时行，这里兜住（不注入是硬要求）
   * ② 过时探测：真实实现的通道**结构上**不返回过时行（SQL 层就排除了），
   *    所以主路径只能靠探测知道"这里曾经有过一条已被推翻的结论"
   */
  const overturnedById = new Map<string, { supersededBy: string | null; validTo: number | null }>()
  let reservedSkipped = 0
  const usable: HydratedCandidate[] = []
  for (const entry of hydrated) {
    if (isReservedSource(entry.record.sourceRef)) {
      reservedSkipped += 1
      continue
    }
    // 已失效（被取代/矛盾裁决/到期）的条目不注入——通道实现若不排除，这里兜底。
    // 注意：真实实现的通道在 SQL 层就排除了 `valid_to`/`superseded_by` 非空的行，
    // 所以这里通常什么也拦不到；"曾经有过一条已被推翻的结论"靠**过时探测**（见下）而非本行。
    // 只设了 `supersededBy`（`validTo` 仍为空）的半成品行会走到注入列表里——
    // 那是刻意的：与其静默丢弃，不如注入并逐条标注"不是有效结论"（渲染层负责标注）。
    if (entry.record.validTo !== null) {
      noteOverturned(overturnedById, entry.record.id, entry.record.supersededBy, entry.record.validTo)
      continue
    }
    usable.push(entry)
  }
  const capped = usable.slice(0, maxCandidates)
  const dropped = orderedFused.length - usable.length

  for (const hit of await probeOverturned(ordered, query, degraded)) {
    noteOverturned(overturnedById, hit.id, hit.supersededBy, hit.validTo)
  }
  const supersededIds = [...overturnedById]
    .filter(([, value]) => value.supersededBy !== null)
    .map(([id]) => id)
    .sort(asciiCompare)
  const supersededSkipped = supersededIds.length
  const expiredSkipped = [...overturnedById.values()].filter(value => value.validTo !== null).length

  // ⑥ 可选廉价重排。
  const reranked = rerankRequested && now !== undefined
    ? cheapRerank(capped, {
        now,
        ...(query.rerankHalfLifeMs !== undefined ? { halfLifeMs: query.rerankHalfLifeMs } : {}),
        ...(query.scope !== undefined ? { preferredScope: query.scope } : {}),
      })
    : capped

  // ⑤ 每库配额。
  const quota = normalizeQuota(query.perStoreQuota, limit, ordered.length)
  const selection = selectWithQuota(
    reranked.map(h => ({ id: h.candidate.id, scope: primaryScope(h.candidate) })),
    limit,
    quota,
  )
  const selected = new Set(selection.map(s => s.id))
  const chosen = reranked.filter(h => selected.has(h.candidate.id))

  const items = chosen.map((h, rank) => toItem(h, rank))
  return {
    items,
    gate,
    degraded,
    stats: {
      storesQueried: ordered.length,
      channelsUsed: unique(rankings.map(r => r.channel)),
      candidatesFused: fused.length,
      candidatesCapped: capped.length,
      dropped,
      reservedSkipped,
      expiredSkipped,
      supersededSkipped,
      supersededSkippedIds: supersededIds.slice(0, MAX_REPORTED_SUPERSEDED),
      perStore: ordered.map(t => ({
        scope: t.scope,
        candidates: capped.filter(entry => primaryScope(entry.candidate) === t.scope).length,
        selected: chosen.filter(entry => primaryScope(entry.candidate) === t.scope).length,
      })),
      rrfK: k,
      reranked: rerankRequested,
    },
    now: now ?? null,
    note: buildNote(ordered.length, rankings.length, items.length, supersededSkipped),
  }
}

// ---------- 内部工具 ----------

interface StoreSearch {
  readonly tagged: TaggedStore
  readonly rankings: readonly ChannelRanking[]
}

interface HydratedCandidate {
  readonly candidate: FusedCandidate
  readonly record: MemoryRecord
}

function emptyStats(k: number): RetrieveStats {
  return {
    storesQueried: 0,
    channelsUsed: [],
    candidatesFused: 0,
    candidatesCapped: 0,
    dropped: 0,
    reservedSkipped: 0,
    expiredSkipped: 0,
    supersededSkipped: 0,
    supersededSkippedIds: [],
    perStore: [],
    rrfK: k,
    reranked: false,
  }
}

/**
 * 一句话结论。**"被取代"必须出现在这里**：
 * 零命中既可能是"没有这段记忆"，也可能是"有过结论、已被推翻"——两者对后续会话的含义完全相反。
 *
 * ## 为什么写清"通道"的口径
 *
 * 自检报告提过一个合理疑问：「召回头部通道数从首次的『已查询 2 个库、**4 个通道**』
 * 变为后续的『**1 个通道**』，插件未解释该数字含义，我无法判断是"命中通道数"
 * 还是"启用通道数"」。
 *
 * 答案是**参与本次排序的通道数**（注册表里当时可用的），不是"命中了几个通道"。
 * 数字会变是因为通道注册是异步的：向量通道装载完成的那一刻它才加入。
 * 这个口径必须写出来——否则读者只能猜，而"猜"正是状态面最该消灭的东西。
 */
function buildNote(
  storeCount: number,
  rankingCount: number,
  hitCount: number,
  supersededSkipped: number,
): string {
  const overturned =
    supersededSkipped > 0
      ? `；另有 ${supersededSkipped} 条相关记忆因**已被取代**而未注入（它们不是有效结论；历史痕迹用 omb_relate 追）`
      : ''
  const channels = `${rankingCount} 个通道（本次参与排序的通道数，不是命中数；向量通道异步装载，装载完成前不计入）`
  if (hitCount === 0) {
    return `已查询 ${storeCount} 个库、${channels}，零命中（一等结果，不是错误）${overturned}`
  }
  return `已查询 ${storeCount} 个库、${channels}，注入 ${hitCount} 条（逐字 + 溯源）${overturned}`
}

/**
 * 记一条"匹配到但不算数"的条目。**按 id 去重**：兜底过滤与探测可能报同一条，
 * 重复计数会让状态面撒谎（"有 2 条被推翻"而实际只有 1 条）。
 */
function noteOverturned(
  map: Map<string, { supersededBy: string | null; validTo: number | null }>,
  id: string,
  supersededBy: string | null,
  validTo: number | null,
): void {
  const existing = map.get(id)
  if (existing === undefined) {
    map.set(id, { supersededBy, validTo })
    return
  }
  // 同一条只记一次，信息取更全的那个（谁取代了它比"失效了"更有用）
  map.set(id, {
    supersededBy: existing.supersededBy ?? supersededBy,
    validTo: existing.validTo ?? validTo,
  })
}

/**
 * 过时探测：问每个库"这条查询匹配到、但已经不算数的条目有哪些"。
 *
 * 库不支持探测（fake store / 其它实现）→ 跳过，**不算降级**；
 * 探测抛错 → 记降级原因（不静默：那会让人误以为"没有过时结论"）。
 */
async function probeOverturned(
  ordered: readonly TaggedStore[],
  query: RetrieveQuery,
  degraded: string[],
): Promise<readonly OverturnedHit[]> {
  const hits: OverturnedHit[] = []
  await Promise.all(
    ordered.map(async tagged => {
      const probe = asOverturnedProbe(tagged.store)
      if (probe === undefined) return
      try {
        const found: unknown = await probe.searchOverturned({
          text: query.text,
          scope: tagged.store.scope,
          limit: MAX_REPORTED_SUPERSEDED,
          ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
        })
        if (!Array.isArray(found)) {
          degraded.push(`库 ${tagged.store.scope} 的过时探测返回了非数组（已忽略）：本次不报告过时结论`)
          return
        }
        for (const hit of found as readonly OverturnedHit[]) {
          if (typeof hit?.id === 'string' && hit.id.length > 0) hits.push(hit)
        }
      } catch (error) {
        degraded.push(
          `库 ${tagged.store.scope} 的过时探测失败（${messageOf(error)}）：本次不报告"已被推翻"的结论`,
        )
      }
    }),
  )
  return hits
}

function toItem(hydrated: HydratedCandidate, rank: number): RetrievedItem {  const { candidate, record } = hydrated
  return {
    rank,
    id: record.id,
    text: record.text,
    sourceRef: record.sourceRef,
    observedAt: record.observedAt,
    scope: record.scope,
    kind: record.kind,
    assertedBy: record.assertedBy,
    project: record.project,
    validTo: record.validTo,
    supersededBy: record.supersededBy,
    score: candidate.score,
    channels: candidate.channels,
    ranks: candidate.matches,
  }
}

/** 库的确定序：作用域优先级 → 原序（保证同一输入永远同一结果）。 */function orderStores(stores: readonly TaggedStore[]): readonly TaggedStore[] {
  return stores
    .map((store, index) => ({ store, index }))
    .sort((a, b) => {
      const pa = SCOPE_PRIORITY[a.store.scope]
      const pb = SCOPE_PRIORITY[b.store.scope]
      if (pa !== pb) return pa - pb
      return a.index - b.index
    })
    .map(entry => entry.store)
}

/** 每作用域一次批量水合；单库失败只降级不抛。 */
async function hydrate(
  ordered: readonly TaggedStore[],
  candidates: readonly FusedCandidate[],
  degraded: string[],
): Promise<readonly HydratedCandidate[]> {
  if (candidates.length === 0) return []
  const idsByScope = new Map<MemoryScope, string[]>()
  for (const candidate of candidates) {
    const scope = primaryScope(candidate)
    const bucket = idsByScope.get(scope)
    if (bucket === undefined) idsByScope.set(scope, [candidate.id])
    else bucket.push(candidate.id)
  }
  const records = new Map<string, MemoryRecord>()
  await Promise.all(
    [...idsByScope].map(async ([scope, ids]) => {
      const tagged = ordered.find(t => t.scope === scope)
      if (tagged === undefined) return
      try {
        const found = await tagged.store.getMany(ids)
        for (const record of found) records.set(record.id, record)
      } catch (err) {
        degraded.push(`库 ${scope} 水合失败（${messageOf(err)}）：该库候选被丢弃`)
      }
    }),
  )
  const out: HydratedCandidate[] = []
  for (const candidate of candidates) {
    const record = records.get(candidate.id)
    if (record !== undefined) out.push({ candidate, record })
  }
  return out
}

async function safeSearch(
  fn: () => Promise<readonly ScoredHit[]>,
  degraded: string[],
  label: string,
): Promise<readonly ScoredHit[] | null> {
  try {
    const raw: unknown = await fn()
    if (!Array.isArray(raw)) {
      degraded.push(`${label}：返回值不是数组（通道实现违规）`)
      return null
    }
    return (raw as readonly unknown[]).filter(isUsableHit)
  } catch (err) {
    degraded.push(`${label}：${messageOf(err)}`)
    return null
  }
}

function isUsableHit(value: unknown): value is ScoredHit {
  if (typeof value !== 'object' || value === null) return false
  const hit = value as { id?: unknown; score?: unknown; channel?: unknown }
  return (
    typeof hit.id === 'string' &&
    hit.id.length > 0 &&
    typeof hit.score === 'number' &&
    typeof hit.channel === 'string'
  )
}

/**
 * 读时钟。**模块层不读墙钟**：时钟一律经端口注入（`kernel.clock`）。
 * 读数缺失/非法 → `undefined`，调用方据此关掉时间相关的先验并如实降级。
 */
function readNow(ports: RetrievePorts): number | undefined {
  try {
    const value = ports.clock?.now()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  } catch {
    // 时钟故障不该让检索失败：由调用方降级（跳过重排）。
  }
  return undefined
}

function normalizeK(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_RRF_K
  return value
}

function normalizePositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

function normalizeQuota(value: number | undefined, limit: number, storeCount: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value)
  return Math.max(1, Math.ceil(limit / Math.max(1, storeCount)))
}

function normalizeHalfLife(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return RERANK_HALF_LIFE_MS
  return value
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)]
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}
