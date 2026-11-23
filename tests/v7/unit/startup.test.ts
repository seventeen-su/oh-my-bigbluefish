import { describe, expect, it, vi } from 'vitest'
import { LazyInitializer } from '../../../plugin/v7/startup.js'

describe('LazyInitializer', () => {
  it('does not treat a failed first attempt as permanent', async () => {
    let now = 0
    let attempts = 0
    const initialize = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
    })
    const startup = new LazyInitializer({ initialize, cooldownMs: 1_000, now: () => now })

    expect(await startup.ensureReady()).toBe(false)
    expect(startup.error).toContain('ECONNREFUSED')

    // 冷却窗口内不重复打数据库。
    now = 500
    expect(await startup.ensureReady()).toBe(false)
    expect(initialize).toHaveBeenCalledTimes(1)

    // 冷却结束后，同一个实例重试并成功。
    now = 1_001
    expect(await startup.ensureReady()).toBe(true)
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(startup.isReady).toBe(true)
    expect(startup.error).toBeUndefined()
  })

  it('lets a status probe force a retry inside the cooldown', async () => {
    let now = 10
    let attempts = 0
    const initialize = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('database offline')
    })
    const startup = new LazyInitializer({ initialize, cooldownMs: 60_000, now: () => now })

    expect(await startup.ensureReady()).toBe(false)
    now = 11
    expect(await startup.ensureReady()).toBe(false)
    expect(initialize).toHaveBeenCalledTimes(1)

    expect(await startup.ensureReady({ force: true })).toBe(true)
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  it('single-flights concurrent attempts', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const initialize = vi.fn(() => gate)
    const startup = new LazyInitializer({ initialize })

    const first = startup.ensureReady()
    const second = startup.ensureReady()
    await Promise.resolve()
    expect(initialize).toHaveBeenCalledTimes(1)

    release?.()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('survives a synchronously throwing initializer without leaving an inflight promise', async () => {
    let attempts = 0
    const initialize = (() => {
      attempts += 1
      if (attempts === 1) throw new Error('synchronous failure')
      return Promise.resolve()
    }) as () => Promise<void>
    const startup = new LazyInitializer({ initialize, cooldownMs: 0 })

    expect(await startup.ensureReady()).toBe(false)
    expect(startup.error).toBe('synchronous failure')
    expect(await startup.ensureReady()).toBe(true)
    expect(attempts).toBe(2)
  })

  it('reports the error callback but stays retryable when the callback itself throws', async () => {
    let attempts = 0
    const onError = vi.fn(() => {
      throw new Error('logger failed')
    })
    const startup = new LazyInitializer({
      initialize: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('pg down')
      },
      cooldownMs: 0,
      onError,
    })

    expect(await startup.ensureReady()).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(await startup.ensureReady()).toBe(true)
  })
})
