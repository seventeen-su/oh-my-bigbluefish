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

/** 宿主 ctx 的最小结构面。 */
interface HostCtxLike {
  get?(name: string): unknown
}

/** 判断拿到的对象是否"已经是我们的内核"（而不是宿主 ctx）。 */
export function isKernel(value: unknown): value is Kernel {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { service?: unknown; services?: unknown; pressure?: unknown }
  return typeof candidate.service === 'function'
    && typeof candidate.services === 'function'
    && typeof candidate.pressure === 'function'
}

/**
 * 解析出真正的内核。
 *
 * @param first `apply` 的第一个参数（可能是内核，也可能是宿主 ctx）。
 * @returns 内核；两条路径都取不到时返回 `undefined`（调用方如实降级，不抛）。
 */
export function resolveKernel(first: unknown): Kernel | undefined {
  if (isKernel(first)) return first
  const ctx = first as HostCtxLike | null | undefined
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  try {
    const found = ctx.get(SERVICES.kernel)
    return isKernel(found) ? found : undefined
  } catch {
    return undefined
  }
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
    apply(first: unknown, config?: unknown): () => void {
      const kernel = resolveKernel(first)
      if (kernel === undefined) {
        // 不是错误：宿主可能先加载模块行、内核稍后才注册服务。
        // 如实降级——不提供能力，但绝不抛（抛会让这一行在插件页显示激活失败）。
        return () => {}
      }
      const parsed = config ?? registration.manifest.configSchema.parse(undefined)
      try {
        const result = registration.apply(kernel, parsed as T)
        return typeof result === 'function' ? result : () => {}
      } catch (error) {
        // H-1：disposer 与启动路径都不得把异常抛回宿主。
        // 启动失败记在健康面（内核会捕获并记 failed），这里只保证不逃逸。
        kernel.logger.warn(
          `OMB：模块 ${registration.manifest.id} 启动抛异常——${error instanceof Error ? error.message : String(error)}`,
        )
        return () => {}
      }
    },
  }
}
