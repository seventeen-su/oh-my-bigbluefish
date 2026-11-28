import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDisposer,
  lastTeardown,
  resetTeardownLedger,
  type DisposerOptions,
} from '../../../plugin/v7/teardown.js'
import type { Logger } from '../../../packages/v7/src/ports/jobs.js'
import type { ManagedPostgresStatus } from '../../../packages/v7/src/adapters/postgres/managed.js'

interface Harness {
  readonly options: DisposerOptions
  readonly events: string[]
}

function logger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function status(probe: ManagedPostgresStatus['probe'] = 'stopped'): ManagedPostgresStatus {
  return { state: 'stopped', managed: false, generation: 1, refs: 0, probe }
}

function noop(): void {}

function harness(overrides: Partial<DisposerOptions> = {}): Harness {
  const events: string[] = []
  const options: DisposerOptions = {
    logger: logger(),
    tools: { dispose: () => { events.push('tools') } },
    capture: { dispose: noop },
    skillsOff: noop,
    protocolOff: noop,
    promptSink: { dispose: noop },
    checkpointSink: { dispose: noop },
    hooks: {},
    session: { dispose: noop },
    boot: { dispose: () => { events.push('boot') } },
    eventRuntime: { stop: async () => { events.push('eventRuntime') } },
    projection: { stop: async () => { events.push('projection') } },
    queue: { stop: async () => { events.push('queue') } },
    embedder: { close: async () => { events.push('embedder') } },
    store: { close: async () => { events.push('store') } },
    managedDb: {
      release: async () => { events.push('release') },
      status: async () => status(),
    },
    budgets: { drainMs: 100, storeMs: 100, lifecycleMs: 100 },
    ...overrides,
  }
  return { options, events }
}

beforeEach(() => {
  resetTeardownLedger()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createDisposer 分阶段收尾', () => {
  it('给定 drain 阶段挂起当收尾则 DB release 仍有独立预算并执行', async () => {
    const hanging = new Promise<void>(() => {})
    const { options, events } = harness({
      eventRuntime: { stop: () => hanging },
    })
    const dispose = createDisposer(options)
    const task = dispose()
    // 同步注销已经完成；DB release 还没开始（drain 阶段尚无结果）。
    expect(events).toContain('tools')
    expect(events).not.toContain('release')

    await vi.advanceTimersByTimeAsync(300)
    await task
    expect(events).toContain('release')
    expect(events.indexOf('store')).toBeGreaterThan(events.indexOf('eventRuntime'))
    expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('store'))

    const ledger = lastTeardown()
    expect(ledger?.managedDbAfter).toBe('stopped')
    expect(ledger?.timedOut).toContain('eventRuntime.stop')
    expect(ledger?.completed).toEqual(expect.arrayContaining(['queue.stop', 'store.close', 'managedDb.release']))
  })

  it('给定步骤失败当收尾则继续 release 并在 ledger 记录失败', async () => {
    const { options, events } = harness({
      queue: { stop: async () => { events.push('queue'); throw new Error('queue stop failed') } },
    })
    const task = createDisposer(options)()
    await vi.advanceTimersByTimeAsync(300)
    await task

    expect(events).toContain('release')
    const ledger = lastTeardown()
    expect(ledger?.failed).toEqual([{ name: 'queue.stop', reason: 'queue stop failed' }])
    expect(ledger?.managedDbAfter).toBe('stopped')
  })

  it('给定重复 dispose 当关闭则返回同一个 Promise 并只注销一次', async () => {
    const { options, events } = harness()
    const dispose = createDisposer(options)
    const first = dispose()
    const second = dispose()
    expect(second).toBe(first)
    await vi.advanceTimersByTimeAsync(300)
    await first
    dispose()
    expect(events.filter(item => item === 'tools')).toHaveLength(1)
    expect(events.filter(item => item === 'release')).toHaveLength(1)
  })

  it('给定 managePostgres=false 当收尾则 ledger 标记 disabled，不伪造 release', async () => {
    const { options } = harness({ managedDb: undefined })
    const task = createDisposer(options)()
    await vi.advanceTimersByTimeAsync(300)
    await task
    const ledger = lastTeardown()
    expect(ledger?.managedDbAfter).toBe('disabled')
    expect(ledger?.completed).not.toContain('managedDb.release')
  })
})
