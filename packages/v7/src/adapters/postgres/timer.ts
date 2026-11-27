import pg from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'
import type {
  TimerCancelInput,
  TimerClaimOptions,
  TimerFailureInput,
  TimerScheduleInput,
  TimerScheduleResult,
  TimerStats,
  TimerStore,
  TimerTask,
  TimerWakeSource,
} from '../../app/workflow/index.js'
import { iso, PostgresDb, type PostgresConfig } from './db.js'

/** timer 提交后发出的低延迟唤醒信号；它只负责叫醒，不承载队列语义。 */
export const TIMER_NOTIFY_CHANNEL = 'omb_timer'

const MAX_ERROR_LENGTH = 4_000

/** 适配器内部的最小执行器：Pool、PoolClient 与 PostgresDb 都满足（writer 事务共用）。 */
export interface TimerQueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

interface ScheduleRow extends QueryResultRow {
  id: string
  due_at: Date | string
  inserted: boolean
}

interface ClaimRow extends QueryResultRow {
  id: string
  topic: string
  payload: unknown
  due_at: Date | string
  attempts: number
  dedupe_key: string | null
}

interface StatsRow extends QueryResultRow {
  pending: number
  claimed: number
  done: number
  dead: number
  cancelled: number
  oldest_due_age_ms: string | number | null
}

interface NextDueRow extends QueryResultRow {
  due_at: Date | string | null
}

/**
 * 幂等 schedule：同一 `dedupe_key` 是**重排期**（覆盖 due_at/payload 并重置重试状态），
 * 不是第二行。`xmax = 0` 区分本次是插入（true）还是覆盖（false）。
 */
const SCHEDULE_SQL = `
insert into omb.timer (topic, payload, due_at, dedupe_key)
values ($1, $2::jsonb, $3::timestamptz, $4)
on conflict (dedupe_key) where dedupe_key is not null do update
   set topic = excluded.topic,
       payload = excluded.payload,
       due_at = excluded.due_at,
       status = 'pending',
       attempts = 0,
       claimed_at = null,
       last_error = null
returning id, due_at, (xmax = 0) as inserted
`

/**
 * claim 生产 SQL，导出以便 EXPLAIN 诊断与测试断言 due 索引被使用。
 *
 * `$1` 批大小，`$2` 租约毫秒。只领取 `due_at <= now()` 的行；`FOR UPDATE SKIP LOCKED`
 * 保证并发 worker 互不阻塞、不重复领取。`due_at` 同时充当租约到期时间：进程崩溃后
 * 租约到期即重新满足条件，被其它 worker 领取（at-least-once）。
 */
export const TIMER_CLAIM_SQL = `
with due as (
  select id
  from omb.timer
  where status in ('pending', 'claimed')
    and due_at <= now()
  order by due_at, id
  for update skip locked
  limit $1
)
update omb.timer target
set status = 'claimed',
    claimed_at = now(),
    due_at = now() + ($2::int * interval '1 millisecond')
from due
where target.id = due.id
returning target.id, target.topic, target.payload, target.due_at,
          target.attempts, target.dedupe_key
`

const COMPLETE_SQL = `
update omb.timer
   set status = 'done', claimed_at = null, last_error = null
 where id = $1 and status = 'claimed' and attempts = $2
`

const FAIL_SQL = `
update omb.timer
   set attempts = attempts + 1,
       status = $2,
       due_at = coalesce($3::timestamptz, due_at),
       claimed_at = null,
       last_error = $4
 where id = $1 and status = 'claimed' and attempts = $5
`

const RELEASE_SQL = `
update omb.timer
   set status = 'pending', claimed_at = null, due_at = now()
 where id = $1 and status = 'claimed' and attempts = $2
`

const CANCEL_BY_ID_SQL = `
update omb.timer
   set status = 'cancelled', claimed_at = null
 where id = $1 and status in ('pending', 'claimed')
`

const CANCEL_BY_KEY_SQL = `
update omb.timer
   set status = 'cancelled', claimed_at = null
 where dedupe_key = $1 and status in ('pending', 'claimed')
`

const STATS_SQL = `
select
  count(*) filter (where status = 'pending')::int as pending,
  count(*) filter (where status = 'claimed')::int as claimed,
  count(*) filter (where status = 'done')::int as done,
  count(*) filter (where status = 'dead')::int as dead,
  count(*) filter (where status = 'cancelled')::int as cancelled,
  coalesce(
    (extract(
      epoch from (
        now() - min(due_at) filter (where status in ('pending', 'claimed') and due_at <= now())
      )
    ) * 1000)::bigint,
    0
  ) as oldest_due_age_ms
from omb.timer
`

const NEXT_DUE_SQL = `
select min(due_at) as due_at
  from omb.timer
 where status in ('pending', 'claimed')
`

/**
 * PostgreSQL timer 适配器。
 *
 * `schedule` 接受 writer 的事务句柄：timer 行与业务写一起提交/回滚，并在同一事务里发
 * `pg_notify`——事务回滚时提示也一起消失，不会出现“提前叫醒但没有 timer 行”的半状态。
 */
export class PostgresTimerStore implements TimerStore {
  constructor(private readonly db: PostgresDb) {}

  async schedule(input: TimerScheduleInput, tx?: unknown): Promise<TimerScheduleResult> {
    const executor = executorFor(tx, this.db)
    const result = await executor.query<ScheduleRow>(SCHEDULE_SQL, [
      input.topic,
      JSON.stringify(input.payload),
      input.dueAt.toISOString(),
      input.dedupeKey === undefined ? null : input.dedupeKey,
    ])
    const row = result.rows[0]
    if (row === undefined) throw new Error(`timer schedule 没有返回行：${input.topic}`)
    await notifyTimer(executor, input.topic)
    return { id: Number(row.id), inserted: row.inserted, dueAt: iso(row.due_at) as string }
  }

  async cancel(input: TimerCancelInput): Promise<boolean> {
    if (input.id === undefined && input.dedupeKey === undefined) {
      throw new Error('timer cancel 需要 id 或 dedupeKey')
    }
    const result = input.id !== undefined
      ? await this.db.query(CANCEL_BY_ID_SQL, [input.id])
      : await this.db.query(CANCEL_BY_KEY_SQL, [input.dedupeKey])
    return result.rowCount === 1
  }

  async claimDue(options: TimerClaimOptions): Promise<readonly TimerTask[]> {
    const result = await this.db.query<ClaimRow>(TIMER_CLAIM_SQL, [
      clampInt(options.limit, 1, 500),
      clampInt(options.leaseMs, 1, 3_600_000),
    ])
    return result.rows.map(row => ({
      id: Number(row.id),
      topic: row.topic,
      payload: row.payload as TimerTask['payload'],
      dueAt: iso(row.due_at) as string,
      attempts: Number(row.attempts),
      ...(row.dedupe_key !== null ? { dedupeKey: row.dedupe_key } : {}),
    }))
  }

  async complete(id: number, expectedAttempts: number): Promise<boolean> {
    const result = await this.db.query(COMPLETE_SQL, [id, expectedAttempts])
    return result.rowCount === 1
  }

  async fail(input: TimerFailureInput): Promise<boolean> {
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

  async nextDueAt(): Promise<string | undefined> {
    const result = await this.db.query<NextDueRow>(NEXT_DUE_SQL)
    return iso(result.rows[0]?.due_at ?? null)
  }

  async stats(): Promise<TimerStats> {
    const result = await this.db.query<StatsRow>(STATS_SQL)
    const row = result.rows[0]
    if (row === undefined) {
      return { pending: 0, claimed: 0, done: 0, dead: 0, cancelled: 0, oldestDueAgeMs: 0 }
    }
    return {
      pending: row.pending,
      claimed: row.claimed,
      done: row.done,
      dead: row.dead,
      cancelled: row.cancelled,
      oldestDueAgeMs: Math.max(0, Number(row.oldest_due_age_ms ?? 0)),
    }
  }
}

/**
 * 在给定执行器（通常是 writer 的事务客户端）上发 NOTIFY。
 * 事务提交时 PostgreSQL 才投递；回滚则提示消失。
 */
export async function notifyTimer(executor: TimerQueryExecutor, topic: string): Promise<void> {
  await executor.query('select pg_notify($1, $2)', [TIMER_NOTIFY_CHANNEL, topic])
}

/**
 * NOTIFY 监听器（LISTEN 需要专用连接，不能占用连接池里的短连接）。
 * 它只负责唤醒；漏通知时由 worker 的 `nextDueAt` 兜底，因此这里不做自动重连。
 */
export class PostgresTimerNotifier implements TimerWakeSource {
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
      // 连接失败不阻塞 worker 启动；NOTIFY 只是提示，nextDueAt 会兜底。
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
    if (this.closed) return Promise.reject(new Error('timer notifier 已关闭'))
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
      application_name: 'omb-v7-timer',
    })
    client.on('notification', message => {
      if (message.channel !== TIMER_NOTIFY_CHANNEL) return
      for (const listener of [...this.listeners]) {
        try {
          listener()
        } catch {
          // 单个监听器异常不能影响其它监听器，也不能把错误抛进 pg 的事件循环。
        }
      }
    })
    client.on('error', () => {
      // 连接断开：丢弃它；漏掉的唤醒交给 nextDueAt 兜底。
      if (this.client === client) this.client = undefined
      void client.end().catch(() => {})
    })
    try {
      await client.connect()
      await client.query(`listen ${TIMER_NOTIFY_CHANNEL}`)
    } catch (error) {
      await client.end().catch(() => {})
      throw error
    }
    if (this.closed) {
      await client.end().catch(() => {})
      throw new Error('timer notifier 已关闭')
    }
    this.client = client
  }
}

function executorFor(tx: unknown, db: PostgresDb): TimerQueryExecutor {
  if (tx === undefined || tx === null) return db
  if (typeof tx === 'object' && typeof (tx as { query?: unknown }).query === 'function') {
    return tx as TimerQueryExecutor
  }
  throw new Error('timer.schedule 的事务句柄必须提供 query()')
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function errorText(value: string): string {
  const text = value.trim().length > 0 ? value : 'unknown error'
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text
}
