/**
 * 主动记忆的“可写信号”识别：只做保守的正则/结构判断，不调用 LLM。
 *
 * 为什么放在 domain：它是纯文本规则，不依赖宿主、数据库或插件状态；单元测试可以直接锁住
 * “哪些用户话值得写长期记忆”。识别结果只用于**提醒**，不自动写库；模型仍要自己调用
 * `omb_remember`，因此误判只会多一次可见检查点，不会污染记忆。
 */

export const DURABLE_SIGNAL_KINDS = ['preference', 'decision', 'fact', 'constraint', 'correction'] as const

export type DurableSignalKind = (typeof DURABLE_SIGNAL_KINDS)[number]

export const DURABLE_SIGNAL_LABELS: Record<DurableSignalKind, string> = {
  preference: '偏好/习惯',
  decision: '决定/结论',
  fact: '事实',
  constraint: '约束/边界',
  correction: '纠正/更正',
}

export interface DurableSignal {
  readonly kind: DurableSignalKind
  /** 原文中的一个完整短句，已压缩空白并限长；用于检查点展示，不替代原文。 */
  readonly text: string
  /** strong 才进入提醒队列；weak 保留给诊断/测试，避免任务指令被当成长期偏好。 */
  readonly strength: 'strong' | 'weak'
}

const MAX_SIGNAL_TEXT = 180
const MAX_SIGNALS = 3

const CODE_FENCE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g

/** 明确的记忆/偏好措辞：出现即可认为用户希望跨会话保留。 */
const PREFERENCE = /(?:记住|记一下|记下|别忘|不要忘|以后|今后|下次|往后|每次|总是|永远|千万别|不要再|别再|偏好|我喜欢|我不喜欢|我习惯|我要求|我希望|我倾向|我更(?:喜欢|愿意)|prefer|from\s+now\s+on|\balways\b|\bnever\b|\bremember\b)/i

/** 明确的决定/结论措辞：不把普通代码修改指令（“改成 async”）算进来。 */
const DECISION = /(?:我们决定|我决定|已经决定|决定(?:用|采用|选|改)|定稿|最终(?:方案|决定)|就用|采用|按这个来|结论是|定为|设为默认|we\s+decided|\bdecision\b|we(?:'ll|\s+will)\s+use|final\s+(?:plan|decision))/i

/** 纠正旧事实：优先于其它类型，检查点会提示用链接/更新而不是重复写。 */
const CORRECTION = /(?:纠正|更正|说错|收回|其实不是|不是[^。！？!?\n]{1,40}而是|更正一下|\bcorrection\b|\bactually\b)/i

/** 强边界：以后/不要再/禁止这类通常跨会话有效。 */
const CONSTRAINT_STRONG = /(?:以后|今后|每次|永远|千万不要|不要再|别再|禁止|不允许|只能|不要(?:再|在|把|让))/i

/** 弱边界：单独出现时可能只是当前任务指令，需要至少两个弱信号才提醒。 */
const CONSTRAINT_WEAK = /(?:必须|务必|一定要|只能|不要|不能|禁止|不允许|约束|限制|规则|标准|规范|约定|默认)/i

/** 第一人称/环境事实：通常值得跨会话保留。 */
const SELF_FACT = /(?:我是|我的|我在|我用|我用的是|我们用的是|本机|这台|这个项目|我的项目|仓库是|路径是|端口是|版本是|环境是|数据库是|部署在|\bworkspace\b|\bmy\s+(?:machine|repo|project)\b|\bi\s+(?:use|am\s+using)\b)/i

/** 项目事实：需要“是/用/在/为”这类断言，避免“路径不对”“版本切换”这种普通描述。 */
const PROJECT_FACT = /(?:仓库|项目|路径|端口|版本|环境|数据库|生产|repo(?:sitory)?|\bpath\b|\bport\b|\bversion\b|\bdatabase\b|\benvironment\b)/i
const PROJECT_ASSERTION = /(?:是|用|在|为|：|:)/

/** 去掉代码块，避免把代码里的 `以后`/`记住` 或路径当成用户长期信号。 */
function withoutCode(input: string): string {
  return input.replace(CODE_FENCE, ' ').replace(INLINE_CODE, ' ')
}

function compact(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function excerpt(input: string): string {
  const text = compact(input)
  if (text.length <= MAX_SIGNAL_TEXT) return text
  // 不把代理对截成半个字符。
  let end = MAX_SIGNAL_TEXT
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

function sentences(input: string): string[] {
  return withoutCode(input)
    // 中文标点和换行是可靠边界；英文句点不切，避免把路径/版本号切碎。
    .split(/[。！？!?；;\n]+/)
    .map(part => part.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').trim())
    .filter(part => part.length > 0)
}

function classify(sentence: string): { kind: DurableSignalKind; strength: 'strong' | 'weak' } | undefined {
  if (CORRECTION.test(sentence)) return { kind: 'correction', strength: 'strong' }
  if (PREFERENCE.test(sentence)) return { kind: 'preference', strength: 'strong' }
  if (DECISION.test(sentence)) return { kind: 'decision', strength: 'strong' }
  if (CONSTRAINT_STRONG.test(sentence)) return { kind: 'constraint', strength: 'strong' }
  if (SELF_FACT.test(sentence)) return { kind: 'fact', strength: 'strong' }
  if (PROJECT_FACT.test(sentence) && PROJECT_ASSERTION.test(sentence)) return { kind: 'fact', strength: 'strong' }
  // 弱信号不进入主动提醒，但仍返回给诊断/测试；避免“必须完成这个任务”这类当前指令刷屏。
  if (CONSTRAINT_WEAK.test(sentence)) return { kind: 'constraint', strength: 'weak' }
  return undefined
}

/**
 * 从一条用户消息中识别值得长期保存的信号。
 *
 * 规则刻意保守：只认明确偏好、决定、纠正、边界、第一人称/项目事实；普通问题、代码修改指令、
 * 一次性任务细节都不返回。结果按句子去重，最多 3 条。
 */
export function detectDurableSignals(input: string, limit = MAX_SIGNALS): DurableSignal[] {
  if (input.trim().length === 0) return []
  const limitValue = Number.isSafeInteger(limit) ? Math.max(1, Math.min(MAX_SIGNALS, limit)) : MAX_SIGNALS
  const seen = new Set<string>()
  const signals: DurableSignal[] = []
  for (const sentence of sentences(input)) {
    const text = excerpt(sentence)
    if (text.length === 0 || seen.has(text)) continue
    const classified = classify(sentence)
    if (classified === undefined) continue
    seen.add(text)
    signals.push({ ...classified, text })
    if (signals.length >= limitValue) break
  }
  return signals
}
