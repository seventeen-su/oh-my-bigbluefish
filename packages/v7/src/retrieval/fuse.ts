import type { Expansion } from '../domain/link.js'
import type { ChannelHit } from '../ports/store.js'
import type { RetrievalConfig, ScenarioWeights } from './config.js'
import type { ChainInfo, SeedSet } from './expand.js'
import { bestSeedOverall, resolveExpansionSeed } from './expand.js'
import type { RecallChannel, StageOneChannel } from './types.js'
import { RECALL_CHANNELS, STAGE_ONE_CHANNELS } from './constants.js'

export interface LinkEvidence {
  readonly seedId: string
  readonly hop: number
  readonly decay: number
  /** 由种子原始分 × 跳数衰减得到，用于 links 通道的原始分门控。 */
  readonly rawScore: number
  readonly contribution: number
  readonly viaLinkId: string
  readonly relation: string
  readonly chainId?: string
  /** 存储层给的链路分（含其自身衰减），只作为「链路强度」先验证据。 */
  readonly linkScore: number
}

export interface FusionCandidate {
  readonly entityId: string
  fused: number
  readonly rawByChannel: Map<RecallChannel, number>
  readonly rankByChannel: Map<RecallChannel, number>
  /** 每通道对 RRF 融合分的贡献（weight / (rrfK + rank)），求和恒等于 fused。 */
  readonly contributionByChannel: Map<RecallChannel, number>
  link?: LinkEvidence
}

export function createCandidate(entityId: string): FusionCandidate {
  return {
    entityId,
    fused: 0,
    rawByChannel: new Map(),
    rankByChannel: new Map(),
    contributionByChannel: new Map(),
  }
}

function ensureCandidate(candidates: Map<string, FusionCandidate>, entityId: string): FusionCandidate {
  const existing = candidates.get(entityId)
  if (existing !== undefined) return existing
  const created = createCandidate(entityId)
  candidates.set(entityId, created)
  return created
}

function addChannelContribution(
  candidate: FusionCandidate,
  channel: RecallChannel,
  rank: number,
  rawScore: number,
  weight: number,
  rrfK: number,
): void {
  const contribution = weight / (rrfK + rank)
  candidate.fused += contribution
  const previousContribution = candidate.contributionByChannel.get(channel) ?? 0
  candidate.contributionByChannel.set(channel, previousContribution + contribution)
  const previousRaw = candidate.rawByChannel.get(channel)
  candidate.rawByChannel.set(channel, previousRaw === undefined ? rawScore : Math.max(previousRaw, rawScore))
  if (channel !== 'links') {
    const previousRank = candidate.rankByChannel.get(channel)
    if (previousRank === undefined || rank < previousRank) candidate.rankByChannel.set(channel, rank)
  }
}

/**
 * 加权 RRF：sum(weight[channel] / (rrfK + rank))；只看名次，不看原始分。
 * `rrfK` 与 `weight` 都由调用方从 RetrievalConfig / 场景配置传入，不在这里写死；
 * 每通道贡献单独记录，供 explain 输出「这条分数由谁贡献」。
 */
export function fuseStageOne(
  hitsByChannel: ReadonlyMap<StageOneChannel, readonly ChannelHit[]>,
  weights: ScenarioWeights,
  rrfK: number,
): Map<string, FusionCandidate> {
  const candidates = new Map<string, FusionCandidate>()
  for (const channel of STAGE_ONE_CHANNELS) {
    const weight = weights[channel]
    for (const hit of hitsByChannel.get(channel) ?? []) {
      const candidate = ensureCandidate(candidates, hit.entityId)
      addChannelContribution(candidate, channel, hit.rank, hit.rawScore, weight, rrfK)
    }
  }
  return candidates
}

export function decayForHop(hop: number, config: RetrievalConfig): number | undefined {
  if (hop === 1) return config.hopDecay[1]
  if (hop === 2) return config.hopDecay[2]
  return undefined
}

function betterEvidence(left: LinkEvidence, right: LinkEvidence): LinkEvidence {
  if (left.contribution !== right.contribution) return left.contribution > right.contribution ? left : right
  if (left.hop !== right.hop) return left.hop < right.hop ? left : right
  return left.viaLinkId <= right.viaLinkId ? left : right
}

/** 种子的原始分取它各通道里最高的一个：links 通道的原始分是派生值，用最强证据推导。 */
function seedRawScore(seedSet: SeedSet, seedId: string, fallback: number): number {
  const refs = seedSet.byEntity.get(seedId)
  if (refs === undefined || refs.length === 0) return fallback
  return refs.reduce((best, ref) => Math.max(best, ref.rawScore), Number.NEGATIVE_INFINITY)
}

/**
 * 把阶段二扩展并入候选：
 * - 1/2 跳衰减来自配置（0.5 / 0.25），融合贡献 = links 权重 × 衰减 / (rrfK + 种子名次)；
 * - 同一实体被多条路径扩展时只保留贡献最高的一条（去重，不重复累加）；
 * - 已在阶段一出现的实体只追加 links 通道，不新增重复结果。
 */
export function applyExpansions(
  candidates: Map<string, FusionCandidate>,
  expansions: readonly Expansion[],
  seedSet: SeedSet,
  chains: ReadonlyMap<string, ChainInfo>,
  weights: ScenarioWeights,
  config: RetrievalConfig,
): void {
  const fallbackSeed = bestSeedOverall(seedSet)

  const bestByEntity = new Map<string, LinkEvidence>()
  for (const expansion of expansions) {
    const decay = decayForHop(expansion.hop, config)
    if (decay === undefined) continue
    const seed = resolveExpansionSeed(expansion, seedSet, chains, fallbackSeed)
    if (seed === undefined) continue
    const evidence: LinkEvidence = {
      seedId: seed.entityId,
      hop: expansion.hop,
      decay,
      rawScore: seedRawScore(seedSet, seed.entityId, seed.rawScore) * decay,
      contribution: (weights.links * decay) / (config.rrfK + seed.rank),
      viaLinkId: expansion.viaLinkId,
      relation: expansion.relation,
      ...(expansion.chainId === undefined ? {} : { chainId: expansion.chainId }),
      linkScore: Number.isFinite(expansion.score) ? Math.max(0, Math.min(1, expansion.score)) : 0,
    }
    const previous = bestByEntity.get(expansion.entityId)
    bestByEntity.set(expansion.entityId, previous === undefined ? evidence : betterEvidence(previous, evidence))
  }

  for (const [entityId, evidence] of bestByEntity) {
    const candidate = ensureCandidate(candidates, entityId)
    candidate.fused += evidence.contribution
    const previousContribution = candidate.contributionByChannel.get('links') ?? 0
    candidate.contributionByChannel.set('links', previousContribution + evidence.contribution)
    const previousRaw = candidate.rawByChannel.get('links')
    candidate.rawByChannel.set('links', previousRaw === undefined ? evidence.rawScore : Math.max(previousRaw, evidence.rawScore))
    candidate.link = evidence
  }
}

export function sortChannels(channels: Iterable<RecallChannel>): RecallChannel[] {
  const present = new Set(channels)
  return RECALL_CHANNELS.filter(channel => present.has(channel))
}
