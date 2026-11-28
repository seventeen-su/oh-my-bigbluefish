import type {
  Entity,
  PatchEntityInput,
  StateVersion,
  WriteEntityInput,
} from '../../domain/entity.js'
import type { OmbError } from '../../domain/errors.js'
import type { EvidenceInput } from '../../domain/evidence.js'
import { isPlainObject, type JsonValue } from '../../domain/json.js'
import type { Link, LinkInput } from '../../domain/link.js'
import type { NormalizedWrite } from '../../domain/validation.js'

/**
 * CommandBus / AttributeWriter 的契约（ARCHITECTURE-PLAN §4.1、ADR-0007）。
 *
 * 分层约定：本模块只依赖 domain + ports；`AttributeWriter` 在 adapters/postgres 实现
 * `CommandWriter`，命令的合并/校验等纯逻辑留在 app 层，事务与 SQL 留在适配器。
 */

type ActorKind = 'user' | 'model' | 'job' | 'system' | 'external'

interface Actor {
  readonly id: string
  readonly kind: ActorKind
}

const ACTOR_KINDS: readonly ActorKind[] = ['user', 'model', 'job', 'system', 'external']

export interface CommandMeta {
  /** 幂等键：同一 commandId 只生效一次，重复提交返回首次结果（audit_log.command_id unique）。 */
  readonly commandId: string
  readonly actor: Actor
  /** 来源，如 `model`、`job:extract`、`user`。 */
  readonly origin: string
  readonly correlationId: string
  readonly causationId?: string
  /** 更新/归档/链接端点的乐观锁版本；不匹配返回 conflict + currentRevision。 */
  readonly expectedRevision?: number
  /** 命令截止时间（epoch ms）。 */
  readonly deadline?: number
  /**
   * 本次写入附带的证据：写事务内落 `omb.evidence`；内容去重复用原实体时并入原实体证据集。
   * contentHash 由 writer 按内容指纹补齐，调用方只给来源/主题。
   */
  readonly evidence?: readonly EvidenceInput[]
}

export type DomainEventType =
  | 'EntityCreated'
  | 'EntityPatched'
  | 'EntityArchived'
  | 'EntityUnarchived'
  | 'LinkCreated'
  | 'LinkUnlinked'
  | 'AttributeRenamed'
  /** 内容去重复用原实体时，新证据并入证据集（实体本身未变，revision 不 bump）。 */
  | 'EvidenceAdded'

/** 域事件；`id` 就是 audit_log.id（event_id 稳定，重放不会变）。 */
export interface DomainEvent {
  readonly id: string
  readonly seq: number
  readonly streamId: string
  readonly streamVersion: number
  readonly type: DomainEventType
  readonly actor: Actor
  readonly origin: string
  readonly occurredAt: string
  readonly payload: JsonValue
  readonly inverse?: JsonValue
}

export interface ProjectionToken {
  readonly entityId: string
  readonly revision: number
  readonly watermark: string
}

export interface CommandResult {
  readonly ok: true
  readonly events: readonly DomainEvent[]
  readonly revision: number
  readonly projectionToken: ProjectionToken
}

export type CommandExecution =
  | { readonly ok: true; readonly value: CommandResult }
  | { readonly ok: false; readonly error: OmbError & { readonly currentRevision?: number } }

export type Command =
  | { readonly type: 'CreateEntity'; readonly input: WriteEntityInput }
  | { readonly type: 'PatchEntity'; readonly input: PatchEntityInput }
  | { readonly type: 'ArchiveEntity'; readonly id: string; readonly reason: string }
  | { readonly type: 'UnarchiveEntity'; readonly id: string; readonly reason: string }
  | { readonly type: 'Link'; readonly input: LinkInput }
  | { readonly type: 'Unlink'; readonly linkId: string }
  | { readonly type: 'RenameAttribute'; readonly from: string; readonly to: string; readonly reason: string }

/** CommandBus 校验/归一化之后交给 AttributeWriter 的写操作。 */
export type PreparedCommand =
  | { readonly type: 'CreateEntity'; readonly input: NormalizedWrite }
  | { readonly type: 'PatchEntity'; readonly input: NormalizedWrite; readonly patch: PatchEntityInput }
  | { readonly type: 'ArchiveEntity'; readonly id: string; readonly reason: string }
  | { readonly type: 'UnarchiveEntity'; readonly id: string; readonly reason: string }
  | { readonly type: 'Link'; readonly input: LinkInput }
  | { readonly type: 'Unlink'; readonly linkId: string }
  | {
    readonly type: 'RenameAttribute'
    readonly from: string
    readonly to: string
    readonly reason: string
    /**
     * 审计 `action` 标签；事件类型与 outbox topic 始终是 `AttributeRenamed`。
     * 维护入口（后台 attr-alias 归并）沿用历史标签 `attr-alias`，既有审计查询/回滚定位不变。
     */
    readonly auditAction?: 'rename-attr' | 'attr-alias'
  }

/**
 * 一次写事务的完整结果。
 *
 * `events/revision/projectionToken` 是命令契约；`entity/history/link/entityIds` 是
 * 旧 `Store.write/patch/...` 返回值所需的事务内产物，CommandBus 不向外暴露它们。
 */
export interface CommandOutcome {
  readonly events: readonly DomainEvent[]
  readonly revision: number
  readonly projectionToken: ProjectionToken
  readonly entity?: Entity
  readonly history?: StateVersion
  readonly link?: Link
  readonly linkCreated?: boolean
  readonly entityIds?: readonly string[]
  /**
   * 写事务没有产生新事件时的复用标记：
   * - `content`：同 scope/category/关键属性/时间的内容已存在，证据并入原实体；
   * - `command`：同一 commandId 已执行过，返回首次结果（Store 层补标记）。
   */
  readonly deduped?: 'content' | 'command'
}

/** AttributeWriter 的端口：唯一能写业务表的事务入口。 */
export interface CommandWriter {
  execute(command: PreparedCommand, meta: CommandMeta): Promise<CommandOutcome>
  /** 按 commandId 读取首次结果（重复命令返回首次结果，不再执行）。 */
  result(commandId: string): Promise<CommandOutcome | undefined>
}

export interface CommandBus {
  execute(command: Command, meta: CommandMeta): Promise<CommandExecution>
}

/** 重复命令的内部信号：由 writer 抛出，CommandBus 捕获后读取首次结果。 */
export function duplicateCommandFailure(commandId: string): OmbError {
  return {
    code: 'conflict',
    message: `命令已执行：${commandId}`,
    details: { duplicateCommand: true, commandId },
  }
}

/** 从重复命令信号里取回 commandId；不是该信号时返回 undefined。 */
export function duplicateCommandIdOf(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined
  const errorRecord = error as { readonly error?: unknown }
  const candidate = errorRecord.error ?? error
  const details = (candidate as { readonly details?: unknown }).details
  if (!isPlainObject(details) || details['duplicateCommand'] !== true) return undefined
  const commandId = details['commandId']
  return typeof commandId === 'string' && commandId.length > 0 ? commandId : undefined
}

export interface SystemCommandOptions {
  /** 稳定幂等键（工具调用/重试复用）；缺省合成一次性 UUID，保持旧写入语义。 */
  readonly commandId?: string
  readonly correlationId?: string
  readonly evidence?: readonly EvidenceInput[]
}

/** 旧写入路径（Store.write/patch/...）的 command meta：有稳定键时用它，否则合成一次性键。 */
export function systemCommandMeta(actor: string, origin?: string, options: SystemCommandOptions = {}): CommandMeta {
  return {
    commandId: options.commandId ?? crypto.randomUUID(),
    actor: { id: actor, kind: actorKindOf(actor) },
    origin: origin ?? actor,
    correlationId: options.correlationId ?? crypto.randomUUID(),
    ...(options.evidence !== undefined && options.evidence.length > 0 ? { evidence: options.evidence } : {}),
  }
}

export function actorKindOf(actor: string): ActorKind {
  const normalized = actor.toLowerCase()
  if (normalized === 'user' || normalized.startsWith('user:')) return 'user'
  if (normalized === 'job' || normalized.startsWith('job:')) return 'job'
  if (normalized === 'system' || normalized.startsWith('system:')) return 'system'
  if (normalized === 'external' || normalized.startsWith('external:')) return 'external'
  return 'model'
}

/** 命令元数据校验；返回第一个错误（与 CommandBus 的错误体同一形状）。 */
export function validateCommandMeta(meta: CommandMeta): OmbError | undefined {
  const invalid = (message: string): OmbError => ({ code: 'invalid-input', message })
  if (typeof meta.commandId !== 'string' || meta.commandId.trim().length === 0) {
    return invalid('commandId 必须是非空字符串')
  }
  if (meta.commandId.length > 200) return invalid('commandId 不能超过 200 字符')
  const actor = meta.actor as { readonly id?: unknown; readonly kind?: unknown } | undefined
  if (actor === undefined || typeof actor.id !== 'string' || actor.id.trim().length === 0) {
    return invalid('actor.id 必须是非空字符串')
  }
  if (typeof actor.kind !== 'string' || !(ACTOR_KINDS as readonly string[]).includes(actor.kind)) {
    return invalid(`actor.kind 必须是 ${ACTOR_KINDS.join('/')}`)
  }
  if (typeof meta.origin !== 'string' || meta.origin.trim().length === 0) return invalid('origin 必须是非空字符串')
  if (typeof meta.correlationId !== 'string' || meta.correlationId.trim().length === 0) {
    return invalid('correlationId 必须是非空字符串')
  }
  if (meta.expectedRevision !== undefined
    && (!Number.isInteger(meta.expectedRevision) || meta.expectedRevision < 1)) {
    return invalid('expectedRevision 必须是正整数')
  }
  if (meta.deadline !== undefined && !Number.isFinite(meta.deadline)) return invalid('deadline 必须是 epoch 毫秒')
  return undefined
}
