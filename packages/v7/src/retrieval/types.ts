import type { Category, EntityKind, Scope, StateStatus } from '../domain/entity.js'
import type { OmbErrorCode } from '../domain/errors.js'
import type { JsonValue } from '../domain/json.js'
import type {
  EXPANSION_MODES,
  RECALL_CHANNELS,
  RECALL_SCENARIOS,
  STAGE_ONE_CHANNELS,
} from './constants.js'

export type StageOneChannel = (typeof STAGE_ONE_CHANNELS)[number]
export type RecallChannel = (typeof RECALL_CHANNELS)[number]
export type RecallScenario = (typeof RECALL_SCENARIOS)[number]
export type ExpansionMode = (typeof EXPANSION_MODES)[number]

export interface TimeWindow {
  readonly from: string
  readonly to: string
}

export interface RecallRequest {
  readonly query: string
  readonly scenario?: RecallScenario
  /** 缺省 'both'：链接与思维链成员都做图扩展。 */
  readonly expand?: ExpansionMode
  readonly scope?: 'global' | 'project'
  readonly projectKey?: string
  readonly kind?: EntityKind
  readonly category?: Category
  readonly status?: readonly StateStatus[]
  readonly includeArchived?: boolean
  readonly includeHistory?: boolean
  readonly limit?: number
  readonly hops?: 1 | 2
  /** 显式时间窗；缺省时按场景的 timeWindowDays 从 now 回推。 */
  readonly timeWindow?: TimeWindow
  /**
   * 查询日历日使用的 IANA 时区（如 `Asia/Shanghai`）；缺省用检索配置的 `timezone`。
   * 只影响「今天/昨天/前天」这类**日历日**解析，不影响其余相对时间（最近 N 天）。
   */
  readonly timezone?: string
  /** 注入时钟（ISO 8601）；不传用 Clock 端口。 */
  readonly now?: string
  readonly traceId?: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly trigger?: string
  /** 本次结果是否会注入上下文；T2 模型主动检索为 false，T0/T1 注入为 true。 */
  readonly injected?: boolean
}

export type ChannelStatus = 'ok' | 'empty' | 'skipped' | 'failed' | 'unavailable'

export interface ChannelReport {
  readonly channel: StageOneChannel
  readonly status: ChannelStatus
  readonly hitCount: number
  readonly reason?: string
}

export interface ChannelError {
  readonly channel: RecallChannel
  readonly code: OmbErrorCode
  readonly message: string
  readonly retryable: boolean
}

export type EmptyReasonCode =
  | 'empty-query'
  | 'no-stage-one-hits'
  | 'all-channels-failed'
  | 'below-threshold'
  | 'filtered-out'
  | 'summaries-failed'

export interface EmptyReason {
  readonly code: EmptyReasonCode
  readonly message: string
  readonly details?: JsonValue
}

export interface RecallHit {
  readonly entityId: string
  readonly kind: EntityKind
  readonly title?: string
  readonly snippet: string
  readonly category?: Category
  readonly status?: StateStatus
  readonly scope: Scope
  readonly updatedAt: string
  /** 最终分：融合分 × 重排先验（先验乘数限制在 [0.5, 1.5]）。 */
  readonly score: number
  /** RRF 融合分（门控用），便于审计「为什么这条排在这里」。 */
  readonly fusedScore: number
  readonly why: readonly string[]
  readonly channels: readonly RecallChannel[]
  readonly rawScores: Readonly<Partial<Record<RecallChannel, number>>>
  /** 命中思维链成员/组时带出的同组标题（组标题在前，其它成员标题随后，不含自身）。 */
  readonly chainSiblings: readonly string[]
  readonly historyCount: number
  /** 这条命中是否由图扩展带到结果里（阶段一直接命中为缺省）。 */
  readonly expanded?: boolean
}

export interface ExpansionStats {
  /** 去重后的种子实体数（每通道前 seedLimit 的并集）。 */
  readonly seeds: number
  /** 图扩展返回的候选数（含已在阶段一出现的实体）。 */
  readonly expanded: number
  /** 命中的思维链组数。 */
  readonly chains: number
}

export interface RecallResult {
  readonly traceId: string
  readonly configVersion: string
  readonly scenario: RecallScenario
  readonly query: string
  readonly hits: readonly RecallHit[]
  readonly emptyReason?: EmptyReason
  readonly channelErrors: readonly ChannelError[]
  readonly channels: readonly ChannelReport[]
  readonly expansion: ExpansionStats
  readonly warnings: readonly string[]
  /** 本机耗时；仅用于基准与诊断，不参与排序。 */
  readonly timings?: {
    readonly stageOneMs: number
    readonly totalMs: number
  }
}
