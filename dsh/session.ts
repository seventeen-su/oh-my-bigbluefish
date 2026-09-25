/**
 * 会话侧集成：把宿主会话事实喂给内核与模块。
 *
 * 三件事：
 * ① 记住会话的 cwd（项目库身份由此确定）
 * ② 汇总各模块的 `PromptContribution` 注入宿主提示层
 * ③ 把宿主会话事件转成内核事件（`turn/start`、`turn/end`、`evidence/observed`）
 *
 * **不接管 Agent Loop**（DSH 硬约束，`docs/cookbook/extension-cookbook.md:100`）：
 * 本层只观察、只注入，不替换也不包装回合。
 */
import { createHash } from 'node:crypto'
import type { HostContextLike } from './host.js'
import { readService } from './host.js'
import type {
  ContextRenderInput,
  Kernel,
  PromptContribution,
  SessionRef,
} from '../kernel/abi/index.js'
import { RESIDENT_HINT_MAX } from '../kernel/abi/index.js'

/** 宿主系统提示服务的最小结构面。 */
export interface SystemPromptLike {
  /**
   * 注册动态上下文。`text` 可为函数，每轮装配时求值。
   * 返回 disposer。见 `packages/core/system-prompt/src/index.ts:489-498`。
   */
  context(entry: {
    name: string
    order: number
    text: string | ((ctx: unknown) => string)
  }): unknown
}

/**
 * 注入顺序。
 *
 * 宿主自己的 `CONTEXT_ORDERS` 是 110/115/120（sandbox/approval/subagent）。
 * 我们用 200 段，落在宿主的内置段之后、保证不插队——插队会改变宿主的提示结构。
 */
export const CONTEXT_ORDER = 200

/** 记录会话的 cwd 与服务映射。 */
export class SessionTable {
  readonly #cwd = new Map<SessionRef, string>()

  remember(session: SessionRef, cwd: string): void {
    this.#cwd.set(session, cwd)
  }

  cwdOf(session: SessionRef): string | undefined {
    return this.#cwd.get(session)
  }

  forget(session: SessionRef): void {
    this.#cwd.delete(session)
  }

  sessions(): readonly SessionRef[] {
    return [...this.#cwd.keys()].sort()
  }
}

/** 从可能的事件载荷里稳取字符串字段（宿主事件形状跨版本可能变）。 */
function pickString(source: unknown, ...keys: readonly string[]): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 稳定短哈希，用于动作/证据指纹（跨进程确定，便于重放与测试）。 */
export function fingerprint(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * 收集内核服务表里所有 `prompt:*` 贡献。
 *
 * 为什么按前缀扫描而不是硬编码名字：新增模块不应改 `dsh/`。
 * 这也是"模块化"在集成层的体现——加一个模块只需它自己 provide 一个 `prompt:<id>`。
 */
export function collectPromptContributions(kernel: Kernel): readonly PromptContribution[] {
  const contributions: PromptContribution[] = []
  for (const name of kernel.services()) {
    if (!name.startsWith('prompt:')) continue
    const value = kernel.service<PromptContribution>(name)
    if (value !== undefined) contributions.push(value)
  }
  return contributions
}

/**
 * 规范化常驻提示：合并所有模块的 `resident`，裁到上限。
 *
 * **逐字节稳定是硬要求**：常驻提示进入系统提示的稳定前缀，
 * 任何跨轮变化都会使其后的整段前缀缓存失效（规划 §6.5）。
 * 因此这里不注入时间戳、计数器，也不随会话变化——只有内容真的变了才变。
 */
export function residentHint(contributions: readonly PromptContribution[]): string {
  const parts = contributions
    .map(c => c.resident?.trim())
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  const joined = parts.join('\n')
  return joined.length <= RESIDENT_HINT_MAX ? joined : joined.slice(0, RESIDENT_HINT_MAX)
}

/**
 * 渲染易变上下文。所有模块的动态段合并成一段，避免污染宿主提示结构。
 */
export function renderContext(
  contributions: readonly PromptContribution[],
  input: ContextRenderInput,
): string {
  const parts: string[] = []
  for (const c of contributions) {
    if (c.context === undefined) continue
    try {
      const text = c.context(input)
      if (text.trim().length > 0) parts.push(text)
    } catch {
      // 单个模块渲染失败不得让整份注入失败
    }
  }
  return parts.join('\n\n')
}

export interface SessionWiringOptions {
  readonly kernel: Kernel
  readonly contributions: readonly PromptContribution[]
  readonly systemPrompt: SystemPromptLike | undefined
  readonly clock: { now(): number }
}

/**
 * 把提示注入接到宿主。
 *
 * 注册时机：**同步**完成（热插拔 H-2——宿主挂载审计只查一次，
 * 事后异步注册会触发进程级失败告警）。
 *
 * @returns 幂等 disposer；**绝不抛异常**（H-1）。
 */
export function wirePromptInjection(options: SessionWiringOptions): () => void {
  const { kernel, contributions, systemPrompt, clock } = options
  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') {
    kernel.logger.warn('OMB：宿主 systemPrompt 服务不可用，认知投影未注入（状态面已记录）')
    return () => {}
  }

  const resident = residentHint(contributions)
  let disposer: unknown
  try {
    disposer = systemPrompt.context({
      name: 'omb:cognitive',
      order: CONTEXT_ORDER,
      text: (ctx: unknown): string => {
        // 会话 id 用于按会话取档位/压力（`AssembleContext.agent` 由 agent 包增强）
        const sessionId = sessionIdOf(ctx)
        const input: ContextRenderInput = {
          sessionId,
          depth: kernel.focus(sessionId),
          band: kernel.pressure(sessionId).band,
        }
        // 易变快照里也带常驻提示：宿主对运行时上下文的语义是
        // 「本快照取代此前的运行时上下文快照」，所以完整自包含比精简更重要。
        const dynamic = renderContext(contributions, input)
        return [resident, dynamic].filter(p => p.length > 0).join('\n\n')
      },
    })
    // 记录一次注入时间，供诊断（不进入提示文本，因此不影响缓存）
    kernel.logger.debug(`OMB：认知投影已注入（常驻 ${resident.length} 字符，order ${CONTEXT_ORDER}，t=${clock.now()}）`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    kernel.logger.warn(`OMB：认知投影注册失败——${message}`)
    return () => {}
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      if (typeof disposer === 'function') (disposer as () => void)()
    } catch {
      // H-1：回收失败不得向上传播
    }
  }
}

/** 从宿主装配上下文里取会话 id。宿主未提供时退化为空串（不影响功能，只影响按会话的档位）。 */
function sessionIdOf(ctx: unknown): string {
  const agent = (ctx as { agent?: unknown } | undefined)?.agent
  const fromAgent = pickString(agent, 'id')
  if (fromAgent !== undefined) return fromAgent
  const session = (agent as { session?: unknown } | undefined)?.session
  const fromSession = pickString(session, 'id')
  if (fromSession !== undefined) return fromSession
  return pickString(ctx, 'scope') ?? ''
}

/**
 * 订阅宿主会话事件并转成内核事件。
 *
 * 只订阅**三个**宿主事件面（与规划一致，不扩张观察面）：
 * `session/event`（回合/工具）、`session/flush`、`tools/result`。
 *
 * @returns 幂等 disposer；绝不抛。
 */
export function wireSessionEvents(options: {
  readonly ctx: HostContextLike
  readonly kernel: Kernel
  readonly sessions: SessionTable
  readonly onToolResult?: (payload: { sessionId: string; text: string; callId: string | undefined }) => void
}): () => void {
  const { ctx, kernel, sessions, onToolResult } = options
  if (typeof ctx.on !== 'function') {
    kernel.logger.warn('OMB：宿主事件订阅不可用，认知层将只做注入不做观察（状态面已记录）')
    return () => {}
  }

  const offs: (() => void)[] = []
  const safeOn = (event: string, fn: (...args: never[]) => void): void => {
    try {
      const returned = ctx.on?.(event, fn)
      if (typeof returned === 'function') offs.push(returned as () => void)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      kernel.logger.warn(`OMB：订阅 ${event} 失败——${message}`)
    }
  }

  safeOn('session/event', (async (...args: unknown[]) => {
    const [session, event] = args
    const sessionId = pickString(session, 'id') ?? ''
    const type = pickString(event, 'type')
    if (sessionId.length === 0 || type === undefined) return
    const data = (event as { data?: unknown } | undefined)?.data
    switch (type) {
      case 'turn/start': {
        const turn = typeof (data as { turn?: unknown })?.turn === 'number'
          ? (data as { turn: number }).turn
          : 0
        kernel.emit('turn/start', { sessionId, turn })
        return
      }
      case 'turn/end': {
        const turn = typeof (data as { turn?: unknown })?.turn === 'number'
          ? (data as { turn: number }).turn
          : 0
        kernel.emit('turn/end', { sessionId, turn })
        return
      }
      case 'tool/call': {
        // 动作指纹：工具名 + 参数摘要。用于循环检测（同一动作重复即信号）
        const name = pickString(data, 'name') ?? 'unknown'
        const argsText = JSON.stringify((data as { arguments?: unknown })?.arguments ?? null)
        kernel.emit('evidence/observed', {
          sessionId,
          actionHash: fingerprint('call', name, argsText),
          evidenceHash: '',
          at: kernel.clock.now(),
        })
        return
      }
      default:
        return
    }
  }) as never)

  safeOn('tools/result', (async (...args: unknown[]) => {
    const [exec, result] = args
    const sessionId = pickString((exec as { agent?: { session?: unknown } } | undefined)?.agent?.session, 'id')
      ?? pickString(exec, 'sessionId')
      ?? ''
    if (sessionId.length === 0) return
    const callId = pickString(exec, 'callId')
    const text = extractText(result)
    kernel.emit('evidence/observed', {
      sessionId,
      actionHash: fingerprint('result', callId ?? ''),
      evidenceHash: fingerprint('evidence', text.slice(0, 512)),
      at: kernel.clock.now(),
    })
    try {
      onToolResult?.({ sessionId, text, callId })
    } catch {
      // 观察者的失败不得影响会话
    }
  }) as never)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const off of offs.reverse()) {
      try {
        off()
      } catch {
        // H-1
      }
    }
    offs.length = 0
    void sessions
  }
}

/** 从工具结果里抽可读文本（形状跨版本可能变，尽力而为）。 */
export function extractText(result: unknown): string {
  if (typeof result === 'string') return result
  const content = (result as { content?: unknown } | undefined)?.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const text = pickString(block, 'text')
      if (text !== undefined) parts.push(text)
    }
    return parts.join('\n')
  }
  try {
    return JSON.stringify(result ?? '')
  } catch {
    return ''
  }
}

/** 便利：从宿主上下文取系统提示服务。 */
export function readSystemPrompt(ctx: HostContextLike): SystemPromptLike | undefined {
  return readService<SystemPromptLike>(ctx, 'systemPrompt')
}
