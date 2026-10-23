/**
 * 记忆活动日志（v4.11.0）：**有界、进程内、只读展示**的最近活动面。
 *
 * 为什么需要它：用户排障时只能看到"最终状态"，看不到"刚才到底写了什么、被去重了几次、
 * 哪一步升级/弃权了"。`omb_status` 之前只有累计计数，没有带时间的最近事件。
 *
 * 边界（刻意）：
 * - **不落盘**：活动是诊断读数，不是审计（审计在 `memory_confirm` / `memory_feedback`）；
 * - **有界**：环形最多 `ACTIVITY_LOG_MAX` 条，超出按插入序淘汰；detail 截断；
 * - **不含原文**：只记 id/动作/原因类别，避免把记忆正文复制到第二个地方；
 * - 计数是**累计**的（淘汰不影响 summary）；errors 单独计数，不静默。
 */
export type ActivityKind =
  | 'write'
  | 'dedupe'
  | 'promote'
  | 'abstain'
  | 'retrieve'
  | 'confirm'
  | 'controller'
  | 'error'

/** 最近活动保留条数（够看清一次排障窗口，不撑内存）。 */
export const ACTIVITY_LOG_MAX = 200
/** 单条 detail 最大字符数（防一条异常文本撑爆环形）。 */
export const ACTIVITY_DETAIL_MAX = 200

export interface ActivityEntry {
  readonly at: number
  readonly kind: ActivityKind
  readonly detail: string
}

export interface ActivitySummary {
  readonly total: number
  readonly byKind: Readonly<Record<ActivityKind, number>>
  readonly errors: number
  /** 最近一条活动时间；没有活动为 null（不写 0）。 */
  readonly lastAt: number | null
}

export interface ActivityLog {
  note(input: { readonly kind: ActivityKind; readonly detail: string; readonly at: number }): void
  /** 最近活动（新→旧，最多 `limit` 条）。 */
  recent(limit?: number): readonly ActivityEntry[]
  summary(): ActivitySummary
}

const EMPTY_COUNTS: Readonly<Record<ActivityKind, number>> = {
  write: 0,
  dedupe: 0,
  promote: 0,
  abstain: 0,
  retrieve: 0,
  confirm: 0,
  controller: 0,
  error: 0,
}

export function createActivityLog(max: number = ACTIVITY_LOG_MAX): ActivityLog {
  const capacity = Number.isFinite(max) && max > 0 ? Math.floor(max) : ACTIVITY_LOG_MAX
  const entries: ActivityEntry[] = []
  const counts: Record<ActivityKind, number> = { ...EMPTY_COUNTS }
  let total = 0
  let errors = 0
  let lastAt: number | null = null

  return {
    note(input) {
      const kind = input.kind
      const at = Number.isFinite(input.at) ? input.at : 0
      const detail = typeof input.detail === 'string'
        ? input.detail.length > ACTIVITY_DETAIL_MAX
          ? `${input.detail.slice(0, ACTIVITY_DETAIL_MAX)}…`
          : input.detail
        : ''
      entries.push({ at, kind, detail })
      while (entries.length > capacity) entries.shift()
      counts[kind] += 1
      total += 1
      if (kind === 'error') errors += 1
      lastAt = lastAt === null ? at : Math.max(lastAt, at)
    },
    recent(limit = 20) {
      const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20
      return entries.slice(-n).reverse()
    },
    summary() {
      return { total, byKind: { ...counts }, errors, lastAt }
    },
  }
}

/**
 * 健康面的一行活动读数（v4.11.0）。
 *
 * 只列**发生过**的类别（不印 0 次，避免"没发生"看起来像"发生了 0 次"）；
 * 错误单列且永不省略。没有活动时一个字都不写。
 */
export function renderActivityNote(summary: ActivitySummary | undefined): string {
  if (summary === undefined || summary.total === 0) return ''
  const labels: readonly [ActivityKind, string][] = [
    ['write', '写入'],
    ['dedupe', '去重'],
    ['promote', '升级'],
    ['abstain', '弃权'],
    ['retrieve', '召回'],
    ['confirm', '确认'],
    ['controller', '控制器'],
  ]
  const parts = labels
    .filter(([kind]) => summary.byKind[kind] > 0)
    .map(([kind, label]) => `${label} ${summary.byKind[kind]}`)
  const base = parts.length === 0 ? '' : `；活动：${parts.join('、')}`
  if (summary.errors === 0) return base
  return `${base}；⚠ 活动里记录到 ${summary.errors} 次错误`
}
