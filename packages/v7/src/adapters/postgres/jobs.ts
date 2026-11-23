import type { QueryResultRow } from 'pg'
import type {
  JobFailureLog,
  JobFinalFailure,
  JobFinalFailureSummary,
} from '../../ports/jobs.js'
import { iso, PostgresDb } from './db.js'

export const JOB_FINAL_FAILURE_ACTION = 'job-final-failure'
export const JOB_RECOVERED_ACTION = 'job-recovered'

interface AuditRow extends QueryResultRow {
  target_ids: string[] | null
  after: unknown
  created_at: Date | string
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function mapFailure(row: AuditRow): JobFinalFailure | undefined {
  const after = recordOf(row.after)
  if (after === undefined) return undefined
  const name = text(after['name'])
  const error = text(after['error'])
  const attempt = finiteNumber(after['attempt'])
  const retryLimit = finiteNumber(after['retryLimit'])
  const at = text(after['at']) ?? iso(row.created_at)
  const jobId = row.target_ids?.[0] ?? text(after['jobId'])
  if (name === undefined || error === undefined || attempt === undefined || retryLimit === undefined || at === undefined || jobId === undefined) {
    return undefined
  }
  return {
    jobId,
    name,
    payload: typeof after['payload'] === 'string' ? after['payload'] : '',
    error,
    attempt,
    retryLimit,
    at,
  }
}

/**
 * 任务最终失败的持久日志。
 *
 * 使用现有 `omb.audit_log`，因此最终失败既能被 `omb_admin audit` 看到，也满足
 * SPEC「最终失败写审计」；不单独建表，避免同一事实出现两个写者。审计动作不带
 * inverse：最终失败不是数据变更，回滚没有意义。
 */
export class PostgresJobFailureLog implements JobFailureLog {
  constructor(private readonly db: PostgresDb) {}

  async record(failure: JobFinalFailure): Promise<void> {
    await this.db.transaction(async client => {
      await client.query(
        `insert into omb.audit_log (actor, action, target_ids, after, job_id)
         values ('job', $1, $2::text[], $3::jsonb, $4)`,
        [
          JOB_FINAL_FAILURE_ACTION,
          [failure.jobId],
          JSON.stringify({
            jobId: failure.jobId,
            name: failure.name,
            payload: failure.payload,
            error: failure.error,
            attempt: failure.attempt,
            retryLimit: failure.retryLimit,
            at: failure.at,
          }),
          failure.jobId,
        ],
      )
    })
  }

  /**
   * 记录一次同名任务成功，解除此前未解除的最终失败。
   *
   * 只在确有未解除失败时插入，避免每个周期任务都写一条审计；恢复行不删除旧失败，
   * 审计历史仍完整。并发成功最多重复写两条恢复行，不影响计数语义。
   */
  async recordRecovery(name: string, at: string): Promise<void> {
    await this.db.query(
      `insert into omb.audit_log (actor, action, after)
       select 'job', $2, jsonb_build_object('name', $1::text, 'at', $3::text)
       where exists (
         select 1 from omb.audit_log f
         where f.action = $4
           and f.after->>'name' = $1
           and not exists (
             select 1 from omb.audit_log r
             where r.action = $2
               and r.after->>'name' = $1
               and r.created_at > f.created_at
           )
       )`,
      [name, JOB_RECOVERED_ACTION, at, JOB_FINAL_FAILURE_ACTION],
    )
  }

  async summary(limit = 5): Promise<JobFinalFailureSummary> {
    const pageSize = Number.isSafeInteger(limit) ? Math.min(20, Math.max(1, limit)) : 5
    const unresolved = `not exists (
      select 1 from omb.audit_log r
      where r.action = $2
        and r.after->>'name' = f.after->>'name'
        and r.created_at > f.created_at
    )`
    const [count, rows] = await Promise.all([
      this.db.query<{ count: string }>(
        `select count(*)::text as count from omb.audit_log f
         where f.action = $1 and ${unresolved}`,
        [JOB_FINAL_FAILURE_ACTION, JOB_RECOVERED_ACTION],
      ),
      this.db.query<AuditRow>(
        `select f.target_ids, f.after, f.created_at
         from omb.audit_log f
         where f.action = $1 and ${unresolved}
         order by f.created_at desc, f.id desc
         limit $3`,
        [JOB_FINAL_FAILURE_ACTION, JOB_RECOVERED_ACTION, pageSize],
      ),
    ])
    return {
      count: Number.parseInt(count.rows[0]?.count ?? '0', 10) || 0,
      recent: rows.rows.map(mapFailure).filter((failure): failure is JobFinalFailure => failure !== undefined),
    }
  }
}
