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
import { attributeValue } from '../../packages/v7/src/domain/entity-access.js'
import type { Reaction } from '../../packages/v7/src/app/outbox/index.js'
import { dependencyRefreshKey } from '../../packages/v7/src/app/dependency.js'
import { asRecord } from '../../packages/v7/src/adapters/dsh/host.js'
import { embeddingText } from '../../packages/v7/src/app/embedding.js'

export const EMBED_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/**
 * 事件触发优先：实体写入后动态属性可能已过期（新建时还没有缓存、patch 改了 ref 目标），
 * 所以 Created/Patched 触发一次实体自身刷新；Archived/Unarchived 不刷新自身，但如果
 * 写事务里落了依赖失效标记，则触发一次定向的依赖刷新（reaction 读取 payload.dependency）。
 *
 * 依赖失效**不靠周期扫描**：标记与 outbox 事件同事务提交，本 reaction 只按 root 入队
 * `omb.refresh`，handler 读 root 的入边标记顺序刷新。
 */
export const REFRESH_REACTION_TOPICS: readonly string[] = [
  'EntityCreated',
  'EntityPatched',
  'EntityArchived',
  'EntityUnarchived',
]

/**
 * 链接变化 → 入队 `omb.link-suggest`。
 *
 * 链接是共同召回成组/链成员建议的输入：新建或取消链接后立刻扫一遍，比等下一格 10 分钟
 * 定时更符合“事件触发优先”；定时扫描仍保留，事件只是提前一次。
 */
export const LINK_REACTION_TOPICS: readonly string[] = ['LinkCreated', 'LinkUnlinked']

/**
 * 巩固任务的事件触发（事件驱动为主）：
 * - `EntityCreated`/`EntityPatched` 的 memory → 定向 dedupe/conflict；线索 → 定向 clue-promote；
 * - `EntityPatched`（任意 kind）→ 定向 reference-rot（只看指向该实体的引用）；
 * - `AttributeRenamed` → 对受影响实体逐个定向 reference-rot（见下方独立 reaction）。
 *
 * 这些任务在周期 timer 里仍保留低频兜底（漏事件/首次启动），但正常路径由本 reaction 即时
 * 入队：不会等下一格轮询，也不会为一条新记忆扫描整库。
 */
export const CONSOLIDATION_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/** 属性改名影响引用目标列名：受影响实体必须立即做定向引用腐化检查。 */
export const ATTRIBUTE_RENAME_REACTION_TOPICS: readonly string[] = ['AttributeRenamed']

/**
 * 内容相同、证据新增（第二层内容幂等命中）→ 立即重新评估线索晋升。
 * 证据变化不 bump 实体 revision，因此不会触发 EntityPatched 的 dedupe/conflict；
 * 只有 clue-promote 关心“同一内容又出现了一个来源”。
 */
export const EVIDENCE_REACTION_TOPICS: readonly string[] = ['EvidenceAdded']

/**
 * 合法但不需要 outbox 再做一次下游动作的 topic。
 *
 * - `EntityArchived`/`EntityUnarchived`：归档列、`entity_view` 同步与看板投影任务都在
 *   writer 的同一事务里完成；它们不参与嵌入，但可能带 `payload.dependency`，由 refresh
 *   reaction 触发一次定向依赖刷新。
 * - `EntitySuperseded`/`EntityRetracted`：生命周期列、`entity_view.lifecycle`、看板删除任务
 *   与审计 inverse 都在取代/证伪事务里完成；旧实体不该再产生嵌入/刷新任务。
 * - `AttributeRenamed`：属性改名会 bump 受影响实体版本、重建 view/引用/触发键并重新入队
 *   看板投影（同样在写事务里）；`deriveSearchText` 不含属性名，嵌入文本不变。
 *
 * 这些 topic 由 `createAckReaction` 明确 ack 并计数，而不是交给 unknownTopic 策略进死信：
 * “写事务已经处理”与“没人注册消费者”是两种不同状态，status 里必须能区分。
 * `AttributeRenamed` 已由定向 reference-rot reaction 消费，不再只是 ack。
 */
export const WRITE_SIDE_EFFECT_TOPICS: readonly string[] = [
  'EntityArchived',
  'EntityUnarchived',
  'EntitySuperseded',
  'EntityRetracted',
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
 * 写事务里的依赖失效摘要（`payload.dependency.marked > 0`）：返回 root 实体。
 * payload 是完整 DomainEvent（`payload.payload.dependency`），由 writer 在 patch/archive/
 * unarchive 事件里写入；没有标记的普通写入返回 undefined，不产生刷新任务。
 */
export function dependencyInvalidationOf(payload: JsonValue): { rootEntityId: string; marked: number } | undefined {
  const event = asRecord(payload)
  const data = asRecord(event?.['payload'])
  const dependency = asRecord(data?.['dependency'])
  if (dependency === undefined) return undefined
  const marked = dependency['marked']
  if (typeof marked !== 'number' || !Number.isFinite(marked) || marked <= 0) return undefined
  const rootEntityId = entityIdFromOutboxPayload(payload)
  if (rootEntityId === undefined) return undefined
  return { rootEntityId, marked }
}

/**
 * EntityCreated / EntityPatched → 实体自身合并入队一次 `omb.refresh`（事件触发优先）。
 *
 * 只有实体真的带动态属性才入队自身刷新；依赖失效再看写事务落的 `payload.dependency`，
 * 对每个 root 用 `refresh:dependency:<root>` 去重（同一 root 的事件风暴只留一个待跑任务）。
 * 与 embed reaction 同款：载荷不是实体事件时抛错让 relay 进死信（status 可见），不静默丢弃。
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
      // 归档实体自身不再刷新；只有 Created/Patched 需要把新 spec/缺失缓存补上。
      if ((event.topic === 'EntityCreated' || event.topic === 'EntityPatched')
        && entity.attributes.some(attribute => attribute.value.kind === 'dynamic')) {
        await deps.queue.enqueue('omb.refresh', { entityId }, { singletonKey: 'refresh:event', retryLimit: 3 })
      }
      const invalidation = dependencyInvalidationOf(event.payload)
      if (invalidation !== undefined) {
        await deps.queue.enqueue(
          'omb.refresh',
          { dependencyRoot: invalidation.rootEntityId },
          { singletonKey: dependencyRefreshKey(invalidation.rootEntityId), retryLimit: 3 },
        )
      }
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

/** 从 payload 读 `payload.entityIds`（AttributeRenamed 事件）；缺了就是损坏事件。 */
function entityIdsFromOutboxPayload(payload: JsonValue): string[] | undefined {
  const event = asRecord(payload)
  const data = asRecord(event?.['payload'])
  const value = data?.['entityIds']
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * EntityCreated / EntityPatched → 定向巩固任务（事件驱动为主）。
 *
 * 只做“把这件事告诉对应的定向 handler”，不在这里做近邻计算：
 * - memory → `omb.dedupe` / `omb.conflict`（singletonKey 按实体，避免事件风暴放大）；
 * - clue → 追加 `omb.clue-promote`；
 * - 任意 EntityPatched → `omb.reference-rot`（targetEntityId = 被改实体）。
 *
 * 载荷缺 entityId 时抛错让 relay 退避/死信（status 可见），不静默丢弃。
 * 周期 timer 仍有低频兜底；本 reaction 让正常路径不等下一格。
 */
export function createConsolidationReaction(deps: {
  readonly store: PostgresStore
  readonly queue: JobQueue
  readonly logger: Logger
}): Reaction {
  return {
    name: 'enqueue-consolidation',
    async run(event): Promise<void> {
      const entityId = entityIdFromOutboxPayload(event.payload)
      if (entityId === undefined) {
        throw new Error(`outbox ${event.topic} 事件缺少 entityId（event_id=${event.eventId}）`)
      }
      const entity = await deps.store.get(entityId, { includeArchived: true })
      // 已归档实体不再需要收敛/晋升；写入事务已处理看板，这里直接返回。
      if (entity === undefined || entity.archivedAt !== undefined) return
      if (entity.kind === 'memory') {
        await deps.queue.enqueue(
          'omb.dedupe',
          { trigger: 'entity-event', topic: event.topic, entityId, eventId: event.eventId },
          { singletonKey: `dedupe:${entityId}`, retryLimit: 3 },
        )
        await deps.queue.enqueue(
          'omb.conflict',
          { trigger: 'entity-event', topic: event.topic, entityId, eventId: event.eventId },
          { singletonKey: `conflict:${entityId}`, retryLimit: 3 },
        )
        if (attributeValue(entity, 'category') === 'clue') {
          await deps.queue.enqueue(
            'omb.clue-promote',
            { trigger: 'entity-event', topic: event.topic, entityId, eventId: event.eventId },
            { singletonKey: `clue-promote:${entityId}`, retryLimit: 3 },
          )
        }
      }
      // 只有 patch 可能删除/改名属性，从而让指向本实体的引用腐化。
      if (event.topic === 'EntityPatched') {
        await deps.queue.enqueue(
          'omb.reference-rot',
          { trigger: 'entity-event', topic: event.topic, entityId, targetEntityId: entityId, eventId: event.eventId },
          { singletonKey: `reference-rot:${entityId}`, retryLimit: 3 },
        )
      }
    },
  }
}

/**
 * AttributeRenamed → 对每个受影响实体定向检查引用腐化。
 *
 * 改名在同一事务里更新了属性行/引用/视图；但引用行的 `target_attr_name` 可能还指向旧名，
 * 这是唯一能在改名前就存在的腐化来源。逐个实体入队，singletonKey 按实体合并事件风暴。
 */
export function createAttributeRenameReaction(deps: { readonly queue: JobQueue }): Reaction {
  return {
    name: 'enqueue-reference-rot-on-rename',
    async run(event): Promise<void> {
      const entityIds = entityIdsFromOutboxPayload(event.payload)
      if (entityIds === undefined || entityIds.length === 0) {
        throw new Error(`outbox ${event.topic} 事件缺少 entityIds（event_id=${event.eventId}）`)
      }
      for (const entityId of entityIds) {
        await deps.queue.enqueue(
          'omb.reference-rot',
          { trigger: 'attribute-renamed', topic: event.topic, entityId, targetEntityId: entityId, eventId: event.eventId },
          { singletonKey: `reference-rot:${entityId}`, retryLimit: 3 },
        )
      }
    },
  }
}

/**
 * EvidenceAdded → 定向重评估线索晋升。
 *
 * 内容去重命中时实体 revision 不变（写事务只追加 evidence + 一条 EvidenceAdded 事件）；
 * 这里按 singletonKey 合并同一实体的证据风暴，让晋升在下一轮后台立即发生，不等 2h 兜底。
 */
export function createEvidenceAddedReaction(deps: { readonly queue: JobQueue }): Reaction {
  return {
    name: 'enqueue-clue-promote-on-evidence',
    async run(event): Promise<void> {
      const entityId = entityIdFromOutboxPayload(event.payload)
      if (entityId === undefined) {
        throw new Error(`outbox ${event.topic} 事件缺少 entityId（event_id=${event.eventId}）`)
      }
      await deps.queue.enqueue(
        'omb.clue-promote',
        { trigger: 'evidence-event', topic: event.topic, entityId, eventId: event.eventId },
        { singletonKey: `clue-promote:${entityId}`, retryLimit: 3 },
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
