/**
 * `omb-context` 模块注册入口（上下文优化，规划 §6）。
 *
 * 四条杠杆（§6.2）：**准入**（要不要注入）· **布局**（前缀稳定）·
 * **归因**（拉取计数）· **塑形**（按测得的压力调整行为，而不是设死上限）。
 *
 * 硬边界：
 * - **没有每回合硬性 token 上限**：`candidateConsiderLimit` 是"一次最多考虑几个候选"
 * - **不自己算 token**：一律走内核度量桥 `kernel.pressure()`（§3.3 不变量 6）
 * - 订阅者与 disposer 全部同步注册，卸载零残留（H-1 / H-2）
 */
import { z } from 'zod'
import type {
  ContextPressure,
  FocusDepth,
  FocusState,
  Kernel,
  ModuleHealth,
  ModuleManifest,
  ModuleRegistration,
  SessionRef,
  StatusRegistry,
  ToolDefinition,
} from '../../kernel/abi/index.js'
import { SERVICES, derivedCapabilities, derivedRequires, toolsServiceFor } from '../../kernel/abi/index.js'
import type { AdmissionOptions, Candidate } from './admission.js'
import { DEFAULT_CANDIDATE_CONSIDER_LIMIT, marginalValue, measuredCost, selectForInjection } from './admission.js'
import type { BandBehavior, PressureBands, PressureReading } from './pressure.js'
import { bandOf, bandsFromPair, behaviorFor, readingOf } from './pressure.js'
import type { PullLedger, PullSnapshot, ViewPullStats, WatchOptions } from './watch.js'
import {
  EMPTY_LEDGER,
  MIN_TURNS_FOR_VERDICT,
  SESSION_TABLE_MAX,
  SESSIONS_LIST_MAX,
  UNKNOWN_SESSION_KEY,
  VIEW_TOOLS,
  cacheHitRate,
  noteTurn,
  recordPull,
  sessionKeyOf,
  sessionOfKey,
  summarize,
} from './watch.js'
import type { StatusPanelInput } from './tools.js'
import { buildStatusPanel, createStatusContributor } from './tools.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export const MODULE_ID = 'omb-context'
export const MODULE_VERSION = '3.6.0'

/**
 * 「真的没有会话」时面板上的那一句说明。
 *
 * 它必须由**本次渲染**的会话解析结果推出（`panelInput`），**不做累积**：
 * 累积写法会把"当时没有会话"永久留在面板上，于是拿到会话之后，同一段里
 * 一边报 `moderate / 0.343`、一边说"无活跃会话：读数缺失"——同一次输出里
 * 两个相反的说法，读者无法判断该信哪个。
 */
const NO_SESSION_NOTE = '无活跃会话：压力读数缺失，按宽松档处理'

/** 配置：`cordis.patch.yml` 的 `config` 段。 */
export interface ContextConfig {
  /** `[适中阈值, 紧张阈值]`；软档位，**从测量标定**，不手写当真值。 */
  readonly pressureBands: readonly [number, number]
  /** **一次最多考虑几个候选**（安全阀）。不是每回合 token 上限。 */
  readonly candidateConsiderLimit: number
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  pressureBands: [0.3, 0.6],
  candidateConsiderLimit: DEFAULT_CANDIDATE_CONSIDER_LIMIT,
}

/**
 * 配置 schema（zod）。缺省值完整（内核会原样传 `undefined`）。
 * 非法取值抛异常 → 内核标 `failed` 并写明原因（诚实降级）。
 */
export const contextConfigSchema = z
  .object({
    pressureBands: z.tuple([z.number(), z.number()]).default([0.3, 0.6]),
    candidateConsiderLimit: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_CONTEXT_CONFIG.candidateConsiderLimit),
  })
  // 目录级缺省必须是**新对象**：`readonly` 元组与 zod 的 `[number, number]` 不同型，
  // 且共享同一个字面量会让调用方有机会改到 schema 的缺省值。
  .default({ pressureBands: [0.3, 0.6], candidateConsiderLimit: DEFAULT_CANDIDATE_CONSIDER_LIMIT })

/** `context:pressure` 服务面：压力读数 + 档位行为。 */
export interface ContextPressureService {
  readonly bands: PressureBands
  bandOf(fillRatio: number | null): ReturnType<typeof bandOf>
  behaviorFor(band: ReturnType<typeof bandOf>): BandBehavior
  /** 一次拿全：压力读数 + 档位 + 行为。 */
  read(session?: SessionRef): PressureReading & { readonly pressure: ContextPressure }
}

/**
 * `context:metrics` 服务面：拉取计数 + 缓存命中率 + 注入裁决。
 *
 * 拉取计数与 admission 合并在一个观测面服务里（`abi/catalog.ts` 的约定：
 * 一个模块一个观测面服务，不为一个指标开一个服务）。
 *
 * ## 生产消费者只有 `recordPull` 一个（S3-d 的如实标注）
 *
 * 全仓 grep 的事实：生产代码里只有 `dsh/session.ts` 调 `recordPull`；
 * `select` / `marginalValue` / `measuredCost` / `snapshot` / `killList` /
 * `views` / `focusState` 都**没有生产调用方**（只有测试与手动排查在调）。
 * 因此"注入裁决"（moderate 推一条、tight 主动提示）从未发生——
 * 状态面（`healthNow` 与 `tools.ts` 的档位行为行）必须把这一点写出来，
 * 不许让读者以为它在工作。接上真实消费者之后，同步删掉那些标注。
 */
export interface ContextMetricsService {
  /**
   * 记一次拉取。`dsh/` 包住五个视图工具时调用。**绝不抛**。
   *
   * `session` 省略时用当前会话；**拿不到会话就记进"未知会话"桶**（状态面明说），
   * 不会混进任何具体会话。
   */
  recordPull(view: string, session?: SessionRef): void
  /**
   * **某一个会话**的台账快照（含杀死判据）。
   *
   * `session` 省略时用"当前会话"（内核活跃会话登记处 → 本模块订阅到的最近回合）；
   * 都拿不到就落到"未知会话"桶——**不会**混进任何具体会话。
   */
  snapshot(session?: SessionRef, options?: WatchOptions): PullSnapshot
  /** 该会话里长期趋近 0、按杀死判据应删除的视图（轮数不足时为空）。 */
  killList(session?: SessionRef, options?: WatchOptions): readonly string[]
  /** 缓存命中率；不可测时 null。 */
  cacheHitRate(session?: SessionRef): number | null
  /** 当前档位状态（供注入裁决用）。 */
  focusState(session?: SessionRef): FocusState
  /** 单位 token 的边际价值。 */
  marginalValue(candidate: Candidate, alreadyPresent: readonly Candidate[], focus?: FocusState): number
  /** 选要注入的候选：只推最有价值的一条（`pushLimit` 由压力档位决定）。 */
  select(
    candidates: readonly Candidate[],
    alreadyPresent: readonly Candidate[],
    focus?: FocusState,
    options?: ContextSelectOptions,
  ): readonly Candidate[]
  /** 逐节点真实成本；没有该节点返回 null（**不估算**）。 */
  measuredCost(name: string, session?: SessionRef): number | null
  /** **某一个会话**里每个视图的计数与轮次。 */
  views(session?: SessionRef, options?: WatchOptions): readonly ViewPullStats[]
}

interface SessionPressure {
  band: string
  depth: FocusDepth
  reason: string
}

/** `select` 的选项：admission 的两个旋钮 + 读哪一段压力。 */
export interface ContextSelectOptions extends AdmissionOptions {
  /**
   * 用哪个会话的压力决定推不推。
   * 缺省用"最近活跃会话"——工具与提示渲染都发生在某个回合内，那是正确的归属。
   */
  readonly session?: SessionRef
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 建立模块实例。**每个实例自带状态**：拉取台账（**按会话分桶**，一个会话一份账）
 * 与回合计数。
 */
export function createContextModule(): ModuleRegistration<ContextConfig> {
  let lastHealth: ModuleHealth = {
    state: 'ok',
    detail: `未启动；软压力档位 ${DEFAULT_CONTEXT_CONFIG.pressureBands.join('/')}（无每回合 token 上限）`,
  }

  const manifest: ModuleManifest<ContextConfig> = {
    id: MODULE_ID,
    version: MODULE_VERSION,
    requires: derivedRequires(MODULE_ID),
    capabilities: derivedCapabilities(MODULE_ID),
    configSchema: contextConfigSchema,
    health: () => lastHealth,
  }

  function apply(kernel: Kernel, config: ContextConfig): () => void {
    const disposers: (() => void)[] = []
    const degradations: string[] = []
    const notes: string[] = []

    // ── 配置落地：任何收敛都写进降级原因（不静默改配置） ──
    const rawBands = config.pressureBands ?? DEFAULT_CONTEXT_CONFIG.pressureBands
    const bands = bandsFromPair(rawBands)
    if (bands.moderate !== rawBands[0] || bands.tight !== rawBands[1]) {
      degradations.push(`pressureBands 已收敛为 [${bands.moderate}, ${bands.tight}]（收到 [${rawBands.join(', ')}]）`)
    }
    const rawConsider = config.candidateConsiderLimit
    const considerLimit = Number.isFinite(rawConsider) ? Math.min(Math.max(Math.floor(rawConsider), 1), 200) : DEFAULT_CANDIDATE_CONSIDER_LIMIT
    if (considerLimit !== rawConsider) {
      degradations.push(`candidateConsiderLimit 已收敛为 ${considerLimit}（收到 ${String(rawConsider)}）`)
    }
    if (degradations.length > 0) {
      for (const note of degradations) kernel.logger.warn(`${MODULE_ID}：${note}`)
    }

    // ── 拉取台账（**按会话隔离**）与回合计数 ──
    //
    // 曾经是"一份全局台账 + 一个全局回合计数"：别的会话的工具调用会混进来，
    // 于是"待删除视图"里出现本会话从未调用过的工具（实测：`cordis_inspect_list`
    // 变成了待删除视图），分母也是跨会话的总轮数。后果不是"数字不好看"——
    // 而是**拿别人的噪声给本会话定罪**，将来按"零拉取视图"杀工具就会杀错。
    // 现在：一个会话一本账，`turns` / `totalPulls` / 判据都只算本会话。
    const ledgers = new Map<SessionRef, PullLedger>()
    const sessionTurns = new Map<SessionRef, number>()
    const sessionPressure = new Map<SessionRef, SessionPressure>()

    /**
     * 最近活动顺序（**LRU**）：末尾最新，三张分会话表共用同一个顺序。
     *
     * 为什么必须有：宿主**不会**把会话结束事件交给模块（本片刻意不依赖它，
     * 见规划 §4 S3-f），旧实现只在 dispose 时清空 → 长跑宿主上三张表随历史会话数
     * 单调增长，"分会话拉取台账"段越用越长、每次渲染全量排序。
     * 上界与取值理由见 `watch.ts` 的 `SESSION_TABLE_MAX`。
     *
     * 淘汰必须按"最久未活动"而不是"最早插入"：一个老会话可能正在被使用
     * （交错会话/长会话），按插入序淘汰会把**正在用的账**清掉。
     */
    const sessionOrder = new Map<SessionRef, true>()
    let evictedSessions = 0

    /** 把某个会话标记为"刚活动过"，并淘汰最久未活动的会话（三张表一起删，不留半份账）。 */
    const touchSession = (key: SessionRef): void => {
      sessionOrder.delete(key)
      sessionOrder.set(key, true)
      while (sessionOrder.size > SESSION_TABLE_MAX) {
        const oldest = sessionOrder.keys().next().value
        if (oldest === undefined) break
        sessionOrder.delete(oldest)
        ledgers.delete(oldest)
        sessionTurns.delete(oldest)
        sessionPressure.delete(oldest)
        evictedSessions += 1
      }
    }

    const ledgerFor = (key: SessionRef): PullLedger => ledgers.get(key) ?? EMPTY_LEDGER

    /**
     * 会话解析：**只认显式传入的那个会话**（口径唯一）。
     *
     * 这里曾经有两条兜底：内核活跃会话登记处（`SERVICES.activeSession.current()`）
     * 与本模块订阅到的"最近回合"。两者都是"**最近**看到的会话"，而不是"这次是谁"——
     * 两个会话交错时，A 的拉取计数会被记到 B 的账上（或反过来把 B 的账当成 A 的读），
     * 而状态面看不出来这个数是谁的。**拿不到就落到"未知会话"桶**（`sessionKeyOf`），
     * 状态面照实说明，绝不并入任何具体会话。
     *
     * 调用方要精确归属时**必须显式传会话**：`dsh/` 在 `tools/result` 里从
     * `exec.agent.session.id` 拿到的是**这次调用自己的**会话，那才是可用的来源。
     */
    const resolveSession = (session?: SessionRef): SessionRef | null => {
      if (typeof session === 'string' && session.trim() !== '') return session
      return null
    }

    /**
     * 按**显式会话**读压力；没有会话时不借用别人的读数。
     *
     * 内核登记处的 `current()` 仍是"最后一次观测到的会话"，**读历史可以、当归属不行**，
     * 所以这里不用它。
     */

    /** 读时钟：端口异常时返回 0（服务方法不因宿主端口坏掉而抛给调用方）。 */
    const now = (): number => {
      try {
        return kernel.clock.now()
      } catch {
        return 0
      }
    }

    const pressureOf = (session?: SessionRef): ContextPressure => {
      const target = resolveSession(session)
      if (target === null) {
        // **这里不写 `notes`**：那句话必须由**这一次**的读数推出（见 `panelInput`）。
        // 曾经它在这里 `notes.push(...)`，于是"没有会话"那一刻的说明会一直挂在面板上——
        // 拿到会话之后，同一段里一边报 `moderate / 0.343`、一边说"无活跃会话：读数缺失"。
        // 累积的说明与实时读数混在一起，就是"快照 vs 实时"这一类缺陷的另一种形态。
        return { totalTokens: 0, fillRatio: null, band: 'relaxed', cacheReadTokens: 0, cacheWriteTokens: 0, nodes: [] }
      }
      try {
        return kernel.pressure(target)
      } catch (error) {
        kernel.logger.warn(`${MODULE_ID}：读压力失败——${messageOf(error)}`)
        return { totalTokens: 0, fillRatio: null, band: 'relaxed', cacheReadTokens: 0, cacheWriteTokens: 0, nodes: [] }
      }
    }

    const focusState = (session?: SessionRef): FocusState => {
      const target = resolveSession(session)
      const recorded = target === null ? undefined : sessionPressure.get(target)
      let depth: FocusDepth = recorded?.depth ?? 'standard'
      if (target !== null) {
        try {
          depth = kernel.focus(target)
        } catch {
          depth = recorded?.depth ?? 'standard'
        }
      }
      return { depth, reason: recorded?.reason ?? '', setAt: now() }
    }

    /**
     * **各会话**的台账快照（含"未知会话"桶），按**最近活动先后**排列（最旧在前）。
     *
     * 这是"归属"在状态面上的呈现方式：既然没有"当前会话"可挑，就把每一份账
     * 连同它的主人一起摆出来——读者不需要猜"这个数是谁的"。
     * 排列顺序与 LRU 顺序同源，因此"最近用过的会话在最后一行"，且是确定性的
     * （同一串事件 → 同一份输出，不依赖 Map 的偶然顺序）。
     *
     * **只列最近活动的 `SESSIONS_LIST_MAX` 个**：分会话表本身有 LRU 上界，
     * 但即使 32 份全列出来也会把状态面撑成几十行；
     * 截断数量由 {@link sessionsScope} 给出并在渲染时写明。
     */
    const sessionsSnapshot = (options?: WatchOptions): readonly {
      readonly session: SessionRef | null
      readonly band?: string
      readonly pulls: PullSnapshot
    }[] =>
      [...sessionOrder.keys()]
        .slice(-SESSIONS_LIST_MAX)
        .map(key => {
          const session = sessionOfKey(key)
          // 压力读数**按该会话**取；拿不到就省略（不借用别人的读数）
          const band = session === null ? undefined : pressureOf(session).band
          return {
            session,
            ...(band === undefined ? {} : { band }),
            pulls: summarize(ledgerFor(key), options ?? { views: VIEW_TOOLS }, session),
          }
        })

    /**
     * 分会话台账的**截断口径**（状态面照实写出"另有 M 个未列出"）。
     *
     * `hidden` = 还在内存表里但这次没列出；`evicted` = 已被 LRU 淘汰、
     * **连计数都不在了**。两个数含义不同，不许合并成一个"省略 N 个"。
     */
    const sessionsScope = (): { listed: number; hidden: number; evicted: number; tableMax: number } => {
      const listed = Math.min(sessionOrder.size, SESSIONS_LIST_MAX)
      return {
        listed,
        hidden: Math.max(0, sessionOrder.size - listed),
        evicted: evictedSessions,
        tableMax: SESSION_TABLE_MAX,
      }
    }

    /**
     * **某一个会话**的台账快照。会话口径由 `resolveSession` 定（只认显式传入），
     * 拿不到就落到"未知会话"桶（`session` 为 null，状态面照实说明）。
     */
    const snapshotFor = (session?: SessionRef, options?: WatchOptions): PullSnapshot => {
      const key = sessionKeyOf(resolveSession(session))
      return summarize(ledgerFor(key), options ?? { views: VIEW_TOOLS }, sessionOfKey(key))
    }

    const healthNow = (): ModuleHealth => {
      // 压力读数**没有默认会话**：拿不到会话就是"未测量"（见 `resolveSession` 的说明）
      const pressure = pressureOf()
      const band = pressure.band ?? bandOf(pressure.fillRatio, bands)
      const known = [...ledgers.keys()].filter(key => key !== UNKNOWN_SESSION_KEY).sort()
      const unknown = snapshotFor(UNKNOWN_SESSION_KEY)
      const ledgerLine =
        known.length === 0 && unknown.totalPulls === 0
          ? '拉取台账：尚无可读账（未观测到任何会话的回合或拉取）'
          : `拉取台账：分会话计 ${known.length} 个会话`
            + `${unknown.totalPulls === 0 ? '' : ` + 未知会话桶 ${unknown.totalPulls} 次`}`
            + (evictedSessions === 0 ? '' : `（表上限 ${SESSION_TABLE_MAX}，已淘汰 ${evictedSessions} 个更早的会话）`)
            + '（**不挑"当前会话"**：逐会话计数与杀死判据见「组件自述」）'
      const parts = [
        `软档位 ${band}`,
        pressure.fillRatio === null
          ? 'fillRatio 未知（宿主未声明窗口）→ 按宽松档，不施压'
          : `fillRatio ${pressure.fillRatio.toFixed(3)}`,
        `行为 ${behaviorFor(band).mode}（最多推 ${behaviorFor(band).pushLimit} 条）`,
        // **如实标注**（S3-d）：`select`/`marginalValue`/`measuredCost`/
        // `announcePressure` 都没有生产消费者，在线的是拉取计数。不写这一句，
        // 上面那句"行为 single-best（最多推 1 条）"就是在承诺一件不发生的事。
        '注入裁决：当前无调用方（仅拉取计数在线）',
        ledgerLine,
      ]
      if (degradations.length > 0) parts.push(`降级：${degradations.join('；')}`)
      return {
        state: degradations.length > 0 ? 'degraded' : 'ok',
        detail: parts.join('；'),
        metrics: {
          // 会话数是**测到的**（观测到几个会话）；每会话的轮数/拉取数不进这里——
          // 它们属于具体会话，状态面逐会话列出（见 tools.ts 的分会话台账段）。
          sessions: known.length,
          unknownPulls: unknown.totalPulls,
          moderateBand: bands.moderate,
          tightBand: bands.tight,
          candidateConsiderLimit: considerLimit,
        },
      }
    }

    const report = (): void => {
      // 组装本身也不许把异常抛给事件总线：状态面挂掉是最难排查的故障，
      // 它必须自己还能说话（写清"组装失败"而不是整段消失）。
      try {
        lastHealth = healthNow()
      } catch (error) {
        lastHealth = { state: 'degraded', detail: `健康面组装失败（已隔离）：${messageOf(error)}` }
      }
      try {
        kernel.report(lastHealth)
      } catch (error) {
        kernel.logger.warn(`${MODULE_ID}：健康上报失败——${messageOf(error)}`)
      }
    }

    const provide = (name: string, value: unknown): void => {
      try {
        disposers.push(kernel.provide(name, value))
      } catch (error) {
        const note = `服务 ${name} 注册失败：${messageOf(error)}`
        degradations.push(note)
        kernel.logger.warn(`${MODULE_ID}：${note}`)
      }
    }

    // ── 事件：回合边界与压力档位（只观察，不接管 Loop） ──
    disposers.push(
      kernel.on('turn/start', payload => {
        const key = sessionKeyOf(payload.sessionId)
        touchSession(key)
        // 回合数**按本会话**推进：跨会话的总数不能当分母。
        // 用"观察到的回合边界数"而不是事件里的 `turn` 值，因为 `dsh/` 传的是
        // 0 基的 `step`（`dsh/session.ts` 的 `step/start` 分支）——直接用会把
        // 首轮记成第 0 轮，续接会话的步号还会把分母一次抬大、把视图误判成没人用。
        const turn = (sessionTurns.get(key) ?? 0) + 1
        sessionTurns.set(key, turn)
        ledgers.set(key, noteTurn(ledgerFor(key), turn))
        report()
      }),
    )

    disposers.push(
      kernel.on('focus/changed', payload => {
        const key = sessionKeyOf(payload.sessionId)
        touchSession(key)
        sessionPressure.set(key, {
          band: sessionPressure.get(key)?.band ?? 'relaxed',
          depth: payload.depth,
          reason: payload.reason,
        })
        report()
      }),
    )

    disposers.push(
      kernel.on('pressure/band-changed', payload => {
        const key = sessionKeyOf(payload.sessionId)
        touchSession(key)
        const reading = readingOf(payload.pressure, bands)
        sessionPressure.set(key, {
          band: reading.band,
          depth: focusState(key).depth,
          reason: sessionPressure.get(key)?.reason ?? '',
        })
        report()
      }),
    )

    // ── 服务面 ──
    const pressureService: ContextPressureService = {
      bands,
      bandOf: fillRatio => bandOf(fillRatio, bands),
      behaviorFor: band => behaviorFor(band),
      read: session => {
        const pressure = pressureOf(session)
        const reading = readingOf(pressure, bands)
        return { ...reading, band: reading.band, pressure }
      },
    }

    const metricsService: ContextMetricsService = {
      recordPull: (view, session) => {
        try {
          const key = sessionKeyOf(resolveSession(session))
          touchSession(key)
          // 本会话的回合数；未知时传 0（= "轮次未知"），**不用别的会话或全局轮数顶替**。
          const turn = sessionTurns.get(key) ?? 0
          ledgers.set(key, recordPull(ledgerFor(key), view, turn))
          if (key === UNKNOWN_SESSION_KEY) {
            // 拿不到会话就在状态面明说，别让这些计数看起来像某个会话的
            const note = '拿不到会话标识：拉取计数落在"未知会话"桶，不并入任何具体会话'
            if (!notes.includes(note)) notes.push(note)
          }
          report()
        } catch (error) {
          kernel.logger.warn(`${MODULE_ID}：记录拉取失败——${messageOf(error)}`)
        }
      },
      snapshot: (session, options) => snapshotFor(session, options),
      killList: (session, options) => snapshotFor(session, options).deadViews,
      cacheHitRate: session => cacheHitRate(pressureOf(session)),
      focusState: session => focusState(session),
      marginalValue: (candidate, alreadyPresent, focus) =>
        marginalValue(candidate, alreadyPresent, focus ?? focusState()),
      select: (candidates, alreadyPresent, focus, options) => {
        const target = focus ?? focusState(options?.session)
        const reading = pressureService.read(options?.session)
        // 推不推由**档位**决定：宽松/紧张档 pushLimit = 0（紧张档内容全部转工具拉取）。
        // 这不是 token 预算——没有"还剩多少额度"这种判断。
        const pushLimit = options?.pushLimit ?? reading.behavior.pushLimit
        return selectForInjection(candidates, alreadyPresent, target, {
          considerLimit: options?.considerLimit ?? considerLimit,
          pushLimit,
        })
      },
      measuredCost: (name, session) => measuredCost(pressureOf(session).nodes, name),
      views: (session, options) => snapshotFor(session, options).views,
    }

    const tools: readonly ToolDefinition[] = []
    // 保留位：上下文模块当前没有模型可见工具（`omb_status` 由 dsh/ 注册，属 omb-kernel）
    provide(toolsServiceFor(MODULE_ID), tools)

    /**
     * 状态面板的输入组装。`session` 是**状态面渲染时给出的本次会话**
     * （`dsh/status-tool.ts` 把顶层「## 上下文」段用的同一个会话标识传进来）。
     *
     * ## 为什么必须与顶层共用同一个会话（实测矛盾）
     *
     * 这里曾经不接收会话，于是同一次 `omb_status` 里两个读数相反：
     *
     * ```
     * ## 上下文            压力档位：moderate / 窗口占用：0.343   ← 顶层拿到了会话
     * ### 上下文优化（…）  压力档位：relaxed（fillRatio 未知…）     ← 模块没拿到
     * ```
     *
     * 后果不只是难看：本模块的塑形（`pushLimit` / `indexOnly`）按 relaxed 走，
     * **"紧张就少说"在模块层面等于没生效**；而顶层还显示 moderate——读者无法判断
     * 该信哪个，整个状态面（唯一的模型可见诊断入口）一起失去可信度。
     *
     * ## 为什么不能让模块自己去问内核登记处
     *
     * `SERVICES.activeSession.current()` 是"最后一次观测到的会话"，**读历史可以、
     * 当归属不行**（`kernel/abi/catalog.ts:279-281`、`kernel/activeSession.ts:17-18`）；
     * 模块自己挑就会重演 `lastActiveSession` 那类跨会话污染（交错会话时把别人的读数
     * 当成自己的）。所以会话**只认调用方显式传入**——见 `resolveSession` 的契约，
     * 拿不到（`undefined`）就如实按"未测量"处理，不借用任何人的读数。
     *
     * 拉取台账**不跟着会话走**：它按会话分列（`sessionsSnapshot`）并在主行写清口径，
     * 既有的"不挑当前会话、不合并"语义保持不变；会话只用于上面那条会被顶层重复
     * 印出来的压力读数（两处必须是同一个数）。
     */
    const panelInput = (session?: SessionRef): StatusPanelInput => {
      const pressure = pressureOf(session)
      const reading = readingOf(pressure, bands)
      const noSession = resolveSession(session) === null
      return {
        // 模块健康由 omb_status 顶部统一呈现（模块拿不到全局健康面，不假装有）
        pressure,
        behavior: reading.behavior,
        // 本模块**不再挑"当前会话"**：计入"未知会话"桶的读数单列，分会话台账全列出
        pulls: snapshotFor(),
        sessions: sessionsSnapshot(),
        sessionsScope: sessionsScope(),
        degradations,
        // 「说明」按**本次渲染**算，不做累积：没有会话才有那一句。
        // 累积写法会让旧结论一直挂在面板上，与同一段里的实时读数打架
        // （见 `pressureOf` 的说明）——状态面里"两边各说一套"就是这么长出来的。
        notes: noSession ? [...notes, NO_SESSION_NOTE] : notes,
      }
    }

    /**
     * 状态段：**直接复用 `./tools.ts` 的 `createStatusContributor`**。
     *
     * ## 这里曾经自己造一份贡献者（那次重复的代价）
     *
     * helper 的 `read` 旧签名是 `() => StatusPanelInput`，会把状态面传进来的会话吃掉；
     * 而那个会话正是本段与顶层读数一致的唯一来源（吞掉它就退回了上面记的那次矛盾）。
     * 于是本文件只能**再写一份** `render` / `metrics` + 两层隔离的贡献者字面量：
     * 同一段组装逻辑有两份实现，改一处忘一处就是下一次"两个面互相矛盾"；
     * 而 helper 自己既没有生产调用方、又没有测试之外的存在理由——**僵尸接缝**的典型形态
     * （仍导出、仍被原测试覆盖，于是谁也不敢删）。
     *
     * 现在 `read` 的形参是 `(session?: SessionRef)`：会话一路传到 `panelInput`，
     * 本文件不再有第二份贡献者实现。隔离要求照旧（都在 helper 里）：
     * `render` / `metrics` 绝不抛，单个段落失败不得弄坏整份状态面。
     *
     * 注：内核登记处的汇总口径（`handle.status()`）**不传会话**——它没有"这次是谁"
     * 这件事实。那条路径下本段如实呈现"未测量"（`fillRatio 未知`），不借用任何读数；
     * 模型可见的 `omb_status` 走的是 `dsh/status-tool.ts`，那里会话显式传入。
     */
    const statusContributor = createStatusContributor(session => panelInput(session))

    provide(SERVICES.contextPressure, pressureService)
    provide(SERVICES.contextMetrics, metricsService)

    try {
      const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
      if (registry === undefined) {
        degradations.push(`未找到状态面登记处 ${SERVICES.statusContributor}；本模块段落不会出现在 omb_status`)
        kernel.logger.warn(`${MODULE_ID}：${degradations[degradations.length - 1]}`)
      } else {
        disposers.push(registry.register(statusContributor))
      }
    } catch (error) {
      const note = `状态面登记失败：${messageOf(error)}`
      degradations.push(note)
      kernel.logger.warn(`${MODULE_ID}：${note}`)
    }

    report()

    return () => {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose()
        } catch (error) {
          kernel.logger.warn(`${MODULE_ID}：注销时抛异常（已隔离）——${messageOf(error)}`)
        }
      }
      disposers.length = 0
      ledgers.clear()
      sessionTurns.clear()
      sessionPressure.clear()
      // LRU 顺序与淘汰计数一起清掉：卸载后不留任何会话残留（H-2）
      sessionOrder.clear()
      evictedSessions = 0
      lastHealth = { state: 'ok', detail: `模块已卸载；历史拉取计数已清空（杀死判据的观察从零开始）` }
    }
  }

  return { manifest, apply }
}

/** 供状态面组装用的面板输入（`dsh/` 也可直接调用 `buildStatusPanel`）。 */
export { buildStatusPanel }

/** 杀死判据的常量，供文档与测试引用。 */
export const CONTEXT_KILL_CRITERIA = {
  minTurns: MIN_TURNS_FOR_VERDICT,
  views: VIEW_TOOLS,
} as const

/** 目录里登记的模块实例（`dsh/` 直接取用）。 */
export const contextRegistration: ModuleRegistration<ContextConfig> = createContextModule()

export default toHostPlugin(contextRegistration)
