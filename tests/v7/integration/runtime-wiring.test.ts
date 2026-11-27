import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../../../plugin/v7/index.js'
import type { HostContextLike, HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { PostgresTimerStore } from '../../../packages/v7/src/adapters/postgres/timer.js'
import { AttributeWriter } from '../../../packages/v7/src/adapters/postgres/writer.js'
import { DefaultCommandBus, type CommandMeta } from '../../../packages/v7/src/app/commands/index.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'

/**
 * Phase 3 运行时接线（PLAN Task 14/15 的组合根部分）：
 * DB ready 且投影启动之后构造/启动 outbox relay、timer worker、workflow runtime，
 * 注册真实 reaction（EntityCreated/EntityPatched → omb.embed），status 报真实读数，
 * teardown 先停 relay/timer/workflow 再关连接。
 *
 * 使用独立库 `omb_v7_test_runtime`（env 可覆盖），不碰 omb_v7_test / 生产库。
 * 所有等待都是有上界的条件轮询：断言依赖状态变化，不用固定 sleep 当同步。
 */
const DATABASE_URL = process.env.OMB_RUNTIME_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_runtime'

const PROJECT = 'D:\\Program\\Oh-My-BigBlueFish'
const EXEC = { agent: { session: { id: 'runtime-wiring-session', header: { cwd: PROJECT } } } }
/** outbox relay 从 writer 的 NOTIFY 被唤醒；这里显式再发一次只用于 at-least-once 重放。 */
const OUTBOX_CHANNEL = 'omb_outbox'

interface FakeHost {
  ctx: HostContextLike
  readonly tools: Map<string, HostToolDefinition>
  readonly promptText: Map<string, string>
  readonly listeners: Map<string, (...args: unknown[]) => unknown>
  readonly logs: string[]
  provider: ((input: unknown) => string) | undefined
}

function fakeHost(): FakeHost {
  const tools = new Map<string, HostToolDefinition>()
  const promptText = new Map<string, string>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const logs: string[] = []
  const push = (level: string, message: unknown): void => {
    logs.push(`${level} ${typeof message === 'string' ? message : JSON.stringify(message)}`)
  }
  const host: FakeHost = { ctx: undefined as unknown as HostContextLike, tools, promptText, listeners, logs, provider: undefined }
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
          context: (arg: unknown) => {
            const record = arg as { name?: string; text?: (input: unknown) => string }
            if (typeof record.text === 'function') host.provider = record.text
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
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
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

interface RunningRuntime {
  readonly host: FakeHost
  readonly dispose: () => void
  stop(): Promise<void>
}

function startRuntime(overrides: Record<string, unknown> = {}): RunningRuntime {
  const host = fakeHost()
  const dispose = apply(host.ctx, {
    databaseUrl: DATABASE_URL,
    autoMigrate: true,
    jobs: true,
    residentBudget: 300,
    ...overrides,
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

async function statusText(runtime: RunningRuntime): Promise<string> {
  const result = await runtime.host.tools.get('omb_status')?.execute({}, EXEC)
  if (result === undefined || !result.ok) throw new Error(`omb_status 失败：${result?.text ?? '没有注册 omb_status'}`)
  return result.text
}

function infoLines(runtime: RunningRuntime): string[] {
  return runtime.host.logs.filter(line => line.startsWith('info '))
}

function meta(): CommandMeta {
  return {
    commandId: randomUUID(),
    actor: { id: 'test', kind: 'system' },
    origin: 'test',
    correlationId: randomUUID(),
  }
}

function memory(title: string): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body: `正文-${title}` },
  }
}

let store: PostgresStore

async function resetRuntimeTables(): Promise<void> {
  await truncateAll(DATABASE_URL)
  await store.db.query(`
    truncate table omb.workflow_step, omb.workflow_run, omb.timer,
                    omb.projection_watermark, omb.projection_task,
                    omb.preference_board, omb.state_board, omb.adoption_stat,
                    omb.co_recall_pair, omb.similar_cache
    restart identity cascade
  `)
  const boss = await store.db.query<{ present: boolean }>(
    "select to_regclass('pgboss.job') is not null as present",
  )
  if (boss.rows[0]?.present === true) {
    // 上一个用例的 pg-boss 行会占用 singletonKey：新用例必须从空队列开始。
    await store.db.query("delete from pgboss.job where name like 'omb.%'")
  }
}

function busOn(db: PostgresStore): DefaultCommandBus {
  return new DefaultCommandBus({ store: db, writer: new AttributeWriter(db.db) })
}

interface OutboxRow {
  readonly id: number
  readonly status: string
  readonly last_error: string | null
  readonly attempts: number
}

async function outboxRowOfStream(streamId: string, eventType: string): Promise<OutboxRow | undefined> {
  const result = await store.db.query<OutboxRow>(
    `select o.id::int as id, o.status, o.last_error, o.attempts
       from omb.outbox o
       join omb.audit_log a on a.id = o.event_id
      where a.stream_id = $1 and a.event_type = $2`,
    [streamId, eventType],
  )
  return result.rows[0]
}

interface EmbedJobRow {
  readonly singleton_key: string | null
  readonly state: string
  readonly data: { readonly entityId: string; readonly text: string }
}

async function embedJobOf(entityId: string): Promise<EmbedJobRow | undefined> {
  const result = await store.db.query<EmbedJobRow>(
    `select singleton_key, state, data
       from pgboss.job
      where name = 'omb.embed' and data->>'entityId' = $1
      order by created_on desc
      limit 1`,
    [entityId],
  )
  return result.rows[0]
}

async function createEntityOnBus(title: string): Promise<string> {
  const created = await busOn(store).execute({ type: 'CreateEntity', input: memory(title) }, meta())
  if (!created.ok) throw new Error(`创建实体失败：${created.error.message}`)
  const id = created.value.events[0]?.streamId
  if (id === undefined) throw new Error('创建实体没有返回事件')
  return id
}

describe('Phase 3 运行时接线（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    store = new PostgresStore(DATABASE_URL)
  })

  beforeEach(async () => {
    await resetRuntimeTables()
  })

  afterAll(async () => {
    await resetRuntimeTables().catch(() => {})
    await store.close()
  })

  it('给定 jobs=true 当 plugin 就绪则 status 报 outbox/timer/workflow 实测读数，且启动在投影之后', async () => {
    const runtime = startRuntime()
    try {
      const text = await statusText(runtime)
      expect(text).toContain('projection=ok')
      expect(text).toContain('outbox=ok')
      expect(text).toContain('outboxLagMs=0 outboxPending=0 outboxClaimed=0 outboxDead=0')
      expect(text).toContain('outboxTopics=EntityCreated,EntityPatched')
      expect(text).toContain('outboxUnknownTopic=dead')
      expect(text).toContain('timer=ok')
      expect(text).toMatch(/timerPending=0 timerClaimed=0 timerDueAgeMs=0 timerDead=0/)
      expect(text).toContain('timerTopics=omb.workflow.wake')
      expect(text).toContain('workflow=ok')
      expect(text).toMatch(/workflowPending=0 workflowRunning=0 workflowWaiting=0 workflowDead=0/)
      expect(text).toContain('workflowDefinitions=none')

      // 启动顺序：投影 worker 先起，event 运行时（outbox/timer/workflow）在其后。
      const lines = infoLines(runtime)
      const projectionIndex = lines.findIndex(line => line.includes('投影 worker 已启动'))
      const runtimeIndex = lines.findIndex(line => line.includes('事件运行时已启动'))
      expect(projectionIndex).toBeGreaterThanOrEqual(0)
      expect(runtimeIndex).toBeGreaterThan(projectionIndex)
    } finally {
      await runtime.stop()
    }
  })

  it('给定 EntityCreated 事件当 relay 投递则注册的 reaction 入队 omb.embed（singletonKey 去重）', async () => {
    const runtime = startRuntime()
    try {
      // 先等运行时就绪（LISTEN + relay 空闲等待 NOTIFY），再走命令总线写事件。
      await statusText(runtime)
      const id = await createEntityOnBus('事件驱动嵌入')

      const delivered = await waitFor(
        async () => {
          const row = await outboxRowOfStream(id, 'EntityCreated')
          return row?.status === 'done' ? row : undefined
        },
        'EntityCreated 的 outbox 行被 relay 投递',
      )
      expect(delivered.attempts).toBe(0)

      // 该实体没有走 remember/update（它们会自行入队），所以任务只能来自注册的 reaction。
      const job = await waitFor(() => embedJobOf(id), 'reaction 入队 omb.embed')
      expect(job.singleton_key).toBe(`embed:${id}`)
      expect(job.data.text).toContain('事件驱动嵌入')

      // 任务被真实执行：向量写入（嵌入器可用），而不是只入队不消费。
      const embedding = await waitFor(
        async () => {
          const rows = await store.db.query<{ count: number }>(
            'select count(*)::int as count from omb.embedding where entity_id = $1',
            [id],
          )
          return (rows.rows[0]?.count ?? 0) >= 1 ? rows.rows[0] : undefined
        },
        'omb.embed 执行后写入向量',
      )
      expect(embedding.count).toBe(1)

      const text = await statusText(runtime)
      expect(text).toContain('outbox=ok')
      expect(text).toMatch(/outboxLagMs=0 outboxPending=0 outboxClaimed=0 outboxDead=0/)
      expect(text).toContain('outboxDelivered=1')
    } finally {
      await runtime.stop()
    }
  })

  it('给定同一 outbox 事件被重复投递当 relay 再处理则实体/审计/向量都不重复', async () => {
    const runtime = startRuntime()
    try {
      await statusText(runtime)
      const id = await createEntityOnBus('重复投递幂等')
      const first = await waitFor(
        async () => {
          const row = await outboxRowOfStream(id, 'EntityCreated')
          return row?.status === 'done' ? row : undefined
        },
        '首次投递完成',
      )
      await waitFor(() => embedJobOf(id), '首次入队 omb.embed')
      await waitFor(
        async () => {
          const rows = await store.db.query<{ count: number }>(
            'select count(*)::int as count from omb.embedding where entity_id = $1',
            [id],
          )
          return (rows.rows[0]?.count ?? 0) >= 1 ? rows.rows[0] : undefined
        },
        '首次 omb.embed 执行并写入向量',
      )

      // 模拟 at-least-once：同一 outbox 行（同一 event_id）回到 pending，再发 NOTIFY 唤醒 relay。
      await store.db.query(
        `update omb.outbox set status = 'pending', claimed_at = null, available_at = now() where id = $1`,
        [first.id],
      )
      await store.db.query('select pg_notify($1, $2)', [OUTBOX_CHANNEL, String(first.id)])

      await waitFor(
        async () => {
          const row = await outboxRowOfStream(id, 'EntityCreated')
          return row?.status === 'done' ? row : undefined
        },
        '重复投递完成',
      )
      // 重复投递没有产生第二份业务事实：实体/审计事件/向量各只有一行。
      const counts = await store.db.query<{ entity: number; audit: number; outbox: number; embedding: number }>(
        `select
           (select count(*) from omb.entity where id = $1)::int as entity,
           (select count(*) from omb.audit_log where stream_id = $1)::int as audit,
           (select count(*) from omb.outbox o join omb.audit_log a on a.id = o.event_id where a.stream_id = $1)::int as outbox,
           (select count(*) from omb.embedding where entity_id = $1)::int as embedding`,
        [id],
      )
      expect(counts.rows[0]).toEqual({ entity: 1, audit: 1, outbox: 1, embedding: 1 })

      const text = await statusText(runtime)
      expect(text).toContain('outboxDelivered=2')
      expect(text).toMatch(/outboxLagMs=0 outboxPending=0/)
    } finally {
      await runtime.stop()
    }
  })

  it('给定未注册 topic 当 relay 投递则进死信并报出原因，不静默丢弃', async () => {
    const runtime = startRuntime()
    try {
      await statusText(runtime)
      const audit = await store.db.query<{ id: string }>(
        `insert into omb.audit_log (actor, action, event_type, stream_id, stream_version)
         values ('test', 'probe', 'EntityArchived', $1, 1)
         returning id`,
        [`probe-${randomUUID()}`],
      )
      const eventId = audit.rows[0]?.id
      if (eventId === undefined) throw new Error('没有拿到 audit_log.id')
      const outbox = await store.db.query<{ id: string }>(
        `insert into omb.outbox (event_id, topic, payload)
         values ($1, 'EntityArchived', '{}'::jsonb)
         returning id`,
        [eventId],
      )
      const outboxId = outbox.rows[0]?.id
      if (outboxId === undefined) throw new Error('没有拿到 outbox.id')
      await store.db.query('select pg_notify($1, $2)', [OUTBOX_CHANNEL, outboxId])

      const dead = await waitFor(
        async () => {
          const rows = await store.db.query<OutboxRow>(
            'select id::int as id, status, last_error, attempts from omb.outbox where id = $1',
            [outboxId],
          )
          const row = rows.rows[0]
          return row?.status === 'dead' ? row : undefined
        },
        '未注册 topic 进死信',
      )
      // 策略是 dead（不是静默 skip）：错误里点名 topic，可按 topic 补注册后重放。
      expect(dead.last_error).toContain('EntityArchived')
      // 死信也走一次 fail 写结果：attempts 记录本次投递，便于对账而不是假装没尝试过。
      expect(dead.attempts).toBe(1)

      const text = await statusText(runtime)
      expect(text).toContain('outboxDead=1')
      expect(text).toContain('outboxUnknownTopic=dead')
      expect(text).toContain('outboxLastError=')
    } finally {
      await runtime.stop()
    }
  })

  it('给定到期 timer 当 worker 空闲则由到期单次唤醒执行，而不是固定轮询', async () => {
    const runtime = startRuntime()
    try {
      await statusText(runtime)
      const timers = new PostgresTimerStore(store.db)
      const dedupeKey = `probe:${randomUUID()}`
      const scheduled = await timers.schedule({
        topic: 'omb.workflow.wake',
        payload: {},
        dueAt: new Date(Date.now() + 250),
        dedupeKey,
      })
      expect(scheduled.inserted).toBe(true)

      const done = await waitFor(
        async () => {
          const rows = await store.db.query<{ status: string; last_error: string | null }>(
            'select status, last_error from omb.timer where id = $1',
            [scheduled.id],
          )
          const row = rows.rows[0]
          return row?.status === 'done' ? row : undefined
        },
        '到期 timer 被 timer worker 执行',
        10_000,
      )
      expect(done.last_error).toBeNull()

      const text = await waitFor(
        async () => {
          const current = await statusText(runtime)
          return current.includes('timerFired=1') ? current : undefined
        },
        'status 报 timerFired=1',
      )
      expect(text).toMatch(/timerPending=0 timerClaimed=0 timerDueAgeMs=0 timerDead=0/)
    } finally {
      await runtime.stop()
    }
  })

  it('给定启动前遗留的到期 workflow run 当 plugin 启动恢复则被领取并落死信（未注册定义可见）', async () => {
    // 组合根不注册任何 workflow 定义（Phase 3 没有真实生产 workflow）：遗留 run 必须
    // 被领取后落死信让问题可见，而不是永远 pending。
    await store.db.query(
      `insert into omb.workflow_run (id, name, version, state, step, status, attempts, next_run_at, idempotency_key)
       values ('wf_orphan', 'not-registered', 1, '{}'::jsonb, 'a', 'pending', 0, now() - interval '1 second', $1)`,
      [`idem-${randomUUID()}`],
    )
    const runtime = startRuntime()
    try {
      const dead = await waitFor(
        async () => {
          const rows = await store.db.query<{ status: string; last_error: string | null }>(
            "select status, last_error from omb.workflow_run where id = 'wf_orphan'",
          )
          const row = rows.rows[0]
          return row?.status === 'dead' ? row : undefined
        },
        '遗留 run 被 workflow runtime 领取并落死信',
      )
      expect(dead.last_error).toContain('未注册')

      const text = await statusText(runtime)
      expect(text).toContain('workflow=ok')
      expect(text).toMatch(/workflowPending=0 workflowRunning=0/)
      expect(text).toContain('workflowDead=1')
    } finally {
      await runtime.stop()
    }
  })

  it('给定 workflow 表里有各状态 run 当 status 则如实报 pending/running/waiting/dead 计数', async () => {
    const runtime = startRuntime()
    try {
      await statusText(runtime)
      // 到期时间都在未来：运行时不领取，只用于验证 status 读的是真实表而不是内存推测。
      await store.db.query(
        `insert into omb.workflow_run (id, name, version, state, step, status, attempts, next_run_at, idempotency_key)
         values
           ('wf_pending', 'future-a', 1, '{}'::jsonb, 'a', 'pending', 0, now() + interval '1 hour', $1),
           ('wf_running', 'future-b', 1, '{}'::jsonb, 'a', 'running', 1, now() + interval '1 hour', $2),
           ('wf_waiting', 'future-c', 1, '{}'::jsonb, 'a', 'waiting', 0, now() + interval '1 hour', $3),
           ('wf_dead', 'future-d', 1, '{}'::jsonb, 'a', 'dead', 3, null, $4)`,
        [`idem-${randomUUID()}`, `idem-${randomUUID()}`, `idem-${randomUUID()}`, `idem-${randomUUID()}`],
      )
      const text = await statusText(runtime)
      expect(text).toContain('workflow=ok')
      expect(text).toMatch(/workflowPending=1 workflowRunning=1 workflowWaiting=1 workflowDead=1/)
      expect(text).toMatch(/workflowDueAgeMs=0/)
    } finally {
      await runtime.stop()
    }
  })

  it('给定 jobs=true 当 disposer 收尾则先停 relay/timer/workflow 再停队列/投影/连接且不超时', async () => {
    const runtime = startRuntime()
    await statusText(runtime)
    expect(() => runtime.dispose()).not.toThrow()
    await waitFor(
      async () => (runtime.host.logs.some(line => line.includes('teardown 收尾完成')) ? true : undefined),
      'plugin teardown 收尾',
    )

    const lines = infoLines(runtime)
    const order = [
      'outbox.relay.stop',
      'timer.worker.stop',
      'workflow.runtime.stop',
      'outbox.notifier.close',
      'timer.notifier.close',
      'queue.stop',
      'projection.worker.stop',
      'projection.read.close',
      'projection.notifier.close',
      'store.close',
    ]
    const indices = order.map(name => lines.findIndex(line => line.includes(`teardown ${name} 完成`)))
    for (let index = 0; index < order.length; index += 1) {
      expect(indices[index], `缺少 teardown 步骤：${order[index] ?? ''}`).toBeGreaterThanOrEqual(0)
      if (index > 0) expect(indices[index]).toBeGreaterThan(indices[index - 1] as number)
    }
    // 每步 5s 预算内完成：超时/失败会写成 warn，不允许出现。
    expect(runtime.host.logs.some(line => line.includes('teardown') && line.startsWith('warn '))).toBe(false)
    // 重复 dispose 不重复收尾。
    expect(() => runtime.dispose()).not.toThrow()
    expect(runtime.host.logs.filter(line => line.includes('teardown 收尾完成'))).toHaveLength(1)
  })
})
