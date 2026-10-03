/**
 * `omb-notify` 模块注册入口：外部通知服务的探测桥。
 *
 * 对外服务名 `notify`（其它模块经 `kernel.service('notify')` 取用，取不到就是没有）。
 *
 * 本模块**永远不失败**：宿主没有通知服务时全部静默降级，
 * 原因写在 `health().detail` / `status().detail` 里（无空降级）。
 */
import { z } from 'zod'
import type { Kernel, ModuleHealth, ModuleManifest, ModuleRegistration } from '../../kernel/abi/index.js'
import type { StatusContributor, StatusRegistry } from '../../kernel/abi/index.js'
import { SERVICES, derivedCapabilities, derivedRequires } from '../../kernel/abi/index.js'
import type { DesktopNotifyLike, NotifyClick, NotifyUrgency } from './bridge.js'
import { DEFAULT_NOTIFY_SESSION, NOTIFY_SESSION_LIMIT, NOTIFY_THROTTLE_MS, NotifyBridge } from './bridge.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export const NOTIFY_MODULE_ID = 'omb-notify'
/** 服务名取 ABI 契约里的 `SERVICES.notify`（不是本地约定）。 */
export const NOTIFY_SERVICE = SERVICES.notify
export const NOTIFY_VERSION = '3.4.0'

/**
 * 宿主服务名。`dsh/` 侧把 `ctx.get('desktopNotify')` 注册进内核服务表后，
 * 桥在下一次推送时自动取到——这就是"零改码自动接上"。
 */
export const NOTIFY_HOST_SERVICE = 'desktopNotify'

/** 唯一保留的内核事件通知种类：**中途**失败的模块（启动失败不打扰）。 */
export const KERNEL_FAILURE_KIND = 'kernel-module-failed'

/**
 * 依赖断裂的通知种类：**前置组件被关掉，依赖它的模块随之失效**。
 *
 * 这条通知与上面那条的分工：上面报"某个模块自己坏了"，这条报"某个模块
 * 是被别人关掉前置**连累**的"——后者用户才知道该去把哪一行打开。
 */
export const KERNEL_DEPENDENCY_BROKEN_KIND = 'kernel-dependency-broken'

export interface NotifyConfig {
  /**
   * **中途**模块失败时是否推送通知（**默认 false**）。
   *
   * 为什么默认关（Lead 裁决）：启动期若有一个模块坏掉，会造成启动噪音；
   * 而启动失败已在插件管理页与 roster 上如实显示，通知是重复的。
   * 打开后也只报"从非 failed 转成 failed"的**转变**（即会话进行中挂掉），
   * 不在启动首轮上报。
   */
  readonly notifyModuleFailures: boolean
  /**
   * 前置组件被关掉时是否推送通知（**默认 true**）。
   *
   * 为什么默认**开**，与上一条相反：这不是"噪音"，而是**用户自己刚做的动作的
   * 后果说明**。宿主不会替用户检查这件事（实测：插件管理器从不读一行的
   * `inject`，关掉前置后依赖方的行仍显示为启用，只是静默停在 PENDING），
   * 所以这条提醒是用户唯一能知道"我刚刚关掉的东西连累了谁"的通道。
   *
   * 只在**卸下**时发，因此启动期（只有挂载、没有卸下）一条都不会发。
   */
  readonly notifyDependencyBroken: boolean
}

export const NOTIFY_DEFAULT_CONFIG: NotifyConfig = { notifyModuleFailures: false, notifyDependencyBroken: true }

export const notifyConfigSchema = z
  .object({
    notifyModuleFailures: z.boolean().default(false),
    notifyDependencyBroken: z.boolean().default(true),
  })
  .default(NOTIFY_DEFAULT_CONFIG)

export interface NotifyService {
  /**
   * 推送一条通知；返回是否真的发出（探测不到/被宿主拒绝就是 false，绝不抛）。
   * @param kind 节流与去重用的类型键（不给人看）。
   * @param title **必填**——宿主对空标题一律拒绝。
   * @param message 正文，可选。
   * @param click 点击通知后的行为（`dsh-desktop-notify` 2.0.0 四态）；不给则点了不跳转。
   */
  push(
    kind: string,
    title: string,
    message?: string,
    sessionId?: string,
    urgency?: NotifyUrgency,
    click?: NotifyClick,
  ): boolean
  status(): { readonly available: boolean; readonly detail: string; readonly sent: number; readonly suppressed: number }
}

export function createNotifyModule(): ModuleRegistration<NotifyConfig> {
  function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 状态面登记的注销函数；dispose 时必须调，否则热插拔会留下悬空段落。 */
let statusUnregister: (() => void) | undefined

let bridge: NotifyBridge | undefined
let config: NotifyConfig = NOTIFY_DEFAULT_CONFIG

  /** 同步健康函数：既能进清单，也能直接 `report`（清单的 health 允许返回 Promise）。 */
  const health = (): ModuleHealth => {
    if (bridge === undefined) {
      return {
        state: 'ok',
        detail: '模块未启动（内核未 apply）：通知桥未建立，不发送任何通知',
      }
    }
    const status = bridge.status()
    // 未安装通知服务不是失败：能力按设计静默降级，原因必须可读。
    return {
      state: 'ok',
      detail: status.detail,
      metrics: { available: status.available ? 1 : 0, sent: status.sent, suppressed: status.suppressed },
    }
  }

  const manifest: ModuleManifest<NotifyConfig> = {
    id: NOTIFY_MODULE_ID,
    version: NOTIFY_VERSION,
    requires: derivedRequires(NOTIFY_MODULE_ID),
    capabilities: derivedCapabilities(NOTIFY_MODULE_ID),
    configSchema: notifyConfigSchema,
    health,
  }

  return {
    manifest,
    apply(kernel: Kernel, parsed: NotifyConfig) {
      config = parsed
      const created = new NotifyBridge({
        // 挂载时可能还没有；每次推送都会重新解析（见 resolve）。
        notify: kernel.service<DesktopNotifyLike>(NOTIFY_HOST_SERVICE),
        clock: kernel.clock,
        logger: kernel.logger,
        resolve: () => kernel.service<unknown>(NOTIFY_HOST_SERVICE),
      })
      bridge = created

      const service: NotifyService = {
        push: (kind, title, message, sessionId = DEFAULT_NOTIFY_SESSION, urgency = 'normal', click) =>
          created.push(kind, title, message, sessionId, urgency, click),
        status: () => {
          const status = created.status()
          return {
            available: status.available,
            detail: status.detail,
            sent: status.sent,
            suppressed: status.suppressed,
          }
        },
      }

      const unprovide = kernel.provide(NOTIFY_SERVICE, service)

      // ── 状态面自述 ────────────────────────────────────────────────────────
      //
      // **降级时更需要这一节**：自检报告指出过「整个状态面里 `omb-notify`
      // 没有独立的『组件自述』段」——因为宿主没装通知服务，它只在模块行出现一次，
      // 而那一次的信息量不足以回答「通知到底接上了没有、发了几条、抑制了几条」。
      //
      // "没接上"本身就是要看的信息，不该因为没接上就整节消失。
      const statusContributor: StatusContributor = {
        name: '桌面通知（omb-notify）',
        render: (): string => {
          try {
            /**
             * **渲染前先自报一次健康。**
             *
             * ## 两个面为什么会分叉（同一类缺陷的第三次复发）
             *
             * 模块行（`## 模块` 段）读的是 `kernel.report()` 的**上报快照**
             * （`kernel/health.ts:12-37`），组件自述读**实时**状态。实测过的同一次输出：
             *
             * ```
             * - omb-notify：正常——宿主未安装 desktopNotify 服务
             * ### 桌面通知（omb-notify）  已接上宿主 desktopNotify（通道 notify）
             * ```
             *
             * **这一类为什么危险**：同一次输出里两个面互相拆台——制品索引那次是
             * 「模块行说 0 条、组件自述说 2 条」，通知这次是「模块行说未安装、
             * 组件自述说已接上」。读者（和模型）无法判断该信哪个；`omb_status` 是
             * **唯一的模型可见诊断入口**，两个面互相矛盾会让整个状态面一起失去
             * 可信度——而改一次文案只能掩盖一处，下一次还会在这儿复发。
             *
             * ## 这条注释先前写错了什么（复发的原因）
             *
             * 它早先写着「于是两个面在**同一次调用内**读到同一份状态，不可能再分叉」。
             * **那句判断当时是错的**：自报确实发生了，但 `dsh/status-tool.ts` 那时是
             * **先取健康面快照、后渲染各段落**——刷新的结果只能被**下一次**调用看到，
             * 同一次输出里的模块行仍停在上一次上报那一刻。
             *
             * ## 机制上怎么消除（两边各一半，缺一不可）
             *
             * ① 模块侧（这里）：`render` 的**第一句**就自报——`omb_status` 不会调用
             *    模块的 health 函数，`render` 是模块唯一能刷新自己那一行的地方；
             * ② 状态面侧（`dsh/status-tool.ts`）：**先渲染全部贡献者、再取健康面快照**
             *    （见那里的"组件自述：必须先渲染"）。
             *    少了②，本段的自报仍旧只对下一次调用有效——这正是它复发的原因。
             *
             * 自报是零成本的：`render` 只在 `omb_status` 被调用时跑，
             * 而 `kernel.report` 正是 `omb_status` 的提供者，必然在场。
             */
            kernel.report(health())
            const status = created.status()
            const lines = [status.detail]
            if (status.available) {
              lines.push(
                `已发 ${status.sent} 条、抑制 ${status.suppressed} 条`
                + `（抑制 = 被节流/去重/超上限/宿主拒绝；最近一次原因：${status.lastReason ?? '无'}）`,
              )
            } else {
              // 不可用时这三个数**没有意义**——它们是"没测到"，不是"测到 0"。
              lines.push('已发/抑制：不可测（服务未接上，这两个计数不会被更新——不是 0）')
            }
            lines.push(`节流：同类型 ${NOTIFY_THROTTLE_MS / 60000} 分钟 1 条、同会话内同内容只发一次、单会话上限 ${NOTIFY_SESSION_LIMIT} 条`)
            return lines.join('\n')
          } catch (error) {
            return `渲染失败：${messageOf(error)}`
          }
        },
        metrics: (): Readonly<Record<string, number>> => {
          try {
            const status = created.status()
            return { available: status.available ? 1 : 0, sent: status.sent, suppressed: status.suppressed }
          } catch {
            return { renderError: 1 }
          }
        },
      }
      try {
        const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
        if (registry === undefined) {
          kernel.logger.warn(`${NOTIFY_MODULE_ID}：未找到状态面登记处，本模块段落不会出现在 omb_status`)
        } else {
          statusUnregister = registry.register(statusContributor)
        }
      } catch (error) {
        kernel.logger.warn(`${NOTIFY_MODULE_ID}：状态面登记失败——${messageOf(error)}`)
      }

      /**
       * 健康转变跟踪：**只在"非 failed → failed"的转变时打扰**。
       * 首次看到某模块的健康时只记录（那是启动结果，管理页已经显示了），
       * 因此启动期不会产生任何通知。
       */
      const lastState = new Map<string, ModuleHealth['state']>()
      const unsubscribe = kernel.on('kernel/module-health', payload => {
        if (payload.id === NOTIFY_MODULE_ID) return // 自己坏了也没有桥可用
        const previous = lastState.get(payload.id)
        lastState.set(payload.id, payload.health.state)
        if (!config.notifyModuleFailures) return
        if (previous === undefined || previous === 'failed') return
        if (payload.health.state !== 'failed') return
        // 标题给人看、正文放细节：宿主对空标题一律拒绝，且标题过短才看得清。
        created.push(
          KERNEL_FAILURE_KIND,
          `OMB 模块 ${payload.id} 运行中失败`,
          payload.health.detail,
          undefined,
          'critical',
        )
      })

      /**
       * 依赖断裂：**前置组件被关掉，依赖它的模块随之失效**。
       *
       * ## 这条通知补的是谁的缺口
       *
       * 宿主不会替用户检查这件事。实测（`D:\Program\deepseek-harness`）：
       * 插件管理器的写路径从不读一行的 `inject`（`plugin-manager/src/index.ts:424-435`
       * 只写 `disabled` 就落盘），被关掉的只是 **fiber**——依赖方被卸载到
       * PENDING（`vendor/cordis/src/fiber.ts:611-639`），而**它自己的行仍然是启用状态**，
       * 页面上只显示一行"等待依赖"。用户于是看到"我关了一个，另一个还在，
       * 但好像不干活了"，没有任何地方告诉他是谁连累了谁。
       *
       * ## 为什么只认 `unmount`
       *
       * 启动期只有挂载、没有卸下，因此这条通知**天然不会在启动时打扰**——
       * 不需要像上面那条一样额外做"首轮不报"的判断。
       * 内核整体注销时的卸下也不会走到这里（账本那边 `disposed` 已经拦掉）。
       */
      const unsubscribeGraph = kernel.on('kernel/module-graph-changed', payload => {
        if (!config.notifyDependencyBroken) return
        if (payload.change !== 'unmount') return
        if (payload.id === NOTIFY_MODULE_ID) return // 自己被关掉了，没有桥可用
        if (payload.dependents.length === 0) return
        const list = payload.dependents.join('、')
        created.push(
          KERNEL_DEPENDENCY_BROKEN_KIND,
          `OMB：${payload.id} 已关闭，依赖它的 ${payload.dependents.length} 个模块已失效`,
          `依赖 ${payload.id} 的模块：${list}。`
            + '它们仍在启用状态，但拿不到前置，只会静默降级或空转。'
            + `要恢复：在插件页把 ${payload.id} 那一行重新打开。`,
          undefined,
          'normal',
          // 正文里让用户"去插件页把那一行打开"——那就把入口一起给上。
          // 2.0.0 的 `click` 四态里 `page` 正是为这种跳转准备的；
          // 老版本不认识它，按协议忽略未知字段，不会因此拒绝。
          { type: 'page', page: 'plugins' },
        )
      })
      kernel.report(health())

      return () => {
        try {
          unsubscribe()
        } catch (error) {
          kernel.logger.warn(`通知：注销事件订阅失败（已隔离）——${String(error)}`)
        }
        try {
          unsubscribeGraph()
        } catch (error) {
          kernel.logger.warn(`通知：注销模块图订阅失败（已隔离）——${String(error)}`)
        }
        try {
          unprovide()
          statusUnregister?.()
          statusUnregister = undefined
        } catch (error) {
          kernel.logger.warn(`通知：注销服务失败（已隔离）——${String(error)}`)
        }
        bridge = undefined
      }
    },
  }
}

export const notifyModule = createNotifyModule()

export default toHostPlugin(notifyModule)