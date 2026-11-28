import type { Category, EntityKind, StateStatus } from '../domain/entity.js'
import { fail, invalid } from '../domain/errors.js'
import { extractQuerySignals, normalizeText, tokenize } from '../domain/text.js'
import type { FusionGate, RetrievalConfig, ScenarioConfig } from './config.js'
import { RECALL_SCENARIOS, STAGE_ONE_CHANNELS } from './constants.js'
import { isValidTimeZone, localDayStartDaysAgo } from './timezone.js'
import type { ExpansionMode, RecallRequest, RecallScenario, StageOneChannel, TimeWindow } from './types.js'

/**
 * QueryCompiler：把一次召回请求编译成**可序列化的检索计划**。
 *
 * 设计约束（ADR-0009 / ARCHITECTURE-PLAN §4.5）：
 * - 纯函数：不读时钟、不连 store、不碰 `process`；`now` 与执行锚点都由调用方传入。
 * - 计划是数据：只有 JSON 可表达的字段，没有函数/连接/类实例；`JSON.parse(JSON.stringify(plan))` 后仍可执行。
 * - 稳定哈希：内容哈希覆盖除 `hash` 之外的全部字段，运行日志/基准报告可以用它对齐「同一份计划」。
 * - 配置版本：`configVersion` 记录编译时权重/门控版本；重放时引擎发现版本漂移会写 warning，不静默换口径。
 *
 * 时间有两层，不能混：
 * - `time.now` 是**查询时间锚点**（“昨天/最近 N 天”与场景默认回看窗按它算），可以来自请求里的 `now`；
 * - `deadline` 是**执行预算**，锚点是宿主墙钟（`executionAnchorMs`），与查询语义时间无关；
 *   否则回放一份历史计划会因为 `now` 在过去的语义时间而立刻超时。
 *
 * 日历日第三层：`time.timezone` 是 IANA 时区，决定「今天/昨天/前天」落在哪一天。
 * 它必须是显式参数（请求 > 编译上下文 > 配置），绝不隐式读 Node 本地时区。
 */

/** 计划 schema 版本；字段不兼容变更必须升版本，`parseRetrievalPlan` 会拒绝旧版本。 */
export const PLAN_SCHEMA = 'omb.retrieval-plan/2'

/** 阶段一 + 阶段二扩展的总预算（ms）；缺省值对齐宿主 pre-step 的 1.5s 上限。 */
export const DEFAULT_STAGE_ONE_BUDGET_MS = 1500

/** 单个 provider 的超时（ms）；实际生效值 = min(本值, 计划剩余预算)。 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 1000

/** 进入全文查询的加权词上限；与 PostgreSQL fulltext 的 OR 词上限（48）保持一致。 */
export const DEFAULT_QUERY_TERM_BUDGET = 48

/** 八个 provider 的名称（阶段一六通道 + 阶段二 links/expand）。计划按这个顺序落盘。 */
export const PROVIDER_CHANNELS = [...STAGE_ONE_CHANNELS, 'links', 'expand'] as const
export type ProviderChannel = (typeof PROVIDER_CHANNELS)[number]

/*
 * 计划字段类型故意不导出：调用方只需要 `RetrievalPlan` 这一个数据契约，
 * 内部形状（filters/time/terms/providers/...）由编译函数与 provider 共同消费，
 * 不额外扩大检索模块的公共面（架构检查上限 15 个导出）。
 */

interface PlanQuerySignals {
  readonly paths: readonly string[]
  readonly identifiers: readonly string[]
  readonly errorCodes: readonly string[]
}

/** 查询词的权重来源；provider 只按顺序消费 term，权重用于裁剪与审计。 */
type WeightedTermKind = 'signal' | 'path' | 'phrase' | 'term'

interface WeightedTerm {
  readonly term: string
  readonly weight: number
  readonly kind: WeightedTermKind
}

interface PlanFilters {
  readonly scope?: 'global' | 'project'
  readonly projectKey?: string
  readonly kind?: EntityKind
  readonly category?: Category
  readonly status?: readonly StateStatus[]
  readonly includeArchived: boolean
  readonly includeHistory: boolean
  /** 历史检索开关：false 时只允许 lifecycle=active（默认）。 */
  readonly includeSuperseded: boolean
}

interface PlanTime {
  /** 查询时间锚点（ISO 8601）；时间通道与重排衰减都按它算。 */
  readonly now: string
  /** 日历日解析使用的 IANA 时区；计划显式记录，重放不依赖编译机本地时区。 */
  readonly timezone: string
  /** time 通道的回看窗：显式 > 查询相对时间 > 场景默认。 */
  readonly lookback: TimeWindow
  /** 显式且合法的请求时间窗；只有它会收窄最终候选。 */
  readonly explicit?: TimeWindow
  /** 请求里给了非法 timeWindow 时的回退原因；序列化在计划里，重放也能解释。 */
  readonly fallbackReason?: string
}

interface PlanProviderConfig {
  readonly channel: ProviderChannel
  readonly enabled: boolean
  /** 该 provider 单次查询的候选上限（传给 store 的 limit）。 */
  readonly limit: number
  /** 该 provider 的超时（ms），运行时再与计划剩余预算取小。 */
  readonly timeoutMs: number
}

interface PlanBudget {
  /** 进入全文查询的加权词上限。 */
  readonly terms: number
  /** 每个 provider 的候选上限。 */
  readonly candidates: number
  /** 每通道进入阶段二图扩展的种子数。 */
  readonly seeds: number
  /** 最多解析多少个思维链组。 */
  readonly chainGroups: number
}

interface PlanThresholds {
  /** 查询归一化长度 ≤ 该值才允许单字回退。 */
  readonly singleCharMaxQueryLength: number
  /** 融合分绝对健全性下限（RRF 分未校准，不承担相关性过滤职责）。 */
  readonly fusedFloor: number
  /** 本次计划生效的融合层相对/一致性门控快照（含场景校准）。 */
  readonly fusionGate: FusionGate
}

interface PlanDeadline {
  /** 编译锚点 + 预算；绝对时刻，用于审计与队列超时。 */
  readonly atMs: number
  /** 执行预算（ms）；运行时按执行锚点重新展开成绝对期限。 */
  readonly ms: number
}

export interface RetrievalPlan {
  readonly schema: string
  readonly configVersion: string
  readonly scenario: RecallScenario
  readonly query: string
  readonly normalizedQuery: string
  readonly expand: ExpansionMode
  readonly hops: 1 | 2
  readonly filters: PlanFilters
  readonly time: PlanTime
  readonly signals: PlanQuerySignals
  readonly terms: readonly WeightedTerm[]
  readonly phrases: readonly string[]
  readonly providers: readonly PlanProviderConfig[]
  readonly limit: number
  readonly budget: PlanBudget
  readonly thresholds: PlanThresholds
  readonly deadline: PlanDeadline
  /** 计划内容哈希（不含本字段）；`parseRetrievalPlan` 会重算校验。 */
  readonly hash: string
}

export interface PlanCompileContext {
  readonly config: RetrievalConfig
  /** 查询时间锚点（ISO 8601）。 */
  readonly now: string
  /** 执行锚点（ms，宿主墙钟）；deadline 从这里 + 预算。 */
  readonly executionAnchorMs: number
  /** 日历日时区（IANA）；请求里的 `timezone` 优先，其次这里，最后用配置的 `timezone`。 */
  readonly timezone?: string
  readonly budgetMs?: number
  readonly providerTimeoutMs?: number
  readonly termBudget?: number
}

type PlanBody = Omit<RetrievalPlan, 'hash'>

const DAY_MS = 86_400_000
const CJK_CHAR = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,20}/gu
const QUOTED = /"([^"]{2,40})"|“([^”]{2,40})”|'([^']{2,40})'/gu
const MAX_PHRASES = 8
const INVALID_WINDOW_REASON = 'timeWindow 不是合法且 from<=to 的 ISO 时间，已回退到场景默认时间窗'

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * 从查询里解析显式相对时间（今天/昨天/前天/上周/最近 N 天周月/N 天前）。
 * 只做确定性匹配，不猜「上次/之前」——那是调用方切到 `last-time` 场景的事。
 *
 * 「今天/昨天/前天」是**当地日历日**：按 `timeZone` 求当地零点，不用 UTC 日历日，
 * 也不用 `now - 24h`（DST 日不是 24 小时）。「最近 N 天/上周」是时长语义，保持锚点回退。
 */
function queryTimeWindow(query: string, nowIso: string, timeZone: string): TimeWindow | undefined {
  const anchor = Date.parse(nowIso)
  if (!Number.isFinite(anchor)) return undefined
  const to = new Date(anchor).toISOString()
  const dayStart = (daysAgo: number): string => new Date(localDayStartDaysAgo(timeZone, anchor, daysAgo)).toISOString()
  if (/昨天/.test(query)) return { from: dayStart(1), to }
  if (/前天/.test(query)) return { from: dayStart(2), to }
  if (/今天/.test(query)) return { from: dayStart(0), to }
  if (/上周|过去一周|最近一周/.test(query)) return { from: new Date(anchor - 7 * DAY_MS).toISOString(), to }
  const relative = /最近\s*(\d{1,3})\s*(天|日|周|个?月)/.exec(query) ?? /(\d{1,3})\s*(天|日|周|个?月)(?:前|内)/.exec(query)
  if (relative !== null) {
    const count = Number(relative[1])
    const unit = relative[2] ?? '天'
    if (!Number.isFinite(count) || count <= 0) return undefined
    const days = unit.includes('周') ? count * 7 : unit.includes('月') ? count * 30 : count
    return { from: new Date(anchor - Math.min(days, 365) * DAY_MS).toISOString(), to }
  }
  return undefined
}

function validTimeWindow(window: TimeWindow | undefined): TimeWindow | undefined {
  if (window === undefined) return undefined
  const from = Date.parse(window.from)
  const to = Date.parse(window.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return undefined
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

/** 时区解析顺序：请求 > 编译上下文 > 配置；非法值直接拒绝，不静默换成 UTC。 */
function resolveTimeZone(request: RecallRequest, context: PlanCompileContext): string {
  const requested = request.timezone ?? context.timezone ?? context.config.timezone
  if (!isValidTimeZone(requested)) {
    fail(invalid(`时区必须是可解析的 IANA 名称（如 Asia/Shanghai），实际：${String(requested)}`))
  }
  return requested
}

function compileTime(request: RecallRequest, scenario: ScenarioConfig, anchorMs: number, timeZone: string): PlanTime {
  const now = new Date(anchorMs).toISOString()
  const explicit = validTimeWindow(request.timeWindow)
  if (explicit !== undefined) return { now, timezone: timeZone, lookback: explicit, explicit }
  const fallback = request.timeWindow === undefined ? {} : { fallbackReason: INVALID_WINDOW_REASON }
  const queryWindow = queryTimeWindow(request.query, now, timeZone)
  if (queryWindow !== undefined) return { now, timezone: timeZone, lookback: queryWindow, ...fallback }
  return {
    now,
    timezone: timeZone,
    lookback: { from: new Date(anchorMs - scenario.timeWindowDays * DAY_MS).toISOString(), to: now },
    ...fallback,
  }
}

function compileSignals(query: string): PlanQuerySignals {
  const signals = extractQuerySignals(query)
  return {
    paths: uniqueStrings(signals.paths),
    identifiers: uniqueStrings(signals.identifiers),
    errorCodes: uniqueStrings(signals.errorCodes),
  }
}

/** 引号片段与连续 CJK 片段：给短语内词更高权重，保留“这几个字挨在一起”的意图。 */
function extractPhrases(query: string): string[] {
  const found: string[] = []
  for (const match of query.matchAll(QUOTED)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value !== undefined) found.push(value)
  }
  for (const match of normalizeText(query).matchAll(CJK_RUN)) found.push(match[0])
  return uniqueStrings(found).slice(0, MAX_PHRASES)
}

interface RankedTerm extends WeightedTerm {
  readonly index: number
}

/**
 * 加权词表：信号（路径/错误码/标识符）> 路径片段/短语 > 普通词 > CJK 单字。
 * 超过预算时按权重、词长、原顺序裁剪，保证同一查询永远得到同一份词表。
 */
function compileTerms(query: string, signals: PlanQuerySignals, phrases: readonly string[], budget: number): WeightedTerm[] {
  const tokens = tokenize(query)
  const signalTokens = new Set<string>()
  for (const value of [...signals.errorCodes, ...signals.identifiers]) {
    for (const token of tokenize(value)) signalTokens.add(token)
  }
  const pathTokens = new Set<string>()
  for (const path of signals.paths) {
    for (const token of tokenize(path)) pathTokens.add(token)
  }
  const phraseTokens = new Set<string>()
  for (const phrase of phrases) {
    for (const token of tokenize(phrase)) phraseTokens.add(token)
  }
  const ranked: RankedTerm[] = tokens.map((term, index) => {
    if (signalTokens.has(term)) return { term, weight: 1.5, kind: 'signal', index }
    if (pathTokens.has(term)) return { term, weight: 1.25, kind: 'path', index }
    if (phraseTokens.has(term)) return { term, weight: 1.25, kind: 'phrase', index }
    if (CJK_CHAR.test(term)) return { term, weight: 0.8, kind: 'term', index }
    return { term, weight: 1, kind: 'term', index }
  })
  ranked.sort((left, right) => right.weight - left.weight
    || right.term.length - left.term.length
    || left.index - right.index)
  return ranked.slice(0, Math.max(1, budget)).map(item => ({ term: item.term, weight: item.weight, kind: item.kind }))
}

function compileFilters(request: RecallRequest): PlanFilters {
  return {
    ...(request.scope === undefined ? {} : { scope: request.scope }),
    ...(request.projectKey === undefined ? {} : { projectKey: request.projectKey }),
    ...(request.kind === undefined ? {} : { kind: request.kind }),
    ...(request.category === undefined ? {} : { category: request.category }),
    ...(request.status === undefined ? {} : { status: [...request.status] }),
    includeArchived: request.includeArchived === true,
    includeHistory: request.includeHistory === true,
    includeSuperseded: request.includeSuperseded === true,
  }
}

/**
 * `request.channels` 的显式通道限定：只允许阶段一通道，且必须非空。
 * 空数组会编译出一份“什么都不跑”的计划，属于调用方 bug，直接拒绝而不是静默返回空结果。
 */
function resolveChannels(channels: RecallRequest['channels']): readonly StageOneChannel[] | undefined {
  if (channels === undefined) return undefined
  if (channels.length === 0) fail(invalid('channels 不能是空数组'))
  const unique: StageOneChannel[] = []
  for (const channel of channels) {
    if (!(STAGE_ONE_CHANNELS as readonly string[]).includes(channel)) {
      fail(invalid(`channels 只允许阶段一通道（${STAGE_ONE_CHANNELS.join('/')}），实际：${String(channel)}`))
    }
    if (!unique.includes(channel)) unique.push(channel)
  }
  return unique
}

/**
 * provider 开关。显式限定通道时只点亮这些通道且不启用图扩展（T0 状态看板路径）；
 * 未限定时沿用 `expand` 的既有语义：links/expand 只在计划要求图扩展时启用。
 */
function compileProviders(
  config: RetrievalConfig,
  expand: ExpansionMode,
  timeoutMs: number,
  channels: readonly StageOneChannel[] | undefined,
): PlanProviderConfig[] {
  const narrowed = channels === undefined ? undefined : new Set(channels)
  return PROVIDER_CHANNELS.map(channel => ({
    channel,
    enabled: narrowed !== undefined
      ? narrowed.has(channel as StageOneChannel)
      : channel === 'links' || channel === 'expand' ? expand !== 'none' : true,
    limit: config.channelLimit,
    timeoutMs,
  }))
}

function resolveLimit(request: RecallRequest, config: RetrievalConfig): number {
  const requested = request.limit ?? config.defaultLimit
  if (!Number.isFinite(requested)) return config.defaultLimit
  return Math.max(1, Math.min(config.maxLimit, Math.floor(requested)))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item === undefined) continue
      result[key] = canonicalize(item)
    }
    return result
  }
  return value
}

/** 稳定序列化：对象键排序、丢弃 undefined，保证同一内容永远得到同一字符串。 */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** FNV-1a 64 位；纯字符串运算，不引入 node:crypto（retrieval 只依赖 domain+ports）。 */
function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

function fingerprint(body: PlanBody): string {
  return fnv1a64(stableStringify(body))
}

/** 计划内容指纹：去掉 `hash` 后重算，供审计与稳定性测试使用。 */
export function planFingerprint(plan: RetrievalPlan): string {
  const { hash: _hash, ...rest } = plan
  return fingerprint(rest)
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) fail(invalid(`${label} 必须是有限数字`))
  return value
}

/**
 * 编译入口。同一 `(request, config, now, executionAnchorMs, 预算)` 永远得到同一份计划（含同一 hash）。
 * 场景级门控校准在这里就解析进 `thresholds.fusionGate`，让计划本身说明「用哪套门控」。
 */
export function compileRetrievalPlan(request: RecallRequest, context: PlanCompileContext): RetrievalPlan {
  const anchorMs = Date.parse(context.now)
  if (!Number.isFinite(anchorMs)) fail(invalid(`now 必须是合法 ISO 时间，实际：${context.now}`))
  requireFinite(context.executionAnchorMs, 'executionAnchorMs')
  const scenarioName: RecallScenario = request.scenario ?? 'manual'
  const scenario = context.config.scenarios[scenarioName]
  if (scenario === undefined) fail(invalid(`未知召回场景：${scenarioName}`))
  const budgetMs = Math.max(1, Math.floor(context.budgetMs ?? DEFAULT_STAGE_ONE_BUDGET_MS))
  const providerTimeoutMs = Math.max(1, Math.floor(context.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS))
  const termBudget = Math.max(1, Math.floor(context.termBudget ?? DEFAULT_QUERY_TERM_BUDGET))
  const signals = compileSignals(request.query)
  const phrases = extractPhrases(request.query)
  const channels = resolveChannels(request.channels)
  // 显式通道限定是“最小召回”语义：不跑图扩展，避免为 T0 状态再打一次 links/expand。
  const expand: ExpansionMode = channels === undefined ? (request.expand ?? 'both') : 'none'
  const timeZone = resolveTimeZone(request, context)

  const body: PlanBody = {
    schema: PLAN_SCHEMA,
    configVersion: context.config.version,
    scenario: scenarioName,
    query: request.query,
    normalizedQuery: normalizeText(request.query),
    expand,
    hops: request.hops === 1 ? 1 : 2,
    filters: compileFilters(request),
    time: compileTime(request, scenario, anchorMs, timeZone),
    signals,
    phrases,
    terms: compileTerms(request.query, signals, phrases, termBudget),
    providers: compileProviders(context.config, expand, providerTimeoutMs, channels),
    limit: resolveLimit(request, context.config),
    budget: {
      terms: termBudget,
      candidates: context.config.channelLimit,
      seeds: context.config.seedLimit,
      chainGroups: context.config.maxChainGroups,
    },
    thresholds: {
      singleCharMaxQueryLength: context.config.singleCharMaxQueryLength,
      fusedFloor: context.config.fusedFloor,
      fusionGate: scenario.gate ?? context.config.fusionGate,
    },
    deadline: { atMs: Math.floor(context.executionAnchorMs) + budgetMs, ms: budgetMs },
  }
  return { ...body, hash: fingerprint(body) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 反序列化 + 校验。用于 `RecallEngine.recallFromPlan`：结构不对或 hash 不符就抛 invalid-input，
 * 不让被篡改/不兼容的计划静默执行（否则问题只会在召回质量上体现）。
 */
export function parseRetrievalPlan(value: unknown): RetrievalPlan {
  if (!isRecord(value)) fail(invalid('RetrievalPlan 必须是对象'))
  if (value.schema !== PLAN_SCHEMA) {
    fail(invalid(`RetrievalPlan schema 不匹配：期望 ${PLAN_SCHEMA}，实际 ${String(value.schema)}`))
  }
  for (const key of ['query', 'normalizedQuery', 'configVersion', 'hash'] as const) {
    if (typeof value[key] !== 'string') fail(invalid(`RetrievalPlan.${key} 必须是字符串`))
  }
  if (!RECALL_SCENARIOS.includes(value.scenario as RecallScenario)) {
    fail(invalid(`RetrievalPlan.scenario 非法：${String(value.scenario)}`))
  }
  for (const key of ['filters', 'time', 'signals', 'budget', 'thresholds', 'deadline'] as const) {
    if (!isRecord(value[key])) fail(invalid(`RetrievalPlan.${key} 必须是对象`))
  }
  for (const key of ['terms', 'phrases', 'providers'] as const) {
    if (!Array.isArray(value[key])) fail(invalid(`RetrievalPlan.${key} 必须是数组`))
  }
  const time = value.time as Record<string, unknown>
  if (typeof time.timezone !== 'string' || !isValidTimeZone(time.timezone)) {
    fail(invalid(`RetrievalPlan.time.timezone 必须是可解析的 IANA 时区，实际：${String(time.timezone)}`))
  }
  const thresholds = value.thresholds as Record<string, unknown>
  if (!Number.isFinite(thresholds.fusedFloor) || !isRecord(thresholds.fusionGate)) {
    fail(invalid('RetrievalPlan.thresholds 必须带 fusedFloor 与 fusionGate（门控快照）'))
  }
  if (!Number.isFinite(value.limit) || !Number.isFinite((value.deadline as Record<string, unknown>).atMs)) {
    fail(invalid('RetrievalPlan.limit / deadline.atMs 必须是有限数字'))
  }
  const plan = value as unknown as RetrievalPlan
  if (planFingerprint(plan) !== plan.hash) {
    fail(invalid('RetrievalPlan hash 不匹配：计划内容被修改或来自不兼容版本'))
  }
  return plan
}

/**
 * 重放辅助：把计划的执行期限重新锚到新的宿主墙钟，查询语义字段与权重全部不变。
 * 用于「历史计划回放/基准」；正常 `recall` 不需要它（编译时已锚在当前时钟）。
 */
export function rebaseRetrievalPlan(plan: RetrievalPlan, executionAnchorMs: number, budgetMs?: number): RetrievalPlan {
  requireFinite(executionAnchorMs, 'executionAnchorMs')
  const ms = Math.max(1, Math.floor(budgetMs ?? plan.deadline.ms))
  const { hash: _hash, ...rest } = plan
  const body: PlanBody = { ...rest, deadline: { atMs: Math.floor(executionAnchorMs) + ms, ms } }
  return { ...body, hash: fingerprint(body) }
}
