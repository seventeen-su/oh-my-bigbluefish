import { toOmbError } from '../domain/errors.js'
import { extractQuerySignals, normalizeText, tokenize } from '../domain/text.js'
import type { Embedder } from '../ports/embedding.js'
import type { ChannelHit, SearchBase, Store } from '../ports/store.js'
import type { RetrievalConfig, ScenarioConfig } from './config.js'
import type { ChannelError, ChannelReport, RecallRequest, StageOneChannel, TimeWindow } from './types.js'
import { STAGE_ONE_CHANNELS } from './constants.js'

export interface StageOneDeps {
  readonly store: Store
  readonly embedder: Embedder
}

export interface StageOneInput {
  readonly request: RecallRequest
  readonly config: RetrievalConfig
  readonly scenario: ScenarioConfig
  readonly now: string
}

export interface StageOneOutcome {
  readonly hitsByChannel: ReadonlyMap<StageOneChannel, readonly ChannelHit[]>
  readonly reports: readonly ChannelReport[]
  readonly errors: readonly ChannelError[]
  readonly warnings: readonly string[]
}

type ExecutionStatus = 'ok' | 'empty' | 'skipped' | 'failed' | 'unavailable'

interface ChannelExecution {
  readonly status: ExecutionStatus
  readonly hits: readonly ChannelHit[]
  readonly reason?: string
}

const VECTOR_DIMS = 512

function searchBase(request: RecallRequest, limit: number): SearchBase {
  return {
    ...(request.scope === undefined ? {} : { scope: request.scope }),
    ...(request.projectKey === undefined ? {} : { projectKey: request.projectKey }),
    ...(request.kind === undefined ? {} : { kind: request.kind }),
    ...(request.category === undefined ? {} : { category: request.category }),
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.includeArchived === true ? { includeArchived: true } : {}),
    ...(request.includeHistory === true ? { includeHistory: true } : {}),
    limit,
  }
}

function normalizeHits(hits: readonly ChannelHit[], limit: number): ChannelHit[] {
  const seen = new Set<string>()
  const sorted = [...hits]
    .filter(hit => Number.isFinite(hit.rank) && hit.rank > 0 && Number.isFinite(hit.rawScore))
    .sort((left, right) => left.rank - right.rank)
  const result: ChannelHit[] = []
  for (const hit of sorted) {
    if (seen.has(hit.entityId)) continue
    seen.add(hit.entityId)
    result.push(hit)
    if (result.length >= limit) break
  }
  return result
}

function toExecution(hits: readonly ChannelHit[], limit: number): ChannelExecution {
  const normalized = normalizeHits(hits, limit)
  return { status: normalized.length === 0 ? 'empty' : 'ok', hits: normalized }
}

function resolveNow(now: string, warnings: string[]): number {
  const parsed = Date.parse(now)
  if (Number.isFinite(parsed)) return parsed
  warnings.push(`now 不是合法时间（${now}），时间通道回退到系统时钟`)
  return Date.now()
}

/**
 * 从查询里解析显式相对时间（今天/昨天/前天/上周/最近 N 天周月/N 天前）。
 * 只做确定性匹配，不猜「上次/之前」——那是调用方切到 `last-time` 场景的事。
 */
export function queryTimeWindow(query: string, nowIso: string): TimeWindow | undefined {
  const anchor = Date.parse(nowIso)
  if (!Number.isFinite(anchor)) return undefined
  const startOfUtcDay = (ms: number): number => {
    const date = new Date(ms)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  }
  const to = new Date(anchor).toISOString()
  if (/昨天/.test(query)) return { from: new Date(startOfUtcDay(anchor) - 86_400_000).toISOString(), to }
  if (/前天/.test(query)) return { from: new Date(startOfUtcDay(anchor) - 2 * 86_400_000).toISOString(), to }
  if (/今天/.test(query)) return { from: new Date(startOfUtcDay(anchor)).toISOString(), to }
  if (/上周|过去一周|最近一周/.test(query)) return { from: new Date(anchor - 7 * 86_400_000).toISOString(), to }
  const relative = /最近\s*(\d{1,3})\s*(天|日|周|个?月)/.exec(query) ?? /(\d{1,3})\s*(天|日|周|个?月)(?:前|内)/.exec(query)
  if (relative !== null) {
    const count = Number(relative[1])
    const unit = relative[2] ?? '天'
    if (!Number.isFinite(count) || count <= 0) return undefined
    const days = unit.includes('周') ? count * 7 : unit.includes('月') ? count * 30 : count
    return { from: new Date(anchor - Math.min(days, 365) * 86_400_000).toISOString(), to }
  }
  return undefined
}

/**
 * 时间通道的回看窗：显式 timeWindow 优先，其次查询里的相对时间，
 * 最后按场景 timeWindowDays 回推。`last-time` 场景把窗口放宽（60 天），
 * 由 config 的 scenarios 表集中控制。
 */
export function resolveTimeWindow(
  request: RecallRequest,
  scenario: ScenarioConfig,
  now: string,
  warnings: string[],
): TimeWindow {
  if (request.timeWindow !== undefined) {
    const from = Date.parse(request.timeWindow.from)
    const to = Date.parse(request.timeWindow.to)
    if (Number.isFinite(from) && Number.isFinite(to) && from <= to) {
      return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
    }
    warnings.push('timeWindow 不是合法且 from<=to 的 ISO 时间，已回退到场景默认时间窗')
  }
  const anchor = resolveNow(now, warnings)
  const queryWindow = queryTimeWindow(request.query, new Date(anchor).toISOString())
  if (queryWindow !== undefined) return queryWindow
  return {
    from: new Date(anchor - scenario.timeWindowDays * 86_400_000).toISOString(),
    to: new Date(anchor).toISOString(),
  }
}

function triggerKeys(query: string): string[] {
  const signals = extractQuerySignals(query)
  const keys = new Set<string>()
  for (const value of [...signals.paths, ...signals.errorCodes, ...signals.identifiers]) {
    const trimmed = value.trim()
    if (trimmed.length > 0) keys.add(trimmed)
  }
  return [...keys]
}

/**
 * 阶段一：六通道。
 *
 * 六个里五个并行执行；`single_char` 的触发条件本身依赖 fulltext 结果
 * （全文零命中 + 查询很短），所以它必须在 fulltext 之后串行执行。
 * 单通道异常只进 channelErrors，不影响其它通道；vector 不可用标 unavailable，
 * 不能当成 0 分（0 分会污染 RRF 与门控）。
 */
export async function runStageOne(deps: StageOneDeps, input: StageOneInput): Promise<StageOneOutcome> {
  const { store, embedder } = deps
  const { request, config, scenario, now } = input
  const warnings: string[] = []
  const errors: ChannelError[] = []
  const executions = new Map<StageOneChannel, ChannelExecution>()
  const base = searchBase(request, config.channelLimit)
  const normalizedQuery = normalizeText(request.query)
  const anchor = resolveNow(now, warnings)
  const normalizedNow = new Date(anchor).toISOString()
  const timeWindow = resolveTimeWindow(request, scenario, normalizedNow, warnings)

  const recordError = (channel: StageOneChannel, error: unknown): void => {
    const normalized = toOmbError(error)
    errors.push({ channel, code: normalized.code, message: normalized.message, retryable: normalized.retryable ?? false })
  }

  const tasks: { readonly channel: StageOneChannel; readonly execute: () => Promise<ChannelExecution> }[] = [
    {
      channel: 'trigger',
      execute: async () => {
        const keys = triggerKeys(request.query)
        // 动态 regex 触发键由应用层执行，任意查询文本都可能是候选；
        // 没有路径/标识符/错误码时不能直接跳过，否则带 flags 的正则触发永远无候选。
        const regexText = normalizedQuery.length > 0 ? request.query : undefined
        if (keys.length === 0 && regexText === undefined) {
          return { status: 'skipped', hits: [], reason: '查询为空，没有可匹配的触发键或正则文本' }
        }
        try {
          const hits = await store.triggers({
            ...base,
            keys,
            ...(regexText === undefined ? {} : { regexText }),
          })
          return toExecution(hits, config.channelLimit)
        } catch (error) {
          // 正则分支超时说明存在病态正则：记录 channel error 后**只重试字面触发键**。
          // 不能把整个 trigger 通道标 failed，否则路径/错误码/实体等字面命中会被一条正则连坐。
          if (toOmbError(error).code !== 'sandbox-timeout') throw error
          recordError('trigger', error)
          const fallback = await store.triggers({ ...base, keys })
          return {
            ...toExecution(fallback, config.channelLimit),
            reason: '正则触发匹配超时，已降级为仅按字面触发键匹配',
          }
        }
      },
    },
    {
      channel: 'fulltext',
      execute: async () => {
        const tokens = tokenize(request.query)
        if (tokens.length === 0) return { status: 'skipped', hits: [], reason: '查询为空，没有全文词' }
        const hits = await store.fulltext({ ...base, query: request.query, tokens })
        return toExecution(hits, config.channelLimit)
      },
    },
    {
      channel: 'vector',
      execute: async () => {
        if (normalizedQuery.length === 0) return { status: 'skipped', hits: [], reason: '查询为空，跳过向量检索' }
        let available: boolean
        try {
          available = await embedder.available()
        } catch (error) {
          recordError('vector', error)
          return { status: 'unavailable', hits: [], reason: '嵌入器可用性检查失败' }
        }
        if (!available) return { status: 'unavailable', hits: [], reason: '嵌入器不可用' }
        if (embedder.dims !== VECTOR_DIMS) {
          return { status: 'unavailable', hits: [], reason: `嵌入维度 ${embedder.dims} 与存储的 ${VECTOR_DIMS} 不匹配` }
        }
        let embedding: number[]
        try {
          const vectors = await embedder.embed([request.query])
          const first = vectors[0]
          if (first === undefined || first.length !== VECTOR_DIMS) {
            recordError('vector', new Error(`嵌入器返回的向量维度不是 ${VECTOR_DIMS}`))
            return { status: 'unavailable', hits: [], reason: '嵌入结果维度不匹配' }
          }
          embedding = first
        } catch (error) {
          recordError('vector', error)
          return { status: 'unavailable', hits: [], reason: '嵌入失败' }
        }
        const hits = await store.vector({ ...base, embedding })
        return toExecution(hits, config.channelLimit)
      },
    },
    {
      channel: 'time',
      execute: async () => {
        const hits = await store.time({ ...base, from: timeWindow.from, to: timeWindow.to, now: normalizedNow })
        return toExecution(hits, config.channelLimit)
      },
    },
    {
      channel: 'state_board',
      execute: async () => {
        // 当前项目看板：没有显式 scope 但给了项目键时，按项目收窄；显式 global 时看全局。
        const boardBase: SearchBase = request.scope === undefined && request.projectKey !== undefined
          ? { ...base, scope: 'project', projectKey: request.projectKey }
          : base
        const hits = await store.stateBoard({ ...boardBase, now: normalizedNow })
        return toExecution(hits, config.channelLimit)
      },
    },
  ]

  const settled = await Promise.allSettled(tasks.map(task => task.execute()))
  settled.forEach((result, index) => {
    const task = tasks[index]
    if (task === undefined) return
    if (result.status === 'fulfilled') {
      executions.set(task.channel, result.value)
      return
    }
    recordError(task.channel, result.reason)
    executions.set(task.channel, { status: 'failed', hits: [], reason: toOmbError(result.reason).message })
  })

  // fulltext 零命中且查询足够短时才跑单字 LIKE 回退。
  const fulltextExecution = executions.get('fulltext')
  const fulltextHitCount = fulltextExecution?.hits.length ?? 0
  if (fulltextHitCount > 0) {
    executions.set('single_char', { status: 'skipped', hits: [], reason: '全文已有命中，不需要单字回退' })
  } else if (normalizedQuery.length === 0) {
    executions.set('single_char', { status: 'skipped', hits: [], reason: '查询为空' })
  } else if (normalizedQuery.length > config.singleCharMaxQueryLength) {
    executions.set('single_char', {
      status: 'skipped',
      hits: [],
      reason: `查询长度 ${normalizedQuery.length} > ${config.singleCharMaxQueryLength}，不做单字回退`,
    })
  } else {
    try {
      const hits = await store.singleChar({ ...base, query: normalizedQuery, tokens: tokenize(request.query) })
      const execution = toExecution(hits, config.channelLimit)
      executions.set('single_char', execution)
    } catch (error) {
      recordError('single_char', error)
      executions.set('single_char', { status: 'failed', hits: [], reason: toOmbError(error).message })
    }
  }

  const hitsByChannel = new Map<StageOneChannel, readonly ChannelHit[]>()
  for (const channel of STAGE_ONE_CHANNELS) {
    const execution = executions.get(channel)
    if (execution === undefined) {
      executions.set(channel, { status: 'failed', hits: [], reason: '通道没有执行结果' })
      hitsByChannel.set(channel, [])
      continue
    }
    if (execution.hits.length > 0) hitsByChannel.set(channel, execution.hits)
  }

  const reports: ChannelReport[] = STAGE_ONE_CHANNELS.map(channel => {
    const execution = executions.get(channel)
    if (execution === undefined) {
      return { channel, status: 'failed', hitCount: 0, reason: '通道没有执行结果' }
    }
    return {
      channel,
      status: execution.status,
      hitCount: execution.hits.length,
      ...(execution.reason === undefined ? {} : { reason: execution.reason }),
    }
  })

  return { hitsByChannel, reports, errors, warnings }
}
