/**
 * 注入裁决（规划 §6.7）。**纯函数**：零 I/O、零 mock 可测。
 *
 * `(relevance * novelty) / max(cost, 1)` —— 单位 token 的边际价值。
 *
 * `novelty = 1 - maxSimilarity(candidate, alreadyPresent)` 是**关键项**：
 * 旧设计只看单条相关性，于是会一次注入 5 条说同一件事的记忆，
 * 那是浪费的主要来源。`cost` 也**必须来自真实测量**（`ContextNodeCost.tokens`），
 * 不是估算。
 */
import type { ContextNodeCost, FocusDepth, FocusState } from '../../kernel/abi/index.js'

/** 一个候选注入物。 */
export interface Candidate {
  readonly id: string
  /** 逐字内容（相似度比较用；不做抽取式改写）。 */
  readonly text: string
  /** 内容模块给出的相关性 0…1。越界会被收敛，NaN 视为 0。 */
  readonly relevance: number
  /** **真实测量**出的 token 成本（`ContextNodeCost.tokens`），不是估算。 */
  readonly tokens: number
  /**
   * 仅在这些深度档位下有意义（§4.6 的反向接口：
   * 思维链层声明"deep 档需要 R3/R4/R5"，上下文层据此裁决）。
   * 缺省 = 所有档位都适用。
   */
  readonly depths?: readonly FocusDepth[]
}

/** 一次最多考虑几个候选（**不是**每回合 token 上限）。 */
export const DEFAULT_CANDIDATE_CONSIDER_LIMIT = 12

/**
 * 相关性：候选自带的相关性 × 深度适配。
 *
 * 深度不适配 → 0（例如"deep 档才需要的规则卡"在 quick 档没有价值）。
 * `focus` 缺失时保守取 0：无法确认需求就不注入。
 */
export function relevanceTo(candidate: Candidate, focus: FocusState | undefined): number {
  const base = clamp01(candidate?.relevance)
  const depths = candidate?.depths
  if (depths !== undefined && depths.length > 0) {
    const depth = focus?.depth
    if (depth === undefined || !depths.includes(depth)) return 0
  }
  return base
}

/**
 * 两条内容的相似度（0…1）。领域中立：中文按**字符二元组**、西文按词，
 * 取 Jaccard。相同文本恒为 1；两条都空也视为同一件事（1）。
 */
export function similarity(a: string, b: string): number {
  const left = tokenize(a)
  const right = tokenize(b)
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** 与"已在场内容"的最大相似度。同 id 直接判 1。 */
export function maxSimilarity(candidate: Candidate, alreadyPresent: readonly Candidate[]): number {
  if (!Array.isArray(alreadyPresent)) return 0
  let max = 0
  for (const present of alreadyPresent) {
    if (present === null || present === undefined) continue
    if (present.id !== '' && present.id === candidate?.id) return 1
    const score = similarity(String(candidate?.text ?? ''), String(present.text ?? ''))
    if (score > max) max = score
  }
  return max
}

/**
 * 单位 token 的边际价值。`novelty` 为 0 时整项为 0——
 * **第二条说同一件事的候选价值必然低于第一条**（这是反例测试的核心）。
 */
export function marginalValue(
  candidate: Candidate,
  alreadyPresent: readonly Candidate[],
  focus: FocusState,
): number {
  const relevance = relevanceTo(candidate, focus)
  if (relevance <= 0) return 0
  const novelty = 1 - maxSimilarity(candidate, alreadyPresent)
  if (novelty <= 0) return 0
  const cost = Math.max(tokenCost(candidate), 1)
  const value = (relevance * novelty) / cost
  return Number.isFinite(value) ? value : 0
}

export interface AdmissionOptions {
  /** 一次最多考虑几个候选（安全阀；缺省 `DEFAULT_CANDIDATE_CONSIDER_LIMIT`）。 */
  readonly considerLimit?: number
  /** 最多推几条（由压力档位给出：宽松/紧张 = 0，适中 = 1）。 */
  readonly pushLimit?: number
}

/**
 * 选出要注入的候选（贪心）。
 *
 * 贪心的意义：每选一条就把它加入"已在场"，下一条的 `novelty` 因此下降——
 * 五条重复记忆只会进第一条。`considerLimit` 只是**一次考虑几个**的廉价安全阀，
 * 与"每回合 token 上限"无关。
 */
export function selectForInjection(
  candidates: readonly Candidate[],
  alreadyPresent: readonly Candidate[],
  focus: FocusState,
  options: AdmissionOptions = {},
): readonly Candidate[] {
  const pushLimit = Math.max(0, integerOr(options.pushLimit, 0))
  if (pushLimit === 0) return []
  const considerLimit = Math.max(1, integerOr(options.considerLimit, DEFAULT_CANDIDATE_CONSIDER_LIMIT))
  const pool = (Array.isArray(candidates) ? candidates : [])
    .filter(item => item !== null && item !== undefined)
    .slice()
    .sort((a, b) => relevanceTo(b, focus) - relevanceTo(a, focus))
    .slice(0, considerLimit)

  const chosen: Candidate[] = []
  const present: Candidate[] = Array.isArray(alreadyPresent) ? [...alreadyPresent] : []
  while (chosen.length < pushLimit && pool.length > 0) {
    let bestIndex = -1
    let bestValue = 0
    for (let index = 0; index < pool.length; index += 1) {
      const value = marginalValue(pool[index] as Candidate, present, focus)
      if (value > bestValue) {
        bestValue = value
        bestIndex = index
      }
    }
    if (bestIndex < 0) break
    const picked = pool.splice(bestIndex, 1)[0]
    if (picked === undefined) break
    chosen.push(picked)
    present.push(picked)
  }
  return chosen
}

/** 从逐节点价格里取真实成本；没有该节点时返回 null（**不估算**）。 */
export function measuredCost(
  nodes: readonly ContextNodeCost[] | undefined,
  name: string,
): number | null {
  if (!Array.isArray(nodes)) return null
  for (const node of nodes) {
    if (node === null || node === undefined) continue
    if (node.name === name && Number.isFinite(node.tokens)) return node.tokens
  }
  return null
}

/**
 * 用**真实测量**覆盖候选自带的成本；测量缺失时返回 null。
 *
 * 返回 null 而不是回落估算：估算出来的 cost 会让"值不值"这个判断失去意义
 * （量纲不可比的成本 = 与决策相关的谎言）。
 */
export function withMeasuredCost(
  candidate: Candidate,
  nodes: readonly ContextNodeCost[] | undefined,
): Candidate | null {
  const measured = measuredCost(nodes, candidate?.id)
  if (measured === null) return null
  return { ...candidate, tokens: measured }
}

/** 中文按字符二元组、西文按词——领域中立，不需要分词器依赖。 */
function tokenize(text: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  const normalized = String(text ?? '').toLowerCase()
  for (const run of normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run)
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  for (const word of normalized.match(/[a-z0-9_]+/g) ?? []) tokens.add(word)
  return tokens
}

function tokenCost(candidate: Candidate): number {
  const tokens = candidate?.tokens
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return 0
  return tokens
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}
