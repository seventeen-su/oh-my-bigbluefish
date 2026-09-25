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
   * 幂等——重复调用不改变注册（除非某个来源刚被 `invalidate` 标记重挂）。
   */
  sync(): void
  /**
   * 标记某来源已重挂：它的工具闭包换代了，下次 `sync()` 必须替换注册。
   *
   * 为什么需要显式标记：模块的 `tools:` 服务可能每次访问都返回新对象，
   * 「对象变了就重注册」会让每次 `sync()` 都重注册（实测唯一名单 7 个、
   * 调用 29 次）。而"重挂了"这件事**只有挂载方知道**。
   */
  invalidate(origin: string): void
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
  /** 每个来源（模块 id / `omb-kernel`）的世代；`invalidate` 时递增。 */
  const generations = new Map<string, number>()
  /** 注册时记录的世代；与当前世代不符才替换。 */
  const registeredAt = new Map<string, number>()
  /** 已知的工具（含模块还没挂载时先加的）。 */
  const extra: RegistrableTool[] = []

  const bridge: ToolBridge = {
    attach(nextHost, nextSource) {
      host = nextHost
      source = nextSource
      bridge.sync()
    },
    add(tools, origin) {
      // **重挂时必须换掉旧实例**，不能因为名字已存在就 `continue`。
      //
      // 这条与 `sync` 里的替换是同一个坑，但发生在另一条路径上：
      // `add` 注册的是内核自带的 `omb_status` 等工具，而它们的闭包里**握着一个
      // 内核实例**（`buildStatusTool(handle, sessions)`）。内核行重挂后旧实例仍在
      // 注册表里，于是工具跑的是**上一代内核**——它的 `sessions` 表是空的。
      //
      // 实测症状极难判读：工具报的「会话→cwd 映射」是 0，而模块行报 1；
      // 于是 `omb_focus` 一直"取不到当前会话标识"（工具问的是旧实例的活跃会话表，
      // 而会话事件灌进的是新实例）。两处数字对不上就是最直接的线索。
      //
      // 注：这两处的字段**已经改名**，不再是同名不同表——模块段现在写
      // 「本模块会话→cwd 登记」（`modules/memory/store.ts` 自己维护的
      // `cwdBySession`），内核行的 `SessionTable` 才是本文件的 `sessions`。
      // 同名曾经让自检报告把它当成"同一份输出的自相矛盾"记了两次。
      const names = new Set(tools.map(tool => tool.name))
      for (let i = extra.length - 1; i >= 0; i -= 1) {
        if (names.has(extra[i]!.name)) extra.splice(i, 1)
      }
      for (const tool of tools) extra.push(tool)
      void origin
      // **先标世代失效再同步**：`sync` 只在"来源重挂过"时才替换已注册的同名工具
      // （见那边的注释）。内核行重挂时 `add` 被调用，正是那个信号。
      bridge.invalidate('omb-kernel')
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
        // **只在来源重挂后才替换**，普通重放不动注册。
        //
        // 为什么不比较工具对象：模块的 `tools:` 服务可能每次访问都返回新对象，
        // 「对象变了就重注册」会让每次 `sync()` 都重注册（实测唯一名单 7 个、
        // 调用 29 次）。而"重挂了要换新闭包"这件事**只有调用方知道**，
        // 所以由 `add` 与 `hostEntry` 在挂载后调 `invalidate`。
        const generation = generations.get(origin) ?? 0
        const previous = registered.get(tool.name)
        const already = previous !== undefined
        const stale = already && (registeredAt.get(tool.name) ?? -1) !== generation
        if (already && !stale) continue
        try {
          // **必须经 `toHostTool`**：宿主 `tools.register()` 要求
          // `output { schema, render }`，缺了会抛
          // `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`
          // （`packages/core/tools/src/index.ts:1066-1070`）。
          // 这里曾手搓注册对象、漏了 `output`，于是**每一个 OMB 工具都被拒绝**
          // 而异常被下面的 catch 吞成一条 warn——工具面全空、纤维状态却全正常。
          //
          // **必须先注销旧的再注册新的**：宿主 `NamedEntries.insert` 在名字已存在时
          // **直接抛错**（`packages/core/scope/src/store.ts:45`），不是覆盖。
          // 反过来做（先注册新的）会撞名抛错、被下面的 catch 吞掉，
          // 于是宿主永远留着旧闭包——实测 `omb_focus` 代码修好了却仍是旧行为。
          if (previous !== undefined) {
            try {
              previous()
            } catch {
              // H-1：disposer 绝不抛
            }
            registered.delete(tool.name)
            registeredAt.delete(tool.name)
          }
          const off = host.register(toHostTool(tool))
          registered.set(tool.name, typeof off === 'function' ? (off as () => void) : () => {})
          registeredAt.set(tool.name, generation)
        } catch (error) {
          // 单个工具失败不影响其余（宿主对重名/形状非法会抛）
          source?.logger.warn(
            `OMB：工具 ${tool.name}（来自 ${origin}）注册失败——${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    },
    invalidate(origin) {
      // 该来源重挂了：它的工具闭包已换代，下次 sync 必须替换
      generations.set(origin, (generations.get(origin) ?? 0) + 1)
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
