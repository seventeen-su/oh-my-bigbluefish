/**
 * outbox 事件的真实 reaction：实体写入后入队嵌入与动态属性刷新，链接变化后触发
 * link-suggest，写事务已完成的副作用 topic 只做明确 ack。
 *
 * writer 的 `event_type` 就是 outbox `topic`（`adapters/postgres/writer.ts` insertEvent）。
 * 每个合法 topic 都必须在这里有消费者：未注册 topic 由 relay 的 `unknownTopic='dead'`
 * 明示进死信，而不是静默丢弃；反过来，不允许合法 topic 因为“没人接”而长期堆在死信里。
 * reaction 只依赖端口（Store/JobQueue/Embedder），不碰表结构。
 */
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { OnnxEmbedder } from '../../packages/v7/src/adapters/embedding/index.js'
import type { JobQueue, Logger } from '../../packages/v7/src/ports/jobs.js'
import type { JsonValue } from '../../packages/v7/src/domain/json.js'
import type { Reaction } from '../../packages/v7/src/app/outbox/index.js'
import { asRecord } from '../../packages/v7/src/adapters/dsh/host.js'
import { embeddingText } from '../../packages/v7/src/app/embedding.js'

export const EMBED_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/**
 * 事件触发优先：实体写入后动态属性可能已过期（新建时还没有缓存、patch 改了 ref 目标），
 * 所以 Created/Patched 也触发一次合并的 `omb.refresh`。链接/归档不改动态值，仍由 timer 巩固。
 */
export const REFRESH_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/**
 * 链接变化 → 入队 `omb.link-suggest`。
 *
 * 链接是共同召回成组/链成员建议的输入：新建或取消链接后立刻扫一遍，比等下一格 10 分钟
 * 定时更符合“事件触发优先”；定时扫描仍保留，事件只是提前一次。
 */
export const LINK_REACTION_TOPICS: readonly string[] = ['LinkCreated', 'LinkUnlinked']

/**
 * 合法但不需要 outbox 再做一次下游动作的 topic。
 *
 * - `EntityArchived`/`EntityUnarchived`：归档列、`entity_view` 同步与看板投影任务都在
 *   writer 的同一事务里完成；再入队嵌入只会给已归档实体白算向量。
 * - `AttributeRenamed`：属性改名会 bump 受影响实体版本、重建 view/引用/触发键并重新入队
 *   看板投影（同样在写事务里）；`deriveSearchText` 不含属性名，嵌入文本不变。
 *
 * 这些 topic 由 `createAckReaction` 明确 ack 并计数，而不是交给 unknownTopic 策略进死信：
 * “写事务已经处理”与“没人注册消费者”是两种不同状态，status 里必须能区分。
 * 如果哪天写事务不再产生某个副作用，应由测试发现，而不是让事件永远躺在死信里。
 */
export const WRITE_SIDE_EFFECT_TOPICS: readonly string[] = [
  'EntityArchived',
  'EntityUnarchived',
  'AttributeRenamed',
]

/** ack 的进程内计数；`omb_status` 用它证明合法 topic 被明确处理而不是 dead。 */
export interface ReactionAckMetrics {
  ack(topic: string): void
  /** topic → 次数，按 topic 排序；没有 ack 时是空对象。 */
  snapshot(): Readonly<Record<string, number>>
}

export function createReactionAckMetrics(): ReactionAckMetrics {
  const counts = new Map<string, number>()
  return {
    ack(topic: string): void {
      counts.set(topic, (counts.get(topic) ?? 0) + 1)
    },
    snapshot(): Readonly<Record<string, number>> {
      const sorted: Record<string, number> = {}
      for (const topic of [...counts.keys()].sort()) sorted[topic] = counts.get(topic) ?? 0
      return sorted
    },
  }
}

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

/** 链接事件的 payload 里 `payload.linkId` 是流 id；缺了就是损坏事件，交给 relay 退避/死信。 */
function linkIdFromOutboxPayload(payload: JsonValue): string | undefined {
  const event = asRecord(payload)
  const data = asRecord(event?.['payload'])
  const linkId = data?.['linkId']
  return typeof linkId === 'string' && linkId.length > 0 ? linkId : undefined
}

/**
 * LinkCreated / LinkUnlinked → 入队一次 `omb.link-suggest`。
 *
 * `omb.link-suggest` 的手柄是“扫共同召回对再成组/建链”的聚合任务，与链接创建/取消直接
 * 相关；这里只负责把“有新链接变化”这件事尽快告诉它，不传逐链接的细粒度语义。
 *
 * 幂等：`singletonKey='link-suggest:event'` 让一次链接风暴最多留下一个待跑任务；任务本身
 * 按当前数据库状态重新扫描，重复投递（at-least-once）不会产生第二份结果。
 * 载荷缺 linkId 时抛错，让 relay 按退避/死信处理并在 status 可见，而不是静默丢弃。
 */
export function createLinkSuggestReaction(deps: { readonly queue: JobQueue }): Reaction {
  return {
    name: 'enqueue-link-suggest',
    async run(event): Promise<void> {
      const linkId = linkIdFromOutboxPayload(event.payload)
      if (linkId === undefined) {
        throw new Error(`outbox ${event.topic} 事件缺少 linkId（event_id=${event.eventId}）`)
      }
      await deps.queue.enqueue(
        'omb.link-suggest',
        { trigger: 'outbox-link', topic: event.topic, linkId, eventId: event.eventId },
        { singletonKey: 'link-suggest:event', retryLimit: 3 },
      )
    },
  }
}

/**
 * 合法 topic 的明确 ack（副作用已在写事务完成，见 `WRITE_SIDE_EFFECT_TOPICS`）。
 *
 * 不抛错、不做 IO：只把“这个事件被有意跳过”记进进程内计数，避免它被当成未注册 topic
 * 进死信；`omb_status` 的 `outboxAcked`/`outboxAckedByTopic` 与 dead 计数因此可以区分
 * “正常跳过”和“没人消费”。
 */
export function createAckReaction(deps: { readonly metrics: ReactionAckMetrics }): Reaction {
  return {
    name: 'ack-write-side-effects',
    run(event): void {
      deps.metrics.ack(event.topic)
    },
  }
}
