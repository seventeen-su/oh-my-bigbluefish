/**
 * 用户消息的形态闸门（v4.7.0；从 `capture.ts` 抽出，供控制器与捕获共用）。
 *
 * ## 为什么单独成文件
 *
 * v4.7.0 阶段 1 里控制器自己判"值不值得写"，捕获路径另有一套 `classifyUserMessage`。
 * 两套判据一旦漂移，就会出现"控制器决定 persist、写入路径认为该跳过"的分裂——
 * 阶段 2 要让控制器**执行**写入，所以判据必须是同一份。
 *
 * 这里只放**纯形态判据**（是不是疑问句/命令/代码/带偏好标记），不读时间、不读库：
 *
 * | 判据 | 为什么拒 |
 * | --- | --- |
 * | 疑问句 | 用户在问，不是在陈述长期约定 |
 * | 命令/代码 | `/compact`、粘贴的代码块不是偏好 |
 * | 无偏好标记 | 宁可漏收，不把闲聊写进用户库 |
 *
 * "临时/长期"的时间边界判定在 `intent.ts`，不在这里——两件事分开才测得清。
 */

/** 用户偏好/决定标记（任一命中即候选；宁可漏收，不可把闲聊写进用户库）。 */
export const PREFERENCE_MARKERS: readonly string[] = [
  '记住',
  '以后',
  '下次',
  '我喜欢',
  '我习惯',
  '不要',
  '必须',
  '决定',
  '采用',
  '方案',
  '约定',
]

/** 疑问句：以问号结尾或典型疑问开头。 */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (/[?？]\s*$/.test(trimmed)) return true
  return /^(?:什么|怎么|为什么|为何|是否|能否|能不能|可不可以|是不是|要不要|哪个|哪些|多少|何时|几时|请问)/.test(
    trimmed,
  )
}

/** 命令/代码块：命令行、斜杠命令、代码围栏或典型代码片段一律不收。 */
export function isCommandOrCode(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('$') || trimmed.startsWith('>')) return true
  if (trimmed.includes('```')) return true
  if (/\b(?:function|class|interface)\s+\w+\s*[({]/.test(trimmed)) return true
  if (/\bimport\s+[^\n]+\s+from\s+['"]/.test(trimmed)) return true
  // 多行且以分号/花括号结尾的行占比高 → 代码粘贴
  const lines = trimmed.split('\n').filter(line => line.trim().length > 0)
  if (lines.length >= 3) {
    const codeLike = lines.filter(line => /[;{}]\s*$/.test(line.trim())).length
    if (codeLike / lines.length >= 0.5) return true
  }
  return false
}

/** 是否含用户偏好/决定标记（纯形态；不含时间边界判断）。 */
export function hasPreferenceMarker(text: string): boolean {
  return PREFERENCE_MARKERS.some(marker => text.includes(marker))
}
