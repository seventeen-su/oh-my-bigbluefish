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
  StatusContributor,
  StatusRegistry,
  ToolDefinition,
} from '../../kernel/abi/index.js'
import { SERVICES, toolsServiceFor } from '../../kernel/abi/index.js'
import type { AdmissionOptions, Candidate } from './admission.js'
import { DEFAULT_CANDIDATE_CONSIDER_LIMIT, marginalValue, measuredCost, selectForInjection } from './admission.js'
import type { BandBehavior, PressureBands, PressureReading } from './pressure.js'
import { bandOf, bandsFromPair, behaviorFor, readingOf } from './pressure.js'
import type { PullLedger, PullSnapshot, ViewPullStats, WatchOptions } from './watch.js'
import {
  EMPTY_LEDGER,
  MIN_TURNS_FOR_VERDICT,
  UNKNOWN_SESSION_KEY,
  VIEW_TOOLS,
  cacheHitRate,
  healthDetail,
  noteTurn,
  recordPull,
  sessionKeyOf,
  sessionOfKey,
  summarize,
} from './watch.js'
import { buildStatusPanel, createStatusContributor } from './tools.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export const MODULE_ID = 'omb-context'
export const MODULE_VERSION = '3.0.0'

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
    requires: ['omb-kernel'],
    capabilities: ['context.pressure', 'context.admission', 'context.metrics'],
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
    let lastActiveSession: SessionRef | null = null

    const ledgerFor = (key: SessionRef): PullLedger => ledgers.get(key) ?? EMPTY_LEDGER

    /**
     * 读内核的活跃会话登记处（`SERVICES.activeSession`）。
     *
     * 会话是内核级事实（`dsh/` 观测到就写进去），**优先于本模块自己订阅到的事件**：
     * 模块收不到 `turn/start` 时这里仍然是对的（见 `kernel/activeSession.ts`）。
     * 端口坏掉时返回 null（服务方法不因宿主端口坏掉而抛给调用方）。
     */
    const kernelSession = (): SessionRef | null => {
      try {
        const current = kernel.service<{ current(): SessionRef | null }>(SERVICES.activeSession)?.current()
        return typeof current === 'string' && current.trim() !== '' ? current : null
      } catch {
        return null
      }
    }

    /**
     * 会话解析（口径只认**这一个**会话）：
     * ① 显式传入 ② 内核活跃会话登记处 ③ 本模块订阅到的最近回合 ④ 都没有 → null。
     *
     * ④ 落到 null 不等于"用全局数顶替"：调用方会把它记进"未知会话"桶，
     * 状态面照实说明，不并入任何具体会话。
     */
    const resolveSession = (session?: SessionRef): SessionRef | null => {
      if (typeof session === 'string' && session.trim() !== '') return session
      return kernelSession() ?? lastActiveSession
    }

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
        const note = '无活跃会话：压力读数缺失，按宽松档处理'
        if (!notes.includes(note)) notes.push(note)
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
     * **某一个会话**的台账快照。会话口径由 `resolveSession` 定，
     * 拿不到就落到"未知会话"桶（`session` 为 null，状态面照实说明）。
     */
    const snapshotFor = (session?: SessionRef, options?: WatchOptions): PullSnapshot => {
      const key = sessionKeyOf(resolveSession(session))
      return summarize(ledgerFor(key), options ?? { views: VIEW_TOOLS }, sessionOfKey(key))
    }

    const healthNow = (): ModuleHealth => {
      const pressure = pressureOf()
      const snapshot = snapshotFor()
      const band = pressure.band ?? bandOf(pressure.fillRatio, bands)
      const parts = [
        `软档位 ${band}`,
        pressure.fillRatio === null
          ? 'fillRatio 未知（宿主未声明窗口）→ 按宽松档，不施压'
          : `fillRatio ${pressure.fillRatio.toFixed(3)}`,
        `行为 ${behaviorFor(band).mode}（最多推 ${behaviorFor(band).pushLimit} 条）`,
        // 杀死判据必须出现在 detail 里（轮数未知/不足时如实说明"暂不下结论"）。
        // 文案自带口径（"本会话"/"未知会话"），不留"这个数是谁的"的疑问。
        healthDetail(snapshot),
      ]
      if (degradations.length > 0) parts.push(`降级：${degradations.join('；')}`)
      return {
        state: degradations.length > 0 ? 'degraded' : 'ok',
        detail: parts.join('；'),
        metrics: {
          turns: snapshot.turns,
          // 0/1：`turns` 为 0 时它区分"本会话真的一轮都没有"与"轮数未知（分母未知）"
          turnsKnown: snapshot.turnsKnown ? 1 : 0,
          totalPulls: snapshot.totalPulls,
          pullsPerTurn: snapshot.pullsPerTurn,
          deadViews: snapshot.deadViews.length,
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
        // 空会话标识不清掉已知会话（与内核 ActiveSessionTable 同一条纪律）
        if (key !== UNKNOWN_SESSION_KEY) lastActiveSession = key
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

    const statusContributor: StatusContributor = createStatusContributor(() => {
      const pressure = pressureOf()
      const reading = readingOf(pressure, bands)
      return {
        // 模块健康由 omb_status 顶部统一呈现（模块拿不到全局健康面，不假装有）
        pressure,
        behavior: reading.behavior,
        // 只报**本会话**的账（拿不到会话就是"未知会话"桶，状态面照实说明）
        pulls: snapshotFor(),
        degradations,
        notes,
      }
    })

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
      lastActiveSession = null
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
