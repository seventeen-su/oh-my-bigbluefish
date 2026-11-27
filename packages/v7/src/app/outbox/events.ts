import type { JsonValue } from '../../domain/json.js'

/**
 * outbox 事件/存储端口。
 *
 * 语义约定（对应 ARCHITECTURE-PLAN §4.2）：
 * - `append` 与 writer 的命令写在同一 PostgreSQL 事务里；`event_id` 唯一，重复 append 被吸收。
 * - `claim` 用 `FOR UPDATE SKIP LOCKED` 批量领取到期行，并把 `available_at` 推到租约到期时间；
 *   进程崩溃后租约到期即可被其它 worker 重领。
 * - 投递语义是 at-least-once：完成/失败都用 `(id, attempts)` 做 CAS，租约过期后同一条事件
 *   可能被再次派发，所以 reaction 必须用 `eventId`/`commandId` 自行幂等。
 */

/** 已 claim、等待派发的一条 outbox 记录。 */
export interface OutboxEvent {
  /** `omb.outbox.id`（bigserial）。 */
  readonly id: number
  /** `omb.audit_log.id`：同一事件只入队一次。 */
  readonly eventId: number
  readonly topic: string
  readonly payload: JsonValue
  /** claim 前累计的失败次数；complete/fail 用它做 CAS，避免覆盖另一个 worker 的结果。 */
  readonly attempts: number
  readonly createdAt: string
  /** 本行下一次可被 claim 的时刻：租约内是租约到期时间，退避时是重试时间。 */
  readonly availableAt: string
}

export interface OutboxAppendInput {
  readonly eventId: number
  readonly topic: string
  readonly payload: JsonValue
  /** 默认 `now()`；只有补投/测试需要显式指定。 */
  readonly availableAt?: Date
}

export interface OutboxAppendResult {
  readonly id: number
  /** false 表示 `event_id` 已存在，重复 append 没有产生第二行。 */
  readonly inserted: boolean
}

/**
 * 不透明事务句柄：app 只把它转交给适配器，不解释其类型。
 * writer 在写事务里调用 `append(input, client)`，outbox 行随业务写一起提交/回滚。
 */
export type OutboxTransaction = unknown

export interface OutboxClaimOptions {
  readonly limit: number
  readonly leaseMs: number
}

export interface OutboxFailureInput {
  readonly id: number
  /** claim 时看到的 attempts；与行上不一致说明租约已被别人接管，CAS 失败。 */
  readonly expectedAttempts: number
  readonly error: string
  /** true 直接进死信；否则回到 pending 并在 `retryAt` 之后可重领。 */
  readonly dead?: boolean
  readonly retryAt?: Date
}

export interface OutboxStats {
  /** 尚未被领取的行数。 */
  readonly pending: number
  /** 已领取、租约未到期的行数。 */
  readonly claimed: number
  /**
   * 已到期但尚未投递完成的最老事件年龄（毫秒）。
   * 只看 `pending` 或租约已过期（`available_at <= now()`）的 `claimed` 行：
   * 正在租约内的行属于正常在途，不算 lag。
   */
  readonly oldestAgeMs: number
}

/** writer 在同一事务里追加、relay 只从这里读；适配器实现负责 SQL。 */
export interface OutboxStore {
  append(input: OutboxAppendInput, tx?: OutboxTransaction): Promise<OutboxAppendResult>
  claim(options: OutboxClaimOptions): Promise<readonly OutboxEvent[]>
  /** 成功投递；返回 false 表示 CAS 失败（行已被接管或已不是 claimed）。 */
  complete(id: number, expectedAttempts: number): Promise<boolean>
  /** 记录失败：退避重试或直接死信。返回 false 表示 CAS 失败。 */
  fail(input: OutboxFailureInput): Promise<boolean>
  /** 已 claim 但未派发就 stop 时归还，避免等租约过期才恢复。 */
  release(id: number, expectedAttempts: number): Promise<boolean>
  stats(): Promise<OutboxStats>
  /**
   * reconciliation 安全网：只数“已到期、且创建早于 grace 的 pending 行”。
   * 它不是主路径，正常投递只依赖 NOTIFY/显式 wake；用于兜底丢失的唤醒。
   */
  stalePendingCount(olderThanMs: number): Promise<number>
}

/** NOTIFY/LISTEN 之类只负责“叫醒”，不是队列本身。 */
export interface OutboxWakeSource {
  subscribe(listener: () => void): () => void
}

/** app 层只需要窄 logger，不依赖具体宿主。 */
export interface OutboxLogger {
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}
