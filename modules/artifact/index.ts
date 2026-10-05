/**
 * 制品索引：**只维护索引，不注入清单**（规划 §6.4 拉取式上下文）。
 *
 * 旧实现维护 500 条清单，并把"最近制品"注入上下文。两个问题：
 * ① **最近 ≠ 相关**——注入的是时间上新的，不是当下有用的；
 * ② 清单本身占 token，而模型多数回合根本不需要找文件。
 *
 * 新形态：
 * - 索引常驻内存（**不进上下文**：本类没有任何 inject/contribute 方法）
 * - 模型需要找文件时调 `omb_files({ query? })`，一次最多返回 **1~3 条**索引条目
 *   （路径/类型/时间），**不含内容**；内容由模型用读取类工具按需取
 * - 有 query 时按相关性排序，**没有相关结果就返回空**——不拿"最近的"顶替
 *
 * 与宿主 ABI 的关系（Lead 最终裁决）：冻结核的 `evidence/observed` 载荷只有
 * `actionHash`/`evidenceHash`，**没有路径**，所以本索引**不从事件推导**——
 * 唯一入口是 `record(path)`：由 `dsh/hooks.ts` 从宿主会话事件（`tool/call` 参数）
 * 提取路径后喂进来。单一入口，避免"事件推导"与"显式喂入"两条来源分叉。
 */
import type { Logger } from '../../kernel/abi/index.js'

/** 索引簿记上限（**不是上下文预算**：索引不进上下文）。 */
export const ARTIFACT_DEFAULT_MAX = 500

/** 一次最多返回几条：1~3。上限写死为 3，避免"索引变清单"。 */
export const ARTIFACT_TOP_MAX = 3
export const ARTIFACT_TOP_MIN = 1

export type ArtifactKind = 'file' | 'dir' | 'unknown'

const ARTIFACT_KINDS: readonly ArtifactKind[] = ['file', 'dir', 'unknown']

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && ARTIFACT_KINDS.includes(value as ArtifactKind)
}

export interface ArtifactEntry {
  readonly path: string
  readonly kind: ArtifactKind
  /** 内容哈希；`''` = 尚未观察到内容（**不拿路径哈希冒充内容哈希**）。 */
  readonly contentHash: string
  readonly at: number
}

/**
 * 隐私判定端口（**结构契约**；由 `omb-privacy` 提供）。
 *
 * 定义在这里而不是 import `modules/privacy/`：分层规则禁止模块互相 import
 * （`eslint.config.mjs` 的 `no-layer-violation`），双方只认形状——与
 * `modules/memory/store.ts` 的 `PrivacyGatePort` 同一处理方式。
 *
 * **为什么制品索引也要过隐私闸门**（Lead 裁决）：制品索引就是一份**阅读痕迹**
 * （本会话读过/写过哪些文件）。把它排除在隐私之外，会得到
 * "记忆读不到、但你的文件足迹照样列得出来"的半个隐私。
 */
export interface ArtifactPrivacyDecision {
  readonly allowRead: boolean
  readonly allowWrite: boolean
  readonly readReason: string
  readonly writeReason: string
}

export interface ArtifactPrivacyPort {
  decide(sessionId: string): ArtifactPrivacyDecision
  decideUnattributed(): ArtifactPrivacyDecision
  /**
   * 是否存在任何受限会话（或受限基线）。
   *
   * 用途只有一个：**归属未知的"读"**判定。记忆侧的 `decideUnattributed()` 是
   * "禁写不禁读"（写不可逆、读可恢复）；而制品索引返回的是**阅读痕迹**，
   * 归属未知时读同样可能泄露受限会话的足迹，因此这里按 Lead 的裁决取更严的一侧：
   * 只要存在受限会话就拒绝读。没有任何受限会话时照常放行——
   * 否则隐私模块会把一个正常功能变成永久故障。
   */
  restricted?(): boolean
}

export interface ArtifactIndexDeps {
  readonly maxEntries?: number
  readonly logger?: Logger
  /**
   * 惰性解析隐私判定端口（行序无关：`omb-privacy` 可能后于本模块挂载）。
   * 取不到 = 不受限（隐私模块被关掉 = 没有隐私模式）。
   */
  readonly privacy?: () => ArtifactPrivacyPort | undefined
}

/** 归属未知（调用方拿不到会话）时的说明，与记忆侧同口径。 */
export const ARTIFACT_UNATTRIBUTED_READ_DENIED =
  '无法确定本次调用的会话归属（宿主未提供 agent），因此无法证明它不属于受限会话：'
  + '按最严处理，拒绝读取制品索引（阅读痕迹同样属于隐私）。'

/**
 * 「写入被拒绝」的**留声**：一次拒绝必须留下可读痕迹，否则就是静默失效。
 *
 * 背景（审计 C3 + Lead 的复核）：`ArtifactIndex.record()` 在隐私闸门禁止写入时
 * 抛可读错误，而 `dsh/hooks.ts` 的订阅回调把异常吞掉 → 用户把任何一个会话设为
 * sealed 之后，**所有会话**的制品索引静默停更，`omb_files` 永远回答
 * "本会话还没有观察到任何制品"——**这是错误暗示**（真因是写入被拒），
 * 而当时唯一的线索在另一个模块（privacy）的计数里。
 *
 * 因此索引自己记住：拒绝**次数**（累计）、**最近一次原因**（可读）。
 * 两者都进 `module.ts` 的状态面与 `omb_files` 的空结果文案。
 */
export interface ArtifactWriteRejection {
  /** 本实例启动以来的拒绝次数（**0 = 真的没被拒过**，不是"未测量"）。 */
  readonly count: number
  /** 最近一次拒绝原因；从未被拒为 `null`（**null ≠ 空串**）。 */
  readonly lastReason: string | null
}

/** 匹配用路径：小写 + 统一分隔符（Windows 反斜杠）。展示仍用原路径。 */
function matchPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function tokensOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0)
}

/**
 * 相关性打分。**词法相关，不做"最近即相关"的替换**。
 *
 * 打分分档（从精确到宽松）：
 * 1. 整条路径相等 → 100
 * 2. 文件名相等 / 路径以 `/<query>` 结尾 → 70
 * 3. **含分隔符的路径片段或 CJK** → 允许整串包含（这两类没有可用的词边界）
 * 4. 其余情况要求**词元相等**
 *
 * 为什么第 3 档要限定条件：`does-not-exist` 曾因 `notes` 里含 `not` 而命中
 * `docs/notes.md`——"看起来沾边"和"最近"一样是假召回。精度优先于召回（§5.1）。
 */
function relevance(entry: ArtifactEntry, query: string, queryTokens: readonly string[]): number {
  const path = matchPath(entry.path)
  const wanted = matchPath(query)
  if (wanted.length === 0) return 0
  if (path === wanted) return 100
  const base = basename(path)
  if (base === wanted || path.endsWith(`/${wanted}`)) return 70
  // 无词边界的查询（路径片段 / CJK）才允许整串包含
  if ((wanted.includes('/') || /[^\u0000-\u007F]/.test(wanted)) && path.includes(wanted)) return 40
  const pathTokens = new Set(tokensOf(path))
  let hits = 0
  for (const token of queryTokens) {
    if (pathTokens.has(token)) hits += 1
  }
  return hits > 0 ? 10 + hits : 0
}

/** 把 limit 夹到 1~3；非法值取上限。 */
export function clampTopLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ARTIFACT_TOP_MAX
  return Math.min(ARTIFACT_TOP_MAX, Math.max(ARTIFACT_TOP_MIN, Math.trunc(limit)))
}

export class ArtifactIndex {
  readonly #index = new Map<string, ArtifactEntry>()
  readonly #maxEntries: number
  readonly #logger: Logger | undefined
  readonly #privacy: (() => ArtifactPrivacyPort | undefined) | undefined
  /** 写入被隐私闸门拒绝的次数（见 {@link ArtifactWriteRejection}）。 */
  #rejectedWrites = 0
  #lastWriteRejection: string | null = null

  constructor(deps: ArtifactIndexDeps = {}) {
    this.#maxEntries = Math.max(1, Math.trunc(deps.maxEntries ?? ARTIFACT_DEFAULT_MAX))
    this.#logger = deps.logger
    this.#privacy = deps.privacy
  }

  /**
   * 读判定。**这是本模块的数据边界**：工具（`omb_files`）与服务（`ArtifactService`）
   * 都只能经这里拿数据，所以判定放在这一层就不存在"某条入口绕过"的可能。
   *
   * - 给了会话 → 按会话判定（sealed 禁读；子代理已经由隐私侧解析成父的模式）
   * - 没给会话 → 归属未知：**存在任何受限会话时禁读**（scoped fail-closed）。
   *   为什么不是"永远禁读"：没有任何受限会话时禁读等于把功能做成了故障；
   *   为什么不是"永远放行"：那会让 sealed 会话的足迹照样列得出来。
   */
  #readDenial(sessionId: string | undefined): string | null {
    const port = this.#privacy?.()
    if (port === undefined) return null // 没有隐私模块 → 不受限
    if (sessionId === undefined || sessionId.length === 0) {
      // 归属未知：存在受限会话时**禁读**（制品索引＝阅读痕迹，见端口注释）。
      if (port.restricted?.() === true) return ARTIFACT_UNATTRIBUTED_READ_DENIED
      return port.decideUnattributed().allowRead ? null : ARTIFACT_UNATTRIBUTED_READ_DENIED
    }
    const decision = port.decide(sessionId)
    return decision.allowRead ? null : decision.readReason
  }

  /** 写判定（记录制品＝写一份阅读痕迹）。 */
  #writeDenial(sessionId: string | undefined): string | null {
    const port = this.#privacy?.()
    if (port === undefined) return null
    const decision = sessionId === undefined || sessionId.length === 0
      ? port.decideUnattributed()
      : port.decide(sessionId)
    return decision.allowWrite ? null : decision.writeReason
  }

  /**
   * 记录/更新一条制品。同路径 upsert（不产生重复条目）。
   *
   * `kind` 由**调用方**给出（`dsh/hooks.ts` 按工具名映射：read/write/edit/read_image
   * → `'file'`，glob/grep → `'dir'`；白名单之外的调用方拿不到类型，落回 `'unknown'`）。
   * 模块侧看不到工具名，因此**不做映射**，只保证给出的合法值被原样保留。
   *
   * @returns 写入的条目；路径为空时返回 undefined（不臆造条目）
   * @throws 隐私模式禁止写入时抛**可读**错误（调用方如实上报，见 `dsh/hooks.ts` 的隔离）；
   *   每次拒绝都会在 {@link rejectedWrites} / {@link lastWriteRejection} 留声
   */
  record(
    input: {
      readonly path: string
      readonly kind?: unknown
      readonly contentHash?: unknown
      readonly at: number
    },
    sessionId?: string,
  ): ArtifactEntry | undefined {
    const denial = this.#writeDenial(sessionId)
    if (denial !== null) {
      this.#rejectedWrites += 1
      this.#lastWriteRejection = denial
      // **只在第一次拒绝时写日志**：每次工具调用都拒的时候逐条 warn 会淹没日志，
      // 而"留声"的目的已经由计数 + 最近原因 + 状态面达成（`dsh/hooks.ts` 另有
      // 同类失败只报一次的 warn）。第一次必须说，否则这个降级最初就是静默的。
      if (this.#rejectedWrites === 1) {
        this.#logger?.warn(
          `制品索引：写入被隐私闸门拒绝（本次不记录，索引因此停更）——${denial}；`
          + '后续同类拒绝只累计计数（见 omb_status 的制品索引段与 omb-files 的空结果文案）',
        )
      }
      throw new Error(denial)
    }
    const path = input.path.trim()
    if (path.length === 0) return undefined
    const previous = this.#index.get(path)
    const entry: ArtifactEntry = {
      path,
      kind: isArtifactKind(input.kind) ? input.kind : (previous?.kind ?? 'unknown'),
      contentHash:
        typeof input.contentHash === 'string' && input.contentHash.length > 0
          ? input.contentHash
          : (previous?.contentHash ?? ''),
      at: Number.isFinite(input.at) ? input.at : 0,
    }
    // 重新插入：Map 迭代序保持"最近记录在后"，便于按 at 淘汰时稳定
    this.#index.delete(path)
    this.#index.set(path, entry)
    this.#evict()
    return entry
  }

  /**
   * 按需查询：最多 1~3 条（**上限写死为 3**）。
   * - 无 query：按最近排序（调用方明确要"最近"）
   * - 有 query：按相关性排序；**无相关结果返回空数组**（不拿最近的顶替）
   *
   * @param sessionId 本次读取的会话归属（工具从 `ToolCallContext` 传进来）；
   *   省略即"归属未知"，判定见 `#readDenial`
   * @throws 隐私模式禁止读取时抛**可读**错误（工具层转成可读的 error 结果）
   */
  topFor(query?: string, limit?: number, sessionId?: string): readonly ArtifactEntry[] {
    const denial = this.#readDenial(sessionId)
    if (denial !== null) throw new Error(denial)
    const capped = clampTopLimit(limit)
    const wanted = (query ?? '').trim()
    if (wanted.length === 0) {
      return [...this.#index.values()].sort(byRecency).slice(0, capped)
    }
    const queryTokens = tokensOf(wanted)
    return [...this.#index.values()]
      .map(entry => ({ entry, score: relevance(entry, wanted, queryTokens) }))
      .filter(item => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.at - a.entry.at ||
          a.entry.path.localeCompare(b.entry.path),
      )
      .slice(0, capped)
      .map(item => item.entry)
  }

  /**
   * 全量快照（状态面/审计用）。**不用于注入**，但它返回的是**路径清单**——
   * 因此同样过读判定（Lead 明确要求核对所有出口，不要只堵 `topFor`）。
   */
  list(sessionId?: string): readonly ArtifactEntry[] {
    const denial = this.#readDenial(sessionId)
    if (denial !== null) throw new Error(denial)
    return [...this.#index.values()].sort(byRecency)
  }

  size(): number {
    return this.#index.size
  }

  maxEntries(): number {
    return this.#maxEntries
  }

  /**
   * 写入被隐私闸门拒绝的次数（**本实例启动以来累计**）。
   *
   * 语义边界：`clear()` **不**清零这个计数——它描述的是"发生过什么"，
   * 而不是"索引里现在有什么"；把它和条目一起清掉就等于把拒绝痕迹也抹了。
   */
  rejectedWrites(): number {
    return this.#rejectedWrites
  }

  /** 最近一次写入被拒的可读原因；从未被拒为 `null`。 */
  lastWriteRejection(): string | null {
    return this.#lastWriteRejection
  }

  /** 拒绝留声的两个数，一次取全（供状态面与 `omb_files` 的空结果文案）。 */
  writeRejection(): ArtifactWriteRejection {
    return { count: this.#rejectedWrites, lastReason: this.#lastWriteRejection }
  }

  clear(): void {
    this.#index.clear()
  }

  #evict(): void {
    if (this.#index.size <= this.#maxEntries) return
    const ordered = [...this.#index.values()].sort(
      (a, b) => a.at - b.at || a.path.localeCompare(b.path),
    )
    const excess = this.#index.size - this.#maxEntries
    for (let index = 0; index < excess; index += 1) {
      const victim = ordered[index]
      if (victim !== undefined) this.#index.delete(victim.path)
    }
    // 淘汰是簿记行为，不是错误：索引有界，且**不进上下文**，所以只记 debug。
    this.#logger?.debug(`制品索引：淘汰 ${excess} 条（上限 ${this.#maxEntries}）`)
  }
}

function byRecency(a: ArtifactEntry, b: ArtifactEntry): number {
  return b.at - a.at || a.path.localeCompare(b.path)
}
