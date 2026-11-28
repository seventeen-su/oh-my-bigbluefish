import type {
  DependencyAttributeRef,
  DependencyEdge,
  DependencyOperation,
  DependencyOrigin,
  DependencyStaleMark,
} from '../../domain/dependency.js'
import type { Attribute, EntityKind } from '../../domain/entity.js'
import { deriveReferences, type DerivedReference } from '../../domain/validation.js'
import type { Clock } from '../../ports/clock.js'
import type { DependencyGraph, DependencyStaleTarget } from '../../ports/dependency.js'
import { DependencyInvalidator, type DependencyInvalidationResult } from '../../app/dependency.js'
import { iso, type PostgresDb } from './db.js'
import { asAttributeQuery, type AttributeQuery } from './writer-tables.js'

/**
 * 依赖图的 PostgreSQL 适配器。
 *
 * - 写边：`replaceReferenceDependencyEdges`（写事务内整体替换某实体 source 的引用边）、
 *   `insertLinkDependencyEdges` / `deleteLinkDependencyEdges`（link create/unlink 维护）；
 * - 传播：`PostgresDependencyGraph` 只按 `target_entity_id` 入边批量查询，批量写标记；
 * - 读取：`readDependencyMarks` / `clearDependencyMarks` 给 DynamicService；
 * - 调度：`readDependencyTargets` 按 depth、marked_at、last_accessed_at 排序，给 omb.refresh。
 *
 * 事务边界由调用方持有：writer 传 PoolClient（经 `asAttributeQuery` 归一），读路径传
 * PostgresDb；两者都满足同一个窄 query 面。
 */

export type DependencyQuery = AttributeQuery

const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
  iso: () => new Date().toISOString(),
}

interface EdgeRow {
  source_entity_id: string
  source_attr_name: string
  source_ordinal: number
  target_entity_id: string
  target_attr_name: string
  origin: DependencyOrigin
  relation: string
}

interface AttributeKeyRow {
  entity_id: string
  name: string
  ordinal: number
}

interface MarkRow {
  entity_id: string
  attr_name: string
  ordinal: number
  depth: number
  reason: string
  root_entity_id: string
  operation: DependencyOperation
  marked_at: Date | string
}

interface TargetRow {
  entity_id: string
  depth: number
  marked_at: Date | string
  last_accessed_at: Date | string | null
}

interface LinkRow {
  from_id: string
  to_id: string
  relation: string
  directed: boolean
}

function jsonRecords(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(rows)
}

/**
 * 依赖图端口实现：所有查询都按给定实体集合（root + 每层入边 source）收敛，
 * 没有全表扫描；循环由 app 层 visited 处理，这里只做批量取数。
 */
export class PostgresDependencyGraph implements DependencyGraph {
  constructor(private readonly db: DependencyQuery) {}

  async edgesTargeting(targetEntityIds: readonly string[]): Promise<readonly DependencyEdge[]> {
    if (targetEntityIds.length === 0) return []
    const rows = await this.db.query<EdgeRow>(
      `select source_entity_id, source_attr_name, source_ordinal,
              target_entity_id, target_attr_name, origin, relation
       from omb.dynamic_dependency
       where target_entity_id = any($1::text[])
       order by target_entity_id, source_entity_id, source_attr_name, source_ordinal, origin, relation`,
      [[...targetEntityIds]],
    )
    return rows.rows.map(row => ({
      sourceEntityId: row.source_entity_id,
      sourceAttrName: row.source_attr_name,
      sourceOrdinal: row.source_ordinal,
      targetEntityId: row.target_entity_id,
      targetAttrName: row.target_attr_name,
      origin: row.origin,
      relation: row.relation,
    }))
  }

  async dynamicAttributesOf(entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly DependencyAttributeRef[]>> {
    const found = new Map<string, DependencyAttributeRef[]>()
    if (entityIds.length === 0) return found
    const rows = await this.db.query<AttributeKeyRow>(
      `select entity_id, name, ordinal
       from omb.attribute
       where entity_id = any($1::text[]) and value_kind = 'dynamic'
       order by entity_id, ordinal, name`,
      [[...entityIds]],
    )
    for (const row of rows.rows) {
      const list = found.get(row.entity_id) ?? []
      list.push({ name: row.name, ordinal: row.ordinal })
      found.set(row.entity_id, list)
    }
    return found
  }

  async markStale(marks: readonly DependencyStaleMark[]): Promise<void> {
    if (marks.length === 0) return
    await this.db.query(
      `insert into omb.dynamic_stale (
         entity_id, attr_name, ordinal, root_entity_id, operation, depth, reason, marked_at
       )
       select e->>'entity_id', e->>'attr_name', coalesce((e->>'ordinal')::int, 0),
              e->>'root_entity_id', e->>'operation', coalesce((e->>'depth')::int, 0),
              e->>'reason', (e->>'marked_at')::timestamptz
       from jsonb_array_elements($1::jsonb) as e
       on conflict (entity_id, attr_name, ordinal) do update set
         root_entity_id = excluded.root_entity_id,
         operation = excluded.operation,
         depth = least(omb.dynamic_stale.depth, excluded.depth),
         reason = case
           when excluded.depth < omb.dynamic_stale.depth then excluded.reason
           else omb.dynamic_stale.reason
         end,
         marked_at = least(omb.dynamic_stale.marked_at, excluded.marked_at)`,
      [jsonRecords(marks.map(mark => ({
        entity_id: mark.entityId,
        attr_name: mark.attrName,
        ordinal: mark.ordinal,
        root_entity_id: mark.rootEntityId,
        operation: mark.operation,
        depth: mark.depth,
        reason: mark.reason,
        marked_at: mark.markedAt,
      })))],
    )
  }
}

/**
 * 写事务内的依赖失效入口：构造 transaction-scoped 图 + app 层 BFS。
 * 所有标记与业务写在同一个事务里提交/回滚。
 */
export async function invalidateDependencies(
  client: Parameters<typeof asAttributeQuery>[0],
  rootEntityId: string,
  operation: DependencyOperation,
  options: { readonly maxDepth?: number; readonly clock?: Clock } = {},
): Promise<DependencyInvalidationResult> {
  const invalidator = new DependencyInvalidator(
    new PostgresDependencyGraph(asAttributeQuery(client)),
    options.clock ?? SYSTEM_CLOCK,
  )
  return invalidator.invalidate({
    rootEntityId,
    operation,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  })
}

/**
 * 引用边整体替换：`omb.reference` 的派生结果与依赖边同源、同事务。
 * 状态历史是不可变快照，不会被刷新；为它建边只会制造无意义失效。
 */
export async function replaceReferenceDependencyEdges(
  client: Parameters<typeof asAttributeQuery>[0],
  entityId: string,
  kind: EntityKind,
  references: readonly DerivedReference[],
  options: { readonly deleteOnly?: boolean } = {},
): Promise<void> {
  const db = asAttributeQuery(client)
  await db.query("delete from omb.dynamic_dependency where source_entity_id = $1 and origin = 'reference'", [entityId])
  if (options.deleteOnly === true || kind === 'state_version' || references.length === 0) return
  const records = references.map(reference => ({
    source_attr_name: reference.sourceAttrName,
    source_ordinal: reference.sourceOrdinal,
    target_entity_id: reference.targetEntityId,
    target_attr_name: reference.targetAttrName ?? '',
  }))
  await db.query(
    `insert into omb.dynamic_dependency (
       source_entity_id, source_attr_name, source_ordinal, target_entity_id, target_attr_name, origin, relation
     )
     select $1, e->>'source_attr_name', coalesce((e->>'source_ordinal')::int, 0),
            e->>'target_entity_id', coalesce(e->>'target_attr_name', ''), 'reference', ''
     from jsonb_array_elements($2::jsonb) as e
     on conflict do nothing`,
    [entityId, jsonRecords(records)],
  )
}

async function insertLinkEdgeRows(
  db: DependencyQuery,
  rows: readonly { readonly source: string; readonly target: string; readonly relation: string }[],
): Promise<void> {
  if (rows.length === 0) return
  await db.query(
    `insert into omb.dynamic_dependency (
       source_entity_id, source_attr_name, source_ordinal, target_entity_id, target_attr_name, origin, relation
     )
     select e->>'source', '', 0, e->>'target', '', 'link', e->>'relation'
     from jsonb_array_elements($1::jsonb) as e
     on conflict do nothing`,
    [jsonRecords(rows.map(row => ({ source: row.source, target: row.target, relation: row.relation })))],
  )
}

/** 从 link 行写依赖边：有向单向；无向补反向边（双向依赖）。 */
export async function insertLinkDependencyEdges(
  client: Parameters<typeof asAttributeQuery>[0],
  link: { readonly fromId: string; readonly toId: string; readonly relation: string; readonly directed: boolean },
): Promise<void> {
  if (link.fromId === link.toId) return
  const rows = [{ source: link.fromId, target: link.toId, relation: link.relation }]
  if (!link.directed) rows.push({ source: link.toId, target: link.fromId, relation: link.relation })
  await insertLinkEdgeRows(asAttributeQuery(client), rows)
}

/** unlink（link 软归档）时删除对应 link 依赖边。 */
export async function deleteLinkDependencyEdges(
  client: Parameters<typeof asAttributeQuery>[0],
  link: { readonly fromId: string; readonly toId: string; readonly relation: string; readonly directed: boolean },
): Promise<void> {
  const db = asAttributeQuery(client)
  const pairs: Array<[string, string]> = [[link.fromId, link.toId]]
  if (!link.directed) pairs.push([link.toId, link.fromId])
  for (const [source, target] of pairs) {
    await db.query(
      `delete from omb.dynamic_dependency
       where origin = 'link' and source_entity_id = $1 and target_entity_id = $2 and relation = $3`,
      [source, target, link.relation],
    )
  }
}

/** 归档 source 时清掉它的出边与自身待刷新标记：它不再作为可刷新依赖方。 */
export async function deleteSourceDependencyEdges(
  client: Parameters<typeof asAttributeQuery>[0],
  entityId: string,
): Promise<void> {
  const db = asAttributeQuery(client)
  await db.query('delete from omb.dynamic_dependency where source_entity_id = $1', [entityId])
  await db.query('delete from omb.dynamic_stale where entity_id = $1', [entityId])
}

/** 重新派生某实体作为 source 的全部依赖边（unarchive/回滚恢复属性后使用）。 */
export async function rebuildDependencyEdges(
  client: Parameters<typeof asAttributeQuery>[0],
  entity: { readonly id: string; readonly kind: EntityKind },
  attributes: readonly Attribute[],
): Promise<void> {
  const db = asAttributeQuery(client)
  const persisted = await db.query<AttributeKeyRow>(
    `select entity_id, name, ordinal
     from omb.attribute
     where entity_id = $1 and value_kind = 'dynamic'
     order by ordinal, name`,
    [entity.id],
  )
  const dynamicKeys = new Set(persisted.rows.map(row => `${row.name}#${row.ordinal}`))
  const references = deriveReferences(attributes)
    .filter(reference => dynamicKeys.has(`${reference.sourceAttrName}#${reference.sourceOrdinal}`))
  await replaceReferenceDependencyEdges(client, entity.id, entity.kind, references)
  if (entity.kind === 'state_version') return
  // 只补当前实体作为 source 的边：别的实体的边在归档时没有被删，不能借机复活。
  const links = await db.query<LinkRow>(
    `select from_id, to_id, relation, directed from omb.link
     where archived_at is null and (from_id = $1 or to_id = $1)`,
    [entity.id],
  )
  const rows: Array<{ source: string; target: string; relation: string }> = []
  for (const link of links.rows) {
    if (link.from_id === entity.id) rows.push({ source: link.from_id, target: link.to_id, relation: link.relation })
    if (link.directed === false && link.to_id === entity.id) {
      rows.push({ source: link.to_id, target: link.from_id, relation: link.relation })
    }
  }
  await insertLinkEdgeRows(db, rows)
}

/** 依赖标记读取（DynamicService 在每次刷新前消费）。 */
export async function readDependencyMarks(
  db: DependencyQuery,
  entityId: string,
): Promise<readonly DependencyStaleMark[]> {
  const rows = await db.query<MarkRow>(
    `select entity_id, attr_name, ordinal, depth, reason, root_entity_id, operation, marked_at
     from omb.dynamic_stale
     where entity_id = $1
     order by depth asc, marked_at asc, attr_name asc, ordinal asc`,
    [entityId],
  )
  return rows.rows.map(row => ({
    entityId: row.entity_id,
    attrName: row.attr_name,
    ordinal: row.ordinal,
    depth: row.depth,
    reason: row.reason,
    rootEntityId: row.root_entity_id,
    operation: row.operation,
    markedAt: iso(row.marked_at) as string,
  }))
}

/** 刷新成功后清除标记；失败必须保留（调用方不调用本函数）。 */
export async function clearDependencyMarks(
  db: DependencyQuery,
  entityId: string,
  attrs?: readonly DependencyAttributeRef[],
): Promise<void> {
  if (attrs === undefined) {
    await db.query('delete from omb.dynamic_stale where entity_id = $1', [entityId])
    return
  }
  if (attrs.length === 0) return
  await db.query(
    `delete from omb.dynamic_stale s
     using (
       select e->>'name' as name, coalesce((e->>'ordinal')::int, 0) as ordinal
       from jsonb_array_elements($2::jsonb) as e
     ) as k
     where s.entity_id = $1 and s.attr_name = k.name and s.ordinal = k.ordinal`,
    [entityId, jsonRecords(attrs.map(attr => ({ name: attr.name, ordinal: attr.ordinal })))],
  )
}

/** 属性重写后清理已经不存在/不再是动态属性的标记（patch 删除属性时）。 */
export async function pruneDependencyMarks(
  client: Parameters<typeof asAttributeQuery>[0],
  entityId: string,
): Promise<void> {
  await asAttributeQuery(client).query(
    `delete from omb.dynamic_stale s
     where s.entity_id = $1 and not exists (
       select 1 from omb.attribute a
       where a.entity_id = s.entity_id and a.name = s.attr_name
         and a.ordinal = s.ordinal and a.value_kind = 'dynamic'
     )`,
    [entityId],
  )
}

/**
 * 待刷新目标（事件驱动的 `omb.refresh` 消费）：同一实体只取最浅的一行；
 * 排序 = 直接依赖优先 → 陈旧时间早优先 → 最近访问优先（同优先级）。
 */
export async function readDependencyTargets(
  db: DependencyQuery,
  rootEntityId: string,
  limit: number,
): Promise<readonly DependencyStaleTarget[]> {
  const rows = await db.query<TargetRow>(
    `select entity_id, depth, marked_at, last_accessed_at
     from (
       select distinct on (s.entity_id)
              s.entity_id, s.depth, s.marked_at, e.last_accessed_at
       from omb.dynamic_stale s
       join omb.entity e on e.id = s.entity_id
       where s.root_entity_id = $1 and e.archived_at is null
       order by s.entity_id, s.depth asc, s.marked_at asc
     ) as targets
     order by depth asc, marked_at asc, last_accessed_at desc nulls last
     limit $2`,
    [rootEntityId, Math.max(1, Math.min(200, limit))],
  )
  return rows.rows.map(row => ({
    entityId: row.entity_id,
    depth: row.depth,
    markedAt: iso(row.marked_at) as string,
  }))
}

/** 读路径入口：PostgresDb 直接满足窄查询面。 */
export function dependencyQueryOf(db: PostgresDb): DependencyQuery {
  return db as unknown as DependencyQuery
}
