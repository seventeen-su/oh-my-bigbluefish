/**
 * 一次性初始化（数据库迁移、pg-boss、后台任务）的懒重试状态机。
 *
 * 为什么不是 `await ready` + `startupError`：DSH 的 `apply` 是同步组合根，
 * 插件加载时数据库可能还没起来；把首次失败永久缓存会让整个进程在数据库
 * 恢复后仍然不可用，必须重启 DSH 才能重新探测。这里的约定是：
 *
 * - 加载期只发起一次后台初始化，不阻塞宿主；
 * - 失败只记录“上一次错误”，下一次真实调用仍会重试；
 * - 同一时刻只有一个初始化在跑（单飞），避免并发迁移/重复注册队列；
 * - 失败后的普通调用有短暂冷却，防止每个工具调用都打数据库；
 * - `force` 供 `omb_status` 这类探针绕过冷却，立即反映真实恢复。
 */
export interface LazyInitializerOptions {
  readonly initialize: () => Promise<void>
  readonly cooldownMs?: number
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export class LazyInitializer {
  private ready = false
  private lastError: string | undefined
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<boolean> | undefined

  constructor(private readonly options: LazyInitializerOptions) {}

  get isReady(): boolean {
    return this.ready
  }

  get error(): string | undefined {
    return this.lastError
  }

  /**
   * 确保初始化完成。失败不会把状态永久钉死：调用方下一次仍可重试。
   * @param options.force - 绕过失败冷却（状态探针使用）。
   * @returns 初始化是否成功。
   */
  async ensureReady(options: { readonly force?: boolean } = {}): Promise<boolean> {
    if (this.ready) return true
    if (this.inflight !== undefined) return this.inflight
    const now = this.options.now?.() ?? Date.now()
    const cooldownMs = this.options.cooldownMs ?? 1_000
    if (options.force !== true && this.lastError !== undefined && now - this.lastAttemptAt < cooldownMs) {
      return false
    }
    this.lastAttemptAt = now
    // 先建立单飞 promise，再在微任务里启动 initialize：即使 initialize
    // 同步抛错，也不会留下一个已经结束却仍被当成 inflight 的 promise。
    const attempt = Promise.resolve().then(() => this.run())
    this.inflight = attempt
    try {
      return await attempt
    } finally {
      if (this.inflight === attempt) this.inflight = undefined
    }
  }

  private async run(): Promise<boolean> {
    try {
      await this.options.initialize()
      this.ready = true
      this.lastError = undefined
      return true
    } catch (error) {
      this.lastError = messageOf(error)
      try {
        this.options.onError?.(error)
      } catch {
        // 日志回调本身不能反过来让初始化失败。
      }
      return false
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
