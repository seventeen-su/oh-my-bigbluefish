/**
 * 效用与阈值：**纯函数 + 可测状态机**（3.7 Wave 2 / R9 C1+C3）。
 *
 * ## 为什么单独一个文件
 *
 * - `store.ts` 需要"把 counters 折算成 utility"（放在读取路径上，零额外查询）；
 * - `retrieve.ts` 需要"用 utility 替换 usage 先验"；
 * - `feedback.ts` 需要"按动作更新 counters"与"自适应下限的 q 校准"；
 * - `index.ts` 需要把读数暴露到健康面。
 *
 * 四处共享同一套公式。放在一个**不 import 任何 storage/host** 的纯模块里，
 * 才不会出现"公式抄两遍、一边改了另一边没改"（本项目已付过代价）。
 *
 * ## 核心公式（R9 §3 C1）
 *
 * `utility = λ · BetaPosterior + (1−λ) · baseRate`
 * - `α = 1 + used + 2·useful`；`β = 4 + max(0, exposed − used) + 1.5·stale + 1·noise`
 * - `BetaPosterior = α/(α+β)`（先验均值 0.2 ≈ 本地实测 34 使用/156 暴露）
 * - `λ = min(exposed,20)/(min(exposed,20)+10)`（经验贝叶斯收缩：曝光 0 完全用基率）
 *
 * 关键性质（有测试钉住）：**exposed 增加但 used 不增加 → utility 下降**，
 * 从而打断 `useCount/(1+useCount)` 的"曝光越多越提权"反馈环。
 */

/** 后验先验参数（R9 设计值）。 */
export const UTILITY_ALPHA_PRIOR = 1
export const UTILITY_BETA_PRIOR = 4
/** 先验均值（≈ 本地 34/156 基率）。 */
export const UTILITY_BASE_RATE = UTILITY_ALPHA_PRIOR / (UTILITY_ALPHA_PRIOR + UTILITY_BETA_PRIOR)
/** 经验贝叶斯收缩强度：曝光 = 10 时 λ=0.5。 */
export const UTILITY_SHRINK_K = 10
/** 单条曝光上限：防"被注入 100 次"把 λ 拉满（R9 §3 C1 第 4 条）。 */
export const UTILITY_EXPOSURE_CAP = 20
/** 显式正反馈权重（R9：useful → α += 2）。 */
export const USEFUL_ALPHA_WEIGHT = 2
/** 显式 stale / noise / wrong 的负权重（R9：stale → β += 1.5；noise → β += 1；wrong 更强 → 2）。 */
export const STALE_BETA_WEIGHT = 1.5
export const NOISE_BETA_WEIGHT = 1
export const WRONG_BETA_WEIGHT = 2

/** 一条记忆的效用原始计数（来自 `memory_utility` 表）。 */
export interface UtilityCounters {
  readonly exposed: number
  readonly used: number
  readonly useful: number
  readonly wrong: number
  readonly stale: number
  readonly noise: number
}

/** 空计数（没有账本行 = 从未曝光：utility 应等于基率，不是 0）。 */
export const EMPTY_UTILITY_COUNTERS: UtilityCounters = {
  exposed: 0,
  used: 0,
  useful: 0,
  wrong: 0,
  stale: 0,
  noise: 0,
}

/** 后验均值（不含收缩）。 */
export function betaPosterior(counters: UtilityCounters): number {
  const exposed = nonNegative(counters.exposed)
  const used = Math.min(nonNegative(counters.used), exposed)
  const alpha = UTILITY_ALPHA_PRIOR + used + USEFUL_ALPHA_WEIGHT * nonNegative(counters.useful)
  const beta =
    UTILITY_BETA_PRIOR +
    Math.max(0, exposed - used) +
    STALE_BETA_WEIGHT * nonNegative(counters.stale) +
    NOISE_BETA_WEIGHT * nonNegative(counters.noise) +
    WRONG_BETA_WEIGHT * nonNegative(counters.wrong)
  const total = alpha + beta
  return total > 0 ? alpha / total : UTILITY_BASE_RATE
}

/** 收缩系数 λ（0 曝光 → 0；曝光 ≥20 → 0.667）。 */
export function shrinkageLambda(exposed: number): number {
  const effective = Math.min(nonNegative(exposed), UTILITY_EXPOSURE_CAP)
  return effective / (effective + UTILITY_SHRINK_K)
}

/**
 * 效用估计：**曝光归一 + 经验贝叶斯收缩**。
 *
 * 输入全是计数、无 I/O、无模型；同输入同输出。
 */
export function estimateUtility(counters: UtilityCounters): number {
  const posterior = betaPosterior(counters)
  const lambda = shrinkageLambda(counters.exposed)
  return clamp01(lambda * posterior + (1 - lambda) * UTILITY_BASE_RATE)
}

// ────────────────────────────────────────────────────────────────────────────
// 自适应相对下限（R9 C3）
// ────────────────────────────────────────────────────────────────────────────

/** 相对下限系数：`score ≥ top × ρ`（比旧 0.5 松，让分位数主导）。 */
export const LEXICAL_RELATIVE_RHO = 0.35
/** 分位数初值（只被在线校准改动；夹在 [0.3, 0.8]）。 */
export const LEXICAL_QUANTILE_INITIAL = 0.5
export const LEXICAL_QUANTILE_MIN = 0.3
export const LEXICAL_QUANTILE_MAX = 0.8
/** 目标精度：注入后"被使用/未被纠正"的目标比例（R9 C3 设计值 0.6）。 */
export const LEXICAL_TARGET_PRECISION = 0.6
/** 校准步长上限（R9：步长 ≤0.05）。 */
export const LEXICAL_CALIBRATION_STEP = 0.05
/** 每多少次召回更新一次（R9：每 20 次）。 */
export const LEXICAL_CALIBRATION_WINDOW = 20
/** 小库夹紧：top 低于该值时不启用绝对下限（bm25≈1e-6 的库必须保住唯一命中）。 */
export const SMALL_LIBRARY_TOP = 0.2
/** 绝对夹紧区间（只用于"相对分位算出的值"上，小库走 fallback）。 */
export const LEXICAL_ABS_MIN = 0.2
export const LEXICAL_ABS_MAX = 1.5

/** 词法下限模式：`relative`（C3，默认）/ `fixed`（旧 0.5，回滚）。 */
export type LexicalFloorMode = 'relative' | 'fixed'

/** 一次下限计算的输入。 */
export interface FloorInput {
  /** 候选分（本库本通道，任意顺序）。 */
  readonly scores: readonly number[]
  readonly mode: LexicalFloorMode
  /** `fixed` 模式的绝对下限（旧行为 0.5）。 */
  readonly fixedFloor: number
  /** 当前分位（来自校准器；`fixed` 模式忽略）。 */
  readonly quantile: number
}

/**

 * 计算本次词法下限。**纯函数**——分位数、相对系数、夹紧与小库保护都在这里，
 * 调用方（`retrieve.ts`）只负责取候选分与过滤。
 *
 * 规则（R9 C3，形态与旧 `min(top×0.5, 0.5)` 兼容）：
 * 1. `top < SMALL_LIBRARY_TOP`（小库/单位分）→ **退回旧规则** `min(top×0.5, fixedFloor)`；
 * 2. 否则 `threshold = clamp(max(top×ρ, Q_q(scores)), ABS_MIN, ABS_MAX)`；
 * 3. `fixed` 模式直接返回 `fixedFloor`（回滚开关）。
 */
export function lexicalFloorFor(input: FloorInput): { readonly threshold: number; readonly mode: LexicalFloorMode } {
  const scores = input.scores.filter(score => Number.isFinite(score)).map(score => Math.max(0, score))
  const top = scores.reduce((max, score) => (score > max ? score : max), 0)
  if (input.mode === 'fixed') return { threshold: Math.max(0, input.fixedFloor), mode: 'fixed' }
  if (top < SMALL_LIBRARY_TOP) {
    // 小库/低分库：绝对下限会误杀唯一命中；退回旧"相对 top"规则
    return { threshold: Math.min(top * 0.5, Math.max(0, input.fixedFloor)), mode: 'fixed' }
  }
  const quantile = quantileOf(scores, clamp(input.quantile, LEXICAL_QUANTILE_MIN, LEXICAL_QUANTILE_MAX))
  const threshold = clamp(Math.max(top * LEXICAL_RELATIVE_RHO, quantile), LEXICAL_ABS_MIN, LEXICAL_ABS_MAX)
  return { threshold, mode: 'relative' }
}

/** 线性插值分位（升序）。空数组 → 0。 */
export function quantileOf(scores: readonly number[], q: number): number {
  if (scores.length === 0) return 0
  const sorted = [...scores].sort((a, b) => a - b)
  const position = clamp(q, 0, 1) * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const lowValue = sorted[lower] ?? 0
  const highValue = sorted[upper] ?? lowValue
  return lowValue + (highValue - lowValue) * (position - lower)
}

/**
 * 在线校准器：按"目标精度"调整分位数 q。
 *
 * 只在 `observe` 收到**标签窗口**（窗口内 exposure 与 used）时更新；
 * 没有隐式使用信号（used=0 且窗口内 exposure 很多也算信息）→ 会下调 q。
 * 每 `LEXICAL_CALIBRATION_WINDOW` 次召回评估一次，步长上限 0.05，q ∈ [0.3,0.8]。
 *
 * **确定性**：状态可由 `serialize/restore` 持久化到 `memory_meta`（跨重启不漂移）。
 */
export interface AdaptiveFloorState {
  readonly q: number
  readonly recalls: number
  readonly exposures: number
  readonly used: number
  readonly precision: number | null
}

export class AdaptiveFloorCalibrator {
  #q: number
  #recalls = 0
  #exposures = 0
  #used = 0
  #precision: number | null = null
  readonly #target: number

  constructor(state: Partial<AdaptiveFloorState> = {}, targetPrecision: number = LEXICAL_TARGET_PRECISION) {
    this.#q = clamp(state.q ?? LEXICAL_QUANTILE_INITIAL, LEXICAL_QUANTILE_MIN, LEXICAL_QUANTILE_MAX)
    this.#recalls = Math.max(0, Math.floor(state.recalls ?? 0))
    this.#exposures = Math.max(0, Math.floor(state.exposures ?? 0))
    this.#used = Math.max(0, Math.floor(state.used ?? 0))
    this.#precision = typeof state.precision === 'number' && Number.isFinite(state.precision) ? state.precision : null
    this.#target = Number.isFinite(targetPrecision) ? targetPrecision : LEXICAL_TARGET_PRECISION
  }

  get q(): number {
    return this.#q
  }

  state(): AdaptiveFloorState {
    return { q: this.#q, recalls: this.#recalls, exposures: this.#exposures, used: this.#used, precision: this.#precision }
  }

  /**
   * 记录一次召回（无论是否命中）。
   *
   * @param observed 本窗口新增的 exposure 与 used 计数（来自 utility 账本的增量）
   * @returns 是否发生了 q 更新（供状态面/测试观察）
   */
  observe(observed: { readonly exposures: number; readonly used: number }): boolean {
    this.#recalls += 1
    this.#exposures += Math.max(0, Math.floor(observed.exposures))
    this.#used += Math.max(0, Math.floor(observed.used))
    if (this.#recalls % LEXICAL_CALIBRATION_WINDOW !== 0) return false
    // 窗口内没有任何曝光 → 没有可用的精度标签，不动 q（避免"没数据改成乱猜"）
    if (this.#exposures <= 0) return false
    const precision = clamp01(this.#used / this.#exposures)
    this.#precision = precision
    const direction = precision >= this.#target ? 1 : -1
    this.#q = clamp(this.#q + LEXICAL_CALIBRATION_STEP * direction, LEXICAL_QUANTILE_MIN, LEXICAL_QUANTILE_MAX)
    this.#exposures = 0
    this.#used = 0
    return true
  }
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}
