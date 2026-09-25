/**
 * `omb-reasoning` 模块注册入口（思维链质量层，规划 §4）。
 *
 * 三层落地（§4.2）：**可执行规则**（`methods.ts`）·**可观测状态**
 * （深度档位 + 循环计数，`focus.ts` / `loop.ts`）·**按需拉取**（`tools.ts`）。
 *
 * 本文件是唯一有状态的地方，且状态只有两样：
 * ① 每会话的滚动指纹窗口（循环检测用，模型自己看不见）
 * ② 每会话是否已显式设过档位（默认档位只落地一次，不逐轮抖动）
 *
 * 热插拔约束（H-1/H-2）：所有注册在 `apply` 内**同步**完成并返回同一批
 * disposer；`dispose` 绝不抛异常。
 */
import { z } from 'zod'
import type {
  ContextRenderInput,
  FocusDepth,
  Kernel,
  ModuleHealth,
  ModuleManifest,
  ModuleRegistration,
  PromptContribution,
  SessionRef,
  StatusContributor,
  StatusRegistry,
  ToolDefinition,
  ToolFactory,
} from '../../kernel/abi/index.js'
import { RESIDENT_HINT_MAX, SERVICES } from '../../kernel/abi/index.js'
import { QUICK_DIRECTIVE, FOCUS_DEPTH_VALUES, applyFocus, isFocusDepth, projectFocus, readFocus, renderProjection } from './focus.js'
import type { LoopSignal, TurnFingerprint } from './loop.js'
import { DEFAULT_WINDOW_SIZE, appendFingerprint, detectLoop, renderLoopSignal } from './loop.js'
import type { MethodCard } from './methods.js'
import { METHOD_CARDS, cardById, cardsFor, residentHint } from './methods.js'
import { createReasoningTools } from './tools.js'

export const MODULE_ID = 'omb-reasoning'
export const MODULE_VERSION = '3.0.0'

/** 配置：`cordis.patch.yml` 的 `config` 段。 */
export interface ReasoningConfig {
  /** 会话未显式设档时的默认档位。 */
  readonly defaultDepth: FocusDepth
  /** 常驻提示的字符预算；受内核 `RESIDENT_HINT_MAX` 硬上限约束。 */
  readonly residentHintChars: number
}

export const DEFAULT_REASONING_CONFIG: ReasoningConfig = {
  defaultDepth: 'standard',
  residentHintChars: RESIDENT_HINT_MAX,
}

/**
 * 配置 schema（zod）。**缺省值完整**：`parse(undefined)` 也得到完整配置，
 * 因为内核会把缺失的 config 原样传进来（`configs?.get(id)`）。
 * 非法取值**抛异常**由内核标 `failed` 并写明原因——这是诚实降级，不是吞掉。
 */
export const reasoningConfigSchema = z
  .object({
    defaultDepth: z.enum(FOCUS_DEPTH_VALUES).default(DEFAULT_REASONING_CONFIG.defaultDepth),
    residentHintChars: z.number().int().positive().default(DEFAULT_REASONING_CONFIG.residentHintChars),
  })
  .default(DEFAULT_REASONING_CONFIG)

/** `ToolFactory` 的输入：`dsh/` 在正确的作用域里传入当前会话。 */
export interface ReasoningToolInput {
  readonly currentSession: SessionRef
}

export type ReasoningToolFactory = ToolFactory<ReasoningToolInput>

/** `reasoning:loop` 服务面。 */
export interface ReasoningLoopService {
  /** 当前循环信号；无信号返回 null（不是"没有信号"的文本）。 */
  signal(session: SessionRef): LoopSignal | null
  /** 滚动指纹窗口（最近 `DEFAULT_WINDOW_SIZE` 条），供状态面与审计。 */
  window(session: SessionRef): readonly TurnFingerprint[]
  /** 清掉某会话的窗口（模型确认换向后可复位）。 */
  reset(session: SessionRef): void
}

/** `reasoning:methods` 服务面：只读投影，供 `dsh/` 与状态面取用。 */
export interface ReasoningMethodsService {
  cardsFor(depth: FocusDepth): readonly MethodCard[]
  cardById(id: string): MethodCard | undefined
  /** 常驻提示（逐字节稳定）。 */
  resident(): string
}

interface SessionState {
  window: readonly TurnFingerprint[]
  explicitDepth: FocusDepth | undefined
  lastReason: string
  lastSignal: LoopSignal | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function newSessionState(): SessionState {
  return { window: [], explicitDepth: undefined, lastReason: '', lastSignal: null }
}

/**
 * 建立模块实例。**每个实例自带状态**——测试可以建两个互不干扰的实例，
 * 热重载时也不会把上一轮的窗口带过来。
 */
export function createReasoningModule(): ModuleRegistration<ReasoningConfig> {
  let lastHealth: ModuleHealth = {
    state: 'ok',
    detail: `未启动；规则卡 ${METHOD_CARDS.length} 张为静态数据，常驻提示上限 ${RESIDENT_HINT_MAX} 字符`,
  }

  const manifest: ModuleManifest<ReasoningConfig> = {
    id: MODULE_ID,
    version: MODULE_VERSION,
    requires: ['omb-kernel'],
    capabilities: ['reasoning.methods', 'reasoning.depth', 'reasoning.loop-detect'],
    configSchema: reasoningConfigSchema,
    health: () => lastHealth,
  }

  function apply(kernel: Kernel, config: ReasoningConfig): () => void {
    const sessions = new Map<SessionRef, SessionState>()
    const disposers: (() => void)[] = []
    const degradations: string[] = []
    /**
     * 最近活跃的会话。
     *
     * 工具调用发生在某个回合内，而回合边界事件带 `sessionId`——因此
     * "最近活跃会话"就是当前会话。这是给 `dsh/` 传空 `currentSession` 时的回落
     * （见 `toolFactory`），宿主若改为按会话建工厂，这个回落自然不再触发。
     */
    let lastActiveSession: SessionRef | null = null

    // ── 常驻提示：apply 内算一次，之后逐字节不变（静态前缀靠它保缓存） ──
    const hintBudget = clampHintBudget(config.residentHintChars, kernel, degradations)
    const hint = residentHint(hintBudget)

    const ensure = (session: SessionRef): SessionState => {
      let state = sessions.get(session)
      if (state === undefined) {
        state = newSessionState()
        sessions.set(session, state)
      }
      return state
    }

    const healthNow = (): ModuleHealth => {
      let withSignal = 0
      for (const state of sessions.values()) if (state.lastSignal !== null) withSignal += 1
      const parts = [
        `规则卡 ${METHOD_CARDS.length} 张`,
        `常驻提示 ${hint.length}/${RESIDENT_HINT_MAX} 字符`,
        `跟踪会话 ${sessions.size}`,
        withSignal > 0 ? `循环信号 ${withSignal} 个` : '无循环信号',
      ]
      if (degradations.length > 0) parts.push(`降级：${degradations.join('；')}`)
      return {
        state: degradations.length > 0 ? 'degraded' : 'ok',
        detail: parts.join('；'),
        metrics: {
          cards: METHOD_CARDS.length,
          residentHintChars: hint.length,
          trackedSessions: sessions.size,
          activeLoopSignals: withSignal,
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

    /** 服务注册：重名等失败**不抛**，记入降级原因并在健康面写明。 */
    const provide = (name: string, value: unknown): void => {
      try {
        disposers.push(kernel.provide(name, value))
      } catch (error) {
        const note = `服务 ${name} 注册失败：${messageOf(error)}`
        degradations.push(note)
        kernel.logger.warn(`${MODULE_ID}：${note}`)
      }
    }

    // ── 事件：滚动指纹窗口（本组件唯一需要"计算"的部分） ──
    disposers.push(
      kernel.on('evidence/observed', payload => {
        const state = ensure(payload.sessionId)
        lastActiveSession = payload.sessionId
        state.window = appendFingerprint(
          state.window,
          { actionHash: payload.actionHash, evidenceHash: payload.evidenceHash, at: payload.at },
          DEFAULT_WINDOW_SIZE,
        )
        state.lastSignal = detectLoop(state.window)
        report()
      }),
    )

    disposers.push(
      kernel.on('focus/changed', payload => {
        const state = ensure(payload.sessionId)
        lastActiveSession = payload.sessionId
        state.explicitDepth = payload.depth
        state.lastReason = payload.reason
        report()
      }),
    )

    disposers.push(
      kernel.on('turn/start', payload => {
        const state = ensure(payload.sessionId)
        lastActiveSession = payload.sessionId
        state.lastSignal = detectLoop(state.window)
        // 配置的默认档位只在"本会话尚未显式设置"时落地一次：幂等，不逐轮抖动
        if (state.explicitDepth === undefined && config.defaultDepth !== 'standard') {
          try {
            if (kernel.focus(payload.sessionId) !== config.defaultDepth) {
              kernel.setFocus(payload.sessionId, config.defaultDepth, '模块默认档位')
            }
          } catch (error) {
            kernel.logger.warn(`${MODULE_ID}：默认档位落地失败——${messageOf(error)}`)
          }
        }
        report()
      }),
    )

    // ── 服务面 ──
    const loopService: ReasoningLoopService = {
      signal: session => sessions.get(session)?.lastSignal ?? null,
      window: session => sessions.get(session)?.window ?? [],
      reset: session => {
        sessions.delete(session)
      },
    }

    const methodsService: ReasoningMethodsService = {
      cardsFor: depth => cardsFor(isFocusDepth(depth) ? depth : 'standard'),
      cardById,
      resident: () => hint,
    }

    const toolFactory: ReasoningToolFactory = {
      create: (input: ReasoningToolInput): readonly ToolDefinition[] => {
        try {
          const fixed = typeof input?.currentSession === 'string' ? input.currentSession.trim() : ''
          return createReasoningTools({
            // 空会话时回落到"最近活跃会话"：工具调用必然发生在某个回合内，
            // 而回合边界事件带 sessionId，因此这个回落指向的就是当前会话。
            currentSession: fixed !== '' ? fixed : () => lastActiveSession ?? '',
            readDepth: target => readFocus(kernel, target).depth,
            applyDepth: (target, depth, reason) => applyFocus(kernel, target, depth, reason),
            loopSignal: target => loopService.signal(target),
          })
        } catch (error) {
          kernel.logger.warn(`${MODULE_ID}：工具工厂创建失败——${messageOf(error)}`)
          return []
        }
      },
    }

    /**
     * `PromptContribution`：`resident` 是冻结的常驻提示；`context` 是每轮易变部分。
     *
     * 易变部分遵守软压力塑形（§6.3）：紧张档只留索引（规则卡转 `omb_method` 拉取），
     * 宽松/适中档在 `deep` 时给规则卡全文——那是模型**显式动作**提出的需求，不是推送。
     */
    const contribution: PromptContribution = {
      resident: hint,
      context: (input: ContextRenderInput): string => {
        try {
          const depth = isFocusDepth(input.depth) ? input.depth : readFocus(kernel, input.sessionId).depth
          const signal = sessions.get(input.sessionId)?.lastSignal ?? null
          const parts: string[] = []
          if (depth === 'quick') {
            parts.push(QUICK_DIRECTIVE)
          } else if (depth === 'deep') {
            parts.push(
              input.band === 'tight'
                ? '深度 deep：上下文紧张，规则卡全文改用 omb_method 拉取。'
                : renderProjection(projectFocus('deep')),
            )
          }
          const loopLine = renderLoopSignal(signal)
          if (loopLine !== '') parts.push(loopLine)
          return parts.join('\n')
        } catch (error) {
          // 提示渲染失败不得影响宿主回合：宁可不注入，也不抛
          kernel.logger.warn(`${MODULE_ID}：上下文渲染失败（已跳过注入）——${messageOf(error)}`)
          return ''
        }
      },
    }

    const statusContributor: StatusContributor = {
      name: '思维链质量（omb-reasoning）',
      render: (): string => {
        try {
          const lines = [healthNow().detail]
          for (const [session, state] of sessions) {
            if (state.lastSignal === null) continue
            lines.push(`会话 ${session}：${state.lastSignal.kind}——${state.lastSignal.detail}`)
          }
          if (hint !== '') lines.push(`常驻提示：${hint}`)
          return lines.join('\n')
        } catch (error) {
          return `渲染失败：${messageOf(error)}`
        }
      },
      metrics: (): Readonly<Record<string, number>> => {
        try {
          return healthNow().metrics ?? {}
        } catch {
          return { renderError: 1 }
        }
      },
    }

    provide(SERVICES.promptReasoning, contribution)
    provide(SERVICES.reasoningTools, toolFactory)
    provide(SERVICES.reasoningLoop, loopService)
    provide(SERVICES.reasoningMethods, methodsService)

    // 状态面：登记处由微内核提供（服务名是单值的，N 个贡献者靠 register 聚合）。
    // `registry?` 可选——按 H-3 不假设宿主/内核一定在场；缺失时记入降级原因。
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
      sessions.clear()
      lastHealth = { state: 'ok', detail: `模块已卸载；规则卡 ${METHOD_CARDS.length} 张仍为静态数据` }
    }
  }

  return { manifest, apply }
}

/** 常驻提示预算：受内核上限约束；任何调整都记入降级原因（不静默改配置）。 */
function clampHintBudget(requested: unknown, kernel: Kernel, degradations: string[]): number {
  const raw = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : RESIDENT_HINT_MAX
  const clamped = Math.min(Math.max(raw, 20), RESIDENT_HINT_MAX)
  if (clamped !== raw) {
    const note = `residentHintChars=${raw} 已收敛到 ${clamped}（允许区间 20…${RESIDENT_HINT_MAX}）`
    degradations.push(note)
    kernel.logger.warn(`${MODULE_ID}：${note}`)
  }
  return clamped
}

/** 目录里登记的模块实例（`dsh/` 直接取用）。 */
export const reasoningRegistration: ModuleRegistration<ReasoningConfig> = createReasoningModule()

export default reasoningRegistration
