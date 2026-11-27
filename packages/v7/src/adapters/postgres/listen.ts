import pg from 'pg'

/**
 * LISTEN 连接的共享实现（outbox/timer/projection 三个 notifier 共用）。
 *
 * NOTIFY 需要专用连接：连接池里的短连接会频繁换人，LISTEN 注册不上去。这个模块把
 * “一条专用连接 + 断线恢复”收成一个深模块，三个适配器只提供 channel/application_name：
 *
 * - 连接被服务端终止/数据库重启后，按指数退避用**单次** `setTimeout` 重连（没有 setInterval）；
 * - 重连成功会重新 `LISTEN`，然后依次触发 `onReconnect` 监听器（组合根做一次有界对账）
 *   与普通订阅者（relay/worker 的 `wake()`，它们在正常循环里补做一次有界 catch-up）；
 * - `status()` 暴露 connected/reconnects/connectAttempts，组合根把读数放进 `omb_status`。
 *
 * 纪律：这里只负责“叫醒”，不承载队列语义、不重放漏掉的通知。漏掉的唤醒由重连唤醒 +
 * 有界对账兜底，绝不做固定轮询。
 */

/** 首次重连等待；之后每次失败翻倍。 */
export const RECONNECT_BASE_DELAY_MS = 250
/** 退避上限：再久也按这个间隔持续尝试，不停摆也不打爆数据库。 */
export const RECONNECT_MAX_DELAY_MS = 30_000

/**
 * 指数退避：`attempt` 是已连续失败的次数（0 → 基线，1 → 2×，2 → 4×…），到上限后持平。
 * 负数/NaN 回落到基线：`setTimeout(NaN)` 会被当成 1ms，等于把退避变成忙等。
 */
export function reconnectDelayMs(
  attempt: number,
  baseMs = RECONNECT_BASE_DELAY_MS,
  maxMs = RECONNECT_MAX_DELAY_MS,
): number {
  const base = Number.isFinite(baseMs) ? Math.max(1, Math.trunc(baseMs)) : RECONNECT_BASE_DELAY_MS
  const max = Number.isFinite(maxMs) ? Math.max(base, Math.trunc(maxMs)) : RECONNECT_MAX_DELAY_MS
  const failures = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0
  // 2 ** 40 已经远超任何上限；夹住指数避免溢出成 Infinity。
  const delay = base * 2 ** Math.min(failures, 40)
  return Math.min(max, Math.max(1, delay))
}

/** `omb_status` 读取的连接读数；计数都是本进程累计。 */
export interface ListenNotifierStatus {
  readonly channel: string
  readonly connected: boolean
  /** 本进程成功建立的**额外**连接次数（首次连接不算重连）。 */
  readonly reconnects: number
  /** 本进程发起过的连接尝试次数（含首次与每次退避重试）。 */
  readonly connectAttempts: number
  readonly lastError?: string
  readonly lastConnectedAt?: string
}

export interface ListenNotifierConfig {
  readonly connectionString: string
  readonly channel: string
  readonly applicationName: string
  readonly connectionTimeoutMillis?: number
  readonly reconnectBaseMs?: number
  readonly reconnectMaxMs?: number
}

/**
 * 一条会自动重连的 LISTEN 连接。
 *
 * 生命周期：`ready()`（启动期同步建立，失败抛出交给懒初始化重试）→ 正常订阅 →
 * `close()`。连接在运行期断开时不会被当成致命错误：标记断开、安排一次退避重连，
 * 重连成功后唤醒所有订阅者。
 */
export class PostgresListenNotifier {
  private client: pg.Client | undefined
  private connecting: Promise<void> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private consecutiveFailures = 0
  private reconnects = 0
  private connectAttempts = 0
  private everConnected = false
  private closed = false
  private lastError: string | undefined
  private lastConnectedAt: string | undefined
  private readonly listeners = new Set<() => void>()
  private readonly reconnectListeners = new Set<() => void>()

  constructor(private readonly config: ListenNotifierConfig) {}

  get channel(): string {
    return this.config.channel
  }

  status(): ListenNotifierStatus {
    return {
      channel: this.config.channel,
      connected: this.client !== undefined,
      reconnects: this.reconnects,
      connectAttempts: this.connectAttempts,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastConnectedAt === undefined ? {} : { lastConnectedAt: this.lastConnectedAt }),
    }
  }

  /** 等待 LISTEN 真正注册完成；启动期用它把“没连上”变成可重试的初始化失败。 */
  async ready(): Promise<void> {
    this.cancelPendingReconnect()
    await this.ensureConnected()
  }

  /**
   * 普通订阅者（relay/worker 的 `wake`）：NOTIFY 与**重连成功**都会唤醒它。
   * 订阅时顺带确保连接正在建立；首次失败不抛出，由退避接管（调用方还有有界对账兜底）。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    void this.ensureConnected().catch(() => {
      // 连接失败不阻塞调用方启动；退避重连与有界对账负责恢复。
    })
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 重连成功回调：组合根用它做一次有界 reconcile（不是轮询）。可重复注销。 */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener)
    return () => {
      this.reconnectListeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.cancelPendingReconnect()
    this.listeners.clear()
    this.reconnectListeners.clear()
    const client = this.client
    this.client = undefined
    if (client !== undefined) await client.end().catch(() => {})
  }

  private cancelPendingReconnect(): void {
    const timer = this.reconnectTimer
    this.reconnectTimer = undefined
    if (timer !== undefined) clearTimeout(timer)
  }

  private ensureConnected(): Promise<void> {
    if (this.client !== undefined) return Promise.resolve()
    if (this.connecting !== undefined) return this.connecting
    if (this.closed) return Promise.reject(new Error(`LISTEN ${this.config.channel} 已关闭`))
    // 手动重试优先于已排定的退避：清掉定时器，避免同一时刻出现两条连接。
    this.cancelPendingReconnect()
    const connecting = this.open()
    this.connecting = connecting
    void connecting.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.connecting !== connecting) return
      this.connecting = undefined
      // 这次尝试失败（client 仍未就绪）时排下一次退避；成功路径不排任何定时器。
      if (!this.closed && this.client === undefined) this.scheduleReconnect()
    })
    return connecting
  }

  private scheduleReconnect(): void {
    if (this.closed || this.client !== undefined) return
    if (this.reconnectTimer !== undefined || this.connecting !== undefined) return
    const delay = reconnectDelayMs(
      this.consecutiveFailures,
      this.config.reconnectBaseMs,
      this.config.reconnectMaxMs,
    )
    this.consecutiveFailures += 1
    const timer = setTimeout(() => {
      if (this.reconnectTimer === timer) this.reconnectTimer = undefined
      if (this.closed) return
      void this.ensureConnected().catch(() => {
        // 失败会在 ensureConnected 的 finally 里安排下一轮退避。
      })
    }, delay)
    // 退避等待中的定时器不能拖住宿主进程退出（与 timer worker 的单次定时器同款处理）。
    timer.unref?.()
    this.reconnectTimer = timer
  }

  private async open(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis ?? 5_000,
      application_name: this.config.applicationName,
    })
    this.connectAttempts += 1
    let lost = false
    /** 连接丢失（'error'/'end'）：只处理一次，避免两个事件各安排一次重连。 */
    const drop = (error?: Error): void => {
      if (lost) return
      lost = true
      if (error !== undefined) this.lastError = errorMessage(error)
      const wasCurrent = this.client === client
      if (wasCurrent) this.client = undefined
      void client.end().catch(() => {})
      // 已发布的连接断开：立即安排退避重连。
      // 尚未发布的连接失败：open() 的 reject 会走 ensureConnected 的 finally。
      if (wasCurrent && !this.closed) this.scheduleReconnect()
    }
    client.on('notification', message => {
      if (message.channel !== this.config.channel) return
      this.dispatch(this.listeners)
    })
    // 'error' 必须被消费：pg 的未处理 error 事件会变成宿主的 uncaughtException。
    client.on('error', (error: Error) => drop(error))
    client.on('end', () => drop())
    try {
      await client.connect()
      await client.query(`listen ${this.config.channel}`)
    } catch (error) {
      lost = true
      await client.end().catch(() => {})
      throw error
    }
    if (this.closed || lost) {
      await client.end().catch(() => {})
      throw new Error(`LISTEN ${this.config.channel} 连接在就绪前已关闭`)
    }
    this.client = client
    this.consecutiveFailures = 0
    this.lastError = undefined
    this.lastConnectedAt = new Date().toISOString()
    if (this.everConnected) {
      this.reconnects += 1
      // 断线期间可能漏掉 NOTIFY：先让组合根做一次有界对账，再唤醒正常循环补做 catch-up。
      this.dispatch(this.reconnectListeners)
      this.dispatch(this.listeners)
    } else {
      this.everConnected = true
    }
  }

  private dispatch(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 单个订阅者异常不能影响其它订阅者，也不能把错误抛进 pg 的事件循环。
      }
    }
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const text = message.replace(/\s+/g, ' ').trim()
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`
}
