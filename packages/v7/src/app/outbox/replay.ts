/**
 * 死信（outbox.status='dead'）的读取与人工重放端口。
 *
 * 与 relay 的派发端口分开：relay 的热路径只 claim/complete/fail，死信运维面
 * （`omb_status` 读数 + `omb_admin replay`）不需要也不应该影响派发循环的形状。
 *
 * 重放语义（对应 `adapters/postgres/outbox.ts` 的 CAS SQL）：
 * - 只匹配 `status='dead'` 的行；已 done/pending 的行不会因为重复 replay 再产生一次副作用；
 * - 重置 `attempts=0`、`available_at=now()`、`claimed_at=null`，让行按全新事件重新投递；
 * - `last_error` 保留到下一次投递结果覆盖：重放后仍能追查它为什么进过死信；
 * - 用 `FOR UPDATE SKIP LOCKED` + `(status, attempts)` 条件做 CAS：并发 replay 同一条行
 *   只有一个事务真正把它移回 pending；
 * - 真正发生重放时在同一事务里写一条 `action='outbox-replay'` 的运维审计，
 *   没有行被重放（重复 replay / 条件不匹配）时不写审计，重复调用幂等。
 */

/** 一条死信行的快照；`lastError` 就是它为什么进死信。 */
export interface OutboxDeadRow {
  /** `omb.outbox.id`。 */
  readonly id: number
  /** `omb.audit_log.id`。 */
  readonly eventId: number
  readonly topic: string
  /** 进入死信前累计的失败次数。 */
  readonly attempts: number
  readonly lastError: string
  readonly createdAt: string
}

export interface OutboxDeadSummary {
  /** 全库统计口径的 dead 行总数，不是本次返回的行数。 */
  readonly count: number
  /** 最近进死信的行（按 id 升序截断到 limit）。 */
  readonly rows: readonly OutboxDeadRow[]
}

/**
 * 重放条件：`id` 与 `topic` 二选一（都缺省时不匹配任何行，由调用方校验并报 invalid-input）。
 * `limit` 是单次重放上限，调用方负责把它限制在运维可接受的范围内。
 */
export interface OutboxReplayInput {
  readonly id?: number
  readonly topic?: string
  readonly limit: number
  /** 审计 actor，例如 `model`。 */
  readonly actor: string
  /** 审计里的原因；`omb_admin` 的 reason 原样落库。 */
  readonly reason?: string
}

export interface OutboxReplayResult {
  /** 本次真正从 dead 回到 pending 的行（带重放前的 attempts/lastError）。 */
  readonly replayed: readonly OutboxDeadRow[]
  /**
   * 重放后仍匹配同一条件的 dead 行数：`>0` 表示本次上限不够或有行被并发事务占用，
   * 再调用一次 replay 即可继续；`0` 表示该条件下已经没有 dead 行。
   */
  readonly remaining: number
}

/** 死信读取 + 重放入口；`omb_status` 与 `omb_admin replay` 共用。 */
export interface OutboxReplayStore {
  deadSummary(limit: number): Promise<OutboxDeadSummary>
  replayDead(input: OutboxReplayInput): Promise<OutboxReplayResult>
}
