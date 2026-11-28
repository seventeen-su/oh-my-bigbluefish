import type { Logger } from '../../ports/jobs.js'
import type { RuntimeContext } from '../../ports/context.js'

export interface HostContextLike {
  readonly get?: (name: string) => unknown
  readonly on?: (event: string, listener: (...args: never[]) => unknown, options?: unknown) => unknown
  readonly logger?: unknown
}

export interface HostToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: object
  readonly output: {
    readonly schema: object
    render(args: unknown, value: unknown): readonly { readonly type: 'text'; readonly text: string }[]
  }
  execute(args: unknown, exec: unknown): Promise<{ readonly ok: boolean; readonly text: string }>
}

export interface HostToolsLike {
  register(definition: HostToolDefinition): unknown
  /**
   * DSH `ToolsService.get(name)`：运行期自检用。老宿主/测试替身可能没有，
   * 调用方必须退回注册记录而不是把“查不到”当成“已注册”。
   */
  readonly get?: (name: string, scope?: unknown, toolSet?: unknown) => unknown
}

export interface HostSystemPromptLike {
  context?(...args: unknown[]): unknown
  section?(...args: unknown[]): unknown
  getContextOrder?(name: string): number
  getSectionOrder?(name: string): number
}

export type ToolContext = RuntimeContext

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function readService(ctx: HostContextLike | undefined, name: string): unknown {
  if (ctx === undefined || typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

export function methodOf(value: unknown, name: string): ((...args: never[]) => unknown) | undefined {
  const record = asRecord(value)
  const method = record?.[name]
  if (typeof method !== 'function') return undefined
  // 服务方法是原型上的普通方法，提取后直接调用会丢 `this`；DSH 的
  // `SystemPrompt.context/section`、`jobs.read` 等都依赖 `this`，所以统一绑定。
  return (method as (...args: never[]) => unknown).bind(value)
}

export function readTools(ctx: HostContextLike | undefined): HostToolsLike | undefined {
  const raw = readService(ctx, 'tools')
  return methodOf(raw, 'register') === undefined ? undefined : raw as HostToolsLike
}

export function readSystemPrompt(ctx: HostContextLike | undefined): HostSystemPromptLike | undefined {
  const raw = readService(ctx, 'systemPrompt')
  const usable = methodOf(raw, 'context') !== undefined || methodOf(raw, 'section') !== undefined
  return usable ? raw as HostSystemPromptLike : undefined
}

export function sessionFromExec(exec: unknown): ToolContext | undefined {
  const record = asRecord(exec)
  const agent = asRecord(record?.['agent'])
  const session = asRecord(agent?.['session'])
  const sessionId = typeof session?.['id'] === 'string' && session['id'].trim().length > 0
    ? session['id']
    : typeof agent?.['id'] === 'string' && agent['id'].trim().length > 0
      ? agent['id']
      : undefined
  if (sessionId === undefined) return undefined
  const header = asRecord(session?.['header'])
  const cwd = typeof header?.['cwd'] === 'string' && header['cwd'].trim().length > 0 ? header['cwd'] : undefined
  const agentPath = typeof agent?.['name'] === 'string' && agent['name'].trim().length > 0 ? agent['name'] : undefined
  // 工具调用的稳定身份（DSH ToolExecution.callId）：写路径用它合成重试复用的 commandId。
  const callId = typeof record?.['callId'] === 'string' && record['callId'].trim().length > 0
    ? record['callId']
    : undefined
  const turn = typeof record?.['turn'] === 'number' && Number.isSafeInteger(record['turn']) ? record['turn'] : undefined
  const step = typeof record?.['step'] === 'number' && Number.isSafeInteger(record['step']) ? record['step'] : undefined
  return {
    sessionId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(agentPath !== undefined ? { agentPath } : {}),
    ...(callId !== undefined ? { callId } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(step !== undefined ? { step } : {}),
  }
}

export function createLogger(ctx: HostContextLike | undefined): Logger {
  const raw = asRecord(ctx?.logger)
  const call = (level: string, message: string, details?: unknown): void => {
    const fn = raw?.[level]
    if (typeof fn !== 'function') return
    try {
      fn.call(raw, details === undefined ? `OMB v7：${message}` : `OMB v7：${message} ${JSON.stringify(details)}`)
    } catch {
      // 日志失败不影响业务。
    }
  }
  return {
    debug: (message, details) => call('debug', message, details),
    info: (message, details) => call('info', message, details),
    warn: (message, details) => call('warn', message, details),
    error: (message, details) => call('error', message, details),
  }
}

export interface PromptSink {
  readonly available: boolean
  readonly reason?: string
  write(sessionId: string, text: string): boolean
  dispose(): void
}

interface PromptSinkOptions {
  /** context 名；默认是 T0 的 `omb-v7:injection`。 */
  readonly name?: string
  /** 相对 `WEB_SURFACE` 的偏移；默认 5，检查点用 6 紧跟在 T0 后。 */
  readonly orderOffset?: number
  /** 可选运行时上下文被关闭时仍保留；检查点需要它。 */
  readonly required?: boolean
}

const MAX_SESSIONS = 256

export function createPromptSink(ctx: HostContextLike | undefined, options: PromptSinkOptions = {}): PromptSink {
  const service = readSystemPrompt(ctx)
  const context = methodOf(service, 'context')
  if (service === undefined || context === undefined) {
    return { available: false, reason: '宿主没有 systemPrompt.context', write: () => false, dispose: () => {} }
  }
  const name = options.name ?? 'omb-v7:injection'
  const offset = options.orderOffset ?? 5
  const texts = new Map<string, string>()
  let order = 210
  try {
    const getOrder = methodOf(service, 'getContextOrder') as ((name: string) => unknown) | undefined
    if (getOrder !== undefined) {
      const allocated = getOrder('WEB_SURFACE')
      if (typeof allocated === 'number' && Number.isFinite(allocated)) order = allocated + offset
    }
  } catch {
    // 顺序只影响提示位置，不影响正确性。
  }
  const provider = (assembleContext: unknown): string => {
    const agent = asRecord(asRecord(assembleContext)?.['agent'])
    const session = asRecord(agent?.['session'])
    const sessionId = typeof session?.['id'] === 'string' ? session['id'] : undefined
    return sessionId === undefined ? '' : texts.get(sessionId) ?? ''
  }
  let disposer: (() => void) | undefined
  try {
    const returned = (context as (arg: unknown) => unknown)({
      name,
      order,
      interpolate: false,
      ...(options.required === true ? { required: true } : {}),
      text: provider,
    })
    if (typeof returned === 'function') disposer = returned as () => void
  } catch (error) {
    return {
      available: false,
      reason: `systemPrompt.context 注册失败：${error instanceof Error ? error.message : String(error)}`,
      write: () => false,
      dispose: () => {},
    }
  }
  return {
    available: true,
    write(sessionId, text) {
      if (sessionId.trim().length === 0) return false
      texts.set(sessionId, text)
      while (texts.size > MAX_SESSIONS) {
        const oldest = texts.keys().next().value
        if (oldest === undefined) break
        texts.delete(oldest)
      }
      return true
    },
    dispose() {
      texts.clear()
      try {
        disposer?.()
      } catch {
        // 注销失败不扩散。
      }
    },
  }
}
