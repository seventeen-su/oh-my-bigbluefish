/**
 * 会话运行态（内核 = 控制平面）——**消灭"事件明明来了，状态却记到另一个会话"**。
 *
 * ## 为什么需要它
 *
 * 同一份"当前会话"事实曾经以多种形式散落在各组件里：
 *
 * ```
 * 内核 ActiveSessionTable            （会话 → cwd，已收敛）
 * modules/reasoning  lastActiveSession  ← 事件里赋值，工具调用时当归属
 * modules/memory     lastActiveSession  ← 同上
 * modules/context    lastActiveSession  ← 同上
 * ```
 *
 * `lastActiveSession` 的语义是"**最近**看到的那个会话"。单个会话时它恰好等于当前会话，
 * 因此长期看起来是对的；一旦两个会话交错（多窗口、子代理、并发回合）：
 *
 * ```
 * A turn/start  → lastActiveSession = A
 * B turn/start  → lastActiveSession = B
 * A 的工具调用  → 读到 B      ← 状态写进了别人的会话
 * ```
 *
 * 改名、加"这是快路径"的注释都治不了它：**问题不在名字，在于用"最近一个"当归属**。
 *
 * ## 这一版的分工（硬性）
 *
 * - **归属只在有确切来源时确定**：工具调用用**本次调用自己的** `agent`（宿主
 *   `exec.agent` → `ToolCallContext.sessionId`），会话事件用**事件所属会话**，
 *   命令用 `invocation.agent`。这些是"这次是谁"，不是"最近是谁"。
 * - **拿不到就不猜**：`note()` 拒绝空会话并把这次观测记进 `unknownObservations`；
 *   调用方要么给出可读原因拒绝执行，要么在输出里明说"归属未知"。
 * - **运行态按会话键控**：每个会话一份 `SessionRuntime`，模块的私有状态挂在
 *   `slot()` 上，容器保证 `for(A)` 永远拿不到 B 的状态。
 *
 * ## 与 `ActiveSessionTable` 的分工
 *
 * `ActiveSessionTable`（`kernel/activeSession.ts`）仍然是"会话 → cwd"的**唯一**存放处，
 * 它的 `current()` 只是"最后一次观测到的会话"，**不得**再被任何模块用于归属判断
 * （状态面展示历史读数可以，写任何按会话的状态不行）。
 *
 * 本文件是纯逻辑（只依赖 `kernel/abi`）：不读墙钟（`Clock` 由调用方注入）、不抛异常。
 */
import type { Clock, SessionRef } from './abi/index.js'

/**
 * 一次工具调用的归属信息（由 `dsh/` 从宿主 `exec` **投影**而来）。
 *
 * 宿主那边的确切来源（`D:\Program\deepseek-harness`）：
 * - `ToolDefinition.execute(args, exec)`：`packages/core/tools/src/index.ts:236`
 * - `exec.agent`：`:326-339`（类型声明）、`:1391-1417`（运行时真的填上）
 * - agent loop 每次都传：`packages/core/agent-loop/src/tool-calls.ts:68-81`
 * - `agent.id` 是 `SessionId`：`packages/core/agent/src/types.ts:15-18`
 * - `agent.session`（含 `header.parentSession` / `delegationDepth`）：
 *   `packages/core/agent/src/runtime-types.ts:163-168`
 *
 * `attribution: 'unknown'` 表示"宿主没给会话"——此时模块**不得**改用"最近一个"。
 */
export interface ToolCallContext {
  /** 本次调用所属会话；`attribution === 'unknown'` 时缺省。 */
  readonly sessionId?: SessionRef
  /** 宿主调用 id（`exec.callId`）：只用于关联/审计，**不用于归属**。 */
  readonly callId?: string
  /** 子代理会话的父会话（`agent.session.header.parentSession`）。 */
  readonly parentSessionId?: SessionRef
  /** 委派深度：缺省/0 = 顶层会话（`header.delegationDepth`）。 */
  readonly delegationDepth?: number
  /** 归属确定性。**只有真的拿到会话 id 才允许是 `'session'`。** */
  readonly attribution: 'session' | 'unknown'
}

/** 归属未知：唯一的构造入口，保证不会"顺手"填一个会话进去。 */
export const UNKNOWN_TOOL_CALL: ToolCallContext = Object.freeze({ attribution: 'unknown' })

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * 从**宿主 exec 的原始字段**构造归属信息（`dsh/` 调用；模块不该自己拼）。
 *
 * 只认"确切的会话 id"：`agent.id`（声明字段）优先，`agent.session.header.id`
 * 作为佐证/兜底；两者都没有 → `unknown`。**任何一步都不抛**。
 */
export function toolCallContext(init: {
  readonly sessionId?: unknown
  readonly callId?: unknown
  readonly parentSessionId?: unknown
  readonly delegationDepth?: unknown
}): ToolCallContext {
  const sessionId = nonEmptyString(init.sessionId)
  const callId = nonEmptyString(init.callId)
  const parentSessionId = nonEmptyString(init.parentSessionId)
  const delegationDepth = nonNegativeInteger(init.delegationDepth)
  return Object.freeze({
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(callId === undefined ? {} : { callId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(delegationDepth === undefined ? {} : { delegationDepth }),
    attribution: sessionId === undefined ? 'unknown' : 'session',
  })
}

/** 一次回合/观测的来源。**必须可分辨**：状态面的"这个数是谁的"靠它回答。 */
export type TurnSource = 'session-event' | 'tool-call' | 'kernel-event' | 'explicit'

/**
 * 回合信封：一次观测的**身份 + 顺序**。
 *
 * 字段是"按 OMB 实际需要裁剪"的结果：
 * - `sessionId`：归属（唯一必须字段）
 * - `turnId`：宿主 `step/start` 的步号；拿不到就 `null`（**不猜**）
 * - `sequence`：该会话内单调递增，用于丢弃迟到/重复观测
 * - `timestamp`：`Clock` 读数（模块层不读墙钟）
 * - `source`：这次观测从哪来（审计与状态面用）
 * - `parentSessionId` / `delegationDepth`：子代理血统（有才有）
 *
 * **没有 `causalityId`**：OMB 目前没有"把一次写入回溯到产生它的那次模型请求"的需求
 * （工具关联用 `ToolCallContext.callId` 足够）。要加就得先有真实用例，不为凑字段加。
 */
export interface TurnEnvelope {
  readonly sessionId: SessionRef
  readonly turnId: number | null
  readonly sequence: number
  readonly timestamp: number
  readonly source: TurnSource
  readonly parentSessionId?: SessionRef
  readonly delegationDepth?: number
}

/** 一个会话的运行态。模块的私有状态挂在 `slot()` 上，绝不跨会话共享。 */
export interface SessionRuntime {
  readonly sessionId: SessionRef
  /** 子代理血缘：无父 = null（顶层会话）。 */
  readonly parentSessionId: SessionRef | null
  readonly delegationDepth: number
  readonly firstSeenAt: number
  /** 最近一次被接受的信封。 */
  lastTurn: TurnEnvelope | null
  /** 已接受的观测数（不是"回合数"——回合由宿主定义，这里只数观测）。 */
  observations: number
  /**
   * 取/建本会话的私有槽。
   *
   * `key` **必须带模块前缀**（`reasoning:` / `memory:` / `context:` / `profile:`）：
   * 槽名冲突会让两个模块互相覆盖状态，而那种 bug 只在特定会话下出现。
   */
  slot<T>(key: string, init: () => T): T
  /** 只读一个已存在的槽（不创建）。 */
  peekSlot<T>(key: string): T | undefined
}

/** `note()` 的入参：只有 `sessionId` 是必需的。 */
export interface TurnObservation {
  readonly sessionId: unknown
  readonly turnId?: unknown
  readonly source: TurnSource
  readonly parentSessionId?: unknown
  readonly delegationDepth?: unknown
}

class Runtime implements SessionRuntime {
  readonly sessionId: SessionRef
  parentSessionId: SessionRef | null
  delegationDepth: number
  readonly firstSeenAt: number
  lastTurn: TurnEnvelope | null = null
  observations = 0
  readonly #slots = new Map<string, unknown>()

  constructor(sessionId: SessionRef, now: number) {
    this.sessionId = sessionId
    this.parentSessionId = null
    this.delegationDepth = 0
    this.firstSeenAt = now
  }

  /** 血统只增不减：先看到子会话、后看到它的父信息时也要补上。 */
  noteLineage(parentSessionId: SessionRef | undefined, delegationDepth: number | undefined): void {
    if (parentSessionId !== undefined) this.parentSessionId = parentSessionId
    if (delegationDepth !== undefined && delegationDepth > this.delegationDepth) {
      this.delegationDepth = delegationDepth
    }
  }

  slot<T>(key: string, init: () => T): T {
    const existing = this.#slots.get(key)
    if (existing !== undefined) return existing as T
    const created = init()
    this.#slots.set(key, created)
    return created
  }

  peekSlot<T>(key: string): T | undefined {
    return this.#slots.get(key) as T | undefined
  }

  /** 槽名清单（状态面/测试用，稳定排序）。 */
  slotNames(): readonly string[] {
    return [...this.#slots.keys()].sort()
  }
}

/**
 * 按会话键控的运行态容器（内核控制平面）。
 *
 * 不变式（都有测试钉住）：
 * ① `note()` 只有拿到非空 `sessionId` 才建/改运行态；空会话**拒绝**并计入 `unknownObservations`
 * ② `for(A)` 与 `for(B)` 是两个对象，槽互不可见
 * ③ 同一会话内 `sequence` 单调递增；`accept` 丢弃迟到的旧信封
 * ④ 绝不抛异常（热插拔 H-1/H-3）
 */
export class SessionRuntimeTable {
  readonly #clock: Clock
  readonly #bySession = new Map<SessionRef, Runtime>()
  #unknownObservations = 0
  #lastUnknownSource: TurnSource | null = null

  constructor(clock: Clock) {
    this.#clock = clock
  }

  /** 记一次观测。**拿不到会话就拒绝**（返回 null），并把这次记进"归属未知"计数。 */
  note(observation: TurnObservation): TurnEnvelope | null {
    try {
      const sessionId = nonEmptyString(observation.sessionId)
      if (sessionId === undefined) {
        this.#unknownObservations += 1
        this.#lastUnknownSource = observation.source
        return null
      }
      const runtime = this.#ensureRuntime(sessionId)
      if (runtime === null) return null
      runtime.noteLineage(
        nonEmptyString(observation.parentSessionId),
        nonNegativeInteger(observation.delegationDepth),
      )
      const envelope: TurnEnvelope = Object.freeze({
        sessionId,
        turnId: nonNegativeInteger(observation.turnId) ?? null,
        sequence: runtime.observations + 1,
        timestamp: this.#now(),
        source: observation.source,
        ...(runtime.parentSessionId === null ? {} : { parentSessionId: runtime.parentSessionId }),
        ...(runtime.delegationDepth === 0 ? {} : { delegationDepth: runtime.delegationDepth }),
      })
      return this.accept(envelope)
    } catch {
      // 观测记账绝不抛：一次记账失败不该影响回合
      this.#unknownObservations += 1
      return null
    }
  }

  /**
   * 接受一个信封：**只有序号更大的才收**。
   *
   * 用途：宿主事件可能与工具调用交错到达（`tools/result` 晚于下一次 `step/start`），
   * 迟到的旧信封不能把"最近一次观测"改回过去。
   */
  accept(envelope: TurnEnvelope): TurnEnvelope | null {
    const runtime = this.#bySession.get(envelope.sessionId)
    if (runtime === undefined) return null
    const last = runtime.lastTurn
    if (last !== null && envelope.sequence <= last.sequence) return null
    runtime.lastTurn = envelope
    runtime.observations = envelope.sequence
    return envelope
  }

  /** 取运行态（不存在返回 undefined，不创建）。 */
  for(sessionId: string): SessionRuntime | undefined {
    return this.#bySession.get(sessionId)
  }

  /** 取/建运行态（内部用：需要 `Runtime` 的具体方法）。 */
  #ensureRuntime(sessionId: string): Runtime | null {
    const key = nonEmptyString(sessionId)
    if (key === undefined) return null
    let runtime = this.#bySession.get(key)
    if (runtime === undefined) {
      runtime = new Runtime(key, this.#now())
      this.#bySession.set(key, runtime)
    }
    return runtime
  }

  /** 取/建运行态。空会话返回 null（**建不出"别人的"运行态**）。 */
  ensure(sessionId: string): SessionRuntime | null {
    return this.#ensureRuntime(sessionId)
  }

  /** 已知会话（ASCII 排序 → 输出确定）。 */
  list(): readonly SessionRuntime[] {
    return [...this.#bySession.keys()].sort().map(key => this.#bySession.get(key) as Runtime)
  }

  /** 归属未知的观测数 + 最近一次来源（状态面必须能显示"有多少次没归属上"）。 */
  unknown(): { readonly observations: number; readonly lastSource: TurnSource | null } {
    return { observations: this.#unknownObservations, lastSource: this.#lastUnknownSource }
  }

  forget(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }

  /** 内核关闭时清空（旧会话在新一轮里不再可信）。 */
  clear(): void {
    this.#bySession.clear()
    this.#unknownObservations = 0
    this.#lastUnknownSource = null
  }

  stats(): { readonly sessions: number; readonly unknownObservations: number } {
    return { sessions: this.#bySession.size, unknownObservations: this.#unknownObservations }
  }

  #now(): number {
    try {
      const value = this.#clock.now()
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }
}
