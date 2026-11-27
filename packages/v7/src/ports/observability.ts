import type { JsonValue } from '../domain/json.js'

/**
 * 观测/审计端口的记录形状：召回事件、T0 常驻 trace、审计与回滚、artifact、状态统计。
 *
 * 这些类型只描述「写进观测表的一行」，与写路径（store.ts）和检索通道（search.ts）分开；
 * 单独成文件是为了让端口契约按职责可读，而不是一个 26 导出的宽接口文件。
 */

export interface RecallEventInput {
  readonly traceId: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly query?: string
  readonly trigger?: string
  readonly entityId: string
  readonly channel: string
  readonly rank: number
  readonly rawScore?: number
  readonly fusedScore?: number
  readonly injected: boolean
}

/** T0 常驻注入的一段候选；kept=false 表示因预算被裁掉。 */
export interface ResidentTraceSection {
  readonly name: string
  readonly tokens: number
  readonly kept: boolean
  readonly text: string
  readonly entityIds: readonly string[]
}

/** 一次 T0 常驻构建的完整 trace；用于证明注入预算与裁剪真实发生。 */
export interface ResidentTraceInput {
  readonly traceId: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly budgetTokens: number
  readonly usedTokens: number
  readonly text: string
  readonly sections: readonly ResidentTraceSection[]
  readonly droppedSections: readonly string[]
}

export interface AuditEntry {
  readonly actor: string
  readonly action: string
  readonly targetIds?: readonly string[]
  readonly before?: JsonValue
  readonly after?: JsonValue
  readonly inverse?: JsonValue
  readonly jobId?: string
}

export interface AuditRecord {
  readonly id: number
  readonly actor: string
  readonly action: string
  readonly targetIds: readonly string[]
  readonly inverse?: JsonValue
  readonly createdAt: string
  readonly rolledBackAt?: string
}

export interface RollbackResult {
  readonly auditId: number
  readonly rollbackAuditId: number
  readonly applied: readonly string[]
}

export interface ArtifactInput {
  readonly id: string
  readonly sessionId?: string
  readonly kind: string
  readonly content: string
  readonly source?: string
  readonly metadata?: JsonValue
}

export interface ArtifactRecord {
  readonly id: string
  readonly sessionId?: string
  readonly kind: string
  readonly content: string
  readonly source: string
  readonly metadata: JsonValue
  readonly createdAt: string
}

export interface StoreStats {
  readonly memory: number
  readonly state: number
  readonly chain: number
  readonly archived: number
  readonly attrNames: readonly string[]
  readonly categories?: Readonly<Record<'fact' | 'clue' | 'event', number>>
  readonly scopes?: Readonly<{ global: number; project: number }>
  readonly recentStates?: readonly { id: string; title?: string; status: string }[]
}
