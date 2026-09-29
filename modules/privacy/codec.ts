/**
 * 持久化文档的编解码（纯函数，零 I/O）。
 *
 * ## 文档形状
 *
 * ```json
 * { "version": 1, "failClosedAt": 1730000000000, "modes": { "<sessionId>": "sealed" } }
 * ```
 *
 * - `modes`：**只记显式命令设置过的会话**。继承是**读时解析**的（沿血缘向上找），
 *   所以子代理不需要、也不应该被写进文件——父会话改模式后子会话立刻跟着变，
 *   若把继承结果也落盘，就会变成一份会漂移的副本（本项目在"同一事实存两遍"
 *   上已经付过代价）。
 * - `failClosedAt`：**粘性**的 fail-closed 标记。文件存在但读不出/解析失败/版本不认识时，
 *   我们无法知道丢掉了哪些会话的限制。此时把它写成非 null，于是**基线**变成
 *   `sealed`（没有记录 = 最严），只有显式 `/omb-privacy trust` 才能清除。
 *   为什么粘性：否则"损坏 → 兜底 sealed → 下次启动解析成功（因为文件已被重写成空）
 *   → 全部回到 normal"——中间那次兜底就白做了，等于悄悄放宽。
 *
 * ## 一条容易写错、这里钉死的规则
 *
 * **文件不存在 ≠ 文件损坏**：不存在是"从未配置过"（基线 normal），损坏才是
 * "曾经配置过但读不出来"（基线 sealed）。混为一谈会让首次安装的用户记忆直接不可用。
 */
import type { PrivacyMode } from './modes.js'
import { isPrivacyMode, PRIVACY_MODES } from './modes.js'

export const PRIVACY_DOC_VERSION = 1

export interface PrivacyDoc {
  readonly version: number
  /** 非 null = 曾经读到损坏状态；基线按最严处理，直到显式 trust。 */
  readonly failClosedAt: number | null
  /** 会话 id → 显式模式。 */
  readonly modes: Readonly<Record<string, PrivacyMode>>
}

export interface PrivacyDecodeResult {
  readonly doc: PrivacyDoc
  /** 可读的失败原因；正常为 null。 */
  readonly error: string | null
  /** 是否进入了 fail-closed 兜底（调用方据此写回粘性标记并如实上报）。 */
  readonly degraded: boolean
  /** 文件是否存在（不存在且无错误 = 从未配置过）。 */
  readonly exists: boolean
}

/** 空文档（从未配置过）。 */
export function emptyDoc(): PrivacyDoc {
  return { version: PRIVACY_DOC_VERSION, failClosedAt: null, modes: {} }
}

/** 因损坏而兜底的文档：保留 failClosedAt（粘性），并带上解析期可读到的合法条目。 */
export function degradedDoc(now: number, keep: Readonly<Record<string, PrivacyMode>> = {}): PrivacyDoc {
  return { version: PRIVACY_DOC_VERSION, failClosedAt: now, modes: { ...keep } }
}

/** 序列化：键排序 → 逐字节确定（便于"内容未变就不写"和人工核对）。 */
export function encodeDoc(doc: PrivacyDoc): string {
  const modes: Record<string, PrivacyMode> = {}
  for (const key of Object.keys(doc.modes).sort()) {
    const mode = doc.modes[key]
    if (mode !== undefined && isPrivacyMode(mode)) modes[key] = mode
  }
  return `${JSON.stringify({ version: PRIVACY_DOC_VERSION, failClosedAt: doc.failClosedAt, modes }, null, 2)}\n`
}

/** 解析结果里的模式表（只保留合法条目，并报告丢弃数）。 */
function parseModes(raw: unknown): { modes: Record<string, PrivacyMode>; dropped: number } {
  const modes: Record<string, PrivacyMode> = {}
  let dropped = 0
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { modes, dropped: 0 }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim().length === 0 || !isPrivacyMode(value)) {
      dropped += 1
      continue
    }
    modes[key] = value
  }
  return { modes, dropped }
}

/**
 * 解析持久化文本。
 *
 * **绝不抛异常**；一切无法信任的输入都走 fail-closed：
 * - `text` 为空/全空白 → 损坏（截断写、外部改动）→ degraded
 * - 不是合法 JSON / 顶层不是对象 → degraded
 * - `version` 不认识（缺失、非 1）→ degraded（**不猜**未来结构）
 * - 单个条目非法 → **丢弃该条目并整体 degraded**：丢一条就等于丢一个会话的限制，
 *   不能只丢不报（那样被丢的会话会悄悄回到 normal）。
 */
export function decodeDoc(text: string, now: number, exists = true): PrivacyDecodeResult {
  if (!exists) {
    return { doc: emptyDoc(), error: null, degraded: false, exists: false }
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return {
      doc: degradedDoc(now),
      error: '隐私状态文件为空（可能被截断或外部清空）',
      degraded: true,
      exists: true,
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { doc: degradedDoc(now), error: `隐私状态文件不是合法 JSON：${message}`, degraded: true, exists: true }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { doc: degradedDoc(now), error: '隐私状态文件顶层不是对象', degraded: true, exists: true }
  }

  const record = raw as { version?: unknown; failClosedAt?: unknown; modes?: unknown }
  if (record.version !== PRIVACY_DOC_VERSION) {
    return {
      doc: degradedDoc(now),
      error: `不认识的隐私状态版本：${String(record.version)}（本实现只认 v${PRIVACY_DOC_VERSION}）`,
      degraded: true,
      exists: true,
    }
  }

  const { modes, dropped } = parseModes(record.modes)
  const sticky = typeof record.failClosedAt === 'number' && Number.isFinite(record.failClosedAt)
    ? record.failClosedAt
    : null
  if (dropped > 0) {
    return {
      doc: { version: PRIVACY_DOC_VERSION, failClosedAt: sticky ?? now, modes },
      error: `隐私状态里有 ${dropped} 条无法识别的模式记录（已按 fail-closed 处理）`,
      degraded: true,
      exists: true,
    }
  }
  return {
    doc: { version: PRIVACY_DOC_VERSION, failClosedAt: sticky, modes },
    error: null,
    degraded: false,
    exists: true,
  }
}

/** 文档里的模式数量（状态面用）。 */
export function docSize(doc: PrivacyDoc): number {
  return Object.keys(doc.modes).length
}

/** 供状态面显示：当前文档认得的模式取值清单（防止有人在文件里手写别的字样）。 */
export const KNOWN_MODE_LIST: string = PRIVACY_MODES.join('、')
