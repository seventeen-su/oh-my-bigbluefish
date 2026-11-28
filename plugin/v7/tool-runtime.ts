/**
 * 工具运行时（7 个 `omb_*` 工具的宿主端口）：就绪检查 + 调用例 + 结果格式化。
 *
 * 只做组合：`remember/update` 走用例服务，`link/history/admin/recall` 走 Store/RecallService；
 * 未就绪统一返回可重试的 `db-unavailable`，业务异常经 `resultError` 转成错误体，
 * 不把异常抛回宿主。状态探测（`status`）在 `status.ts`，这里只注入。
 */
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import { PostgresOutboxStore } from '../../packages/v7/src/adapters/postgres/outbox.js'
import type {
  AdminToolArgs,
  RecallToolArgs,
  ToolRuntime,
} from '../../packages/v7/src/adapters/dsh/tools.js'
import type { ToolContext } from '../../packages/v7/src/adapters/dsh/host.js'
import type { RecallService } from '../../packages/v7/src/app/recall.js'
import type { RememberService } from '../../packages/v7/src/app/remember.js'
import type { UpdateService } from '../../packages/v7/src/app/update.js'
import { err, ok, type Result } from '../../packages/v7/src/domain/errors.js'
import type { PatchEntityInput, WriteEntityInput } from '../../packages/v7/src/domain/entity.js'
import type { LinkInput } from '../../packages/v7/src/domain/link.js'
import { formatPatch, formatWrite, resultError } from './messages.js'

export interface ToolRuntimeDeps {
  readonly requireReady: () => Promise<Result<never> | undefined>
  readonly rememberService: RememberService
  readonly updateService: UpdateService
  readonly recallService: RecallService
  readonly store: PostgresStore
  readonly status: () => Promise<Result<string>>
  /** 运行时上下文解析（组合根注入：稳定 projectId + 身份注册）。 */
  readonly resolveContext: (exec: unknown) => Promise<ToolContext | undefined>
}

export function createToolRuntime(deps: ToolRuntimeDeps): ToolRuntime {
  const { requireReady, rememberService, updateService, recallService, store, status } = deps
  // 死信重放与 relay 共用同一个适配器实现（无状态、不额外建连接池）。
  const outbox = new PostgresOutboxStore(store.db)
  return {
    context: deps.resolveContext,
    async remember(input: WriteEntityInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await rememberService.remember(input)
        return result.ok ? ok(formatWrite(result)) : result
      } catch (error) {
        return resultError(error)
      }
    },
    async recall(input: RecallToolArgs, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      return recallService.recall(input, context)
    },
    async update(input: PatchEntityInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await updateService.update(input)
        return result.ok ? ok(formatPatch(result)) : result
      } catch (error) {
        return resultError(error)
      }
    },
    async link(input: LinkInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await store.link(input)
        return ok(`${result.created ? '已建立' : '已存在'}链接 ${result.link.fromId} -[${result.link.relation}]-> ${result.link.toId}`)
      } catch (error) {
        return resultError(error)
      }
    },
    async unlink(id: string): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        await store.unlink(id, 'model')
        return ok(`已归档链接 ${id}`)
      } catch (error) {
        return resultError(error)
      }
    },
    async history(id: string, limit: number): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const versions = await store.history(id, limit)
        if (versions.length === 0) return ok(`状态机 ${id} 暂无历史版本`)
        return ok(versions.map(version => `${version.id} rev=${version.revision} status=${version.status} time=${version.time}`).join('\n'))
      } catch (error) {
        return resultError(error)
      }
    },
    status,
    async admin(input: AdminToolArgs): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        if (input.action === 'audit') {
          const rows = await store.listAudit(input.limit ?? 20)
          if (rows.length === 0) return ok('暂无审计记录')
          return ok(rows.map(row => (
            `${row.id} ${row.action} by=${row.actor} kind=${row.actorKind ?? 'unknown'} source=${row.source ?? 'unknown'}` +
            ` at=${row.createdAt} rolled=${row.rolledBackAt ?? 'no'}`
          )).join('\n'))
        }
        if (input.action === 'archive' || input.action === 'unarchive') {
          if (input.targetId === undefined) return err({ code: 'invalid-input', message: `${input.action} 需要 targetId` })
          if (input.action === 'archive') await store.archive(input.targetId, input.reason ?? 'manual', 'model')
          else await store.unarchive(input.targetId, input.reason ?? 'manual', 'model')
          return ok(`${input.action === 'archive' ? '已归档' : '已取消归档'} ${input.targetId}`)
        }
        if (input.action === 'replay') {
          // 两个筛选条件二选一：都缺省会变成“重放全部 dead”，不能靠默认值猜用户意图。
          if ((input.outboxId === undefined) === (input.topic === undefined)) {
            return err({ code: 'invalid-input', message: 'replay 需要 outboxId 或 topic 二选一' })
          }
          const limit = input.limit ?? 20
          const result = await outbox.replayDead({
            ...(input.outboxId !== undefined ? { id: input.outboxId } : {}),
            ...(input.topic !== undefined ? { topic: input.topic } : {}),
            limit,
            actor: 'model',
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
          if (result.replayed.length === 0) {
            return ok('没有匹配的 dead outbox 行（已重放、topic/outboxId 不匹配或已被其它 worker 处理）')
          }
          const rows = result.replayed.map(row => (
            `${row.id} ${row.topic} attempts=${row.attempts} lastError=${row.lastError.length > 0 ? row.lastError : 'none'}`
          ))
          const remaining = result.remaining > 0
            ? [`剩余 ${result.remaining} 行 dead 未重放（本次 limit=${limit}），可再次 replay`]
            : []
          return ok([
            `已重放 ${result.replayed.length} 行 dead → pending（attempts/available_at 已重置）`,
            ...rows,
            ...remaining,
          ].join('\n'))
        }
        if (input.auditId === undefined) return err({ code: 'invalid-input', message: 'rollback 需要 auditId' })
        const result = await store.rollback(input.auditId, 'model')
        return ok(`已回滚审计 ${result.auditId}；新审计 ${result.rollbackAuditId}；动作 ${result.applied.join(', ')}`)
      } catch (error) {
        return resultError(error)
      }
    },
  }
}
