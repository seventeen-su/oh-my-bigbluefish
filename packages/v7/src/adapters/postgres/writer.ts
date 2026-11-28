import type { PoolClient } from 'pg'
import type { Attribute, Entity, PatchEntityInput, StateStatus, StateVersion } from '../../domain/entity.js'
import type { AuditAuthorization } from '../../domain/audit.js'
import { attributeValue, scopeOf } from '../../domain/entity-access.js'
import { OmbFailure, conflict, internal, invalid, notFound } from '../../domain/errors.js'
import { newId } from '../../domain/ids.js'
import { isPlainObject, type JsonValue } from '../../domain/json.js'
import type { EntityLifecycle, RetractResult, SupersedeResult } from '../../domain/lifecycle.js'
import { deriveReferences, deriveSearchText, deriveTriggers, type NormalizedWrite } from '../../domain/validation.js'
import type { AuditEntry, RollbackResult } from '../../ports/observability.js'
import {
  duplicateCommandFailure,
  patchConflictFields,
  type CommandMeta,
  type CommandOutcome,
  type CommandWriter,
  type DomainEvent,
  type PreparedCommand,
} from '../../app/commands/index.js'
import type { ProjectionName } from '../../app/projections/types.js'
import type { ProjectionTaskStore } from '../../app/projections/tasks.js'
import type { DependencyInvalidationResult } from '../../app/dependency.js'
import { iso, PostgresDb } from './db.js'
import {
  deleteSourceDependencyEdges,
  invalidateDependencies,
  pruneDependencyMarks,
  rebuildDependencyEdges,
  replaceReferenceDependencyEdges,
} from './dependency.js'
import { boardProjectionsFor, boardProjectionsForRename, PostgresProjectionTaskStore } from './projection.js'
import { autoArchivedAt, buildViewValues, mapEntity, type EntityRow } from './rows.js'
import { insertAudit, insertEvent, nextStreamVersion } from './writer-audit.js'
import { contentHashOf, insertEvidence } from './writer-evidence.js'
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

/** 关键属性的字符串视图：冲突差异只带可读值，非字符串（如数字）不参与“当前状态”字段。 */
function textAttribute(entity: Entity, name: string): string | undefined {
  const value = attributeValue(entity, name)
  return typeof value === 'string' ? value : undefined
}

/**
 * 写事务里「依赖失效」结果进事件 payload 的窄投影：reaction 只据此决定是否入队
 * `omb.refresh`（`dependency` 存在即代表有标记），不把完整标记列表塞进 outbox。
 */
function dependencyPayload(result: DependencyInvalidationResult): Record<string, JsonValue> {
  if (result.total === 0) return {}
  return {
    dependency: {
      marked: result.total,
      direct: result.direct,
      cascaded: result.cascaded,
      truncated: result.truncated,
      maxDepth: result.maxDepth,
    },
  }
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
      // 写路径的重复命令需要返回首次实体（工具重试不能只拿 revision 而丢实体）。
      // 实体 id 优先取 payload.entityId：EvidenceAdded 的 streamId 是 `evidence:<id>`。
      let entity: CommandOutcome['entity']
      if (entityId.length > 0) {
        const entityRow = await this.db.query<EntityRow>('select * from omb.entity where id = $1', [entityId])
        const current = entityRow.rows[0]
        if (current !== undefined) {
          const attributes = await selectAttributes(asAttributeQuery(this.db as unknown as PoolClient), entityId)
          entity = mapEntity(current, attributes)
        }
      }
      return {
        events,
        revision,
        projectionToken: { entityId, revision, watermark: row.id },
        ...(entity !== undefined ? { entity } : {}),
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
      case 'Supersede':
        return this.supersedeEntity(client, command, meta)
      case 'RetractEntity':
        return this.retractEntity(client, command.id, command.reason, command.effectiveAt, command.expectedRevision, meta)
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
    // 内容级幂等（第二层）：同 scope/category/关键属性/时间的内容复用原实体，新证据并入证据集。
    // 并发同内容写入用事务级 advisory lock 串行化（只有 memory 参与；归档行不参与，遗忘后可重写）。
    // 被取代/被证伪的历史条目也不参与：同一内容重新断言必须落成新的当前事实，不能把证据
    // 并入旧事实再把历史条目当作本次写入结果返回。
    const contentHash = contentHashOf(input)
    if (contentHash !== null) {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`omb:content:${contentHash}`])
      const existing = await client.query<EntityRow>(
        `select * from omb.entity
          where content_key = $1 and kind = $2 and archived_at is null and is_current and lifecycle = 'active'
          order by created_at asc
          limit 1`,
        [contentHash, input.kind],
      )
      const row = existing.rows[0]
      if (row !== undefined) {
        await insertEvidence(client, row.id, meta.evidence, contentHash)
        const attributes = await selectAttributes(asAttributeQuery(client), row.id)
        const revision = Number(row.revision)
        // 没有新证据（系统写回同内容）时不产生事件：只有“证据集真的可能变化”才通知反应器。
        if (meta.evidence === undefined || meta.evidence.length === 0) {
          return {
            events: [],
            revision,
            projectionToken: { entityId: row.id, revision, watermark: '' },
            entity: mapEntity(row, attributes),
            deduped: 'content',
          }
        }
        // 证据并入也需要可审计、可触发的事件：实体 revision/stream version 不变
        // （实体后续 patch 还要用它的版本号），证据事件单独走 `evidence:<id>` 流。
        const streamId = `evidence:${row.id}`
        const streamVersion = await nextStreamVersion(client, streamId)
        const payload: Record<string, JsonValue> = {
          entityId: row.id,
          entityKind: row.kind,
          revision,
          evidence: meta.evidence?.length ?? 0,
          contentHash,
        }
        const event = await insertEvent(client, {
          meta,
          action: 'evidence',
          eventType: 'EvidenceAdded',
          streamId,
          streamVersion,
          targetIds: [row.id],
          payload,
          after: toJson({ evidence: meta.evidence?.length ?? 0, deduped: 'content' }),
        })
        return {
          events: [event],
          revision,
          projectionToken: projectionToken(row.id, revision, event),
          entity: mapEntity(row, attributes),
          deduped: 'content',
        }
      }
    }
    // attribute 有 entity 外键，entity 必须先插入；归档时间只由属性行里的 status 决定。
    const archivedAt = autoArchivedAt(input.kind, input.attributes, now)
    const archived = archivedAt !== null
    // 实体 origin 是内容出处（trust/检索先验），审计 source 是本次授权来源：
    // 两者必须分开——后台刷新（source=system:refresh）不能把实体出处从 job 改成 system。
    const entityResult = await client.query<EntityRow>(
      `insert into omb.entity (
         id, kind, revision, origin, confidence, pinned, salience, archived_at, archive_reason,
         is_current, content_key, lifecycle, valid_from
       ) values ($1,$2,1,$3,$4,$5,0.5,$6,$7,true,$8,'active', now())
       returning *`,
      [input.id, input.kind, input.origin, input.confidence ?? null, input.pinned, archivedAt, archived ? 'auto-status' : null, contentHash],
    )
    const entityRow = entityResult.rows[0]
    if (entityRow === undefined) throw new OmbFailure(internal('实体写入没有返回行'))
    await insertAttributes(client, input.id, input.attributes)
    await insertEvidence(client, input.id, meta.evidence, contentHash)
    await upsertRegistry(client, input.attributes)
    // trigger_key/reference/entity_view 都从同一事务内读回的属性行派生（唯一真源）。
    const persisted = await selectAttributes(asAttributeQuery(client), input.id)
    const references = deriveReferences(persisted)
    await replaceReferences(client, input.id, references)
    await replaceReferenceDependencyEdges(client, input.id, input.kind, references)
    await insertTriggers(client, input.id, deriveTriggers(persisted))
    if (input.kind === 'chain' && input.group !== undefined) {
      await assertChainMemberKinds(client, input.group)
      await insertChainMembers(client, input.id, input.group)
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
    const contentHash = contentHashOf(input)
    const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [input.id])
    const current = currentResult.rows[0]
    if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${input.id}`))
    if (current.archived_at !== null) throw new OmbFailure({ code: 'archived', message: `实体已归档：${input.id}` })
    if (current.kind !== input.kind) throw new OmbFailure(conflict(`实体类型不能从 ${current.kind} 改为 ${input.kind}`))
    // 条件更新：缺失 expectedRevision 直接拒绝，绝不回退到“写最新版本”。
    if (patch.expectedRevision === undefined) {
      throw new OmbFailure(invalid('PatchEntity 必须携带 expectedRevision（禁止无条件覆盖）'))
    }
    const oldAttributes = await selectAttributes(asAttributeQuery(client), input.id)
    const oldEntity = mapEntity(current, oldAttributes)
    if (Number(current.revision) !== patch.expectedRevision) {
      // 冲突差异在行锁内计算：oldAttributes 是当前已提交状态，与 incoming 成对返回。
      const currentStatus = textAttribute(oldEntity, 'status')
      const currentTitle = textAttribute(oldEntity, 'title')
      const currentTime = textAttribute(oldEntity, 'time')
      const currentCategory = textAttribute(oldEntity, 'category')
      throw revisionConflict(patch.expectedRevision, Number(current.revision), {
        entityId: input.id,
        actor: meta.actor,
        source: meta.origin,
        ...(currentStatus === undefined ? {} : { currentStatus }),
        ...(currentTitle === undefined ? {} : { currentTitle }),
        ...(currentTime === undefined ? {} : { currentTime }),
        ...(currentCategory === undefined ? {} : { currentCategory }),
        conflictingFields: patchConflictFields(oldEntity, patch),
      })
    }
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
    const references = deriveReferences(persisted)
    await replaceReferences(client, input.id, references)
    await replaceReferenceDependencyEdges(client, input.id, input.kind, references)
    // 被删掉/改成静态的属性不再有依赖标记，避免 stale 行永久占用刷新窗口。
    await pruneDependencyMarks(client, input.id)
    // trigger_key 也是派生数据；patch 必须整体替换，否则旧路径/错误签名会残留。
    await client.query('delete from omb.trigger_key where entity_id = $1', [input.id])
    await insertTriggers(client, input.id, deriveTriggers(persisted))
    if (input.kind === 'chain' && input.group !== undefined) {
      await assertChainMemberKinds(client, input.group)
      await replaceChainMembers(client, input.id, input.group)
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
           content_key = $7,
           updated_at = now()
       where id = $1 and revision = $8
       returning *`,
      [
        input.id,
        input.confidence ?? current.confidence,
        input.pinned,
        archivedAt,
        archivedAt === null ? null : 'auto-status',
        input.origin,
        contentHash,
        patch.expectedRevision,
      ],
    )
    const updated = updatedResult.rows[0]
    if (updated === undefined) {
      // 行锁 + 上面的版本比较已经覆盖正常路径；这里兜底 CAS（条件更新）语义。
      throw revisionConflict(patch.expectedRevision, Number(current.revision), {
        entityId: input.id,
        actor: meta.actor,
        source: meta.origin,
        conflictingFields: patchConflictFields(oldEntity, patch),
      })
    }
    const { view } = buildViewFromRows(updated, persisted, now, archivedAt)
    await upsertView(client, view)
    // 引用依赖失效：只沿 target 入边标记直接依赖并做有界级联，与本次写入同事务。
    const invalidation = await invalidateDependencies(client, input.id, 'patch')
    // 更新也可以携带证据（如晋升时的系统验证结论）；内容哈希按更新后的属性重算，
    // 旧内容上的证据不会被新内容冒用。
    await insertEvidence(client, input.id, meta.evidence, contentHash)
    const revision = Number(updated.revision)
    // 写前/写后都传：之前属于看板、之后不属于时要让 projector 收到 revision 去删旧行。
    await this.enqueueProjections(client, input.id, revision, [oldEntity, mapEntity(updated, persisted)])
    const payload: Record<string, JsonValue> = {
      entityId: input.id,
      entityKind: input.kind,
      revision,
      attributes: persisted.filter(item => !item.required).map(item => item.name),
      ...dependencyPayload(invalidation),
    }
    const event = await insertEvent(client, {
      // 审计的 expected_revision 记录“这次补丁是基于哪个版本提交的”，便于事后复现 CAS。
      meta: { ...meta, expectedRevision: patch.expectedRevision },
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
    const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [id])
    const current = currentResult.rows[0]
    if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${id}`))
    if (current.archived_at !== null) {
      // 已归档：带 expectedRevision 的命令返回可恢复冲突；旧路径保持静默 no-op。
      if (expected === undefined) return noopOutcome(id)
      throw await this.revisionConflictFor(client, current, meta, expected, true)
    }
    if (expected !== undefined && Number(current.revision) !== expected) {
      throw revisionConflict(expected, Number(current.revision), {
        entityId: id,
        actor: meta.actor,
        source: meta.origin,
        conflictingFields: [{ field: 'revision', incoming: expected, current: Number(current.revision) }],
      })
    }
    // 归档只覆盖「当前有效」的生命周期：已被取代/证伪的条目保留真值状态，只补 archived_at，
    // 否则历史会丢掉「它是被取代的」这条事实。
    const nextLifecycle: EntityLifecycle = current.lifecycle === 'active' ? 'archived' : current.lifecycle
    const updatedResult = await client.query<EntityRow>(
      `update omb.entity
       set revision = revision + 1, archived_at = now(), archive_reason = $2, lifecycle = $3, updated_at = now()
       where id = $1
       returning *`,
      [id, reason, nextLifecycle],
    )
    const row = updatedResult.rows[0]
    if (row === undefined) throw new OmbFailure(internal('归档没有返回行'))
    const revision = Number(row.revision)
    await client.query('update omb.entity_view set archived_at = now(), lifecycle = $2 where entity_id = $1', [id, nextLifecycle])
    // 归档 source 不再作为可刷新依赖方：清掉它的出边与自身待刷新标记（入边保留，
    // 取消归档后继续参与失效传播）。
    await deleteSourceDependencyEdges(client, id)
    // 被归档的实体内容不再可读：它的入边依赖方仍需失效，避免引用方继续用旧缓存。
    const invalidation = await invalidateDependencies(client, id, 'archive')
    // 归档前属于看板时入队：projector 按归档后的谓词删除读模型行。
    // 只有 memory/state 参与看板，链/历史版本不为它们白查一次属性行。
    if (row.kind === 'memory' || row.kind === 'state') {
      const attributes = await selectAttributes(asAttributeQuery(client), id)
      // 判定要按归档前（archived:false）才能产生删除任务。
      await this.enqueueProjections(client, id, revision, [mapEntity(current, attributes)], { archived: false })
    }
    const payload: Record<string, JsonValue> = { entityId: id, kind: row.kind, reason, revision, lifecycle: nextLifecycle, ...dependencyPayload(invalidation) }
    const event = await insertEvent(client, {
      meta,
      action: 'archive',
      eventType: 'EntityArchived',
      streamId: id,
      streamVersion: revision,
      targetIds: [id],
      payload,
      after: toJson({ archived: true, reason, lifecycle: nextLifecycle }),
      inverse: toJson({ action: 'unarchive', entityId: id, previousLifecycle: current.lifecycle }),
    })
    return { events: [event], revision, projectionToken: projectionToken(id, revision, event) }
  }

  private async unarchiveEntity(client: PoolClient, id: string, reason: string, meta: CommandMeta): Promise<CommandOutcome> {
    const expected = meta.expectedRevision
    const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [id])
    const current = currentResult.rows[0]
    if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${id}`))
    if (current.archived_at === null) {
      if (expected === undefined) return noopOutcome(id)
      throw await this.revisionConflictFor(client, current, meta, expected, false)
    }
    if (expected !== undefined && Number(current.revision) !== expected) {
      throw revisionConflict(expected, Number(current.revision), {
        entityId: id,
        actor: meta.actor,
        source: meta.origin,
        conflictingFields: [{ field: 'revision', incoming: expected, current: Number(current.revision) }],
      })
    }
    // 只把 `archived` 生命周期还原成 `active`；以取代/证伪状态归档的条目取消归档后仍是历史。
    const nextLifecycle: EntityLifecycle = current.lifecycle === 'archived' ? 'active' : current.lifecycle
    const updatedResult = await client.query<EntityRow>(
      `update omb.entity
       set revision = revision + 1, archived_at = null, archive_reason = null, lifecycle = $2, updated_at = now()
       where id = $1
       returning *`,
      [id, nextLifecycle],
    )
    const row = updatedResult.rows[0]
    if (row === undefined) throw new OmbFailure(internal('取消归档没有返回行'))
    const revision = Number(row.revision)
    await client.query('update omb.entity_view set archived_at = null, lifecycle = $2 where entity_id = $1', [id, nextLifecycle])
    // 取消归档后重新满足看板谓词时入队，projector 重建读模型行（同样只对 memory/state 查属性）。
    const attributes = await selectAttributes(asAttributeQuery(client), id)
    // 归档时删过出边；取消归档要按当前属性/链接重新派生，否则之后上游更新不会失效。
    await rebuildDependencyEdges(client, { id, kind: row.kind }, attributes)
    // 取消归档改变可读性，依赖方可能缓存了“归档不可读”的结果。
    const invalidation = await invalidateDependencies(client, id, 'unarchive')
    if (row.kind === 'memory' || row.kind === 'state') {
      await this.enqueueProjections(client, id, revision, [mapEntity(row, attributes)])
    }
    const payload: Record<string, JsonValue> = { entityId: id, kind: row.kind, reason, revision, lifecycle: nextLifecycle, ...dependencyPayload(invalidation) }
    const event = await insertEvent(client, {
      meta,
      action: 'unarchive',
      eventType: 'EntityUnarchived',
      streamId: id,
      streamVersion: revision,
      targetIds: [id],
      payload,
      after: toJson({ archived: false, reason, lifecycle: nextLifecycle }),
      inverse: toJson({ action: 'archive', entityId: id, reason: 'rollback-unarchive' }),
    })
    return { events: [event], revision, projectionToken: projectionToken(id, revision, event) }
  }

  /**
   * 取代（first-class）：旧实体 → 新实体，单事务完成确认/创建新实体、`supersedes` 关系、
   * 旧实体生命周期与有效期、`entity_view`/看板投影、审计与 inverse。
   *
   * 幂等/冲突规则（不靠轮询、不靠二次扫描）：
   * - 旧实体已被同一新实体取代 → 返回 `alreadyApplied`，不再写第二行审计；
   * - 已被另一个实体取代 → conflict（一个旧实体只能有一个当前 succeeded-by）；
   * - 新实体必须当前有效；沿 superseded_by 链能回到旧实体 → 拒绝成环；
   * - 旧实体已归档/已证伪 → 拒绝（归档与证伪不是取代的隐式前提）。
   */
  private async supersedeEntity(
    client: PoolClient,
    command: {
      readonly oldId: string
      readonly newId: string
      readonly reason: string
      readonly effectiveAt?: string
      readonly create?: NormalizedWrite
      readonly expectedRevision?: number
    },
    meta: CommandMeta,
  ): Promise<CommandOutcome> {
    const { oldId, reason } = command
    const targetNewId = command.newId
    if (oldId === targetNewId) throw new OmbFailure(conflict('不能把实体取代为它自己'))
    const effectiveAt = command.effectiveAt ?? nowIso()
    const oldResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [oldId])
    const old = oldResult.rows[0]
    if (old === undefined) throw new OmbFailure(notFound(`实体不存在：${oldId}`))
    if (old.archived_at !== null) throw new OmbFailure({ code: 'archived', message: `实体已归档，不能取代：${oldId}` })
    if (old.lifecycle === 'superseded') {
      if (old.superseded_by === targetNewId) {
        const revision = Number(old.revision)
        const result: SupersedeResult = {
          oldId,
          newId: targetNewId,
          linkId: '',
          effectiveAt,
          created: false,
          alreadyApplied: true,
          auditId: 0,
          revision,
        }
        return {
          events: [],
          revision,
          projectionToken: { entityId: oldId, revision, watermark: '' },
          supersede: result,
        }
      }
      throw new OmbFailure(conflict(`旧实体已被另一条记忆取代：${oldId} → ${old.superseded_by ?? 'unknown'}`))
    }
    if (old.lifecycle === 'retracted') {
      throw new OmbFailure(conflict(`实体已被证伪（retracted），不能用取代覆盖：${oldId}`))
    }
    if (command.expectedRevision !== undefined && Number(old.revision) !== command.expectedRevision) {
      throw revisionConflict(command.expectedRevision, Number(old.revision), {
        entityId: oldId,
        actor: meta.actor,
        source: meta.origin,
        conflictingFields: [{
          field: 'revision',
          incoming: command.expectedRevision,
          current: Number(old.revision),
        }],
      })
    }

    // 新实体：事务内创建（create 归一化输入）或确认已存在；两条路径都在同一事务里。
    let created = false
    let newRow: EntityRow | undefined
    const createdEvents: DomainEvent[] = []
    let newIdForRow = targetNewId
    if (command.create !== undefined) {
      const createdOutcome = await this.createEntity(client, command.create, {
        ...meta,
        // 创建事件是独立审计行：command_id 必须不同于取代命令（唯一索引）。
        commandId: `${meta.commandId}:create`,
      })
      const entity = createdOutcome.entity
      if (entity === undefined) throw new OmbFailure(internal('取代的新实体创建没有返回实体'))
      created = true
      createdEvents.push(...createdOutcome.events)
      newIdForRow = entity.id
    } else {
      const newResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [targetNewId])
      newRow = newResult.rows[0]
      if (newRow === undefined) throw new OmbFailure(notFound(`取代的新实体不存在：${targetNewId}`))
      if (newRow.archived_at !== null) throw new OmbFailure({ code: 'archived', message: `取代的新实体已归档：${targetNewId}` })
    }
    if (created) {
      const createdRow = await client.query<EntityRow>('select * from omb.entity where id = $1', [newIdForRow])
      newRow = createdRow.rows[0]
    }
    if (newRow === undefined) throw new OmbFailure(internal('取代的新实体读取失败'))
    // 成环检查先于“新实体必须当前有效”：反向取代已被取代的实体时，应报环而不是笼统的 not-current。
    if (await this.supersedeChainReaches(client, newIdForRow, oldId)) {
      throw new OmbFailure(conflict(`取代关系会形成环：${oldId} ← … ← ${newIdForRow}`))
    }
    if (newRow.lifecycle !== 'active') {
      throw new OmbFailure(conflict(`取代的新实体不是当前有效（lifecycle=${newRow.lifecycle}）：${newIdForRow}`))
    }
    const oldValidFrom = iso(old.valid_from)
    if (oldValidFrom !== undefined && oldValidFrom > effectiveAt) {
      throw new OmbFailure(conflict(`effectiveAt 早于旧实体的有效期起点 ${oldValidFrom}`))
    }

    // `supersedes` 关系是生命周期的一部分，必须在同一事务里建立；旧实体生命周期与有效期同步落库。
    const linkId = newId('link')
    await client.query(
      `insert into omb.link (id, from_id, to_id, relation, directed, strength, source, origin)
       values ($1,$2,$3,'supersedes',true,1.0,$4,$4)`,
      [linkId, newIdForRow, oldId, meta.origin],
    )
    const updatedResult = await client.query<EntityRow>(
      `update omb.entity
       set revision = revision + 1,
           lifecycle = 'superseded',
           superseded_by = $2,
           superseded_at = $3,
           supersede_reason = $4,
           valid_to = $3,
           valid_from = coalesce(valid_from, created_at),
           updated_at = now()
       where id = $1
       returning *`,
      [oldId, newIdForRow, effectiveAt, reason],
    )
    const updated = updatedResult.rows[0]
    if (updated === undefined) throw new OmbFailure(internal('取代没有返回旧实体行'))
    const revision = Number(updated.revision)
    await client.query('update omb.entity_view set lifecycle = $2, updated_at = now() where entity_id = $1', [oldId, 'superseded'])
    // 旧实体原先属于看板时入队删除读模型行（按取代前状态判定，与归档同款）。
    if (old.kind === 'memory' || old.kind === 'state') {
      const oldAttributes = await selectAttributes(asAttributeQuery(client), oldId)
      await this.enqueueProjections(client, oldId, revision, [mapEntity(old, oldAttributes)], { archived: false })
    }
    const payload: Record<string, JsonValue> = {
      entityId: newIdForRow,
      oldId,
      newId: newIdForRow,
      linkId,
      reason,
      effectiveAt,
      revision,
      created,
      validFrom: iso(updated.valid_from) ?? null,
      validTo: effectiveAt,
    }
    const event = await insertEvent(client, {
      meta,
      action: 'supersede',
      eventType: 'EntitySuperseded',
      streamId: oldId,
      streamVersion: revision,
      targetIds: [oldId, newIdForRow],
      payload,
      before: toJson({
        lifecycle: old.lifecycle,
        revision: Number(old.revision),
        validFrom: iso(old.valid_from) ?? null,
        validTo: iso(old.valid_to) ?? null,
        supersededBy: old.superseded_by,
        supersededAt: iso(old.superseded_at) ?? null,
      }),
      after: toJson({
        lifecycle: 'superseded',
        revision,
        validFrom: iso(updated.valid_from) ?? null,
        validTo: effectiveAt,
        supersededBy: newIdForRow,
        supersededAt: effectiveAt,
      }),
      inverse: toJson({
        action: 'unsupersede',
        oldId,
        newId: newIdForRow,
        linkId,
        previousLifecycle: old.lifecycle,
        previousValidFrom: iso(old.valid_from) ?? null,
        previousValidTo: iso(old.valid_to) ?? null,
      }),
    })
    const result: SupersedeResult = {
      oldId,
      newId: newIdForRow,
      linkId,
      effectiveAt,
      created,
      alreadyApplied: false,
      auditId: Number(event.id),
      revision,
    }
    return {
      events: [...createdEvents, event],
      revision,
      projectionToken: projectionToken(oldId, revision, event),
      supersede: result,
    }
  }

  /** 沿 `superseded_by` 链向上走，判断是否会回到旧实体（环）；有界步数防脏数据死循环。 */
  private async supersedeChainReaches(client: PoolClient, startId: string, targetId: string): Promise<boolean> {
    const seen = new Set<string>()
    let cursor: string | null = startId
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === targetId) return true
      seen.add(cursor)
      const result: { rows: { superseded_by: string | null }[] } = await client.query<{ superseded_by: string | null }>(
        'select superseded_by from omb.entity where id = $1',
        [cursor],
      )
      cursor = result.rows[0]?.superseded_by ?? null
      if (seen.size > 64) break
    }
    return false
  }

  /**
   * 证伪（retracted）：与取代不同的生命周期——不是「有更新的说法」，而是「这条说法不成立」。
   * 同样单事务写审计与 inverse；重复证伪幂等返回，已被取代的实体不能再被证伪。
   */
  private async retractEntity(
    client: PoolClient,
    id: string,
    reason: string,
    effectiveAtInput: string | undefined,
    expectedRevision: number | undefined,
    meta: CommandMeta,
  ): Promise<CommandOutcome> {
    const effectiveAt = effectiveAtInput ?? nowIso()
    const currentResult = await client.query<EntityRow>('select * from omb.entity where id = $1 for update', [id])
    const current = currentResult.rows[0]
    if (current === undefined) throw new OmbFailure(notFound(`实体不存在：${id}`))
    if (current.archived_at !== null) throw new OmbFailure({ code: 'archived', message: `实体已归档，不能撤回：${id}` })
    if (current.lifecycle === 'retracted') {
      const revision = Number(current.revision)
      const result: RetractResult = { id, effectiveAt, alreadyApplied: true, auditId: 0, revision }
      return { events: [], revision, projectionToken: { entityId: id, revision, watermark: '' }, retract: result }
    }
    if (current.lifecycle === 'superseded') {
      throw new OmbFailure(conflict(`实体已被取代（superseded），不能用证伪覆盖：${id}`))
    }
    if (expectedRevision !== undefined && Number(current.revision) !== expectedRevision) {
      throw revisionConflict(expectedRevision, Number(current.revision), {
        entityId: id,
        actor: meta.actor,
        source: meta.origin,
        conflictingFields: [{ field: 'revision', incoming: expectedRevision, current: Number(current.revision) }],
      })
    }
    const currentValidFrom = iso(current.valid_from)
    if (currentValidFrom !== undefined && currentValidFrom > effectiveAt) {
      throw new OmbFailure(conflict(`effectiveAt 早于实体的有效期起点 ${currentValidFrom}`))
    }
    const updatedResult = await client.query<EntityRow>(
      `update omb.entity
       set revision = revision + 1,
           lifecycle = 'retracted',
           retracted_at = $2,
           retracted_reason = $3,
           valid_to = $2,
           valid_from = coalesce(valid_from, created_at),
           updated_at = now()
       where id = $1
       returning *`,
      [id, effectiveAt, reason],
    )
    const updated = updatedResult.rows[0]
    if (updated === undefined) throw new OmbFailure(internal('证伪没有返回实体行'))
    const revision = Number(updated.revision)
    await client.query('update omb.entity_view set lifecycle = $2, updated_at = now() where entity_id = $1', [id, 'retracted'])
    if (current.kind === 'memory' || current.kind === 'state') {
      const attributes = await selectAttributes(asAttributeQuery(client), id)
      await this.enqueueProjections(client, id, revision, [mapEntity(current, attributes)], { archived: false })
    }
    const payload: Record<string, JsonValue> = { entityId: id, kind: current.kind, reason, effectiveAt, revision }
    const event = await insertEvent(client, {
      meta,
      action: 'retract',
      eventType: 'EntityRetracted',
      streamId: id,
      streamVersion: revision,
      targetIds: [id],
      payload,
      before: toJson({
        lifecycle: current.lifecycle,
        revision: Number(current.revision),
        validFrom: iso(current.valid_from) ?? null,
        validTo: iso(current.valid_to) ?? null,
      }),
      after: toJson({
        lifecycle: 'retracted',
        revision,
        retractedAt: effectiveAt,
        reason,
        validTo: effectiveAt,
      }),
      inverse: toJson({
        action: 'unretract',
        entityId: id,
        previousLifecycle: current.lifecycle,
        previousValidFrom: iso(current.valid_from) ?? null,
        previousValidTo: iso(current.valid_to) ?? null,
      }),
    })
    const result: RetractResult = { id, effectiveAt, alreadyApplied: false, auditId: Number(event.id), revision }
    return { events: [event], revision, projectionToken: projectionToken(id, revision, event), retract: result }
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
    // check:ignore-next-line sec-sql-concat -- from/to 只作为 $1 参数值，不是 SQL 片段
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
      // check:ignore-next-line sec-sql-concat -- name 走 $1 参数，模板是常量 SQL
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
      await replaceReferenceDependencyEdges(client, entityId, updated.kind, references)
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

  /**
   * 归档/取消归档的冲突上下文：只在冲突路径多读一次属性行，正常写路径没有额外查询。
   * `incomingArchived` 让调用方看到“我想改成什么 vs 当前是什么”。
   */
  private async revisionConflictFor(
    client: PoolClient,
    row: EntityRow,
    meta: CommandMeta,
    expected: number,
    incomingArchived: boolean,
  ): Promise<OmbFailure> {
    const attributes = row.kind === 'memory' || row.kind === 'state'
      ? await selectAttributes(asAttributeQuery(client), row.id)
      : []
    const entity = mapEntity(row, attributes)
    const currentStatus = textAttribute(entity, 'status')
    const currentTitle = textAttribute(entity, 'title')
    return revisionConflict(expected, Number(row.revision), {
      entityId: row.id,
      actor: meta.actor,
      source: meta.origin,
      ...(currentStatus === undefined ? {} : { currentStatus }),
      ...(currentTitle === undefined ? {} : { currentTitle }),
      conflictingFields: [{ field: 'archivedAt', incoming: incomingArchived, current: row.archived_at !== null }],
    })
  }

  /** 运维审计入口（自动刷新/遗忘的 skipped/conflict）：不写业务行、不 bump revision。 */
  async recordAudit(entry: AuditEntry): Promise<number> {
    try {
      return await this.db.transaction(client => insertAudit(client, entry))
    } catch (error) {
      throw mapPgError(error)
    }
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
        // 成功但解析结果为空（undefined）必须清掉旧缓存：依赖失效后“没有值”也是新结果，
        // 不能因为 coalesce 把旧值留下。失败（error）才保留旧缓存并写 last_error。
        const updated = await client.query(
          `update omb.attribute
           set cached_value = case when $6::text is null then $4::jsonb else coalesce($4::jsonb, cached_value) end,
               cached_at = $5,
               last_error = $6
           where entity_id = $1 and name = $2 and ordinal = $3`,
          [entityId, name, ordinal, value === undefined ? null : JSON.stringify(value), cachedAt, error ?? null],
        )
        if (updated.rowCount === 0) return
        if (error === undefined) {
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
        await replaceReferenceDependencyEdges(client, id, row.kind, references)
        await upsertView(client, view)
      })
    } catch (error) {
      throw mapPgError(error)
    }
  }

  /** 审计回滚（维护入口）：委托 writer-rollback，事务边界与错误映射留在本类。 */
  async rollback(auditId: number, actor: string, authorization?: AuditAuthorization): Promise<RollbackResult> {
    try {
      return await this.db.transaction(client => rollbackAudit(client, auditId, actor, authorization))
    } catch (error) {
      throw mapPgError(error)
    }
  }
}
