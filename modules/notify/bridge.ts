/**
 * 桌面通知桥：**探测外部服务，探测不到就全部静默降级**。
 *
 * **协议对齐 `dsh-desktop-notify` 2.0.0，对外 API 基线 `1.0.0`**
 * （`NOTIFY_API_VERSION`，见其 README「给其它插件调用」与 `src/api.ts`）。
 *
 * | 方法 | 门控 | 返回 |
 * | --- | --- | --- |
 * | `push(payload)` | **走聚焦门控** | `boolean`（只有真入队才是 true） |
 * | `pushAlways(payload)` | **绕过门控** | `boolean` |
 * | `notify(payload)` | **与 `push` 完全同一个 `deliver()`** | 明细 `{ ok, queued, silenced, reason, apiVersion, unsupportedVersion }` |
 *
 * ⚠️ 本文件旧注释把 `notify` 写成"同上（`pushAlways`）但返回明细"——**那是错的**。
 * 读 2.0.0 的 `src/api.ts:192-207` 可见：`push` 与 `notify` 是同一个 `deliver()`，
 * `pushAlways` 才是不走门控的那一个。所以**改用 `notify` 不改变门控语义**，
 * 只是把"没发出去"从裸 `false` 变成一个可读原因——这正是本仓库"降级必须可读"要的。
 *
 * 协议还提供两件本桥要用到的东西：
 *   - `capabilities: string[]`：能力探测的权威来源，**协议明说"不要靠版本号猜"**；
 *   - `click` 四态：`none` / `session` / `page` / `url`（旧的顶层 `url` 字段等价于
 *     `click: { type: 'url', url }`，仍然兼容）。
 *
 * 三条硬约束（实测踩过）：
 * - **`title` 为空一律 `false` 且不推送**。旧签名的桥只传了正文，
 *   于是每一条都被拒绝——而桥当时不检查返回值，所以**一条都发不出去却毫无察觉**。
 * - `title` 上限 160 字符、`message` 上限 400 字符，超出由对方截断（不切断代理对）。
 * - `sessionId` 可传会话对象/id/数组；**传了才按会话门控**，不传则始终推送。
 *   本桥按 kind 节流，因此门控交给对方，自己不重复实现。
 *
 * 保留的三条抗噪约束：
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

/** 对方接受的紧急度档位。 */
export type NotifyUrgency = 'low' | 'normal' | 'critical'

/**
 * 本桥声明的对外 API 版本（对方 2.0.0 的 `NOTIFY_API_VERSION`）。
 *
 * 为什么声明：协议规定"更高的主版本不会中断推送，但结果里会回带
 * `unsupportedVersion: true`"。不声明就永远观测不到这件事——
 * 声明了才能把"对方已经不认我们这个版本了"变成一条可读事实。
 * 本桥没有用任何超出基线的东西，所以声明基线而不是"最高版本"。
 */
export const NOTIFY_API_BASELINE = '1.0.0'

/**
 * 挑选发送方法：**优先 `notify`**。
 *
 * `push` 与 `notify` 在 2.0.0 里是同一个 `deliver()`（门控行为完全相同），
 * 区别只在返回：`push` 给 boolean，`notify` 给 `{ ok, queued, silenced, reason, … }`。
 * 既然门控一样，选能说出原因的那个——这也让"设置页关掉了对外 API"这类
 * 拒绝从裸 `false` 变成 `reason: 'api-disabled'`。
 *
 * `pushAlways` 排最后：它**绕过聚焦门控**，只有在对方既没有 `push` 也没有
 * `notify` 时才退到它（那时没有别的选择，且至少还能发出去）。
 *
 * 能力清单（`capabilities`）按协议参与挑选，但**只用来排除，不用来否决**：
 * 清单不认识某个方法名时退回声明的形状探测，而不是把能用的服务判死。
 */
function chooseSend(target: DesktopNotifyLike): { name: string; fn: (payload: NotifyPayload) => unknown } | undefined {
  const order = ['notify', 'push', 'pushAlways'] as const
  const declared = typeof target.capabilities === 'object' && Array.isArray(target.capabilities)
    ? target.capabilities.filter((c): c is string => typeof c === 'string')
    : undefined
  const available = order.filter(name => typeof target[name] === 'function')
  const usable = declared === undefined || declared.length === 0
    ? available
    : available.filter(name => declared.includes(name))
  const name = (usable[0] ?? available[0])
  if (name === undefined) return undefined
  const fn = target[name]
  if (typeof fn !== 'function') return undefined
  return { name, fn: fn as (payload: NotifyPayload) => unknown }
}

/** 把 `notify()` 的返回值读成明细；不是对象/没有可用字段就返回 undefined。 */
function outcomeOf(value: unknown): NotifyOutcomeLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as NotifyOutcomeLike
  if (candidate.queued === undefined && candidate.reason === undefined && candidate.ok === undefined) return undefined
  return candidate
}

/** 点击通知后做什么。四态与 `dsh-desktop-notify` 2.0.0 的 `ClickTarget` 一致。 */
export type NotifyClick =
  | { readonly type: 'none' }
  | { readonly type: 'session'; readonly sessionId?: string }
  /** 跳到宿主插件页——"关掉的前置怎么恢复"这类通知点一下就能到现场。 */
  | { readonly type: 'page'; readonly page: 'plugins' | 'settings-plugins' }
  | { readonly type: 'url'; readonly url: string }

/** 通知载荷。字段名与 `dsh-desktop-notify` 的对外 API 一字不差。 */
export interface NotifyPayload {
  /** **必填**。为空时对方一律拒绝并返回 false。 */
  readonly title: string
  /** 正文，上限 400 字符（对方截断）。缺省时只显示标题。 */
  readonly message?: string
  readonly urgency?: NotifyUrgency
  /** 传了就按会话门控；不传则始终推送。 */
  readonly sessionId?: string | readonly string[]
  /** 点击后的行为（2.0.0 四态）。 */
  readonly click?: NotifyClick
  /**
   * `click` 之前的旧写法，等价于 `click: { type: 'url', url }`。
   * 保留是因为老版本不认识 `click`；新调用一律用 `click`。
   */
  readonly url?: string
  /**
   * 声明的对外 API 版本。协议规定：**更高的主版本不会中断推送**，
   * 但结果里会回带 `unsupportedVersion: true`，调用方可据此降级。
   * 本桥只声明基线版本（它没有用任何超出基线的东西）。
   */
  readonly v?: string
}

/** 对方 `notify()` 返回的明细（字段只增不改）。 */
export interface NotifyOutcomeLike {
  readonly ok?: unknown
  readonly queued?: unknown
  readonly silenced?: unknown
  readonly reason?: unknown
  readonly apiVersion?: unknown
  readonly unsupportedVersion?: unknown
}

/** 宿主 `desktopNotify` 服务的最小结构接口（第三方实现只需对上这个形状）。 */
export interface DesktopNotifyLike {
  /** 对外 API 版本（如 `'1.0.0'`）。老版本没有这个字段。 */
  readonly apiVersion?: unknown
  /** 能力清单，协议指定的探测入口（如 `['push', 'click.page', …]`）。 */
  readonly capabilities?: unknown
  push?(payload: NotifyPayload): unknown
  pushAlways?(payload: NotifyPayload): unknown
  notify?(payload: NotifyPayload): unknown
}

/**
 * 形状探测：三个方法至少要有一个是函数。
 * 声明了但类型不对（如 `push: 1`）→ 判否（不猜测、不改写）。
 *
 * ⚠️ 数组必须显式排除：`Array.prototype.push` 是函数，光看 `push` 会把
 * 任意数组误认成通知服务，然后"推送成功"却什么也没发。
 */
export function isDesktopNotifyLike(value: unknown): value is DesktopNotifyLike {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  if (Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const methods = ['push', 'pushAlways', 'notify'] as const
  for (const name of methods) {
    const method = candidate[name]
    if (method !== undefined && typeof method !== 'function') return false
  }
  return methods.some(name => typeof candidate[name] === 'function')
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
   *
   * @param kind 节流与去重用的类型键（不给人看）。
   * @param title **必填**——对方对空标题一律拒绝。
   * @param message 正文（可选）。
   * @param click 点击通知后的行为（2.0.0 四态）；不给则点了不跳转。
   * @returns 是否**真的发出**（false = 未安装/节流/去重/超上限/对方拒绝，全部静默）
   *
   * **绝不抛异常**：没有任何失败路径能把错误带给调用方。
   */
  push(
    kind: string,
    title: string,
    message?: string,
    sessionId: string = DEFAULT_NOTIFY_SESSION,
    urgency: NotifyUrgency = 'normal',
    click?: NotifyClick,
  ): boolean {
    try {
      const target = this.#target()
      if (target === undefined) {
        this.#suppress(this.#unavailableReason())
        return false
      }

      // 对方对空标题一律拒绝并返回 false；在这里就拦掉，省一次调用，
      // 并把原因写清楚（否则会表现成"静默降级"，看不出是标题的问题）。
      if (title.trim() === '') {
        this.#suppress('标题为空——宿主通知服务拒绝空标题的推送')
        return false
      }

      const now = this.#deps.clock.now()
      this.#prune(now)

      const lastKind = this.#lastByKind.get(kind)
      if (lastKind !== undefined && now - lastKind < NOTIFY_THROTTLE_MS) {
        this.#suppress(`同类型「${kind}」在节流窗口内已推送过`)
        return false
      }

      const contentKey = `${kind}\u0000${title}\u0000${message ?? ''}`
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

      const chosen = chooseSend(target)
      if (chosen === undefined) {
        this.#suppress('宿主 desktopNotify 形状不匹配（无可调用的 push/pushAlways/notify）')
        return false
      }

      // 载荷字段名与对方 API 一字不差。`sessionId` 只在确实有会话时传——
      // 传了才按会话门控，不传则始终推送（本桥的节流是另一回事）。
      const payload: NotifyPayload = {
        title,
        ...(message === undefined || message === '' ? {} : { message }),
        urgency,
        ...(sessionId === DEFAULT_NOTIFY_SESSION ? {} : { sessionId }),
        ...(click === undefined ? {} : { click }),
        // 声明基线版本：协议规定高主版本不中断推送但会回带 unsupportedVersion，
        // 声明了才能把它观测到（不声明就永远是"没意见"）。
        v: NOTIFY_API_BASELINE,
      }
      const returned = chosen.fn.call(target, payload)

      // 异步实现：失败不得变成未处理拒绝，成功与否也无法同步判定，按已入队记账。
      if (isThenable(returned)) {
        void (returned as Promise<unknown>).then(
          value => {
            if (value === false || outcomeOf(value)?.queued === false) {
              this.#deps.logger.warn(`通知：宿主拒绝了推送（异步）——kind=${kind}`)
            }
          },
          (error: unknown) => {
            this.#deps.logger.warn(`通知：异步推送失败（已静默）——${messageOf(error)}`)
          },
        )
      } else {
        const outcome = outcomeOf(returned)
        // `notify()` 给的 `reason` 是权威原因；`push` 只给 boolean，没有就是没有。
        if (outcome !== undefined && outcome.unsupportedVersion === true) {
          this.#deps.logger.warn(
            `通知：宿主声明我们的 API 版本 ${NOTIFY_API_BASELINE} 不受支持（它自己的是 ${String(outcome.apiVersion)}）——推送仍会尝试`,
          )
        }
        const refused = returned === false || outcome?.queued === false
        if (refused) {
          // **必须检查返回值**：对方在标题为空、聚焦门控静默、1.5 秒同文案去重、
          // 设置页关掉了对外 API、或当前平台没有通知后端时都不入队。旧实现不看返回值，
          // 于是"一条都没发出去"被记成"已发 N 条"，状态面在骗人。
          const why = typeof outcome?.reason === 'string' && outcome.reason !== '' ? outcome.reason : undefined
          this.#suppress(
            why === undefined
              ? `宿主拒绝了推送（${chosen.name} 返回 false）：标题为空/聚焦门控静默/同文案去重/无通知后端`
              : `宿主拒绝了推送：${why}${why === 'api-disabled' ? '（设置页关掉了对外 API）' : ''}`,
          )
          return false
        }
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
    // 通道名必须与**实际会用的那个方法**一致：`chooseSend` 才是唯一真源。
    // 旧实现自己另判一遍（push ?? pushAlways ?? notify），于是改成优先 notify 之后，
    // 状态面会继续显示"通道 push"——显示的和做的是两件事。
    const chosen = chooseSend(target)
    const channel = chosen?.name ?? '（无）'
    // 对方的对外 API 版本按协议是权威信号，能力清单同理——探测到就如实写出来。
    const theirVersion = typeof target.apiVersion === 'string' && target.apiVersion !== '' ? target.apiVersion : undefined
    const caps = Array.isArray(target.capabilities)
      ? target.capabilities.filter((c): c is string => typeof c === 'string')
      : undefined
    // 只报与本桥行为有关的几个能力，不把整张清单倒进状态面
    const relevant = caps === undefined ? undefined : ['notify', 'push', 'pushAlways', 'click.page', 'click.session']
      .filter(c => caps.includes(c))
    const versionNote = theirVersion === undefined
      ? '（对方未声明对外 API 版本——旧版本或非官方实现）'
      : theirVersion === NOTIFY_API_BASELINE
        ? `（对外 API ${theirVersion}）`
        : `（对外 API ${theirVersion}，本桥声明的是 ${NOTIFY_API_BASELINE}）`
    return {
      available: true,
      detail:
        `已接上宿主 desktopNotify（通道 ${channel}${versionNote}）；节流：同类型 30 分钟 1 条、同会话内同内容只发一次、` +
        `单会话上限 ${NOTIFY_SESSION_LIMIT} 条。已发 ${this.#sent} 条、抑制 ${this.#suppressed} 条`
        + (relevant === undefined || relevant.length === 0 ? '' : `；对方能力：${relevant.join('、')}`),
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

    /**
     * **配了解析器时，它说了算——不要回落到构造时缓存的实例。**
     *
     * 原来这里无条件回落，于是出现一处自相矛盾（自检报告实测抓到）：
     * 同一次 `omb_status` 里，模块行说「宿主未安装 desktopNotify 服务」，
     * 组件自述却说「已接上宿主 desktopNotify（通道 push）」。
     *
     * 成因：两个内核实例各有一个桥。工具那个实例的 `resolve` 取不到宿主服务
     * （宿主服务只发布给行实例），于是回落到**装载时快照**里的那份——
     * 而那份可能早已不在，也可能从来只是"当时看起来像"。
     *
     * `resolve` 的契约就是"每次推送时重新解析"，它是权威；回落到陈旧快照
     * 等于让状态面说一件已经不再成立的事。**宁可如实报"不可用"，也不要报一个
     * 已经不成立的好消息**——后者会让人以为通知在工作。
     *
     * 只有**没配解析器**时才用构造时给的那份（那正是它的用途）。
     */
    if (this.#deps.resolve !== undefined) return undefined
    if (isDesktopNotifyLike(this.#deps.notify)) return this.#deps.notify
    return undefined
  }

  #unavailableReason(): string {
    let resolved: unknown
    let probeFailed = false
    try {
      resolved = this.#deps.resolve?.()
    } catch {
      resolved = undefined
      probeFailed = true
    }

    // **配了解析器时，只有它说了算**（与 `#target` 同一口径）。
    // 不能再拿装载时的快照来判断"是没装还是形状不对"——那会给出与
    // `available: false` 不匹配的理由，读者会以为"服务在、只是形状怪"。
    if (this.#deps.resolve !== undefined) {
      if (probeFailed) return '解析宿主 desktopNotify 时出错；通知全部静默降级（不影响任何功能）'
      if (resolved === undefined) {
        return '宿主未安装 desktopNotify 服务（本次解析为空）；通知全部静默降级，不影响任何功能'
      }
      return `宿主 desktopNotify 形状不匹配（push/pushAlways/notify 都不可调用，实际为 ${typeNameOf(resolved)}）；通知全部静默降级`
    }

    if (this.#deps.notify === undefined) {
      return '宿主未安装 desktopNotify 服务；通知全部静默降级，不影响任何功能'
    }
    return `宿主 desktopNotify 形状不匹配（push/pushAlways/notify 都不可调用，实际为 ${typeNameOf(this.#deps.notify)}）；通知全部静默降级`
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
