import { type Attribute, type Category, type Entity, type PatchEntityInput, type Scope, type StateStatus, type WriteEntityInput } from '../../domain/entity.js'
import { attributeValue, scopeOf } from '../../domain/entity-access.js'
import type { RawAttributeValue } from '../../domain/dynamic-spec.js'
import { OmbFailure } from '../../domain/errors.js'
import type { RevisionConflictField } from '../../domain/conflict.js'
import { jsonEqual, type JsonValue } from '../../domain/json.js'

/**
 * `PatchEntity` 命令的纯合并逻辑：把当前实体 + 补丁合成一次完整写入输入。
 *
 * 与 `app/update.ts` 的私有合并规则一致（7b 迁移时 `UpdateService` 会改调本模块，
 * 现在两条路径必须产出同一份属性集合，否则命令路径与工具路径会写出不同结果）。
 */

function optionalRaw(attributes: readonly Attribute[]): Record<string, RawAttributeValue> {
  const attrs: Record<string, RawAttributeValue> = {}
  for (const attribute of attributes) {
    if (attribute.required) continue
    attrs[attribute.name] = attribute.value.kind === 'static'
      ? attribute.value.value
      : { $dynamic: attribute.value.spec }
  }
  return attrs
}

function stringValue(entity: Entity, name: string): string {
  const value = attributeValue(entity, name)
  if (typeof value !== 'string') throw new OmbFailure({ code: 'invalid-input', message: `实体缺少字符串属性 ${name}` })
  return value
}

function categoryValue(entity: Entity): Category {
  const value = attributeValue(entity, 'category')
  if (value !== 'fact' && value !== 'clue' && value !== 'event') {
    throw new OmbFailure({ code: 'invalid-input', message: '实体缺少合法分类' })
  }
  return value
}

function statusValue(entity: Entity): StateStatus {
  const value = attributeValue(entity, 'status')
  if (value !== 'completed' && value !== 'in_progress' && value !== 'waiting' && value !== 'blocked' && value !== 'not_started' && value !== 'discarded') {
    throw new OmbFailure({ code: 'invalid-input', message: '实体缺少合法状态' })
  }
  return value
}

function groupValue(entity: Entity): string[] {
  const value = attributeValue(entity, 'group')
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new OmbFailure({ code: 'invalid-input', message: '思维链缺少成员组' })
  }
  return value as string[]
}

/** 可选属性按补丁合并：`null` 删除，其余覆盖。 */
export function mergePatchAttributes(attributes: readonly Attribute[], patch: PatchEntityInput): Record<string, RawAttributeValue> {
  const merged = optionalRaw(attributes)
  for (const [name, value] of Object.entries(patch.attrs ?? {})) {
    if (value === null) delete merged[name]
    else merged[name] = value
  }
  return merged
}

export function preparePatchWrite(entity: Entity, patch: PatchEntityInput): WriteEntityInput {
  const scope: Scope = scopeOf(entity)
  const attrs = mergePatchAttributes(entity.attributes, patch)
  const base = {
    id: entity.id,
    scope,
    attrs,
    origin: patch.origin ?? entity.origin,
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : { pinned: entity.pinned }),
    ...(patch.confidence !== undefined
      ? { confidence: patch.confidence }
      : entity.confidence !== undefined
        ? { confidence: entity.confidence }
        : {}),
  }
  if (entity.kind === 'memory') {
    return { ...base, kind: 'memory', category: patch.category ?? categoryValue(entity) }
  }
  if (entity.kind === 'state') {
    return {
      ...base,
      kind: 'state',
      title: patch.title ?? stringValue(entity, 'title'),
      status: patch.status ?? statusValue(entity),
      time: patch.time ?? stringValue(entity, 'time'),
    }
  }
  if (entity.kind === 'chain') {
    return {
      ...base,
      kind: 'chain',
      title: patch.title ?? stringValue(entity, 'title'),
      group: patch.group ?? groupValue(entity),
    }
  }
  throw new OmbFailure({ code: 'invalid-input', message: '历史版本不能直接更新' })
}

/**
 * 冲突差异的纯计算：本次补丁**想写**的字段 vs 数据库**当前**值，只保留真正不同的字段。
 *
 * 补丁是「字段级意图」，所以不需要调用方提供旧快照：CAS 失败时当前值就是权威值；
 * 把 incoming/current 成对返回，人/AI 能直接判断要重读覆盖还是放弃。
 */
export function patchConflictFields(entity: Entity, patch: PatchEntityInput): RevisionConflictField[] {
  const fields: RevisionConflictField[] = []
  const consider = (field: string, incoming: JsonValue | undefined): void => {
    if (incoming === undefined) return
    const current = attributeValue(entity, field)
    if (jsonEqual(incoming, current)) return
    fields.push({ field, incoming, current: current ?? null })
  }
  // 只比较该 kind 真正会写的必填字段：避免把“补丁里给了但合并逻辑忽略”的字段报成冲突。
  if (entity.kind === 'memory') consider('category', patch.category)
  if (entity.kind === 'state') {
    consider('title', patch.title)
    consider('status', patch.status)
    consider('time', patch.time)
  }
  if (entity.kind === 'chain') {
    consider('title', patch.title)
    consider('group', patch.group as JsonValue | undefined)
  }
  // pinned/confidence 是实体行字段，不是属性行：不能拿 attributeValue 比较。
  if (patch.pinned !== undefined && patch.pinned !== entity.pinned) {
    fields.push({ field: 'pinned', incoming: patch.pinned, current: entity.pinned })
  }
  if (patch.confidence !== undefined) {
    const current = entity.confidence ?? null
    if (!jsonEqual(patch.confidence, current)) {
      fields.push({ field: 'confidence', incoming: patch.confidence, current })
    }
  }
  for (const [name, value] of Object.entries(patch.attrs ?? {})) {
    // null 是「删除该可选属性」：当前本来就没有就不算冲突。
    consider(name, value === null ? undefined : value as JsonValue)
    if (value === null) {
      const current = attributeValue(entity, name)
      if (current !== undefined) fields.push({ field: name, incoming: null, current })
    }
  }
  return fields
}
