/**
 * 常驻提示（v4 技能化后只剩这一句）。
 *
 * 8 张方法卡已迁到 DSH skills：`skills/omb-r1/SKILL.md` … `skills/omb-r8/SKILL.md`。
 * 模型通过会话技能目录（name + description）发现它们，用 `skill` 工具按需加载正文；
 * 用户也可以用 `/omb-rN` 显式加载。本文件不再持有卡片正文/索引/话题匹配。
 *
 * 硬约束（v4 / docs/v4-decision.md §3 L3）：
 * - **≤80 字符**（模块自身上限；宿主的共享常驻预算是 120 字符，
 *   要给记忆/上下文模块留余量）；
 * - 逐字节稳定（同一预算下永远同结果，缓存前缀不抖）；
 * - 自己承载 R1 的动作（"先判断需要多少推理"），并点名 skills，模型才知道有过程卡。
 *
 * 文本真源在这里，**不在文档里**：`tests/modules/reasoning/methods.test.ts` 用字面量与
 * 长度上限冻住它，任何改动都会被看见。
 */
import { RESIDENT_HINT_MAX } from '../../kernel/abi/index.js'

/** 常驻提示的模块自身上限（v4：≤80 字符；不得借用宿主的 120 全预算）。 */
export const RESIDENT_HINT_MAX_CHARS = 80

/**
 * 逐字节稳定的常驻提示。
 *
 * 它做三件事：① 承载 R1 的判断动作；② 说明"简单直接答、复杂再展开"；
 * ③ 指向 skills（omb-r1…r8）——这是模型发现过程卡目录的入口。
 */
export const RESIDENT_HINT = '先判断需要多少推理：简单直接答，复杂再展开；过程卡见 skills：omb-r1…omb-r8。'

/**
 * 按预算取常驻提示：装得下就用整句，装不下才截断（截断保留省略号，
 * 不假装是完整句）。`maxChars` 只会缩小，不会超过模块上限。
 */
export function residentHint(maxChars: number = RESIDENT_HINT_MAX_CHARS): string {
  const requested = Number.isFinite(maxChars) ? Math.floor(maxChars) : RESIDENT_HINT_MAX_CHARS
  const limit = Math.max(0, Math.min(requested, RESIDENT_HINT_MAX_CHARS, RESIDENT_HINT_MAX))
  if (limit <= 0) return ''
  if (RESIDENT_HINT.length <= limit) return RESIDENT_HINT
  if (limit === 1) return RESIDENT_HINT.slice(0, 1)
  return `${RESIDENT_HINT.slice(0, limit - 1)}…`
}
