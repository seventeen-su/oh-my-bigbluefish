import type { PoolClient } from 'pg'
import type {
  Attribute,
  PatchEntityInput,
  StateStatus,
  StateVersion,
} from '../../domain/entity.js'
import { scopeOf } from '../../domain/entity.js'
import { OmbFailure, conflict, internal, notFound } from '../../domain/errors.js'
import { newId } from '../../domain/ids.js'
import { isPlainObject, type JsonValue } from '../../domain/json.js'
import type { Link, LinkInput } from '../../domain/link.js'
import { deriveReferences, deriveSearchText, deriveTriggers, type NormalizedWrite } from '../../domain/validation.js'
import type { AuditEntry, ReferenceInput, RollbackResult } from '../../ports/store.js'
import {
  duplicateCommandFailure,
  type CommandMeta,
  type CommandOutcome,
  type CommandWriter,
  type DomainEvent,
  type DomainEventType,
  type PreparedCommand,
  type ProjectionToken,
} from '../../app/commands/index.js'
import { asNumber, asString, iso, PostgresDb } from './db.js'
import { notifyOutbox } from './outbox.js'
import {
  autoArchivedAt,
  buildViewValues,
  mapAttribute,
  mapEntity,
  type AttributeRow,
  type EntityRow,
  type ViewValues,
} from './rows.js'

/**
 * AttributeWriter：`entity`/`attribute`/`entity_view`/`link`/`chain_member`/`audit`/`outbox`
 * 的唯一事务入口（ADR-0007）。
 *
 * 固定写事务：
 *   CAS（或 create insert）→ 属性批量写 → 从属性行派生 view/触发键/引用 → link/chain
 *   → 追加审计事件（含 stream/command 元数据）→ 追加 outbox。（同事务、短事务）
 *
 * 事务内不做相似查询、不嵌入、不调用 LLM；相似建议/嵌入/看板由 outbox 之后的异步投影负责。
 * `Store` 只保留读路径与计数器，写方法全部委托到这里。
 *
 * 唯一的业务表写入例外（review Task 7b 的直写点清单，均不写 attribute/entity_view/link/chain_member）：
 * - `Store.markAccessed`/`markAdopted`：只自增 `entity.access_count/adoption_count` 与
 *   `last_accessed_at`（遥测计数器，不派生属性/视图、不 bump revision）。走命令路径会让每次召回都
 *   写审计+事件并推进版本，制造 CAS 冲突与 outbox 噪声，故保留为显式例外。
 * - `PostgresJobFailureLog`（jobs.ts）：任务最终失败/恢复的运维审计（无 inverse、非业务变更）。
 * - `PostgresOutboxStore.append`：outbox 端口自身的写入入口；writer 的 insertEvent 在同一事务里
 *   写 outbox 并 `pg_notify`。
 */

interface LinkRow {
  id: string
  from_id: string
  to_id: string
  relation: string
  directed: boolean
  strength: number
  source: string
  origin: string
  created_at: Date | string
  archived_at: Date | string | null
}

/** 允许在事务内直接 query 的最小接口（Pool 与 PoolClient 都满足）。 */
export type AttributeQuery = { query: PostgresDb['query'] }

export function nowIso(): string {
  return new Date().toISOString()
}

export function mapPgError(error: unknown): OmbFailure {
  if (error instanceof OmbFailure) return error
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = typeof record['code'] === 'string' ? record['code'] : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (code === '23505') return new OmbFailure(conflict(message))
  if (code === '23503') return new OmbFailure(conflict(message))
  if (code === '57014') return new OmbFailure({ code: 'db-unavailable', message: `数据库语句超时：${message}`, retryable: true })
  if (code === 'ECONNREFUSED' || code === '57P01' || code === '08006') {
    return new OmbFailure({ code: 'db-unavailable', message: `数据库不可用：${message}`, retryable: true })
  }
  return new OmbFailure(internal(message))
}

function mapLink(row: LinkRow): Link {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation,
    directed: row.directed,
    strength: row.strength,
    source: row.source,
    origin: row.origin,
    createdAt: iso(row.created_at) as string,
    ...(iso(row.archived_at) !== undefined ? { archivedAt: iso(row.archived_at) as string } : {}),
  }
}

function toJson(value: unknown): JsonValue {
  return value as JsonValue
}

/**
 * 动态 spec 的规范 JSON。`jsonb` 会按 key 长度重排对象键，
 * 不能用 `JSON.stringify` 的插入顺序比较（否则同 spec 永远被当成变化，patch 丢缓存）。
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** patch 重新插入属性时保留同名、同 spec 动态属性的缓存；spec 变了才丢弃。 */
async function preserveDynamicCaches(
  client: PoolClient,
  entityId: string,
  previous: readonly Attribute[],
  next: readonly Attribute[],
): Promise<void> {
  const oldByName = new Map(previous.filter(item => item.value.kind === 'dynamic').map(item => [item.name, item]))
  for (const attribute of next) {
    if (attribute.value.kind !== 'dynamic') continue
    const old = oldByName.get(attribute.name)
    if (old?.value.kind !== 'dynamic') continue
    if (canonicalJson(old.value.spec) !== canonicalJson(attribute.value.spec)) continue
    if (old.value.cachedValue === undefined && old.value.lastError === undefined) continue
    await client.query(
      `update omb.attribute
       set cached_value = $3::jsonb, cached_at = $4, last_error = $5
       where entity_id = $1 and name = $2 and ordinal = $6`,
      [
        entityId,
        attribute.name,
        old.value.cachedValue === undefined ? null : JSON.stringify(old.value.cachedValue),
        old.value.cachedAt ?? null,
        old.value.lastError ?? null,
        attribute.ordinal,
      ],
    )
  }
}

async function insertAttributes(client: PoolClient, entityId: string, attributes: readonly Attribute[]): Promise<void> {
  for (const attribute of attributes) {
    const value = attribute.value
    await client.query(
      `insert into omb.attribute (
         entity_id, name, ordinal, value_kind, value, expr, cached_value, cached_at,
         stale_after_ms, last_error, is_required, confidence, source
       ) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
      [
        entityId,
        attribute.name,
        attribute.ordinal,
        value.kind,
        value.kind === 'static' ? JSON.stringify(value.value) : null,
        value.kind === 'dynamic' ? JSON.stringify(value.spec) : null,
        value.kind === 'dynamic' && value.cachedValue !== undefined ? JSON.stringify(value.cachedValue) : null,
        value.kind === 'dynamic' && value.cachedAt !== undefined ? value.cachedAt : null,
        value.kind === 'dynamic' && value.staleAfterMs !== undefined ? value.staleAfterMs : null,
        value.kind === 'dynamic' && value.lastError !== undefined ? value.lastError : null,
        attribute.required,
        attribute.confidence ?? null,
        attribute.source,
      ],
    )
  }
}

async function upsertRegistry(client: PoolClient, attributes: readonly Attribute[]): Promise<void> {
  for (const attribute of attributes) {
    if (attribute.required) continue
    await client.query(
      `insert into omb.attr_registry (name, value_kind, usage_count)
       values ($1,$2,1)
       on conflict (name) do update
         set usage_count = omb.attr_registry.usage_count + 1,
             last_seen = now(),
             value_kind = excluded.value_kind`,
      [attribute.name, attribute.value.kind],
    )
  }
}

async function insertTriggers(client: PoolClient, entityId: string, triggers: readonly { readonly kind: string; readonly key: string; readonly weight: number }[]): Promise<void> {
  for (const trigger of triggers) {
    await client.query(
      `insert into omb.trigger_key (entity_id, kind, key, weight)
       values ($1,$2,$3,$4)
       on conflict (entity_id, kind, key) do update set weight = greatest(omb.trigger_key.weight, excluded.weight)`,
      [entityId, trigger.kind, trigger.key, trigger.weight],
    )
  }
}

async function replaceReferences(client: PoolClient, entityId: string, references: readonly ReferenceInput[]): Promise<void> {
  await client.query('delete from omb.reference where source_entity_id = $1', [entityId])
  for (const reference of references) {
    await client.query(
      `insert into omb.reference (
         source_entity_id, source_attr_name, source_ordinal, target_entity_id, target_attr_name, kind
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict do nothing`,
      [
        entityId,
        reference.sourceAttrName,
        reference.sourceOrdinal,
        reference.targetEntityId,
        reference.targetAttrName ?? '',
        reference.kind,
      ],
    )
  }
}

async function insertChainMembers(client: PoolClient, chainId: string, members: readonly string[], source: string): Promise<void> {
  for (const [position, memberId] of members.entries()) {
    await client.query(
      `insert into omb.chain_member (chain_id, member_id, position, source)
       values ($1,$2,$3,$4)
       on conflict (chain_id, member_id) do update set position = excluded.position`,
      [chainId, memberId, position, source],
    )
  }
}

async function replaceChainMembers(client: PoolClient, chainId: string, members: readonly string[], source: string): Promise<void> {
  await client.query('delete from omb.chain_member where chain_id = $1', [chainId])
  await insertChainMembers(client, chainId, members, source)
}

/**
 * 思维链成员只能是记忆、状态机或状态历史；链不能嵌套链。
 * 先查 entity 再插 chain_member：FK 只保证存在，不保证 kind。
 */
async function assertChainMemberKinds(client: PoolClient, members: readonly string[]): Promise<void> {
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
function buildViewFromRows(
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
async function rebuildViewFromRows(client: PoolClient, entityId: string, now: string): Promise<void> {
  const entityResult = await client.query<EntityRow>('select * from omb.entity where id = $1', [entityId])
  const row = entityResult.rows[0]
  if (row === undefined) return
  const attributes = await selectAttributes(asAttributeQuery(client), entityId)
  const { view, triggers } = buildViewFromRows(row, attributes, now, iso(row.archived_at) ?? null)
  await client.query('delete from omb.trigger_key where entity_id = $1', [entityId])
  await insertTriggers(client, entityId, triggers)
  await upsertView(client, view)
}

async function upsertView(client: PoolClient, view: ViewValues): Promise<void> {
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

async function insertAudit(client: PoolClient, entry: AuditEntry): Promise<number> {
  const result = await client.query<{ id: string }>(
    `insert into omb.audit_log (actor, action, target_ids, before, after, inverse, job_id)
     values ($1,$2,$3::text[],$4::jsonb,$5::jsonb,$6::jsonb,$7)
     returning id`,
    [
      entry.actor,
      entry.action,
      [...(entry.targetIds ?? [])],
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.inverse === undefined ? null : JSON.stringify(entry.inverse),
      entry.jobId ?? null,
    ],
  )
  return Number(result.rows[0]?.id ?? 0)
}

interface EventInput {
  readonly meta: CommandMeta
  readonly action: string
  readonly eventType: DomainEventType
  readonly streamId: string
  readonly streamVersion: number
  readonly targetIds: readonly string[]
  readonly payload: Record<string, JsonValue>
  readonly before?: JsonValue
  readonly after?: JsonValue
  readonly inverse?: JsonValue
}

/**
 * 追加一条领域事件：audit_log（含 command/stream 元数据）+ outbox 同一事务写入。
 * `event.id` 取 audit_log.id，重复命令重放时 id 不变（event_id 稳定）。
 */
async function insertEvent(client: PoolClient, input: EventInput): Promise<DomainEvent> {
  const result = await client.query<{ id: string; created_at: Date | string }>(
    `insert into omb.audit_log (
       actor, action, target_ids, before, after, inverse, job_id,
       command_id, stream_id, stream_version, event_type, revision,
       correlation_id, causation_id, actor_kind
     ) values ($1,$2,$3::text[],$4::jsonb,$5::jsonb,$6::jsonb,null,
       $7,$8,$9,$10,$11,$12,$13,$14)
     returning id, created_at`,
    [
      input.meta.actor.id,
      input.action,
      [...input.targetIds],
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.inverse === undefined ? null : JSON.stringify(input.inverse),
      input.meta.commandId,
      input.streamId,
      input.streamVersion,
      input.eventType,
      input.streamVersion,
      input.meta.correlationId,
      input.meta.causationId ?? null,
      input.meta.actor.kind,
    ],
  )
  const row = result.rows[0]
  if (row === undefined) throw new OmbFailure(internal('事件写入没有返回行'))
  const id = Number(row.id)
  const event: DomainEvent = {
    id: String(id),
    seq: id,
    streamId: input.streamId,
    streamVersion: input.streamVersion,
    type: input.eventType,
    actor: input.meta.actor,
    origin: input.meta.origin,
    occurredAt: iso(row.created_at) as string,
    payload: input.payload,
    ...(input.inverse !== undefined ? { inverse: input.inverse } : {}),
  }
  // outbox.event_id 唯一：事务内一次事件只入队一次，reconciliation 重复扫描不会产生第二行。
  const outbox = await client.query<{ id: string }>(
    `insert into omb.outbox (event_id, topic, payload)
     values ($1,$2,$3::jsonb)
     on conflict (event_id) do nothing
     returning id`,
    [id, input.eventType, JSON.stringify(event)],
  )
  // 只有真正插入 outbox 行时才通知：NOTIFY 与 outbox 行在同一事务里，PG 在提交时才投递、
  // 回滚则提示一起消失；同一 event_id 的重复入队（对账/重放）不会重复唤醒 relay。
  if (outbox.rows[0] !== undefined) await notifyOutbox(client, id)
  return event
}

/** 同一 stream 的版本必须唯一（008 部分唯一索引）：在聚合行锁内取下一个版本。 */
async function nextStreamVersion(client: PoolClient, streamId: string): Promise<number> {
  const result = await client.query<{ next: string }>(
    'select coalesce(max(stream_version), 0) + 1 as next from omb.audit_log where stream_id = $1',
    [streamId],
  )
  return Number(result.rows[0]?.next ?? 1)
}

function projectionToken(entityId: string, revision: number, event: DomainEvent | undefined): ProjectionToken {
  return { entityId, revision, watermark: event?.id ?? '' }
}

function noopOutcome(entityId: string): CommandOutcome {
  return { events: [], revision: 0, projectionToken: { entityId, revision: 0, watermark: '' } }
}

function payloadEntityId(payload: Record<string, JsonValue>, fallback: string): string {
  const value = payload['entityId']
  return typeof value === 'string' ? value : fallback
}

function isDuplicateCommandFailure(error: unknown): boolean {
  if (!(error instanceof OmbFailure)) return false
  const details = error.error.details
  return isPlainObject(details) && details['duplicateCommand'] === true
}

function isDuplicateCommandViolation(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  return record['code'] === '23505' && record['constraint'] === 'audit_log_command_unique'
}

/** 冲突是领域结果：带上 currentRevision，命令总线据此让调用方重读重试。 */
function revisionConflict(expected: number | undefined, currentRevision: number): OmbFailure {
  const detail = expected === undefined ? `当前 ${currentRevision}` : `期望 ${expected}，实际 ${currentRevision}`
  return new OmbFailure({
    code: 'conflict',
    message: `实体版本已变化（${detail}）`,
    details: { currentRevision },
  })
}

export class AttributeWriter implements CommandWriter {
  constructor(private readonly db: PostgresDb) {}

  /**
   * 命令单事务入口。幂等：
   * 1. 先按 commandId 取事务级 advisory lock（只串行化同一命令，不同实体/不同命令不排队）；
   * 2. 锁内复查 audit_log.command_id（等第一个事务提交后能看到它）；
   * 3. 唯一索引兜底：并发重复提交撞 `audit_log_command_unique` 时转成重复信号。
   */
  async execute(command: PreparedCommand, meta: CommandMeta): Promise<CommandOutcome> {
    try {
      return await this.db.transaction(async client => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [meta.commandId])
        const seen = await client.query('select 1 from omb.audit_log where command_id = $1', [meta.commandId])
        if ((seen.rowCount ?? 0) > 0) throw new OmbFailure(duplicateCommandFailure(meta.commandId))
        return await this.dispatch(client, command, meta)
      })
    } catch (error) {
      if (isDuplicateCommandFailure(error) || isDuplicateCommandViolation(error)) {
        throw new OmbFailure(duplicateCommandFailure(meta.commandId))
      }
      throw mapPgError(error)
    }
  }

  /** 重复 commandId 的首次结果：从审计行 + outbox payload 还原（不再写任何表）。 */
  async result(commandId: string): Promise<CommandOutcome | undefined> {
    try {
      const rows = await this.db.query<{
        id: string
        stream_id: string | null
        stream_version: string | null
        payload: JsonValue | null
      }>(
        `select a.id::text as id, a.stream_id, a.stream_version, o.payload
         from omb.audit_log a
         left join omb.outbox o on o.event_id = a.id
         where a.command_id = $1
         order by a.id asc
         limit 1`,
        [commandId],
      )
      const row = rows.rows[0]
      if (row === undefined) return undefined
      const revision = Number(row.stream_version ?? 0)
      const payload = isPlainObject(row.payload) ? row.payload as Record<string, JsonValue> : undefined
      const entityId = payload === undefined ? row.stream_id ?? '' : payloadEntityId(payload, row.stream_id ?? '')
      const events: DomainEvent[] = payload === undefined ? [] : [payload as unknown as DomainEvent]
      return {
        events,
        revision,
        projectionToken: { entityId, revision, watermark: row.id },
      }
    } catch (error) {
      throw mapPgError(error)
    }
  }

  private async dispatch(client: PoolClient, command: PreparedCommand, meta: CommandMeta): Promise<CommandOutcome> {
    switch (command.type) {
      case 'CreateEntity':
        return this.createEntity(client, command.input, meta)
      case 'PatchEntity':
        return this.patchEntity(client, command.input, command.patch, meta)
      case 'ArchiveEntity':
        return this.archiveEntity(client, command.id, command.reason, meta)
      case 'UnarchiveEntity':
        return this.unarchiveEntity(client, command.id, command.reason, meta)
      case 'Link':
        return this.createLink(client, command.input, meta)
      case 'Unlink':
        return this.unlink(client, command.linkId, meta)
      case 'RenameAttribute':
        return this.renameAttribute(client, command, meta)
    }
  }

  private async createEntity(client: PoolClient, input: NormalizedWrite, meta: CommandMeta): Promise<CommandOutcome> {
    const now = nowIso()
    // attribute 有 entity 外键，entity 必须先插入；归档时间只由属性行里的 status 决定。
    const archivedAt = autoArchivedAt(input.kind, input.attributes, now)
    const archived = archivedAt !== null
    const entityResult = await client.query<EntityRow>(
      `insert into omb.entity (
         id, kind, revision, origin, confidence, pinned, salience, archived_at, archive_reason, is_current
       ) values ($1,$2,1,$3,$4,$5,0.5,$6,$7,true)
       returning *`,
      [input.id, input.kind, meta.origin, input.confidence ?? null, input.pinned, archivedAt, archived ? 'auto-status' : null],
    )
    const entityRow = entityResult.rows[0]
    if (entityRow === undefined) throw new OmbFailure(internal('实体写入没有返回行'))
    await insertAttributes(client, input.id, input.attributes)
    await upsertRegistry(client, input.attributes)
    // trigger_key/reference/entity_view 都从同一事务内读回的属性行派生（唯一真源）。
    const persisted = await selectAttributes(asAttributeQuery(client), input.id)
    await replaceReferences(client, input.id, deriveReferences(persisted))
    await insertTriggers(client, input.id, deriveTriggers(persisted))
    if (input.kind === 'chain' && input.group !== undefined) {
      await assertChainMemberKinds(client, input.group)
      await insertChainMembers(client, input.id, input.group, meta.origin)
    }
    const { view } = buildViewFromRows(entityRow, persisted, now, archivedAt)
    await upsertView(client, view)
    const revision = Number(entityRow.revision)
    const payload: Record<string, JsonValue> = { entityId: input.id, entityKind: input.kind, revision }
    const event = await insertEvent(client, {
      meta,
      action: 'write',
      eventType: 'EntityCreated',
      streamId: input.id,
      streamVersion: revision,
      targetIds: [input.id],
      payload,
      after: toJson({ id: input.id, kind: input.kind, revision }),
      inverse: toJson({ action: 'remove_written', entityId: input.id }),
    })
    return {
      events: [event],
      revision,
      projectionToken: projectionToken(payloadEntityId(payload, input.id), revision, event),
      entity: mapEntity(entityRow, persisted),
    }
  }

  private async patchEntity(
    client: PoolClient,
    input: NormalizedWrite,
    patch: PatchEntityInput,
    meta: CommandMeta,
  ): Promise<CommandOutcome> {
    const now = nowIso()
    const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [input.id])
    const current = currentResult.rows[0]
    if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${input.id}`))
    if (current.archived_at !== null) throw new OmbFailure({ code: 'archived', message: `实体已归档：${input.id}` })
    if (current.kind !== input.kind) throw new OmbFailure(conflict(`实体类型不能从 ${current.kind} 改为 ${input.kind}`))
    if (patch.expectedRevision !== undefined && Number(current.revision) !== patch.expectedRevision) {
      throw revisionConflict(patch.expectedRevision, Number(current.revision))
    }
    const oldAttributes = await selectAttributes(asAttributeQuery(client), input.id)
    const oldEntity = mapEntity(current, oldAttributes)
    const oldScope = scopeOf(oldEntity)
    const scopeChanged = oldScope.kind !== input.scope.kind
      || (oldScope.kind === 'project' && input.scope.kind === 'project' && oldScope.projectKey !== input.scope.projectKey)
    if (scopeChanged) throw new OmbFailure(conflict('补丁不能改变作用域'))

    let history: StateVersion | undefined
    if (current.kind === 'state') history = await this.snapshotState(client, current, oldAttributes, now)

    await client.query('delete from omb.attribute where entity_id = $1', [input.id])
    await insertAttributes(client, input.id, input.attributes)
    await preserveDynamicCaches(client, input.id, oldAttributes, input.attributes)
    // 唯一真源是属性行：preserveDynamicCaches 写回缓存后再读回，视图/触发键/引用都从这里派生。
    const persisted = await selectAttributes(asAttributeQuery(client), input.id)
    await replaceReferences(client, input.id, deriveReferences(persisted))
    // trigger_key 也是派生数据；patch 必须整体替换，否则旧路径/错误签名会残留。
    await client.query('delete from omb.trigger_key where entity_id = $1', [input.id])
    await insertTriggers(client, input.id, deriveTriggers(persisted))
    if (input.kind === 'chain' && input.group !== undefined) {
      await assertChainMemberKinds(client, input.group)
      await replaceChainMembers(client, input.id, input.group, meta.origin)
    }
    // 自动归档由状态机 status 决定；先落 entity 再按最终行派生视图，版本号与归档列保持一致。
    const archivedAt = autoArchivedAt(input.kind, persisted, now)
    const updatedResult = await client.query<EntityRow>(
      `update omb.entity
       set revision = revision + 1,
           confidence = $2,
           pinned = $3,
           archived_at = $4,
           archive_reason = $5,
           origin = $6,
           updated_at = now()
       where id = $1
       returning *`,
      [
        input.id,
        input.confidence ?? current.confidence,
        input.pinned,
        archivedAt,
        archivedAt === null ? null : 'auto-status',
        meta.origin,
      ],
    )
    const updated = updatedResult.rows[0]
    if (updated === undefined) throw new OmbFailure(internal('实体更新没有返回行'))
    const { view } = buildViewFromRows(updated, persisted, now, archivedAt)
    await upsertView(client, view)
    const revision = Number(updated.revision)
    const payload: Record<string, JsonValue> = {
      entityId: input.id,
      entityKind: input.kind,
      revision,
      attributes: persisted.filter(item => !item.required).map(item => item.name),
    }
    const event = await insertEvent(client, {
      meta,
      action: 'patch',
      eventType: 'EntityPatched',
      streamId: input.id,
      streamVersion: revision,
      targetIds: [input.id],
      payload,
      before: toJson({
        revision: Number(current.revision),
        attributes: oldAttributes,
        pinned: current.pinned,
        confidence: current.confidence,
        origin: current.origin,
        archivedAt: iso(current.archived_at) ?? null,
        archiveReason: current.archive_reason,
      }),
      after: toJson({
        revision,
        attributes: input.attributes,
        pinned: updated.pinned,
        confidence: updated.confidence,
        origin: updated.origin,
        archivedAt: iso(updated.archived_at) ?? null,
        archiveReason: updated.archive_reason,
      }),
      inverse: toJson({
        action: 'restore',
        entityId: input.id,
        revision: Number(current.revision),
        attributes: oldAttributes,
        pinned: current.pinned,
        confidence: current.confidence,
        origin: current.origin,
        archivedAt: iso(current.archived_at) ?? null,
        archiveReason: current.archive_reason,
      }),
    })
    return {
      events: [event],
      revision,
      projectionToken: projectionToken(input.id, revision, event),
      entity: mapEntity(updated, input.attributes),
      ...(history !== undefined ? { history } : {}),
    }
  }

  private async snapshotState(
    client: PoolClient,
    current: EntityRow,
    attributes: readonly Attribute[],
    now: string,
  ): Promise<StateVersion> {
    const versionId = newId('stateVersion')
    const currentEntity = mapEntity(current, attributes)
    const scope = scopeOf(currentEntity)
    const snapshotInput: NormalizedWrite = {
      id: versionId,
      kind: 'state',
      scope,
      origin: current.origin,
      ...(current.confidence !== null ? { confidence: current.confidence } : {}),
      pinned: current.pinned,
      attributes,
    }
    const derived = {
      searchText: deriveSearchText(attributes),
      triggers: deriveTriggers(attributes),
    }
    const view = buildViewValues(snapshotInput, derived, {
      now,
      isCurrent: false,
      revision: Number(current.revision),
      archivedAt: null,
      kindOverride: 'state_version',
    })
    const versionResult = await client.query<EntityRow>(
      `insert into omb.entity (
         id, kind, revision, origin, confidence, pinned, salience, version_of, is_current
       ) values ($1,'state_version',$2,$3,$4,$5,$6,$7,false)
       returning *`,
      [versionId, Number(current.revision), current.origin, current.confidence, current.pinned, current.salience, current.id],
    )
    const versionRow = versionResult.rows[0]
    if (versionRow === undefined) throw new OmbFailure(internal('状态历史写入没有返回行'))
    await insertAttributes(client, versionId, attributes)
    await replaceReferences(client, versionId, deriveReferences(attributes))
    await upsertView(client, view)
    return {
      id: versionId,
      stateId: current.id,
      revision: Number(current.revision),
      status: (attributes.find(item => item.name === 'status')?.value as { value?: StateStatus } | undefined)?.value ?? 'not_started',
      title: String((attributes.find(item => item.name === 'title')?.value as { value?: string } | undefined)?.value ?? ''),
      time: String((attributes.find(item => item.name === 'time')?.value as { value?: string } | undefined)?.value ?? ''),
      attributes,
      createdAt: iso(versionRow.created_at) as string,
    }
  }

  private async archiveEntity(client: PoolClient, id: string, reason: string, meta: CommandMeta): Promise<CommandOutcome> {
    const expected = meta.expectedRevision
    const updated = expected === undefined
      ? await client.query<EntityRow>(
        `update omb.entity
         set revision = revision + 1, archived_at = now(), archive_reason = $2, updated_at = now()
         where id = $1 and archived_at is null
         returning *`,
        [id, reason],
      )
      : await client.query<EntityRow>(
        `update omb.entity
         set revision = revision + 1, archived_at = now(), archive_reason = $2, updated_at = now()
         where id = $1 and archived_at is null and revision = $3
         returning *`,
        [id, reason, expected],
      )
    const row = updated.rows[0]
    if (row === undefined) {
      const current = await this.currentEntity(client, id)
      if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${id}`))
      // 已归档或版本已前进：带 expectedRevision 的命令返回可恢复冲突；旧路径保持静默 no-op。
      if (expected === undefined) return noopOutcome(id)
      throw revisionConflict(expected, Number(current.revision))
    }
    const revision = Number(row.revision)
    await client.query('update omb.entity_view set archived_at = now(), revision = $2 where entity_id = $1', [id, revision])
    const payload: Record<string, JsonValue> = { entityId: id, kind: row.kind, reason, revision }
    const event = await insertEvent(client, {
      meta,
      action: 'archive',
      eventType: 'EntityArchived',
      streamId: id,
      streamVersion: revision,
      targetIds: [id],
      payload,
      after: toJson({ archived: true, reason }),
      inverse: toJson({ action: 'unarchive', entityId: id }),
    })
    return { events: [event], revision, projectionToken: projectionToken(id, revision, event) }
  }

  private async unarchiveEntity(client: PoolClient, id: string, reason: string, meta: CommandMeta): Promise<CommandOutcome> {
    const expected = meta.expectedRevision
    const updated = expected === undefined
      ? await client.query<EntityRow>(
        `update omb.entity
         set revision = revision + 1, archived_at = null, archive_reason = null, updated_at = now()
         where id = $1 and archived_at is not null
         returning *`,
        [id],
      )
      : await client.query<EntityRow>(
        `update omb.entity
         set revision = revision + 1, archived_at = null, archive_reason = null, updated_at = now()
         where id = $1 and archived_at is not null and revision = $2
         returning *`,
        [id, expected],
      )
    const row = updated.rows[0]
    if (row === undefined) {
      const current = await this.currentEntity(client, id)
      if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${id}`))
      if (expected === undefined) return noopOutcome(id)
      throw revisionConflict(expected, Number(current.revision))
    }
    const revision = Number(row.revision)
    await client.query('update omb.entity_view set archived_at = null, revision = $2 where entity_id = $1', [id, revision])
    const payload: Record<string, JsonValue> = { entityId: id, kind: row.kind, reason, revision }
    const event = await insertEvent(client, {
      meta,
      action: 'unarchive',
      eventType: 'EntityUnarchived',
      streamId: id,
      streamVersion: revision,
      targetIds: [id],
      payload,
      after: toJson({ archived: false, reason }),
      inverse: toJson({ action: 'archive', entityId: id, reason: 'rollback-unarchive' }),
    })
    return { events: [event], revision, projectionToken: projectionToken(id, revision, event) }
  }

  private async createLink(client: PoolClient, input: LinkInput, meta: CommandMeta): Promise<CommandOutcome> {
    if (input.fromId === input.toId) throw new OmbFailure(conflict('不能链接到自己'))
    const relation = input.relation.trim()
    if (relation.length === 0 || relation.length > 64) throw new OmbFailure(conflict('relation 必须是 1-64 字符'))
    const endpoints = await client.query<EntityRow>(
      'select * from omb.entity where id = any($1::text[])',
      [[input.fromId, input.toId]],
    )
    if (endpoints.rowCount !== 2) throw new OmbFailure(notFound('链接端点不存在'))
    if (input.allowArchived !== true && endpoints.rows.some(row => row.archived_at !== null)) {
      throw new OmbFailure({ code: 'archived', message: '不能链接已归档实体' })
    }
    if (meta.expectedRevision !== undefined) {
      const from = endpoints.rows.find(row => row.id === input.fromId)
      if (from === undefined) throw new OmbFailure(notFound(`链接端点不存在：${input.fromId}`))
      if (Number(from.revision) !== meta.expectedRevision) throw revisionConflict(meta.expectedRevision, Number(from.revision))
    }
    const directed = input.directed ?? true
    const existing = await client.query<LinkRow>(
      `select * from omb.link
       where relation = $3 and directed = $4 and archived_at is null
         and ((from_id = $1 and to_id = $2)
              or ($4 = false and from_id = $2 and to_id = $1))`,
      [input.fromId, input.toId, relation, directed],
    )
    const existingRow = existing.rows[0]
    if (existingRow !== undefined) {
      return { ...noopOutcome(input.fromId), link: mapLink(existingRow), linkCreated: false }
    }

    const id = newId('link')
    const strength = Math.max(0, Math.min(1, input.strength ?? 0.5))
    const inserted = await client.query<LinkRow>(
      `insert into omb.link (id, from_id, to_id, relation, directed, strength, source, origin)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [id, input.fromId, input.toId, relation, directed, strength, input.source ?? 'model', input.origin ?? meta.origin],
    )
    const link = mapLink(inserted.rows[0] as LinkRow)
    const payload: Record<string, JsonValue> = {
      entityId: input.fromId,
      linkId: link.id,
      fromId: link.fromId,
      toId: link.toId,
      relation: link.relation,
      directed: link.directed,
      strength: link.strength,
    }
    // `link` 是独立聚合：create=1；用 max+1 而不是常数，rollback restore_link 之后再次取消也不会撞唯一索引。
    const streamVersion = await nextStreamVersion(client, link.id)
    const event = await insertEvent(client, {
      meta,
      action: 'link',
      eventType: 'LinkCreated',
      streamId: link.id,
      streamVersion,
      targetIds: [input.fromId, input.toId],
      payload,
      after: toJson({ linkId: link.id, relation, directed: link.directed }),
      inverse: toJson({ action: 'unlink', linkId: link.id }),
    })
    return {
      events: [event],
      revision: streamVersion,
      projectionToken: projectionToken(input.fromId, streamVersion, event),
      link,
      linkCreated: true,
    }
  }

  private async unlink(client: PoolClient, id: string, meta: CommandMeta): Promise<CommandOutcome> {
    const result = await client.query<LinkRow>(
      'update omb.link set archived_at = now(), updated_at = now() where id = $1 and archived_at is null returning *',
      [id],
    )
    const row = result.rows[0]
    if (row === undefined) return noopOutcome('')
    if (row.relation === 'possible_conflict') {
      const [left, right] = row.from_id < row.to_id ? [row.from_id, row.to_id] : [row.to_id, row.from_id]
      await client.query(
        `insert into omb.conflict_suppression (pair_key, reason)
         values ($1, 'manual-unlink') on conflict (pair_key) do nothing`,
        [`${left}|${right}`],
      )
    }
    const payload: Record<string, JsonValue> = {
      entityId: row.from_id,
      linkId: row.id,
      fromId: row.from_id,
      toId: row.to_id,
      relation: row.relation,
    }
    // `link` 是独立聚合：unlink 在 link 行锁内取 max+1，rollback 后再次 unlink 也不会撞 stream 唯一索引。
    const streamVersion = await nextStreamVersion(client, row.id)
    const event = await insertEvent(client, {
      meta,
      action: 'unlink',
      eventType: 'LinkUnlinked',
      streamId: row.id,
      streamVersion,
      targetIds: [row.from_id, row.to_id],
      payload,
      after: toJson({ linkId: id, archived: true }),
      inverse: toJson({ action: 'restore_link', linkId: id }),
    })
    return { events: [event], revision: streamVersion, projectionToken: projectionToken(row.from_id, streamVersion, event) }
  }

  /**
   * 属性改名（CommandBus / 维护入口共用的唯一事务路径）。
   *
   * 同事务：属性行 → attr_registry → 引用 → 每个受影响实体的 view/触发键（版本 +1）。
   * 改名不产生新的必填属性；`from`/`to` 必须是非必填名。
   * 维护入口（attr-alias 归并）沿用历史审计标签 `attr-alias`，见 `PreparedCommand.RenameAttribute`。
   */
  private async renameAttribute(
    client: PoolClient,
    command: { readonly from: string; readonly to: string; readonly reason: string; readonly auditAction?: 'rename-attr' | 'attr-alias' },
    meta: CommandMeta,
  ): Promise<CommandOutcome> {
    const { from, to, reason } = command
    // 同一个 from→to 的并发改名必须串行，否则两边会算出同一个 stream_version。
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`omb:rename-attr:${from}->${to}`])
    const affected = await client.query<{ entity_id: string }>(
      'select distinct entity_id from omb.attribute where name = $1 order by entity_id asc',
      [from],
    )
    const entityIds = affected.rows.map(row => row.entity_id)
    if (entityIds.length === 0) return noopOutcome(from)
    const before = await client.query<Record<string, unknown>>(
      `select entity_id, name, ordinal, value_kind, value, expr, cached_value, cached_at,
              stale_after_ms, last_error, is_required, confidence, source
       from omb.attribute where name in ($1, $2) order by entity_id, name, ordinal`,
      [from, to],
    )
    await client.query(
      `delete from omb.attribute f
       using omb.attribute t
       where f.entity_id = t.entity_id and f.name = $1 and t.name = $2`,
      [from, to],
    )
    await client.query('update omb.attribute set name = $2, updated_at = now() where name = $1', [from, to])
    const canonical = await client.query('select 1 from omb.attr_registry where name = $1', [to])
    if (canonical.rowCount === 0) {
      await client.query('update omb.attr_registry set name = $2, last_seen = now() where name = $1', [from, to])
      await client.query('update omb.attr_registry set aliases = array_append(aliases, $1) where name = $2', [from, to])
    } else {
      await client.query(
        `update omb.attr_registry
         set aliases = array_append(aliases, $1),
             usage_count = usage_count + coalesce((select usage_count from omb.attr_registry where name = $1), 0),
             last_seen = now()
         where name = $2`,
        [from, to],
      )
      await client.query('delete from omb.attr_registry where name = $1', [from])
    }
    const now = nowIso()
    for (const entityId of entityIds) {
      const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [entityId])
      const current = currentResult.rows[0]
      if (current === undefined) continue
      const attributes = await selectAttributes(asAttributeQuery(client), entityId)
      const updatedResult = await client.query<EntityRow>(
        'update omb.entity set revision = revision + 1, updated_at = now() where id = $1 returning *',
        [entityId],
      )
      const updated = updatedResult.rows[0] ?? current
      const { view, triggers, references } = buildViewFromRows(updated, attributes, now, iso(updated.archived_at) ?? null)
      await replaceReferences(client, entityId, references)
      await client.query('delete from omb.trigger_key where entity_id = $1', [entityId])
      await insertTriggers(client, entityId, triggers)
      await upsertView(client, view)
    }
    const streamId = `attr:${from}->${to}`
    const streamVersion = await nextStreamVersion(client, streamId)
    const payload: Record<string, JsonValue> = {
      entityId: entityIds[0] ?? streamId,
      from,
      to,
      reason,
      entityIds,
      revision: streamVersion,
    }
    const event = await insertEvent(client, {
      meta,
      action: command.auditAction ?? 'rename-attr',
      eventType: 'AttributeRenamed',
      streamId,
      streamVersion,
      targetIds: entityIds,
      payload,
      after: toJson({ from, to, affected: entityIds.length }),
      inverse: toJson({ action: 'restore_attr_rows', from, to, rows: before.rows }),
    })
    return {
      events: [event],
      revision: streamVersion,
      projectionToken: projectionToken(entityIds[0] ?? streamId, streamVersion, event),
      entityIds,
    }
  }

  private async currentEntity(client: PoolClient, id: string): Promise<EntityRow | undefined> {
    const result = await client.query<EntityRow>('select * from omb.entity where id = $1', [id])
    return result.rows[0]
  }

  /** 动态缓存写回（`setAttributeCache`）：属性行 + view/触发键同事务。 */
  async setAttributeCache(
    entityId: string,
    name: string,
    ordinal: number,
    value: JsonValue | undefined,
    cachedAt: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.db.transaction(async client => {
        const updated = await client.query(
          `update omb.attribute
           set cached_value = coalesce($4::jsonb, cached_value), cached_at = $5, last_error = $6
           where entity_id = $1 and name = $2 and ordinal = $3`,
          [entityId, name, ordinal, value === undefined ? null : JSON.stringify(value), cachedAt, error ?? null],
        )
        if (updated.rowCount === 0) return
        if (value !== undefined && error === undefined) {
          // 动态缓存值是检索文本的一部分：与属性行同事务重建 search_text/chars/snippet 与触发键。
          await rebuildViewFromRows(client, entityId, cachedAt)
        } else {
          await client.query('update omb.entity_view set updated_at = now() where entity_id = $1', [entityId])
        }
      })
    } catch (error) {
      throw mapPgError(error)
    }
  }

  /** 视图重建入口：只读属性行（唯一真源）重建 view/触发键/引用。 */
  async rebuildView(id: string): Promise<void> {
    const now = nowIso()
    try {
      await this.db.transaction(async client => {
        // 行锁 + 同一事务读属性行，避免重建窗口里读到半更新状态（VIEW 必须可由属性表重建）。
        const entityResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [id])
        const row = entityResult.rows[0]
        if (row === undefined) return
        const attributes = await selectAttributes(asAttributeQuery(client), id)
        const { view, triggers, references } = buildViewFromRows(row, attributes, now, iso(row.archived_at) ?? null)
        await client.query('delete from omb.trigger_key where entity_id = $1', [id])
        await insertTriggers(client, id, triggers)
        await replaceReferences(client, id, references)
        await upsertView(client, view)
      })
    } catch (error) {
      throw mapPgError(error)
    }
  }

  /** 审计回滚（维护入口）：只回滚单条审计的 inverse，写 audit/view/属性，仍在同一短事务内。 */
  async rollback(auditId: number, actor: string): Promise<RollbackResult> {
    try {
      return await this.db.transaction(async client => {
        const result = await client.query<{
          id: string
          inverse: JsonValue | null
          target_ids: string[]
          rolled_back_at: Date | string | null
        }>('select id, inverse, target_ids, rolled_back_at from omb.audit_log where id = $1 for update', [auditId])
        const row = result.rows[0]
        if (row === undefined) throw new OmbFailure(notFound(`审计记录不存在：${auditId}`))
        if (row.rolled_back_at !== null) throw new OmbFailure(conflict(`审计记录已回滚：${auditId}`))
        if (row.inverse === null || typeof row.inverse !== 'object' || Array.isArray(row.inverse)) {
          throw new OmbFailure(internal(`审计记录没有可执行 inverse：${auditId}`))
        }
        const inverse = row.inverse as Record<string, JsonValue>
        const action = asString(inverse['action'])
        const applied: string[] = []
        if (action === 'unarchive') {
          const id = asString(inverse['entityId'])
          if (id === undefined) throw new OmbFailure(internal('inverse 缺少 entityId'))
          await client.query('update omb.entity set archived_at = null, archive_reason = null where id = $1', [id])
          await client.query('update omb.entity_view set archived_at = null where entity_id = $1', [id])
          applied.push(`unarchive:${id}`)
        } else if (action === 'archive') {
          const id = asString(inverse['entityId'])
          if (id === undefined) throw new OmbFailure(internal('inverse 缺少 entityId'))
          await client.query('update omb.entity set archived_at = now(), archive_reason = $2 where id = $1', [id, asString(inverse['reason']) ?? 'rollback'])
          await client.query('update omb.entity_view set archived_at = now() where entity_id = $1', [id])
          applied.push(`archive:${id}`)
        } else if (action === 'unlink') {
          const linkId = asString(inverse['linkId'])
          if (linkId === undefined) throw new OmbFailure(internal('inverse 缺少 linkId'))
          await client.query('update omb.link set archived_at = now() where id = $1', [linkId])
          applied.push(`unlink:${linkId}`)
        } else if (action === 'restore_link') {
          const linkId = asString(inverse['linkId'])
          if (linkId === undefined) throw new OmbFailure(internal('inverse 缺少 linkId'))
          await client.query('update omb.link set archived_at = null where id = $1', [linkId])
          applied.push(`restore_link:${linkId}`)
        } else if (action === 'remove_written') {
          const entityId = asString(inverse['entityId'])
          if (entityId === undefined) throw new OmbFailure(internal('inverse 缺少 entityId'))
          await client.query("update omb.entity set archived_at = now(), archive_reason = 'rollback-write' where id = $1", [entityId])
          await client.query('update omb.entity_view set archived_at = now() where entity_id = $1', [entityId])
          applied.push(`remove_written:${entityId}`)
        } else if (action === 'restore') {
          const entityId = asString(inverse['entityId'])
          const attributes = inverse['attributes']
          const revision = asNumber(inverse['revision'])
          if (entityId === undefined || !Array.isArray(attributes) || revision === undefined) {
            throw new OmbFailure(internal('restore inverse 缺少 entityId/attributes/revision'))
          }
          const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [entityId])
          const current = currentResult.rows[0]
          if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${entityId}`))
          const restored = attributes as unknown as Attribute[]
          const oldEntity = mapEntity(current, restored)
          const archivedAt = inverse['archivedAt'] === null
            ? null
            : asString(inverse['archivedAt']) ?? iso(current.archived_at) ?? null
          const archiveReason = inverse['archiveReason'] === null
            ? null
            : asString(inverse['archiveReason']) ?? (archivedAt === null ? null : current.archive_reason)
          const pinned = typeof inverse['pinned'] === 'boolean' ? inverse['pinned'] : current.pinned
          const confidence = inverse['confidence'] === null
            ? null
            : asNumber(inverse['confidence']) ?? current.confidence
          const origin = asString(inverse['origin']) ?? current.origin
          const normalized: NormalizedWrite = {
            id: entityId,
            kind: current.kind === 'state_version' ? 'state' : current.kind,
            scope: scopeOf(oldEntity),
            origin,
            ...(confidence !== null ? { confidence } : {}),
            pinned,
            attributes: restored,
          }
          const derived = {
            searchText: deriveSearchText(restored),
            triggers: deriveTriggers(restored),
            references: deriveReferences(restored),
          }
          await client.query('delete from omb.attribute where entity_id = $1', [entityId])
          await insertAttributes(client, entityId, restored)
          await replaceReferences(client, entityId, derived.references)
          // trigger_key 是派生数据；回滚属性后必须同步重建，否则旧触发键会继续命中。
          await client.query('delete from omb.trigger_key where entity_id = $1', [entityId])
          await insertTriggers(client, entityId, derived.triggers)
          if (current.kind === 'chain') {
            const groupAttr = restored.find(attribute => attribute.name === 'group')
            const group = groupAttr?.value.kind === 'static' && Array.isArray(groupAttr.value.value)
              ? groupAttr.value.value.filter((item): item is string => typeof item === 'string')
              : []
            if (group.length > 0) {
              await assertChainMemberKinds(client, group)
              await replaceChainMembers(client, entityId, group, origin)
            }
          }
          const view = buildViewValues(normalized, derived, {
            now: nowIso(),
            isCurrent: current.is_current,
            revision: Math.max(Number(current.revision), revision) + 1,
            archivedAt,
            kindOverride: current.kind,
          })
          await client.query(
            `update omb.entity
             set revision = $2, confidence = $3, pinned = $4, origin = $5,
                 archived_at = $6, archive_reason = $7, updated_at = now()
             where id = $1`,
            [
              entityId,
              Math.max(Number(current.revision), revision) + 1,
              confidence,
              pinned,
              origin,
              archivedAt,
              archiveReason,
            ],
          )
          await upsertView(client, view)
          applied.push(`restore:${entityId}`)
        } else if (action === 'restore_attr_rows') {
          const from = asString(inverse['from'])
          const to = asString(inverse['to'])
          const rows = inverse['rows']
          if (from === undefined || to === undefined || !Array.isArray(rows)) {
            throw new OmbFailure(internal('restore_attr_rows inverse 缺少 from/to/rows'))
          }
          const names = [from, to]
          const entityIds = new Set<string>()
          const grouped = new Map<string, Record<string, JsonValue>[]>()
          for (const raw of rows) {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
            const record = raw as Record<string, JsonValue>
            const entityId = asString(record['entity_id'])
            if (entityId === undefined) continue
            entityIds.add(entityId)
            const list = grouped.get(entityId) ?? []
            list.push(record)
            grouped.set(entityId, list)
          }
          for (const entityId of entityIds) {
            await client.query('delete from omb.attribute where entity_id = $1 and name = any($2::text[])', [entityId, names])
            for (const record of grouped.get(entityId) ?? []) {
              await client.query(
                `insert into omb.attribute (
                   entity_id, name, ordinal, value_kind, value, expr, cached_value, cached_at,
                   stale_after_ms, last_error, is_required, confidence, source
                 ) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13)
                 on conflict (entity_id, name, ordinal) do update set
                   value_kind = excluded.value_kind, value = excluded.value, expr = excluded.expr,
                   cached_value = excluded.cached_value, cached_at = excluded.cached_at,
                   stale_after_ms = excluded.stale_after_ms, last_error = excluded.last_error,
                   is_required = excluded.is_required, confidence = excluded.confidence, source = excluded.source`,
                [
                  entityId,
                  asString(record['name']) ?? from,
                  asNumber(record['ordinal']) ?? 0,
                  asString(record['value_kind']) ?? 'static',
                  record['value'] === null ? null : JSON.stringify(record['value']),
                  record['expr'] === null ? null : JSON.stringify(record['expr']),
                  record['cached_value'] === null ? null : JSON.stringify(record['cached_value']),
                  asString(record['cached_at']) ?? null,
                  asNumber(record['stale_after_ms']) ?? null,
                  asString(record['last_error']) ?? null,
                  record['is_required'] === true,
                  asNumber(record['confidence']) ?? null,
                  asString(record['source']) ?? 'model',
                ],
              )
            }
          }
          for (const entityId of entityIds) {
            const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [entityId])
            const current = currentResult.rows[0]
            if (current === undefined) continue
            const attributes = await selectAttributes(asAttributeQuery(client), entityId)
            const restoredEntity = mapEntity(current, attributes)
            const normalized: NormalizedWrite = {
              id: entityId,
              kind: (current.kind === 'state_version' ? 'state' : current.kind) as 'memory' | 'state' | 'chain',
              scope: scopeOf(restoredEntity),
              origin: current.origin,
              ...(current.confidence !== null ? { confidence: current.confidence } : {}),
              pinned: current.pinned,
              attributes,
            }
            const derived = {
              searchText: deriveSearchText(attributes),
              triggers: deriveTriggers(attributes),
              references: deriveReferences(attributes),
            }
            const view = buildViewValues(normalized, derived, {
              now: nowIso(),
              isCurrent: current.is_current,
              revision: Number(current.revision),
              archivedAt: current.archived_at === null ? null : iso(current.archived_at) ?? null,
              kindOverride: current.kind,
            })
            await client.query('delete from omb.trigger_key where entity_id = $1', [entityId])
            await insertTriggers(client, entityId, derived.triggers)
            await replaceReferences(client, entityId, derived.references)
            await upsertView(client, view)
            applied.push(`restore_attr_rows:${entityId}`)
          }
        } else {
          throw new OmbFailure({ code: 'unsupported', message: `暂不支持回滚 inverse 动作：${String(action)}` })
        }
        await client.query('update omb.audit_log set rolled_back_at = now() where id = $1', [auditId])
        const rollbackAuditId = await insertAudit(client, {
          actor,
          action: 'rollback',
          targetIds: [...row.target_ids],
          before: toJson({ auditId }),
          after: toJson({ applied }),
          inverse: toJson({ action: 'rollback-of-rollback', auditId }),
        })
        return { auditId, rollbackAuditId, applied }
      })
    } catch (error) {
      throw mapPgError(error)
    }
  }
}
