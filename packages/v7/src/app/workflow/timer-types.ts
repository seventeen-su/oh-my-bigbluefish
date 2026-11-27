import type { JsonValue } from '../../domain/json.js'

/**
 * Timer 的公共契约（ARCHITECTURE-PLAN §4.3、ADR-0011）。
 *
 * Timer 只服务“真正需要时间”的动作（到期提醒、衰减、软删除），不是全表扫描/固定节拍：
 * - `due_at` 上有部分索引 `timer_due (status, due_at) where status in ('pending','claimed')`；
 * - worker 用 `FOR UPDATE SKIP LOCKED` 只领取 `due_at <= now()` 的行；
 * - `schedule` 提交后 `pg_notify('omb_timer')` 叫醒空闲 worker；有未来到期 timer 时
 *   worker 只 arm 一个到 `nextDueAt` 的单次定时器，不做 10 分钟轮询。
 *
 * 幂等：同一 `dedupe_key` 再 schedule 是**重排期**（覆盖 due_at/payload/attempts），不是第二行；
 * 取消按行 id 或 dedupe_key 把 pending/claimed 行置为 cancelled，之后不会再被 claim。
 *
 * at-least-once：claim 有租约，进程崩溃后 `due_at`（租约到期）会重新到期被领取；
 * complete/fail 用 `(id, attempts)` 做 CAS，被接管的旧 worker 写结果会失败。
 */

export type TimerStatus = 'pending' | 'claimed' | 'done' | 'dead' | 'cancelled'

/** 已 claim、等待派发的一条 timer。 */
export interface TimerTask {
  readonly id: number
  readonly topic: string
  readonly payload: JsonValue
  /** 本行下一次可被 claim 的时刻：租约内是租约到期时间，退避时是重试时间。 */
  readonly dueAt: string
  /** claim 前累计的失败次数；complete/fail 用它做 CAS。 */
  readonly attempts: number
  readonly dedupeKey?: string
}

export interface TimerScheduleInput {
  readonly topic: string
  readonly payload: JsonValue
  readonly dueAt: Date
  /** 业务去重键（如 `decay:<entityId>`）：同键重排期而不是新增一行。 */
  readonly dedupeKey?: string
}

export interface TimerScheduleResult {
  readonly id: number
  /** false 表示同一 dedupe_key 已存在，本次只重排期。 */
  readonly inserted: boolean
  readonly dueAt: string
}

export interface TimerClaimOptions {
  readonly limit: number
  readonly leaseMs: number
}

export interface TimerFailureInput {
  readonly id: number
  /** claim 时看到的 attempts；与行上不一致说明租约已被接管，CAS 失败。 */
  readonly expectedAttempts: number
  readonly error: string
  /** true 直接进死信；否则回到 pending 并在 retryAt 之后可重领。 */
  readonly dead?: boolean
  readonly retryAt?: Date
}

export interface TimerCancelInput {
  readonly id?: number
  readonly dedupeKey?: string
}

export interface TimerStats {
  readonly pending: number
  readonly claimed: number
  readonly done: number
  readonly dead: number
  readonly cancelled: number
  /** 已到期仍未处理的最老 timer 年龄（毫秒）。 */
  readonly oldestDueAgeMs: number
}

/**
 * Timer 存储端口。
 *
 * `schedule` 可在业务事务里调用（`tx` 由 writer 传入）：timer 行与业务写一起提交/回滚，
 * 并在同一事务里发 NOTIFY——回滚时提示也一起消失，不会提前叫醒 worker。
 */
export interface TimerStore {
  schedule(input: TimerScheduleInput, tx?: unknown): Promise<TimerScheduleResult>
  /** 取消 pending/claimed 的 timer；返回 false 表示没有可取消的行（已 done/dead/cancelled）。 */
  cancel(input: TimerCancelInput): Promise<boolean>
  claimDue(options: TimerClaimOptions): Promise<readonly TimerTask[]>
  complete(id: number, expectedAttempts: number): Promise<boolean>
  fail(input: TimerFailureInput): Promise<boolean>
  /** 已 claim 但未派发就 stop 时归还，避免等租约过期才恢复。 */
  release(id: number, expectedAttempts: number): Promise<boolean>
  /** 下一次到期的时刻；没有 pending/claimed 行时 undefined（worker 无限等待 NOTIFY）。 */
  nextDueAt(): Promise<string | undefined>
  stats(): Promise<TimerStats>
}

export interface TimerContext {
  readonly timerId: number
  readonly topic: string
  /** 本次是第几次执行（1 起）；同一 timer 的重复派发共享同一个 commandId。 */
  readonly attempt: number
  /** 重放稳定的幂等键：`timer:<dedupeKey>` 或 `timer:<id>`；副作用必须据此去重。 */
  readonly commandId: string
  readonly now: Date
  readonly signal: AbortSignal
}

export interface TimerHandler {
  readonly topic: string
  run(task: TimerTask, ctx: TimerContext): Promise<void>
}

/** NOTIFY/LISTEN 之类只负责“叫醒”，不是队列本身。 */
export interface TimerWakeSource {
  subscribe(listener: () => void): () => void
}

export interface TimerLogger {
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}
