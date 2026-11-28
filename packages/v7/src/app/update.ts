import type { Entity, EntityKind, PatchEntityInput } from '../domain/entity.js'
import { isArchived } from '../domain/entity-access.js'
import { validationError } from '../domain/validation-result.js'
import { OmbFailure, err, invalid, notFound, ok, type Result } from '../domain/errors.js'
import { deriveReferences, deriveSearchText, deriveTriggers, normalizeWrite } from '../domain/validation.js'
import type { Clock } from '../ports/clock.js'
import type { Embedder } from '../ports/embedding.js'
import type { JobQueue, Logger } from '../ports/jobs.js'
import type { Store, WriteOptions } from '../ports/store.js'
import type { PatchResult } from '../ports/store.js'
import { preparePatchWrite } from './commands/patch.js'
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

/** 更新的幂等/证据与执行者参数；`commandId` 让工具重试不重复 bump revision。 */
export type UpdateOptions = WriteOptions

export class UpdateService {
  constructor(private readonly deps: UpdateServiceDeps) {}

  /**
   * 更新实体。`patch.expectedRevision` 必填：调用方必须先在读路径（recall/history）
   * 拿到版本再提交；缺失时直接拒绝，不提供“默认覆盖最新版本”的兼容路径。
   *
   * `options` 既是幂等/证据参数，也携带 actor/source（默认 model），写进审计与冲突差异；
   * 它与补丁字段分开，避免把身份信息混进属性校验。
   */
  async update(patch: PatchEntityInput, options: UpdateOptions = {}): Promise<Result<UpdateOutput>> {
    try {
      if (patch.expectedRevision === undefined) {
        return err(invalid(
          '更新必须携带 expectedRevision（先从 recall/history 读取当前版本再提交，避免覆盖并发修改）',
          { field: 'expectedRevision' },
        ))
      }
      if (!Number.isInteger(patch.expectedRevision) || patch.expectedRevision < 1) {
        return err(invalid('expectedRevision 必须是正整数', { field: 'expectedRevision' }))
      }
      const entity = await this.deps.store.get(patch.id, { includeArchived: false })
      if (entity === undefined) return err(notFound(`实体不存在或已归档：${patch.id}`))
      if (isArchived(entity)) return err({ code: 'archived', message: `实体已归档：${patch.id}` })
      // 正文要在 patch 前取：patch 返回的实体是入参属性（动态缓存值已丢），不能当权威文本。
      const bodyBefore = embeddingBody(entity.kind, entity.attributes)
      const normalized = normalizeWrite(preparePatchWrite(entity, patch))
      if (!normalized.ok) return err(validationError(normalized.errors))
      const derived = {
        searchText: deriveSearchText(normalized.value.attributes),
        triggers: deriveTriggers(normalized.value.attributes),
        references: deriveReferences(normalized.value.attributes),
      }
      const result = await this.deps.store.patch(normalized.value, patch, derived, options)
      // 重复命令返回首次结果：没有发生新写入，不能重建向量/改判失败。
      if (result.deduped !== undefined) return ok(result)
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
