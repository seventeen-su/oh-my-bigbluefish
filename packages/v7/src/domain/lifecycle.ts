import type { WriteEntityInput } from './entity.js'

/**
 * 实体生命周期（取代/证伪/归档）的稳定词表与取代命令契约。
 *
 * 与 `archived_at` 的分工：`archived_at` 仍是**保留/可见性**时间戳（人工或系统归档），
 * `lifecycle` 是**内容真值状态**。两者可以并存：一个已被取代的实体之后被归档，
 * `lifecycle` 仍保留 `superseded`，不会被归档覆盖成 `archived`。
 *
 * 当前有效 = `lifecycle === 'active'` 且未归档；普通召回只看当前有效，
 * 历史查询（显式时间窗 / includeSuperseded / omb_history）才能读到旧事实，并且必须
 * 带上「已于某时被取代」的标记，不能把它伪装成当前有效。
 */

export const ENTITY_LIFECYCLES = ['active', 'superseded', 'retracted', 'archived'] as const
export type EntityLifecycle = (typeof ENTITY_LIFECYCLES)[number]

export const LIFECYCLE_LABELS: Record<EntityLifecycle, string> = {
  active: '当前有效',
  superseded: '已被取代',
  retracted: '已被证伪',
  archived: '已归档',
}

export function isEntityLifecycle(value: unknown): value is EntityLifecycle {
  return typeof value === 'string' && (ENTITY_LIFECYCLES as readonly string[]).includes(value)
}

/** 只有 `active` 参与默认召回/图扩展/重排加分；其余三种只能历史检索。 */
export function isCurrentLifecycle(value: EntityLifecycle): boolean {
  return value === 'active'
}

/**
 * `supersede` 的输入：把旧实体标记为已被新实体取代，并在同一事务里确认或创建新实体。
 *
 * - `newId` 是取代者；`create` 非空时在同一事务创建它（`create.id` 必须等于 `newId`），
 *   为空时要求它已经存在且当前有效。
 * - `effectiveAt` 是取代生效时间（ISO 8601，可回溯）；缺省用事务墙钟。
 * - `commandId` 给外部幂等键；重复提交同一键按“命令已执行”拒绝，不会二次写。
 */
export interface SupersedeInput {
  readonly oldId: string
  readonly newId: string
  readonly reason: string
  readonly actor: string
  readonly effectiveAt?: string
  readonly create?: WriteEntityInput
  readonly commandId?: string
  readonly expectedRevision?: number
}

export interface SupersedeResult {
  readonly oldId: string
  readonly newId: string
  readonly linkId: string
  readonly effectiveAt: string
  /** 本次事务是否真的创建了新实体（false 表示确认已有实体）。 */
  readonly created: boolean
  /** 旧实体已由同一个新实体取代：重复调用幂等返回，没有产生第二次写。 */
  readonly alreadyApplied: boolean
  /** supersede 事件的审计 id；`alreadyApplied` 时为 0。 */
  readonly auditId: number
  /** 旧实体在本次取代后的 revision。 */
  readonly revision: number
}

export interface RetractInput {
  readonly id: string
  readonly reason: string
  readonly actor: string
  /** 证伪生效时间（ISO 8601）；缺省用事务墙钟。 */
  readonly effectiveAt?: string
  readonly commandId?: string
  readonly expectedRevision?: number
}

export interface RetractResult {
  readonly id: string
  readonly effectiveAt: string
  readonly alreadyApplied: boolean
  readonly auditId: number
  readonly revision: number
}
