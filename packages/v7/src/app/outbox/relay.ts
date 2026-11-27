import type { Clock } from '../../ports/clock.js'
import type { ReactionRegistry } from './registry.js'
import { errorMessage } from './registry.js'
import { DEFAULT_RETRY_POLICY, normalizeRetryPolicy, planAttempt, type RetryPolicy } from './retry.js'
import type {
  OutboxEvent,
  OutboxLogger,
  OutboxStats,
  OutboxStore,
  OutboxWakeSource,
} from './events.js'
import type { ReactionContext, ReactionDispatch, UnknownTopicPolicy } from './reactions.js'

export interface OutboxTickSummary {
  readonly claimed: number
  readonly delivered: number
  /** unknown topic + `skip` 策略丢弃。 */
  readonly skipped: number
  /** 已退避，等待下一次 claim。 */
  readonly retried: number
  /** 本次进入死信（重试耗尽、未知 topic 或策略要求）。 */
  readonly dead: number
  /** stop 时尚未派发、归还为 pending 的行数。 */
  readonly released: number
  /** CAS 失败：租约已被其它 worker 接管，本 worker 不再写结果。 */
  readonly lost: number
}

export interface OutboxRelayStats extends OutboxStats {
  readonly delivered: number
  readonly skipped: number
  readonly retried: number
  readonly dead: number
  readonly released: number
  readonly lost: number
  /** 最近一次派发或批处理错误；成功不会清除它，便于 omb_status 暴露问题。 */
  readonly lastError?: string
}

export function emptyTickSummary(): OutboxTickSummary {
  return { claimed: 0, delivered: 0, skipped: 0, retried: 0, dead: 0, released: 0, lost: 0 }
}

export interface OutboxRelayOptions {
  /** 一次 claim 的批大小，默认 25。 */
  readonly batchSize?: number
  /** claim 租约；reaction 超过它就可能被另一个 worker 重领，默认 30s。 */
  readonly leaseMs?: number
  readonly retry?: RetryPolicy
  /** 未注册 topic 的策略，默认 'dead'：死信可见、可按 topic 补注册后重放。 */
  readonly unknownTopic?: UnknownTopicPolicy
  /** reconciliation 只数“创建早于 grace 的 pending”，默认 30s。 */
  readonly reconcileGraceMs?: number
}

export interface OutboxRelayDeps {
  readonly store: OutboxStore
  readonly registry: ReactionRegistry
  readonly clock: Clock
  /** NOTIFY/LISTEN 适配器；只负责叫醒，丢了也没关系（reconciliation 兜底）。 */
  readonly wake?: OutboxWakeSource
  readonly logger?: OutboxLogger
}

/**
 * OutboxRelay：事件驱动的 outbox 派发器。
 *
 * 主路径没有任何 setInterval/固定轮询：
 * - `start()` 后循环先 drain 一次，然后**等待** wake（NOTIFY 的 LISTEN 回调或显式 `wake()`）；
 * - `tick()` 是一次可观测的 claim+派发，可供测试/运维显式驱动；
 * - `reconcile()` 是安全网，只处理“旧 pending”，节奏由 supervisor/timer 决定，不在 relay 内轮询。
 *
 * stop 语义：停止后不再领取新行；批内未派发的已 claim 行立刻 `release` 回 pending，
 * 已在执行中的 reaction 会被等待，其 complete/fail 仍会写入。若进程被强杀，
 * 已 claim 未完成的行保留租约，到期后由其它 worker 重新领取——不丢事件。
 */
export class OutboxRelay {
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly retry: RetryPolicy
  private readonly unknownTopic: UnknownTopicPolicy
  private readonly reconcileGraceMs: number

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
    delivered: 0,
    skipped: 0,
    retried: 0,
    dead: 0,
    released: 0,
    lost: 0,
  }

  constructor(
    private readonly deps: OutboxRelayDeps,
    options: OutboxRelayOptions = {},
  ) {
    this.batchSize = clamp(options.batchSize ?? 25, 1, 500)
    this.leaseMs = clamp(options.leaseMs ?? 30_000, 1, 3_600_000)
    this.retry = normalizeRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY)
    this.unknownTopic = options.unknownTopic ?? 'dead'
    this.reconcileGraceMs = clamp(options.reconcileGraceMs ?? 30_000, 0, 86_400_000)
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
        this.deps.logger?.warn('outbox wake source subscribe 失败', errorMessage(error))
      }
    }
    this.loop = this.runLoop()
  }

  /**
   * 停止并等待在途批次；批内未派发的行归还为 pending。
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
   * 安全网：只统计“已到期且创建早于 grace 的 pending 行”，有就 wake。
   * relay 自己不调度它——调用方（supervisor/timer）决定频率。
   * 返回被兜底的旧 pending 数量。
   */
  async reconcile(): Promise<number> {
    const stale = await this.deps.store.stalePendingCount(this.reconcileGraceMs)
    if (stale > 0) this.wake()
    return stale
  }

  /** 一次 claim + 派发；并发调用会被串行化。stop 开始后返回空摘要。 */
  async tick(): Promise<OutboxTickSummary> {
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
  async drain(maxBatches = 100): Promise<OutboxTickSummary> {
    const total = { ...emptyTickSummary() }
    for (let index = 0; index < maxBatches; index += 1) {
      const summary = await this.tick()
      accumulate(total, summary)
      if (summary.claimed === 0) break
    }
    return total
  }

  async stats(): Promise<OutboxRelayStats> {
    const base = await this.deps.store.stats()
    return {
      pending: base.pending,
      claimed: base.claimed,
      oldestAgeMs: base.oldestAgeMs,
      delivered: this.totals.delivered,
      skipped: this.totals.skipped,
      retried: this.totals.retried,
      dead: this.totals.dead,
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
        // 本批领满就继续 drain；否则等 NOTIFY/显式 wake。
        if (summary.claimed > 0) continue
        await this.waitForWake()
      } catch (error) {
        this.lastError = errorMessage(error)
        this.deps.logger?.error('outbox relay 批处理失败', this.lastError)
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

  private async runBatch(): Promise<OutboxTickSummary> {
    const summary = { ...emptyTickSummary() }
    if (this.stopping) return summary
    const events = await this.deps.store.claim({ limit: this.batchSize, leaseMs: this.leaseMs })
    summary.claimed = events.length
    for (const event of events) {
      if (this.stopping) {
        const released = await this.deps.store.release(event.id, event.attempts)
        if (released) summary.released += 1
        else summary.lost += 1
        continue
      }
      await this.dispatch(event, summary)
    }
    return summary
  }

  private async dispatch(event: OutboxEvent, summary: {
    delivered: number
    skipped: number
    retried: number
    dead: number
    lost: number
  }): Promise<void> {
    const context: ReactionContext = {
      id: event.id,
      eventId: event.eventId,
      topic: event.topic,
      attempt: event.attempts + 1,
      now: this.deps.clock.now(),
    }
    let result: ReactionDispatch
    try {
      result = await this.deps.registry.dispatch(event, context)
    } catch (error) {
      result = {
        kind: 'failed',
        ran: [],
        failures: [{ name: '(registry)', error: errorMessage(error) }],
      }
    }

    if (result.kind === 'ok') {
      await this.finish(event, summary, 'delivered')
      return
    }
    if (result.kind === 'no-handlers') {
      if (this.unknownTopic === 'skip') {
        await this.finish(event, summary, 'skipped')
        return
      }
      await this.deadLetter(event, summary, `topic "${event.topic}" 没有注册 reaction`)
      return
    }

    const reason = result.failures.map(failure => `${failure.name}: ${failure.error}`).join('; ')
    this.lastError = reason
    const plan = planAttempt(this.retry, event.attempts)
    if (plan.kind === 'dead') {
      await this.deadLetter(event, summary, reason)
      return
    }
    const retryAt = new Date(this.deps.clock.now().getTime() + plan.delayMs)
    const applied = await this.deps.store.fail({
      id: event.id,
      expectedAttempts: event.attempts,
      error: reason,
      retryAt,
    })
    if (applied) {
      summary.retried += 1
      return
    }
    summary.lost += 1
    this.deps.logger?.warn('outbox fail CAS 失败，行已被其它 worker 接管', { id: event.id })
  }

  private async finish(
    event: OutboxEvent,
    summary: { delivered: number; skipped: number; lost: number },
    kind: 'delivered' | 'skipped',
  ): Promise<void> {
    const applied = await this.deps.store.complete(event.id, event.attempts)
    if (!applied) {
      summary.lost += 1
      this.deps.logger?.warn('outbox complete CAS 失败，行已被其它 worker 接管', { id: event.id })
      return
    }
    if (kind === 'delivered') summary.delivered += 1
    else summary.skipped += 1
  }

  private async deadLetter(
    event: OutboxEvent,
    summary: { dead: number; lost: number },
    reason: string,
  ): Promise<void> {
    this.lastError = reason
    const applied = await this.deps.store.fail({
      id: event.id,
      expectedAttempts: event.attempts,
      error: reason,
      dead: true,
    })
    if (applied) {
      summary.dead += 1
      return
    }
    summary.lost += 1
    this.deps.logger?.warn('outbox 死信 CAS 失败，行已被其它 worker 接管', { id: event.id })
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function accumulate(
  target: {
    claimed: number
    delivered: number
    skipped: number
    retried: number
    dead: number
    released: number
    lost: number
  },
  summary: OutboxTickSummary,
): void {
  target.claimed += summary.claimed
  target.delivered += summary.delivered
  target.skipped += summary.skipped
  target.retried += summary.retried
  target.dead += summary.dead
  target.released += summary.released
  target.lost += summary.lost
}
