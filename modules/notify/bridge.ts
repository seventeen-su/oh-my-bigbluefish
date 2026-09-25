/**
 * 桌面通知桥：**探测外部服务，探测不到就全部静默降级**。
 *
 * 背景（规划 §1.7 事实）：**DSH 全树没有桌面通知服务**。
 * `dsh-desktop-notify` 是第三方插件，仍在适配新版、**暂未安装**。
 *
 * 本轮的处置方式就是这座桥：
 * - 探测不到 → `push()` 返回 `false`，**绝不抛**，`status().detail` 如实写明原因
 * - **零改码自动接上**：`dsh-desktop-notify` 更新后，宿主侧 `ctx.get('desktopNotify')`
 *   能取到，`dsh/` 层把它放进内核服务表；桥在**每次推送时重新解析**
 *   （`deps.resolve`），因此不需要改桥、不需要重启插件，下一次推送就开始工作。
 *
 * 保留旧实现里值得留的三条约束（它们防的是"通知变成噪音"）：
 * ① 同 kind 30 分钟一次
 * ② 内容去重（**同会话内**同 kind 同内容只发一次；新会话重新计）
 * ③ 会话内上限 10 条
 *
 * **已删除**的通知种类（那些功能本轮已删除，留着就是死代码）：
 * 晋升回退 / 债务 critical / 待人工裁决债务 / 内核未加载。
 */
import type { Clock, Logger } from '../../kernel/abi/index.js'

/** 同 kind 节流窗口：30 分钟。 */
export const NOTIFY_THROTTLE_MS = 30 * 60 * 1000

/** 单会话推送上限。 */
export const NOTIFY_SESSION_LIMIT = 10

/** 未显式给会话时的默认键（`push(kind, message)` 仍可直接用）。 */
export const DEFAULT_NOTIFY_SESSION = 'default'

/** 宿主 `desktopNotify` 服务的最小结构接口（第三方实现只需对上这个形状）。 */
export interface DesktopNotifyLike {
  push?(message: string, options?: unknown): unknown
  pushAlways?(message: string, options?: unknown): unknown
}

/**
 * 形状探测：既无 `push` 也无 `pushAlways` → 不是通知服务；
 * 声明了但类型不对（如 `push: 1`）→ 也判否（不猜测、不改写）。
 *
 * ⚠️ 数组必须显式排除：`Array.prototype.push` 是函数，光看 `push` 会把
 * 任意数组误认成通知服务，然后"推送成功"却什么也没发。
 */
export function isDesktopNotifyLike(value: unknown): value is DesktopNotifyLike {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  if (Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const push = candidate['push']
  const pushAlways = candidate['pushAlways']
  if (push !== undefined && typeof push !== 'function') return false
  if (pushAlways !== undefined && typeof pushAlways !== 'function') return false
  return typeof push === 'function' || typeof pushAlways === 'function'
}

export interface NotifyBridgeDeps {
  /** 已知的宿主服务实例；通常为 `undefined`（未安装）。 */
  readonly notify: DesktopNotifyLike | undefined
  readonly clock: Clock
  readonly logger: Logger
  /**
   * 每次推送时重新解析宿主服务——"零改码自动接上"的机制本身。
   * 解析失败/形状不符一律按"不可用"处理。
   */
  readonly resolve?: () => unknown
}

export interface NotifyStatus {
  readonly available: boolean
  /** 必填、可读：说明"能不能发"以及"为什么不能发"。 */
  readonly detail: string
  readonly sent: number
  readonly suppressed: number
  /** 最近一次被抑制的原因（诊断用；无抑制时为 null）。 */
  readonly lastReason: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function typeNameOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export class NotifyBridge {
  readonly #deps: NotifyBridgeDeps
  readonly #lastByKind = new Map<string, number>()
  /** 会话 → 已发过的内容键。内容去重不随时间失效，只随会话重置。 */
  readonly #sentContent = new Map<string, Set<string>>()
  readonly #sentPerSession = new Map<string, number>()
  #sent = 0
  #suppressed = 0
  #lastReason: string | null = null

  constructor(deps: NotifyBridgeDeps) {
    this.#deps = deps
  }

  /**
   * 推送一条通知。
   * @returns 是否**真的发出**（false = 未安装/节流/去重/超上限，全部静默）
   *
   * **绝不抛异常**：没有任何失败路径能把错误带给调用方。
   */
  push(kind: string, message: string, sessionId: string = DEFAULT_NOTIFY_SESSION): boolean {
    try {
      const target = this.#target()
      if (target === undefined) {
        this.#suppress(this.#unavailableReason())
        return false
      }

      const now = this.#deps.clock.now()
      this.#prune(now)

      const lastKind = this.#lastByKind.get(kind)
      if (lastKind !== undefined && now - lastKind < NOTIFY_THROTTLE_MS) {
        this.#suppress(`同类型「${kind}」在节流窗口内已推送过`)
        return false
      }

      const contentKey = `${kind}\u0000${message}`
      const sentContents = this.#sentContent.get(sessionId)
      if (sentContents?.has(contentKey) === true) {
        this.#suppress('内容重复（同会话内同类型同内容只发一次）')
        return false
      }

      const sentInSession = this.#sentPerSession.get(sessionId) ?? 0
      if (sentInSession >= NOTIFY_SESSION_LIMIT) {
        this.#suppress(`会话「${sessionId}」已达单会话上限 ${NOTIFY_SESSION_LIMIT} 条`)
        return false
      }

      const send = typeof target.push === 'function' ? target.push : target.pushAlways
      if (send === undefined) {
        this.#suppress('宿主 desktopNotify 形状不匹配（无可调用的 push/pushAlways）')
        return false
      }

      const returned = send.call(target, message, { kind })
      if (isThenable(returned)) {
        // 异步失败不得变成未处理拒绝；桥只记账，不把失败抛回调用方。
        void returned.catch((error: unknown) => {
          this.#deps.logger.warn(`通知：异步推送失败（已静默）——${messageOf(error)}`)
        })
      }

      this.#lastByKind.set(kind, now)
      if (sentContents === undefined) this.#sentContent.set(sessionId, new Set([contentKey]))
      else sentContents.add(contentKey)
      this.#sentPerSession.set(sessionId, sentInSession + 1)
      this.#sent += 1
      return true
    } catch (error) {
      this.#deps.logger.warn(`通知：推送失败（已静默）——${messageOf(error)}`)
      this.#suppress(`推送时异常：${messageOf(error)}`)
      return false
    }
  }

  /** 可用性与原因。**原因必填**（无空降级）。 */
  status(): NotifyStatus {
    const target = this.#target()
    if (target === undefined) {
      return {
        available: false,
        detail: this.#unavailableReason(),
        sent: this.#sent,
        suppressed: this.#suppressed,
        lastReason: this.#lastReason,
      }
    }
    const channel = typeof target.push === 'function' ? 'push' : 'pushAlways'
    return {
      available: true,
      detail:
        `已接上宿主 desktopNotify（通道 ${channel}）；节流：同类型 30 分钟 1 条、同会话内同内容只发一次、` +
        `单会话上限 ${NOTIFY_SESSION_LIMIT} 条。已发 ${this.#sent} 条、抑制 ${this.#suppressed} 条`,
      sent: this.#sent,
      suppressed: this.#suppressed,
      lastReason: this.#lastReason,
    }
  }

  /** 清空某会话的计数与内容去重记录（新会话/测试用）。不影响同 kind 的节流窗口。 */
  resetSession(sessionId: string): void {
    this.#sentPerSession.delete(sessionId)
    this.#sentContent.delete(sessionId)
  }

  #target(): DesktopNotifyLike | undefined {
    let resolved: unknown
    try {
      resolved = this.#deps.resolve?.()
    } catch (error) {
      this.#deps.logger.warn(`通知：解析宿主服务失败（已静默）——${messageOf(error)}`)
      resolved = undefined
    }
    if (isDesktopNotifyLike(resolved)) return resolved
    if (isDesktopNotifyLike(this.#deps.notify)) return this.#deps.notify
    return undefined
  }

  #unavailableReason(): string {
    let resolved: unknown
    try {
      resolved = this.#deps.resolve?.()
    } catch {
      resolved = undefined
    }
    if (resolved === undefined && this.#deps.notify === undefined) {
      return '宿主未安装 desktopNotify 服务（dsh-desktop-notify 仍在适配新版）；通知全部静默降级，不影响任何功能'
    }
    const seen = resolved !== undefined ? resolved : this.#deps.notify
    return `宿主 desktopNotify 形状不匹配（既无 push 也无 pushAlways，实际为 ${typeNameOf(seen)}）；通知全部静默降级`
  }

  #suppress(reason: string): void {
    this.#suppressed += 1
    this.#lastReason = reason
    // 静默降级：不写 info/debug 噪音，只在需要诊断时经 status() 读到原因。
  }

  /** 清理过期的节流记录，防止 Map 无界增长。 */
  #prune(now: number): void {
    for (const [key, at] of this.#lastByKind) {
      if (now - at >= NOTIFY_THROTTLE_MS) this.#lastByKind.delete(key)
    }
  }
}
