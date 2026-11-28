import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../../../plugin/v7/index.js'
import type { HostContextLike, HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { resetTeardownLedger } from '../../../plugin/v7/teardown.js'
import { prepareDatabase, TEST_DATABASE_URL } from './helpers.js'

/**
 * 热开关生命周期的真实 PostgreSQL 证据。
 *
 * 覆盖：
 * - `apply` 返回的 disposer 是**可 await** 的：await 之后没有 OMB 连接/worker 残留；
 * - 重复装配 3 轮：工具/钩子/prompt context 不重复注册，连接不泄漏；
 * - 连续断连（terminate 全部 OMB 后端两次）后 LISTEN 各自重连且每个 channel 只有一条连接；
 * - 数据库重启（本轮以 terminate 全部 OMB 后端等价）后 status/读写恢复，不靠重启 DSH；
 * - 上一代 teardown 结果在重新开启后可由 `omb_status` 读到（managed DB 仅在
 *   managePostgres=true 时启用，这里用 disabled 断言不伪造）。
 *
 * 运行前用独立库：`OMB_TEST_DATABASE_URL=postgres://omb:omb@127.0.0.1:5432/omb_v7_test_lc`，
 * 不要与其它会话共用 omb_v7_test。
 */

const PROJECT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const EXEC = { agent: { session: { id: 'lifecycle-session', header: { cwd: PROJECT } } } }
const OMB_APPLICATIONS = ['omb-v7', 'omb-v7-worker', 'omb-v7-outbox', 'omb-v7-timer', 'omb-v7-projection'] as const

interface LogWaiter {
  readonly matches: (logs: readonly string[]) => boolean
  readonly resolve: () => void
}

interface FakeHost {
  ctx: HostContextLike
  readonly tools: Map<string, HostToolDefinition>
  readonly listeners: Map<string, Set<(...args: unknown[]) => unknown>>
  readonly contexts: Map<string, unknown>
  readonly sections: Map<string, unknown>
  readonly logs: string[]
  provider: ((input: unknown) => string) | undefined
  waitForLog(matches: (logs: readonly string[]) => boolean): Promise<void>
}

/** 事件驱动的日志等待：logger 写入时同步解析 waiter，不靠 sleep 轮询。 */
function fakeHost(): FakeHost {
  const tools = new Map<string, HostToolDefinition>()
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const contexts = new Map<string, unknown>()
  const sections = new Map<string, unknown>()
  const logs: string[] = []
  const waiters: LogWaiter[] = []
  const resolveWaiters = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter !== undefined && waiter.matches(logs)) {
        waiters.splice(index, 1)
        waiter.resolve()
      }
    }
  }
  const push = (level: string, message: unknown): void => {
    logs.push(`${level} ${typeof message === 'string' ? message : JSON.stringify(message)}`)
    resolveWaiters()
  }
  const host: FakeHost = {
    ctx: undefined as unknown as HostContextLike,
    tools,
    listeners,
    contexts,
    sections,
    logs,
    provider: undefined,
    waitForLog(matches) {
      if (matches(logs)) return Promise.resolve()
      const pending = new Promise<void>(settle => {
        waiters.push({ matches, resolve: settle })
      })
      // 新 waiter 注册后立刻再检查一次，避免注册与日志写入交错时丢事件。
      resolveWaiters()
      return pending
    },
  }
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
          section: (arg: unknown) => {
            const record = arg as { name?: string }
            if (record.name !== undefined) sections.set(record.name, arg)
            return () => { if (record.name !== undefined) sections.delete(record.name) }
          },
          context: (arg: unknown) => {
            const record = arg as { name?: string; text?: (input: unknown) => string }
            if (record.name !== undefined) contexts.set(record.name, arg)
            return () => {
              if (record.name !== undefined) contexts.delete(record.name)
              if (record.name === 'omb-v7:injection') host.provider = undefined
            }
          },
        }
      }
      return undefined
    },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(event)
      }
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
  readonly dispose: () => Promise<void>
}

function startPlugin(overrides: Record<string, unknown> = {}): RunningPlugin {
  const host = fakeHost()
  const dispose = apply(host.ctx, {
    databaseUrl: TEST_DATABASE_URL,
    autoMigrate: true,
    jobs: false,
    residentBudget: 300,
    ...overrides,
  })
  return { host, dispose }
}

async function statusText(plugin: RunningPlugin): Promise<string> {
  const result = await plugin.host.tools.get('omb_status')?.execute({}, EXEC)
  if (result === undefined || !result.ok) throw new Error(`omb_status 失败：${result?.text ?? '没有注册 omb_status'}`)
  return result.text
}

/** 用独立 application_name 的观察连接，避免把自身的连接算进 OMB 残留。 */
let observer: pg.Client

async function ombConnections(applications: readonly string[] = OMB_APPLICATIONS): Promise<{ application: string; count: number }[]> {
  const result = await observer.query<{ application_name: string; count: number }>(
    `select application_name, count(*)::int as count
       from pg_stat_activity
      where datname = current_database() and application_name = any($1::text[])
      group by application_name order by application_name`,
    [[...applications]],
  )
  return result.rows.map(row => ({ application: row.application_name, count: row.count }))
}

async function countConnections(application: string): Promise<number> {
  const rows = await ombConnections([application])
  return rows[0]?.count ?? 0
}

async function terminate(applications: readonly string[]): Promise<number> {
  const result = await observer.query<{ terminated: number }>(
    `select count(*)::int as terminated
       from (
         select pg_terminate_backend(pid) as killed
           from pg_stat_activity
          where datname = current_database()
            and application_name = any($1::text[])
            and pid <> pg_backend_pid()
       ) terminated`,
    [[...applications]],
  )
  return result.rows[0]?.terminated ?? 0
}

beforeAll(async () => {
  await prepareDatabase()
  observer = new pg.Client({ connectionString: TEST_DATABASE_URL, application_name: 'omb-lifecycle-observer' })
  await observer.connect()
})

afterAll(async () => {
  await observer.end()
})

beforeEach(async () => {
  resetTeardownLedger()
  await truncateAll(TEST_DATABASE_URL)
})

describe('插件热开关：apply/dispose 生命周期', () => {
  it('给定关闭插件当 await dispose 则工具/钩子/prompt context 全部注销且没有 OMB 连接', async () => {
    const plugin = startPlugin()
    expect([...plugin.host.tools.keys()]).toHaveLength(7)
    expect(await statusText(plugin)).toContain('db=ok')

    await plugin.dispose()
    expect(plugin.host.tools.size).toBe(0)
    expect(plugin.host.listeners.size).toBe(0)
    expect(plugin.host.contexts.size).toBe(0)
    expect(plugin.host.sections.size).toBe(0)
    expect(await ombConnections()).toEqual([])

    // 重新开启：上一代的 teardown 结果可见，且 managed DB 关闭时如实报 disabled（不伪造 running）。
    const reopened = startPlugin()
    try {
      const status = await statusText(reopened)
      expect(status).toContain('previousTeardown=ok')
      expect(status).toContain('previousTeardownManagedDb=disabled')
      expect(status).toContain('managedDb=disabled')
    } finally {
      await reopened.dispose()
    }
    expect(await ombConnections()).toEqual([])
  })

  it('给定重复装配 3 轮当每轮 await dispose 则工具不累积、连接不泄漏', async () => {
    for (let round = 0; round < 3; round += 1) {
      const plugin = startPlugin()
      expect([...plugin.host.tools.keys()].sort()).toEqual([
        'omb_admin', 'omb_history', 'omb_link', 'omb_recall', 'omb_remember', 'omb_status', 'omb_update',
      ])
      // 每个事件只保留一个监听器（Set 大小 1），重复 apply 不叠加。
      for (const set of plugin.host.listeners.values()) expect(set.size).toBe(1)
      expect(await statusText(plugin)).toContain('db=ok')
      await plugin.dispose()
      expect(plugin.host.tools.size).toBe(0)
      expect(plugin.host.listeners.size).toBe(0)
    }
    expect(await ombConnections()).toEqual([])
  })

  it('给定 jobs=true 当 await dispose 则 LISTEN/relay/worker/队列连接全部关闭', async () => {
    const plugin = startPlugin({ jobs: true })
    const status = await statusText(plugin)
    expect(status).toContain('jobs=on')
    expect(status).toContain('outboxListenConnected=true')
    expect(await countConnections('omb-v7-outbox')).toBe(1)
    expect(await countConnections('omb-v7-timer')).toBe(1)
    expect(await countConnections('omb-v7-projection')).toBe(1)

    await plugin.dispose()
    expect(await ombConnections()).toEqual([])
  })

  it('给定连续两次踢掉全部 OMB 后端当恢复则各自只保留一条 LISTEN 连接并计数累加', async () => {
    const plugin = startPlugin({ jobs: true })
    try {
      expect(await statusText(plugin)).toContain('outboxListenConnected=true')

      for (let round = 1; round <= 2; round += 1) {
        const reconnects = Promise.all([
          plugin.host.waitForLog(logs => logs.filter(line => line.includes('outbox LISTEN 已重连')).length >= round),
          plugin.host.waitForLog(logs => logs.filter(line => line.includes('timer LISTEN 已重连')).length >= round),
          plugin.host.waitForLog(logs => logs.filter(line => line.includes('投影 LISTEN 已重连')).length >= round),
        ])
        expect(await terminate([...OMB_APPLICATIONS])).toBeGreaterThan(0)
        await reconnects

        const status = await statusText(plugin)
        expect(status).toContain(`outboxListenConnected=true outboxListenReconnects=${round}`)
        expect(status).toContain(`timerListenConnected=true timerListenReconnects=${round}`)
        expect(status).toContain(`projectionListenConnected=true projectionListenReconnects=${round}`)
        // 重连是“补一条专用连接”，不是每次断线多留一条。
        expect(await countConnections('omb-v7-outbox')).toBe(1)
        expect(await countConnections('omb-v7-timer')).toBe(1)
        expect(await countConnections('omb-v7-projection')).toBe(1)
      }
    } finally {
      await plugin.dispose()
    }
    expect(await ombConnections()).toEqual([])
  })

  it('给定数据库重启踢掉全部 OMB 后端当恢复则 status 与写入都继续可用', async () => {
    const plugin = startPlugin({ jobs: true })
    try {
      expect(await statusText(plugin)).toContain('db=ok')
      const reconnected = Promise.all([
        plugin.host.waitForLog(logs => logs.some(line => line.includes('outbox LISTEN 已重连'))),
        plugin.host.waitForLog(logs => logs.some(line => line.includes('timer LISTEN 已重连'))),
        plugin.host.waitForLog(logs => logs.some(line => line.includes('投影 LISTEN 已重连'))),
      ])
      expect(await terminate([...OMB_APPLICATIONS])).toBeGreaterThan(0)
      await reconnected

      const recovered = await statusText(plugin)
      expect(recovered).toContain('db=ok')
      expect(recovered).toContain('outboxListenConnected=true')
      const remembered = await plugin.host.tools.get('omb_remember')?.execute({
        kind: 'memory',
        category: 'fact',
        scope: 'project',
        attrs: { title: `重启后写入 ${randomUUID().slice(0, 8)}`, body: '数据库重启后仍可写' },
      }, EXEC)
      expect(remembered?.ok).toBe(true)
    } finally {
      await plugin.dispose()
    }
    expect(await ombConnections()).toEqual([])
  })
})
