/**
 * 模块清单——内核与模块之间的唯一契约。
 *
 * `id` 有三个身份，必须完全一致：
 * ① `cordis.patch.yml` 的行 id ② 插件管理页的开关 id ③ 内核注册表的键。
 */
import type { Kernel } from './kernel.js'

/**
 * 配置 schema 的最小结构接口。
 *
 * 只要求 `parse`——不引 zod 类型，使 `kernel/` 对第三方校验库零依赖；
 * 实现方可传 zod / schemastery / 手写校验器。
 */
export interface ConfigSchema<T> {
  parse(input: unknown): T
}

/** 模块清单。 */
export interface ModuleManifest<TConfig = unknown> {
  /** 稳定标识 = cordis.patch.yml 行 id = 插件页开关 id。 */
  readonly id: string
  readonly version: string
  /** 依赖的模块 id；内核校验存在性并做拓扑排序，缺失即 failed（不抛到会话）。 */
  readonly requires: readonly string[]
  /** 可选依赖：缺失时模块自行降级，不算失败。 */
  readonly optional?: readonly string[]
  /** 对外能力名（状态面与投影列出）。 */
  readonly capabilities: readonly string[]
  /** 配置 schema；**缺省值必须完整**，使 apply 永远收到完整配置。 */
  readonly configSchema: ConfigSchema<TConfig>
  /** 健康检查。必须返回可读的 detail（无空降级）。 */
  readonly health: () => ModuleHealth | Promise<ModuleHealth>
}

/** 模块对外声明的健康。 */
export interface ModuleHealth {
  readonly state: 'ok' | 'degraded' | 'failed'
  /** 必须写明原因：不是"不可用"，而是"onnxruntime-node 未安装"这类可行动信息。 */
  readonly detail: string
  readonly metrics?: Readonly<Record<string, number>>
}

/**
 * 模块实现。由 `dsh/` 侧调用。
 *
 * **硬约束（热插拔要求）**：
 * - 一切注册走 `ctx.effect`（宿主侧），卸载自动回收
 * - **不得**在 `apply` 返回后异步注册工具/提示段/投影
 *   （DSH 挂载审计只查一次，事后注册会触发进程级失败告警）
 * - **`dispose` 绝不抛异常**：宿主 `reconcileProfilePatches` 会 await 旧 fiber，
 *   一旦 reject 会让整次开关操作失败
 */
export interface ModuleRegistration<TConfig = unknown> {
  readonly manifest: ModuleManifest<TConfig>
  apply(kernel: Kernel, config: TConfig): void | (() => void | Promise<void>)
}
