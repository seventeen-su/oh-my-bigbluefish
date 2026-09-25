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
import type { Kernel, ModuleRegistration } from './abi/index.js'
import { SERVICES } from './abi/index.js'

/** `cordis.patch.yml` 的 `name` 指向 `dsh/kernel.ts`。 */
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
        await waitForKernel(first)
        if (cancelled) return
        const kernel = resolveKernel(first)
        if (kernel === undefined) return // 内核行被禁用：如实不提供能力，不抛
        const parsed = config ?? registration.manifest.configSchema.parse(undefined)
        try {
          const result = registration.apply(kernel, parsed as T)
          if (typeof result === 'function') dispose = result
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
