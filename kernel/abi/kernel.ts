/**
 * 内核给模块的能力。**模块只能用它**——不接触宿主 Context。
 *
 * 这条边界使 `modules/*` 无法 import `@deepseek-ai/*`（ESLint 强制），
 * 因此模块层可以零 mock 测试，且宿主升级的影响被限制在 `dsh/` 一层。
 */
import type { ContextPressure } from './ports.js'
import type { ModuleHealth } from './manifest.js'
export type { ModuleHealth } from './manifest.js'
import type { Logger, Clock } from './ports.js'
import type { FocusDepth } from './kinds.js'

/** 资源槽的类别。 */
export type BudgetKind = 'tokens' | 'calls' | 'millis'

/** 一次获批的预算。 */
export interface BudgetGrant {
  readonly kind: BudgetKind
  readonly amount: number
  /** 归还未用完的部分；可重复调用，幂等。 */
  release(): void
}

/** 模块间事件的载荷表。类型化，禁止裸字符串。 */
export interface ModuleEvents {
  /** 宿主回合开始。 */
  'turn/start': { readonly sessionId: string; readonly turn: number }
  /** 宿主回合结束。 */
  'turn/end': { readonly sessionId: string; readonly turn: number }
  /** 一次可观察事实的产生（工具结果、用户消息、观察到的变化）。 */
  'evidence/observed': {
    readonly sessionId: string
    readonly actionHash: string
    readonly evidenceHash: string
    readonly at: number
  }
  /** 记忆被写入（供画像、审计、回响检测订阅）。 */
  'memory/written': { readonly id: string; readonly scope: string; readonly kind: string }
  /** 模型设定/改变了推理深度档位。 */
  'focus/changed': { readonly sessionId: string; readonly depth: FocusDepth; readonly reason: string }
  /** 上下文压力档位变化（软信号，供各模块调整行为）。 */
  'pressure/band-changed': { readonly sessionId: string; readonly pressure: ContextPressure }
  /** 内核广播本身的健康变化（供状态面聚合）。 */
  'kernel/module-health': { readonly id: string; readonly health: ModuleHealth }
  /**
   * 模块挂载账本发生变化（挂上 / 卸下）。
   *
   * **为什么要一条专门的事件，而不是让订阅方自己去轮询 `moduleGraph()`**：
   * "前置组件被关掉了"这件事只在**变化的瞬间**有信息量——依赖方当时并不会报错，
   * 它只会静默降级。等到下一次有人来查账本时，能拿到的只有"现在缺了"，
   * 拿不到"刚才是谁被关的"，而后者才是用户需要知道的那句话。
   *
   * 载荷直接带上变化之后的 `missingDependencies`：订阅方不必自己重算，
   * 于是"事件里说的"与"状态面显示的"必然是同一份（同一函数产出）。
   */
  'kernel/module-graph-changed': {
    readonly change: 'mount' | 'unmount'
    readonly id: string
    /** `依赖方 ← 依赖`，变化**之后**的全量未满足项。 */
    readonly missingDependencies: readonly string[]
    /** 被卸下的模块在它首次挂载时声明的前置；挂载事件里为空数组。 */
    readonly unmetRequires: readonly string[]
    /**
     * 被卸下的这个模块**是谁的前置**（仍挂着的那些模块 id）。
     *
     * 这一项就是提醒文案要说的那句"关了 X 之后依赖它的 Y 会失效"。
     * 由内核算，不由订阅方自己遍历：账本是内核的事实，且卸下的那一刻
     * 位置信息就会变，让订阅方各算一遍必然出现"事件里说的"与"状态面显示的"不一致。
     */
    readonly dependents: readonly string[]
  }
}

export type ModuleEventName = keyof ModuleEvents

/** 按宿主会话标识。 */
export type SessionRef = string

/**
 * 内核接口。职责穷举（不得扩张）：
 * 服务注册 · 事件总线 · 预算槽 · 健康上报 · 度量桥 · 日志时钟。
 *
 * **内核不做任何业务逻辑**：没有记忆、没有检索、没有推理。
 */
export interface Kernel {
  /**
   * 注册一个命名服务。
   *
   * **同名重复注册 = 替换（不抛异常）。** 这是刻意的语义，两种情形都会发生：
   * ① 热插拔重载同一模块（旧 fiber 的 disposer 可能晚于新注册执行）
   * ② 模块自己重建服务实例
   * 抛异常会把"重载"变成"插件加载失败"，与「开关不该让会话报错」直接冲突。
   * 返回的 disposer **只移除本次注册的实例**，迟到的旧 disposer 不会误删新服务。
   *
   * @returns 注销函数（幂等）。
   */
  provide<T>(name: string, service: T): () => void

  /**
   * 解析服务。
   *
   * **缺失返回 undefined，绝不抛**——这是热插拔不报错的基础：
   * 模块可能在下一刻被卸下，调用方必须能自行降级。
   */
  service<T>(name: string): T | undefined

  /**
   * 已注册的服务名（稳定排序）。
   *
   * 存在的理由：集成层需要按前缀发现服务（如汇总所有 `prompt:*` 贡献），
   * 否则每新增一个模块都要改集成层——那就不是模块化了。
   */
  services(): readonly string[]

  /** 发布事件。订阅者抛异常不得影响发布者。 */
  emit<E extends ModuleEventName>(event: E, payload: ModuleEvents[E]): void

  /** 订阅事件。@returns 注销函数。 */
  on<E extends ModuleEventName>(event: E, fn: (payload: ModuleEvents[E]) => void): () => void

  /**
   * 申请预算槽。超限返回 undefined，**由调用方自己降级**（内核不替它决定）。
   */
  budget(kind: BudgetKind, amount: number): BudgetGrant | undefined

  /** 上报本模块健康。运行中可动态更新，状态面如实反映。 */
  report(health: ModuleHealth): void

  /** 度量桥：读某会话的上下文压力（来自宿主 tokenMeter）。 */
  pressure(session: SessionRef): ContextPressure

  /** 读/设推理深度档位。 */
  focus(session: SessionRef): FocusDepth
  setFocus(session: SessionRef, depth: FocusDepth, reason: string): void

  readonly logger: Logger
  readonly clock: Clock
}
