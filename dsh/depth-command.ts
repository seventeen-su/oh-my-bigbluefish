/**
 * `/omb-depth`：用户显式设置本会话推理深度。
 *
 * 为什么是**用户命令**而不是模型工具：v4 删除了 `omb_focus` 工具——档位是
 * "用户愿意为这次任务付多少思考 token"的决定，模型不应自己给自己加预算；
 * 同时用户命令是唯一不会被模型误触发的显式信号，正好满足 effort 映射
 * "只在显式改档/回合边界改请求头"的约束。
 *
 * 命令只写内核的 focus 表；真正改写 `reasoningEffort` 的是
 * `dsh/reasoning-effort.ts` 的根级 `agent/request` 监听器（能力探测后再设值）。
 *
 * @module omb/dsh/depth-command
 */
import type { HostContextLike } from './host.js'
import { readService } from './host.js'
import type { FocusDepth, Kernel, Logger } from '../kernel/abi/index.js'
import { FOCUS_DEPTHS } from '../kernel/abi/index.js'

interface CommandResultLike {
  readonly kind: 'success' | 'error'
  readonly text: string
}

interface CommandInvocationLike {
  readonly rawInput?: unknown
  readonly agent?: unknown
}

interface CommandsLike {
  register(definition: {
    readonly definitionId: string
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): unknown
}

/** 命令名（用户输入 `/omb-depth …`）。 */
export const DEPTH_COMMAND_NAME = 'omb-depth'
/** 定义 id：全局唯一即可。 */
export const DEPTH_COMMAND_ID = 'omb-kernel/depth'

function pickString(source: unknown, ...keys: readonly string[]): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 从命令 invocation 取会话 id（取不到就 null，不猜）。 */
export function sessionOfInvocation(invocation: CommandInvocationLike): string | null {
  const agent = invocation.agent
  return pickString(agent, 'id')
    ?? pickString((agent as { session?: unknown } | undefined)?.session, 'id')
    ?? null
}

/**
 * 注册 `/omb-depth`。
 *
 * @returns 幂等 disposer；宿主 commands 不可用时返回空 disposer（状态面会由
 *          `omb_status` 的推理段显示"档位命令未注册"）。
 */
export function registerDepthCommand(options: {
  readonly ctx: HostContextLike
  readonly kernel: Kernel
  readonly logger: Logger
}): () => void {
  const { ctx, kernel, logger } = options
  const commands = readService<CommandsLike>(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    logger.warn('OMB：宿主 commands 服务不可用——/omb-depth 未注册（推理深度仍可用默认档）')
    return () => {}
  }
  try {
    const returned = commands.register({
      definitionId: DEPTH_COMMAND_ID,
      name: DEPTH_COMMAND_NAME,
      description: '设置本会话的思考深度',
      input: { hint: '[quick | standard | deep]' },
      handler: invocation => {
        const sessionId = sessionOfInvocation(invocation)
        if (sessionId === null) {
          return { kind: 'error', text: '/omb-depth：拿不到当前会话标识，本次未改档' }
        }
        const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
        if (raw.length === 0) {
          return {
            kind: 'success',
            text: `当前推理深度：${kernel.focus(sessionId)}。用法 /omb-depth quick|standard|deep`,
          }
        }
        const depth = raw.toLowerCase() as FocusDepth
        if (!FOCUS_DEPTHS.includes(depth)) {
          return {
            kind: 'error',
            text: `/omb-depth：可用取值 ${FOCUS_DEPTHS.join(' / ')}，收到 ${JSON.stringify(raw)}；未改档`,
          }
        }
        try {
          kernel.setFocus(sessionId, depth, '用户命令 /omb-depth')
        } catch (error) {
          return {
            kind: 'error',
            text: `/omb-depth：写入档位失败——${error instanceof Error ? error.message : String(error)}`,
          }
        }
        const hint = depth === 'quick'
          ? '下一请求把 reasoningEffort 降到 low；改请求头会失效一次前缀缓存。'
          : depth === 'deep'
            ? '下一请求把 reasoningEffort 提到 max；改请求头会失效一次前缀缓存。'
            : '下一请求恢复继承宿主/用户的 effort。'
        return { kind: 'success', text: `已把本会话推理深度设为 ${depth}。${hint}` }
      },
    })
    return typeof returned === 'function' ? returned as () => void : () => {}
  } catch (error) {
    logger.warn(`OMB：/omb-depth 注册失败——${String(error)}`)
    return () => {}
  }
}
