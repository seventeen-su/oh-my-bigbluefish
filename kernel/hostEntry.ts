/**
 * 模块入口的宿主契约适配。
 *
 * **背景（实测教训）**：在 DSH 0.1.7 的加载模型下，`cordis.patch.yml` 的
 * **每一行都是宿主独立加载的插件**——宿主按 `apply(ctx, config)` 调用它，
 * `ctx` 是**宿主 ctx 代理**，我们的内核无法介入。于是模块入口里那句
 * `kernel.clock` / `kernel.service(...)` 会被 Cordis 的 Guard 拦下：
 *
 * ```
 * Error: cannot get property "clock" without inject
 * ```
 *
 * 症状是"插件半活"：工具面与提示注入正常（那些走 `ctx.get`），
 * 而依赖内核能力的模块全部激活失败——最难排查的一种状态。
 *
 * **修法**：模块入口不再假设第一参是内核，而是先判断拿到的是什么：
 * - 已经是内核（内核自己按依赖顺序启动模块时）→ 直接用
 * - 是宿主 ctx（宿主按行加载时）→ 经 `ctx.get(SERVICES.kernel)` 取内核
 *
 * 这样同一份模块定义在**两条路径**下都成立，且模块实现一行不改。
 */
import { createRequire } from 'node:module'
import type { Kernel, ModuleRegistration } from './abi/index.js'

const require = createRequire(import.meta.url)
import { SERVICES } from './abi/index.js'

/** `cordis.patch.yml` 的 `omb-kernel` 行 id（行名是组件包名 `@omb/kernel`）。 */
export const KERNEL_ENTRY_NAME = 'omb-kernel'

/** 宿主 ctx 的最小结构面。**只声明 `get`/`on`**——其余属性一概不摸（Guard 会抛）。 */
interface HostCtxLike {
  get?(name: string): unknown
  on?(event: string, fn: unknown): unknown
}

/**
 * 模块入口在宿主 ctx 上等待的"内核就绪"键。
 *
 * **为什么需要它**：宿主按行加载，无法保证内核行先完成 `apply`。
 * 而我们的内核服务注册在**内核自己的服务表**里，宿主 `ctx.get()` 查的是
 * **宿主的**服务表——两者不通。所以内核行必须把一个**就绪 promise**
 * 发布到宿主 ctx（`ctx.provide('ombReady', …)`），模块行 `await` 它。
 *
 * 实测教训：没有这一层时，8 个模块全部"正常"却什么都没做——
 * `resolveKernel` 对每一行都返回 undefined，兜底成空 disposer，
 * 表现为**静默空转**（比报错更难发现）。
 */
export const KERNEL_READY_KEY = 'ombReady'

/**
 * 内核标记。
 *
 * **为什么需要显式标记**：不能用"读几个属性看看"来认内核——
 * 宿主 ctx 是个 **Proxy**，Guard 对未 `inject` 的属性读写直接抛。
 * 实测：`typeof ctx.service` 会抛 `cannot get property "service" without inject`，
 * 于是"探测"本身变成了失败原因（这正是本文件上一版踩的坑）。
 *
 * 所以：认内核只看一个**自有**标记，其余一律不摸。
 */
export const KERNEL_MARKER = '__ombKernel'

/**
 * 内核句柄标记。挂在**句柄**上（不是内核上），供 `toHostPlugin` 拿到 `mount`。
 *
 * 为什么不把句柄发布到宿主 ctx：多一个公开服务键就多一处冲突面，
 * 而模块入口只需要"能挂载自己"这一件事。
 */
export const HANDLE_MARKER = '__ombKernelHandle'

/**
 * 给内核句柄打标记：**把句柄自己挂在句柄上**。
 *
 * 模块入口（`toHostPlugin`）靠它拿回 `mount`，从而让模块自报的健康绑定到模块 id。
 * 不把句柄发布到宿主 ctx——多一个公开服务键就多一处冲突面，
 * 而模块入口只需要"能挂载自己"这一件事。
 *
 * 只写一次这个键：`Object.defineProperty` 默认不可配置，重复写会抛
 * （踩过一次：先写 `true` 再想改成句柄，第二次静默失败）。
 */
export function markKernelHandle(handle: object): void {
  try {
    Object.defineProperty(handle, HANDLE_MARKER, { value: handle, enumerable: false })
  } catch {
    // 打不上标记时模块入口走"直接调用"退路（健康绑定会丢失，状态面如实显示"未自报"）
  }
  // **同时挂到内核对象上**：模型入口拿到的是**内核**（`ctx.get('omb:kernel')` 返回的
  // 是它），而不是句柄。只挂在句柄上会让 `kernelHandleOf(kernel)` 找不到——
  // 实测就是这么静默失败的（marker 写在了不同对象上）。
  const kernel = (handle as { kernel?: unknown }).kernel
  if (typeof kernel === 'object' && kernel !== null) {
    try {
      Object.defineProperty(kernel, HANDLE_MARKER, { value: handle, enumerable: false })
    } catch {
      // 同上，退路
    }
  }
}

/** 从内核对象取回内核句柄；不是我们的内核或未打标记时返回 undefined。 */
export function kernelHandleOf(kernel: unknown): KernelHandleLike | undefined {
  if (typeof kernel !== 'object' || kernel === null) return undefined
  try {
    const candidate = (kernel as Record<string, unknown>)[HANDLE_MARKER]
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const mount = (candidate as { mount?: unknown }).mount
    return typeof mount === 'function' ? (candidate as KernelHandleLike) : undefined
  } catch {
    return undefined
  }
}

/** `toHostPlugin` 只需要句柄上的这一个能力——不 import `kernel/index.js`，避免环。 */
export interface KernelHandleLike {
  mount(registration: ModuleRegistration<unknown>, hostCtx?: unknown): () => void
}

/** 内核行提供"动作型注册重放"时用的服务名。 */
export const TOOL_BRIDGE_SERVICE = 'omb:tool-bridge'

/**
 * 模块挂载完成后，触发一次"把动作型注册同步给宿主"。
 *
 * **为什么需要**：内核行在 `apply` 里注册工具，而模块行是**异步**挂载的
 * （Cordis 先等 `inject` 就绪，再在微任务里挂载）。内核注册那一刻模块还没有
 * 任何工具服务，于是模块的工具**全部消失**——健康面却一切正常
 * （实测：工具面只剩内核自带的 `omb_status`）。
 *
 * 由服务名解耦：内核不 import `dsh/`，模块入口不认识 `dsh/`，双方只认这个键。
 */
export function replayModuleRegistrations(kernel: Kernel, moduleId: string): void {
  try {
    const bridge = kernel.service<{ sync(): void }>(TOOL_BRIDGE_SERVICE)
    if (bridge === undefined || typeof bridge.sync !== 'function') return
    bridge.sync()
  } catch (error) {
    // 重放失败不得影响模块挂载本身；但要留声（工具会缺席）
    process.stderr.write(
      `OMB：模块 ${moduleId} 挂载后的注册重放失败——${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

/**
 * 等待内核就绪。
 *
 * 内核行会把一个 promise 发布到宿主 ctx 的 `KERNEL_READY_KEY` 上；
 * 模块行在 `apply` 开头 await 它，然后才解析内核。
 *
 * 为什么必须这样：宿主按行加载，**无法保证内核行先完成 `apply`**；
 * 而我们的内核服务注册在**内核自己的服务表**里，宿主 `ctx.get()` 查的是
 * **宿主的**服务表——两者不通。所以只能靠内核行主动发布一个就绪 promise。
 *
 * @returns 就绪时 true；宿主没提供（内核行被禁用等）时 false——调用方如实跳过。
 */
export async function waitForKernel(first: unknown): Promise<boolean> {
  // 只摸 get 一个属性：宿主 ctx 是 Proxy，其余属性可能触发 Guard 抛错
  if (typeof first !== 'object' || first === null) return false
  let get: unknown
  try {
    get = (first as { get?: unknown }).get
  } catch {
    return false
  }
  if (typeof get !== 'function') return false
  let ready: unknown
  try {
    ready = (get as (name: string) => unknown).call(first, KERNEL_READY_KEY)
  } catch {
    return false
  }
  if (ready === null || ready === undefined) return false
  try {
    await (ready as Promise<unknown>)
    return true
  } catch {
    return false
  }
}

/** 给内核打标记（幂等）。`createKernel` 调用一次即可。 */
export function markKernel(kernel: object): void {
  try {
    Object.defineProperty(kernel, KERNEL_MARKER, { value: true, enumerable: false })
  } catch {
    // 打不上标记时仍可经宿主 ctx 的 get 路径取用；不抛
  }
}

/** 判断拿到的对象是否"已经是我们的内核"。**只读一个自有标记，绝不摸其他属性**。 */
export function isKernel(value: unknown): value is Kernel {
  if (typeof value !== 'object' || value === null) return false
  try {
    return (value as Record<string, unknown>)[KERNEL_MARKER] === true
  } catch {
    return false
  }
}

/**
 * 心跳日志（诊断用）。
 *
 * 为什么保留：宿主按行加载时，"内核行到底有没有把服务发布出去""模块行有没有
 * 取到内核"这两件事在宿主内部发生，**不写日志就只能靠推断**——本项目已经因为
 * 推断宿主 ctx 语义而反复返工。心跳把这条链路变成可读事实。
 *
 * 写文件失败一律忽略：诊断不得影响功能。
 */
export function heartbeat(stage: string, detail: Record<string, unknown> = {}): void {
  try {
    // 动态 import 会变成异步，这里用同步写入；路径固定在仓库根，方便直接查看
    const line = `${JSON.stringify({ at: new Date().toISOString(), stage, ...detail })}\n`
     
    const fs = require('node:fs') as { appendFileSync(p: string, d: string): void }
    fs.appendFileSync('D:/Program/Oh-My-BigBlueFish/.omb-heartbeat.jsonl', line)
  } catch {
    // 诊断失败不影响功能
  }
}

/**
 * 解析出真正的内核。
 *
 * 顺序很重要：**先判宿主 ctx**（只看 `get` 是否可调用），再判内核标记。
 * 反过来会让 `typeof ctx.service` 触发 Guard 而抛错。
 */
export function resolveKernel(first: unknown): Kernel | undefined {
  if (typeof first !== 'object' || first === null) return undefined
  const asCtx = first as HostCtxLike
  // ① 宿主 ctx：有可调用的 get → 从服务表取内核
  let hostGet: unknown
  try {
    hostGet = asCtx.get
  } catch {
    hostGet = undefined // Guard 拒绝 → 说明这只是个受限代理，不是内核
  }
  if (typeof hostGet === 'function') {
    try {
      const found = (hostGet as (name: string) => unknown).call(first, SERVICES.kernel)
      return isKernel(found) ? found : undefined
    } catch {
      return undefined
    }
  }
  // ② 直接就是内核（内核按依赖顺序启动模块时走这条）
  return isKernel(first) ? first : undefined
}

/**
 * 把一个模块注册项包成宿主可独立加载的 Cordis 插件。
 *
 * 宿主按行加载时调用返回的 `apply(ctx, config)`；内核按依赖顺序启动时
 * 直接把内核传进来。两条路径走同一份模块实现。
 *
 * 取不到内核时**不抛**——记一条日志并返回空 disposer。这样"内核没起来"
 * 表现为该模块不提供能力（其余模块与宿主都不受影响），而不是一行激活失败。
 */
export function toHostPlugin<T>(registration: ModuleRegistration<T>): {
  readonly manifest: ModuleRegistration<T>['manifest']
  apply(first: unknown, config?: unknown): () => void
} {
  return {
    manifest: registration.manifest,
    /**
     * **同步返回 disposer**（宿主契约：`apply` 不得返回 Promise——
     * 宿主会把它当 disposer 存起来，注销时调用一个 Promise 等于什么都没做）。
     *
     * 内核就绪的等待放在**后台微任务**里，满足两个约束：
     * - `ctx.get()` 查的是**宿主**服务表，而内核行**同步**完成 `provide`
     *   （`dsh/plugin.ts` 的 `markReady()` 在任何 await 之前），因此解析必然成功；
     * - 注册发生在 `apply` 返回后的微任务里，但 Cordis 的 fiber 此时仍存活，
     *   服务与事件订阅照常归属该 fiber。
     */
    apply(first: unknown, config?: unknown): () => void {
      let dispose: (() => void) | undefined
      let cancelled = false
      void (async (): Promise<void> => {
        const ready = await waitForKernel(first)
        if (cancelled) return
        const kernel = resolveKernel(first)
        heartbeat('module-apply', {
          id: registration.manifest.id,
          ready,
          kernelFound: kernel !== undefined,
          hasConfig: config !== undefined,
        })
        if (kernel === undefined) {
          // **不静默**：走不到内核时必须留声。这条曾经是无声 `return`，
          // 结果 5 个模块"挂载成功但什么都没做"，排查了很久。
          // 用 stderr 而不是 logger：logger 可能还没建立（内核对不上就是这种情形）。
          process.stderr.write(
            `OMB：模块 ${registration.manifest.id} 取不到内核`
            + `（ready=${String(ready)}）——本行不会提供任何能力。`
            + '常见原因：patch 行缺 `inject: [\'omb:kernel\']`，或入口用错了导出'
            + '（具名注册项 vs default 宿主包装器）。\n',
          )
          return
        }
        try {
          // 走 `mount`（若这个内核是我们造的）：它绑定健康上报——`kernel.report`
          // 自动带上本模块 id——并用 schema 缺省值补全配置、把失败记进健康面。
          //
          // **不要**直接 `registration.apply(...)`：那样模块自报的健康会落到
          // 未绑定 id 的兜底实现上，状态面永远是"已启动（未自报健康）"。
          const handle = kernelHandleOf(kernel)
          if (handle !== undefined) {
            dispose = handle.mount(registration as ModuleRegistration<unknown>, first)
          } else {
            // 外来内核（测试替身等）：退回直接调用，但**如实说明**放弃了健康绑定
            const parsed = config ?? registration.manifest.configSchema.parse(undefined)
            const result = registration.apply(kernel, parsed as T)
            if (typeof result === 'function') dispose = result
          }
          // **把动作型注册重放给宿主**：模块此时才把自己的工具/提示段注册进服务表，
          // 而内核行早已 `apply` 完毕。`toolBridge` 由内核行提供，缺失即跳过。
          replayModuleRegistrations(kernel, registration.manifest.id)
        } catch (error) {
          // H-1：启动路径不得把异常抛回宿主
          kernel.logger.warn(
            `OMB：模块 ${registration.manifest.id} 启动抛异常——${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })()
      return () => {
        cancelled = true
        try {
          dispose?.()
        } catch (error) {
          // H-1：disposer 绝不抛
          void error
        }
      }
    },
  }
}
