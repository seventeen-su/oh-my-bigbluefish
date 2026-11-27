import type { Attribute, EntityKind } from '../domain/entity.js'
import { deriveSearchText } from '../domain/validation.js'
import type { Embedder } from '../ports/embedding.js'
import type { JobQueue, Logger } from '../ports/jobs.js'
import type { Store } from '../ports/store.js'

/** 一次嵌入刷新/重建的结果；`unavailable` 表示嵌入器不可用或文本为空，不是失败。 */
export type EmbeddingStatus = 'done' | 'queued' | 'unavailable' | 'failed'

export interface EmbeddingDeps {
  readonly store: Store
  readonly embedder?: Embedder
  readonly jobs?: JobQueue
  readonly logger?: Logger
}

/** 真正送去嵌入的文本：与 `remember` 写入时一致，是完整 searchText。 */
export function embeddingText(attributes: readonly Attribute[]): string {
  return deriveSearchText(attributes)
}

/**
 * 正文文本：状态机的 `status`/`time` 是流程元数据（状态流转、事件时间），
 * 不参与「正文是否变化」判定，否则后台 `omb.refresh` 推进状态就会无谓重建向量。
 * memory/chain 没有这类流程元数据，所有属性都算正文。
 */
export function embeddingBody(kind: EntityKind, attributes: readonly Attribute[]): string {
  if (kind !== 'state') return deriveSearchText(attributes)
  return deriveSearchText(attributes.filter(attribute => attribute.name !== 'status' && attribute.name !== 'time'))
}

/**
 * remember 与 update 共用的嵌入写入路径：队列可用时入队 `omb.embed`（singletonKey 按实体去重），
 * 队列不可用或入队失败时降级同步嵌入；失败只记录，后续由 `omb.embed-sweep` 补齐。
 *
 * `invalidate` 只在队列路径调用：schema 没有 stale 列，装配层用「删除旧向量行」表达失效，
 * 保证重建完成前 vector 通道拿不到旧文本的向量。同步路径原地覆盖，不需要失效窗口。
 */
export async function populateEmbedding(
  deps: EmbeddingDeps,
  entityId: string,
  text: string,
  options: { readonly invalidate?: (entityId: string) => Promise<void> } = {},
): Promise<EmbeddingStatus> {
  if (deps.embedder === undefined || text.trim().length === 0) return 'unavailable'
  const available = await deps.embedder.available().catch(() => false)
  if (!available) return 'unavailable'
  if (deps.jobs !== undefined) {
    try {
      if (options.invalidate !== undefined) {
        try {
          await options.invalidate(entityId)
        } catch (error) {
          // 失效失败不阻断重建：任务会用最新正文覆盖旧行，最坏是旧向量多存活到消费完成。
          deps.logger?.warn('旧向量失效失败，继续入队重建', error)
        }
      }
      await deps.jobs.enqueue('omb.embed', { entityId, text }, { singletonKey: `embed:${entityId}`, retryLimit: 3 })
      return 'queued'
    } catch (error) {
      deps.logger?.warn('嵌入任务入队失败，改为同步嵌入', error)
    }
  }
  try {
    const vectors = await deps.embedder.embed([text])
    const vector = vectors[0]
    if (vector === undefined) return 'failed'
    await deps.store.upsertEmbedding(entityId, deps.embedder.model, deps.embedder.dims, vector)
    return 'done'
  } catch (error) {
    deps.logger?.warn('同步嵌入失败', error)
    return 'failed'
  }
}
