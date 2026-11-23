export interface JobOptions {
  readonly singletonKey?: string
  readonly startAfter?: Date | string | number
  readonly retryLimit?: number
  readonly expireInSeconds?: number
}

/** 本进程观测到的一次 handler 异常；不代表 pg-boss 的最终失败或死信状态。 */
export interface JobHandlerFailure {
  readonly name: string
  /** 载荷的 JSON 摘要（已截断），用于定位是哪个任务的哪条数据。 */
  readonly payload: string
  readonly error: string
  /** ISO 时间；仅本进程内的观测时间。 */
  readonly at: string
  /** 第几次尝试（pg-boss 的 retryCount + 1）。重试会再次记录同一条任务。 */
  readonly attempt: number
  readonly jobId?: string
}

export interface JobHandlerFailureSummary {
  /** 本进程累计且尚未被同名任务后续成功清除的 handler 失败次数。 */
  readonly count: number
  /** 最近若干条未清除失败，新的在前。 */
  readonly recent: readonly JobHandlerFailure[]
}

/** 一次已耗尽重试的最终失败；可跨进程读取。 */
export interface JobFinalFailure {
  readonly jobId: string
  readonly name: string
  readonly payload: string
  readonly error: string
  readonly attempt: number
  readonly retryLimit: number
  /** ISO 时间；队列观测到最终失败的时间。 */
  readonly at: string
}

export interface JobFinalFailureSummary {
  /** 尚未被同名任务后续成功解除的最终失败数。 */
  readonly count: number
  /** 最近若干条未解除最终失败，新的在前。 */
  readonly recent: readonly JobFinalFailure[]
}

/** 最终失败日志端口；生产实现写审计表，测试可用内存实现。 */
export interface JobFailureLog {
  record(failure: JobFinalFailure): Promise<void>
  /**
   * 同名任务一次成功执行后解除此前未解除的最终失败。
   *
   * 旧失败仍保留在审计里，只标记为已恢复；没有实现该方法的测试替身不会改变
   * 历史行为。恢复写入失败不能反向把成功的任务变成失败。
   */
  recordRecovery?(name: string, at: string): Promise<void>
  summary(limit?: number): Promise<JobFinalFailureSummary>
}

export interface JobQueue {
  start(): Promise<void>
  stop(): Promise<void>
  enqueue(name: string, payload: unknown, options?: JobOptions): Promise<string | null>
  work(name: string, handler: (payload: unknown) => Promise<void>): Promise<void>
  /**
   * 本进程缓存的 handler 失败；只用于可观察性，不持久化。
   *
   * handler 抛错后异常仍会抛回 pg-boss，是否重试、何时进入死信由队列配置决定，
   * 这里的记录不能当成 pg-boss 的最终状态。
   */
  handlerFailures(): JobHandlerFailureSummary
  /** 跨进程的最终失败；没有配置持久日志时返回 0。 */
  finalFailures(limit?: number): Promise<JobFinalFailureSummary>
}

export interface Logger {
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}
