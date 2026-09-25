/**
 * 工具桥：把"模块注册了工具服务"变成"宿主的工具面里真的出现这些工具"。
 *
 * **为什么需要它**（实测故障）：内核的 `apply` 是**同步**的，而模块行由宿主
 * **异步**加载（Cordis 先等 `inject: ['omb:kernel']` 就绪，再在微任务里挂载）。
 * 于是内核在 `apply` 那一刻收集工具时，模块还没注册任何东西——
 * 结果只有内核自带的 `omb_status` 进了工具面，其余 7 个工具**全部消失**，
 * 而健康面一切正常（模块确实起来了）。这是"看起来全对、功能却不在"的典型。
 *
 * **做法**：注册**幂等**且可在模块挂载后重放。
 * - `sync()` 收集当前所有 `tools:<模块 id>` 服务，只注册**还没注册过**的工具
 * - 每次有模块挂载完成就调一次 `sync()`（模块内工具数量有限，代价可忽略）
 * - 同名工具只注册第一个（宿主 `tools.register` 对重名会抛，而抛会让整批失败）
 */
import type { ToolDefinition } from '../kernel/abi/index.js'
import { SERVICES } from '../kernel/abi/index.js'
import { toHostTool, type ToolSpec } from './tools.js'

/** `tools.register` 的最小结构面（宿主提供）。 */
export interface HostToolsLike {
  register(definition: unknown): unknown
}

/** 一个待注册的工具：**统一用本插件的 `ToolSpec` 形状**。
 *
 * 不用宿主形状：`toHostTool` 是唯一补齐宿主契约（`output { schema, render }`）的地方，
 * 绕过它就会漏字段——实测因此让每个 OMB 工具都被宿主拒绝，
 * 而异常被 catch 吞成一条 warn，工具面全空、纤维状态却全正常。
 */
export type RegistrableTool = ToolSpec

/** 从内核服务表读工具声明的入口。 */
export interface ToolSource {
  services(): readonly string[]
  service<T>(name: string): T | undefined
  readonly logger: { warn(message: string): void }
}

export interface ToolBridge {
  /** 把内核与宿主 tools 服务接到桥上。 */
  attach(host: HostToolsLike | undefined, source: ToolSource): void
  /** 注册额外工具（内核自带的 `omb_status` 等）。 */
  add(tools: readonly RegistrableTool[], origin: string): void
  /**
   * 同步一次：注册所有尚未注册的工具。
   * 幂等——重复调用只注册新增的。
   */
  sync(): void
  /** 当前已注册的工具名（诊断用）。 */
  registered(): readonly string[]
  /** 注销全部已注册工具（disposer，绝不抛）。 */
  dispose(): void
}

export function createToolBridge(): ToolBridge {
  let host: HostToolsLike | undefined
  let source: ToolSource | undefined
  /** 已注册的工具名 → 宿主返回的 disposer。 */
  const registered = new Map<string, () => void>()
  /** 已知的工具（含模块还没挂载时先加的）。 */
  const extra: RegistrableTool[] = []

  const bridge: ToolBridge = {
    attach(nextHost, nextSource) {
      host = nextHost
      source = nextSource
      bridge.sync()
    },
    add(tools, origin) {
      for (const tool of tools) {
        if (registered.has(tool.name) || extra.some(t => t.name === tool.name)) continue
        extra.push(tool)
        void origin
      }
      bridge.sync()
    },
    sync() {
      if (host === undefined) return
      const pending: { tool: RegistrableTool; origin: string }[] = extra.map(tool => ({
        tool,
        origin: 'omb-kernel',
      }))
      if (source !== undefined) {
        for (const serviceName of source.services()) {
          if (!serviceName.startsWith(SERVICES.toolsPrefix)) continue
          const declared = source.service<readonly ToolDefinition[]>(serviceName)
          if (!Array.isArray(declared)) continue
          for (const definition of declared) {
            const tool = toRegistrable(definition)
            if (tool !== undefined) pending.push({ tool, origin: serviceName })
          }
        }
      }

      for (const { tool, origin } of pending) {
        if (registered.has(tool.name)) continue
        try {
          // **必须经 `toHostTool`**：宿主 `tools.register()` 要求
          // `output { schema, render }`，缺了会抛
          // `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`
          // （`packages/core/tools/src/index.ts:1066-1070`）。
          // 这里曾手搓注册对象、漏了 `output`，于是**每一个 OMB 工具都被拒绝**
          // 而异常被下面的 catch 吞成一条 warn——工具面全空、纤维状态却全正常。
          const off = host.register(
            toHostTool(tool),
          )
          registered.set(tool.name, typeof off === 'function' ? (off as () => void) : () => {})
        } catch (error) {
          // 单个工具失败不影响其余（宿主对重名/形状非法会抛）
          source?.logger.warn(
            `OMB：工具 ${tool.name}（来自 ${origin}）注册失败——${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    },
    registered: () => [...registered.keys()].sort(),
    dispose() {
      for (const [name, off] of registered) {
        try {
          off()
        } catch {
          // H-1：disposer 绝不抛
          void name
        }
      }
      registered.clear()
    },
  }
  return bridge
}

/** 把模块声明的 `ToolDefinition` 转成 `ToolSpec`；形状不符返回 undefined。 */
export function toRegistrable(definition: ToolDefinition): RegistrableTool | undefined {
  if (typeof definition?.name !== 'string' || definition.name.length === 0) return undefined
  if (typeof definition.description !== 'string') return undefined
  if (typeof definition.execute !== 'function') return undefined
  const parameters = (definition.parameters as unknown as { jsonSchema?: Record<string, unknown> })
    .jsonSchema
  return {
    name: definition.name,
    description: definition.description,
    parameters: parameters ?? { type: 'object', properties: {} },
    // 模块的 `execute` 契约是"返回 ToolOutcome 或抛"；桥统一成 ToolSpec 的 run
    run: (args: unknown) => definition.execute(args),
  }
}
