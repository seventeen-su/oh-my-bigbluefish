import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import type { JsonValue } from '../../domain/json.js'
import type { Scope } from '../../domain/entity.js'
import {
  AUDIT_DENIED_ACTION,
  rollbackAccessDecision,
  type AuditRollbackFacts,
  type AuditTenant,
  type EntityScopeFact,
} from '../../domain/audit.js'
import { OmbFailure, forbidden, internal } from '../../domain/errors.js'
import type { AuditEntry, AuditRecord } from '../../ports/observability.js'
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
  /**
   * 来源/授权方与条件更新的两侧版本。
   *
   * 这三列不参与 `auditChainPayload`：014 之前的审计行没有它们，加进哈希载荷会让
   * 历史行无法重新验链（链是 append-only 的历史承诺）。它们仍是同事务写入的审计事实，
   * 只是不改变既有链的哈希输入。
   */
  readonly source?: string | null
  readonly expectedRevision?: number | null
  readonly currentRevision?: number | null
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
       correlation_id, causation_id, actor_kind, source, expected_revision, current_revision,
       prev_hash, hash
     ) values ($1,$2,$3::text[],$4::jsonb,$5::jsonb,$6::jsonb,$7,
       $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
      entry.source ?? null,
      entry.expectedRevision ?? null,
      entry.currentRevision ?? null,
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
    actorKind: entry.actorKind ?? null,
    source: entry.source ?? null,
    expectedRevision: entry.expectedRevision ?? null,
    currentRevision: entry.currentRevision ?? null,
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
    source: input.meta.origin,
    expectedRevision: input.meta.expectedRevision ?? null,
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

// ---------------------------------------------------------------------------
// 越权检查的只读事实（与审计同源；工具路径把这里的结果交给 domain/audit 判定）
// ---------------------------------------------------------------------------

/**
 * 只读查询能力：PostgresDb 与事务内 PoolClient 都能提供，避免把整只连接池类型
 * 拖进审计辅助函数（也让测试可以用最小 fake）。
 */
export interface AuditQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: T[] }>
}

/** 审计行里做授权判定所需的列；不回传 before/after（可能含正文）。 */
export interface AuditAccessRow {
  readonly id: number
  readonly action: string
  readonly actor: string
  readonly actorKind: string | null
  readonly source: string | null
  readonly targetIds: readonly string[]
  readonly rolledBackAt: string | null
}

interface AuditAccessDbRow {
  readonly id: string
  readonly action: string
  readonly actor: string
  readonly actor_kind: string | null
  readonly source: string | null
  readonly target_ids: string[]
  readonly rolled_back_at: Date | string | null
}

/** 读取单条审计的授权事实；不存在返回 undefined（调用方转 not-found）。 */
export async function readAuditAccessRow(db: AuditQueryable, auditId: number): Promise<AuditAccessRow | undefined> {
  const result = await db.query<AuditAccessDbRow>(
    `select id::text as id, action, actor, actor_kind, source, target_ids, rolled_back_at
       from omb.audit_log
      where id = $1`,
    [auditId],
  )
  return result.rows[0] === undefined ? undefined : auditAccessOf(result.rows[0])
}

function auditAccessOf(row: AuditAccessDbRow): AuditAccessRow {
  return {
    id: Number(row.id),
    action: row.action,
    actor: row.actor,
    actorKind: row.actor_kind,
    source: row.source,
    targetIds: row.target_ids,
    rolledBackAt: iso(row.rolled_back_at) ?? null,
  }
}

export function rollbackFactsOf(row: AuditAccessRow): AuditRollbackFacts {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    actorKind: row.actorKind,
    source: row.source,
    targetIds: row.targetIds,
  }
}

/**
 * 批量读取实体作用域（entity_view 是写入事务内派生的读模型，含归档行）。
 * 缺失的 id 不返回：调用方必须把“查不到作用域”当成不可证明归属并拒绝。
 */
export async function readEntityScopes(
  db: AuditQueryable,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Scope>> {
  const unique = [...new Set(ids.filter(id => id.length > 0))]
  if (unique.length === 0) return new Map()
  const result = await db.query<{ entity_id: string; scope: string; project_key: string }>(
    `select entity_id, scope, project_key
       from omb.entity_view
      where entity_id = any($1::text[])`,
    [unique],
  )
  const scopes = new Map<string, Scope>()
  for (const row of result.rows) {
    scopes.set(
      row.entity_id,
      row.scope === 'project' && row.project_key.length > 0
        ? { kind: 'project', projectKey: row.project_key }
        : { kind: 'global' },
    )
  }
  return scopes
}

/** 把 id 列表映射成作用域事实；查不到作用域的 id 带 `scope: undefined`（fail-closed）。 */
export async function readAuthorizationTargets(
  db: AuditQueryable,
  ids: readonly string[],
): Promise<readonly EntityScopeFact[]> {
  const scopes = await readEntityScopes(db, ids)
  return ids.map(id => {
    const scope = scopes.get(id)
    return scope === undefined ? { id } : { id, scope }
  })
}

/** 链接端点的实体 id；越权检查必须同时看两端（任一在项目外都拒绝）。 */
export async function readLinkEndpoints(
  db: AuditQueryable,
  linkId: string,
): Promise<{ readonly fromId: string; readonly toId: string } | undefined> {
  const result = await db.query<{ from_id: string; to_id: string }>(
    'select from_id, to_id from omb.link where id = $1',
    [linkId],
  )
  const row = result.rows[0]
  return row === undefined ? undefined : { fromId: row.from_id, toId: row.to_id }
}

/**
 * 回滚的适配器层越权校验：只在调用方提供 tenant 时生效（旧测试/后台入口保持旧语义）。
 * 事务内已经 `for update` 锁住审计行，这里再读 target 作用域，避免 TOCTOU 下把
 * 项目外实体回滚掉。
 */
export async function assertRollbackTenantAllowed(
  client: PoolClient,
  facts: AuditRollbackFacts,
  tenant: AuditTenant | undefined,
): Promise<void> {
  if (tenant === undefined) return
  const targets = await readAuthorizationTargets(client, facts.targetIds)
  const decision = rollbackAccessDecision({ facts, targets, tenant })
  if (!decision.allowed) {
    throw new OmbFailure(forbidden(decision.message, {
      auditId: facts.id,
      reason: decision.reason,
      targetIds: decision.targetIds,
    }))
  }
}

interface AuditListRow {
  readonly id: string
  readonly actor: string
  readonly action: string
  readonly target_ids: string[]
  readonly inverse: JsonValue | null
  readonly created_at: Date | string
  readonly rolled_back_at: Date | string | null
  readonly actor_kind: string | null
  readonly source: string | null
  readonly expected_revision: string | null
  readonly current_revision: string | null
}

/**
 * 按租户列出审计：只有当审计的**全部** target 都是 global 或当前项目时可见。
 *
 * 越权拒绝行（action='denied'）的目标可能在项目外，用 `after.tenantProjectKey`
 * 证明它是本租户的拒绝记录；返回时清空 target_ids，避免把外项目 id 带进工具输出。
 * 目标无法解析/为空的行默认不展示（不猜归属）。
 */
export async function listAuditWithinTenant(
  db: AuditQueryable,
  options: { readonly limit: number; readonly tenant?: AuditTenant; readonly actor?: string },
): Promise<readonly AuditRecord[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit)))
  const aliases = options.tenant?.aliases ?? []
  const result = await db.query<AuditListRow>(
    `select a.id::text as id, a.actor, a.action, a.target_ids, a.inverse, a.created_at,
            a.rolled_back_at, a.actor_kind, a.source, a.expected_revision, a.current_revision
       from omb.audit_log a
      where (
        a.action = $3
        and coalesce(a.after->>'tenantProjectKey', '') = any($2::text[])
      ) or (
        a.action <> $3
        and (
          coalesce((
            select bool_and(v.scope = 'global' or v.project_key = any($2::text[]))
              from unnest(a.target_ids) as target(entity_id)
              left join omb.entity_view v on v.entity_id = target.entity_id
          ), false)
          or (cardinality(a.target_ids) = 0 and a.actor = $4)
        )
      )
      order by a.id desc
      limit $1`,
    [limit, aliases, AUDIT_DENIED_ACTION, options.actor ?? ''],
  )
  return result.rows.map(row => ({
    id: Number(row.id),
    actor: row.actor,
    action: row.action,
    targetIds: row.action === AUDIT_DENIED_ACTION ? [] : row.target_ids,
    ...(row.inverse === null ? {} : { inverse: row.inverse }),
    createdAt: iso(row.created_at) as string,
    ...(iso(row.rolled_back_at) !== undefined ? { rolledBackAt: iso(row.rolled_back_at) as string } : {}),
    ...(row.actor_kind === null ? {} : { actorKind: row.actor_kind }),
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.expected_revision === null ? {} : { expectedRevision: Number(row.expected_revision) }),
    ...(row.current_revision === null ? {} : { currentRevision: Number(row.current_revision) }),
  }))
}

/** 当前租户的越权拒绝次数（`omb_admin audit` 报出，便于发现探测/注入尝试）。 */
export async function countDeniedWithinTenant(db: AuditQueryable, tenant: AuditTenant | undefined): Promise<number> {
  const aliases = tenant?.aliases ?? []
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count
       from omb.audit_log
      where action = $1
        and coalesce(after->>'tenantProjectKey', '') = any($2::text[])`,
    [AUDIT_DENIED_ACTION, aliases],
  )
  return Number(result.rows[0]?.count ?? 0)
}
