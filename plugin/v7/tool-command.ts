import { createHash } from 'node:crypto'
import type { RuntimeContext } from '../../packages/v7/src/ports/context.js'

/**
 * 工具调用的稳定 commandId：同一调用（同一 callId）的重试/重投复用同一个键，
 * AttributeWriter 的 `audit_log.command_id` 唯一索引保证只生效一次。
 *
 * 为什么不是内容哈希：
 * - 内容哈希会把“用户在不同时间重复确认同一件事”误判成同一次调用；
 * - 内容级幂等由 writer 的 Content Idempotency 单独处理（scope/category/关键属性/时间）。
 *
 * 旧宿主/测试替身没有 callId 时退回“会话 + 参数规范哈希”：至少保证同一进程内同一参数
 * 的自动重试不重复写；真实 DSH 调用始终带 callId。
 */
export type IdempotentToolName = 'omb_remember' | 'omb_update'

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

const MAX_COMMAND_ID = 200

export function toolCommandId(
  tool: IdempotentToolName,
  context: Pick<RuntimeContext, 'sessionId' | 'callId'>,
  args: unknown,
): string {
  const prefix = `tool:${tool}:${context.sessionId}`
  const suffix = context.callId !== undefined && context.callId.trim().length > 0
    ? `call:${context.callId.trim()}`
    : `args:${createHash('sha256').update(canonical(args)).digest('hex').slice(0, 32)}`
  const commandId = `${prefix}:${suffix}`
  return commandId.length <= MAX_COMMAND_ID ? commandId : commandId.slice(0, MAX_COMMAND_ID)
}
