#!/usr/bin/env node
/**
 * OMB v7 shadow compare：写模型 vs 投影读模型 + recall vs recallFromPlan 重放。
 *
 * 用途（PLAN Task 9「双写/影子比对」的可重复证据）：
 * 1. 看板：把 `preference_board`/`state_board` 读模型与从 `entity/attribute` 现算的写模型
 *    逐实体比对（entityId/revision/标题/其余派生列），输出差异明细。空库、尚未投影、
 *    读模型停摆（T0 会回退写模型）都**显式给原因**，不把“没有可比对的数据”说成一致。
 * 2. 检索：同一请求先 `recall`、再把 `compilePlan` 的计划 JSON 往返后 `recallFromPlan`，
 *    比较命中集合/融合分/通道；至少 10 条查询，任何差异即 FAIL。
 *
 * 只读纪律：
 * - 目标库名必须含独立 test/bench 段时才会建库/清库/造夹具/跑投影 worker（独立可抛弃库）；
 *   生产库名在**连接之前**就被拒绝，只允许显式 `--read-only` 做看板只读比对。
 * - 只读模式不跑检索重放：`recall`/`recallFromPlan` 会写 `recall_event` 与访问计数。
 * - 报告里只写库名，不写连接串（避免把口令带进证据文件）。
 *
 * 用法：
 *   pnpm v7:shadow                      # 默认 omb_v7_shadow_test，造夹具后完整比对
 *   pnpm v7:shadow --read-only          # 只比现有数据的两块看板，不写任何表
 *   pnpm v7:shadow --mode=boards|retrieval|all --json shadow.json --limit 100
 *   环境变量：OMB_SHADOW_DATABASE_URL / OMB_SHADOW_PROJECT_KEY
 *
 * 判定：全部一致 → exit 0；任一差异、或空库/未投影/查询数不足等无证据情形 → exit 1。
 */
import process from 'node:process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Entity, Scope, StateStatus, WriteEntityInput } from '../packages/v7/src/domain/entity.js'
import { deriveSearchText, deriveTriggers, normalizeWrite } from '../packages/v7/src/domain/validation.js'
import { embeddingText } from '../packages/v7/src/app/embedding.js'
import { projectionOfBoard } from '../packages/v7/src/app/projections/index.js'
import { ProjectionWorker } from '../packages/v7/src/app/projections/index.js'
import type { ProjectionTickSummary } from '../packages/v7/src/app/projections/worker.js'
import type { BoardQuery } from '../packages/v7/src/app/projections/read.js'
import type {
  BoardItem,
  BoardKind,
  ProjectionName,
  ProjectionTaskState,
} from '../packages/v7/src/app/projections/types.js'
import { HASH_DIMS, HASH_MODEL, HashEmbedder, hashEmbed } from '../packages/v7/src/adapters/embedding/hash.js'
import { PostgresDb } from '../packages/v7/src/adapters/postgres/db.js'
import { migrateDatabase, truncateAll } from '../packages/v7/src/adapters/postgres/migrate.js'
import {
  createBoardProjectors,
  createBoardReader,
  PostgresProjectionTaskStore,
} from '../packages/v7/src/adapters/postgres/projection.js'
import { PostgresStore } from '../packages/v7/src/adapters/postgres/store.js'
import type { DerivedWrite } from '../packages/v7/src/ports/store.js'
import type { Clock } from '../packages/v7/src/ports/clock.js'
import { RecallEngine } from '../packages/v7/src/retrieval/engine.js'
import type { RecallChannel, RecallRequest, RecallResult } from '../packages/v7/src/retrieval/types.js'
import { databaseNameOf, isDisposableDatabaseName } from '../packages/v7/src/security/trust.js'

export const SHADOW_SCHEMA = 'omb.shadow-compare/1'
export const DEFAULT_SHADOW_DATABASE_URL = 'postgres://omb:omb@127.0.0.1:5432/omb_v7_shadow_test'
export const DEFAULT_SHADOW_PROJECT_KEY = 'D:/shadow/omb'
/** 固定查询时间锚点：重放的两侧必须用同一个 now，否则时间通道/衰减本身就会不同。 */
export const SHADOW_CLOCK_ISO = '2026-11-28T00:00:00.000Z'
/** PLAN Task 9 要求至少 10 条查询；少于它就不是证据。 */
export const MIN_SHADOW_QUERIES = 10

/**
 * 看板水位停摆门槛，与 `recall/resident.ts` 的 `DEFAULT_BOARDS_WATERMARK_MAX_AGE_MS` 对齐。
 * 那边没有导出该常量（消费方私有），这里复制并使用同一条判据：
 * “水位比门槛老 **且** 还有未投影任务”才算停摆；只看年龄会把“长时间没写”误判成停摆。
 */
const BOARD_WATERMARK_MAX_AGE_MS = 30_000
const MAX_BOARD_LIMIT = 100
/** 浮点比较容差：同一条 SQL 在同一份数据上重复执行应当逐位相同，留极小容差只吸收格式化噪声。 */
const SCORE_EPSILON = 1e-9
const MAX_REPORTED_DIFFS = 50

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export type ShadowVerdict = 'consistent' | 'divergent' | 'inconclusive'
export type ShadowMode = 'all' | 'boards' | 'retrieval'

export interface ShadowDatabaseInfo {
  /** 只写库名，不写连接串/口令。 */
  readonly name?: string
  readonly disposable: boolean
  readonly readOnly: boolean
  readonly mode: ShadowMode
}

export interface FieldDelta {
  readonly field: string
  readonly writeModel: string | number | null
  readonly readModel: string | number | null
}

export interface BoardDiff {
  readonly entityId: string
  readonly kind: 'missing-in-read-model' | 'extra-in-read-model' | 'field-drift'
  /**
   * unprojected：差异由未完成的投影任务（pending/claimed）解释，worker 还没追上写模型；
   * divergent：没有未完成任务可以解释的差异，是真正的写/读模型不一致。
   */
  readonly cause: 'unprojected' | 'divergent'
  readonly fields?: readonly FieldDelta[]
  readonly projectionTask?: { readonly status: string; readonly revision: number }
  readonly writeModelRevision?: number
  readonly readModelRevision?: number
}

export interface BoardFallback {
  readonly needed: boolean
  readonly reason?: string
}

export interface BoardShadowSection {
  readonly board: BoardKind
  readonly projection: ProjectionName
  readonly scope: string
  readonly verdict: ShadowVerdict
  readonly reasons: readonly string[]
  readonly writeModelCount: number
  readonly readModelCount: number
  readonly compared: number
  readonly unprojectedCount: number
  readonly divergentCount: number
  readonly fallback: BoardFallback
  readonly freshness: { readonly unprojected: number; readonly watermarkAgeMs?: number }
  readonly diffs: readonly BoardDiff[]
}

export interface RetrievalDifference {
  readonly query: string
  readonly kind:
    | 'hit-count'
    | 'hit-identity'
    | 'fused-score'
    | 'score'
    | 'channels'
    | 'channel-report'
    | 'empty-reason'
  readonly index?: number
  readonly entityId?: string
  readonly channel?: RecallChannel
  readonly recall: string | number | null
  readonly replay: string | number | null
}

export interface QueryShadowSection {
  readonly name: string
  readonly query: string
  readonly recallHits: number
  readonly replayHits: number
  /**
   * 本次执行覆盖到的通道：阶段一 `status='ok'` 的通道 ∪ 最终命中携带的通道（含 links）。
   * 全部通道都 empty 时“重放一致”只证明了空结果一致，所以覆盖率要单独报出来。
   */
  readonly channels: readonly RecallChannel[]
  readonly differences: readonly RetrievalDifference[]
}

export interface RetrievalShadowSection {
  readonly verdict: ShadowVerdict
  readonly reasons: readonly string[]
  readonly queryCount: number
  readonly queriesWithHits: number
  readonly totalHits: number
  readonly channels: readonly RecallChannel[]
  readonly queries: readonly QueryShadowSection[]
  readonly differences: readonly RetrievalDifference[]
  /** 本次没有执行重放时的原因（只读/不可抛弃库）；此时 verdict 不参与总判定。 */
  readonly skipped?: string
}

export interface ShadowReport {
  readonly schema: string
  readonly generatedAt: string
  readonly database: ShadowDatabaseInfo
  readonly projectKey: string
  readonly boards: readonly BoardShadowSection[]
  readonly retrieval?: RetrievalShadowSection
  readonly verdict: ShadowVerdict
  readonly reasons: readonly string[]
  readonly exitCode: 0 | 1
}

export interface ShadowSummary {
  readonly verdict: ShadowVerdict
  readonly exitCode: 0 | 1
  readonly reasons: readonly string[]
}

export interface ShadowReportInput {
  readonly database: ShadowDatabaseInfo
  readonly projectKey: string
  readonly boards: readonly BoardShadowSection[]
  readonly retrieval?: RetrievalShadowSection
  /** 连接前的硬拒绝原因（例如生产库未显式只读）；给定时直接 inconclusive + exit 1。 */
  readonly blockedReason?: string
}

// ---------------------------------------------------------------------------
// 影子比较目标（真实 PG 组合）
// ---------------------------------------------------------------------------

const shadowClock: Clock = { now: () => new Date(SHADOW_CLOCK_ISO), iso: () => SHADOW_CLOCK_ISO }

interface ShadowFreshness {
  readonly watermarkAgeMs?: number
  readonly unprojected: number
}

interface ShadowFreshnessPair {
  readonly preferenceFreshness: ShadowFreshness
  readonly stateFreshness: ShadowFreshness
}

interface ShadowBoardReader {
  readBoard(query: BoardQuery): Promise<readonly BoardItem[]>
  deriveFromWriteModel(query: BoardQuery): Promise<readonly BoardItem[]>
  readFreshness(): Promise<ShadowFreshnessPair>
}

export interface BoardShadowDeps {
  readonly reader: ShadowBoardReader
  readonly taskStates: (
    projection: ProjectionName,
    entityIds: readonly string[],
  ) => Promise<ReadonlyMap<string, ProjectionTaskState>>
}

export interface ShadowTarget {
  readonly databaseUrl: string
  readonly db: PostgresDb
  readonly store: PostgresStore
  readonly engine: RecallEngine
  readonly tasks: PostgresProjectionTaskStore
  readonly boards: BoardShadowDeps
  close(): Promise<void>
}

function taskStatusOf(value: string): ProjectionTaskState['status'] {
  if (value === 'pending' || value === 'claimed' || value === 'done' || value === 'dead') return value
  throw new Error(`未知 projection_task.status：${value}`)
}

export function createBoardShadowDeps(db: PostgresDb): BoardShadowDeps {
  const reader = createBoardReader(db)
  return {
    reader: {
      readBoard: query => reader.readBoard(query),
      deriveFromWriteModel: query => reader.deriveFromWriteModel(query),
      readFreshness: () => reader.readFreshness(),
    },
    /**
     * 一次取回所有差异实体的任务状态：用于区分“worker 还没追上（unprojected）”
     * 与“投影已处理但没有/写错行（divergent）”。只读 SELECT。
     */
    taskStates: async (projection, entityIds) => {
      const result = new Map<string, ProjectionTaskState>()
      if (entityIds.length === 0) return result
      const rows = await db.query<{ entity_id: string; status: string; revision: string | number }>(
        `select entity_id, status, revision::bigint as revision
           from omb.projection_task
          where projection = $1 and entity_id = any($2::text[])`,
        [projection, entityIds],
      )
      for (const row of rows.rows) {
        result.set(row.entity_id, { status: taskStatusOf(row.status), revision: Number(row.revision) })
      }
      return result
    },
  }
}

export function openShadowTarget(databaseUrl: string): ShadowTarget {
  const store = new PostgresStore(databaseUrl)
  const db = store.db
  /**
   * 阶段一预算放大到 5s：shadow 只验证“同一份计划重放等价”，不是性能预算。
   * 用默认 1500ms 时，一台负载高的机器可能让同一条查询在两次执行里一次 ok、一次 deadline，
   * 那是测量噪声而不是语义差异；把预算拉大可以排除这类假差异。
   */
  const engine = new RecallEngine({
    store,
    embedder: new HashEmbedder(),
    clock: shadowClock,
    stageOneBudgetMs: 5_000,
    providerTimeoutMs: 5_000,
  })
  return {
    databaseUrl,
    db,
    store,
    engine,
    tasks: new PostgresProjectionTaskStore(db),
    boards: createBoardShadowDeps(db),
    close: () => store.close(),
  }
}

/** 清空可抛弃库的业务表 + 投影表（`projection_watermark` 无 FK，不会被 truncateAll 级联）。 */
export async function resetShadowDatabase(target: ShadowTarget): Promise<void> {
  await truncateAll(target.databaseUrl)
  await target.db.query(
    `truncate table omb.projection_watermark, omb.projection_task, omb.preference_board,
                    omb.state_board, omb.adoption_stat, omb.co_recall_pair, omb.similar_cache
       restart identity cascade`,
  )
}

/** 把 `projection_task` 全部投影掉（与生产 worker 同一实现），返回一次 drain 的计数。 */
export async function drainProjections(target: ShadowTarget): Promise<ProjectionTickSummary> {
  const worker = new ProjectionWorker(
    { store: target.tasks, projectors: createBoardProjectors(target.db), clock: shadowClock },
    { batchSize: 50, leaseMs: 5_000 },
  )
  return worker.drain()
}

// ---------------------------------------------------------------------------
// 看板比对
// ---------------------------------------------------------------------------

export interface ShadowBoardQuery {
  readonly kind: BoardKind
  readonly scope: Scope
  readonly limit?: number
}

/** 逐字段比较的列；`updatedAt` 故意不参与比较（见 `compareBoardShadow` 注释）。 */
type OptionalBoardField = 'title' | 'summary' | 'status' | 'projectKey' | 'eventTime'
type BoardField = OptionalBoardField | 'revision' | 'salience'

const PREFERENCE_FIELDS: readonly BoardField[] = ['title', 'summary', 'salience', 'revision']
const STATE_FIELDS: readonly BoardField[] = ['title', 'status', 'projectKey', 'eventTime', 'revision']

function fieldValue(item: BoardItem, field: BoardField): string | number | null {
  if (field === 'revision') return item.revision
  if (field === 'salience') return item.salience ?? null
  const value = item[field]
  return value === undefined ? null : value
}

function scopeLabel(scope: Scope): string {
  return scope.kind === 'global' ? 'global' : `project:${scope.projectKey}`
}

function clampBoardLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_BOARD_LIMIT, Math.trunc(value))) : MAX_BOARD_LIMIT
}

function diffSummary(diffs: readonly BoardDiff[]): string {
  const missing = diffs.filter(diff => diff.kind === 'missing-in-read-model').length
  const extra = diffs.filter(diff => diff.kind === 'extra-in-read-model').length
  const drift = diffs.filter(diff => diff.kind === 'field-drift').length
  return `missing=${missing} extra=${extra} fieldDrift=${drift}`
}

/**
 * 比对一块看板：写模型（entity/attribute 现算）vs 投影读模型。
 *
 * 一致性判据：
 * - 同一 entityId 的 revision 与派生列逐字段相等；
 * - 差异要么由**未完成**的投影任务解释（unprojected → inconclusive，不是 PASS），
 *   要么就是真差异（divergent → FAIL）。
 * - 写模型与读模型都为空时是空库/数据未准备（conclusive 的反面），返回 inconclusive。
 *
 * 为什么**不比 `updatedAt`**：`omb.entity` 有 `entity_touch_updated_at` 触发器，`markAccessed`
 * 只改访问计数也会把 `entity.updated_at` 推到现在，而 revision 不变、也不会产生投影任务；
 * 拿它比较会造出一堆假差异。读模型是否覆盖写模型版本由 `revision` 判定。
 */
export async function compareBoardShadow(
  deps: BoardShadowDeps,
  query: ShadowBoardQuery,
): Promise<BoardShadowSection> {
  const projectKey = query.scope.kind === 'project' ? query.scope.projectKey : ''
  const derivedQuery: BoardQuery = {
    kind: query.kind,
    scope: query.scope,
    limit: clampBoardLimit(query.limit ?? MAX_BOARD_LIMIT),
    ...(projectKey.length > 0 ? { projectKey } : {}),
  }
  const [writeRows, readRows, freshnessPair] = await Promise.all([
    deps.reader.deriveFromWriteModel(derivedQuery),
    deps.reader.readBoard(derivedQuery),
    deps.reader.readFreshness(),
  ])

  const writeById = new Map(writeRows.map(row => [row.entityId, row]))
  const readById = new Map(readRows.map(row => [row.entityId, row]))
  const fields = query.kind === 'preference' ? PREFERENCE_FIELDS : STATE_FIELDS

  const differenceIds: string[] = []
  const pending: { entityId: string; kind: BoardDiff['kind']; fields?: FieldDelta[] }[] = []
  for (const [entityId, writeRow] of writeById) {
    const readRow = readById.get(entityId)
    if (readRow === undefined) {
      pending.push({ entityId, kind: 'missing-in-read-model' })
      differenceIds.push(entityId)
      continue
    }
    const deltas: FieldDelta[] = []
    for (const field of fields) {
      const writeModel = fieldValue(writeRow, field)
      const readModel = fieldValue(readRow, field)
      if (writeModel !== readModel) deltas.push({ field, writeModel, readModel })
    }
    if (deltas.length > 0) {
      pending.push({ entityId, kind: 'field-drift', fields: deltas })
      differenceIds.push(entityId)
    }
  }
  for (const entityId of readById.keys()) {
    if (writeById.has(entityId)) continue
    pending.push({ entityId, kind: 'extra-in-read-model' })
    differenceIds.push(entityId)
  }

  const projection = projectionOfBoard(query.kind)
  const taskStates = await deps.taskStates(projection, differenceIds)
  const diffs: BoardDiff[] = pending
    .map(item => {
      const task = taskStates.get(item.entityId)
      const writeRow = writeById.get(item.entityId)
      const readRow = readById.get(item.entityId)
      const cause: BoardDiff['cause'] = task !== undefined && (task.status === 'pending' || task.status === 'claimed')
        ? 'unprojected'
        : 'divergent'
      return {
        entityId: item.entityId,
        kind: item.kind,
        cause,
        ...(item.fields === undefined ? {} : { fields: item.fields }),
        ...(task === undefined ? {} : { projectionTask: { status: task.status, revision: task.revision } }),
        ...(writeRow === undefined ? {} : { writeModelRevision: writeRow.revision }),
        ...(readRow === undefined ? {} : { readModelRevision: readRow.revision }),
      } satisfies BoardDiff
    })
    .sort((left, right) => (left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0))

  const unprojected = diffs.filter(diff => diff.cause === 'unprojected')
  const divergent = diffs.filter(diff => diff.cause === 'divergent')
  const freshness = query.kind === 'preference' ? freshnessPair.preferenceFreshness : freshnessPair.stateFreshness
  const reasons: string[] = []
  let verdict: ShadowVerdict
  if (divergent.length > 0) {
    verdict = 'divergent'
    reasons.push(`divergent: ${divergent.length} 条写/读模型差异（${diffSummary(divergent)}）`)
  } else if (unprojected.length > 0) {
    verdict = 'inconclusive'
    reasons.push(`unprojected: ${unprojected.length} 条差异由未完成的投影任务解释（${diffSummary(unprojected)}）；worker 未追上写模型，不是一致性证据`)
  } else if (writeRows.length === 0 && readRows.length === 0) {
    verdict = 'inconclusive'
    reasons.push('empty-write-model: 写模型没有看板成员（空库或数据未准备），没有可比对的源行')
  } else {
    verdict = 'consistent'
  }

  const stalled = freshness.unprojected > 0
    && (freshness.watermarkAgeMs === undefined || freshness.watermarkAgeMs > BOARD_WATERMARK_MAX_AGE_MS)
  const fallback: BoardFallback = writeRows.length > 0 && readRows.length === 0
    ? { needed: true, reason: 'read-model-empty' }
    : stalled
      ? {
          needed: true,
          reason: `read-model-watermark-stale: watermarkAgeMs=${Math.trunc(freshness.watermarkAgeMs ?? 0)} unprojected=${freshness.unprojected}`,
        }
      : { needed: false }

  return {
    board: query.kind,
    projection,
    scope: scopeLabel(query.scope),
    verdict,
    reasons,
    writeModelCount: writeRows.length,
    readModelCount: readRows.length,
    compared: [...writeById.keys()].filter(entityId => readById.has(entityId)).length,
    unprojectedCount: unprojected.length,
    divergentCount: divergent.length,
    fallback,
    freshness: {
      unprojected: freshness.unprojected,
      ...(freshness.watermarkAgeMs === undefined ? {} : { watermarkAgeMs: freshness.watermarkAgeMs }),
    },
    diffs: diffs.slice(0, MAX_REPORTED_DIFFS),
  }
}

// ---------------------------------------------------------------------------
// 检索重放比对
// ---------------------------------------------------------------------------

function closeScore(left: number, right: number): boolean {
  return Math.abs(left - right) <= SCORE_EPSILON
}

function uniqueChannels(values: readonly RecallChannel[]): RecallChannel[] {
  const seen = new Set<RecallChannel>()
  for (const value of values) seen.add(value)
  return [...seen].sort()
}

/** 比较同一条查询的 `recall` 与 `recallFromPlan` 结果；任何字段差异都逐条记下来。 */
export function compareRecallResults(
  name: string,
  query: string,
  direct: RecallResult,
  replayed: RecallResult,
): QueryShadowSection {
  const differences: RetrievalDifference[] = []
  const maxHits = Math.max(direct.hits.length, replayed.hits.length)
  for (let index = 0; index < maxHits; index++) {
    const left = direct.hits[index]
    const right = replayed.hits[index]
    if (left === undefined || right === undefined) {
      differences.push({
        query,
        kind: 'hit-count',
        index,
        recall: direct.hits.length,
        replay: replayed.hits.length,
      })
      // 条数差异已经是根因，后续索引逐条报只会淹没它。
      break
    }
    if (left.entityId !== right.entityId) {
      differences.push({
        query,
        kind: 'hit-identity',
        index,
        entityId: left.entityId,
        recall: left.entityId,
        replay: right.entityId,
      })
      continue
    }
    if (!closeScore(left.fusedScore, right.fusedScore)) {
      differences.push({
        query,
        kind: 'fused-score',
        index,
        entityId: left.entityId,
        recall: left.fusedScore,
        replay: right.fusedScore,
      })
    }
    if (!closeScore(left.score, right.score)) {
      differences.push({
        query,
        kind: 'score',
        index,
        entityId: left.entityId,
        recall: left.score,
        replay: right.score,
      })
    }
    const leftChannels = left.channels.join(',')
    const rightChannels = right.channels.join(',')
    if (leftChannels !== rightChannels) {
      differences.push({
        query,
        kind: 'channels',
        index,
        entityId: left.entityId,
        recall: leftChannels,
        replay: rightChannels,
      })
    }
  }

  const directReports = new Map(direct.channels.map(report => [report.channel, report]))
  const replayedReports = new Map(replayed.channels.map(report => [report.channel, report]))
  const reportChannels = new Set([...directReports.keys(), ...replayedReports.keys()])
  for (const channel of reportChannels) {
    const left = directReports.get(channel)
    const right = replayedReports.get(channel)
    const leftSummary = left === undefined ? null : `${left.status}:${left.hitCount}`
    const rightSummary = right === undefined ? null : `${right.status}:${right.hitCount}`
    if (leftSummary !== rightSummary) {
      differences.push({
        query,
        kind: 'channel-report',
        channel,
        recall: leftSummary,
        replay: rightSummary,
      })
    }
  }

  if (direct.hits.length === 0 && replayed.hits.length === 0) {
    const leftReason = direct.emptyReason?.code ?? null
    const rightReason = replayed.emptyReason?.code ?? null
    if (leftReason !== rightReason) {
      differences.push({ query, kind: 'empty-reason', recall: leftReason, replay: rightReason })
    }
  }

  const spacedChannels = new Set<RecallChannel>()
  for (const report of direct.channels) if (report.status === 'ok') spacedChannels.add(report.channel)
  for (const hit of direct.hits) for (const channel of hit.channels) spacedChannels.add(channel)

  return {
    name,
    query,
    recallHits: direct.hits.length,
    replayHits: replayed.hits.length,
    channels: uniqueChannels([...spacedChannels]),
    differences,
  }
}

/**
 * 汇总一次检索重放的证据强弱：
 * - 有差异 → divergent（FAIL，任何差异都是 FAIL）；
 * - 查询数不足 → inconclusive（少于 10 条不是证据）；
 * - 全部零命中 → inconclusive（空结果一致不能证明检索一致）。
 */
export function assessRetrievalShadow(
  queries: readonly QueryShadowSection[],
  minimumQueries = MIN_SHADOW_QUERIES,
): RetrievalShadowSection {
  const differences = queries.flatMap(item => item.differences)
  const totalHits = queries.reduce((sum, item) => sum + item.recallHits, 0)
  const queriesWithHits = queries.filter(item => item.recallHits > 0).length
  const channels = uniqueChannels(queries.flatMap(item => item.channels))
  const reasons: string[] = []
  let verdict: ShadowVerdict
  if (differences.length > 0) {
    verdict = 'divergent'
    reasons.push(`divergent: ${differences.length} 处 recall/recallFromPlan 差异`)
  } else if (queries.length < minimumQueries) {
    verdict = 'inconclusive'
    reasons.push(`too-few-queries: ${queries.length} < ${minimumQueries}`)
  } else if (totalHits === 0) {
    verdict = 'inconclusive'
    reasons.push('no-hits: 所有查询均无命中，空结果一致不能证明重放一致')
  } else {
    verdict = 'consistent'
  }
  return {
    verdict,
    reasons,
    queryCount: queries.length,
    queriesWithHits,
    totalHits,
    channels,
    queries,
    differences,
  }
}

export interface ShadowQuerySpec {
  readonly name: string
  readonly request: RecallRequest
}

/**
 * 固定 12 条查询，覆盖六条阶段一通道 + links 扩展 + 状态看板 + 空结果。
 * 时间锚点固定（`SHADOW_CLOCK_ISO`），所以两次执行的时间窗/衰减完全相同。
 */
export function shadowQuerySpecs(projectKey = DEFAULT_SHADOW_PROJECT_KEY): readonly ShadowQuerySpec[] {
  const now = SHADOW_CLOCK_ISO
  return [
    {
      name: 'deploy-long',
      request: {
        query: '上次生产部署回滚时数据库连接池被打满、日志出现 ECONNRESET，/src/retrieval/compiler.ts 的 deadline 也有问题，怎么处理？',
        scenario: 'last-time',
        now,
        limit: 10,
      },
    },
    {
      name: 'deploy-link',
      request: { query: '生产部署回滚排障记录', scenario: 'manual', expand: 'links', now, limit: 10 },
    },
    { name: 'vector-exact', request: { query: '向量检索迭代扫描集成记忆', scenario: 'manual', now, limit: 10 } },
    { name: 'error-signal', request: { query: 'ECONNRESET', scenario: 'tool-error', now, limit: 10 } },
    { name: 'single-char', request: { query: '猫', scenario: 'manual', projectKey, now, limit: 10 } },
    {
      name: 'state-board',
      request: {
        query: '当前项目 进行中 阻塞中',
        scenario: 'session-start',
        scope: 'project',
        projectKey,
        kind: 'state',
        status: ['in_progress', 'blocked'],
        now,
        limit: 10,
      },
    },
    {
      name: 'time-window',
      request: {
        query: '部署',
        scenario: 'last-time',
        timeWindow: { from: '2026-11-20T00:00:00.000Z', to: now },
        now,
        limit: 10,
      },
    },
    {
      name: 'chain-expand',
      request: { query: '检索计划重放', scenario: 'manual', expand: 'both', now, limit: 10 },
    },
    { name: 'category-filter', request: { query: '连接池 超时 重试', scenario: 'manual', category: 'fact', now, limit: 10 } },
    {
      name: 'project-scope',
      request: { query: '项目偏好', scenario: 'manual', scope: 'project', projectKey, now, limit: 10 },
    },
    { name: 'tool-before', request: { query: 'pnpm test:pg 失败', scenario: 'tool-before', now, limit: 10 } },
    { name: 'unmatched-text', request: { query: 'quarterly zebra calibration', scenario: 'manual', now, limit: 10 } },
  ]
}

/** 对每条查询执行 recall，再用计划 JSON 往返重放，逐条比较。 */
export async function runRetrievalShadow(
  engine: RecallEngine,
  specs: readonly ShadowQuerySpec[],
): Promise<RetrievalShadowSection> {
  const queries: QueryShadowSection[] = []
  for (const spec of specs) {
    const plan = engine.compilePlan(spec.request)
    const serialized = JSON.parse(JSON.stringify(plan)) as unknown
    const direct = await engine.recall({ ...spec.request, traceId: `shadow-recall-${spec.name}` })
    const replayed = await engine.recallFromPlan(serialized, { traceId: `shadow-replay-${spec.name}` })
    queries.push(compareRecallResults(spec.name, spec.request.query, direct, replayed))
  }
  return assessRetrievalShadow(queries)
}

// ---------------------------------------------------------------------------
// 夹具（只写可抛弃库）
// ---------------------------------------------------------------------------

export interface SeededShadowFixtures {
  readonly preferences: readonly { readonly id: string; readonly title: string; readonly revision: number }[]
  readonly states: readonly { readonly id: string; readonly title: string; readonly status: StateStatus }[]
  readonly retrieval: Readonly<Record<string, string>>
}

/**
 * 超长中文正文：1200 个不重复的 CJK 扩展 A 单字（≈2400 token）把 `search_text` 截到
 * 2048 token 之后，再接一个目标字。于是 fulltext 命不中、`chars` 仍包含它，正好触发
 * single_char 回退——用来证明重放覆盖了这条通道，而不是只覆盖全文。
 * 用扩展 A 区（U+3400 起）是为了不和正常中文词共享 bigram，避免污染其它查询。
 */
function longTailBody(tail: string, characters = 1200): string {
  const prefix: string[] = []
  for (let index = 0; index < characters; index++) prefix.push(String.fromCharCode(0x3400 + index))
  return `${prefix.join('')}${tail}`
}

interface FixtureWrite {
  readonly key: string
  readonly input: WriteEntityInput
  readonly embed?: boolean
}

function fixtureWrites(projectKey: string): readonly FixtureWrite[] {
  const project = { kind: 'project', projectKey } as const
  const preference = (title: string, body: string): WriteEntityInput => ({
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body, tags: ['偏好'] },
  })
  const memory = (title: string, attrs: Record<string, unknown> = {}): WriteEntityInput => ({
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, ...attrs },
  })
  const state = (key: string, title: string, status: StateStatus, time: string, scope: Scope = project): FixtureWrite => ({
    key,
    input: { kind: 'state', scope, title, status, time },
  })

  return [
    { key: 'pref-1', input: preference('偏好：提交前先跑受影响测试', '先写会红的断言，再写最小实现。') },
    { key: 'pref-2', input: preference('偏好：代码与路径保持英文', '回复用中文，代码、命令、路径用英文。') },
    { key: 'pref-3', input: preference('偏好：归档不物理删除', '归档只改 archived_at，已有链接仍可解析。') },
    {
      key: 'project-preference',
      input: {
        kind: 'memory',
        category: 'fact',
        scope: project,
        attrs: { title: '项目内偏好：项目偏好不进出全局看板', body: '只影响本项目。', tags: ['偏好'] },
      },
    },
    state('state-progress', '状态：shadow compare 实现中', 'in_progress', '2026-11-27T10:00:00.000Z'),
    state('state-blocked', '状态：检索重放卡住', 'blocked', '2026-11-26T09:00:00.000Z'),
    state('state-waiting', '状态：等待看板回填', 'waiting', '2026-11-25T08:00:00.000Z'),
    state('state-completed', '状态：已完成的旧任务', 'completed', '2026-11-24T07:00:00.000Z'),
    state('state-other-project', '状态：另一个项目进行中', 'in_progress', '2026-11-23T06:00:00.000Z', {
      kind: 'project',
      projectKey: 'D:/shadow/other',
    }),
    {
      key: 'deploy-memory',
      input: memory('生产部署回滚排障记录', {
        body: '上一次生产部署回滚时数据库连接池被打满，日志出现 ECONNRESET；根因是 /src/retrieval/compiler.ts 的 deadline 处理与连接泄漏。',
        error: 'ECONNRESET',
        tool: 'pnpm test:pg',
      }),
    },
    { key: 'checklist-memory', input: memory('回滚检查清单', { body: '回滚前检查连接池、超时与重试，并确认审计链完整。' }) },
    { key: 'vector-memory', input: memory('向量检索迭代扫描集成记忆', { body: '向量检索迭代扫描集成记忆' }), embed: true },
    { key: 'plain-memory', input: memory('普通全局记忆：构建产物指针', { body: 'lib-gen 的指针由构建脚本维护，不手改。' }) },
    { key: 'approval-memory', input: memory('季度部署审批流程', { body: '部署申请需要两名负责人审批，回滚窗口另行通知。' }) },
    { key: 'single-char-memory', input: memory('宠物记录', { body: longTailBody('这只猫每天在窗台上晒太阳。') }) },
    { key: 'chain-step-1', input: memory('思维链：检索计划重放步骤一', { body: '把请求编译成可序列化计划。' }) },
    { key: 'chain-step-2', input: memory('思维链：检索计划重放步骤二', { body: '比较两次执行的融合分与通道。' }) },
  ]
}

async function writeFixture(target: ShadowTarget, fixture: FixtureWrite): Promise<Entity> {
  const normalized = normalizeWrite(fixture.input)
  if (!normalized.ok) throw new Error(`shadow 夹具非法（${fixture.key}）：${JSON.stringify(normalized.errors)}`)
  const value = normalized.value
  const derived: DerivedWrite = {
    searchText: deriveSearchText(value.attributes),
    triggers: deriveTriggers(value.attributes),
  }
  const written = await target.store.write(value, derived)
  if (fixture.embed === true) {
    const text = embeddingText(written.entity.attributes)
    await target.store.upsertEmbedding(written.entity.id, HASH_MODEL, HASH_DIMS, hashEmbed(text, HASH_DIMS))
  }
  return written.entity
}

/**
 * 造夹具：走生产写路径（`PostgresStore.write` → AttributeWriter），因此 writer 该入队的
 * `projection_task` 一定入队；再补一条链接、一条思维链，让 links 通道真的有扩展证据。
 * 只在可抛弃库上调用（runShadowCompare 已做库名判定）。
 */
export async function seedShadowFixtures(
  target: ShadowTarget,
  options: { readonly projectKey?: string } = {},
): Promise<SeededShadowFixtures> {
  const projectKey = options.projectKey ?? DEFAULT_SHADOW_PROJECT_KEY
  const ids = new Map<string, Entity>()
  for (const fixture of fixtureWrites(projectKey)) {
    ids.set(fixture.key, await writeFixture(target, fixture))
  }

  const deployId = ids.get('deploy-memory')?.id
  const checklistId = ids.get('checklist-memory')?.id
  if (deployId !== undefined && checklistId !== undefined) {
    await target.store.link({ fromId: deployId, toId: checklistId, relation: 'related', strength: 0.8 })
  }
  const stepOne = ids.get('chain-step-1')?.id
  const stepTwo = ids.get('chain-step-2')?.id
  if (stepOne !== undefined && stepTwo !== undefined) {
    await writeFixture(target, {
      key: 'chain',
      input: { kind: 'chain', scope: { kind: 'global' }, title: '检索重放思维链', group: [stepOne, stepTwo] },
    })
  }

  const required = (key: string): Entity => {
    const entity = ids.get(key)
    if (entity === undefined) throw new Error(`shadow 夹具缺失：${key}`)
    return entity
  }
  const preferences = ['pref-1', 'pref-2', 'pref-3'].map(key => {
    const entity = required(key)
    return { id: entity.id, title: attributeString(entity, 'title'), revision: entity.revision }
  })
  const states = ['state-progress', 'state-blocked', 'state-waiting'].map(key => {
    const entity = required(key)
    return {
      id: entity.id,
      title: attributeString(entity, 'title'),
      status: attributeString(entity, 'status') as StateStatus,
    }
  })
  const retrieval: Record<string, string> = {}
  for (const key of [
    'deploy-memory',
    'checklist-memory',
    'vector-memory',
    'plain-memory',
    'approval-memory',
    'single-char-memory',
    'chain-step-1',
    'chain-step-2',
  ]) {
    retrieval[key] = required(key).id
  }
  return { preferences, states, retrieval }
}

function attributeString(entity: Entity, name: string): string {
  for (const attribute of entity.attributes) {
    if (attribute.name !== name) continue
    if (attribute.value.kind !== 'static') return ''
    return typeof attribute.value.value === 'string' ? attribute.value.value : ''
  }
  return ''
}

// ---------------------------------------------------------------------------
// 汇总 / 输出
// ---------------------------------------------------------------------------

export function summarizeShadow(input: {
  readonly boards: readonly BoardShadowSection[]
  readonly retrieval?: RetrievalShadowSection | undefined
  readonly blockedReason?: string | undefined
}): ShadowSummary {
  if (input.blockedReason !== undefined) {
    return { verdict: 'inconclusive', exitCode: 1, reasons: [input.blockedReason] }
  }
  const reasons: string[] = []
  const sections: { readonly label: string; readonly verdict: ShadowVerdict; readonly reasons: readonly string[] }[] = []
  for (const board of input.boards) {
    sections.push({ label: `${board.projection}(${board.scope})`, verdict: board.verdict, reasons: board.reasons })
  }
  const retrieval = input.retrieval
  // 明确跳过的段（只读/不可抛弃库）不参与判定：报告已写清“没比”，不能算 PASS 证据。
  if (retrieval !== undefined && retrieval.skipped === undefined) {
    sections.push({ label: 'retrieval', verdict: retrieval.verdict, reasons: retrieval.reasons })
  }
  for (const section of sections) {
    if (section.reasons.length === 0 && section.verdict !== 'consistent') {
      // 不允许出现“FAIL/INCONCLUSIVE 但没有任何原因”的段：报告要能解释自己。
      reasons.push(`${section.label}: ${section.verdict}（该段没有给出原因）`)
      continue
    }
    for (const reason of section.reasons) reasons.push(`${section.label}: ${reason}`)
  }
  if (sections.length === 0) {
    return { verdict: 'inconclusive', exitCode: 1, reasons: [...reasons, 'no-sections: 没有任何实际执行的比对'] }
  }
  const verdict: ShadowVerdict = sections.some(section => section.verdict === 'divergent')
    ? 'divergent'
    : sections.some(section => section.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'consistent'
  return { verdict, exitCode: verdict === 'consistent' ? 0 : 1, reasons }
}

export function buildShadowReport(input: ShadowReportInput): ShadowReport {
  const summary = summarizeShadow({
    boards: input.boards,
    ...(input.retrieval === undefined ? {} : { retrieval: input.retrieval }),
    ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
  })
  return {
    schema: SHADOW_SCHEMA,
    generatedAt: new Date().toISOString(),
    database: input.database,
    projectKey: input.projectKey,
    boards: input.boards,
    ...(input.retrieval === undefined ? {} : { retrieval: input.retrieval }),
    verdict: summary.verdict,
    reasons: summary.reasons,
    exitCode: summary.exitCode,
  }
}

function formatValue(value: string | number | null): string {
  return value === null ? 'null' : String(value)
}

function verdictLabel(verdict: ShadowVerdict): string {
  if (verdict === 'consistent') return 'PASS'
  if (verdict === 'divergent') return 'FAIL'
  return 'INCONCLUSIVE'
}

/** 人读摘要：结论 + 每段计数 + 差异明细（最多 50 条，完整明细在 JSON 里）。 */
export function formatHumanSummary(report: ShadowReport): string {
  const lines: string[] = []
  lines.push(
    `[shadow] schema=${report.schema} 数据库=${report.database.name ?? 'unknown'} disposable=${report.database.disposable} readOnly=${report.database.readOnly} mode=${report.database.mode}`,
  )
  lines.push(`[shadow] 项目键=${report.projectKey}`)
  if (report.boards.length === 0 && (report.retrieval === undefined || report.retrieval.skipped !== undefined)) {
    // 连接前被拒（生产库未声明只读）/没有实际执行的段：原因在顶层 reasons 里。
    if (report.reasons.length > 0) lines.push(`[shadow] 未执行原因：${report.reasons.join('；')}`)
  }
  for (const board of report.boards) {
    const fallback = board.fallback.needed ? ` fallback=${board.fallback.reason ?? 'yes'}` : ''
    lines.push(
      `[看板] ${board.projection} scope=${board.scope} ${board.verdict} 写模型=${board.writeModelCount} 读模型=${board.readModelCount} 比对=${board.compared} 未投影=${board.unprojectedCount} 真差异=${board.divergentCount}${fallback}`,
    )
    for (const reason of board.reasons) lines.push(`  - 原因：${reason}`)
    for (const diff of board.diffs) {
      const fields = diff.fields === undefined
        ? ''
        : ` 字段=${diff.fields.map(field => `${field.field}(写=${formatValue(field.writeModel)},读=${formatValue(field.readModel)})`).join(';')}`
      const task = diff.projectionTask === undefined ? '' : ` task=${diff.projectionTask.status}@${diff.projectionTask.revision}`
      lines.push(`  - ${diff.kind}/${diff.cause} ${diff.entityId}${task}${fields}`)
    }
  }
  const retrieval = report.retrieval
  if (retrieval === undefined) {
    lines.push(`[检索重放] 未执行（mode=${report.database.mode}）`)
  } else if (retrieval.skipped !== undefined) {
    lines.push(`[检索重放] 跳过：${retrieval.skipped}`)
    for (const reason of retrieval.reasons) lines.push(`  - 原因：${reason}`)
  } else {
    lines.push(
      `[检索重放] ${retrieval.verdict} 查询=${retrieval.queryCount} 有命中=${retrieval.queriesWithHits} 命中总数=${retrieval.totalHits} 差异=${retrieval.differences.length} 通道=${retrieval.channels.join(',') || '无'}`,
    )
    for (const reason of retrieval.reasons) lines.push(`  - 原因：${reason}`)
    for (const query of retrieval.queries) {
      if (query.differences.length === 0) continue
      lines.push(`  - 查询 ${query.name}（${query.query}）命中 ${query.recallHits} vs ${query.replayHits}，差异 ${query.differences.length}`)
      for (const difference of query.differences) {
        const entity = difference.entityId === undefined ? '' : ` ${difference.entityId}`
        const channel = difference.channel === undefined ? '' : ` ${difference.channel}`
        lines.push(
          `    · ${difference.kind}${entity}${channel} recall=${formatValue(difference.recall)} replay=${formatValue(difference.replay)}`,
        )
      }
    }
  }
  lines.push(`[shadow] 结论: ${verdictLabel(report.verdict)} (exit ${report.exitCode})`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 一键运行
// ---------------------------------------------------------------------------

export interface ShadowCompareOptions {
  readonly databaseUrl: string
  readonly projectKey?: string
  readonly mode?: ShadowMode
  readonly readOnly?: boolean
  readonly limit?: number
  readonly jsonPath?: string
}

/** 机器可读的跳过码留在 `skipped`，人读解释放 `reasons`：调用方不该解析长句子。 */
function emptyRetrievalSection(skipped: string, reason: string): RetrievalShadowSection {
  return {
    verdict: 'inconclusive',
    reasons: [`skipped: ${reason}`],
    queryCount: 0,
    queriesWithHits: 0,
    totalHits: 0,
    channels: [],
    queries: [],
    differences: [],
    skipped,
  }
}

/**
 * 一次完整 shadow compare。
 *
 * 安全顺序：库名判定在**任何连接之前**；只有可抛弃库才 migrate/清库/造夹具/跑 worker。
 * 只读模式不造数据、不跑检索重放（`recall` 会写 `recall_event` 与访问计数）。
 */
export async function runShadowCompare(options: ShadowCompareOptions): Promise<ShadowReport> {
  const databaseUrl = options.databaseUrl
  const name = databaseNameOf(databaseUrl)
  const disposable = name !== undefined && isDisposableDatabaseName(name)
  const readOnly = options.readOnly === true
  const mode = options.mode ?? 'all'
  const projectKey = options.projectKey ?? DEFAULT_SHADOW_PROJECT_KEY
  const database: ShadowDatabaseInfo = {
    ...(name === undefined ? {} : { name }),
    disposable,
    readOnly,
    mode,
  }
  if (!disposable && !readOnly) {
    return buildShadowReport({
      database,
      projectKey,
      boards: [],
      blockedReason: `database-not-disposable: ${name ?? 'unknown'} 不是可抛弃的测试/基准库（名称必须含 test/bench 段）；只读比对请显式传 --read-only`,
    })
  }

  if (disposable && !readOnly) {
    // 与 bench/测试同一道守卫：只有库名命中 test/bench 段才允许清库；生产库名在连接前已被拒绝。
    process.env.OMB_ALLOW_DESTRUCTIVE ??= '1'
    await migrateDatabase(databaseUrl)
  }

  const target = openShadowTarget(databaseUrl)
  const boards: BoardShadowSection[] = []
  let retrieval: RetrievalShadowSection | undefined
  try {
    if (disposable && !readOnly) {
      await resetShadowDatabase(target)
      await seedShadowFixtures(target, { projectKey })
      await drainProjections(target)
    }
    const limit = clampBoardLimit(options.limit ?? MAX_BOARD_LIMIT)
    if (mode !== 'retrieval') {
      boards.push(await compareBoardShadow(target.boards, {
        kind: 'preference',
        scope: { kind: 'global' },
        limit,
      }))
      boards.push(await compareBoardShadow(target.boards, {
        kind: 'state',
        scope: { kind: 'project', projectKey },
        limit,
      }))
    }
    if (mode !== 'boards') {
      if (readOnly) {
        retrieval = emptyRetrievalSection(
          'read-only',
          'read-only: recall/recallFromPlan 会写 recall_event 与访问计数，只读模式不重放',
        )
      } else if (disposable) {
        retrieval = await runRetrievalShadow(target.engine, shadowQuerySpecs(projectKey))
      } else {
        retrieval = emptyRetrievalSection('database-not-disposable', 'database-not-disposable: 不写 recall_event')
      }
    }
  } finally {
    await target.close()
  }

  const report = buildShadowReport({
    database,
    projectKey,
    boards,
    ...(retrieval === undefined ? {} : { retrieval }),
  })
  if (options.jsonPath !== undefined) {
    await writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  return report
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly readOnly: boolean
  readonly mode: ShadowMode
  readonly jsonPath?: string
  readonly limit?: number
  readonly projectKey?: string
  readonly help: boolean
}

function parseCli(argv: readonly string[]): CliOptions {
  let readOnly = false
  let mode: ShadowMode = 'all'
  let jsonPath: string | undefined
  let limit: number | undefined
  let projectKey: string | undefined
  let help = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--read-only') {
      readOnly = true
      continue
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length)
      if (value !== 'all' && value !== 'boards' && value !== 'retrieval') {
        throw new Error(`--mode 只支持 all/boards/retrieval，实际：${value}`)
      }
      mode = value
      continue
    }
    if (arg === '--mode') {
      const value = argv[index + 1]
      if (value !== 'all' && value !== 'boards' && value !== 'retrieval') {
        throw new Error(`--mode 只支持 all/boards/retrieval，实际：${String(value)}`)
      }
      mode = value
      index += 1
      continue
    }
    if (arg.startsWith('--json=')) {
      jsonPath = arg.slice('--json='.length)
      continue
    }
    if (arg === '--json') {
      jsonPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length))
      continue
    }
    if (arg === '--limit') {
      limit = Number(argv[index + 1])
      index += 1
      continue
    }
    if (arg.startsWith('--project-key=')) {
      projectKey = arg.slice('--project-key='.length)
      continue
    }
    if (arg === '--project-key') {
      projectKey = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`未知参数：${arg}（--help 查看用法）`)
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new Error('--limit 必须是正整数')
  return {
    readOnly,
    mode,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    ...(limit === undefined ? {} : { limit }),
    ...(projectKey === undefined ? {} : { projectKey }),
    help,
  }
}

function printHelp(): void {
  console.log(`用法：pnpm v7:shadow [--read-only] [--mode=all|boards|retrieval] [--json <path>] [--limit N] [--project-key <key>]

默认目标库：${DEFAULT_SHADOW_DATABASE_URL}（名称含 test 段，会建库/清库/造夹具/跑投影 worker）
生产库名必须先传 --read-only（只比两块看板，不写任何表、不跑检索重放）
环境变量：OMB_SHADOW_DATABASE_URL / OMB_SHADOW_PROJECT_KEY

退出码：0 = 全部一致；1 = 有差异，或空库/未投影/查询数不足等无证据情形。`)
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseCli(argv)
  if (options.help) {
    printHelp()
    return 0
  }
  const databaseUrl = process.env.OMB_SHADOW_DATABASE_URL ?? DEFAULT_SHADOW_DATABASE_URL
  const projectKey = options.projectKey ?? process.env.OMB_SHADOW_PROJECT_KEY
  const report = await runShadowCompare({
    databaseUrl,
    readOnly: options.readOnly,
    mode: options.mode,
    ...(projectKey === undefined ? {} : { projectKey }),
    ...(options.jsonPath === undefined ? {} : { jsonPath: options.jsonPath }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })
  console.log(formatHumanSummary(report))
  console.log('--- JSON ---')
  console.log(JSON.stringify(report, null, 2))
  return report.exitCode
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().then(
    exitCode => {
      process.exitCode = exitCode
    },
    error => {
      console.error(`[shadow] 运行失败：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
