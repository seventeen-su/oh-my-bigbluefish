import type { Attribute, Category, Entity, EntityKind, PatchEntityInput, Scope, StateStatus, WriteEntityInput } from '../domain/entity.js'
import type { RawAttributeValue } from '../domain/dynamic-spec.js'
import { attributeValue, isArchived, scopeOf } from '../domain/entity-access.js'
import { validationError } from '../domain/validation-result.js'
import { OmbFailure, err, notFound, ok, type Result } from '../domain/errors.js'
import { deriveReferences, deriveSearchText, deriveTriggers, normalizeWrite } from '../domain/validation.js'
import type { Clock } from '../ports/clock.js'
import type { Embedder } from '../ports/embedding.js'
import type { JobQueue, Logger } from '../ports/jobs.js'
import type { Store } from '../ports/store.js'
import type { PatchResult } from '../ports/store.js'
import { embeddingBody, embeddingText, populateEmbedding, type EmbeddingStatus } from './embedding.js'

export interface UpdateOutput extends PatchResult {
  /**
   * 本次更新触发的嵌入刷新结果。`undefined` 表示正文没有变化（或刷新被降级跳过），
   * 没有触碰向量；`queued` 表示已删除旧向量行并入队 `omb.embed` 重建。
   */
  readonly embedding?: EmbeddingStatus
}

export interface UpdateServiceDeps {
  readonly store: Store
  readonly embedder?: Embedder
  readonly jobs?: JobQueue
  readonly clock?: Clock
  readonly logger?: Logger
  /**
   * 队列重建前失效旧向量。schema 没有 stale 列（`omb.embedding` 只有 model/dims/embedding），
   * 装配层注入「删除旧行」；不提供时只入队，旧行由重建任务原地覆盖。
   */
  readonly invalidateEmbedding?: (entityId: string) => Promise<void>
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

  async update(patch: PatchEntityInput): Promise<Result<UpdateOutput>> {
    try {
      const entity = await this.deps.store.get(patch.id, { includeArchived: false })
      if (entity === undefined) return err(notFound(`实体不存在或已归档：${patch.id}`))
      if (isArchived(entity)) return err({ code: 'archived', message: `实体已归档：${patch.id}` })
      // 正文要在 patch 前取：patch 返回的实体是入参属性（动态缓存值已丢），不能当权威文本。
      const bodyBefore = embeddingBody(entity.kind, entity.attributes)
      const input = writeInputFor(entity, patch)
      const normalized = normalizeWrite(input)
      if (!normalized.ok) return err(validationError(normalized.errors))
      const derived = {
        searchText: deriveSearchText(normalized.value.attributes),
        triggers: deriveTriggers(normalized.value.attributes),
        references: deriveReferences(normalized.value.attributes),
      }
      const result = await this.deps.store.patch(normalized.value, patch, derived)
      // 只有写入成功之后才可能失效/入队：失败路径不能留下 stale 标记或队列任务。
      const embedding = await this.refreshEmbedding(entity.kind, normalized.value.id, bodyBefore)
      return ok(embedding === undefined ? result : { ...result, embedding })
    } catch (error) {
      if (error instanceof OmbFailure) return err(error.error)
      return err({ code: 'internal', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * 正文变化才重建向量。旧向量是否失效、是否入队由 `populateEmbedding` 决定；
   * 刷新阶段任何失败都只降级（日志 + 跳过），不能把已经落库的更新改判成失败。
   */
  private async refreshEmbedding(kind: EntityKind, entityId: string, bodyBefore: string): Promise<EmbeddingStatus | undefined> {
    if (this.deps.embedder === undefined) return undefined
    let fresh: Entity | undefined
    try {
      // patch 后从属性行读回权威文本（动态缓存值由 store 保留，派生文本必须与视图同源）。
      fresh = await this.deps.store.get(entityId, { includeArchived: true })
    } catch (error) {
      this.deps.logger?.warn('更新后读取权威属性失败，跳过嵌入刷新', {
        at: this.deps.clock?.iso(),
        entityId,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
    if (fresh === undefined) return undefined
    if (embeddingBody(kind, fresh.attributes) === bodyBefore) return undefined
    return populateEmbedding(this.deps, entityId, embeddingText(fresh.attributes), {
      invalidate: this.deps.invalidateEmbedding,
    })
  }
}
