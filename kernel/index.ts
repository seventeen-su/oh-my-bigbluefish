/**
 * 微内核装配。职责穷举，不得扩张：
 * 服务注册 · 事件总线 · 模块生命周期 · 配置校验 · 资源槽 · 健康面 · 度量桥 · 日志时钟。
 *
 * **内核不做任何业务逻辑。** 它不知道什么是记忆、什么是推理。
 * 业务全在 `modules/`，宿主接触全在 `dsh/`。
 */
import { EventBus, ServiceTable } from './services.js'
import { BudgetTable } from './budget.js'
import { HealthTable } from './health.js'
import { FocusTable, planModules } from './registry.js'
import { StatusTable } from './status.js'
import { adoptContext, type ForeignContextLike } from './adopt.js'
import { markKernel, markKernelHandle } from './hostEntry.js'
import { ActiveSessionTable } from './activeSession.js'
import { SessionRuntimeTable } from './sessionRuntime.js'
import { ChannelTable } from './channels.js'
import { SERVICES } from './abi/index.js'
import type {
  BudgetGrant,
  BudgetKind,
  Clock,
  ContextPressure,
  FocusDepth,
  Kernel,
  Logger,
  ModuleEventName,
  ModuleEvents,
  ModuleHealth,
  ModuleRegistration,
  SessionRef,
} from './abi/index.js'
import { FOCUS_DEPTHS } from './abi/index.js'

/** 压力档位的默认阈值（软档位，不是硬上限）。 */
export interface PressureBands {
  readonly moderate: number
  readonly tight: number
}

export const DEFAULT_PRESSURE_BANDS: PressureBands = { moderate: 0.3, tight: 0.6 }

export interface KernelOptions {
  readonly logger?: Logger
  readonly clock?: Clock
  readonly bands?: PressureBands
  /** 宿主度量桥。缺省时压力恒为 relaxed 且在 detail 中说明原因。 */
  readonly measure?: (session: SessionRef) => ContextPressure | undefined
}

export interface KernelHandle {
  readonly kernel: Kernel
  /**
   * 启动全部模块；返回被阻断的模块（缺失依赖/成环）。
   * @param modules 模块注册集合。
   * @param configs 每个模块 id 对应的配置（来自 `cordis.patch.yml` 的 `config`）。
   *   缺失时传 undefined，由模块自己的 schema 缺省值补齐。
   */
  start(
    modules: readonly ModuleRegistration<unknown>[],
    configs?: ReadonlyMap<string, unknown>,
    hostCtx?: unknown,
  ): readonly {
    readonly id: string
    readonly reason: string
  }[]
  /**
   * 挂载**单个**模块，返回其 disposer。
   *
   * 与 `start()` 的分工：`start()` 是"内核按依赖顺序启动一批模块"（离线/测试用）；
   * `mount()` 是"宿主把一个模块交给我挂载"——**真实宿主路径用这个**
   * （`cordis.patch.yml` 的每行由宿主独立加载，依赖顺序由行级 `inject` 保证）。
   *
   * `hostCtx` 传宿主 ctx：模块读宿主服务（`tools` 等）时经它，其余能力落回内核。
   */
  mount(registration: ModuleRegistration<unknown>, hostCtx?: unknown): () => void
  /**
   * 造一个把健康上报绑定到指定模块 id 的内核视图（诊断与测试用）。
   */
  scopedKernel(id: string, hostCtx?: unknown): Kernel
  /** 健康面快照，供 `omb_status` 使用。 */
  health(): Readonly<Record<string, ModuleHealth>>
  /** 状态面贡献汇总（已按 name 排序渲染）。单个贡献者失败被隔离成一行错误。 */
  status(): readonly string[]
  /** 已登记的状态面贡献者名（诊断用）。 */
  statusNames(): readonly string[]
  /** 预算面快照。 */
  budgets(): Readonly<Record<string, { used: number; limit: number }>>
  /** 事件总线订阅者数——热插拔验收用（卸载后应为 0）。 */
  listenerCount(): number
  /**
   * **模块依赖图自检**：真实挂载顺序 vs 每个模块自己声明的 `requires`。
   *
   * 为什么需要它（这是唯一诚实且不碰 H-2 的强制方式）：行与行之间只有
   * `inject: ['omb:kernel']` 一道门，**没有顺序保证**；一旦有人把
   * `cordis.patch.yml` 的行序改错（例如把 `omb-memory-vector` 挪到 `omb-memory` 前），
   * 依赖方会先加载、拿不到服务而静默降级。这里把"顺序被改错"从静默变成**可读事实**。
   *
   * 语义：
   * - `orderViolations`：依赖**挂载得比依赖方晚**（真·顺序违规）
   * - `missingDependencies`：依赖**从未挂载**（前置条件未满足；依赖方应已自行降级并写明原因）
   *
   * 按需计算（`omb_status` 渲染时），因此读到的是**当前**事实而不是启动瞬间的快照。
   */
  moduleGraph(): ModuleGraphReport
  /**
   * 注销全部服务与事件订阅。**绝不抛异常**（热插拔 H-1）。
   *
   * ⚠️ **同步路径不保证异步 disposer 已完成**：它逐个调用 disposer 但不等 Promise，
   * 返回时可能有模块仍在异步收尾（例如关闭数据库、等 flush）。
   * 需要"卸载确实完成"的调用方请用 `disposeAsync()`。
   * 两条路径共用同一份 disposer 集合与同一个幂等包装，重复调用不会重复释放。
   */
  dispose(): void
  /**
   * 注销并**等待全部 disposer 完成**（含返回 Promise 的）。
   *
   * 语义：`Promise.allSettled` —— 单个 disposer 抛错/reject 只记日志，不阻止其余，
   * 也不让本方法 reject（H-1）。可在 `dispose()` 之后调用：此时它补等尚未完成的那些。
   */
  disposeAsync(): Promise<void>
}

/** 模块依赖图自检报告（见 `KernelHandle.moduleGraph`）。 */
export interface ModuleGraphReport {
  /** 实际挂载顺序（id，按挂载先后）。 */
  readonly mounted: readonly string[]
  /** 依赖挂载得比依赖方晚：`依赖方 ← 依赖`。 */
  readonly orderViolations: readonly string[]
  /** 依赖从未挂载：`依赖方 ← 依赖`（前置条件未满足，不是顺序问题）。 */
  readonly missingDependencies: readonly string[]
}

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {} }
const SYSTEM_CLOCK: Clock = { now: () => Date.now() }

function bandOf(fillRatio: number | null, bands: PressureBands): ContextPressure['band'] {
  if (fillRatio === null) return 'relaxed' // 宿主未声明窗口 → 不施压（不臆断）
  if (fillRatio >= bands.tight) return 'tight'
  if (fillRatio >= bands.moderate) return 'moderate'
  return 'relaxed'
}

const UNKNOWN_PRESSURE: ContextPressure = {
  totalTokens: 0,
  fillRatio: null,
  band: 'relaxed',
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  nodes: [],
}

/**
 * 建立内核。
 *
 * 模块启动失败的处理：记入健康面并让**其余模块继续**——
 * 单个模块坏掉不得连坐（这是微内核相对分层内核的核心收益）。
 */
export function createKernel(options: KernelOptions = {}): KernelHandle {
  const logger = options.logger ?? NOOP_LOGGER
  const clock = options.clock ?? SYSTEM_CLOCK
  const bands = options.bands ?? DEFAULT_PRESSURE_BANDS

  const services = new ServiceTable()
  const bus = new EventBus()
  const budgetTable = new BudgetTable()
  const healthTable = new HealthTable()
  const focusTable = new FocusTable()
  const statusTable = new StatusTable()
  const channelTable = new ChannelTable<{ readonly name: string }>()
  const activeSessions = new ActiveSessionTable()
  /**
   * 会话运行态容器（`kernel/sessionRuntime.ts`）。
   *
   * **由内核 provide，模块只复用**：这张表一旦有多份，"同一个会话的隐私/推理/记忆状态"
   * 就会被拆到不同的表里——那正是 `lastActiveSession` 那类缺陷（每个模块各记一份
   * "当前会话"）的翻版。消费方（如 `omb-privacy` 的隐私槽）先问服务、拿不到才自建兜底。
   */
  const sessionRuntime = new SessionRuntimeTable(clock)

  // 四个登记处都由内核自己 provide：
  // ① 状态面：单值服务表装不下 N 个贡献者（见 abi/catalog.ts 的说明）
  // ② 第二通道：**依赖方向要求"推"而不是"拉"**——`omb-memory-vector` 的 requires
  //    包含 `omb-memory`，所以只能由向量模块把自己的通道注册进来，记忆模块读登记处。
  // ③ 活跃会话：模块经收养视图订阅事件时订到的是**宿主**事件面，收不到内核对
  //    `turn/start` 的广播（见 kernel/activeSession.ts）。会话这个全局事实必须由
  //    内核持有，模块按需读取，不能依赖"模块能不能收到某条事件"。
  // ④ 会话运行态：按会话键控的容器必须**只有一份**（见上面 sessionRuntime 的说明）。
  services.provide(SERVICES.statusContributor, statusTable)
  services.provide(SERVICES.channelRegistry, channelTable)
  services.provide(SERVICES.activeSession, activeSessions)
  services.provide(SERVICES.sessionRuntime, sessionRuntime)

  // 内核自己的状态面段落：**模块依赖图自检**。
  // 行序是模块间依赖的唯一保证（行与行之间只有 `inject: ['omb:kernel']` 门），
  // 所以"行序被改错"必须能从状态面读出来，而不是靠人盯 cordis.patch.yml。
  statusTable.register({
    name: '模块依赖图',
    render: () => renderModuleGraph(moduleGraphReport()),
    metrics: () => {
      const report = moduleGraphReport()
      return {
        mounted: report.mounted.length,
        orderViolations: report.orderViolations.length,
        missingDependencies: report.missingDependencies.length,
      }
    },
  })

  let disposed = false
  /**
   * **唯一的 disposer owner 集合**：`start()` 与 `mount()` 登记的都进这里。
   *
   * 为什么必须统一：`mount()` 是真实宿主路径，它过去把 disposer 直接交给宿主、
   * 内核自己不留——宿主一旦漏调（或只调了内核的 `dispose`），模块就永远不卸载。
   * 现在宿主仍拿得到返回值，但内核**自己也持有同一份**，两边共用幂等包装。
   */
  const owners: (() => void | Promise<void>)[] = []
  /**
   * **实际挂载账本**：`{ id, requires }`，按挂载先后。用于依赖图自检
   * （`moduleGraph()`）——它是"宿主到底按什么顺序把模块装上来的"这一事实的唯一记录。
   *
   * ⚠️ **内核行自己必须先入账**（见下面的 `recordMount(KERNEL_MANIFEST_ID, [])`）。
   *
   * 内核行（`dsh/plugin.ts` 的 `KERNEL_SELF`）的 `apply` 是**空操作**——内核在
   * `createKernel()` 里就建好了，行只是把"内核已就绪"发布到宿主 ctx，**从不经过
   * `mount()`**。于是账本里没有 `omb-kernel`，而其余 8 个模块的 `requires` 都含它，
   * 依赖图自检就会报 8 条假的"依赖未挂载"。
   *
   * 这不是理论风险：真实宿主实测到的输出是
   * `依赖未挂载 6 处：omb-privacy ← omb-kernel、omb-memory ← omb-kernel …`，
   * 而同一次状态面里 8 个模块全部 `正常`、0 失败——**内核显然在**。
   *
   * 教训与「制品索引空转」那次同源：**自检若把"我没记录到的"当成"不存在"，
   * 它就会稳定地产出假告警**，而假告警会让人开始无视真告警。
   */
  const mountLedger: { readonly id: string; readonly requires: readonly string[] }[] = []
  /**
   * 同步 `dispose()` 已触发、但尚未被 await 的 promise。
   * `dispose()` 返回后它们仍在跑；`disposeAsync()` 会把这些补等掉。
   */
  const settling: Promise<void>[] = []

  function warnIsolated(what: string, error: unknown): void {
    logger.warn(`内核：${what}（已隔离）——${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * 内核行自己先入账——它是模块图里的一个节点，只是**不经过 `mount()`**
   * （`apply` 是空操作，见 `mountLedger` 上方的说明）。
   *
   * 记在账本**最前面**：内核是其余所有模块的依赖，它必须最早"就位"，
   * 否则后面每个模块都会判成"依赖挂载得更晚"→ 变成顺序违规（另一种假告警）。
   */
  const KERNEL_ROW_ID = 'omb-kernel'
  mountLedger.push({ id: KERNEL_ROW_ID, requires: [] })

  /**
   * 登记一个 disposer，返回**给宿主的幂等包装**（`() => void`）。
   *
   * 幂等是硬要求：宿主可能自己调一次 mount 的返回值，内核 dispose 时再调一次；
   * 两次都执行会让"关闭数据库"这类收尾跑两遍（第二次通常抛错或损坏状态）。
   *
   * 内部登记的是 `owned` 本身（可能返回 Promise）：它的 promise 一产生就挂上
   * `.catch` 记日志，因此即使调用方不 await 也不会出现 unhandled rejection。
   */
  function registerOwner(disposer: () => void | Promise<void>): () => void {
    let called = false
    let result: void | Promise<void>
    const owned = (): void | Promise<void> => {
      if (called) return result
      called = true
      try {
        result = disposer()
      } catch (error) {
        warnIsolated('disposer 同步抛异常', error)
        return
      }
      if (result instanceof Promise) {
        result.catch((error: unknown) => { warnIsolated('disposer 异步失败', error) })
      }
      return result
    }
    owners.push(owned)
    return () => { void owned() }
  }

  /**
   * 取出全部 disposer（清空集合）并按注册逆序调用，收集返回的 promise。
   * 任何一个抛错/reject 都被隔离并记日志——**绝不向上传播**（H-1）。
   */
  function drainOwners(): Promise<void>[] {
    const pending: Promise<void>[] = []
    for (const owner of owners.splice(0, owners.length).reverse()) {
      try {
        const result = owner()
        if (result instanceof Promise) {
          pending.push(result.then(() => undefined, (error: unknown) => { warnIsolated('disposer 异步失败', error) }))
        }
      } catch (error) {
        warnIsolated('disposer 同步抛异常', error)
      }
    }
    return pending
  }

  /**
   * 记一笔挂载，并**当场**检出"依赖来得太晚"。
   *
   * 挂载 `id` 时，若账本里已有模块声明依赖它，那些依赖方就是在依赖之前启动的
   * （它们启动时拿不到服务，会降级或空转）——这是**启动瞬间就能发现**的顺序违规。
   */
  function recordMount(id: string, requires: readonly string[]): void {
    const late: string[] = []
    for (const entry of mountLedger) {
      if (entry.requires.includes(id)) late.push(entry.id)
    }
    mountLedger.push({ id, requires: [...requires] })
    if (late.length === 0) return
    logger.warn(
      `内核：⚠ 模块挂载顺序违反依赖图——${late.join('、')} 依赖 ${id}，但 ${id} 挂载得更晚；`
      + '请检查 cordis.patch.yml 的行序（依赖行必须在依赖方之前）',
    )
  }

  /**
   * 依赖图自检（按需计算，读到的是**当前**事实）。
   *
   * 两类结论分开报，因为修法不同：
   * - 顺序违规 → 改 `cordis.patch.yml` 的行序；
   * - 依赖未挂载 → 前置条件未满足（那一行被禁用），依赖方应已自行降级并写明原因。
   */
  function moduleGraphReport(): ModuleGraphReport {
    const positions = new Map<string, number>()
    mountLedger.forEach((entry, index) => positions.set(entry.id, index))
    const orderViolations: string[] = []
    const missingDependencies: string[] = []
    for (const entry of mountLedger) {
      const self = positions.get(entry.id) ?? 0
      for (const dep of entry.requires) {
        const at = positions.get(dep)
        if (at === undefined) missingDependencies.push(`${entry.id} ← ${dep}`)
        else if (at > self) orderViolations.push(`${entry.id} ← ${dep}`)
      }
    }
    return { mounted: mountLedger.map(entry => entry.id), orderViolations, missingDependencies }
  }

  /** 状态面渲染：自检通过时一行话，出问题时逐条列出并给修法。 */
  function renderModuleGraph(report: ModuleGraphReport): string {
    const lines: string[] = []
    if (report.orderViolations.length === 0 && report.missingDependencies.length === 0) {
      return `已按依赖顺序挂载 ${report.mounted.length} 个模块；顺序自检通过（行序 = cordis.patch.yml）`
    }
    if (report.orderViolations.length > 0) {
      lines.push(`⚠ **顺序违规** ${report.orderViolations.length} 处（依赖挂载得比依赖方晚）：`)
      for (const violation of report.orderViolations) lines.push(`- ${violation}`)
      lines.push('  修法：调整 cordis.patch.yml 的行序，依赖行必须排在依赖方之前。')
    }
    if (report.missingDependencies.length > 0) {
      lines.push(`依赖未挂载 ${report.missingDependencies.length} 处（前置条件未满足，依赖方应已自行降级）：`)
      for (const missing of report.missingDependencies) lines.push(`- ${missing}`)
    }
    return lines.join('\n')
  }

  const kernel: Kernel = {
    provide: (name, service) => {
      if (disposed) throw new Error('内核已注销，不能再注册服务')
      const off = services.provide(name, service)
      return off
    },
    service: <T,>(name: string) => services.get<T>(name),
    services: () => services.names(),
    emit: <E extends ModuleEventName>(event: E, payload: ModuleEvents[E]) => {
      if (disposed) return
      bus.emit(event, payload)
    },
    on: (event, fn) => (disposed ? () => {} : bus.on(event, fn as (p: unknown) => void)),
    budget: (kind: BudgetKind, amount: number): BudgetGrant | undefined =>
      budgetTable.grant(kind, amount),
    // 兜底实现；start() 会为每个模块换成绑定了自己 id 的视图
    report: () => {},
    pressure: (session: SessionRef): ContextPressure => {
      const measured = options.measure?.(session)
      if (measured === undefined) return UNKNOWN_PRESSURE
      // 档位由内核统一判定，模块拿到的是一致的口径
      return { ...measured, band: bandOf(measured.fillRatio, bands) }
    },
    focus: (session: SessionRef): FocusDepth => {
      const entry = focusTable.get(session)
      const depth = entry?.depth
      return FOCUS_DEPTHS.includes(depth as FocusDepth) ? (depth as FocusDepth) : 'standard'
    },
    setFocus: (session: SessionRef, depth: FocusDepth, reason: string) => {
      focusTable.set(session, depth, reason, clock.now())
      bus.emit('focus/changed', { sessionId: session, depth, reason })
    },
    logger,
    clock,
  }

  // 建好就打标记：模块入口靠这个**自有标记**认出"这是内核而不是宿主 ctx"
  // （见 `hostEntry.ts`）。放在创建处而不是 `start()` 里——模块生命周期归宿主，
  // `start()` 可能根本不被调用，但"内核身份"必须从存在那刻起就成立。
  markKernel(kernel)

  // `report` 需要一个键：模块把自己的 id 放在 health 之外，
  // 因此这里用"最近一次上报的调用栈之外"的显式键不方便，改由 start 包装。
  // 见 start() 中注入的 per-module report。

  /**
   * 造一个把健康上报绑定到指定模块 id 的内核视图。
   *
   * **为什么需要它**：模块调用 `kernel.report(health)` 时不该自己带 id——多一个
   * 出错点，而且模块无法知道宿主怎么称呼它。视图把这层绑定做掉。
   */
  function scopedKernel(id: string, hostCtx?: unknown): Kernel {
    return adoptContext(
      (hostCtx ?? {}) as ForeignContextLike,
      {
        services: {
          get: <T,>(name: string) => services.get<T>(name),
          names: () => services.names(),
          provide: (name, value) => services.provide(name, value),
        },
        on: (event, fn) => bus.on(event, fn),
        emit: (event, payload) => {
          if (!disposed) bus.emit(event, payload)
        },
        budget: (kind, amount) => budgetTable.grant(kind, amount),
        pressure: session => kernel.pressure(session),
        focus: session => kernel.focus(session),
        setFocus: (session, depth, reason) => kernel.setFocus(session, depth, reason),
        logger,
        clock,
      },
      health => healthTable.report(id, health),
    )
  }

  const handle: KernelHandle = {
    kernel,
    /**
     * 挂载单个模块，并返回**绑定好健康上报与配置解析**的挂载函数。
     *
     * 与 `start()` 的区别：`start()` 是"内核按依赖顺序启动一批模块"（离线/测试用）；
     * `mount()` 是"宿主把一个模块交给我挂载"——**真实宿主路径用这个**
     * （`cordis.patch.yml` 的每行由宿主独立加载，依赖顺序由行级 `inject` 保证）。
     *
     * 两者都走同一份 `scopedKernel`，因此模块在两条路径下行为一致——
     * 这正是"同一份模块定义在哪都能成立"的落点。
     */
    mount(registration, hostCtx) {
      const id = registration.manifest.id
      const scoped = scopedKernel(id, hostCtx)
      let config: unknown
      try {
        // 配置解析失败与 apply 失败要分开报：两者修法完全不同
        config = registration.manifest.configSchema.parse(undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        healthTable.report(id, { state: 'failed', detail: `配置解析失败：${message}` })
        logger.warn(`内核：模块 ${id} 配置解析失败——${message}`)
        return () => {}
      }
      try {
        const result = registration.apply(scoped, config)
        // **未自报健康**是可疑信号：模块可能在 apply 里提前 return 了
        // （例如依赖的服务没拿到）。如实标成 degraded，不假装"启动成功"——
        // 否则状态面显示"已启动（未自报健康）"，把一次静默失效伪装成正常。
        if (!healthTable.has(id)) {
          const registered = services.names().filter(n => n.startsWith('tools:'))
          // 把"为什么提前返回"也记进日志：状态面只放一句可读原因，
          // 真正的排查需要知道模块看到了什么（它请求了哪个服务、有没有配置）。
          logger.warn(
            `内核：模块 ${id} 已挂载但未自报健康（未注册服务）；`
            + `宿主 ctx 提供的内核服务=${String(services.get(SERVICES.kernel) !== undefined)}`,
          )
          healthTable.report(id, {
            state: 'degraded',
            detail: `已挂载但未自报健康——通常表示 apply 提前返回（依赖的服务不可用）；`
              + `当前工具服务：${registered.length === 0 ? '无' : registered.join('、')}`,
          })
        }
        // 挂载成功（apply 返回了）→ 记进挂载账本：依赖图自检靠它
        recordMount(id, registration.manifest.requires)
        return typeof result === 'function' ? registerOwner(result) : () => {}
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        healthTable.report(id, { state: 'failed', detail: `挂载失败：${message}` })
        logger.warn(`内核：模块 ${id} 挂载失败——${message}`)
        return () => {}
      }
    },
    scopedKernel,
    start(modules, configs, hostCtx) {
      // 打标记：模块入口靠这个**自有标记**认出"这是内核而不是宿主 ctx"。
      // 不能用"读几个属性看看"来认——宿主 ctx 是 Proxy，Guard 对未 inject 的
      // 属性读写会抛，于是探测本身会变成失败原因（见 hostEntry.ts 的说明）。
      markKernel(kernel)
      const plan = planModules(modules)
      for (const blocked of plan.blocked) {
        healthTable.report(blocked.id, { state: 'failed', detail: blocked.reason })
        logger.warn(`内核：模块 ${blocked.id} 未启动——${blocked.reason}`)
      }
      for (const { id, registration } of plan.ordered) {
        // **关键**：`apply` 的第一参必须是我们的 `Kernel` 纯对象，而不是宿主 ctx。
        // 宿主 Cordis 会按它自己的契约传 ctx 代理，而 Guard 对未 `inject` 的属性
        // 读写直接抛（实测："cannot get property \"clock\" without inject" → 模块
        // 激活失败，而工具面/提示注入正常，表现为"插件半活"）。
        // 收养把宿主能力逐项取一次后落到纯对象上，且不展开代理（展开会实体化 getter
        // 从而绕过 Guard）。
        //
        // 与 `mount()` 共用同一份 `scopedKernel`：两条路径行为必须一致，
        // 否则"模块在测试里好好的、在宿主里空转"这类偏差会再次出现。
        const scoped = scopedKernel(id, hostCtx)
        try {
          const config = registration.manifest.configSchema.parse(configs?.get(id))
          const disposer = registration.apply(scoped, config)
          if (typeof disposer === 'function') registerOwner(disposer)
          recordMount(id, registration.manifest.requires)
          // **只在模块未自报时**补通用值：模块自报的降级原因优先级更高，
          // 否则"配置被收敛/服务注册失败"这类原因会在启动瞬间被覆盖
          // （与「无空降级」冲突）。
          if (!healthTable.has(id)) {
            healthTable.report(id, { state: 'ok', detail: `模块 ${id} 已启动（未自报健康）` })
          }
        } catch (error) {
          // 单模块失败不连坐：只记健康面，继续启动其余模块
          const message = error instanceof Error ? error.message : String(error)
          healthTable.report(id, { state: 'failed', detail: `启动失败：${message}` })
          logger.warn(`内核：模块 ${id} 启动失败——${message}`)
        }
      }
      return plan.blocked
    },
    health: () => healthTable.snapshot(),
    status: () => statusTable.render(),
    statusNames: () => statusTable.list().map(c => c.name),
    moduleGraph: () => moduleGraphReport(),
    budgets: () => budgetTable.snapshot(),
    listenerCount: () => bus.listenerCount(),
    dispose() {
      if (disposed) return
      disposed = true
      // 逐个注销（逆序）；抛错/reject 都被隔离并记日志——绝不向上传播（H-1）。
      // **不等待** Promise：需要"卸载确实完成"的调用方用 disposeAsync()。
      settling.push(...drainOwners())
      // 「会话 → cwd」是内核持有的**唯一**一份（`kernel/activeSession.ts`）：
      // 内核注销后旧会话在新一轮里不再可信，必须连它一起清——
      // 否则重挂后模块会按上一代的会话 cwd 去打开项目库（把记忆写到别人的项目里）。
      activeSessions.clear()
      // 按会话的运行态同理（`kernel/sessionRuntime.ts`）：不清就会让重挂后的模块
      // 读到上一代的槽（隐私模式、循环信号…），那是"状态记到别人的会话"的另一种形态。
      sessionRuntime.clear()
      healthTable.report('omb-kernel', {
        state: 'ok',
        detail: '内核已注销（同步路径：不等待异步 disposer；需要等待请用 disposeAsync）',
      })
    },
    async disposeAsync() {
      if (!disposed) {
        disposed = true
        settling.push(...drainOwners())
        activeSessions.clear()
        sessionRuntime.clear()
      }
      // allSettled 语义：任何一个失败都不阻止其余，也不让本方法 reject
      await Promise.allSettled(settling.splice(0, settling.length))
      healthTable.report('omb-kernel', {
        state: 'ok',
        detail: '内核已注销（异步路径：全部 disposer 已完成）',
      })
    },
  }
  // 句柄上打标记（值就是句柄自己）：模块入口（`hostEntry.ts`）靠它拿到 `mount`，
  // 从而让模块自报的健康绑定到模块 id。见 `markKernelHandle` 的说明。
  markKernelHandle(handle)
  return handle
}

/** 由 `start` 传入的模块配置。缺省配置在模块 schema 里，这里传 undefined 让其走 defaults。 */