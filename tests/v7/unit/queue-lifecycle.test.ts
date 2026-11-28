import { describe, expect, it } from 'vitest'
import type { PgBoss } from 'pg-boss'
import { PgBossQueue, type PgBossQueueOptions } from '../../../packages/v7/src/adapters/pg-boss/queue.js'

interface FakeBoss {
  readonly events: Map<string, (error: unknown) => void>
  readonly start: () => Promise<void>
  readonly stop: (options?: { close?: boolean; graceful?: boolean; timeout?: number }) => Promise<void>
  readonly work: () => Promise<void>
  readonly createQueue: () => Promise<void>
  readonly send: () => Promise<string | null>
  readonly on: (event: string, handler: (error: unknown) => void) => void
}

/** 构造一个用假 pg-boss 的队列；构造器里 createBoss 在子类字段之前执行，所以用闭包捕获。 */
function queueWith(boss: FakeBoss): PgBossQueue {
  class TestQueue extends PgBossQueue {
    protected override createBoss(): PgBoss {
      return boss as unknown as PgBoss
    }
  }
  const options: PgBossQueueOptions = { connectionString: 'postgres://unused' }
  return new TestQueue(options)
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}

describe('PgBossQueue start/stop 生命周期', () => {
  it('给定 boss.start 未完成当 dispose 则 stop 等启动落地后才执行，且带有限 graceful 超时', async () => {
    const starting = deferred()
    const startEntered = deferred()
    const stopCalls: { close?: boolean; graceful?: boolean; timeout?: number }[] = []
    const boss: FakeBoss = {
      events: new Map(),
      start: async () => { startEntered.resolve(); await starting.promise },
      stop: async options => { stopCalls.push(options ?? {}) },
      work: async () => {},
      createQueue: async () => {},
      send: async () => null,
      on: () => {},
    }
    const queue = queueWith(boss)
    const start = queue.start()
    await startEntered.promise
    const stop = queue.stop()
    await Promise.resolve()
    // 旧实现里 `started` 还是 false，stop 会直接返回；现在必须等 start 完成。
    expect(stopCalls).toEqual([])

    starting.resolve()
    await start
    await stop
    expect(stopCalls).toEqual([{ graceful: true, close: true, timeout: 3_000 }])
    // 关闭后迟到启动/入队被拒绝，不会把 worker 复活。
    await expect(queue.start()).rejects.toThrow(/已关闭/)
    await expect(queue.enqueue('omb.embed', {})).rejects.toThrow(/已关闭/)
  })

  it('给定重复 stop 当关闭则只调用一次 boss.stop', async () => {
    let stops = 0
    const boss: FakeBoss = {
      events: new Map(),
      start: async () => {},
      stop: async () => { stops += 1 },
      work: async () => {},
      createQueue: async () => {},
      send: async () => null,
      on: () => {},
    }
    const queue = queueWith(boss)
    await queue.start()
    await queue.stop()
    await queue.stop()
    expect(stops).toBe(1)
  })

  it('给定数据库重启踢连接当 boss error 事件则被消费且交给 logger，不穿透宿主', async () => {
    const handlers = new Map<string, (error: unknown) => void>()
    const errors: string[] = []
    const boss: FakeBoss = {
      events: handlers,
      start: async () => {},
      stop: async () => {},
      work: async () => {},
      createQueue: async () => {},
      send: async () => null,
      on: (event, handler) => { handlers.set(event, handler) },
    }
    class TestQueue extends PgBossQueue {
      protected override createBoss(): PgBoss {
        return boss as unknown as PgBoss
      }
    }
    const queue = new TestQueue({
      connectionString: 'postgres://unused',
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: message => { errors.push(message) },
      },
    })
    const errorHandler = handlers.get('error')
    expect(errorHandler).toBeDefined()
    expect(() => errorHandler?.(new Error('connection terminated'))).not.toThrow()
    expect(errors.some(line => line.includes('connection terminated'))).toBe(true)
    await queue.stop()
  })
})
