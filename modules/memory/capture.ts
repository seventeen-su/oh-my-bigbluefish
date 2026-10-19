/**
 * 自主记忆捕获（3.7 Wave 2，task-17）。
 *
 * ## 为什么需要它
 *
 * W1 之后记忆库仍然**只靠模型主动调 `omb_remember`**：391 会话里只有 29 个用过，
 * 大量"用户明确说过的偏好/决定"和"这个项目实际做了什么"留在原始会话里，
 * 下次会话从零开始——这正是用户说的"不自动、不理解项目、每次冷启动"。
 *
 * 本模块订阅 `dsh/` 已观测到的**三个事实事件**（不读宿主、不读模型输出）：
 * - `user/message/observed`：用户原话（偏好/决定的唯一可信来源）；
 * - `tool/call/observed` / `tool/result/observed`：项目活动（命令/改文件）。
 *
 * ## 三条硬规则
 *
 * ① **零 LLM、零抽取**：全是确定性的正则/长度/去重规则，同一输入永远同一结论
 *    （模型可以复核、测试可以断言；不用小模型"总结"，避免又造回顾体）。
 * ② **只写观测到的事实**：偏好写 `asserted_by=user`（原文包含用户陈述），
 *    活动写 `asserted_by=execution`（真的发生了这次调用），**不写助手文本**。
 * ③ **有界**：每会话偏好 ≤5、活动 ≤10；同会话按去重键幂等；会话状态表有上限。
 *
 * ## v4.1 §3.5：生命周期（`tool/call` 只是尝试，`tool/result` 才是事实）
 *
 * v4.1 之前 `tool/call` 时就写"编辑文件：x"——**尝试过**被记成**完成过**。现在：
 * - `tool/call` 只按 `callId` 建 pending（每会话 20 / 全局 512）；
 * - `tool/result`：`ok===true` 写旧文本；`ok===false` 写 `未生效：…`（同一事实轴，
 *   但明确未生效）；`ok===undefined` 不写并计 `unknown-result`；无匹配 pending 计 `no-pending`；
 * - `turn/end` 丢弃未解决 pending 并计 `unconfirmed`（跨回合无法可靠配对）；
 * - 没有 `callId` 时也**只挂 pending**（用 tool+args 派生相关键），**绝不在调用时写**；
 *   结果事件若同样缺 `callId`、也没有可配对的 tool+args，就保持 unknown
 *   （`unknownCorrelation`），回合结束仍未配对则计 `unconfirmed`。
 *   `unconfirmedCall` 只表示"这条调用缺少宿主关联 ID"，不再表示"已写入"。
 *
 * 统计（`failed`/`unconfirmed`/`unknownResult`/`noPending`/`unconfirmedCall`/
 * `unknownCorrelation`/`pending`）经模块健康面进入 `omb_status` 记忆段：
 * 没有成功就没有"完成过"，尝试与结果分开可见；未知也不冒充完成。
 *
 * ## 与 `omb_remember` 的分工
 *
 * - `omb_remember`：模型主动、走准入闸门（用户原话核对/工件核验/执行台账）；
 * - 本模块：**事件驱动**，不经过 `decideAdmission`（它的输入是观测事实，不是模型自述），
 *   但同样受隐私闸门约束、同样拒绝密钥模式。
 */
import type { Clock, MemoryKind, MemoryRecord, MemoryScope, MemoryStore } from '../../kernel/abi/index.js'
import { contentHashOf, newMemoryId } from './remember.js'
import { hasSecret } from './secrets.js'
import { detectProactiveCue } from './proactive.js'
import { classifyMemoryIntent, isDurableIntent } from './intent.js'

export { hasSecret } from './secrets.js'

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

/** 项目活动命令标记（大小写不敏感）。 */
export const ACTIVITY_COMMAND_PATTERN = /\b(?:test|build|verify|git\s+commit|pnpm|npm|pytest|tsc)\b/i

/** 视为"改文件"的工具名（宿主工具名可能带前缀，按子串匹配）。 */
export const EDIT_TOOL_MARKERS: readonly string[] = ['edit', 'write', 'str_replace', 'str-replace']

/** 偏好文本长度域（太短无法成为可核对陈述；太长是回顾体）。 */
export const PREF_MIN_CHARS = 8
export const PREF_MAX_CHARS = 500

/** 每会话捕获上限（有界；见任务书）。 */
export const DEFAULT_MAX_PREFERENCES = 5
export const DEFAULT_MAX_ACTIVITY = 10

/** 项目库未就绪时的重试（冷启动）。 */
export const DEFAULT_PROJECT_RETRY_MS = 250

/**
 * 密钥/凭据模式识别（与准入共用；3.7 Wave 2 起抽到 `./secrets.js`）。
 *
 * 自主写入不经 `omb_remember` 的准入，必须在写之前自己拒。
 */

/** 疑问句：以问号结尾或典型疑问开头（"以后要不要…"这种带有决定标记的仍算偏好，见 classify）。 */
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

/** 偏好候选的分类结果：`ok` 时给出要写入的正文（去首尾空白）。 */
export type PreferenceDecision =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

/**
 * 判断一条用户消息是否值得作为**跨会话偏好/决定**写入。
 *
 * 判据顺序固定（确定性）：长度 → 疑问/命令/代码 → 标记 → 密钥 → **记忆意图**。
 * 最后一步是关键：命中“这次/先/当前任务”等临时边界时，即使含“不要/必须”，
 * 也不写长期记忆（v4.6.1 P1）。
 */
export function classifyUserMessage(text: string): PreferenceDecision {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  if (trimmed.length < PREF_MIN_CHARS) return { ok: false, reason: 'too-short' }
  if (trimmed.length > PREF_MAX_CHARS) return { ok: false, reason: 'too-long' }
  if (isQuestion(trimmed)) return { ok: false, reason: 'question' }
  if (isCommandOrCode(trimmed)) return { ok: false, reason: 'command-or-code' }
  if (!PREFERENCE_MARKERS.some(marker => trimmed.includes(marker))) return { ok: false, reason: 'no-marker' }
  if (hasSecret(trimmed)) return { ok: false, reason: 'secret' }
  const intent = classifyMemoryIntent(trimmed)
  if (!isDurableIntent(intent.intent)) return { ok: false, reason: intent.intent }
  return { ok: true, text: trimmed }
}

/** 工具调用 → 项目活动的分类结果。 */
export type ActivityDecision =
  | { readonly ok: true; readonly text: string; readonly dedupeKey: string }
  | { readonly ok: false; readonly reason: string }

function toolNameMatches(tool: string, marker: string): boolean {
  return tool.toLowerCase().includes(marker)
}

/** 从参数串里抽路径（防御式：参数可能是 JSON、命令行或裸路径）。 */
export function extractPaths(raw: string): readonly string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const found = new Set<string>()
  for (const match of raw.matchAll(/[A-Za-z]:\\[^\s"'`）)，,。；;]+/g)) found.add(match[0])
  for (const match of raw.matchAll(/(?:\.{1,2}\/)[\w.@/-]+/g)) found.add(match[0])
  for (const match of raw.matchAll(/(?:^|[\s"':=])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})/g)) {
    const value = match[1]
    if (value !== undefined && value.length > 2) found.add(value)
  }
  return [...found].sort()
}

/** 从命令串/参数串里抽命令摘要（最多两个 token，避免写进整段参数）。 */
export function extractCommand(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const match = raw.match(
    /(?:^|["'\s])((?:pnpm|npm|yarn|npx|node|pytest|tsc|git|make|docker|vitest|go|cargo)\b[^"'`\n]{0,80})/i,
  )
  if (match?.[1] === undefined) return undefined
  return match[1].trim().slice(0, 120)
}

/**
 * 判断一次工具调用是否构成"项目活动"，并给出可写入的**事实陈述**。
 *
 * - 改文件类工具 → `编辑文件：<path>`（抽不到路径就跳过，不写空泛记录）；
 * - 命令类（命中 `ACTIVITY_COMMAND_PATTERN`）→ `执行命令：<cmd>`；
 * - 其它 → 跳过（读操作不记，避免把"看过"写成"做过"）。
 */
export function classifyToolActivity(tool: string, args: string): ActivityDecision {
  const toolText = typeof tool === 'string' ? tool : ''
  const argText = typeof args === 'string' ? args : ''
  if (toolText.length === 0) return { ok: false, reason: 'no-tool' }
  if (hasSecret(argText) || hasSecret(toolText)) return { ok: false, reason: 'secret' }

  if (EDIT_TOOL_MARKERS.some(marker => toolNameMatches(toolText, marker))) {
    const paths = extractPaths(argText)
    if (paths.length === 0) return { ok: false, reason: 'no-path' }
    const shown = paths.slice(0, 3).join('、')
    return { ok: true, text: `编辑文件：${shown}`, dedupeKey: `edit:${paths.join('|')}` }
  }

  const command = extractCommand(argText)
  const haystack = `${toolText} ${argText}`
  if (!ACTIVITY_COMMAND_PATTERN.test(haystack)) return { ok: false, reason: 'not-activity' }
  if (command === undefined) {
    const trimmed = argText.trim().slice(0, 120)
    if (trimmed.length === 0) return { ok: false, reason: 'no-command' }
    return { ok: true, text: `执行命令：${trimmed}`, dedupeKey: `cmd:${trimmed}` }
  }
  return { ok: true, text: `执行命令：${command}`, dedupeKey: `cmd:${command}` }
}

/** 会话结局（turn/end）：只在"有活动但一条都没捕获"时兜一条，避免刷屏。 */
export function classifySessionOutcome(input: {
  readonly toolCalls: number
  readonly capturedActivity: number
  readonly topTools: readonly string[]
}): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  if (input.toolCalls < 3) return { ok: false, reason: 'too-few-calls' }
  if (input.capturedActivity > 0) return { ok: false, reason: 'already-captured' }
  const tools = input.topTools.slice(0, 3).join('、')
  return { ok: true, text: `会话活动：${input.toolCalls} 次工具调用（${tools}）` }
}

/**
 * 实体键（图自动连边用）。
 *
 * 四类：路径 / 命令 / 包名（反引号内标识符）/ 项目名（cwd basename）。
 * **至少 2 个共用键才连边**——单个键重合（如都提到 `README.md`）不构成"同一主题"。
 */
export function extractEntityKeys(text: string, projectName?: string | null): readonly string[] {
  const raw = typeof text === 'string' ? text : ''
  const keys = new Set<string>()
  if (raw.length === 0) return []
  for (const match of raw.matchAll(/[A-Za-z]:\\[^\s"'`）)，,。；;]+/g)) {
    keys.add(`path:${match[0].replace(/\\/g, '/').toLowerCase()}`)
  }
  for (const match of raw.matchAll(/(?:\.{1,2}\/)[\w.@/-]+/g)) {
    keys.add(`path:${match[0].replace(/^\.\//, '').toLowerCase()}`)
  }
  // 裸相对路径（至少两级）：`modules/memory/store.ts` —— 代码讨论里最常见的形态
  for (const match of raw.matchAll(/(?:^|[\s"'(:：，,])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})/g)) {
    const value = match[1]
    if (value !== undefined) keys.add(`path:${value.toLowerCase()}`)
  }
  for (const match of raw.matchAll(/\b([\w.@-]+\.[A-Za-z0-9]{1,8})\b/g)) {
    keys.add(`path:${match[1]?.toLowerCase() ?? ''}`)
  }
  for (const match of raw.matchAll(
    /\b((?:pnpm|npm|yarn|npx|node|pytest|tsc|git|make|docker|vitest|go|cargo)\s+[a-z][\w:-]{0,24})/gi,
  )) {
    keys.add(`cmd:${(match[1] ?? '').toLowerCase().replace(/\s+/g, ' ')}`)
  }
  for (const match of raw.matchAll(/`([^`\n]{2,40})`/g)) {
    const value = match[1]?.trim().toLowerCase()
    if (value !== undefined && value.length >= 2) keys.add(`token:${value}`)
  }
  if (typeof projectName === 'string' && projectName.length > 0) {
    const name = projectName.split(/[\\/]/).filter(Boolean).pop() ?? projectName
    if (name.length >= 2 && raw.toLowerCase().includes(name.toLowerCase())) {
      keys.add(`project:${name.toLowerCase()}`)
    }
  }
  // **去重"裸文件名"**：完整路径 `path:modules/memory/store.ts` 已包含 `path:store.ts`
  // 的语义，二者同时计数会让"只共享一个文件"被算成 2 个键（自动连边因此过度触发）。
  // 只保留完整路径键。
  const pathKeys = [...keys].filter(key => key.startsWith('path:'))
  for (const key of pathKeys) {
    const base = key.split('/').pop() ?? ''
    const bare = `path:${base}`
    if (bare !== key && key.includes('/') && keys.has(bare)) keys.delete(bare)
  }
  keys.delete('path:')
  return [...keys].sort()
}

/** 捕获统计（健康面用；按类分开，避免"捕获 0 条"一个数字掩盖具体原因）。 */
export interface CaptureStats {
  preferences: number
  activity: number
  outcomes: number
  /** `ok=true` 的调用写过文本。 */
  failed: number
  /** 回合结束时仍未等到结果的 pending 数（丢弃）。 */
  unconfirmed: number
  /** 结果事件 `ok === undefined`（既不算成功也不算失败，不写）。 */
  unknownResult: number
  /** 带 callId 的结果找不到 pending（乱序/重放/超界丢弃）。 */
  noPending: number
  /** call 事件没有 callId → 只能用 tool+args 派生相关键挂 pending；**不再直接写入**。 */
  unconfirmedCall: number
  /** 结果事件既无 callId 也无 tool+args，无法关联到任何 pending（保持 unknown，不写）。 */
  unknownCorrelation: number
  /** 当前挂起中的 pending 数（**瞬时量**，不是累计）。 */
  pending: number
  skipped: Record<string, number>
}

export interface CapturePorts extends CaptureFeatureSwitches {
  readonly clock: Clock
  /** 解析库。**项目作用域必须返回项目库**；拿不到就报告，绝不回落用户库。 */
  readonly resolveStore: (scope: MemoryScope, sessionId: string) => Promise<MemoryStore | undefined>
  /** 该会话的项目身份（规范化 cwd）；用于 `project` 字段与实体键。 */
  readonly currentProject?: (sessionId: string) => string | undefined
  /** 隐私闸门（写许可）。缺省视为允许（模块装配层一定给；单测可省）。 */
  readonly privacyAllowsWrite?: (sessionId: string) => boolean
  /** 写入成功回调（触发向量落盘与统计）。 */
  readonly onMemoryWritten?: (payload: {
    readonly id: string
    readonly scope: MemoryScope
    readonly kind: MemoryKind
  }) => void
  /** 写入成功后的图自动连边（3.7 Wave 2；缺省不连）。 */
  readonly onMemoryStored?: (store: MemoryStore, record: MemoryRecord) => Promise<void>
  readonly logger?: { warn(message: string): void; info?(message: string): void }
  /** 每会话偏好上限（默认 5）。 */
  readonly maxPreferences?: number
  /** 每会话活动上限（默认 10）。 */
  readonly maxActivity?: number
  /** 项目库未就绪时的重试等待（默认 250ms；0 = 不重试）。 */
  readonly projectRetryMs?: number
}

/** 单会话捕获状态。有界（见 `SESSION_STATE_MAX` 与 pending 上限）。 */
interface PendingActivity {
  /** 调用侧分类结果（成功/失败共用同一段"旧文本"）。 */
  readonly decision: { readonly text: string; readonly dedupeKey: string }
  readonly at: number
}

interface SessionCaptureState {
  preferences: number
  activity: number
  outcomes: number
  hashes: Set<string>
  activityKeys: Set<string>
  toolCalls: number
  tools: Map<string, number>
  /** `tool/call` 建、`tool/result` 消；按 callId 配对（v4.1 生命周期）。 */
  pending: Map<string, PendingActivity>
}

export const SESSION_STATE_MAX = 64
/** pending 有界：每会话 20（R10 §6 轨迹预算；超出不再挂起，结果按 no-pending 计）。 */
export const MAX_PENDING_PER_SESSION = 20
/** pending 全局上限 512（多会话并发时的兜底）。 */
export const MAX_PENDING_GLOBAL = 512
/** 失败调用的写入前缀（"尝试过"被记成"完成过"的修复：同一行正文但明确未生效）。 */
export const FAILED_PREFIX = '未生效：'

function emptyState(): SessionCaptureState {
  return {
    preferences: 0,
    activity: 0,
    outcomes: 0,
    hashes: new Set(),
    activityKeys: new Set(),
    toolCalls: 0,
    tools: new Map(),
    pending: new Map(),
  }
}

export interface Capture {
  readonly onUserMessage: (payload: {
    readonly sessionId: string
    readonly text: string
    readonly at: number
    readonly seq?: number
  }) => Promise<void>
  readonly onToolCall: (payload: {
    readonly sessionId: string
    readonly tool: string
    readonly args: string
    readonly at: number
    readonly callId?: string
  }) => Promise<void>
  readonly onToolResult: (payload: {
    readonly sessionId: string
    readonly tool?: string
    readonly args?: string
    readonly callId?: string
    readonly ok?: boolean
    readonly text: string
    readonly at: number
  }) => Promise<void>
  readonly onTurnEnd: (payload: { readonly sessionId: string; readonly turn: number }) => Promise<void>
  /** 当前用户消息触发的主动性提示（易变上下文；无信号时 undefined）。 */
  readonly nudge: (sessionId: string) => string | undefined
  /** 显式清除某会话的主动性提示（回合结束/用户消息无信号时）。 */
  readonly clearNudge: (sessionId: string) => void
  readonly stats: () => CaptureStats
  /** 预热会话状态（turn/start）：不清空已捕获的计数——同一会话跨回合。 */
  readonly warm: (sessionId: string) => void
}

/**
 * 造一个捕获器。
 *
 * 所有方法**绝不抛**：事件订阅侧是 fire-and-forget，抛出去会变成未处理的 rejection。
 * 写失败只记日志与 skipped 计数（`store-error`），不重试（重试会放大写风暴；
 * 冷启动重试只发生在"库尚未打开"这一条上，且只有一次）。
 */
export function createCapture(ports: CapturePorts): Capture {
  const maxPreferences = ports.maxPreferences ?? DEFAULT_MAX_PREFERENCES
  const maxActivity = ports.maxActivity ?? DEFAULT_MAX_ACTIVITY
  const retryMs = ports.projectRetryMs ?? DEFAULT_PROJECT_RETRY_MS
  const states = new Map<string, SessionCaptureState>()
  const stats: CaptureStats = {
    preferences: 0,
    activity: 0,
    outcomes: 0,
    failed: 0,
    unconfirmed: 0,
    unknownResult: 0,
    noPending: 0,
    unconfirmedCall: 0,
    unknownCorrelation: 0,
    pending: 0,
    skipped: {},
  }
  /** pending 全局计数（stats.pending 每次读快照；不靠遍历会话求和）。 */
  let globalPending = 0
  /**
   * 主动性提示：每会话一条，命中即覆盖、回合结束清空。
   *
   * 有界（最多 64 会话）：它只服务当前对话，不需要跨会话保留。
   */
  const nudges = new Map<string, string>()
  const MAX_NUDGE_SESSIONS = 64

  const clearNudge = (sessionId: string): void => {
    nudges.delete(sessionId)
  }

  const setNudge = (sessionId: string, text: string): void => {
    if (nudges.size >= MAX_NUDGE_SESSIONS && !nudges.has(sessionId)) {
      const oldest = nudges.keys().next().value
      if (oldest !== undefined) nudges.delete(oldest)
    }
    nudges.delete(sessionId)
    nudges.set(sessionId, text)
  }

  const stateOf = (sessionId: string): SessionCaptureState => {
    const existing = states.get(sessionId)
    if (existing !== undefined) return existing
    if (states.size >= SESSION_STATE_MAX) {
      // 简单的插入序淘汰：捕获状态只服务"当前活跃会话"，越界即最旧。
      // 淘汰时**必须归还该会话挂起的 pending 配额**：否则 globalPending 只增不减，
      // 长跑进程会在 512 上限处永久拒绝新 pending（静默的全局捕获失效）。
      const oldest = states.keys().next().value
      if (oldest !== undefined) {
        const evicted = states.get(oldest)
        if (evicted !== undefined) globalPending = Math.max(0, globalPending - evicted.pending.size)
        states.delete(oldest)
      }
    }
    const created = emptyState()
    states.set(sessionId, created)
    return created
  }

  const skip = (reason: string): void => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1
  }

  const writable = (sessionId: string): boolean => {
    try {
      return ports.privacyAllowsWrite?.(sessionId) ?? true
    } catch {
      return false
    }
  }

  /** 项目库未就绪 → 等一次再取（冷启动竞态）；用户库不重试。 */
  const resolveStoreOnce = async (scope: MemoryScope, sessionId: string): Promise<MemoryStore | undefined> => {
    const first = await ports.resolveStore(scope, sessionId)
    if (first !== undefined || scope !== 'project' || retryMs <= 0) return first
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, retryMs)
      // 不阻止进程退出（测试/宿主关闭时不被 250ms 挂住）
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    })
    return await ports.resolveStore(scope, sessionId)
  }

  /**
   * 内容去重：内存集合（快）+ 库内同内容（跨进程）。
   *
   * 库内检查用「正文前 60 字符的词法命中 + content_hash 比对」：不引入新端口，
   * 也只对"同一段文字"生效（近义改写不拦——那是离线整合的活）。
   */
  const alreadyStored = async (store: MemoryStore, text: string): Promise<boolean> => {
    const hash = contentHashOf(text)
    try {
      const probe = text.slice(0, 60)
      const hits = await store.searchLexical({ text: probe, scope: store.scope, limit: 5 })
      if (hits.length === 0) return false
      const records = await store.getMany(hits.map(hit => hit.id))
      return records.some(record => record.contentHash === hash)
    } catch {
      return false
    }
  }

  const write = async (input: {
    readonly sessionId: string
    readonly scope: MemoryScope
    readonly kind: MemoryKind
    readonly text: string
    readonly sourceRef: string
    readonly assertedBy: 'user' | 'execution' | 'model'
    readonly dedupeKey: string
  }): Promise<boolean> => {
    const state = stateOf(input.sessionId)
    const hash = contentHashOf(input.text)
    if (state.hashes.has(hash)) {
      skip('duplicate')
      return false
    }
    if (!writable(input.sessionId)) {
      skip('privacy')
      return false
    }
    const store = await resolveStoreOnce(input.scope, input.sessionId)
    if (store === undefined) {
      skip(input.scope === 'project' ? 'no-project-store' : 'no-user-store')
      return false
    }
    if (await alreadyStored(store, input.text)) {
      state.hashes.add(hash)
      skip('duplicate')
      return false
    }
    const now = ports.clock.now()
    const record: MemoryRecord = {
      id: newMemoryId(ports.clock, hash),
      scope: input.scope,
      kind: input.kind,
      text: input.text,
      contentHash: hash,
      sourceRef: input.sourceRef,
      assertedBy: input.assertedBy,
      observedAt: now,
      validTo: null,
      supersededBy: null,
      lastUsedAt: now,
      useCount: 0,
      project: ports.currentProject?.(input.sessionId) ?? null,
    }
    try {
      await store.put(record)
    } catch (error) {
      // 隐私闸门在库访问边界也会拒一次；按可读原因归类，不静默
      const message = error instanceof Error ? error.message : String(error)
      skip(/隐私|禁止写入|privacy|sealed|read-only/i.test(message) ? 'privacy' : 'store-error')
      ports.logger?.warn(`OMB 自主捕获：写入失败（${input.scope}/${input.kind}）——${message.slice(0, 120)}`)
      return false
    }
    state.hashes.add(hash)
    state.activityKeys.add(input.dedupeKey)
    try {
      ports.onMemoryWritten?.({ id: record.id, scope: record.scope, kind: record.kind })
    } catch {
      // 事件通道失败不改变"已写入"
    }
    try {
      await ports.onMemoryStored?.(store, record)
    } catch (error) {
      // 图连边失败不影响"已写入"这个事实（它只是附加索引）
      ports.logger?.warn(`OMB 自主捕获：自动连边失败（已隔离）——${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  const capturePreference = async (payload: {
    sessionId: string
    text: string
    at: number
    seq?: number
  }): Promise<void> => {
    if (ports.enabledPreferences === false) return
    const decision = classifyUserMessage(payload.text)
    if (!decision.ok) {
      skip(decision.reason)
      return
    }
    const state = stateOf(payload.sessionId)
    if (state.preferences >= maxPreferences) {
      skip('cap')
      return
    }
    const sourceRef = `session:${payload.sessionId}#${payload.seq ?? payload.at}`
    const wrote = await write({
      sessionId: payload.sessionId,
      scope: 'user',
      kind: 'semantic',
      text: decision.text,
      sourceRef,
      assertedBy: 'user',
      dedupeKey: `pref:${sourceRef}`,
    })
    if (wrote) {
      state.preferences += 1
      stats.preferences += 1
    }
  }

  /** 写一条活动：成功 = 旧文本；失败 = `未生效：` + 旧文本（v4.1 §3.5）。 */
  const writeActivity = async (input: {
    readonly sessionId: string
    readonly decision: { readonly text: string; readonly dedupeKey: string }
    readonly at: number
    /** 宿主关联 ID（callId）；缺少时用派生键，仍可让同一调用的结果配对。 */
    readonly correlation?: string
    readonly failed?: boolean
  }): Promise<boolean> => {
    const state = stateOf(input.sessionId)
    if (input.failed !== true && state.activityKeys.has(input.decision.dedupeKey)) {
      skip('duplicate')
      return false
    }
    if (state.activity >= maxActivity) {
      skip('cap')
      return false
    }
    const failed = input.failed === true
    const sourceRef = `session:${input.sessionId}#call:${input.correlation ?? input.at}`
    const wrote = await write({
      sessionId: input.sessionId,
      scope: 'project',
      kind: 'episodic',
      text: failed ? `${FAILED_PREFIX}${input.decision.text}` : input.decision.text,
      sourceRef,
      assertedBy: 'execution',
      // 失败与成功是两条不同的事实，去重键必须分开（否则同一命令先失败后成功会被吞一条）
      dedupeKey: failed ? `fail:${input.decision.dedupeKey}` : input.decision.dedupeKey,
    })
    if (wrote) {
      state.activity += 1
      stats.activity += 1
    }
    return wrote
  }

  /**
   * 调用相关键：有宿主 `callId` 就用它；没有时用 `tool+args` 派生一个确定性键。
   *
   * 派生键不是"猜结果"：它只用于把**同一条调用的结果**找回来；
   * 找不回来时 pending 会在 `turn/end` 被计为 `unconfirmed`，而不是被写成完成。
   * 这正是"没有结果确认就保持 unknown"的结构保证。
   */
  const correlationKey = (input: {
    readonly callId?: string
    readonly tool?: string
    readonly args?: string
  }): string | undefined => {
    if (input.callId !== undefined) return `call:${input.callId}`
    if (input.tool !== undefined && input.args !== undefined) {
      return `fallback:${contentHashOf(`${input.tool}\u0000${input.args}`)}`
    }
    return undefined
  }

  /**
   * `tool/call`：**只挂 pending**，任何情况下都不在这里写记忆。
   *
   * v4.5.3：无 `callId` 的降级路径不再"调用时写"。旧行为虽然计了
   * `unconfirmed-call`，但记录正文与成功记录长得一样——读者仍会把
   * "尝试过"当成"完成过"。现在它只挂一个派生键 pending；结果事件能配上才写，
   * 配不上就留到 `turn/end` 计 `unconfirmed`，不会与完成混类。
   */
  const captureActivity = async (payload: {
    sessionId: string
    tool: string
    args: string
    at: number
    callId?: string
  }): Promise<void> => {
    if (ports.enabledActivity === false) return
    const decision = classifyToolActivity(payload.tool, payload.args)
    if (!decision.ok) {
      skip(decision.reason)
      return
    }
    const key = correlationKey(payload)
    if (key === undefined) {
      stats.unknownCorrelation += 1
      skip('no-correlation')
      return
    }
    if (payload.callId === undefined) {
      // 只计数（宿主事件缺关联 ID），不再写入；pending 仍受同一套配对上界约束。
      stats.unconfirmedCall += 1
      skip('unconfirmed-call')
    }
    const state = stateOf(payload.sessionId)
    if (state.activityKeys.has(decision.dedupeKey)) {
      skip('duplicate')
      return
    }
    if (state.activity >= maxActivity) {
      skip('cap')
      return
    }
    if (state.pending.has(key)) {
      skip('pending-duplicate')
      return
    }
    if (state.pending.size >= MAX_PENDING_PER_SESSION || globalPending >= MAX_PENDING_GLOBAL) {
      skip('pending-cap')
      return
    }
    state.pending.set(key, {
      decision: { text: decision.text, dedupeKey: decision.dedupeKey },
      at: payload.at,
    })
    globalPending += 1
  }

  return {
    async onUserMessage(payload) {
      // 主动性提示与自动捕获解耦：即使偏好捕获被关闭/失败，提示仍按用户消息更新。
      const cue = detectProactiveCue(payload.text)
      if (cue === null) clearNudge(payload.sessionId)
      else setNudge(payload.sessionId, cue.text)
      try {
        await capturePreference(payload)
      } catch (error) {
        ports.logger?.warn(`OMB 自主捕获（偏好）失败（已隔离）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    async onToolCall(payload) {
      try {
        const state = stateOf(payload.sessionId)
        state.toolCalls += 1
        state.tools.set(payload.tool, (state.tools.get(payload.tool) ?? 0) + 1)
        await captureActivity(payload)
      } catch (error) {
        ports.logger?.warn(`OMB 自主捕获（活动）失败（已隔离）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    async onToolResult(payload) {
      try {
        if (ports.enabledActivity === false) return
        const state = states.get(payload.sessionId)
        const key = correlationKey(payload)
        // 结果事件连"是哪条调用"都无法确定：保持 unknown，不写。
        // 若结果本身可判定为非活动（读/状态面），静默忽略，避免把每次 read 撑成"未知"。
        if (key === undefined) {
          if (payload.tool !== undefined && classifyToolActivity(payload.tool, payload.args ?? '').ok) {
            stats.unknownCorrelation += 1
            skip('no-correlation')
          }
          return
        }
        const pending = state?.pending.get(key)
        if (state === undefined || pending === undefined) {
          // **只把"活动调用没配上 pending"算丢失**：读文件/状态面等本来就不
          // 产生 pending，若也计入，这个数会被每次 read 撑大。
          if (payload.tool !== undefined && payload.args !== undefined) {
            if (!classifyToolActivity(payload.tool, payload.args).ok) return
          }
          if (key.startsWith('fallback:')) {
            // 无 callId 的派生键没配上：不能证明这条结果属于哪次调用，
            // 计入 unknown（不写），pending 留到 turn/end 再计 unconfirmed。
            stats.unknownCorrelation += 1
            skip('no-correlation')
            return
          }
          stats.noPending += 1
          skip('no-pending')
          return
        }
        state.pending.delete(key)
        globalPending = Math.max(0, globalPending - 1)
        // `ok === undefined` = 结果既没标成功也没标失败（宿主字段缺失/工具未声明）：
        // 不写，但计数可见——"不知道"不能当成"成功"。
        if (payload.ok === undefined) {
          stats.unknownResult += 1
          skip('unknown-result')
          return
        }
        const failed = payload.ok === false
        if (failed) stats.failed += 1
        await writeActivity({
          sessionId: payload.sessionId,
          decision: pending.decision,
          at: payload.at,
          correlation: payload.callId ?? key,
          failed,
        })
      } catch (error) {
        ports.logger?.warn(`OMB 自主捕获（结果）失败（已隔离）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    async onTurnEnd(payload) {
      try {
        // 主动性提示只服务当前回合；回合结束即清，避免下一轮还在念叨上一轮的话。
        clearNudge(payload.sessionId)
        // v4.1 生命周期：回合结束仍未等到结果的 pending 一律丢弃并计 unconfirmed。
        // 跨回合结果本就不可靠配对；留在表里只会在下一回合再数一次。
        const pendingState = states.get(payload.sessionId)
        if (pendingState !== undefined && pendingState.pending.size > 0) {
          const dropped = pendingState.pending.size
          pendingState.pending.clear()
          globalPending = Math.max(0, globalPending - dropped)
          stats.unconfirmed += dropped
        }
        if (ports.enabledOutcome === false) return
        const state = states.get(payload.sessionId)
        if (state === undefined) return
        if (state.outcomes >= 1) return
        const decision = classifySessionOutcome({
          toolCalls: state.toolCalls,
          capturedActivity: state.activity,
          topTools: [...state.tools.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([tool]) => tool),
        })
        if (!decision.ok) return
        const wrote = await write({
          sessionId: payload.sessionId,
          scope: 'project',
          kind: 'episodic',
          text: decision.text,
          sourceRef: `session:${payload.sessionId}#outcome:${payload.turn}`,
          assertedBy: 'model',
          dedupeKey: `outcome:${payload.turn}`,
        })
        if (wrote) {
          state.outcomes += 1
          stats.outcomes += 1
        }
      } catch (error) {
        ports.logger?.warn(`OMB 自主捕获（结局）失败（已隔离）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    stats: () => ({
      preferences: stats.preferences,
      activity: stats.activity,
      outcomes: stats.outcomes,
      failed: stats.failed,
      unconfirmed: stats.unconfirmed,
      unknownResult: stats.unknownResult,
      noPending: stats.noPending,
      unconfirmedCall: stats.unconfirmedCall,
      unknownCorrelation: stats.unknownCorrelation,
      pending: globalPending,
      skipped: { ...stats.skipped },
    }),
    nudge: (sessionId: string) => nudges.get(sessionId),
    clearNudge,
    warm(sessionId) {
      stateOf(sessionId)
    },
  }
}

/**
 * 捕获端口里的**开关**（由模块配置映射；放在 ports 上是为了让单测能关）。
 */
export interface CaptureFeatureSwitches {
  readonly enabledPreferences: boolean
  readonly enabledActivity: boolean
  readonly enabledOutcome: boolean
}
