import { describe, expect, it, vi } from 'vitest'
import { WorkflowRuntime } from '../../../packages/v7/src/app/workflow/runtime.js'
import { TimerWorker } from '../../../packages/v7/src/app/workflow/timer.js'
import type {
  ClaimedWorkflowRun,
  TimerCancelInput,
  TimerClaimOptions,
  TimerFailureInput,
  TimerHandler,
  TimerScheduleInput,
  TimerScheduleResult,
  TimerStats,
  TimerStore,
  TimerTask,
  WorkflowAbandonInput,
  WorkflowBeginStepInput,
  WorkflowCancelInput,
  WorkflowClaimOptions,
  WorkflowCompensateInput,
  WorkflowCompleteStepInput,
  WorkflowDefinition,
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
} from '../../../packages/v7/src/app/workflow/index.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'

/** 可控时钟：退避/到期都用它推进，测试里没有真实 sleep。 */
class FakeClock implements Clock {
  constructor(private current = Date.parse('2026-11-27T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current)
  }
  iso(): string {
    return new Date(this.current).toISOString()
  }
  advance(ms: number): void {
    this.current += ms
  }
}

interface MemoryRun {
  id: string
  name: string
  version: number
  state: JsonValue
  step: string | null
  status: WorkflowRunStatus
  attempts: number
  nextRunAt: number | null
  idempotencyKey: string
  lastError: string | null
  createdAt: number
  updatedAt: number
}

interface MemoryStep {
  runId: string
  step: string
  attempt: number
  status: WorkflowStepStatus
  input?: JsonValue
  output?: JsonValue
  error?: string
  startedAt: number
  finishedAt?: number
  compensatedAt?: number
}

/** 内存工作流存储：复刻 008 的状态机与 CAS 语义，不引入计时器。 */
class MemoryWorkflowStore implements WorkflowStore {
  readonly runs = new Map<string, MemoryRun>()
  readonly stepRows: MemoryStep[] = []

  constructor(private readonly clock: Clock) {}

  seedRun(input: {
    id?: string
    name?: string
    version?: number
    state?: JsonValue
    step?: string | null
    status?: WorkflowRunStatus
    attempts?: number
    nextRunAt?: Date | null
    idempotencyKey?: string
  }): MemoryRun {
    const now = this.clock.now().getTime()
    const run: MemoryRun = {
      id: input.id ?? `run-${this.runs.size + 1}`,
      name: input.name ?? 'probe',
      version: input.version ?? 1,
      state: input.state ?? {},
      step: input.step === undefined ? 'a' : input.step,
      status: input.status ?? 'pending',
      attempts: input.attempts ?? 0,
      nextRunAt: input.nextRunAt === undefined ? now : input.nextRunAt?.getTime() ?? null,
      idempotencyKey: input.idempotencyKey ?? `key-${this.runs.size + 1}`,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(run.id, run)
    return run
  }

  seedStep(input: Partial<MemoryStep> & { runId: string; step: string; attempt: number }): MemoryStep {
    const row: MemoryStep = {
      status: 'completed',
      input: {},
      output: { state: {}, next: null },
      startedAt: this.clock.now().getTime(),
      ...input,
    }
    this.stepRows.push(row)
    return row
  }

  async start(input: WorkflowStartInput): Promise<WorkflowStartResult> {
    const existing = [...this.runs.values()].find(run => run.idempotencyKey === input.idempotencyKey)
    if (existing !== undefined) return { runId: existing.id, inserted: false }
    const now = this.clock.now().getTime()
    const runAt = input.runAt === undefined ? now : input.runAt.getTime()
    const run: MemoryRun = {
      id: input.id,
      name: input.name,
      version: input.version,
      state: input.state,
      step: input.step,
      status: runAt > now ? 'waiting' : 'pending',
      attempts: 0,
      nextRunAt: runAt,
      idempotencyKey: input.idempotencyKey,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(run.id, run)
    return { runId: run.id, inserted: true }
  }

  async get(runId: string): Promise<WorkflowRunSnapshot | undefined> {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : snapshotOf(run)
  }

  async steps(runId: string): Promise<readonly WorkflowStepRecord[]> {
    return this.stepRows
      .filter(row => row.runId === runId)
      .sort((left, right) => left.startedAt - right.startedAt || left.attempt - right.attempt)
      .map(row => ({
        runId: row.runId,
        step: row.step,
        attempt: row.attempt,
        status: row.status,
        ...(row.input !== undefined ? { input: row.input } : {}),
        ...(row.output !== undefined ? { output: row.output } : {}),
        ...(row.error !== undefined ? { error: row.error } : {}),
        startedAt: new Date(row.startedAt).toISOString(),
        ...(row.finishedAt !== undefined ? { finishedAt: new Date(row.finishedAt).toISOString() } : {}),
        ...(row.compensatedAt !== undefined ? { compensatedAt: new Date(row.compensatedAt).toISOString() } : {}),
      }))
  }

  async claimDue(options: WorkflowClaimOptions): Promise<readonly ClaimedWorkflowRun[]> {
    const now = this.clock.now().getTime()
    const due = [...this.runs.values()]
      .filter(run => (run.status === 'pending' || run.status === 'running' || run.status === 'waiting')
        && run.nextRunAt !== null && run.nextRunAt <= now)
      .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0) || left.id.localeCompare(right.id))
      .slice(0, options.limit)
    for (const run of due) {
      run.status = 'running'
      run.attempts += 1
      run.nextRunAt = now + options.leaseMs
      run.updatedAt = now
    }
    return due.map(run => snapshotOf(run))
  }

  async beginStep(input: WorkflowBeginStepInput): Promise<WorkflowStepRecord> {
    const existing = this.findStep(input.runId, input.step, input.attempt)
    if (existing !== undefined) return (await this.steps(input.runId)).find(row => row.step === input.step && row.attempt === input.attempt) as WorkflowStepRecord
    const row = this.seedStep({
      runId: input.runId,
      step: input.step,
      attempt: input.attempt,
      status: 'running',
      input: input.input,
      output: undefined,
      finishedAt: undefined,
    })
    return (await this.steps(input.runId)).find(item => item.step === row.step && item.attempt === row.attempt) as WorkflowStepRecord
  }

  async completeStep(input: WorkflowCompleteStepInput): Promise<boolean> {
    const run = this.runs.get(input.runId)
    if (run === undefined || run.status !== 'running' || run.attempts !== input.attempt) return false
    const step = this.findStep(input.runId, input.step, input.attempt)
    if (step === undefined || step.status !== 'running') return false
    const now = this.clock.now().getTime()
    step.status = 'completed'
    step.output = input.output
    step.finishedAt = now
    run.state = input.state
    run.step = input.nextStep
    run.status = input.nextStep === null ? 'completed' : 'running'
    run.nextRunAt = input.nextStep === null ? null : now
    run.lastError = null
    run.updatedAt = now
    return true
  }

  async failStep(input: WorkflowFailInput): Promise<WorkflowFailResult> {
    const run = this.runs.get(input.runId)
    if (run === undefined || run.status !== 'running' || run.attempts !== input.attempt) {
      return { applied: false, failures: 0 }
    }
    const step = this.findStep(input.runId, input.step, input.attempt)
    if (step === undefined || step.status !== 'running') return { applied: false, failures: 0 }
    const now = this.clock.now().getTime()
    step.status = 'failed'
    step.error = input.error
    step.finishedAt = now
    run.status = input.dead === true ? 'dead' : 'pending'
    run.nextRunAt = input.dead === true ? null : input.retryAt?.getTime() ?? now
    run.lastError = input.error
    run.updatedAt = now
    const failures = this.stepRows.filter(
      row => row.runId === input.runId && row.step === input.step && row.status === 'failed',
    ).length
    return { applied: true, failures }
  }

  async compensateStep(input: WorkflowCompensateInput): Promise<boolean> {
    const step = this.findStep(input.runId, input.step, input.attempt)
    if (step === undefined || step.status !== 'completed') return false
    const now = this.clock.now().getTime()
    step.status = 'compensated'
    step.compensatedAt = now
    return true
  }

  async cancel(input: WorkflowCancelInput): Promise<boolean> {
    const run = this.runs.get(input.runId)
    if (run === undefined) return false
    const now = this.clock.now().getTime()
    const cancellable = input.attempt !== undefined
      ? run.attempts === input.attempt && (run.status === 'running' || run.status === 'pending' || run.status === 'waiting')
      : run.status === 'pending' || run.status === 'waiting' || run.status === 'failed' || run.status === 'dead'
        || (run.status === 'running' && run.nextRunAt !== null && run.nextRunAt <= now)
    if (!cancellable) return false
    run.status = 'cancelled'
    run.nextRunAt = null
    run.updatedAt = now
    return true
  }

  async retryRun(runId: string): Promise<boolean> {
    const run = this.runs.get(runId)
    if (run === undefined || (run.status !== 'dead' && run.status !== 'failed')) return false
    const now = this.clock.now().getTime()
    run.status = 'pending'
    run.nextRunAt = now
    run.lastError = null
    run.updatedAt = now
    return true
  }

  async release(input: WorkflowReleaseInput): Promise<boolean> {
    const run = this.runs.get(input.runId)
    if (run === undefined || run.status !== 'running' || run.attempts !== input.attempt) return false
    const now = this.clock.now().getTime()
    run.status = 'pending'
    run.nextRunAt = now
    run.updatedAt = now
    return true
  }

  async abandon(input: WorkflowAbandonInput): Promise<boolean> {
    const run = this.runs.get(input.runId)
    if (run === undefined || run.status !== 'running' || run.attempts !== input.attempt) return false
    run.status = 'dead'
    run.nextRunAt = null
    run.lastError = input.error
    run.updatedAt = this.clock.now().getTime()
    return true
  }

  async recover(): Promise<WorkflowRecoveryReport> {
    const now = this.clock.now().getTime()
    let recovered = 0
    for (const run of this.runs.values()) {
      if (run.status === 'running' && run.nextRunAt !== null && run.nextRunAt <= now) {
        run.status = 'pending'
        run.nextRunAt = now
        run.updatedAt = now
        recovered += 1
      }
    }
    const due = [...this.runs.values()].filter(
      run => (run.status === 'pending' || run.status === 'waiting') && run.nextRunAt !== null && run.nextRunAt <= now,
    ).length
    return { recovered, due }
  }

  async stats(): Promise<WorkflowStats> {
    const count = (status: WorkflowRunStatus): number =>
      [...this.runs.values()].filter(run => run.status === status).length
    const now = this.clock.now().getTime()
    const dueRuns = [...this.runs.values()].filter(
      run => (run.status === 'pending' || run.status === 'waiting') && run.nextRunAt !== null && run.nextRunAt <= now,
    )
    const oldest = dueRuns.length === 0 ? 0 : now - Math.min(...dueRuns.map(run => run.nextRunAt ?? now))
    return {
      pending: count('pending'),
      running: count('running'),
      waiting: count('waiting'),
      completed: count('completed'),
      failed: count('failed'),
      dead: count('dead'),
      cancelled: count('cancelled'),
      oldestDueAgeMs: Math.max(0, oldest),
    }
  }

  async nextDueAt(): Promise<string | undefined> {
    const next = [...this.runs.values()]
      .filter(run => run.status === 'pending' || run.status === 'running' || run.status === 'waiting')
      .map(run => run.nextRunAt)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0]
    return next === undefined ? undefined : new Date(next).toISOString()
  }

  private findStep(runId: string, step: string, attempt: number): MemoryStep | undefined {
    return this.stepRows.find(row => row.runId === runId && row.step === step && row.attempt === attempt)
  }
}

function snapshotOf(run: MemoryRun): WorkflowRunSnapshot {
  return {
    id: run.id,
    name: run.name,
    version: run.version,
    state: run.state,
    step: run.step,
    status: run.status,
    attempts: run.attempts,
    ...(run.nextRunAt !== null ? { nextRunAt: new Date(run.nextRunAt).toISOString() } : {}),
    ...(run.lastError !== null ? { lastError: run.lastError } : {}),
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
  }
}

interface MemoryTimer {
  id: number
  topic: string
  payload: JsonValue
  dueAt: number
  status: 'pending' | 'claimed' | 'done' | 'dead' | 'cancelled'
  attempts: number
  dedupeKey?: string
  lastError?: string
}

/** 内存 timer 存储：复刻 dedupe/lease/CAS 语义。 */
class MemoryTimerStore implements TimerStore {
  readonly timers: MemoryTimer[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  seed(input: { topic?: string; payload?: JsonValue; dueAt?: Date; status?: MemoryTimer['status']; attempts?: number; dedupeKey?: string }): MemoryTimer {
    const timer: MemoryTimer = {
      id: this.nextId,
      topic: input.topic ?? 'probe',
      payload: input.payload ?? {},
      dueAt: input.dueAt?.getTime() ?? this.clock.now().getTime(),
      status: input.status ?? 'pending',
      attempts: input.attempts ?? 0,
      ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    }
    this.nextId += 1
    this.timers.push(timer)
    return timer
  }

  async schedule(input: TimerScheduleInput): Promise<TimerScheduleResult> {
    const existing = input.dedupeKey === undefined
      ? undefined
      : this.timers.find(timer => timer.dedupeKey === input.dedupeKey && timer.status !== 'cancelled')
    if (existing !== undefined) {
      existing.topic = input.topic
      existing.payload = input.payload
      existing.dueAt = input.dueAt.getTime()
      existing.status = 'pending'
      existing.attempts = 0
      existing.lastError = undefined
      return { id: existing.id, inserted: false, dueAt: input.dueAt.toISOString() }
    }
    const timer = this.seed({ topic: input.topic, payload: input.payload, dueAt: input.dueAt, ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}) })
    return { id: timer.id, inserted: true, dueAt: input.dueAt.toISOString() }
  }

  async cancel(input: TimerCancelInput): Promise<boolean> {
    const timer = input.id !== undefined
      ? this.timers.find(item => item.id === input.id)
      : this.timers.find(item => item.dedupeKey !== undefined && item.dedupeKey === input.dedupeKey)
    if (timer === undefined || (timer.status !== 'pending' && timer.status !== 'claimed')) return false
    timer.status = 'cancelled'
    return true
  }

  async claimDue(options: TimerClaimOptions): Promise<readonly TimerTask[]> {
    const now = this.clock.now().getTime()
    const due = this.timers
      .filter(timer => (timer.status === 'pending' || timer.status === 'claimed') && timer.dueAt <= now)
      .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)
      .slice(0, options.limit)
    for (const timer of due) {
      timer.status = 'claimed'
      timer.dueAt = now + options.leaseMs
    }
    return due.map(timer => this.taskOf(timer))
  }

  async complete(id: number, expectedAttempts: number): Promise<boolean> {
    const timer = this.timers.find(item => item.id === id)
    if (timer === undefined || timer.status !== 'claimed' || timer.attempts !== expectedAttempts) return false
    timer.status = 'done'
    return true
  }

  async fail(input: TimerFailureInput): Promise<boolean> {
    const timer = this.timers.find(item => item.id === input.id)
    if (timer === undefined || timer.status !== 'claimed' || timer.attempts !== input.expectedAttempts) return false
    timer.attempts += 1
    timer.lastError = input.error
    if (input.dead === true) {
      timer.status = 'dead'
      return true
    }
    timer.status = 'pending'
    timer.dueAt = input.retryAt?.getTime() ?? this.clock.now().getTime()
    return true
  }

  async release(id: number, expectedAttempts: number): Promise<boolean> {
    const timer = this.timers.find(item => item.id === id)
    if (timer === undefined || timer.status !== 'claimed' || timer.attempts !== expectedAttempts) return false
    timer.status = 'pending'
    timer.dueAt = this.clock.now().getTime()
    return true
  }

  async nextDueAt(): Promise<string | undefined> {
    const next = this.timers
      .filter(timer => timer.status === 'pending' || timer.status === 'claimed')
      .map(timer => timer.dueAt)
      .sort((left, right) => left - right)[0]
    return next === undefined ? undefined : new Date(next).toISOString()
  }

  async stats(): Promise<TimerStats> {
    const count = (status: MemoryTimer['status']): number => this.timers.filter(timer => timer.status === status).length
    const now = this.clock.now().getTime()
    const due = this.timers.filter(
      timer => (timer.status === 'pending' || timer.status === 'claimed') && timer.dueAt <= now,
    )
    return {
      pending: count('pending'),
      claimed: count('claimed'),
      done: count('done'),
      dead: count('dead'),
      cancelled: count('cancelled'),
      oldestDueAgeMs: due.length === 0 ? 0 : now - Math.min(...due.map(timer => timer.dueAt)),
    }
  }

  private taskOf(timer: MemoryTimer): TimerTask {
    return {
      id: timer.id,
      topic: timer.topic,
      payload: timer.payload,
      dueAt: new Date(timer.dueAt).toISOString(),
      attempts: timer.attempts,
      ...(timer.dedupeKey !== undefined ? { dedupeKey: timer.dedupeKey } : {}),
    }
  }
}

function runtimeOf(store: WorkflowStore, clock: Clock): WorkflowRuntime {
  return new WorkflowRuntime({ store, clock }, { batchSize: 10, leaseMs: 5_000, retry: { maxAttempts: 3, baseDelayMs: 100, factor: 4, maxDelayMs: 1_000 } })
}

function probeDefinition(
  steps: WorkflowDefinition['steps'],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return { name: 'probe', version: 1, initial: { n: 0 }, steps, ...overrides }
}

describe('WorkflowRuntime 注册与 start 幂等', () => {
  it('给定空 steps 或重复 step 名当 register 则立即抛错', () => {
    const clock = new FakeClock()
    const runtime = runtimeOf(new MemoryWorkflowStore(clock), clock)
    expect(() => runtime.register(probeDefinition([]))).toThrow('至少需要一个 step')
    expect(() => runtime.register(probeDefinition([
      { name: 'a', run: async () => ({ state: {} }) },
      { name: 'a', run: async () => ({ state: {} }) },
    ]))).toThrow('step 重复：a')
    expect(() => runtime.register(probeDefinition([{ name: 'a', run: async () => ({ state: {} }) }]))).not.toThrow()
    expect(() => runtime.register(probeDefinition([{ name: 'a', run: async () => ({ state: {} }) }]))).toThrow('已注册')
  })

  it('给定同一 idempotencyKey 当两次 startRun 则只建一个 run 并返回同一 runId', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    runtime.register(probeDefinition([{ name: 'a', run: async () => ({ state: { n: 1 } }) }]))
    const first = await runtime.startRun('probe', undefined, { idempotencyKey: 'dedupe-key' })
    const second = await runtime.startRun('probe', undefined, { idempotencyKey: 'dedupe-key' })
    expect(first.inserted).toBe(true)
    expect(second).toEqual({ runId: first.runId, inserted: false })
    expect(store.runs.size).toBe(1)
  })

  it('给定未注册 workflow 当 startRun 则抛错而不是静默建 run', async () => {
    const clock = new FakeClock()
    const runtime = runtimeOf(new MemoryWorkflowStore(clock), clock)
    await expect(runtime.startRun('ghost', undefined, { idempotencyKey: 'k' })).rejects.toThrow('未注册')
  })
})

describe('WorkflowRuntime 顺序执行与 checkpoint 幂等', () => {
  it('给定三步工作流当 drain 则按序 checkpoint、run 完成，二次 drain 不重复执行', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const calls: string[] = []
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async state => {
          calls.push('a')
          return { state: { n: (state as { n: number }).n + 1 } }
        },
      },
      {
        name: 'b',
        run: async state => {
          calls.push('b')
          return { state: { n: (state as { n: number }).n + 1 } }
        },
      },
      {
        name: 'c',
        run: async state => {
          calls.push('c')
          return { state: { n: (state as { n: number }).n + 1 } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'run-1' })

    const first = await runtime.drain()
    expect(first).toMatchObject({ claimed: 1, steps: 3, completed: 1, retried: 0, dead: 0 })
    expect(calls).toEqual(['a', 'b', 'c'])
    const run = await store.get(runId)
    expect(run).toMatchObject({ status: 'completed', step: null, state: { n: 3 }, attempts: 1 })
    const records = await store.steps(runId)
    expect(records.map(record => `${record.step}:${record.status}`)).toEqual(['a:completed', 'b:completed', 'c:completed'])
    expect(records.every(record => record.output !== undefined)).toBe(true)

    const second = await runtime.drain()
    expect(second.claimed).toBe(0)
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('给定 step 返回 next 指向未知步骤当执行则落 dead 且不写 checkpoint', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    runtime.register(probeDefinition([
      { name: 'a', run: async () => ({ state: {}, next: 'ghost' }) },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'bad-next' })
    const summary = await runtime.drain()
    expect(summary.dead).toBe(1)
    expect(await store.get(runId)).toMatchObject({ status: 'dead', step: 'a' })
    expect((await store.get(runId))?.lastError).toContain('未知 next')
  })
})

describe('WorkflowRuntime 重试与失败补偿', () => {
  it('给定 step 前两次失败当退避到期后重试则完成且保留失败历史', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    let calls = 0
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async () => {
          calls += 1
          if (calls <= 2) throw new Error('flaky')
          return { state: { ok: true } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'retry' })

    expect(await runtime.drain()).toMatchObject({ claimed: 1, retried: 1, steps: 0 })
    const afterFirst = await store.get(runId)
    expect(afterFirst).toMatchObject({ status: 'pending', attempts: 1 })
    expect(afterFirst?.lastError).toContain('flaky')
    expect(afterFirst?.nextRunAt).toBe(new Date(clock.now().getTime() + 100).toISOString())

    expect(await runtime.drain()).toMatchObject({ claimed: 0 })
    clock.advance(150)
    expect(await runtime.drain()).toMatchObject({ claimed: 1, retried: 1 })
    clock.advance(1_000)
    expect(await runtime.drain()).toMatchObject({ claimed: 1, steps: 1, completed: 1 })
    expect(calls).toBe(3)
    const records = await store.steps(runId)
    expect(records.map(record => record.status)).toEqual(['failed', 'failed', 'completed'])
    expect(records.map(record => record.attempt)).toEqual([1, 2, 3])
  })

  it('给定 step 永远失败当重试耗尽则落 dead 并按逆序补偿已完成步骤', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const undo: string[] = []
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async () => ({ state: { a: 1 } }),
        compensate: async () => {
          undo.push('a')
        },
      },
      {
        name: 'b',
        run: async () => ({ state: { b: 1 } }),
        compensate: async () => {
          undo.push('b')
        },
      },
      {
        name: 'c',
        run: async () => {
          throw new Error('boom')
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'dead' })
    let summary = await runtime.drain()
    for (let index = 0; index < 5 && (await store.get(runId))?.status === 'pending'; index += 1) {
      clock.advance(10_000)
      summary = await runtime.drain()
    }
    const run = await store.get(runId)
    expect(run).toMatchObject({ status: 'dead', step: 'c' })
    expect(run?.lastError).toContain('boom')
    expect(summary).toMatchObject({ dead: 1, compensated: 2 })
    expect(undo).toEqual(['b', 'a'])
    const records = await store.steps(runId)
    expect(records.filter(record => record.status === 'compensated').map(record => record.step)).toEqual(['a', 'b'])
    expect(records.find(record => record.step === 'c')?.status).toBe('failed')
  })

  it('给定补偿抛错当逆序补偿则其它步骤仍被补偿、失败步骤保持 completed', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const undo: string[] = []
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async () => ({ state: { a: 1 } }),
        compensate: async () => {
          throw new Error('undo-a failed')
        },
      },
      {
        name: 'b',
        run: async () => ({ state: { b: 1 } }),
        compensate: async () => {
          undo.push('b')
        },
      },
      {
        name: 'c',
        run: async () => {
          throw new Error('boom')
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'undo-error' })
    let summary = await runtime.drain()
    for (let index = 0; index < 5 && (await store.get(runId))?.status === 'pending'; index += 1) {
      clock.advance(10_000)
      summary = await runtime.drain()
    }
    expect(summary).toMatchObject({ dead: 1, compensated: 1, compensationErrors: 1 })
    expect(undo).toEqual(['b'])
    const records = await store.steps(runId)
    expect(records.find(record => record.step === 'a')?.status).toBe('completed')
    expect(records.find(record => record.step === 'b')?.status).toBe('compensated')
    expect((await runtime.stats()).lastError).toContain('undo-a failed')
  })

  it('给定 run 处于 dead 当 retry 并再次执行成功则回到 completed', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    let fail = true
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async () => {
          if (fail) throw new Error('boom')
          return { state: { ok: true } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'replay' })
    let summary = await runtime.drain()
    for (let index = 0; index < 5 && (await store.get(runId))?.status === 'pending'; index += 1) {
      clock.advance(10_000)
      summary = await runtime.drain()
    }
    expect(summary.dead).toBe(1)
    expect(await store.get(runId)).toMatchObject({ status: 'dead' })

    fail = false
    expect(await runtime.retry(runId)).toBe(true)
    const completed = await runtime.drain()
    expect(completed).toMatchObject({ claimed: 1, steps: 1, completed: 1 })
    expect(await store.get(runId)).toMatchObject({ status: 'completed' })
  })
})

describe('WorkflowRuntime 启动恢复与 checkpoint 语义', () => {
  it('给定 run 已从 checkpoint 推进到 b 当恢复执行则只跑 b，不重跑已完成步骤', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const calls: string[] = []
    const runtime = runtimeOf(store, clock)
    runtime.register(probeDefinition([
      { name: 'a', run: async () => ({ state: { a: 1 } }) },
      {
        name: 'b',
        run: async state => {
          calls.push('b')
          return { state: { ...(state as object), b: 1 } }
        },
      },
    ]))
    const run = store.seedRun({ id: 'run-resume', state: { a: 1 }, step: 'b', status: 'pending' })
    store.seedStep({ runId: run.id, step: 'a', attempt: 1, status: 'completed', input: {}, output: { state: { a: 1 }, next: 'b' }, finishedAt: clock.now().getTime() })

    const summary = await runtime.drain()
    expect(summary).toMatchObject({ claimed: 1, steps: 1, completed: 1 })
    expect(calls).toEqual(['b'])
    expect(await store.get(run.id)).toMatchObject({ status: 'completed', state: { a: 1, b: 1 } })
  })

  it('给定未注册 workflow 的 run 当执行则落 dead 且不执行任何 step', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const run = store.seedRun({ id: 'run-unknown-workflow', name: 'ghost', step: 'a', status: 'pending' })
    const summary = await runtime.drain()
    expect(summary).toMatchObject({ dead: 1, steps: 0 })
    expect(await store.get(run.id)).toMatchObject({ status: 'dead' })
    expect((await store.get(run.id))?.lastError).toContain('workflow 未注册')
  })

  it('给定同一 attempt 两次 beginStep 当幂等调用则只有一条 step 行', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    store.seedRun({ id: 'run-begin-idempotent', step: 'a', status: 'pending' })
    await store.claimDue({ limit: 1, leaseMs: 100 })
    const first = await store.beginStep({ runId: 'run-begin-idempotent', step: 'a', attempt: 1, input: { n: 1 } })
    const second = await store.beginStep({ runId: 'run-begin-idempotent', step: 'a', attempt: 1, input: { n: 1 } })
    expect(second).toEqual(first)
    expect((await store.steps('run-begin-idempotent')).filter(row => row.step === 'a')).toHaveLength(1)
  })

  it('给定 running 且租约过期当 recover 则回 pending 并从当前 step 继续', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const calls: string[] = []
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async () => {
          calls.push('a')
          return { state: { a: 1 } }
        },
      },
    ]))
    store.seedRun({ id: 'run-crash', step: 'a', status: 'running', attempts: 3, nextRunAt: new Date(clock.now().getTime() - 1) })
    const report = await runtime.recover()
    expect(report).toEqual({ recovered: 1, due: 1 })
    expect(await store.get('run-crash')).toMatchObject({ status: 'pending', attempts: 3 })
    expect(await runtime.drain()).toMatchObject({ claimed: 1, completed: 1 })
    expect(calls).toEqual(['a'])
    expect(await store.get('run-crash')).toMatchObject({ status: 'completed', attempts: 4 })
  })

  it('给定 checkpoint 已存在但 run 仍指向同一 step 当 claim 则落 dead 而不是重复执行', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const calls: string[] = []
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async () => {
          calls.push('a')
          return { state: {} }
        },
      },
    ]))
    const run = store.seedRun({ id: 'run-inconsistent', step: 'a', status: 'pending', attempts: 0 })
    // 下一次 claim 的 attempt 是 1；预置同一 (run, step, attempt) 的 completed 行模拟不一致。
    store.seedStep({ runId: run.id, step: 'a', attempt: 1, status: 'completed', output: { state: {}, next: null } })
    const summary = await runtime.drain()
    expect(summary).toMatchObject({ dead: 1, steps: 0 })
    expect(calls).toEqual([])
    expect(await store.get(run.id)).toMatchObject({ status: 'dead' })
    expect((await store.get(run.id))?.lastError).toContain('checkpoint 不一致')
  })

  it('给定 run 的 workflow 版本不匹配当执行则落 dead 且不执行任何 step', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const calls: string[] = []
    runtime.register(probeDefinition([{ name: 'a', run: async () => ({ state: {} }) }], { version: 2 }))
    const run = store.seedRun({ id: 'run-version', version: 1, step: 'a', status: 'pending' })
    await runtime.drain()
    expect(calls).toEqual([])
    expect(await store.get(run.id)).toMatchObject({ status: 'dead' })
    expect((await store.get(run.id))?.lastError).toContain('版本不匹配')
  })
})

describe('WorkflowRuntime 取消', () => {
  it('给定正在执行的步骤当 cancel 则中断、run 变 cancelled、只补偿已完成步骤且不再重试', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    const undo: string[] = []
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    runtime.register(probeDefinition([
      {
        name: 'a',
        run: async () => ({ state: { a: 1 } }),
        compensate: async () => {
          undo.push('a')
        },
      },
      {
        name: 'b',
        run: async (_state, ctx) => {
          entered()
          await new Promise<void>((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
          return { state: { b: 1 } }
        },
        compensate: async () => {
          undo.push('b')
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'cancel' })
    runtime.start()
    try {
      await enteredPromise
      const result = await runtime.cancel(runId)
      expect(result).toMatchObject({ cancelled: true, compensated: 1, compensationErrors: 0 })
      expect(undo).toEqual(['a'])
      const run = await store.get(runId)
      expect(run).toMatchObject({ status: 'cancelled', step: 'b' })
      const records = await store.steps(runId)
      expect(records.find(record => record.step === 'a')?.status).toBe('compensated')
      expect(records.find(record => record.step === 'b')).toMatchObject({ status: 'failed', error: 'cancelled by caller' })

      // 取消后不再有到期 run：推进时钟也不会被重新执行。
      clock.advance(60_000)
      expect(await runtime.drain()).toMatchObject({ claimed: 0 })
      expect(await store.get(runId)).toMatchObject({ status: 'cancelled' })
    } finally {
      await runtime.stop()
    }
  })

  it('给定 run 已 completed 当 cancel 则返回 cancelled=false 且不改状态', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    runtime.register(probeDefinition([{ name: 'a', run: async () => ({ state: {} }) }]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'cancel-done' })
    await runtime.drain()
    const result = await runtime.cancel(runId)
    expect(result.cancelled).toBe(false)
    expect(result.status).toBe('completed')
    expect(await store.get(runId)).toMatchObject({ status: 'completed' })
  })
})

describe('WorkflowStore 语义（内存实现自检）', () => {
  it('给定旧 attempt 当新 holder 重领后 completeStep 则 CAS 失败且不推进 run', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    const runtime = runtimeOf(store, clock)
    runtime.register(probeDefinition([{ name: 'a', run: async () => ({ state: {} }) }]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'cas' })
    const first = await store.claimDue({ limit: 1, leaseMs: 100 })
    expect(first[0]).toMatchObject({ attempts: 1 })
    clock.advance(200)
    const second = await store.claimDue({ limit: 1, leaseMs: 100 })
    expect(second[0]).toMatchObject({ attempts: 2 })
    await store.beginStep({ runId, step: 'a', attempt: 1, input: {} })
    await store.beginStep({ runId, step: 'a', attempt: 2, input: {} })
    expect(await store.completeStep({ runId, step: 'a', attempt: 1, state: {}, nextStep: null, output: { state: {}, next: null } })).toBe(false)
    expect(await store.completeStep({ runId, step: 'a', attempt: 2, state: {}, nextStep: null, output: { state: {}, next: null } })).toBe(true)
    expect(await store.get(runId)).toMatchObject({ status: 'completed', attempts: 2 })
  })

  it('给定同一 attempt 第二次 failStep 当 attempts 已变化则 CAS 失败', async () => {
    const clock = new FakeClock()
    const store = new MemoryWorkflowStore(clock)
    store.seedRun({ id: 'run-fail-cas', step: 'a', status: 'pending' })
    await store.claimDue({ limit: 1, leaseMs: 100 })
    await store.beginStep({ runId: 'run-fail-cas', step: 'a', attempt: 1, input: {} })
    expect(await store.failStep({ runId: 'run-fail-cas', step: 'a', attempt: 1, error: 'boom' })).toEqual({ applied: true, failures: 1 })
    expect(await store.failStep({ runId: 'run-fail-cas', step: 'a', attempt: 1, error: 'boom' })).toEqual({ applied: false, failures: 0 })
    expect(await store.completeStep({ runId: 'run-fail-cas', step: 'a', attempt: 1, state: {}, nextStep: null, output: {} })).toBe(false)
  })
})

describe('TimerWorker 与 TimerStore', () => {
  function workerOf(store: TimerStore, clock: Clock, handlers: readonly TimerHandler[]): TimerWorker {
    return new TimerWorker(
      { store, handlers, clock },
      { batchSize: 10, leaseMs: 5_000, retry: { maxAttempts: 2, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 } },
    )
  }

  it('给定 future timer 当 tick 则只派发已到期的 timer', async () => {
    const clock = new FakeClock()
    const store = new MemoryTimerStore(clock)
    const fired: number[] = []
    const storeWithDue = store
    const worker = workerOf(storeWithDue, clock, [{ topic: 'probe', run: async task => { fired.push(task.id) } }])
    const due = store.seed({ topic: 'probe', dueAt: new Date(clock.now().getTime() - 1_000) })
    const future = store.seed({ topic: 'probe', dueAt: new Date(clock.now().getTime() + 60_000) })
    expect(await worker.tick()).toMatchObject({ claimed: 1, fired: 1 })
    expect(fired).toEqual([due.id])
    expect(store.timers.find(timer => timer.id === future.id)?.status).toBe('pending')
    clock.advance(60_000)
    expect(await worker.tick()).toMatchObject({ claimed: 1, fired: 1 })
    expect(fired).toEqual([due.id, future.id])
  })

  it('给定同一 dedupeKey 两次 schedule 当查询则只有一行且重排期', async () => {
    const clock = new FakeClock()
    const store = new MemoryTimerStore(clock)
    const first = await store.schedule({ topic: 'probe', payload: { n: 1 }, dueAt: new Date(clock.now().getTime() + 5_000), dedupeKey: 'decay:e1' })
    const second = await store.schedule({ topic: 'probe', payload: { n: 2 }, dueAt: new Date(clock.now().getTime() + 1_000), dedupeKey: 'decay:e1' })
    expect(first.inserted).toBe(true)
    expect(second).toMatchObject({ id: first.id, inserted: false })
    expect(store.timers).toHaveLength(1)
    expect(store.timers[0]).toMatchObject({ payload: { n: 2 }, status: 'pending', attempts: 0 })
    expect(store.timers[0]?.dueAt).toBe(clock.now().getTime() + 1_000)
  })

  it('给定 handler 抛错当按退避重试到上限则进死信', async () => {
    const clock = new FakeClock()
    const store = new MemoryTimerStore(clock)
    let calls = 0
    const worker = workerOf(store, clock, [{ topic: 'flaky', run: async () => { calls += 1; throw new Error('boom') } }])
    store.seed({ topic: 'flaky', dueAt: new Date(clock.now().getTime() - 1) })
    expect(await worker.tick()).toMatchObject({ claimed: 1, retried: 1, dead: 0 })
    expect(store.timers[0]).toMatchObject({ status: 'pending', attempts: 1 })
    clock.advance(10_000)
    expect(await worker.tick()).toMatchObject({ claimed: 1, dead: 1, retried: 0 })
    expect(store.timers[0]).toMatchObject({ status: 'dead', attempts: 2 })
    expect(calls).toBe(2)
    expect((await worker.stats()).lastError).toContain('boom')
  })

  it('给定未注册 topic 当 tick 则进死信且错误里带 topic', async () => {
    const clock = new FakeClock()
    const store = new MemoryTimerStore(clock)
    const worker = workerOf(store, clock, [{ topic: 'known', run: async () => {} }])
    store.seed({ topic: 'missing', dueAt: new Date(clock.now().getTime() - 1) })
    expect(await worker.tick()).toMatchObject({ claimed: 1, dead: 1 })
    expect(store.timers[0]?.lastError).toContain('missing')
  })

  it('给定 timer 被取消当 tick 则不派发', async () => {
    const clock = new FakeClock()
    const store = new MemoryTimerStore(clock)
    const fired: number[] = []
    const worker = workerOf(store, clock, [{ topic: 'probe', run: async task => { fired.push(task.id) } }])
    const timer = store.seed({ topic: 'probe', dueAt: new Date(clock.now().getTime() - 1), dedupeKey: 'dedupe-x' })
    expect(await store.cancel({ dedupeKey: 'dedupe-x' })).toBe(true)
    expect(await worker.tick()).toMatchObject({ claimed: 0 })
    expect(fired).toEqual([])
    expect(store.timers.find(item => item.id === timer.id)?.status).toBe('cancelled')
  })

  it('给定空闲当 worker start 则不用 setInterval 轮询，只等待 NOTIFY/到期', async () => {
    const clock = new FakeClock()
    const store = new MemoryTimerStore(clock)
    const worker = workerOf(store, clock, [{ topic: 'probe', run: async () => {} }])
    const spy = vi.spyOn(globalThis, 'setInterval')
    try {
      worker.start()
      // 让循环跑到等待点：tick（空）→ nextDueAt（undefined）→ 无限等待。
      await Promise.resolve()
      await Promise.resolve()
      expect(spy).not.toHaveBeenCalled()
      expect(await worker.recover()).toBe(false)
    } finally {
      await worker.stop()
      spy.mockRestore()
    }
  })

  it('给定到期 timer 当 recover 则叫醒并派发', async () => {
    const clock = new FakeClock()
    const store = new MemoryTimerStore(clock)
    let fired = 0
    const worker = workerOf(store, clock, [{ topic: 'probe', run: async () => { fired += 1 } }])
    store.seed({ topic: 'probe', dueAt: new Date(clock.now().getTime() - 1) })
    worker.start()
    try {
      expect(await worker.recover()).toBe(true)
      for (let index = 0; index < 100 && fired === 0; index += 1) await Promise.resolve()
      expect(fired).toBe(1)
    } finally {
      await worker.stop()
    }
  })
})
