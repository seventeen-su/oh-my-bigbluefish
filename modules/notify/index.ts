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
import { SERVICES } from '../../kernel/abi/index.js'
import type { DesktopNotifyLike } from './bridge.js'
import { DEFAULT_NOTIFY_SESSION, NotifyBridge } from './bridge.js'

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
  /** 推送一条通知；返回是否真的发出（探测不到就是 false，绝不抛）。 */
  push(kind: string, message: string, sessionId?: string): boolean
  status(): { readonly available: boolean; readonly detail: string }
}

export function createNotifyModule(): ModuleRegistration<NotifyConfig> {
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
        push: (kind, message, sessionId = DEFAULT_NOTIFY_SESSION) =>
          created.push(kind, message, sessionId),
        status: () => {
          const status = created.status()
          return { available: status.available, detail: status.detail }
        },
      }

      const unprovide = kernel.provide(NOTIFY_SERVICE, service)
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
        created.push(KERNEL_FAILURE_KIND, `模块 ${payload.id} 运行中失败：${payload.health.detail}`)
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
        } catch (error) {
          kernel.logger.warn(`通知：注销服务失败（已隔离）——${String(error)}`)
        }
        bridge = undefined
      }
    },
  }
}

export const notifyModule = createNotifyModule()

export default notifyModule
