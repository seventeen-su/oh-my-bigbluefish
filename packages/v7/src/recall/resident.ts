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

function notifyHits(
  traceId: string,
  hits: readonly RecallHit[],
  sink: RecallNoticeSink | undefined,
): void {
  if (hits.length === 0) return
  sink?.({
    traceId,
    hits: hits.map(hit => ({ id: hit.entityId, ...(hit.title !== undefined ? { title: hit.title } : {}) })),
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
  const kept: { readonly text: string; readonly id: string }[] = []
  const seen = new Set<string>()
  for (const hit of result.hits) {
    if (seen.has(hit.entityId)) continue
    const text = compactHit(hit)
    if (text.length === 0) continue
    seen.add(hit.entityId)
    kept.push({ text, id: hit.entityId })
    if (kept.length >= max) break
  }
  if (kept.length === 0) return undefined
  return {
    name: 'states',
    text: `${prefix}${kept.map(item => item.text).join('；')}`,
    entityIds: kept.map(item => item.id),
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

  const header: ResidentCandidate = { name: 'header', text: '[OMB 常驻]', entityIds: [] }
  const candidates: ResidentCandidate[] = [
    ...(preferenceItems === undefined ? [] : [compactSummaries(preferenceItems, '偏好：', 5)]),
    compactHits(states, '当前状态：', 5),
    ...indexCandidates(index),
    {
      name: 'tool-hint',
      text: '需要细节用 omb_recall；长期结论用 omb_remember；状态更新用 omb_update。',
      entityIds: [],
    },
  ].filter((candidate): candidate is ResidentCandidate => candidate !== undefined)

  const headerTokens = estimateTokens(header.text)
  // header 先占预算：内容必须和 header 一起放得下才算注入。
  const contentBudget = budgetTokens - headerTokens
  const sections: ResidentTraceSection[] = [toTraceSection(header, false, headerTokens)]
  const keptLines: string[] = []
  const droppedSections: string[] = []
  let used = 0
  for (const candidate of candidates) {
    const tokens = estimateTokens(candidate.text)
    const kept = used + tokens <= contentBudget
    sections.push(toTraceSection(candidate, kept, tokens))
    if (!kept) {
      droppedSections.push(candidate.name)
      continue
    }
    keptLines.push(candidate.text)
    used += tokens
  }

  // header 不能单独注入（RET-15）：没有内容可放时整段不注入，trace 与“未注入”一致。
  if (keptLines.length === 0) {
    droppedSections.unshift(header.name)
    return {
      text: '',
      trace: {
        traceId: newId('trace'),
        sessionId: context.sessionId,
        budgetTokens,
        usedTokens: 0,
        text: '',
        sections,
        droppedSections,
      },
      preferenceHits: [],
    }
  }

  sections[0] = toTraceSection(header, true, headerTokens)
  keptLines.unshift(header.text)
  used += headerTokens
  // 只有状态段真正进入文本时才登记召回（adoption 只认实际注入的命中）。
  if (sections.some(section => section.name === 'states' && section.kept)) notify(states, onRecall)

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

const EVENT_RECALL_HEADER = '[OMB 事件召回]'
const EVENT_RECALL_PREFIX = '相关：'
const EVENT_RECALL_MAX_HITS = 3
const TRUNCATION_MARK = '…'

/**
 * 按预算装配 T1 文本：header + 单行 `相关：...` 内容。
 *
 * header 不能单独注入（RET-15）：内容整行放不下时按 token 估算截断尾部，保留
 * `相关：` 前缀与至少一个可辨识字符；连 header + 最小内容都放不下则返回空串。
 */
function assembleEventRecallText(header: string, content: string, budgetTokens: number): string {
  const full = `${header}\n${content}`
  if (estimateTokens(full) <= budgetTokens) return full
  // estimateTokens 对追加字符单调不减，二分找“截断后仍放得下”的最长前缀。
  let low = 0
  let high = content.length
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (estimateTokens(`${header}\n${content.slice(0, mid)}${TRUNCATION_MARK}`) <= budgetTokens) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  // 只留下 `相关：` 前缀算不上有内容；同时避免把代理对（emoji 等）截成半个字符。
  if (low > 0) {
    const last = content.charCodeAt(low - 1)
    if (last >= 0xd800 && last <= 0xdbff) low -= 1
  }
  if (low <= EVENT_RECALL_PREFIX.length) return ''
  return `${header}\n${content.slice(0, low)}${TRUNCATION_MARK}`
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
    // 不强制 scope='project'（RET-03）：T1 要同时看到全局偏好/事实与当前项目。
    // state_board 通道在没有显式 scope 时仍按 projectKey 收窄，不会跨项目串状态。
    ...(projectKey !== undefined ? { projectKey } : {}),
    limit: 6,
    sessionId: context.sessionId,
    injected: true,
  })
  if (result.hits.length === 0) return ''
  const compacted = compact(result, EVENT_RECALL_PREFIX, EVENT_RECALL_MAX_HITS)
  const text = compacted.text.length === 0
    ? ''
    : assembleEventRecallText(EVENT_RECALL_HEADER, compacted.text, budgetTokens)
  // 空字符串代表本次不注入；只登记最终文本里仍可见的命中，避免预算截断后
  // 未展示的实体被 adoption 误判（RET-04）。
  if (text.length > 0) {
    notifyHits(result.traceId, compacted.hits.filter(hit => text.includes(hit.entityId)), onRecall)
  }
  return text
}

interface CompactedEventRecall {
  readonly text: string
  readonly hits: readonly RecallHit[]
}

/** 单行 `相关：...`：按 entityId 去重、跳过空标题、条数封顶，保持预算可预测。 */
function compact(result: RecallResult, prefix: string, max: number): CompactedEventRecall {
  const seen = new Set<string>()
  const parts: string[] = []
  const hits: RecallHit[] = []
  for (const hit of result.hits) {
    if (seen.has(hit.entityId)) continue
    const part = compactHit(hit)
    if (part.length === 0) continue
    seen.add(hit.entityId)
    parts.push(part)
    hits.push(hit)
    if (parts.length >= max) break
  }
  return hits.length === 0
    ? { text: '', hits: [] }
    : { text: `${prefix}${parts.join('；')}`, hits }
}
