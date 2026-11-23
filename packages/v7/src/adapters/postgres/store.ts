import type { PoolClient } from 'pg'
import { newId } from '../../domain/ids.js'
import { tokenize } from '../../domain/text.js'
import type {
  Attribute,
  Entity,
  EntityKind,
  PatchEntityInput,
  StateStatus,
  StateVersion,
} from '../../domain/entity.js'
import { scopeOf } from '../../domain/entity.js'
import type { JsonValue } from '../../domain/json.js'
import type { Expansion, Link } from '../../domain/link.js'
import { OmbFailure, conflict, internal, notFound } from '../../domain/errors.js'
import { deriveReferences, deriveSearchText, deriveTriggers, type NormalizedWrite } from '../../domain/validation.js'
import type {
  ArtifactInput,
  ArtifactRecord,
  AuditEntry,
  AuditRecord,
  ChannelHit,
  DerivedWrite,
  EntitySummary,
  LinkResult,
  PatchResult,
  ReadOptions,
  ReferenceInput,
  RecallEventInput,
  ResidentTraceInput,
  RollbackResult,
  StateBoardSpec,
  Store,
  TextSearchSpec,
  TimeSearchSpec,
  TriggerSearchSpec,
  VectorSearchSpec,
  WriteResult,
} from '../../ports/store.js'
import { asNumber, asString, iso, PostgresDb } from './db.js'
import {
  buildViewValues,
  mapAttribute,
  mapEntity,
  type AttributeRow,
  type EntityRow,
  type ViewRow,
  type ViewValues,
} from './rows.js'

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

function nowIso(): string {
  return new Date().toISOString()
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

function mapPgError(error: unknown): OmbFailure {
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

async function insertTriggers(client: PoolClient, entityId: string, triggers: DerivedWrite['triggers']): Promise<void> {
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

async function replaceChainMembers(client: PoolClient, chainId: string, members: readonly string[], source: string): Promise<void> {
  await client.query('delete from omb.chain_member where chain_id = $1', [chainId])
  await insertChainMembers(client, chainId, members, source)
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
    if (JSON.stringify(old.value.spec) !== JSON.stringify(attribute.value.spec)) continue
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

type AttributeQuery = { query: PostgresDb['query'] }

function asAttributeQuery(client: PoolClient): AttributeQuery {
  return client as unknown as AttributeQuery
}

async function selectAttributes(queryable: AttributeQuery, entityId: string): Promise<Attribute[]> {
  const rows = await queryable.query<AttributeRow>(
    `select * from omb.attribute where entity_id = $1 order by ordinal asc, name asc`,
    [entityId],
  )
  return rows.rows.map(mapAttribute)
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

function toJson(value: unknown): JsonValue {
  return value as JsonValue
}

export class PostgresStore implements Store {
  readonly db: PostgresDb

  constructor(connectionString: string) {
    this.db = new PostgresDb({ connectionString })
  }

  async close(): Promise<void> {
    await this.db.close()
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw mapPgError(error)
    }
  }

  async write(input: NormalizedWrite, derived: DerivedWrite): Promise<WriteResult> {
    return this.run(async () => {
      const now = nowIso()
      const view = buildViewValues(input, derived, { now })
      return this.db.transaction(async client => {
        const archived = view.archivedAt !== null
        const entityResult = await client.query<EntityRow>(
          `insert into omb.entity (
             id, kind, revision, origin, confidence, pinned, salience, archived_at, archive_reason, is_current
           ) values ($1,$2,1,$3,$4,$5,0.5,$6,$7,true)
           returning *`,
          [input.id, input.kind, input.origin, input.confidence ?? null, input.pinned, view.archivedAt, archived ? 'auto-status' : null],
        )
        const entityRow = entityResult.rows[0]
        if (entityRow === undefined) throw new OmbFailure(internal('实体写入没有返回行'))
        await insertAttributes(client, input.id, input.attributes)
        await upsertRegistry(client, input.attributes)
        await replaceReferences(client, input.id, derived.references ?? deriveReferences(input.attributes))
        await insertTriggers(client, input.id, derived.triggers)
        if (input.kind === 'chain' && input.group !== undefined) {
          await assertChainMemberKinds(client, input.group)
          await insertChainMembers(client, input.id, input.group, input.origin)
        }
        await upsertView(client, view)
        const similar = await this.findSimilar(client, input, view)
        await insertAudit(client, {
          actor: input.origin,
          action: 'write',
          targetIds: [input.id],
          after: toJson({ id: input.id, kind: input.kind, revision: 1 }),
          inverse: toJson({ action: 'remove_written', entityId: input.id }),
        })
        return {
          entity: mapEntity(entityRow, input.attributes),
          ...similar,
        }
      })
    })
  }

  async findByAttribute(name: string, value: JsonValue, kind?: EntityKind): Promise<string | undefined> {
    return this.run(async () => {
      const params: unknown[] = [name, JSON.stringify(value)]
      const kindClause = kind === undefined ? '' : `and e.kind = $3`
      if (kind !== undefined) params.push(kind)
      const rows = await this.db.query<{ id: string }>(
        `select e.id
         from omb.entity e
         join omb.attribute a on a.entity_id = e.id
         where e.archived_at is null and a.name = $1 and a.value = $2::jsonb ${kindClause}
         order by e.updated_at desc
         limit 1`,
        params,
      )
      return rows.rows[0]?.id
    })
  }

  async get(id: string, options: ReadOptions = {}): Promise<Entity | undefined> {
    return this.run(async () => {
      const entityResult = await this.db.query<EntityRow>('select * from omb.entity where id = $1', [id])
      const row = entityResult.rows[0]
      if (row === undefined) return undefined
      if (row.archived_at !== null && options.includeArchived !== true) return undefined
      const attributes = await selectAttributes(this.db, id)
      const historyCount = row.kind === 'state'
        ? Number((await this.db.query<{ count: string }>('select count(*)::text as count from omb.entity where version_of = $1', [id])).rows[0]?.count ?? 0)
        : 0
      return mapEntity(row, attributes, historyCount)
    })
  }

  async patch(input: NormalizedWrite, patch: PatchEntityInput, derived: DerivedWrite): Promise<PatchResult> {
    return this.run(async () => {
      const now = nowIso()
      return this.db.transaction(async client => {
        const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [input.id])
        const current = currentResult.rows[0]
        if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${input.id}`))
        if (current.archived_at !== null) throw new OmbFailure({ code: 'archived', message: `实体已归档：${input.id}` })
        if (current.kind !== input.kind) throw new OmbFailure(conflict(`实体类型不能从 ${current.kind} 改为 ${input.kind}`))
        if (patch.expectedRevision !== undefined && Number(current.revision) !== patch.expectedRevision) {
          throw new OmbFailure(conflict(`实体版本已变化（期望 ${patch.expectedRevision}，实际 ${current.revision}）`))
        }
        const oldAttributes = await selectAttributes(asAttributeQuery(client), input.id)
        const oldEntity = mapEntity(current, oldAttributes)
        const oldScope = scopeOf(oldEntity)
        const scopeChanged = oldScope.kind !== input.scope.kind
          || (oldScope.kind === 'project' && input.scope.kind === 'project' && oldScope.projectKey !== input.scope.projectKey)
        if (scopeChanged) {
          throw new OmbFailure(conflict('补丁不能改变作用域'))
        }

        let history: StateVersion | undefined
        if (current.kind === 'state') {
          history = await this.snapshotState(client, current, oldAttributes, now)
        }

        await client.query('delete from omb.attribute where entity_id = $1', [input.id])
        await insertAttributes(client, input.id, input.attributes)
        await preserveDynamicCaches(client, input.id, oldAttributes, input.attributes)
        await replaceReferences(client, input.id, derived.references ?? deriveReferences(input.attributes))
        // trigger_key 也是派生数据；patch 必须整体替换，否则旧路径/错误签名会残留。
        await client.query('delete from omb.trigger_key where entity_id = $1', [input.id])
        await insertTriggers(client, input.id, derived.triggers)
        if (input.kind === 'chain' && input.group !== undefined) {
          await assertChainMemberKinds(client, input.group)
          await replaceChainMembers(client, input.id, input.group, input.origin)
        }
        const view = buildViewValues(input, derived, { now, revision: Number(current.revision) + 1 })
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
            view.archivedAt,
            view.archivedAt === null ? null : 'auto-status',
            input.origin,
          ],
        )
        const updated = updatedResult.rows[0]
        if (updated === undefined) throw new OmbFailure(internal('实体更新没有返回行'))
        await upsertView(client, view)
        await insertAudit(client, {
          actor: input.origin,
          action: 'patch',
          targetIds: [input.id],
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
            revision: Number(updated.revision),
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
        return { entity: mapEntity(updated, input.attributes), ...(history !== undefined ? { history } : {}) }
      })
    })
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
    const derived: DerivedWrite = {
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

  async archive(id: string, reason: string, actor: string): Promise<void> {
    await this.run(async () => {
      await this.db.transaction(async client => {
        const result = await client.query('update omb.entity set archived_at = now(), archive_reason = $2 where id = $1 and archived_at is null', [id, reason])
        if (result.rowCount === 0) return
        await client.query('update omb.entity_view set archived_at = now() where entity_id = $1', [id])
        await insertAudit(client, {
          actor,
          action: 'archive',
          targetIds: [id],
          after: toJson({ archived: true, reason }),
          inverse: toJson({ action: 'unarchive', entityId: id }),
        })
      })
    })
  }

  async unarchive(id: string, reason: string, actor: string): Promise<void> {
    await this.run(async () => {
      await this.db.transaction(async client => {
        const result = await client.query('update omb.entity set archived_at = null, archive_reason = null where id = $1 and archived_at is not null', [id])
        if (result.rowCount === 0) return
        await client.query('update omb.entity_view set archived_at = null where entity_id = $1', [id])
        await insertAudit(client, {
          actor,
          action: 'unarchive',
          targetIds: [id],
          after: toJson({ archived: false, reason }),
          inverse: toJson({ action: 'archive', entityId: id, reason: 'rollback-unarchive' }),
        })
      })
    })
  }

  async link(input: {
    fromId: string
    toId: string
    relation: string
    directed?: boolean
    strength?: number
    source?: string
    origin?: string
    allowArchived?: boolean
  }): Promise<LinkResult> {
    return this.run(async () => {
      if (input.fromId === input.toId) throw new OmbFailure(conflict('不能链接到自己'))
      const relation = input.relation.trim()
      if (relation.length === 0 || relation.length > 64) throw new OmbFailure(conflict('relation 必须是 1-64 字符'))
      return this.db.transaction(async client => {
        const endpoints = await client.query<EntityRow>(
          'select * from omb.entity where id = any($1::text[])',
          [[input.fromId, input.toId]],
        )
        if (endpoints.rowCount !== 2) throw new OmbFailure(notFound('链接端点不存在'))
        if (input.allowArchived !== true && endpoints.rows.some(row => row.archived_at !== null)) {
          throw new OmbFailure({ code: 'archived', message: '不能链接已归档实体' })
        }
        const directed = input.directed ?? true
        const existing = await client.query<LinkRow>(
          `select * from omb.link
           where relation = $3 and directed = $4 and archived_at is null
             and ((from_id = $1 and to_id = $2)
                  or ($4 = false and from_id = $2 and to_id = $1))`,
          [input.fromId, input.toId, relation, directed],
        )
        if (existing.rows[0] !== undefined) return { link: mapLink(existing.rows[0]), created: false }

        const id = newId('link')
        const strength = Math.max(0, Math.min(1, input.strength ?? 0.5))
        const inserted = await client.query<LinkRow>(
          `insert into omb.link (id, from_id, to_id, relation, directed, strength, source, origin)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           returning *`,
          [id, input.fromId, input.toId, relation, directed, strength, input.source ?? 'model', input.origin ?? 'model'],
        )
        const link = mapLink(inserted.rows[0] as LinkRow)
        await insertAudit(client, {
          actor: input.origin ?? 'model',
          action: 'link',
          targetIds: [input.fromId, input.toId],
          after: toJson({ linkId: link.id, relation, directed: link.directed }),
          inverse: toJson({ action: 'unlink', linkId: link.id }),
        })
        return { link, created: true }
      })
    })
  }

  async unlink(id: string, actor: string): Promise<void> {
    await this.run(async () => {
      await this.db.transaction(async client => {
        const result = await client.query<LinkRow>('update omb.link set archived_at = now() where id = $1 and archived_at is null returning *', [id])
        const row = result.rows[0]
        if (row === undefined) return
        if (row.relation === 'possible_conflict') {
          const [left, right] = row.from_id < row.to_id ? [row.from_id, row.to_id] : [row.to_id, row.from_id]
          await client.query(
            `insert into omb.conflict_suppression (pair_key, reason)
             values ($1, 'manual-unlink') on conflict (pair_key) do nothing`,
            [`${left}|${right}`],
          )
        }
        await insertAudit(client, {
          actor,
          action: 'unlink',
          targetIds: [row.from_id, row.to_id],
          after: toJson({ linkId: id, archived: true }),
          inverse: toJson({ action: 'restore_link', linkId: id }),
        })
      })
    })
  }

  async history(stateId: string, limit: number): Promise<StateVersion[]> {
    return this.run(async () => {
      const rows = await this.db.query<EntityRow>(
        'select * from omb.entity where version_of = $1 order by revision desc limit $2',
        [stateId, Math.max(1, Math.min(100, limit))],
      )
      return Promise.all(rows.rows.map(async row => {
        const attributes = await selectAttributes(this.db, row.id)
        return this.toStateVersion(row, stateId, attributes)
      }))
    })
  }

  private toStateVersion(row: EntityRow, stateId: string, attributes: readonly Attribute[]): StateVersion {
    const valueOf = (name: string): unknown => {
      const attribute = attributes.find(item => item.name === name)
      if (attribute === undefined) return undefined
      return attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
    }
    return {
      id: row.id,
      stateId,
      revision: Number(row.revision),
      status: (valueOf('status') as StateStatus | undefined) ?? 'not_started',
      title: typeof valueOf('title') === 'string' ? valueOf('title') as string : '',
      time: typeof valueOf('time') === 'string' ? valueOf('time') as string : '',
      attributes,
      ...(iso(row.archived_at) !== undefined ? { archivedAt: iso(row.archived_at) as string } : {}),
      createdAt: iso(row.created_at) as string,
    }
  }

  async expand(seeds: readonly string[], hops: 1 | 2, options: { includeArchived?: boolean } = {}): Promise<Expansion[]> {
    if (seeds.length === 0) return []
    return this.run(async () => {
      const linkRows = await this.db.query<{
        entity_id: string
        hop: number
        score: number
        via_link_id: string
        from_id: string
        relation: string
      }>(
        `with recursive walk (id, hop, score, via_link_id, from_id, relation, path) as (
           select seed, 0, 1.0, null::text, null::text, null::text, array[seed]
           from unnest($1::text[]) as seed
           union all
           select n.next_id,
                  w.hop + 1,
                  w.score * (case when w.hop = 0 then 0.5 else 0.25 end),
                  l.id,
                  w.id,
                  l.relation,
                  w.path || n.next_id
           from walk w
           join omb.link l on l.archived_at is null
             and (l.from_id = w.id or (not l.directed and l.to_id = w.id))
           cross join lateral (
             select case when l.from_id = w.id then l.to_id else l.from_id end as next_id
           ) n
           where w.hop < $2 and not (n.next_id = any(w.path))
         )
         select id as entity_id, min(hop) as hop, max(score) as score,
                (array_agg(via_link_id order by score desc))[1] as via_link_id,
                (array_agg(from_id order by score desc))[1] as from_id,
                (array_agg(relation order by score desc))[1] as relation
         from walk
         where hop > 0
         group by id
         order by score desc
         limit 100`,
        [seeds, hops],
      )

      const chainRows = await this.db.query<{ chain_id: string; member_id: string; seed_id: string }>(
        `with target_chains as (
           select chain_id from omb.chain_member where member_id = any($1::text[])
           union
           select id from unnest($1::text[]) as id
         )
         select cm.chain_id, cm.member_id, cm.chain_id as seed_id
         from omb.chain_member cm
         join target_chains tc on tc.chain_id = cm.chain_id
         where not (cm.member_id = any($1::text[]))`,
        [seeds],
      )

      const byId = new Map<string, Expansion>()
      for (const row of linkRows.rows) {
        byId.set(row.entity_id, {
          entityId: row.entity_id,
          hop: Number(row.hop),
          score: Number(row.score),
          viaLinkId: row.via_link_id,
          fromId: row.from_id,
          relation: row.relation,
        })
      }
      for (const row of chainRows.rows) {
        const existing = byId.get(row.member_id)
        const score = 0.4
        if (existing === undefined || existing.score < score) {
          byId.set(row.member_id, {
            entityId: row.member_id,
            hop: 1,
            score,
            viaLinkId: `chain:${row.chain_id}`,
            fromId: row.seed_id,
            relation: 'chain',
            chainId: row.chain_id,
          })
        } else if (existing.chainId === undefined) {
          byId.set(row.member_id, { ...existing, chainId: row.chain_id })
        }
      }
      if (options.includeArchived !== true && byId.size > 0) {
        const ids = [...byId.keys()]
        const active = await this.db.query<{ entity_id: string }>(
          'select entity_id from omb.entity_view where entity_id = any($1::text[]) and archived_at is null',
          [ids],
        )
        const activeIds = new Set(active.rows.map(row => row.entity_id))
        for (const id of ids) if (!activeIds.has(id)) byId.delete(id)
      }
      return [...byId.values()].sort((left, right) => right.score - left.score)
    })
  }

  async summaries(ids: readonly string[]): Promise<EntitySummary[]> {
    if (ids.length === 0) return []
    return this.run(async () => {
      const rows = await this.db.query<ViewRow & { history_count: number }>(
        `select v.*, (select count(*)::int from omb.entity h where h.version_of = v.entity_id) as history_count
         from omb.entity_view v
         where v.entity_id = any($1::text[])`,
        [ids],
      )
      return rows.rows.map(row => ({
        id: row.entity_id,
        kind: row.kind,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.category !== null ? { category: row.category } : {}),
        ...(row.status !== null ? { status: row.status } : {}),
        scope: row.scope === 'global' ? { kind: 'global' as const } : { kind: 'project' as const, projectKey: row.project_key },
        snippet: row.snippet,
        archived: row.archived_at !== null,
        isCurrent: row.is_current,
        ...(row.event_time === null ? {} : { eventTime: iso(row.event_time) as string }),
        updatedAt: iso(row.updated_at) as string,
        historyCount: Number(row.history_count),
      }))
    })
  }

  async preferenceSummaries(limit: number): Promise<EntitySummary[]> {
    return this.run(async () => {
      const rows = await this.db.query<ViewRow & { history_count: number }>(
        `select v.*, 0 as history_count
         from omb.entity_view v
         join omb.entity e on e.id = v.entity_id
         where v.kind = 'memory' and v.scope = 'global'
           and v.archived_at is null and v.is_current
           and (v.attrs @> '{"tags":["偏好"]}'::jsonb or v.attrs->>'标签' = '偏好')
         order by e.salience desc, v.updated_at desc
         limit $1`,
        [Math.max(1, Math.min(20, limit))],
      )
      return rows.rows.map(row => ({
        id: row.entity_id,
        kind: row.kind,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.category !== null ? { category: row.category } : {}),
        ...(row.status !== null ? { status: row.status } : {}),
        scope: { kind: 'global' as const },
        snippet: row.snippet,
        archived: false,
        isCurrent: true,
        ...(row.event_time === null ? {} : { eventTime: iso(row.event_time) as string }),
        updatedAt: iso(row.updated_at) as string,
        historyCount: 0,
      }))
    })
  }

  async upsertEmbedding(entityId: string, model: string, dims: number, embedding: readonly number[]): Promise<void> {
    if (embedding.length !== 512) throw new OmbFailure(internal('向量维度必须是 512'))
    await this.run(async () => {
      await this.db.query(
        `insert into omb.embedding (entity_id, model, dims, embedding)
         values ($1,$2,$3,$4::vector)
         on conflict (entity_id) do update
           set model = excluded.model, dims = excluded.dims, embedding = excluded.embedding, updated_at = now()`,
        [entityId, model, dims, `[${embedding.join(',')}]`],
      )
    })
  }

  async setAttributeCache(
    entityId: string,
    name: string,
    ordinal: number,
    value: JsonValue | undefined,
    cachedAt: string,
    error?: string,
  ): Promise<void> {
    await this.run(async () => {
      await this.db.transaction(async client => {
        const updated = await client.query(
          `update omb.attribute
           set cached_value = coalesce($4::jsonb, cached_value), cached_at = $5, last_error = $6
           where entity_id = $1 and name = $2 and ordinal = $3`,
          [entityId, name, ordinal, value === undefined ? null : JSON.stringify(value), cachedAt, error ?? null],
        )
        if (updated.rowCount === 0) return
        if (value !== undefined && error === undefined) {
          await client.query(
            `update omb.entity_view
             set attrs = jsonb_set(attrs, array[$2]::text[], $3::jsonb, true), updated_at = now()
             where entity_id = $1`,
            [entityId, name, JSON.stringify(value)],
          )
        } else {
          await client.query('update omb.entity_view set updated_at = now() where entity_id = $1', [entityId])
        }
      })
    })
  }

  async rebuildView(id: string): Promise<void> {
    await this.run(async () => {
      const entityResult = await this.db.query<EntityRow>('select * from omb.entity where id = $1', [id])
      const row = entityResult.rows[0]
      if (row === undefined) return
      const attributes = await selectAttributes(this.db, id)
      const entity = mapEntity(row, attributes)
      const input: NormalizedWrite = {
        id,
        kind: entity.kind === 'state_version' ? 'state' : entity.kind,
        scope: scopeOf(entity),
        origin: entity.origin,
        ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
        pinned: entity.pinned,
        attributes,
      }
      const derived = {
        searchText: deriveSearchText(attributes),
        triggers: deriveTriggers(attributes),
        references: deriveReferences(attributes),
      }
      const view = buildViewValues(input, derived, {
        now: new Date().toISOString(),
        isCurrent: entity.isCurrent,
        revision: entity.revision,
        archivedAt: entity.archivedAt ?? null,
        kindOverride: entity.kind,
      })
      await this.db.transaction(async client => {
        await upsertView(client, view)
        await replaceReferences(client, id, derived.references)
        await client.query('delete from omb.trigger_key where entity_id = $1', [id])
        await insertTriggers(client, id, derived.triggers)
      })
    })
  }

  async recordRecall(events: readonly RecallEventInput[]): Promise<void> {
    if (events.length === 0) return
    await this.run(async () => {
      for (const event of events) {
        await this.db.query(
          `insert into omb.recall_event (
             trace_id, session_id, turn_id, query, trigger, entity_id, channel, rank,
             raw_score, fused_score, injected, injected_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                     case when $11 then now() else null end)`,
          [
            event.traceId,
            event.sessionId ?? null,
            event.turnId ?? null,
            event.query ?? null,
            event.trigger ?? null,
            event.entityId,
            event.channel,
            event.rank,
            event.rawScore ?? null,
            event.fusedScore ?? null,
            event.injected,
          ],
        )
      }
    })
  }

  async recordResidentTrace(trace: ResidentTraceInput): Promise<void> {
    await this.run(async () => {
      await this.db.query(
        `insert into omb.resident_trace (
           trace_id, session_id, turn_id, budget_tokens, used_tokens, text, sections, dropped_sections
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[])
         on conflict (trace_id) do nothing`,
        [
          trace.traceId,
          trace.sessionId ?? null,
          trace.turnId ?? null,
          trace.budgetTokens,
          trace.usedTokens,
          trace.text,
          JSON.stringify(trace.sections),
          [...trace.droppedSections],
        ],
      )
    })
  }

  async markAccessed(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.run(async () => {
      await this.db.query(
        `update omb.entity
         set access_count = access_count + 1, last_accessed_at = now()
         where id = any($1::text[])`,
        [ids],
      )
    })
  }

  async markAdopted(traceId: string, entityId: string, kind: string): Promise<void> {
    await this.run(async () => {
      await this.db.transaction(async client => {
        const updated = await client.query(
          `update omb.recall_event
           set adopted_at = now(), adoption_kind = $3
           where trace_id = $1 and entity_id = $2 and adopted_at is null`,
          [traceId, entityId, kind],
        )
        if (updated.rowCount !== null && updated.rowCount > 0) {
          await client.query('update omb.entity set adoption_count = adoption_count + 1 where id = $1', [entityId])
        }
      })
    })
  }

  async recordArtifact(input: ArtifactInput): Promise<void> {
    await this.run(async () => {
      await this.db.query(
        `insert into omb.artifact (id, session_id, kind, content, source, metadata)
         values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (id) do nothing`,
        [
          input.id,
          input.sessionId ?? null,
          input.kind,
          input.content,
          input.source ?? 'dsh',
          input.metadata === undefined ? '{}' : JSON.stringify(input.metadata),
        ],
      )
    })
  }

  async listArtifacts(limit: number): Promise<ArtifactRecord[]> {
    return this.run(async () => {
      const rows = await this.db.query<{
        id: string
        session_id: string | null
        kind: string
        content: string
        source: string
        metadata: JsonValue
        created_at: Date | string
      }>(
        `select id, session_id, kind, content, source, metadata, created_at
         from omb.artifact where processed_at is null
         order by created_at asc limit $1`,
        [Math.max(1, Math.min(200, limit))],
      )
      return rows.rows.map(row => ({
        id: row.id,
        ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
        kind: row.kind,
        content: row.content,
        source: row.source,
        metadata: row.metadata,
        createdAt: iso(row.created_at) as string,
      }))
    })
  }

  async markArtifactProcessed(id: string): Promise<void> {
    await this.run(async () => {
      await this.db.query('update omb.artifact set processed_at = now() where id = $1', [id])
    })
  }

  async stats(): Promise<{
    memory: number
    state: number
    chain: number
    archived: number
    attrNames: readonly string[]
    categories: Record<'fact' | 'clue' | 'event', number>
    scopes: { global: number; project: number }
    recentStates: Array<{ id: string; title?: string; status: string }>
  }> {
    return this.run(async () => {
      const counts = await this.db.query<{ kind: string; count: string; archived: string }>(
        `select kind, count(*) filter (where archived_at is null)::text as count,
                count(*) filter (where archived_at is not null)::text as archived
         from omb.entity group by kind`,
      )
      const byKind = new Map(counts.rows.map(row => [row.kind, row]))
      const attrs = await this.db.query<{ name: string }>(
        'select name from omb.attr_registry order by usage_count desc, name asc limit 12',
      )
      const facets = await this.db.query<{ category: string | null; scope: string; count: string }>(
        `select category, scope, count(*)::text as count
         from omb.entity_view where archived_at is null group by category, scope`,
      )
      const categories = { fact: 0, clue: 0, event: 0 }
      const scopes = { global: 0, project: 0 }
      for (const row of facets.rows) {
        const count = Number(row.count)
        if (row.category === 'fact' || row.category === 'clue' || row.category === 'event') categories[row.category] += count
        if (row.scope === 'global') scopes.global += count
        else scopes.project += count
      }
      const states = await this.db.query<{ id: string; title: string | null; status: string }>(
        `select entity_id as id, title, status
         from omb.entity_view
         where kind = 'state' and archived_at is null and status is not null
         order by updated_at desc limit 3`,
      )
      return {
        memory: Number(byKind.get('memory')?.count ?? 0),
        state: Number(byKind.get('state')?.count ?? 0),
        chain: Number(byKind.get('chain')?.count ?? 0),
        archived: counts.rows.reduce((sum, row) => sum + Number(row.archived), 0),
        attrNames: attrs.rows.map(row => row.name),
        categories,
        scopes,
        recentStates: states.rows.map(row => ({
          id: row.id,
          ...(row.title !== null ? { title: row.title } : {}),
          status: row.status,
        })),
      }
    })
  }

  async listAudit(limit: number, targetId?: string): Promise<AuditRecord[]> {
    return this.run(async () => {
      const rows = await this.db.query<{
        id: string
        actor: string
        action: string
        target_ids: string[]
        inverse: JsonValue | null
        created_at: Date | string
        rolled_back_at: Date | string | null
      }>(
        `select id, actor, action, target_ids, inverse, created_at, rolled_back_at
         from omb.audit_log
         where ($2::text is null or $2 = any(target_ids))
         order by id desc limit $1`,
        [Math.max(1, Math.min(200, limit)), targetId ?? null],
      )
      return rows.rows.map(row => ({
        id: Number(row.id),
        actor: row.actor,
        action: row.action,
        targetIds: row.target_ids,
        ...(row.inverse !== null ? { inverse: row.inverse } : {}),
        createdAt: iso(row.created_at) as string,
        ...(iso(row.rolled_back_at) !== undefined ? { rolledBackAt: iso(row.rolled_back_at) as string } : {}),
      }))
    })
  }

  async rollback(auditId: number, actor: string): Promise<RollbackResult> {
    return this.run(async () => {
      return this.db.transaction(async client => {
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
            now: new Date().toISOString(),
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
            const row = raw as Record<string, JsonValue>
            const entityId = asString(row['entity_id'])
            if (entityId === undefined) continue
            entityIds.add(entityId)
            const list = grouped.get(entityId) ?? []
            list.push(row)
            grouped.set(entityId, list)
          }
          for (const entityId of entityIds) {
            await client.query('delete from omb.attribute where entity_id = $1 and name = any($2::text[])', [entityId, names])
            for (const row of grouped.get(entityId) ?? []) {
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
                  asString(row['name']) ?? from,
                  asNumber(row['ordinal']) ?? 0,
                  asString(row['value_kind']) ?? 'static',
                  row['value'] === null ? null : JSON.stringify(row['value']),
                  row['expr'] === null ? null : JSON.stringify(row['expr']),
                  row['cached_value'] === null ? null : JSON.stringify(row['cached_value']),
                  asString(row['cached_at']) ?? null,
                  asNumber(row['stale_after_ms']) ?? null,
                  asString(row['last_error']) ?? null,
                  row['is_required'] === true,
                  asNumber(row['confidence']) ?? null,
                  asString(row['source']) ?? 'model',
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
              now: new Date().toISOString(),
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
    })
  }

  // 检索通道由 search.ts 的独立查询实现，避免把图/融合逻辑塞进 Store。
  async fulltext(spec: TextSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchFulltext(spec))
  }

  async triggers(spec: TriggerSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchTriggers(spec))
  }

  async singleChar(spec: TextSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchSingleChar(spec))
  }

  async vector(spec: VectorSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchVector(spec))
  }

  async time(spec: TimeSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchTime(spec))
  }

  async stateBoard(spec: StateBoardSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchStateBoard(spec))
  }

  private scopeClause(spec: TextSearchSpec | VectorSearchSpec | TimeSearchSpec | StateBoardSpec | TriggerSearchSpec, params: unknown[]): string {
    const clauses: string[] = []
    if (spec.includeHistory !== true) clauses.push('v.is_current = true')
    if (spec.includeArchived !== true) clauses.push('v.archived_at is null')
    if (spec.kind !== undefined) {
      params.push(spec.kind)
      clauses.push(`v.kind = $${params.length}`)
    }
    if (spec.category !== undefined) {
      params.push(spec.category)
      clauses.push(`v.category = $${params.length}`)
    }
    if (spec.status !== undefined && spec.status.length > 0) {
      params.push(spec.status)
      clauses.push(`v.status = any($${params.length}::text[])`)
    }
    if (spec.scope === 'global') clauses.push(`v.scope = 'global'`)
    if (spec.scope === 'project') {
      clauses.push(`v.scope = 'project'`)
      if (spec.projectKey !== undefined) {
        params.push(spec.projectKey)
        clauses.push(`v.project_key = $${params.length}`)
      }
    }
    return clauses.length > 0 ? `and ${clauses.join(' and ')}` : ''
  }

  private async searchFulltext(spec: TextSearchSpec): Promise<ChannelHit[]> {
    if (spec.tokens.length === 0) return []
    const query = spec.tokens.join(' & ')
    const params: unknown[] = [query]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(100, spec.limit)))
    const rows = await this.db.query<{ entity_id: string; raw: number }>(
      `select v.entity_id, ts_rank_cd(v.search_tsv, q) as raw
       from omb.entity_view v, to_tsquery('simple', $1) q
       where v.search_tsv @@ q ${filter}
       order by raw desc, v.updated_at desc
       limit $${params.length}`,
      params,
    )
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'fulltext' }))
  }

  private async searchSingleChar(spec: TextSearchSpec): Promise<ChannelHit[]> {
    if (spec.query.trim().length === 0) return []
    const params: unknown[] = [spec.query.trim()]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(20, spec.limit)))
    const rows = await this.db.query<{ entity_id: string; raw: number }>(
      // datctype=C 的库里 similarity('中文','中') 恒为 0，不能拿它当 rawScore；
      // 单/双字查询按字符集合做 GIN 候选，再用 snippet 子串命中给确定分数。
      `select v.entity_id,
              case when v.snippet ilike '%' || $1 || '%' then 1.0 else 0.8 end as raw
       from omb.entity_view v
       where v.chars @> string_to_array($1, NULL)
         and v.snippet ilike '%' || $1 || '%' ${filter}
       order by raw desc, v.updated_at desc
       limit $${params.length}`,
      params,
    )
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'single_char' }))
  }

  private async searchVector(spec: VectorSearchSpec): Promise<ChannelHit[]> {
    if (spec.embedding.length !== 512) throw new OmbFailure(internal('向量维度必须是 512'))
    const params: unknown[] = [`[${spec.embedding.join(',')}]`]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(100, spec.limit)))
    return this.db.transaction(async client => {
      // pgvector 过滤在 HNSW 扫描之后发生；不开迭代扫描会静默少返回。
      await client.query("set local hnsw.iterative_scan = 'relaxed_order'")
      const rows = await client.query<{ entity_id: string; raw: number }>(
        `select v.entity_id, 1 - (e.embedding <=> $1::vector) as raw
         from omb.embedding e
         join omb.entity_view v on v.entity_id = e.entity_id
         where true ${filter}
         order by e.embedding <=> $1::vector
         limit $${params.length}`,
        params,
      )
      return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'vector' }))
    })
  }

  private async searchTime(spec: TimeSearchSpec): Promise<ChannelHit[]> {
    const params: unknown[] = [spec.from, spec.to, spec.now]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(100, spec.limit)))
    const rows = await this.db.query<{ entity_id: string; raw: number }>(
      `select v.entity_id,
              1.0 / (1.0 + greatest(0, extract(epoch from ($3::timestamptz - v.event_time)) / 86400.0 / 30.0)) as raw
       from omb.entity_view v
       where v.event_time >= $1::timestamptz and v.event_time <= $2::timestamptz ${filter}
       order by v.event_time desc
       limit $${params.length}`,
      params,
    )
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'time' }))
  }

  private async searchStateBoard(spec: StateBoardSpec): Promise<ChannelHit[]> {
    const params: unknown[] = [spec.now]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(50, spec.limit)))
    const rows = await this.db.query<{ entity_id: string; raw: number }>(
      `select v.entity_id,
              case v.status when 'blocked' then 1.0 when 'in_progress' then 0.9 when 'waiting' then 0.7 else 0.5 end
              + 0.1 / (1.0 + greatest(0, extract(epoch from ($1::timestamptz - v.event_time)) / 86400.0 / 30.0)) as raw
       from omb.entity_view v
       where v.kind = 'state' and v.status in ('in_progress','blocked','waiting') ${filter}
       order by raw desc, v.updated_at desc
       limit $${params.length}`,
      params,
    )
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'state_board' }))
  }

  private async searchTriggers(spec: TriggerSearchSpec): Promise<ChannelHit[]> {
    const scores = new Map<string, number>()
    if (spec.keys.length > 0) {
      const params: unknown[] = [spec.keys]
      const filter = this.scopeClause(spec, params)
      const rows = await this.db.query<{ entity_id: string; raw: number }>(
        `select t.entity_id, sum(t.weight) as raw
         from omb.trigger_key t
         join omb.entity_view v on v.entity_id = t.entity_id
         where t.key = any($1::text[]) ${filter}
         group by t.entity_id
         order by raw desc
         limit 50`,
        params,
      )
      for (const row of rows.rows) scores.set(row.entity_id, Math.max(scores.get(row.entity_id) ?? 0, Number(row.raw)))
    }
    if (spec.regexText !== undefined && spec.regexText.trim().length > 0) {
      const params: unknown[] = [spec.regexText]
      void params
      const filterParams: unknown[] = []
      const filter = this.scopeClause(spec, filterParams)
      const rows = await this.db.query<{ entity_id: string; key: string; weight: number }>(
        `select t.entity_id, t.key, t.weight
         from omb.trigger_key t
         join omb.entity_view v on v.entity_id = t.entity_id
         where t.kind = 'regex' ${filter}
         limit 500`,
        filterParams,
      )
      for (const row of rows.rows) {
        try {
          if (new RegExp(row.key).test(spec.regexText)) {
            scores.set(row.entity_id, Math.max(scores.get(row.entity_id) ?? 0, Number(row.weight) * 1.2))
          }
        } catch {
          // 写入时已校验正则；这里跳过损坏的历史行，不让单行拖垮通道。
        }
      }
    }
    return [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, Math.max(1, Math.min(50, spec.limit)))
      .map(([entityId, raw], index) => ({ entityId, rank: index + 1, rawScore: raw, channel: 'trigger' }))
  }

  private async findSimilar(
    client: PoolClient,
    input: NormalizedWrite,
    view: ViewValues,
  ): Promise<{ similarAttributes: WriteResult['similarAttributes']; similarEntities: WriteResult['similarEntities']; archivedMatches: WriteResult['similarEntities'] }> {
    const optionalNames = input.attributes.filter(attribute => !attribute.required).map(attribute => attribute.name)
    const attrs = optionalNames.length > 0
      ? await client.query<{ name: string; usage_count: number; similarity: number }>(
          `select r.name, r.usage_count, max(similarity(r.name, q.name)) as similarity
           from omb.attr_registry r
           cross join unnest($1::text[]) as q(name)
           where similarity(r.name, q.name) >= 0.35
           group by r.name, r.usage_count
           order by similarity desc, r.usage_count desc
           limit 10`,
          [optionalNames],
        )
      : { rows: [] as { name: string; usage_count: number; similarity: number }[] }

    const optionalText = input.attributes
      .filter(attribute => !attribute.required)
      .map(attribute => attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue)
      .filter((value): value is NonNullable<typeof value> => value !== undefined)
      .map(value => typeof value === 'string' ? value : JSON.stringify(value))
      .join('\n')
    const search = optionalText.slice(0, 240) || view.title || ''
    // 只从可选属性取查询词；snippet 含必填分类（事实/fact），会把任意两条记忆都判成相似。
    // 共享至少两个长度 >=2 的 token 才算相似：共同分类/单字噪声不够。
    const similarTokens = tokenize(optionalText, 64).filter(token => token.length >= 2)
    const similarQuery = similarTokens.join(' | ')
    const minShared = Math.min(2, similarTokens.length)
    const active = similarTokens.length === 0
      ? { rows: [] as (ViewRow & { similarity: number })[] }
      : await client.query<ViewRow & { similarity: number }>(
        `select v.*, similarity(v.snippet, $4) as similarity
         from omb.entity_view v
         where v.entity_id <> $1 and v.kind = $2 and v.archived_at is null
           and v.search_tsv @@ to_tsquery('simple', $3)
           and (
             select count(*) from unnest(string_to_array(v.search_text, ' ')) as t(token)
             where t.token = any($5::text[])
           ) >= $6
         order by similarity(v.snippet, $4) desc, v.updated_at desc
         limit 8`,
        [input.id, input.kind, similarQuery, search, similarTokens, minShared],
      )
    const archived = similarTokens.length === 0
      ? { rows: [] as (ViewRow & { similarity: number })[] }
      : await client.query<ViewRow & { similarity: number }>(
        `select v.*, similarity(v.snippet, $4) as similarity
         from omb.entity_view v
         where v.entity_id <> $1 and v.kind = $2 and v.archived_at is not null
           and v.search_tsv @@ to_tsquery('simple', $3)
           and (
             select count(*) from unnest(string_to_array(v.search_text, ' ')) as t(token)
             where t.token = any($5::text[])
           ) >= $6
         order by similarity(v.snippet, $4) desc, v.updated_at desc
         limit 3`,
        [input.id, input.kind, similarQuery, search, similarTokens, minShared],
      )

    const toSimilar = (row: ViewRow & { similarity?: number }): WriteResult['similarEntities'][number] => ({
      id: row.entity_id,
      kind: row.kind,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.category !== null ? { category: row.category } : {}),
      ...(row.status !== null ? { status: row.status } : {}),
      scope: row.scope === 'global' ? { kind: 'global' } : { kind: 'project', projectKey: row.project_key },
      archived: row.archived_at !== null,
      score: Number(asNumber(row.similarity) ?? 0),
      reason: row.archived_at !== null ? 'archived-similar' : 'text-or-attribute-overlap',
    })

    return {
      similarAttributes: attrs.rows.map(row => ({ name: row.name, usageCount: Number(row.usage_count), similarity: Number(row.similarity) })),
      similarEntities: active.rows.map(toSimilar),
      archivedMatches: archived.rows.map(row => ({ ...toSimilar(row), score: 1 })),
    }
  }
}
