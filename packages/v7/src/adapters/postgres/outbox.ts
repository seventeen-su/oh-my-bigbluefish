import pg from 'pg'
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
import { iso, PostgresDb, type PostgresConfig } from './db.js'

/** 提交后由 writer/append 发出的低延迟提示；它只是唤醒信号，不承载队列语义。 */
export const OUTBOX_NOTIFY_CHANNEL = 'omb_outbox'

const MAX_ERROR_LENGTH = 4_000
const MAX_LAG_MS = 86_400_000

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
 * PostgreSQL outbox 适配器。
 *
 * `append` 接受 writer 的事务句柄（PoolClient），使 outbox 行与业务写原子提交；
 * 在同一次调用里发 `pg_notify`，事务回滚时提示也一起消失——这样 writer 不会出现
 * “写了 outbox 却忘了唤醒”或 “通知了但数据回滚” 的半状态。
 */
export class PostgresOutboxStore implements OutboxStore {
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
 * 它只负责唤醒；连接断开/漏通知时由 relay 的 reconciliation 安全网兜底，
 * 因此这里不做自动重连：调用方在重连/重启时重新 `subscribe` 或 `ready` 即可。
 */
export class PostgresOutboxNotifier implements OutboxWakeSource {
  private client: pg.Client | undefined
  private connecting: Promise<void> | undefined
  private readonly listeners = new Set<() => void>()
  private closed = false

  constructor(private readonly config: PostgresConfig) {}

  /** 等待 LISTEN 真正注册完成；测试和需要确定性时序的调用方使用。 */
  async ready(): Promise<void> {
    await this.listen()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    void this.listen().catch(() => {
      // 连接失败不阻塞 relay 启动；NOTIFY 只是提示，reconciliation 会兜底。
    })
    return () => {
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.listeners.clear()
    const client = this.client
    this.client = undefined
    if (client !== undefined) await client.end().catch(() => {})
  }

  private listen(): Promise<void> {
    if (this.client !== undefined) return Promise.resolve()
    if (this.connecting !== undefined) return this.connecting
    if (this.closed) return Promise.reject(new Error('outbox notifier 已关闭'))
    const connecting = this.open()
    this.connecting = connecting
    void connecting
      .catch(() => {})
      .finally(() => {
        if (this.connecting === connecting) this.connecting = undefined
      })
    return connecting
  }

  private async open(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis ?? 5_000,
      application_name: 'omb-v7-outbox',
    })
    client.on('notification', message => {
      if (message.channel !== OUTBOX_NOTIFY_CHANNEL) return
      for (const listener of [...this.listeners]) {
        try {
          listener()
        } catch {
          // 单个监听器异常不能影响其它监听器，也不能把错误抛进 pg 的事件循环。
        }
      }
    })
    client.on('error', () => {
      // 连接断开：丢弃它，等待调用方重建；漏掉的唤醒交给 reconciliation。
      if (this.client === client) this.client = undefined
      void client.end().catch(() => {})
    })
    try {
      await client.connect()
      await client.query(`listen ${OUTBOX_NOTIFY_CHANNEL}`)
    } catch (error) {
      await client.end().catch(() => {})
      throw error
    }
    if (this.closed) {
      await client.end().catch(() => {})
      throw new Error('outbox notifier 已关闭')
    }
    this.client = client
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

function errorText(value: string): string {
  const text = value.trim().length > 0 ? value : 'unknown error'
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text
}
