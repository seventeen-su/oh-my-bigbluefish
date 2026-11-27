import type {
  ClaimedProjectionTask,
  ProjectionEnqueueInput,
  ProjectionEnqueueResult,
  ProjectionLag,
  ProjectionName,
  ProjectionTaskState,
  ProjectionTransaction,
  ProjectionWatermark,
} from './types.js'

/**
 * 投影队列 + 水位的存储端口（ARCHITECTURE-PLAN §4.4、CONCURRENCY §4.4）。
 *
 * 语义约定：
 * - `enqueue` 与 writer 的业务写在同一事务里（`tx` 由 writer 传入）；
 *   同一 `(entity_id, projection)` 只有一行，新 revision 覆盖旧行并重置重试状态。
 * - `claim` 用 `FOR UPDATE SKIP LOCKED` 按 projection 批量领取到期行，把 `available_at`
 *   推到租约到期时间；进程崩溃后租约到期即可被其它 worker 重领（启动恢复靠它）。
 * - `complete`/`fail`/`release` 用 `(entity_id, projection, attempts)` 做 CAS；租约被接管后
 *   旧 worker 的写入失败，不会覆盖新 worker 的结果。
 * - `advanceWatermark` 只由 worker 在投影**成功之后**调用，且必须单调不减。
 */
export interface ProjectionClaimOptions {
  readonly projection: ProjectionName
  readonly limit: number
  readonly leaseMs: number
}

export interface ProjectionFailureInput {
  readonly task: ClaimedProjectionTask
  readonly error: string
  /** true 直接进死信；否则回到 pending 并在 `retryAt` 之后可重领。 */
  readonly dead?: boolean
  readonly retryAt?: Date
}

export interface ProjectionTaskStore {
  enqueue(input: ProjectionEnqueueInput, tx?: ProjectionTransaction): Promise<ProjectionEnqueueResult>
  claim(options: ProjectionClaimOptions): Promise<readonly ClaimedProjectionTask[]>
  /** 成功投影；返回 false 表示 CAS 失败（租约已被接管或已不是 claimed）。 */
  complete(task: ClaimedProjectionTask): Promise<boolean>
  /** 记录失败：退避重试或直接死信。返回 false 表示 CAS 失败。 */
  fail(input: ProjectionFailureInput): Promise<boolean>
  /** 已 claim 但未投影就 stop 时归还，避免等租约过期才恢复。 */
  release(task: ClaimedProjectionTask): Promise<boolean>
  /**
   * 推进水位。实现必须满足 `new > old` 才写入（单调不减），返回是否真的改变。
   * 只在投影成功后调用——失败/未完成绝不能让水位前进。
   */
  advanceWatermark(projection: ProjectionName, watermark: string): Promise<boolean>
  watermark(projection: ProjectionName): Promise<ProjectionWatermark | undefined>
  watermarks(): Promise<readonly ProjectionWatermark[]>
  /** 全部投影的 lag（含没有任务/没有水位的投影）。 */
  lag(): Promise<readonly ProjectionLag[]>
  /** read-your-writes：这一版是否已被该投影处理过。 */
  taskState(entityId: string, projection: ProjectionName): Promise<ProjectionTaskState | undefined>
}
