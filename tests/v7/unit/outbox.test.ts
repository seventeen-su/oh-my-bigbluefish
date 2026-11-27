import { describe, expect, it } from 'vitest'
import { OutboxRelay, type OutboxRelayOptions } from '../../../packages/v7/src/app/outbox/relay.js'
import { ReactionRegistry } from '../../../packages/v7/src/app/outbox/registry.js'
import { DEFAULT_RETRY_POLICY, normalizeRetryPolicy, planAttempt } from '../../../packages/v7/src/app/outbox/retry.js'
import type {
  OutboxAppendInput,
  OutboxAppendResult,
  OutboxClaimOptions,
  OutboxEvent,
  OutboxFailureInput,
  OutboxStats,
  OutboxStore,
  OutboxTransaction,
  OutboxWakeSource,
} from '../../../packages/v7/src/app/outbox/events.js'
import type { ReactionContext } from '../../../packages/v7/src/app/outbox/reactions.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'

type RowStatus = 'pending' | 'claimed' | 'done' | 'dead'

interface Row {
  id: number
  eventId: number
  topic: string
  payload: JsonValue
  status: RowStatus
  attempts: number
  availableAt: number
  createdAt: number
  lastError: string | null
}

interface SeedInput {
  eventId: number
  topic: string
  payload?: JsonValue
  createdAt?: Date
  availableAt?: Date
  status?: RowStatus
  attempts?: number
}

/** 内存 outbox：只模拟 §4.2 的 claim/complete/fail/release 语义，不引入计时器。 */
class MemoryOutboxStore implements OutboxStore {
  private nextId = 1
  readonly rows: Row[] = []

  constructor(private readonly clock: Clock) {}

  seed(input: SeedInput): Row {
    const now = this.clock.now().getTime()
    const row: Row = {
      id: this.nextId,
      eventId: input.eventId,
      topic: input.topic,
      payload: input.payload ?? {},
      status: input.status ?? 'pending',
      attempts: input.attempts ?? 0,
      availableAt: input.availableAt?.getTime() ?? now,
      createdAt: input.createdAt?.getTime() ?? now,
      lastError: null,
    }
    this.nextId += 1
    this.rows.push(row)
    return row
  }

  async append(input: OutboxAppendInput, _tx?: OutboxTransaction): Promise<OutboxAppendResult> {
    const existing = this.rows.find(row => row.eventId === input.eventId)
    if (existing !== undefined) return { id: existing.id, inserted: false }
    const row = this.seed({
      eventId: input.eventId,
      topic: input.topic,
      payload: input.payload,
      availableAt: input.availableAt,
    })
    return { id: row.id, inserted: true }
  }

  async claim(options: OutboxClaimOptions): Promise<readonly OutboxEvent[]> {
    const now = this.clock.now().getTime()
    const due = this.rows
      .filter(row => (row.status === 'pending' || row.status === 'claimed') && row.availableAt <= now)
      .sort((left, right) => left.availableAt - right.availableAt || left.id - right.id)
      .slice(0, Math.max(0, options.limit))
    for (const row of due) {
      row.status = 'claimed'
      row.availableAt = now + options.leaseMs
    }
    return due.map(row => this.eventOf(row))
  }

  async complete(id: number, expectedAttempts: number): Promise<boolean> {
    const row = this.rows.find(item => item.id === id)
    if (row === undefined || row.status !== 'claimed' || row.attempts !== expectedAttempts) return false
    row.status = 'done'
    row.lastError = null
    return true
  }

  async fail(input: OutboxFailureInput): Promise<boolean> {
    const row = this.rows.find(item => item.id === input.id)
    if (row === undefined || row.status !== 'claimed' || row.attempts !== input.expectedAttempts) return false
    row.attempts += 1
    row.lastError = input.error
    if (input.dead === true) {
      row.status = 'dead'
      return true
    }
    row.status = 'pending'
    row.availableAt = input.retryAt?.getTime() ?? this.clock.now().getTime()
    return true
  }

  async release(id: number, expectedAttempts: number): Promise<boolean> {
    const row = this.rows.find(item => item.id === id)
    if (row === undefined || row.status !== 'claimed' || row.attempts !== expectedAttempts) return false
    row.status = 'pending'
    row.availableAt = this.clock.now().getTime()
    return true
  }

  async stats(): Promise<OutboxStats> {
    const now = this.clock.now().getTime()
    let pending = 0
    let claimed = 0
    let oldestAgeMs = 0
    for (const row of this.rows) {
      if (row.status === 'pending') pending += 1
      if (row.status === 'claimed') claimed += 1
      const due = row.status === 'pending' || (row.status === 'claimed' && row.availableAt <= now)
      if (due) oldestAgeMs = Math.max(oldestAgeMs, now - row.createdAt)
    }
    return { pending, claimed, oldestAgeMs: Math.max(0, oldestAgeMs) }
  }

  async stalePendingCount(olderThanMs: number): Promise<number> {
    const now = this.clock.now().getTime()
    return this.rows.filter(
      row => row.status === 'pending' && row.availableAt <= now && row.createdAt <= now - olderThanMs,
    ).length
  }

  eventOf(row: Row): OutboxEvent {
    return {
      id: row.id,
      eventId: row.eventId,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: new Date(row.createdAt).toISOString(),
      availableAt: new Date(row.availableAt).toISOString(),
    }
  }
}

class FakeWakeSource implements OutboxWakeSource {
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

function fixedClock(startIso = '2026-01-01T00:00:00.000Z'): Clock & { advance(ms: number): void } {
  let current = Date.parse(startIso)
  return {
    now: () => new Date(current),
    iso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms
    },
  }
}

interface Harness {
  readonly store: MemoryOutboxStore
  readonly registry: ReactionRegistry
  readonly clock: ReturnType<typeof fixedClock>
  readonly wake: FakeWakeSource
}

function harness(): Harness {
  const clock = fixedClock()
  return {
    store: new MemoryOutboxStore(clock),
    registry: new ReactionRegistry(),
    clock,
    wake: new FakeWakeSource(),
  }
}

function relayOf(current: Harness, options: OutboxRelayOptions = {}): OutboxRelay {
  return new OutboxRelay(
    {
      store: current.store,
      registry: current.registry,
      clock: current.clock,
      wake: current.wake,
    },
    { leaseMs: 5_000, batchSize: 10, ...options },
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const CONTEXT: ReactionContext = {
  id: 1,
  eventId: 1,
  topic: 'probe',
  attempt: 1,
  now: new Date('2026-01-01T00:00:00.000Z'),
}

function eventOf(topic = 'probe'): OutboxEvent {
  return {
    id: 1,
    eventId: 1,
    topic,
    payload: {},
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('outbox 退避策略', () => {
  it('给定默认策略当连续失败则按指数退避并在上限处死信', () => {
    expect(planAttempt(DEFAULT_RETRY_POLICY, 0)).toEqual({ kind: 'retry', attempt: 1, delayMs: 250 })
    expect(planAttempt(DEFAULT_RETRY_POLICY, 1)).toEqual({ kind: 'retry', attempt: 2, delayMs: 1_000 })
    expect(planAttempt(DEFAULT_RETRY_POLICY, 3)).toEqual({ kind: 'retry', attempt: 4, delayMs: 16_000 })
    expect(planAttempt(DEFAULT_RETRY_POLICY, 4)).toEqual({ kind: 'dead', attempt: 5 })
  })

  it('给定最大延迟当指数超过上限则退避取 cap', () => {
    expect(planAttempt({ maxAttempts: 10, baseDelayMs: 100, factor: 10, maxDelayMs: 1_000 }, 3)).toEqual({
      kind: 'retry',
      attempt: 4,
      delayMs: 1_000,
    })
  })

  it('给定 maxAttempts=1 当第一次失败则直接死信', () => {
    expect(planAttempt({ maxAttempts: 1, baseDelayMs: 10, factor: 2, maxDelayMs: 100 }, 0)).toEqual({
      kind: 'dead',
      attempt: 1,
    })
  })

  it('给定非法策略当归一化则把上界/下界夹到可用范围', () => {
    expect(normalizeRetryPolicy({ maxAttempts: 0, baseDelayMs: -5, factor: 0.5, maxDelayMs: -1 })).toEqual({
      maxAttempts: 1,
      baseDelayMs: 0,
      factor: 1,
      maxDelayMs: 0,
    })
  })
})

describe('ReactionRegistry', () => {
  it('给定同 topic 两个 reaction 当第一个抛错则第二个仍执行并汇报失败', async () => {
    const registry = new ReactionRegistry()
    const ran: string[] = []
    registry.register('probe', {
      name: 'bad',
      run: () => {
        throw new Error('bad handler')
      },
    })
    registry.register('probe', {
      name: 'good',
      run: () => {
        ran.push('good')
      },
    })
    const result = await registry.dispatch(eventOf(), CONTEXT)
    expect(result).toEqual({
      kind: 'failed',
      ran: ['good'],
      failures: [{ name: 'bad', error: 'bad handler' }],
    })
    expect(ran).toEqual(['good'])
  })

  it('给定未注册 topic 当派发则返回 no-handlers 而不是抛错', async () => {
    const registry = new ReactionRegistry()
    await expect(registry.dispatch(eventOf('missing'), CONTEXT)).resolves.toEqual({ kind: 'no-handlers' })
  })

  it('给定已注册 reaction 当调用注销函数则不再派发', async () => {
    const registry = new ReactionRegistry()
    let runs = 0
    const dispose = registry.register('probe', {
      name: 'once',
      run: () => {
        runs += 1
      },
    })
    await registry.dispatch(eventOf(), CONTEXT)
    expect(runs).toBe(1)
    dispose()
    expect(registry.has('probe')).toBe(false)
    await expect(registry.dispatch(eventOf(), CONTEXT)).resolves.toEqual({ kind: 'no-handlers' })
  })

  it('给定同名 reaction 替换当派发则只执行后注册的实现', async () => {
    const registry = new ReactionRegistry()
    const seen: string[] = []
    const disposeFirst = registry.register('probe', {
      name: 'same',
      run: () => {
        seen.push('first')
      },
    })
    registry.register('probe', {
      name: 'same',
      run: () => {
        seen.push('second')
      },
    })
    await registry.dispatch(eventOf(), CONTEXT)
    expect(seen).toEqual(['second'])
    // 旧注销函数不能误删后来替换的实例。
    disposeFirst()
    expect(registry.count('probe')).toBe(1)
  })

  it('给定同步抛错当派发则错误被捕获而不是冒泡', async () => {
    const registry = new ReactionRegistry()
    registry.register('probe', {
      name: 'sync-bad',
      run: () => {
        throw new TypeError('sync boom')
      },
    })
    await expect(registry.dispatch(eventOf(), CONTEXT)).resolves.toEqual({
      kind: 'failed',
      ran: [],
      failures: [{ name: 'sync-bad', error: 'sync boom' }],
    })
  })
})

describe('OutboxRelay', () => {
  it('给定已注册 reaction 当 tick 则派发一次并把行标记 done', async () => {
    const current = harness()
    current.store.seed({ eventId: 11, topic: 'probe', payload: { hello: '世界' } })
    const seen: Array<{ eventId: number; attempt: number; payload: JsonValue }> = []
    current.registry.register('probe', {
      name: 'collect',
      run: (event, ctx) => {
        seen.push({ eventId: event.eventId, attempt: ctx.attempt, payload: event.payload })
      },
    })
    const relay = relayOf(current)
    const summary = await relay.tick()
    expect(summary).toEqual({ claimed: 1, delivered: 1, skipped: 0, retried: 0, dead: 0, released: 0, lost: 0 })
    expect(seen).toEqual([{ eventId: 11, attempt: 1, payload: { hello: '世界' } }])
    expect(current.store.rows[0]?.status).toBe('done')
    expect((await relay.tick()).claimed).toBe(0)
  })

  it('给定 reaction 持续抛错当按退避重试则 attempts 递增并在上限死信', async () => {
    const current = harness()
    current.store.seed({ eventId: 1, topic: 'flaky' })
    current.registry.register('flaky', {
      name: 'always-fail',
      run: () => {
        throw new Error('boom')
      },
    })
    const relay = relayOf(current, {
      retry: { maxAttempts: 3, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 },
    })

    const first = await relay.tick()
    expect(first).toMatchObject({ claimed: 1, retried: 1, dead: 0 })
    expect(current.store.rows[0]).toMatchObject({ status: 'pending', attempts: 1 })
    expect(current.store.rows[0]?.lastError).toContain('boom')
    expect((current.store.rows[0]?.availableAt ?? 0) - current.clock.now().getTime()).toBe(100)
    expect(await relay.tick()).toMatchObject({ claimed: 0 })

    current.clock.advance(100)
    const second = await relay.tick()
    expect(second).toMatchObject({ claimed: 1, retried: 1, dead: 0 })
    expect(current.store.rows[0]?.attempts).toBe(2)
    expect((current.store.rows[0]?.availableAt ?? 0) - current.clock.now().getTime()).toBe(200)

    current.clock.advance(200)
    const third = await relay.tick()
    expect(third).toMatchObject({ claimed: 1, dead: 1, retried: 0 })
    expect(current.store.rows[0]).toMatchObject({ status: 'dead', attempts: 3 })
    expect((await relay.tick()).claimed).toBe(0)
    expect((await relay.stats()).lastError).toContain('boom')
  })

  it('给定未注册 topic 当 tick 则默认进入死信并记录 topic', async () => {
    const current = harness()
    current.store.seed({ eventId: 1, topic: 'missing' })
    const relay = relayOf(current)
    const summary = await relay.tick()
    expect(summary).toMatchObject({ claimed: 1, dead: 1, delivered: 0 })
    expect(current.store.rows[0]).toMatchObject({ status: 'dead', attempts: 1 })
    expect(current.store.rows[0]?.lastError).toContain('missing')
  })

  it('给定 unknownTopic=skip 当 tick 则丢弃未知 topic 并标记 done', async () => {
    const current = harness()
    current.store.seed({ eventId: 1, topic: 'missing' })
    const relay = relayOf(current, { unknownTopic: 'skip' })
    const summary = await relay.tick()
    expect(summary).toMatchObject({ claimed: 1, skipped: 1, dead: 0 })
    expect(current.store.rows[0]?.status).toBe('done')
  })

  it('给定同 topic 前一个 reaction 失败当 tick 则后一个仍执行且整条事件退避', async () => {
    const current = harness()
    current.store.seed({ eventId: 1, topic: 'pair' })
    const seen: string[] = []
    current.registry.register('pair', {
      name: 'bad',
      run: () => {
        throw new Error('bad')
      },
    })
    current.registry.register('pair', {
      name: 'good',
      run: () => {
        seen.push('good')
      },
    })
    const relay = relayOf(current)
    const summary = await relay.tick()
    expect(summary).toMatchObject({ claimed: 1, retried: 1, delivered: 0 })
    expect(seen).toEqual(['good'])
    expect(current.store.rows[0]?.status).toBe('pending')
  })

  it('给定 3 条事件且 batchSize=1 当 drain 则全部投递', async () => {
    const current = harness()
    for (let index = 0; index < 3; index += 1) current.store.seed({ eventId: index + 1, topic: 'probe' })
    current.registry.register('probe', { name: 'ok', run: () => {} })
    const relay = relayOf(current, { batchSize: 1 })
    const summary = await relay.drain()
    expect(summary).toMatchObject({ claimed: 3, delivered: 3 })
    expect(current.store.rows.every(row => row.status === 'done')).toBe(true)
  })

  it('给定 relay 已启动并空闲当收到 wake 则自动派发', async () => {
    const current = harness()
    const seen: number[] = []
    current.registry.register('probe', {
      name: 'record',
      run: event => {
        seen.push(event.eventId)
      },
    })
    const relay = relayOf(current)
    relay.start()
    try {
      await relay.whenIdle()
      current.store.seed({ eventId: 7, topic: 'probe', payload: { via: 'wake' } })
      current.wake.emit()
      await relay.whenIdle()
      expect(seen).toEqual([7])
      expect(current.store.rows[0]?.status).toBe('done')
    } finally {
      await relay.stop()
    }
  })

  it('给定丢失唤醒的旧 pending 当 reconcile 则只兜底旧行并唤醒处理', async () => {
    const current = harness()
    const seen: number[] = []
    current.registry.register('probe', {
      name: 'record',
      run: event => {
        seen.push(event.eventId)
      },
    })
    const relay = relayOf(current, { reconcileGraceMs: 30_000 })
    relay.start()
    try {
      await relay.whenIdle()
      current.store.seed({
        eventId: 1,
        topic: 'probe',
        createdAt: new Date(current.clock.now().getTime() - 60_000),
      })
      current.store.seed({ eventId: 2, topic: 'probe' })
      expect(await relay.reconcile()).toBe(1)
      await relay.whenIdle()
      // 唤醒后正常 claim 会把所有到期行都带走；reconcile 的返回值只数“旧 pending”。
      expect(seen.sort((left, right) => left - right)).toEqual([1, 2])
      expect(await relay.reconcile()).toBe(0)
    } finally {
      await relay.stop()
    }
  })

  it('给定 batch 内 reaction 尚未完成当 stop 则未派发行归还 pending 且不丢已 claim 行', async () => {
    const current = harness()
    for (let index = 0; index < 3; index += 1) current.store.seed({ eventId: 100 + index, topic: 'block' })
    const gate = deferred()
    const entered = deferred()
    let runs = 0
    current.registry.register('block', {
      name: 'block-first',
      run: async () => {
        runs += 1
        if (runs === 1) {
          entered.resolve()
          await gate.promise
        }
      },
    })
    const relay = relayOf(current)
    const tick = relay.tick()
    await entered.promise
    const stopping = relay.stop()
    gate.resolve()
    const summary = await tick
    await stopping

    expect(summary).toMatchObject({ claimed: 3, delivered: 1, released: 2, lost: 0 })
    expect(current.store.rows.map(row => row.status)).toEqual(['done', 'pending', 'pending'])
    expect((current.store.rows[1]?.availableAt ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(current.clock.now().getTime())

    const resumed = relayOf(current)
    await expect(resumed.drain()).resolves.toMatchObject({ delivered: 2 })
    expect(current.store.rows.every(row => row.status === 'done')).toBe(true)
  })

  it('给定 relay 已 stop 当再 tick 则不领取新行', async () => {
    const current = harness()
    const relay = relayOf(current)
    await relay.stop()
    current.store.seed({ eventId: 1, topic: 'probe' })
    await expect(relay.tick()).resolves.toEqual({
      claimed: 0,
      delivered: 0,
      skipped: 0,
      retried: 0,
      dead: 0,
      released: 0,
      lost: 0,
    })
    expect(current.store.rows[0]?.status).toBe('pending')
  })

  it('给定 reaction 返回前租约已易主当 complete 则 CAS 失败并计入 lost', async () => {
    const current = harness()
    current.store.seed({ eventId: 1, topic: 'probe' })
    current.registry.register('probe', {
      name: 'takeover',
      run: event => {
        const row = current.store.rows.find(item => item.id === event.id)
        if (row !== undefined) {
          // 等价于租约过期后另一个 worker 重领并失败过一次：attempts 改变，旧 worker 不能再写结果。
          row.attempts += 1
        }
      },
    })
    const relay = relayOf(current)
    await expect(relay.tick()).resolves.toMatchObject({ claimed: 1, delivered: 0, lost: 1 })
  })

  it('给定一批成功投递当 stats 则合并持久计数与进程内计数', async () => {
    const current = harness()
    current.store.seed({ eventId: 1, topic: 'probe' })
    current.registry.register('probe', { name: 'ok', run: () => {} })
    const relay = relayOf(current)
    await relay.tick()
    const stats = await relay.stats()
    expect(stats).toMatchObject({ pending: 0, claimed: 0, oldestAgeMs: 0, delivered: 1, retried: 0, dead: 0, lost: 0 })
    expect(stats.lastError).toBeUndefined()
  })

  it('给定 claim 租约未到期当再次 claim 则不重复领取，到期后可重领', async () => {
    const current = harness()
    current.store.seed({ eventId: 1, topic: 'probe' })
    const first = await current.store.claim({ limit: 1, leaseMs: 5_000 })
    expect(first).toHaveLength(1)
    expect(first[0]?.availableAt).toBe(new Date(current.clock.now().getTime() + 5_000).toISOString())
    expect(await current.store.claim({ limit: 1, leaseMs: 5_000 })).toHaveLength(0)
    current.clock.advance(5_000)
    const again = await current.store.claim({ limit: 1, leaseMs: 5_000 })
    expect(again).toHaveLength(1)
    expect(again[0]?.attempts).toBe(0)
    const id = again[0]?.id ?? 0
    expect(await current.store.complete(id, 0)).toBe(true)
  })

  it('给定循环运行中 store 抛错当错误被隔离则 relay 仍可被 wake 恢复', async () => {
    const current = harness()
    const seen: number[] = []
    current.registry.register('probe', {
      name: 'record',
      run: event => {
        seen.push(event.eventId)
      },
    })
    let failures = 1
    const original = current.store.claim.bind(current.store)
    current.store.claim = async options => {
      if (failures > 0) {
        failures -= 1
        throw new Error('db down')
      }
      return original(options)
    }
    const relay = relayOf(current, { leaseMs: 5_000 })
    relay.start()
    try {
      await relay.whenIdle()
      expect((await relay.stats()).lastError).toContain('db down')
      current.store.seed({ eventId: 1, topic: 'probe' })
      current.wake.emit()
      await relay.whenIdle()
      expect(seen).toEqual([1])
    } finally {
      await relay.stop()
    }
  })
})
