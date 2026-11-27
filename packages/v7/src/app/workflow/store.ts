import type { JsonValue } from '../../domain/json.js'
import type {
  WorkflowRecoveryReport,
  WorkflowRunSnapshot,
  WorkflowStats,
  WorkflowStepRecord,
} from './run.js'

/**
 * 持久工作流存储端口（`008_v7_expand.sql`、ARCHITECTURE-PLAN §4.3）。
 *
 * 语义约定：
 * - `start` 靠 `idempotency_key` 唯一约束幂等；重复 start 返回已有 run。
 * - `claimDue` 用 `FOR UPDATE SKIP LOCKED` 领取**到期**的 pending/running/waiting：
 *   崩溃的 running 在租约到期后自动可重领（启动恢复靠它），不做全表轮询。
 * - `beginStep` 幂等写 `(run_id, step, attempt)`；`completeStep` 在**同一事务**里
 *   写 step checkpoint 并推进 run（state/step/status），不存在“step 已 checkpoint 但 run 没推进”的半状态。
 * - `failStep` 记录失败原因并退避/终态；`failures` 只数该 step 的失败 attempt，用于重试上限。
 * - `compensateStep` 只把 completed 的 step 标成 compensated；补偿失败时不写，保留可重试痕迹。
 * - 所有终态/推进都用 `(run_id, attempt)` CAS；租约被接管后旧 worker 的写入返回 false。
 */

export interface WorkflowStartInput {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly state: JsonValue
  readonly step: string
  /** 同一幂等键只允许一个 run；重复 start 返回已有 run（不产生第二行）。 */
  readonly idempotencyKey: string
  /** 到期时间；缺省立即。未来时间落 `status='waiting'`，到期由运行时唤醒。 */
  readonly runAt?: Date
}

export interface WorkflowStartResult {
  readonly runId: string
  /** false 表示幂等键已存在，本次没有新建 run。 */
  readonly inserted: boolean
}

export interface WorkflowClaimOptions {
  readonly limit: number
  /** claim 租约；步骤超过它就可能被另一个 worker 重领，所以步骤必须幂等。 */
  readonly leaseMs: number
}

export interface WorkflowBeginStepInput {
  readonly runId: string
  readonly step: string
  readonly attempt: number
  readonly input: JsonValue
}

export interface WorkflowCompleteStepInput {
  readonly runId: string
  readonly step: string
  readonly attempt: number
  readonly state: JsonValue
  /** null 表示没有下一步：同一事务里把 run 置为 completed。 */
  readonly nextStep: string | null
  /** checkpoint 输出（`{ state, next }`），补偿与审计从这里读。 */
  readonly output: JsonValue
}

export interface WorkflowFailInput {
  readonly runId: string
  readonly step: string
  readonly attempt: number
  readonly error: string
  /** 退避重试的下次可领取时间；`dead` 时忽略。 */
  readonly retryAt?: Date
  /** true 直接终态；false 回到 pending 等退避。 */
  readonly dead?: boolean
}

export interface WorkflowFailResult {
  readonly applied: boolean
  /** 该 step 累计失败次数（含本次）；运行时用它判断是否达到重试上限。CAS 失败时为 0。 */
  readonly failures: number
}

export interface WorkflowCancelInput {
  readonly runId: string
  /** 当前持有者的代数：CAS 取消自己的 run；缺省只取消未被有效租约持有的 run。 */
  readonly attempt?: number
}

export interface WorkflowCompensateInput {
  readonly runId: string
  readonly step: string
  readonly attempt: number
}

export interface WorkflowReleaseInput {
  readonly runId: string
  readonly attempt: number
}

/** 没办法执行却仍要落死信：定义缺失/版本不匹配/未知 step/checkpoint 不一致。 */
export interface WorkflowAbandonInput {
  readonly runId: string
  readonly attempt: number
  readonly error: string
}

export interface WorkflowStore {
  start(input: WorkflowStartInput): Promise<WorkflowStartResult>
  get(runId: string): Promise<WorkflowRunSnapshot | undefined>
  steps(runId: string): Promise<readonly WorkflowStepRecord[]>
  claimDue(options: WorkflowClaimOptions): Promise<readonly WorkflowRunSnapshot[]>
  beginStep(input: WorkflowBeginStepInput): Promise<WorkflowStepRecord>
  /** 写 step checkpoint + 推进 run（单事务）；返回 false 表示 CAS 失败或 step 状态不允许。 */
  completeStep(input: WorkflowCompleteStepInput): Promise<boolean>
  failStep(input: WorkflowFailInput): Promise<WorkflowFailResult>
  compensateStep(input: WorkflowCompensateInput): Promise<boolean>
  /** 取消：带 attempt 是持有者自取消，不带 attempt 只取消未被有效租约持有的 run。 */
  cancel(input: WorkflowCancelInput): Promise<boolean>
  /** 人工重放死信：dead/failed → pending（attempts 不重置，避免无限重试）。 */
  retryRun(runId: string): Promise<boolean>
  /** 优雅停机：已 claim 但还没开始执行的 run 归还 pending，不必等租约过期。 */
  release(input: WorkflowReleaseInput): Promise<boolean>
  /** 无法继续执行（定义缺失/版本不匹配/未知 step/checkpoint 不一致）时落死信。 */
  abandon(input: WorkflowAbandonInput): Promise<boolean>
  /** 启动恢复：租约过期的 running → pending，并报告现在可领取的数量。 */
  recover(): Promise<WorkflowRecoveryReport>
  stats(): Promise<WorkflowStats>
  /** 下一次有 run 到期的时刻；运行时据此定时唤醒，不做固定轮询。 */
  nextDueAt(): Promise<string | undefined>
}

/** NOTIFY/LISTEN 之类只负责“叫醒”，不是队列本身。 */
export interface WorkflowWakeSource {
  subscribe(listener: () => void): () => void
}

/** app 层只需要窄 logger，不依赖具体宿主。 */
export interface WorkflowLogger {
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}
