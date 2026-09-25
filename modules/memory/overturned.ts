/**
 * 「过时结论探测」的非 ABI 契约面（`modules/memory` 内部）。
 *
 * ## 为什么需要它
 *
 * `SqliteStore` 的词法/向量通道在 SQL 层就排除了 `valid_to` / `superseded_by` 非空的行
 * （精度优先，规划 §5.1：过时结论不得注入）。这个决定是对的，但它带来一个**观察盲区**：
 * "本次查询其实匹配到一条已被推翻的旧结论"这件事，在召回侧完全不可见——
 * 后续会话只会看到「零命中」，从而以为这里**从来没有过**结论。
 * "没有结论"与"有过结论、已被推翻"对后续会话的含义完全不同，所以必须能被区分。
 *
 * 因此这里给存储实现一个**只读的旁路探测**：它只回答"哪些匹配到的条目已经不算数、
 * 被谁取代了"，返回的东西**绝不进注入列表**。注入用哪条仍然由 `retrieve.ts` 决定。
 *
 * ## 为什么是结构契约而不是 ABI 方法
 *
 * `kernel/abi` 的 `MemoryStore` 是冻结的接口（不该为一个诊断面扩端口），
 * 而且 fake store 与将来的其它实现可以按需实现、缺失即跳过（**不降级、不抛**）。
 * 因此判定是"有这个方法就支持"的结构探测。
 */
import type { MemoryKind, MemoryScope, MemoryStore } from '../../kernel/abi/index.js'

export interface OverturnedQuery {
  readonly text: string
  readonly scope: MemoryScope
  readonly limit: number
  /** 与本次召回相同的类型过滤（调用方限定了 kinds 时，过时条目也该按同一口径报）。 */
  readonly kinds?: readonly MemoryKind[]
}

/** 一条过时（不再作为有效结论注入）的库内条目。 */
export interface OverturnedHit {
  readonly id: string
  /** 取代它的条目 id；`null` = 只是到期失效，不是被推翻。 */
  readonly supersededBy: string | null
  readonly validTo: number | null
}

/** 过时探测面。**只读**：实现方不得因此改动任何状态。 */
export interface OverturnedProbe {
  searchOverturned(query: OverturnedQuery): Promise<readonly OverturnedHit[]>
}

/**
 * 取过时探测面。不支持 → `undefined`（调用方跳过探测，既不降级也不抛）。
 *
 * 用结构探测而不是 `instanceof`：契约是能力而不是类型身份，
 * 这样测试里的 fake store 也能实现它来构造"过时行确实存在"的场景。
 */
export function asOverturnedProbe(store: MemoryStore): OverturnedProbe | undefined {
  const candidate = store as unknown as Partial<OverturnedProbe>
  if (typeof candidate.searchOverturned !== 'function') return undefined
  return {
    searchOverturned: (query: OverturnedQuery) => candidate.searchOverturned!.call(store, query),
  }
}
