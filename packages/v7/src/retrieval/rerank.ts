import { attributeValue } from '../domain/entity.js'
import type { Entity } from '../domain/entity.js'
import type { EntitySummary } from '../ports/store.js'
import type { RetrievalConfig, ScenarioConfig } from './config.js'
import type { RecallRequest } from './types.js'

export interface PriorContext {
  readonly summary: EntitySummary
  readonly entity?: Entity
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

const TAG_ATTRIBUTES = ['标签', 'tags', 'tag'] as const

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

function tagsOf(entity: Entity): string[] {
  for (const name of TAG_ATTRIBUTES) {
    const value = attributeValue(entity, name)
    if (typeof value === 'string' && value.trim().length > 0) return [value]
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
  }
  return []
}

function hasPreferenceTag(entity: Entity): boolean {
  return tagsOf(entity).some(tag => tag.includes('偏好') || /^preference/i.test(tag.trim()))
}

/**
 * 重排先验（SPEC §7.2）：分类、置信度、时间衰减、作用域匹配、历史采用率、
 * 链接强度、来源。每个先验只在有证据时乘上去，最后整体夹到 [0.5, 1.5]。
 *
 * 所有乘数都来自 `config.scenarios[scenario].priors`，不写死在代码里；
 * 没有实体富化数据（Entity 缺失）时，只有可用字段参与计算。
 */
export function rerankPrior(context: PriorContext): PriorResult {
  const { summary, entity, scenario, config, request, now } = context
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

  if (entity?.confidence !== undefined) {
    const confidence = clamp01(entity.confidence)
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

  if (entity?.pinned === true) {
    apply('pinned', scenario.priors.pinned)
  }

  if (entity !== undefined && hasPreferenceTag(entity)) {
    apply('tag:偏好', scenario.priors.preferenceTag)
  }

  if (entity !== undefined && entity.accessCount > 0 && entity.adoptionCount > 0) {
    const rate = Math.min(1, entity.adoptionCount / entity.accessCount)
    apply(`adoption:${format(rate)}`, 1 + (scenario.priors.adopted - 1) * rate)
  }

  if (entity !== undefined && /(^|[-_:])(job|auto|consolidat|background)/i.test(entity.origin)) {
    apply(`origin:${entity.origin}`, scenario.priors.jobOrigin)
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
