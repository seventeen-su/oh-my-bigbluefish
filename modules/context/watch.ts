/**
 * 拉取计数台账（规划 §6.4 / §6.6）。
 *
 * 拉取式设计把"注入了但没被使用"这个类别**消掉**了——每次注入都是模型的一次
 * 显式拉取，因此归因退化为一个廉价计数器。
 *
 * 它同时给出**明确的杀死判据**：若某视图长期趋近 0 次拉取，
 * 就删掉该视图，不要"以防万一"地留着（§6.9）。判定结果进 health 的 detail。
 *
 * 纯函数：台账是不可变值，`recordPull` 返回新台账。
 */
import type { ContextPressure } from '../../kernel/abi/index.js'

/** 规划 §6.4 的五个拉取视图（工具名）。 */
export const VIEW_TOOLS: readonly string[] = ['omb_recall', 'omb_relate', 'omb_files', 'omb_method', 'omb_focus']

/** 少于这么多轮**不下杀死结论**（诚实：样本不足就不装懂）。 */
export const MIN_TURNS_FOR_VERDICT = 20

/** 每轮拉取次数低于此值即视为"长期趋近 0"（= 20 轮里不到 1 次）。 */
export const DEAD_VIEW_PULLS_PER_TURN = 0.05

export interface ViewCounters {
  readonly pulls: number
  /** 首次被拉的轮次；从未被拉时为 null。 */
  readonly firstTurn: number | null
  readonly lastTurn: number | null
}

export interface PullLedger {
  readonly views: Readonly<Record<string, ViewCounters>>
  /** 已观察到的回合数（由 `turn/start` 推进，单调不减）。 */
  readonly turns: number
}

export const EMPTY_LEDGER: PullLedger = { views: {}, turns: 0 }

/** 记一次拉取。空视图名被忽略（不让垃圾键污染台账）；返回新台账。 */
export function recordPull(ledger: PullLedger, view: string, turn: number): PullLedger {
  const name = typeof view === 'string' ? view.trim() : ''
  if (name === '') return normalizeLedger(ledger)
  const base = normalizeLedger(ledger)
  const at = turnOf(turn)
  const previous = base.views[name]
  const next: ViewCounters = previous === undefined
    ? { pulls: 1, firstTurn: at, lastTurn: at }
    : {
        pulls: previous.pulls + 1,
        firstTurn: previous.firstTurn === null ? at : Math.min(previous.firstTurn, at),
        lastTurn: previous.lastTurn === null ? at : Math.max(previous.lastTurn, at),
      }
  return { views: { ...base.views, [name]: next }, turns: Math.max(base.turns, at) }
}

/** 推进回合边界。轮次单调不减，回退的输入被忽略。 */
export function noteTurn(ledger: PullLedger, turn: number): PullLedger {
  const base = normalizeLedger(ledger)
  const at = turnOf(turn)
  return at <= base.turns ? base : { views: base.views, turns: at }
}

export interface ViewPullStats {
  readonly view: string
  readonly pulls: number
  readonly firstTurn: number | null
  readonly lastTurn: number | null
  readonly pullsPerTurn: number
}

export interface PullSnapshot {
  readonly turns: number
  readonly totalPulls: number
  readonly pullsPerTurn: number
  readonly views: readonly ViewPullStats[]
  /** 长期趋近 0、按杀死判据应删除的视图（轮数不足时恒为空）。 */
  readonly deadViews: readonly string[]
  /** 人可读结论，进状态面。 */
  readonly verdict: string
}

export interface WatchOptions {
  /**
   * 当前**实际注册**的视图名。只有它们才参与"该删了吗"的判定——
   * 模块被关掉后工具本就不存在，不能算它的账。省略时只看台账里出现过的视图。
   */
  readonly views?: readonly string[]
  readonly minTurns?: number
  readonly deadBelow?: number
}

/**
 * 汇总台账。
 *
 * 传入 `views` 时，**从未被拉过的视图也会出现在结果里**（拉取 0 次）——
 * 这正是杀死判据要找的对象。
 */
export function summarize(ledger: PullLedger, options: WatchOptions = {}): PullSnapshot {
  const base = normalizeLedger(ledger)
  const turns = base.turns
  const minTurns = numberOr(options.minTurns, MIN_TURNS_FOR_VERDICT)
  const deadBelow = numberOr(options.deadBelow, DEAD_VIEW_PULLS_PER_TURN)

  const names = new Set<string>(Object.keys(base.views))
  for (const name of options.views ?? []) {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (trimmed !== '') names.add(trimmed)
  }

  const views: ViewPullStats[] = [...names].sort().map(view => {
    const counters = base.views[view] ?? { pulls: 0, firstTurn: null, lastTurn: null }
    return {
      view,
      pulls: counters.pulls,
      firstTurn: counters.firstTurn,
      lastTurn: counters.lastTurn,
      pullsPerTurn: ratio(counters.pulls, turns),
    }
  })

  const totalPulls = views.reduce((sum, item) => sum + item.pulls, 0)
  const settled = turns >= minTurns
  const deadViews = settled
    ? views.filter(item => item.pullsPerTurn < deadBelow).map(item => item.view)
    : []

  return {
    turns,
    totalPulls,
    pullsPerTurn: ratio(totalPulls, turns),
    views,
    deadViews,
    verdict: verdictOf({ turns, totalPulls, pullsPerTurn: ratio(totalPulls, turns), deadViews, minTurns, deadBelow }),
  }
}

/** health().detail 里的一行：拉取率 + 待删除视图（杀死判据必须可见）。 */
export function healthDetail(snapshot: PullSnapshot): string {
  const rate = snapshot.pullsPerTurn.toFixed(2)
  const dead = snapshot.deadViews.length > 0
    ? `待删除视图：${snapshot.deadViews.join('、')}（长期趋近 0 次/轮）`
    : '无视图趋近 0'
  return `拉取 ${snapshot.totalPulls} 次 / ${snapshot.turns} 轮 = ${rate} 次/轮；${dead}`
}

/**
 * 从度量桥的压力读数里取缓存命中率。
 *
 * **没有任何缓存读写时返回 null（不可测），而不是 0**——
 * 0 的意思是"缓存全没命中"，与"宿主没报这个量"是两件事。
 */
export function cacheHitRate(pressure: ContextPressure | null | undefined): number | null {
  const read = Math.max(0, numberOr(pressure?.cacheReadTokens, 0))
  const write = Math.max(0, numberOr(pressure?.cacheWriteTokens, 0))
  if (read + write <= 0) return null
  return ratio(read, read + write)
}

function verdictOf(input: {
  turns: number
  totalPulls: number
  pullsPerTurn: number
  deadViews: readonly string[]
  minTurns: number
  deadBelow: number
}): string {
  const rate = input.pullsPerTurn.toFixed(2)
  if (input.turns < input.minTurns) {
    return `已观察 ${input.turns} 轮（判定需 ${input.minTurns} 轮），暂不下"该删视图"的结论；当前拉取 ${input.totalPulls} 次（${rate} 次/轮）。`
  }
  if (input.deadViews.length > 0) {
    return `拉取 ${input.totalPulls} 次 / ${input.turns} 轮 = ${rate} 次/轮；建议删除视图：${input.deadViews.join('、')}（低于 ${input.deadBelow} 次/轮，说明模型不用它）。`
  }
  return `拉取 ${input.totalPulls} 次 / ${input.turns} 轮 = ${rate} 次/轮；没有视图趋近 0，全部保留。`
}

function normalizeLedger(ledger: PullLedger | undefined | null): PullLedger {
  if (ledger === undefined || ledger === null || typeof ledger !== 'object') return EMPTY_LEDGER
  const views = typeof ledger.views === 'object' && ledger.views !== null ? ledger.views : {}
  return { views, turns: turnOf(ledger.turns) }
}

function turnOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0
  const value = numerator / denominator
  return Number.isFinite(value) ? value : 0
}
