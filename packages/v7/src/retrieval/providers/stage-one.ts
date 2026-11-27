import { toOmbError } from '../../domain/errors.js'
import type { ChannelHit } from '../../ports/search.js'
import type { RetrievalPlan } from '../compiler.js'
import { providerLimit, searchBase } from './run.js'
import type { IndexProvider, ProviderContext, ProviderIssue, ProviderResult } from './types.js'

/**
 * 阶段一六个 provider：trigger / fulltext / single_char / vector / time / state_board。
 *
 * 每个 provider 只封装一条既有 store 查询 + 该通道自己的跳过/降级规则：
 * - trigger：路径/错误码/标识符来自**计划里已解析好的 signals**，不再各自解析查询；
 * - fulltext：用计划里的加权词表（有界），store 侧仍按词面优先级裁剪并走 OR tsquery；
 * - single_char：只在 fulltext 零命中且查询短时才跑，查 `chars GIN + search_text`（不退化用 snippet）；
 * - vector：嵌入不可用/维度不符标 unavailable，不当 0 分；
 * - time：窗口直接来自 `plan.time.lookback`；
 * - state_board：没显式 scope 但有 projectKey 时按项目收窄。
 */

const VECTOR_DIMS = 512

function skipped(reason: string): ProviderResult {
  return { status: 'skipped', reason }
}

function issueOf(error: unknown): ProviderIssue {
  const normalized = toOmbError(error)
  return { code: normalized.code, message: normalized.message, retryable: normalized.retryable ?? false }
}

/** 字面触发键：顺序与旧 channels.triggerKeys 一致（paths → errorCodes → identifiers），去重保序。 */
function triggerKeys(plan: RetrievalPlan): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const value of [...plan.signals.paths, ...plan.signals.errorCodes, ...plan.signals.identifiers]) {
    const trimmed = value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    keys.push(trimmed)
  }
  return keys
}

export class TriggerProvider implements IndexProvider {
  readonly channel = 'trigger' as const

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    const keys = triggerKeys(plan)
    // 动态 regex 触发键由应用层执行，任意查询文本都可能是候选；
    // 没有路径/标识符/错误码时不能直接跳过，否则带 flags 的正则触发永远无候选。
    const regexText = plan.normalizedQuery.length > 0 ? plan.query : undefined
    if (keys.length === 0 && regexText === undefined) {
      return skipped('查询为空，没有可匹配的触发键或正则文本')
    }
    const base = searchBase(plan, providerLimit(plan, 'trigger'))
    try {
      const hits = await context.store.triggers({
        ...base,
        keys,
        ...(regexText === undefined ? {} : { regexText }),
      })
      return { status: 'ok', hits }
    } catch (error) {
      // 正则分支超时说明存在病态正则：记录 channel error 后**只重试字面触发键**。
      // 不能把整个 trigger 通道标 failed，否则路径/错误码等字面命中会被一条正则连坐。
      if (toOmbError(error).code !== 'sandbox-timeout') throw error
      const fallback = await context.store.triggers({ ...base, keys })
      return {
        status: 'ok',
        hits: fallback,
        reason: '正则触发匹配超时，已降级为仅按字面触发键匹配',
        issues: [issueOf(error)],
      }
    }
  }
}

export class FulltextProvider implements IndexProvider {
  readonly channel = 'fulltext' as const

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    if (plan.terms.length === 0) return skipped('查询为空，没有全文词')
    const hits = await context.store.fulltext({
      ...searchBase(plan, providerLimit(plan, 'fulltext')),
      query: plan.query,
      tokens: plan.terms.map(term => term.term),
    })
    return { status: 'ok', hits }
  }
}

/** 依赖 fulltext 命中数的通道：fulltext 有命中时单字回退没有价值，直接跳过。 */
export class SingleCharProvider implements IndexProvider {
  readonly channel = 'single_char' as const
  readonly afterStageOne = true

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    const fulltextHits: readonly ChannelHit[] = context.previous.get('fulltext') ?? []
    if (fulltextHits.length > 0) return skipped('全文已有命中，不需要单字回退')
    if (plan.normalizedQuery.length === 0) return skipped('查询为空')
    const maxLength = plan.thresholds.singleCharMaxQueryLength
    if (plan.normalizedQuery.length > maxLength) {
      return skipped(`查询长度 ${plan.normalizedQuery.length} > ${maxLength}，不做单字回退`)
    }
    const hits = await context.store.singleChar({
      ...searchBase(plan, providerLimit(plan, 'single_char')),
      query: plan.normalizedQuery,
      tokens: plan.terms.map(term => term.term),
    })
    return { status: 'ok', hits }
  }
}

export class VectorProvider implements IndexProvider {
  readonly channel = 'vector' as const

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    if (plan.normalizedQuery.length === 0) return skipped('查询为空，跳过向量检索')
    const { embedder } = context
    let available: boolean
    try {
      available = await embedder.available()
    } catch (error) {
      return { status: 'unavailable', reason: '嵌入器可用性检查失败', issues: [issueOf(error)] }
    }
    if (!available) return { status: 'unavailable', reason: '嵌入器不可用' }
    if (embedder.dims !== VECTOR_DIMS) {
      return { status: 'unavailable', reason: `嵌入维度 ${embedder.dims} 与存储的 ${VECTOR_DIMS} 不匹配` }
    }
    let embedding: number[]
    try {
      const vectors = await embedder.embed([plan.query])
      const first = vectors[0]
      if (first === undefined || first.length !== VECTOR_DIMS) {
        return {
          status: 'unavailable',
          reason: '嵌入结果维度不匹配',
          issues: [issueOf(new Error(`嵌入器返回的向量维度不是 ${VECTOR_DIMS}`))],
        }
      }
      embedding = first
    } catch (error) {
      return { status: 'unavailable', reason: '嵌入失败', issues: [issueOf(error)] }
    }
    // store 侧仍在事务里 set local hnsw.iterative_scan = 'relaxed_order'（过滤向量不静默少返回）。
    const hits = await context.store.vector({ ...searchBase(plan, providerLimit(plan, 'vector')), embedding })
    return { status: 'ok', hits }
  }
}

export class TimeProvider implements IndexProvider {
  readonly channel = 'time' as const

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    const hits = await context.store.time({
      ...searchBase(plan, providerLimit(plan, 'time')),
      from: plan.time.lookback.from,
      to: plan.time.lookback.to,
      now: plan.time.now,
    })
    return { status: 'ok', hits }
  }
}

export class StateBoardProvider implements IndexProvider {
  readonly channel = 'state_board' as const

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    // 当前项目看板：没有显式 scope 但给了项目键时，按项目收窄；显式 global 时看全局。
    const narrowToProject = plan.filters.scope === undefined && plan.filters.projectKey !== undefined
    const base = searchBase(plan, providerLimit(plan, 'state_board'))
    const boardBase = narrowToProject
      ? { ...base, scope: 'project' as const, projectKey: plan.filters.projectKey }
      : base
    const hits = await context.store.stateBoard({ ...boardBase, now: plan.time.now })
    return { status: 'ok', hits }
  }
}

/** 阶段一 provider 的固定顺序；single_char 通过 `afterStageOne` 声明依赖，由 orchestrator 串行。 */
export function createStageOneProviders(): readonly IndexProvider[] {
  return [
    new TriggerProvider(),
    new FulltextProvider(),
    new SingleCharProvider(),
    new VectorProvider(),
    new TimeProvider(),
    new StateBoardProvider(),
  ]
}
