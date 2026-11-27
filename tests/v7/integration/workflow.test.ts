import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  TimerWorker,
  WorkflowRuntime,
  type TimerHandler,
  type TimerStore,
  type WorkflowDefinition,
  type WorkflowRuntimeOptions,
  type WorkflowStore,
} from '../../../packages/v7/src/app/workflow/index.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { migrateDatabase } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import {
  PostgresTimerNotifier,
  PostgresTimerStore,
  TIMER_CLAIM_SQL,
} from '../../../packages/v7/src/adapters/postgres/timer.js'
import {
  PostgresWorkflowStore,
  WORKFLOW_CLAIM_SQL,
} from '../../../packages/v7/src/adapters/postgres/workflow.js'

/** 独立测试库：不读写 omb_v7_test / 生产库；008 的 workflow/timer 表由本套件自己建。 */
const DATABASE_URL = process.env.OMB_WORKFLOW_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_workflow'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CHILD_TIMEOUT_MS = 20_000

const clock: Clock = { now: () => new Date(), iso: () => new Date().toISOString() }

let db: PostgresDb
let store: PostgresWorkflowStore
let timerStore: PostgresTimerStore

interface ExplainRow {
  'QUERY PLAN': unknown
}

interface PlanNode {
  node: string
  relation?: string
  index?: string
}

interface RunRow {
  id: string
  status: string
  step: string | null
  state: JsonValue
  attempts: number
  next_run_at: Date | null
  last_error: string | null
}

async function reset(): Promise<void> {
  await db.query('truncate table omb.workflow_run, omb.timer, omb.audit_log restart identity cascade')
}

async function runs(): Promise<RunRow[]> {
  const result = await db.query<RunRow>(
    'select id, status, step, state, attempts, next_run_at, last_error from omb.workflow_run order by id',
  )
  return result.rows
}

async function runRow(runId: string): Promise<RunRow> {
  const result = await db.query<RunRow>(
    'select id, status, step, state, attempts, next_run_at, last_error from omb.workflow_run where id = $1',
    [runId],
  )
  const row = result.rows[0]
  if (row === undefined) throw new Error(`没有 workflow_run：${runId}`)
  return row
}

/**
 * 步骤副作用：带重放稳定 commandId 的幂等写。`command_id` 有部分唯一索引，
 * 同一逻辑步骤重放（崩溃/租约过期/人工重放）只会留下一行。
 */
async function effect(commandId: string): Promise<boolean> {
  const result = await db.query(
    `insert into omb.audit_log (actor, action, command_id)
     values ('test', 'workflow-step', $1)
     on conflict (command_id) where command_id is not null do nothing`,
    [commandId],
  )
  return result.rowCount === 1
}

async function effectCount(commandId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    'select count(*)::int as count from omb.audit_log where command_id = $1',
    [commandId],
  )
  return result.rows[0]?.count ?? 0
}

/** 把 run 的下次可领取时间提前，避免测试等真实退避时间。 */
async function makeDue(runId: string): Promise<void> {
  await db.query("update omb.workflow_run set next_run_at = now() - interval '1 second' where id = $1", [runId])
}

function definition(steps: WorkflowDefinition['steps'], overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { name: 'probe', version: 1, initial: { n: 0 }, steps, ...overrides }
}

function runtimeOf(options: WorkflowRuntimeOptions = {}): WorkflowRuntime {
  return new WorkflowRuntime(
    { store, clock },
    { batchSize: 10, leaseMs: 30_000, retry: { maxAttempts: 3, baseDelayMs: 1_000, factor: 2, maxDelayMs: 5_000 }, ...options },
  )
}

function timerWorkerOf(handlers: readonly TimerHandler[], wake?: PostgresTimerNotifier): TimerWorker {
  return new TimerWorker(
    { store: timerStore, handlers, clock, ...(wake !== undefined ? { wake } : {}) },
    { batchSize: 10, leaseMs: 5_000, retry: { maxAttempts: 2, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 } },
  )
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待条件超时')
    await new Promise<void>(resolve => {
      // 有上界的条件轮询：25ms 只是重试间隔，不是用睡眠当同步/断言（test-sleep 已显式豁免）。
      // check:ignore-next-line test-sleep
      setTimeout(resolve, 25)
    })
  }
}

function collectPlanNodes(plan: unknown, nodes: PlanNode[] = []): PlanNode[] {
  if (Array.isArray(plan)) {
    for (const item of plan) collectPlanNodes(item, nodes)
    return nodes
  }
  if (typeof plan !== 'object' || plan === null) return nodes
  const record = plan as Record<string, unknown>
  if (typeof record['Node Type'] === 'string') {
    nodes.push({
      node: record['Node Type'],
      ...(typeof record['Relation Name'] === 'string' ? { relation: record['Relation Name'] } : {}),
      ...(typeof record['Index Name'] === 'string' ? { index: record['Index Name'] } : {}),
    })
  }
  if (Array.isArray(record['Plans'])) collectPlanNodes(record['Plans'], nodes)
  if (record['Plan'] !== undefined) collectPlanNodes(record['Plan'], nodes)
  return nodes
}

describe('WorkflowStore/WorkflowRuntime（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    db = new PostgresDb({ connectionString: DATABASE_URL })
    store = new PostgresWorkflowStore(db)
    timerStore = new PostgresTimerStore(db)
  })

  beforeEach(async () => {
    await reset()
  })

  afterAll(async () => {
    await db.close()
  })

  it('给定同一 idempotencyKey 当两次 startRun 则只建一个 run 并返回同一 id', async () => {
    const runtime = runtimeOf()
    runtime.register(definition([{ name: 'a', run: async () => ({ state: { n: 1 } }) }]))
    const first = await runtime.startRun('probe', undefined, { idempotencyKey: 'same-key' })
    const second = await runtime.startRun('probe', undefined, { idempotencyKey: 'same-key' })
    expect(first.inserted).toBe(true)
    expect(second).toEqual({ runId: first.runId, inserted: false })
    expect(await runs()).toHaveLength(1)
    expect((await runRow(first.runId)).id).toBe(first.runId)
  })

  it('给定三步工作流当 drain 则按序 checkpoint、run completed，二次 drain 不重复执行', async () => {
    const runtime = runtimeOf()
    const calls: string[] = []
    runtime.register(definition([
      {
        name: 'a',
        run: async (state, ctx) => {
          calls.push('a')
          await effect(ctx.commandId)
          return { state: { n: (state as { n: number }).n + 1 } }
        },
      },
      {
        name: 'b',
        run: async (state, ctx) => {
          calls.push('b')
          await effect(ctx.commandId)
          return { state: { n: (state as { n: number }).n + 1 } }
        },
      },
      {
        name: 'c',
        run: async (state, ctx) => {
          calls.push('c')
          await effect(ctx.commandId)
          return { state: { n: (state as { n: number }).n + 1 } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'three-steps' })

    const summary = await runtime.drain()
    expect(summary).toMatchObject({ claimed: 1, steps: 3, completed: 1, dead: 0 })
    expect(calls).toEqual(['a', 'b', 'c'])
    const row = await runRow(runId)
    expect(row).toMatchObject({ status: 'completed', step: null, state: { n: 3 }, attempts: 1 })

    const records = await store.steps(runId)
    expect(records.map(record => `${record.step}:${record.status}:${record.attempt}`)).toEqual([
      'a:completed:1',
      'b:completed:1',
      'c:completed:1',
    ])
    expect(records[2]?.output).toEqual({ state: { n: 3 }, next: null })
    for (const step of ['a', 'b', 'c']) expect(await effectCount(`${runId}:${step}`)).toBe(1)

    const second = await runtime.drain()
    expect(second.claimed).toBe(0)
    expect(calls).toEqual(['a', 'b', 'c'])
    const auditCount = await db.query<{ count: number }>('select count(*)::int as count from omb.audit_log')
    expect(auditCount.rows[0]?.count).toBe(3)
  })

  it('给定未来 runAt 当到期前不执行、到期后自行唤醒执行', async () => {
    const runtime = runtimeOf()
    let executions = 0
    runtime.register(definition([
      {
        name: 'a',
        run: async () => {
          executions += 1
          return { state: { fired: true } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, {
      idempotencyKey: 'waiting-run',
      runAt: new Date(Date.now() + 200),
    })
    expect((await runRow(runId)).status).toBe('waiting')
    expect((await runtime.drain()).claimed).toBe(0)
    expect(executions).toBe(0)

    runtime.start()
    try {
      await waitFor(async () => (await runRow(runId)).status === 'completed', 10_000)
      expect(executions).toBe(1)
    } finally {
      await runtime.stop()
    }
  })

  it('给定 step 前两次失败当退避后重试则 completed 且保留失败 checkpoint 历史', async () => {
    const runtime = runtimeOf({ retry: { maxAttempts: 3, baseDelayMs: 500, factor: 2, maxDelayMs: 5_000 } })
    let calls = 0
    runtime.register(definition([
      {
        name: 'a',
        run: async (_state, ctx) => {
          calls += 1
          await effect(ctx.commandId)
          if (calls <= 2) throw new Error('flaky')
          return { state: { ok: true } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'retry-run' })

    expect(await runtime.drain()).toMatchObject({ claimed: 1, retried: 1, steps: 0 })
    const afterFirst = await runRow(runId)
    expect(afterFirst).toMatchObject({ status: 'pending', attempts: 1 })
    expect(afterFirst.last_error).toContain('flaky')
    expect(afterFirst.next_run_at?.getTime()).toBeGreaterThan(Date.now())

    await makeDue(runId)
    expect(await runtime.drain()).toMatchObject({ claimed: 1, retried: 1 })
    await makeDue(runId)
    expect(await runtime.drain()).toMatchObject({ claimed: 1, steps: 1, completed: 1 })
    expect((await runRow(runId)).status).toBe('completed')
    expect(calls).toBe(3)

    const records = await store.steps(runId)
    expect(records.map(record => `${record.attempt}:${record.status}`)).toEqual(['1:failed', '2:failed', '3:completed'])
    expect(records[0]?.error).toContain('flaky')
    expect(records[1]?.error).toContain('flaky')
    expect(records[2]?.error).toBeUndefined()
    // 三次执行都用同一个 commandId，副作用只生效一次。
    expect(await effectCount(`${runId}:a`)).toBe(1)
  })

  it('给定 step 永远失败当重试耗尽则 dead 并按逆序补偿已完成步骤', async () => {
    const runtime = runtimeOf({ retry: { maxAttempts: 2, baseDelayMs: 200, factor: 2, maxDelayMs: 1_000 } })
    const undo: string[] = []
    runtime.register(definition([
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
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'dead-run' })
    let summary = await runtime.drain()
    for (let index = 0; index < 5 && (await runRow(runId)).status === 'pending'; index += 1) {
      await makeDue(runId)
      summary = await runtime.drain()
    }
    expect(summary).toMatchObject({ dead: 1, compensated: 2, compensationErrors: 0 })
    expect(undo).toEqual(['b', 'a'])
    const row = await runRow(runId)
    expect(row).toMatchObject({ status: 'dead', step: 'c' })
    expect(row.last_error).toContain('boom')
    const records = await store.steps(runId)
    const compensated = records.filter(record => record.status === 'compensated')
    expect(compensated.map(record => record.step)).toEqual(['a', 'b'])
    expect(compensated.every(record => record.compensatedAt !== undefined)).toBe(true)
    expect(records.find(record => record.step === 'c')?.status).toBe('failed')
  })

  it('给定补偿抛错当补偿则其它步骤仍被补偿、失败步骤保持 completed 可人工重试', async () => {
    const runtime = runtimeOf({ retry: { maxAttempts: 1, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 } })
    const undo: string[] = []
    runtime.register(definition([
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
    const summary = await runtime.drain()
    expect(summary).toMatchObject({ dead: 1, compensated: 1, compensationErrors: 1 })
    expect(undo).toEqual(['b'])
    const records = await store.steps(runId)
    expect(records.find(record => record.step === 'a')?.status).toBe('completed')
    expect(records.find(record => record.step === 'a')?.compensatedAt).toBeUndefined()
    expect(records.find(record => record.step === 'b')?.status).toBe('compensated')
    expect((await runtime.stats()).lastError).toContain('undo-a failed')
  })

  it('给定正在执行的步骤当 cancel 则中断、run cancelled、只补偿已完成步骤且不再重试', async () => {
    const runtime = runtimeOf()
    const undo: string[] = []
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    runtime.register(definition([
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
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'cancel-run' })
    runtime.start()
    try {
      await enteredPromise
      const result = await runtime.cancel(runId)
      expect(result).toMatchObject({ cancelled: true, compensated: 1, compensationErrors: 0 })
      expect(undo).toEqual(['a'])
      const row = await runRow(runId)
      expect(row).toMatchObject({ status: 'cancelled', step: 'b' })
      const records = await store.steps(runId)
      expect(records.find(record => record.step === 'a')?.status).toBe('compensated')
      expect(records.find(record => record.step === 'b')).toMatchObject({ status: 'failed', error: 'cancelled by caller' })

      expect(await runtime.drain()).toMatchObject({ claimed: 0 })
      expect((await runRow(runId)).status).toBe('cancelled')
    } finally {
      await runtime.stop()
    }
  })

  it('给定 running 且租约过期当 recover 则回 pending 并从当前 step 继续，不重跑已完成步骤', async () => {
    const runtime = runtimeOf()
    const calls: string[] = []
    runtime.register(definition([
      {
        name: 'a',
        run: async () => {
          calls.push('a')
          return { state: { a: 1 } }
        },
      },
      {
        name: 'b',
        run: async (state, ctx) => {
          calls.push('b')
          await effect(ctx.commandId)
          return { state: { ...(state as object), b: 1 } }
        },
      },
      {
        name: 'c',
        run: async state => {
          calls.push('c')
          return { state: { ...(state as object), c: 1 } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'resume-run' })

    // 模拟一个 worker：claim 后只执行了 a 的 checkpoint 就被杀，run 留在 running。
    const claimed = await store.claimDue({ limit: 1, leaseMs: 30_000 })
    expect(claimed.map(run => run.id)).toEqual([runId])
    await store.beginStep({ runId, step: 'a', attempt: 1, input: { n: 0 } })
    expect(await store.completeStep({
      runId,
      step: 'a',
      attempt: 1,
      state: { a: 1 },
      nextStep: 'b',
      output: { state: { a: 1 }, next: 'b' },
    })).toBe(true)
    expect(await runRow(runId)).toMatchObject({ status: 'running', step: 'b' })
    await makeDue(runId)

    const report = await runtime.recover()
    expect(report).toMatchObject({ recovered: 1, due: 1 })
    expect((await runRow(runId)).status).toBe('pending')
    expect(await runtime.drain()).toMatchObject({ claimed: 1, steps: 2, completed: 1 })
    expect(calls).toEqual(['b', 'c'])
    expect(await runRow(runId)).toMatchObject({ status: 'completed', state: { a: 1, b: 1, c: 1 }, attempts: 2 })
    expect((await store.steps(runId)).map(record => `${record.step}:${record.attempt}:${record.status}`)).toEqual([
      'a:1:completed',
      'b:2:completed',
      'c:2:completed',
    ])
  })

  it('给定 checkpoint 已存在但 run 未推进当 claim 则落 dead 而不是重复执行', async () => {
    const runtime = runtimeOf()
    let calls = 0
    runtime.register(definition([
      {
        name: 'a',
        run: async () => {
          calls += 1
          return { state: {} }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'inconsistent' })
    // 下一次 claim 的 attempt 是 1；预置同一 (run, step, attempt) 的 completed 行模拟不一致。
    await db.query(
      `insert into omb.workflow_step (run_id, step, attempt, status, input, output, finished_at)
       values ($1, 'a', 1, 'completed', '{}'::jsonb, '{"state":{},"next":null}'::jsonb, now())`,
      [runId],
    )
    const summary = await runtime.drain()
    expect(summary).toMatchObject({ dead: 1, steps: 0 })
    expect(calls).toBe(0)
    const row = await runRow(runId)
    expect(row.status).toBe('dead')
    expect(row.last_error).toContain('checkpoint 不一致')
  })

  it('给定未知 step 的 run 当执行则 dead 且不执行任何 step', async () => {
    const runtime = runtimeOf()
    let calls = 0
    runtime.register(definition([
      {
        name: 'a',
        run: async () => {
          calls += 1
          return { state: {} }
        },
      },
    ]))
    const started = await store.start({
      id: 'run-ghost-step',
      name: 'probe',
      version: 1,
      state: {},
      step: 'ghost',
      idempotencyKey: 'ghost-step',
    })
    const summary = await runtime.drain()
    expect(summary).toMatchObject({ dead: 1, steps: 0 })
    expect(calls).toBe(0)
    expect(await runRow(started.runId)).toMatchObject({ status: 'dead' })
  })

  it('给定 dead run 当 retry 则回到 pending 并可执行完成', async () => {
    const runtime = runtimeOf({ retry: { maxAttempts: 1, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 } })
    let fail = true
    runtime.register(definition([
      {
        name: 'a',
        run: async () => {
          if (fail) throw new Error('boom')
          return { state: { ok: true } }
        },
      },
    ]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'replay-run' })
    expect((await runtime.drain()).dead).toBe(1)
    expect((await runRow(runId)).status).toBe('dead')

    fail = false
    expect(await runtime.retry(runId)).toBe(true)
    expect((await runRow(runId)).status).toBe('pending')
    expect(await runtime.drain()).toMatchObject({ claimed: 1, steps: 1, completed: 1 })
    expect((await runRow(runId)).status).toBe('completed')
  })

  it('给定两个 runtime 并发 drain 6 个 run 当 SKIP LOCKED 则每个 run 只执行一次', async () => {
    const definitionOfProbe = definition([
      {
        name: 'a',
        run: async (_state, ctx) => {
          await effect(ctx.commandId)
          return { state: { done: true } }
        },
      },
    ])
    const secondDb = new PostgresDb({ connectionString: DATABASE_URL })
    const secondStore = new PostgresWorkflowStore(secondDb)
    const first = runtimeOf()
    const second = new WorkflowRuntime(
      { store: secondStore, clock },
      { batchSize: 10, leaseMs: 30_000, retry: { maxAttempts: 3, baseDelayMs: 1_000, factor: 2, maxDelayMs: 5_000 } },
    )
    try {
      first.register(definitionOfProbe)
      second.register(definitionOfProbe)
      const ids: string[] = []
      for (let index = 0; index < 6; index += 1) {
        const started = await first.startRun('probe', undefined, { idempotencyKey: `concurrent-${index}` })
        ids.push(started.runId)
      }
      const [left, right] = await Promise.all([first.drain(), second.drain()])
      expect(left.claimed + right.claimed).toBe(6)
      for (const id of ids) {
        expect((await runRow(id)).status).toBe('completed')
        expect(await effectCount(`${id}:a`)).toBe(1)
      }
    } finally {
      await secondDb.close()
    }
  })

  it('给定旧 worker 的 attempts 已被新 claim 覆盖当 completeStep 则 CAS 失败且 run 不推进', async () => {
    const runtime = runtimeOf()
    runtime.register(definition([{ name: 'a', run: async () => ({ state: {} }) }]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'cas-run' })
    expect(await store.claimDue({ limit: 1, leaseMs: 30_000 })).toHaveLength(1)
    await makeDue(runId)
    const second = await store.claimDue({ limit: 1, leaseMs: 30_000 })
    expect(second[0]).toMatchObject({ id: runId, attempts: 2 })

    await store.beginStep({ runId, step: 'a', attempt: 1, input: {} })
    await store.beginStep({ runId, step: 'a', attempt: 2, input: {} })
    expect(await store.completeStep({ runId, step: 'a', attempt: 1, state: { old: true }, nextStep: null, output: {} })).toBe(false)
    expect((await runRow(runId)).step).toBe('a')
    expect(await store.completeStep({ runId, step: 'a', attempt: 2, state: { new: true }, nextStep: null, output: {} })).toBe(true)
    expect(await runRow(runId)).toMatchObject({ status: 'completed', state: { new: true }, attempts: 2 })
  })

  it('给定同一 attempt 重复 failStep 当第二次已不是 running 则 CAS 失败', async () => {
    const runtime = runtimeOf()
    runtime.register(definition([{ name: 'a', run: async () => ({ state: {} }) }]))
    const { runId } = await runtime.startRun('probe', undefined, { idempotencyKey: 'fail-cas' })
    expect(await store.claimDue({ limit: 1, leaseMs: 30_000 })).toHaveLength(1)
    await store.beginStep({ runId, step: 'a', attempt: 1, input: {} })
    expect(await store.failStep({ runId, step: 'a', attempt: 1, error: 'boom' })).toEqual({ applied: true, failures: 1 })
    expect(await store.failStep({ runId, step: 'a', attempt: 1, error: 'boom' })).toEqual({ applied: false, failures: 0 })
    expect(await store.completeStep({ runId, step: 'a', attempt: 1, state: {}, nextStep: null, output: {} })).toBe(false)
  })

  it('给定大量历史 run 当 EXPLAIN claim SQL 则使用 workflow_run_due 部分索引而不是全表扫描', async () => {
    await db.query(`
      insert into omb.workflow_run
        (id, name, version, state, step, status, attempts, next_run_at, idempotency_key)
      select 'bulk-' || i, 'bulk', 1, '{}'::jsonb, null, 'completed', 0, null, 'bulk-key-' || i
        from generate_series(1, 3000) as i
    `)
    const runtime = runtimeOf()
    runtime.register(definition([{ name: 'a', run: async () => ({ state: {} }) }]))
    for (let index = 0; index < 5; index += 1) {
      await runtime.startRun('probe', undefined, { idempotencyKey: `explain-${index}` })
    }
    await db.query('analyze omb.workflow_run')

    const explained = await db.query<ExplainRow>(`explain (format json) ${WORKFLOW_CLAIM_SQL}`, [10, 30_000])
    const nodes = collectPlanNodes(explained.rows[0]?.['QUERY PLAN'])
    expect(nodes.some(node => node.index === 'workflow_run_due')).toBe(true)
    expect(nodes.some(node => node.node === 'Seq Scan' && node.relation === 'workflow_run')).toBe(false)
    expect(
      nodes
        .filter(node => node.relation === 'workflow_run' && node.node.includes('Scan'))
        .every(node => node.index !== undefined),
    ).toBe(true)

    expect(await store.claimDue({ limit: 10, leaseMs: 5_000 })).toHaveLength(5)
  })
})

describe('子进程在 step 中途被 SIGKILL 后重启恢复（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    db = new PostgresDb({ connectionString: DATABASE_URL })
    store = new PostgresWorkflowStore(db)
    timerStore = new PostgresTimerStore(db)
  })

  beforeEach(async () => {
    await reset()
  })

  afterAll(async () => {
    await db.close()
  })

  interface ChildResult {
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
    readonly stderr: string
  }

  function runChild(scriptPath: string, env: NodeJS.ProcessEnv): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      child.stderr?.on('data', chunk => {
        stderr += String(chunk)
      })
      // 子进程超时守卫：这是失败兜底，不是用睡眠当断言（test-sleep 已显式豁免）。
      // check:ignore-next-line test-sleep
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`子进程超时未退出：${stderr}`))
      }, CHILD_TIMEOUT_MS)
      timer.unref?.()
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stderr })
      })
    })
  }

  function childSource(): string {
    const dbUrl = new URL('../../../packages/v7/src/adapters/postgres/db.ts', import.meta.url).href
    const storeUrl = new URL('../../../packages/v7/src/adapters/postgres/workflow.ts', import.meta.url).href
    const runtimeUrl = new URL('../../../packages/v7/src/app/workflow/runtime.ts', import.meta.url).href
    return `
const load = async url => await import(url)
const { PostgresDb } = await load(${JSON.stringify(dbUrl)})
const { PostgresWorkflowStore } = await load(${JSON.stringify(storeUrl)})
const { WorkflowRuntime } = await load(${JSON.stringify(runtimeUrl)})
const db = new PostgresDb({ connectionString: process.env.WF_DATABASE_URL })
const store = new PostgresWorkflowStore(db)
const clock = { now: () => new Date(), iso: () => new Date().toISOString() }
// 短租约：进程被 SIGKILL 后很快到期，模拟“重启时租约已过期”的真实恢复路径。
const runtime = new WorkflowRuntime({ store, clock }, { batchSize: 10, leaseMs: 150 })
const effect = async commandId => {
  await db.query(
    "insert into omb.audit_log (actor, action, command_id) values ('test', 'workflow-step', $1) on conflict (command_id) where command_id is not null do nothing",
    [commandId],
  )
}
runtime.register({
  name: 'kill-probe',
  version: 1,
  initial: { step: 0 },
  steps: [
    { name: 'a', run: async (state, ctx) => { await effect(ctx.commandId); return { state: { a: 1 } } } },
    {
      name: 'b',
      run: async (state, ctx) => {
        await effect(ctx.commandId)
        process.kill(process.pid, 'SIGKILL')
        return { state: { b: 1 } }
      },
    },
  ],
})
await runtime.startRun('kill-probe', undefined, { idempotencyKey: process.env.WF_CHILD_KEY })
await runtime.drain()
`
  }

  it('给定子进程在 b 的副作用之后被 SIGKILL 当新 runtime recover 则 b 重放、a 不重跑、副作用按 commandId 幂等', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omb-workflow-child-'))
    try {
      const scriptPath = join(dir, 'child.mjs')
      writeFileSync(scriptPath, childSource(), 'utf8')
      const child = await runChild(scriptPath, { WF_DATABASE_URL: DATABASE_URL, WF_CHILD_KEY: 'kill-9-run' })
      // Windows 上 SIGKILL 以退出码体现；真正的证据在 DB：run 停在 b 且没有完成 checkpoint。
      expect(child.code !== 0 || child.signal !== null).toBe(true)

      const killed = await db.query<RunRow>(
        `select id, status, step, state, attempts, next_run_at, last_error
           from omb.workflow_run where idempotency_key = 'kill-9-run'`,
      )
      const run = killed.rows[0]
      expect(run).toBeDefined()
      if (run === undefined) throw new Error('子进程没有留下 run')
      expect(run).toMatchObject({ status: 'running', step: 'b' })
      const killedSteps = await store.steps(run.id)
      expect(killedSteps.map(record => `${record.step}:${record.attempt}:${record.status}`)).toEqual([
        'a:1:completed',
        'b:1:running',
      ])
      expect(killedSteps[1]?.finishedAt).toBeUndefined()
      expect(await effectCount(`${run.id}:a`)).toBe(1)
      expect(await effectCount(`${run.id}:b`)).toBe(1)

      // 等 claim 租约到期（真实 kill 后重启时同样要等租约过期），再启动新 runtime。
      await waitFor(async () => {
        const current = await runRow(run.id)
        return current.next_run_at !== null && current.next_run_at.getTime() <= Date.now()
      }, 10_000)

      // 新进程（本测试进程）启动 runtime：recover → 从 b 继续；a 不再执行，b 的副作用不重复。
      const runtime = runtimeOf()
      runtime.register(definition([
        {
          name: 'a',
          run: async (_state, ctx) => {
            await effect(ctx.commandId)
            return { state: { a: 1 } }
          },
        },
        {
          name: 'b',
          run: async (_state, ctx) => {
            await effect(ctx.commandId)
            return { state: { a: 1, b: 1 } }
          },
        },
      ], { name: 'kill-probe' }))
      const report = await runtime.recover()
      expect(report).toMatchObject({ recovered: 1, due: 1 })
      expect(await runtime.drain()).toMatchObject({ claimed: 1, steps: 1, completed: 1 })

      expect(await runRow(run.id)).toMatchObject({ status: 'completed', state: { a: 1, b: 1 }, attempts: 2 })
      const steps = await store.steps(run.id)
      expect(steps.map(record => `${record.step}:${record.attempt}:${record.status}`)).toEqual([
        'a:1:completed',
        'b:1:running',
        'b:2:completed',
      ])
      expect(steps.filter(record => record.step === 'a')).toHaveLength(1)
      expect(await effectCount(`${run.id}:a`)).toBe(1)
      expect(await effectCount(`${run.id}:b`)).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TimerStore/TimerWorker（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    db = new PostgresDb({ connectionString: DATABASE_URL })
    store = new PostgresWorkflowStore(db)
    timerStore = new PostgresTimerStore(db)
  })

  beforeEach(async () => {
    await reset()
  })

  afterAll(async () => {
    await db.close()
  })

  async function timerRows(): Promise<Array<{ id: number; topic: string; status: string; attempts: number; due_at: Date; payload: JsonValue; dedupe_key: string | null }>> {
    const result = await db.query<{
      id: number
      topic: string
      status: string
      attempts: number
      due_at: Date
      payload: JsonValue
      dedupe_key: string | null
    }>('select id::int as id, topic, status, attempts, due_at, payload, dedupe_key from omb.timer order by id')
    return result.rows
  }

  it('给定同一 dedupeKey 两次 schedule 当查询则只有一行且是重排期', async () => {
    const first = await timerStore.schedule({
      topic: 'decay',
      payload: { n: 1 },
      dueAt: new Date(Date.now() + 60_000),
      dedupeKey: 'decay:e1',
    })
    const second = await timerStore.schedule({
      topic: 'decay',
      payload: { n: 2 },
      dueAt: new Date(Date.now() + 1_000),
      dedupeKey: 'decay:e1',
    })
    expect(first.inserted).toBe(true)
    expect(second).toMatchObject({ id: first.id, inserted: false })
    const rows = await timerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: first.id, status: 'pending', attempts: 0, payload: { n: 2 }, dedupe_key: 'decay:e1' })
    expect(Math.abs((rows[0]?.due_at.getTime() ?? 0) - Date.parse(second.dueAt))).toBeLessThan(5_000)
  })

  it('给定 schedule 提交当 LISTEN 的 NOTIFY 送达则唤醒', async () => {
    const notifier = new PostgresTimerNotifier({ connectionString: DATABASE_URL })
    let received = 0
    const unsubscribe = notifier.subscribe(() => {
      received += 1
    })
    try {
      await notifier.ready()
      await timerStore.schedule({ topic: 'probe', payload: {}, dueAt: new Date(Date.now() + 60_000) })
      await waitFor(() => received > 0)
      expect(received).toBeGreaterThan(0)
    } finally {
      unsubscribe()
      await notifier.close()
    }
  })

  it('给定一个到期一个未到期当 claimDue 则只领取到期的', async () => {
    const due = await timerStore.schedule({ topic: 'probe', payload: { due: true }, dueAt: new Date(Date.now() - 1_000) })
    const future = await timerStore.schedule({ topic: 'probe', payload: { due: false }, dueAt: new Date(Date.now() + 60_000) })
    const claimed = await timerStore.claimDue({ limit: 10, leaseMs: 5_000 })
    expect(claimed.map(task => task.id)).toEqual([due.id])
    expect(claimed[0]).toMatchObject({ topic: 'probe', attempts: 0, payload: { due: true } })
    expect(await timerStore.complete(due.id, 0)).toBe(true)
    expect(await timerStore.claimDue({ limit: 10, leaseMs: 5_000 })).toHaveLength(0)
    expect((await timerRows()).find(row => row.id === future.id)?.status).toBe('pending')
  })

  it('给定 6 个到期 timer 当 8 个 worker 并发 claim 则每条只被领取一次', async () => {
    for (let index = 0; index < 6; index += 1) {
      await timerStore.schedule({ topic: 'probe', payload: { index }, dueAt: new Date(Date.now() - 1_000) })
    }
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => timerStore.claimDue({ limit: 2, leaseMs: 5_000 })),
    )
    const ids = claims.flat().map(task => task.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
    const claimed = await db.query<{ count: number }>("select count(*)::int as count from omb.timer where status = 'claimed'")
    expect(claimed.rows[0]?.count).toBe(6)
  })

  it('给定已 claim 当 release 则归还并可重新领取', async () => {
    const scheduled = await timerStore.schedule({ topic: 'probe', payload: {}, dueAt: new Date(Date.now() - 1_000) })
    expect(await timerStore.claimDue({ limit: 1, leaseMs: 5_000 })).toHaveLength(1)
    expect(await timerStore.release(scheduled.id, 0)).toBe(true)
    const reclaimed = await timerStore.claimDue({ limit: 1, leaseMs: 5_000 })
    expect(reclaimed.map(task => task.id)).toEqual([scheduled.id])
    expect(await timerStore.complete(scheduled.id, 0)).toBe(true)
    expect(await timerStore.complete(scheduled.id, 0)).toBe(false)
  })

  it('给定 handler 成功当 tick 则 done；重复 tick 不再领取', async () => {
    const fired: number[] = []
    const worker = timerWorkerOf([{ topic: 'probe', run: async task => { fired.push(task.id) } }])
    const first = await timerStore.schedule({ topic: 'probe', payload: {}, dueAt: new Date(Date.now() - 1_000) })
    const second = await timerStore.schedule({ topic: 'probe', payload: {}, dueAt: new Date(Date.now() - 1_000) })
    expect(await worker.tick()).toMatchObject({ claimed: 2, fired: 2 })
    expect(fired.sort((left, right) => left - right)).toEqual([first.id, second.id].sort((left, right) => left - right))
    expect((await timerRows()).every(row => row.status === 'done')).toBe(true)
    expect(await worker.tick()).toMatchObject({ claimed: 0 })
    expect(await timerStore.stats()).toMatchObject({ pending: 0, claimed: 0, done: 2 })
  })

  it('给定 handler 抛错当重试到上限则进死信', async () => {
    let calls = 0
    const worker = timerWorkerOf([{ topic: 'flaky', run: async () => { calls += 1; throw new Error('boom') } }])
    const scheduled = await timerStore.schedule({ topic: 'flaky', payload: {}, dueAt: new Date(Date.now() - 1_000) })
    expect(await worker.tick()).toMatchObject({ claimed: 1, retried: 1, dead: 0 })
    expect((await timerRows())[0]).toMatchObject({ status: 'pending', attempts: 1 })
    await db.query('update omb.timer set due_at = now() - interval \'1 second\' where id = $1', [scheduled.id])
    expect(await worker.tick()).toMatchObject({ claimed: 1, dead: 1, retried: 0 })
    const row = (await timerRows())[0]
    expect(row).toMatchObject({ status: 'dead', attempts: 2 })
    expect(row).toBeDefined()
    expect(calls).toBe(2)
    expect((await worker.stats()).lastError).toContain('boom')
  })

  it('给定未注册 topic 当 tick 则进死信且错误里带 topic', async () => {
    const worker = timerWorkerOf([{ topic: 'known', run: async () => {} }])
    await timerStore.schedule({ topic: 'missing', payload: {}, dueAt: new Date(Date.now() - 1_000) })
    expect(await worker.tick()).toMatchObject({ claimed: 1, dead: 1 })
    const row = await db.query<{ last_error: string | null }>('select last_error from omb.timer')
    expect(row.rows[0]?.last_error).toContain('missing')
  })

  it('给定 timer 被取消当 tick 则不派发', async () => {
    const fired: number[] = []
    const worker = timerWorkerOf([{ topic: 'probe', run: async task => { fired.push(task.id) } }])
    const scheduled = await timerStore.schedule({ topic: 'probe', payload: {}, dueAt: new Date(Date.now() - 1_000), dedupeKey: 'cancel-me' })
    expect(await timerStore.cancel({ dedupeKey: 'cancel-me' })).toBe(true)
    expect(await worker.tick()).toMatchObject({ claimed: 0 })
    expect(fired).toEqual([])
    expect((await timerRows()).find(row => row.id === scheduled.id)?.status).toBe('cancelled')
  })

  it('给定空闲 worker 且无 NOTIFY 当 timer 到期时 worker 自行唤醒执行', async () => {
    const fired: number[] = []
    const worker = timerWorkerOf([{ topic: 'raw', run: async task => { fired.push(task.id) } }])
    // 直接插表、不发 NOTIFY：只能靠 worker 自己 arm 到 due_at 的定时器唤醒。
    const inserted = await db.query<{ id: number }>(
      `insert into omb.timer (topic, payload, due_at)
       values ('raw', '{}'::jsonb, now() + interval '150 milliseconds')
       returning id::int as id`,
    )
    const id = inserted.rows[0]?.id
    worker.start()
    try {
      await waitFor(() => fired.length === 1, 10_000)
      expect(fired).toEqual([id])
      expect((await timerRows()).find(row => row.id === id)?.status).toBe('done')
      await worker.whenIdle()
    } finally {
      await worker.stop()
    }
  })

  it('给定空闲 worker 当 schedule 的 NOTIFY 送达则立即派发', async () => {
    const notifier = new PostgresTimerNotifier({ connectionString: DATABASE_URL })
    const fired: number[] = []
    const worker = timerWorkerOf([{ topic: 'probe', run: async task => { fired.push(task.id) } }], notifier)
    try {
      await notifier.ready()
      worker.start()
      await worker.whenIdle()
      const scheduled = await timerStore.schedule({ topic: 'probe', payload: {}, dueAt: new Date(Date.now() - 1_000) })
      await waitFor(() => fired.length === 1)
      expect(fired).toEqual([scheduled.id])
    } finally {
      await worker.stop()
      await notifier.close()
    }
  })

  it('给定大量历史 timer 当 EXPLAIN claim SQL 则使用 timer_due 部分索引而不是全表扫描', async () => {
    await db.query(`
      insert into omb.timer (topic, payload, due_at, status)
      select 'bulk', '{}'::jsonb, now(), 'done' from generate_series(1, 3000)
    `)
    for (let index = 0; index < 5; index += 1) {
      await timerStore.schedule({ topic: 'probe', payload: { index }, dueAt: new Date(Date.now() - 1_000) })
    }
    await db.query('analyze omb.timer')

    const explained = await db.query<ExplainRow>(`explain (format json) ${TIMER_CLAIM_SQL}`, [25, 30_000])
    const nodes = collectPlanNodes(explained.rows[0]?.['QUERY PLAN'])
    expect(nodes.some(node => node.index === 'timer_due')).toBe(true)
    expect(nodes.some(node => node.node === 'Seq Scan' && node.relation === 'timer')).toBe(false)
    expect(
      nodes
        .filter(node => node.relation === 'timer' && node.node.includes('Scan'))
        .every(node => node.index !== undefined),
    ).toBe(true)

    expect(await timerStore.claimDue({ limit: 25, leaseMs: 5_000 })).toHaveLength(5)
  })
})

/** 适配器实现 app 端口的编译期自检（不建连接池、不产生运行时副作用）。 */
type StoreImplementsPort = PostgresWorkflowStore extends WorkflowStore ? true : never
type TimerImplementsPort = PostgresTimerStore extends TimerStore ? true : never
const _storePortCheck: StoreImplementsPort = true
const _timerPortCheck: TimerImplementsPort = true
void _storePortCheck
void _timerPortCheck
