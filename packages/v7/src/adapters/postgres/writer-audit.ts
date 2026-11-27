import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { JsonValue } from '../../domain/json.js'
import { OmbFailure, internal } from '../../domain/errors.js'
import type { AuditEntry } from '../../ports/observability.js'
import type { CommandMeta, DomainEvent, DomainEventType } from '../../app/commands/index.js'
import { iso } from './db.js'
import { notifyOutbox } from './outbox.js'
import { canonicalJson } from './writer-support.js'

/**
 * audit_log 的 hash chain + outbox 事件写入 + 聚合 stream 版本。
 *
 * 与 writer-tables 的分工：这里写审计/事件（跨聚合的账本），表原语只写业务行；
 * 串行化（advisory lock）与链头读取都在 appendAuditRow 内完成。
 */

/** 审计链一条记录的规范字段；业务事件与运维审计两个写入入口共用。 */
export interface AuditChainEntry {
  readonly actor: string
  readonly action: string
  readonly targetIds?: readonly string[]
  readonly before?: JsonValue
  readonly after?: JsonValue
  readonly inverse?: JsonValue
  readonly jobId?: string | null
  readonly commandId?: string | null
  readonly streamId?: string | null
  readonly streamVersion?: number | null
  readonly eventType?: string | null
  readonly revision?: number | null
  readonly correlationId?: string | null
  readonly causationId?: string | null
  readonly actorKind?: string | null
}

/**
 * 链载荷的规范 JSON：键序固定（canonicalJson 排序）、缺省写成 null，保证同一行在
 * 任意进程/任意时间都算出同一 hash。command/event/revision 都在载荷里：命令幂等键、
 * 事件类型、stream 版本任一被改都会打断链。
 */
export function auditChainPayload(entry: AuditChainEntry): string {
  return canonicalJson({
    actor: entry.actor,
    action: entry.action,
    targetIds: [...(entry.targetIds ?? [])],
    before: entry.before ?? null,
    after: entry.after ?? null,
    inverse: entry.inverse ?? null,
    jobId: entry.jobId ?? null,
    commandId: entry.commandId ?? null,
    streamId: entry.streamId ?? null,
    streamVersion: entry.streamVersion ?? null,
    eventType: entry.eventType ?? null,
    revision: entry.revision ?? null,
    correlationId: entry.correlationId ?? null,
    causationId: entry.causationId ?? null,
    actorKind: entry.actorKind ?? null,
  })
}

/** `prev_hash` + 载荷的 sha256；空链起点用空串占位（`prev_hash` 列同时存 null）。 */
export function auditChainHash(prevHash: string | null, entry: AuditChainEntry): string {
  return createHash('sha256').update(`${prevHash ?? ''}\n${auditChainPayload(entry)}`).digest('hex')
}

interface AppendedAuditRow {
  readonly id: number
  readonly hash: string
  readonly createdAt: Date | string
}

/**
 * 追加审计行并链接 hash chain（ADR-0010）。
 *
 * 串行化：事务内先取 `omb:audit-chain` advisory lock，再读链头、写新行；并发写事务
 * 不可能算出同一个 `prev_hash`（唯一索引之外的第二道保证），也不会 fork。
 * 链头只看 `hash is not null`：迁移前遗留的无 hash 行不参与链接，新链从第一条带
 * hash 的行开始。链尾被单独删除无法仅凭链内数据发现，这是链式审计的固有限制
 * （需要外部锚点/定期快照），已在交付说明里记录。
 */
async function appendAuditRow(client: PoolClient, entry: AuditChainEntry): Promise<AppendedAuditRow> {
  await client.query("select pg_advisory_xact_lock(hashtext('omb:audit-chain'))")
  const head = await client.query<{ hash: string | null }>(
    'select hash from omb.audit_log where hash is not null order by id desc limit 1',
  )
  const prevHash = head.rows[0]?.hash ?? null
  const hash = auditChainHash(prevHash, entry)
  const result = await client.query<{ id: string; created_at: Date | string }>(
    `insert into omb.audit_log (
       actor, action, target_ids, before, after, inverse, job_id,
       command_id, stream_id, stream_version, event_type, revision,
       correlation_id, causation_id, actor_kind, prev_hash, hash
     ) values ($1,$2,$3::text[],$4::jsonb,$5::jsonb,$6::jsonb,$7,
       $8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning id, created_at`,
    [
      entry.actor,
      entry.action,
      [...(entry.targetIds ?? [])],
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.inverse === undefined ? null : JSON.stringify(entry.inverse),
      entry.jobId ?? null,
      entry.commandId ?? null,
      entry.streamId ?? null,
      entry.streamVersion ?? null,
      entry.eventType ?? null,
      entry.revision ?? null,
      entry.correlationId ?? null,
      entry.causationId ?? null,
      entry.actorKind ?? null,
      prevHash,
      hash,
    ],
  )
  const row = result.rows[0]
  if (row === undefined) throw new OmbFailure(internal('审计写入没有返回行'))
  return { id: Number(row.id), hash, createdAt: row.created_at }
}

export async function insertAudit(client: PoolClient, entry: AuditEntry): Promise<number> {
  const inserted = await appendAuditRow(client, {
    actor: entry.actor,
    action: entry.action,
    ...(entry.targetIds === undefined ? {} : { targetIds: entry.targetIds }),
    ...(entry.before === undefined ? {} : { before: entry.before }),
    ...(entry.after === undefined ? {} : { after: entry.after }),
    ...(entry.inverse === undefined ? {} : { inverse: entry.inverse }),
    jobId: entry.jobId ?? null,
  })
  return inserted.id
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
 * 追加一条领域事件：audit_log（含 command/stream 元数据 + hash chain）+ outbox
 * 同一事务写入。`event.id` 取 audit_log.id，重复命令重放时 id 不变（event_id 稳定）。
 */
export async function insertEvent(client: PoolClient, input: EventInput): Promise<DomainEvent> {
  const inserted = await appendAuditRow(client, {
    actor: input.meta.actor.id,
    action: input.action,
    targetIds: input.targetIds,
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.inverse === undefined ? {} : { inverse: input.inverse }),
    commandId: input.meta.commandId,
    streamId: input.streamId,
    streamVersion: input.streamVersion,
    eventType: input.eventType,
    revision: input.streamVersion,
    correlationId: input.meta.correlationId,
    causationId: input.meta.causationId ?? null,
    actorKind: input.meta.actor.kind,
  })
  const id = inserted.id
  const event: DomainEvent = {
    id: String(id),
    seq: id,
    streamId: input.streamId,
    streamVersion: input.streamVersion,
    type: input.eventType,
    actor: input.meta.actor,
    origin: input.meta.origin,
    occurredAt: iso(inserted.createdAt) as string,
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
export async function nextStreamVersion(client: PoolClient, streamId: string): Promise<number> {
  const result = await client.query<{ next: string }>(
    'select coalesce(max(stream_version), 0) + 1 as next from omb.audit_log where stream_id = $1',
    [streamId],
  )
  return Number(result.rows[0]?.next ?? 1)
}
