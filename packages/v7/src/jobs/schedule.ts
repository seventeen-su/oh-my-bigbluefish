import type { JsonValue } from '../domain/json.js'
import { isPlainObject } from '../domain/json.js'
import type { Clock } from '../ports/clock.js'
import type { JobQueue, Logger } from '../ports/jobs.js'
import type { TimerContext, TimerHandler, TimerScheduleInput, TimerTask } from '../app/workflow/index.js'
import type { ConsolidationDeps } from './consolidate.js'
import { CONSOLIDATION_JOBS, type ConsolidationJobName } from './names.js'
import { createConsolidationJobRunners, type ConsolidationJobContext } from './runners.js'

export { CONSOLIDATION_JOBS, type ConsolidationJobName } from './names.js'

/**
 * 巩固任务的 durable 调度（ADR-0011）：把「10 分钟一轮」的旧 loop 换成 omb.timer 里的行。
 *
 * 与 `consolidate.ts` / `runners.ts` 的分工：那边是每个任务**做什么**（纯 handler），这边是
 * 任务**何时**执行（稳定 dedupeKey + due_at 网格 + 到期派发 + 执行完续期）。拆开的原因：
 *  1. 调度策略只有组合根关心，任务处理器可以单独测试/复用；
 *  2. 没有 setInterval/固定节拍——启动只做一次幂等 ensure，之后由 timer 到期 + 任务执行
 *     完的 rearm 续期；
 *  3. 到期派发互斥：配置了 workflow 的任务到期只按「期」幂等 start 一个真实 run；没有配置
 *     的旧装配仍入队 pg-boss，两者互斥，同一任务不会双跑。
 */

/** 「按幂等键启动一个已注册 run」：幂等键由调度方按「期」生成，重放返回已有 run。 */
export type WorkflowRunStarter = (name: string, idempotencyKey: string) => Promise<unknown>

/**
 * 一个由 workflow（而不是 pg-boss 队列）执行的巩固任务：timer 到期只按「期」幂等 start，
 * 本期执行完由 step 的 `rearm` 续期（不在 handler 里改 timer 行，见 timerHandler 注释）。
 */
export interface ConsolidationWorkflowDispatch {
  readonly job: ConsolidationJobName
  /** 已注册在 WorkflowRuntime 里的定义名；调度只按名字启动，不解释步骤。 */
  readonly workflow: string
  readonly start: WorkflowRunStarter
}

const CONSOLIDATION_TIMER_TOPIC = 'omb.consolidation'
/** timer 入队时写入的触发标记：只有调度驱动的执行才续期。 */
const CONSOLIDATION_TRIGGER = 'omb.consolidation'

export type ConsolidationMode = 'event' | 'time' | 'fallback'

export interface ConsolidationSchedule {
  readonly job: ConsolidationJobName
  readonly dedupeKey: string
  readonly intervalMs: number
  readonly mode: ConsolidationMode
}

const MINUTE_MS = 60 * 1000
const EVENT_FALLBACK_MS = 2 * 60 * MINUTE_MS
const EXTRACT_FALLBACK_MS = 15 * MINUTE_MS
const REFRESH_INTERVAL_MS = 10 * MINUTE_MS
const EMBED_SWEEP_INTERVAL_MS = 30 * MINUTE_MS
const LOW_FREQUENCY_MS = 6 * 60 * MINUTE_MS

const CONSOLIDATION_MODES: Readonly<Record<ConsolidationJobName, ConsolidationMode>> = {
  'omb.extract': 'event',
  'omb.reference-rot': 'event',
  'omb.clue-promote': 'event',
  'omb.dedupe': 'event',
  'omb.conflict': 'event',
  'omb.link-suggest': 'event',
  'omb.refresh': 'time',
  'omb.embed-sweep': 'time',
  'omb.forget': 'fallback',
  'omb.attr-alias': 'fallback',
}

const CONSOLIDATION_INTERVALS: Readonly<Record<ConsolidationJobName, number>> = {
  'omb.extract': EXTRACT_FALLBACK_MS,
  'omb.reference-rot': EVENT_FALLBACK_MS,
  'omb.clue-promote': EVENT_FALLBACK_MS,
  'omb.dedupe': EVENT_FALLBACK_MS,
  'omb.conflict': EVENT_FALLBACK_MS,
  'omb.link-suggest': EVENT_FALLBACK_MS,
  'omb.refresh': REFRESH_INTERVAL_MS,
  'omb.embed-sweep': EMBED_SWEEP_INTERVAL_MS,
  'omb.forget': LOW_FREQUENCY_MS,
  'omb.attr-alias': LOW_FREQUENCY_MS,
}

const CONSOLIDATION_SCHEDULES: readonly ConsolidationSchedule[] = CONSOLIDATION_JOBS.map(job => ({
  job,
  dedupeKey: `consolidation:${job}`,
  intervalMs: CONSOLIDATION_INTERVALS[job],
  mode: CONSOLIDATION_MODES[job],
}))

/** 组合根注入的 timer 能力（不 import pg、不认识表结构）。 */
export interface ConsolidationTimerPort {
  /** 同 dedupeKey 是重排期（覆盖 due_at），不是新增行。 */
  schedule(input: TimerScheduleInput): Promise<unknown>
  /** 已有 pending/claimed timer 的 dedupeKey 集合（一次查询）。 */
  armed(keys: readonly string[]): Promise<ReadonlySet<string>>
}

export interface ConsolidationScheduleResult {
  /** 本次真正补排的任务；空数组表示全部已 armed（幂等重入）。 */
  readonly scheduled: readonly string[]
  /** 已有 pending/claimed 行、本次没有改动的任务数。 */
  readonly armed: number
}

/** 巩固调度的窄接口：调用方只需要“排期/续期/一个 timer handler”。 */
export interface ConsolidationScheduler {
  /** 全部任务的调度描述（dedupeKey/周期）；调用方可以按已注册 handler 过滤。 */
  readonly schedules: readonly ConsolidationSchedule[]
  /**
   * 启动/断链恢复的幂等排期：
   * - 已有 pending/claimed 行（armed）完全不动：不把 due_at 往后推，崩溃期间到期的
   *   timer 保持逾期、恢复后立刻执行（at-least-once），也不会产生第二行；
   * - 没有行（首次启动、或链路断了）才补一条**立即到期**的 timer，等价旧 loop 的启动
   *   首轮，但只有一行且到期即入队一次。
   */
  ensure(jobs?: readonly string[]): Promise<ConsolidationScheduleResult>
  /** 调度驱动的任务执行完：把下一期排到网格点（同 dedupeKey 覆盖，行数恒定）。 */
  rearm(job: string): Promise<void>
  /** 到期派发一次：默认入队 pg-boss；配置了 workflow dispatch 的任务改为 start 一个 run。 */
  readonly timerHandler: TimerHandler
}

export interface ConsolidationSchedulerDeps {
  readonly timers: ConsolidationTimerPort
  readonly queue: JobQueue
  readonly clock: Clock
  readonly logger?: Logger
  /**
   * 由真实 workflow 执行的任务（当前 10 个巩固任务全部配置）。缺省/未配置时该任务仍走
   * pg-boss 入队的旧路径（测试与旧装配），两者互斥：同一任务只会有一种派发方式，不会双跑。
   */
  readonly workflows?: readonly ConsolidationWorkflowDispatch[]
}

function scheduleOf(job: string): ConsolidationSchedule {
  const schedule = CONSOLIDATION_SCHEDULES.find(item => item.job === job)
  if (schedule === undefined) throw new Error(`没有注册巩固任务：${job}`)
  return schedule
}

/**
 * 下一次到期：严格晚于 `now` 的 interval 网格点。
 *
 * 用网格而不是 `now + interval`：同一个 `now` 算出的 due_at 确定，重启/重复 rearm
 * 不会让下一期漂移；`+1ms` 保证永远在未来，避免“到期即再到期”的自激循环。
 */
function nextDue(now: Date, intervalMs: number): Date {
  const interval = Math.max(1, Math.trunc(intervalMs))
  return new Date(Math.ceil((now.getTime() + 1) / interval) * interval)
}

/**
 * 网格期号：同一期内的重试/重复派发得到同一个数字。
 *
 * 它随 timer 载荷一起落库（排期时按 `due_at` 写入），所以重试一条 timer 不会换期号，
 * workflow 的幂等键（`<dedupeKey>:<period>`）也就不会换。
 */
function periodOf(at: Date, intervalMs: number): number {
  return Math.floor(at.getTime() / Math.max(1, Math.trunc(intervalMs)))
}

/**
 * timer 载荷里的期号。
 *
 * 部署前已经排好的行只有 `{ job }`：按本次派发时刻的期号兜底，不把到期 timer 打成死信；
 * 本轮 rearm 会把带 period 的载荷写回去，之后的重试都稳定。
 */
function periodOfPayload(payload: JsonValue, intervalMs: number, now: Date): number {
  const period = isPlainObject(payload) ? payload['period'] : undefined
  if (typeof period === 'number' && Number.isInteger(period) && period >= 0) return period
  return periodOf(now, intervalMs)
}

function timerInput(schedule: ConsolidationSchedule, dueAt: Date): TimerScheduleInput {
  return {
    topic: CONSOLIDATION_TIMER_TOPIC,
    // period 是「这一期」的身份：workflow 幂等键与 pg-boss singletonKey 都从它派生。
    payload: { job: schedule.job, period: periodOf(dueAt, schedule.intervalMs) },
    dueAt,
    dedupeKey: schedule.dedupeKey,
  }
}

/** timer 载荷里的任务名；不合法时抛错让 timer 退避/死信，而不是静默空转。 */
function jobOfPayload(payload: JsonValue): ConsolidationJobName {
  const job = isPlainObject(payload) ? payload['job'] : undefined
  if (typeof job === 'string' && (CONSOLIDATION_JOBS as readonly string[]).includes(job)) {
    return job as ConsolidationJobName
  }
  throw new Error(`omb.consolidation timer 载荷非法：${JSON.stringify(payload)}`)
}

/** 该 pg-boss 任务是不是 consolidation timer 到期入队的（只有它执行完才续期）。 */
function isTriggered(payload: unknown): boolean {
  return isPlainObject(payload) && payload['trigger'] === CONSOLIDATION_TRIGGER
}

/**
 * 构造巩固任务调度器（组合根调用一次）。
 *
 * timer 只负责“到点入队一次”；续期跟着**调度驱动**的任务真实执行走，所以删除 loop 后
 * 调度仍然连续。被 outbox reaction 或人工提前入队的同名任务不续期——它没有“这一期结束”
 * 的语义，也不能在 timer 已被 claim 的瞬间把行重排成 pending（会破坏 complete 的 CAS）。
 */
export function createConsolidationScheduler(deps: ConsolidationSchedulerDeps): ConsolidationScheduler {
  const schedules = CONSOLIDATION_SCHEDULES
  const dispatches = new Map<ConsolidationJobName, ConsolidationWorkflowDispatch>()
  for (const dispatch of deps.workflows ?? []) {
    if (dispatches.has(dispatch.job)) throw new Error(`巩固任务 ${dispatch.job} 配置了多个 workflow dispatch`)
    dispatches.set(dispatch.job, dispatch)
  }
  return {
    schedules,
    async ensure(jobs) {
      const selected = jobs === undefined ? schedules : schedules.filter(schedule => jobs.includes(schedule.job))
      const armedKeys = await deps.timers.armed(selected.map(schedule => schedule.dedupeKey))
      const scheduled: string[] = []
      for (const schedule of selected) {
        if (armedKeys.has(schedule.dedupeKey)) continue
        await deps.timers.schedule(timerInput(schedule, deps.clock.now()))
        scheduled.push(schedule.job)
      }
      return { scheduled, armed: selected.length - scheduled.length }
    },
    async rearm(job) {
      const schedule = scheduleOf(job)
      await deps.timers.schedule(timerInput(schedule, nextDue(deps.clock.now(), schedule.intervalMs)))
    },
    timerHandler: {
      topic: CONSOLIDATION_TIMER_TOPIC,
      async run(task: TimerTask, ctx: TimerContext): Promise<void> {
        const job = jobOfPayload(task.payload)
        const schedule = scheduleOf(job)
        const dispatch = dispatches.get(job)
        if (dispatch !== undefined) {
          // 只启动、不续期：此刻 timer 行还是 claimed，重排期会让派发器的 complete CAS 失败。
          // 本期执行完由 workflow step 调 rearm 续下一期（见 app/workflow/business.ts 与
          // jobs/workflows.ts）。幂等键按「期」：同一条 timer 的重试命中的是同一个 run。
          const period = periodOfPayload(task.payload, schedule.intervalMs, ctx.now)
          await dispatch.start(dispatch.workflow, `${schedule.dedupeKey}:${period}`)
          deps.logger?.debug('巩固任务已交给 workflow 执行', {
            job,
            workflow: dispatch.workflow,
            period,
          })
          return
        }
        const bucket = periodOf(ctx.now, schedule.intervalMs)
        await deps.queue.enqueue(job, { trigger: CONSOLIDATION_TRIGGER, job }, {
          singletonKey: `${job}:${bucket}`,
          retryLimit: 3,
        })
      },
    },
  }
}

export interface ConsolidationJobOptions {
  /** 有 scheduler 时，调度驱动的任务执行完把下一期排进 timer；缺省只注册 handler。 */
  readonly scheduler?: ConsolidationScheduler
}

/**
 * 注册巩固任务的 pg-boss handler，返回真实注册成功的任务名。
 *
 * 这是**事件驱动**入口：outbox reaction 带 entityId/artifactId 入队时只处理目标；周期兜底
 * 由 timer 到期驱动 workflow run，step 调用同一个 runner（见 `runners.ts`），不另写逻辑。
 *
 * 传了 `scheduler` 时，只有**调度驱动**的队列任务（载荷带触发标记）执行完才在 finally 里
 * rearm 下一期；rearm 失败只记日志，不影响本次任务结果。
 */
export async function registerConsolidationJobs(
  queue: JobQueue,
  deps: ConsolidationDeps,
  options: ConsolidationJobOptions = {},
): Promise<readonly string[]> {
  const runners = createConsolidationJobRunners(deps)
  const registered: string[] = []
  const work = async (job: ConsolidationJobName): Promise<void> => {
    await queue.work(job, async payload => {
      try {
        // pg-boss 入口没有「逻辑步骤」语义（每个 job 独立 at-least-once），因此不传 commandId；
        // handler 自身用 revision CAS / 唯一约束保证重试幂等。workflow 入口才传 `<runId>:<step>`。
        const context: ConsolidationJobContext = {
          now: deps.clock.now(),
          signal: new AbortController().signal,
        }
        await runners[job](payload, context)
      } finally {
        if (isTriggered(payload) && options.scheduler !== undefined) {
          try {
            await options.scheduler.rearm(job)
          } catch (error) {
            deps.logger?.warn(`巩固任务续期失败：${job}`, error)
          }
        }
      }
    })
    registered.push(job)
  }
  for (const job of CONSOLIDATION_JOBS) {
    // 没有动态属性/嵌入器时不注册对应消费者：避免排期和队列里出现永远空跑的任务。
    if (job === 'omb.refresh' && deps.dynamic === undefined) continue
    if (job === 'omb.embed-sweep' && deps.embedder === undefined) continue
    await work(job)
  }
  return registered
}
