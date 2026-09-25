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
  ): readonly {
    readonly id: string
    readonly reason: string
  }[]
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

  // 状态面登记处由内核自己提供：单值服务表装不下 N 个贡献者（见 abi/catalog.ts 的说明）
  services.provide(SERVICES.statusContributor, statusTable)

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

  // `report` 需要一个键：模块把自己的 id 放在 health 之外，
  // 因此这里用"最近一次上报的调用栈之外"的显式键不方便，改由 start 包装。
  // 见 start() 中注入的 per-module report。

  return {
    kernel,
    start(modules, configs) {
      const plan = planModules(modules)
      for (const blocked of plan.blocked) {
        healthTable.report(blocked.id, { state: 'failed', detail: blocked.reason })
        logger.warn(`内核：模块 ${blocked.id} 未启动——${blocked.reason}`)
      }
      for (const { id, registration } of plan.ordered) {
        // 每个模块拿到一个把 report 绑定到自己 id 的内核视图；
        // 这样健康面无需模块自己报 id（少一个出错点）。
        const scoped: Kernel = { ...kernel, report: health => healthTable.report(id, health) }
        try {
          const config = registration.manifest.configSchema.parse(configs?.get(id))
          const disposer = registration.apply(scoped, config)
          if (typeof disposer === 'function') disposers.push(disposer)
          healthTable.report(id, { state: 'ok', detail: `模块 ${id} 已启动` })
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
}

/** 由 `start` 传入的模块配置。缺省配置在模块 schema 里，这里传 undefined 让其走 defaults。 */
