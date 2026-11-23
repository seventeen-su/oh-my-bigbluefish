import { newId } from '../domain/ids.js'
import { estimateTokens } from '../domain/text.js'
import type { RecallEngine } from '../retrieval/engine.js'
import type { RecallHit, RecallResult, RecallScenario } from '../retrieval/types.js'
import type { RuntimeContext } from '../ports/context.js'
import type {
  EntitySummary,
  ResidentTraceInput,
  ResidentTraceSection,
  StoreStats,
} from '../ports/store.js'

export const DEFAULT_RESIDENT_BUDGET = 600

export interface RecallNotice {
  readonly traceId: string
  readonly hits: readonly { readonly id: string; readonly title?: string }[]
}

export type RecallNoticeSink = (notice: RecallNotice) => void

/** T0 构建结果：注入文本与可落库的 trace。 */
export interface ResidentBuild {
  readonly text: string
  readonly trace: ResidentTraceInput
  /** 真正进入文本的偏好命中；用于 recall_event + 采用判定（可带标题）。 */
  readonly preferenceHits: readonly { readonly id: string; readonly title?: string }[]
}

interface ResidentCandidate {
  readonly name: string
  readonly text: string
  readonly entityIds: readonly string[]
}

function notify(result: RecallResult | undefined, sink: RecallNoticeSink | undefined): void {
  if (result === undefined || result.hits.length === 0) return
  sink?.({
    traceId: result.traceId,
    hits: result.hits.map(hit => ({ id: hit.entityId, ...(hit.title !== undefined ? { title: hit.title } : {}) })),
  })
}

function compactHit(hit: RecallHit): string {
  const label = [hit.category, hit.status].filter(value => value !== undefined).join('/')
  const head = hit.title !== undefined && hit.title.length > 0 ? hit.title : hit.snippet
  return `${label.length > 0 ? `[${label}] ` : ''}${head}（${hit.entityId}）`
}

function compactSummaries(items: readonly EntitySummary[], prefix: string, max: number): ResidentCandidate | undefined {
  if (items.length === 0) return undefined
  const kept = items.slice(0, max)
  return {
    name: 'preferences',
    text: `${prefix}${kept.map(item => `${item.title ?? item.snippet}（${item.id}）`).join('；')}`,
    entityIds: kept.map(item => item.id),
  }
}

function compactHits(result: RecallResult | undefined, prefix: string, max: number): ResidentCandidate | undefined {
  if (result === undefined || result.hits.length === 0) return undefined
  const kept = result.hits.slice(0, max)
  return {
    name: 'states',
    text: `${prefix}${kept.map(compactHit).join('；')}`,
    entityIds: kept.map(hit => hit.entityId),
  }
}

function indexCandidates(index: StoreStats | undefined): ResidentCandidate[] {
  if (index === undefined) return []
  const candidates: ResidentCandidate[] = [{
    name: 'index',
    text: `库索引：memory ${index.memory}、state ${index.state}、chain ${index.chain}、archived ${index.archived}`,
    entityIds: [],
  }]
  if (index.categories !== undefined) {
    candidates.push({
      name: 'index',
      text: `分类：fact ${index.categories.fact}、clue ${index.categories.clue}、event ${index.categories.event}`,
      entityIds: [],
    })
  }
  if (index.scopes !== undefined) {
    candidates.push({
      name: 'index',
      text: `作用域：global ${index.scopes.global}、project ${index.scopes.project}`,
      entityIds: [],
    })
  }
  if (index.recentStates !== undefined && index.recentStates.length > 0) {
    candidates.push({
      name: 'index',
      text: `最近状态：${index.recentStates.map(item => `${item.title ?? item.id}(${item.status})`).join('；')}`,
      entityIds: index.recentStates.map(item => item.id),
    })
  }
  if (index.attrNames.length > 0) {
    candidates.push({
      name: 'index',
      text: `常用属性：${index.attrNames.slice(0, 8).join('、')}`,
      entityIds: [],
    })
  }
  return candidates
}

function toTraceSection(candidate: ResidentCandidate, kept: boolean, tokens: number): ResidentTraceSection {
  return {
    name: candidate.name,
    tokens,
    kept,
    text: candidate.text,
    entityIds: candidate.entityIds,
  }
}

/**
 * T0 常驻层：固定预算内注入偏好、当前项目进行中/阻塞状态与一行索引提示。
 *
 * 返回值同时包含文本和 trace：trace 记录每个候选段落是否被预算裁掉，调用方负责
 * 落库；只读，不写 recall_event 的 adopted 字段。
 */
export async function buildResident(
  engine: RecallEngine,
  context: RuntimeContext,
  budgetTokens = DEFAULT_RESIDENT_BUDGET,
  stats?: () => Promise<StoreStats>,
  onRecall?: RecallNoticeSink,
  preferences?: () => Promise<EntitySummary[]>,
): Promise<ResidentBuild> {
  const projectKey = context.projectKey ?? context.cwd
  const [preferenceItems, states, index] = await Promise.all([
    preferences === undefined ? Promise.resolve(undefined) : preferences().catch(() => undefined),
    projectKey === undefined ? Promise.resolve(undefined) : engine.recall({
      query: '当前项目 进行中 阻塞中',
      scenario: 'session-start',
      scope: 'project',
      projectKey,
      kind: 'state',
      status: ['in_progress', 'blocked'],
      limit: 5,
      sessionId: context.sessionId,
      injected: true,
    }).catch(() => undefined),
    stats === undefined ? Promise.resolve(undefined) : stats().catch(() => undefined),
  ])

  notify(states, onRecall)

  const candidates: ResidentCandidate[] = [
    { name: 'header', text: '[OMB 常驻]', entityIds: [] },
    ...(preferenceItems === undefined ? [] : [compactSummaries(preferenceItems, '偏好：', 5)]),
    compactHits(states, '当前状态：', 5),
    ...indexCandidates(index),
    {
      name: 'tool-hint',
      text: '需要细节用 omb_recall；长期结论用 omb_remember；状态更新用 omb_update。',
      entityIds: [],
    },
  ].filter((candidate): candidate is ResidentCandidate => candidate !== undefined)

  const sections: ResidentTraceSection[] = []
  const keptLines: string[] = []
  const droppedSections: string[] = []
  let used = 0
  for (const candidate of candidates) {
    const tokens = estimateTokens(candidate.text)
    const kept = used + tokens <= budgetTokens
    sections.push(toTraceSection(candidate, kept, tokens))
    if (!kept) {
      droppedSections.push(candidate.name)
      continue
    }
    keptLines.push(candidate.text)
    used += tokens
  }

  const preferenceSection = sections.find(section => section.name === 'preferences')
  const preferenceHits = preferenceSection?.kept === true
    ? (preferenceItems ?? []).slice(0, 5).map(item => ({
        id: item.id,
        ...(item.title !== undefined && item.title.length > 0 ? { title: item.title } : {}),
      }))
    : []

  return {
    text: keptLines.join('\n'),
    trace: {
      // 独立 trace id：T0 与状态召回各自的 trace 不能混用，否则 adopted 归属不明。
      traceId: newId('trace'),
      sessionId: context.sessionId,
      budgetTokens,
      usedTokens: used,
      text: keptLines.join('\n'),
      sections,
      droppedSections,
    },
    preferenceHits,
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
): Promise<string> {
  return (await buildResident(engine, context, budgetTokens, stats, onRecall, preferences)).text
}

/** T1 事件驱动层：用规则抽取后的查询做一次注入召回，超预算截断。 */
export async function buildEventRecallText(
  engine: RecallEngine,
  context: RuntimeContext,
  query: string,
  scenario: RecallScenario,
  budgetTokens = 400,
  onRecall?: RecallNoticeSink,
): Promise<string> {
  if (query.trim().length === 0) return ''
  const projectKey = context.projectKey ?? context.cwd
  const result = await engine.recall({
    query,
    scenario,
    ...(projectKey !== undefined ? { scope: 'project' as const, projectKey } : {}),
    limit: 6,
    sessionId: context.sessionId,
    injected: true,
  })
  notify(result, onRecall)
  if (result.hits.length === 0) return ''
  const lines = ['[OMB 事件召回]', ...compact(result, '相关：', 6)]
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = estimateTokens(line)
    if (used + cost > budgetTokens) break
    kept.push(line)
    used += cost
  }
  return kept.join('\n')
}

function compact(result: RecallResult, prefix: string, max: number): string[] {
  if (result.hits.length === 0) return []
  return [`${prefix}${result.hits.slice(0, max).map(compactHit).join('；')}`]
}
