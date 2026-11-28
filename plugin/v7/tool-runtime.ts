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
import { evidenceForWrite } from '../../packages/v7/src/app/evidence.js'
import { err, ok, type Result } from '../../packages/v7/src/domain/errors.js'
import type { PatchEntityInput, WriteEntityInput } from '../../packages/v7/src/domain/entity.js'
import type { Entity } from '../../packages/v7/src/domain/entity.js'
import type { LinkInput } from '../../packages/v7/src/domain/link.js'
import type { Clock } from '../../packages/v7/src/ports/clock.js'
import type { RetractInput, SupersedeInput } from '../../packages/v7/src/domain/lifecycle.js'
import { LIFECYCLE_LABELS } from '../../packages/v7/src/domain/lifecycle.js'
import { formatPatch, formatWrite, resultError } from './messages.js'
import { toolCommandId } from './tool-command.js'

/** 生命周期事实行：旧事实可以看，但必须显示「已于某时被谁取代/被证伪」与有效期。 */
function lifecycleLines(entity: Entity): string[] {
  const window = entity.validFrom === undefined && entity.validTo === undefined
    ? ''
    : `；有效期 ${entity.validFrom ?? '未知'} ~ ${entity.validTo ?? '现在'}`
  const label = LIFECYCLE_LABELS[entity.lifecycle]
  let detail = ''
  if (entity.lifecycle === 'superseded') {
    detail = `${entity.supersededAt === undefined ? '' : `（${entity.supersededAt}）`}`
      + `${entity.supersededBy === undefined ? '' : `，取代者 ${entity.supersededBy}`}`
  } else if (entity.lifecycle === 'retracted') {
    detail = `${entity.retractedAt === undefined ? '' : `（${entity.retractedAt}）`}`
      + `${entity.retractedReason === undefined ? '' : `，原因 ${entity.retractedReason}`}`
  }
  return [`生命周期：${label}${detail}${window}`]
}

export interface ToolRuntimeDeps {
  readonly requireReady: () => Promise<Result<never> | undefined>
  readonly rememberService: RememberService
  readonly updateService: UpdateService
  readonly recallService: RecallService
  readonly store: PostgresStore
  readonly clock: Clock
  readonly status: () => Promise<Result<string>>
  /** 运行时上下文解析（组合根注入：稳定 projectId + 身份注册）。 */
  readonly resolveContext: (exec: unknown) => Promise<ToolContext | undefined>
}

export function createToolRuntime(deps: ToolRuntimeDeps): ToolRuntime {
  const { requireReady, rememberService, updateService, recallService, store, clock, status } = deps
  // 死信重放与 relay 共用同一个适配器实现（无状态、不额外建连接池）。
  const outbox = new PostgresOutboxStore(store.db)
  return {
    context: deps.resolveContext,
    async remember(input: WriteEntityInput, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        // 第一层幂等：同一工具调用（callId）重试复用同一 commandId；
        // 第二层内容幂等由写事务按 scope/category/关键属性/时间判定。
        const commandId = toolCommandId('omb_remember', context, input)
        const evidence = evidenceForWrite(input, {
          sessionId: context.sessionId,
          ...(context.callId !== undefined ? { callId: context.callId } : {}),
          tool: 'omb_remember',
          ...(input.origin !== undefined ? { origin: input.origin } : {}),
          now: clock.iso(),
        })
        const result = await rememberService.remember(input, {
          commandId,
          ...(evidence.length > 0 ? { evidence } : {}),
        })
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
    async update(input: PatchEntityInput, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        // 更新同样有稳定 commandId：工具重试不会重复 bump revision/写第二条审计。
        const result = await updateService.update(input, { commandId: toolCommandId('omb_update', context, input) })
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
    async supersede(input: SupersedeInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await store.supersede(input)
        if (result.alreadyApplied) {
          return ok(`已确认：${result.oldId} 早已被 ${result.newId} 取代（幂等，无新写入）`)
        }
        return ok([
          `已将 ${result.oldId} 标记为被 ${result.newId} 取代（生效 ${result.effectiveAt}）`,
          `旧条目退出普通召回、保留历史；${result.created ? '新条目已在同一事务创建；' : ''}link=${result.linkId} revision=${result.revision} audit=${result.auditId}`,
          '无需再 archive（取代不是归档）；撤销取代用 omb_admin rollback。',
        ].join('\n'))
      } catch (error) {
        return resultError(error)
      }
    },
    async retract(input: RetractInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await store.retract(input)
        if (result.alreadyApplied) return ok(`已确认：${result.id} 早已被证伪（幂等，无新写入）`)
        return ok([
          `已将 ${result.id} 标记为被证伪（retracted，生效 ${result.effectiveAt}）`,
          `它退出普通召回并保留历史；这不是取代，撤销用 omb_admin rollback（audit=${result.auditId}）。`,
        ].join('\n'))
      } catch (error) {
        return resultError(error)
      }
    },
    async history(id: string, limit: number): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const [entity, versions] = await Promise.all([
          store.get(id, { includeArchived: true }),
          store.history(id, limit),
        ])
        const lines: string[] = []
        if (entity !== undefined) lines.push(...lifecycleLines(entity))
        // 历史快照按版本列出；没有状态历史时也要给出生命周期事实，不能只说“暂无”。
        if (versions.length === 0) {
          lines.push(entity === undefined ? `实体 ${id} 不存在` : `状态机 ${id} 暂无历史版本`)
        } else {
          lines.push(...versions.map(version => `${version.id} rev=${version.revision} status=${version.status} time=${version.time}`))
        }
        return ok(lines.join('\n'))
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
        if (input.action === 'supersede') {
          if (input.targetId === undefined) return err({ code: 'invalid-input', message: 'supersede 需要 targetId（旧实体）' })
          if (input.newId === undefined) return err({ code: 'invalid-input', message: 'supersede 需要 newId（取代者）' })
          return this.supersede({
            oldId: input.targetId,
            newId: input.newId,
            reason: input.reason ?? 'superseded',
            actor: 'model',
            ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
          })
        }
        if (input.action === 'retract') {
          if (input.targetId === undefined) return err({ code: 'invalid-input', message: 'retract 需要 targetId' })
          return this.retract({
            id: input.targetId,
            reason: input.reason ?? 'retracted',
            actor: 'model',
            ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
          })
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
