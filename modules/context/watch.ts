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
 *
 * **一份台账只描述一个会话**。分桶由调用方做（`index.ts` 持有
 * `Map<SessionRef, PullLedger>`）；本节只负责把一个会话的账算清楚。
 * 拿不到会话标识的调用进 `UNKNOWN_SESSION_KEY` 桶——**它不是某个会话**，
 * 并进任何具体会话就等于拿别人的调用给本会话定罪。
 */
import type { ContextPressure, SessionRef } from '../../kernel/abi/index.js'

/** 规划 §6.4 的五个拉取视图（工具名）。 */
export const VIEW_TOOLS: readonly string[] = ['omb_recall', 'omb_relate', 'omb_files', 'omb_method', 'omb_focus']

/**
 * 拿不到会话标识时的归属桶。
 *
 * 它**不是**某个具体会话：混进去会让"待删除视图"基于别的会话的噪声下结论
 * （实测症状：本会话从未调用过的工具出现在待删除列表里）。
 */
export const UNKNOWN_SESSION_KEY = '<未知会话>'

/** 会话键归一：空串 / 非串 → `UNKNOWN_SESSION_KEY`。 */
export function sessionKeyOf(session: SessionRef | null | undefined): SessionRef {
  return typeof session === 'string' && session.trim() !== '' ? session : UNKNOWN_SESSION_KEY
}

/** 会话键 → 快照口径：`UNKNOWN_SESSION_KEY` 记作 `null`（状态面写"未知会话"）。 */
export function sessionOfKey(key: SessionRef): SessionRef | null {
  return key === UNKNOWN_SESSION_KEY ? null : key
}

/** 少于这么多轮**不下杀死结论**（诚实：样本不足就不装懂）。 */
export const MIN_TURNS_FOR_VERDICT = 20

/** 每轮拉取次数低于此值即视为"长期趋近 0"（= 20 轮里不到 1 次）。 */
export const DEAD_VIEW_PULLS_PER_TURN = 0.05

/**
 * 分会话表（`ledgers` / `sessionTurns` / `sessionPressure`）的 **LRU 上界**。
 *
 * 取值理由（32）：
 * - 宿主侧同时活跃的会话数是个位数（真机 1~3），32 给足 10 倍余量：交错会话、
 *   子代理会话、重连会话都不会把**正在用的账**挤掉；
 * - 每份账只有几个键（5 个视图 + 少量非视图工具名），32 份的内存代价可忽略；
 * - 上界必须有：宿主**不会**把会话结束事件交给模块（本片刻意不依赖它，
 *   见规划 §4 S3-f），没有上界时分会话台账会随插件加载以来的历史会话数
 *   单调增长，且状态面每次渲染都要全量排序——"唯一的诊断入口"随时间退化。
 *
 * **被淘汰的会话再被查询时表现为"未测量"**（拿到 `EMPTY_LEDGER`）。
 * 这是有界性的代价，如实呈现，不假装还记得它。
 */
export const SESSION_TABLE_MAX = 32

/**
 * 状态面板一次最多列几个会话（**只影响渲染，不影响记账**）。
 *
 * 分会话表本身可留 {@link SESSION_TABLE_MAX} 份，但 `omb_status` 全列出来会
 * 把整段状态面撑成几十行；只列最近活动的这几个，并在同一段里写明
 * "另有 M 个未列出"——**截断要说出来**，否则读者会把"列出的"当成"全部的"。
 */
export const SESSIONS_LIST_MAX = 8

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
  /**
   * 这份账属于哪个会话；`null` = 拿不到会话标识（"未知会话"桶）。
   *
   * 有它才谈得上"本会话口径"：没有这个字段，读者永远不知道
   * `turns` / `totalPulls` 是谁的数。
   */
  readonly session: SessionRef | null
  /** **本会话**已观察到的回合数（由 `turn/start` 推进，单调不减）。 */
  readonly turns: number
  /**
   * 本会话的回合数是否已知。
   *
   * `false` ⇒ `pullsPerTurn` 的**分母未知**：此时如实写"轮数未知"，
   * 不用跨会话或其他会话的数顶替，也不下"该删视图"的结论。
   */
  readonly turnsKnown: boolean
  /** **本会话**的拉取总次数（不含别的会话）。口径见 `scopedToViews`/`countedViews`。 */
  readonly totalPulls: number
  /**
   * 头条读数（`totalPulls` / `pullsPerTurn`）覆盖了哪些工具名。
   *
   * - `true`：只覆盖**登记的拉取式视图**（传了 `options.views`）——与 `deadViews`
   *   的判定集合**同一口径**；
   * - `false`：覆盖台账里出现过的**全部工具名**（没给视图清单时的纯函数口径）。
   */
  readonly scopedToViews: boolean
  /** 头条读数计入的工具名个数（`scopedToViews` 为 true 时 = 登记的视图数）。 */
  readonly countedViews: number
  /** 本会话的每轮拉取次数；分母未知时为 0（**不要**当成"测得 0"）。 */
  readonly pullsPerTurn: number
  readonly views: readonly ViewPullStats[]
  /** 长期趋近 0、按杀死判据应删除的视图（轮数不足时恒为空）。 */
  readonly deadViews: readonly string[]
  /** 轮数是否已达到判定门槛。未达到时 `deadViews` 为空**不代表没问题**。 */
  readonly settled: boolean
  /** 判定所用的最少轮数（配置过就带出来，供状态面说明）。 */
  readonly minTurns: number
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
 * 汇总**某一个会话**的台账。
 *
 * 传入 `views` 时，**从未被拉过的视图也会出现在结果里**（拉取 0 次）——
 * 这正是杀死判据要找的对象。
 *
 * ## 头条与杀死判据必须**同一口径**（本片修掉的真缺陷）
 *
 * `dsh/` 把**每一次**工具调用都记进台账（`read` / `pwsh` / `glob`…），而"杀死判据"
 * 只能判我们自己登记的五个视图。旧实现把台账里**全部**工具名求和当分子，
 * 于是同一份状态面里出现：
 *
 * ```
 * 本会话拉取 28 次 / 22 轮 = 1.27 次/轮；待删除视图：omb_files、omb_relate、…
 * ```
 *
 * ——头条说"用得挺勤"，判据说"五个视图全该删"（真机那条矛盾读数就是从这里长出来的）。
 * 现在给了 `views` 时**分子只算 judged 集合**；非视图工具仍然出现在 `views` 明细里
 * （它们是本会话真实发生过的拉取，只是不参与"杀谁"的决定），只是不进头条分子。
 *
 * @param session 这份账属于哪个会话（`null` = 未知会话桶），只影响文案口径，
 *   不参与计算——**会话隔离由"喂进来的是哪本账"保证**。
 */
export function summarize(ledger: PullLedger, options: WatchOptions = {}, session: SessionRef | null = null): PullSnapshot {
  const base = normalizeLedger(ledger)
  const turns = base.turns
  const minTurns = numberOr(options.minTurns, MIN_TURNS_FOR_VERDICT)
  const deadBelow = numberOr(options.deadBelow, DEAD_VIEW_PULLS_PER_TURN)

  const names = new Set<string>(Object.keys(base.views))
  // 只有**登记的视图**才参与"该删了吗"的判定：台账里可能还有别的工具名
  // （`dsh/` 把每次工具调用都记进来），而"杀死判据"能删的只有我们自己注册的视图。
  // 没给 `views` 时退回"台账里出现过的名字"（纯函数调用方的口径）。
  const judged = new Set<string>()
  for (const name of options.views ?? []) {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (trimmed === '') continue
    names.add(trimmed)
    judged.add(trimmed)
  }
  const judgedAll = judged.size === 0

  const views: ViewPullStats[] = [...names].sort().map(view => {
    const counters = base.views[view] ?? { pulls: 0, firstTurn: null, lastTurn: null }
    return {
      view,
      pulls: countOf(counters.pulls),
      firstTurn: counters.firstTurn === null ? null : turnOf(counters.firstTurn),
      lastTurn: counters.lastTurn === null ? null : turnOf(counters.lastTurn),
      pullsPerTurn: ratio(countOf(counters.pulls), turns),
    }
  })

  // 分子与 `deadViews` 用**同一个谓词**（`judgedAll || judged.has(...)`）：
  // 两个口径只允许在代码里出现一次，改一处忘一处就是下一次"两个面互相矛盾"。
  const counted = (view: string): boolean => judgedAll || judged.has(view)
  const countedViews = judgedAll ? views.length : judged.size
  const totalPulls = views.reduce((sum, item) => sum + (counted(item.view) ? item.pulls : 0), 0)
  // 0 轮 = 本会话还没观察到回合边界（分母**未知**），不是"第 0 轮"。
  const turnsKnown = turns > 0
  const settled = turns >= minTurns
  const deadViews = settled
    ? views.filter(item => counted(item.view) && item.pullsPerTurn < deadBelow).map(item => item.view)
    : []
  const pullsPerTurn = ratio(totalPulls, turns)

  return {
    session,
    turns,
    turnsKnown,
    totalPulls,
    scopedToViews: !judgedAll,
    countedViews,
    pullsPerTurn,
    views,
    deadViews,
    settled,
    minTurns,
    verdict: verdictOf({
      session,
      turnsKnown,
      turns,
      totalPulls,
      scopedToViews: !judgedAll,
      countedViews,
      pullsPerTurn,
      deadViews,
      minTurns,
      deadBelow,
    }),
  }
}

/**
 * health().detail 里的一行：拉取率 + 杀死判据结论。
 *
 * 四种情形**必须分开说**：轮数未知 / 轮数不足 / 有待删除视图 / 无视图趋近 0。
 * 把"样本不够"说成"一切正常"是这类计数器最常见的谎。
 * 文案一律带口径（"本会话"/"未知会话"），不留"这个数是谁的"的疑问。
 *
 * **还要自报分子口径**（{@link scopeNote}）：头条只算登记的拉取式视图，
 * 而明细里还列着 `read`/`pwsh` 这类非视图工具——不写清的话读者会把两者混为一谈，
 * 于是又回到"1.27 次/轮 与 五个视图全待删 同屏"那种矛盾。
 */
export function healthDetail(snapshot: PullSnapshot): string {
  const who = snapshot.session === null ? '未知会话' : '本会话'
  const scope = scopeNote(snapshot)
  if (!snapshot.turnsKnown) {
    return `${who}拉取 ${snapshot.totalPulls} 次 / 轮数未知（未观察到回合边界，判定需 ${snapshot.minTurns} 轮），暂不下删除结论${scope}`
  }
  const rate = snapshot.pullsPerTurn.toFixed(2)
  const head = `${who}拉取 ${snapshot.totalPulls} 次 / ${snapshot.turns} 轮 = ${rate} 次/轮${scope}`
  if (!snapshot.settled) {
    return `${head}；轮数不足（判定需 ${snapshot.minTurns} 轮），暂不下删除结论`
  }
  const dead = snapshot.deadViews.length > 0
    ? `待删除视图：${snapshot.deadViews.join('、')}（长期趋近 0 次/轮）`
    : '无视图趋近 0'
  return `${head}；${dead}`
}

/**
 * 头条分子的**口径说明**（自报）：它必须与 `deadViews` 的判定集合一致，
 * 否则读者无法判断"次/轮"这个数该和谁比。
 */
export function scopeNote(snapshot: PullSnapshot): string {
  return snapshot.scopedToViews
    ? `（口径：只计 ${snapshot.countedViews} 个拉取式视图的调用，非视图工具不计入这个分子）`
    : `（口径：台账里出现过的全部工具名，共 ${snapshot.countedViews} 个）`
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
  session: SessionRef | null
  turnsKnown: boolean
  turns: number
  totalPulls: number
  scopedToViews: boolean
  countedViews: number
  pullsPerTurn: number
  deadViews: readonly string[]
  minTurns: number
  deadBelow: number
}): string {
  const who = input.session === null ? '未知会话' : '本会话'
  const rate = input.pullsPerTurn.toFixed(2)
  // 口径与 healthDetail 同源（`scopeNote` 的两种说法），避免两个入口各写一套。
  const scope = input.scopedToViews
    ? `（口径：只计 ${input.countedViews} 个拉取式视图的调用，非视图工具不计入）`
    : `（口径：台账里出现过的全部工具名，共 ${input.countedViews} 个）`
  if (!input.turnsKnown) {
    return `${who}拉取 ${input.totalPulls} 次；${who}回合数未知（判定需 ${input.minTurns} 轮），暂不下"该删视图"的结论。`
  }
  if (input.turns < input.minTurns) {
    return `${who}已观察 ${input.turns} 轮（判定需 ${input.minTurns} 轮），暂不下"该删视图"的结论；${who}拉取 ${input.totalPulls} 次（${rate} 次/轮）${scope}。`
  }
  if (input.deadViews.length > 0) {
    return `${who}拉取 ${input.totalPulls} 次 / ${input.turns} 轮 = ${rate} 次/轮${scope}；建议删除视图：${input.deadViews.join('、')}（低于 ${input.deadBelow} 次/轮，说明模型不用它）。`
  }
  return `${who}拉取 ${input.totalPulls} 次 / ${input.turns} 轮 = ${rate} 次/轮${scope}；没有视图趋近 0，全部保留。`
}

function normalizeLedger(ledger: PullLedger | undefined | null): PullLedger {
  if (ledger === undefined || ledger === null || typeof ledger !== 'object') return EMPTY_LEDGER
  const views = typeof ledger.views === 'object' && ledger.views !== null ? ledger.views : {}
  return { views, turns: turnOf(ledger.turns) }
}

function turnOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 计数：非有限数或负数按 0（畸形台账不得把 NaN 传染给 pullsPerTurn 与状态面）。 */
function countOf(value: unknown): number {
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
