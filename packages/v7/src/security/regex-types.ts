/**
 * 正则安全执行的请求/结果契约（R3）。
 *
 * 所有异常（超时/非法/busy/引擎错误）都用 `RegexMatchResult` 表达，不向宿主抛异常；
 * 预算常量在 `regex-limits.ts`，执行器在 `regex.ts`。
 */

export interface RegexCandidate {
  /** 调用方用来把结果映射回候选行的稳定 id（同一批里应唯一）。 */
  readonly id: string
  readonly source: string
  readonly flags?: string
}

export interface RegexMatchRequest {
  readonly input: string
  readonly candidates: readonly RegexCandidate[]
  /** 单条正则的 CPU 上限；缺省 50ms，传更大值也会被压到 50ms。 */
  readonly timeoutMs?: number
}

export type RegexRejectReason =
  | 'empty-source'
  | 'source-too-long'
  | 'invalid-flags'
  | 'too-complex'
  | 'invalid-source'
  | 'engine-error'

export interface RegexRejectedCandidate {
  readonly id: string
  readonly reason: RegexRejectReason
  readonly detail?: string
}

export type RegexMatchStatus = 'ok' | 'timeout' | 'busy' | 'invalid-input' | 'engine-error'

export interface RegexMatchResult {
  readonly status: RegexMatchStatus
  /** 命中的候选 id，按候选输入顺序；超时前已完成的命中仍保留。 */
  readonly matchedIds: readonly string[]
  /** 被静态检查或沙箱拒绝的候选；单个候选出错不影响其它候选。 */
  readonly rejected: readonly RegexRejectedCandidate[]
  /** 撞到 CPU/总预算的候选 id（通常是最后一条）。 */
  readonly timedOutIds: readonly string[]
  /** 本次调用的真实耗时（毫秒，含排队）。 */
  readonly durationMs: number
  readonly reason?: string
}

export interface RegexServiceOptions {
  /** 覆盖并发上限（默认 4，最小 1）。 */
  readonly maxConcurrent?: number
  /** 覆盖等待队列上限（默认 8，最小 0）。 */
  readonly queueLimit?: number
}
