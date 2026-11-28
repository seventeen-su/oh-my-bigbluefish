import { readFile } from 'node:fs/promises'
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

/** 可控 Promise：测试用事件/闸门同步，不用 sleep 等时序。 */
function deferred<T = void>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

/** 记录每一步的最后一个参数（status/start/stop），便于断言顺序。 */
function stepOf(call: Recorded): string {
  return call.args[call.args.length - 1] ?? ''
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

describe('PostgresLifecycle 并发与状态机', () => {
  it('给定 pg_ctl start 还没返回当 dispose 则停止排在启动之后并必然执行', async () => {
    const startEntered = deferred()
    const releaseStart = deferred()
    const calls: string[] = []
    const run: CommandRunner = async (_file, args) => {
      const step = args[args.length - 1] ?? ''
      calls.push(step)
      if (step === 'status') return { code: 1, stdout: '', stderr: 'no server running' }
      if (step === 'start') {
        startEntered.resolve()
        await releaseStart.promise
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const lifecycle = new PostgresLifecycle({ binDir: '/pg/bin', dataDir: '/pg/data', watchdog: false }, run)
    const starting = lifecycle.ensureStarted()
    await startEntered.promise
    const stopping = lifecycle.stop()
    await Promise.resolve()
    // stop 必须等启动落地，不能在 start 返回前抢先执行（否则会停到半启动实例）。
    expect(calls).toEqual(['status', 'start'])

    releaseStart.resolve()
    await starting
    await stopping
    expect(calls).toEqual(['status', 'start', 'stop'])
    expect(lifecycle.status()).toMatchObject({ state: 'stopped', managed: false })
  })

  it('给定 stop 之后旧代再 ensureStarted 则拒绝，不把已关闭的库重新拉起', async () => {
    const fake = runner([1, 0, 0])
    const lifecycle = new PostgresLifecycle({ binDir: '/pg/bin', dataDir: '/pg/data', watchdog: false }, fake.run)
    const oldGeneration = lifecycle.status().generation
    await lifecycle.stop()
    await expect(lifecycle.ensureStarted(oldGeneration)).rejects.toThrow(/代 .* 已失效/)
    // 新代仍可启动：组件重新开启时由进程池的新 handle 触发。
    await lifecycle.ensureStarted()
    expect(lifecycle.status()).toMatchObject({ state: 'running', managed: true })
    await lifecycle.stop()
    expect(fake.calls.map(stepOf)).toEqual(['status', 'start', 'stop'])
  })

  it('给定 pg_ctl stop 失败但实例仍在运行则保留 running 并抛出，重试成功后才 stopped', async () => {
    let stopAttempts = 0
    const calls: string[] = []
    const run: CommandRunner = async (_file, args) => {
      const step = args[args.length - 1] ?? ''
      calls.push(step)
      if (step === 'status') {
        // 第一次探测未运行；stop 失败后的复核仍在运行；第二次 stop 成功后不再探测。
        const code = stopAttempts === 0 ? 1 : 0
        return { code, stdout: '', stderr: code === 0 ? '' : 'no server running' }
      }
      if (step === 'start') return { code: 0, stdout: '', stderr: '' }
      stopAttempts += 1
      return stopAttempts === 1
        ? { code: 1, stdout: '', stderr: 'stop failed' }
        : { code: 0, stdout: '', stderr: '' }
    }
    const lifecycle = new PostgresLifecycle({ binDir: '/pg/bin', dataDir: '/pg/data', watchdog: false }, run)
    await lifecycle.ensureStarted()
    await expect(lifecycle.stop()).rejects.toThrow(/PostgreSQL 停止失败/)
    expect(lifecycle.status()).toMatchObject({ state: 'running', managed: true })

    await lifecycle.stop()
    expect(lifecycle.status()).toMatchObject({ state: 'stopped', managed: false })
    expect(calls.filter(step => step === 'stop')).toHaveLength(2)
  })

  it('给定 pg_ctl 不可用当 probe 则报 unknown 而不是 stopped', async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'spawn pg_ctl ENOENT' })
    const lifecycle = new PostgresLifecycle({ binDir: '/pg/bin', dataDir: '/pg/data', watchdog: false }, run)
    await expect(lifecycle.probe()).resolves.toBe('unknown')
  })

  it('给定 pg_ctl status 成功/报告未运行当 probe 则分别报 running/stopped', async () => {
    const running = new PostgresLifecycle(
      { binDir: '/pg/bin', dataDir: '/pg/data', watchdog: false },
      async () => ({ code: 0, stdout: '', stderr: '' }),
    )
    await expect(running.probe()).resolves.toBe('running')
    const stopped = new PostgresLifecycle(
      { binDir: '/pg/bin', dataDir: '/pg/data', watchdog: false },
      async () => ({ code: 3, stdout: '', stderr: 'no server running' }),
    )
    await expect(stopped.probe()).resolves.toBe('stopped')
  })

  it('给定默认 watchdog 源码则用 stdin EOF 事件，不含 setInterval 轮询', async () => {
    const source = await readFile(
      new URL('../../../packages/v7/src/adapters/postgres/lifecycle.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/\bsetInterval\s*\(/)
    expect(source).toMatch(/stdio: \['pipe', 'ignore', 'ignore'\]/)
    expect(source).toMatch(/ELECTRON_RUN_AS_NODE/)
    expect(source).toMatch(/process\.stdin\.once\('end', stop\)/)
    // argv 顺序：execPath 之后先是 parentPid，再是 pgCtl/dataDir；解构必须跳过 parentPid。
    expect(source).toMatch(/const \[, pgCtl, dataDir\] = process\.argv\.slice\(1\)/)
  })
})
