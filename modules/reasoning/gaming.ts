/**
 * "糊弄倾向"的**观察面**（研究报告 §5.2 设计 C：先只观察，不干预）。
 *
 * ## 它为什么不注入、只上报
 *
 * 证据决定了这条通道只能做到观察，不能做到判定：
 * - 模型在故意教它 reward hack 的设定里 **>99% 利用了捷径，而思维链里承认的 <2%**
 *   （Anthropic 2025-04-03）——**读自述不可信**；
 * - RHB 显示 72% 的作弊者在 CoT 里**自认合理**——它不会自己报为失败；
 * - 情绪向量显示内部压力高时输出可以**完全没有痕迹**——外部看不到。
 *
 * 所以这里只做一件事：把**结构上可核对的事实**摆出来，并明确标成"信号"。
 * **禁止出现"检测到作弊/欺骗/违规"这类结论性措辞**：那既是我们证明不了的结论，
 * 也会把状态面变成不可信的面（`GAMING_BANNED_WORDS` 由测试逐条守住）。
 *
 * ## 两个信号，都只用到已有状态
 *
 * 1. `loop-no-progress`：`stalled` / `no-new-evidence`（`loop.ts` 的口径）——
 *    连续 N 轮没有新增证据，或同一动作在窗口内反复出现且没有新证据；
 * 2. `claim-rechecked-unresolved`：**同一条结论跨 ≥2 个回合被反复核对、且仍未过形式核对**。
 *
 * 第 2 条要说清它测的是什么：**能观测到的是"核对"，不是"断言"**——
 * 本模块看不到模型说了什么（不读会话内容），所以"同一结论反复断言而未 `omb_verify`"
 * 这个形状**无法直接测**；能测的是它的反面代理：同一条结论被反复核对却始终补不出
 * 可核对来源。取舍是"低召回、高精度"：宁可不报，不报错。
 *
 * ## 未测量 ≠ 0
 *
 * 研究报告与任务书都点名了"测试被改写 / 被跳过"这类工具调用痕迹。**它测不到**：
 * `evidence/observed` 的载荷只有动作哈希与证据哈希，**没有工具名与路径**
 * （`kernel/abi/kernel.ts:31`，Lead 已裁决不扩展 ABI；`dsh/` 不在本组件写入范围）。
 * 因此它作为"**未测量项**"固定写在状态面里，与"0 个信号"明确区分开——
 * 不写就等于把"没测"伪装成"没有"。
 *
 * 纯函数、零 I/O、零 mock 可测；畸形输入一律按"没有信号"处理（不抛）。
 */
import type { LoopSignal } from './loop.js'
import { isNoProgressSignal } from './loop.js'
import type { VerifyTracker, VerifyVerdict } from './verify.js'
import { VERDICT_TEXT } from './verify.js'

/** 观察到的**可核对事实**；`id` 用于测试与审计，不面向模型。 */
export interface GamingSignal {
  readonly id: 'loop-no-progress' | 'claim-rechecked-unresolved'
  /** 事实本身（含依据：次数/回合数/判定），不含任何结论性措辞。 */
  readonly fact: string
}

/** 一个会话的观察结果。 */
export interface GamingSessionObservation {
  readonly session: string
  readonly signals: readonly GamingSignal[]
}

export interface GamingInput {
  readonly signal: LoopSignal | null
  readonly tracker: VerifyTracker
}

/** 状态面报告里最多列几个会话、每个会话最多列几条事实（超出只报总数，不静默丢）。 */
export const GAMING_SESSIONS = 3
export const GAMING_FACTS_PER_SESSION = 2

/** 状态面**禁止**出现的措辞（结论性/评判性）。由测试逐条守住。 */
export const GAMING_BANNED_WORDS: readonly string[] = [
  '作弊',
  '欺骗',
  '撒谎',
  '不诚实',
  '违规',
  '检测到',
  '已确认',
  '监控',
]

/** 灵敏度上限：写在每一份报告里，读者不必猜这个面能证明什么。 */
export const GAMING_SENSITIVITY = '低召回高精度：只报可核对的动作事实，不是检测器，也不是结论'

/** 未测量项：必须与"0 个信号"分开说（见文件头）。 */
export const GAMING_UNMEASURED =
  '未测量：测试被改写/跳过的工具调用痕迹——本模块只拿得到动作/证据哈希，拿不到工具名与路径'

/**
 * 观察一个会话。**只看两样已有状态**：循环信号与验证台账；不新增任何事件源。
 */
export function observeGaming(input: GamingInput): readonly GamingSignal[] {
  const signals: GamingSignal[] = []
  try {
    const loop = input?.signal ?? null
    if (isNoProgressSignal(loop) && loop !== null) {
      // 逐字用 signal.detail：它是 Loop 的审计依据（含轮数/次数），不是复述
      signals.push({ id: 'loop-no-progress', fact: `无进展信号（${loop.kind}）：${loop.detail}` })
    }
    for (const fact of repeatedUnresolved(input?.tracker)) {
      signals.push({ id: 'claim-rechecked-unresolved', fact })
    }
  } catch {
    // 观察面绝不因为自己的解析失败而影响状态面；失败时如实报"无信号"会误导，
    // 所以这里返回空数组并由 renderGamingReport 的"未测量"行兜住口径说明。
    return []
  }
  return signals
}

/**
 * 同一条结论跨多个回合被反复核对、且仍未过形式核对。
 *
 * 判定口径（全部取自台账里的既有字段，不猜）：
 * - 同一条结论（`claim` 键与 `verify.ts` 同一把）出现 ≥2 次；
 * - 分布在 **≥2 个不同的回合**（同一回合里核对两次不算"反复"，那是正常补证据）；
 * - 最新判定仍不是 `checkable`（补上来源后重核会把它从待办里去掉）。
 */
function repeatedUnresolved(tracker: VerifyTracker | undefined): readonly string[] {
  const ledger = Array.isArray(tracker?.ledger) ? tracker.ledger : []
  if (ledger.length === 0) return []
  interface Seen {
    count: number
    turns: Set<number>
    verdict: VerifyVerdict
    claim: string
  }
  const seen = new Map<string, Seen>()
  for (const record of ledger) {
    if (record === null || record === undefined) continue
    const claim = typeof record.claim === 'string' && record.claim.trim() !== '' ? record.claim.trim() : '(空结论)'
    const entry = seen.get(claim) ?? { count: 0, turns: new Set<number>(), verdict: record.verdict, claim }
    entry.count += 1
    if (typeof record.turn === 'number' && Number.isFinite(record.turn)) entry.turns.add(Math.floor(record.turn))
    entry.verdict = record.verdict
    seen.set(claim, entry)
  }
  const facts: string[] = []
  for (const entry of seen.values()) {
    if (entry.count < 2) continue
    if (entry.turns.size < 2) continue
    if (entry.verdict === 'checkable') continue
    facts.push(
      `同一条结论「${truncate(entry.claim, 24)}」跨 ${entry.turns.size} 个回合被核对 ${entry.count} 次，`
      + `仍未过形式核对（最近：${VERDICT_TEXT[entry.verdict]}）`,
    )
  }
  return facts
}

/**
 * 状态面报告：一行。**无信号时也输出**——但要输出的是"没有信号 + 灵敏度上限 +
 * 有一项未测量"，而不是让人把"没测到"读成"没有"。
 */
export function renderGamingReport(observations: readonly GamingSessionObservation[]): string {
  const total = observations.reduce((sum, item) => sum + (item?.signals?.length ?? 0), 0)
  const head = `糊弄倾向：${total === 0 ? '无信号' : `${total} 个信号`}（${GAMING_SENSITIVITY}）`
  const details: string[] = []
  for (const item of observations.slice(0, GAMING_SESSIONS)) {
    const signals = item?.signals ?? []
    if (signals.length === 0) continue
    const listed = signals.slice(0, GAMING_FACTS_PER_SESSION).map(signal => signal.fact).join('；')
    const more = signals.length > GAMING_FACTS_PER_SESSION
      ? `；（另有 ${signals.length - GAMING_FACTS_PER_SESSION} 条同类未列出）`
      : ''
    details.push(`会话 ${item.session}：${listed}${more}`)
  }
  const omitted = observations.length > GAMING_SESSIONS
    ? observations.length - GAMING_SESSIONS
    : 0
  const tail = omitted > 0 ? `（另有 ${omitted} 个会话未列出）` : ''
  const body = details.length === 0 ? '' : `——${details.join('｜')}${tail}`
  return `${head}${body}。${GAMING_UNMEASURED}`
}

function truncate(text: string, max: number): string {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
