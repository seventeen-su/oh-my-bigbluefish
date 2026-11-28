import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../../../plugin/v7/index.js'
import type { HostContextLike, HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { PgBossQueue } from '../../../packages/v7/src/adapters/pg-boss/index.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { PostgresTimerStore } from '../../../packages/v7/src/adapters/postgres/timer.js'
import { TimerWorker } from '../../../packages/v7/src/app/workflow/index.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { attributeValue } from '../../../packages/v7/src/domain/entity-access.js'
import { createConsolidationScheduler } from '../../../packages/v7/src/jobs/index.js'
import type { JobQueue } from '../../../packages/v7/src/ports/jobs.js'
import { databaseNameOf, isDisposableDatabaseName } from '../../../packages/v7/src/security/trust.js'
import { derived, normalized } from './helpers.js'

/**
 * Phase 3 Task 16a：巩固任务从“10 分钟 setInterval 全表 loop”迁到 durable timer。
 *
 * 使用独立库 `omb_v7_test_schedule`（env 可覆盖），不碰 omb_v7_test / 生产库。
 * 所有等待都是有上界的条件轮询：断言依赖状态变化，不用固定 sleep 当同步。
 *
 * 期望值独立写死（任务名/周期/topic 是契约），不从被测实现推导。
 */
const DATABASE_URL = process.env.OMB_SCHEDULE_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_schedule'
const PROJECT = process.cwd()
const CONSOLIDATION_JOB_NAMES = [
  'omb.extract',
  'omb.reference-rot',
  'omb.clue-promote',
  'omb.dedupe',
  'omb.conflict',
  'omb.link-suggest',
  'omb.forget',
  'omb.attr-alias',
  'omb.refresh',
  'omb.embed-sweep',
] as const
const CONSOLIDATION_TIMER_TOPIC = 'omb.consolidation'
const CONSOLIDATION_TRIGGER = 'omb.consolidation'
const CONSOLIDATION_INTERVAL_MS = 10 * 60 * 1000
const consolidationDedupeKeys = CONSOLIDATION_JOB_NAMES.map(job => `consolidation:${job}`)

// 显式声明破坏性用途：只有库名命中 test/bench 段才设置；truncateAll 在连接前仍会拒绝生产库。
const scheduleDatabaseName = databaseNameOf(DATABASE_URL)
if (scheduleDatabaseName !== undefined && isDisposableDatabaseName(scheduleDatabaseName)) {
  process.env.OMB_ALLOW_DESTRUCTIVE ??= '1'
}

interface FakeHost {
  ctx: HostContextLike
  readonly tools: Map<string, HostToolDefinition>
  readonly listeners: Map<string, (...args: unknown[]) => unknown>
  readonly logs: string[]
  provider: ((input: unknown) => string) | undefined
}

function fakeHost(): FakeHost {
  const tools = new Map<string, HostToolDefinition>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const logs: string[] = []
  const push = (level: string, message: unknown): void => {
    logs.push(`${level} ${typeof message === 'string' ? message : JSON.stringify(message)}`)
  }
  const host: FakeHost = { ctx: undefined as unknown as HostContextLike, tools, listeners, logs, provider: undefined }
  const ctx = {
    get: (name: string) => {
      if (name === 'tools') {
        return {
          register: (definition: HostToolDefinition) => {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
          get: (toolName: string) => tools.get(toolName),
        }
      }
      if (name === 'systemPrompt') {
        return {
          getContextOrder: () => 200,
          getSectionOrder: () => 500,
          section: () => () => {},
          context: (arg: unknown) => {
            const record = arg as { name?: string; text?: (input: unknown) => string }
            // 现在有 T0 与检查点两条 context；host.provider 只代表 T0。
            if (record.name === 'omb-v7:injection' && typeof record.text === 'function') host.provider = record.text
            return () => {}
          },
        }
      }
      return undefined
    },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    logger: {
      warn: (message: unknown) => push('warn', message),
      error: (message: unknown) => push('error', message),
      info: (message: unknown) => push('info', message),
      debug: () => {},
    },
  }
  host.ctx = ctx as unknown as HostContextLike
  return host
}

/** 有上界的条件等待；25ms 是重试间隔，不是用睡眠当同步/断言。 */
async function waitFor<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise<void>(resolve => {
      // 有上界的条件轮询：25ms 只是重试间隔，不是用睡眠当同步/断言。
      // check:ignore-next-line test-sleep
      setTimeout(resolve, 25)
    })
  }
}

interface RunningPlugin {
  readonly host: FakeHost
  dispose(): void
  stop(): Promise<void>
}

function startPlugin(): RunningPlugin {
  const host = fakeHost()
  const dispose = apply(host.ctx, {
    databaseUrl: DATABASE_URL,
    autoMigrate: true,
    jobs: true,
    residentBudget: 300,
  })
  let stopped = false
  return {
    host,
    dispose,
    async stop() {
      if (stopped) return
      stopped = true
      dispose()
      await waitFor(
        async () => (host.logs.some(line => line.includes('teardown 收尾完成')) ? true : undefined),
        'plugin teardown 收尾',
      )
    },
  }
}

async function statusText(plugin: RunningPlugin): Promise<string> {
  const result = await plugin.host.tools.get('omb_status')?.execute({}, {
    agent: { session: { id: 'consolidation-schedule-session', header: { cwd: PROJECT } } },
  })
  if (result === undefined || !result.ok) throw new Error(`omb_status 失败：${result?.text ?? '没有注册 omb_status'}`)
  return result.text
}

function metric(text: string, name: string): number {
  const match = new RegExp(`${name}=(\\d+)`).exec(text)
  if (match?.[1] === undefined) throw new Error(`status 缺少字段 ${name}：\n${text}`)
  return Number(match[1])
}

interface TimerRow {
  readonly id: string
  readonly topic: string
  readonly payload: { readonly job?: string }
  readonly due_at: Date
  readonly status: string
  readonly dedupe_key: string
}

function testClock() {
  return { now: () => new Date(), iso: () => new Date().toISOString() }
}

/** 只用于排期类用例的队列替身：这些用例不触发 handler。 */
function stubQueue(): JobQueue {
  return {
    start: async () => {},
    stop: async () => {},
    enqueue: async () => null,
    work: async () => {},
    handlerFailures: () => ({ count: 0, recent: [] }),
    finalFailures: async () => ({ count: 0, recent: [] }),
  }
}

type ConsolidationScheduler = ReturnType<typeof createConsolidationScheduler>

/** 只记录“到期该入队哪个任务”的队列替身：workflow 用例断言 forget 不入队。 */
function recordingQueue(enqueued: string[]): JobQueue {
  return {
    ...stubQueue(),
    enqueue: async (name: string) => {
      enqueued.push(name)
      return null
    },
  }
}

/** 与 plugin 组合根同形的调度器：真实 timer 适配器 + 真实/替身队列。 */
function schedulerFor(queue: JobQueue = stubQueue(), workflow?: Parameters<typeof createConsolidationScheduler>[0]['workflow']): ConsolidationScheduler {
  const timers = new PostgresTimerStore(db.db)
  return createConsolidationScheduler({
    timers: {
      schedule: input => timers.schedule(input),
      async armed(keys) {
        if (keys.length === 0) return new Set<string>()
        const rows = await db.db.query<{ dedupe_key: string }>(
          `select distinct dedupe_key
             from omb.timer
            where dedupe_key = any($1::text[]) and status in ('pending', 'claimed')`,
          [keys],
        )
        return new Set(rows.rows.map(row => row.dedupe_key))
      },
    },
    queue,
    clock: testClock(),
    ...(workflow === undefined ? {} : { workflow }),
  })
}

async function consolidationTimerRows(): Promise<TimerRow[]> {
  const rows = await db.db.query<TimerRow>(
    `select id::text as id, topic, payload, due_at, status, dedupe_key
       from omb.timer
      where dedupe_key like 'consolidation:%'
      order by dedupe_key`,
  )
  return rows.rows
}

function consolidationTimerRow(rows: readonly TimerRow[], dedupeKey: string): TimerRow {
  const row = rows.find(item => item.dedupe_key === dedupeKey)
  if (row === undefined) throw new Error(`没有 timer 行：${dedupeKey}`)
  return row
}

/**
 * 全部任务都完成过一轮、并且 rearm 到下一个网格点（due 在明显未来）。
 *
 * 只数 `pending` 不够：启动首轮的立即到期行同样是 pending，会把“还没跑”误判成“已续期”。
 */
async function fullyArmedRows(): Promise<TimerRow[] | undefined> {
  const rows = await consolidationTimerRows()
  const threshold = Date.now() + 1_000
  const armed = rows.length === CONSOLIDATION_JOB_NAMES.length
    && rows.every(row => row.status === 'pending' && new Date(row.due_at).getTime() > threshold)
  return armed ? rows : undefined
}

function timerJobCount(rows: readonly { count: string }[]): number {
  return rows.reduce((sum, row) => sum + Number(row.count), 0)
}

async function writeEntity(input: WriteEntityInput): Promise<string> {
  const written = await db.write(normalized(input), derived(input))
  return written.entity.id
}

let db: PostgresStore

async function resetDatabase(): Promise<void> {
  await truncateAll(DATABASE_URL)
  await db.db.query(`
    truncate table omb.workflow_step, omb.workflow_run, omb.timer, omb.outbox,
                    omb.projection_watermark, omb.projection_task,
                    omb.preference_board, omb.state_board, omb.adoption_stat,
                    omb.co_recall_pair, omb.similar_cache
    restart identity cascade
  `)
  const boss = await db.db.query<{ present: boolean }>("select to_regclass('pgboss.job') is not null as present")
  if (boss.rows[0]?.present === true) {
    // 上一个用例的 pg-boss 行会占用 singletonKey：新用例必须从空队列开始。
    await db.db.query("delete from pgboss.job where name like 'omb.%'")
  }
}

beforeAll(async () => {
  await migrateDatabase(DATABASE_URL)
  db = new PostgresStore(DATABASE_URL)
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await resetDatabase().catch(() => {})
  await db.close()
})

describe('巩固任务的 durable schedule（真实 PostgreSQL）', () => {
  it('给定首次启动当 ensure 则为每个任务补一条 pending timer，且载荷是任务名', async () => {
    const scheduler = schedulerFor()
    expect(scheduler.schedules.map(schedule => schedule.job)).toEqual([...CONSOLIDATION_JOB_NAMES])
    expect(scheduler.schedules.map(schedule => schedule.dedupeKey)).toEqual(consolidationDedupeKeys)
    expect(scheduler.schedules.every(schedule => schedule.intervalMs === CONSOLIDATION_INTERVAL_MS)).toBe(true)

    const ensured = await scheduler.ensure()

    expect(ensured.scheduled).toEqual([...CONSOLIDATION_JOB_NAMES])
    expect(ensured.armed).toBe(0)
    const rows = await consolidationTimerRows()
    expect(rows).toHaveLength(CONSOLIDATION_JOB_NAMES.length)
    expect(rows.map(row => row.dedupe_key)).toEqual([...consolidationDedupeKeys].sort())
    for (const row of rows) {
      expect(row.status).toBe('pending')
      expect(row.topic).toBe(CONSOLIDATION_TIMER_TOPIC)
      expect(CONSOLIDATION_JOB_NAMES).toContain(row.payload.job)
    }
  })

  it('给定同一进程重复 ensure 当已有 armed 行则幂等：不插新行、不改 due_at', async () => {
    const scheduler = schedulerFor()
    await scheduler.ensure()
    const before = await consolidationTimerRows()

    // 模拟重启后在网格内再次启动：同样的 10 个任务已经 armed。
    const again = await scheduler.ensure()

    expect(again.scheduled).toHaveLength(0)
    expect(again.armed).toBe(CONSOLIDATION_JOB_NAMES.length)
    const after = await consolidationTimerRows()
    expect(after).toHaveLength(CONSOLIDATION_JOB_NAMES.length)
    for (const dedupeKey of consolidationDedupeKeys) {
      const previous = consolidationTimerRow(before, dedupeKey)
      const current = consolidationTimerRow(after, dedupeKey)
      // 幂等的判据：同一行（id 不变）且到期时间原样保留（不往后推、不提前）。
      expect(current.id).toBe(previous.id)
      expect(new Date(current.due_at).toISOString()).toBe(new Date(previous.due_at).toISOString())
    }
  })

  it('给定任务执行完当 rearm 则同一行排到下一网格，行数恒为任务数', async () => {
    const scheduler = schedulerFor()
    await scheduler.ensure()
    const before = await consolidationTimerRows()
    const forgetKey = `consolidation:omb.forget`
    const now = Date.now()

    await scheduler.rearm('omb.forget')

    const after = await consolidationTimerRows()
    expect(after).toHaveLength(CONSOLIDATION_JOB_NAMES.length)
    const row = consolidationTimerRow(after, forgetKey)
    expect(row.id).toBe(consolidationTimerRow(before, forgetKey).id)
    expect(row.status).toBe('pending')
    const dueAt = new Date(row.due_at).getTime()
    // 下一期是严格未来的网格点，且在 (now, now + interval] 内。
    expect(dueAt).toBeGreaterThan(now)
    expect(dueAt - now).toBeLessThanOrEqual(CONSOLIDATION_INTERVAL_MS)
    expect(dueAt % CONSOLIDATION_INTERVAL_MS).toBe(0)

    // 重复 rearm 幂等：同一期网格内再排一次不改行 id / due_at，也不新增行
    // （workflow step 重试/恢复都会再调一次 rearm）。
    await scheduler.rearm('omb.forget')
    const repeated = await consolidationTimerRows()
    expect(repeated).toHaveLength(CONSOLIDATION_JOB_NAMES.length)
    expect(consolidationTimerRow(repeated, forgetKey).id).toBe(row.id)
    expect(new Date(consolidationTimerRow(repeated, forgetKey).due_at).toISOString()).toBe(new Date(row.due_at).toISOString())
  })

  it('给定 timer 被取消当再次 ensure 则只补那一条，其余行不动', async () => {
    const scheduler = schedulerFor()
    await scheduler.ensure()
    const before = await consolidationTimerRows()
    const forgetKey = `consolidation:omb.forget`
    const timers = new PostgresTimerStore(db.db)
    expect(await timers.cancel({ dedupeKey: forgetKey })).toBe(true)

    const repaired = await scheduler.ensure()

    expect(repaired.scheduled).toEqual(['omb.forget'])
    const after = await consolidationTimerRows()
    expect(consolidationTimerRow(after, forgetKey).status).toBe('pending')
    for (const dedupeKey of consolidationDedupeKeys) {
      if (dedupeKey === forgetKey) continue
      expect(consolidationTimerRow(after, dedupeKey).id).toBe(consolidationTimerRow(before, dedupeKey).id)
    }
  })

  it('给定到期 timer 当 TimerWorker 派发则只入队一次且第二次 drain 不再入队', async () => {
    const clock = testClock()
    const queue = new PgBossQueue({ connectionString: DATABASE_URL })
    const scheduler = schedulerFor(queue)
    const worker = new TimerWorker(
      { store: new PostgresTimerStore(db.db), handlers: [scheduler.timerHandler], clock },
      { batchSize: 25, leaseMs: 30_000 },
    )
    const timers = new PostgresTimerStore(db.db)
    const schedule = scheduler.schedules.find(item => item.job === 'omb.dedupe')
    if (schedule === undefined) throw new Error('缺少 omb.dedupe 调度')
    const scheduled = await timers.schedule({
      topic: CONSOLIDATION_TIMER_TOPIC,
      payload: { job: 'omb.dedupe' },
      dueAt: new Date(Date.now() - 1_000),
      dedupeKey: schedule.dedupeKey,
    })
    worker.start()
    try {
      await waitFor(
        async () => {
          const rows = await db.db.query<{ status: string }>('select status from omb.timer where id = $1', [scheduled.id])
          return rows.rows[0]?.status === 'done' ? true : undefined
        },
        'timer 到期后被 worker 执行',
        10_000,
      )
      const jobs = await db.db.query<{ name: string; singleton_key: string | null; data: { trigger?: string; job?: string } }>(
        "select name, singleton_key, data from pgboss.job where name = 'omb.dedupe'",
      )
      expect(jobs.rows).toHaveLength(1)
      // singletonKey 是 "<job>:<期号>"：同一期内的重复投递由 pg-boss 合并。
      const singletonKey = jobs.rows[0]?.singleton_key ?? ''
      expect(singletonKey).toMatch(/^omb\.dedupe:\d+$/)
      const bucket = Number(singletonKey.slice('omb.dedupe:'.length))
      expect(Math.abs(bucket - Math.floor(Date.now() / CONSOLIDATION_INTERVAL_MS))).toBeLessThanOrEqual(1)
      // 载荷带调度触发标记：只有它执行完才续期，事件 reaction 的提前触发不会移动 schedule。
      expect(jobs.rows[0]?.data).toMatchObject({ trigger: CONSOLIDATION_TRIGGER, job: 'omb.dedupe' })
      // timer 行已经 done：再来一轮不该重复入队（没有第二行 timer 可领）。
      await worker.drain(2)
      const again = await db.db.query<{ count: string }>("select count(*)::text as count from pgboss.job where name = 'omb.dedupe'")
      expect(timerJobCount(again.rows)).toBe(1)
    } finally {
      await worker.stop()
      await queue.stop()
    }
  })

  it('给定非法载荷当 timer handler 运行则抛错走 timer 重试，不静默空转', async () => {
    const clock = testClock()
    const queue = new PgBossQueue({ connectionString: DATABASE_URL })
    try {
      const scheduler = schedulerFor(queue)
      await expect(scheduler.timerHandler.run(
        { id: 1, topic: CONSOLIDATION_TIMER_TOPIC, payload: {}, dueAt: clock.iso(), attempts: 0 },
        {
          timerId: 1,
          topic: CONSOLIDATION_TIMER_TOPIC,
          attempt: 1,
          commandId: 'timer:probe',
          now: clock.now(),
          signal: new AbortController().signal,
        },
      )).rejects.toThrow('载荷非法')
    } finally {
      await queue.stop()
    }
  })

  it('给定 forget 配置了 workflow dispatch 当 timer 到期则按「期」start 一次且不入队 pg-boss', async () => {
    const enqueued: string[] = []
    const starts: Array<{ readonly name: string; readonly key: string }> = []
    const scheduler = schedulerFor(recordingQueue(enqueued), {
      job: 'omb.forget',
      workflow: 'forget',
      start: async (name, idempotencyKey) => {
        starts.push({ name, key: idempotencyKey })
      },
    })
    const schedule = scheduler.schedules.find(item => item.job === 'omb.forget')
    if (schedule === undefined) throw new Error('缺少 omb.forget 调度')
    const timers = new PostgresTimerStore(db.db)
    // 排期时就把期号写进载荷：重试同一条 timer 不会换幂等键。
    const dueAt = new Date(Date.now() - 1_000)
    const period = Math.floor(dueAt.getTime() / CONSOLIDATION_INTERVAL_MS)
    await timers.schedule({
      topic: CONSOLIDATION_TIMER_TOPIC,
      payload: { job: 'omb.forget', period },
      dueAt,
      dedupeKey: schedule.dedupeKey,
    })
    const worker = new TimerWorker(
      { store: timers, handlers: [scheduler.timerHandler], clock: testClock() },
      { batchSize: 5, leaseMs: 5_000 },
    )

    expect(await worker.tick()).toMatchObject({ claimed: 1, fired: 1, dead: 0, lost: 0 })
    expect(starts).toEqual([{ name: 'forget', key: `consolidation:omb.forget:${period}` }])
    // 不得双跑：workflow 路径下同一个 timer 不再入队 pg-boss。
    expect(enqueued).toEqual([])
    // handler 不碰 timer 行（重排期会让 complete CAS 失败）：派发器正常 complete 成 done，
    // 续期由 workflow step 的 rearm 负责。
    expect(consolidationTimerRow(await consolidationTimerRows(), schedule.dedupeKey).status).toBe('done')
  })

  it('给定旧载荷（无 period）当 timer 到期则按当前期兜底，不把到期 timer 打成死信', async () => {
    const starts: Array<{ readonly name: string; readonly key: string }> = []
    const scheduler = schedulerFor(stubQueue(), {
      job: 'omb.forget',
      workflow: 'forget',
      start: async (name, idempotencyKey) => {
        starts.push({ name, key: idempotencyKey })
      },
    })
    const schedule = scheduler.schedules.find(item => item.job === 'omb.forget')
    if (schedule === undefined) throw new Error('缺少 omb.forget 调度')
    const timers = new PostgresTimerStore(db.db)
    await timers.schedule({
      topic: CONSOLIDATION_TIMER_TOPIC,
      payload: { job: 'omb.forget' },
      dueAt: new Date(Date.now() - 1_000),
      dedupeKey: schedule.dedupeKey,
    })
    const worker = new TimerWorker(
      { store: timers, handlers: [scheduler.timerHandler], clock: testClock() },
      { batchSize: 5, leaseMs: 5_000 },
    )

    expect(await worker.tick()).toMatchObject({ claimed: 1, fired: 1, dead: 0 })
    const key = starts[0]?.key ?? ''
    expect(key).toMatch(/^consolidation:omb\.forget:\d+$/)
    const period = Number(key.slice('consolidation:omb.forget:'.length))
    expect(Math.abs(period - Math.floor(Date.now() / CONSOLIDATION_INTERVAL_MS))).toBeLessThanOrEqual(1)
  })

  it('给定未配置 workflow dispatch 当 forget timer 到期则走 pg-boss 入队（兼容路径，与 workflow 互斥）', async () => {
    const enqueued: string[] = []
    const scheduler = schedulerFor(recordingQueue(enqueued))
    const schedule = scheduler.schedules.find(item => item.job === 'omb.forget')
    if (schedule === undefined) throw new Error('缺少 omb.forget 调度')
    const timers = new PostgresTimerStore(db.db)
    await timers.schedule({
      topic: CONSOLIDATION_TIMER_TOPIC,
      payload: { job: 'omb.forget' },
      dueAt: new Date(Date.now() - 1_000),
      dedupeKey: schedule.dedupeKey,
    })
    const worker = new TimerWorker(
      { store: timers, handlers: [scheduler.timerHandler], clock: testClock() },
      { batchSize: 5, leaseMs: 5_000 },
    )

    expect(await worker.tick()).toMatchObject({ claimed: 1, fired: 1 })
    expect(enqueued).toEqual(['omb.forget'])
  })
})

describe('plugin：loop 删除后的巩固调度（真实 PostgreSQL + pg-boss）', () => {
  it('给定 jobs=true 当启动则 10 个任务各有 durable timer，到点各入队一次', async () => {
    const plugin = startPlugin()
    try {
      // 启动首轮立即到期 → 各任务入队并执行 → 执行完 rearm 到下一网格（due 在未来）。
      await waitFor(fullyArmedRows, '巩固任务全部 rearm 到下一网格', 60_000)
      // 首轮入队的 10 个 pg-boss 作业可能还在消费中；等队列清空再断言，避免瞬时计数 flaky。
      const text = await waitFor(
        async () => {
          const current = await statusText(plugin)
          return metric(current, 'consolidationQueued') === 0 ? current : undefined
        },
        '首轮巩固任务队列清空',
        20_000,
      )
      expect(text).toContain('consolidation=ok')
      expect(text).toContain(`consolidationJobs=${CONSOLIDATION_JOB_NAMES.join(',')}`)
      expect(text).toContain('timerTopics=omb.workflow.wake,omb.consolidation')
      // consolidation 的 pending 是合法 durable schedule，不是泄漏；业务 timer 空闲。
      expect(metric(text, 'timerPending') - metric(text, 'consolidationPending')).toBe(0)
      expect(metric(text, 'consolidationPending')).toBe(CONSOLIDATION_JOB_NAMES.length)
      expect(metric(text, 'consolidationQueued')).toBe(0)
      // status 必须把 consolidation 的到期/下一次时间也报出来（不是只有总数）。
      expect(metric(text, 'consolidationDueAgeMs')).toBe(0)
      expect(metric(text, 'consolidationNextDueMs')).toBeGreaterThan(0)
      expect(metric(text, 'consolidationDead')).toBe(0)

      const rows = await consolidationTimerRows()
      expect(rows).toHaveLength(CONSOLIDATION_JOB_NAMES.length)
      expect(rows.map(row => row.dedupe_key)).toEqual([...consolidationDedupeKeys].sort())
      expect(rows.every(row => row.status === 'pending')).toBe(true)

      // 每个任务都真的被 timer 到期驱动过**恰好一次**：`timerFired` 只在 handler 成功
      // （入队完成）后累加，而一条 timer 行 complete 后不可能再被 claim；这里没有 workflow
      // wake timer，所以 fired 必须等于任务数——多一次就是重复派发。
      const fired = await statusText(plugin)
      expect(metric(fired, 'timerFired')).toBe(CONSOLIDATION_JOB_NAMES.length)
      expect(metric(fired, 'timerRetried')).toBe(0)
      expect(metric(fired, 'timerDead')).toBe(0)
    } finally {
      await plugin.stop()
    }
  }, 90_000)

  it('给定 plugin 重启当 ensure 则 schedule 幂等：行数、行 id、到期时间都不变', async () => {
    const first = startPlugin()
    let before: TimerRow[]
    try {
      // 必须等首轮真的跑完并 rearm：启动时那 10 条“立即到期”的 pending 行同样满足
      // “pending=10”，会把“还没跑”误当成“已续期”。
      before = await waitFor(fullyArmedRows, '首个进程巩固任务全部 rearm 到下一网格', 60_000)
    } finally {
      await first.stop()
    }

    const second = startPlugin()
    try {
      await waitFor(
        async () => ((await statusText(second)).includes('consolidation=ok') ? true : undefined),
        '第二个进程巩固调度就绪',
        60_000,
      )
      const after = await consolidationTimerRows()
      expect(after).toHaveLength(before.length)
      for (const previous of before) {
        const current = consolidationTimerRow(after, previous.dedupe_key)
        expect(current.id).toBe(previous.id)
        expect(new Date(current.due_at).toISOString()).toBe(new Date(previous.due_at).toISOString())
        expect(current.status).toBe('pending')
      }
      // 重启没有补排：日志里 scheduledNow 为空。
      expect(
        second.host.logs.some(line => line.includes('durable 调度已就绪') && line.includes('"scheduledNow":[]')),
      ).toBe(true)
    } finally {
      await second.stop()
    }
  }, 90_000)

  it('给定删除 10 分钟 loop 当启动则 forget 由 timer → workflow step 执行并归档，run completed 且 timer 续期', async () => {
    const old = await writeEntity({
      kind: 'memory',
      category: 'event',
      scope: { kind: 'global' },
      attrs: { title: '很久以前的日志', body: '无关紧要' },
    })
    await db.db.query("update omb.entity set updated_at = now() - interval '365 days' where id = $1", [old])
    await db.db.query(
      "update omb.entity_view set updated_at = now() - interval '365 days' where entity_id = $1",
      [old],
    )

    const plugin = startPlugin()
    try {
      // 没有 setInterval 了：唯一驱动是启动时 durable timer 到期 → start 一个真实
      // forget workflow run → step 调用 runForget 归档。
      await waitFor(
        async () => ((await db.get(old)) === undefined ? true : undefined),
        'forget 的 workflow step 执行并归档',
        60_000,
      )

      // run 是真实定义、真实完成：name/version/status/idempotencyKey 都落库。
      // 归档副作用发生在 step 内、completeStep 之前，所以“实体已归档”不等于 run 已 completed：
      // 等 run 自己到终态再断言（有上界，不是固定 sleep）。
      const run = await waitFor(
        async () => {
          const rows = await db.db.query<{ id: string; status: string; version: number; idempotency_key: string }>(
            "select id, status, version, idempotency_key from omb.workflow_run where name = 'forget' order by created_at",
          )
          const row = rows.rows[0]
          return rows.rows.length === 1 && row?.status === 'completed' ? row : undefined
        },
        'forget workflow run 完成',
        30_000,
      )
      expect(run.version).toBe(1)
      // 幂等键 = <dedupeKey>:<期号>：同一期的重复派发只会命中同一个 run。
      expect(run.idempotency_key).toMatch(/^consolidation:omb\.forget:\d+$/)

      const steps = await db.db.query<{ step: string; status: string; output: { state?: Record<string, unknown> } }>(
        'select step, status, output from omb.workflow_step where run_id = $1 order by attempt',
        [run.id],
      )
      expect(steps.rows.map(row => `${row.step}:${row.status}`)).toEqual(['archive:completed'])
      // step state 记录了 ctx 的幂等键/时钟读数与真实归档数（不是只跑了个空壳）。
      expect(steps.rows[0]?.output.state).toMatchObject({
        target: 'forget',
        archived: 1,
        commandId: `${run.id}:archive`,
      })
      expect(typeof steps.rows[0]?.output.state?.['at']).toBe('string')

      const text = await statusText(plugin)
      // status 必须报真实定义与 completed 计数，而不是 workflowDefinitions=none。
      expect(text).toContain('workflowDefinitions=forget')
      expect(metric(text, 'workflowCompleted')).toBeGreaterThanOrEqual(1)
      expect(metric(text, 'workflowDead')).toBe(0)
      // 不得双跑：workflow 路径下 forget 不再入队 pg-boss。
      const queued = await db.db.query<{ count: string }>(
        "select count(*)::text as count from pgboss.job where name = 'omb.forget'",
      )
      expect(Number(queued.rows[0]?.count ?? 0)).toBe(0)
      // 归档之后由 step 的 rearm 把同一行排到下一网格，不靠任何固定节拍。
      await waitFor(
        async () => {
          const row = consolidationTimerRow(await consolidationTimerRows(), 'consolidation:omb.forget')
          return row.status === 'pending' && new Date(row.due_at).getTime() > Date.now() ? true : undefined
        },
        'forget 任务续期到下一网格',
      )
    } finally {
      await plugin.stop()
    }
  }, 90_000)

  it('给定 EntityCreated 带动态属性当 relay 投递则合并入队 omb.refresh 并刷新属性', async () => {
    const plugin = startPlugin()
    try {
      // 先等启动首轮巩固跑完并 rearm：之后出现的 refresh 任务只可能来自 reaction。
      await waitFor(fullyArmedRows, '启动首轮巩固结束并 rearm', 60_000)

      const input: WriteEntityInput = {
        kind: 'memory',
        category: 'fact',
        scope: { kind: 'global' },
        attrs: {
          title: '事件触发动态刷新',
          body: 'EntityCreated → omb.refresh',
          statusRule: { $dynamic: { kind: 'regex', source: 'completed', input: { kind: 'literal', value: 'completed' } } },
        },
      }
      const written = await writeEntity(input)
      // outbox 事件被 relay 投递（reaction 真的跑了）。
      const outboxStatus = await waitFor(
        async () => {
          const rows = await db.db.query<{ status: string }>(
            `select o.status from omb.outbox o
               join omb.audit_log a on a.id = o.event_id
              where a.stream_id = $1 and a.event_type = 'EntityCreated'`,
            [written],
          )
          const status = rows.rows[0]?.status
          return status === 'done' ? status : undefined
        },
        'EntityCreated 被 relay 投递',
      )
      expect(outboxStatus).toBe('done')
      // refresh:event 这个 singletonKey 只有事件 reaction 会用（timer 驱动的是 <job>:<bucket>）。
      const queued = await waitFor(
        async () => {
          const rows = await db.db.query<{ singleton_key: string | null }>(
            "select singleton_key from pgboss.job where name = 'omb.refresh' and singleton_key = 'refresh:event'",
          )
          return rows.rows[0]
        },
        'EntityCreated → enqueue-refresh',
      )
      expect(queued.singleton_key).toBe('refresh:event')
      // 任务真的执行：动态属性被刷新出缓存值（不是只入队不消费）。
      const refreshed = await waitFor(
        async () => {
          const loaded = await db.get(written, { includeArchived: true })
          return loaded === undefined ? undefined : attributeValue(loaded, 'statusRule')
        },
        'omb.refresh 执行后动态属性有值',
      )
      expect(refreshed).toBe('completed')
    } finally {
      await plugin.stop()
    }
  }, 90_000)
})

describe('巩固调度源码（静态）', () => {
  it('给定巩固调度实现当静态检查则没有 setInterval，也没有旧 loop 入口', async () => {
    const jobsSource = await readFile(new URL('../../../packages/v7/src/jobs/consolidate.ts', import.meta.url), 'utf8')
    const jobsIndex = await readFile(new URL('../../../packages/v7/src/jobs/index.ts', import.meta.url), 'utf8')
    const pluginSource = await readFile(new URL('../../../plugin/v7/index.ts', import.meta.url), 'utf8')

    // 这两段 needle 是“源码里不应出现的旧实现”，本行不是睡眠/轮询调用。
    // check:ignore-next-line test-sleep
    const forbiddenInterval = 'setInterval('
    const forbiddenLoop = 'startConsolidationLoop'
    for (const [name, source] of [['jobs/consolidate.ts', jobsSource], ['jobs/index.ts', jobsIndex], ['plugin/v7/index.ts', pluginSource]] as const) {
      expect(source.includes(forbiddenInterval), `${name} 不允许有 setInterval`).toBe(false)
      expect(source.includes(forbiddenLoop), `${name} 不允许保留旧 loop 入口`).toBe(false)
    }
    // 调度必须真的走 timer 表：dedupeKey 稳定、topic 固定、任务名是载荷。
    expect(jobsSource).toContain("const CONSOLIDATION_TIMER_TOPIC = 'omb.consolidation'")
    expect(jobsSource).toContain('dedupeKey: `consolidation:${job}`')
    expect(jobsSource).toContain('payload: { job: schedule.job, period: periodOf(dueAt, schedule.intervalMs) }')
  })

  it('给定 forget 改成 workflow 执行当静态检查则定义有真实 step、调度只 start，续期不在 handler 里', async () => {
    const business = await readFile(new URL('../../../packages/v7/src/app/workflow/business.ts', import.meta.url), 'utf8')
    const jobsSource = await readFile(new URL('../../../packages/v7/src/jobs/consolidate.ts', import.meta.url), 'utf8')
    const pluginConsolidation = await readFile(new URL('../../../plugin/v7/consolidation.ts', import.meta.url), 'utf8')

    // 定义是真实业务步骤（不是空壳）：step 名固定，命令幂等键与时钟来自 ctx。
    expect(business).toContain("export const FORGET_WORKFLOW = 'forget'")
    expect(business).toContain("export const FORGET_STEP = 'archive'")
    expect(business).toContain('ctx.commandId')
    expect(business).toContain('ctx.now')
    // 行为与后台 handler 一致：定义只通过注入的 forget port 调同一个实现。
    expect(pluginConsolidation).toContain('runForget(')
    expect(pluginConsolidation).toContain('rearm: () => scheduler.rearm(FORGET_JOB)')
    // timer 到期在 workflow 路径下只 start：不得同时入队 pg-boss（双跑）。
    expect(jobsSource).toContain('await dispatch.start(dispatch.workflow')
  })
})
