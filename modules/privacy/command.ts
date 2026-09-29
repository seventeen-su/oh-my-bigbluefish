/**
 * `/omb-privacy` 命令：解析、执行、渲染（纯逻辑 + 一个不抛的端口）。
 *
 * ## 为什么是命令而不是工具
 *
 * 隐私模式是**用户**的决定。做成模型可调用的工具，等于让模型能自己解除对自己的
 * 限制（"这条记忆很有价值，我先把 sealed 关掉"）——那不是隐私，是自证。
 * 宿主已有正式的斜杠命令机制，用户手打、用户负责。
 *
 * ## 命令语法
 *
 * ```
 * /omb-privacy              显示当前会话的模式（与 status 同）
 * /omb-privacy status       显示当前会话 + 状态文件 + 拒绝计数
 * /omb-privacy normal       本会话可读可写
 * /omb-privacy read-only    本会话可读不可写
 * /omb-privacy sealed       本会话不可读不可写
 * /omb-privacy trust        清除 fail-closed 粘性标记（**只有人能按**）
 * ```
 *
 * `trust` 的存在理由：状态文件损坏后基线被钉成最严（见 `codec.ts`），
 * 若没有任何解除途径，用户会在修好文件后仍然被最严档位锁住——那会让人绕过整个
 * 机制（直接删文件），比给一个显式的、可审计的解除动作更糟。
 *
 * ## 会话身份从哪来
 *
 * `CommandInvocation.agent`（宿主 `packages/interaction/commands/src/index.ts:41`）：
 * `agent.id` 是会话 id，`agent.session.header.{parentSession,delegationDepth}` 是子代理血统
 * （宿主 `packages/core/session/src/types.ts:101/107/123`）。本文件只做**结构投影**，
 * 与本仓库 `dsh/tools.ts` 对 `exec.agent` 的投影同源；投影不出来就如实说
 * "拿不到会话"，绝不用"最近一个会话"顶替。
 */

/** 与宿主 `CommandResult` 结构一致（本仓库解析不到 `@deepseek-ai/*`，故只认形状）。 */
export interface CommandResultLike {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** 与宿主 `CommandInvocation` 的**最小**结构面。 */
export interface CommandInvocationLike {
  readonly rawInput?: unknown
  readonly agent?: unknown
  readonly signal?: unknown
  readonly commandId?: unknown
}

/** 命令名（用户输入 `/omb-privacy …`）。 */
export const PRIVACY_COMMAND_NAME = 'omb-privacy'
/** 定义 id：全局唯一即可。用 `@omb/privacy` 与组件包名一致，便于排查。 */
export const PRIVACY_COMMAND_ID = '@omb/privacy'

export const PRIVACY_USAGE =
  '用法：/omb-privacy [status | normal | read-only | sealed | trust]'
  + '（不带参数 = status；只影响当前会话，子代理继承；trust 只清除 fail-closed 兜底标记）'

export interface InvocationSession {
  readonly sessionId: string | null
  readonly parentSessionId: string | null
  readonly delegationDepth: number | null
}

function pickString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** 从命令 invocation 里取会话身份（取不到就是 null，不猜）。 */
export function sessionOfInvocation(invocation: CommandInvocationLike): InvocationSession {
  const agent = invocation.agent
  const session = (agent as { session?: unknown } | undefined)?.session
  const header = (session as { header?: unknown } | undefined)?.header
  const sessionId = pickString(agent, 'id') ?? pickString(header, 'id') ?? null
  const parentSessionId = pickString(header, 'parentSession') ?? null
  const rawDepth = (header as { delegationDepth?: unknown } | undefined)?.delegationDepth
  const delegationDepth = typeof rawDepth === 'number' && Number.isInteger(rawDepth) && rawDepth >= 0
    ? rawDepth
    : null
  return { sessionId, parentSessionId, delegationDepth }
}

/** 命令处理要用到的那部分能力（由模块 `apply` 注入；**每个方法都不抛**）。 */
export interface PrivacyCommandApi {
  /** 状态文本（当前会话 + 文件 + 计数）。 */
  statusText(sessionId: string | null): string
  /** 设置某会话的模式（会尝试持久化，失败时如实说明"未持久化"）。 */
  setMode(sessionId: string, mode: 'normal' | 'read-only' | 'sealed'): CommandResultLike
  /** 清除 fail-closed 粘性标记（显式的人类动作）。 */
  trust(): CommandResultLike
}

/** 命令名 → 是否本命令（宿主按 name 注册，这里只用于自检与测试）。 */
export function isPrivacyCommandName(name: string): boolean {
  return name === PRIVACY_COMMAND_NAME
}

/**
 * 执行命令。**纯逻辑**：所有副作用都经 `api`，因此可以零宿主测试。
 *
 * **绝不抛**：任何输入都得到一条 `CommandResult`。
 */
export function runPrivacyCommand(
  rawInput: string,
  session: InvocationSession,
  api: PrivacyCommandApi,
): CommandResultLike {
  const words = rawInput.trim().split(/\s+/).filter(word => word.length > 0)
  const head = (words[0] ?? 'status').toLowerCase()

  try {
    switch (head) {
      case 'status':
      case '':
        return { kind: 'success', text: api.statusText(session.sessionId) }

      case 'normal':
      case 'read-only':
      case 'readonly':
      case 'ro':
      case 'sealed': {
        if (session.sessionId === null) {
          return {
            kind: 'error',
            text: '拿不到本次命令所属的会话（宿主未提供 invocation.agent）：'
              + '无法按会话设置隐私模式。请在新会话里重试，或用 /omb-privacy status 查看。',
          }
        }
        const mode = head === 'sealed' ? 'sealed' : head === 'normal' ? 'normal' : 'read-only'
        return api.setMode(session.sessionId, mode)
      }

      case 'trust':
        return api.trust()

      case 'help':
      case '?':
        return { kind: 'success', text: PRIVACY_USAGE }

      default:
        return { kind: 'error', text: `不认识的参数「${words[0] ?? ''}」。${PRIVACY_USAGE}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `隐私命令执行失败：${message}` }
  }
}
