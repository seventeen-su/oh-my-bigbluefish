/**
 * 巩固任务的 durable 调度：把「10 分钟一轮」的旧 loop 换成 omb.timer 里的行。
 *
 * - `schedule` 直接走 timer 适配器（同 dedupeKey 是重排期，不是新增行）；
 * - `armed` 一次查询判断“该任务是否已有 pending/claimed 行”；
 * - timer handler 到期派发一次：默认只把对应任务入队 pg-boss 一次；`omb.forget` 走真实
 *   workflow——到期按「期」幂等 start 一个 run，run 的 step 调用同一个 `runForget`，
 *   本期执行完由 step 把同一 dedupeKey rearm 到下一网格点。
 *
 * 没有 setInterval/固定节拍：启动只做一次幂等 ensure，之后由 timer 到期 + 任务执行完的
 * rearm 续期。本模块也提供 `omb_status` 的巩固读数与断链自愈（只在 status 被真实调用时发生）。
 */
import { createConsolidationScheduler, runForget } from '../../packages/v7/src/jobs/index.js'
import { createForgetWorkflow } from '../../packages/v7/src/app/workflow/business.js'
import type { WorkflowDefinition } from '../../packages/v7/src/app/workflow/index.js'
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { PostgresTimerStore } from '../../packages/v7/src/adapters/postgres/timer.js'
import type { TimerHandler } from '../../packages/v7/src/app/workflow/index.js'
import type { Clock } from '../../packages/v7/src/ports/clock.js'
import type { JobQueue, Logger } from '../../packages/v7/src/ports/jobs.js'
import type { MaintenanceQueries } from '../../packages/v7/src/ports/maintenance.js'
import { messageOf } from './messages.js'

export type ConsolidationScheduler = ReturnType<typeof createConsolidationScheduler>
type ConsolidationSchedule = ConsolidationScheduler['schedules'][number]

export interface ConsolidationRuntimeDeps {
  readonly store: PostgresStore
  readonly queue: JobQueue
  readonly clock: Clock
  readonly logger: Logger
  /** timer 适配器无状态：worker 与 durable 调度共用一个实例，避免两套连接/两套语义。 */
  readonly timerStore: PostgresTimerStore
  /** forget workflow 的 step 与后台 handler 用同一份维护查询（同一批可遗忘条目）。 */
  readonly queries: MaintenanceQueries
  /** 未启动/启动失败时的原因：读 `startup.error`，不在这里缓存第二份状态。 */
  readonly startupError: () => string | undefined
}

export interface ConsolidationRuntime {
  /** 供 `registerConsolidationJobs` 注入：调度驱动的任务执行完在 finally 里 rearm。 */
  readonly scheduler: ConsolidationScheduler
  /** 到期派发一次：默认入队 pg-boss；forget 改为 start 一个真实 workflow run。 */
  readonly timerHandler: TimerHandler
  /** 注册进 WorkflowRuntime 的真实业务定义（当前只有 forget）；status 从这里读名字。 */
  readonly workflows: readonly WorkflowDefinition[]
  /** event-runtime 启动 workflow runtime 后回填：timer 到期才有地方 start run。 */
  bindWorkflowStart(start: WorkflowRunStarter): void
  /** 只给真实注册了 handler 的任务排期。 */
  schedules(): readonly ConsolidationSchedule[]
  /** 注册成功后回填：没有 handler 的任务不建空跑 timer。 */
  setRegisteredJobs(jobs: readonly string[]): void
  /** 启动/断链恢复的幂等排期；成功后 `started` 才变为 true。 */
  ensure(): Promise<void>
  /** `omb_status` 的巩固读数（含一次有界自愈）。 */
  statusLines(): Promise<string[]>
}

/** forget 在巩固任务表里的任务名：调度、workflow、rearm 三处必须同一个值。 */
const FORGET_JOB = 'omb.forget'

/** 按幂等键启动一个已注册 run 的回调；event-runtime 在 workflow runtime 就绪后绑定。 */
type WorkflowRunStarter = (name: string, idempotencyKey: string) => Promise<unknown>

export function createConsolidationRuntime(deps: ConsolidationRuntimeDeps): ConsolidationRuntime {
  const { store, clock, logger } = deps
  /** 真实注册成功的巩固任务名：只给它们排期，没 handler 的任务不建空跑 timer。 */
  let consolidationJobs: readonly string[] = []
  let consolidationStarted = false
  /** 由 event-runtime 在 workflow runtime 就绪后回填；缺省时 forget 的 timer 派发会明确抛错。 */
  let workflowStart: WorkflowRunStarter | undefined

  /**
   * 已有 pending/claimed timer 的 dedupeKey（一次查询）。
   *
   * 同时给调度器的排期和 status 的自愈判据用：armed 的任务不动，缺失的才补。
   */
  async function readArmedConsolidationKeys(keys: readonly string[]): Promise<ReadonlySet<string>> {
    if (keys.length === 0) return new Set<string>()
    const rows = await store.db.query<{ dedupe_key: string }>(
      `select distinct dedupe_key
         from omb.timer
        where dedupe_key = any($1::text[]) and status in ('pending', 'claimed')`,
      [keys],
    )
    return new Set(rows.rows.map(row => row.dedupe_key))
  }

  /**
   * forget 的真实业务定义：step 只做两件事——调用与后台队列**同一个** `runForget`，
   * 然后把同一 dedupeKey 的 timer rearm 到下一网格点。
   */
  const forgetWorkflow = createForgetWorkflow({
    forget: request => runForget({ store, queries: deps.queries, clock, logger }, {
      commandId: request.commandId,
      now: request.now,
      signal: request.signal,
    }),
    rearm: () => scheduler.rearm(FORGET_JOB),
  })

  function bindWorkflowStart(start: WorkflowRunStarter): void {
    workflowStart = start
  }

  const scheduler = createConsolidationScheduler({
    timers: {
      schedule: input => deps.timerStore.schedule(input),
      armed: keys => readArmedConsolidationKeys(keys),
    },
    queue: deps.queue,
    clock,
    logger,
    // 调度侧看到的 forget：到期只 start 一个 run。`start` 延迟绑定——workflow runtime
    // 在 event-runtime 里构造，晚于本模块；未绑定时明确抛错让 timer 退避，不静默空转。
    workflow: {
      job: FORGET_JOB,
      workflow: forgetWorkflow.name,
      start: async (name, idempotencyKey) => {
        const start = workflowStart
        if (start === undefined) throw new Error('workflow runtime 尚未就绪：omb.forget 不能降级为空转')
        return await start(name, idempotencyKey)
      },
    },
  })

  /**
   * 只给真实注册了 handler 的任务排期：没有 handler 的 timer 到期只会入队一个
   * 没人消费的 pg-boss 任务（看起来在跑，实际空转）。
   */
  function schedules(): readonly ConsolidationSchedule[] {
    return scheduler.schedules.filter(schedule => consolidationJobs.includes(schedule.job))
  }

  async function ensure(): Promise<void> {
    if (consolidationStarted) return
    const selected = schedules()
    const ensured = await scheduler.ensure(selected.map(schedule => schedule.job))
    consolidationStarted = true
    logger.info('巩固任务 durable 调度已就绪', {
      jobs: selected.map(schedule => schedule.job),
      dedupeKeys: selected.map(schedule => schedule.dedupeKey),
      scheduledNow: ensured.scheduled,
      armed: ensured.armed,
      driver: 'timer/omb.consolidation',
    })
  }

  function setRegisteredJobs(jobs: readonly string[]): void {
    consolidationJobs = jobs
  }

  interface ConsolidationTimerSnapshot {
    readonly pending: number
    readonly claimed: number
    readonly done: number
    readonly dead: number
    readonly dueAgeMs: number
    readonly nextDueAt?: string
  }

  /** 巩固调度的 timer 行读数：只认 `consolidation:` 前缀，业务 timer 不混进来。 */
  async function readConsolidationTimers(): Promise<ConsolidationTimerSnapshot> {
    const result = await store.db.query<{
      pending: number
      claimed: number
      done: number
      dead: number
      due_age_ms: number
      next_due: Date | string | null
    }>(
      `select
         count(*) filter (where status = 'pending')::int as pending,
         count(*) filter (where status = 'claimed')::int as claimed,
         count(*) filter (where status = 'done')::int as done,
         count(*) filter (where status = 'dead')::int as dead,
         coalesce(
           (extract(epoch from (
             now() - min(due_at) filter (where status in ('pending', 'claimed') and due_at <= now())
           )) * 1000)::int,
           0
         ) as due_age_ms,
         min(due_at) filter (where status in ('pending', 'claimed')) as next_due
       from omb.timer
      where dedupe_key like 'consolidation:%'`,
    )
    const row = result.rows[0]
    if (row === undefined) return { pending: 0, claimed: 0, done: 0, dead: 0, dueAgeMs: 0 }
    return {
      pending: row.pending,
      claimed: row.claimed,
      done: row.done,
      dead: row.dead,
      dueAgeMs: Math.max(0, Number(row.due_age_ms ?? 0)),
      ...(row.next_due === null ? {} : { nextDueAt: new Date(row.next_due).toISOString() }),
    }
  }

  /** 巩固任务在 pg-boss 里还没跑完的行（created/retry/active），按任务名聚合。 */
  async function readConsolidationQueued(
    selected: readonly { readonly job: string }[],
  ): Promise<{ readonly total: number; readonly names: ReadonlySet<string> }> {
    if (selected.length === 0) return { total: 0, names: new Set<string>() }
    const result = await store.db.query<{ name: string; queued: number }>(
      `select name, count(*)::int as queued
         from pgboss.job
        where name = any($1::text[]) and state in ('created', 'retry', 'active')
        group by name`,
      [selected.map(schedule => schedule.job)],
    )
    let total = 0
    for (const row of result.rows) total += row.queued
    return { total, names: new Set(result.rows.map(row => row.name)) }
  }

  /**
   * `omb_status` 的巩固调度读数：必须与业务 timer 分开看。
   *
   * `timerPending/Claimed/...` 是 **全部** timer 的聚合，包含 consolidation 的 durable
   * schedule 行（合法 pending，不是泄漏）；这里的 consolidation* 给出其中属于巩固调度的
   * 份额，两者相减才是 workflow wake / 提醒等业务 timer 的空闲读数。
   *
   * 有界自愈：status 是一次真实观测，按任务判断“没有 armed timer 且队列里也没有在跑的
   * 同名任务”就补排一次。它不是轮询——只有 omb_status 被调用时才发生；也不会把正常在途
   * 误判成断链（timer handler 先入队再 complete，任务先 rearm 再 complete）。
   */
  async function statusLines(): Promise<string[]> {
    if (!consolidationStarted) {
      return ['consolidation=unknown', `consolidationReason=${deps.startupError() ?? 'not-started'}`]
    }
    const selected = schedules()
    try {
      const armed = await readArmedConsolidationKeys(selected.map(schedule => schedule.dedupeKey))
      const queued = await readConsolidationQueued(selected).catch(error => {
        logger.warn('巩固任务队列计数失败', messageOf(error))
        return undefined
      })
      let repaired = false
      if (queued !== undefined) {
        // 断链判据按任务看：没有 armed timer，队列里也没有同名在跑的任务。
        const missing = selected.filter(schedule => (
          !armed.has(schedule.dedupeKey) && !queued.names.has(schedule.job)
        ))
        if (missing.length > 0) {
          const ensured = await scheduler.ensure(missing.map(schedule => schedule.job))
          if (ensured.scheduled.length > 0) {
            logger.warn('巩固任务的 timer 链路缺失，已按 durable schedule 补排', { jobs: ensured.scheduled })
            repaired = true
          }
        }
      }
      const snapshot = await readConsolidationTimers()
      const queuedAfter = repaired
        ? await readConsolidationQueued(selected).catch(() => undefined)
        : queued
      const nextDueMs = snapshot.nextDueAt === undefined
        ? 'none'
        : String(Math.max(0, Date.parse(snapshot.nextDueAt) - clock.now().getTime()))
      return [
        'consolidation=ok',
        `consolidationJobs=${selected.map(schedule => schedule.job).join(',') || 'none'}`,
        `consolidationModes=${selected.map(schedule => `${schedule.job}:${schedule.mode}`).join(',') || 'none'}`,
        `consolidationPending=${snapshot.pending} consolidationClaimed=${snapshot.claimed} consolidationDone=${snapshot.done} consolidationDead=${snapshot.dead}`,
        `consolidationDueAgeMs=${snapshot.dueAgeMs} consolidationNextDueMs=${nextDueMs} consolidationQueued=${queuedAfter?.total ?? 'unknown'}`,
      ]
    } catch (error) {
      return ['consolidation=unknown', `consolidationReason=${messageOf(error)}`]
    }
  }

  return {
    scheduler,
    timerHandler: scheduler.timerHandler,
    workflows: [forgetWorkflow],
    bindWorkflowStart,
    schedules,
    setRegisteredJobs,
    ensure,
    statusLines,
  }
}
