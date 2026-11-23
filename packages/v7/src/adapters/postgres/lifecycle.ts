import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface PostgresLifecycleOptions {
  /** pg_ctl 所在目录（不是 postgres.exe）。 */
  readonly binDir: string
  /** PostgreSQL data 目录。 */
  readonly dataDir: string
  readonly logPath?: string
  readonly port?: number
  readonly startTimeoutMs?: number
  readonly stopTimeoutMs?: number
  /** Ctrl+C / 进程异常退出时由 watchdog 收尾；测试可关。 */
  readonly watchdog?: boolean
  /** 启动时已由外部启动的实例也纳入生命周期（专用便携库可开）。 */
  readonly adoptExisting?: boolean
  readonly spawnWatchdog?: (parentPid: number, pgCtl: string, dataDir: string) => ChildProcess
}

export interface CommandRunner {
  (file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>
}

/** 独立的父进程存活看门狗；父进程（DSH）一退出就同步停止 PostgreSQL。 */
function defaultWatchdog(parentPid: number, pgCtl: string, dataDir: string): ChildProcess {
  const script = String.raw`
const { spawnSync } = require('node:child_process')
const [parentPid, pgCtl, dataDir] = process.argv.slice(1)
const alive = () => {
  try { process.kill(Number(parentPid), 0); return true } catch { return false }
}
const timer = setInterval(() => {
  if (alive()) return
  clearInterval(timer)
  spawnSync(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { timeout: 30000, windowsHide: true })
  process.exit(0)
}, 1000)
`
  const child = spawn(process.execPath, ['-e', script, String(parentPid), pgCtl, dataDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child
}

async function defaultRunner(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(file, [...args], { timeout: timeoutMs, windowsHide: true })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const record = error as { code?: number; stdout?: string; stderr?: string; message?: string }
    return {
      code: typeof record.code === 'number' ? record.code : 1,
      stdout: record.stdout ?? '',
      stderr: record.stderr ?? record.message ?? String(error),
    }
  }
}

/**
 * DSH 插件自有的 PostgreSQL 生命周期。
 *
 * 只在 `managePostgres: true` 且配置了 binDir/dataDir 时启用：
 * - 初始化前先 `pg_ctl status`，未运行则 `start -w`；
 * - 只有本插件真正启动的实例才在 dispose 时 `stop -m fast`，外部已运行的实例不碰；
 * - 失败返回错误，交给 LazyInitializer 在下次工具调用时重试，不永久缓存。
 */
export class PostgresLifecycle {
  private startedByUs = false
  private watchdog: ChildProcess | undefined
  private exitHook = false

  constructor(private readonly options: PostgresLifecycleOptions, private readonly runner: CommandRunner = defaultRunner) {}

  private get pgCtl(): string {
    return `${this.options.binDir.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}pg_ctl${process.platform === 'win32' ? '.exe' : ''}`
  }

  async ensureStarted(): Promise<void> {
    const status = await this.runner(this.pgCtl, ['-D', this.options.dataDir, 'status'], 10_000)
    if (status.code === 0) {
      if (this.options.adoptExisting === true) this.own()
      return
    }
    const args = ['-D', this.options.dataDir, '-w', '-t', String(Math.ceil((this.options.startTimeoutMs ?? 30_000) / 1000))]
    if (this.options.logPath !== undefined) args.push('-l', this.options.logPath)
    args.push('start')
    const started = await this.runner(this.pgCtl, args, this.options.startTimeoutMs ?? 30_000)
    if (started.code !== 0) {
      throw new Error(`PostgreSQL 启动失败（pg_ctl exit ${started.code}）：${started.stderr.trim() || started.stdout.trim()}`)
    }
    this.own()
  }

  private own(): void {
    if (this.startedByUs) return
    this.startedByUs = true
    if (this.options.watchdog !== false) {
      const spawnWatchdog = this.options.spawnWatchdog ?? defaultWatchdog
      this.watchdog = spawnWatchdog(process.pid, this.pgCtl, this.options.dataDir)
    }
    if (!this.exitHook) {
      this.exitHook = true
      // 正常 process.exit / 部分 SIGINT 路径仍会触发 exit；同步收尾是 watchdog 之外的第二道保险。
      process.once('exit', () => {
        if (!this.startedByUs) return
        spawnSync(this.pgCtl, ['-D', this.options.dataDir, '-m', 'fast', '-w', 'stop'], {
          timeout: this.options.stopTimeoutMs ?? 30_000,
          windowsHide: true,
        })
      })
    }
  }

  async stop(): Promise<void> {
    if (!this.startedByUs) return
    this.startedByUs = false
    try {
      this.watchdog?.kill()
    } catch {
      // watchdog 已退出。
    }
    this.watchdog = undefined
    const stopped = await this.runner(
      this.pgCtl,
      ['-D', this.options.dataDir, '-m', 'fast', '-w', '-t', String(Math.ceil((this.options.stopTimeoutMs ?? 30_000) / 1000)), 'stop'],
      this.options.stopTimeoutMs ?? 30_000,
    )
    if (stopped.code !== 0) {
      throw new Error(`PostgreSQL 停止失败（pg_ctl exit ${stopped.code}）：${stopped.stderr.trim() || stopped.stdout.trim()}`)
    }
  }
}
