import { beforeEach, describe, expect, it } from 'vitest'
import {
  formatManagedDbLines,
  formatPreviousTeardownLines,
} from '../../../plugin/v7/status.js'
import type { ManagedPostgresStatus } from '../../../packages/v7/src/adapters/postgres/managed.js'
import { createDisposer, resetTeardownLedger, type DisposerOptions } from '../../../plugin/v7/teardown.js'
import type { Logger } from '../../../packages/v7/src/ports/jobs.js'

function status(overrides: Partial<ManagedPostgresStatus> = {}): ManagedPostgresStatus {
  return {
    state: 'running',
    managed: true,
    generation: 3,
    refs: 1,
    probe: 'running',
    ...overrides,
  }
}

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

beforeEach(() => {
  resetTeardownLedger()
})

describe('omb_status 的受管 DB 读数', () => {
  it('给定 managePostgres 未启用当格式化则报 disabled 且 owner=none', async () => {
    await expect(formatManagedDbLines(undefined)).resolves.toEqual(['managedDb=disabled', 'managedDbOwner=none'])
  })

  it('给定本实例管理的库在运行当格式化则报 running/self 与引用数', async () => {
    const lines = await formatManagedDbLines({ status: async () => status() })
    expect(lines).toContain('managedDb=running')
    expect(lines).toContain('managedDbState=running')
    expect(lines).toContain('managedDbOwner=self')
    expect(lines).toContain('managedDbRefs=1')
  })

  it('给定外部实例在运行当格式化则报 owner=external，不冒充本插件负责', async () => {
    const lines = await formatManagedDbLines({
      status: async () => status({ managed: false, probe: 'running' }),
    })
    expect(lines).toContain('managedDb=running')
    expect(lines).toContain('managedDbOwner=external')
  })

  it('给定 pg_ctl 探测未知当格式化则如实报 unknown 并带原因', async () => {
    const lines = await formatManagedDbLines({
      status: async () => status({ probe: 'unknown', lastError: 'pg_ctl 缺失' }),
    })
    expect(lines).toContain('managedDb=unknown')
    expect(lines).toContain('managedDbError=pg_ctl 缺失')
  })

  it('给定状态探测抛错当格式化则 unknown + reason，不让 omb_status 整段失败', async () => {
    const lines = await formatManagedDbLines({
      status: async () => { throw new Error('probe boom') },
    })
    expect(lines).toEqual(['managedDb=unknown', 'managedDbReason=probe boom'])
  })
})

function disposeOptions(overrides: Partial<DisposerOptions> = {}): DisposerOptions {
  return {
    logger,
    tools: { dispose: () => {} },
    capture: { dispose: () => {} },
    skillsOff: () => {},
    protocolOff: () => {},
    promptSink: { dispose: () => {} },
    checkpointSink: { dispose: () => {} },
    hooks: {},
    session: { dispose: () => {} },
    boot: { dispose: () => {} },
    eventRuntime: { stop: async () => {} },
    projection: { stop: async () => {} },
    queue: { stop: async () => {} },
    embedder: { close: async () => {} },
    store: { close: async () => {} },
    managedDb: {
      release: async () => {},
      status: async (): Promise<ManagedPostgresStatus> => status({ state: 'stopped', managed: false, probe: 'stopped', refs: 0 }),
    },
    ...overrides,
  }
}

describe('omb_status 的上一代 teardown 读数', () => {
  it('给定从未卸载当格式化则报 none', () => {
    expect(formatPreviousTeardownLines()).toEqual(['previousTeardown=none'])
  })

  it('给定上一代收尾全部成功当格式化则报 ok 与 managedDbAfter', async () => {
    await createDisposer(disposeOptions())()
    const lines = formatPreviousTeardownLines()
    expect(lines).toContain('previousTeardown=ok')
    expect(lines).toContain('previousTeardownManagedDb=stopped')
    expect(lines).toContain('previousTeardownSteps=completed:6 timedOut:0 failed:0')
    expect(lines.some(line => line.startsWith('previousTeardownFailed='))).toBe(false)
  })

  it('给定上一代有超时当格式化则报 degraded 并列出超时步骤', async () => {
    await createDisposer(disposeOptions({
      eventRuntime: { stop: () => new Promise<void>(() => {}) },
      budgets: { drainMs: 5, storeMs: 5, lifecycleMs: 5 },
    }))()
    const lines = formatPreviousTeardownLines()
    expect(lines).toContain('previousTeardown=degraded')
    expect(lines.some(line => line.startsWith('previousTeardownTimedOut=') && line.includes('eventRuntime.stop'))).toBe(true)
    expect(lines).toContain('previousTeardownManagedDb=stopped')
  })
})
