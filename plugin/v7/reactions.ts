/**
 * outbox 事件的真实 reaction：实体写入后入队嵌入与动态属性刷新。
 *
 * 只注册 writer 真实写出的 topic（`EntityCreated`/`EntityPatched`）；未注册 topic 由
 * relay 的 `unknownTopic='dead'` 明示进死信，而不是静默丢弃。reaction 只依赖端口
 * （Store/JobQueue/Embedder），不碰表结构。
 */
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { OnnxEmbedder } from '../../packages/v7/src/adapters/embedding/index.js'
import type { JobQueue, Logger } from '../../packages/v7/src/ports/jobs.js'
import type { JsonValue } from '../../packages/v7/src/domain/json.js'
import type { Reaction } from '../../packages/v7/src/app/outbox/index.js'
import { asRecord } from '../../packages/v7/src/adapters/dsh/host.js'
import { embeddingText } from '../../packages/v7/src/app/embedding.js'

/**
 * outbox 里注册了真实 reaction 的 topic。writer 的 `event_type` 就是 outbox `topic`
 * （`adapters/postgres/writer.ts` insertEvent），这里只接实体写入两条；
 * 其余 topic（归档/链接/改名）暂未接线：relay 的 `unknownTopic='dead'` 让它们进死信
 * 并在 status 里可见，而不是静默丢弃。
 */
export const EMBED_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/**
 * 事件触发优先：实体写入后动态属性可能已过期（新建时还没有缓存、patch 改了 ref 目标），
 * 所以 Created/Patched 也触发一次合并的 `omb.refresh`。链接/归档不改动态值，仍由 timer 巩固。
 */
export const REFRESH_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/**
 * outbox payload 是完整的 DomainEvent（writer 的 insertEvent）：实体事件优先读
 * `payload.entityId`，回退 `streamId`。两者都没有时不是实体事件，交给调用方报错。
 */
function entityIdFromOutboxPayload(payload: JsonValue): string | undefined {
  const event = asRecord(payload)
  const data = asRecord(event?.['payload'])
  const fromPayload = data?.['entityId']
  if (typeof fromPayload === 'string' && fromPayload.length > 0) return fromPayload
  const streamId = event?.['streamId']
  return typeof streamId === 'string' && streamId.length > 0 ? streamId : undefined
}

/**
 * EntityCreated / EntityPatched → 入队 `omb.embed`。
 *
 * 幂等：`singletonKey = embed:<entityId>` 让同一实体在已有一个未完成任务时不再建第二个；
 * relay 是 at-least-once（租约过期会重投），重复投递最多重建一次同文本向量，
 * `upsertEmbedding` 按实体覆盖，不会产生第二行。
 *
 * 嵌入器不可用时与 remember/update 同策略：不入队注定失败的任务（由 `omb.embed-sweep`
 * 在嵌入恢复后补齐），并只提示一次，避免每个事件刷日志。
 */
export function createEmbedReaction(deps: {
  readonly store: PostgresStore
  readonly queue: JobQueue
  readonly embedder: OnnxEmbedder
  readonly logger: Logger
}): Reaction {
  let unavailableLogged = false
  return {
    name: 'enqueue-embed',
    async run(event): Promise<void> {
      const entityId = entityIdFromOutboxPayload(event.payload)
      if (entityId === undefined) {
        // 不是实体事件却注册到了实体 topic：抛错让 relay 走退避/死信，问题在 status 可见。
        throw new Error(`outbox ${event.topic} 事件缺少 entityId（event_id=${event.eventId}）`)
      }
      const entity = await deps.store.get(entityId, { includeArchived: true })
      if (entity === undefined) return
      const text = embeddingText(entity.attributes)
      if (text.trim().length === 0) return
      if (!(await deps.embedder.available().catch(() => false))) {
        if (!unavailableLogged) {
          unavailableLogged = true
          deps.logger.warn('嵌入器不可用：事件驱动嵌入暂不入队，等 omb.embed-sweep 补齐')
        }
        return
      }
      await deps.queue.enqueue('omb.embed', { entityId, text }, { singletonKey: `embed:${entityId}`, retryLimit: 3 })
    },
  }
}

/**
 * EntityCreated / EntityPatched → 合并入队一次 `omb.refresh`（事件触发优先）。
 *
 * 只有实体真的带动态属性才入队：`omb.refresh` 是“扫 staleDynamic”的聚合任务，
 * 普通记忆入队只会空跑一次全表查询。`singletonKey` 固定为 `refresh:event`，
 * 所以一次事件风暴最多留下一个待跑任务，不按事件放大。
 *
 * 与 embed reaction 同款：载荷不是实体事件时抛错让 relay 进死信（status 可见），
 * 不静默丢弃。
 */
export function createRefreshReaction(deps: {
  readonly store: PostgresStore
  readonly queue: JobQueue
  readonly logger: Logger
}): Reaction {
  return {
    name: 'enqueue-refresh',
    async run(event): Promise<void> {
      const entityId = entityIdFromOutboxPayload(event.payload)
      if (entityId === undefined) {
        throw new Error(`outbox ${event.topic} 事件缺少 entityId（event_id=${event.eventId}）`)
      }
      const entity = await deps.store.get(entityId, { includeArchived: true })
      if (entity === undefined) return
      if (!entity.attributes.some(attribute => attribute.value.kind === 'dynamic')) return
      await deps.queue.enqueue('omb.refresh', { entityId }, { singletonKey: 'refresh:event', retryLimit: 3 })
    },
  }
}
