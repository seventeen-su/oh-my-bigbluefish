/**
 * 正则安全执行的预算常量（R3）。
 *
 * 这些是跨模块可观测的上限：store 用 `REGEX_TIMEOUT_MS` 对齐召回预算，单测断言
 * 静态拒绝阈值。执行器/类型在 `regex-types.ts` 与 `regex.ts`。
 */

/** 单条正则的 CPU 上限（毫秒）。 */
export const REGEX_TIMEOUT_MS = 50
/** 单次 match 调用的总预算（毫秒）；正常候选远低于它，恶意候选不能把一次召回拖垮。 */
export const REGEX_MAX_TOTAL_MS = 100
/** 匹配输入上限（字符）；超长查询不做正则匹配，避免把 CPU 交给不可控输入。 */
export const REGEX_MAX_INPUT_CHARS = 16_384
/** 单条正则源码上限（字符）。 */
export const REGEX_MAX_SOURCE_CHARS = 2_048
/** 单次最多评估多少条候选正则（与 store 的候选上限对齐）。 */
export const REGEX_MAX_CANDIDATES = 500
/** 同一服务内最多同时执行多少个 QuickJS 正则任务。 */
export const REGEX_MAX_CONCURRENCY = 4
/** 并发上限之外的等待队列长度；超过直接 busy。 */
export const REGEX_QUEUE_LIMIT = 8
/** 静态复杂度快速拒绝：量词超过该数量直接拒绝。 */
export const REGEX_MAX_QUANTIFIERS = 64
