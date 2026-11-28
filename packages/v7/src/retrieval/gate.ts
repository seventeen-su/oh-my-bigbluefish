import type { FusionGate, RetrievalConfig } from './config.js'
import type { FusionCandidate } from './fuse.js'
import { sortChannels } from './fuse.js'
import type { RecallChannel } from './types.js'

/**
 * 门控（SPEC §7.2 / 不变量 5）：原始分下限按通道分别设；融合层用**相对/一致性**规则。
 *
 * 为什么不再用融合分绝对下限做相关性判断：RRF 是 `sum(weight/(rrfK+rank))`，是排名融合分，
 * 不是概率、也没有跨查询可比的量纲。旧规则 `fused >= 0.0015` 几乎什么都能过：
 * 单通道末位 `state_board` 第 50 名在 manual 场景是 `0.2/(60+50)=0.001818`，已经高于下限，
 * 于是「单通道末位弱候选」被默认放行。现在的三道规则：
 *
 * 1. 原始分门控（不变）：至少一个通道的 `rawScore >= channelFloor`，否则 below-raw；
 * 2. 绝对健全性：`fused >= fusedFloor`，只挡 0/负分与明显无效的融合结果，否则 below-fused；
 * 3. 一致性（共识）：有 ≥ `minChannels` 个通道的原始分达标，**或**候选自身通道名次
 *    ≤ `singleChannelRank`（精确单通道强命中），**或**它是来自精确种子的图扩展；
 *    否则 no-consensus；
 * 4. 相对：`fused >= 本轮最高融合分 × relativeFloor`，同样的排名共识/图扩展豁免，
 *    否则 below-relative。
 *
 * 单通道末位（rank 50，ratio 0.11）在第 3 步被拒；单通道第 1–5 名的精确命中即使
 * 融合分只有最高分的一小部分也保留，不会误杀。不达标的候选宁可不返回，
 * 并且**保留每一条被淘汰的原因与证据**，供 explain 组装 whyNot。
 */

export type GateRejectionCode = 'below-raw' | 'below-fused' | 'below-relative' | 'no-consensus'

export interface GateRejection {
  readonly entityId: string
  readonly code: GateRejectionCode
  /** 淘汰时的融合分（审计用；below-raw 时它不一定低于 fusedFloor）。 */
  readonly fused: number
  /** 这一条对照的下限：below-raw 用通道原始分下限，below-fused 用绝对下限，below-relative 用比例。 */
  readonly floor: number
  /** below-raw 时原始分最接近下限的通道；没有通道证据的候选没有这个字段。 */
  readonly channel?: RecallChannel
  readonly rawScore?: number
  /** 达到通道下限的通道数（一致性门控证据）。 */
  readonly channels?: number
  /** 候选最好的通道名次；图扩展候选给来源种子的名次（排名共识证据）。 */
  readonly rank?: number
  /** below-relative：本轮参照融合分与候选/参照比例。 */
  readonly reference?: number
  readonly ratio?: number
}

/** 本次门控实际生效的下限快照，来源只有 RetrievalConfig + 计划，便于审计“用哪套阈值算的”。 */
export interface GateFloors {
  readonly channel: Readonly<Record<RecallChannel, number>>
  readonly fused: number
  readonly fusion: FusionGate
  /** 相对门控的参照分（本轮通过原始分门控的最高融合分）；没有候选时缺省。 */
  readonly reference?: number
}

export interface GateOutcome {
  readonly passed: readonly FusionCandidate[]
  readonly belowRaw: number
  readonly belowFused: number
  readonly belowRelative: number
  readonly belowConsensus: number
  /** 每条被淘汰候选的原因；长度恒等于四个 below 计数之和。 */
  readonly rejected: readonly GateRejection[]
  readonly floors: GateFloors
}

interface RawMiss {
  readonly channel: RecallChannel
  readonly rawScore: number
  readonly floor: number
}

/** 候选的证据视图：哪些通道达标、排名共识来自哪里。 */
interface Evidence {
  readonly candidate: FusionCandidate
  /** 原始分达到该通道下限的通道（按 RECALL_CHANNELS 顺序）。 */
  readonly channels: readonly RecallChannel[]
  /** 其中阶段一通道的最好名次（links 是派生通道，没有名次）。 */
  readonly bestRank: number | undefined
  /** 图扩展候选：来源种子的名次与通道。 */
  readonly seedRank: number | undefined
  /** 只有 links 通道的候选（阶段一没有直接命中，完全靠图扩展带来）。 */
  readonly expansionOnly: boolean
}

/**
 * 淘汰理由要说“差多少”，所以挑原始分**最接近**该通道下限的一条通道证据：
 * 差距 = raw - floor，取最大者（仍为负值），而不是简单取原始分最高的通道。
 */
function closestRawMiss(
  candidate: FusionCandidate,
  floors: Readonly<Record<RecallChannel, number>>,
): RawMiss | undefined {
  let best: RawMiss | undefined
  let bestGap = Number.NEGATIVE_INFINITY
  for (const channel of sortChannels(candidate.rawByChannel.keys())) {
    const rawScore = candidate.rawByChannel.get(channel)
    if (rawScore === undefined) continue
    const floor = floors[channel]
    const gap = rawScore - floor
    if (gap > bestGap) {
      bestGap = gap
      best = { channel, rawScore, floor }
    }
  }
  return best
}

function evidenceOf(candidate: FusionCandidate, config: RetrievalConfig): Evidence {
  const channels: RecallChannel[] = []
  let bestRank: number | undefined
  for (const channel of sortChannels(candidate.rawByChannel.keys())) {
    const rawScore = candidate.rawByChannel.get(channel)
    if (rawScore === undefined || rawScore < config.channelFloors[channel]) continue
    channels.push(channel)
    if (channel === 'links') continue
    const rank = candidate.rankByChannel.get(channel)
    if (rank !== undefined && (bestRank === undefined || rank < bestRank)) bestRank = rank
  }
  return {
    candidate,
    channels,
    bestRank,
    seedRank: candidate.link?.seedRank,
    expansionOnly: channels.length > 0 && channels.every(channel => channel === 'links'),
  }
}

/**
 * 排名共识：单通道候选的通道名次足够靠前 = 精确命中；图扩展候选看来源种子。
 * 这是「一致性/排名共识」里不受融合分标度影响的那一半。
 */
function preciseEnough(evidence: Evidence, gate: FusionGate): boolean {
  if (evidence.bestRank !== undefined && evidence.bestRank <= gate.singleChannelRank) return true
  return evidence.expansionOnly
    && evidence.seedRank !== undefined
    && evidence.seedRank <= gate.singleChannelRank
}

/**
 * 原始分门控 + 融合层相对/一致性门控。
 * 阈值全部来自配置（`channelFloors` / `fusedFloor` / `fusionGate`），函数里没有魔法数。
 */
export function gateCandidates(
  candidates: readonly FusionCandidate[],
  config: RetrievalConfig,
): GateOutcome {
  const gate = config.fusionGate
  const evidence: Evidence[] = []
  const rejected: GateRejection[] = []
  let belowRaw = 0

  for (const candidate of candidates) {
    const item = evidenceOf(candidate, config)
    if (item.channels.length === 0) {
      belowRaw += 1
      const miss = closestRawMiss(candidate, config.channelFloors)
      rejected.push({
        entityId: candidate.entityId,
        code: 'below-raw',
        fused: candidate.fused,
        floor: miss?.floor ?? 0,
        ...(miss === undefined ? {} : { channel: miss.channel, rawScore: miss.rawScore }),
      })
      continue
    }
    evidence.push(item)
  }

  // 相对门控的参照分：本轮通过原始分门控的最高融合分。查询级相对比较才不受标度影响。
  const reference = evidence.reduce((best, item) => Math.max(best, item.candidate.fused), 0)
  const passed: FusionCandidate[] = []
  let belowFused = 0
  let belowRelative = 0
  let belowConsensus = 0

  for (const item of evidence) {
    const candidate = item.candidate
    if (candidate.fused < config.fusedFloor) {
      belowFused += 1
      rejected.push({
        entityId: candidate.entityId,
        code: 'below-fused',
        fused: candidate.fused,
        floor: config.fusedFloor,
      })
      continue
    }
    const precise = preciseEnough(item, gate)
    const consensus = item.channels.length >= gate.minChannels || precise
    if (!consensus) {
      belowConsensus += 1
      const rankEvidence = item.bestRank ?? item.seedRank
      rejected.push({
        entityId: candidate.entityId,
        code: 'no-consensus',
        fused: candidate.fused,
        floor: gate.minChannels,
        channels: item.channels.length,
        ...(rankEvidence === undefined ? {} : { rank: rankEvidence }),
      })
      continue
    }
    const ratio = reference > 0 ? candidate.fused / reference : 1
    if (gate.relativeFloor > 0 && !precise && ratio < gate.relativeFloor) {
      belowRelative += 1
      rejected.push({
        entityId: candidate.entityId,
        code: 'below-relative',
        fused: candidate.fused,
        floor: gate.relativeFloor,
        channels: item.channels.length,
        reference,
        ratio,
        ...(item.bestRank === undefined ? {} : { rank: item.bestRank }),
      })
      continue
    }
    passed.push(candidate)
  }

  return {
    passed,
    belowRaw,
    belowFused,
    belowRelative,
    belowConsensus,
    rejected,
    floors: {
      channel: config.channelFloors,
      fused: config.fusedFloor,
      fusion: gate,
      ...(evidence.length === 0 ? {} : { reference }),
    },
  }
}
