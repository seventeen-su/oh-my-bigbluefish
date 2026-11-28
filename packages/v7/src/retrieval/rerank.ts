import type { EntityPriorFeatures, EntitySummary } from '../ports/search.js'
import type { RetrievalConfig, ScenarioConfig } from './config.js'
import type { RecallRequest } from './types.js'

export interface PriorContext {
  readonly summary: EntitySummary
  /**
   * 实体级富化特征（confidence/pinned/tags/采用率/origin）。
   * 缺省 = 没有富化数据：对应乘数全部按中性 1 处理，不因“没轮到富化”而惩罚或奖励。
   */
  readonly features?: EntityPriorFeatures
  /** 图扩展证据强度（0–1）；没有 links 通道时为 0。 */
  readonly linkStrength: number
  readonly scenario: ScenarioConfig
  readonly config: RetrievalConfig
  readonly request: RecallRequest
  readonly now: string
}

export interface PriorResult {
  readonly factor: number
  readonly reasons: readonly string[]
}

const MIN_PRIOR = 0.5
const MAX_PRIOR = 1.5

function format(value: number): string {
  return value.toFixed(4)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function ageInDays(isoTime: string, now: string): number | undefined {
  const then = Date.parse(isoTime)
  const at = Date.parse(now)
  if (!Number.isFinite(then) || !Number.isFinite(at)) return undefined
  return Math.max(0, (at - then) / 86_400_000)
}

function hasPreferenceTag(features: EntityPriorFeatures): boolean {
  return (features.tags ?? []).some(tag => tag.includes('偏好') || /^preference/i.test(tag.trim()))
}

/**
 * 重排先验（SPEC §7.2）：分类、置信度、时间衰减、作用域匹配、历史采用率、
 * 链接强度、来源。每个先验只在有证据时乘上去，最后整体夹到 [0.5, 1.5]。
 *
 * 所有乘数都来自 `config.scenarios[scenario].priors`，不写死在代码里。
 * 分两级使用同一函数：
 * - 初排（全部候选）只给 `summary`：分类/新近度/作用域/历史/链路，全部廉价可得；
 * - 精排（富化窗口）再加 `features`：置信度/置顶/偏好标签/采用率/来源。
 * 没有 `features` 时这些实体级乘数不参与，等价于中性的 1，所以两级排序可比。
 */
export function rerankPrior(context: PriorContext): PriorResult {
  const { summary, features, scenario, config, request, now } = context
  const reasons: string[] = []
  let factor = 1
  const apply = (label: string, multiplier: number): void => {
    if (!Number.isFinite(multiplier) || multiplier === 1) return
    factor *= multiplier
    reasons.push(`prior:${label}=×${format(multiplier)}`)
  }

  if (summary.category !== undefined) {
    apply(`category:${summary.category}`, scenario.priors.category[summary.category])
  }

  if (features?.confidence !== undefined) {
    const confidence = clamp01(features.confidence)
    apply(`confidence:${format(confidence)}`, 1 + (scenario.priors.confidence - 1) * confidence)
  }

  const ageDays = ageInDays(summary.updatedAt, now)
  if (ageDays !== undefined) {
    const recency = Math.pow(0.5, ageDays / Math.max(1, config.rerankHalfLifeDays))
    apply(`recency:${ageDays.toFixed(0)}d`, 1 + (scenario.priors.recency - 1) * recency)
  }

  if (request.projectKey !== undefined && summary.scope.kind === 'project' && summary.scope.projectKey === request.projectKey) {
    apply('scope:project', scenario.priors.projectScope)
  }

  if (summary.historyCount > 0) {
    apply(`history:${summary.historyCount}`, scenario.priors.history)
  }

  if (features?.pinned === true) {
    apply('pinned', scenario.priors.pinned)
  }

  if (features !== undefined && hasPreferenceTag(features)) {
    apply('tag:偏好', scenario.priors.preferenceTag)
  }

  // 使用证据只认机会级、平滑后的 utilityConfidence：
  // - Reference/Utilization/Validation 按受控权重进入，Validation 最强；
  // - 单纯 Exposure/accessCount 不在这里加分，避免“检索自己→更容易被检索”的正反馈；
  // - 旧的 adoptionCount/accessCount 字符串命中口径已从重排移除；
  // - 无有效证据时保持中性（不乘任何因子）。
  const utility = features?.utilityConfidence ?? 0
  if (features !== undefined && utility > 0) {
    apply(`utility:${format(utility)}`, 1 + (scenario.priors.adopted - 1) * utility)
  }
  // 负向证据：只在实际存在 refutation 时降权，且乘数下限仍由全局 clamp 保护。
  const refutation = features?.refutationRate ?? 0
  if (features !== undefined && refutation > 0) {
    apply(`refuted:${format(refutation)}`, 1 - (1 - scenario.priors.refuted) * refutation)
  }

  if (features?.origin !== undefined && /(^|[-_:])(job|auto|consolidat|background)/i.test(features.origin)) {
    apply(`origin:${features.origin}`, scenario.priors.jobOrigin)
  }

  if (context.linkStrength > 0) {
    const strength = clamp01(context.linkStrength)
    apply(`link:${format(strength)}`, 1 + (scenario.priors.linkStrength - 1) * strength)
  }

  const clamped = Math.min(MAX_PRIOR, Math.max(MIN_PRIOR, factor))
  if (clamped !== factor) {
    reasons.push(`prior:clamp[${MIN_PRIOR},${MAX_PRIOR}]=×${format(clamped)}`)
  }
  return { factor: clamped, reasons }
}
