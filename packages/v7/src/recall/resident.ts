import { newId } from '../domain/ids.js'
import type { StateStatus } from '../domain/entity.js'
import { estimateTokens } from '../domain/text.js'
import {
  CONTEXT_HEADER,
  createPromptAssembler,
  type EntityReceipt,
  type InjectionReceipt,
} from '../prompt/assembler.js'
import { dataBlock, type ContextBlock } from '../prompt/blocks.js'
import type { RecallEngine } from '../retrieval/engine.js'
import type { RecallHit, RecallResult, RecallScenario } from '../retrieval/types.js'
import type { RuntimeContext } from '../ports/context.js'
import { keptEntityIds, withEntityReceipts } from './receipts.js'
import type {
  EntitySummary,
} from '../ports/search.js'
import type {
  ResidentTraceInput,
  ResidentTraceSection,
  StoreStats,
} from '../ports/observability.js'

export const DEFAULT_RESIDENT_BUDGET = 600
/** 读模型等待预算：超时立即回退写模型，不把整个 T0 预算耗在读模型上。 */
const DEFAULT_RESIDENT_BOARDS_TIMEOUT_MS = 250
/**
 * 看板水位超龄门槛。
 *
 * 判据是“水位比现在老这么久 **且** 还有没投影的源行”：只靠年龄会把“长时间没写”
 * 误判成停摆（那时读模型并没有落后），两者一起才说明 worker 真的停在那里、读模型在静默变旧。
 */
const DEFAULT_BOARDS_WATERMARK_MAX_AGE_MS = 30_000
/** T0 偏好/状态的条数上限；预算裁剪仍由 token 预算决定。 */
const RESIDENT_PREFERENCE_LIMIT = 5
const RESIDENT_STATE_LIMIT = 5

/** 一条被实际注入的命中；用于 recall_event + 采用证据。 */
interface ResidentHit {
  readonly id: string
  readonly title?: string
  /** 注入时的实体更新时间：之后实体被改/归档就不能再升 Validated。 */
  readonly updatedAt?: string
}

export interface RecallNotice {
  readonly traceId: string
  readonly hits: readonly ResidentHit[]
  /** T1 本次注入的装配 receipt；adoption 只认这里的 kept（且不含被隔离的块）。 */
  readonly receipt?: InjectionReceipt
  /** 实际注入文本；`receipt.textHash` 与它一一对应，持久化时一起落库。 */
  readonly text?: string
}

export type RecallNoticeSink = (notice: RecallNotice) => void

/**
 * T0 需要的最小看板行形状。`app/projections` 的 `BoardItem` 是它的超集；
 * recall 层不 import 上层类型，`ProjectionReadApi` 在组合根按结构满足。
 */
interface ResidentBoardItem {
  readonly entityId: string
  readonly title?: string
  readonly summary?: string
  readonly status?: StateStatus
  readonly updatedAt?: string
}

export interface ResidentBoardsQuery {
  readonly projectKey?: string
  readonly preferenceLimit?: number
  readonly stateLimit?: number
}

/**
 * 一块看板的新鲜度（由读模型实现方提供）：水位年龄 + 仍未投影的源行数。
 *
 * recall 层不查库，也不认识 PostgreSQL；它只按这两个事实判断“读模型是否停摆”。
 */
export interface ResidentBoardFreshness {
  /** `now - watermark`（毫秒）；从未成功投影过时缺省。 */
  readonly watermarkAgeMs?: number
  /** 仍未被投影的源行数；>0 说明读模型可能落后于写模型。 */
  readonly unprojected: number
}

export interface ResidentBoardsSnapshot {
  readonly preference: readonly ResidentBoardItem[]
  readonly state: readonly ResidentBoardItem[]
  /** 偏好看板的新鲜度；读取器不提供时缺省（退化为旧的“只看空/错/超时”语义）。 */
  readonly preferenceFreshness?: ResidentBoardFreshness
  readonly stateFreshness?: ResidentBoardFreshness
}

/**
 * T0 优先读取的投影看板（消费方定义的窄端口）。
 *
 * 实现方是 plugin 组合根里的「ProjectionReadApi + 看板新鲜度」组合：两块看板各一条
 * SQL、新鲜度一条 SQL，不带 lag/token 等待。失败、超时、两块都为空或水位停摆时由
 * buildResident 回退到 engine/stats 旧路径并在 trace 里标来源，绝不静默返回读模型空结果。
 */
export interface ResidentBoardsReader {
  readResidentBoards(query: ResidentBoardsQuery): Promise<ResidentBoardsSnapshot>
}

export interface ResidentBoardsOptions {
  readonly reader: ResidentBoardsReader
  readonly timeoutMs?: number
  /** 水位超龄门槛（毫秒），默认 30s；只和“还有未投影任务”一起判停摆。 */
  readonly maxWatermarkAgeMs?: number
}

/** trace 里一段内容的来源：读模型，或读模型不可用时的写模型回退。 */
type ResidentSectionSource = 'read-model' | 'write-model'

/** persisted 在 `resident_trace.sections`（JSONB）里的来源/回退证据。 */
interface ResidentTraceSectionDetail extends ResidentTraceSection {
  readonly source?: ResidentSectionSource
  /** 已尝试读模型但回退时的原因；读模型命中或未注入读取器时缺省。 */
  readonly fallbackReason?: string
  /** 该段被注入的是隔离说明而不是原文（高风险）。 */
  readonly quarantined?: boolean
  /** 该段在预算内被截断（当前 T0 整段保留/丢弃，故通常缺省）。 */
  readonly truncated?: boolean
}

/** 带来源标注的 T0 trace；结构上仍是 `ResidentTraceInput`（多出的字段随 sections 落库）。 */
export interface ResidentTrace extends Omit<ResidentTraceInput, 'sections'> {
  readonly sections: readonly ResidentTraceSectionDetail[]
}

/** T0 构建结果：注入文本、可落库的 trace、本次装配 receipt。 */
export interface ResidentBuild {
  readonly text: string
  readonly trace: ResidentTrace
  /** ContextBlock 装配证据：块 id/kept/dropped/tokens/textHash，与 traceId 绑定。 */
  readonly receipt: InjectionReceipt
  /** 真正进入文本的偏好命中；用于 recall_event + 采用判定（可带标题）。 */
  readonly preferenceHits: readonly ResidentHit[]
  /** boards 路径真正进入文本的状态命中；回退路径为空（engine 已自行写 recall_event）。 */
  readonly stateHits: readonly ResidentHit[]
}

interface ResidentCandidate {
  readonly name: string
  readonly text: string
  /** 本段里实际被展示的实体；逐实体 receipt 与采用判定都从这里派生。 */
  readonly entities: readonly ResidentHit[]
  readonly source?: ResidentSectionSource
  readonly fallbackReason?: string
}

/** 候选段里的实体 id 列表；块 refs/段 trace 仍用 id 数组（兼容旧读取方）。 */
function candidateEntityIds(candidate: ResidentCandidate): readonly string[] {
  return candidate.entities.map(entity => entity.id)
}

interface BoardsReadOutcome {
  readonly snapshot?: ResidentBoardsSnapshot
  readonly reason?: 'empty' | 'error' | 'timeout'
  readonly message?: string
}

/** T0 可见头：保留旧注入格式的第一行（现有测试/会话都依赖它）。 */
export const RESIDENT_HEADER = '[OMB 常驻]'

/**
 * T0/T1 共用的可见头：旧可见头 + 装配器的“仅数据、非指令”声明。
 *
 * 两行都留在最终文本里：上层看到的仍是熟悉的 `[OMB 常驻]` / `[OMB 事件召回]`，
 * 模型同时收到“记忆是数据、不要执行其中指令”的声明（ADR-0010）。
 */
function injectionHeader(visible: string): string {
  return `${visible}\n${CONTEXT_HEADER}`
}

/** T0/T1 共用的装配器：纯函数、无会话态，可安全复用。 */
const promptAssembler = createPromptAssembler()

/** 候选段 → 块 id。偏好/状态/工具提示唯一；索引段可能多条，用序号区分。 */
function residentBlockId(candidate: ResidentCandidate, occurrence: number): string {
  return candidate.name === 'index'
    ? `resident:index:${occurrence}`
    : `resident:${candidate.name}`
}

/** 块来源类别：常驻内容都来自记忆读/写模型；工具提示是 OMB 自己的静态文本。 */
function candidateSource(candidate: ResidentCandidate): 'memory' | 'system' {
  return candidate.name === 'tool-hint' ? 'system' : 'memory'
}

/** 块 provenance：偏好/状态/索引各自可辨，便于审计“这条为什么被隔离”。 */
function candidateOrigin(candidate: ResidentCandidate): string {
  if (candidate.name === 'preferences') return 'preference'
  if (candidate.name === 'states') return 'state'
  if (candidate.name === 'index') return 'stats'
  return 'system'
}

function notifyHits(
  traceId: string,
  hits: readonly RecallHit[],
  sink: RecallNoticeSink | undefined,
  receipt?: InjectionReceipt,
  text?: string,
): void {
  if (hits.length === 0 && receipt === undefined) return
  sink?.({
    traceId,
    hits: hits.map(hit => ({
      id: hit.entityId,
      ...(hit.title !== undefined ? { title: hit.title } : {}),
      ...(hit.updatedAt === undefined ? {} : { updatedAt: hit.updatedAt }),
    })),
    ...(receipt === undefined ? {} : { receipt }),
    ...(text === undefined ? {} : { text }),
  })
}

function notify(result: RecallResult | undefined, sink: RecallNoticeSink | undefined): void {
  if (result === undefined) return
  notifyHits(result.traceId, result.hits, sink)
}

const HIT_TEXT_LIMIT = 100

/** 标题/摘要压成一行并截到约 100 字，避免单条命中吃掉整个 T1 预算。 */
function compactHitText(input: string): string {
  const text = input.replace(/\s+/g, ' ').trim()
  if (text.length <= HIT_TEXT_LIMIT) return text
  let end = HIT_TEXT_LIMIT
  // 不把代理对（emoji 等）截成半个字符。
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

function compactHit(hit: RecallHit): string {
  const label = [hit.category, hit.status].filter(value => value !== undefined).join('/')
  const title = (hit.title ?? '').trim()
  const head = compactHitText(title.length > 0 ? title : hit.snippet)
  // 标题与摘要都为空时这条没有可辨识内容；输出空壳只会浪费预算。
  if (head.length === 0) return ''
  return `${label.length > 0 ? `[${label}] ` : ''}${head}（${hit.entityId}）`
}

/** 一个会被展示的实体（id + 可辨识标题/更新时间）；逐实体 receipt 的最小来源。 */
function residentEntity(id: string, title?: string, updatedAt?: string): ResidentHit {
  const trimmed = title?.trim()
  return {
    id,
    ...(trimmed !== undefined && trimmed.length > 0 ? { title: trimmed } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function compactSummaries(items: readonly EntitySummary[], prefix: string, max: number): ResidentCandidate | undefined {
  if (items.length === 0) return undefined
  const kept = items.slice(0, max)
  return {
    name: 'preferences',
    text: `${prefix}${kept.map(item => `${item.title ?? item.snippet}（${item.id}）`).join('；')}`,
    entities: kept.map(item => residentEntity(item.id, item.title, item.updatedAt)),
  }
}

function compactHits(result: RecallResult | undefined, prefix: string, max: number): ResidentCandidate | undefined {
  if (result === undefined || result.hits.length === 0) return undefined
  const kept: { readonly text: string; readonly hit: ResidentHit }[] = []
  const seen = new Set<string>()
  for (const hit of result.hits) {
    if (seen.has(hit.entityId)) continue
    const text = compactHit(hit)
    if (text.length === 0) continue
    seen.add(hit.entityId)
    kept.push({
      text,
      hit: residentEntity(hit.entityId, hit.title, hit.updatedAt),
    })
    if (kept.length >= max) break
  }
  if (kept.length === 0) return undefined
  return {
    name: 'states',
    text: `${prefix}${kept.map(item => item.text).join('；')}`,
    entities: kept.map(item => item.hit),
  }
}

/** 看板偏好段：与旧 `compactSummaries` 同格式；行来自 `preference_board`，无 snippet 时用 summary。 */
function compactBoardSummaries(
  items: readonly ResidentBoardItem[],
  prefix: string,
  max: number,
): ResidentCandidate | undefined {
  const kept: ResidentHit[] = []
  const parts: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.entityId)) continue
    const label = (item.title ?? item.summary ?? '').replace(/\s+/g, ' ').trim()
    // 标题/摘要都为空的行没有可辨识内容，注入只会浪费预算。
    if (label.length === 0) continue
    seen.add(item.entityId)
    const title = item.title?.trim()
    kept.push({
      id: item.entityId,
      ...(title !== undefined && title.length > 0 ? { title } : {}),
      ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
    })
    parts.push(`${label}（${item.entityId}）`)
    if (kept.length >= max) break
  }
  if (kept.length === 0) return undefined
  return {
    name: 'preferences',
    text: `${prefix}${parts.join('；')}`,
    entities: kept,
  }
}

/** 看板状态段：只保留当前项目的 in_progress/blocked/waiting（看板行的状态谓词由投影保证，这里再兜一层）。 */
function compactBoardStates(
  items: readonly ResidentBoardItem[],
  prefix: string,
  max: number,
): ResidentCandidate | undefined {
  const kept: { readonly text: string; readonly id: string; readonly title?: string }[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.entityId)) continue
    const status = item.status
    if (status !== 'in_progress' && status !== 'blocked' && status !== 'waiting') continue
    const title = item.title?.trim()
    // 看板行没有 snippet 兜底：没有标题就没有可注入内容。
    const head = compactHitText(title ?? '')
    if (head.length === 0) continue
    seen.add(item.entityId)
    kept.push({ text: `[${status}] ${head}（${item.entityId}）`, id: item.entityId, ...(title !== undefined ? { title } : {}) })
    if (kept.length >= max) break
  }
  if (kept.length === 0) return undefined
  return {
    name: 'states',
    text: `${prefix}${kept.map(item => item.text).join('；')}`,
    entities: kept.map(item => residentEntity(item.id, item.title)),
  }
}

/** 错误信息压成一行并限长：trace 要能定位回退原因，但不能塞进整段驱动错误。 */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const text = message.replace(/\s+/g, ' ').trim()
  return text.length <= 160 ? text : `${text.slice(0, 160)}…`
}

/**
 * 读投影看板，带独立超时：失败/超时/两块都为空都换算成可写进 trace 的回退原因。
 *
 * 空结果不能直接当“没有偏好/状态”：投影未回填或 worker 未处理时两块都是空的，
 * 那正是必须回退写模型的时刻（不是静默注入空 T0）。
 */
async function readBoardsWithTimeout(
  reader: ResidentBoardsReader,
  query: ResidentBoardsQuery,
  timeoutMs: number,
): Promise<BoardsReadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<{ readonly kind: 'timeout' }>(resolve => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), clampTimeout(timeoutMs))
    })
    const result = await Promise.race([
      reader.readResidentBoards(query).then(
        snapshot => ({ kind: 'ok' as const, snapshot }),
        error => ({ kind: 'error' as const, error }),
      ),
      timeout,
    ])
    if (result.kind === 'timeout') return { reason: 'timeout' }
    if (result.kind === 'error') return { reason: 'error', message: errorText(result.error) }
    const { snapshot } = result
    if (snapshot.preference.length === 0 && snapshot.state.length === 0) return { reason: 'empty' }
    return { snapshot }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function clampTimeout(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : DEFAULT_RESIDENT_BOARDS_TIMEOUT_MS
}

function fallbackReasonOf(outcome: BoardsReadOutcome): string {
  if (outcome.reason === 'error') {
    return outcome.message === undefined ? 'read-model-error' : `read-model-error: ${outcome.message}`
  }
  if (outcome.reason === 'timeout') return 'read-model-timeout'
  return 'read-model-empty'
}

/**
 * 水位停摆判据：某块看板“水位比门槛老 **且** 还有未投影任务”时读模型在静默变旧。
 *
 * 只看年龄不够：长时间没有写入时水位同样很老，但读模型并没有落后，回退写模型只会
 * 白花查询并让日志噪音常驻。两者同时成立才是 worker 停在那里。
 *
 * 也不看“这块看板有没有读到行”：停摆时新写的行根本还没投影进来，读到 0 行恰恰是
 * 最该回退的情形（缺失行同样是旧读）。
 */
function watermarkStaleReason(
  snapshot: ResidentBoardsSnapshot,
  maxWatermarkAgeMs: number,
): string | undefined {
  const limit = Number.isFinite(maxWatermarkAgeMs) ? Math.max(1, Math.trunc(maxWatermarkAgeMs)) : DEFAULT_BOARDS_WATERMARK_MAX_AGE_MS
  const boards: readonly [string, ResidentBoardFreshness | undefined][] = [
    ['preference_board', snapshot.preferenceFreshness],
    ['state_board', snapshot.stateFreshness],
  ]
  for (const [projection, freshness] of boards) {
    if (freshness === undefined) continue
    if (freshness.unprojected <= 0) continue
    const age = freshness.watermarkAgeMs
    if (age === undefined || age <= limit) continue
    return `read-model-watermark-stale: ${projection} watermarkAgeMs=${Math.trunc(age)} unprojected=${freshness.unprojected}`
  }
  return undefined
}

function indexCandidates(index: StoreStats | undefined): ResidentCandidate[] {
  if (index === undefined) return []
  const candidates: ResidentCandidate[] = [{
    name: 'index',
    text: `库索引：memory ${index.memory}、state ${index.state}、chain ${index.chain}、archived ${index.archived}`,
    entities: [],
  }]
  if (index.categories !== undefined) {
    candidates.push({
      name: 'index',
      text: `分类：fact ${index.categories.fact}、clue ${index.categories.clue}、event ${index.categories.event}`,
      entities: [],
    })
  }
  if (index.scopes !== undefined) {
    candidates.push({
      name: 'index',
      text: `作用域：global ${index.scopes.global}、project ${index.scopes.project}`,
      entities: [],
    })
  }
  if (index.recentStates !== undefined && index.recentStates.length > 0) {
    candidates.push({
      name: 'index',
      text: `最近状态：${index.recentStates.map(item => `${item.title ?? item.id}(${item.status})`).join('；')}`,
      entities: index.recentStates.map(item => residentEntity(item.id, item.title)),
    })
  }
  if (index.attrNames.length > 0) {
    candidates.push({
      name: 'index',
      text: `常用属性：${index.attrNames.slice(0, 8).join('、')}`,
      entities: [],
    })
  }
  return candidates
}

function toTraceSection(candidate: ResidentCandidate, kept: boolean, tokens: number): ResidentTraceSectionDetail {
  return {
    name: candidate.name,
    tokens,
    kept,
    text: candidate.text,
    entityIds: candidateEntityIds(candidate),
    ...(candidate.source === undefined ? {} : { source: candidate.source }),
    ...(candidate.fallbackReason === undefined ? {} : { fallbackReason: candidate.fallbackReason }),
  }
}

/**
 * T0 逐实体 receipt：块 kept 且未被隔离 → `kept`；块 kept 但被隔离 → `quarantined`。
 *
 * 被预算丢弃的段（`kept:false`）、没有实体的索引行/工具提示、以及被隔离块的原文
 * 都不产生 `kept` 条目；未实际展示的实体不记。同一实体在一次注入里由
 * `withEntityReceipts` 再去重（kept 优先）。
 */
function residentEntityReceipts(
  traceId: string,
  candidates: readonly ResidentCandidate[],
  blocks: readonly ContextBlock[],
  receipt: InjectionReceipt,
): EntityReceipt[] {
  const receiptById = new Map(receipt.blocks.map(item => [item.id, item]))
  const items: EntityReceipt[] = []
  candidates.forEach((candidate, index) => {
    const block = blocks[index]
    if (block === undefined) return
    const blockReceipt = receiptById.get(block.id)
    if (blockReceipt === undefined || !blockReceipt.kept) return
    const state: EntityReceipt['state'] = blockReceipt.quarantined ? 'quarantined' : 'kept'
    for (const entity of candidate.entities) {
      items.push({
        traceId,
        entityId: entity.id,
        section: candidate.name,
        state,
        blockId: block.id,
        ...(state === 'kept' && entity.title !== undefined ? { title: entity.title } : {}),
        ...(state === 'kept' && entity.updatedAt !== undefined ? { updatedAt: entity.updatedAt } : {}),
      })
    }
  })
  return items
}

/**
 * T0 常驻层：固定预算内注入偏好、当前项目进行中/阻塞/等待状态与一行工具提示。
 *
 * 有 `boards` 读取器时优先读投影读模型（两块看板各一条 SQL + 一条新鲜度 SQL，不跑六通道）；
 * 读模型失败/超时/两块都为空/水位超龄且还有未投影任务，都回退 engine/stats 的写模型路径，
 * 并在 trace 的 section.source/fallbackReason 里标出来源，不静默把空的或停摆的读模型当成“没有内容”。
 *
 * 返回值同时包含文本、trace 和 receipt：trace 记录每个候选段落是否被预算裁掉/被隔离，
 * 调用方负责落库；receipt 是本次 ContextBlock 装配的证据（block id/kept/dropped/tokens/
 * textHash），随 trace 一起可查。只读，不写 recall_event 的 adopted 字段。
 */
export async function buildResident(
  engine: RecallEngine,
  context: RuntimeContext,
  budgetTokens = DEFAULT_RESIDENT_BUDGET,
  stats?: () => Promise<StoreStats>,
  onRecall?: RecallNoticeSink,
  preferences?: () => Promise<EntitySummary[]>,
  boards?: ResidentBoardsOptions,
): Promise<ResidentBuild> {
  const projectKey = context.projectKey ?? context.cwd
  const toolHint: ResidentCandidate = {
    name: 'tool-hint',
    text: '需要细节用 omb_recall；长期结论用 omb_remember；状态更新用 omb_update。',
    entities: [],
  }

  let candidates: ResidentCandidate[]
  let recalledStates: RecallResult | undefined
  let fallbackReason: string | undefined
  let usedBoards = false

  const boardOutcome = boards === undefined
    ? undefined
    : await readBoardsWithTimeout(
        boards.reader,
        {
          ...(projectKey === undefined ? {} : { projectKey }),
          preferenceLimit: RESIDENT_PREFERENCE_LIMIT,
          stateLimit: RESIDENT_STATE_LIMIT,
        },
        boards.timeoutMs ?? DEFAULT_RESIDENT_BOARDS_TIMEOUT_MS,
      )

  // 读模型有行也可能已经落后：worker 停摆时水位不再前进。超龄且仍有未投影任务就回退写模型。
  const staleReason = boardOutcome?.snapshot === undefined
    ? undefined
    : watermarkStaleReason(
        boardOutcome.snapshot,
        boards?.maxWatermarkAgeMs ?? DEFAULT_BOARDS_WATERMARK_MAX_AGE_MS,
      )

  if (boardOutcome?.snapshot !== undefined && staleReason === undefined) {
    usedBoards = true
    const preferenceCandidate = compactBoardSummaries(
      boardOutcome.snapshot.preference,
      '偏好：',
      RESIDENT_PREFERENCE_LIMIT,
    )
    const stateCandidate = compactBoardStates(
      boardOutcome.snapshot.state,
      '当前状态：',
      RESIDENT_STATE_LIMIT,
    )
    // 读模型路径不查 stats：T0 的 SQL 预算就是两块看板各一条。
    candidates = [
      ...(preferenceCandidate === undefined ? [] : [{ ...preferenceCandidate, source: 'read-model' as const }]),
      ...(stateCandidate === undefined ? [] : [{ ...stateCandidate, source: 'read-model' as const }]),
      toolHint,
    ]
  } else {
    if (boardOutcome !== undefined) fallbackReason = staleReason ?? fallbackReasonOf(boardOutcome)
    const [preferenceItems, states, index] = await Promise.all([
      preferences === undefined ? Promise.resolve(undefined) : preferences().catch(() => undefined),
      projectKey === undefined ? Promise.resolve(undefined) : engine.recall({
        query: '当前项目 进行中 阻塞中',
        scenario: 'session-start',
        scope: 'project',
        projectKey,
        kind: 'state',
        status: ['in_progress', 'blocked'],
        limit: RESIDENT_STATE_LIMIT,
        // RET-11：状态看板只需要 state_board 一条通道；不能为 5 条状态跑完整六通道 +
        // 图扩展 + 重排富化。计划里的 providers.enabled 会记录这次限定，可审计。
        channels: ['state_board'],
        expand: 'none',
        sessionId: context.sessionId,
        injected: true,
      }).catch(() => undefined),
      stats === undefined ? Promise.resolve(undefined) : stats().catch(() => undefined),
    ])
    recalledStates = states
    candidates = [
      ...(preferenceItems === undefined ? [] : [compactSummaries(preferenceItems, '偏好：', RESIDENT_PREFERENCE_LIMIT)]),
      compactHits(states, '当前状态：', RESIDENT_STATE_LIMIT),
      ...indexCandidates(index),
      toolHint,
    ]
      .filter((candidate): candidate is ResidentCandidate => candidate !== undefined)
      // 回退路径的每一段都来自写模型；fallbackReason 只在真的尝试过读模型时出现。
      // tool-hint 是静态提示，不是数据来源，保持 source 缺省。
      .map(candidate => candidate.name === 'tool-hint'
        ? candidate
        : {
            ...candidate,
            source: 'write-model' as const,
            ...(fallbackReason === undefined ? {} : { fallbackReason }),
          })
  }

  const traceId = newId('trace')
  const headerText = injectionHeader(RESIDENT_HEADER)
  const headerTokens = estimateTokens(headerText)
  // 候选段先变成 ContextBlock：trust/risk 由 security/trust 分类，装配器只负责
  // 预算/去重/隔离/转义。常驻层是“整段要么进、要么不进”，所以 truncateBlocks=false。
  const blocks = candidates.map((candidate, index) => {
    const entityIds = candidateEntityIds(candidate)
    return dataBlock({
      id: residentBlockId(candidate, index),
      text: candidate.text,
      source: candidateSource(candidate),
      origin: candidateOrigin(candidate),
      entityIds,
      refs: entityIds,
      scope: { kind: 'global' },
    })
  })
  const assembled = promptAssembler.assemble(blocks, {
    budgetTokens,
    traceId,
    header: headerText,
    layout: 'inline',
    separator: '\n',
    truncateBlocks: false,
    maxBlockTokens: budgetTokens,
  })
  // 块级 receipt 之后补逐实体 receipt：同一段里有多个实体时，块级 kept 无法回答
  // “这个实体到底有没有被展示”。未展示/被丢弃的实体不产生条目。
  const entityReceipts = residentEntityReceipts(traceId, candidates, blocks, assembled.receipt)
  const receipt = withEntityReceipts(assembled.receipt, entityReceipts)
  const receiptById = new Map(receipt.blocks.map(item => [item.id, item]))
  const sections: ResidentTraceSectionDetail[] = [toTraceSection(
    { name: 'header', text: headerText, entities: [] },
    receipt.injected,
    headerTokens,
  )]
  const droppedSections: string[] = receipt.injected ? [] : ['header']
  const keptBlockIds = new Set<string>()
  candidates.forEach((candidate, index) => {
    const block = blocks[index]
    const blockReceipt = block === undefined ? undefined : receiptById.get(block.id)
    const kept = blockReceipt?.kept === true
    if (kept && block !== undefined) keptBlockIds.add(block.id)
    sections.push({
      ...toTraceSection(candidate, kept, blockReceipt?.tokens ?? 0),
      ...(blockReceipt?.quarantined === true ? { quarantined: true } : {}),
      ...(blockReceipt?.truncated === true ? { truncated: true } : {}),
    })
    if (!kept) droppedSections.push(candidate.name)
  })
  // receipt 与 trace 同行落库（resident_trace.sections 是现有的注入证据通道）。
  // 段级 entityIds 只列真正进入文本的实体；被隔离的实体在 receipt.entities 里标
  // quarantined，adoption 不会把它们当成已展示。
  const receiptEntityIds = keptEntityIds(receipt)
  sections.push({
    name: 'injection-receipt',
    tokens: receipt.usedTokens,
    kept: receipt.injected,
    text: JSON.stringify(receipt),
    entityIds: receiptEntityIds,
  })

  const preferenceBlock = candidates.findIndex(candidate => candidate.name === 'preferences')
  const stateBlock = candidates.findIndex(candidate => candidate.name === 'states')
  const preferenceBlockId = preferenceBlock < 0 ? undefined : residentBlockId(candidates[preferenceBlock] as ResidentCandidate, preferenceBlock)
  const stateBlockId = stateBlock < 0 ? undefined : residentBlockId(candidates[stateBlock] as ResidentCandidate, stateBlock)
  const blockVisible = (blockId: string | undefined): boolean => blockId !== undefined
    && keptBlockIds.has(blockId)
    && !receipt.quarantinedIds.includes(blockId)

  // 只有状态段真正进入文本时才登记召回（adoption 只认实际注入的命中）；读模型路径
  // 没有 engine trace，由 plugin 用 build 结果里的 stateHits 写 recall_event。
  if (recalledStates !== undefined && blockVisible(stateBlockId)) notify(recalledStates, onRecall)

  // 命中列表与逐实体 receipt 同源：段 kept 且未被隔离时，段里的实体都真的在文本里。
  const preferenceCandidate = preferenceBlock < 0 ? undefined : candidates[preferenceBlock]
  const stateCandidate = stateBlock < 0 ? undefined : candidates[stateBlock]
  const preferenceHits = blockVisible(preferenceBlockId) && preferenceCandidate !== undefined
    ? preferenceCandidate.entities
    : []
  const stateHits = usedBoards && blockVisible(stateBlockId) && stateCandidate !== undefined
    ? stateCandidate.entities
    : []

  return {
    text: assembled.text,
    trace: {
      // 独立 trace id：T0 与状态召回各自的 trace 不能混用，否则 adopted 归属不明。
      traceId,
      sessionId: context.sessionId,
      budgetTokens,
      usedTokens: receipt.usedTokens,
      text: assembled.text,
      sections,
      droppedSections,
    },
    receipt,
    preferenceHits,
    stateHits,
  }
}

/** 兼容旧调用方：只要文本时使用；需要 trace 的调用方用 buildResident。 */
export async function buildResidentText(
  engine: RecallEngine,
  context: RuntimeContext,
  budgetTokens = DEFAULT_RESIDENT_BUDGET,
  stats?: () => Promise<StoreStats>,
  onRecall?: RecallNoticeSink,
  preferences?: () => Promise<EntitySummary[]>,
  boards?: ResidentBoardsOptions,
): Promise<string> {
  return (await buildResident(engine, context, budgetTokens, stats, onRecall, preferences, boards)).text
}

const EVENT_RECALL_HEADER = '[OMB 事件召回]'
const EVENT_RECALL_PREFIX = '相关：'
const EVENT_RECALL_MAX_HITS = 3
/** T1 逐实体 receipt 的 section 名；T0 用 preferences/states/index。 */
export const EVENT_RECALL_SECTION = 'event-recall'

/**
 * T1 事件驱动层：把每条召回命中变成 ContextBlock，再经 PromptAssembler 装配。
 *
 * 对外格式保持既有可见头与单行正文：`[OMB 事件召回]`、`[OMB 记忆上下文…]`、
 * `相关：…`；预算、按 entityId 去重、header-only 不注入（RET-15）都由装配器保证。
 * 区别是：高风险命中只留隔离说明、adoption 只认 receipt 里 kept、未被隔离且最终
 * 文本仍能看到 entityId 的命中（未被预算截掉的才登记）。receipt 同时带逐实体
 * `entities`（kept/quarantined），与 T0 共用同一份读取契约。
 */
export async function buildEventRecallText(
  engine: RecallEngine,
  context: RuntimeContext,
  query: string,
  scenario: RecallScenario,
  budgetTokens = 400,
  onRecall?: RecallNoticeSink,
  excludeEntityIds?: ReadonlySet<string>,
): Promise<string> {
  if (query.trim().length === 0) return ''
  const projectKey = context.projectKey ?? context.cwd
  const result = await engine.recall({
    query,
    scenario,
    // 不强制 scope='project'（RET-03）：T1 要同时看到全局偏好/事实与当前项目。
    // state_board 通道在没有显式 scope 时仍按 projectKey 收窄，不会跨项目串状态。
    ...(projectKey !== undefined ? { projectKey } : {}),
    limit: 6,
    sessionId: context.sessionId,
    // T1 先检索、后由宿主实际追加消息；injected 由投递点 markRecallInjected 置 true，
    // 避免 pre-step reject/去重时把候选误记为已注入。
    injected: false,
  })
  if (result.hits.length === 0) return ''
  const compacted = compact(result, EVENT_RECALL_MAX_HITS, excludeEntityIds)
  if (compacted.length === 0) return ''
  const blocks = compacted.map(entry => dataBlock({
    id: entry.hit.entityId,
    text: entry.text,
    source: 'memory',
    entityIds: [entry.hit.entityId],
    refs: [entry.hit.entityId],
    scope: entry.hit.scope,
  }))
  const assembled = promptAssembler.assemble(blocks, {
    budgetTokens,
    traceId: result.traceId,
    header: injectionHeader(EVENT_RECALL_HEADER),
    layout: 'inline',
    prefix: EVENT_RECALL_PREFIX,
    separator: '；',
  })
  const text = assembled.text
  if (text.length === 0) return ''
  // T1 的每个块就是一个实体；逐实体证据与 T0 共用同一份 receipt 形状，
  // adoption 不再需要特判“T1 块 id 恰好是实体 id”。
  const receipt = withEntityReceipts(
    assembled.receipt,
    eventRecallEntityReceipts(result.traceId, compacted, assembled.receipt, text),
  )
  const kept = new Set(receipt.keptIds)
  const quarantined = new Set(receipt.quarantinedIds)
  // 空字符串代表本次不注入；只登记最终文本里仍可见的命中，避免预算截断/隔离后
  // 未展示的实体被 adoption 误判（RET-04）。receipt 随通知交给组合根持久化。
  const visible = compacted
    .map(entry => entry.hit)
    .filter(hit => kept.has(hit.entityId) && !quarantined.has(hit.entityId) && text.includes(hit.entityId))
  notifyHits(result.traceId, visible, onRecall, receipt, text)
  return text
}

/**
 * T1 逐实体 receipt：块 id 就是实体 id，`kept` 且文本里仍能看到 id 才算展示。
 *
 * 被隔离的块只注入了隔离说明，记 `quarantined`（原文没有进入提示词）；被预算丢弃
 * 或截断到看不到实体 id 的命中不记——与 visible/notify 的口径一致。
 */
function eventRecallEntityReceipts(
  traceId: string,
  compacted: readonly CompactedEventRecallHit[],
  receipt: InjectionReceipt,
  text: string,
): EntityReceipt[] {
  const receiptById = new Map(receipt.blocks.map(item => [item.id, item]))
  const items: EntityReceipt[] = []
  for (const entry of compacted) {
    const blockReceipt = receiptById.get(entry.hit.entityId)
    if (blockReceipt === undefined || !blockReceipt.kept) continue
    if (blockReceipt.quarantined) {
      items.push({
        traceId,
        entityId: entry.hit.entityId,
        section: EVENT_RECALL_SECTION,
        state: 'quarantined',
        blockId: entry.hit.entityId,
      })
      continue
    }
    if (!text.includes(entry.hit.entityId)) continue
    const title = entry.hit.title?.trim()
    items.push({
      traceId,
      entityId: entry.hit.entityId,
      section: EVENT_RECALL_SECTION,
      state: 'kept',
      blockId: entry.hit.entityId,
      ...(title !== undefined && title.length > 0 ? { title } : {}),
      ...(entry.hit.updatedAt === undefined ? {} : { updatedAt: entry.hit.updatedAt }),
    })
  }
  return items
}

interface CompactedEventRecallHit {
  readonly hit: RecallHit
  readonly text: string
}

/** 单行 `相关：...` 的条目：按 entityId 去重、跳过空标题、条数封顶，保持预算可预测。 */
function compact(
  result: RecallResult,
  max: number,
  excludeEntityIds?: ReadonlySet<string>,
): CompactedEventRecallHit[] {
  const seen = new Set<string>()
  const entries: CompactedEventRecallHit[] = []
  for (const hit of result.hits) {
    if (seen.has(hit.entityId)) continue
    if (excludeEntityIds?.has(hit.entityId) === true) continue
    const text = compactHit(hit)
    if (text.length === 0) continue
    seen.add(hit.entityId)
    entries.push({ hit, text })
    if (entries.length >= max) break
  }
  return entries
}
