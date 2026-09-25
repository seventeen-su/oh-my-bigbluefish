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
  /** 注销全部服务与事件订阅。**绝不抛异常**（热插拔 H-1）。 */
  dispose(): void
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

  // 三个登记处都由内核自己 provide：
  // ① 状态面：单值服务表装不下 N 个贡献者（见 abi/catalog.ts 的说明）
  // ② 第二通道：**依赖方向要求"推"而不是"拉"**——`omb-memory-vector` 的 requires
  //    包含 `omb-memory`，所以只能由向量模块把自己的通道注册进来，记忆模块读登记处。
  // ③ 活跃会话：模块经收养视图订阅事件时订到的是**宿主**事件面，收不到内核对
  //    `turn/start` 的广播（见 kernel/activeSession.ts）。会话这个全局事实必须由
  //    内核持有，模块按需读取，不能依赖"模块能不能收到某条事件"。
  services.provide(SERVICES.statusContributor, statusTable)
  services.provide(SERVICES.channelRegistry, channelTable)
  services.provide(SERVICES.activeSession, activeSessions)

  let disposed = false
  const disposers: (() => void | Promise<void>)[] = []
  
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
        return typeof result === 'function' ? result : () => {}
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
          if (typeof disposer === 'function') disposers.push(disposer)
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
    budgets: () => budgetTable.snapshot(),
    listenerCount: () => bus.listenerCount(),
    dispose() {
      disposed = true
      // 逐个注销；任何一个抛异常都被吞掉并记日志——绝不向上传播（H-1）
      for (const disposer of disposers.reverse()) {
        try {
          void disposer()
        } catch (error) {
          logger.warn(`内核：模块注销时抛异常（已隔离）——${String(error)}`)
        }
      }
      disposers.length = 0
      healthTable.report('omb-kernel', { state: 'ok', detail: '内核已注销' })
    },
  }
  // 句柄上打标记（值就是句柄自己）：模块入口（`hostEntry.ts`）靠它拿到 `mount`，
  // 从而让模块自报的健康绑定到模块 id。见 `markKernelHandle` 的说明。
  markKernelHandle(handle)
  return handle
}

/** 由 `start` 传入的模块配置。缺省配置在模块 schema 里，这里传 undefined 让其走 defaults。 */