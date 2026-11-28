import type { Category, EntityKind, Scope, StateStatus } from '../domain/entity.js'
import type { JsonValue } from '../domain/json.js'
import type { EntityLifecycle } from '../domain/lifecycle.js'

/**
 * 检索通道的端口契约：六个通道（fulltext/triggers/singleChar/vector/time/stateBoard）
 * 共用同一组过滤条件与命中形状。
 *
 * 与 `store.ts` 的写路径分开：检索只读、形状稳定，Store 实现按通道提供查询；
 * `EntitySummary` 是通道返回实体摘要再到重排/注入的公共形状。
 */

export interface SearchBase {
  readonly scope?: 'global' | 'project'
  readonly projectKey?: string
  readonly kind?: EntityKind
  readonly category?: Category
  readonly status?: readonly StateStatus[]
  readonly includeArchived?: boolean
  readonly includeHistory?: boolean
  /**
   * 历史检索开关：默认只返回 `lifecycle='active'`；显式打开后才允许 superseded/retracted。
   * 归档仍由 `includeArchived` 单独控制，两者不互相隐含。
   */
  readonly includeSuperseded?: boolean
  readonly limit: number
  /**
   * 本次查询的剩余执行预算（ms）。适配器必须**尽力**把它变成服务端取消
   * （PostgreSQL 用事务级 `statement_timeout`），而不是只放弃等待；缺省用连接默认值。
   */
  readonly timeoutMs?: number
}

export interface TextSearchSpec extends SearchBase {
  readonly query: string
  readonly tokens: readonly string[]
}

export interface TriggerSearchSpec extends SearchBase {
  readonly keys: readonly string[]
  readonly regexText?: string
}

export interface VectorSearchSpec extends SearchBase {
  readonly embedding: readonly number[]
}

export interface TimeSearchSpec extends SearchBase {
  readonly from: string
  readonly to: string
  readonly now: string
}

export interface StateBoardSpec extends SearchBase {
  readonly now: string
}

export interface ChannelHit {
  readonly entityId: string
  readonly rank: number
  readonly rawScore: number
  readonly channel: string
  readonly meta?: Record<string, JsonValue>
}

export interface EntitySummary {
  readonly id: string
  readonly kind: EntityKind
  readonly title?: string
  readonly category?: Category
  readonly status?: StateStatus
  readonly scope: Scope
  readonly snippet: string
  readonly archived: boolean
  readonly isCurrent: boolean
  /** 内容真值状态；`active` 之外的条目只能在历史检索里出现，必须带生命周期标记。 */
  readonly lifecycle: EntityLifecycle
  /** 被取代的时间与取代者（历史条目标记用）。 */
  readonly supersededAt?: string
  readonly supersededBy?: string
  /** 被证伪时间（历史条目标记用）。 */
  readonly retractedAt?: string
  /** 有效期窗口；`validTo` 缺省表示仍在生效。 */
  readonly validFrom?: string
  readonly validTo?: string
  /** 实体事件时间（ISO 8601）；只有带 time 属性的实体（状态机等）才有，缺省表示未知。 */
  readonly eventTime?: string
  readonly updatedAt: string
  readonly historyCount: number
  readonly score?: number
}

/**
 * 重排精排阶段的实体级先验特征：一次批量读取拿回，不在候选循环里逐条读实体。
 *
 * 字段缺省一律按**中性**处理（对应乘数为 1）：这样「没有富化数据」不会变成惩罚，
 * 也不会变成奖励，截断位置本身不参与打分。
 */
export interface EntityPriorFeatures {
  readonly entityId: string
  readonly confidence?: number
  readonly pinned?: boolean
  readonly origin?: string
  readonly accessCount?: number
  /** 旧口径，仅兼容读；重排改用 utilityConfidence。 */
  readonly adoptionCount?: number
  /** 机会级、平滑后的使用效用；Exposure/access 不计入。 */
  readonly utilityConfidence?: number
  /** 被用户否定/证伪的比例（0–1）。 */
  readonly refutationRate?: number
  /** 标签属性（`标签`/`tags`/`tag`）拍平后的字符串数组。 */
  readonly tags?: readonly string[]
}
