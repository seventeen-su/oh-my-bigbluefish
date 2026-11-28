import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * `pg_ctl status` 的观测口径。
 *
 * `stopped` 只代表“命令成功执行且报告未运行”；命令本身不可用（pg_ctl 缺失、权限
 * 拒绝）不能冒充 stopped，否则 `omb_status` 会把坏配置报成健康。
 */
export type PostgresProbe = 'running' | 'stopped' | 'unknown'

/** 生命周期的稳定状态；`starting`/`stopping` 只在单个操作的观察窗口内出现。 */
export type PostgresLifecycleState = 'unknown' | 'stopped' | 'starting' | 'running' | 'stopping'

export interface PostgresLifecycleStatus {
  readonly state: PostgresLifecycleState
  /** 本实例是否对 PostgreSQL 的停止负责（自己启动或 adoptExisting 纳入）。 */
  readonly managed: boolean
  /** 代：每次 `stop()` +1；旧代迟到的 `ensureStarted` 会被拒绝。 */
  readonly generation: number
  readonly lastError?: string
}

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

/** 探针与普通命令的上界。 */
const PROBE_TIMEOUT_MS = 10_000
/** watchdog 自己的 pg_ctl stop 上界；父进程已死，不该再拖住。 */
const WATCHDOG_STOP_TIMEOUT_MS = 20_000

/**
 * 父进程存活看门狗：子进程读父进程持有的 stdin 管道，**父进程消失时管道 EOF**
 * 就是唯一信号——没有 setInterval，也没有任何周期检查。
 *
 * 正常 dispose 会先 kill 子进程再 `pg_ctl stop`，所以 EOF 路径只在父进程异常退出
 * （崩溃 / SIGKILL）时触发，作为 `process.once('exit')` 之外的第二道保险。
 */
function defaultWatchdog(parentPid: number, pgCtl: string, dataDir: string): ChildProcess {
  const script = String.raw`
const { spawnSync } = require('node:child_process')
// argv: [execPath, parentPid, pgCtl, dataDir] -> slice(1) 后跳过 parentPid。
const [, pgCtl, dataDir] = process.argv.slice(1)
let stopped = false
const stop = () => {
  if (stopped) return
  stopped = true
  // 父进程已不在，任何异常都只能吞掉；同步等待让 pg_ctl 有机会完成 fast shutdown。
  spawnSync(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', '-t', '10', 'stop'], {
    timeout: ${WATCHDOG_STOP_TIMEOUT_MS},
    windowsHide: true,
  })
  process.exit(0)
}
// 读端必须保持活跃，否则父进程存活时子进程会因空事件循环退出；父进程死亡 -> EOF。
process.stdin.resume()
process.stdin.once('end', stop)
process.stdin.once('close', stop)
process.stdin.once('error', stop)
`
  const child = spawn(process.execPath, ['-e', script, String(parentPid), pgCtl, dataDir], {
    detached: true,
    // stdin 是父子之间的存活信号；父进程退出时 OS 关闭写端，子进程收到 EOF。
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    // Electron 宿主的 process.execPath 是 electron.exe；没有这个变量时 `-e` 不会按 Node 执行。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
  const stdin = child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null
  stdin?.unref?.()
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
 * 进程退出时的同步兜底集合。
 *
 * 只有使用默认 runner 的实例才会进入这里：测试注入假 runner 时，exit 钩子不应
 * 真的去 spawnSync 一个假路径。集合按实例去重，热重载不会叠加监听器。
 */
const exitBacked = new Set<PostgresLifecycle>()
let exitHookInstalled = false

function trackExitBacked(lifecycle: PostgresLifecycle): void {
  exitBacked.add(lifecycle)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const instance of [...exitBacked]) {
      try {
        instance.stopSync()
      } catch {
        // exit 路径没有调用方可处理；watchdog 是最后一道保险。
      }
    }
  })
}

/**
 * DSH 插件自有的 PostgreSQL 生命周期。
 *
 * 只在 `managePostgres: true` 且配置了 binDir/dataDir 时启用：
 * - 初始化前先 `pg_ctl status`，未运行则 `start -w`；
 * - `adoptExisting: true` 时把已在运行的专用实例也纳入；
 * - 只有本实例负责的实例才在 stop 时 `stop -m fast`，外部已运行的实例不碰；
 * - 失败返回错误，交给 LazyInitializer 在下次工具调用时重试，不永久缓存。
 *
 * 并发语义（这是关闭开关时最容易漏掉的部分）：
 * - 所有状态变更经同一条串行队列，`ensureStarted` 与 `stop` 不会交错；
 * - `stop` 如果排在启动后面，会等启动落地后再停；启动如果排在 stop 后面，
 *   会等 stop 完成后再启动；
 * - 每次 `stop()` 让代 +1。旧代迟到的 `ensureStarted(generation)` 直接拒绝，
 *   避免“dispose 之后 boot 的异步初始化把库重新拉起来”；
 * - `stop` 是幂等的：已停再停不会重复调用 pg_ctl。
 */
export class PostgresLifecycle {
  private state: PostgresLifecycleState = 'unknown'
  private owned = false
  private generation = 0
  private lastError: string | undefined
  private watchdog: ChildProcess | undefined
  /** 串行队列：每个状态变更都排在前一个之后，失败不阻断后续。 */
  private tail: Promise<void> = Promise.resolve()
  private readonly exitBacked: boolean

  constructor(private readonly options: PostgresLifecycleOptions, private readonly runner: CommandRunner = defaultRunner) {
    this.exitBacked = runner === defaultRunner
  }

  private get pgCtl(): string {
    return `${this.options.binDir.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}pg_ctl${process.platform === 'win32' ? '.exe' : ''}`
  }

  private get probeTimeoutMs(): number {
    return Math.min(PROBE_TIMEOUT_MS, this.options.startTimeoutMs ?? PROBE_TIMEOUT_MS)
  }

  private get stopArgs(): readonly string[] {
    return [
      '-D', this.options.dataDir,
      '-m', 'fast',
      '-w',
      '-t', String(Math.ceil((this.options.stopTimeoutMs ?? 30_000) / 1000)),
      'stop',
    ]
  }

  /** 同步状态快照；不跑外部命令，因此 `omb_status` 另有真实 `probe()`。 */
  status(): PostgresLifecycleStatus {
    return {
      state: this.state,
      managed: this.owned,
      generation: this.generation,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /** 真实 `pg_ctl status` 探测；命令不可用时返回 unknown，不把坏配置报成 stopped。 */
  async probe(): Promise<PostgresProbe> {
    try {
      const result = await this.runner(this.pgCtl, ['-D', this.options.dataDir, 'status'], this.probeTimeoutMs)
      if (result.code === 0) return 'running'
      const detail = `${result.stderr}\n${result.stdout}`.toLowerCase()
      if (detail.includes('enoent') || detail.includes('not found') || detail.includes('not recognized')) return 'unknown'
      return 'stopped'
    } catch {
      return 'unknown'
    }
  }

  /**
   * 确保实例运行。
   * @param generation - 调用方所属代；旧代（stop 之后）的迟到调用会被拒绝。
   */
  ensureStarted(generation: number = this.generation): Promise<void> {
    return this.enqueue(async () => {
      if (generation !== this.generation) {
        throw new Error(`PostgreSQL 生命周期代 ${generation} 已失效（当前 ${this.generation}），拒绝迟到的启动`)
      }
      await this.startOnce()
    })
  }

  /** 停止并把代 +1；幂等，且总是排在已排队的启动之后。 */
  stop(): Promise<void> {
    this.generation += 1
    return this.enqueue(() => this.stopOnce())
  }

  /** 进程退出时的同步兜底：只处理自己负责的默认 runner 实例。 */
  stopSync(): void {
    if (!this.exitBacked) return
    this.killWatchdog()
    if (!this.owned) {
      exitBacked.delete(this)
      return
    }
    try {
      spawnSync(this.pgCtl, [...this.stopArgs], {
        timeout: this.options.stopTimeoutMs ?? 30_000,
        windowsHide: true,
      })
    } catch {
      // 退出路径没有调用方可处理；watchdog 会再试一次。
    }
    this.owned = false
    this.state = 'stopped'
    exitBacked.delete(this)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  private async startOnce(): Promise<void> {
    if (this.state === 'running') return
    this.state = 'starting'
    this.lastError = undefined
    try {
      const status = await this.runner(this.pgCtl, ['-D', this.options.dataDir, 'status'], this.probeTimeoutMs)
      if (status.code === 0) {
        // 已运行：adoptExisting 才接管；否则只观察，dispose 时不为外部实例负责。
        if (this.options.adoptExisting === true) this.own()
        this.state = 'running'
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
      this.state = 'running'
    } catch (error) {
      this.state = 'stopped'
      this.lastError = messageOf(error)
      throw error
    }
  }

  private async stopOnce(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'unknown') {
      this.killWatchdog()
      this.owned = false
      this.state = 'stopped'
      if (this.exitBacked) exitBacked.delete(this)
      return
    }
    this.state = 'stopping'
    this.killWatchdog()
    if (!this.owned) {
      // 外部实例：不停止，也不假装自己停过。
      this.state = 'stopped'
      if (this.exitBacked) exitBacked.delete(this)
      return
    }
    const stopped = await this.runner(this.pgCtl, [...this.stopArgs], this.options.stopTimeoutMs ?? 30_000)
    if (stopped.code === 0) {
      this.finishStopped()
      return
    }
    // stop 非零不一定是失败：实例可能已被用户/服务端提前停掉。用 status 复核，
    // 只有仍在运行时才保留 running 状态并抛出，供 teardown 报告真实失败。
    const still = await this.runner(this.pgCtl, ['-D', this.options.dataDir, 'status'], this.probeTimeoutMs)
      .catch(() => undefined)
    if (still !== undefined && still.code === 0) {
      this.state = 'running'
      const error = new Error(
        `PostgreSQL 停止失败（pg_ctl exit ${stopped.code}）：${stopped.stderr.trim() || stopped.stdout.trim()}`,
      )
      this.lastError = error.message
      throw error
    }
    this.finishStopped()
  }

  private finishStopped(): void {
    this.owned = false
    this.lastError = undefined
    this.state = 'stopped'
    if (this.exitBacked) exitBacked.delete(this)
  }

  private own(): void {
    if (this.owned) return
    this.owned = true
    if (this.options.watchdog !== false && this.watchdog === undefined) {
      try {
        const spawnWatchdog = this.options.spawnWatchdog ?? defaultWatchdog
        this.watchdog = spawnWatchdog(process.pid, this.pgCtl, this.options.dataDir)
      } catch (error) {
        // watchdog 是异常退出兜底，不是启动前置条件：记录但不让插件不可用。
        this.lastError = `watchdog 启动失败：${messageOf(error)}`
      }
    }
    if (this.exitBacked) trackExitBacked(this)
  }

  private killWatchdog(): void {
    const watchdog = this.watchdog
    this.watchdog = undefined
    if (watchdog === undefined) return
    try {
      // 先关管道再 kill：即使子进程忽略信号，EOF 也会让它走 stop 路径。
      watchdog.stdin?.destroy()
      watchdog.kill()
    } catch {
      // watchdog 已退出。
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
