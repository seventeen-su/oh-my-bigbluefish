/**
 * 记忆主动性提示（v4.5.3 用户新增需求）。
 *
 * ## 为什么需要它
 *
 * 记忆库此前是"被动可用"：工具描述写着能写，但模型没有**何时该主动写**的触发条件。
 * 用户的原话是"大幅度提高 ai 主动记忆和管理记忆库的积极性和主动性，而不是每次由用户提醒"。
 *
 * ## 做法：只在用户消息里出现明确信号时，下一轮注入一行
 *
 * - 不是常驻散文（常驻预算 120 字符，且必须逐字节稳定）；
 * - 不是每轮都提醒（那会变成噪声，模型很快学会忽略）；
 * - 只是一行 ≤120 字符的**易变上下文**，命中一次、用完/回合结束即清。
 *
 * 判据是确定性的（热路径零 LLM）：显式要求记住 > 纠正旧结论 > 项目决定 > 长期偏好。
 * 宁可漏提示，也不把每句闲聊都变成"快写记忆"。
 */

import { classifyMemoryIntent } from './intent.js'

/** 触发记忆操作的信号类别。 */
export type ProactiveCue = 'explicit-remember' | 'correction' | 'decision' | 'preference' | 'task-constraint'

export interface ProactiveNudge {
  readonly cue: ProactiveCue
  /** 给模型看的一行提示（≤120 字符）。 */
  readonly text: string
}

/** 单条用户消息的最大长度：超长文本多半是粘贴内容，不做记忆提示。 */
export const PROACTIVE_MAX_CHARS = 600

const EXPLICIT_REMEMBER = /(记住|帮我记|记一下|别忘了|不要忘记|存一下|记下来)/u
const CORRECTION = /(不对|错了|不是这样|改主意|改成|改为|更正|修正|撤销|收回|别再|不要再用|之前说|上次说|更新一下)/u

function looksLikeQuestion(text: string): boolean {
  return /[?？]\s*$/u.test(text)
}

/**
 * 从用户消息里识别"值得主动记忆/管理"的信号。
 *
 * @returns null = 没有明确信号（不打断、不提示）
 */
export function detectProactiveCue(raw: string): ProactiveNudge | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0 || text.length > PROACTIVE_MAX_CHARS) return null
  // 纯问句不当作陈述；但"能记住吗？"这类显式要求仍应触发（下面单独判断）。
  const question = looksLikeQuestion(text)
  if (EXPLICIT_REMEMBER.test(text)) {
    return {
      cue: 'explicit-remember',
      text: '用户明确要求记住：立即调用 omb_remember 写入逐字原文（附来源），不要只回复“好的”。',
    }
  }
  if (question) return null
  if (CORRECTION.test(text)) {
    return {
      cue: 'correction',
      text: '用户在纠正旧结论：先用 omb_recall 查旧条目，再用 omb_remember(supersedes) 更正，不要只口头承认。',
    }
  }
  const intent = classifyMemoryIntent(text)
  // 临时约束先分流：不要让“这次不要联网”被提示成“长期偏好”。
  if (intent.intent === 'task-constraint' || intent.intent === 'temporary-instruction') {
    return {
      cue: 'task-constraint',
      text: '这是当前任务约束（不是长期偏好）：不要写成长期记忆；若用户明确要求记住，请限定失效边界。',
    }
  }
  if (intent.intent === 'stable-decision') {
    return {
      cue: 'decision',
      text: '这是项目决定/长期约定：主动用 omb_remember 记为 semantic（项目库），并写清来源。',
    }
  }
  if (intent.intent === 'long-term-preference') {
    return {
      cue: 'preference',
      text: '用户表达了长期偏好：主动用 omb_remember 记为 semantic（用户库），不要等用户提醒。',
    }
  }
  return null
}
