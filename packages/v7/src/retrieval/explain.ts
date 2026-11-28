import { normalizeText } from '../domain/text.js'
import type { FusionCandidate } from './fuse.js'
import { sortChannels } from './fuse.js'
import type { GateOutcome, GateRejection } from './gate.js'
import type { PriorResult } from './rerank.js'
import type { ChannelReport, EmptyReason, EmptyReasonCode } from './types.js'

/**
 * 解释层：结果为什么在（why）、空结果为什么空（whyNot）。
 *
 * 只做“把已有证据翻译成可审计文本”，不重新打分、不改变门控结果；
 * 所有分数都来自 fuse/gate/rerank 的输出，避免解释与实现各算一遍。
 */

/** 过滤类淘汰原因；与引擎的过滤顺序一一对应。 */
export type FilterCode =
  | 'archived'
  | 'history'
  | 'superseded'
  | 'retracted'
  | 'kind'
  | 'category'
  | 'status'
  | 'time-window'
  | 'missing-summary'

export type WhyNotCode =
  | 'empty-query'
  | 'no-stage-one-hits'
  | 'all-channels-failed'
  | 'below-raw'
  | 'below-fused'
  | 'below-relative'
  | 'no-consensus'
  | `filtered-${FilterCode}`
  | 'summaries-failed'

export interface WhyNot {
  readonly code: WhyNotCode
  /** 单条可读行，形如 `below-raw entity=mem_a channel=fulltext raw=0.1000 floor=0.2000`。 */
  readonly message: string
}

/** 空结果 whyNot 最多在 message 里展开几条；其余只报总数，避免空结果变成长报告。 */
const MAX_WHY_NOT_IN_MESSAGE = 5

function formatScore(value: number): string {
  return value.toFixed(4)
}

export interface HitEvidence {
  readonly candidate: FusionCandidate
  /** 重排先验结果（乘数与原因）。 */
  readonly prior: PriorResult
  /** 最终分 = fused × prior.factor。 */
  readonly score: number
}

/**
 * 结果解释：通道（provider）/名次/原始分/该通道对 RRF 的贡献、
 * 图扩展路径（种子、跳数、衰减、链路）、重排先验、融合分与最终分。
 */
export function explainHit(evidence: HitEvidence): string[] {
  const { candidate, prior, score } = evidence
  const why: string[] = []
  for (const channel of sortChannels(candidate.rawByChannel.keys())) {
    const raw = candidate.rawByChannel.get(channel)
    if (raw === undefined) continue
    const rank = candidate.rankByChannel.get(channel)
    const contribution = candidate.contributionByChannel.get(channel)
    const parts: string[] = [
      rank === undefined ? `channel:${channel}` : `channel:${channel}#${rank}`,
      `raw=${formatScore(raw)}`,
    ]
    if (contribution !== undefined) parts.push(`contribution=${formatScore(contribution)}`)
    why.push(parts.join(' '))
  }
  if (candidate.link !== undefined) {
    const link = candidate.link
    const chain = link.chainId === undefined ? '' : ` chain=${link.chainId}`
    why.push(
      `link:hop${link.hop} seed=${link.seedId} decay=${formatScore(link.decay)} via=${link.viaLinkId}${chain}`,
    )
  }
  why.push(`rrf=${formatScore(candidate.fused)}`)
  why.push(...prior.reasons)
  why.push(`score=${formatScore(score)}`)
  return why
}

/** 把一条被过滤的候选翻译成 whyNot；detail 由引擎给事实（kind/status/时间窗等）。 */
export function explainFiltered(code: FilterCode, entityId: string, detail?: string): WhyNot {
  const suffix = detail === undefined || detail.length === 0 ? '' : ` ${detail}`
  return {
    code: `filtered-${code}`,
    message: `filtered-${code} entity=${entityId}${suffix}`,
  }
}

function rejectionWhyNot(rejection: GateRejection): WhyNot {
  if (rejection.code === 'below-raw') {
    const channel = rejection.channel === undefined ? '' : ` channel=${rejection.channel}`
    const raw = rejection.rawScore === undefined ? '' : ` raw=${formatScore(rejection.rawScore)}`
    return {
      code: 'below-raw',
      message: `below-raw entity=${rejection.entityId}${channel}${raw} floor=${formatScore(rejection.floor)}`,
    }
  }
  if (rejection.code === 'no-consensus') {
    const channels = rejection.channels === undefined ? '' : ` channels=${rejection.channels}`
    const rank = rejection.rank === undefined ? '' : ` rank=${rejection.rank}`
    return {
      code: 'no-consensus',
      message: `no-consensus entity=${rejection.entityId}${channels}${rank} minChannels=${rejection.floor}`,
    }
  }
  if (rejection.code === 'below-relative') {
    const ratio = rejection.ratio === undefined ? '' : ` ratio=${formatScore(rejection.ratio)}`
    const reference = rejection.reference === undefined ? '' : ` reference=${formatScore(rejection.reference)}`
    return {
      code: 'below-relative',
      message: `below-relative entity=${rejection.entityId} fused=${formatScore(rejection.fused)} floor=${formatScore(rejection.floor)}${ratio}${reference}`,
    }
  }
  return {
    code: 'below-fused',
    message: `below-fused entity=${rejection.entityId} fused=${formatScore(rejection.fused)} floor=${formatScore(rejection.floor)}`,
  }
}

export interface EmptyExplanationInput {
  readonly query: string
  readonly stageOneHitCount: number
  readonly reports: readonly ChannelReport[]
  readonly gate: GateOutcome
  /** 通过门控但被归档/历史/类型/状态/时间窗过滤掉的候选数。 */
  readonly filteredOut: number
  readonly timeFiltered?: number
  readonly summariesFailed: boolean
  /** 被过滤候选的逐条原因，由引擎用 explainFiltered 生成；空结果时并入 whyNot。 */
  readonly filteredReasons: readonly WhyNot[]
}

/**
 * 空结果 whyNot：按引擎的真实分支给出**类别化**的原因明细。
 * 这里只描述当前引擎可观测的状态；deadline 截断依赖 provider 级超时（RET-10 / Task 11），
 * 当前引擎没有 deadline/AbortSignal，不在此伪造该类原因。
 */
export function explainWhyNot(input: EmptyExplanationInput): readonly WhyNot[] {
  if (input.stageOneHitCount === 0) {
    if (normalizeText(input.query).length === 0) {
      return [{ code: 'empty-query', message: 'empty-query 归一化后查询为空' }]
    }
    const attempted = input.reports.filter(report => report.status !== 'skipped')
    if (attempted.length > 0 && attempted.every(report => report.status === 'failed')) {
      return [
        {
          code: 'all-channels-failed',
          message: `all-channels-failed channels=${attempted.map(report => report.channel).join(',')}`,
        },
      ]
    }
    return [
      {
        code: 'no-stage-one-hits',
        message: `no-stage-one-hits channels=${input.reports
          .map(report => `${report.channel}:${report.status}`)
          .join(',')}`,
      },
    ]
  }
  if (input.gate.passed.length === 0) {
    return input.gate.rejected.map(rejectionWhyNot)
  }
  if (input.summariesFailed) {
    return [{ code: 'summaries-failed', message: 'summaries-failed 实体摘要读取失败，候选无法解释' }]
  }
  return input.filteredReasons
}

interface EmptyReasonBase {
  readonly code: EmptyReasonCode
  readonly message: string
  readonly details?: EmptyReason['details']
}

/** 原有空结果文案与 details 形状保持不变；whyNot 只追加到 message 末尾。 */
function baseEmptyReason(input: EmptyExplanationInput): EmptyReasonBase {
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
      message: '六个通道均无命中：检查查询词、作用域、归档/历史/取代开关是否把目标排除在外。',
      details: { channels: input.reports.map(report => `${report.channel}:${report.status}`) },
    }
  }
  if (input.gate.passed.length === 0) {
    const gate = input.gate
    return {
      code: 'below-threshold',
      message: `有 ${gate.belowRaw + gate.belowFused + gate.belowRelative + gate.belowConsensus} 条候选进入融合，但没有一条同时满足原始分下限、融合层相对门控与通道一致性；为避免噪声不返回。`,
      details: {
        belowRaw: gate.belowRaw,
        belowFused: gate.belowFused,
        // 新增的两类门控只在真的发生时出现，旧 logs 的 details 形状保持可读。
        ...(gate.belowRelative === 0 ? {} : { belowRelative: gate.belowRelative }),
        ...(gate.belowConsensus === 0 ? {} : { belowConsensus: gate.belowConsensus }),
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
    message: `有 ${input.gate.passed.length} 条候选通过门控，但都被归档/历史/取代/证伪/类型/状态/时间窗过滤排除。`,
    details: {
      filteredOut: input.filteredOut,
      ...(input.timeFiltered === undefined || input.timeFiltered === 0 ? {} : { timeFiltered: input.timeFiltered }),
    },
  }
}

function renderWhyNot(entries: readonly WhyNot[]): string {
  if (entries.length === 0) return ''
  const shown = entries.slice(0, MAX_WHY_NOT_IN_MESSAGE).map(entry => entry.message)
  const omitted = entries.length > shown.length ? `；…共 ${entries.length} 条` : ''
  return `；whyNot：${shown.join('；')}${omitted}`
}

/** 空结果统一出口：原有 code/message/details 不变，message 末尾附上可审计的 whyNot。 */
export function explainEmpty(input: EmptyExplanationInput): EmptyReason {
  const reason = baseEmptyReason(input)
  const suffix = renderWhyNot(explainWhyNot(input))
  if (suffix.length === 0) return reason
  // 原 message 以句号结尾，直接用分号接 whyNot 会拼出「。；」，这里去掉句号再拼接。
  const head = reason.message.endsWith('。') ? reason.message.slice(0, -1) : reason.message
  return { ...reason, message: `${head}${suffix}` }
}
