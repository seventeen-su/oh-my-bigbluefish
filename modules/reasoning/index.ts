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
} from '../../kernel/abi/index.js'
import { RESIDENT_HINT_MAX, SERVICES, toolsServiceFor } from '../../kernel/abi/index.js'
import { QUICK_DIRECTIVE, FOCUS_DEPTH_VALUES, applyFocus, isFocusDepth, peekFocus, projectFocus, readFocus, renderProjection } from './focus.js'
import type { LoopSignal, TurnFingerprint } from './loop.js'
import { DEFAULT_WINDOW_SIZE, detectLoop, noteObservation, renderLoopSignal } from './loop.js'
import type { MethodCard, RuleId } from './methods.js'
import { CARDS_BY_DEPTH, METHOD_CARDS, cardById, cardsFor, residentHint } from './methods.js'
import { createReasoningTools } from './tools.js'
import { heartbeat, toHostPlugin } from '../../kernel/hostEntry.js'

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

/** `tools:omb-reasoning` 的交付形状：`dsh/plugin.ts` 只消费数组（见 catalog 的 `toolsPrefix`）。 */
export type ReasoningTools = readonly ToolDefinition[]

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
 * 上一次 `context` 渲染的留痕。
 *
 * **为什么必须有**：注入失败原本只留下一句 `logger.warn`，工具回执照样说
 * "会带上规则卡全文"——模型侧看不到任何异常，"说了要注入却没注入"只能是静默事实。
 * 留下这条痕迹后，`omb_status` 能回答"上次渲染到底产出了什么"：
 * 请求了哪几张卡、真进了上下文几张、多少字符。
 */
interface RenderTrace {
  readonly session: SessionRef
  readonly depth: FocusDepth
  readonly band: ContextRenderInput['band']
  /** 该档位**声明需要**的卡（请求，不保证注入）。 */
  readonly requested: readonly RuleId[]
  /** 真的出现在渲染结果里的卡（按正文逐张比对得出，不是照抄请求）。 */
  readonly delivered: readonly RuleId[]
  /** 产出的 context 字符数；0 = 本轮确实什么都没注入。 */
  readonly chars: number
  /** 渲染入参档位与内核读数的分歧（'' = 一致或无从比较）。 */
  readonly depthDivergence: string
}

function idList(ids: readonly RuleId[]): string {
  return ids.length === 0 ? '无卡' : ids.join('/')
}

/**
 * 渲染用档位：三个来源谁说了算。**纯函数**。
 *
 * - **模型显式设过档**（本模块亲眼收到过该会话的 `focus/changed`）→ 内核读数是权威。
 *   只有这一种情况值得压过入参：模型刚要求了 deep，宿主递来的旧快照不得把它压回
 *   standard——那正是"设了 deep 却没落地"最可能的真实形态。内核读不回时用记下的显式值。
 * - **没设过** → 入参为准。它是宿主对同一份内核状态的读数（真实接线里就是
 *   `kernel.focus(sessionId)`），本来就是宿主的契约；入参非法或缺失才回落内核读数，
 *   最后才用 standard。
 */
function resolveRenderDepth(sources: {
  readonly explicit: FocusDepth | undefined
  readonly reported: FocusDepth | null
  readonly kernelDepth: FocusDepth | null
}): FocusDepth {
  const { explicit, reported, kernelDepth } = sources
  if (explicit !== undefined) return kernelDepth ?? explicit
  return reported ?? kernelDepth ?? 'standard'
}

/**
 * 状态面里的一行：上次注入**实际**发生了什么——可核验的事实，不是承诺。
 *
 * 三种非失败情形分开写，因为它们回答的问题不同：
 * - `空`：本轮确实没内容可注入（不是失败）
 * - `只给了指令未含卡片`：请求了卡却没进上下文（紧张档转拉取，或渲染把卡丢了）
 * - `成功`：真有几张卡进了上下文
 */
function describeLastRender(trace: RenderTrace | null, failures: number, lastFailure: string): string {
  const bits: string[] = []
  if (trace === null) {
    bits.push(failures > 0 ? `上次注入：失败（${lastFailure}）` : '上次注入：尚无（还没有渲染过）')
  } else if (trace.chars === 0) {
    bits.push(
      `上次注入：空（深度 ${trace.depth}，压力 ${trace.band}；请求 ${idList(trace.requested)}，未注入；会话 ${trace.session}）`,
    )
  } else if (trace.delivered.length === 0) {
    bits.push(
      `上次注入：只给了指令未含卡片（${trace.chars} 字符；深度 ${trace.depth}，压力 ${trace.band}；请求 ${idList(trace.requested)}；会话 ${trace.session}）`,
    )
  } else {
    bits.push(
      `上次注入：成功（${idList(trace.delivered)}，${trace.chars} 字符；深度 ${trace.depth}，压力 ${trace.band}；会话 ${trace.session}）`,
    )
  }
  // 失败历史不隐藏：失败过一次、后来又成功，两件事都要在状态面里看得到
  if (failures > 1 || (failures > 0 && trace !== null)) {
    bits.push(`渲染失败累计 ${failures} 次（最近：${lastFailure}）`)
  }
  if (trace !== null && trace.depthDivergence !== '') bits.push(`档位分歧：${trace.depthDivergence}`)
  return bits.join('；')
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
     * "最近活跃会话"就是当前会话。这是 `tools:omb-reasoning` 里
     * `omb_focus` 唯一的会话归属来源（dsh 无法按会话建工具，见工具面注释）。
     */
    let lastActiveSession: SessionRef | null = null

    /** 渲染留痕与失败计数：状态面据此把"说了要注入"变成可核验的事实。 */
    let lastRender: RenderTrace | null = null
    let renderFailures = 0
    let lastRenderFailure = ''

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
      // 渲染失败必须留声：它是"回执说了要注入、实际没注入"的唯一证据
      if (renderFailures > 0) parts.push(`上下文渲染失败 ${renderFailures} 次（最近：${lastRenderFailure}）`)
      if (degradations.length > 0) parts.push(`降级：${degradations.join('；')}`)
      return {
        state: degradations.length > 0 || renderFailures > 0 ? 'degraded' : 'ok',
        detail: parts.join('；'),
        metrics: {
          cards: METHOD_CARDS.length,
          residentHintChars: hint.length,
          trackedSessions: sessions.size,
          activeLoopSignals: withSignal,
          renderFailures,
          lastRenderChars: lastRender?.chars ?? 0,
          lastRenderCards: lastRender?.delivered.length ?? 0,
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
    // 一次工具调用会来两条事件（call + result），因此用 noteObservation 归并成"一步"
    disposers.push(
      kernel.on('evidence/observed', payload => {
        const state = ensure(payload.sessionId)
        lastActiveSession = payload.sessionId
        state.window = noteObservation(
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
        // 诊断：确认订阅端真的收到 `turn/start`。
        // `omb_focus` 报"取不到会话"时只剩两种可能：①发送端没发（看 `step-start`
        // 心跳）②订阅端没收到。两条心跳一对，分叉点就唯一了。
        heartbeat('reasoning-turn', { sessionId: payload.sessionId })
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

    /**
     * 工具面。交付约定是 `tools:<模块 id>` → `readonly ToolDefinition[]`
     * （`dsh/plugin.ts` 的前缀遍历只消费数组）。
     *
     * **会话解析用"最近活跃会话"是正确语义，不是 hack**（Lead 已确认）：
     * 工具调用必然发生在某个回合内，而 `turn/start` / `evidence/observed` /
     * `focus/changed` 都带 `sessionId`，因此最近活跃的那个就是当前会话。
     * dsh 侧无法按会话建工具（那会让注册变成动态的，违反 H-2 的"apply 返回后不得注册"），
     * 所以这里有且只有这一个正确的归属来源。
     */
    let tools: ReasoningTools = []
    try {
      tools = createReasoningTools({
        // 本模块记的"最近活跃会话"是**快路径**，但它有个致命前提：
        // 模块必须真的收到 `turn/start`。而收养视图的 `on` 优先绑**宿主**事件面，
        // `dsh/` 却发在内核总线——收不到也不报错。所以必须有内核兜底。
        currentSession: () =>
          lastActiveSession
          ?? kernel.service<{ current(): SessionRef | null }>(SERVICES.activeSession)?.current()
          ?? '',
        readDepth: target => readFocus(kernel, target).depth,
        applyDepth: (target, depth, reason) => applyFocus(kernel, target, depth, reason),
        loopSignal: target => loopService.signal(target),
      })
    } catch (error) {
      const note = `工具构造失败：${messageOf(error)}`
      degradations.push(note)
      kernel.logger.warn(`${MODULE_ID}：${note}`)
    }

    /**
     * `PromptContribution`：`resident` 是冻结的常驻提示；`context` 是每轮易变部分。
     *
     * 易变部分遵守软压力塑形（§6.3）：紧张档只留索引（规则卡转 `omb_method` 拉取），
     * 宽松/适中档在 `deep` 时给规则卡全文——那是模型**显式动作**提出的需求，不是推送。
     *
     * 档位来源的裁决见 `resolveRenderDepth`：模型显式设过档时内核读数是权威，
     * 否则以宿主入参为准。两者分歧**必定留痕**——否则"模型设了 deep、渲染却按
     * standard 走"又会是静默事实。
     */
    const contribution: PromptContribution = {
      resident: hint,
      context: (input: ContextRenderInput): string => {
        try {
          const state = sessions.get(input.sessionId)
          const reported = isFocusDepth(input.depth) ? input.depth : null
          const kernelDepth = peekFocus(kernel, input.sessionId)
          const depth = resolveRenderDepth({ explicit: state?.explicitDepth, reported, kernelDepth })
          const depthDivergence =
            reported !== null && kernelDepth !== null && reported !== kernelDepth
              ? `渲染入参 ${reported} / 内核 ${kernelDepth}（已按 ${depth} 渲染）`
              : ''
          if (depthDivergence !== '') kernel.logger.warn(`${MODULE_ID}：${depthDivergence}`)

          const parts: string[] = []
          // 本档位声明需要的卡；真进了上下文几张，由下面的正文比对给出
          const requested = CARDS_BY_DEPTH[depth] ?? []
          const candidates = depth === 'deep' && input.band !== 'tight' ? cardsFor('deep') : []
          if (depth === 'quick') {
            parts.push(QUICK_DIRECTIVE)
          } else if (depth === 'deep') {
            parts.push(
              input.band === 'tight'
                ? '深度 deep：上下文紧张，规则卡全文改用 omb_method 拉取。'
                : renderProjection(projectFocus('deep')),
            )
          }
          const signal = state?.lastSignal ?? null
          const loopLine = renderLoopSignal(signal)
          if (loopLine !== '') parts.push(loopLine)
          const text = parts.join('\n')

          // 可核验留痕：按正文逐张确认卡真的进了上下文，而不是"我们打算注入"
          lastRender = {
            session: input.sessionId,
            depth,
            band: input.band,
            requested,
            delivered: candidates.filter(card => text.includes(card.text)).map(card => card.id),
            chars: text.length,
            depthDivergence,
          }
          // 上报一次：否则内核健康面停留在上一次事件的快照，与 omb_status 里的
          // 实时留痕各说一套——同一模块的两个面不允许互相矛盾
          report()
          return text
        } catch (error) {
          // 提示渲染失败不得影响宿主回合：宁可不注入，也不抛。
          // 但**失败必须留声**——计数与原因进健康面与状态面，不再是静默降级。
          renderFailures += 1
          lastRenderFailure = messageOf(error)
          lastRender = null
          kernel.logger.warn(
            `${MODULE_ID}：上下文渲染失败 ${renderFailures} 次（已跳过注入，失败记入状态面）——${lastRenderFailure}`,
          )
          report()
          return ''
        }
      },
    }

    const statusContributor: StatusContributor = {
      name: '思维链质量（omb-reasoning）',
      render: (): string => {
        try {
          // 第二行是"注入到底发生了没有"的可核验痕迹：回执说会注入的卡，
          // 在这里必须能看到真进了几张；失败连原因一起留下。
          const lines = [healthNow().detail, describeLastRender(lastRender, renderFailures, lastRenderFailure)]
          for (const [session, state] of sessions) {
            // 只写"有事发生"的会话：显式设过档位（含理由，供事后判断旋钮是否有用）
            // 或检出过循环信号。安静的会话不占行。
            const signal = state.lastSignal
            if (signal === null && state.explicitDepth === undefined) continue
            const bits: string[] = []
            if (state.explicitDepth !== undefined) {
              bits.push(`深度 ${state.explicitDepth}${state.lastReason === '' ? '' : `（理由：${state.lastReason}）`}`)
            }
            if (signal !== null) bits.push(`${signal.kind}——${signal.detail}`)
            lines.push(`会话 ${session}：${bits.join('；')}`)
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
    provide(toolsServiceFor(MODULE_ID), tools)
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

export default toHostPlugin(reasoningRegistration)
