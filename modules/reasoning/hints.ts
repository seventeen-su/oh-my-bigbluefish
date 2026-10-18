/**
 * 事件驱动的注入提示（v4）：只剩"合法出口"一段。
 *
 * 依据（研究报告 §3.7）：**"诚实解仍可行"是压制生效的前提**，而"合法选项被封闭"
 * 会把 misalignment 从 0% 推到 96%。所以无进展信号出现时，注入的不是"别绕圈"，
 * 而是**把出口写出来**。
 *
 * 三条硬约束（都是反例清单换来的，不许放宽）：
 * 1. **≤ `EXIT_SEGMENT_MAX`（120 字符）**——由测试逐信号断言；
 * 2. **不写"不许作弊"、不写"你被监控"**——前者只部分有效，后者会提高评测意识、
 *    触发表演式合规；
 * 3. **不重述"完成判据/验证预算"**——那些控制表字段已在 v4 删除，没有行为证据的
 *    门槛不该作为承诺读给模型。
 *
 * 这层只由 `loop.ts` 的"无进展"信号（`stalled` / `no-new-evidence`）触发；
 * 其余信号各自的 `hint`（≤80 字符）已经点明了具体出口，不再叠这段。
 */
import type { LoopSignal } from './loop.js'
import { isNoProgressSignal } from './loop.js'

/** 出口段的字符上限（v4 收紧：每段 ≤120 字符）。 */
export const EXIT_SEGMENT_MAX = 120

const EXIT_LEAD: Readonly<Record<string, string>> = {
  stalled: '同一件事反复做且没有进展',
  'no-new-evidence': '连续几轮没有新增证据',
}

/**
 * 显式"合法出口"（仅在无进展信号出现且过迟滞时注入，非每轮）。
 *
 * 无信号、或信号不触发时返回空串：**不注入"没有出口"这类废话**。
 */
export function renderExitOptions(signal: LoopSignal | null | undefined): string {
  if (!isNoProgressSignal(signal)) return ''
  const lead = EXIT_LEAD[signal.kind]
  if (lead === undefined) return ''
  return `${lead}——三个合法出口：① 给出带来源的部分结论并列出未解决项；`
    + `② 写明这条路为什么走不通并换向；③ 直接说不确定，并说明需要什么信息。`
}
