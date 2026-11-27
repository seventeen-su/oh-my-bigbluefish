import { isJsonValue } from '../../domain/json.js'
import type { JsonValue } from '../../domain/json.js'
import type { Clock } from '../../ports/clock.js'
import {
  DEFAULT_RETRY_POLICY,
  errorMessage,
  normalizeRetryPolicy,
  planAttempt,
  type RetryPolicy,
} from '../outbox/index.js'
import type { WorkflowContext, WorkflowDefinition, WorkflowStep, WorkflowStepOutcome } from './definition.js'
import type { ClaimedWorkflowRun, WorkflowStats } from './run.js'
import type {
  WorkflowFailInput,
  WorkflowLogger,
  WorkflowStartResult,
  WorkflowStore,
  WorkflowWakeSource,
} from './store.js'

const MAX_SLEEP_MS = 2_000_000_000
const DB_RETRY_DELAY_MS = 1_000
/** 单个 run 在一次 tick 内的最大 step 跳数：防止 `next` 指回前面的步骤造成死循环。 */
const MAX_STEPS_PER_RUN = 1_000

export interface WorkflowRuntimeOptions {
  /** 一次 claim 的 run 数，默认 10。 */
  readonly batchSize?: number
  /** claim 租约；步骤超过它就可能被另一个 worker 重领，默认 30s。 */
  readonly leaseMs?: number
  readonly retry?: RetryPolicy
}

export interface WorkflowRuntimeDeps {
  readonly store: WorkflowStore
  readonly clock: Clock
  /** NOTIFY/LISTEN 之类；只负责叫醒，丢失也不影响正确性（nextDueAt 兜底）。 */
  readonly wake?: WorkflowWakeSource
  readonly logger?: WorkflowLogger
}

export interface WorkflowTickSummary {
  readonly claimed: number
  /** 本次 tick 成功 checkpoint 的步骤数。 */
  readonly steps: number
  /** 本次 tick 走到 completed 的 run 数。 */
  readonly completed: number
  /** 进入退避、等下一次 claim 的失败数。 */
  readonly retried: number
  /** 进入死信的 run 数（重试耗尽或无法执行）。 */
  readonly dead: number
  readonly cancelled: number
  /** 补偿成功的步骤数。 */
  readonly compensated: number
  /** 补偿抛错的步骤数；这些 step 保持 completed（未标 compensated），可人工重试。 */
  readonly compensationErrors: number
  /** stop 时尚未执行、归还 pending 的 run 数。 */
  readonly released: number
  /** CAS 失败：租约已被其它 worker 接管，本 worker 不写结果。 */
  readonly lost: number
}

export interface WorkflowRuntimeStats extends WorkflowStats {
  readonly claimed: number
  readonly steps: number
  readonly completed: number
  readonly retried: number
  readonly dead: number
  readonly cancelled: number
  readonly compensated: number
  readonly compensationErrors: number
  readonly released: number
  readonly lost: number
  /** 最近一次失败/补偿错误；成功不会清除它，便于 omb_status 暴露问题。 */
  readonly lastError?: string
}

export interface WorkflowCancelResult {
  readonly cancelled: boolean
  readonly compensated: number
  readonly compensationErrors: number
  /** 取消失败时 run 当前的状态（例如已经 completed）；不存在时为 undefined。 */
  readonly status?: string
}

export interface WorkflowStartOptions {
  readonly idempotencyKey: string
  /** 未来时间：落 `status='waiting'`，到期由运行时自行唤醒。 */
  readonly runAt?: Date
}

export function emptyTickSummary(): WorkflowTickSummary {
  return {
    claimed: 0,
    steps: 0,
    completed: 0,
    retried: 0,
    dead: 0,
    cancelled: 0,
    compensated: 0,
    compensationErrors: 0,
    released: 0,
    lost: 0,
  }
}

/** 内部累加用的可写视图；对调用方仍然只暴露只读的 WorkflowTickSummary。 */
type MutableTickSummary = { -readonly [K in keyof WorkflowTickSummary]: WorkflowTickSummary[K] }

/**
 * WorkflowRuntime：持久工作流的执行器。
 *
 * 权威性（CONCURRENCY §4.5）：
 * - 唯一进度来源是 `workflow_run/step`；内存只保存“本进程正在执行的 run”用于取消，
 *   进程崩溃后这些 Promise 消失不会影响恢复——租约到期后 run 会被重新 claim，
 *   从 `run.step` 继续（已完成步骤的 checkpoint 已持久化，不会重跑）。
 * - 每个 claim 的代数 `run.attempts` 是 CAS 栅栏：checkpoint / 失败 / 取消都带它，
 *   租约过期后被别人接管的旧执行写结果会返回 false（lost），不会覆盖新持有者。
 *
 * 重试与补偿：
 * - 失败按 `RetryPolicy` 退避；失败次数只数该 step 的失败 attempt（`workflow_step` 唯一键）。
 * - 达到上限 → run 落 `dead`，然后按 checkpoint 逆序补偿（只补偿有 `compensate` 的已完成步骤）。
 * - 人工重放（`retry`）把 dead/failed 拉回 pending；attempts 不重置，坏任务不会无限自动重试。
 *
 * 唤醒（不做固定轮询）：
 * - `start`/`retry`/`recover` 显式 wake；循环在无到期 run 时**无限等待** wake；
 * - 有未来到期的 run 时只 arm 一个 `setTimeout` 到 `nextDueAt`，到点再 claim；
 * - 没有 10 分钟节拍，也不用内存 Promise 判断“任务还在不在”。
 */
export class WorkflowRuntime {
  private readonly definitions = new Map<string, WorkflowDefinition>()
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly retryPolicy: RetryPolicy

  private started = false
  private stopping = false
  private unsubscribe: (() => void) | undefined
  private loop: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private readonly waiters = new Set<() => void>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly active = new Map<string, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private wakePending = false
  private lastError: string | undefined
  private readonly totals = {
    claimed: 0,
    steps: 0,
    completed: 0,
    retried: 0,
    dead: 0,
    cancelled: 0,
    compensated: 0,
    compensationErrors: 0,
    released: 0,
    lost: 0,
  }

  constructor(
    private readonly deps: WorkflowRuntimeDeps,
    options: WorkflowRuntimeOptions = {},
  ) {
    this.batchSize = clamp(options.batchSize ?? 10, 1, 500)
    this.leaseMs = clamp(options.leaseMs ?? 30_000, 1, 3_600_000)
    this.retryPolicy = normalizeRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY)
  }

  /** 注册定义；name 重复、steps 为空或重名、initial 不是 JSON 时立即抛错。 */
  register(definition: WorkflowDefinition): void {
    if (definition.name.trim().length === 0) throw new Error('workflow 名称不能为空')
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new Error(`workflow ${definition.name} 的 version 必须是正整数`)
    }
    if (definition.steps.length === 0) throw new Error(`workflow ${definition.name} 至少需要一个 step`)
    if (!isJsonValue(definition.initial)) throw new Error(`workflow ${definition.name} 的 initial 必须是 JSON`)
    const names = new Set<string>()
    for (const step of definition.steps) {
      if (step.name.trim().length === 0) throw new Error(`workflow ${definition.name} 存在空 step 名`)
      if (names.has(step.name)) throw new Error(`workflow ${definition.name} 的 step 重复：${step.name}`)
      names.add(step.name)
    }
    if (this.definitions.has(definition.name)) throw new Error(`workflow ${definition.name} 已注册`)
    this.definitions.set(definition.name, definition)
  }

  /** 已注册的 workflow 名（注册顺序）。 */
  names(): string[] {
    return [...this.definitions.keys()]
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
        this.deps.logger?.warn('workflow wake source subscribe 失败', errorMessage(error))
      }
    }
    this.loop = this.runLoop()
  }

  /** 停止并等待在途 tick；批内未执行的 run 归还 pending。不设自身超时（由 supervisor 兜底）。 */
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
   * 启动一个 run。
   *
   * `input` 缺省用定义的 `initial`；`idempotencyKey` 唯一，重复 start 返回已有 run。
   * run id 在这里生成一次并落库，重放不会重新生成（步骤参数保持确定性）。
   */
  async startRun(name: string, input: JsonValue | undefined, options: WorkflowStartOptions): Promise<WorkflowStartResult> {
    const definition = this.definitionOf(name)
    if (options.idempotencyKey.trim().length === 0) throw new Error('start 需要非空 idempotencyKey')
    const state = input === undefined ? definition.initial : input
    if (!isJsonValue(state)) throw new Error(`workflow ${name} 的初始 state 必须是 JSON`)
    const first = definition.steps[0]
    if (first === undefined) throw new Error(`workflow ${name} 没有 step`)
    const result = await this.deps.store.start({
      id: crypto.randomUUID(),
      name: definition.name,
      version: definition.version,
      state,
      step: first.name,
      idempotencyKey: options.idempotencyKey,
      ...(options.runAt !== undefined ? { runAt: options.runAt } : {}),
    })
    if (result.inserted) this.wake()
    return result
  }

  /** 人工重放死信：dead/failed → pending；成功后 wake。 */
  async retry(runId: string): Promise<boolean> {
    const retried = await this.deps.store.retryRun(runId)
    if (retried) this.wake()
    return retried
  }

  /**
   * 取消一个 run：先中断本进程里正在执行的步骤（AbortSignal），再 CAS 到 cancelled，
   * 最后按逆序补偿已完成步骤。取消不会再安排重试；已完成的副作用由补偿承担。
   */
  async cancel(runId: string): Promise<WorkflowCancelResult> {
    const active = this.active.get(runId)
    if (active !== undefined) {
      active.abort.abort()
      await active.done
    }
    const before = await this.deps.store.get(runId)
    if (before === undefined) return { cancelled: false, compensated: 0, compensationErrors: 0 }
    const cancelled = before.status === 'cancelled' || (await this.deps.store.cancel({ runId }))
    if (!cancelled) {
      return { cancelled: false, compensated: 0, compensationErrors: 0, status: before.status }
    }
    const compensation = await this.compensateRun(runId)
    return {
      cancelled: true,
      compensated: compensation.compensated,
      compensationErrors: compensation.errors,
      status: 'cancelled',
    }
  }

  /** 启动恢复：租约过期的 running 回 pending，并唤醒循环。返回恢复报告。 */
  async recover(): Promise<{ readonly recovered: number; readonly due: number }> {
    const report = await this.deps.store.recover()
    if (report.due > 0 || report.recovered > 0) this.wake()
    return report
  }

  /** 一次 claim + 执行；并发调用会被串行化。stop 开始后返回空摘要。 */
  async tick(): Promise<WorkflowTickSummary> {
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

  /** 连续 tick 直到没有可 claim 的 run（有上限，避免异常数据造成死循环）。 */
  async drain(maxBatches = 100): Promise<WorkflowTickSummary> {
    const total = { ...emptyTickSummary() }
    for (let index = 0; index < maxBatches; index += 1) {
      const summary = await this.tick()
      accumulate(total, summary)
      if (summary.claimed === 0) break
    }
    return total
  }

  async stats(): Promise<WorkflowRuntimeStats> {
    const base = await this.deps.store.stats()
    return {
      ...base,
      claimed: this.totals.claimed,
      steps: this.totals.steps,
      completed: this.totals.completed,
      retried: this.totals.retried,
      dead: this.totals.dead,
      cancelled: this.totals.cancelled,
      compensated: this.totals.compensated,
      compensationErrors: this.totals.compensationErrors,
      released: this.totals.released,
      lost: this.totals.lost,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  private definitionOf(name: string): WorkflowDefinition {
    const definition = this.definitions.get(name)
    if (definition === undefined) throw new Error(`workflow 未注册：${name}`)
    return definition
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const summary = await this.tick()
        if (this.stopping) break
        // 本批领满就继续 drain；否则等 wake 或下一个到期时刻。
        if (summary.claimed > 0) continue
        await this.waitForNext()
      } catch (error) {
        this.lastError = errorMessage(error)
        this.deps.logger?.error('workflow runtime 批处理失败', this.lastError)
        if (this.stopping) break
        try {
          await this.waitForNext()
        } catch (waitError) {
          // DB 不可用：退避一次再试，不把宿主打成 uncaughtException，也不是队列轮询。
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
      // 单次定时器只是“到点再看一眼”，不会周期性重查；unref 让宿主退出不被它拖住。
      timer.unref?.()
    }
    for (const resolve of [...this.idleWaiters]) resolve()
    this.idleWaiters.clear()
    await resumed
    if (timer !== undefined) clearTimeout(timer)
  }

  /** 距下一个到期 run 还有多久；没有待执行 run 时返回 undefined（无限等待 wake）。 */
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

  private async runBatch(): Promise<WorkflowTickSummary> {
    const summary: MutableTickSummary = { ...emptyTickSummary() }
    if (this.stopping) return summary
    const runs = await this.deps.store.claimDue({ limit: this.batchSize, leaseMs: this.leaseMs })
    summary.claimed = runs.length
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]
      if (run === undefined) continue
      if (this.stopping) {
        for (const pending of runs.slice(index)) await this.release(pending, summary)
        break
      }
      await this.executeRun(run, summary)
    }
    return summary
  }

  private async release(run: ClaimedWorkflowRun, summary: { released: number; lost: number }): Promise<void> {
    const released = await this.deps.store.release({ runId: run.id, attempt: run.attempts })
    if (released) summary.released += 1
    else summary.lost += 1
  }

  private async executeRun(run: ClaimedWorkflowRun, summary: MutableTickSummary): Promise<void> {
    const abort = new AbortController()
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => {
      resolveDone = resolve
    })
    this.active.set(run.id, { abort, done })
    try {
      const definition = this.definitions.get(run.name)
      if (definition === undefined) {
        await this.abandon(run, `workflow 未注册：${run.name}`, summary)
        return
      }
      if (definition.version !== run.version) {
        await this.abandon(run, `workflow ${run.name} 版本不匹配：run=${run.version} 定义=${definition.version}`, summary)
        return
      }
      await this.runSteps(definition, run, abort.signal, summary)
    } catch (error) {
      // 执行器自身异常（DB 断连等）：不写结果，让租约过期后由恢复重领。
      this.lastError = errorMessage(error)
      this.deps.logger?.error('workflow 执行失败', { runId: run.id, error: this.lastError })
    } finally {
      this.active.delete(run.id)
      resolveDone()
    }
  }

  private async runSteps(
    definition: WorkflowDefinition,
    run: ClaimedWorkflowRun,
    signal: AbortSignal,
    summary: MutableTickSummary,
  ): Promise<void> {
    const byName = new Map<string, { readonly step: WorkflowStep; readonly index: number }>()
    for (let index = 0; index < definition.steps.length; index += 1) {
      const step = definition.steps[index]
      if (step !== undefined) byName.set(step.name, { step, index })
    }
    const startedAt = run.step
    if (startedAt === null) {
      await this.abandon(run, `workflow ${run.name} 的 run 没有当前 step，但仍是可执行状态`, summary)
      return
    }
    if (!byName.has(startedAt)) {
      await this.abandon(run, `workflow ${run.name} 存在未知 step：${startedAt}`, summary)
      return
    }
    // 从已持久化的 checkpoint 继续：run.step 之前的步骤不再执行。
    let stepName: string | null = startedAt
    let state = run.state
    let hops = 0

    while (stepName !== null) {
      hops += 1
      if (hops > MAX_STEPS_PER_RUN) {
        await this.abandon(run, `workflow ${run.name} 的 step 链超过 ${MAX_STEPS_PER_RUN} 跳，疑似循环`, summary)
        return
      }
      if (signal.aborted) {
        const cancelled = await this.deps.store.cancel({ runId: run.id, attempt: run.attempts })
        if (cancelled) summary.cancelled += 1
        else summary.lost += 1
        return
      }
      const entry = byName.get(stepName)
      if (entry === undefined) {
        await this.abandon(run, `workflow ${run.name} 存在未知 step：${stepName}`, summary)
        return
      }
      const stepContext: WorkflowContext = {
        runId: run.id,
        step: stepName,
        attempt: run.attempts,
        commandId: `${run.id}:${stepName}`,
        now: this.deps.clock.now(),
        signal,
      }
      const begun = await this.deps.store.beginStep({
        runId: run.id,
        step: stepName,
        attempt: run.attempts,
        input: state,
      })
      if (begun.status !== 'running') {
        // checkpoint 已存在但 run 未推进：拒绝重复执行造成双写，落死信等人工核对。
        await this.abandon(
          run,
          `step ${stepName} 已存在 ${begun.status} checkpoint，但 run 仍指向它（checkpoint 不一致）`,
          summary,
        )
        return
      }

      let outcome: WorkflowStepOutcome
      try {
        outcome = await entry.step.run(state, stepContext)
      } catch (error) {
        if (signal.aborted) {
          // 取消：把中断的 step 记为 failed（保留审计痕迹），再 CAS 成 cancelled。
          await this.cancelActiveStep(run, stepName, summary)
          return
        }
        await this.failStep(run, stepName, errorMessage(error), summary)
        return
      }
      if (!isJsonValue(outcome.state)) {
        await this.failStep(run, stepName, 'step 返回的 state 不是 JSON', summary)
        return
      }
      const nextStep = outcome.next === undefined ? nextStepOf(definition, entry.index) : outcome.next
      if (nextStep !== null && !byName.has(nextStep)) {
        await this.abandon(run, `step ${stepName} 返回未知 next：${nextStep}`, summary)
        return
      }
      const output: JsonValue = { state: outcome.state, next: nextStep }
      const checkpointed = await this.deps.store.completeStep({
        runId: run.id,
        step: stepName,
        attempt: run.attempts,
        state: outcome.state,
        nextStep,
        output,
      })
      if (!checkpointed) {
        summary.lost += 1
        this.deps.logger?.warn('workflow checkpoint CAS 失败，run 已被其它 worker 接管', { runId: run.id, step: stepName })
        return
      }
      summary.steps += 1
      state = outcome.state
      if (nextStep === null) {
        summary.completed += 1
        return
      }
      stepName = nextStep
    }
  }

  private async failStep(
    run: ClaimedWorkflowRun,
    stepName: string,
    reason: string,
    summary: MutableTickSummary,
  ): Promise<void> {
    this.lastError = reason
    const failures = await this.deps.store.steps(run.id)
    const failedBefore = failures.filter(record => record.step === stepName && record.status === 'failed').length
    const plan = planAttempt(this.retryPolicy, failedBefore)
    const input: WorkflowFailInput = {
      runId: run.id,
      step: stepName,
      attempt: run.attempts,
      error: reason,
      ...(plan.kind === 'retry' ? { retryAt: new Date(this.deps.clock.now().getTime() + plan.delayMs) } : {}),
    }
    const result = await this.deps.store.failStep(plan.kind === 'dead' ? { ...input, dead: true } : input)
    if (!result.applied) {
      summary.lost += 1
      this.deps.logger?.warn('workflow fail CAS 失败，run 已被其它 worker 接管', { runId: run.id, step: stepName })
      return
    }
    if (plan.kind === 'retry') {
      summary.retried += 1
      return
    }
    summary.dead += 1
    // 终态失败：已完成的步骤按逆序补偿（补偿只依赖 checkpoint，不依赖内存状态）。
    const compensation = await this.compensateRun(run.id)
    summary.compensated += compensation.compensated
    summary.compensationErrors += compensation.errors
  }

  private async abandon(run: ClaimedWorkflowRun, reason: string, summary: { dead: number }): Promise<void> {
    this.lastError = reason
    const applied = await this.deps.store.abandon({ runId: run.id, attempt: run.attempts, error: reason })
    if (applied) {
      summary.dead += 1
      this.deps.logger?.warn('workflow run 落死信', { runId: run.id, error: reason })
      return
    }
    this.deps.logger?.warn('workflow abandon CAS 失败，run 已被其它 worker 接管', { runId: run.id })
  }

  /**
   * 取消时收尾正在执行的 step：先把它记为 failed（保留审计痕迹与失败原因），
   * 再把 run CAS 成 cancelled。两步都用同一个 attempt 栅栏，租约被接管时不会误写。
   */
  private async cancelActiveStep(
    run: ClaimedWorkflowRun,
    stepName: string,
    summary: { cancelled: number; lost: number },
  ): Promise<void> {
    await this.deps.store.failStep({
      runId: run.id,
      step: stepName,
      attempt: run.attempts,
      error: 'cancelled by caller',
    })
    const cancelled = await this.deps.store.cancel({ runId: run.id, attempt: run.attempts })
    if (cancelled) summary.cancelled += 1
    else summary.lost += 1
  }

  /**
   * 按 checkpoint 逆序补偿：只处理有 `compensate` 的已完成步骤。
   * 幂等：compensateStep 后该行不再是 completed，重复调用不会二次执行；
   * 补偿抛错时保留 completed，错误进 metrics，便于人工重试。
   */
  private async compensateRun(runId: string): Promise<{ readonly compensated: number; readonly errors: number }> {
    const run = await this.deps.store.get(runId)
    if (run === undefined) return { compensated: 0, errors: 0 }
    const definition = this.definitions.get(run.name)
    if (definition === undefined) {
      this.lastError = `workflow 未注册，无法补偿：${run.name}`
      this.deps.logger?.warn('workflow 未注册，跳过补偿', { runId })
      return { compensated: 0, errors: 0 }
    }
    const byName = new Map(definition.steps.map(step => [step.name, step]))
    const order = new Map(definition.steps.map((step, index) => [step.name, index]))
    const records = await this.deps.store.steps(runId)
    const completed = records
      .filter(record => record.status === 'completed' && byName.get(record.step)?.compensate !== undefined)
      .sort((left, right) => {
        const leftAt = left.finishedAt === undefined ? 0 : Date.parse(left.finishedAt)
        const rightAt = right.finishedAt === undefined ? 0 : Date.parse(right.finishedAt)
        // 逆序：完成时间倒序；同一时间戳（单元测试的假时钟/批量完成）按定义顺序倒序兜底。
        return rightAt - leftAt || (order.get(right.step) ?? -1) - (order.get(left.step) ?? -1)
      })
    let compensated = 0
    let errors = 0
    for (const record of completed) {
      const step = byName.get(record.step)
      if (step?.compensate === undefined) continue
      const state = stateOfOutput(record.output) ?? record.input
      const context: WorkflowContext = {
        runId,
        step: record.step,
        attempt: record.attempt,
        commandId: `compensate:${runId}:${record.step}`,
        now: this.deps.clock.now(),
        signal: new AbortController().signal,
      }
      try {
        await step.compensate(state ?? null, context)
      } catch (error) {
        errors += 1
        this.lastError = `workflow ${run.name} 补偿 ${record.step} 失败：${errorMessage(error)}`
        this.deps.logger?.error('workflow 补偿失败', { runId, step: record.step, error: this.lastError })
        continue
      }
      const marked = await this.deps.store.compensateStep({
        runId,
        step: record.step,
        attempt: record.attempt,
      })
      if (marked) compensated += 1
    }
    return { compensated, errors }
  }
}

function nextStepOf(definition: WorkflowDefinition, index: number): string | null {
  return definition.steps[index + 1]?.name ?? null
}

function stateOfOutput(output: JsonValue | undefined): JsonValue | undefined {
  if (output === null || output === undefined) return undefined
  if (typeof output !== 'object' || Array.isArray(output)) return undefined
  return output['state']
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

function accumulate(target: MutableTotals, summary: WorkflowTickSummary): void {
  target.claimed += summary.claimed
  target.steps += summary.steps
  target.completed += summary.completed
  target.retried += summary.retried
  target.dead += summary.dead
  target.cancelled += summary.cancelled
  target.compensated += summary.compensated
  target.compensationErrors += summary.compensationErrors
  target.released += summary.released
  target.lost += summary.lost
}

interface MutableTotals {
  claimed: number
  steps: number
  completed: number
  retried: number
  dead: number
  cancelled: number
  compensated: number
  compensationErrors: number
  released: number
  lost: number
}
