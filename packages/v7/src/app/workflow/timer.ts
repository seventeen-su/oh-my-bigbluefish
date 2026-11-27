import type { Clock } from '../../ports/clock.js'
import {
  DEFAULT_RETRY_POLICY,
  errorMessage,
  normalizeRetryPolicy,
  planAttempt,
  type RetryPolicy,
} from '../outbox/index.js'
import type {
  TimerContext,
  TimerHandler,
  TimerLogger,
  TimerStore,
  TimerTask,
  TimerWakeSource,
} from './timer-types.js'

export interface TimerWorkerOptions {
  /** 一次 claim 的条数，默认 25。 */
  readonly batchSize?: number
  /** 租约；handler 超过它就可能被另一个 worker 重领，所以 handler 必须幂等。 */
  readonly leaseMs?: number
  readonly retry?: RetryPolicy
}

export interface TimerWorkerDeps {
  readonly store: TimerStore
  readonly handlers: readonly TimerHandler[]
  readonly clock: Clock
  readonly wake?: TimerWakeSource
  readonly logger?: TimerLogger
}

export interface TimerTickSummary {
  readonly claimed: number
  readonly fired: number
  readonly retried: number
  readonly dead: number
  /** stop 时尚未派发、归还 pending 的条数。 */
  readonly released: number
  /** CAS 失败：租约已被其它 worker 接管。 */
  readonly lost: number
}

export interface TimerWorkerStats {
  readonly pending: number
  readonly claimed: number
  readonly done: number
  readonly deadTimers: number
  readonly cancelled: number
  readonly oldestDueAgeMs: number
  readonly fired: number
  readonly retried: number
  readonly deadLettered: number
  readonly released: number
  readonly lost: number
  readonly lastError?: string
}

const MAX_SLEEP_MS = 2_000_000_000
const DB_RETRY_DELAY_MS = 1_000

export function emptyTimerTickSummary(): TimerTickSummary {
  return { claimed: 0, fired: 0, retried: 0, dead: 0, released: 0, lost: 0 }
}

/**
 * TimerWorker：只领取**到期**行并派发给注册的 handler。
 *
 * 与 OutboxRelay/ProjectionWorker 同一模式：没有固定轮询。
 * - `start()` 后先 drain 一次，然后等待 NOTIFY/显式 `wake()`；
 * - 有未来到期 timer 时只 arm 一个到 `nextDueAt` 的单次定时器，到点再看；
 * - `tick()`/`drain()` 供测试与运维显式驱动；
 * - `recover()` 在 DB 就绪后驱动一次，避免等 NOTIFY。
 */
export class TimerWorker {
  private readonly handlers = new Map<string, TimerHandler>()
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
  private readonly totals: TimerTotals = { claimed: 0, fired: 0, retried: 0, dead: 0, released: 0, lost: 0 }

  constructor(
    private readonly deps: TimerWorkerDeps,
    options: TimerWorkerOptions = {},
  ) {
    for (const handler of deps.handlers) {
      if (handler.topic.trim().length === 0) throw new Error('timer handler 的 topic 不能为空')
      if (this.handlers.has(handler.topic)) throw new Error(`timer topic ${handler.topic} 注册了多个 handler`)
      this.handlers.set(handler.topic, handler)
    }
    if (this.handlers.size === 0) throw new Error('TimerWorker 至少需要一个 handler')
    this.batchSize = clamp(options.batchSize ?? 25, 1, 500)
    this.leaseMs = clamp(options.leaseMs ?? 30_000, 1, 3_600_000)
    this.retry = normalizeRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY)
  }

  /** 已注册的 topic（注册顺序）。 */
  topics(): string[] {
    return [...this.handlers.keys()]
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
        this.deps.logger?.warn('timer wake source subscribe 失败', errorMessage(error))
      }
    }
    this.loop = this.runLoop()
  }

  /** 停止并等待在途批次；批内未派发的行归还 pending。不设自身超时（supervisor 兜底）。 */
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

  /** 当前是否已完全空闲（循环在等待下一次 wake/到期）。 */
  whenIdle(): Promise<void> {
    if (!this.started || this.stopping) return Promise.resolve()
    if (this.waiters.size > 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.idleWaiters.add(resolve)
    })
  }

  /**
   * 启动恢复 / DB 就绪后的驱动：现在就有到期 timer 才叫醒循环（不做全表扫描）。
   * 返回是否已有到期 timer。
   */
  async recover(): Promise<boolean> {
    const due = await this.deps.store.nextDueAt()
    if (due === undefined) return false
    const at = Date.parse(due)
    if (Number.isNaN(at)) return false
    if (at > this.deps.clock.now().getTime()) return false
    this.wake()
    return true
  }

  /** 一次 claim + 派发；并发调用会被串行化。stop 开始后返回空摘要。 */
  async tick(): Promise<TimerTickSummary> {
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

  /** 连续 tick 直到没有可 claim 的行（有上限）。 */
  async drain(maxBatches = 100): Promise<TimerTickSummary> {
    const total = { ...emptyTimerTickSummary() }
    for (let index = 0; index < maxBatches; index += 1) {
      const summary = await this.tick()
      accumulate(total, summary)
      if (summary.claimed === 0) break
    }
    return total
  }

  async stats(): Promise<TimerWorkerStats> {
    const base = await this.deps.store.stats()
    return {
      pending: base.pending,
      claimed: base.claimed,
      done: base.done,
      deadTimers: base.dead,
      cancelled: base.cancelled,
      oldestDueAgeMs: base.oldestDueAgeMs,
      fired: this.totals.fired,
      retried: this.totals.retried,
      deadLettered: this.totals.dead,
      released: this.totals.released,
      lost: this.totals.lost,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const summary = await this.tick()
        if (this.stopping) break
        if (summary.claimed > 0) continue
        await this.waitForNext()
      } catch (error) {
        this.lastError = errorMessage(error)
        this.deps.logger?.error('timer worker 批处理失败', this.lastError)
        if (this.stopping) break
        try {
          await this.waitForNext()
        } catch (waitError) {
          this.lastError = errorMessage(waitError)
          await sleep(DB_RETRY_DELAY_MS)
        }
      }
    }
  }

  private async waitForNext(): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false
      return
    }
    const delay = await this.nextWakeDelayMs()
    const resumed = new Promise<void>(resolve => {
      this.waiters.add(resolve)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (delay !== undefined) {
      timer = setTimeout(() => this.resolveWaiters(), Math.min(delay, MAX_SLEEP_MS))
      timer.unref?.()
    }
    for (const resolve of [...this.idleWaiters]) resolve()
    this.idleWaiters.clear()
    await resumed
    if (timer !== undefined) clearTimeout(timer)
  }

  private async nextWakeDelayMs(): Promise<number | undefined> {
    const due = await this.deps.store.nextDueAt()
    if (due === undefined) return undefined
    const at = Date.parse(due)
    if (Number.isNaN(at)) return undefined
    return Math.max(0, at - this.deps.clock.now().getTime())
  }

  private resolveWaiters(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resolve of waiters) resolve()
    const idle = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of idle) resolve()
  }

  private async runBatch(): Promise<TimerTickSummary> {
    const summary: MutableTickSummary = { ...emptyTimerTickSummary() }
    if (this.stopping) return summary
    const tasks = await this.deps.store.claimDue({ limit: this.batchSize, leaseMs: this.leaseMs })
    summary.claimed = tasks.length
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]
      if (task === undefined) continue
      if (this.stopping) {
        for (const pending of tasks.slice(index)) await this.release(pending, summary)
        break
      }
      await this.dispatch(task, summary)
    }
    return summary
  }

  private async release(task: TimerTask, summary: MutableTickSummary): Promise<void> {
    const released = await this.deps.store.release(task.id, task.attempts)
    if (released) summary.released += 1
    else summary.lost += 1
  }

  private async dispatch(task: TimerTask, summary: MutableTickSummary): Promise<void> {
    const handler = this.handlers.get(task.topic)
    if (handler === undefined) {
      await this.deadLetter(task, summary, `topic "${task.topic}" 没有注册 timer handler`)
      return
    }
    const context: TimerContext = {
      timerId: task.id,
      topic: task.topic,
      attempt: task.attempts + 1,
      commandId: task.dedupeKey === undefined ? `timer:${task.id}` : `timer:${task.dedupeKey}`,
      now: this.deps.clock.now(),
      signal: new AbortController().signal,
    }
    try {
      await handler.run(task, context)
    } catch (error) {
      await this.failTask(task, errorMessage(error), summary)
      return
    }
    const applied = await this.deps.store.complete(task.id, task.attempts)
    if (!applied) {
      summary.lost += 1
      this.deps.logger?.warn('timer complete CAS 失败，行已被其它 worker 接管', { id: task.id })
      return
    }
    summary.fired += 1
  }

  private async failTask(task: TimerTask, reason: string, summary: MutableTickSummary): Promise<void> {
    this.lastError = reason
    const plan = planAttempt(this.retry, task.attempts)
    if (plan.kind === 'dead') {
      await this.deadLetter(task, summary, reason)
      return
    }
    const applied = await this.deps.store.fail({
      id: task.id,
      expectedAttempts: task.attempts,
      error: reason,
      retryAt: new Date(this.deps.clock.now().getTime() + plan.delayMs),
    })
    if (applied) summary.retried += 1
    else summary.lost += 1
  }

  private async deadLetter(task: TimerTask, summary: MutableTickSummary, reason: string): Promise<void> {
    this.lastError = reason
    const applied = await this.deps.store.fail({
      id: task.id,
      expectedAttempts: task.attempts,
      error: reason,
      dead: true,
    })
    if (applied) summary.dead += 1
    else summary.lost += 1
  }
}

/** 内部累加用的可写视图；对调用方仍然只暴露只读的 TimerTickSummary。 */
type MutableTickSummary = { -readonly [K in keyof TimerTickSummary]: TimerTickSummary[K] }

interface TimerTotals {
  claimed: number
  fired: number
  retried: number
  dead: number
  released: number
  lost: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function accumulate(target: TimerTotals, summary: TimerTickSummary): void {
  target.claimed += summary.claimed
  target.fired += summary.fired
  target.retried += summary.retried
  target.dead += summary.dead
  target.released += summary.released
  target.lost += summary.lost
}
