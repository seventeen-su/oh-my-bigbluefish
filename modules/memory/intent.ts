/**
 * 用户消息的"记忆意图"分类（v4.6.1；修复 P1：临时约束不能变长期偏好）。
 *
 * 旧实现只按关键词命中（"以后"“不要”“决定”“方案”…）就把整句写成
 * `scope:user / kind:semantic / assertedBy:user`，随后 `lifecycle.ts` 把它显示为
 * “已确认”——用户说“这次不要联网，先离线测试”也会被记成长期偏好。
 *
 * 这里把**时间边界**放在关键词之前判断：
 * - 含“这次/本次/当前任务/暂时/先…”且没有“以后/长期/统一/约定…” → 临时约束；
 * - 有长期标记 → 长期偏好/稳定决策；
 * - 只有“决定/采用/方案”但没有稳定语境 → 候选，不自动写成长记忆。
 *
 * 不靠继续堆关键词解决：真正的写入仍受 `omb_remember` 准入与生命周期闸门约束，
 * 本分类只是让**自动捕获**不再把临时话术升格。
 */

export type MemoryIntent =
  | 'long-term-preference'
  | 'stable-decision'
  | 'task-constraint'
  | 'temporary-instruction'
  | 'candidate'

export interface IntentDecision {
  readonly intent: MemoryIntent
  readonly reason: string
}

/** 时间边界：这些词把陈述限定在本次任务/此刻。 */
const TEMPORARY = /(这次|本次|今天|当前任务|这个任务|暂时|临时|仅此|就这一次|先)/u
/** 长期边界：只有出现这些词才允许进入长期语义记忆。 */
const LONG_TERM = /(以后|长期|永久|永远|总是|一直|每次|从今|接下来都|统一|约定|规则|习惯|偏好)/u
const PREFERENCE = /(喜欢|不喜欢|讨厌|偏好|习惯|总是|一直|每次|永远|不要|必须|不准|别再|不要再)/u
const DECISION = /(决定|采用|方案|确认用|就这么|定为)/u
const CONSTRAINT = /(不要|必须|只能|别|禁止|不准)/u

/**
 * 判据顺序固定（确定性）：
 * 临时边界 → 长期边界 → 决策 → 约束（候选）→ 候选。
 */
export function classifyMemoryIntent(raw: string): IntentDecision {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { intent: 'candidate', reason: 'empty' }

  // ① 临时边界优先：有“这次/先/当前任务”等，且没有“以后/长期/统一”对冲。
  if (TEMPORARY.test(text) && !LONG_TERM.test(text)) {
    return CONSTRAINT.test(text)
      ? { intent: 'task-constraint', reason: '含临时/任务边界词 + 约束词：按当前任务约束处理，不写长期记忆' }
      : { intent: 'temporary-instruction', reason: '含临时/任务边界词：按临时指令处理，不写长期记忆' }
  }

  // ② 长期边界：才允许长期偏好/稳定决策。
  if (LONG_TERM.test(text)) {
    if (DECISION.test(text)) {
      return { intent: 'stable-decision', reason: '含长期边界词 + 决策词：可进入项目稳定决策' }
    }
    return PREFERENCE.test(text)
      ? { intent: 'long-term-preference', reason: '含长期边界词 + 偏好词：可进入长期用户偏好' }
      : { intent: 'stable-decision', reason: '含长期边界词：可进入项目稳定决策' }
  }

  // ③ 决策词但没有长期边界：可能是本任务的方案，先当候选。
  if (DECISION.test(text)) {
    return { intent: 'stable-decision', reason: '含决策词且无临时边界：按稳定决策候选（仍需准入）' }
  }

  // ④ 约束词但没有长期边界：不自动晋升为长期偏好。
  if (CONSTRAINT.test(text)) {
    return { intent: 'candidate', reason: '含约束词但无长期边界：保留为候选，不自动写成长期偏好' }
  }

  return { intent: 'candidate', reason: '没有明确的长期/任务边界' }
}

/** 是否允许自动捕获为长期记忆（只放行两类）。 */
export function isDurableIntent(intent: MemoryIntent): boolean {
  return intent === 'long-term-preference' || intent === 'stable-decision'
}
