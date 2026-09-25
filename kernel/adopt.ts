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
import { heartbeat } from './hostEntry.js'
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
 * **只有宿主才有的**事件名：这些必须订宿主的事件面。
 *
 * 其余一律订内核总线——因为 `dsh/` 发事件走的是 `core.emit`（内核总线），
 * 而 `ctx.on` 对任何事件名都会"成功"返回一个 disposer，无法用它来区分。
 * 换句话说：**"订上了"不等于"订对了地方"**，这句判据必须靠白名单。
 *
 * 新增宿主事件时把它加进来；新增**内核**事件时什么都不用做。
 */
const HOST_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'session/event',
  'session/flush',
  'tools/result',
  'tools/call',
  'tools/execute',
  'tools/post-execute',
])

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
      // **默认订内核总线，只有宿主独有的事件才用宿主事件面。**
      //
      // 为什么必须这样排（踩过两次，都不报错，症状只是"事件好像没来"）：
      //
      // 收养视图原先写成"宿主事件面优先，失败才回落内核总线"。而 `ctx.on` 对
      // **任何**事件名都返回一个函数，于是 `turn/start`、`focus/changed` 这些
      // 内核总线事件**全部被静默订到了宿主面上**：
      //
      // - 模块 `kernel.on('turn/start', …)` → 订到宿主面
      // - `dsh/session.ts` `kernel.emit('turn/start')` → 发在内核总线
      // - 两者永远碰不到；订阅注册成功、disposer 正常、健康面全绿
      //
      // 实测代价（两次）：
      // ① `omb_focus` 一直报"取不到当前会话标识"；
      // ② 修了①之后，「跟踪会话」恒为 0——因为 `focus/changed` 同样订错了面，
      //    会话状态机从未被喂到，于是**循环检测事实上空转**，健康面却报"正常"。
      //
      // 判据是"这个事件名是不是宿主独有"，不是"宿主能不能订上"。
      if (hostOn !== undefined && HOST_ONLY_EVENTS.has(event)) {
        try {
          const off = hostOn(event, fn as (...args: never[]) => void)
          if (typeof off === 'function') {
            heartbeat('adopt-on', { event, backend: 'host' })
            return off as () => void
          }
        } catch {
          // 回落内核总线
        }
      }
      heartbeat('adopt-on', { event, backend: 'kernel' })
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
