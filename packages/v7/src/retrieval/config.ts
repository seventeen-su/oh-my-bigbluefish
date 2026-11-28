import type { Category } from '../domain/entity.js'
import { RECALL_SCENARIOS } from './constants.js'
import { DEFAULT_TIME_ZONE } from './timezone.js'
import type { RecallChannel, RecallScenario } from './types.js'

/**
 * 检索配置是唯一可审计的权重/门控/重排先验来源。
 *
 * 不变量：
 * - 场景权重只在这里定义；引擎、通道、融合、重排都从配置读，不写死常量。
 * - 修改权重必须同时升 `version`，方便 recall_event / 基准报告对上版本。
 * - 原始分门控按通道设下限（各通道原始分不在同一量纲：ts_rank_cd ≈0.0x，
 *   vector cosine ≈0.5+，trigger 是权重和，state_board 0.5~1.1）。
 * - 融合层门控是**相对/一致性**规则（见 `FusionGate`）：RRF 分是排名融合分不是概率，
 *   不能当绝对相关性保证；`fusedFloor` 只留作 0/负分的健全性下限。
 * - 日历日语义（今天/昨天/前天）按 `timezone`（IANA）算，见 retrieval/timezone.ts。
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

/**
 * 融合层门控：把「未校准的 RRF 分」换成两种可解释的相对证据。
 *
 * - `relativeFloor`：候选融合分 / 本轮最高融合分 ≥ 该比例。RRF 分只保证「同一次查询内
 *   谁比谁强」，所以只能做相对比较；绝对分在不同查询、不同通道权重下没有可比性。
 * - `minChannels`：至少有几个通道的原始分达到各自下限（多通道共识）。
 * - `singleChannelRank`：单通道候选的通道名次 ≤ 该值即视为精确命中（排名共识），
 *   可以单独通过一致性与相对门控；图扩展候选看它来源种子的名次。
 *
 * `relativeFloor=0.35 / minChannels=2 / singleChannelRank=5` 的含义：单通道排名第 6 名
 * 以后必须有第二个通道佐证；单通道末位（例如 rank 50 的 state_board，融合分
 * 0.2/(60+50)=0.001818，高于旧的绝对下限 0.0015）不再默认通过。
 */
export interface FusionGate {
  readonly relativeFloor: number
  readonly minChannels: number
  readonly singleChannelRank: number
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
  /** 场景级融合门控校准：按场景放宽/收紧单通道排名共识；缺省用全局 `fusionGate`。 */
  readonly gate?: FusionGate
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
  /**
   * 融合分**绝对**下限。RRF 分未校准，这个值只挡 0/负分与明显无效的融合结果，
   * 不承担相关性过滤职责；相关性由 `fusionGate` 的相对/一致性规则判断。
   */
  readonly fusedFloor: number
  /** 融合层相对/一致性门控（全局缺省；场景可覆盖）。 */
  readonly fusionGate: FusionGate
  /** 查询日历日（今天/昨天/前天）使用的 IANA 时区；显式配置，不读宿主本地时区。 */
  readonly timezone: string
  /** 全文零命中时，查询归一化长度 ≤ 该值才跑单字回退。 */
  readonly singleCharMaxQueryLength: number
  readonly defaultLimit: number
  readonly maxLimit: number
  /** 最多解析多少个思维链组的成员（避免一次召回打爆读取）。 */
  readonly maxChainGroups: number
  /**
   * 精排富化窗口的**下限**：初排（全部候选，只用摘要级特征）之后，对前
   * `max(rerankEnrichTopK, limit)` 名做一次批量富化再精排。窗口取 max 保证
   * 所有返回结果都拿到富化证据，截断位置本身不会造成隐性惩罚/奖励。
   */
  readonly rerankEnrichTopK: number
  readonly rerankHalfLifeDays: number
  readonly scenarios: Readonly<Record<RecallScenario, ScenarioConfig>>
}

const NEUTRAL_CATEGORY: Readonly<Record<Category, number>> = { fact: 1, clue: 1, event: 1 }

/** 融合层门控缺省：单通道只保留前 5 名，更深的单通道命中必须有第二个通道佐证。 */
const DEFAULT_FUSION_GATE: FusionGate = Object.freeze({
  relativeFloor: 0.35,
  minChannels: 2,
  singleChannelRank: 5,
})

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
 *
 * `session-start` 的门控放宽到单通道前 10 名：看板/偏好本身就是单通道信号，
 * 当前项目在做什么不该因为「只出现在 state_board 的第 7 条」被丢掉。
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
  fusionGate: DEFAULT_FUSION_GATE,
  timezone: DEFAULT_TIME_ZONE,
  singleCharMaxQueryLength: 2,
  defaultLimit: 10,
  maxLimit: 50,
  maxChainGroups: 8,
  rerankEnrichTopK: 24,
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
      gate: Object.freeze({ ...DEFAULT_FUSION_GATE, singleChannelRank: 10 }),
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
  /** 场景级融合门控校准；只覆盖显式给出的字段，其余沿用全局 `fusionGate`。 */
  readonly gate?: Partial<FusionGate>
}

export interface RetrievalConfigOverrides {
  readonly version?: string
  readonly rrfK?: number
  readonly seedLimit?: number
  readonly channelLimit?: number
  readonly hopDecay?: Partial<Record<1 | 2, number>>
  readonly channelFloors?: Partial<Record<RecallChannel, number>>
  readonly fusedFloor?: number
  readonly fusionGate?: Partial<FusionGate>
  /** IANA 时区；插件组合根会按配置/宿主显式传入。 */
  readonly timezone?: string
  readonly singleCharMaxQueryLength?: number
  readonly defaultLimit?: number
  readonly maxLimit?: number
  readonly maxChainGroups?: number
  readonly rerankEnrichTopK?: number
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

function mergeGate(base: FusionGate, override?: Partial<FusionGate>): FusionGate {
  if (override === undefined) return base
  return {
    relativeFloor: override.relativeFloor ?? base.relativeFloor,
    minChannels: override.minChannels ?? base.minChannels,
    singleChannelRank: override.singleChannelRank ?? base.singleChannelRank,
  }
}

function mergeScenarios(
  base: RetrievalConfig,
  globalGate: FusionGate,
  override: RetrievalConfigOverrides['scenarios'] = {},
): Record<RecallScenario, ScenarioConfig> {
  const scenarios = {} as Record<RecallScenario, ScenarioConfig>
  for (const name of RECALL_SCENARIOS) {
    const baseScenario = base.scenarios[name]
    // 场景门控 = 全局门控 + 该场景相对默认全局的校准差 + 调用方显式覆盖。
    // 这样全局改 relativeFloor 时，只校准了 singleChannelRank 的场景也会跟着走。
    const delta = baseScenario.gate === undefined ? {} : diffGate(baseScenario.gate, base.fusionGate)
    const gate = mergeGate(mergeGate(globalGate, delta), override[name]?.gate)
    const scenarioOverride = override[name]
    const baseWithGate: ScenarioConfig = { ...baseScenario, gate }
    if (scenarioOverride === undefined) {
      scenarios[name] = baseWithGate
      continue
    }
    scenarios[name] = {
      ...baseWithGate,
      weights: { ...baseWithGate.weights, ...(scenarioOverride.weights ?? {}) },
      timeWindowDays: scenarioOverride.timeWindowDays ?? baseWithGate.timeWindowDays,
      priors: mergePriors(baseWithGate.priors, scenarioOverride.priors),
    }
  }
  return scenarios
}

/** 场景门控相对全局门控的差分（只保留真正不同的字段）。 */
function diffGate(gate: FusionGate, globalGate: FusionGate): Partial<FusionGate> {
  return {
    ...(gate.relativeFloor === globalGate.relativeFloor ? {} : { relativeFloor: gate.relativeFloor }),
    ...(gate.minChannels === globalGate.minChannels ? {} : { minChannels: gate.minChannels }),
    ...(gate.singleChannelRank === globalGate.singleChannelRank ? {} : { singleChannelRank: gate.singleChannelRank }),
  }
}

/** 生成一份可审计的检索配置；只替换显式给出的字段，其余沿用默认值。 */
export function createRetrievalConfig(overrides: RetrievalConfigOverrides = {}): RetrievalConfig {
  const fusionGate = mergeGate(DEFAULT_RETRIEVAL_CONFIG.fusionGate, overrides.fusionGate)
  const scenarios = mergeScenarios(DEFAULT_RETRIEVAL_CONFIG, fusionGate, overrides.scenarios)
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
    fusionGate,
    timezone: overrides.timezone ?? DEFAULT_RETRIEVAL_CONFIG.timezone,
    singleCharMaxQueryLength: overrides.singleCharMaxQueryLength ?? DEFAULT_RETRIEVAL_CONFIG.singleCharMaxQueryLength,
    defaultLimit: overrides.defaultLimit ?? DEFAULT_RETRIEVAL_CONFIG.defaultLimit,
    maxLimit: overrides.maxLimit ?? DEFAULT_RETRIEVAL_CONFIG.maxLimit,
    maxChainGroups: overrides.maxChainGroups ?? DEFAULT_RETRIEVAL_CONFIG.maxChainGroups,
    rerankEnrichTopK: overrides.rerankEnrichTopK ?? DEFAULT_RETRIEVAL_CONFIG.rerankEnrichTopK,
    rerankHalfLifeDays: overrides.rerankHalfLifeDays ?? DEFAULT_RETRIEVAL_CONFIG.rerankHalfLifeDays,
    scenarios,
  }
}
