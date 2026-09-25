/**
 * 软压力塑形（规划 §6.3）——**取代硬上限**。
 *
 * 没有每回合硬性 token 上限：档位是**行为切换**，不是丢弃。
 * 任何被推迟的内容仍可通过工具取回（`recoverable` 在任何档位都为 true），
 * 因此不存在静默信息丢失——这正是硬上限做不到的事。
 *
 * 全部纯函数：零 I/O、零 mock 可测。
 */
import type { ContextPressure, PressureBand } from '../../kernel/abi/index.js'

/** 软档位阈值。**从测量标定**，不手写当真值；这里只给缺省。 */
export interface PressureBands {
  readonly moderate: number
  readonly tight: number
}

export const DEFAULT_PRESSURE_BANDS: PressureBands = { moderate: 0.3, tight: 0.6 }

/** 推入行为：不推 / 只推最有价值的一条 / 只留索引。 */
export type PushMode = 'none' | 'single-best' | 'index-only'

/** 一个压力档位的**行为**（不是"丢什么"，而是"怎么给"）。 */
export interface BandBehavior {
  readonly band: PressureBand
  readonly mode: PushMode
  /** 是否允许主动推内容。宽松档**不做任何注入裁决**，因此是 false。 */
  readonly pushAllowed: boolean
  /** 一次最多推几条（适中档 = 1；宽松/紧张 = 0）。 */
  readonly pushLimit: number
  /** 只保留索引视图（"有什么可用"），内容全部转工具拉取。 */
  readonly indexOnly: boolean
  /** 是否主动提示模型当前上下文紧张。提示是**信号**，不是内容，故不受 `pushAllowed` 约束。 */
  readonly announcePressure: boolean
  /**
   * 被推迟的内容仍可通过工具取回。**任何档位都是 true**——
   * 这是"档位是行为切换而不是丢弃"在类型上的表达。
   */
  readonly recoverable: true
  /** 一句话行为说明，进状态面与日志。 */
  readonly detail: string
}

const BEHAVIORS: Readonly<Record<PressureBand, BandBehavior>> = {
  relaxed: {
    band: 'relaxed',
    mode: 'none',
    pushAllowed: false,
    pushLimit: 0,
    indexOnly: false,
    announcePressure: false,
    recoverable: true,
    detail: '宽松：不做任何注入裁决，不主动推；规则卡与记忆全部按需拉取。',
  },
  moderate: {
    band: 'moderate',
    mode: 'single-best',
    pushAllowed: true,
    pushLimit: 1,
    indexOnly: false,
    announcePressure: false,
    recoverable: true,
    detail: '适中：按边际价值只推最有价值的一条，其余留给模型自己拉。',
  },
  tight: {
    band: 'tight',
    mode: 'index-only',
    pushAllowed: false,
    pushLimit: 0,
    indexOnly: true,
    announcePressure: true,
    recoverable: true,
    detail: '紧张：只留索引视图，内容全部转为工具拉取，并主动提示模型上下文紧张。',
  },
}

/** 档位行为表（只读）。测试与状态面可直接比对。 */
export function behaviorFor(band: PressureBand): BandBehavior {
  return BEHAVIORS[band] ?? BEHAVIORS.relaxed
}

/**
 * 由 `fillRatio` 判档。
 *
 * - `fillRatio === null` → `relaxed`：**宿主未声明窗口就不施压，不臆断**
 * - `NaN`/`Infinity` 同样按"未声明"处理（非法输入不产生紧张档）
 * - 阈值非法时回落缺省，阈值反序时交换（纯函数不抛）
 */
export function bandOf(fillRatio: number | null, bands: PressureBands = DEFAULT_PRESSURE_BANDS): PressureBand {
  if (fillRatio === null || !Number.isFinite(fillRatio)) return 'relaxed'
  const normalized = normalizeBands(bands)
  if (fillRatio >= normalized.tight) return 'tight'
  if (fillRatio >= normalized.moderate) return 'moderate'
  return 'relaxed'
}

/** 档位 + 行为，一次拿全（供 `context:pressure` 服务与状态面）。 */
export interface PressureReading {
  readonly band: PressureBand
  readonly behavior: BandBehavior
  readonly fillRatio: number | null
}

/** 由压力读数直接得到档位与行为。压力缺失/畸形时按 relaxed 处理。 */
export function readingOf(
  pressure: ContextPressure | null | undefined,
  bands: PressureBands = DEFAULT_PRESSURE_BANDS,
): PressureReading {
  const fillRatio = typeof pressure?.fillRatio === 'number' && Number.isFinite(pressure.fillRatio)
    ? pressure.fillRatio
    : null
  const band = bandOf(fillRatio, bands)
  return { band, behavior: behaviorFor(band), fillRatio }
}

/** 规范化阈值：非有限数→缺省，越界→收敛到 [0,1]，反序→交换。 */
export function normalizeBands(bands: PressureBands | undefined): PressureBands {
  const moderateRaw = bands?.moderate
  const tightRaw = bands?.tight
  const moderate = Number.isFinite(moderateRaw) ? clamp01(moderateRaw as number) : DEFAULT_PRESSURE_BANDS.moderate
  const tight = Number.isFinite(tightRaw) ? clamp01(tightRaw as number) : DEFAULT_PRESSURE_BANDS.tight
  return moderate <= tight ? { moderate, tight } : { moderate: tight, tight: moderate }
}

/**
 * 从 `cordis.patch.yml` 的 `pressureBands: [0.3, 0.6]` 解析阈值。
 *
 * 永不抛：缺项/畸形各自回落缺省。**配置只有两个数**，
 * 因此这里不做"每回合 token 上限"这类第九个旋钮（§6.8）。
 */
export function bandsFromPair(pair: unknown): PressureBands {
  if (!Array.isArray(pair)) return DEFAULT_PRESSURE_BANDS
  const [moderate, tight] = pair as readonly unknown[]
  return normalizeBands({
    moderate: typeof moderate === 'number' ? moderate : DEFAULT_PRESSURE_BANDS.moderate,
    tight: typeof tight === 'number' ? tight : DEFAULT_PRESSURE_BANDS.tight,
  })
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
