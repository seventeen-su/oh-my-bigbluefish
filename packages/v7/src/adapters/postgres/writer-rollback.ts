import type { PoolClient } from 'pg'
import type { Attribute } from '../../domain/entity.js'
import { scopeOf } from '../../domain/entity-access.js'
import { OmbFailure, conflict, internal, notFound } from '../../domain/errors.js'
import { isPlainObject, type JsonValue } from '../../domain/json.js'
import { deriveReferences, deriveSearchText, deriveTriggers, type NormalizedWrite } from '../../domain/validation.js'
import type { RollbackResult } from '../../ports/observability.js'
import { asNumber, asString, iso } from './db.js'
import { buildViewValues, mapEntity, type EntityRow } from './rows.js'
import { insertAudit } from './writer-audit.js'
import {
  asAttributeQuery,
  assertChainMemberKinds,
  insertAttributes,
  insertTriggers,
  replaceChainMembers,
  replaceReferences,
  selectAttributes,
  upsertView,
} from './writer-tables.js'
import { nowIso, revisionConflict, toJson } from './writer-support.js'

/**
 * 审计回滚：只回滚单条审计的 inverse，写 audit/view/属性，仍在一个短事务内。
 *
 * 事务与锁由调用方（AttributeWriter.rollback）持有；快照类 inverse 先做 CAS，
 * 版本已前进就整笔失败，不留半写。
 */

interface RollbackAuditRow {
  readonly id: string
  readonly inverse: JsonValue | null
  readonly target_ids: string[]
  readonly rolled_back_at: Date | string | null
  readonly stream_id: string | null
  readonly stream_version: string | null
}

/**
 * 快照类 inverse 的 CAS 守卫（ADR-0010）：只回滚“审计时那个版本”，版本已前进就拒绝。
 *
 * 只对**回写旧内容**的 inverse 生效（`restore` 恢复补丁前属性、`restore_attr_rows`
 * 恢复改名前的属性行）：这两类会用旧快照覆盖当前数据，必须先证明当前版本仍是审计时
 * 的版本。`archive`/`unarchive`/`unlink`/`restore_link`/`remove_written` 是状态切换，
 * 不回写旧属性，仍由 `rolled_back_at` 保证一条审计只回滚一次。
 *
 * 迁移前（008 之前）的审计行没有 stream/revision 数据时无法证明快照归属；
 * `restore_attr_rows` 旧 inverse 没有 `revisions`，保持旧行为而不是凭空拒绝。
 */
async function assertRollbackSnapshotCas(
  client: PoolClient,
  row: RollbackAuditRow,
  inverse: Record<string, JsonValue>,
): Promise<void> {
  const action = asString(inverse['action'])
  if (action === 'restore') {
    const entityId = asString(inverse['entityId'])
    const expected = row.stream_version === null ? undefined : Number(row.stream_version)
    if (entityId === undefined || expected === undefined || row.stream_id !== entityId) return
    await assertEntityRevision(client, entityId, expected)
    return
  }
  if (action === 'restore_attr_rows') {
    const revisions = inverse['revisions']
    if (!isPlainObject(revisions)) return
    for (const [entityId, raw] of Object.entries(revisions)) {
      const expected = asNumber(raw)
      if (expected === undefined) continue
      await assertEntityRevision(client, entityId, expected)
    }
  }
}

async function assertEntityRevision(client: PoolClient, entityId: string, expected: number): Promise<void> {
  // 行锁 + 重新读取：并发回滚/写入在 READ COMMITTED 下等锁后会看到最新版本。
  const result = await client.query<{ revision: string }>(
    'select revision from omb.entity where id = $1 for update',
    [entityId],
  )
  const row = result.rows[0]
  if (row === undefined) throw new OmbFailure(notFound(`实体不存在：${entityId}`))
  const currentRevision = Number(row.revision)
  if (currentRevision !== expected) throw revisionConflict(expected, currentRevision)
}

export async function rollbackAudit(client: PoolClient, auditId: number, actor: string): Promise<RollbackResult> {
  const result = await client.query<RollbackAuditRow>(
    `select id, inverse, target_ids, rolled_back_at, stream_id, stream_version
     from omb.audit_log where id = $1 for update`,
    [auditId],
  )
  const row = result.rows[0]
  if (row === undefined) throw new OmbFailure(notFound(`审计记录不存在：${auditId}`))
  if (row.rolled_back_at !== null) throw new OmbFailure(conflict(`审计记录已回滚：${auditId}`))
  if (row.inverse === null || typeof row.inverse !== 'object' || Array.isArray(row.inverse)) {
    throw new OmbFailure(internal(`审计记录没有可执行 inverse：${auditId}`))
  }
  const inverse = row.inverse as Record<string, JsonValue>
  // 先进 CAS 再动数据：旧快照覆盖新修改时整笔回滚失败，不留半写。
  await assertRollbackSnapshotCas(client, row, inverse)
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
        await replaceChainMembers(client, entityId, group)
      }
    }
    const view = buildViewValues(normalized, derived, {
      now: nowIso(),
      isCurrent: current.is_current,
      archivedAt,
      kindOverride: current.kind,
    })
    // check:ignore-next-line sec-sql-concat -- 所有值走 $2..$7 参数，模板是常量 SQL
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
      // 回滚也是一次修改：bump revision，后续审计的快照 CAS 才判断得出来。
      const restoredRevision = Number(current.revision) + 1
      await client.query('update omb.entity set revision = $2, updated_at = now() where id = $1', [
        entityId,
        restoredRevision,
      ])
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
}
