import { describe, expect, it } from 'vitest'
import {
  ManagedPostgresPool,
  managedKey,
  type ManagedLifecycle,
} from '../../../packages/v7/src/adapters/postgres/managed.js'
import type {
  PostgresLifecycleStatus,
  PostgresProbe,
} from '../../../packages/v7/src/adapters/postgres/lifecycle.js'

/**
 * 进程池的替身：只记录 start/stop 与代，行为与 `PostgresLifecycle` 的串行状态机一致
 * （stop 先让代 +1，再异步停机）。
 */
class FakeLifecycle implements ManagedLifecycle {
  generation = 0
  starts = 0
  stops = 0
  stopGate: Promise<void> | undefined
  stopFailure: Error | undefined
  probeResult: PostgresProbe = 'stopped'
  state: PostgresLifecycleStatus['state'] = 'unknown'

  async ensureStarted(generation: number = this.generation): Promise<void> {
    if (generation !== this.generation) throw new Error(`旧代 ${generation} 已失效`)
    this.starts += 1
    this.state = 'running'
  }

  async stop(): Promise<void> {
    this.generation += 1
    this.stops += 1
    this.state = 'stopping'
    if (this.stopGate !== undefined) await this.stopGate
    if (this.stopFailure !== undefined) {
      this.state = 'running'
      throw this.stopFailure
    }
    this.state = 'stopped'
  }

  status(): PostgresLifecycleStatus {
    return { state: this.state, managed: this.state === 'running', generation: this.generation }
  }

  async probe(): Promise<PostgresProbe> {
    return this.probeResult
  }
}

function poolWith(fake: FakeLifecycle): ManagedPostgresPool {
  return new ManagedPostgresPool(() => fake)
}

const OPTIONS = { binDir: '/pg/bin', dataDir: '/pg/data' }

describe('ManagedPostgresPool', () => {
  it('给定同一 dataDir 两个 handle 当逐个 release 则最后一个才停', async () => {
    const fake = new FakeLifecycle()
    const pool = poolWith(fake)
    const first = pool.acquire(OPTIONS)
    const second = pool.acquire(OPTIONS)
    await first.ensureStarted()
    await second.ensureStarted()
    expect(fake.starts).toBe(2)

    await first.release()
    expect(fake.stops).toBe(0)
    await second.release()
    expect(fake.stops).toBe(1)
    expect((await first.status()).refs).toBe(0)
  })

  it('给定 handle 已释放当迟到的 ensureStarted 则拒绝，不能把已关闭实例重新拉起', async () => {
    const fake = new FakeLifecycle()
    const pool = poolWith(fake)
    const handle = pool.acquire(OPTIONS)
    await handle.ensureStarted()
    await handle.release()
    await expect(handle.ensureStarted()).rejects.toThrow(/已释放/)
    expect(fake.starts).toBe(1)
  })

  it('给定 release 重复调用当释放则只停一次', async () => {
    const fake = new FakeLifecycle()
    const pool = poolWith(fake)
    const handle = pool.acquire(OPTIONS)
    await handle.ensureStarted()
    await handle.release()
    await handle.release()
    expect(fake.stops).toBe(1)
  })

  it('给定 stop 期间新 acquire 当 stop 完成则新代可以重新启动', async () => {
    const fake = new FakeLifecycle()
    const gate = { resolve: (): void => {} }
    fake.stopGate = new Promise<void>(resolve => { gate.resolve = resolve })
    const pool = poolWith(fake)
    const first = pool.acquire(OPTIONS)
    await first.ensureStarted()
    const releasing = first.release()
    // stop 已经让代 +1，但还没完成；此时新组件实例 acquire 到新代。
    const second = pool.acquire(OPTIONS)
    expect((await second.status()).probe).toBe('stopped')
    gate.resolve()
    await releasing
    await second.ensureStarted()
    expect(fake.starts).toBe(2)
    expect(fake.stops).toBe(1)
    await second.release()
  })

  it('给定 stop 失败当 release 则抛错并保留引用计数，下一次 acquire 可重试', async () => {
    const fake = new FakeLifecycle()
    fake.stopFailure = new Error('stop failed')
    const pool = poolWith(fake)
    const handle = pool.acquire(OPTIONS)
    await handle.ensureStarted()
    await expect(handle.release()).rejects.toThrow(/stop failed/)
    expect(fake.stops).toBe(1)
    // 失败后 slot 仍在，下一次 acquire 拿到的仍是同一个生命周期，release 会再次尝试。
    fake.stopFailure = undefined
    const retry = pool.acquire(OPTIONS)
    await retry.ensureStarted()
    await retry.release()
    expect(fake.stops).toBe(2)
  })

  it('给定 Windows 路径大小写与尾分隔符不同当 acquire 则复用同一个池项', async () => {
    expect(managedKey('/pg/data/')).toBe(managedKey('/pg/data'))
    if (process.platform !== 'win32') return
    expect(managedKey('C:\\PG\\Data')).toBe(managedKey('c:\\pg\\data\\'))
  })
})
