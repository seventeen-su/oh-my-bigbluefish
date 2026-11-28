import { toOmbError } from '../domain/errors.js'
import { newId } from '../domain/ids.js'
import type { Clock } from '../ports/clock.js'
import type { Embedder } from '../ports/embedding.js'
import type { Store } from '../ports/store.js'
import type { EntityPriorFeatures, EntitySummary } from '../ports/search.js'
import type { RecallEventInput } from '../ports/observability.js'
import { runStageOnePlan } from './channels.js'
import {
  compileRetrievalPlan,
  parseRetrievalPlan,
  type RetrievalPlan,
} from './compiler.js'
import type { RetrievalConfig } from './config.js'
import { DEFAULT_RETRIEVAL_CONFIG } from './config.js'
import { explainEmpty, explainFiltered, explainHit, type WhyNot } from './explain.js'
import { collectSeeds, type ChainInfo, type SeedSet } from './expand.js'
import { applyExpansions, fuseStageOne, sortChannels, type FusionCandidate } from './fuse.js'
import { gateCandidates } from './gate.js'
import { runExpansionProviders, type ExpansionRunResult } from './providers/index.js'
import { rerankPrior, type PriorResult } from './rerank.js'
import type {
  EmptyReason,
  ExpansionStats,
  RecallChannel,
  RecallHit,
  RecallRequest,
  RecallResult,
  TimeWindow,
} from './types.js'

export interface RecallEngineDeps {
  readonly store: Store
  readonly embedder: Embedder
  readonly clock: Clock
  /** 审计配置；缺省用 DEFAULT_RETRIEVAL_CONFIG。 */
  readonly config?: RetrievalConfig
  /** 阶段一 + 阶段二扩展的总预算（ms）；缺省 DEFAULT_STAGE_ONE_BUDGET_MS。 */
  readonly stageOneBudgetMs?: number
  /** 单个 provider 超时（ms）；缺省 DEFAULT_PROVIDER_TIMEOUT_MS。 */
  readonly providerTimeoutMs?: number
}

/** `recallFromPlan` 的审计字段；检索语义全部来自 plan，这里只影响 recall_event。 */
export interface RecallPlanAudit {
  readonly traceId?: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly trigger?: string
  readonly injected?: boolean
}

interface RecallExecution {
  readonly plan: RetrievalPlan
  readonly traceId: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly trigger?: string
  readonly injected: boolean
}

interface ScoredCandidate {
  readonly candidate: FusionCandidate
  readonly summary: EntitySummary
  readonly prior: PriorResult
  readonly score: number
}

interface FilteredCandidate {
  readonly candidate: FusionCandidate
  readonly summary: EntitySummary
}

interface TimeWindowBounds {
  readonly fromMs: number
  readonly toMs: number
}

const MAX_CHAIN_SIBLINGS = 12

function resolveNowIso(request: RecallRequest, clock: Clock): string {
  if (request.now !== undefined) {
    const parsed = Date.parse(request.now)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  const iso = clock.iso()
  const parsed = Date.parse(iso)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  return new Date().toISOString()
}

function traceIdOf(request: RecallRequest): string {
  return request.traceId !== undefined && request.traceId.trim().length > 0 ? request.traceId : newId('trace')
}

/** 无 eventTime（非状态机实体）或时间无法解析时按未知处理：不因时间窗排除。 */
function withinTimeWindow(bounds: TimeWindowBounds, eventTime: string | undefined): boolean {
  if (eventTime === undefined) return true
  const eventMs = Date.parse(eventTime)
  if (!Number.isFinite(eventMs)) return true
  return eventMs >= bounds.fromMs && eventMs <= bounds.toMs
}

function boundsOf(window: TimeWindow): TimeWindowBounds {
  return { fromMs: Date.parse(window.from), toMs: Date.parse(window.to) }
}

/** 重排先验只需要请求里的少量字段；从计划重建一个只读视图，避免把原 request 透传进来。 */
function requestViewOf(plan: RetrievalPlan): RecallRequest {
  return {
    query: plan.query,
    scenario: plan.scenario,
    expand: plan.expand,
    hops: plan.hops,
    limit: plan.limit,
    ...(plan.filters.scope === undefined ? {} : { scope: plan.filters.scope }),
    ...(plan.filters.projectKey === undefined ? {} : { projectKey: plan.filters.projectKey }),
    ...(plan.filters.kind === undefined ? {} : { kind: plan.filters.kind }),
    ...(plan.filters.category === undefined ? {} : { category: plan.filters.category }),
    ...(plan.filters.status === undefined ? {} : { status: plan.filters.status }),
    ...(plan.filters.includeArchived ? { includeArchived: true } : {}),
    ...(plan.filters.includeHistory ? { includeHistory: true } : {}),
    ...(plan.filters.includeSuperseded ? { includeSuperseded: true } : {}),
    ...(plan.time.explicit === undefined ? {} : { timeWindow: plan.time.explicit }),
    now: plan.time.now,
  }
}

function compareScored(left: ScoredCandidate, right: ScoredCandidate): number {
  if (right.score !== left.score) return right.score - left.score
  return left.candidate.entityId < right.candidate.entityId ? -1 : left.candidate.entityId > right.candidate.entityId ? 1 : 0
}

function collectSiblingIds(hitId: string, chains: ReadonlyMap<string, ChainInfo>, out: Set<string>): void {
  for (const chain of chains.values()) {
    const isChain = chain.chainId === hitId
    const isMember = chain.members.has(hitId)
    if (!isChain && !isMember) continue
    for (const memberId of chain.members) if (memberId !== hitId) out.add(memberId)
  }
}

function chainSiblingTitles(
  hitId: string,
  chains: ReadonlyMap<string, ChainInfo>,
  titles: ReadonlyMap<string, string>,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const push = (value: string | undefined): void => {
    const title = value?.trim()
    if (title === undefined || title.length === 0 || seen.has(title)) return
    seen.add(title)
    result.push(title)
  }
  for (const chain of chains.values()) {
    const isChain = chain.chainId === hitId
    const isMember = chain.members.has(hitId)
    if (!isChain && !isMember) continue
    if (!isChain) push(chain.title)
    for (const memberId of [...chain.members].sort()) {
      if (memberId === hitId) continue
      push(titles.get(memberId))
    }
  }
  return result.slice(0, MAX_CHAIN_SIBLINGS)
}

/**
 * 计划驱动的两阶段召回引擎。
 *
 * 阶段一：`runStageOnePlan` 执行六个 provider（五个并行 + 单字回退条件执行），
 * 每个 provider 有独立 deadline/状态，单个失败不拖垮其它；deadline 在报告里记为
 * failed + `deadline:` reason，并在 warnings 里明示。
 * 阶段二：`runExpansionProviders` 执行 expand → links（按计划 expand 模式），失败降级为 warning。
 * 之后是加权 RRF（k 来自配置，默认 60）融合、原始分门控 + 融合层相对/一致性门控、
 * 两级场景重排、显式时间窗收窄，最后写 recall_event；空结果一定带 emptyReason，不静默返回 []。
 *
 * 计划可序列化：`compilePlan(request)` 得到纯数据计划，`recallFromPlan(JSON 往返后的计划)`
 * 可以重放同一份检索语义；配置版本漂移会在 warnings 里暴露，不静默换口径。
 * 门控阈值与日历日时区都从计划读（计划是权威），重放不受当前配置影响。
 *
 * 两级重排（`rerankEnrichTopK`）：
 * 1. 初排：**全部**候选只用摘要级特征（分类/新近度/作用域/历史/链路）算分；
 * 2. 精排：对初排前 `max(rerankEnrichTopK, limit)` 名做**一次**批量富化
 *    （`store.priorFeatures`），把置信度/置顶/偏好标签/采用率/来源加进来再排序。
 * 窗口不小于返回条数，所以截断位置不会决定谁拿到实体级乘数；富化缺失按中性处理。
 */
export class RecallEngine {
  readonly config: RetrievalConfig
  private readonly store: Store
  private readonly embedder: Embedder
  private readonly clock: Clock
  private readonly stageOneBudgetMs: number | undefined
  private readonly providerTimeoutMs: number | undefined
  /** 存储缺少批量富化能力只提示一次，不让每次召回都刷同一条 warning。 */
  private enrichmentGapReported = false

  constructor(deps: RecallEngineDeps) {
    this.store = deps.store
    this.embedder = deps.embedder
    this.clock = deps.clock
    this.config = deps.config ?? DEFAULT_RETRIEVAL_CONFIG
    this.stageOneBudgetMs = deps.stageOneBudgetMs
    this.providerTimeoutMs = deps.providerTimeoutMs
  }

  /** 纯编译：同一请求 + 时钟锚点永远得到同一份计划（含同一 hash）。 */
  compilePlan(request: RecallRequest): RetrievalPlan {
    return compileRetrievalPlan(request, {
      config: this.config,
      now: resolveNowIso(request, this.clock),
      executionAnchorMs: this.executionAnchorMs(),
      ...(this.stageOneBudgetMs === undefined ? {} : { budgetMs: this.stageOneBudgetMs }),
      ...(this.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: this.providerTimeoutMs }),
    })
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    return this.execute({
      plan: this.compilePlan(request),
      traceId: traceIdOf(request),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
      injected: request.injected === true,
    })
  }

  /**
   * 用**序列化后的计划**重放召回；结构/hash 不符直接抛 invalid-input，不执行被篡改的计划。
   * 注意：计划里的 deadline 是绝对时刻，历史计划需要用 `rebaseRetrievalPlan` 重新锚定执行窗口。
   */
  async recallFromPlan(plan: unknown, audit: RecallPlanAudit = {}): Promise<RecallResult> {
    const parsed = parseRetrievalPlan(plan)
    return this.execute({
      plan: parsed,
      traceId: audit.traceId !== undefined && audit.traceId.trim().length > 0 ? audit.traceId : newId('trace'),
      ...(audit.sessionId === undefined ? {} : { sessionId: audit.sessionId }),
      ...(audit.turnId === undefined ? {} : { turnId: audit.turnId }),
      ...(audit.trigger === undefined ? {} : { trigger: audit.trigger }),
      injected: audit.injected === true,
    })
  }

  private executionAnchorMs(): number {
    const parsed = Date.parse(this.clock.iso())
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  private async execute(input: RecallExecution): Promise<RecallResult> {
    const plan = input.plan
    const scenario = this.config.scenarios[plan.scenario]
    const startedAt = performance.now()
    const warnings: string[] = []
    if (plan.configVersion !== this.config.version) {
      warnings.push(`plan 由检索配置 ${plan.configVersion} 编译，当前配置 ${this.config.version}：融合/门控按当前配置计算。`)
    }

    const stageOne = await runStageOnePlan(
      { store: this.store, embedder: this.embedder },
      plan,
      { executionAnchorMs: this.executionAnchorMs() },
    )
    const stageOneMs = performance.now() - startedAt
    warnings.push(...stageOne.warnings)
    const stageOneHitCount = [...stageOne.hitsByChannel.values()].reduce((sum, hits) => sum + hits.length, 0)

    // 计划是权威：种子数按 plan.budget.seeds 取（重放一份旧计划时不能悄悄用当前配置的 seedLimit）。
    const seedConfig: RetrievalConfig = plan.budget.seeds === this.config.seedLimit
      ? this.config
      : { ...this.config, seedLimit: plan.budget.seeds }
    const seedSet: SeedSet = collectSeeds(stageOne.hitsByChannel, seedConfig)
    // 阶段二的执行锚点要扣掉阶段一已用时间；否则同一份计划的 deadline 会被两个阶段各用一遍。
    const expansionAnchorMs = this.executionAnchorMs() + (performance.now() - startedAt)
    const expansion = await this.expand(plan, seedSet, warnings, expansionAnchorMs)
    const expansionStats: ExpansionStats = {
      seeds: seedSet.entityIds.length,
      expanded: expansion.expansions.length,
      chains: expansion.chains.size,
    }

    const candidates = fuseStageOne(stageOne.hitsByChannel, scenario.weights, this.config.rrfK)
    if (expansion.expansions.length > 0) {
      applyExpansions(candidates, expansion.expansions, seedSet, expansion.chains, scenario.weights, this.config)
    }
    // 门控阈值以计划为权威：重放一份历史计划时不能悄悄换用当前配置的门控。
    const gate = gateCandidates([...candidates.values()], {
      ...this.config,
      fusedFloor: plan.thresholds.fusedFloor,
      fusionGate: plan.thresholds.fusionGate,
    })
    // 有结果时 below 统计不会进 emptyReason；用一条 warning 保证门控淘汰不静默。
    if (gate.passed.length > 0 && gate.rejected.length > 0) {
      warnings.push(
        `门控淘汰 ${gate.rejected.length} 条候选（belowRaw=${gate.belowRaw}，belowFused=${gate.belowFused}，`
        + `belowRelative=${gate.belowRelative}，noConsensus=${gate.belowConsensus}）：证据不足的不进入结果。`,
      )
    }

    const empty = (reason: EmptyReason): RecallResult => ({
      traceId: input.traceId,
      configVersion: this.config.version,
      scenario: plan.scenario,
      query: plan.query,
      hits: [],
      emptyReason: reason,
      channelErrors: stageOne.errors,
      channels: stageOne.reports,
      expansion: expansionStats,
      warnings: [...warnings],
      timings: { stageOneMs, totalMs: performance.now() - startedAt },
    })

    if (gate.passed.length === 0) {
      return empty(explainEmpty({
        query: plan.query,
        stageOneHitCount,
        reports: stageOne.reports,
        gate,
        filteredOut: 0,
        summariesFailed: false,
        filteredReasons: [],
      }))
    }

    const summaryMap = new Map<string, EntitySummary>()
    let summariesFailed = false
    try {
      const summaries = await this.store.summaries(gate.passed.map(candidate => candidate.entityId))
      for (const summary of summaries) summaryMap.set(summary.id, summary)
    } catch (error) {
      summariesFailed = true
      warnings.push(`读取实体摘要失败：${toOmbError(error).message}`)
    }
    if (summariesFailed) {
      return empty(explainEmpty({
        query: plan.query,
        stageOneHitCount,
        reports: stageOne.reports,
        gate,
        filteredOut: 0,
        summariesFailed: true,
        filteredReasons: [],
      }))
    }

    const filters = plan.filters
    const filtered: FilteredCandidate[] = []
    const filteredReasons: WhyNot[] = []
    let filteredOut = 0
    let timeFiltered = 0
    const timeWindow = plan.time.explicit === undefined ? undefined : boundsOf(plan.time.explicit)
    for (const candidate of gate.passed) {
      const summary = summaryMap.get(candidate.entityId)
      if (summary === undefined) {
        filteredOut += 1
        filteredReasons.push(explainFiltered('missing-summary', candidate.entityId))
        continue
      }
      if (!filters.includeArchived && summary.archived) {
        filteredOut += 1
        filteredReasons.push(explainFiltered('archived', candidate.entityId))
        continue
      }
      if (!filters.includeHistory && !summary.isCurrent) {
        filteredOut += 1
        filteredReasons.push(explainFiltered('history', candidate.entityId))
        continue
      }
      // 生命周期：默认只返回当前有效；历史检索才允许被取代/被证伪的条目，且必须带标记。
      // 纯归档行由 includeArchived 控制（archived_at 过滤已在前一条分支处理），这里放行 lifecycle=archived。
      const lifecycleAllowed = summary.lifecycle === 'active'
        || (summary.lifecycle === 'archived' && filters.includeArchived)
      if (!filters.includeSuperseded && !lifecycleAllowed) {
        filteredOut += 1
        const code = summary.lifecycle === 'retracted' ? 'retracted' : 'superseded'
        const at = summary.lifecycle === 'retracted' ? summary.retractedAt : summary.supersededAt
        filteredReasons.push(explainFiltered(code, candidate.entityId, `lifecycle=${summary.lifecycle}${at === undefined ? '' : ` at=${at}`}`))
        continue
      }
      if (filters.kind !== undefined && summary.kind !== filters.kind) {
        filteredOut += 1
        filteredReasons.push(explainFiltered('kind', candidate.entityId, `kind=${summary.kind} expected=${filters.kind}`))
        continue
      }
      if (filters.category !== undefined && summary.category !== filters.category) {
        filteredOut += 1
        filteredReasons.push(
          explainFiltered('category', candidate.entityId, `category=${summary.category ?? 'undefined'} expected=${filters.category}`),
        )
        continue
      }
      if (filters.status !== undefined && (summary.status === undefined || !filters.status.includes(summary.status))) {
        filteredOut += 1
        filteredReasons.push(
          explainFiltered('status', candidate.entityId, `status=${summary.status ?? 'undefined'} expected=${filters.status.join('|')}`),
        )
        continue
      }
      // 显式 timeWindow 对最终候选统一收窄：事件时间在窗外的实体不进入 hits。
      // 没有 eventTime 的实体（记忆/思维链等没有 time 属性）按未知处理，不凭空排除。
      if (timeWindow !== undefined && !withinTimeWindow(timeWindow, summary.eventTime)) {
        filteredOut += 1
        timeFiltered += 1
        filteredReasons.push(
          explainFiltered(
            'time-window',
            candidate.entityId,
            `eventTime=${summary.eventTime ?? 'unknown'} window=${new Date(timeWindow.fromMs).toISOString()}..${new Date(timeWindow.toMs).toISOString()}`,
          ),
        )
        continue
      }
      filtered.push({ candidate, summary })
    }

    if (filtered.length === 0) {
      return empty(explainEmpty({
        query: plan.query,
        stageOneHitCount,
        reports: stageOne.reports,
        gate,
        filteredOut,
        timeFiltered,
        summariesFailed: false,
        filteredReasons,
      }))
    }

    const requestView = requestViewOf(plan)
    const scoreOf = (candidate: FusionCandidate, summary: EntitySummary, features?: EntityPriorFeatures): ScoredCandidate => {
      const prior = rerankPrior({
        summary,
        ...(features === undefined ? {} : { features }),
        linkStrength: candidate.link?.linkScore ?? 0,
        scenario,
        config: this.config,
        request: requestView,
        now: plan.time.now,
      })
      return { candidate, summary, prior, score: candidate.fused * prior.factor }
    }

    // 初排：全部候选、同一套廉价摘要特征，先得到没有富化偏差的顺序。
    const prelim: ScoredCandidate[] = filtered.map(item => scoreOf(item.candidate, item.summary))
    prelim.sort(compareScored)

    // 富化窗口 ≥ 计划限制：返回的每一条都拿到实体级证据，截断位置不再是“谁被富化”的依据。
    const enrichWindow = Math.max(0, Math.min(prelim.length, Math.max(this.config.rerankEnrichTopK, plan.limit)))
    const enrichIds = prelim.slice(0, enrichWindow).map(item => item.candidate.entityId)
    const featuresById = await this.priorFeaturesOf(enrichIds, warnings)
    const scored = prelim.map((item, index) => {
      if (index >= enrichWindow) return item
      const features = featuresById.get(item.candidate.entityId)
      // 窗口内但没拿到富化数据：与窗口外完全同一套中性策略，不额外加减乘数。
      return features === undefined ? item : scoreOf(item.candidate, item.summary, features)
    })
    scored.sort(compareScored)
    const selected = scored.slice(0, plan.limit)

    const titles = new Map<string, string>()
    for (const summary of summaryMap.values()) {
      if (summary.title !== undefined) titles.set(summary.id, summary.title)
    }
    const siblingIds = new Set<string>()
    for (const item of selected) collectSiblingIds(item.candidate.entityId, expansion.chains, siblingIds)
    const missingSiblingIds = [...siblingIds].filter(id => !summaryMap.has(id)).sort()
    if (missingSiblingIds.length > 0) {
      try {
        const summaries = await this.store.summaries(missingSiblingIds)
        for (const summary of summaries) {
          summaryMap.set(summary.id, summary)
          if (summary.title !== undefined) titles.set(summary.id, summary.title)
        }
      } catch (error) {
        warnings.push(`读取思维链同组标题失败：${toOmbError(error).message}`)
      }
    }

    const hits: RecallHit[] = selected.map(item => {
      const candidate = item.candidate
      const channels = sortChannels(candidate.rawByChannel.keys())
      const rawScores: Partial<Record<RecallChannel, number>> = {}
      for (const channel of channels) {
        const raw = candidate.rawByChannel.get(channel)
        if (raw !== undefined) rawScores[channel] = raw
      }
      return {
        entityId: candidate.entityId,
        kind: item.summary.kind,
        ...(item.summary.title === undefined ? {} : { title: item.summary.title }),
        snippet: item.summary.snippet,
        ...(item.summary.category === undefined ? {} : { category: item.summary.category }),
        ...(item.summary.status === undefined ? {} : { status: item.summary.status }),
        scope: item.summary.scope,
        updatedAt: item.summary.updatedAt,
        lifecycle: item.summary.lifecycle,
        ...(item.summary.supersededAt === undefined ? {} : { supersededAt: item.summary.supersededAt }),
        ...(item.summary.supersededBy === undefined ? {} : { supersededBy: item.summary.supersededBy }),
        ...(item.summary.retractedAt === undefined ? {} : { retractedAt: item.summary.retractedAt }),
        ...(item.summary.validFrom === undefined ? {} : { validFrom: item.summary.validFrom }),
        ...(item.summary.validTo === undefined ? {} : { validTo: item.summary.validTo }),
        score: item.score,
        fusedScore: candidate.fused,
        why: explainHit({ candidate, prior: item.prior, score: item.score }),
        channels,
        rawScores,
        chainSiblings: chainSiblingTitles(candidate.entityId, expansion.chains, titles),
        historyCount: item.summary.historyCount,
        ...(candidate.link === undefined ? {} : { expanded: true }),
      }
    })

    await this.recordRecall(input, hits, warnings)
    // 访问计数只记当前有效条目：历史条目的访问不该反过来影响当前重排/遗忘。
    const currentHits = hits.filter(hit => hit.lifecycle === 'active').map(hit => hit.entityId)
    if (currentHits.length > 0) await this.store.markAccessed?.(currentHits).catch(() => {})

    return {
      traceId: input.traceId,
      configVersion: this.config.version,
      scenario: plan.scenario,
      query: plan.query,
      hits,
      channelErrors: stageOne.errors,
      channels: stageOne.reports,
      expansion: expansionStats,
      warnings,
      timings: { stageOneMs, totalMs: performance.now() - startedAt },
    }
  }

  /** 阶段二：计划要求图扩展时才执行；失败只降级为 warning，阶段一结果照常返回。 */
  private async expand(
    plan: RetrievalPlan,
    seedSet: SeedSet,
    warnings: string[],
    nowMs: number,
  ): Promise<ExpansionRunResult> {
    const empty: ExpansionRunResult = { expansions: [], chains: new Map(), warnings: [], outcomes: [] }
    if (plan.expand === 'none') return empty
    try {
      const result = await runExpansionProviders(
        plan,
        { store: this.store, embedder: this.embedder },
        { nowMs, seeds: seedSet.entityIds },
      )
      warnings.push(...result.warnings)
      return result
    } catch (error) {
      warnings.push(`图扩展失败（阶段一结果保留）：${toOmbError(error).message}`)
      return empty
    }
  }

  /**
   * 精排富化：**一次**批量读取（不逐条 `store.get`，也不轮询）。
   * 返回缺失/抛错/端口未实现都退化为中性策略：对应候选保持初排分数，
   * 与其它未富化候选完全一致，不产生位置相关的惩罚或奖励。
   */
  private async priorFeaturesOf(
    ids: readonly string[],
    warnings: string[],
  ): Promise<Map<string, EntityPriorFeatures>> {
    const features = new Map<string, EntityPriorFeatures>()
    if (ids.length === 0) return features
    if (this.store.priorFeatures === undefined) {
      if (!this.enrichmentGapReported) {
        this.enrichmentGapReported = true
        warnings.push('存储未实现批量富化读取（priorFeatures）：精排退化为摘要级中性先验。')
      }
      return features
    }
    try {
      for (const item of await this.store.priorFeatures(ids)) features.set(item.entityId, item)
    } catch (error) {
      warnings.push(`批量富化失败（未富化候选按中性先验处理）：${toOmbError(error).message}`)
      return features
    }
    if (features.size < ids.length) {
      warnings.push(`批量富化只返回 ${features.size}/${ids.length} 条，其余按中性先验处理`)
    }
    return features
  }

  private async recordRecall(
    execution: RecallExecution,
    hits: readonly RecallHit[],
    warnings: string[],
  ): Promise<void> {
    const events: RecallEventInput[] = []
    hits.forEach((hit, index) => {
      for (const channel of hit.channels) {
        const rawScore = hit.rawScores[channel]
        if (rawScore === undefined) continue
        events.push({
          traceId: execution.traceId,
          ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
          ...(execution.turnId === undefined ? {} : { turnId: execution.turnId }),
          ...(execution.plan.query.length === 0 ? {} : { query: execution.plan.query }),
          ...(execution.trigger === undefined ? {} : { trigger: execution.trigger }),
          entityId: hit.entityId,
          channel,
          rank: index + 1,
          rawScore,
          fusedScore: hit.fusedScore,
          injected: execution.injected,
        })
      }
    })
    if (events.length === 0) return
    try {
      await this.store.recordRecall(events)
    } catch (error) {
      warnings.push(`recall_event 写入失败：${toOmbError(error).message}`)
    }
  }
}
