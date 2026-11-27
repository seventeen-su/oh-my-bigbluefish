import type { PoolClient } from 'pg'
import type { Link, LinkInput } from '../../domain/link.js'
import { OmbFailure, conflict, notFound } from '../../domain/errors.js'
import { newId } from '../../domain/ids.js'
import type { JsonValue } from '../../domain/json.js'
import type { CommandMeta, CommandOutcome } from '../../app/commands/index.js'
import { iso } from './db.js'
import type { EntityRow } from './rows.js'
import { insertEvent, nextStreamVersion } from './writer-audit.js'
import { noopOutcome, projectionToken, revisionConflict, toJson } from './writer-support.js'

/**
 * link 聚合的两个写命令（create/unlink）。
 *
 * `link` 是独立 stream：版本用 nextStreamVersion 取 max+1，所以 restore_link 之后再次
 * unlink 不会撞唯一索引；conflict 抑制（possible_conflict 手工取消）也在同一事务里。
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

export async function createLinkCommand(client: PoolClient, input: LinkInput, meta: CommandMeta): Promise<CommandOutcome> {
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

export async function unlinkCommand(client: PoolClient, id: string, meta: CommandMeta): Promise<CommandOutcome> {
  const result = await client.query<LinkRow>(
    'update omb.link set archived_at = now(), updated_at = now() where id = $1 and archived_at is null returning *',
    [id],
  )
  const row = result.rows[0]
  if (row === undefined) return noopOutcome('')
  if (row.relation === 'possible_conflict') {
    const [left, right] = row.from_id < row.to_id ? [row.from_id, row.to_id] : [row.to_id, row.from_id]
    // check:ignore-next-line sec-sql-concat -- pair_key 走 $1 参数，reason 是常量字面量
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
