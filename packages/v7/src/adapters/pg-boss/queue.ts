import { PgBoss } from 'pg-boss'
import type {
  JobFailureLog,
  JobFinalFailureSummary,
  JobHandlerFailure,
  JobHandlerFailureSummary,
  JobOptions,
  JobQueue,
  Logger,
} from '../../ports/jobs.js'

/** 最近失败最多保留多少条，避免长期运行时无界增长。 */
const RECENT_FAILURE_LIMIT = 10
/** 状态行里单条摘要的最大长度。 */
const SUMMARY_LIMIT = 240
/** 我们自己入队时的默认重试上限；队列配置与任务元数据都以此为准。 */
const DEFAULT_RETRY_LIMIT = 3
const EMPTY_FINAL_FAILURES: JobFinalFailureSummary = { count: 0, recent: [] }

function summarize(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    // 循环引用等无法 JSON 化的载荷仍要留下可读摘要，不能因为记录失败而再抛。
    text = String(value)
  }
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > SUMMARY_LIMIT ? `${oneLine.slice(0, SUMMARY_LIMIT - 1)}…` : oneLine
}

export interface PgBossQueueOptions {
  readonly connectionString: string
  readonly schema?: string
  readonly logger?: Logger
  /** 跨进程最终失败日志；缺省时只保留本进程观测。 */
  readonly failureLog?: JobFailureLog
}

export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss
  private readonly handlers = new Map<string, (payload: unknown) => Promise<void>>()
  private readonly registered = new Set<string>()
  private readonly registering = new Map<string, Promise<void>>()
  private readonly queues = new Set<string>()
  private readonly retryLimits = new Map<string, number>()
  private started = false
  private startPromise: Promise<void> | undefined
  /**
   * handler 异常的内存记录：只覆盖本进程，进程重启即丢失，也不持久化到 PostgreSQL。
   *
   * pg-boss 12 的事件只有 error/warning/wip/stopped/bam/flow，没有逐任务的最终
   * 失败或死信事件；handler 抛错后是否重试、何时进入死信由队列配置决定。因此这
   * 里只命名为 handler failure，不冒充 pg-boss 的最终状态。同名任务后续成功会
   * 清掉该名称的进程内失败，避免一次可恢复的异常让状态永久 degraded。
   */
  private readonly failureCounts = new Map<string, number>()
  private readonly recentFailures: JobHandlerFailure[] = []

  constructor(private readonly options: PgBossQueueOptions) {
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema ?? 'pgboss',
      application_name: 'omb-v7-worker',
    })
    // pg-boss 的 Db 会把连接级错误转发到 PgBoss 的 'error' 事件。EventEmitter
    // 在没有任何 error 监听器时会直接把异常抛成 uncaughtException；数据库重启
    // 或管理员终止连接时，这会让整个 DSH 进程退出。队列错误只应记录并等待
    // 下一次 start()/enqueue() 重试，不能穿透宿主。
    this.boss.on('error', error => {
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger?.error(`pg-boss 错误（队列将重试）：${message}`)
    })
  }

  async start(): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    const attempt = (async () => {
      // pg-boss 允许在同一实例上重试 start()；失败时不能把 started 置真。
      if (!this.started) {
        await this.boss.start()
        this.started = true
      }
      // 启动成功后仍要补注册：上一次可能已经连上数据库，但在 work() 阶段失败。
      for (const name of this.handlers.keys()) await this.register(name)
    })()
    this.startPromise = attempt
    try {
      await attempt
    } finally {
      if (this.startPromise === attempt) this.startPromise = undefined
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    try {
      await this.boss.stop({ graceful: true, close: true })
    } finally {
      this.started = false
      // 再 start() 时 pg-boss 的 worker 已经不存在，必须重新 work()。
      this.registered.clear()
    }
  }

  async enqueue(name: string, payload: unknown, options: JobOptions = {}): Promise<string | null> {
    await this.start()
    await this.ensureQueue(name)
    const retryLimit = options.retryLimit ?? this.retryLimits.get(name) ?? DEFAULT_RETRY_LIMIT
    this.retryLimits.set(name, retryLimit)
    const data = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : { value: payload }
    return this.boss.send(name, data, {
      ...(options.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
      retryLimit,
      ...(options.expireInSeconds !== undefined ? { expireInSeconds: options.expireInSeconds } : {}),
    })
  }

  async work(name: string, handler: (payload: unknown) => Promise<void>): Promise<void> {
    this.handlers.set(name, handler)
    if (this.started) await this.register(name)
  }

  handlerFailures(): JobHandlerFailureSummary {
    const count = [...this.failureCounts.values()].reduce((sum, value) => sum + value, 0)
    return { count, recent: this.recentFailures.map(failure => ({ ...failure })) }
  }

  async finalFailures(limit = 5): Promise<JobFinalFailureSummary> {
    if (this.options.failureLog === undefined) return EMPTY_FINAL_FAILURES
    return this.options.failureLog.summary(limit)
  }

  private async recordHandlerFailure(
    name: string,
    job: { readonly id?: string; readonly data?: unknown; readonly retryCount?: number },
    error: unknown,
  ): Promise<void> {
    this.failureCounts.set(name, (this.failureCounts.get(name) ?? 0) + 1)
    const attempt = typeof job.retryCount === 'number' && Number.isFinite(job.retryCount) ? job.retryCount + 1 : 1
    const failure: JobHandlerFailure = {
      name,
      payload: summarize(job.data),
      error: summarize(error instanceof Error ? error.message : error),
      at: new Date().toISOString(),
      attempt,
      ...(typeof job.id === 'string' ? { jobId: job.id } : {}),
    }
    this.recentFailures.unshift(failure)
    if (this.recentFailures.length > RECENT_FAILURE_LIMIT) this.recentFailures.length = RECENT_FAILURE_LIMIT

    const retryLimit = await this.retryLimitOf(name, job.id)
    // 只有真正耗尽重试的那一次才写持久最终失败；中间重试仍由 pg-boss 接管。
    if (retryLimit === undefined || attempt <= retryLimit || this.options.failureLog === undefined) return
    try {
      await this.options.failureLog.record({
        jobId: typeof job.id === 'string' ? job.id : 'unknown',
        name,
        payload: failure.payload,
        error: failure.error,
        attempt,
        retryLimit,
        at: failure.at,
      })
    } catch (recordError) {
      // 审计写失败不能再掩盖原始 handler 异常；状态行会显示持久日志不可用。
      this.options.logger?.error(
        `最终失败审计写入失败：${name}`,
        recordError instanceof Error ? recordError.message : recordError,
      )
    }
  }

  private async recordHandlerSuccess(name: string): Promise<void> {
    this.failureCounts.delete(name)
    for (let index = this.recentFailures.length - 1; index >= 0; index -= 1) {
      if (this.recentFailures[index]?.name === name) this.recentFailures.splice(index, 1)
    }
    const log = this.options.failureLog
    if (log?.recordRecovery === undefined) return
    try {
      await log.recordRecovery(name, new Date().toISOString())
    } catch (recoveryError) {
      // 恢复日志写失败不能把一次成功任务反向变成失败；下一次成功会再尝试。
      this.options.logger?.error(
        `最终失败恢复记录写入失败：${name}`,
        recoveryError instanceof Error ? recoveryError.message : recoveryError,
      )
    }
  }

  /**
   * 解析本次尝试对应的重试上限。
   *
   * pg-boss 传给 work handler 的 Job 没有 retryLimit；先问 getJobById 拿权威值，
   * 失败时退回本进程入队时记录的值。两个来源都没有时不猜，避免把中间重试误报为最终失败。
   */
  private async retryLimitOf(name: string, jobId: string | undefined): Promise<number | undefined> {
    if (jobId !== undefined) {
      const getJobById = (this.boss as unknown as {
        getJobById?: (queue: string, id: string) => Promise<{ retryLimit?: number } | null>
      }).getJobById
      if (typeof getJobById === 'function') {
        try {
          const job = await getJobById.call(this.boss, name, jobId)
          if (typeof job?.retryLimit === 'number' && Number.isFinite(job.retryLimit)) return job.retryLimit
        } catch {
          // 元数据查询失败不是 handler 失败；只影响最终失败判定，退回本地记录。
        }
      }
    }
    return this.retryLimits.get(name)
  }

  private async ensureQueue(name: string): Promise<void> {
    if (this.queues.has(name)) return
    const retryLimit = this.retryLimits.get(name) ?? DEFAULT_RETRY_LIMIT
    await this.boss.createQueue(name, { retryLimit })
    this.retryLimits.set(name, retryLimit)
    this.queues.add(name)
  }

  private async register(name: string): Promise<void> {
    if (this.registered.has(name)) return
    const existing = this.registering.get(name)
    if (existing !== undefined) return existing
    const attempt = (async () => {
      await this.ensureQueue(name)
      await this.boss.work(name, async jobs => {
        for (const job of jobs) {
          try {
            await this.handlers.get(name)?.(job.data)
            await this.recordHandlerSuccess(name)
          } catch (error) {
            // 先记录再记日志，最后原样抛回：pg-boss 需要这个拒绝来决定重试/失败，
            // 不能吞错；记录只用于本进程的状态查询。
            await this.recordHandlerFailure(name, job, error)
            this.options.logger?.error(`后台任务失败：${name}`, error)
            throw error
          }
        }
      })
      // 只有 work() 真正成功后才标记，否则下一次 start()/work() 不会补注册。
      this.registered.add(name)
    })()
    this.registering.set(name, attempt)
    try {
      await attempt
    } finally {
      if (this.registering.get(name) === attempt) this.registering.delete(name)
    }
  }
}
