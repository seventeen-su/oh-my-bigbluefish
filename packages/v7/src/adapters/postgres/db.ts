import pg from 'pg'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

export interface PostgresConfig {
  readonly connectionString: string
  readonly max?: number
  readonly idleTimeoutMillis?: number
  readonly connectionTimeoutMillis?: number
  readonly statementTimeoutMs?: number
}

export class PostgresDb {
  readonly pool: Pool

  constructor(config: PostgresConfig) {
    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 10,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
      application_name: 'omb-v7',
      statement_timeout: config.statementTimeoutMs ?? 15_000,
    })
    this.pool.on('error', () => {
      // 连接池空闲连接错误不应让宿主进程崩溃；调用方会在下一次查询拿到错误。
    })
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values as unknown[])
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const value = await work(client)
      await client.query('commit')
      return value
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * 事务内执行并给本次事务设置 `statement_timeout`。
   *
   * 为什么不是 `pool.query({ signal })`：node-postgres 目前没有 query 级 AbortSignal；
   * 只 race 放弃等待会留下仍在跑的查询占住连接。事务级 `set_config(..., true)` 是
   * PostgreSQL 的服务端取消，超时后语句被取消、事务回滚、连接归还连接池（RET-10）。
   */
  async transactionWithin<T>(timeoutMs: number, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const safe = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : 1
    return this.transaction(async client => {
      await client.query("select set_config('statement_timeout', $1, true)", [String(safe)])
      return work(client)
    })
  }

  /** 单条语句的服务端超时（内部开事务设置 local statement_timeout）。 */
  async queryWithin<T extends QueryResultRow = QueryResultRow>(
    timeoutMs: number,
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.transactionWithin(timeoutMs, client => client.query<T>(text, values as unknown[]))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
