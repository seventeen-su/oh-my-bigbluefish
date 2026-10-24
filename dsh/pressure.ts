/**
 * 上下文压力度量桥：把宿主 token-meter 的会话投影接进内核的 `measure`。
 *
 * ## 这条线为什么必须存在
 *
 * 内核的 `measure` 是可选项（`kernel/index.ts:48`）。缺省时 `pressure()` 恒返回
 * `UNKNOWN_PRESSURE`（`fillRatio: null` → `band: 'relaxed'`）。后果不是"少了一个数字"，
 * 而是**整套压力响应永久失效**：`band` 恒为 `relaxed`，于是"紧张就少说"这条设计
 * 一次都不会触发，而模块健康面、工具面、状态面**全部正常**——
 * 每一层单独看都对，只是中间少了一根线。
 *
 * ## 宿主侧的真源（**优先 snapshot 的 wire view，旧宿主退回 stateOf 的宿主 state**）
 *
 * `packages/llm/token-meter/src/projection.ts` 注册了三个会话投影，它们各有
 * **宿主 state** 与 **client wire view** 两层形状：
 *
 * - `contextPressure` state：`{contextWindow?, pressureTokens?, surfaceTokens,
 *   sampledSurfaceTokens?, claim?}`；wire view：`{contextWindow?, pressureTokens?,
 *   projectedTokens?}`，其中 `projectedTokens = pressureTokens + surfaceTokens −
 *   sampledSurfaceTokens`（`usage-projection.ts` 的 `wire.view`）。
 * - `tokenUsage` state：`{totals, last}`；wire view 是**扁平 totals**。
 * - `contextBreakdown` state：`{systems, surfaceTokens, breakdown:{...}}`；
 *   wire view 是嵌套的 `breakdown`。
 *
 * DSH 0.2.1-rc.3 之后 `sessionProjections.stateOf(session, key)` 被标记 deprecated
 * （仍返回宿主 state，但每个键打一次警告），正路是注册句柄的 `stateOf` 或所属域服务。
 * 第三方插件没有注册句柄，所以本文件**优先**走非弃用的
 * `ctx.sessionProjections.snapshot(session, [key]).values[key]`（wire view），
 * 没有 `snapshot` 的旧宿主才退回 `stateOf`（宿主 state）。下面两种形状都吃：
 * 压力优先用 wire 的 `projectedTokens`，缺了再按同一条公式用 state 三个字段算；
 * 用量先看 `totals`、缺了就当扁平 view；构成先看嵌套 `breakdown`、缺了就当扁平 view。
 *
 * 读错形状不会报错，只会**静默地永远读到 0 / undefined**——本文件的测试替身曾经
 * 照着 wire view 写，于是整条链路在测试里全绿、在真机上从未生效。所以两种形状现在
 * 各有一条测试钉住（`tests/dsh/pressure.test.ts`）。
 *
 * 两者都要求传 **Session 对象**、不是 sessionId —— 本模块负责那个映射。
 *
 * ## 映射怎么来
 *
 * 两条路，先快后慢：
 *
 * 1. `session/event` 的载荷里 `args[0]` **就是** Session 对象
 *    （`packages/core/session/src/index.ts:77` 的签名 `(session, event)`）；
 *    `dsh/session.ts` 的订阅已经拿到了它，`remember()` 把它按 sessionId 存下来。
 * 2. 缓存未命中时问宿主的会话注册表：服务名 `sessions`，有 `get(sessionId)`
 *    （`packages/core/session/src/index.ts:953`）。
 *
 * 第 2 条是兜底而非主路：宿主 ctx 受 Cordis Guard 管，读未 `inject` 的服务会抛，
 * 所以整段包 try/catch —— 拿不到就是降级，绝不影响加载（H-1 / H-3）。
 *
 * 本文件**不 import 任何 `@deepseek-ai/*`**，与 `dsh/` 其余文件同一规矩。
 *
 * @module omb/dsh/pressure
 */
import type { ContextNodeCost, ContextPressure } from '../kernel/abi/index.js'
import type { HostContextLike } from './host.js'

/** 宿主投影键，与 token-meter 的注册键逐字一致。 */
const KEY_PRESSURE = 'contextPressure'
const KEY_USAGE = 'tokenUsage'
const KEY_BREAKDOWN = 'contextBreakdown'

/** 宿主会话注册表的服务名。 */
const SESSIONS_SERVICE = 'sessions'

/** 宿主投影注册表的服务名。 */
const PROJECTIONS_SERVICE = 'sessionProjections'

/**
 * 记住的会话上限。超出按最旧淘汰。
 *
 * 上限而非无限：Session 对象不归本插件所有，长期持有一整个进程里出现过的每个会话
 * 是一处无界内存增长，而**可度量的会话本来就只在最近几个**里。
 */
const MAX_REMEMBERED = 256

/** 宿主 Session 对象的最小形状（投影读取认它是同一个对象）。 */
type HostSession = object

/**
 * 会话投影注册表：两种读法都收。
 *
 * - `snapshot(session, [key])`：DSH 0.2.1-rc.3 之后的**非弃用**读法，返回
 *   `{asOfSeq, values}`，`values[key]` 是 **client wire view**；
 * - `stateOf(session, key)`：旧读法（rc.3 起 deprecated），返回 **宿主 state**。
 */
interface ProjectionRegistry {
  snapshot?(session: unknown, keys?: readonly string[]): unknown
  stateOf?(session: unknown, key: string): unknown
}

/** 有 `get` 的会话注册表。 */
interface SessionRegistry {
  get(id: string): unknown
}

export interface PressureBridge {
  /** 交给 `createKernel({ measure })`。**绝不抛**。 */
  readonly measure: (session: string) => ContextPressure | undefined
  /** 观测到一次会话事件时调用，把 Session 对象留下备用。 */
  readonly remember: (sessionId: string, session: unknown) => void
  /**
   * 当前为什么量不到（或量到了什么）。
   *
   * 存在的理由与 `omb_status` 里那句"未测量 ≠ 测量为零"是同一条：
   * **"没有度量"与"没在量"必须能分开**，否则状态面只能显示一个 0，
   * 而 0 会被读成"上下文是空的"。这里给出的是**原因**，供状态面照抄。
   */
  readonly reason: () => string
  /** 供测试与诊断：命中 / 未命中计数。 */
  readonly stats: () => { remembered: number; measured: number; unmetered: number }
  /** 幂等 disposer，绝不抛。 */
  readonly dispose: () => void
}

/** 从 unknown 里取一个有限数值；不是有限数就返回 undefined（**不把 NaN 当 0**）。 */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 从 unknown 里按顺序取第一个有限数值。 */
function firstFinite(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const found = finite(value)
    if (found !== undefined) return found
  }
  return undefined
}

/** 把 unknown 收窄成可读字段的记录；不是对象就返回 undefined。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * 造度量桥。
 *
 * @param options.ctx 宿主上下文（只用到可选的 `get`）。
 * @returns 绝不抛的度量桥。
 */
export function createPressureBridge(options: { readonly ctx: HostContextLike }): PressureBridge {
  const { ctx } = options
  const sessions = new Map<string, HostSession>()
  let measured = 0
  let unmetered = 0
  let disposed = false
  let lastReason = '尚未收到任何会话事件，也还没有可解析的会话（没有可度量的对象）'

  /** 读一个宿主服务；`ctx.get` 缺失或 Guard 拒绝都返回 undefined（H-3）。 */
  const service = <T,>(name: string): T | undefined => {
    try {
      if (typeof ctx.get !== 'function') return undefined
      const found = ctx.get(name)
      return typeof found === 'object' && found !== null ? (found as T) : undefined
    } catch {
      // Guard 拒绝（本行没 inject 这个名字）→ 不可用，不是错误
      return undefined
    }
  }

  /** 记住一个会话，并按 LRU 淘汰。 */
  const remember = (sessionId: string, session: unknown): void => {
    if (disposed) return
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof session !== 'object' || session === null) return
    // 重新插入以刷新 LRU 次序（Map 保序）
    sessions.delete(sessionId)
    sessions.set(sessionId, session)
    while (sessions.size > MAX_REMEMBERED) {
      const oldest = sessions.keys().next()
      if (oldest.done === true) break
      sessions.delete(oldest.value)
    }
  }

  /** sessionId → Session 对象：先查缓存，再问宿主注册表。 */
  const resolve = (sessionId: string): HostSession | undefined => {
    const cached = sessions.get(sessionId)
    if (cached !== undefined) return cached
    const registry = service<SessionRegistry>(SESSIONS_SERVICE)
    if (registry === undefined || typeof registry.get !== 'function') return undefined
    let found: unknown
    try {
      found = registry.get(sessionId)
    } catch {
      // 宿主注册表拒绝（会话不存在 / 已销毁）→ 当作没解析到
      return undefined
    }
    if (typeof found !== 'object' || found === null) return undefined
    remember(sessionId, found)
    return found
  }

  /**
   * 读一个投影；注册表缺失、键未注册、单元抛错都返回 undefined。
   *
   * 优先 `snapshot`（非弃用，wire view），没有才退回 `stateOf`（宿主 state）。
   * 两种形状的字段差异由下面的解析按"优先 view、退回 state"兼容（见文件头）。
   */
  const projectionOf = (registry: ProjectionRegistry, session: HostSession, key: string): Record<string, unknown> | undefined => {
    try {
      if (typeof registry.snapshot === 'function') {
        const snapshot = asRecord(registry.snapshot(session, [key]))
        const values = asRecord(snapshot?.['values'])
        return asRecord(values?.[key])
      }
      return typeof registry.stateOf === 'function' ? asRecord(registry.stateOf(session, key)) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 由启发式构成投影拼出"最贵的几块"。
   *
   * **名字里必须带「估算」**：token-meter 自己的文档写明这三个数用固定密度估计，
   * 会系统性低估 CJK 与 JSON schema，**不与 `totalTokens` 相加对齐**
   * （`packages/llm/token-meter/src/projection.ts:50-57`）。
   * 名字不写，读者就会把三项加起来跟"总 token"对账，然后得出"数字错了"的结论。
   */
  const nodesOf = (breakdown: Record<string, unknown> | undefined): ContextNodeCost[] => {
    if (breakdown === undefined) return []
    const nodes: ContextNodeCost[] = []
    const push = (name: string, tokens: unknown): void => {
      const value = finite(tokens)
      if (value !== undefined && value > 0) nodes.push({ name, tokens: value })
    }
    push('系统提示（估算）', breakdown['systemTokens'])
    push('工具定义（估算）', breakdown['toolsTokens'])
    push('消息（估算）', breakdown['messageTokens'])
    return nodes
  }

  const measure = (sessionRef: string): ContextPressure | undefined => {
    if (disposed) return undefined
    try {
      if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
        lastReason = '没有会话标识，无法度量'
        unmetered += 1
        return undefined
      }
      const registry = service<ProjectionRegistry>(PROJECTIONS_SERVICE)
      if (registry === undefined
        || (typeof registry.snapshot !== 'function' && typeof registry.stateOf !== 'function')) {
        lastReason = `宿主没有提供 ${PROJECTIONS_SERVICE} 服务（拿不到上下文投影；宿主缺 token-meter 一类组件时会这样）`
        unmetered += 1
        return undefined
      }
      const session = resolve(sessionRef)
      if (session === undefined) {
        lastReason = `尚未观察到会话 ${sessionRef} 的 Session 对象，宿主会话注册表也解析不到它`
        unmetered += 1
        return undefined
      }

      const pressure = projectionOf(registry, session, KEY_PRESSURE)
      if (pressure === undefined) {
        lastReason = '宿主尚未注册 contextPressure 投影'
        unmetered += 1
        return undefined
      }
      // **下一次请求的压力**：优先用 wire view 的 `projectedTokens`（非弃用读法）；
      // 旧宿主/旧替身给的是宿主 state，没有 `projectedTokens`，只有
      // `{pressureTokens, surfaceTokens, sampledSurfaceTokens}`——那就按 view 的同一条公式算：
      //   projected = pressureTokens + surfaceTokens − sampledSurfaceTokens
      // 它随 compaction 立即下降（surface 被遮蔽），而 pressureTokens 只跟 provider
      // 上报走、压缩后仍是旧值。两条路的结果是同一个数，不需要知道读的是哪一层。
      const pressureTokens = finite(pressure['pressureTokens'])
      const surfaceTokens = finite(pressure['surfaceTokens'])
      const sampledSurfaceTokens = finite(pressure['sampledSurfaceTokens'])
      const projected = finite(pressure['projectedTokens'])
      const total = pressureTokens !== undefined && surfaceTokens !== undefined && sampledSurfaceTokens !== undefined
        ? Math.max(0, Math.round(pressureTokens + surfaceTokens - sampledSurfaceTokens))
        : firstFinite(projected, pressureTokens)
      if (total === undefined) {
        lastReason = '宿主尚未上报过一次 provider usage（投影里还没有压力读数）'
        unmetered += 1
        return undefined
      }

      const window = finite(pressure['contextWindow'])
      const usableWindow = window !== undefined && window > 0 ? window : undefined
      const usage = projectionOf(registry, session, KEY_USAGE)
      // `tokenUsage` 的宿主 state 是 `{totals,last}`；client wire view 是扁平 totals。
      // 旧宿主读错一层会永远得到 0（这正是某次修复前的实测症状），所以两种都收。
      const usageTotals = asRecord(usage?.['totals']) ?? usage
      const breakdownRoot = projectionOf(registry, session, KEY_BREAKDOWN)
      // `contextBreakdown` 的宿主 state 是 `{systems,surfaceTokens,breakdown:{...}}`；
      // client wire view 就是嵌套的 `breakdown`。两种都收：有嵌套取嵌套、没有就当扁平。
      const breakdown = asRecord(breakdownRoot?.['breakdown']) ?? breakdownRoot

      measured += 1
      lastReason = usableWindow === undefined
        ? `已读到 ${total} token，但宿主没有声明该路由的窗口容量 → 比例不可计算（不臆断）`
        : `已读到 ${total}/${usableWindow}（来源：会话投影 contextPressure）`

      return {
        totalTokens: total,
        // 不夹到 [0,1]：超过窗口是**真实发生过**的事，夹掉等于把"已经溢出"粉饰成"刚好满"。
        fillRatio: usableWindow === undefined ? null : total / usableWindow,
        // 占位值：`kernel.pressure()` 一律用 `bandOf(fillRatio, bands)` 覆写
        // （kernel/index.ts:420），阈值只有内核那一份，此处不重复实现。
        // tests/kernel/kernel.test.ts:214 钉住了这条契约。
        band: 'relaxed',
        cacheReadTokens: finite(usageTotals?.['cacheReadTokens']) ?? 0,
        cacheWriteTokens: finite(usageTotals?.['cacheWriteTokens']) ?? 0,
        nodes: nodesOf(breakdown),
      }
    } catch (error) {
      // 度量桥自己出问题，绝不冒泡进 kernel.pressure（H-1 同源约束：
      // 一次读数失败不得把调用它的模块打成故障）
      lastReason = `度量桥内部异常（已隔离）：${error instanceof Error ? error.message : String(error)}`
      unmetered += 1
      return undefined
    }
  }

  return {
    measure,
    remember,
    reason: () => lastReason,
    stats: () => ({ remembered: sessions.size, measured, unmetered }),
    dispose: () => {
      disposed = true
      sessions.clear()
    },
  }
}
