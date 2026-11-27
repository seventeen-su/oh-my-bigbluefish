import type { JsonValue } from '../../domain/json.js'

/**
 * 持久工作流的状态/快照契约（`008_v7_expand.sql` 的 workflow_run/step）。
 *
 * attempt 是 **claim 代数**：每次 claim `workflow_run.attempts + 1`。complete/fail/cancel
 * 都用 `(run_id, attempt)` 做 CAS——租约过期的旧 worker 写结果会失败，不会覆盖新持有者。
 */

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'dead'
  | 'cancelled'

export type WorkflowStepStatus = 'running' | 'completed' | 'failed' | 'compensated'

/** run 快照；与 `omb.workflow_run` 的列语义一一对应。 */
export interface WorkflowRunSnapshot {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly state: JsonValue
  /** 下一个要执行的步骤名；null 只在终态出现。 */
  readonly step: string | null
  readonly status: WorkflowRunStatus
  /** claim 代数，complete/fail/cancel 的 CAS 依据。 */
  readonly attempts: number
  /** 下一次可被 claim 的时刻；running 时是租约到期时间。 */
  readonly nextRunAt?: string
  readonly lastError?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** claim 返回的快照与普通快照同形；单独命名是为了让调用方代码区分“已持有租约”。 */
export type ClaimedWorkflowRun = WorkflowRunSnapshot

/** 一条步骤 checkpoint 记录（checkpoint 日志 + 补偿依据）。 */
export interface WorkflowStepRecord {
  readonly runId: string
  readonly step: string
  readonly attempt: number
  readonly status: WorkflowStepStatus
  /** 步骤执行前的 state。 */
  readonly input?: JsonValue
  /** checkpoint 写入的 `{ state, next }`；只对 completed/compensated 有意义。 */
  readonly output?: JsonValue
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly compensatedAt?: string
}

/** 启动恢复结果：`recovered` 是租约过期被拉回 pending 的 run；`due` 是现在可领取的 run 数。 */
export interface WorkflowRecoveryReport {
  readonly recovered: number
  readonly due: number
}

export interface WorkflowStats {
  readonly pending: number
  readonly running: number
  readonly waiting: number
  readonly completed: number
  readonly failed: number
  readonly dead: number
  readonly cancelled: number
  /** 已到期仍未领取的最老 run 年龄（毫秒）；lease 内的 running 不算 lag。 */
  readonly oldestDueAgeMs: number
}
