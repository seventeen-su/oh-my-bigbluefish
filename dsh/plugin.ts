/**
 * Cordis 插件入口 —— `@omb/kernel` 组件包（`packages/kernel/index.ts`）re-export 本文件，
 * `cordis.patch.yml` 的 `omb-kernel` 行加载的就是它。
 *
 * **运行状态说明**：本文件（内核行）在 DSH 0.1.7-rc.2 上**已验证工作**——
 * 工具面（7 个工具）、常驻提示注入、`omb_status`、拉取台账、会话 cwd 映射
 * 都在真实宿主里确认过。
 *
 * **模块行的加载路径**：`cordis.patch.yml` 里另外 7 个**模块行**由宿主**独立加载**，
 * 行名是各自独立组件包的裸包名（`@omb/<组件>` → `packages/<组件>/index.ts`）。
 * 组件入口的 `default` 是 `toHostPlugin(registration)`：它经
 * `ctx.get('omb:kernel')` 取本内核（依赖顺序由行级 `inject: ['omb:kernel']` 保证），
 * 取不到时**不抛**，只在 stderr 留一条"本行不会提供任何能力"的说明。
 *
 * 三条硬约束（违反即插件加载失败或开关操作失败）：
 *
 * - **H-1**：所有 disposer 绝不抛异常。宿主 `reconcileProfilePatches` 会 await 旧 fiber，
 *   一旦 reject 会让整次插件开关操作失败
 *   （`packages/boot/app-boot/src/index.ts:289-299`）。
 * - **H-2**：不得在 `apply` 返回后**异步**注册工具/提示段。宿主挂载审计只查一次，
 *   事后注册会触发进程级失败告警
 *   （`packages/preset/agent-preset-registry/src/invariant.ts:33-44`）。
 * - **H-3**：服务缺失返回可读错误而非抛异常——模块可能在下一刻被卸下。
 *
 * 本文件**不 import 任何 `@deepseek-ai/*`**（本仓库解析不到它们），
 * 全部经结构化接口访问宿主。
 */
import { createKernel, type KernelHandle } from '../kernel/index.js'
import type { Kernel, ModuleRegistration, ToolDefinition } from '../kernel/abi/index.js'
import { SERVICES, toolsServiceFor } from '../kernel/abi/index.js'
import { KERNEL_READY_KEY, TOOL_BRIDGE_SERVICE, heartbeat } from '../kernel/hostEntry.js'
import { generationFromUrl } from '../kernel/buildInfo.js'
import type { HostContextLike } from './host.js'
import { hostLogger, publishToHost, readService, systemClock } from './host.js'
import { type ToolSpec } from './tools.js'
import { createToolBridge } from './tool-bridge.js'
import {
  SessionTable,
  collectPromptContributions,
  readSystemPrompt,
  wirePromptInjection,
  wireSessionEvents,
} from './session.js'
import { STORAGE_HOST_SERVICE, createStorageHost } from './stores.js'
import { wireArtifactIndex } from './hooks.js'
import { buildStatusTool } from './status-tool.js'
import { loadModulesSync } from './modules.js'
import { MODULE_ENTRIES } from './moduleEntries.js'

/** `cordis.patch.yml` 行 config 的形状。 */
export interface PluginConfig {
  /** 诊断输出开关。**只控制终端输出**，降级记录与状态面任何时候都如实暴露。 */
  debug?: boolean
  /** 显式覆盖 DSH 主目录（便于不经环境变量指定；缺省按 $DSH_HOME → ~/.dsh）。 */
  dshHome?: string
}

export const name = 'omb'
/** 只注入 commands；其余服务一律 `ctx.get` 可选读取，缺失即降级（H-3）。 */
export const inject = ['commands']

/**
 * 微内核自身的注册项。
 *
 * 它不是模块——`modules/` 里没有它，`cordis.patch.yml` 的 `omb-kernel` 行指向的是
 * 本插件入口。但**它必须在注册集合里**：内核的依赖解析要求"`requires` 里的 id
 * 存在于本次启动的集合中"，否则所有声明 `requires: ['omb-kernel']` 的模块会被
 * 整体阻断——表现为"插件装上了，但几乎所有功能都不在"，各自只报"缺少必需依赖"。
 *
 * `apply` 是空操作：内核已由 `createKernel()` 建好。
 */
export const KERNEL_SELF: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.0.0',
    requires: [],
    capabilities: ['kernel.services', 'kernel.events', 'kernel.health', 'kernel.metrics'],
    configSchema: { parse: (input: unknown) => input ?? {} },
    health: () => ({ state: 'ok', detail: '微内核（插件本体，无独立模块资源）' }),
  },
  apply: () => {},
}

/**
 * 插件主体。返回值是 disposer（Cordis 函数插件契约：`apply(ctx, config)`）。
 *
 * 必须**同步返回 disposer**——宿主会把它当注销函数存起来；返回 Promise 等于
 * 注销时调用一个 Promise，什么都没做。
 */
export function apply(ctx: HostContextLike, config: PluginConfig = {}): () => void {
  const logger = hostLogger(ctx)
  const clock = systemClock
  const handle = createKernel({ logger, clock })
  const sessions = new SessionTable()

  // 把"内核就绪"发布到宿主 ctx：模块行由宿主独立加载，需要经宿主 ctx 取内核。
  // 见 `docs/host-wiring-handoff.md`——这一步在真实宿主上**尚未验证成功**，
  // 因此模块行目前会走空转兜底（如实不提供能力，不抛）。
  let markReady!: () => void
  const ready = new Promise<void>(resolve => {
    markReady = resolve
  })
  const readyOk = publishToHost(ctx, KERNEL_READY_KEY, ready)
  const kernelOk = publishToHost(ctx, SERVICES.kernel, handle.kernel)
  // **不要在这里读 ctx 的其他属性**：宿主 ctx 受 Cordis Guard 管，
  // 读任何未 `inject` 的属性都会抛——实测连 `typeof ctx.get` 都抛。
  // 之前的心跳这么干过，直接把内核行打成"激活失败"。
  heartbeat('kernel-apply', { readyPublished: readyOk, kernelPublished: kernelOk })

  // ── 1) 内核自身发布为服务 + 存储端口 ───────────────────────────────────
  const storageHost = createStorageHost({
    ...(config.dshHome === undefined ? {} : { configuredDshHome: config.dshHome }),
    logger,
  })
  handle.kernel.provide(SERVICES.kernel, handle.kernel)
  try {
    handle.kernel.provide(STORAGE_HOST_SERVICE, storageHost.port)
  } catch (error) {
    // 服务表不再对重名抛错，但保留守卫以免未来语义变化
    logger.warn(`OMB：存储端口注册失败——${String(error)}（记忆库将降级）`)
  }
  // 内核已可解析——放行（必须在任何 await 之前，否则模块行会等到超时）
  markReady()

  // ── 1b) 工具桥（必须先于任何工具注册建立）──────────────────────────────
  //
  // **不要一次性收集工具**：内核 `apply` 是同步的，而模块行由宿主异步挂载
  // （Cordis 先等 `inject: ['omb:kernel']` 就绪，再在微任务里挂载）。一次性收集的
  // 结果是只有内核自带的 `omb_status` 进了工具面，其余 7 个工具**全部消失**，
  // 而健康面一切正常——"看起来全对、功能却不在"。
  // 桥的 `sync()` 幂等；每个模块挂载完成后由 `kernel/hostEntry.ts` 重放一次。
  const toolBridge = createToolBridge()
  const toolSource = {
    services: () => handle.kernel.services(),
    service: <T,>(name: string) => handle.kernel.service<T>(name),
    logger,
  }
  handle.kernel.provide(TOOL_BRIDGE_SERVICE, toolBridge)
  const hostTools = readService<{ register(definition: unknown): unknown }>(ctx, 'tools')
  toolBridge.attach(hostTools, toolSource)
  // 工具面为空的排查入口：`tools` 服务取不到时整条工具链静默失效，
  // 而健康面与纤维状态都是"正常"——必须留下可观测事实。
  heartbeat('tool-bridge', {
    hostToolsAvailable: hostTools !== undefined,
    registerIsFunction: typeof hostTools?.register === 'function',
  })

  // 内核自带的 `omb_status` 也走桥：这样"内核工具"与"模块工具"只有一条注册路径，
  // 不必维护两套（两套必然漂移）。`MODULE_CATALOG` 给 `omb-kernel` 声明了它，
  // 这里就是那个声明对应的实现。
  const statusSpec = buildStatusTool(handle, sessions)
  toolBridge.add([statusSpec], 'omb-kernel')

  // ── 2) 模块由**宿主 Cordis** 启动，内核不再自己启动 ──────────────────────
  //
  // 为什么必须这样（实测教训）：`cordis.patch.yml` 的每个模块行都会被宿主**独立加载**
  // 并调用其 `apply`。先前内核在 `handle.start()` 里又启动了一遍，于是**每个模块
  // 被启动两次**——表现为状态面出现两条 `omb-context` 段落、计数器各自独立、
  // 工具与事件订阅重复注册。
  //
  // 依赖顺序由行级 `inject: ['omb:kernel']` 保证：Cordis 会等内核把服务发布出来
  // 才激活模块行（心跳日志已证实：模块行的 `ready:true, kernelFound:true`）。
  //
  // 内核因此**不做模块生命周期管理**——这正是"微内核零业务逻辑"应有的样子：
  // 它只提供服务总线、事件总线、预算、健康面；谁被加载由宿主决定。
  //
  // 仅做**清单核对**：静态清单与 YAML 必须一一对应（契约测试也钉住了这一点）。
  const loaded = loadModulesSync(MODULE_ENTRIES)
  for (const failure of loaded.failures) {
    logger.warn(`OMB：模块入口 ${failure.path} 未装配——${failure.reason}`)
  }
  // 微内核自身在健康面留一行，让"内核有没有起来"与模块一样可见
  handle.kernel.report({ state: 'ok', detail: `微内核已就绪（产物代数 ${generationFromUrl(import.meta.url) ?? '未知'}）` })

  // ── 3) 提示注入（同步注册）────────────────────────────────────────────
  const disposePrompt = wirePromptInjection({
    kernel: handle.kernel,
    contributions: collectPromptContributions(handle.kernel),
    systemPrompt: readSystemPrompt(ctx),
    clock,
  })

  // 回合边界再重放一次工具注册。
  //
  // **为什么**：模块行由宿主异步挂载，而 agent 的工具表在会话/回合建立时确定。
  // 只在内核 `apply` 那一刻注册，工具可能赶不上 agent 的工具表——表现为
  // "插件页全部 active、`omb_status` 里一切正常，但工具面里一个 OMB 工具都没有"。
  // `sync()` 幂等，重放没有副作用；换成新会话时工具表重建，这次重放就补上了。
  const disposeToolResync = handle.kernel.on('turn/start', () => {
    toolBridge.sync()
  })

  // ── 5) 会话事件（只观察，不接管 Loop）─────────────────────────────────
  const disposeEvents = wireSessionEvents({ ctx, kernel: handle.kernel, sessions })
  /**
   * 制品索引的**生产者**。
   *
   * 这条接线曾经不存在（`dsh/hooks.ts` 只是个被注释提及的文件名）：
   * 于是 `omb_files` 索引恒为 0、健康面全绿、工具可调用——
   * 每一层单独看都对，只是中间少了一根线。自检报告正确地把它标为
   * "无法区分『没观察过』与『没在工作』"，实测答案是后者。
   */
  const disposeArtifactIndex = wireArtifactIndex({ ctx, kernel: handle.kernel })

  // ── 6) 异步阶段：只填内部状态，不再注册任何东西（H-2）─────────────────
  void storageHost
    .ensureSqlite()
    .then(failure => {
      if (failure !== null) logger.warn(`OMB：存储降级——${failure}`)
    })
    .catch((error: unknown) => {
      logger.warn(`OMB：异步初始化异常（已隔离）——${String(error)}`)
    })

  if (config.debug === true) {
    logger.info(
      `OMB：已装配 ${loaded.modules.length} 个模块、已注册工具 ${toolBridge.registered().length} 个、`
      + `${collectPromptContributions(handle.kernel).length} 个提示贡献`,
    )
  }

  // ── 7) 单一 disposer：顺序与注册相反，每步都不抛（H-1）────────────────
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const steps: readonly (() => void)[] = [
      disposeEvents,
      disposeArtifactIndex,
      disposeToolResync,
      disposePrompt,
      () => toolBridge.dispose(),
      () => handle.dispose(),
    ]
    for (const step of steps) {
      try {
        step()
      } catch (error) {
        logger.warn(`OMB：卸载步骤抛异常（已隔离）——${String(error)}`)
      }
    }
  }
}

/**
 * 供测试与诊断：把内核包成一个"宿主 ctx 形状"的对象。
 *
 * 测试要复现**真实路径**（宿主 ctx → `ctx.get('omb:kernel')` → 模块 apply），
 * 而不是让内核自己启动模块——后者与宿主启动会**重复启动**（实测症状：
 * 状态面出现两条 `omb-context` 段落、计数器各自独立）。
 */
export function testHostContext(handle: KernelHandle): { get(name: string): unknown } {
  return {
    get: (name: string) => (name === SERVICES.kernel ? handle.kernel : handle.kernel.service(name)),
  }
}

/**
 * 汇总所有模块声明的工具。
 *
 * 交付约定**只有一条**（`kernel/abi/catalog.ts` 的 `SERVICES.toolsPrefix`）：
 * `tools:<模块 id>` → `readonly ToolDefinition[]`。用统一前缀使 `dsh/` 只需一段遍历，
 * 且新增模块不必改本文件。
 */
export function collectToolSpecs(handle: KernelHandle, sessions: SessionTable): readonly ToolSpec[] {
  const kernel = handle.kernel
  const specs: ToolSpec[] = [buildStatusTool(handle, sessions)]
  const seen = new Set<string>(specs.map(s => s.name))

  for (const serviceName of kernel.services()) {
    if (!serviceName.startsWith(SERVICES.toolsPrefix)) continue
    const declared = kernel.service<readonly ToolDefinition[]>(serviceName)
    if (!Array.isArray(declared)) continue
    for (const definition of declared) {
      if (!isToolDefinition(definition)) continue
      if (seen.has(definition.name)) {
        // 同名工具只注册第一个：宿主 tools.register 对重名会抛，而抛会让整批失败
        kernel.logger.warn(`OMB：工具名重复 ${definition.name}（来自 ${serviceName}），已跳过`)
        continue
      }
      seen.add(definition.name)
      specs.push(toSpec(definition))
    }
  }
  return specs
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (typeof value !== 'object' || value === null) return false
  const d = value as { name?: unknown; description?: unknown; execute?: unknown }
  return typeof d.name === 'string' && typeof d.description === 'string' && typeof d.execute === 'function'
}

/** 把模块声明的 `ToolDefinition` 适配成注册用的 `ToolSpec`。 */
function toSpec(definition: ToolDefinition): ToolSpec {
  const parameters = (definition.parameters as unknown as { jsonSchema?: Record<string, unknown> }).jsonSchema
  return {
    name: definition.name,
    description: definition.description,
    parameters: parameters ?? { type: 'object', properties: {} },
    run: (args: unknown) => definition.execute(args),
  }
}

/** 供诊断：当前模块的工具服务名。 */
export function toolServiceNames(kernel: Kernel): readonly string[] {
  return kernel.services().filter(n => n.startsWith(SERVICES.toolsPrefix))
}

/** 便利：某模块的工具服务名。 */
export { toolsServiceFor }
