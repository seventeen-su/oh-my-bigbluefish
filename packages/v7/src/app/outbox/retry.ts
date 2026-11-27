/**
 * outbox 失败的退避策略：纯函数，时间与随机都不在内部。
 *
 * attempts 是 outbox 行上已记录的失败次数；第一次失败产生 attempt=1。
 * 达到 maxAttempts 的那一次直接进死信，不再重试。
 */
export interface RetryPolicy {
  /** 最多失败次数（含最后那次死信）；`maxAttempts=1` 表示第一次失败就死信。 */
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly factor: number
  readonly maxDelayMs: number
}

export type RetryPlan =
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: 'dead'; readonly attempt: number }

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  factor: 4,
  maxDelayMs: 60_000,
}

export function normalizeRetryPolicy(policy: RetryPolicy): RetryPolicy {
  const maxAttempts = Math.max(1, Math.trunc(policy.maxAttempts))
  const baseDelayMs = Math.max(0, Math.trunc(policy.baseDelayMs))
  const factor = Math.max(1, policy.factor)
  const maxDelayMs = Math.max(baseDelayMs, Math.trunc(policy.maxDelayMs))
  return { maxAttempts, baseDelayMs, factor, maxDelayMs }
}

/**
 * 给定失败前的 attempts，决定下一次是退避重试还是进死信。
 * 退避不做随机抖动：抖动需要可注入的随机源，收益（惊群）在单库 outbox 上不成立。
 */
export function planAttempt(policy: RetryPolicy, attempts: number): RetryPlan {
  const normalized = normalizeRetryPolicy(policy)
  const attempt = Math.max(1, Math.trunc(attempts) + 1)
  if (attempt >= normalized.maxAttempts) return { kind: 'dead', attempt }
  const delayMs = Math.min(
    normalized.maxDelayMs,
    Math.round(normalized.baseDelayMs * normalized.factor ** (attempt - 1)),
  )
  return { kind: 'retry', attempt, delayMs }
}
