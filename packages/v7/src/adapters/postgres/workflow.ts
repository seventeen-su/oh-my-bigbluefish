import type { QueryResultRow } from 'pg'
import type {
  ClaimedWorkflowRun,
  WorkflowAbandonInput,
  WorkflowBeginStepInput,
  WorkflowCancelInput,
  WorkflowClaimOptions,
  WorkflowCompensateInput,
  WorkflowCompleteStepInput,
  WorkflowFailInput,
  WorkflowFailResult,
  WorkflowRecoveryReport,
  WorkflowReleaseInput,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowStartInput,
  WorkflowStartResult,
  WorkflowStats,
  WorkflowStepRecord,
  WorkflowStepStatus,
  WorkflowStore,
} from '../../app/workflow/index.js'
import { iso, PostgresDb } from './db.js'

interface RunRow extends QueryResultRow {
  id: string
  name: string
  version: number
  state: unknown
  step: string | null
  status: string
  attempts: number
  next_run_at: Date | string | null
  last_error: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface StepRow extends QueryResultRow {
  run_id: string
  step: string
  attempt: number
  status: string
  input: unknown
  output: unknown
  error: string | null
  started_at: Date | string
  finished_at: Date | string | null
  compensated_at: Date | string | null
}

interface IdRow extends QueryResultRow {
  id: string
}

interface CountRow extends QueryResultRow {
  count: number
}

interface StatsRow extends QueryResultRow {
  pending: number
  running: number
  waiting: number
  completed: number
  failed: number
  dead: number
  cancelled: number
  oldest_due_age_ms: string | number | null
}

interface NextDueRow extends QueryResultRow {
  next_run_at: Date | string | null
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'dead',
  'cancelled',
]

const STEP_STATUSES: readonly WorkflowStepStatus[] = ['running', 'completed', 'failed', 'compensated']

const RUN_COLUMNS = `id, name, version, state, step, status, attempts, next_run_at, last_error, created_at, updated_at`

const STEP_COLUMNS = `run_id, step, attempt, status, input, output, error, started_at, finished_at, compensated_at`

/**
 * claim 生产 SQL，导出以便 EXPLAIN 诊断与测试断言 due 索引被使用。
 *
 * `$1` 批大小，`$2` 租约毫秒。CTE 里的 `FOR UPDATE SKIP LOCKED` 是并发安全的唯一依据：
 * 第二个 worker 跳过已被锁住的行，不阻塞也不会重复领取。
 * `next_run_at` 在可执行/等待状态上恒非空（start 与 claim 都会写），因此过滤条件可走
 * `workflow_run_due (status, next_run_at)` 部分索引；completed/dead/cancelled 不在索引里。
 * 崩溃的 running 行在租约到期后（next_run_at 就是租约到期时间）同样满足条件，可被重领。
 */
export const WORKFLOW_CLAIM_SQL = `
with due as (
  select id
  from omb.workflow_run
  where status in ('pending', 'running', 'waiting')
    and next_run_at <= now()
  order by next_run_at, id
  for update skip locked
  limit $1
)
update omb.workflow_run target
set status = 'running',
    attempts = target.attempts + 1,
    next_run_at = now() + ($2::int * interval '1 millisecond'),
    updated_at = now()
from due
where target.id = due.id
returning target.id, target.name, target.version, target.state, target.step,
          target.status, target.attempts, target.next_run_at, target.last_error,
          target.created_at, target.updated_at
`

const START_SQL = `
insert into omb.workflow_run
  (id, name, version, state, step, status, attempts, next_run_at, idempotency_key, created_at, updated_at)
values
  ($1, $2, $3, $4::jsonb, $5,
   case when coalesce($6::timestamptz, now()) > now() then 'waiting' else 'pending' end,
   0, coalesce($6::timestamptz, now()), $7, now(), now())
on conflict (idempotency_key) do nothing
returning id
`

const GET_SQL = `select ${RUN_COLUMNS} from omb.workflow_run where id = $1`

const STEPS_SQL = `
select ${STEP_COLUMNS}
  from omb.workflow_step
 where run_id = $1
 order by started_at asc, attempt asc
`

const SELECT_STEP_SQL = `
select ${STEP_COLUMNS}
  from omb.workflow_step
 where run_id = $1 and step = $2 and attempt = $3
`

const BEGIN_STEP_SQL = `
insert into omb.workflow_step (run_id, step, attempt, status, input, started_at)
values ($1, $2, $3, 'running', $4::jsonb, now())
on conflict (run_id, step, attempt) do nothing
returning ${STEP_COLUMNS}
`

/**
 * checkpoint 的两半必须在同一事务里，先做 run 的 CAS 再做 step：
 * - run update 是栅栏：attempts 不匹配 = 租约已被接管，整笔回滚，旧 worker 不落结果；
 * - step update 只允许 running → completed；0 行说明 checkpoint 状态异常，整笔回滚。
 */
const RUN_CHECKPOINT_SQL = `
update omb.workflow_run
   set state = $3::jsonb,
       step = $4::text,
       status = case when $4::text is null then 'completed' else 'running' end,
       next_run_at = case when $4::text is null then null else now() end,
       last_error = null,
       updated_at = now()
 where id = $1 and attempts = $2 and status = 'running'
`

const STEP_CHECKPOINT_SQL = `
update omb.workflow_step
   set status = 'completed', output = $4::jsonb, error = null, finished_at = now()
 where run_id = $1 and step = $2 and attempt = $3 and status = 'running'
`

const RUN_FAIL_SQL = `
update omb.workflow_run
   set status = case when $4::boolean then 'dead' else 'pending' end,
       next_run_at = case when $4::boolean then null else coalesce($5::timestamptz, now()) end,
       last_error = $3,
       updated_at = now()
 where id = $1 and attempts = $2 and status = 'running'
`

const STEP_FAIL_SQL = `
update omb.workflow_step
   set status = 'failed', error = $4, finished_at = now()
 where run_id = $1 and step = $2 and attempt = $3 and status = 'running'
`

const FAILURES_SQL = `
select count(*)::int as count
  from omb.workflow_step
 where run_id = $1 and step = $2 and status = 'failed'
`

const STEP_COMPENSATE_SQL = `
update omb.workflow_step
   set status = 'compensated', compensated_at = now()
 where run_id = $1 and step = $2 and attempt = $3 and status = 'completed'
`

const CANCEL_BY_ATTEMPT_SQL = `
update omb.workflow_run
   set status = 'cancelled', next_run_at = null, updated_at = now()
 where id = $1 and attempts = $2 and status in ('running', 'pending', 'waiting')
`

/** 没有有效租约的 run 才能被外部取消；running 且租约未过期的由持有者自己取消。 */
const CANCEL_OWNERLESS_SQL = `
update omb.workflow_run
   set status = 'cancelled', next_run_at = null, updated_at = now()
 where id = $1
   and (status in ('pending', 'waiting', 'failed', 'dead')
        or (status = 'running' and next_run_at <= now()))
`

const RETRY_SQL = `
update omb.workflow_run
   set status = 'pending', next_run_at = now(), last_error = null, updated_at = now()
 where id = $1 and status in ('dead', 'failed')
`

const RELEASE_SQL = `
update omb.workflow_run
   set status = 'pending', next_run_at = now(), updated_at = now()
 where id = $1 and attempts = $2 and status = 'running'
`

const ABANDON_SQL = `
update omb.workflow_run
   set status = 'dead', next_run_at = null, last_error = $3, updated_at = now()
 where id = $1 and attempts = $2 and status = 'running'
`

/**
 * 启动恢复：租约过期的 running 回到 pending（attempts 保留，下次 claim 继续 +1），
 * 然后统计现在可领取的数量。它是“扫 pending/running”的唯一入口，不做全表扫描：
 * 只碰 `status='running' and next_run_at <= now()` 的行。
 */
const RECOVER_SQL = `
with recovered as (
  update omb.workflow_run
     set status = 'pending', next_run_at = now(), updated_at = now()
   where status = 'running' and next_run_at <= now()
   returning id
)
select count(*)::int as count from recovered
`

const DUE_COUNT_SQL = `
select count(*)::int as count
  from omb.workflow_run
 where status in ('pending', 'waiting') and next_run_at <= now()
`

const STATS_SQL = `
select
  count(*) filter (where status = 'pending')::int as pending,
  count(*) filter (where status = 'running')::int as running,
  count(*) filter (where status = 'waiting')::int as waiting,
  count(*) filter (where status = 'completed')::int as completed,
  count(*) filter (where status = 'failed')::int as failed,
  count(*) filter (where status = 'dead')::int as dead,
  count(*) filter (where status = 'cancelled')::int as cancelled,
  coalesce(
    (extract(
      epoch from (
        now() - min(next_run_at) filter (where status in ('pending', 'waiting') and next_run_at <= now())
      )
    ) * 1000)::bigint,
    0
  ) as oldest_due_age_ms
from omb.workflow_run
`

const NEXT_DUE_SQL = `
select min(next_run_at) as next_run_at
  from omb.workflow_run
 where status in ('pending', 'running', 'waiting')
`

/** checkpoint 的 CAS 丢失：用不带 SQL 的标记把事务整体回滚，再对外返回 false。 */
class WorkflowCasLost extends Error {}

export class PostgresWorkflowStore implements WorkflowStore {
  constructor(private readonly db: PostgresDb) {}

  async start(input: WorkflowStartInput): Promise<WorkflowStartResult> {
    try {
      const inserted = await this.db.query<IdRow>(START_SQL, [
        input.id,
        input.name,
        input.version,
        JSON.stringify(input.state),
        input.step,
        input.runAt === undefined ? null : input.runAt.toISOString(),
        input.idempotencyKey,
      ])
      const row = inserted.rows[0]
      if (row !== undefined) return { runId: row.id, inserted: true }
      const existing = await this.findByKey(input.idempotencyKey)
      if (existing !== undefined) return { runId: existing, inserted: false }
      throw new Error(`workflow start 未插入也未找到幂等键：${input.idempotencyKey}`)
    } catch (error) {
      // 并发 start 同一幂等键：唯一索引竞争失败的一方按“已存在”返回首次 run。
      if (isUniqueViolation(error)) {
        const existing = await this.findByKey(input.idempotencyKey)
        if (existing !== undefined) return { runId: existing, inserted: false }
      }
      throw error
    }
  }

  async get(runId: string): Promise<WorkflowRunSnapshot | undefined> {
    const result = await this.db.query<RunRow>(GET_SQL, [runId])
    const row = result.rows[0]
    return row === undefined ? undefined : toRunSnapshot(row)
  }

  async steps(runId: string): Promise<readonly WorkflowStepRecord[]> {
    const result = await this.db.query<StepRow>(STEPS_SQL, [runId])
    return result.rows.map(toStepRecord)
  }

  async claimDue(options: WorkflowClaimOptions): Promise<readonly ClaimedWorkflowRun[]> {
    const result = await this.db.query<RunRow>(WORKFLOW_CLAIM_SQL, [
      clampInt(options.limit, 1, 500),
      clampInt(options.leaseMs, 1, 3_600_000),
    ])
    return result.rows.map(toRunSnapshot)
  }

  async beginStep(input: WorkflowBeginStepInput): Promise<WorkflowStepRecord> {
    const inserted = await this.db.query<StepRow>(BEGIN_STEP_SQL, [
      input.runId,
      input.step,
      input.attempt,
      JSON.stringify(input.input),
    ])
    const row = inserted.rows[0]
    if (row !== undefined) return toStepRecord(row)
    const existing = await this.db.query<StepRow>(SELECT_STEP_SQL, [input.runId, input.step, input.attempt])
    const found = existing.rows[0]
    if (found === undefined) {
      throw new Error(`workflow_step 打开失败且不存在：${input.runId}/${input.step}/${input.attempt}`)
    }
    return toStepRecord(found)
  }

  async completeStep(input: WorkflowCompleteStepInput): Promise<boolean> {
    try {
      await this.db.transaction(async client => {
        // 先做 run 的 CAS：attempts 不匹配说明租约已被接管，整笔回滚、旧 worker 不写结果。
        const run = await client.query(RUN_CHECKPOINT_SQL, [
          input.runId,
          input.attempt,
          JSON.stringify(input.state),
          input.nextStep,
        ])
        if (run.rowCount !== 1) throw new WorkflowCasLost('run')
        const step = await client.query(STEP_CHECKPOINT_SQL, [
          input.runId,
          input.step,
          input.attempt,
          JSON.stringify(input.output),
        ])
        if (step.rowCount !== 1) throw new WorkflowCasLost('step')
      })
      return true
    } catch (error) {
      if (error instanceof WorkflowCasLost) return false
      throw error
    }
  }

  async failStep(input: WorkflowFailInput): Promise<WorkflowFailResult> {
    try {
      return await this.db.transaction(async client => {
        const dead = input.dead === true
        const run = await client.query(RUN_FAIL_SQL, [
          input.runId,
          input.attempt,
          errorText(input.error),
          dead,
          dead || input.retryAt === undefined ? null : input.retryAt.toISOString(),
        ])
        if (run.rowCount !== 1) throw new WorkflowCasLost('run')
        const step = await client.query(STEP_FAIL_SQL, [
          input.runId,
          input.step,
          input.attempt,
          errorText(input.error),
        ])
        if (step.rowCount !== 1) throw new WorkflowCasLost('step')
        const failures = await client.query<CountRow>(FAILURES_SQL, [input.runId, input.step])
        return { applied: true, failures: failures.rows[0]?.count ?? 0 }
      })
    } catch (error) {
      if (error instanceof WorkflowCasLost) return { applied: false, failures: 0 }
      throw error
    }
  }

  async compensateStep(input: WorkflowCompensateInput): Promise<boolean> {
    const result = await this.db.query(STEP_COMPENSATE_SQL, [input.runId, input.step, input.attempt])
    return result.rowCount === 1
  }

  async cancel(input: WorkflowCancelInput): Promise<boolean> {
    const result = input.attempt === undefined
      ? await this.db.query(CANCEL_OWNERLESS_SQL, [input.runId])
      : await this.db.query(CANCEL_BY_ATTEMPT_SQL, [input.runId, input.attempt])
    return result.rowCount === 1
  }

  async retryRun(runId: string): Promise<boolean> {
    const result = await this.db.query(RETRY_SQL, [runId])
    return result.rowCount === 1
  }

  async release(input: WorkflowReleaseInput): Promise<boolean> {
    const result = await this.db.query(RELEASE_SQL, [input.runId, input.attempt])
    return result.rowCount === 1
  }

  async abandon(input: WorkflowAbandonInput): Promise<boolean> {
    const result = await this.db.query(ABANDON_SQL, [input.runId, input.attempt, errorText(input.error)])
    return result.rowCount === 1
  }

  async recover(): Promise<WorkflowRecoveryReport> {
    return this.db.transaction(async client => {
      const recovered = await client.query<CountRow>(RECOVER_SQL)
      const due = await client.query<CountRow>(DUE_COUNT_SQL)
      return {
        recovered: recovered.rows[0]?.count ?? 0,
        due: due.rows[0]?.count ?? 0,
      }
    })
  }

  async stats(): Promise<WorkflowStats> {
    const result = await this.db.query<StatsRow>(STATS_SQL)
    const row = result.rows[0]
    if (row === undefined) {
      return { pending: 0, running: 0, waiting: 0, completed: 0, failed: 0, dead: 0, cancelled: 0, oldestDueAgeMs: 0 }
    }
    return {
      pending: row.pending,
      running: row.running,
      waiting: row.waiting,
      completed: row.completed,
      failed: row.failed,
      dead: row.dead,
      cancelled: row.cancelled,
      oldestDueAgeMs: Math.max(0, Number(row.oldest_due_age_ms ?? 0)),
    }
  }

  async nextDueAt(): Promise<string | undefined> {
    const result = await this.db.query<NextDueRow>(NEXT_DUE_SQL)
    return iso(result.rows[0]?.next_run_at ?? null)
  }

  private async findByKey(idempotencyKey: string): Promise<string | undefined> {
    const result = await this.db.query<IdRow>(
      'select id from omb.workflow_run where idempotency_key = $1',
      [idempotencyKey],
    )
    return result.rows[0]?.id
  }
}

function toRunSnapshot(row: RunRow): WorkflowRunSnapshot {
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    state: row.state as WorkflowRunSnapshot['state'],
    step: row.step,
    status: asRunStatus(row.status),
    attempts: Number(row.attempts),
    ...(iso(row.next_run_at) !== undefined ? { nextRunAt: iso(row.next_run_at) as string } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  }
}

function toStepRecord(row: StepRow): WorkflowStepRecord {
  return {
    runId: row.run_id,
    step: row.step,
    attempt: Number(row.attempt),
    status: asStepStatus(row.status),
    ...(row.input !== null ? { input: row.input as WorkflowStepRecord['input'] } : {}),
    ...(row.output !== null ? { output: row.output as WorkflowStepRecord['output'] } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    startedAt: iso(row.started_at) as string,
    ...(iso(row.finished_at) !== undefined ? { finishedAt: iso(row.finished_at) as string } : {}),
    ...(iso(row.compensated_at) !== undefined ? { compensatedAt: iso(row.compensated_at) as string } : {}),
  }
}

function asRunStatus(value: string): WorkflowRunStatus {
  const status = RUN_STATUSES.find(item => item === value)
  if (status === undefined) throw new Error(`未知的 workflow_run.status：${value}`)
  return status
}

function asStepStatus(value: string): WorkflowStepStatus {
  const status = STEP_STATUSES.find(item => item === value)
  if (status === undefined) throw new Error(`未知的 workflow_step.status：${value}`)
  return status
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

const MAX_ERROR_LENGTH = 4_000

function errorText(value: string): string {
  const text = value.trim().length > 0 ? value : 'unknown error'
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
