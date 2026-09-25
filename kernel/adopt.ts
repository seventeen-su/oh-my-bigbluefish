/**
 * 宿主上下文收养：把 Cordis 的 `ctx` 代理安全地变成我们的 `Kernel` 纯对象视图。
 *
 * **为什么必须有这一层**：宿主 Cordis 按它自己的契约调用 `apply(ctx, config)`——
 * 第一个参数是**宿主 ctx 代理**，不是我们的内核。两套契约在这里撞上：
 * 模块（如 `modules/memory`）会在 `apply` 里读 `kernel.logger` / `kernel.clock`、
 * 调 `kernel.service(...)` / `kernel.provide(...)`，而 Cordis 的 Guard 对
 * **未 `inject` 的属性读写直接抛** `cannot get property "clock" without inject`。
 *
 * 实测症状（装到 profile 后）：4 个模块激活失败，报错正是上面那句；
 * 而工具面与提示注入却正常（那些走 `ctx.get`），于是表现为
 * "插件半活"——最难排查的一种状态。
 *
 * **两件事必须做对**：
 * ① 不能用 `{ ...ctx }` 展开。展开会把 Proxy 的 getter **实体化**，
 *    等于绕过 Guard（之后所有访问都落到普通属性上），Guard 的哨兵作用就没了。
 *    所以逐项**显式取一次**，构造只含允许能力的纯对象。
 * ② 服务注册（`provide`）一律进**内核自己的服务表**。宿主服务只经 `get` 读取。
 *    这样"模块注册了什么"完全由内核掌握，不依赖宿主 ctx 的内部形状。
 */
import type {
  FocusDepth,
  BudgetGrant,
  BudgetKind,
  Clock,
  ContextPressure,
  Kernel,
  Logger,
  ModuleHealth,
  SessionRef,
} from './abi/index.js'

/** 宿主 Cordis 上下文的最小结构面（只取我们需要的）。 */
export interface ForeignContextLike {
  get?(name: string): unknown
  on?(event: string, fn: (...args: never[]) => void): unknown
  logger?: unknown
}

/** 内核自有能力。收养时用它们，宿主只补"服务读取"与"事件订阅"。 */
export interface KernelCore {
  readonly services: {
    get<T>(name: string): T | undefined
    names(): readonly string[]
    provide(name: string, value: unknown): () => void
  }
  on(event: string, fn: (payload: unknown) => void): () => void
  emit(event: string, payload: unknown): void
  budget(kind: BudgetKind, amount: number): BudgetGrant | undefined
  pressure(session: SessionRef): ContextPressure
  focus(session: SessionRef): string
  setFocus(session: SessionRef, depth: FocusDepth, reason: string): void
  readonly logger: Logger
  readonly clock: Clock
}

/** 把宿主 logger 收敛成我们的 `Logger`；缺失则静默（诊断降级不得影响功能）。 */
function adoptLogger(raw: unknown): Logger | undefined {
  if (raw === undefined || raw === null) return undefined
  let candidate: Record<string, unknown> | undefined
  try {
    candidate = (typeof raw === 'function' ? (raw as () => unknown)() : raw) as
      | Record<string, unknown>
      | undefined
  } catch {
    return undefined
  }
  if (candidate === undefined || candidate === null) return undefined
  const forward = (level: 'debug' | 'info' | 'warn', message: string): void => {
    const fn = candidate?.[level]
    if (typeof fn === 'function') {
      try {
        ;(fn as (m: string) => void).call(candidate, message)
      } catch {
        // 宿主日志本身失败不得影响内核
      }
    }
  }
  return {
    debug: m => forward('debug', m),
    info: m => forward('info', m),
    warn: m => forward('warn', m),
  }
}

/**
 * 把宿主 ctx 收养成 `Kernel`。
 *
 * 每个**宿主**能力只取一次（经 `get`，不触发 Guard 的未声明属性读），
 * 之后落到纯对象上——模块再读 `kernel.logger` 之类不会碰宿主代理。
 *
 * @param ctx 宿主 ctx（可能是代理，也可能是普通对象）。
 * @param core 内核自有能力。
 * @param selfReport 该模块的健康上报入口（已绑定模块 id）。
 */
export function adoptContext(
  ctx: ForeignContextLike,
  core: KernelCore,
  selfReport: (health: ModuleHealth) => void,
): Kernel {
  const hostGet = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : undefined
  const readHost = (name: string): unknown => {
    if (hostGet === undefined) return undefined
    try {
      return hostGet(name)
    } catch {
      // Guard 拒绝或宿主状态异常 → 视为"不提供该能力"（H-3）
      return undefined
    }
  }
  const hostOn = typeof ctx.on === 'function' ? ctx.on.bind(ctx) : undefined

  const logger = adoptLogger(ctx.logger) ?? core.logger

  const kernel: Kernel = {
    /** 宿主服务优先（真宿主提供 tools/systemPrompt 等），否则内核自有表。 */
    service: <T,>(name: string) => (readHost(name) ?? core.services.get<T>(name)) as T | undefined,
    services: () => core.services.names(),
    provide: (name, value) => core.services.provide(name, value),
    on: (event, fn) => {
      // 宿主事件面优先（`session/event` 等只有宿主有）；失败则回落内核总线
      if (hostOn !== undefined) {
        try {
          const off = hostOn(event, fn as (...args: never[]) => void)
          if (typeof off === 'function') return off as () => void
        } catch {
          // 回落内核总线
        }
      }
      return core.on(event, fn as (payload: unknown) => void)
    },
    emit: (event, payload) => core.emit(event, payload),
    budget: (kind, amount) => core.budget(kind, amount),
    report: selfReport,
    pressure: session => core.pressure(session),
    focus: session => core.focus(session) as ReturnType<Kernel['focus']>,
    setFocus: (session, depth, reason) => core.setFocus(session, depth, reason),
    logger,
    clock: core.clock,
  }
  return kernel
}
