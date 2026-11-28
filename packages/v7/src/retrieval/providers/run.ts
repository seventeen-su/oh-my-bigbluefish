import { toOmbError } from '../../domain/errors.js'
import type { Expansion } from '../../domain/link.js'
import type { Embedder } from '../../ports/embedding.js'
import type { Store } from '../../ports/store.js'
import type { ChannelHit, SearchBase } from '../../ports/search.js'
import type { ProviderChannel, RetrievalPlan } from '../compiler.js'
import type {
  IndexProvider,
  ProviderContext,
  ProviderIssue,
  ProviderOutcome,
  ProviderResult,
  ProviderStatus,
} from './types.js'

/**
 * Provider runner：统一 deadline、失败隔离与结果归一化。
 *
 * 不变量：
 * - 一个 provider 抛错/超时只影响它自己：返回 `failed`/`deadline` 状态，不向上冒泡。
 * - deadline 先看计划是否已过期（不启动新查询），再按 `min(provider.timeoutMs, 剩余预算)` 计时。
 * - 超时/计划过期都会把 timeoutMs 传进 store；适配器用它做服务端取消
 *   （PostgreSQL 事务级 statement_timeout），不是只放弃等待 Promise（RET-10）。
 * - 命中归一化（rank 排序、按 entityId 去重、截断到 provider limit）在这里做一次，
 *   与旧 channels.normalizeHits 行为一致，provider 不重复实现。
 */

export interface ProviderRunServices {
  readonly store: Store
  readonly embedder: Embedder
}

export interface ProviderRunOptions {
  /** 执行锚点（ms）：deadline 检查与超时窗口都从这里算。 */
  readonly nowMs: number
  readonly previous?: ReadonlyMap<ProviderChannel, readonly ChannelHit[]>
  readonly seeds?: readonly string[]
  readonly expansions?: readonly Expansion[]
}

class ProviderDeadlineError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`provider deadline ${timeoutMs}ms`)
    this.name = 'ProviderDeadlineError'
    this.timeoutMs = timeoutMs
  }
}

/** 计划里该 provider 的候选上限；计划缺省时回退到全局候选预算。 */
export function providerLimit(plan: RetrievalPlan, channel: ProviderChannel): number {
  const config = plan.providers.find(entry => entry.channel === channel)
  return config?.limit ?? plan.budget.candidates
}

/** 计划过滤条件 → store 的 SearchBase；所有 provider 共用一份映射，避免语义漂移。 */
export function searchBase(plan: RetrievalPlan, limit: number, timeoutMs?: number): SearchBase {
  return {
    ...(plan.filters.scope === undefined ? {} : { scope: plan.filters.scope }),
    ...(plan.filters.projectKey === undefined ? {} : { projectKey: plan.filters.projectKey }),
    ...(plan.filters.kind === undefined ? {} : { kind: plan.filters.kind }),
    ...(plan.filters.category === undefined ? {} : { category: plan.filters.category }),
    ...(plan.filters.status === undefined ? {} : { status: plan.filters.status }),
    ...(plan.filters.includeArchived ? { includeArchived: true } : {}),
    ...(plan.filters.includeHistory ? { includeHistory: true } : {}),
    ...(plan.filters.includeSuperseded ? { includeSuperseded: true } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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

function outcomeOf(
  channel: ProviderChannel,
  status: ProviderStatus,
  startedAt: number,
  extras: Partial<Omit<ProviderOutcome, 'channel' | 'status' | 'elapsedMs'>> = {},
): ProviderOutcome {
  return {
    channel,
    status,
    hits: extras.hits ?? [],
    expansions: extras.expansions ?? [],
    chains: extras.chains ?? new Map(),
    ...(extras.reason === undefined ? {} : { reason: extras.reason }),
    issues: extras.issues ?? [],
    warnings: extras.warnings ?? [],
    elapsedMs: performance.now() - startedAt,
  }
}

function issueOf(error: unknown): ProviderIssue {
  const normalized = toOmbError(error)
  return { code: normalized.code, message: normalized.message, retryable: normalized.retryable ?? false }
}

function finalize(channel: ProviderChannel, result: ProviderResult, limit: number, startedAt: number): ProviderOutcome {
  const hits = normalizeHits(result.hits ?? [], limit)
  // provider 返回 ok 但没命中（或被 rank/去重过滤光）就是 empty：避免 report 里出现 “ok + 0 命中” 的歧义。
  const status: ProviderStatus = result.status === 'ok' || result.status === 'empty'
    ? hits.length > 0 ? 'ok' : 'empty'
    : result.status
  return outcomeOf(channel, status, startedAt, {
    hits,
    expansions: result.expansions === undefined ? [] : [...result.expansions],
    ...(result.chains === undefined ? {} : { chains: result.chains }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    issues: result.issues ?? [],
    warnings: result.warnings ?? [],
  })
}

/**
 * 执行单个 provider。
 *
 * 状态判定顺序：计划未启用 → skipped；计划 deadline 已过期 → deadline（不启动查询）；
 * provider 抛错 → failed；超过该 provider 的超时 → deadline。
 */
export async function runProvider(
  provider: IndexProvider,
  plan: RetrievalPlan,
  services: ProviderRunServices,
  options: ProviderRunOptions,
): Promise<ProviderOutcome> {
  const startedAt = performance.now()
  const config = plan.providers.find(entry => entry.channel === provider.channel)
  if (config === undefined || !config.enabled) {
    return outcomeOf(provider.channel, 'skipped', startedAt, { reason: '计划未启用该 provider' })
  }
  const remaining = plan.deadline.atMs - options.nowMs
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return outcomeOf(provider.channel, 'deadline', startedAt, {
      reason: `计划 deadline 已过期（at=${new Date(plan.deadline.atMs).toISOString()}）`,
    })
  }
  const timeoutMs = Math.min(config.timeoutMs, remaining)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const context: ProviderContext = {
    store: services.store,
    embedder: services.embedder,
    now: plan.time.now,
    signal: controller.signal,
    timeoutMs,
    previous: options.previous ?? new Map(),
    seeds: options.seeds ?? [],
    expansions: options.expansions ?? [],
  }
  let work: Promise<ProviderResult>
  try {
    work = provider.search(plan, context)
  } catch (error) {
    return outcomeOf(provider.channel, 'failed', startedAt, {
      reason: toOmbError(error).message,
      issues: [issueOf(error)],
    })
  }
  // deadline 之后底层查询仍可能 settle：提前挂空 catch，避免 unhandled rejection。
  work.catch(() => {})
  try {
    const result = await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new ProviderDeadlineError(timeoutMs))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
    return finalize(provider.channel, result, config.limit, startedAt)
  } catch (error) {
    if (error instanceof ProviderDeadlineError) {
      return outcomeOf(provider.channel, 'deadline', startedAt, {
        reason: `deadline ${timeoutMs}ms 内未完成`,
      })
    }
    return outcomeOf(provider.channel, 'failed', startedAt, {
      reason: toOmbError(error).message,
      issues: [issueOf(error)],
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 并行执行一组 provider；每个 provider 内部已隔离，这里再兜一层防止 runner 自身 bug 冒泡。 */
export async function runProviderSet(
  providers: readonly IndexProvider[],
  plan: RetrievalPlan,
  services: ProviderRunServices,
  options: ProviderRunOptions,
): Promise<readonly ProviderOutcome[]> {
  return Promise.all(providers.map(async provider => {
    try {
      return await runProvider(provider, plan, services, options)
    } catch (error) {
      return outcomeOf(provider.channel, 'failed', performance.now(), {
        reason: toOmbError(error).message,
        issues: [issueOf(error)],
      })
    }
  }))
}
