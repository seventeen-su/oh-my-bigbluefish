import type { Attribute, Entity, Scope, StateStatus } from './entity.js'
import type { JsonValue } from './json.js'
import { isStateStatus } from './entity.js'

/**
 * 实体/属性的只读访问器与 scope 规范化。
 *
 * 这些函数只读 `Entity.attributes`，不依赖存储；放在单独文件是为了让「实体聚合形状」
 * （entity.ts）与「从属性读值」的便利函数各自有明确边界，调用方按需引入。
 */

export function scopeKey(scope: Scope): string {
  return scope.kind === 'global' ? '' : scope.projectKey
}

export function getAttribute(entity: Entity, name: string): Attribute | undefined {
  return entity.attributes.find(attribute => attribute.name === name)
}

/** 读取属性当前值：静态直接返回；动态返回缓存值（没有缓存则 undefined）。 */
export function attributeValue(entity: Entity, name: string): JsonValue | undefined {
  const attribute = getAttribute(entity, name)
  if (attribute === undefined) return undefined
  return attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
}

export function statusOf(entity: Entity): StateStatus | undefined {
  const value = attributeValue(entity, 'status')
  return typeof value === 'string' && isStateStatus(value) ? value : undefined
}

export function titleOf(entity: Entity): string | undefined {
  const value = attributeValue(entity, 'title')
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function scopeOf(entity: Entity): Scope {
  const value = attributeValue(entity, 'scope')
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>
    if (record['kind'] === 'project' && typeof record['projectKey'] === 'string') {
      return { kind: 'project', projectKey: record['projectKey'] }
    }
  }
  return { kind: 'global' }
}

export function isArchived(entity: Entity): boolean {
  return entity.archivedAt !== undefined
}
