import type { PoolClient } from 'pg'
import type { Attribute } from '../../domain/entity.js'
import { scopeOf } from '../../domain/entity-access.js'
import { OmbFailure, conflict, notFound } from '../../domain/errors.js'
import { deriveReferences, deriveSearchText, deriveTriggers, type NormalizedWrite } from '../../domain/validation.js'
import type { ReferenceInput } from '../../ports/store.js'
import { iso, PostgresDb } from './db.js'
import {
  buildViewValues,
  mapAttribute,
  mapEntity,
  type AttributeRow,
  type EntityRow,
  type ViewValues,
} from './rows.js'
import { canonicalJson } from './writer-support.js'

/**
 * 写事务的表级原语：attribute / attr_registry / trigger_key / reference / chain_member /
 * entity_view 的批量 upsert，以及从属性行派生视图。
 *
 * 只接收 PoolClient：事务边界由 AttributeWriter 或回滚入口持有；这里不做错误映射、
 * 不写 audit/outbox（见 writer-audit.ts）。
 */

/** 允许在事务内直接 query 的最小接口（Pool 与 PoolClient 都满足）。 */
export type AttributeQuery = { query: PostgresDb['query'] }

/**
 * 把一批写入行序列化成单个 jsonb 数组参数。
 *
 * 批量语句统一用 `jsonb_array_elements` 展开：一次往返写完整批属性/触发键/引用，
 * 而不是逐行 `await`（N 次往返）；jsonb 列用 `e->'col'` 取值，保留「JSON null」与
 * 「该列不适用（SQL NULL）」的区别，避免值和约束被悄悄改义。
 */
function jsonRecords(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(rows)
}


/** 单条多值 INSERT：整批属性一次往返写完（ADR-0007/0013）。 */
export async function insertAttributes(client: PoolClient, entityId: string, attributes: readonly Attribute[]): Promise<void> {
  if (attributes.length === 0) return
  const records = attributes.map(attribute => {
    const value = attribute.value
    return {
      name: attribute.name,
      ordinal: attribute.ordinal,
      value_kind: value.kind,
      ...(value.kind === 'static' ? { value: value.value } : { expr: value.spec }),
      ...(value.kind === 'dynamic' && value.cachedValue !== undefined ? { cached_value: value.cachedValue } : {}),
      ...(value.kind === 'dynamic' && value.cachedAt !== undefined ? { cached_at: value.cachedAt } : {}),
      ...(value.kind === 'dynamic' && value.staleAfterMs !== undefined ? { stale_after_ms: value.staleAfterMs } : {}),
      ...(value.kind === 'dynamic' && value.lastError !== undefined ? { last_error: value.lastError } : {}),
      is_required: attribute.required,
      ...(attribute.confidence !== undefined ? { confidence: attribute.confidence } : {}),
      source: attribute.source,
    }
  })
  await client.query(
    `insert into omb.attribute (
       entity_id, name, ordinal, value_kind, value, expr, cached_value, cached_at,
       stale_after_ms, last_error, is_required, confidence, source
     )
     select $1,
            e->>'name',
            coalesce((e->>'ordinal')::int, 0),
            e->>'value_kind',
            e->'value',
            e->'expr',
            e->'cached_value',
            (e->>'cached_at')::timestamptz,
            (e->>'stale_after_ms')::int,
            e->>'last_error',
            (e->>'is_required')::boolean,
            (e->>'confidence')::float8,
            e->>'source'
     from jsonb_array_elements($2::jsonb) as e`,
    [entityId, jsonRecords(records)],
  )
}

/** 注册表按属性名聚合成一批 upsert：同名多 ordinal 只累加一次 usage_count。 */
export async function upsertRegistry(client: PoolClient, attributes: readonly Attribute[]): Promise<void> {
  const usage = new Map<string, { kind: string; count: number }>()
  for (const attribute of attributes) {
    if (attribute.required) continue
    const current = usage.get(attribute.name)
    if (current === undefined) usage.set(attribute.name, { kind: attribute.value.kind, count: 1 })
    else {
      current.count += 1
      current.kind = attribute.value.kind
    }
  }
  if (usage.size === 0) return
  const records = [...usage].map(([name, item]) => ({ name, value_kind: item.kind, usage: item.count }))
  // check:ignore-next-line sec-sql-concat -- records 走 $1::jsonb 参数，模板是常量 SQL
  await client.query(
    `insert into omb.attr_registry (name, value_kind, usage_count)
     select e->>'name', e->>'value_kind', coalesce((e->>'usage')::int, 1)
     from jsonb_array_elements($1::jsonb) as e
     on conflict (name) do update
       set usage_count = omb.attr_registry.usage_count + excluded.usage_count,
           last_seen = now(),
           value_kind = excluded.value_kind`,
    [jsonRecords(records)],
  )
}

export async function insertTriggers(client: PoolClient, entityId: string, triggers: readonly { readonly kind: string; readonly key: string; readonly weight: number }[]): Promise<void> {
  if (triggers.length === 0) return
  await client.query(
    `insert into omb.trigger_key (entity_id, kind, key, weight)
     select $1, e->>'kind', e->>'key', coalesce((e->>'weight')::float8, 1)
     from jsonb_array_elements($2::jsonb) as e
     on conflict (entity_id, kind, key) do update set weight = greatest(omb.trigger_key.weight, excluded.weight)`,
    [entityId, jsonRecords(triggers.map(trigger => ({ kind: trigger.kind, key: trigger.key, weight: trigger.weight })))],
  )
}

export async function replaceReferences(client: PoolClient, entityId: string, references: readonly ReferenceInput[]): Promise<void> {
  await client.query('delete from omb.reference where source_entity_id = $1', [entityId])
  if (references.length === 0) return
  const records = references.map(reference => ({
    source_attr_name: reference.sourceAttrName,
    source_ordinal: reference.sourceOrdinal,
    target_entity_id: reference.targetEntityId,
    target_attr_name: reference.targetAttrName ?? '',
    kind: reference.kind,
  }))
  await client.query(
    `insert into omb.reference (
       source_entity_id, source_attr_name, source_ordinal, target_entity_id, target_attr_name, kind
     )
     select $1, e->>'source_attr_name', coalesce((e->>'source_ordinal')::int, 0),
            e->>'target_entity_id', coalesce(e->>'target_attr_name', ''), e->>'kind'
     from jsonb_array_elements($2::jsonb) as e
     on conflict do nothing`,
    [entityId, jsonRecords(records)],
  )
}

export async function insertChainMembers(client: PoolClient, chainId: string, members: readonly string[], source: string): Promise<void> {
  if (members.length === 0) return
  // 后出现的位置覆盖前面：与逐行 upsert 的最终状态一致，同时避免同一批里重复键。
  const positions = new Map<string, number>()
  for (const [position, memberId] of members.entries()) positions.set(memberId, position)
  const records = [...positions].map(([memberId, position]) => ({ member_id: memberId, position, source }))
  await client.query(
    `insert into omb.chain_member (chain_id, member_id, position, source)
     select $1, e->>'member_id', coalesce((e->>'position')::int, 0), e->>'source'
     from jsonb_array_elements($2::jsonb) as e
     on conflict (chain_id, member_id) do update set position = excluded.position`,
    [chainId, jsonRecords(records)],
  )
}

export async function replaceChainMembers(client: PoolClient, chainId: string, members: readonly string[], source: string): Promise<void> {
  await client.query('delete from omb.chain_member where chain_id = $1', [chainId])
  await insertChainMembers(client, chainId, members, source)
}

/**
 * 思维链成员只能是记忆、状态机或状态历史；链不能嵌套链。
 * 先查 entity 再插 chain_member：FK 只保证存在，不保证 kind。
 */
export async function assertChainMemberKinds(client: PoolClient, members: readonly string[]): Promise<void> {
  const rows = await client.query<{ id: string; kind: string }>(
    'select id, kind from omb.entity where id = any($1::text[])',
    [members],
  )
  const kinds = new Map(rows.rows.map(row => [row.id, row.kind]))
  for (const memberId of members) {
    const kind = kinds.get(memberId)
    if (kind === undefined) throw new OmbFailure(notFound(`思维链成员不存在：${memberId}`))
    if (kind !== 'memory' && kind !== 'state' && kind !== 'state_version') {
      throw new OmbFailure(conflict(`思维链成员必须是记忆、状态机或状态历史：${memberId}（${kind}）`))
    }
  }
}

export function asAttributeQuery(client: PoolClient): AttributeQuery {
  return client as unknown as AttributeQuery
}

export async function selectAttributes(queryable: AttributeQuery, entityId: string): Promise<Attribute[]> {
  const rows = await queryable.query<AttributeRow>(
    'select * from omb.attribute where entity_id = $1 order by ordinal asc, name asc',
    [entityId],
  )
  return rows.rows.map(mapAttribute)
}

interface ViewBuild {
  readonly view: ViewValues
  readonly triggers: ReturnType<typeof deriveTriggers>
  readonly references: ReturnType<typeof deriveReferences>
}

/**
 * 视图/触发键/引用的唯一派生入口：只读属性行（唯一真源），在写事务内调用。
 *
 * 不能从内存里的 `NormalizedWrite.attributes` 派生——patch 前的动态 cachedValue
 * 只存在于属性表里；从属性行派生才能保证 `entity_view` 可由属性表完整重建。
 */
export function buildViewFromRows(
  row: EntityRow,
  attributes: readonly Attribute[],
  now: string,
  archivedAt?: string | null,
): ViewBuild {
  const entity = mapEntity(row, attributes)
  const input: NormalizedWrite = {
    id: row.id,
    kind: row.kind === 'state_version' ? 'state' : row.kind,
    scope: scopeOf(entity),
    origin: row.origin,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    pinned: row.pinned,
    attributes,
  }
  const triggers = deriveTriggers(attributes)
  const references = deriveReferences(attributes)
  const view = buildViewValues(
    input,
    { searchText: deriveSearchText(attributes), triggers },
    {
      now,
      attributes,
      isCurrent: row.is_current,
      revision: Number(row.revision),
      kindOverride: row.kind,
      archivedAt,
    },
  )
  return { view, triggers, references }
}

/**
 * 动态缓存值写回后重建视图与触发键（同事务）。引用只由 spec 决定，缓存变化不影响，
 * 因此这里不重写 reference；触发器则可能来自缓存文本里的路径/错误签名，必须重建。
 */
export async function rebuildViewFromRows(client: PoolClient, entityId: string, now: string): Promise<void> {
  const entityResult = await client.query<EntityRow>('select * from omb.entity where id = $1', [entityId])
  const row = entityResult.rows[0]
  if (row === undefined) return
  const attributes = await selectAttributes(asAttributeQuery(client), entityId)
  const { view, triggers } = buildViewFromRows(row, attributes, now, iso(row.archived_at) ?? null)
  await client.query('delete from omb.trigger_key where entity_id = $1', [entityId])
  await insertTriggers(client, entityId, triggers)
  await upsertView(client, view)
}

export async function upsertView(client: PoolClient, view: ViewValues): Promise<void> {
  await client.query(
    `insert into omb.entity_view (
       entity_id, kind, category, scope, project_key, title, status, event_time, attrs,
       attr_names, search_text, snippet, chars, triggers, is_current, archived_at, revision,
       confidence, pinned, salience, access_count, adoption_count, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::text[],$11,$12,$13::text[],$14::text[],
       $15,$16,$17,$18,$19,$20,$21,$22,$23
     )
     on conflict (entity_id) do update set
       kind = excluded.kind,
       category = excluded.category,
       scope = excluded.scope,
       project_key = excluded.project_key,
       title = excluded.title,
       status = excluded.status,
       event_time = excluded.event_time,
       attrs = excluded.attrs,
       attr_names = excluded.attr_names,
       search_text = excluded.search_text,
       snippet = excluded.snippet,
       chars = excluded.chars,
       triggers = excluded.triggers,
       is_current = excluded.is_current,
       archived_at = excluded.archived_at,
       revision = excluded.revision,
       confidence = excluded.confidence,
       pinned = excluded.pinned,
       salience = excluded.salience,
       access_count = excluded.access_count,
       adoption_count = excluded.adoption_count,
       updated_at = excluded.updated_at`,
    [
      view.entityId,
      view.kind,
      view.category,
      view.scope,
      view.projectKey,
      view.title,
      view.status,
      view.eventTime,
      JSON.stringify(view.attrs),
      view.attrNames,
      view.searchText,
      view.snippet,
      view.chars,
      view.triggers,
      view.isCurrent,
      view.archivedAt,
      view.revision,
      view.confidence,
      view.pinned,
      view.salience,
      view.accessCount,
      view.adoptionCount,
      view.updatedAt,
    ],
  )
}

/** patch 重新插入属性时保留同名、同 spec 动态属性的缓存；spec 变了才丢弃。 */
export async function preserveDynamicCaches(
  client: PoolClient,
  entityId: string,
  previous: readonly Attribute[],
  next: readonly Attribute[],
): Promise<void> {
  const oldByName = new Map(previous.filter(item => item.value.kind === 'dynamic').map(item => [item.name, item]))
  const records: Record<string, unknown>[] = []
  for (const attribute of next) {
    if (attribute.value.kind !== 'dynamic') continue
    const old = oldByName.get(attribute.name)
    if (old?.value.kind !== 'dynamic') continue
    if (canonicalJson(old.value.spec) !== canonicalJson(attribute.value.spec)) continue
    if (old.value.cachedValue === undefined && old.value.lastError === undefined) continue
    records.push({
      name: attribute.name,
      ordinal: attribute.ordinal,
      ...(old.value.cachedValue !== undefined ? { cached_value: old.value.cachedValue } : {}),
      ...(old.value.cachedAt !== undefined ? { cached_at: old.value.cachedAt } : {}),
      ...(old.value.lastError !== undefined ? { last_error: old.value.lastError } : {}),
    })
  }
  if (records.length === 0) return
  await client.query(
    `update omb.attribute a
     set cached_value = c.cached_value, cached_at = c.cached_at, last_error = c.last_error
     from (
       select e->>'name' as name,
              coalesce((e->>'ordinal')::int, 0) as ordinal,
              e->'cached_value' as cached_value,
              (e->>'cached_at')::timestamptz as cached_at,
              e->>'last_error' as last_error
       from jsonb_array_elements($2::jsonb) as e
     ) as c
     where a.entity_id = $1 and a.name = c.name and a.ordinal = c.ordinal`,
    [entityId, jsonRecords(records)],
  )
}
