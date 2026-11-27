import { validationError } from '../../domain/validation-result.js'
import { OmbFailure, err, invalid, notFound, ok, type OmbError } from '../../domain/errors.js'
import { isPlainObject } from '../../domain/json.js'
import type { Store } from '../../ports/store.js'
import { normalizeWrite } from '../../domain/validation.js'
import {
  validateCommandMeta,
  type Command,
  type CommandBus,
  type CommandExecution,
  type CommandMeta,
  type CommandOutcome,
  type CommandResult,
  type CommandWriter,
  type PreparedCommand,
} from './types.js'
import { preparePatchWrite } from './patch.js'

/** 必填属性改名会破坏 entity_view 的列语义；命令层直接拒绝（与 maintenance 同一条规则）。 */
const REQUIRED_ATTRIBUTE_NAMES = new Set(['id', 'category', 'scope', 'title', 'status', 'time', 'group'])

export interface CommandBusDeps {
  readonly store: Pick<Store, 'get'>
  readonly writer: CommandWriter
}

/**
 * CommandBus：命令校验/归一化 → AttributeWriter 单事务执行；冲突、幂等在这里变成领域结果。
 *
 * - `commandId` 由 AttributeWriter 的 `audit_log.command_id` 唯一索引保证只生效一次；
 *   重复命令由 writer 抛内部信号，本类读取首次结果原样返回。
 * - `expectedRevision` 对 PatchEntity 必填（命令或 patch 上），Archive/Unarchive 可选；
 *   冲突返回 `{code:'conflict', currentRevision}`，调用方重读后重试。
 */
export class DefaultCommandBus implements CommandBus {
  constructor(private readonly deps: CommandBusDeps) {}

  async execute(command: Command, meta: CommandMeta): Promise<CommandExecution> {
    const metaError = validateCommandMeta(meta)
    if (metaError !== undefined) return err(metaError)
    try {
      const prepared = await this.prepare(command, meta)
      const outcome = await this.deps.writer.execute(prepared, meta)
      return ok(toCommandResult(outcome))
    } catch (error) {
      const duplicate = duplicateCommandId(error)
      if (duplicate !== undefined) {
        const replay = await this.deps.writer.result(duplicate)
        if (replay === undefined) {
          return err({ code: 'internal', message: `重复命令 ${duplicate} 找不到首次结果` })
        }
        return ok(toCommandResult(replay))
      }
      if (error instanceof OmbFailure) return err(toCommandError(error.error))
      return err({ code: 'internal', message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async prepare(command: Command, meta: CommandMeta): Promise<PreparedCommand> {
    switch (command.type) {
      case 'CreateEntity': {
        const normalized = normalizeWrite(command.input)
        if (!normalized.ok) throw new OmbFailure(validationError(normalized.errors))
        return { type: 'CreateEntity', input: normalized.value }
      }
      case 'PatchEntity': {
        const expectedRevision = command.input.expectedRevision ?? meta.expectedRevision
        if (expectedRevision === undefined) {
          throw new OmbFailure(invalid('PatchEntity 必须携带 expectedRevision（命令 meta 或 patch 上）'))
        }
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
          throw new OmbFailure(invalid('expectedRevision 必须是正整数'))
        }
        const entity = await this.deps.store.get(command.input.id, { includeArchived: true })
        if (entity === undefined) throw new OmbFailure(notFound(`实体不存在：${command.input.id}`))
        if (entity.archivedAt !== undefined) throw new OmbFailure({ code: 'archived', message: `实体已归档：${command.input.id}` })
        const normalized = normalizeWrite(preparePatchWrite(entity, command.input))
        if (!normalized.ok) throw new OmbFailure(validationError(normalized.errors))
        return {
          type: 'PatchEntity',
          input: normalized.value,
          patch: { ...command.input, expectedRevision },
        }
      }
      case 'ArchiveEntity':
        return { type: 'ArchiveEntity', id: requireId(command.id, 'id'), reason: command.reason }
      case 'UnarchiveEntity':
        return { type: 'UnarchiveEntity', id: requireId(command.id, 'id'), reason: command.reason }
      case 'Link':
        return { type: 'Link', input: command.input }
      case 'Unlink':
        return { type: 'Unlink', linkId: requireId(command.linkId, 'linkId') }
      case 'RenameAttribute': {
        const from = command.from.trim()
        const to = command.to.trim()
        if (from.length === 0 || to.length === 0) throw new OmbFailure(invalid('属性名不能为空'))
        if (from === to) throw new OmbFailure(invalid('属性名不能相同'))
        if (REQUIRED_ATTRIBUTE_NAMES.has(from) || REQUIRED_ATTRIBUTE_NAMES.has(to)) {
          throw new OmbFailure(invalid('必填属性不能改名'))
        }
        return { type: 'RenameAttribute', from, to, reason: command.reason }
      }
    }
  }
}

export function createCommandBus(deps: CommandBusDeps): CommandBus {
  return new DefaultCommandBus(deps)
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OmbFailure(invalid(`${field} 必须是非空字符串`))
  }
  return value
}

function duplicateCommandId(error: unknown): string | undefined {
  if (!(error instanceof OmbFailure)) return undefined
  const details = error.error.details
  if (!isPlainObject(details) || details['duplicateCommand'] !== true) return undefined
  const commandId = details['commandId']
  return typeof commandId === 'string' ? commandId : undefined
}

type CommandError = OmbError & { readonly currentRevision?: number }

function toCommandError(error: OmbError): CommandError {
  const details = error.details
  if (error.code === 'conflict' && isPlainObject(details)) {
    const currentRevision = details['currentRevision']
    if (typeof currentRevision === 'number') return { ...error, currentRevision }
  }
  return error
}

function toCommandResult(outcome: CommandOutcome): CommandResult {
  return {
    ok: true,
    events: outcome.events,
    revision: outcome.revision,
    projectionToken: outcome.projectionToken,
  }
}
