import type { OmbErrorCode } from '../domain/errors.js'
import type { JsonValue } from '../domain/json.js'

/**
 * 观测/审计端口的记录形状：召回事件、T0 常驻 trace、采用证据、审计与回滚、
 * artifact、状态统计。
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

/**
 * 通道级失败/deadline 审计行（RET-08）：一次召回里某个通道为什么没结果。
 *
 * 与 `RecallEventInput` 分开：失败时没有命中实体（recall_event.entity_id 非空且外键），
 * 但“哪个通道失败、什么错误、是否可重试”必须能事后查询。
 */
export interface RecallChannelErrorInput {
  readonly traceId: string
  readonly sessionId?: string
  readonly query?: string
  readonly channel: string
  readonly code: OmbErrorCode
  readonly message: string
  readonly retryable: boolean
}

/**
 * 采用证据的四个非暴露层级（Exposure 只由 `UsageExposureInput` 记录）：
 * - reference：模型/用户明确引用，弱证据；
 * - utilization：实体 ID 实际进入工具参数/命令/代码修改，按 session+task 可追溯；
 * - validation：用户确认、验证工具通过、任务完成等外部正向证据；
 * - refutation：用户否定/证伪，负向证据。
 */
export type UsageEvidenceLevel = 'reference' | 'utilization' | 'validation' | 'refutation'

/** 一次真实注入的来源：T0 常驻、T1 事件召回、T2 工具检索。 */
export type AdoptionReceiptKind = 't0' | 't1' | 't2'

/**
 * 一个命中在本次注入里的处置：
 * - kept：原文真正进入注入文本（计入 Retrieved，可参与后续采用）；
 * - quarantined：高风险，只注入了隔离说明（原文未进入，不能升采用）；
 * - dropped：预算/去重/空内容导致未展示（不能升采用）。
 */
export type AdoptionReceiptDisposition = 'kept' | 'quarantined' | 'dropped'

/** receipt 里可选的展示元数据；标题用于后续弱引用匹配，不参与门控。 */
export interface AdoptionReceiptHitInput {
  readonly entityId: string
  readonly title?: string
  readonly updatedAt?: string
  readonly rank?: number
}

/**
 * 一次注入的 receipt（采用证据的唯一来源）。
 *
 * 调用方必须在文本真正投递后写入：`keptIds` 来自装配器的 kept 集合，
 * `quarantinedIds` 是 kept 但原文被隔离的那部分，`droppedIds` 是未展示的候选。
 * 伪造 recall_event 不会创建 receipt，因此不会增加任何采用指标。
 */
export interface AdoptionReceiptInput {
  readonly traceId: string
  readonly kind: AdoptionReceiptKind
  readonly sessionId?: string
  readonly turnId?: string
  readonly taskId?: string
  readonly scenario?: string
  readonly source?: string
  readonly receiptId?: string
  readonly budgetTokens?: number
  readonly usedTokens?: number
  readonly injected: boolean
  readonly textHash?: string
  readonly text?: string
  readonly keptIds: readonly string[]
  readonly quarantinedIds?: readonly string[]
  readonly droppedIds?: readonly string[]
  /** 可带标题/更新时间的命中；未列在三个 id 集合里的命中按 kept 处理。 */
  readonly hits?: readonly AdoptionReceiptHitInput[]
}

/** 落库后的逐实体处置；只有 disposition='kept' 的命中会登记 Exposure。 */
export interface AdoptionReceiptHit {
  readonly entityId: string
  readonly disposition: AdoptionReceiptDisposition
  readonly title?: string
  readonly updatedAt?: string
  readonly rank?: number
}

/**
 * 一次独立使用机会的曝光。`(entityId, sessionId, taskId)` 是机会主键：
 * 同一次任务里的重复召回只增加 exposures，不重复累计成功次数。
 */
export interface UsageExposureInput {
  readonly entityId: string
  readonly sessionId: string
  readonly taskId: string
  readonly traceId?: string
}

/**
 * 一次引用/使用/验证/证伪证据。
 *
 * `taskId` 缺省时落到该 session 上该实体最近一个使用机会；`traceId` 只用于写
 * recall_event 的事件级审计列，不参与机会聚合。
 */
export interface UsageEvidenceInput {
  readonly entityId: string
  readonly sessionId: string
  readonly taskId?: string
  readonly traceId?: string
  readonly kind: string
  readonly source: string
  readonly evidence?: JsonValue
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
  /** 执行者类别（user/model/job/system/external）；业务事件由 CommandMeta 自动填。 */
  readonly actorKind?: string
  /** 来源/授权方（user/model/job:extract/system:refresh）；与实体 origin 分开。 */
  readonly source?: string
  /** 条件更新两侧版本：冲突/跳过审计用它证明“为什么没写”。 */
  readonly expectedRevision?: number
  readonly currentRevision?: number
}

export interface AuditRecord {
  readonly id: number
  readonly actor: string
  readonly action: string
  readonly targetIds: readonly string[]
  readonly inverse?: JsonValue
  readonly createdAt: string
  readonly rolledBackAt?: string
  readonly actorKind?: string
  readonly source?: string
  readonly expectedRevision?: number
  readonly currentRevision?: number
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
