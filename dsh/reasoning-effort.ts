/**
 * 显式档位 → 真实 `reasoningEffort`。
 *
 * 唯一入口是用户命令 `/omb-depth`（`dsh/depth-command.ts`）：它写内核 focus 表，
 * 本文件监听 `focus/changed`，在**下一请求**把档位映射成请求头的
 * `reasoningEffort`（quick→low、deep→max、standard→继承）。
 *
 * 设计约束（全部来自本机实测/源码）：
 * - 根上下文注册的 `agent/request` 监听器位于瀑布外层，返回值最终落到
 *   `request/header.config.reasoningEffort`（`docs/research/2026-10-18-probe-followup.md` Q1）。
 * - 值必须被 provider 支持：错误 id 会让该步请求**硬失败**（`UNSUPPORTED_REASONING_EFFORT`），
 *   所以先用 `llm.resolveModelInfo` 探测（结果按 provider/model 缓存）。
 * - 改档 = 改请求头 = 该次前缀缓存失效：只在用户显式命令时改，不随压力/循环自适应改。
 * - 不调用 `sessionController.selectModel`（它会改用户全局默认模型）。
 *
 * @module omb/dsh/reasoning-effort
 */
import type { HostContextLike } from './host.js'
import { readService } from './host.js'
import type { FocusDepth, Kernel } from '../kernel/abi/index.js'
import { SERVICES } from '../kernel/abi/index.js'

/** 宿主 LLM 服务的最小结构面。 */
interface LlmLike {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts: readonly { id: string }[] } }>
}

interface RequestPayloadLike {
  readonly agent?: unknown
  readonly signal?: AbortSignal
}

/** 一次改写的留痕（状态面据此说"真实档位设成了什么"）。 */
export interface EffortApplication {
  readonly effort: string | null
  readonly reason: string | null
  readonly depth: FocusDepth
  readonly at: number
}

/** 状态面读取端口。 */
export interface EffortControlPort {
  last(sessionId: string): EffortApplication | undefined
}

function pickString(source: unknown, ...keys: readonly string[]): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function sessionIdOfAgent(agent: unknown): string | undefined {
  return pickString(agent, 'id') ?? pickString((agent as { session?: unknown } | undefined)?.session, 'id')
}

/** 档位 → effort；`standard` = undefined（继承，不改请求头）。 */
export function effortForDepth(depth: FocusDepth): 'low' | 'max' | undefined {
  return depth === 'quick' ? 'low' : depth === 'deep' ? 'max' : undefined
}

export function wireReasoningEffort(options: {
  readonly ctx: HostContextLike
  readonly kernel: Kernel
}): () => void {
  const { ctx, kernel } = options
  /** 只记显式档位；standard 会清掉记录（恢复继承）。 */
  const explicit = new Map<string, FocusDepth>()
  const applied = new Map<string, EffortApplication>()
  const capabilities = new Map<string, readonly string[] | null>()
  /**
   * 会话表有界（v4.3）：`explicit` 每会话一条、`capabilities` 每 provider/model 一条。
   * 不设上限时，长跑进程见过的每个会话都会永久留一条——与 `turnBySession` 同类。
   */
  const MAX_EXPLICIT_SESSIONS = 128
  const MAX_CAPABILITY_ENTRIES = 64
  const rememberExplicit = (sessionId: string, depth: FocusDepth): void => {
    explicit.delete(sessionId)
    explicit.set(sessionId, depth)
    while (explicit.size > MAX_EXPLICIT_SESSIONS) {
      const oldest = explicit.keys().next().value
      if (oldest === undefined) break
      explicit.delete(oldest)
    }
  }
  const rememberCapability = (key: string, value: readonly string[] | null): void => {
    capabilities.delete(key)
    capabilities.set(key, value)
    while (capabilities.size > MAX_CAPABILITY_ENTRIES) {
      const oldest = capabilities.keys().next().value
      if (oldest === undefined) break
      capabilities.delete(oldest)
    }
  }
  const llm = readService<LlmLike>(ctx, 'llm')
  let disposed = false

  const offFocus = kernel.on('focus/changed', payload => {
    if (disposed) return
    if (payload.depth === 'standard') explicit.delete(payload.sessionId)
    else rememberExplicit(payload.sessionId, payload.depth)
  })

  const record = (sessionId: string, entry: EffortApplication): void => {
    applied.set(sessionId, entry)
    while (applied.size > 128) {
      const oldest = applied.keys().next().value
      if (oldest === undefined) break
      applied.delete(oldest)
    }
  }

  const supportedEfforts = async (provider: string, model: string): Promise<readonly string[] | null> => {
    const key = `${provider}\u0000${model}`
    if (capabilities.has(key)) return capabilities.get(key) ?? null
    if (llm === undefined) {
      rememberCapability(key, null)
      return null
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info.reasoning?.efforts.map(effort => effort.id) ?? []
      const value = efforts.length === 0 ? null : efforts
      rememberCapability(key, value)
      return value
    } catch {
      rememberCapability(key, null)
      return null
    }
  }

  const handler = async (...args: unknown[]): Promise<unknown> => {
    const [payload, next] = args as [RequestPayloadLike | undefined, (() => Promise<Record<string, unknown>>) | undefined]
    if (typeof next !== 'function') return undefined
    const resolved = await next()
    if (disposed) return resolved
    const sessionId = sessionIdOfAgent(payload?.agent)
    if (sessionId === undefined) return resolved
    const depth = explicit.get(sessionId)
    // 回到 standard（或从未设过）：只清理**本模块自己写进去的** effort。
    // 用户/宿主自己选的 effort 不能在这里被清掉。
    if (depth === undefined) {
      if (applied.has(sessionId)) {
        const rest = { ...resolved }
        delete rest['reasoningEffort']
        record(sessionId, { effort: null, reason: null, depth: 'standard', at: kernel.clock.now() })
        return rest
      }
      return resolved
    }

    const provider = typeof resolved['provider'] === 'string' ? resolved['provider'] : ''
    const model = typeof resolved['model'] === 'string' ? resolved['model'] : ''
    if (provider.length === 0 || model.length === 0) return resolved

    const want = effortForDepth(depth)
    if (want === undefined) {
      if (applied.has(sessionId)) {
        const rest = { ...resolved }
        delete rest['reasoningEffort']
        record(sessionId, { effort: null, reason: null, depth, at: kernel.clock.now() })
        return rest
      }
      return resolved
    }

    const efforts = await supportedEfforts(provider, model)
    if (efforts === null || !efforts.includes(want)) {
      record(sessionId, {
        effort: null,
        reason: `provider ${provider}/${model} 不支持 reasoningEffort=${want}`,
        depth,
        at: kernel.clock.now(),
      })
      return resolved
    }
    if (resolved['reasoningEffort'] === want) {
      record(sessionId, { effort: want, reason: null, depth, at: kernel.clock.now() })
      return resolved
    }
    record(sessionId, { effort: want, reason: null, depth, at: kernel.clock.now() })
    return { ...resolved, reasoningEffort: want }
  }

  const offRequest = (() => {
    try {
      const returned = ctx.on?.('agent/request', handler as never)
      return typeof returned === 'function' ? returned as () => void : () => {}
    } catch (error) {
      kernel.logger.warn(`OMB：agent/request 订阅失败，档位不会改写真实推理预算——${String(error)}`)
      return () => {}
    }
  })()

  const offService = (() => {
    try {
      return kernel.provide<EffortControlPort>(SERVICES.effortControl, { last: sessionId => applied.get(sessionId) })
    } catch (error) {
      kernel.logger.warn(`OMB：effort-control 服务注册失败——${String(error)}`)
      return () => {}
    }
  })()

  return () => {
    if (disposed) return
    disposed = true
    for (const off of [offRequest, offFocus, offService]) {
      try {
        off()
      } catch {
        // H-1
      }
    }
  }
}

