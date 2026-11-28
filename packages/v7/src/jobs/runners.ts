import type { JsonValue } from '../domain/json.js'
import { isPlainObject } from '../domain/json.js'
import type { ConsolidationJobName } from './names.js'
import type { ConsolidationDeps } from './consolidate.js'
import {
  handleAttrAlias,
  handleCluePromote,
  handleCluePromoteFor,
  handleConflict,
  handleConflictFor,
  handleDedupe,
  handleDedupeFor,
  handleEmbedSweep,
  handleExtract,
  handleExtractArtifact,
  handleForget,
  handleLinkSuggest,
  handleRefresh,
  handleReferenceRot,
  handleReferenceRotForTarget,
} from './consolidate.js'

/**
 * 巩固任务的唯一执行体（queue handler 与 workflow step 共用）。
 *
 * 为什么要有这一层：调度可以从「pg-boss 到期入队」换成「timer 到期 start workflow run」，
 * 但任务的**行为**不能换。两个入口都调用这里的 runner，runner 再调用 `consolidate.ts` 的
 * `handleX`，所以周期兜底（全量）与事件驱动（定向载荷）不会长出两套语义。
 */

/**
 * job 载荷里的定向参数。
 *
 * reaction 把「哪个实体/artifact 变了」放进载荷（`entityId`/`targetEntityId`/`artifactId`），
 * 调度驱动的周期兜底载荷只有 `{trigger, job}`；runner 按字段是否存在决定走定向还是全量，
 * 这样事件路径不会为了一个实体扫描整库，周期兜底仍能补漏。
 */
export interface ConsolidationJobPayload {
  readonly limit?: number
  readonly entityId?: string
  readonly targetEntityId?: string
  readonly artifactId?: string
  readonly dependencyRoot?: string
}

/**
 * 一次执行的确定性上下文。
 *
 * - workflow step 传 `<runId>:<step>` 作为 `commandId`：同一逻辑步骤重放（重试、租约过期、
 *   崩溃恢复、人工 retry）都是同一个键；runner 用同一份键记审计/日志即可证明幂等。
 * - pg-boss 入口没有「逻辑步骤」语义（at-least-once，每个 job 独立），因此不传 commandId；
 *   它的幂等来自 handler 自身的 revision CAS / `on conflict`，不是命令去重。
 */
export interface ConsolidationJobContext {
  readonly commandId?: string
  readonly now: Date
  readonly signal: AbortSignal
}

export type ConsolidationJobRunner = (payload: unknown, context: ConsolidationJobContext) => Promise<JsonValue>

/** 所有 10 个巩固任务都有 runner；可选依赖缺失时对应的 handler 本身按 0 处理。 */
export type ConsolidationJobRunners = Readonly<Record<ConsolidationJobName, ConsolidationJobRunner>>

function nonEmptyStringOf(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 解析载荷里的定向参数；非法字段忽略而不是抛错（旧载荷/新字段可以共存）。 */
export function consolidationJobPayloadOf(payload: unknown): ConsolidationJobPayload {
  if (!isPlainObject(payload)) return {}
  const options: { -readonly [K in keyof ConsolidationJobPayload]: ConsolidationJobPayload[K] } = {}
  const entityId = nonEmptyStringOf(payload, 'entityId')
  if (entityId !== undefined) options.entityId = entityId
  const targetEntityId = nonEmptyStringOf(payload, 'targetEntityId')
  if (targetEntityId !== undefined) options.targetEntityId = targetEntityId
  const artifactId = nonEmptyStringOf(payload, 'artifactId')
  if (artifactId !== undefined) options.artifactId = artifactId
  const dependencyRoot = nonEmptyStringOf(payload, 'dependencyRoot')
  if (dependencyRoot !== undefined) options.dependencyRoot = dependencyRoot
  const limit = payload['limit']
  if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) options.limit = limit
  return options
}

/**
 * 构造全部任务的 runner。
 *
 * 统一返回 10 个任务：workflow 定义清单因此固定（不会因可选依赖缺失而少一个定义），
 * 而 pg-boss 注册仍按可选依赖过滤（见 `registerConsolidationJobs`）——没有动态属性/嵌入器时
 * 没必要注册一个永远空跑的队列消费者；workflow 路径只在真实组合根里使用完整依赖。
 */
export function createConsolidationJobRunners(deps: ConsolidationDeps): ConsolidationJobRunners {
  return {
    'omb.extract': async payload => {
      const options = consolidationJobPayloadOf(payload)
      const result = options.artifactId === undefined
        ? await handleExtract(deps, options.limit)
        : await handleExtractArtifact(deps, options.artifactId)
      return { written: result.written, skipped: result.skipped, grouped: result.grouped }
    },
    'omb.reference-rot': async payload => {
      // 事件载荷用 targetEntityId 指“被改的实体”，只检查指向它的引用。
      const options = consolidationJobPayloadOf(payload)
      const target = options.targetEntityId ?? options.entityId
      const result = target === undefined
        ? await handleReferenceRot(deps, options.limit)
        : await handleReferenceRotForTarget(deps, target)
      return { marked: result.marked }
    },
    'omb.clue-promote': async payload => {
      // 线索晋升前必须先看它自己的引用腐化；定向入口内部会做这件事。
      const options = consolidationJobPayloadOf(payload)
      const result = options.entityId === undefined
        ? await handleCluePromote(deps, options.limit)
        : await handleCluePromoteFor(deps, options.entityId)
      return { promoted: result.promoted }
    },
    'omb.dedupe': async payload => {
      const options = consolidationJobPayloadOf(payload)
      const result = options.entityId === undefined
        ? await handleDedupe(deps, options.limit)
        : await handleDedupeFor(deps, options.entityId)
      return { merged: result.merged }
    },
    'omb.conflict': async payload => {
      const options = consolidationJobPayloadOf(payload)
      const result = options.entityId === undefined
        ? await handleConflict(deps, options.limit)
        : await handleConflictFor(deps, options.entityId)
      return { linked: result.linked }
    },
    'omb.link-suggest': async () => {
      const result = await handleLinkSuggest(deps)
      return { linked: result.linked, grouped: result.grouped }
    },
    'omb.forget': async () => {
      const result = await handleForget(deps)
      return { archived: result.archived, skipped: result.skipped }
    },
    'omb.attr-alias': async () => {
      const result = await handleAttrAlias(deps)
      return { renamed: result.renamed }
    },
    'omb.refresh': async payload => {
      const result = await handleRefresh(deps, consolidationJobPayloadOf(payload))
      return { refreshed: result.refreshed, statusUpdated: result.statusUpdated, skipped: result.skipped }
    },
    'omb.embed-sweep': async () => {
      const result = await handleEmbedSweep(deps)
      return { embedded: result.embedded }
    },
  }
}
