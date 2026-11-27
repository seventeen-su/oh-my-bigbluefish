import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../../../plugin/v7/index.js'
import type { HostContextLike, HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { PostgresTimerStore } from '../../../packages/v7/src/adapters/postgres/timer.js'
import { AttributeWriter } from '../../../packages/v7/src/adapters/postgres/writer.js'
import { DefaultCommandBus, type CommandMeta } from '../../../packages/v7/src/app/commands/index.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { reconnectDelayMs } from '../../../packages/v7/src/adapters/postgres/listen.js'
import { OUTBOX_NOTIFY_CHANNEL, PostgresOutboxNotifier } from '../../../packages/v7/src/adapters/postgres/outbox.js'
import { PROJECTION_NOTIFY_CHANNEL, PostgresProjectionNotifier } from '../../../packages/v7/src/adapters/postgres/projection.js'
import { TIMER_NOTIFY_CHANNEL, PostgresTimerNotifier } from '../../../packages/v7/src/adapters/postgres/timer.js'

/**
 * LISTEN/NOTIFY 断连恢复的真实 PostgreSQL 证据（最终复核 P1：事件运行时断连后停摆）。
 *
 * 覆盖：
 * - LISTEN 专用连接被服务端终止（等价于数据库重启踢掉连接）后，按指数退避用单次
 *   setTimeout 重连，**重新 LISTEN** 并继续被 NOTIFY 唤醒——没有 setInterval 轮询；
 * - `status()` 暴露 connected/reconnects 计数（组合根的 `omb_status` 读它）；
 * - 重连后 outbox 投递、投影回填、timer 派发都继续，不靠固定轮询补；
 * - T0 看板水位超龄且仍有未投影任务时回退写模型并标 fallbackReason。
 *
 * 使用独立库 `omb_v7_test_recovery`（env 可覆盖），不碰 omb_v7_test / 生产库。
 */

const DATABASE_URL = process.env.OMB_RECOVERY_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_recovery'

/** LISTEN 专用连接的 application_name：按名字终止它们等价于“连接被踢/数据库重启”。 */
const OUTBOX_APPLICATION = 'omb-v7-outbox'
const TIMER_APPLICATION = 'omb-v7-timer'
const PROJECTION_APPLICATION = 'omb-v7-projection'

let db: PostgresDb

/** 有上界的条件轮询间隔；不是用睡眠当同步/断言。 */
async function wait(ms: number): Promise<void> {
  // check:ignore-next-line test-sleep
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 条件等待：断言依赖状态变化，超时即失败并说明在等什么。 */
async function waitFor<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await wait(25)
  }
}

/** 终止指定 application_name 在本测试库上的连接（只碰本库，不干扰其它测试库）。 */
async function terminateBackends(applicationNames: readonly string[]): Promise<number> {
  const result = await db.query<{ terminated: number }>(
    `select count(*)::int as terminated
       from (
         select pg_terminate_backend(pid) as killed
           from pg_stat_activity
          where datname = current_database()
            and application_name = any($1::text[])
            and pid <> pg_backend_pid()
       ) terminated`,
    [applicationNames],
  )
  return result.rows[0]?.terminated ?? 0
}

/** 当前本库里仍然存在的 LISTEN 连接数（重连证据：旧连接被踢后必须补上新连接）。 */
async function listenConnections(applicationName: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count
       from pg_stat_activity
      where datname = current_database() and application_name = $1`,
    [applicationName],
  )
  return result.rows[0]?.count ?? 0
}

interface NotifierLike {
  ready(): Promise<void>
  subscribe(listener: () => void): () => void
  status(): { readonly connected: boolean; readonly reconnects: number; readonly connectAttempts: number }
  close(): Promise<void>
}

beforeAll(async () => {
  await migrateDatabase(DATABASE_URL)
  db = new PostgresDb({ connectionString: DATABASE_URL })
})

afterAll(async () => {
  await db.close()
})

/**
 * 终止一条 LISTEN 连接后必须：重连计数 +1、连接重新出现，并且**真的重新 LISTEN**。
 *
 * “真的重新 LISTEN”的判据只能是服务端推送：notifier 没有轮询，能唤醒订阅者的只有
 * 重连后注册的 LISTEN 通道收到的 NOTIFY。
 */
async function assertReListen(input: {
  readonly applicationName: string
  readonly channel: string
  readonly notifier: NotifierLike
}): Promise<void> {
  const { notifier } = input
  let woken = 0
  const unsubscribe = notifier.subscribe(() => {
    woken += 1
  })
  try {
    await notifier.ready()
    expect(notifier.status()).toMatchObject({ connected: true, reconnects: 0 })
    expect(await terminateBackends([input.applicationName])).toBeGreaterThanOrEqual(1)

    const reconnected = await waitFor(
      async () => (notifier.status().connected && notifier.status().reconnects >= 1 ? notifier.status() : undefined),
      `${input.channel} 重连完成`,
    )
    expect(reconnected.reconnects).toBeGreaterThanOrEqual(1)
    expect(await listenConnections(input.applicationName)).toBe(1)

    const before = woken
    await db.query('select pg_notify($1, $2)', [input.channel, 'recovery-probe'])
    await waitFor(async () => (woken > before ? true : undefined), `重连后的 ${input.channel} 收到 NOTIFY`)
  } finally {
    unsubscribe()
    await notifier.close()
  }
}

describe('LISTEN 断连重连（真实 PostgreSQL）', () => {
  it('给定连续重连失败当计算退避则指数增长并封顶（单次 setTimeout，无 setInterval）', async () => {
    const first = reconnectDelayMs(0)
    expect(first).toBeGreaterThan(0)
    expect(reconnectDelayMs(1)).toBe(first * 2)
    expect(reconnectDelayMs(2)).toBe(first * 4)
    expect(reconnectDelayMs(3)).toBe(first * 8)
    // 封顶：继续失败不会无限增长，也不会退化成 0（0 会成为忙等循环）。
    const cap = reconnectDelayMs(40)
    expect(cap).toBeGreaterThan(0)
    expect(reconnectDelayMs(45)).toBe(cap)
    // 非法输入（负数/NaN）回落到基线，不产生 NaN 的 setTimeout。
    expect(reconnectDelayMs(-1)).toBe(first)
    expect(reconnectDelayMs(Number.NaN)).toBe(first)

    // 需求是“单次 setTimeout、无 setInterval”；这是文本级护栏，语义证据在下面的真实断连用例。
    // 只看调用形态（`setInterval(`），注释里说明“没有 setInterval”不算违规。
    const source = await readFile(
      new URL('../../../packages/v7/src/adapters/postgres/listen.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/\bsetInterval\s*\(/)
    expect(source).toMatch(/\bsetTimeout\s*\(/)
  })

  it('给定 outbox LISTEN 连接被终止当重连完成则重新 LISTEN 并继续被 NOTIFY 唤醒', async () => {
    await assertReListen({
      applicationName: OUTBOX_APPLICATION,
      channel: OUTBOX_NOTIFY_CHANNEL,
      notifier: new PostgresOutboxNotifier({ connectionString: DATABASE_URL }),
    })
  })

  it('给定 timer LISTEN 连接被终止当重连完成则重新 LISTEN 并继续被 NOTIFY 唤醒', async () => {
    await assertReListen({
      applicationName: TIMER_APPLICATION,
      channel: TIMER_NOTIFY_CHANNEL,
      notifier: new PostgresTimerNotifier({ connectionString: DATABASE_URL }),
    })
  })

  it('给定 projection LISTEN 连接被终止当重连完成则重新 LISTEN 并继续被 NOTIFY 唤醒', async () => {
    await assertReListen({
      applicationName: PROJECTION_APPLICATION,
      channel: PROJECTION_NOTIFY_CHANNEL,
      notifier: new PostgresProjectionNotifier({ connectionString: DATABASE_URL }),
    })
  })
})

// ---------------------------------------------------------------------------
// 组合根：重连计数可见 + 重连后三条运行时链路都继续投递
// ---------------------------------------------------------------------------

const PROJECT = 'D:\\Program\\Oh-My-BigBlueFish'
const EXEC = { agent: { session: { id: 'notifier-recovery-session', header: { cwd: PROJECT } } } }

interface FakeHost {
  ctx: HostContextLike
  readonly tools: Map<string, HostToolDefinition>
  readonly listeners: Map<string, (...args: unknown[]) => unknown>
  readonly logs: string[]
  provider: ((input: unknown) => string) | undefined
}

function fakeHost(): FakeHost {
  const tools = new Map<string, HostToolDefinition>()
  const logs: string[] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
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

interface RunningPlugin {
  readonly host: FakeHost
  dispose(): void
  stop(): Promise<void>
}

/** 启动一个真实 plugin 实例；`stop()` 等 teardown 收尾（关闭 LISTEN 连接）后才返回。 */
function startPlugin(overrides: Record<string, unknown> = {}): RunningPlugin {
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

async function statusText(plugin: RunningPlugin): Promise<string> {
  const result = await plugin.host.tools.get('omb_status')?.execute({}, EXEC)
  if (result === undefined || !result.ok) throw new Error(`omb_status 失败：${result?.text ?? '没有注册 omb_status'}`)
  return result.text
}

/** 等到 status 里出现某段文本（读到就返回整段，便于后续断言其它字段）。 */
async function waitStatus(plugin: RunningPlugin, needle: string, what: string): Promise<string> {
  return waitFor(async () => {
    const text = await statusText(plugin)
    return text.includes(needle) ? text : undefined
  }, what)
}

function meta(): CommandMeta {
  return {
    commandId: randomUUID(),
    actor: { id: 'test', kind: 'system' },
    origin: 'test',
    correlationId: randomUUID(),
  }
}

function memory(title: string, attrs: Record<string, unknown> = {}): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body: `正文-${title}`, ...attrs },
  }
}

let store: PostgresStore
let bus: DefaultCommandBus

function busOn(db: PostgresStore): DefaultCommandBus {
  return new DefaultCommandBus({ store: db, writer: new AttributeWriter(db.db) })
}

async function createOnBus(input: WriteEntityInput): Promise<string> {
  const created = await bus.execute({ type: 'CreateEntity', input }, meta())
  if (!created.ok) throw new Error(`创建实体失败：${created.error.message}`)
  const id = created.value.events[0]?.streamId
  if (id === undefined) throw new Error('创建实体没有返回事件')
  return id
}

interface OutboxRow {
  readonly id: number
  readonly status: string
  readonly attempts: number
}

async function outboxRowOfStream(streamId: string, eventType: string): Promise<OutboxRow | undefined> {
  const result = await store.db.query<OutboxRow>(
    `select o.id::int as id, o.status, o.attempts
       from omb.outbox o
       join omb.audit_log a on a.id = o.event_id
      where a.stream_id = $1 and a.event_type = $2`,
    [streamId, eventType],
  )
  return result.rows[0]
}

async function resetRuntimeTables(): Promise<void> {
  await truncateAll(DATABASE_URL)
  await store.db.query(`
    truncate table omb.workflow_step, omb.workflow_run, omb.timer, omb.outbox,
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

describe('事件运行时断连恢复（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    store = new PostgresStore(DATABASE_URL)
    bus = busOn(store)
  })

  beforeEach(async () => {
    await resetRuntimeTables()
  })

  afterAll(async () => {
    await resetRuntimeTables().catch(() => {})
    await store.close()
  })

  it('给定三个 LISTEN 连接同时被终止当重连完成则 omb_status 报 connected/reconnect 计数', async () => {
    const plugin = startPlugin()
    try {
      const before = await statusText(plugin)
      expect(before).toContain('projectionListenConnected=true projectionListenReconnects=0')
      expect(before).toContain('outboxListenConnected=true outboxListenReconnects=0')
      expect(before).toContain('timerListenConnected=true timerListenReconnects=0')

      expect(
        await terminateBackends([OUTBOX_APPLICATION, TIMER_APPLICATION, PROJECTION_APPLICATION]),
      ).toBeGreaterThanOrEqual(3)

      const after = await waitFor(
        async () => {
          const text = await statusText(plugin)
          const ready = (['projection', 'outbox', 'timer'] as const).every(label => (
            text.includes(`${label}ListenConnected=true ${label}ListenReconnects=1`)
          ))
          return ready ? text : undefined
        },
        '三个 LISTEN 连接都重连并在 status 可见',
      )
      expect(after).toContain('outboxListenConnected=true outboxListenReconnects=1')
      expect(after).toContain('timerListenConnected=true timerListenReconnects=1')
      expect(after).toContain('projectionListenConnected=true projectionListenReconnects=1')
      // 重连是新建专用连接，不是复用连接池里的短连接。
      expect(await listenConnections(OUTBOX_APPLICATION)).toBe(1)
      expect(await listenConnections(TIMER_APPLICATION)).toBe(1)
      expect(await listenConnections(PROJECTION_APPLICATION)).toBe(1)
    } finally {
      await plugin.stop()
    }
  })

  it('给定 outbox LISTEN 连接被终止当重连后则新事件仍被 relay 投递', async () => {
    const plugin = startPlugin()
    try {
      await statusText(plugin)
      expect(await terminateBackends([OUTBOX_APPLICATION])).toBeGreaterThanOrEqual(1)
      await waitStatus(plugin, 'outboxListenReconnects=1', 'outbox LISTEN 重连')

      const id = await createOnBus(memory('重连后仍被投递'))
      const delivered = await waitFor(
        async () => {
          const row = await outboxRowOfStream(id, 'EntityCreated')
          return row?.status === 'done' ? row : undefined
        },
        '重连后 EntityCreated 仍被 relay 投递',
      )
      expect(delivered.attempts).toBe(0)
    } finally {
      await plugin.stop()
    }
  })

  it('给定 projection LISTEN 连接被终止当重连后则新写偏好的看板仍被回填', async () => {
    const plugin = startPlugin()
    try {
      await statusText(plugin)
      expect(await terminateBackends([PROJECTION_APPLICATION])).toBeGreaterThanOrEqual(1)
      await waitStatus(plugin, 'projectionListenReconnects=1', 'projection LISTEN 重连')

      const id = await createOnBus(memory('重连后仍被回填的偏好', { tags: ['偏好'] }))
      const board = await waitFor(
        async () => {
          const rows = await store.db.query<{ title: string; revision: string }>(
            'select title, revision::text as revision from omb.preference_board where entity_id = $1',
            [id],
          )
          return rows.rows[0]
        },
        '重连后 writer 入队的投影任务仍被回填到 preference_board',
      )
      expect(board.title).toBe('重连后仍被回填的偏好')
      expect(board.revision).toBe('1')
    } finally {
      await plugin.stop()
    }
  })

  it('给定 timer LISTEN 连接被终止当重连后则到期 timer 仍被派发', async () => {
    const plugin = startPlugin()
    try {
      await statusText(plugin)
      expect(await terminateBackends([TIMER_APPLICATION])).toBeGreaterThanOrEqual(1)
      await waitStatus(plugin, 'timerListenReconnects=1', 'timer LISTEN 重连')

      const timers = new PostgresTimerStore(store.db)
      const scheduled = await timers.schedule({
        topic: 'omb.workflow.wake',
        payload: {},
        dueAt: new Date(Date.now() + 250),
        dedupeKey: `recovery:${randomUUID()}`,
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
        '重连后到期的 timer 仍被 timer worker 派发',
        10_000,
      )
      expect(done.last_error).toBeNull()
    } finally {
      await plugin.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// T0：worker 停摆时读模型会静默变旧 → 水位超龄即回退写模型
// ---------------------------------------------------------------------------

interface StoredSection {
  name: string
  kept: boolean
  source?: string
  fallbackReason?: string
}

describe('T0 看板水位停摆回退（真实 PostgreSQL）', () => {
  let t0Store: PostgresStore

  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    t0Store = new PostgresStore(DATABASE_URL)
  })

  beforeEach(async () => {
    await truncateAll(DATABASE_URL)
    await t0Store.db.query(`
      truncate table omb.projection_watermark, omb.projection_task,
                      omb.preference_board, omb.state_board
      restart identity cascade
    `)
  })

  afterAll(async () => {
    await truncateAll(DATABASE_URL).catch(() => {})
    await t0Store.close()
  })

  it('给定水位超龄且仍有未投影任务当构建 T0 则回退写模型并在 trace 标 fallbackReason', async () => {
    const plugin = startPlugin({ jobs: false })
    const session = { id: 't0-watermark-stale-session', header: { cwd: PROJECT } }
    const exec = { agent: { session } }
    try {
      const title = 'T0 停摆仍要看得见'
      const remembered = await plugin.host.tools.get('omb_remember')?.execute({
        kind: 'memory',
        category: 'fact',
        scope: 'global',
        attrs: { title, tags: ['偏好'] },
      }, exec)
      const preferenceId = /mem_[0-9a-f-]{36}/.exec(remembered?.text ?? '')?.[0]
      expect(preferenceId).toBeDefined()

      // 先等这次写入真的投影成读模型，避免把“还没投影”当成“停摆”。
      await waitFor(
        async () => {
          const rows = await t0Store.db.query<{ status: string }>(
            `select status from omb.projection_task
              where entity_id = $1 and projection = 'preference_board'`,
            [preferenceId],
          )
          return rows.rows[0]?.status === 'done' ? true : undefined
        },
        '偏好投影完成',
      )

      // 模拟 worker 停摆：任务退回 pending（available_at 在未来 → 不会被 claim），水位停在 10 分钟前。
      const reopened = await t0Store.db.query(
        `update omb.projection_task
            set status = 'pending', attempts = 0, claimed_at = null,
                available_at = now() + interval '1 hour'
          where entity_id = $1 and projection = 'preference_board'`,
        [preferenceId],
      )
      expect(reopened.rowCount).toBe(1)
      await t0Store.db.query(
        `insert into omb.projection_watermark (projection, watermark, updated_at)
         values ('preference_board', now() - interval '10 minutes', now() - interval '10 minutes')
         on conflict (projection) do update
            set watermark = excluded.watermark, updated_at = excluded.updated_at`,
      )

      const preStep = plugin.host.listeners.get('agent/pre-step')
      expect(preStep).toBeDefined()
      await preStep?.({
        agent: { session },
        messages: [{ source: { kind: 'user' }, content: '继续' }],
        turn: 1,
        step: 1,
      }, async () => ({ kind: 'enter', messages: [] }))

      const resident = plugin.host.provider?.({ agent: { session } }) ?? ''
      expect(resident).toContain(title)
      // 写模型回退才有 stats 段：这条断言同时证明 T0 真的换了来源，而不是只写 trace。
      expect(resident).toContain('库索引')

      const sections = await waitFor(
        async () => {
          const rows = await t0Store.db.query<{ sections: StoredSection[] }>(
            'select sections from omb.resident_trace where session_id = $1 order by id desc limit 1',
            [session.id],
          )
          return rows.rows[0]?.sections
        },
        'T0 trace 落库',
      )
      const preferenceSection = sections.find(section => section.name === 'preferences')
      expect(preferenceSection).toMatchObject({ kept: true, source: 'write-model' })
      expect(preferenceSection?.fallbackReason).toMatch(
        /^read-model-watermark-stale: preference_board watermarkAgeMs=\d+ unprojected=1$/,
      )
      // 停摆不是静默降级：组合根必须把原因写进日志，便于 omb_status 之外的排查。
      expect(
        plugin.host.logs.some(line => line.startsWith('warn ') && line.includes('read-model-watermark-stale')),
      ).toBe(true)
    } finally {
      await plugin.stop()
    }
  })
})
