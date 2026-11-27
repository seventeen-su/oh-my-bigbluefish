import type { Category, EntityKind, Scope, StateStatus } from '../domain/entity.js'
import type { JsonValue } from '../domain/json.js'

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
  readonly limit: number
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
  /** 实体事件时间（ISO 8601）；只有带 time 属性的实体（状态机等）才有，缺省表示未知。 */
  readonly eventTime?: string
  readonly updatedAt: string
  readonly historyCount: number
  readonly score?: number
}
