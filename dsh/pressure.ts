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
 * ## 宿主侧的真源
 *
 * `packages/llm/token-meter/src/projection.ts:68-76` 注册了三个会话投影：
 *
 * - `contextPressure`：`pressureTokens`（最近一次请求的真实 prompt 大小）、
 *   `projectedTokens`（下一次请求的预估，会上报 usage 而对 compaction 一无所知）、
 *   `contextWindow`（该路由最新一次被声明的窗口容量）
 * - `tokenUsage`：累计缓存读 / 写 token
 * - `contextBreakdown`：system / tools / messages 的**启发式**构成
 *
 * 三者都经 `ctx.sessionProjections.stateOf(session, key)` 读取
 * （`packages/session/session-projection/src/index.ts:319`），而 `stateOf` 要的是
 * **Session 对象**、不是 sessionId —— 本模块负责那个映射。
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

/** 宿主 Session 对象的最小形状（只要 `stateOf` 认它是同一个对象）。 */
type HostSession = object

/** 有 `stateOf` 的投影注册表。 */
interface ProjectionRegistry {
  stateOf(session: unknown, key: string): unknown
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

  /** 读一个投影；注册表缺失、键未注册、单元抛错都返回 undefined。 */
  const projectionOf = (registry: ProjectionRegistry, session: HostSession, key: string): Record<string, unknown> | undefined => {
    try {
      return asRecord(registry.stateOf(session, key))
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
      if (registry === undefined || typeof registry.stateOf !== 'function') {
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
      // **优先 projectedTokens**：它是"下一次请求的 prompt 会花多少"，随 compaction
      // 立即变化；pressureTokens 只跟着 provider 上报走，compaction 之后仍是旧值
      // （projection.ts:37-45）。用了旧值，压完上下文压力档位不会回落。
      const total = firstFinite(pressure['projectedTokens'], pressure['pressureTokens'])
      if (total === undefined) {
        lastReason = '宿主尚未上报过一次 provider usage（投影里还没有压力读数）'
        unmetered += 1
        return undefined
      }

      const window = finite(pressure['contextWindow'])
      const usableWindow = window !== undefined && window > 0 ? window : undefined
      const usage = projectionOf(registry, session, KEY_USAGE)
      const breakdown = projectionOf(registry, session, KEY_BREAKDOWN)

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
        cacheReadTokens: finite(usage?.['cacheReadTokens']) ?? 0,
        cacheWriteTokens: finite(usage?.['cacheWriteTokens']) ?? 0,
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
