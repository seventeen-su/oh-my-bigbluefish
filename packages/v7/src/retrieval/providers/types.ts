import type { OmbErrorCode } from '../../domain/errors.js'
import type { Expansion } from '../../domain/link.js'
import type { Embedder } from '../../ports/embedding.js'
import type { Store } from '../../ports/store.js'
import type { ChannelHit } from '../../ports/search.js'
import type { ProviderChannel, RetrievalPlan } from '../compiler.js'
import type { ChainInfo } from '../expand.js'

/**
 * 统一 IndexProvider 契约（ADR-0009）。
 *
 * 每个 provider 只做一件事：拿到计划 + 上下文，返回命中/扩展或一个明确的非成功状态。
 * deadline、失败隔离、排序/去重/截断由 `run.ts` 统一做，provider 里不写超时逻辑，
 * 这样新增 provider 不会各自发明一套错误语义。
 */

/** provider 的执行状态；`failed`/`deadline` 由 runner 判定，provider 自己只返回前四种。 */
export type ProviderStatus = 'ok' | 'empty' | 'skipped' | 'unavailable' | 'failed' | 'deadline'

/** provider 自己能返回的状态（不含 runner 判定的失败/超时）。 */
export type ProviderResultStatus = 'ok' | 'empty' | 'skipped' | 'unavailable'

export interface ProviderIssue {
  readonly code: OmbErrorCode
  readonly message: string
  readonly retryable: boolean
}

export interface ProviderResult {
  readonly status: ProviderResultStatus
  /** 阶段一命中；图扩展 provider 留空。 */
  readonly hits?: readonly ChannelHit[]
  /** 阶段二图扩展结果（links/expand）。 */
  readonly expansions?: readonly Expansion[]
  readonly chains?: ReadonlyMap<string, ChainInfo>
  readonly reason?: string
  /** 非致命问题：进 channelErrors（阶段一），但不改变本次 status。 */
  readonly issues?: readonly ProviderIssue[]
  /** 不改变 status 的提示：进结果的 warnings。 */
  readonly warnings?: readonly string[]
}

export interface ProviderContext {
  readonly store: Store
  readonly embedder: Embedder
  /** 查询时间锚点（plan.time.now）。 */
  readonly now: string
  /** 本 provider 的取消信号；超时后 runner 会 abort，provider 可用它提前放弃。 */
  readonly signal: AbortSignal
  /**
   * 本 provider 的剩余执行预算（ms）：runner 已按 `min(provider.timeoutMs, 计划剩余)` 算好。
   * provider 必须把它传给 store，让适配器用服务端取消（PostgreSQL statement_timeout）
   * 真正结束仍在跑的查询，而不是只丢弃 Promise（RET-10）。
   */
  readonly timeoutMs: number
  /** 阶段一已完成的通道命中（single_char 依赖 fulltext 命中数）。 */
  readonly previous: ReadonlyMap<ProviderChannel, readonly ChannelHit[]>
  /** 阶段二种子（expand provider 使用）。 */
  readonly seeds: readonly string[]
  /** 已拿到的原始图扩展结果（links provider 使用）。 */
  readonly expansions: readonly Expansion[]
}

export interface IndexProvider {
  readonly channel: ProviderChannel
  /** 依赖阶段一结果，必须等其它阶段一 provider 结束后串行执行（目前只有 single_char）。 */
  readonly afterStageOne?: boolean
  search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult>
}

/** runner 产出：provider 结果 + 状态/耗时/失败证据。 */
export interface ProviderOutcome {
  readonly channel: ProviderChannel
  readonly status: ProviderStatus
  readonly hits: readonly ChannelHit[]
  readonly expansions: readonly Expansion[]
  readonly chains: ReadonlyMap<string, ChainInfo>
  readonly reason?: string
  readonly issues: readonly ProviderIssue[]
  readonly warnings: readonly string[]
  readonly elapsedMs: number
}
