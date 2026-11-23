import type { Attribute, Category, Entity, PatchEntityInput, RawAttributeValue, Scope, StateStatus, WriteEntityInput } from '../domain/entity.js'
import { attributeValue, isArchived, scopeOf, validationError } from '../domain/entity.js'
import { OmbFailure, err, notFound, ok, type Result } from '../domain/errors.js'
import { deriveReferences, deriveSearchText, deriveTriggers, normalizeWrite } from '../domain/validation.js'
import type { Store } from '../ports/store.js'
import type { PatchResult } from '../ports/store.js'

export interface UpdateServiceDeps {
  readonly store: Store
}

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

function mergeOptional(attributes: readonly Attribute[], patch: PatchEntityInput): Record<string, RawAttributeValue> {
  const merged = optionalRaw(attributes)
  for (const [name, value] of Object.entries(patch.attrs ?? {})) {
    if (value === null) delete merged[name]
    else merged[name] = value
  }
  return merged
}

function writeInputFor(entity: Entity, patch: PatchEntityInput): WriteEntityInput {
  const scope: Scope = scopeOf(entity)
  const attrs = mergeOptional(entity.attributes, patch)
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

export class UpdateService {
  constructor(private readonly deps: UpdateServiceDeps) {}

  async update(patch: PatchEntityInput): Promise<Result<PatchResult>> {
    try {
      const entity = await this.deps.store.get(patch.id, { includeArchived: false })
      if (entity === undefined) return err(notFound(`实体不存在或已归档：${patch.id}`))
      if (isArchived(entity)) return err({ code: 'archived', message: `实体已归档：${patch.id}` })
      const input = writeInputFor(entity, patch)
      const normalized = normalizeWrite(input)
      if (!normalized.ok) return err(validationError(normalized.errors))
      const derived = {
        searchText: deriveSearchText(normalized.value.attributes),
        triggers: deriveTriggers(normalized.value.attributes),
        references: deriveReferences(normalized.value.attributes),
      }
      const result = await this.deps.store.patch(normalized.value, patch, derived)
      return ok(result)
    } catch (error) {
      if (error instanceof OmbFailure) return err(error.error)
      return err({ code: 'internal', message: error instanceof Error ? error.message : String(error) })
    }
  }
}
