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
import { SERVICES } from '../../kernel/abi/index.js'
import type { DesktopNotifyLike, NotifyUrgency } from './bridge.js'
import { DEFAULT_NOTIFY_SESSION, NOTIFY_SESSION_LIMIT, NOTIFY_THROTTLE_MS, NotifyBridge } from './bridge.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export const NOTIFY_MODULE_ID = 'omb-notify'
/** 服务名取 ABI 契约里的 `SERVICES.notify`（不是本地约定）。 */
export const NOTIFY_SERVICE = SERVICES.notify
export const NOTIFY_VERSION = '3.0.0'

/**
 * 宿主服务名。`dsh/` 侧把 `ctx.get('desktopNotify')` 注册进内核服务表后，
 * 桥在下一次推送时自动取到——这就是"零改码自动接上"。
 */
export const NOTIFY_HOST_SERVICE = 'desktopNotify'

/** 唯一保留的内核事件通知种类：**中途**失败的模块（启动失败不打扰）。 */
export const KERNEL_FAILURE_KIND = 'kernel-module-failed'

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
}

export const NOTIFY_DEFAULT_CONFIG: NotifyConfig = { notifyModuleFailures: false }

export const notifyConfigSchema = z
  .object({ notifyModuleFailures: z.boolean().default(false) })
  .default(NOTIFY_DEFAULT_CONFIG)

export interface NotifyService {
  /**
   * 推送一条通知；返回是否真的发出（探测不到/被宿主拒绝就是 false，绝不抛）。
   * @param kind 节流与去重用的类型键（不给人看）。
   * @param title **必填**——宿主对空标题一律拒绝。
   * @param message 正文，可选。
   */
  push(
    kind: string,
    title: string,
    message?: string,
    sessionId?: string,
    urgency?: NotifyUrgency,
  ): boolean
  status(): { readonly available: boolean; readonly detail: string; readonly sent: number; readonly suppressed: number }
}

export function createNotifyModule(): ModuleRegistration<NotifyConfig> {
  function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let bridge: NotifyBridge | undefined
/** 状态面登记的注销函数；dispose 时必须调，否则热插拔会留下悬空段落。 */
let statusUnregister: (() => void) | undefined
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
    requires: ['omb-kernel'],
    capabilities: ['notify.external'],
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
        push: (kind, title, message, sessionId = DEFAULT_NOTIFY_SESSION, urgency = 'normal') =>
          created.push(kind, title, message, sessionId, urgency),
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
      kernel.report(health())

      return () => {
        try {
          unsubscribe()
        } catch (error) {
          kernel.logger.warn(`通知：注销事件订阅失败（已隔离）——${String(error)}`)
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
