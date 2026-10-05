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
import { RESIDENT_HINT_MAX, SERVICES, derivedCapabilities, derivedRequires, toolsServiceFor } from '../../kernel/abi/index.js'
import type { DepthControl, FailureClass } from './control.js'
import {
  AUTO_INJECT_CARD_CAP,
  FAILURE_CLASSES,
  classifyFailure,
  controlOf,
  failureSignalsFromLoop,
  isFailureClass,
  recoveryFor,
  renderRecovery,
} from './control.js'
import {
  FOCUS_DEPTH_VALUES,
  applyFocus,
  isFocusDepth,
  peekFocus,
  projectFocus,
  readFocus,
  renderProjection,
} from './focus.js'
import type { LoopSignal, TurnFingerprint } from './loop.js'
import { DEFAULT_WINDOW_SIZE, detectLoop, noteObservation, renderLoopSignal } from './loop.js'
import type { MethodCard, RuleId } from './methods.js'
import { CARDS_BY_DEPTH, METHOD_CARDS, cardById, cardsFor, renderIndex, residentHint } from './methods.js'
import type { VerifyInput, VerifyOutcome } from './tools.js'
import { createReasoningTools } from './tools.js'
import type { VerifyTracker } from './verify.js'
import {
  VERDICT_TEXT,
  createVerifyTracker,
  describeVerify,
  judgeClaim,
  summarizeTracker,
  trackVerify,
  verifyLine,
} from './verify.js'
import { heartbeat, toHostPlugin } from '../../kernel/hostEntry.js'

export const MODULE_ID = 'omb-reasoning'
export const MODULE_VERSION = '3.4.0'

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
  /**
   * Verify 读数：**滚动台账 + 单调累计 + 每条结论的最新判定**（见 `verify.ts` 的
   * `VerifyTracker`）。累计与未闭合不随台账的 32 条上限消失——那是 G3 的修法核心。
   */
  verify: VerifyTracker
  /** 当前回合号（`turn/start` 推进）；状态面据它回答"本回合验证了几次"。 */
  turn: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function newSessionState(): SessionState {
  return {
    window: [],
    explicitDepth: undefined,
    lastReason: '',
    lastSignal: null,
    verify: createVerifyTracker(),
    turn: 0,
  }
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
  /** 该档位**声明需要**的卡（请求，不保证注入；注入受 1 张上限约束）。 */
  readonly requested: readonly RuleId[]
  /** 真的出现在渲染结果里的卡（按正文逐张比对得出，不是照抄请求）。 */
  readonly delivered: readonly RuleId[]
  /** 产出的 context 字符数；0 = 本轮确实什么都没注入。 */
  readonly chars: number
  /**
   * 真的进了上下文的东西（`指令`/`读数`/`索引`/`卡片`/`验证段`/`循环提示` 的组合）。
   *
   * 为什么留这个痕：状态面原来把"没含卡片正文"一律说成"只给了指令"，
   * 而紧张档改后进的是**读数+索引**、`standard` 有未闭合结论时进的是**验证段**——
   * 标签与内容对不上，正是本模块要消灭的那类"读数说谎"。
   */
  readonly form: string
  /** 控制读数（参数行）占的字符数——档位差异的文本成本，恒定一行。 */
  readonly controlChars: number
  /** 验证段占的字符数（有未闭合项才出现）。 */
  readonly verifyChars: number
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
      `上次注入：只给了${trace.form === '' ? '指令' : trace.form}、未含卡片正文`
      + `（${trace.chars} 字符；深度 ${trace.depth}，压力 ${trace.band}；`
      + `请求 ${idList(trace.requested)}；会话 ${trace.session}）`,
    )
  } else {
    // 声明数 > 注入数不是失败：自动注入钉死在 1 张以内，其余按需拉取
    const budget = trace.requested.length > trace.delivered.length
      ? `；本档自动注入上限 ${AUTO_INJECT_CARD_CAP} 张，其余按需拉取`
      : ''
    bits.push(
      `上次注入：成功（${idList(trace.delivered)}，${trace.chars} 字符；深度 ${trace.depth}，压力 ${trace.band}${budget}；会话 ${trace.session}）`,
    )
  }
  // 控制读数与验证段的字符成本分开记账：这是"档位差异不是靠字数"的可核验读数
  if (trace !== null) {
    bits.push(`控制读数 ${trace.controlChars} 字符，验证段 ${trace.verifyChars} 字符`)
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
    requires: derivedRequires(MODULE_ID),
    capabilities: derivedCapabilities(MODULE_ID),
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
    /**
     * 还没有会话状态时的空读数组（渲染是热路径，别每轮新建一个 Map）。
     * `summarizeTracker` 不改它，所以可以共用。
     */
    const emptyVerify = createVerifyTracker()
    let renderFailures = 0
    let lastRenderFailure = ''
    /** Verify 读数（模块级累计 + 最近一次），状态面与健康面共用。 */
    let verifyCalls = 0
    let verifyOverBudget = 0
    const failureCounts = new Map<FailureClass, number>()
    let lastClassified: { readonly session: SessionRef; readonly failureClass: FailureClass } | null = null

    /** 读时钟：端口异常时返回 0（服务方法不因宿主端口坏掉而抛给调用方）。 */
    const now = (): number => {
      try {
        return kernel.clock.now()
      } catch {
        return 0
      }
    }

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
      let unresolved = 0
      for (const [session, state] of sessions) {
        if (state.lastSignal !== null) withSignal += 1
        const depth = peekFocus(kernel, session) ?? state.explicitDepth ?? 'standard'
        unresolved += summarizeTracker(state.verify, controlOf(depth).verifyBudget, state.turn).unresolved
      }
      const classified = [...failureCounts.values()].reduce((sum, count) => sum + count, 0)
      const parts = [
        `规则卡 ${METHOD_CARDS.length} 张`,
        `常驻提示 ${hint.length}/${RESIDENT_HINT_MAX} 字符`,
        `跟踪会话 ${sessions.size}`,
        withSignal > 0 ? `循环信号 ${withSignal} 个` : '无循环信号',
        verifyCalls > 0 ? `验证 ${verifyCalls} 次（未闭合 ${unresolved}）` : '尚未核对过结论',
      ]
      // 渲染失败必须留声：它是"回执说了要注入、实际没注入"的唯一证据
      if (renderFailures > 0) parts.push(`上下文渲染失败 ${renderFailures} 次（最近：${lastRenderFailure}）`)
      if (classified > 0 && lastClassified !== null) {
        parts.push(`失败分类 ${classified} 次（最近：${lastClassified.failureClass}）`)
      }
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
          lastRenderControlChars: lastRender?.controlChars ?? 0,
          lastRenderVerifyChars: lastRender?.verifyChars ?? 0,
          verifyCalls,
          verifyUnresolved: unresolved,
          verifyOverBudget,
          classifiedFailures: classified,
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
        // 回合号推进：状态面据此回答"本回合验证了几次"（跨回合累计另有 calls）
        if (Number.isFinite(payload.turn)) state.turn = Math.max(state.turn, Math.floor(payload.turn))
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
     * Verify 端口：`omb_verify` 的执行体。
     *
     * 两件事都记台账（状态面可读），且**都不阻塞**模型：
     * - 核对结论：形式核对 + 预算读数（超预算只提示升档，不拒绝）
     * - 给失败定性：分类器（模型定性优先，`unknown` 时用 Loop 观察细化）→ 恢复策略
     */
    const verifyPort = (session: SessionRef, input: VerifyInput): VerifyOutcome => {
      try {
        const depth = peekFocus(kernel, session) ?? 'standard'
        const control = controlOf(depth)
        const state = ensure(session)
        const lines: string[] = []

        if (input.failure !== undefined) {
          const declared = isFailureClass(input.failure) ? input.failure : undefined
          const signals = failureSignalsFromLoop(state.lastSignal)
          const failureClass = classifyFailure({ declared, ...signals })
          const policy = recoveryFor(failureClass)
          failureCounts.set(failureClass, (failureCounts.get(failureClass) ?? 0) + 1)
          lastClassified = { session, failureClass }
          const refined = declared === undefined || declared === 'unknown'
            ? `\n（你给的是${declared === undefined ? '未定性' : ' unknown'}；按循环观察细化为 ${failureClass}${state.lastSignal === null ? '（当前无循环信号）' : `：${state.lastSignal.kind}`}）`
            : ''
          lines.push(renderRecovery(policy) + refined)
        }

        if (input.claim !== undefined) {
          const judgement = judgeClaim({ claim: input.claim, evidence: input.evidence, falsifier: input.falsifier })
          /**
           * 次数读**单调累计**，不读台账长度（G3）。
           *
           * 台账上限 32 条只影响"最近发生了什么"；此前这里读的是被 `slice` 后的长度，
           * 于是第 33 次之后回执永远说"这是第 33 次"、`overBudget` 判据也永远停在第 33 次，
           * 而同一次 `omb_status` 的健康行报的是模块级真实累计——两个面互相矛盾。
           */
          const used = state.verify.total
          const overBudget = control.verifyBudget <= 0 || used + 1 > control.verifyBudget
          trackVerify(state.verify, {
            claim: judgement.claim,
            verdict: judgement.verdict,
            at: now(),
            depth,
            turn: state.turn,
            overBudget,
          })
          verifyCalls += 1
          if (overBudget) verifyOverBudget += 1
          const budgetNote = control.verifyBudget <= 0
            ? `本档（${depth}）不要求验证：你正在核对结论，说明这个问题比 ${depth} 复杂，可用 omb_focus standard 或 deep。`
            : overBudget
              ? `本档验证预算 ${control.verifyBudget} 次已用完（这是第 ${used + 1} 次）。预算不是禁令：继续验证可以，但请把结论收敛——给出来源，或标为待确认，或用 omb_focus 升档。`
              : `本档验证预算 ${control.verifyBudget} 次，已用 ${used + 1}。`
          lines.push(
            `形式核对：${VERDICT_TEXT[judgement.verdict]}——${judgement.note}\n下一步：${judgement.next}\n（${budgetNote}）`,
          )
        }

        report()
        return { ok: true, text: lines.join('\n\n') }
      } catch (error) {
        return { ok: false, text: `验证处理失败：${messageOf(error)}；本次调用未改变任何状态。` }
      }
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
        verify: verifyPort,
      })
    } catch (error) {
      const note = `工具构造失败：${messageOf(error)}`
      degradations.push(note)
      kernel.logger.warn(`${MODULE_ID}：${note}`)
    }

    /**
     * `PromptContribution`：`resident` 是冻结的常驻提示；`context` 是每轮易变部分。
     *
     * v3.1 的注入结构（**档位差异不是靠字数**）：
     * ① 指令：只有 `quick` 有（"不要展开、直接回答"）
     * ② 控制读数：只有偏离基线的档位有（`deep`），一行参数
     * ③ 规则卡：任何档位自动注入 **≤1 张**（`AUTO_INJECT_CARD_CAP`），其余按需拉取
     * ④ 验证段：**有未闭合结论才出现**，与档位无关（是状态，不是档位）
     * ⑤ 循环提示：有信号才出现（≤80 字符）
     *
     * 紧张档：**读数保留 + 真的给索引**（内容全部转工具拉取）。
     * 档位来源的裁决见 `resolveRenderDepth`；两者分歧必定留痕。
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

          const control: DepthControl = controlOf(depth)
          const verifySummary = summarizeTracker(state?.verify ?? emptyVerify, control.verifyBudget, state?.turn)
          const projection = projectFocus(depth, verifySummary.calls)
          const tight = input.band === 'tight'

          const parts: string[] = []
          /** 真的进了上下文的东西（状态面留痕用）——标签必须与内容对得上。 */
          const given: string[] = []
          let verifyOnly = ''
          let verifyChars = 0
          // 紧张档的判据：这一档本来就有可注入内容（读数或卡片），压缩才有意义
          const substantive = projection.controlText !== '' || projection.cards.length > 0
          if (tight) {
            // ① quick 的抑制指令是"少想"，压力再大也不该被吞掉
            if (projection.directive !== '') {
              parts.push(projection.directive)
              given.push('指令')
            }
            // ② 控制读数是**档位差异的唯一载体**（`control.ts` 的 `controlLine`），
            //    且受 CONTROL_LINE_MAX 约束只有一行——紧张档压缩的是卡片正文，
            //    不是读数。此前这里把读数整段丢掉，deep 在压力过 0.6 后退化成与
            //    standard 无差别，而回执与工具描述承诺的恰好相反（G2）。
            if (projection.controlText !== '') {
              parts.push(projection.controlText)
              given.push('读数')
            }
            // ③ 承诺"规则卡只给索引"就**真的给索引**：
            //    `renderIndex()` 只给编号+标题+何时用，不含正文（正文仍用 omb_method 取）。
            //    只在本来就有可注入内容的档位给——`standard` 是基线（常驻提示已逐字承载
            //    R1 的动作），紧张档不为它额外塞文本。
            if (substantive && projection.needs.length > 0) {
              parts.push(renderIndex(cardsFor(depth)))
              given.push('索引')
            }
          } else {
            const body = renderProjection(projection, true)
            if (body !== '') {
              parts.push(body)
              if (projection.directive !== '') given.push('指令')
              if (projection.controlText !== '') given.push('读数')
              if (projection.cards.length > 0) given.push('卡片')
            }
            // 验证段是**状态**驱动：有未闭合结论才出现，不随档位增减
            if (control.verifyBudget > 0) {
              verifyOnly = verifyLine(verifySummary)
              if (verifyOnly !== '') {
                parts.push(verifyOnly)
                given.push('验证段')
                verifyChars = verifyOnly.length
              }
            }
          }

          const signal = state?.lastSignal ?? null
          const loopLine = renderLoopSignal(signal)
          if (loopLine !== '') {
            parts.push(loopLine)
            given.push('循环提示')
          }
          const text = parts.join('\n')

          // 可核验留痕：按正文逐张确认卡真的进了上下文，而不是"我们打算注入"。
          // 控制读数与验证段分开记账——这是"档位差异不是靠字数"的可核验读数。
          lastRender = {
            session: input.sessionId,
            depth,
            band: input.band,
            requested: CARDS_BY_DEPTH[depth] ?? [],
            delivered: projection.cards.filter(card => text.includes(card.text)).map(card => card.id),
            chars: text.length,
            form: given.join('+'),
            controlChars:
              projection.controlText !== '' && text.includes(projection.controlText)
                ? projection.controlText.length
                : 0,
            verifyChars: verifyOnly !== '' && text.includes(verifyOnly) ? verifyChars : 0,
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
          // 失败分类的分布与最近一次处置：这是 R6 从"固定阈值"改成分类器之后的可核验读数
          if (lastClassified !== null) {
            const spread = FAILURE_CLASSES
              .filter(failureClass => (failureCounts.get(failureClass) ?? 0) > 0)
              .map(failureClass => `${failureClass} ${failureCounts.get(failureClass) ?? 0}`)
              .join('、')
            lines.push(
              `失败分类：${spread}（最近：${lastClassified.failureClass} → ${recoveryFor(lastClassified.failureClass).strategy}）`,
            )
          }
          for (const [session, state] of sessions) {
            // 只写"有事发生"的会话：显式设过档位（含理由，供事后判断旋钮是否有用）、
            // 检出过循环信号、或核对过结论。安静的会话不占行。
            const signal = state.lastSignal
            if (signal === null && state.explicitDepth === undefined && state.verify.total === 0) continue
            const bits: string[] = []
            if (state.explicitDepth !== undefined) {
              bits.push(`深度 ${state.explicitDepth}${state.lastReason === '' ? '' : `（理由：${state.lastReason}）`}`)
            }
            if (signal !== null) bits.push(`${signal.kind}——${signal.detail}`)
            if (state.verify.total > 0) {
              const depth = peekFocus(kernel, session) ?? state.explicitDepth ?? 'standard'
              // 累计量取自 tracker 的单调计数器：台账 32 条上限不再让这一行"停在 32"
              bits.push(describeVerify(summarizeTracker(state.verify, controlOf(depth).verifyBudget, state.turn)))
            }
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
