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

export interface ArtifactIndexDeps {
  readonly maxEntries?: number
  readonly logger?: Logger
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

/** 相关性打分。**词法相关，不做"最近即相关"的替换**。 */
function relevance(entry: ArtifactEntry, query: string, queryTokens: readonly string[]): number {
  const path = matchPath(entry.path)
  const wanted = matchPath(query)
  if (wanted.length === 0) return 0
  if (path === wanted) return 100
  const base = basename(path)
  if (base === wanted || path.endsWith(`/${wanted}`)) return 70
  if (base.includes(wanted)) return 50
  if (path.includes(wanted)) return 30
  let hits = 0
  for (const token of queryTokens) {
    if (path.includes(token)) hits += 1
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

  constructor(deps: ArtifactIndexDeps = {}) {
    this.#maxEntries = Math.max(1, Math.trunc(deps.maxEntries ?? ARTIFACT_DEFAULT_MAX))
    this.#logger = deps.logger
  }

  /**
   * 记录/更新一条制品。同路径 upsert（不产生重复条目）。
   * @returns 写入的条目；路径为空时返回 undefined（不臆造条目）
   */
  record(input: {
    readonly path: string
    readonly kind?: unknown
    readonly contentHash?: unknown
    readonly at: number
  }): ArtifactEntry | undefined {
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
   */
  topFor(query?: string, limit?: number): readonly ArtifactEntry[] {
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

  /** 全量快照（状态面/审计用）。**不用于注入**。 */
  list(): readonly ArtifactEntry[] {
    return [...this.#index.values()].sort(byRecency)
  }

  size(): number {
    return this.#index.size
  }

  maxEntries(): number {
    return this.#maxEntries
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
