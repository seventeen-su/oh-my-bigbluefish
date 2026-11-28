/**
 * 工具运行时（7 个 `omb_*` 工具的宿主端口）：就绪检查 + 调用例 + 结果格式化。
 *
 * 只做组合：`remember/update` 走用例服务，`link/history/admin/recall` 走 Store/RecallService；
 * 未就绪统一返回可重试的 `db-unavailable`，业务异常经 `resultError` 转成错误体，
 * 不把异常抛回宿主。状态探测（`status`）在 `status.ts`，这里只注入。
 *
 * 7.2.4 安全边界（本文件的职责）：
 * - actor/source 由宿主 `ToolContext` 派生（`assistant:<session>` + `tool:<能力>`），
 *   工具参数里的 `origin`/`actor` 只作为越权尝试记录，不参与授权或写入；
 * - 所有按 id 的写/回滚/归档/历史读取先证明目标实体属于当前租户（global 共享，
 *   project 必须命中同一 projectId/旧路径别名），跨项目一律 `forbidden`；
 * - 拒绝时写一条 `action='denied'` 的链式审计（`recordAudit`），不吞掉拒绝原因；
 * - 回滚除工具层预检外，适配器层还会按审计 target_ids 做一次 CAS 前校验（防 TOCTOU）。
 */
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import { PostgresOutboxStore } from '../../packages/v7/src/adapters/postgres/outbox.js'
import {
  listAuditWithinTenant,
  countDeniedWithinTenant,
  readAuditAccessRow,
  readAuthorizationTargets,
  readLinkEndpoints,
  rollbackFactsOf,
} from '../../packages/v7/src/adapters/postgres/writer-audit.js'
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
import {
  AUDIT_DENIED_ACTION,
  entityAccessDecision,
  rollbackAccessDecision,
  scopeAccessOf,
  type AuditDenyReason,
  type AuditPrincipal,
  type EntityScopeFact,
} from '../../packages/v7/src/domain/audit.js'
import { err, forbidden, notFound, ok, OmbFailure, type OmbError, type Result } from '../../packages/v7/src/domain/errors.js'
import type { Entity, PatchEntityInput, Scope, WriteEntityInput } from '../../packages/v7/src/domain/entity.js'
import type { JsonValue } from '../../packages/v7/src/domain/json.js'
import type { LinkInput } from '../../packages/v7/src/domain/link.js'
import type { Clock } from '../../packages/v7/src/ports/clock.js'
import type { RetractInput, SupersedeInput } from '../../packages/v7/src/domain/lifecycle.js'
import { LIFECYCLE_LABELS } from '../../packages/v7/src/domain/lifecycle.js'
import { deriveToolPrincipal, claimedProvenance, type ToolOperation } from '../../packages/v7/src/security/audit.js'
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

const DENY_REASON_TEXT: Readonly<Record<AuditDenyReason, string>> = {
  'cross-project': '目标实体不在当前项目作用域内',
  'unknown-tenant': '当前会话没有可证明的项目作用域',
  'unknown-target': '无法证明目标实体的归属作用域',
  'denied-audit': '越权拒绝记录不可回滚',
  'unverifiable-target': '审计没有可验证的目标实体',
}

/** 拒绝审计里的 operation 标签：与工具名分开，便于 sql 计数与排查。 */
type DenyOperation = 'remember' | 'update' | 'link' | 'unlink' | 'supersede' | 'retract'
  | 'archive' | 'unarchive' | 'rollback' | 'history' | 'replay'

/**
 * 越权拒绝：落一条链式审计（action='denied'），再返回可读错误体。
 *
 * 审计失败不能把业务拒绝改判成内部错误：拒绝本身已经生效，审计只做尽力而为；
 * 错误 details 里带 `auditId` 便于事后对账。
 */
async function denyWithAudit(
  store: PostgresStore,
  principal: AuditPrincipal,
  operation: DenyOperation,
  reason: AuditDenyReason | 'forged-actor',
  targetIds: readonly string[],
  claimed?: string,
): Promise<OmbError> {
  let auditId: number | undefined
  try {
    auditId = await store.recordAudit({
      actor: principal.actor.id,
      actorKind: principal.actor.kind,
      source: principal.source,
      action: AUDIT_DENIED_ACTION,
      targetIds: [...targetIds],
      after: {
        operation,
        reason,
        sessionId: principal.sessionId,
        tenantProjectKey: principal.tenant?.projectKey ?? '',
        ...(claimed === undefined ? {} : { claimed }),
      } as JsonValue,
    })
  } catch {
    // 业务拒绝优先：审计降级只体现在 details.auditId 缺失。
  }
  const message = reason === 'forged-actor'
    ? `越权操作被拒绝：工具参数不能声明 actor/source（已忽略 ${claimed ?? '未知值'} 并记审计）`
    : `越权操作被拒绝：${DENY_REASON_TEXT[reason]}`
  return forbidden(message, {
    operation,
    reason,
    targetIds: [...targetIds],
    ...(claimed === undefined ? {} : { claimed }),
    ...(auditId === undefined ? {} : { auditId }),
  })
}

/**
 * 实体写/读前的租户校验：
 * - 查不到作用域 → 按“实体不存在”返回（与 7.1 行为一致，也避免把越权探测伪装成 not-found）；
 * - 项目外 → 记拒绝审计 + forbidden。
 */
async function requireEntityAccess(
  store: PostgresStore,
  principal: AuditPrincipal,
  operation: DenyOperation,
  ids: readonly string[],
): Promise<OmbError | undefined> {
  const targets = await readAuthorizationTargets(store.db, ids)
  const missing = targets.filter(target => target.scope === undefined).map(target => target.id)
  if (missing.length > 0) return notFound(`实体不存在：${missing.join(', ')}`)
  const decision = entityAccessDecision(principal.tenant, targets)
  if (decision.allowed) return undefined
  return denyWithAudit(store, principal, operation, decision.reason, decision.targetIds)
}

/** 伪造 actor/source 的兜底：覆盖为宿主派生值，并把被忽略的声明记进审计。 */
async function recordForgedProvenance(
  store: PostgresStore,
  principal: AuditPrincipal,
  operation: DenyOperation,
  claimed: unknown,
  targetIds: readonly string[] = [],
): Promise<void> {
  const value = claimedProvenance(claimed)
  if (value === undefined) return
  await denyWithAudit(store, principal, operation, 'forged-actor', targetIds, value)
}

/** 写入 scope 也不能由调用方越过租户：global 共享，project 必须命中当前 projectId。 */
async function requireWriteScope(
  store: PostgresStore,
  principal: AuditPrincipal,
  operation: DenyOperation,
  scope: Scope,
): Promise<OmbError | undefined> {
  if (scopeAccessOf(scope, principal.tenant) !== 'foreign') return undefined
  return denyWithAudit(
    store,
    principal,
    operation,
    principal.tenant === undefined ? 'unknown-tenant' : 'cross-project',
    [],
  )
}

const ENTITY_ID_PATTERN = /^(?:mem|st|sv|ch)_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** 从 outbox 事件载荷里收集实体 id（递归、有深度上限；只认稳定 id 前缀）。 */
function entityIdsInPayload(value: JsonValue | undefined, out: Set<string>, depth = 0): void {
  if (value === undefined || value === null || depth > 8) return
  if (typeof value === 'string') {
    if (ENTITY_ID_PATTERN.test(value)) out.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) entityIdsInPayload(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) entityIdsInPayload(item as JsonValue, out, depth + 1)
  }
}

/**
 * `omb_admin replay` 的租户校验：只允许重放“载荷里的实体都可见”的 dead 行。
 *
 * 重放会触发嵌入/依赖/链接等反应，可能跨项目产生副作用；管理面不能靠
 * “outbox 是系统表”就绕过租户边界。找不到任何实体 id 的载荷按不可验证拒绝。
 */
async function requireReplayAccess(
  store: PostgresStore,
  principal: AuditPrincipal,
  input: AdminToolArgs,
): Promise<OmbError | undefined> {
  if (input.outboxId === undefined && input.topic === undefined) return undefined
  const limit = Math.min(input.limit ?? 20, 100)
  const rows = await store.db.query<{ payload: JsonValue }>(
    `select payload from omb.outbox
      where status = 'dead'
        and ($1::bigint is null or id = $1)
        and ($2::text is null or topic = $2)
      order by id asc
      limit $3`,
    [input.outboxId ?? null, input.topic ?? null, limit],
  )
  if (rows.rows.length === 0) return undefined
  const entityIds = new Set<string>()
  for (const row of rows.rows) entityIdsInPayload(row.payload, entityIds)
  if (entityIds.size === 0) {
    return denyWithAudit(store, principal, 'replay', 'unverifiable-target', [])
  }
  return requireEntityAccess(store, principal, 'replay', [...entityIds])
}

/**
 * 回滚前预检：审计事实 + target 作用域 → 是否允许。
 *
 * 适配器层（writer-rollback）在事务内会再校验一次；这里先给出可读拒绝并记审计，
 * 避免跨项目回滚触碰任何业务行。
 */
async function requireRollbackAccess(
  store: PostgresStore,
  principal: AuditPrincipal,
  auditId: number,
): Promise<OmbError | undefined> {
  const row = await readAuditAccessRow(store.db, auditId)
  if (row === undefined) return notFound(`审计记录不存在：${auditId}`)
  const facts = rollbackFactsOf(row)
  const targets: readonly EntityScopeFact[] = await readAuthorizationTargets(store.db, facts.targetIds)
  const decision = rollbackAccessDecision({ facts, targets, tenant: principal.tenant })
  if (decision.allowed) return undefined
  return denyWithAudit(store, principal, 'rollback', decision.reason, decision.targetIds)
}

interface DeniedGuard {
  readonly denied?: OmbError
}

function deniedOf(error: OmbError | undefined): DeniedGuard {
  return error === undefined ? {} : { denied: error }
}

export function createToolRuntime(deps: ToolRuntimeDeps): ToolRuntime {
  const { requireReady, rememberService, updateService, recallService, store, clock, status } = deps
  // 死信重放与 relay 共用同一个适配器实现（无状态、不额外建连接池）。
  const outbox = new PostgresOutboxStore(store.db)

  const principalOf = (context: ToolContext, operation: ToolOperation): AuditPrincipal =>
    deriveToolPrincipal(context, operation)

  return {
    context: deps.resolveContext,
    async remember(input: WriteEntityInput, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const principal = principalOf(context, 'omb_remember')
        // 工具参数里的 origin 一律覆盖：伪造声明只记审计，不参与 actor/source/实体 origin。
        const { origin: claimedOrigin, ...rest } = input
        await recordForgedProvenance(store, principal, 'remember', claimedOrigin)
        const scopeDenied = await requireWriteScope(store, principal, 'remember', rest.scope)
        if (scopeDenied !== undefined) return err(scopeDenied)
        // 第一层幂等：同一工具调用（callId）重试复用同一 commandId；
        // 第二层内容幂等由写事务按 scope/category/关键属性/时间判定。
        const commandId = toolCommandId('omb_remember', context, rest)
        const evidence = evidenceForWrite(rest, {
          sessionId: context.sessionId,
          ...(context.callId !== undefined ? { callId: context.callId } : {}),
          tool: 'omb_remember',
          now: clock.iso(),
        })
        const result = await rememberService.remember(rest, {
          commandId,
          ...(evidence.length > 0 ? { evidence } : {}),
          actor: principal.actor.id,
          source: principal.source,
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
        const principal = principalOf(context, 'omb_update')
        const { origin: claimedOrigin, ...rest } = input
        await recordForgedProvenance(store, principal, 'update', claimedOrigin, [rest.id])
        const access = deniedOf(await requireEntityAccess(store, principal, 'update', [rest.id]))
        if (access.denied !== undefined) return err(access.denied)
        // 更新同样有稳定 commandId：工具重试不会重复 bump revision/写第二条审计。
        const result = await updateService.update(rest, {
          commandId: toolCommandId('omb_update', context, rest),
          actor: principal.actor.id,
          source: principal.source,
        })
        return result.ok ? ok(formatPatch(result)) : result
      } catch (error) {
        return resultError(error)
      }
    },
    async link(input: LinkInput, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const principal = principalOf(context, 'omb_link')
        const access = deniedOf(await requireEntityAccess(store, principal, 'link', [input.fromId, input.toId]))
        if (access.denied !== undefined) return err(access.denied)
        const result = await store.link({
          ...input,
          origin: principal.actor.id,
          source: principal.source,
        })
        return ok(`${result.created ? '已建立' : '已存在'}链接 ${result.link.fromId} -[${result.link.relation}]-> ${result.link.toId}`)
      } catch (error) {
        return resultError(error)
      }
    },
    async unlink(id: string, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const principal = principalOf(context, 'omb_link')
        // 链接不存在时保持旧的 no-op 语义；存在时必须两端都能证明归属。
        const endpoints = await readLinkEndpoints(store.db, id)
        if (endpoints !== undefined) {
          const access = deniedOf(await requireEntityAccess(
            store,
            principal,
            'unlink',
            [endpoints.fromId, endpoints.toId],
          ))
          if (access.denied !== undefined) return err(access.denied)
        }
        await store.unlink(id, principal.actor.id, principal.source)
        return ok(`已归档链接 ${id}`)
      } catch (error) {
        return resultError(error)
      }
    },
    async supersede(
      input: Omit<SupersedeInput, 'actor' | 'source'>,
      context: ToolContext,
      operation: 'omb_link' | 'omb_admin' = 'omb_admin',
    ): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const principal = principalOf(context, operation)
        const ids = input.create === undefined ? [input.oldId, input.newId] : [input.oldId]
        const access = deniedOf(await requireEntityAccess(store, principal, 'supersede', ids))
        if (access.denied !== undefined) return err(access.denied)
        const result = await store.supersede({
          ...input,
          actor: principal.actor.id,
          source: principal.source,
        })
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
    async retract(
      input: Omit<RetractInput, 'actor' | 'source'>,
      context: ToolContext,
    ): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const principal = principalOf(context, 'omb_admin')
        const access = deniedOf(await requireEntityAccess(store, principal, 'retract', [input.id]))
        if (access.denied !== undefined) return err(access.denied)
        const result = await store.retract({
          ...input,
          actor: principal.actor.id,
          source: principal.source,
        })
        if (result.alreadyApplied) return ok(`已确认：${result.id} 早已被证伪（幂等，无新写入）`)
        return ok([
          `已将 ${result.id} 标记为被证伪（retracted，生效 ${result.effectiveAt}）`,
          `它退出普通召回并保留历史；这不是取代，撤销用 omb_admin rollback（audit=${result.auditId}）。`,
        ].join('\n'))
      } catch (error) {
        return resultError(error)
      }
    },
    async history(id: string, limit: number, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const principal = principalOf(context, 'omb_history')
        const access = deniedOf(await requireEntityAccess(store, principal, 'history', [id]))
        if (access.denied !== undefined) return err(access.denied)
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
    async admin(input: AdminToolArgs, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const principal = principalOf(context, 'omb_admin')
        if (input.action === 'audit') {
          const limit = input.limit ?? 20
          const [rows, deniedCount] = await Promise.all([
            listAuditWithinTenant(store.db, {
              limit,
              actor: principal.actor.id,
              ...(principal.tenant === undefined ? {} : { tenant: principal.tenant }),
            }),
            countDeniedWithinTenant(store.db, principal.tenant),
          ])
          if (rows.length === 0) return ok(`暂无审计记录（越权拒绝累计 ${deniedCount} 条）`)
          return ok([
            `审计记录 ${rows.length} 条（越权拒绝累计 ${deniedCount} 条；只展示当前项目/global 目标）`,
            ...rows.map(row => (
              `${row.id} ${row.action} by=${row.actor} kind=${row.actorKind ?? 'unknown'} source=${row.source ?? 'unknown'}` +
              ` at=${row.createdAt} rolled=${row.rolledBackAt ?? 'no'}`
            )),
          ].join('\n'))
        }
        if (input.action === 'archive' || input.action === 'unarchive') {
          if (input.targetId === undefined) return err({ code: 'invalid-input', message: `${input.action} 需要 targetId` })
          const operation: DenyOperation = input.action === 'archive' ? 'archive' : 'unarchive'
          const access = deniedOf(await requireEntityAccess(store, principal, operation, [input.targetId]))
          if (access.denied !== undefined) return err(access.denied)
          if (input.action === 'archive') {
            await store.archive(input.targetId, input.reason ?? 'manual', principal.actor.id, undefined, {
              source: principal.source,
            })
          } else {
            await store.unarchive(input.targetId, input.reason ?? 'manual', principal.actor.id, undefined, {
              source: principal.source,
            })
          }
          return ok(`${input.action === 'archive' ? '已归档' : '已取消归档'} ${input.targetId}`)
        }
        if (input.action === 'supersede') {
          if (input.targetId === undefined) return err({ code: 'invalid-input', message: 'supersede 需要 targetId（旧实体）' })
          if (input.newId === undefined) return err({ code: 'invalid-input', message: 'supersede 需要 newId（取代者）' })
          return this.supersede({
            oldId: input.targetId,
            newId: input.newId,
            reason: input.reason ?? 'superseded',
            ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
          }, context)
        }
        if (input.action === 'retract') {
          if (input.targetId === undefined) return err({ code: 'invalid-input', message: 'retract 需要 targetId' })
          return this.retract({
            id: input.targetId,
            reason: input.reason ?? 'retracted',
            ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
          }, context)
        }
        if (input.action === 'replay') {
          // 两个筛选条件二选一：都缺省会变成“重放全部 dead”，不能靠默认值猜用户意图。
          if ((input.outboxId === undefined) === (input.topic === undefined)) {
            return err({ code: 'invalid-input', message: 'replay 需要 outboxId 或 topic 二选一' })
          }
          const replayDenied = deniedOf(await requireReplayAccess(store, principal, input))
          if (replayDenied.denied !== undefined) return err(replayDenied.denied)
          const limit = input.limit ?? 20
          // outbox-replay 审计由适配器写（actor 来自这里派生的 assistant:<session>）。
          const result = await outbox.replayDead({
            ...(input.outboxId !== undefined ? { id: input.outboxId } : {}),
            ...(input.topic !== undefined ? { topic: input.topic } : {}),
            limit,
            actor: principal.actor.id,
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
        const rollbackDenied = deniedOf(await requireRollbackAccess(store, principal, input.auditId))
        if (rollbackDenied.denied !== undefined) return err(rollbackDenied.denied)
        try {
          const result = await store.rollback(input.auditId, principal.actor.id, {
            source: principal.source,
            ...(principal.tenant === undefined ? {} : { tenant: principal.tenant }),
          })
          return ok(`已回滚审计 ${result.auditId}；新审计 ${result.rollbackAuditId}；动作 ${result.applied.join(', ')}`)
        } catch (error) {
          // 适配器层复查（TOCTOU）也会拒绝：同样落拒绝审计，不把 forbidden 吞成 internal。
          if (error instanceof OmbFailure && error.error.code === 'forbidden') {
            const details = error.error.details
            const reason = typeof details === 'object' && details !== null && 'reason' in details
              ? (details as { reason?: AuditDenyReason }).reason
              : undefined
            const audited = await denyWithAudit(
              store,
              principal,
              'rollback',
              reason ?? 'cross-project',
              [],
            )
            return err(audited)
          }
          throw error
        }
      } catch (error) {
        return resultError(error)
      }
    },
  }
}
