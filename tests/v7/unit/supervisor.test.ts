import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostContextLike } from '../../../packages/v7/src/adapters/dsh/host.js'
import type { Logger } from '../../../packages/v7/src/ports/jobs.js'
import {
  EXPECTED_HOOK_NAMES,
  EXPECTED_TOOL_NAMES,
  Supervisor,
  TEARDOWN_STEP_TIMEOUT_MS,
  runTeardownSteps,
  wireHostHook,
  type TeardownStep,
} from '../../../plugin/v7/supervisor.js'

interface HostFixture {
  readonly ctx: HostContextLike
  readonly definitions: Map<string, unknown>
}

/** 宿主替身：tools.register 真实增减 map；liveProbe=false 时模拟没有 tools.get 的老宿主。 */
function fakeHost(options: { tools?: readonly string[]; liveProbe?: boolean; probeThrows?: boolean } = {}): HostFixture {
  const definitions = new Map<string, unknown>((options.tools ?? []).map(name => [name, { name }]))
  const service: Record<string, unknown> = {
    register: (definition: { name: string }) => {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  }
  if (options.liveProbe !== false) {
    service['get'] = (name: string) => {
      if (options.probeThrows === true) throw new Error('probe failed')
      return definitions.get(name)
    }
  }
  const ctx = {
    get: (name: string) => (name === 'tools' ? service : undefined),
    on: () => () => {},
  } as unknown as HostContextLike
  return { ctx, definitions }
}

interface CapturedLogger {
  readonly logger: Logger
  readonly infos: string[]
  readonly warns: string[]
}

function captureLogger(): CapturedLogger {
  const infos: string[] = []
  const warns: string[] = []
  return {
    infos,
    warns,
    logger: {
      debug: () => {},
      info: message => { infos.push(message) },
      warn: message => { warns.push(message) },
      error: () => {},
    },
  }
}

function wireAllHooks(supervisor: Supervisor): void {
  for (const name of EXPECTED_HOOK_NAMES) supervisor.recordHook(name, true)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('supervisor 期望面', () => {
  it('给定插件承诺面当读取常量则 7 个工具与 4 个钩子', () => {
    expect(EXPECTED_TOOL_NAMES).toHaveLength(7)
    expect([...EXPECTED_TOOL_NAMES].sort()).toEqual([
      'omb_admin', 'omb_history', 'omb_link', 'omb_recall', 'omb_remember', 'omb_status', 'omb_update',
    ])
    expect(EXPECTED_HOOK_NAMES).toEqual([
      'agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'session/disposed',
    ])
  })
})

describe('supervisor 自检读数', () => {
  it('给定 7 个工具与 4 个钩子都已接线当 omb_status 自检则报 tools=7/7 hooks=4/4', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const supervisor = new Supervisor({ ctx: host.ctx })
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    wireAllHooks(supervisor)

    expect(supervisor.statusLines()).toEqual(['tools=7/7', 'hooks=4/4'])
  })

  it('给定工具运行期缺失当自检则报真实 N/7 并标 degraded', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES.filter(name => name !== 'omb_link') })
    const supervisor = new Supervisor({ ctx: host.ctx })
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    wireAllHooks(supervisor)

    const lines = supervisor.statusLines()
    expect(lines).toContain('tools=6/7')
    expect(lines).toContain('surface=degraded')
    expect(lines).toContain('toolsMissing=omb_link')
  })

  it('给定一个钩子未接线当自检则报 hooks=3/4 与缺失钩子', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const supervisor = new Supervisor({ ctx: host.ctx })
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    for (const name of EXPECTED_HOOK_NAMES) {
      supervisor.recordHook(name, name !== 'session/disposed', name === 'session/disposed' ? '宿主没有 on()' : undefined)
    }

    const lines = supervisor.statusLines()
    expect(lines).toContain('tools=7/7')
    expect(lines).toContain('hooks=3/4')
    expect(lines).toContain('hooksMissing=session/disposed')
    expect(lines).toContain('surface=degraded')
  })

  it('给定工具注册失败当自检则保留失败工具与原因可见', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const supervisor = new Supervisor({ ctx: host.ctx })
    supervisor.recordToolRegistration({
      registered: EXPECTED_TOOL_NAMES.filter(name => name !== 'omb_admin'),
      unavailable: [{ name: 'omb_admin', reason: 'already registered' }],
    })
    wireAllHooks(supervisor)

    const lines = supervisor.statusLines()
    expect(lines).toContain('surface=degraded')
    expect(lines).toContain('toolErrors=omb_admin:already registered')
  })

  it('给定宿主没有 tools.get 当自检则退回注册记录并标 toolsProbe=records', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES, liveProbe: false })
    const supervisor = new Supervisor({ ctx: host.ctx })
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    wireAllHooks(supervisor)

    expect(supervisor.statusLines()).toEqual(['tools=7/7', 'hooks=4/4', 'toolsProbe=records'])
  })

  it('给定宿主 tools.get 抛错当自检则按缺失降级而不是伪造 7/7', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES, probeThrows: true })
    const supervisor = new Supervisor({ ctx: host.ctx })
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    wireAllHooks(supervisor)

    const lines = supervisor.statusLines()
    expect(lines).toContain('tools=0/7')
    expect(lines).toContain('surface=degraded')
    expect(lines).not.toContain('tools=7/7')
  })

  it('给定接线齐全当写摘要则 info 一条且带 tools/hooks 计数', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const logger = captureLogger()
    const supervisor = new Supervisor({ ctx: host.ctx, logger: logger.logger })
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    wireAllHooks(supervisor)

    supervisor.logWiringSummary()
    expect(logger.infos).toContain('宿主面接线：tools=7/7 hooks=4/4')
    expect(logger.warns).toEqual([])
  })

  it('给定钩子未接线当记录则立刻 warn 不静默', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const logger = captureLogger()
    const supervisor = new Supervisor({ ctx: host.ctx, logger: logger.logger })
    supervisor.recordHook('agent/pre-step', false, '宿主没有 on()')

    expect(logger.warns).toContain('宿主钩子未接线：agent/pre-step')
  })
})

describe('宿主钩子接线', () => {
  it('给定宿主 on 返回 disposer 当接线则记录已接线并返回 off', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const supervisor = new Supervisor({ ctx: host.ctx })
    const off = (): void => {}
    const ctx = {
      ...host.ctx,
      on: () => off,
    } as unknown as HostContextLike

    const result = wireHostHook({ ctx, supervisor, name: 'agent/pre-step', handler: () => {} })
    expect(result.off).toBe(off)
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    for (const name of EXPECTED_HOOK_NAMES) {
      if (name !== 'agent/pre-step') supervisor.recordHook(name, true)
    }
    expect(supervisor.statusLines()).toContain('hooks=4/4')
  })

  it('给定宿主 on 返回非函数当接线则 off 为空且钩子缺失可见', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const logger = captureLogger()
    const supervisor = new Supervisor({ ctx: host.ctx, logger: logger.logger })
    supervisor.recordHook('agent/pre-step', true)
    const ctx = { ...host.ctx, on: () => undefined } as unknown as HostContextLike

    const result = wireHostHook({ ctx, supervisor, name: 'tools/pre-execute', handler: () => {} })
    expect(result.off).toBeUndefined()
    expect(logger.warns).toContain('宿主钩子未接线：tools/pre-execute')
    expect(supervisor.statusLines()).toContain('hooksMissing=tools/pre-execute,tools/post-execute,session/disposed')
  })

  it('给定宿主 on 抛错当接线则 off 为空且带原因降级', () => {
    const host = fakeHost({ tools: EXPECTED_TOOL_NAMES })
    const supervisor = new Supervisor({ ctx: host.ctx })
    const ctx = {
      ...host.ctx,
      on: () => { throw new Error('boom') },
    } as unknown as HostContextLike

    const result = wireHostHook({ ctx, supervisor, name: 'session/disposed', handler: () => {} })
    expect(result.off).toBeUndefined()
    supervisor.recordToolRegistration({ registered: EXPECTED_TOOL_NAMES, unavailable: [] })
    for (const name of EXPECTED_HOOK_NAMES) {
      if (name !== 'session/disposed') supervisor.recordHook(name, true)
    }
    expect(supervisor.statusLines()).toContain('surface=degraded')
  })
})

describe('teardown 收尾', () => {
  it('给定每步预算当读取常量则等于 5 秒', () => {
    expect(TEARDOWN_STEP_TIMEOUT_MS).toBe(5_000)
  })

  it('给定 queue.stop 挂起当收尾则超时后仍关闭 store 并 stop lifecycle', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const logger = captureLogger()
    const steps: TeardownStep[] = [
      { name: 'queue.stop', run: () => new Promise<void>(() => {}) },
      { name: 'store.close', run: () => { calls.push('store.close'); return Promise.resolve() } },
      { name: 'lifecycle.stop', run: () => { calls.push('lifecycle.stop'); return Promise.resolve() } },
    ]
    const reportPromise = runTeardownSteps(steps, { logger: logger.logger })
    await vi.advanceTimersByTimeAsync(TEARDOWN_STEP_TIMEOUT_MS)
    const report = await reportPromise

    expect(report.timedOut).toEqual(['queue.stop'])
    expect(report.completed).toEqual(['store.close', 'lifecycle.stop'])
    expect(calls).toEqual(['store.close', 'lifecycle.stop'])
    expect(logger.warns).toContain('teardown queue.stop 超过 5000ms 未完成，继续后续步骤')
    expect(logger.infos).toContain('teardown store.close 完成')
  })

  it('给定 queue 与 store 都挂起当收尾则两步各自超时且 lifecycle.stop 仍执行', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const steps: TeardownStep[] = [
      { name: 'queue.stop', run: () => new Promise<void>(() => {}) },
      { name: 'store.close', run: () => { calls.push('store.close'); return new Promise<void>(() => {}) } },
      { name: 'lifecycle.stop', run: () => { calls.push('lifecycle.stop'); return Promise.resolve() } },
    ]
    const reportPromise = runTeardownSteps(steps)
    // 每步独立预算：第一段超时后才开始第二步，第二段再给 5s。
    await vi.advanceTimersByTimeAsync(TEARDOWN_STEP_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(TEARDOWN_STEP_TIMEOUT_MS)
    const report = await reportPromise

    expect(report.timedOut).toEqual(['queue.stop', 'store.close'])
    expect(report.completed).toEqual(['lifecycle.stop'])
    expect(calls).toEqual(['store.close', 'lifecycle.stop'])
  })

  it('给定 queue.stop 未结束当收尾则不会并发关闭 store', async () => {
    const calls: string[] = []
    let releaseQueue = (): void => {}
    const queueDone = new Promise<void>(resolve => { releaseQueue = resolve })
    const reportPromise = runTeardownSteps([
      { name: 'queue.stop', run: () => { calls.push('queue.stop'); return queueDone } },
      { name: 'store.close', run: () => { calls.push('store.close'); return Promise.resolve() } },
    ])
    await Promise.resolve()
    expect(calls).toEqual(['queue.stop'])

    releaseQueue()
    const report = await reportPromise
    expect(calls).toEqual(['queue.stop', 'store.close'])
    expect(report.completed).toEqual(['queue.stop', 'store.close'])
  })

  it('给定步骤同步抛错与 reject 当收尾则记录失败并继续后续且不 reject', async () => {
    const calls: string[] = []
    const report = await runTeardownSteps([
      { name: 'sync.throw', run: () => { calls.push('sync.throw'); throw new Error('boom') } },
      { name: 'async.reject', run: () => { calls.push('async.reject'); return Promise.reject(new Error('nope')) } },
      { name: 'last.ok', run: () => { calls.push('last.ok') } },
    ])

    expect(calls).toEqual(['sync.throw', 'async.reject', 'last.ok'])
    expect(report.completed).toEqual(['last.ok'])
    expect(report.timedOut).toEqual([])
    expect(report.failed).toEqual([
      { name: 'sync.throw', reason: 'boom' },
      { name: 'async.reject', reason: 'nope' },
    ])
  })

  it('给定全部步骤挂起当收尾则报告超时且不抛给宿主', async () => {
    vi.useFakeTimers()
    const reportPromise = runTeardownSteps([
      { name: 'queue.stop', run: () => new Promise<void>(() => {}) },
      { name: 'store.close', run: () => new Promise<void>(() => {}) },
    ], { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(reportPromise).resolves.toEqual({
      completed: [],
      timedOut: ['queue.stop', 'store.close'],
      failed: [],
    })
  })
})
