import type { Category } from '../domain/entity.js'
import { RECALL_SCENARIOS } from './constants.js'
import type { RecallChannel, RecallScenario } from './types.js'

/**
 * 检索配置是唯一可审计的权重/门控/重排先验来源。
 *
 * 不变量：
 * - 场景权重只在这里定义；引擎、通道、融合、重排都从配置读，不写死常量。
 * - 修改权重必须同时升 `version`，方便 recall_event / 基准报告对上版本。
 * - 原始分门控按通道设下限（各通道原始分不在同一量纲：ts_rank_cd ≈0.0x，
 *   vector cosine ≈0.5+，trigger 是权重和，state_board 0.5~1.1）。
 */
export interface ScenarioWeights {
  readonly trigger: number
  readonly fulltext: number
  readonly single_char: number
  readonly vector: number
  readonly time: number
  readonly state_board: number
  readonly links: number
}

export interface RerankPriors {
  /** 分类先验：fact/clue/event 分场景取值。 */
  readonly category: Readonly<Record<Category, number>>
  /** 命中作用域与请求项目一致时的乘数。 */
  readonly projectScope: number
  /** 新近度乘数：按半衰期衰减到 1 与 `recency` 之间。 */
  readonly recency: number
  readonly pinned: number
  /** 属性 标签/tags 含「偏好」时的乘数。 */
  readonly preferenceTag: number
  /** 使用证据（Reference/Utilization/Validation 的平滑置信度）触发的乘数上限。 */
  readonly adopted: number
  /** 被用户否定/证伪的负向乘数（只在实际 refutationRate > 0 时生效）。 */
  readonly refuted: number
  /** 来源为后台自动生成（origin 含 job/auto/...）时的降权乘数。 */
  readonly jobOrigin: number
  /** 链路强度（图扩展分）触发的乘数上限。 */
  readonly linkStrength: number
  /** 状态机有历史版本时的乘数（追踪密度的侧写，不是采用率替代）。 */
  readonly history: number
  /** 实体置信度触发的乘数上限。 */
  readonly confidence: number
}

export interface ScenarioConfig {
  readonly weights: ScenarioWeights
  /** time 通道与重排时间衰减使用的默认回看天数。 */
  readonly timeWindowDays: number
  readonly priors: RerankPriors
}

export interface RetrievalConfig {
  /** 权重/门控版本；每次调整权重升版本。 */
  readonly version: string
  readonly rrfK: number
  /** 每通道进入阶段二图扩展的种子数。 */
  readonly seedLimit: number
  /** 每通道最多取多少条阶段一命中。 */
  readonly channelLimit: number
  /** 图扩展跳数衰减：1 跳 / 2 跳。 */
  readonly hopDecay: Readonly<Record<1 | 2, number>>
  /** 每通道原始分绝对下限。 */
  readonly channelFloors: Readonly<Record<RecallChannel, number>>
  /** 融合分绝对下限；不达标宁可不返回。 */
  readonly fusedFloor: number
  /** 全文零命中时，查询归一化长度 ≤ 该值才跑单字回退。 */
  readonly singleCharMaxQueryLength: number
  readonly defaultLimit: number
  readonly maxLimit: number
  /** 最多解析多少个思维链组的成员（避免一次召回打爆读取）。 */
  readonly maxChainGroups: number
  /** 重排时最多富化多少条候选的实体字段（confidence/adoption/origin 等）。 */
  readonly rerankEnrichLimit: number
  readonly rerankHalfLifeDays: number
  readonly scenarios: Readonly<Record<RecallScenario, ScenarioConfig>>
}

const NEUTRAL_CATEGORY: Readonly<Record<Category, number>> = { fact: 1, clue: 1, event: 1 }

function priors(overrides: Partial<RerankPriors> = {}): RerankPriors {
  return {
    category: NEUTRAL_CATEGORY,
    projectScope: 1,
    recency: 1,
    pinned: 1,
    preferenceTag: 1,
    adopted: 1,
    refuted: 0.8,
    jobOrigin: 1,
    linkStrength: 1,
    history: 1,
    confidence: 1,
    ...overrides,
  }
}

/**
 * 默认配置。场景权重来自 SPEC §7.2：
 * - manual：全文/向量为主；
 * - tool-before：触发匹配加权；
 * - tool-error：错误签名/事件类加权；
 * - session-start：状态机/偏好加权；
 * - last-time：时间窗放宽、时间通道加权。
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = Object.freeze({
  version: 'v7-retrieval-2',
  rrfK: 60,
  seedLimit: 8,
  channelLimit: 50,
  hopDecay: Object.freeze({ 1: 0.5, 2: 0.25 }),
  channelFloors: Object.freeze({
    trigger: 0.5,
    fulltext: 0.02,
    single_char: 0.2,
    vector: 0.35,
    time: 0.2,
    state_board: 0.45,
    links: 0.1,
  }),
  fusedFloor: 0.0015,
  singleCharMaxQueryLength: 2,
  defaultLimit: 10,
  maxLimit: 50,
  maxChainGroups: 8,
  rerankEnrichLimit: 24,
  rerankHalfLifeDays: 30,
  scenarios: Object.freeze({
    manual: {
      weights: { trigger: 0.4, fulltext: 1, single_char: 0.5, vector: 1, time: 0.3, state_board: 0.2, links: 0.5 },
      timeWindowDays: 7,
      priors: priors({
        category: { fact: 1.05, clue: 0.95, event: 0.85 },
        projectScope: 1.05,
        recency: 1.1,
        pinned: 1.1,
        preferenceTag: 1.05,
        adopted: 1.1,
        jobOrigin: 0.9,
        linkStrength: 1.1,
        history: 1.05,
        confidence: 1.05,
      }),
    },
    'tool-before': {
      weights: { trigger: 1.4, fulltext: 0.7, single_char: 0.3, vector: 0.4, time: 0.3, state_board: 0.2, links: 0.4 },
      timeWindowDays: 7,
      priors: priors({
        projectScope: 1.05,
        recency: 1.1,
        pinned: 1.1,
        adopted: 1.1,
        jobOrigin: 0.9,
        linkStrength: 1.1,
        confidence: 1.05,
      }),
    },
    'tool-error': {
      weights: { trigger: 1.6, fulltext: 0.6, single_char: 0.3, vector: 0.4, time: 0.5, state_board: 0.6, links: 0.4 },
      timeWindowDays: 30,
      priors: priors({
        category: { fact: 1, clue: 1.05, event: 1.2 },
        projectScope: 1.05,
        recency: 1.1,
        pinned: 1.1,
        adopted: 1.1,
        jobOrigin: 0.9,
        linkStrength: 1.1,
        confidence: 1.05,
      }),
    },
    'session-start': {
      weights: { trigger: 0.5, fulltext: 0.6, single_char: 0.2, vector: 0.4, time: 0.4, state_board: 1.5, links: 0.6 },
      timeWindowDays: 14,
      priors: priors({
        category: { fact: 1.05, clue: 0.95, event: 0.9 },
        projectScope: 1.1,
        recency: 1.05,
        pinned: 1.15,
        preferenceTag: 1.2,
        adopted: 1.1,
        jobOrigin: 0.9,
        linkStrength: 1.05,
        history: 1.1,
        confidence: 1.05,
      }),
    },
    'last-time': {
      weights: { trigger: 0.4, fulltext: 0.7, single_char: 0.3, vector: 0.4, time: 1.5, state_board: 0.4, links: 0.5 },
      timeWindowDays: 60,
      priors: priors({
        projectScope: 1.05,
        recency: 1.15,
        pinned: 1.1,
        adopted: 1.1,
        jobOrigin: 0.9,
        linkStrength: 1.05,
        confidence: 1.05,
      }),
    },
  }),
})

export interface RerankPriorOverrides {
  readonly category?: Partial<Record<Category, number>>
  readonly projectScope?: number
  readonly recency?: number
  readonly pinned?: number
  readonly preferenceTag?: number
  readonly adopted?: number
  readonly jobOrigin?: number
  readonly linkStrength?: number
  readonly history?: number
  readonly confidence?: number
}

export interface ScenarioConfigOverrides {
  readonly weights?: Partial<ScenarioWeights>
  readonly timeWindowDays?: number
  readonly priors?: RerankPriorOverrides
}

export interface RetrievalConfigOverrides {
  readonly version?: string
  readonly rrfK?: number
  readonly seedLimit?: number
  readonly channelLimit?: number
  readonly hopDecay?: Partial<Record<1 | 2, number>>
  readonly channelFloors?: Partial<Record<RecallChannel, number>>
  readonly fusedFloor?: number
  readonly singleCharMaxQueryLength?: number
  readonly defaultLimit?: number
  readonly maxLimit?: number
  readonly maxChainGroups?: number
  readonly rerankEnrichLimit?: number
  readonly rerankHalfLifeDays?: number
  readonly scenarios?: Partial<Record<RecallScenario, ScenarioConfigOverrides>>
}

function mergePriors(base: RerankPriors, override?: RerankPriorOverrides): RerankPriors {
  if (override === undefined) return base
  const category = { ...base.category, ...(override.category ?? {}) }
  return {
    ...base,
    ...(override.category === undefined ? {} : { category }),
    ...(override.projectScope === undefined ? {} : { projectScope: override.projectScope }),
    ...(override.recency === undefined ? {} : { recency: override.recency }),
    ...(override.pinned === undefined ? {} : { pinned: override.pinned }),
    ...(override.preferenceTag === undefined ? {} : { preferenceTag: override.preferenceTag }),
    ...(override.adopted === undefined ? {} : { adopted: override.adopted }),
    ...(override.jobOrigin === undefined ? {} : { jobOrigin: override.jobOrigin }),
    ...(override.linkStrength === undefined ? {} : { linkStrength: override.linkStrength }),
    ...(override.history === undefined ? {} : { history: override.history }),
    ...(override.confidence === undefined ? {} : { confidence: override.confidence }),
  }
}

function mergeScenarios(base: RetrievalConfig, override: RetrievalConfigOverrides['scenarios'] = {}): Record<RecallScenario, ScenarioConfig> {
  const scenarios = {} as Record<RecallScenario, ScenarioConfig>
  for (const name of RECALL_SCENARIOS) {
    const baseScenario = base.scenarios[name]
    const scenarioOverride = override[name]
    if (scenarioOverride === undefined) {
      scenarios[name] = baseScenario
      continue
    }
    scenarios[name] = {
      weights: { ...baseScenario.weights, ...(scenarioOverride.weights ?? {}) },
      timeWindowDays: scenarioOverride.timeWindowDays ?? baseScenario.timeWindowDays,
      priors: mergePriors(baseScenario.priors, scenarioOverride.priors),
    }
  }
  return scenarios
}

/** 生成一份可审计的检索配置；只替换显式给出的字段，其余沿用默认值。 */
export function createRetrievalConfig(overrides: RetrievalConfigOverrides = {}): RetrievalConfig {
  const scenarios = mergeScenarios(DEFAULT_RETRIEVAL_CONFIG, overrides.scenarios)
  return {
    version: overrides.version ?? DEFAULT_RETRIEVAL_CONFIG.version,
    rrfK: overrides.rrfK ?? DEFAULT_RETRIEVAL_CONFIG.rrfK,
    seedLimit: overrides.seedLimit ?? DEFAULT_RETRIEVAL_CONFIG.seedLimit,
    channelLimit: overrides.channelLimit ?? DEFAULT_RETRIEVAL_CONFIG.channelLimit,
    hopDecay: {
      ...DEFAULT_RETRIEVAL_CONFIG.hopDecay,
      ...(overrides.hopDecay ?? {}),
    },
    channelFloors: {
      ...DEFAULT_RETRIEVAL_CONFIG.channelFloors,
      ...(overrides.channelFloors ?? {}),
    },
    fusedFloor: overrides.fusedFloor ?? DEFAULT_RETRIEVAL_CONFIG.fusedFloor,
    singleCharMaxQueryLength: overrides.singleCharMaxQueryLength ?? DEFAULT_RETRIEVAL_CONFIG.singleCharMaxQueryLength,
    defaultLimit: overrides.defaultLimit ?? DEFAULT_RETRIEVAL_CONFIG.defaultLimit,
    maxLimit: overrides.maxLimit ?? DEFAULT_RETRIEVAL_CONFIG.maxLimit,
    maxChainGroups: overrides.maxChainGroups ?? DEFAULT_RETRIEVAL_CONFIG.maxChainGroups,
    rerankEnrichLimit: overrides.rerankEnrichLimit ?? DEFAULT_RETRIEVAL_CONFIG.rerankEnrichLimit,
    rerankHalfLifeDays: overrides.rerankHalfLifeDays ?? DEFAULT_RETRIEVAL_CONFIG.rerankHalfLifeDays,
    scenarios,
  }
}
