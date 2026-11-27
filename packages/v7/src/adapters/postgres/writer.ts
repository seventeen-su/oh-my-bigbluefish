import type { PoolClient } from 'pg'
import type { Attribute, Entity, PatchEntityInput, StateStatus, StateVersion } from '../../domain/entity.js'
import { scopeOf } from '../../domain/entity-access.js'
import { OmbFailure, conflict, internal, notFound } from '../../domain/errors.js'
import { newId } from '../../domain/ids.js'
import { isPlainObject, type JsonValue } from '../../domain/json.js'
import { deriveReferences, deriveSearchText, deriveTriggers, type NormalizedWrite } from '../../domain/validation.js'
import type { RollbackResult } from '../../ports/observability.js'
import {
  duplicateCommandFailure,
  type CommandMeta,
  type CommandOutcome,
  type CommandWriter,
  type DomainEvent,
  type PreparedCommand,
} from '../../app/commands/index.js'
import type { ProjectionName } from '../../app/projections/types.js'
import type { ProjectionTaskStore } from '../../app/projections/tasks.js'
import { iso, PostgresDb } from './db.js'
import { boardProjectionsFor, boardProjectionsForRename, PostgresProjectionTaskStore } from './projection.js'
import { autoArchivedAt, buildViewValues, mapEntity, type EntityRow } from './rows.js'
import { insertEvent, nextStreamVersion } from './writer-audit.js'
import { createLinkCommand, unlinkCommand } from './writer-links.js'
import { rollbackAudit } from './writer-rollback.js'
import {
  mapPgError,
  noopOutcome,
  nowIso,
  payloadEntityId,
  projectionToken,
  revisionConflict,
  toJson,
} from './writer-support.js'
import {
  asAttributeQuery,
  assertChainMemberKinds,
  buildViewFromRows,
  insertAttributes,
  insertChainMembers,
  insertTriggers,
  preserveDynamicCaches,
  rebuildViewFromRows,
  replaceChainMembers,
  replaceReferences,
  selectAttributes,
  upsertRegistry,
  upsertView,
} from './writer-tables.js'

function isDuplicateCommandFailure(error: unknown): boolean {
  if (!(error instanceof OmbFailure)) return false
  const details = error.error.details
  return isPlainObject(details) && details['duplicateCommand'] === true
}

function isDuplicateCommandViolation(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  return record['code'] === '23505' && record['constraint'] === 'audit_log_command_unique'
}

/**
 * AttributeWriter：`entity`/`attribute`/`entity_view`/`link`/`chain_member`/`audit`/`outbox`
 * 的唯一事务入口（ADR-0007）。
 *
 * 固定写事务：
 *   CAS（或 create insert）→ 属性批量写 → 从属性行派生 view/触发键/引用 → link/chain
 *   → 对已注册看板投影 upsert `projection_task` → 追加审计事件（含 stream/command 元数据）
 *   → 追加 outbox。（同事务、短事务）
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

export interface AttributeWriterOptions {
  /**
   * 投影任务队列。默认构造一个共享同一 `PostgresDb` 的适配器：组合根（plugin）无法触达
   * PostgresStore 内部 writer，而 writer 是唯一业务写入口，只有在这里入队才能保证同一事务。
   * 注入只用于错误路径测试（证明 enqueue 失败会回滚整个写事务）。
   */
  readonly projectionTasks?: ProjectionTaskStore
}

export class AttributeWriter implements CommandWriter {
  private readonly projectionTasks: ProjectionTaskStore

  constructor(private readonly db: PostgresDb, options: AttributeWriterOptions = {}) {
    this.projectionTasks = options.projectionTasks ?? new PostgresProjectionTaskStore(db)
  }

  /**
   * 写事务内 upsert 已注册投影任务：与 entity/attribute/view/audit/outbox 同一个 `client`，
   * 任一后续写入失败时由同一个事务一起回滚；同 revision 重放由 store 的 `where revision <`
   * 吸收，重复 commandId 不会产生第二次任务。
   *
   * 多个 entity 用于 patch 这类“写前/写后都可能属于看板”的命令：写前属于看板时也要入队，
   * projector 才能按写入后的谓词删除陈旧读模型行。
   */
  private async enqueueProjections(
    client: PoolClient,
    entityId: string,
    revision: number,
    entities: readonly Entity[],
    options: { readonly archived?: boolean } = {},
  ): Promise<void> {
    const projections = new Set<ProjectionName>()
    for (const entity of entities) {
      for (const projection of boardProjectionsFor(entity, options)) projections.add(projection)
    }
    await this.enqueueProjectionTasks(client, entityId, revision, projections)
  }

  /** 直接入队一组投影（rename 需要与改名后的谓词无关地重新判定）。 */
  private async enqueueProjectionTasks(
    client: PoolClient,
    entityId: string,
    revision: number,
    projections: Iterable<ProjectionName>,
  ): Promise<void> {
    const unique = new Set(projections)
    for (const projection of unique) {
      await this.projectionTasks.enqueue({ entityId, projection, revision }, client)
    }
  }

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
        return createLinkCommand(client, command.input, meta)
      case 'Unlink':
        return unlinkCommand(client, command.linkId, meta)
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
    const persistedEntity = mapEntity(entityRow, persisted)
    // 入队放在事件之前：后续 audit/outbox 写入失败时任务行随事务一起回滚。
    await this.enqueueProjections(client, input.id, revision, [persistedEntity])
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
      entity: persistedEntity,
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
    // 写前/写后都传：之前属于看板、之后不属于时要让 projector 收到 revision 去删旧行。
    await this.enqueueProjections(client, input.id, revision, [oldEntity, mapEntity(updated, persisted)])
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
    // 归档前属于看板时入队：projector 按归档后的谓词删除读模型行。
    // 只有 memory/state 参与看板，链/历史版本不为它们白查一次属性行。
    if (row.kind === 'memory' || row.kind === 'state') {
      const attributes = await selectAttributes(asAttributeQuery(client), id)
      // 传入的是已归档的行；判定要按归档前（archived:false）才能产生删除任务。
      await this.enqueueProjections(client, id, revision, [mapEntity(row, attributes)], { archived: false })
    }
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
    // 取消归档后重新满足看板谓词时入队，projector 重建读模型行（同样只对 memory/state 查属性）。
    if (row.kind === 'memory' || row.kind === 'state') {
      const attributes = await selectAttributes(asAttributeQuery(client), id)
      await this.enqueueProjections(client, id, revision, [mapEntity(row, attributes)])
    }
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
    // 改名会 bump 每个受影响实体的 revision；把“改名后的版本”记进 inverse，
    // 回滚时就能做逐实体 CAS：改名之后又发生的写入不会被旧快照覆盖。
    const renamedRevisions = new Map<string, number>()
    // 改名可能改变看板谓词（标签↔tags、status 等）；写前谓词无法完整还原，
    // 受影响的 memory/state 一律重新入队，由 projector 幂等重建/删除读模型行。
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
      renamedRevisions.set(entityId, Number(updated.revision))
      const { view, triggers, references } = buildViewFromRows(updated, attributes, now, iso(updated.archived_at) ?? null)
      await replaceReferences(client, entityId, references)
      await client.query('delete from omb.trigger_key where entity_id = $1', [entityId])
      await insertTriggers(client, entityId, triggers)
      await upsertView(client, view)
      if (updated.is_current && updated.archived_at === null) {
        const projections = boardProjectionsForRename(from, to, updated.kind)
        if (projections.length > 0) {
          await this.enqueueProjectionTasks(client, entityId, Number(updated.revision), projections)
        }
      }
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
      inverse: toJson({
        action: 'restore_attr_rows',
        from,
        to,
        rows: before.rows,
        revisions: Object.fromEntries(renamedRevisions),
      }),
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

  /** 审计回滚（维护入口）：委托 writer-rollback，事务边界与错误映射留在本类。 */
  async rollback(auditId: number, actor: string): Promise<RollbackResult> {
    try {
      return await this.db.transaction(client => rollbackAudit(client, auditId, actor))
    } catch (error) {
      throw mapPgError(error)
    }
  }
}
