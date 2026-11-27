import { attributeValue, scopeOf, type Attribute, type Category, type Entity, type PatchEntityInput, type RawAttributeValue, type Scope, type StateStatus, type WriteEntityInput } from '../../domain/entity.js'
import { OmbFailure } from '../../domain/errors.js'

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
