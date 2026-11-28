import type { JsonValue } from '../../domain/json.js'
import { canonicalJson } from '../../domain/json.js'
import {
  OmbFailure,
  conflict,
  internal,
} from '../../domain/errors.js'
import {
  versionConflict,
  type RevisionConflictDetails,
  type RevisionConflictField,
} from '../../domain/conflict.js'
import type { CommandOutcome, DomainEvent, ProjectionToken } from '../../app/commands/index.js'

/**
 * 写命令的共享支撑：时间、PG 错误映射、规范 JSON、命令结果 shaping、版本冲突。
 * 不碰表、不碰事务，供 writer / writer-links / writer-rollback / writer-tables 共用。
 */

/**
 * 动态 spec 的规范 JSON（实现已下沉到 domain）：`jsonb` 会按 key 长度重排对象键，
 * 不能用 `JSON.stringify` 的插入顺序比较，否则同 spec 永远被当成变化、patch 丢缓存。
 * 这里保留再导出给表级原语/审计使用。
 */
export { canonicalJson }

export function nowIso(): string {
  return new Date().toISOString()
}

export function mapPgError(error: unknown): OmbFailure {
  if (error instanceof OmbFailure) return error
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = typeof record['code'] === 'string' ? record['code'] : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (code === '23505') return new OmbFailure(conflict(message))
  if (code === '23503') return new OmbFailure(conflict(message))
  if (code === '57014') return new OmbFailure({ code: 'db-unavailable', message: `数据库语句超时：${message}`, retryable: true })
  if (code === 'ECONNREFUSED' || code === '57P01' || code === '08006') {
    return new OmbFailure({ code: 'db-unavailable', message: `数据库不可用：${message}`, retryable: true })
  }
  return new OmbFailure(internal(message))
}

export function toJson(value: unknown): JsonValue {
  return value as JsonValue
}

export function projectionToken(entityId: string, revision: number, event: DomainEvent | undefined): ProjectionToken {
  return { entityId, revision, watermark: event?.id ?? '' }
}

export function noopOutcome(entityId: string): CommandOutcome {
  return { events: [], revision: 0, projectionToken: { entityId, revision: 0, watermark: '' } }
}

export function payloadEntityId(payload: Record<string, JsonValue>, fallback: string): string {
  const value = payload['entityId']
  return typeof value === 'string' ? value : fallback
}

/** 冲突差异的载荷上限：错误体会进模型上下文与审计，必须有界。 */
const MAX_CONFLICT_FIELDS = 20
const MAX_CONFLICT_VALUE_CHARS = 512

export interface RevisionConflictContext {
  readonly entityId: string
  readonly actor: { readonly id: string; readonly kind: string }
  readonly source: string
  readonly currentStatus?: string
  readonly currentTitle?: string
  readonly currentTime?: string
  readonly currentCategory?: string
  readonly conflictingFields?: readonly RevisionConflictField[]
}

function boundedConflictValue(value: JsonValue | null): JsonValue | null {
  if (value === null) return null
  const text = JSON.stringify(value) ?? 'null'
  return text.length <= MAX_CONFLICT_VALUE_CHARS ? value : `${text.slice(0, MAX_CONFLICT_VALUE_CHARS)}…`
}

/**
 * 冲突是领域结果：带上当前 revision、关键属性、冲突字段与执行者/来源。
 *
 * `expectedRevision` 由调用方先校验存在（缺失即 invalid-input，不再默认无条件覆盖），
 * 所以这里始终拿到两侧版本，调用方重读后可以用同一份 diff 决定重试或放弃。
 */
export function revisionConflict(
  expectedRevision: number,
  currentRevision: number,
  context: RevisionConflictContext,
): OmbFailure {
  const fields = context.conflictingFields ?? []
  const details: RevisionConflictDetails = {
    entityId: context.entityId,
    expectedRevision,
    currentRevision,
    ...(context.currentStatus === undefined ? {} : { currentStatus: context.currentStatus }),
    ...(context.currentTitle === undefined ? {} : { currentTitle: context.currentTitle }),
    ...(context.currentTime === undefined ? {} : { currentTime: context.currentTime }),
    ...(context.currentCategory === undefined ? {} : { currentCategory: context.currentCategory }),
    conflictingFields: fields.slice(0, MAX_CONFLICT_FIELDS).map(field => ({
      field: field.field,
      incoming: boundedConflictValue(field.incoming),
      current: boundedConflictValue(field.current),
    })),
    conflictingFieldCount: fields.length,
    actor: { id: context.actor.id, kind: context.actor.kind },
    source: context.source,
  }
  return new OmbFailure(versionConflict(details))
}
