/**
 * 「OMB 设置 → 会话隐私」页的**数据契约**（v4.17）。
 *
 * 边界（先写清楚，别让路径自己长出来）：
 * - 这是**用户自己的设置页面**的数据面。模型工具没有隐私入口——`omb_remember`
 *   等工具不能读也不能写隐私档位（"这条记忆很有价值，我先把 sealed 关掉"不是隐私）；
 * - 写操作只能来自**用户点击**（`POST /omb/api/privacy`，见 `dsh/ui-route.ts`），
 *   经 `omb:ui` 服务转给 `PrivacyAdminPort`；不是模型路径、不是斜杠命令的替代；
 * - 本文件只有类型，没有实现；类型名/字段名是已冻结契约，改一处就要同步
 *   `modules/memory/ui.ts`、`modules/memory/privacy/index.ts`、`dsh/ui-route.ts` 与测试。
 */
import type { PrivacyMode, PrivacyOrigin } from './modes.js'

/** 设置页能发起的四个用户动作（`POST /privacy` 的 action）。 */
export type PrivacyActionName = 'set' | 'clear' | 'clear-inactive' | 'trust'

/** 一条显式隐私设置（含"是否本进程活跃"与"是否为继承来源"）。 */
export interface UiPrivacySession {
  readonly sessionId: string
  readonly mode: PrivacyMode
  readonly updatedAt: number
  readonly active: boolean
  readonly parentSessionId: string | null
  readonly inheritanceSource: boolean
}

/** 当前会话的解析结果（显式 / 继承 / 基线，来源必须可读）。 */
export interface UiPrivacyCurrent {
  readonly sessionId: string
  readonly mode: PrivacyMode
  readonly origin: PrivacyOrigin
  readonly inheritedFrom: string | null
  readonly detail: string
  readonly parentSessionId: string | null
}

/** 会话隐私页的完整视图；任何降级都必须仍返回这个形状（不省略字段）。 */
export interface UiPrivacyView {
  readonly available: boolean
  readonly reason?: string
  readonly baseline: { readonly mode: PrivacyMode; readonly origin: 'default' | 'fail-closed'; readonly detail: string }
  readonly current: UiPrivacyCurrent | null
  readonly sessions: readonly UiPrivacySession[]
  readonly restricted: { readonly history: number; readonly active: number } | null
  readonly durable: { readonly path: string | null; readonly ok: boolean; readonly detail: string; readonly savedAt: number | null }
  readonly commands: { readonly privacy: string; readonly clean: string; readonly state: string }
  readonly stats: {
    readonly decisions: number
    readonly readDenials: number
    readonly writeDenials: number
    readonly unattributedWriteDenials: number
    readonly lastDeniedSession: string | null
    readonly lastDeniedReason: string | null
  }
}

/** 动作结果：`ok=false` 时 `text` 必须能说明为什么没执行。 */
export interface PrivacyActionResult {
  readonly ok: boolean
  readonly text: string
}

/**
 * 隐私设置的**管理端口**（只供 `omb:ui` 服务调用；模型工具拿不到它）。
 *
 * 全部方法同步、绝不抛：页面是诊断入口，不能因为内部异常白屏。
 */
export interface PrivacyAdminPort {
  view(currentSessionId: string | null): UiPrivacyView
  setMode(sessionId: string, mode: PrivacyMode): PrivacyActionResult
  clear(sessionId: string): PrivacyActionResult
  clearInactive(): PrivacyActionResult
  trust(): PrivacyActionResult
}
