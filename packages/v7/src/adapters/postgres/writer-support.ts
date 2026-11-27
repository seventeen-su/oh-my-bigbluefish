import type { JsonValue } from '../../domain/json.js'
import { isPlainObject } from '../../domain/json.js'
import { OmbFailure, conflict, internal } from '../../domain/errors.js'
import type { CommandOutcome, DomainEvent, ProjectionToken } from '../../app/commands/index.js'

/**
 * 写命令的共享支撑：时间、PG 错误映射、规范 JSON、命令结果 shaping、版本冲突。
 * 不碰表、不碰事务，供 writer / writer-links / writer-rollback / writer-tables 共用。
 */

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

/**
 * 动态 spec 的规范 JSON。`jsonb` 会按 key 长度重排对象键，
 * 不能用 `JSON.stringify` 的插入顺序比较（否则同 spec 永远被当成变化，patch 丢缓存）。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
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

/** 冲突是领域结果：带上 currentRevision，命令总线据此让调用方重读重试。 */
export function revisionConflict(expected: number | undefined, currentRevision: number): OmbFailure {
  const detail = expected === undefined ? `当前 ${currentRevision}` : `期望 ${expected}，实际 ${currentRevision}`
  return new OmbFailure({
    code: 'conflict',
    message: `实体版本已变化（${detail}）`,
    details: { currentRevision, ...(expected === undefined ? {} : { expectedRevision: expected }) },
  })
}
