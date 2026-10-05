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
 * 本文件**不 import 任何 `@deepseek-ai/*`**，全部经结构化接口访问宿主。
 *
 * 这句话曾经的理由是"本仓库解析不到它们"——**那个理由已经不成立**：pnpm 的
 * `auto-install-peers` 默认会把整套宿主依赖树装进 `node_modules`（实测两代并存）。
 * 现在的理由是**纪律 + 护栏**：`.npmrc` 关掉了自动装 peer，让"解析不到"重新物理成立；
 * `tests/dsh/no-host-imports.test.ts` 把这条纪律变成会失败的断言——
 * 否则它只是注释里的一句愿望。
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
  collectPromptContributions,
  readSystemPrompt,
  wirePromptInjection,
  wireSessionEvents,
} from './session.js'
import type { SessionWiringOptions } from './session.js'
import { STORAGE_HOST_SERVICE, createStorageHost } from './stores.js'
import { createPressureBridge } from './pressure.js'
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
    version: '3.4.0',
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
  // ── 0) 上下文压力度量桥（**必须先于 createKernel**：measure 是构造期选项）──
  //
  // 缺了它，`kernel.pressure()` 恒为 `UNKNOWN_PRESSURE`，`band` 永远是 relaxed，
  // 于是"紧张就少说"一次都不会触发，而所有健康面都是绿的。详见 `dsh/pressure.ts`。
  const pressure = createPressureBridge({ ctx })
  const handle = createKernel({ logger, clock, measure: pressure.measure })

  // 把"内核就绪"发布到宿主 ctx：模块行由宿主独立加载，需要经宿主 ctx 取内核。
  //
  // **这一步已在真实宿主上验证成功**（`docs/v3-ten-item-plan.md` §六 记的是 g61 那轮
  // 逐项实测：8 个模块装载、工具面与提示注入都在位）。取不到内核时模块行会走空转兜底
  // （如实不提供能力、不抛）——那是**设计好的降级路径**，不是"尚未接上"的中间态。
  //
  // 注：旧注释在这里指向 `docs/host-wiring-handoff.md`，那个文件**从未存在**
  // （悬空引用）。要查这条线的证据请看上面那节实测记录。
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
  // 压力读数的"为什么"也进服务表：`omb_status` 有两条构造路径，服务表是它们
  // 唯一能共用同一份答案的地方（见 `SERVICES.pressureReading` 的注释）。
  try {
    handle.kernel.provide(SERVICES.pressureReading, {
      reason: pressure.reason,
      stats: pressure.stats,
    })
  } catch (error) {
    logger.warn(`OMB：压力读数说明注册失败——${String(error)}（状态面将只说"未测量"，不说是哪种）`)
  }
  try {
    handle.kernel.provide(STORAGE_HOST_SERVICE, storageHost.port)
  } catch (error) {
    // 服务表不再对重名抛错，但保留守卫以免未来语义变化
    logger.warn(`OMB：存储端口注册失败——${String(error)}（记忆库将降级）`)
  }

  /**
   * **把宿主的可选服务接进内核服务表，用惰性值保证每次重新解析。**
   *
   * ## 这条线曾经是断的（实测：通知一条都发不出去）
   *
   * `modules/notify` 的 `resolve` 只问内核服务表（`kernel.service('desktopNotify')`），
   * 而 `dsh/` **从来没有把宿主服务放进那张表**——grep 全仓库，发布点零处。
   * 于是 `resolve()` 永远返回 `undefined`，通知全部静默，状态面还报"未安装"。
   *
   * ## 佐证：`dsh-path-guard` 的做法是对的
   *
   * 它的 `src/notify.js` 用 `ctx.get('desktopNotify')` 直接取**宿主**服务，
   * 每次事件重新解析，并且**确实能投递**。而 `dsh-desktop-notify` 的实现是
   * `ctx.provide('desktopNotify', …)`（`lib/index.js:445`）——服务在**宿主**容器里。
   *
   * ## 为什么每次读都重新问宿主，而不是取一次存下来
   *
   * 装配顺序不保证：`dsh-desktop-notify` 可能比 OMB 晚加载，也可能中途被开关。
   * 每次读都重新问，于是"后装上也能用""卸下立刻失效"都免费成立——
   * 这正是 path-guard 注释里那条 *"enabling the plugin mid-session starts
   * working immediately"* 的同一个机制。
   *
   * 读 `ctx.get` 必须包 try/catch：宿主 ctx 受 Cordis Guard 管，
   * 未 `inject` 的名字会抛（本文件上方有同样的告诫）。
   */
  try {
    const services = handle.kernel.services()
    const table = typeof services === 'object' && services !== null
      ? (services as { provide?(name: string, value: unknown): unknown })
      : undefined
    if (typeof table?.provide === 'function') {
      const hostOf = (): Record<string, unknown> | undefined => {
        try {
          const found = typeof ctx.get === 'function' ? ctx.get('desktopNotify') : undefined
          return typeof found === 'object' && found !== null ? (found as Record<string, unknown>) : undefined
        } catch {
          // Guard 拒绝（该行没 inject 这个服务）→ 不可用，不是错误
          return undefined
        }
      }
      /**
       * **包一层，不能直接返回方法引用**：宿主的方法依赖 `this` 指向它自己，
       * 把 `host.push` 摘出来单独调用会因 `this` 丢失而抛
       * `TypeError: Illegal invocation`。这里以宿主对象为 `this` 调用。
       */
      const forward = (name: 'push' | 'pushAlways') => (payload: unknown): unknown => {
        const host = hostOf()
        const method = host?.[name]
        if (typeof method !== 'function') return false
        return (method as (this: unknown, p: unknown) => unknown).call(host, payload)
      }
      /**
       * 兜底对象**必须把 2.0.0 的三件也带上**（`notify` / `apiVersion` / `capabilities`）。
       *
       * 生产路径上 `kernel.service('desktopNotify')` 是 **`readHost` 优先**（`kernel/adopt.ts`：
       * `readHost(name) ?? core.services.get(name)`），所以拿到的通常是宿主原对象、什么都有；
       * 但**兜底表只在 readHost 取不到时才被读到**——那时若只有 `push`/`pushAlways`，
       * 消费方（`modules/notify`）会据此把宿主判成"旧版本或非官方实现"，
       * **一次取不到就变成一句对宿主的错判**。
       *
       * 所以：能转发的一律转发；`notify` 用 getter（宿主没有这个能力时属性为 `undefined`，
       * 让消费方**看得出缺失**，而不是拿到一个永远返回 undefined 的函数）；版本与能力同理——
       * 与"每次重新问宿主"同一口径，不缓存也不能缓存。
       */
      table.provide('desktopNotify', {
        push: forward('push'),
        pushAlways: forward('pushAlways'),
        get notify() {
          const host = hostOf()
          const method = host?.['notify']
          if (typeof method !== 'function') return undefined
          return (payload: unknown): unknown =>
            (method as (this: unknown, p: unknown) => unknown).call(host, payload)
        },
        get apiVersion() {
          return hostOf()?.['apiVersion']
        },
        get capabilities() {
          return hostOf()?.['capabilities']
        },
      })
    }
  } catch (error) {
    logger.warn(`OMB：通知服务接线失败（桌面通知将不可用）——${String(error)}`)
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
  //
  // **不再往里传会话表**：会话事实的唯一来源是内核自己的 `ActiveSessionTable`
  // （`SERVICES.activeSession`），`omb_status` 直接读它。传一张外部表进来就等于
  // 允许"状态面读的表"与"模块读的表"不是同一张——那正是先前稳定矛盾的成因。
  const statusSpec = buildStatusTool(handle)
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
  const disposePrompt = wirePromptInjection(promptWiringOptions({ handle, ctx, clock }))

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
  //    会话 → cwd 由这里写进内核登记处（唯一存放处）；不再另存一份。
  const disposeEvents = wireSessionEvents({ ctx, kernel: handle.kernel, onHostSession: pressure.remember })
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
    // 这三个数字都是**装配这一刻**的快照：模块行由宿主异步挂载，内核 apply 里看不到它们。
    // 所以"此刻可见的提示贡献 0 个"在正常启动里是预期值，不是缺陷——
    // 实时账目看状态面（`RESIDENT_BUDGET_STATUS_NAME` 段落）。
    logger.info(
      `OMB：已装配 ${loaded.modules.length} 个模块、已注册工具 ${toolBridge.registered().length} 个、`
      + `此刻可见的提示贡献 ${collectPromptContributions(handle.kernel).length} 个（模块行尚未挂载，实时账目见状态面）`,
    )
  }

  // ── 7) 单一 disposer：顺序与注册相反，每步都不抛（H-1）────────────────
  let disposed = false
  /**
   * 卸载主体。**同步**跑完所有步骤（H-1：任何一步抛都被隔离）。
   *
   * 最后一步是内核的**同步** `dispose()`——它逐个调用模块 disposer 但不等待
   * 返回 Promise 的那些（模块关库、flush 都是异步的）。
   */
  const disposeSync = (): void => {
    if (disposed) return
    disposed = true
    const steps: readonly (() => void)[] = [
      disposeEvents,
      disposeArtifactIndex,
      disposeToolResync,
      disposePrompt,
      () => toolBridge.dispose(),
      () => pressure.dispose(),
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

  /**
   * 交给宿主的 disposer。
   *
   * ## 为什么不是 `async () => { … }`
   *
   * 宿主（Cordis）可能**同步调用** disposer 并丢掉返回值；若改成 `async` 函数，
   * 同步调用仍然会执行函数体——但**返回值变成 Promise 后就没有地方 await 它**，
   * "卸载完成"依然不成立。所以这里保留**同步**签名，把异步收尾作为**函数属性**
   * 挂上去，宿主愿意等就等，不等也不影响同步部分。
   *
   * ## 为什么必须补一个异步收尾
   *
   * 内核的 `dispose()` 是同步的：它逐个调用模块 disposer，但**不等待**返回 Promise
   * 的那些。而模块的收尾几乎都是异步的（关 SQLite 句柄、flush 向量队列）。
   * 所以同步 `dispose()` 返回时，"卸载完成"这句话并不成立——
   * **内核行是唯一知道全部模块收尾何时结束的地方**，它有责任把这个事实交出去。
   *
   * `disposeAsync()` 明确定义为可在 `dispose()` 之后调用（补等尚未完成的那些），
   * 两条路径共用同一份幂等包装，所以这里补等不会重复释放。
   */
  const dispose = (): void => {
    disposeSync()
  }
  dispose.async = async (): Promise<void> => {
    disposeSync()
    try {
      await handle.disposeAsync()
    } catch (error) {
      // H-1：异步收尾失败也不向宿主传播，但必须留声
      logger.warn(`OMB：内核异步收尾失败（部分模块可能未完成清理）——${String(error)}`)
    }
  }
  return dispose
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
 * 提示注入的接线选项。
 *
 * ## 为什么单独成函数
 *
 * 为了让"**必须传提供者**"这条纪律有一个会失败的断言。
 *
 * `contributions` 一旦写成 `collectPromptContributions(handle.kernel)`（一次性收集的数组），
 * 整条提示链路就**从未生效**：内核 `apply` 是同步的，而模块行由宿主异步挂载
 * （Cordis 先等 `inject: ['omb:kernel']` 就绪，再在微任务里挂载），
 * 那一刻服务表里一个 `prompt:*` 都没有——推理模块的 R1 常驻提示、用户画像的 R8
 * 冲突摘要、任何模块的 `context()` 易变段全部到不了模型。
 *
 * 代价不止"少了几句话"：状态面因此长期显示「常驻提示 0/120 字符（无贡献者）」，
 * 而 `omb-reasoning` 同时显示「104/120」且「上次注入：尚无」——两个面互相矛盾，
 * `omb_status` 作为唯一的模型可见诊断入口会跟着一起失去可信度；
 * 所有健康面都是绿的、能力也都注册了，**只是从未生效**，
 * 排查时没有任何一条线索指向这里。
 *
 * 这个根因在工具面上先踩过一次（7 个工具全部消失、只有内核自带的 `omb_status` 在），
 * 提示面上又踩了第二次——所以它不能再只靠注释里的告诫。
 */
export function promptWiringOptions(input: {
  readonly handle: KernelHandle
  readonly ctx: HostContextLike
  readonly clock: { now(): number }
}): SessionWiringOptions {
  const { handle, ctx, clock } = input
  return {
    kernel: handle.kernel,
    // **提供者，不是一次性收集的数组**：每次要文本时重新扫服务表，
    // 于是"接线之后才挂上的模块"照样进得了注入（与 `disposeToolResync` 在
    // `turn/start` 上重放工具注册是同一个修法、同一个根因）。
    contributions: () => collectPromptContributions(handle.kernel),
    systemPrompt: readSystemPrompt(ctx),
    clock,
  }
}

/**
 * 汇总所有模块声明的工具。
 *
 * 交付约定**只有一条**（`kernel/abi/catalog.ts` 的 `SERVICES.toolsPrefix`）：
 * `tools:<模块 id>` → `readonly ToolDefinition[]`。用统一前缀使 `dsh/` 只需一段遍历，
 * 且新增模块不必改本文件。
 */
export function collectToolSpecs(handle: KernelHandle): readonly ToolSpec[] {
  const kernel = handle.kernel
  const specs: ToolSpec[] = [buildStatusTool(handle)]
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
