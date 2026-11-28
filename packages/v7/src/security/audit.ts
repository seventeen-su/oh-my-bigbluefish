import {
  auditTenantOf,
  sanitizeActorId,
  type AuditPrincipal,
} from '../domain/audit.js'
import type { ProjectIdentity } from '../domain/project-identity.js'

/**
 * 工具调用的审计身份派生（宿主上下文 → 服务端身份）。
 *
 * 7.2.4 之前工具调用用硬编码 `actor: 'model'`，且 `omb_remember` 直接接受调用方给的
 * `origin`：模型可以在参数里自称 `user`/`system` 提高写入者信任分，或在审计里留下
 * 假来源。这里把「谁在调用」完全绑定到宿主注入的 `ToolContext`：
 *
 * - actor id = `assistant:<sessionId>`：同一会话可追溯，跨会话不能冒充；
 * - actor kind = `assistant`：工具参数无法指定；
 * - source = `tool:<工具名>`：审计里明确记录是哪个能力入口授权的；
 * - tenant = 当前会话解析出的 projectId + 旧路径别名：供越权判定使用。
 *
 * 本模块是纯函数（不读库、不读环境），便于单测；越权审计落库在 plugin 运行时。
 */

export type ToolOperation =
  | 'omb_remember'
  | 'omb_update'
  | 'omb_link'
  | 'omb_history'
  | 'omb_recall'
  | 'omb_status'
  | 'omb_admin'

/** 只取派生所需的上下文字段，避免 security 反向依赖 DSH 适配器。 */
export interface ToolIdentityContext {
  readonly sessionId: string
  readonly projectKey?: string
  readonly projectIdentity?: Pick<ProjectIdentity, 'projectId' | 'legacyProjectKeys'>
}

/**
 * 工具参数里可以自称身份/来源的字段。它们不是业务字段：出现时只作为越权尝试记录，
 * 绝不进入审计 actor/source 或实体 origin。
 */
export const FORGED_ACTOR_FIELDS = ['origin', 'actor', 'actorKind', 'source', 'sourceType'] as const

/**
 * 从宿主上下文派生工具身份。
 *
 * `sessionId` 不可省略（工具定义在 context 解析失败时已返回 `missing-session`）；
 * 这里仍做一次规范化，保证空串/控制字符不会写出非法 actor。
 */
export function deriveToolPrincipal(context: ToolIdentityContext, operation: ToolOperation): AuditPrincipal {
  const sessionId = sanitizeActorId(context.sessionId, 'unknown')
  const tenant = auditTenantOf(context)
  return {
    actor: { id: `assistant:${sessionId}`, kind: 'assistant' },
    source: `tool:${operation}`,
    sessionId,
    ...(tenant === undefined ? {} : { tenant }),
  }
}

/** 工具参数里自称的来源；截断后只用于审计 `after.claimed`，不参与任何授权。 */
export function claimedProvenance(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed
}

/** 扫描参数对象里出现的伪造身份字段；返回第一个有值的字段名。 */
export function forgedActorFieldsIn(args: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const field of FORGED_ACTOR_FIELDS) {
    const value = args[field]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim().length === 0) continue
    found.push(field)
  }
  return found
}
