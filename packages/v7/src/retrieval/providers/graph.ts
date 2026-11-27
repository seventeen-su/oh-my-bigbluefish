import type { Entity } from '../../domain/entity.js'
import { attributeValue, titleOf } from '../../domain/entity-access.js'
import type { JsonValue } from '../../domain/json.js'
import type { Expansion } from '../../domain/link.js'
import { filterExpansions, type ChainInfo } from '../expand.js'
import type { RetrievalPlan } from '../compiler.js'
import { runProvider, type ProviderRunServices } from './run.js'
import type { IndexProvider, ProviderContext, ProviderOutcome, ProviderResult } from './types.js'

/**
 * 阶段二两个 provider：
 * - `expand`：按计划种子执行 1–2 跳图扩展（store.expand）；
 * - `links`：按计划的 expand 模式收敛扩展结果（links/chain/both），并按需读取思维链组。
 *
 * 拆成两个 provider 是为了让「取扩展」和「收敛/解析链」各有独立状态与 deadline；
 * 任一失败都只影响阶段二，阶段一命中照常返回（engine 把失败降级成 warning）。
 */

function skipped(reason: string): ProviderResult {
  return { status: 'skipped', reason }
}

function groupMembers(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

/** 1–2 跳图扩展；种子来自 engine 的 collectSeeds（每通道前 seedLimit 的并集）。 */
export class ExpandProvider implements IndexProvider {
  readonly channel = 'expand' as const

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    if (plan.expand === 'none') return skipped('expand=none，不执行阶段二图扩展')
    if (context.seeds.length === 0) return skipped('没有阶段一种子，不执行图扩展')
    const expansions = await context.store.expand(
      context.seeds,
      plan.hops,
      plan.filters.includeArchived ? { includeArchived: true } : {},
    )
    return { status: 'ok', expansions }
  }
}

/**
 * 收敛图扩展：
 * - `links` 只保留链接扩展，**不读思维链组**；
 * - `chain` 只保留思维链扩展，并读取组属性拿全部成员与标题；
 * - `both` 两者都要。
 * 组读取失败只降级该组的成员集合（保留扩展里出现过的成员）并留 warning，不影响阶段一。
 */
export class LinksProvider implements IndexProvider {
  readonly channel = 'links' as const

  async search(plan: RetrievalPlan, context: ProviderContext): Promise<ProviderResult> {
    if (plan.expand === 'none') return skipped('expand=none，不做链接/思维链收敛')
    const includeChains = plan.expand === 'chain' || plan.expand === 'both'
    const expansions = filterExpansions(context.expansions, plan.expand)
    const warnings: string[] = []
    const chains = includeChains
      ? await resolveChains(plan, context, warnings)
      : new Map<string, ChainInfo>()
    return {
      status: expansions.length > 0 ? 'ok' : 'empty',
      expansions,
      chains,
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }
}

async function resolveChains(
  plan: RetrievalPlan,
  context: ProviderContext,
  warnings: string[],
): Promise<ReadonlyMap<string, ChainInfo>> {
  const chainIds: string[] = []
  const membersByChain = new Map<string, Set<string>>()
  for (const expansion of context.expansions) {
    const chainId = expansion.chainId
    if (chainId === undefined) continue
    if (!membersByChain.has(chainId)) {
      chainIds.push(chainId)
      membersByChain.set(chainId, new Set())
    }
    membersByChain.get(chainId)?.add(expansion.entityId)
  }
  chainIds.sort()
  const limited = chainIds.slice(0, Math.max(1, plan.budget.chainGroups))
  if (chainIds.length > limited.length) {
    warnings.push(`发现 ${chainIds.length} 个思维链组，只解析前 ${limited.length} 个（maxChainGroups）`)
  }
  const entities = await Promise.allSettled(limited.map(chainId =>
    context.store.get(chainId, plan.filters.includeArchived ? { includeArchived: true } : {}),
  ))
  const chains = new Map<string, ChainInfo>()
  entities.forEach((settled, index) => {
    const chainId = limited[index]
    if (chainId === undefined) return
    const members = new Set(membersByChain.get(chainId) ?? [])
    let title: string | undefined
    let entity: Entity | undefined
    if (settled.status === 'fulfilled') entity = settled.value
    else warnings.push(`读取思维链组 ${chainId} 失败：${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`)
    if (entity !== undefined) {
      title = titleOf(entity)
      for (const memberId of groupMembers(attributeValue(entity, 'group'))) members.add(memberId)
    }
    chains.set(chainId, { chainId, members, ...(title === undefined ? {} : { title }) })
  })
  return chains
}

export interface ExpansionRunOptions {
  readonly nowMs: number
  readonly seeds: readonly string[]
}

export interface ExpansionRunResult {
  /** 收敛后的扩展（已按计划 expand 模式裁剪）。 */
  readonly expansions: readonly Expansion[]
  readonly chains: ReadonlyMap<string, ChainInfo>
  /** 阶段二降级/部分失败的提示；engine 原样并入 RecallResult.warnings。 */
  readonly warnings: readonly string[]
  readonly outcomes: readonly ProviderOutcome[]
}

/** 顺序执行 expand → links；任一步失败都返回空扩展 + 明确 warning，不向上抛。 */
export async function runExpansionProviders(
  plan: RetrievalPlan,
  services: ProviderRunServices,
  options: ExpansionRunOptions,
): Promise<ExpansionRunResult> {
  const warnings: string[] = []
  if (plan.expand === 'none') {
    return { expansions: [], chains: new Map(), warnings, outcomes: [] }
  }
  const expandOutcome = await runProvider(new ExpandProvider(), plan, services, {
    nowMs: options.nowMs,
    seeds: options.seeds,
  })
  const outcomes: ProviderOutcome[] = [expandOutcome]
  warnings.push(...expandOutcome.warnings)
  if (expandOutcome.status === 'failed' || expandOutcome.status === 'deadline') {
    warnings.push(`图扩展失败（阶段一结果保留）：${expandOutcome.reason ?? '未知错误'}`)
    return { expansions: [], chains: new Map(), warnings, outcomes }
  }
  if (expandOutcome.expansions.length === 0) {
    return { expansions: [], chains: new Map(), warnings, outcomes }
  }
  const linksOutcome = await runProvider(new LinksProvider(), plan, services, {
    nowMs: options.nowMs,
    expansions: expandOutcome.expansions,
  })
  outcomes.push(linksOutcome)
  warnings.push(...linksOutcome.warnings)
  if (linksOutcome.status === 'failed' || linksOutcome.status === 'deadline') {
    warnings.push(`思维链/链接收敛失败（阶段一结果保留）：${linksOutcome.reason ?? '未知错误'}`)
    return { expansions: [], chains: new Map(), warnings, outcomes }
  }
  return { expansions: linksOutcome.expansions, chains: linksOutcome.chains, warnings, outcomes }
}

/** 阶段二 provider 的固定顺序（expand 产出 links 的输入）。 */
export function createExpansionProviders(): readonly IndexProvider[] {
  return [new ExpandProvider(), new LinksProvider()]
}
