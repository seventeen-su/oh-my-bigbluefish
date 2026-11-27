import { attributeValue, titleOf } from '../domain/entity-access.js'
import type { Entity } from '../domain/entity.js'
import type { JsonValue } from '../domain/json.js'
import type { Expansion } from '../domain/link.js'
import type { Store } from '../ports/store.js'
import type { ChannelHit } from '../ports/search.js'
import type { RetrievalConfig } from './config.js'
import type { ExpansionMode, StageOneChannel } from './types.js'
import { STAGE_ONE_CHANNELS } from './constants.js'

export interface SeedRef {
  readonly entityId: string
  readonly channel: StageOneChannel
  readonly rank: number
  readonly rawScore: number
}

export interface SeedSet {
  readonly refs: readonly SeedRef[]
  readonly byEntity: ReadonlyMap<string, readonly SeedRef[]>
  /** 去重后的种子实体（保持首次出现顺序）。 */
  readonly entityIds: readonly string[]
}

export interface ChainInfo {
  readonly chainId: string
  readonly title?: string
  readonly members: ReadonlySet<string>
}

export interface ExpansionOutcome {
  readonly expansions: readonly Expansion[]
  readonly chains: ReadonlyMap<string, ChainInfo>
  readonly warnings: readonly string[]
}

/** 每通道取前 seedLimit 名作为阶段二种子；同实体跨通道保留多条种子记录用于解释。 */
export function collectSeeds(
  hitsByChannel: ReadonlyMap<StageOneChannel, readonly ChannelHit[]>,
  config: RetrievalConfig,
): SeedSet {
  const refs: SeedRef[] = []
  const byEntity = new Map<string, SeedRef[]>()
  const entityIds: string[] = []
  const bootstrapped = new Set<string>()
  for (const channel of STAGE_ONE_CHANNELS) {
    const hits = [...(hitsByChannel.get(channel) ?? [])].sort((left, right) => left.rank - right.rank)
    for (const hit of hits.slice(0, config.seedLimit)) {
      const ref: SeedRef = { entityId: hit.entityId, channel, rank: hit.rank, rawScore: hit.rawScore }
      refs.push(ref)
      const existing = byEntity.get(hit.entityId)
      if (existing === undefined) byEntity.set(hit.entityId, [ref])
      else existing.push(ref)
      if (!bootstrapped.has(hit.entityId)) {
        bootstrapped.add(hit.entityId)
        entityIds.push(hit.entityId)
      }
    }
  }
  return { refs, byEntity, entityIds }
}

const CHANNEL_ORDER: ReadonlyMap<StageOneChannel, number> = new Map(
  STAGE_ONE_CHANNELS.map((channel, index) => [channel, index] as const),
)

function betterSeed(left: SeedRef, right: SeedRef): SeedRef {
  if (left.rank !== right.rank) return left.rank < right.rank ? left : right
  const leftOrder = CHANNEL_ORDER.get(left.channel) ?? Number.MAX_SAFE_INTEGER
  const rightOrder = CHANNEL_ORDER.get(right.channel) ?? Number.MAX_SAFE_INTEGER
  return leftOrder <= rightOrder ? left : right
}

export function bestSeedForEntity(seedSet: SeedSet, entityId: string): SeedRef | undefined {
  const refs = seedSet.byEntity.get(entityId)
  if (refs === undefined || refs.length === 0) return undefined
  return refs.reduce(betterSeed)
}

export function bestSeedOverall(seedSet: SeedSet): SeedRef | undefined {
  let best: SeedRef | undefined
  for (const entityId of seedSet.entityIds) {
    const seed = bestSeedForEntity(seedSet, entityId)
    if (seed === undefined) continue
    best = best === undefined ? seed : betterSeed(best, seed)
  }
  return best
}

/** 链扩展的种子：优先用「组内成员里排名最好的种子」解释来源。 */
export function bestSeedForChain(seedSet: SeedSet, chain: ChainInfo): SeedRef | undefined {
  let best: SeedRef | undefined
  for (const memberId of chain.members) {
    const seed = bestSeedForEntity(seedSet, memberId)
    if (seed === undefined) continue
    best = best === undefined ? seed : betterSeed(best, seed)
  }
  return best
}

function parseGroup(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function chainIdOf(expansion: Expansion): string | undefined {
  return expansion.chainId
}

/**
 * 阶段二：以阶段一种子做 1–2 跳图扩展。
 *
 * - 扩展本身失败不致命：调用方把异常降级成 warning，阶段一结果照常返回。
 * - 思维链成员标题需要「组」属性：Store.expand 只给出 chainId / 成员 id，
 *   所以对发现的每个组读一次 `Store.get(chainId)`，从必填属性 `group` 取全部成员。
 *   读组失败时退化为「扩展结果里出现过的成员」，并留 warning。
 * - `options.includeChains=false`（expand=links）时跳过组解析，不读思维链。
 */
export async function expandSeeds(
  store: Store,
  seedSet: SeedSet,
  hops: 1 | 2,
  config: RetrievalConfig,
  options: { readonly includeChains?: boolean; readonly includeArchived?: boolean } = {},
): Promise<ExpansionOutcome> {
  if (seedSet.entityIds.length === 0) {
    return { expansions: [], chains: new Map(), warnings: [] }
  }
  const warnings: string[] = []
  const expansions = await store.expand(seedSet.entityIds, hops, {
    ...(options.includeArchived !== undefined ? { includeArchived: options.includeArchived } : {}),
  })
  if (options.includeChains === false) {
    return { expansions, chains: new Map(), warnings }
  }

  const chainIds: string[] = []
  const membersByChain = new Map<string, Set<string>>()
  for (const expansion of expansions) {
    const chainId = chainIdOf(expansion)
    if (chainId === undefined) continue
    if (!membersByChain.has(chainId)) {
      chainIds.push(chainId)
      membersByChain.set(chainId, new Set())
    }
    membersByChain.get(chainId)?.add(expansion.entityId)
  }
  chainIds.sort()

  const limitedChainIds = chainIds.slice(0, config.maxChainGroups)
  if (chainIds.length > limitedChainIds.length) {
    warnings.push(`发现 ${chainIds.length} 个思维链组，只解析前 ${limitedChainIds.length} 个（maxChainGroups）`)
  }

  const chainEntities = await Promise.allSettled(limitedChainIds.map(chainId =>
    store.get(chainId, options.includeArchived === true ? { includeArchived: true } : {}),
  ))
  const chains = new Map<string, ChainInfo>()
  chainEntities.forEach((settled, index) => {
    const chainId = limitedChainIds[index]
    if (chainId === undefined) return
    const members = new Set(membersByChain.get(chainId) ?? [])
    let title: string | undefined
    let entity: Entity | undefined
    if (settled.status === 'fulfilled') entity = settled.value
    else warnings.push(`读取思维链组 ${chainId} 失败：${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`)
    if (entity !== undefined) {
      title = titleOf(entity)
      for (const memberId of parseGroup(attributeValue(entity, 'group'))) members.add(memberId)
    }
    chains.set(chainId, { chainId, members, ...(title === undefined ? {} : { title }) })
  })

  return { expansions, chains, warnings }
}

/** 按 T2 的 expand 模式裁剪阶段二结果：none/links/chain/both。 */
export function filterExpansions(expansions: readonly Expansion[], mode: ExpansionMode): Expansion[] {
  if (mode === 'none') return []
  if (mode === 'links') return expansions.filter(expansion => expansion.chainId === undefined)
  if (mode === 'chain') return expansions.filter(expansion => expansion.chainId !== undefined)
  return [...expansions]
}

/** 扩展来源种子：链扩展用组内最好种子，普通链接扩展用 fromId。 */
export function resolveExpansionSeed(
  expansion: Expansion,
  seedSet: SeedSet,
  chains: ReadonlyMap<string, ChainInfo>,
  fallback: SeedRef | undefined,
): SeedRef | undefined {
  if (expansion.chainId !== undefined) {
    const chain = chains.get(expansion.chainId)
    if (chain !== undefined) {
      const seed = bestSeedForChain(seedSet, chain)
      if (seed !== undefined) return seed
    }
  }
  return bestSeedForEntity(seedSet, expansion.fromId) ?? fallback
}
