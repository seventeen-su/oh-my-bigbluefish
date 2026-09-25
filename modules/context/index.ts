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
import type { PullSnapshot, ViewPullStats, WatchOptions } from './watch.js'
import {
  EMPTY_LEDGER,
  MIN_TURNS_FOR_VERDICT,
  VIEW_TOOLS,
  cacheHitRate,
  healthDetail,
  noteTurn,
  recordPull,
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
  /** 记一次拉取。`dsh/` 包住五个视图工具时调用。**绝不抛**。 */
  recordPull(view: string, session?: SessionRef): void
  /** 台账快照（含杀死判据）。 */
  snapshot(options?: WatchOptions): PullSnapshot
  /** 长期趋近 0、按杀死判据应删除的视图。 */
  killList(options?: WatchOptions): readonly string[]
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
  /** 每个视图的计数与轮次。 */
  views(): readonly ViewPullStats[]
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
 * 建立模块实例。**每个实例自带状态**（拉取台账与回合计数）。
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

    // ── 台账与回合计数（全局口径：跨会话的"观察到的回合数"是 pullsPerTurn 的分母） ──
    let ledger = EMPTY_LEDGER
    const sessionTurns = new Map<SessionRef, number>()
    const sessionPressure = new Map<SessionRef, SessionPressure>()
    let lastActiveSession: SessionRef | null = null
    let turnsSeen = 0

    const activeSession = (session?: SessionRef): SessionRef | null =>
      typeof session === 'string' && session.trim() !== '' ? session : lastActiveSession

    /** 读时钟：端口异常时返回 0（服务方法不因宿主端口坏掉而抛给调用方）。 */
    const now = (): number => {
      try {
        return kernel.clock.now()
      } catch {
        return 0
      }
    }

    const pressureOf = (session?: SessionRef): ContextPressure => {
      const target = activeSession(session)
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
      const target = activeSession(session)
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

    const healthNow = (): ModuleHealth => {
      const pressure = pressureOf(lastActiveSession ?? undefined)
      const snapshot = summarize(ledger, { views: VIEW_TOOLS })
      const band = pressure.band ?? bandOf(pressure.fillRatio, bands)
      const parts = [
        `软档位 ${band}`,
        pressure.fillRatio === null
          ? 'fillRatio 未知（宿主未声明窗口）→ 按宽松档，不施压'
          : `fillRatio ${pressure.fillRatio.toFixed(3)}`,
        `行为 ${behaviorFor(band).mode}（最多推 ${behaviorFor(band).pushLimit} 条）`,
        // 杀死判据必须出现在 detail 里（轮数不足时如实说明"暂不下结论"）
        healthDetail(snapshot),
      ]
      if (degradations.length > 0) parts.push(`降级：${degradations.join('；')}`)
      return {
        state: degradations.length > 0 ? 'degraded' : 'ok',
        detail: parts.join('；'),
        metrics: {
          turns: snapshot.turns,
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
      lastHealth = healthNow()
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
        lastActiveSession = payload.sessionId
        turnsSeen += 1
        ledger = noteTurn(ledger, turnsSeen)
        sessionTurns.set(payload.sessionId, Number.isFinite(payload.turn) ? payload.turn : turnsSeen)
        report()
      }),
    )

    disposers.push(
      kernel.on('focus/changed', payload => {
        sessionPressure.set(payload.sessionId, {
          band: sessionPressure.get(payload.sessionId)?.band ?? 'relaxed',
          depth: payload.depth,
          reason: payload.reason,
        })
        report()
      }),
    )

    disposers.push(
      kernel.on('pressure/band-changed', payload => {
        const reading = readingOf(payload.pressure, bands)
        sessionPressure.set(payload.sessionId, {
          band: reading.band,
          depth: focusState(payload.sessionId).depth,
          reason: sessionPressure.get(payload.sessionId)?.reason ?? '',
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
          const target = activeSession(session)
          const turn = target === null ? turnsSeen : sessionTurns.get(target) ?? turnsSeen
          ledger = recordPull(ledger, view, turn)
          report()
        } catch (error) {
          kernel.logger.warn(`${MODULE_ID}：记录拉取失败——${messageOf(error)}`)
        }
      },
      snapshot: options => summarize(ledger, options ?? { views: VIEW_TOOLS }),
      killList: options => summarize(ledger, options ?? { views: VIEW_TOOLS }).deadViews,
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
      views: () => summarize(ledger, { views: VIEW_TOOLS }).views,
    }

    const tools: readonly ToolDefinition[] = []
    // 保留位：上下文模块当前没有模型可见工具（`omb_status` 由 dsh/ 注册，属 omb-kernel）
    provide(toolsServiceFor(MODULE_ID), tools)

    const statusContributor: StatusContributor = createStatusContributor(() => {
      const pressure = pressureOf(lastActiveSession ?? undefined)
      const reading = readingOf(pressure, bands)
      return {
        // 模块健康由 omb_status 顶部统一呈现（模块拿不到全局健康面，不假装有）
        pressure,
        behavior: reading.behavior,
        pulls: summarize(ledger, { views: VIEW_TOOLS }),
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
      sessionTurns.clear()
      sessionPressure.clear()
      ledger = EMPTY_LEDGER
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
