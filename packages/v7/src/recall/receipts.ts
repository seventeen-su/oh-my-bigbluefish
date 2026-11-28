import type {
  EntityReceipt,
  EntityReceiptState,
  InjectionReceipt,
} from '../prompt/assembler.js'

/**
 * 逐实体 receipt 的装配/读取契约。
 *
 * 为什么需要它：T0 把偏好、状态、索引压进少数几个段，一个段里可能有多个实体；
 * 块级 `kept`/`entityIds` 无法回答「这个实体到底有没有被展示」。每次注入对每个
 * **实际展示或隔离**的实体写一条 `EntityReceipt`，adoption 与审计都以它为唯一来源：
 *
 * - `state === 'kept'`：实体原文进入了注入文本；
 * - `state === 'quarantined'`：实体所属块被高风险隔离，只注入了隔离说明；
 * - 被预算丢弃、被截断到不可见、或块整体没进的实体**没有条目**。
 *
 * 持久化位置：`omb.resident_trace.sections` 里 `name='injection-receipt'` 的
 * `text`（JSON）的 `entities` 字段。T0 行 `session_id` 非空，T1 行 `session_id` 为空；
 * 两者共用同一份 receipt 形状，用 `traceId` 对账。同一 trace 的
 * `recordResidentTrace` 是 `on conflict (trace_id) do nothing`，重复落库不会重复。
 *
 * 同一实体在一次注入里只保留一条：`kept` 优先于 `quarantined`（同一实体只要在一个
 * 段里被真正展示，就不该被另一个段的隔离说明抹掉），同状态保留先出现的条目。
 */
export type { EntityReceipt, EntityReceiptState }

/** 同一实体只保留一条：kept 优先，其次按首次出现顺序。 */
export function dedupeEntityReceipts(items: readonly EntityReceipt[]): readonly EntityReceipt[] {
  const byId = new Map<string, EntityReceipt>()
  for (const item of items) {
    const previous = byId.get(item.entityId)
    if (previous === undefined || (previous.state === 'quarantined' && item.state === 'kept')) {
      byId.set(item.entityId, item)
    }
  }
  return [...byId.values()]
}

/**
 * 把逐实体证据挂到装配 receipt 上；返回新对象，不修改原 receipt。
 *
 * 空数组也会写入 `entities: []`：新 receipt 的字段形状因此稳定（消费方不必区分
 * “没有字段”和“没有实体”）。traceId 与 receipt 不一致的条目会被归一到 receipt 的
 * traceId，避免逐实体证据与所属注入对不上。
 */
export function withEntityReceipts(
  receipt: InjectionReceipt,
  entities: readonly EntityReceipt[],
): InjectionReceipt {
  const traceId = receipt.traceId
  const normalized = traceId === undefined
    ? entities
    : entities.map(item => (item.traceId === traceId ? item : { ...item, traceId }))
  return { ...receipt, entities: dedupeEntityReceipts(normalized) }
}

/** 逐实体证据；旧 receipt / 未填充时为空数组。 */
export function entityReceiptsOf(receipt: InjectionReceipt | undefined): readonly EntityReceipt[] {
  return receipt?.entities ?? []
}

/** 真正进入注入文本的实体 id（`kept`，不含被隔离的）。 */
export function keptEntityIds(receipt: InjectionReceipt | undefined): readonly string[] {
  return entityReceiptsOf(receipt)
    .filter(item => item.state === 'kept')
    .map(item => item.entityId)
}

/** 只注入了隔离说明的实体 id（原文没有进入提示词）。 */
export function quarantinedEntityIds(receipt: InjectionReceipt | undefined): readonly string[] {
  return entityReceiptsOf(receipt)
    .filter(item => item.state === 'quarantined')
    .map(item => item.entityId)
}
