/**
 * 当地日历日与时区偏移。
 *
 * 为什么单独成文件：`compiler.ts` 的「今天/昨天/前天」是**日历日**语义，不是
 * `now - 24h`。UTC 日历日在 Asia/Shanghai 会错 8 小时，在有夏令时的时区还会错一小时；
 * 因此时区必须是显式 IANA 参数（计划里记录，见 `RetrievalPlan.time.timezone`），
 * 检索模块不读 `process.env.TZ`、也不用 `Date` 的宿主本地时区。
 *
 * 实现顺序：
 * 1. 运行时有 `Temporal` 时优先用它（`ZonedDateTime.startOfDay()` 直接给出当地日边界）；
 * 2. 否则用 `Intl.DateTimeFormat` 求时区偏移，再用「朴素墙钟 → 偏移修正 → 复核」两次迭代
 *    把当地日历日 00:00 解回真实时刻。DST 缺口（当地 00:00 不存在）取缺口之后第一个存在的
 *    当地时刻（与 Temporal 的 `compatible` 消歧一致）；DST 重叠（当地 00:00 出现两次）
 *    取较早的那一次。当前 Node（v24）不内置 Temporal，所以第 2 条是真实执行路径。
 */

/** 时区缺省值：显式 UTC。插件组合根会按宿主/配置传入真实时区，不在这里猜。 */
export const DEFAULT_TIME_ZONE = 'UTC'

const SECOND_MS = 1000

interface LocalDateParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

interface LocalClockParts extends LocalDateParts {
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/** 每个时区只建一次 formatter：编译一次计划要算 1–2 个日历日边界，避免重复构造。 */
function formatterOf(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  FORMATTERS.set(timeZone, created)
  return created
}

/** IANA 时区名是否可被当前运行时解析（`Intl` 对非法名抛 RangeError）。 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string') return false
  const trimmed = timeZone.trim()
  if (trimmed.length === 0 || trimmed !== timeZone) return false
  try {
    formatterOf(trimmed)
    return true
  } catch {
    return false
  }
}

function localClockParts(timeZone: string, epochMs: number): LocalClockParts {
  const parts = formatterOf(timeZone).formatToParts(new Date(epochMs))
  const valueOf = (type: string): number => {
    const found = parts.find(part => part.type === type)
    return found === undefined ? Number.NaN : Number(found.value)
  }
  const hour = valueOf('hour')
  return {
    year: valueOf('year'),
    month: valueOf('month'),
    day: valueOf('day'),
    // 个别实现在 hourCycle 边界仍给 24，取模归一到 0。
    hour: hour % 24,
    minute: valueOf('minute'),
    second: valueOf('second'),
  }
}

/** 该时刻在当地时区的日历日。 */
export function localDateAt(timeZone: string, epochMs: number): LocalDateParts {
  const parts = localClockParts(timeZone, epochMs)
  return { year: parts.year, month: parts.month, day: parts.day }
}

/** `epochMs` 时刻的当地时区偏移（ms，东为正）。 */
export function timeZoneOffsetMs(timeZone: string, epochMs: number): number {
  const parts = localClockParts(timeZone, epochMs)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  // Intl 只精确到秒：把锚点对齐到整秒再相减，避免毫秒被算进偏移。
  return asUtc - Math.floor(epochMs / SECOND_MS) * SECOND_MS
}

interface TemporalInstantLike {
  toZonedDateTimeISO(timeZone: string): TemporalZonedLike
}

interface TemporalZonedLike {
  startOfDay(): { readonly epochMilliseconds: number }
  subtract(duration: { readonly days: number }): TemporalZonedLike
}

interface TemporalLike {
  readonly Instant: { fromEpochMilliseconds(epochMs: number): TemporalInstantLike }
}

/**
 * Temporal 分支：只在运行时提供 Temporal 时走这里，任何异常都返回 undefined 回退 Intl，
 * 不让「更优实现」变成新的失败面。
 */
function temporalDayStartMs(timeZone: string, epochMs: number, daysAgo: number): number | undefined {
  const temporal = (globalThis as { readonly Temporal?: TemporalLike }).Temporal
  if (temporal === undefined) return undefined
  try {
    const instant = temporal.Instant.fromEpochMilliseconds(epochMs)
    const zoned = instant.toZonedDateTimeISO(timeZone)
    const shifted = daysAgo === 0 ? zoned : zoned.subtract({ days: daysAgo })
    const start = shifted.startOfDay().epochMilliseconds
    return Number.isFinite(start) ? start : undefined
  } catch {
    return undefined
  }
}

/**
 * 当地日历日 `year-month-day` 的 00:00 对应的真实时刻。
 *
 * 两步：先把墙钟当 UTC 得到朴素时刻 `naive`，再用 `naive` 与候选时刻的偏移各修正一次；
 * 偏移稳定则一步到位，不稳定（DST 切换恰在日界）时对两个候选做墙钟复核：
 * - 复核后墙钟 < 目标墙钟 = 该候选不在这天（缺口前的错误解），丢弃；
 * - 多个候选都落在目标墙钟 = 重叠，取较早的真实时刻。
 */
function zonedMidnightMs(timeZone: string, year: number, month: number, day: number): number {
  const naive = Date.UTC(year, month - 1, day)
  const firstOffset = timeZoneOffsetMs(timeZone, naive)
  const firstGuess = naive - firstOffset
  const secondOffset = timeZoneOffsetMs(timeZone, firstGuess)
  const candidates = secondOffset === firstOffset ? [firstGuess] : [firstGuess, naive - secondOffset]
  let best: number | undefined
  for (const candidate of candidates) {
    const wallMs = candidate + timeZoneOffsetMs(timeZone, candidate)
    if (wallMs < naive) continue
    if (best === undefined || candidate < best) best = candidate
  }
  return best ?? firstGuess
}

/**
 * 当地日历日 00:00（含 DST 缺口/重叠的正确消歧）。
 *
 * 例如 `Asia/Shanghai` 的 `2026-11-22T00:30:00Z` → `2026-11-21T16:00:00Z`（当地 22 日 08:30 → 22 日零点）。
 */
export function localDayStartMs(timeZone: string, epochMs: number): number {
  const temporal = temporalDayStartMs(timeZone, epochMs, 0)
  if (temporal !== undefined) return temporal
  const date = localDateAt(timeZone, epochMs)
  return zonedMidnightMs(timeZone, date.year, date.month, date.day)
}

/**
 * `daysAgo` 天前那个当地日历日的 00:00。
 *
 * 日历减法在「日期」上做（`Date.UTC(y, m-1, d - daysAgo)` 只取年月日），再按当地时间求零点；
 * 不是 `now - daysAgo * 24h`，所以跨 DST 的那一天是 23/25 小时也不会错。
 */
export function localDayStartDaysAgo(timeZone: string, epochMs: number, daysAgo: number): number {
  const days = Math.trunc(daysAgo)
  if (days === 0) return localDayStartMs(timeZone, epochMs)
  const temporal = temporalDayStartMs(timeZone, epochMs, days)
  if (temporal !== undefined) return temporal
  const date = localDateAt(timeZone, epochMs)
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day - days))
  return zonedMidnightMs(timeZone, shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}
