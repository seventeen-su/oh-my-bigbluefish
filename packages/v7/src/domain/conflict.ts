import type { JsonValue } from './json.js'
import type { OmbError } from './errors.js'

/**
 * 乐观锁冲突的完整差异（领域结果，不是适配器细节）。
 *
 * 冲突字段是「本次补丁想写的值 vs 数据库当前值」；只包含两者真的不同的字段。当前
 * status/title/time/category 是状态机的关键属性，用来让人/AI 直接看到版本漂移。
 *
 * 单独成文件：`errors.ts` 只放错误码/Result 边界与通用构造，冲突这件“带业务差异的
 * 领域结果”有自己的类型面。
 */
export interface RevisionConflictField {
  readonly field: string
  readonly incoming: JsonValue | null
  readonly current: JsonValue | null
}

export interface RevisionConflictActor {
  readonly id: string
  readonly kind: string
}

export interface RevisionConflictDetails {
  readonly entityId: string
  readonly expectedRevision: number
  readonly currentRevision: number
  readonly currentStatus?: string
  readonly currentTitle?: string
  readonly currentTime?: string
  readonly currentCategory?: string
  /** 最多前 N 个冲突字段；`conflictingFieldCount` 给出总数。 */
  readonly conflictingFields: readonly RevisionConflictField[]
  readonly conflictingFieldCount: number
  readonly actor: RevisionConflictActor
  readonly source: string
}

/** 构造带完整差异的冲突错误；message 同时给出期望/当前版本与冲突字段名。 */
export function versionConflict(details: RevisionConflictDetails): OmbError {
  const parts = [`实体版本已变化（期望 ${details.expectedRevision}，当前 ${details.currentRevision}）`]
  if (details.currentStatus !== undefined) parts.push(`当前状态 ${details.currentStatus}`)
  if (details.conflictingFields.length > 0) {
    parts.push(`冲突字段 ${details.conflictingFields.map(field => field.field).join('、')}`)
  }
  return { code: 'conflict', message: parts.join('；'), details }
}
