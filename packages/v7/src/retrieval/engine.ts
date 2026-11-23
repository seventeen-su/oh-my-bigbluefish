import { toOmbError } from '../domain/errors.js'
import type { Entity } from '../domain/entity.js'
import { newId } from '../domain/ids.js'
import { normalizeText } from '../domain/text.js'
import type { Clock } from '../ports/clock.js'
import type { Embedder } from '../ports/embedding.js'
import type { EntitySummary, RecallEventInput, Store } from '../ports/store.js'
import { runStageOne } from './channels.js'
import type { RetrievalConfig, ScenarioConfig } from './config.js'
import { DEFAULT_RETRIEVAL_CONFIG } from './config.js'
import {
  collectSeeds,
  expandSeeds,
  filterExpansions,
  type ChainInfo,
  type ExpansionOutcome,
  type SeedSet,
} from './expand.js'
import {
  applyExpansions,
  fuseStageOne,
  gateCandidates,
  sortChannels,
  type FusionCandidate,
  type GateOutcome,
} from './fuse.js'
import { rerankPrior, type PriorResult } from './rerank.js'
import type {
  ChannelReport,
  EmptyReason,
  ExpansionMode,
  RecallChannel,
  RecallHit,
  RecallRequest,
  RecallResult,
  RecallScenario,
  ExpansionStats,
} from './types.js'

export interface RecallEngineDeps {
  readonly store: Store
  readonly embedder: Embedder
  readonly clock: Clock
  /** 审计配置；缺省用 DEFAULT_RETRIEVAL_CONFIG。 */
  readonly config?: RetrievalConfig
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

const MAX_CHAIN_SIBLINGS = 12

function formatScore(value: number): string {
  return value.toFixed(4)
}

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

function resolveLimit(request: RecallRequest, config: RetrievalConfig): number {
  const requested = request.limit ?? config.defaultLimit
  if (!Number.isFinite(requested)) return config.defaultLimit
  return Math.max(1, Math.min(config.maxLimit, Math.floor(requested)))
}

interface TimeWindowBounds {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * 只有显式 timeWindow 参与最终候选的全局收窄；场景默认窗与查询里的相对时间
 * （昨天/最近 N 天）仍只作用于 time 通道，否则默认召回会被场景窗静默截断。
 * 非法窗（无法解析或 from > to）交给 channels 的 time 通道回退，这里返回
 * undefined 表示“不收窄”，不凭空丢候选。
 */
function explicitTimeWindow(request: RecallRequest): TimeWindowBounds | undefined {
  const window = request.timeWindow
  if (window === undefined) return undefined
  const fromMs = Date.parse(window.from)
  const toMs = Date.parse(window.to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return undefined
  return { fromMs, toMs }
}

/** 无 eventTime（非状态机实体）或时间无法解析时按未知处理：不因时间窗排除。 */
function withinTimeWindow(bounds: TimeWindowBounds, eventTime: string | undefined): boolean {
  if (eventTime === undefined) return true
  const eventMs = Date.parse(eventTime)
  if (!Number.isFinite(eventMs)) return true
  return eventMs >= bounds.fromMs && eventMs <= bounds.toMs
}

function compareScored(left: ScoredCandidate, right: ScoredCandidate): number {
  if (right.score !== left.score) return right.score - left.score
  return left.candidate.entityId < right.candidate.entityId ? -1 : left.candidate.entityId > right.candidate.entityId ? 1 : 0
}

function buildWhy(candidate: FusionCandidate, prior: PriorResult, score: number): string[] {
  const parts: string[] = []
  for (const channel of sortChannels(candidate.rawByChannel.keys())) {
    const raw = candidate.rawByChannel.get(channel)
    if (raw === undefined) continue
    const rank = candidate.rankByChannel.get(channel)
    parts.push(rank === undefined ? `channel:${channel} raw=${formatScore(raw)}` : `channel:${channel}#${rank} raw=${formatScore(raw)}`)
  }
  if (candidate.link !== undefined) {
    const link = candidate.link
    const chain = link.chainId === undefined ? '' : ` chain=${link.chainId}`
    parts.push(`link:hop${link.hop} seed=${link.seedId} decay=${formatScore(link.decay)} via=${link.viaLinkId}${chain}`)
  }
  parts.push(`rrf=${formatScore(candidate.fused)}`)
  parts.push(...prior.reasons)
  parts.push(`score=${formatScore(score)}`)
  return parts
}

function emptyReason(input: {
  readonly query: string
  readonly stageOneHitCount: number
  readonly reports: readonly ChannelReport[]
  readonly gate: GateOutcome
  readonly filteredOut: number
  readonly timeFiltered?: number
  readonly summariesFailed: boolean
}): EmptyReason {
  if (input.stageOneHitCount === 0) {
    if (normalizeText(input.query).length === 0) {
      return {
        code: 'empty-query',
        message: '查询为空：只运行了时间与状态机看板通道，两者都没有命中。',
      }
    }
    const attempted = input.reports.filter(report => report.status !== 'skipped')
    if (attempted.length > 0 && attempted.every(report => report.status === 'failed')) {
      return {
        code: 'all-channels-failed',
        message: '六个通道全部失败：这是存储或嵌入不可用，不代表库里没有相关内容。',
        details: { channels: attempted.map(report => report.channel) },
      }
    }
    return {
      code: 'no-stage-one-hits',
      message: '六个通道均无命中：检查查询词、作用域、归档/历史开关是否把目标排除在外。',
      details: { channels: input.reports.map(report => `${report.channel}:${report.status}`) },
    }
  }
  if (input.gate.passed.length === 0) {
    return {
      code: 'below-threshold',
      message: `有 ${input.gate.belowRaw + input.gate.belowFused} 条候选进入融合，但原始分或融合分低于门控下限；为避免噪声不返回。`,
      details: {
        belowRaw: input.gate.belowRaw,
        belowFused: input.gate.belowFused,
      },
    }
  }
  if (input.summariesFailed) {
    return {
      code: 'summaries-failed',
      message: '候选已通过门控，但读取实体摘要失败，无法给出可解释结果。',
    }
  }
  return {
    code: 'filtered-out',
    message: `有 ${input.gate.passed.length} 条候选通过门控，但都被归档/历史/类型/状态/时间窗过滤排除。`,
    details: {
      filteredOut: input.filteredOut,
      ...(input.timeFiltered === undefined || input.timeFiltered === 0 ? {} : { timeFiltered: input.timeFiltered }),
    },
  }
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
 * 两阶段召回引擎。
 *
 * 阶段一：六通道（五个并行 + 单字回退条件执行），单通道失败隔离。
 * 阶段二：每通道前 seedLimit 做 1–2 跳图扩展（衰减 0.5/0.25），RRF 融合，
 * 原始分门控，场景重排（先验乘数夹在 [0.5, 1.5]），最后写 recall_event。
 * 空结果一定带 emptyReason，不静默返回 []。
 */
export class RecallEngine {
  readonly config: RetrievalConfig
  private readonly store: Store
  private readonly embedder: Embedder
  private readonly clock: Clock

  constructor(deps: RecallEngineDeps) {
    this.store = deps.store
    this.embedder = deps.embedder
    this.clock = deps.clock
    this.config = deps.config ?? DEFAULT_RETRIEVAL_CONFIG
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    const scenarioName: RecallScenario = request.scenario ?? 'manual'
    const scenario: ScenarioConfig = this.config.scenarios[scenarioName]
    const traceId = request.traceId !== undefined && request.traceId.trim().length > 0 ? request.traceId : newId('trace')
    const now = resolveNowIso(request, this.clock)
    const limit = resolveLimit(request, this.config)
    const startedAt = performance.now()

    const stageOne = await runStageOne(
      { store: this.store, embedder: this.embedder },
      { request, config: this.config, scenario, now },
    )
    const stageOneMs = performance.now() - startedAt
    const warnings: string[] = [...stageOne.warnings]
    const stageOneHitCount = [...stageOne.hitsByChannel.values()].reduce((sum, hits) => sum + hits.length, 0)

    const seedSet = collectSeeds(stageOne.hitsByChannel, this.config)
    const expansionMode: ExpansionMode = request.expand ?? 'both'
    const expansion = await this.expand(
      seedSet,
      request.hops === 1 ? 1 : 2,
      expansionMode,
      warnings,
      request.includeArchived === true,
    )
    const expansionStats: ExpansionStats = {
      seeds: seedSet.entityIds.length,
      expanded: expansion.expansions.length,
      chains: expansion.chains.size,
    }

    const candidates = fuseStageOne(stageOne.hitsByChannel, scenario.weights, this.config.rrfK)
    if (expansion.expansions.length > 0) {
      applyExpansions(candidates, expansion.expansions, seedSet, expansion.chains, scenario.weights, this.config)
    }
    const gate = gateCandidates([...candidates.values()], this.config)

    const empty = (reason: EmptyReason): RecallResult => ({
      traceId,
      configVersion: this.config.version,
      scenario: scenarioName,
      query: request.query,
      hits: [],
      emptyReason: reason,
      channelErrors: stageOne.errors,
      channels: stageOne.reports,
      expansion: expansionStats,
      warnings: [...warnings],
      timings: { stageOneMs, totalMs: performance.now() - startedAt },
    })

    if (gate.passed.length === 0) {
      return empty(emptyReason({
        query: request.query,
        stageOneHitCount,
        reports: stageOne.reports,
        gate,
        filteredOut: 0,
        summariesFailed: false,
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
      return empty({
        code: 'summaries-failed',
        message: '候选已通过门控，但读取实体摘要失败，无法给出可解释结果。',
      })
    }

    const filtered: FilteredCandidate[] = []
    let filteredOut = 0
    let timeFiltered = 0
    const timeWindow = explicitTimeWindow(request)
    for (const candidate of gate.passed) {
      const summary = summaryMap.get(candidate.entityId)
      if (summary === undefined) {
        filteredOut += 1
        continue
      }
      if (request.includeArchived !== true && summary.archived) {
        filteredOut += 1
        continue
      }
      if (request.includeHistory !== true && !summary.isCurrent) {
        filteredOut += 1
        continue
      }
      if (request.kind !== undefined && summary.kind !== request.kind) {
        filteredOut += 1
        continue
      }
      if (request.category !== undefined && summary.category !== request.category) {
        filteredOut += 1
        continue
      }
      if (request.status !== undefined && (summary.status === undefined || !request.status.includes(summary.status))) {
        filteredOut += 1
        continue
      }
      // 显式 timeWindow 对最终候选统一收窄：事件时间在窗外的实体不进入 hits。
      // 没有 eventTime 的实体（记忆/思维链等没有 time 属性）按未知处理，不凭空排除。
      if (timeWindow !== undefined && !withinTimeWindow(timeWindow, summary.eventTime)) {
        filteredOut += 1
        timeFiltered += 1
        continue
      }
      filtered.push({ candidate, summary })
    }

    if (filtered.length === 0) {
      return empty(emptyReason({
        query: request.query,
        stageOneHitCount,
        reports: stageOne.reports,
        gate,
        filteredOut,
        timeFiltered,
        summariesFailed: false,
      }))
    }

    const prelim: ScoredCandidate[] = filtered.map(item => {
      const prior = rerankPrior({
        summary: item.summary,
        linkStrength: item.candidate.link?.linkScore ?? 0,
        scenario,
        config: this.config,
        request,
        now,
      })
      return { candidate: item.candidate, summary: item.summary, prior, score: item.candidate.fused * prior.factor }
    })

    const enrichIds = [...prelim]
      .sort(compareScored)
      .slice(0, Math.max(0, this.config.rerankEnrichLimit))
      .map(item => item.candidate.entityId)
    const entities = await this.fetchEntities(enrichIds, warnings, request.includeArchived === true)

    const scored = prelim.map(item => {
      const entity = entities.get(item.candidate.entityId)
      if (entity === undefined) return item
      const prior = rerankPrior({
        summary: item.summary,
        entity,
        linkStrength: item.candidate.link?.linkScore ?? 0,
        scenario,
        config: this.config,
        request,
        now,
      })
      return { candidate: item.candidate, summary: item.summary, prior, score: item.candidate.fused * prior.factor }
    })
    scored.sort(compareScored)
    const selected = scored.slice(0, limit)

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
        score: item.score,
        fusedScore: candidate.fused,
        why: buildWhy(candidate, item.prior, item.score),
        channels,
        rawScores,
        chainSiblings: chainSiblingTitles(candidate.entityId, expansion.chains, titles),
        historyCount: item.summary.historyCount,
        ...(candidate.link === undefined ? {} : { expanded: true }),
      }
    })

    await this.recordRecall(traceId, request, hits, warnings)
    // 访问计数用于采用率先验与遗忘；失败不影响本次召回结果。
    if (hits.length > 0) await this.store.markAccessed?.(hits.map(hit => hit.entityId)).catch(() => {})

    return {
      traceId,
      configVersion: this.config.version,
      scenario: scenarioName,
      query: request.query,
      hits,
      channelErrors: stageOne.errors,
      channels: stageOne.reports,
      expansion: expansionStats,
      warnings,
      timings: { stageOneMs, totalMs: performance.now() - startedAt },
    }
  }

  private async expand(
    seedSet: SeedSet,
    hops: 1 | 2,
    mode: ExpansionMode,
    warnings: string[],
    includeArchived: boolean,
  ): Promise<ExpansionOutcome> {
    if (mode === 'none' || seedSet.entityIds.length === 0) {
      return { expansions: [], chains: new Map(), warnings: [] }
    }
    try {
      // expand=links 不需要读思维链组；chain/both 才解析组属性。
      const includeChains = mode === 'chain' || mode === 'both'
      const outcome = await expandSeeds(this.store, seedSet, hops, this.config, { includeChains, includeArchived })
      warnings.push(...outcome.warnings)
      return {
        expansions: filterExpansions(outcome.expansions, mode),
        chains: includeChains ? outcome.chains : new Map(),
        warnings: outcome.warnings,
      }
    } catch (error) {
      warnings.push(`图扩展失败（阶段一结果保留）：${toOmbError(error).message}`)
      return { expansions: [], chains: new Map(), warnings: [] }
    }
  }

  private async fetchEntities(ids: readonly string[], warnings: string[], includeArchived = false): Promise<Map<string, Entity>> {
    const entities = new Map<string, Entity>()
    if (ids.length === 0) return entities
    const settled = await Promise.allSettled(ids.map(id => this.store.get(id, includeArchived ? { includeArchived: true } : {})))
    let failures = 0
    settled.forEach((result, index) => {
      const id = ids[index]
      if (id === undefined) return
      if (result.status === 'fulfilled') {
        if (result.value !== undefined) entities.set(id, result.value)
        return
      }
      failures += 1
    })
    if (failures > 0) {
      warnings.push(`实体富化失败 ${failures}/${ids.length} 条，未富化条目使用摘要级先验`)
    }
    return entities
  }

  private async recordRecall(
    traceId: string,
    request: RecallRequest,
    hits: readonly RecallHit[],
    warnings: string[],
  ): Promise<void> {
    const events: RecallEventInput[] = []
    hits.forEach((hit, index) => {
      for (const channel of hit.channels) {
        const rawScore = hit.rawScores[channel]
        if (rawScore === undefined) continue
        events.push({
          traceId,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          ...(request.query.length === 0 ? {} : { query: request.query }),
          ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
          entityId: hit.entityId,
          channel,
          rank: index + 1,
          rawScore,
          fusedScore: hit.fusedScore,
          injected: request.injected === true,
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
