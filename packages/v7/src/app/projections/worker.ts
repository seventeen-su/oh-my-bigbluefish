import type { Clock } from '../../ports/clock.js'
import {
  DEFAULT_RETRY_POLICY,
  errorMessage,
  normalizeRetryPolicy,
  planAttempt,
  type RetryPolicy,
} from '../outbox/index.js'
import type { ProjectionTaskStore } from './tasks.js'
import type {
  ClaimedProjectionTask,
  ProjectionLag,
  ProjectionLogger,
  ProjectionName,
  ProjectionStats,
  ProjectionTask,
  ProjectionWakeSource,
} from './types.js'

/**
 * 一个投影的处理器：读源（entity/attribute）→ 幂等写读模型。
 *
 * `project` 必须**幂等**：同一 revision 重复投影结果相同；源已不满足条件时要删除读模型行，
 * 归档/取消归档不能留残留。返回值里的 `sourceUpdatedAt` 是该实体的源行时间，worker
 * 只在 `complete` 成功之后才拿它推进水位。
 */
export interface ProjectionProjector {
  readonly projection: ProjectionName
  project(task: ProjectionTask): Promise<ProjectionOutcome>
}

export interface ProjectionOutcome {
  readonly sourceUpdatedAt?: string
}

export interface ProjectionTickSummary {
  readonly claimed: number
  readonly projected: number
  readonly retried: number
  readonly dead: number
  readonly released: number
  readonly lost: number
  readonly watermarkErrors: number
}

export interface ProjectionWorkerOptions {
  /** 每个 projection 一次 claim 的批大小，默认 25。 */
  readonly batchSize?: number
  /** claim 租约；投影超过它就可能被另一个 worker 重领，默认 30s。 */
  readonly leaseMs?: number
  readonly retry?: RetryPolicy
}

export interface ProjectionWorkerDeps {
  readonly store: ProjectionTaskStore
  readonly projectors: readonly ProjectionProjector[]
  readonly clock: Clock
  /** NOTIFY/LISTEN 适配器；只负责叫醒，丢了也没关系（任务仍会被下一次显式 tick/启动恢复领取）。 */
  readonly wake?: ProjectionWakeSource
  readonly logger?: ProjectionLogger
}

export function emptyTickSummary(): ProjectionTickSummary {
  return { claimed: 0, projected: 0, retried: 0, dead: 0, released: 0, lost: 0, watermarkErrors: 0 }
}

/**
 * ProjectionWorker：按 projection 批量领取并执行投影。
 *
 * 主路径没有任何 setInterval/固定轮询：
 * - `start()` 后先 drain 一次，然后**等待** wake（NOTIFY 的 LISTEN 回调或显式 `wake()`）；
 * - `tick()` 是一次可观测的 claim+投影，测试/运维/定时器显式驱动；
 * - `recover()` 是启动恢复：只数“现在可领取”的任务并叫醒，不扫描源表。
 *
 * 失败隔离：一个投影抛错只让它自己的任务退避/死信，不会中断同批其它投影；
 * 同一投影内按 claim 顺序串行执行，跨 worker 并发由数据库的 `SKIP LOCKED` + 租约保证不重复。
 */
export class ProjectionWorker {
  private readonly projectors = new Map<ProjectionName, ProjectionProjector>()
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly retry: RetryPolicy

  private started = false
  private stopping = false
  private unsubscribe: (() => void) | undefined
  private loop: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private readonly waiters = new Set<() => void>()
  private readonly idleWaiters = new Set<() => void>()
  private wakePending = false
  private lastError: string | undefined
  private readonly totals = {
    claimed: 0,
    projected: 0,
    retried: 0,
    dead: 0,
    released: 0,
    lost: 0,
    watermarkErrors: 0,
  }

  constructor(
    private readonly deps: ProjectionWorkerDeps,
    options: ProjectionWorkerOptions = {},
  ) {
    for (const projector of deps.projectors) {
      if (this.projectors.has(projector.projection)) {
        throw new Error(`projection ${projector.projection} 注册了多个 projector`)
      }
      this.projectors.set(projector.projection, projector)
    }
    if (this.projectors.size === 0) throw new Error('ProjectionWorker 至少需要一个 projector')
    this.batchSize = clamp(options.batchSize ?? 25, 1, 500)
    this.leaseMs = clamp(options.leaseMs ?? 30_000, 1, 3_600_000)
    this.retry = normalizeRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY)
  }

  /** 已注册的投影名（确定性顺序：注册顺序）。 */
  projections(): ProjectionName[] {
    return [...this.projectors.keys()]
  }

  /** 幂等；重复 start 不会起第二个循环。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopping = false
    this.wakePending = false
    if (this.deps.wake !== undefined) {
      try {
        this.unsubscribe = this.deps.wake.subscribe(() => this.wake())
      } catch (error) {
        this.deps.logger?.warn('projection wake source subscribe 失败', errorMessage(error))
      }
    }
    this.loop = this.runLoop()
  }

  /**
   * 停止并等待在途批次；批内未投影的行归还为 pending。
   * 不设自身超时：supervisor 的总 teardown 超时负责强杀，强杀后租约保证可恢复。
   */
  async stop(): Promise<void> {
    this.stopping = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.resolveWaiters()
    const loop = this.loop
    this.loop = undefined
    if (loop !== undefined) await loop
    await this.tail
    this.started = false
  }

  /** 叫醒事件循环；可重复、可早于 start 调用。 */
  wake(): void {
    if (this.waiters.size > 0) this.resolveWaiters()
    else this.wakePending = true
  }

  /** 当前是否已完全空闲（循环在等待下一次 wake）。测试与 teardown 用来对齐时序。 */
  whenIdle(): Promise<void> {
    if (!this.started || this.stopping) return Promise.resolve()
    if (this.waiters.size > 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.idleWaiters.add(resolve)
    })
  }

  /**
   * 启动恢复：数“现在可领取”的任务（pending 到期 + 租约已过期的 claimed）并叫醒循环。
   * 进程崩溃留下的 claimed 行在租约到期后自然可领；这里是让 supervisor 在 DB 就绪后
   * 立即驱动一次，而不是等下一次 NOTIFY。返回可领取行数。
   */
  async recover(): Promise<number> {
    const due = (await this.deps.store.lag()).reduce((sum, item) => sum + item.due, 0)
    if (due > 0) this.wake()
    return due
  }

  /** 一次 claim + 投影；并发调用会被串行化。stop 开始后返回空摘要。 */
  async tick(): Promise<ProjectionTickSummary> {
    const run = this.tail.then(
      () => this.runBatch(),
      () => this.runBatch(),
    )
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    const summary = await run
    accumulate(this.totals, summary)
    return summary
  }

  /** 连续 tick 直到没有可 claim 的行（有上限，避免异常数据造成死循环）。 */
  async drain(maxBatches = 100): Promise<ProjectionTickSummary> {
    const total = { ...emptyTickSummary() }
    for (let index = 0; index < maxBatches; index += 1) {
      const summary = await this.tick()
      accumulate(total, summary)
      if (summary.claimed === 0) break
    }
    return total
  }

  async stats(): Promise<ProjectionStats> {
    const byProjection = await this.deps.store.lag()
    return {
      ...this.totals,
      byProjection,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  /** 单个投影的 lag；不存在时返回零值行，便于 omb_status 固定形状。 */
  async lag(projection: ProjectionName): Promise<ProjectionLag> {
    const all = await this.deps.store.lag()
    return all.find(item => item.projection === projection) ?? emptyLag(projection)
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const summary = await this.tick()
        if (this.stopping) break
        // 本批领满就继续 drain；否则等 NOTIFY/显式 wake。
        if (summary.claimed > 0) continue
        await this.waitForWake()
      } catch (error) {
        this.lastError = errorMessage(error)
        this.deps.logger?.error('projection worker 批处理失败', this.lastError)
        if (this.stopping) break
        await this.waitForWake()
      }
    }
  }

  private waitForWake(): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false
      return Promise.resolve()
    }
    const resumed = new Promise<void>(resolve => {
      this.waiters.add(resolve)
    })
    for (const resolve of [...this.idleWaiters]) resolve()
    this.idleWaiters.clear()
    return resumed
  }

  private resolveWaiters(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resolve of waiters) resolve()
    const idle = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of idle) resolve()
  }

  private async runBatch(): Promise<ProjectionTickSummary> {
    const summary = { ...emptyTickSummary() }
    if (this.stopping) return summary
    for (const projector of this.projectors.values()) {
      if (this.stopping) break
      const tasks = await this.deps.store.claim({
        projection: projector.projection,
        limit: this.batchSize,
        leaseMs: this.leaseMs,
      })
      summary.claimed += tasks.length
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index]
        if (task === undefined) continue
        if (this.stopping) {
          for (const pending of tasks.slice(index)) await this.releaseTask(pending, summary)
          break
        }
        await this.process(projector, task, summary)
      }
    }
    return summary
  }

  private async process(
    projector: ProjectionProjector,
    task: ClaimedProjectionTask,
    summary: { projected: number; retried: number; dead: number; lost: number; watermarkErrors: number },
  ): Promise<void> {
    let outcome: ProjectionOutcome
    try {
      outcome = await projector.project(task)
    } catch (error) {
      await this.failTask(task, errorMessage(error), summary)
      return
    }

    // 先 complete 再推进水位：完成是“这一版读模型已写好”的事实，水位只是它的时间摘要。
    const completed = await this.deps.store.complete(task)
    if (!completed) {
      summary.lost += 1
      this.deps.logger?.warn('projection complete CAS 失败，行已被其它 worker 接管', {
        entityId: task.entityId,
        projection: task.projection,
      })
      return
    }
    summary.projected += 1
    if (outcome.sourceUpdatedAt === undefined) return
    try {
      await this.deps.store.advanceWatermark(task.projection, outcome.sourceUpdatedAt)
    } catch (error) {
      summary.watermarkErrors += 1
      this.lastError = errorMessage(error)
      this.deps.logger?.error('projection 水位推进失败', {
        projection: task.projection,
        watermark: outcome.sourceUpdatedAt,
      })
    }
  }

  private async failTask(
    task: ClaimedProjectionTask,
    reason: string,
    summary: { retried: number; dead: number; lost: number },
  ): Promise<void> {
    this.lastError = reason
    const plan = planAttempt(this.retry, task.attempts)
    if (plan.kind === 'dead') {
      const applied = await this.deps.store.fail({ task, error: reason, dead: true })
      if (applied) summary.dead += 1
      else summary.lost += 1
      return
    }
    const retryAt = new Date(this.deps.clock.now().getTime() + plan.delayMs)
    const applied = await this.deps.store.fail({ task, error: reason, retryAt })
    if (applied) {
      summary.retried += 1
      return
    }
    summary.lost += 1
    this.deps.logger?.warn('projection fail CAS 失败，行已被其它 worker 接管', {
      entityId: task.entityId,
      projection: task.projection,
    })
  }

  private async releaseTask(
    task: ClaimedProjectionTask,
    summary: { released: number; lost: number },
  ): Promise<void> {
    const released = await this.deps.store.release(task)
    if (released) summary.released += 1
    else summary.lost += 1
  }
}

function emptyLag(projection: ProjectionName): ProjectionLag {
  return { projection, pending: 0, claimed: 0, dead: 0, due: 0, oldestDueAgeMs: 0 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function accumulate(target: MutableTotals, summary: ProjectionTickSummary): void {
  target.claimed += summary.claimed
  target.projected += summary.projected
  target.retried += summary.retried
  target.dead += summary.dead
  target.released += summary.released
  target.lost += summary.lost
  target.watermarkErrors += summary.watermarkErrors
}

type MutableTotals = {
  claimed: number
  projected: number
  retried: number
  dead: number
  released: number
  lost: number
  watermarkErrors: number
}
