import { describe, expect, it, vi } from 'vitest'
import { PostgresLifecycle, type CommandRunner } from '../../../packages/v7/src/adapters/postgres/lifecycle.js'

interface Recorded {
  file: string
  args: readonly string[]
}

function runner(responses: number[]): { calls: Recorded[]; run: CommandRunner } {
  const calls: Recorded[] = []
  return {
    calls,
    run: async (file, args) => {
      calls.push({ file, args })
      const code = responses.shift() ?? 0
      return { code, stdout: '', stderr: code === 0 ? '' : 'failed' }
    },
  }
}

describe('PostgresLifecycle', () => {
  it('外部已在运行时只探测，不启动也不停止', async () => {
    const fake = runner([0])
    const lifecycle = new PostgresLifecycle({ binDir: 'C:\\pg\\bin', dataDir: 'C:\\pg\\data' }, fake.run)
    await lifecycle.ensureStarted()
    await lifecycle.stop()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.args).toContain('status')
  })

  it('未运行时启动，且 dispose 只停止本插件启动的实例', async () => {
    const fake = runner([1, 0, 0])
    const lifecycle = new PostgresLifecycle({ binDir: '/pg/bin', dataDir: '/pg/data', logPath: '/pg/log', watchdog: false }, fake.run)
    await lifecycle.ensureStarted()
    await lifecycle.stop()
    await lifecycle.stop()
    expect(fake.calls.map(call => call.args[call.args.length - 1])).toEqual(['status', 'start', 'stop'])
    expect(fake.calls[1]?.args).toContain('/pg/log')
  })

  it('adoptExisting 会把已运行实例纳入生命周期并在 dispose 停止', async () => {
    const fake = runner([0, 0])
    const lifecycle = new PostgresLifecycle({ binDir: '/pg/bin', dataDir: '/pg/data', adoptExisting: true, watchdog: false }, fake.run)
    await lifecycle.ensureStarted()
    await lifecycle.stop()
    expect(fake.calls.map(call => call.args[call.args.length - 1])).toEqual(['status', 'stop'])
  })

  it('启动后挂 watchdog，dispose 时同时杀掉 watchdog', async () => {
    const fake = runner([1, 0, 0])
    const kill = vi.fn()
    const spawnWatchdog = vi.fn(() => ({ kill } as never))
    const lifecycle = new PostgresLifecycle({
      binDir: '/pg/bin', dataDir: '/pg/data',
      spawnWatchdog,
    }, fake.run)
    await lifecycle.ensureStarted()
    expect(spawnWatchdog).toHaveBeenCalledTimes(1)
    await lifecycle.stop()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('启动失败抛出可重试错误', async () => {
    const fake = runner([1, 1])
    const lifecycle = new PostgresLifecycle({ binDir: '/pg/bin', dataDir: '/pg/data' }, fake.run)
    await expect(lifecycle.ensureStarted()).rejects.toThrow(/PostgreSQL 启动失败/)
  })
})
