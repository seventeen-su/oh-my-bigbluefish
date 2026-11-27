import type { QueryResult, QueryResultRow } from 'pg'
import type {
  OutboxAppendInput,
  OutboxAppendResult,
  OutboxClaimOptions,
  OutboxEvent,
  OutboxFailureInput,
  OutboxStats,
  OutboxStore,
  OutboxTransaction,
  OutboxWakeSource,
} from '../../app/outbox/events.js'
import type {
  OutboxDeadRow,
  OutboxDeadSummary,
  OutboxReplayInput,
  OutboxReplayResult,
  OutboxReplayStore,
} from '../../app/outbox/replay.js'
import type { JsonValue } from '../../domain/json.js'
import { iso, PostgresDb, type PostgresConfig } from './db.js'
import { PostgresListenNotifier, type ListenNotifierStatus } from './listen.js'

/** 提交后由 writer/append 发出的低延迟提示；它只是唤醒信号，不承载队列语义。 */
export const OUTBOX_NOTIFY_CHANNEL = 'omb_outbox'

const MAX_ERROR_LENGTH = 4_000
const MAX_LAG_MS = 86_400_000
/** `omb_status` 只要最近几条死信原因，不把整张死信表拉进宿主上下文。 */
const MAX_DEAD_SUMMARY_LIMIT = 50
/** 单次人工重放的硬上限：`omb_admin` 的 limit 更小，这里只防绕过工具的调用方。 */
const MAX_REPLAY_LIMIT = 500

/** 适配器内部的最小执行器：Pool、PoolClient 与 PostgresDb 都满足。 */
export interface OutboxQueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

interface IdRow extends QueryResultRow {
  id: string
}

interface ClaimRow extends QueryResultRow {
  id: string
  event_id: string
  topic: string
  payload: unknown
  attempts: number
  created_at: Date | string
  available_at: Date | string
}

interface StatsRow extends QueryResultRow {
  pending: number
  claimed: number
  oldest_age_ms: string | number | null
}

interface CountRow extends QueryResultRow {
  count: number
}

interface DeadRow extends QueryResultRow {
  /** 窗口计数：本次查询过滤条件下 dead 行总数（不受 limit 影响）。 */
  total?: number
  id: string
  event_id: string
  topic: string
  attempts: number
  last_error: string | null
  created_at: Date | string
}

interface ReplayedRow extends QueryResultRow {
  id: string
  event_id: string
  topic: string
  /** 重放前的尝试次数；UPDATE 已把行上的 attempts 归零，这里必须用 CTE 里的旧值。 */
  previous_attempts: number
  previous_error: string | null
  created_at: Date | string
}

/**
 * claim 生产 SQL，导出以便 EXPLAIN 诊断与测试断言 due 索引被使用。
 * `$1` 批大小，`$2` 租约毫秒。CTE 里的 `FOR UPDATE SKIP LOCKED` 是并发安全的唯一依据：
 * 第二个 worker 会跳过已被锁住的行，不会阻塞也不会重复领取。
 */
export const OUTBOX_CLAIM_SQL = `
with due as (
  select id
  from omb.outbox
  where status in ('pending', 'claimed')
    and available_at <= now()
  order by available_at, id
  for update skip locked
  limit $1
)
update omb.outbox target
set status = 'claimed',
    claimed_at = now(),
    available_at = now() + ($2::int * interval '1 millisecond')
from due
where target.id = due.id
returning target.id, target.event_id, target.topic, target.payload,
          target.attempts, target.created_at, target.available_at
`

const APPEND_SQL = `
insert into omb.outbox (event_id, topic, payload, available_at)
values ($1, $2, $3::jsonb, coalesce($4::timestamptz, now()))
on conflict (event_id) do nothing
returning id
`

const COMPLETE_SQL = `
update omb.outbox
set status = 'done', claimed_at = null, last_error = null
where id = $1 and status = 'claimed' and attempts = $2
`

const FAIL_SQL = `
update omb.outbox
set attempts = attempts + 1,
    status = $2,
    available_at = coalesce($3::timestamptz, available_at),
    claimed_at = null,
    last_error = $4
where id = $1 and status = 'claimed' and attempts = $5
`

const RELEASE_SQL = `
update omb.outbox
set status = 'pending', claimed_at = null, available_at = now()
where id = $1 and status = 'claimed' and attempts = $2
`

const STATS_SQL = `
select
  count(*) filter (where status = 'pending')::int as pending,
  count(*) filter (where status = 'claimed')::int as claimed,
  coalesce(
    (extract(
      epoch from (now() - min(created_at) filter (
        where status = 'pending' or available_at <= now()
      ))
    ) * 1000)::bigint,
    0
  ) as oldest_age_ms
from omb.outbox
where status in ('pending', 'claimed')
`

const STALE_PENDING_SQL = `
select count(*)::int as count
from omb.outbox
where status = 'pending'
  and available_at <= now()
  and created_at <= now() - ($1::int * interval '1 millisecond')
`

/**
 * 死信读取（`omb_status` 与 `omb_admin replay` 共用）。
 *
 * 窗口函数给的是过滤后 dead 总数，limit 只截断明细：运维既能知道“一共几条”，
 * 也能看到最早几条死信的原因。`last_error` 原样返回，不在这里改写。
 */
const DEAD_SUMMARY_SQL = `
select (count(*) over ())::int as total,
       id, event_id, topic, attempts, last_error, created_at
from omb.outbox
where status = 'dead'
order by id
limit $1
`

/**
 * 人工重放的生产 SQL：dead → pending。
 *
 * 原子性来自单条语句的 CTE：`for update skip locked` 先锁住候选行（并发 replay 直接跳过），
 * `update ... where status='dead' and attempts = target.attempts` 再做一次 CAS；
 * 归零 attempts、把 available_at 拉回 now()，让行按全新事件重新投递。
 * `last_error` 故意保留：重放后仍能看到它为什么进过死信，下一次投递结果会覆盖。
 * `$1` 行 id、`$2` topic、`$3` 上限；缺省过滤为 null 表示该维度不限制。
 */
const REPLAY_DEAD_SQL = `
with target as (
  select id, attempts, last_error
  from omb.outbox
  where status = 'dead'
    and ($1::bigint is null or id = $1)
    and ($2::text is null or topic = $2)
  order by id
  limit $3
  for update skip locked
), replayed as (
  update omb.outbox target_row
  set status = 'pending',
      attempts = 0,
      available_at = now(),
      claimed_at = null
  from target
  where target_row.id = target.id
    and target_row.status = 'dead'
    and target_row.attempts = target.attempts
  returning target_row.id, target_row.event_id, target_row.topic, target_row.created_at,
            target.attempts as previous_attempts, target.last_error as previous_error
)
select id, event_id, topic, previous_attempts, previous_error, created_at
from replayed
order by id
`

/** 重放后同一条件下还剩多少 dead：>0 表示上限不够或有并发占用，可再 replay 一次。 */
const REPLAY_REMAINING_SQL = `
select count(*)::int as count
from omb.outbox
where status = 'dead'
  and ($1::bigint is null or id = $1)
  and ($2::text is null or topic = $2)
`

/**
 * 重放审计：与重放更新同一事务。
 *
 * 沿用 `PostgresJobFailureLog` 的运维审计先例（`adapters/postgres/jobs.ts`）：直接写
 * `audit_log`、不参与 hash chain（链只覆盖业务事件），也不需要 inverse——重放不是数据变更。
 * 没有行被重放时不写审计，重复 replay 因此是幂等的。
 */
const REPLAY_AUDIT_SQL = `
insert into omb.audit_log (actor, action, target_ids, after)
values ($1, 'outbox-replay', $2::text[], $3::jsonb)
`

/**
 * PostgreSQL outbox 适配器。
 *
 * `append` 接受 writer 的事务句柄（PoolClient），使 outbox 行与业务写原子提交；
 * 在同一次调用里发 `pg_notify`，事务回滚时提示也一起消失——这样 writer 不会出现
 * “写了 outbox 却忘了唤醒”或 “通知了但数据回滚” 的半状态。
 */
export class PostgresOutboxStore implements OutboxStore, OutboxReplayStore {
  constructor(private readonly db: PostgresDb) {}

  async append(input: OutboxAppendInput, tx?: OutboxTransaction): Promise<OutboxAppendResult> {
    const executor = executorFor(tx, this.db)
    const inserted = await executor.query<IdRow>(APPEND_SQL, [
      input.eventId,
      input.topic,
      JSON.stringify(input.payload),
      input.availableAt === undefined ? null : input.availableAt.toISOString(),
    ])
    const insertedRow = inserted.rows[0]
    if (insertedRow !== undefined) {
      const id = Number(insertedRow.id)
      await notifyOutbox(executor, input.eventId)
      return { id, inserted: true }
    }
    // 同一个 event_id 重复 append：靠唯一索引吸收，返回既有行，不产生第二次事件。
    const existing = await executor.query<IdRow>('select id from omb.outbox where event_id = $1', [input.eventId])
    const existingRow = existing.rows[0]
    if (existingRow === undefined) {
      throw new Error(`outbox append 未插入也未找到已存在行：event_id=${input.eventId}`)
    }
    return { id: Number(existingRow.id), inserted: false }
  }

  async claim(options: OutboxClaimOptions): Promise<readonly OutboxEvent[]> {
    const rows = await this.db.query<ClaimRow>(OUTBOX_CLAIM_SQL, [
      clampInt(options.limit, 1, 500),
      clampInt(options.leaseMs, 1, 3_600_000),
    ])
    return rows.rows.map(row => ({
      id: Number(row.id),
      eventId: Number(row.event_id),
      topic: row.topic,
      payload: row.payload as OutboxEvent['payload'],
      attempts: row.attempts,
      createdAt: iso(row.created_at) as string,
      availableAt: iso(row.available_at) as string,
    }))
  }

  async complete(id: number, expectedAttempts: number): Promise<boolean> {
    const result = await this.db.query(COMPLETE_SQL, [id, expectedAttempts])
    return result.rowCount === 1
  }

  async fail(input: OutboxFailureInput): Promise<boolean> {
    const result = await this.db.query(FAIL_SQL, [
      input.id,
      input.dead === true ? 'dead' : 'pending',
      input.retryAt === undefined ? null : input.retryAt.toISOString(),
      errorText(input.error),
      input.expectedAttempts,
    ])
    return result.rowCount === 1
  }

  async release(id: number, expectedAttempts: number): Promise<boolean> {
    const result = await this.db.query(RELEASE_SQL, [id, expectedAttempts])
    return result.rowCount === 1
  }

  async stats(): Promise<OutboxStats> {
    const result = await this.db.query<StatsRow>(STATS_SQL)
    const row = result.rows[0]
    if (row === undefined) return { pending: 0, claimed: 0, oldestAgeMs: 0 }
    return {
      pending: row.pending,
      claimed: row.claimed,
      oldestAgeMs: Math.max(0, Number(row.oldest_age_ms ?? 0)),
    }
  }

  async stalePendingCount(olderThanMs: number): Promise<number> {
    const result = await this.db.query<CountRow>(STALE_PENDING_SQL, [clampInt(olderThanMs, 0, MAX_LAG_MS)])
    return result.rows[0]?.count ?? 0
  }

  async deadSummary(limit: number): Promise<OutboxDeadSummary> {
    const result = await this.db.query<DeadRow>(DEAD_SUMMARY_SQL, [clampInt(limit, 1, MAX_DEAD_SUMMARY_LIMIT)])
    return {
      count: result.rows[0]?.total ?? 0,
      rows: result.rows.map(mapDeadRow),
    }
  }

  async replayDead(input: OutboxReplayInput): Promise<OutboxReplayResult> {
    const id = input.id === undefined ? null : positiveInt(input.id, 'outbox.id')
    const topic = input.topic === undefined ? null : nonEmptyTopic(input.topic)
    if (id === null && topic === null) throw new Error('outbox replay 需要 id 或 topic 之一')
    const actor = input.actor.trim()
    if (actor.length === 0) throw new Error('outbox replay 需要非空 actor')
    const limit = clampInt(input.limit, 1, MAX_REPLAY_LIMIT)
    return this.db.transaction(async client => {
      const replayedRows = await client.query<ReplayedRow>(REPLAY_DEAD_SQL, [id, topic, limit])
      const replayed = replayedRows.rows.map(mapReplayedRow)
      const remainingRows = await client.query<CountRow>(REPLAY_REMAINING_SQL, [id, topic])
      const remaining = remainingRows.rows[0]?.count ?? 0
      if (replayed.length > 0) {
        await client.query(REPLAY_AUDIT_SQL, [
          actor,
          replayed.map(row => String(row.id)),
          JSON.stringify(replayAuditPayload(input, { id, topic, limit }, replayed, remaining)),
        ])
        await notifyOutbox(client)
      }
      return { replayed, remaining }
    })
  }
}

/**
 * 在给定执行器（通常是 writer 的事务客户端）上发 NOTIFY。
 * 事务提交时 PostgreSQL 才投递；回滚则提示消失。
 */
export async function notifyOutbox(executor: OutboxQueryExecutor, eventId?: number): Promise<void> {
  await executor.query('select pg_notify($1, $2)', [
    OUTBOX_NOTIFY_CHANNEL,
    eventId === undefined ? '' : String(eventId),
  ])
}

/**
 * NOTIFY 监听器（LISTEN 需要专用连接，不能占用连接池里的短连接）。
 *
 * 它只负责唤醒。连接被终止/数据库重启后由共享的 `PostgresListenNotifier` 按指数退避
 * 重连、重新 LISTEN 并唤醒订阅者（含 relay），不再把“断线”变成静默停摆；
 * 漏掉的唤醒仍由重连后的一次性对账 + relay 的 reconciliation 兜底。
 */
export class PostgresOutboxNotifier implements OutboxWakeSource {
  private readonly listen: PostgresListenNotifier

  constructor(config: PostgresConfig) {
    this.listen = new PostgresListenNotifier({
      connectionString: config.connectionString,
      channel: OUTBOX_NOTIFY_CHANNEL,
      applicationName: 'omb-v7-outbox',
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    })
  }

  /** 等待 LISTEN 真正注册完成；测试和需要确定性时序的调用方使用。 */
  async ready(): Promise<void> {
    await this.listen.ready()
  }

  subscribe(listener: () => void): () => void {
    return this.listen.subscribe(listener)
  }

  /** 重连成功回调：组合根据此做一次有界对账（不是固定轮询）。 */
  onReconnect(listener: () => void): () => void {
    return this.listen.onReconnect(listener)
  }

  /** connected/reconnects 读数；`omb_status` 用它证明 LISTEN 没有静默停摆。 */
  status(): ListenNotifierStatus {
    return this.listen.status()
  }

  async close(): Promise<void> {
    await this.listen.close()
  }
}

function executorFor(tx: OutboxTransaction | undefined, db: PostgresDb): OutboxQueryExecutor {
  if (tx === undefined || tx === null) return db
  if (typeof tx === 'object' && typeof (tx as { query?: unknown }).query === 'function') {
    return tx as OutboxQueryExecutor
  }
  throw new Error('outbox.append 的事务句柄必须提供 query()')
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} 必须是正整数`)
  return value
}

function nonEmptyTopic(value: string): string {
  const topic = value.trim()
  if (topic.length === 0) throw new Error('outbox replay 的 topic 不能为空')
  return topic
}

function mapDeadRow(row: DeadRow): OutboxDeadRow {
  return {
    id: Number(row.id),
    eventId: Number(row.event_id),
    topic: row.topic,
    attempts: row.attempts,
    lastError: row.last_error ?? '',
    createdAt: iso(row.created_at) as string,
  }
}

function mapReplayedRow(row: ReplayedRow): OutboxDeadRow {
  return {
    id: Number(row.id),
    eventId: Number(row.event_id),
    topic: row.topic,
    attempts: row.previous_attempts,
    lastError: row.previous_error ?? '',
    createdAt: iso(row.created_at) as string,
  }
}

/** 审计载荷：规范化后的筛选条件、本次真正重放的行（含重放前的失败原因）与剩余数。 */
function replayAuditPayload(
  input: OutboxReplayInput,
  filter: { readonly id: number | null; readonly topic: string | null; readonly limit: number },
  replayed: readonly OutboxDeadRow[],
  remaining: number,
): Record<string, JsonValue> {
  return {
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    filter: {
      id: filter.id,
      topic: filter.topic,
    },
    limit: filter.limit,
    replayed: replayed.map(row => ({
      id: row.id,
      topic: row.topic,
      attempts: row.attempts,
      lastError: row.lastError,
    })),
    remaining,
  }
}

function errorText(value: string): string {
  const text = value.trim().length > 0 ? value : 'unknown error'
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text
}
