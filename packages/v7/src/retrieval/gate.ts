import type { RetrievalConfig } from './config.js'
import type { FusionCandidate } from './fuse.js'
import { sortChannels } from './fuse.js'
import type { RecallChannel } from './types.js'

/**
 * 门控（SPEC §7.2 / 不变量 5）：原始分下限按通道分别设，融合分再有一道绝对下限。
 * 不达标的候选宁可不返回，并且**保留每一条被淘汰的原因**，供 explain 组装 whyNot；
 * 静默丢弃会让“为什么没有结果”无法审计。
 */

export type GateRejectionCode = 'below-raw' | 'below-fused'

export interface GateRejection {
  readonly entityId: string
  readonly code: GateRejectionCode
  /** 淘汰时的融合分（审计用；below-raw 时它不一定低于 fusedFloor）。 */
  readonly fused: number
  /** 这一条对照的下限：below-raw 用通道原始分下限，below-fused 用融合分下限。 */
  readonly floor: number
  /** below-raw 时原始分最接近下限的通道；没有通道证据的候选没有这个字段。 */
  readonly channel?: RecallChannel
  readonly rawScore?: number
}

/** 本次门控实际生效的下限快照，来源只有 RetrievalConfig，便于审计“用哪套阈值算的”。 */
export interface GateFloors {
  readonly channel: Readonly<Record<RecallChannel, number>>
  readonly fused: number
}

export interface GateOutcome {
  readonly passed: readonly FusionCandidate[]
  readonly belowRaw: number
  readonly belowFused: number
  /** 每条被淘汰候选的原因；长度恒等于 belowRaw + belowFused。 */
  readonly rejected: readonly GateRejection[]
  readonly floors: GateFloors
}

interface RawMiss {
  readonly channel: RecallChannel
  readonly rawScore: number
  readonly floor: number
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

/**
 * 原始分门控：每个命中至少一个通道的原始分 ≥ 该通道下限；
 * 通过后再看 RRF 融合分 ≥ fusedFloor。阈值全部来自配置，函数里没有魔法数。
 */
export function gateCandidates(
  candidates: readonly FusionCandidate[],
  config: RetrievalConfig,
): GateOutcome {
  const passed: FusionCandidate[] = []
  const rejected: GateRejection[] = []
  let belowRaw = 0
  let belowFused = 0
  for (const candidate of candidates) {
    let rawPass = false
    for (const channel of sortChannels(candidate.rawByChannel.keys())) {
      const rawScore = candidate.rawByChannel.get(channel)
      if (rawScore === undefined) continue
      if (rawScore >= config.channelFloors[channel]) {
        rawPass = true
        break
      }
    }
    if (!rawPass) {
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
    passed.push(candidate)
  }
  return {
    passed,
    belowRaw,
    belowFused,
    rejected,
    floors: { channel: config.channelFloors, fused: config.fusedFloor },
  }
}
