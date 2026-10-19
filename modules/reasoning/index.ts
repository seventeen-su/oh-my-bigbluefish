import { OMB_VERSION } from '../../kernel/version.js'
/**
 * `omb-reasoning` 模块注册入口（v4：**技能化 + 只留事件驱动提示**）。
 *
 * ## v4 删除清单（docs/v4-decision.md §3 L3 / §4）
 *
 * - **`omb_verify`**（工具 + `verify.ts` + 验证台账 + 验证段）——外部核验器
 *   （tsc/eslint/vitest/git diff）替代，不做内在自验证；
 * - **`omb_method` / `omb_focus`** 两个工具与 `reasoning:methods` 服务——
 *   8 张方法卡迁到 DSH skills（`skills/omb-r1…r8/SKILL.md`），档位/effort 由
 *   `dsh/depth-command.ts` + `dsh/reasoning-effort.ts`（用户命令 `/omb-depth`）负责；
 * - 控制读数、自动注入卡、紧档索引、逐回合压力塑形、失败处置表、糊弄观察面。
 *
 * ## 保留面（Wave 1 已验证的两件事）
 *
 * 1. **一句常驻提示**（`methods.ts`，≤80 字符）：承载 R1 的动作并指向 skills；
 * 2. **事件驱动的循环检测 + 合法出口**（`loop.ts` / `hints.ts`）：
 *    callId 精确配对、surface 代际分区、注入迟滞；**没有信号时注入恒为空**
 *    （standard/quick/deep 都一样——注入不再随档位变化）。
 *
 * 另外保留 `reasoning:loop` 服务（状态面与测试要读窗口/信号）与状态面贡献者：
 * 读数带来源与时间，压力"采样时 vs 现读"同屏，不出现的面一律明说没测量。
 *
 * 本文件仍是唯一有状态的地方：每会话指纹窗口 / 显式档位（仅用于状态展示）/
 * 迟滞状态 / surface 代际 / tick，以及最近一次渲染留痕。
 *
 * 热插拔约束（H-1/H-2）：所有注册在 `apply` 内**同步**完成并返回同一批
 * disposer；`dispose` 绝不抛异常。
 */
import { z } from 'zod'
import type {
  ContextPressure,
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
} from '../../kernel/abi/index.js'
import { RESIDENT_HINT_MAX, SERVICES, derivedCapabilities, derivedRequires } from '../../kernel/abi/index.js'
import { EXIT_SEGMENT_MAX, renderExitOptions } from './hints.js'
import type { LoopAnnounceState, LoopSignal, TurnFingerprint } from './loop.js'
import {
  DEFAULT_WINDOW_SIZE,
  NO_ANNOUNCE,
  announceLoop,
  detectLoop,
  noteObservation,
  renderLoopSignal,
} from './loop.js'
import { RESIDENT_HINT_MAX_CHARS, residentHint } from './methods.js'
import { heartbeat, toHostPlugin } from '../../kernel/hostEntry.js'

export const MODULE_ID = 'omb-reasoning'
/** 版本号在发版时由 Lead 统一抬；本模块不单独进位。 */
export const MODULE_VERSION = OMB_VERSION

/** 会话表上界（LRU）。超过就淘汰最久未活动的会话状态。 */
export const MAX_TRACKED_SESSIONS = 128

/** 配置：`cordis.patch.yml` 的 `config` 段。 */
export interface ReasoningConfig {
  /** 常驻提示的字符预算；上限 80（模块自身），且不得超过内核 `RESIDENT_HINT_MAX`。 */
  readonly residentHintChars: number
}

export const DEFAULT_REASONING_CONFIG: ReasoningConfig = {
  residentHintChars: RESIDENT_HINT_MAX_CHARS,
}

/**
 * 配置 schema（zod）。**缺省值完整**：`parse(undefined)` 也得到完整配置。
 *
 * 注意：旧配置里的 `defaultDepth` / `effortMapping` 会**被 zod 静默剥离**（不报错），
 * 因为这两个语义已分别迁到 `/omb-depth` 命令与 `dsh/reasoning-effort.ts`；
 * `cordis.patch.yml` 的清理归 Lead。
 */
export const reasoningConfigSchema = z
  .object({
    residentHintChars: z.number().int().positive().default(DEFAULT_REASONING_CONFIG.residentHintChars),
  })
  .default(DEFAULT_REASONING_CONFIG)

/** `reasoning:loop` 服务面。 */
export interface ReasoningLoopService {
  /** 当前循环信号；无信号返回 null（不是"没有信号"的文本）。 */
  signal(session: SessionRef): LoopSignal | null
  /** 滚动指纹窗口（最近 `DEFAULT_WINDOW_SIZE` 条），供状态面与审计。 */
  window(session: SessionRef): readonly TurnFingerprint[]
  /** 清掉某会话的**循环窗口与迟滞状态**（不碰显式档位）。 */
  reset(session: SessionRef): void
}

interface SessionState {
  window: readonly TurnFingerprint[]
  /** 用户显式设过的档位（`/omb-depth`）；**只用于状态展示**，不影响注入。 */
  explicitDepth: FocusDepth | undefined
  depthReason: string
  lastSignal: LoopSignal | null
  /** 循环提示的注入迟滞状态（同一信号 N 个 tick 内不重复）。 */
  announce: LoopAnnounceState
  /** 当前 surface 代际（压缩/替换后由 dsh 递增；变化即丢弃旧窗口）。 */
  generation: number
  /** 单调渲染机会计数（每次 `turn/start` +1）：迟滞时钟，不依赖宿主 turn/step 语义。 */
  ticks: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function newSessionState(): SessionState {
  return {
    window: [],
    explicitDepth: undefined,
    depthReason: '',
    lastSignal: null,
    announce: NO_ANNOUNCE,
    generation: 0,
    ticks: 0,
  }
}

/**
 * 上一次 `context` 渲染的留痕：**采样时**的压力/总量/窗口 + 实际产出了什么。
 *
 * 没有 `at`/`total`/`window` 的旧痕迹无法区分"陈旧采样"与"两源不一致"——
 * 这正是本模块被投诉过的那类"读数说谎"，v4 继续保留这组字段。
 */
interface RenderTrace {
  readonly session: SessionRef
  readonly at: number
  /** 渲染时宿主递来的压力带（**采样值**，不是永久事实）。 */
  readonly band: ContextRenderInput['band']
  /** 采样时的上下文总量（token）；未测量为 null。 */
  readonly total: number | null
  /** 采样时的窗口容量（token）；宿主未声明为 null。 */
  readonly window: number | null
  /** 产出的 context 字符数；0 = 本轮确实什么都没注入（常态）。 */
  readonly chars: number
  /** 真的进了上下文的东西（`循环提示` / `出口段` / 组合；'' = 空）。 */
  readonly form: string
  /** 出口段占的字符数。 */
  readonly exitChars: number
}

/** 现读一次压力；任何异常都返回 null（状态面不许因度量桥坏掉而抛）。 */
function readPressure(kernel: Kernel, session: SessionRef): ContextPressure | null {
  try {
    return kernel.pressure(session)
  } catch {
    return null
  }
}

/** 把压力读数渲染成一句可核对的话（"未测量"与"0"必须分开）。 */
function pressureText(pressure: ContextPressure | null): string {
  if (pressure === null) return '不可用'
  if (pressure.fillRatio === null) return `未测量（总 ${pressure.totalTokens}）`
  const window = pressure.fillRatio > 0 ? Math.round(pressure.totalTokens / pressure.fillRatio) : null
  const ratio = window === null ? '' : `（${pressure.fillRatio.toFixed(3)}）`
  return `${pressure.band} ${pressure.totalTokens}/${window ?? '?'}${ratio}`
}

/**
 * 状态面里的一行：上次注入**实际**发生了什么——可核验的事实，不是承诺。
 *
 * 压力这样报：`渲染时压力 X（采样 total/window），现读 Y`——采样值与现读值
 * 都写出来，两个时刻不一致时读者一眼能看见。不再出现"请求 X"这类未发生的承诺。
 */
function describeLastRender(
  trace: RenderTrace | null,
  failures: number,
  lastFailure: string,
  live: ContextPressure | null,
  atText: (at: number) => string,
): string {
  const bits: string[] = []
  if (trace === null) {
    bits.push(failures > 0 ? `上次注入：失败（${lastFailure}）` : '上次注入：尚无（还没有渲染过）')
  } else {
    const sampled = `渲染时压力 ${trace.band}（采样 ${trace.total ?? '未测量'}/${trace.window ?? '?'}）`
    const current = `现读 ${pressureText(live)}`
    const tail = `${sampled}，${current}；采样于 ${atText(trace.at)}；会话 ${trace.session}`
    if (trace.chars === 0) {
      bits.push(`上次注入：空（${tail}）`)
    } else {
      bits.push(`上次注入：${trace.form === '' ? '一行提示' : trace.form}（${trace.chars} 字符；${tail}）`)
      bits.push(`出口段 ${trace.exitChars} 字符（上限 ${EXIT_SEGMENT_MAX}）`)
    }
  }
  if (failures > 1 || (failures > 0 && trace !== null)) {
    bits.push(`渲染失败累计 ${failures} 次（最近：${lastFailure}）`)
  }
  return bits.join('；')
}

/**
 * 建立模块实例。**每个实例自带状态**——测试可以建两个互不干扰的实例，
 * 热重载时也不会把上一轮的窗口带过来。
 */
export function createReasoningModule(): ModuleRegistration<ReasoningConfig> {
  let lastHealth: ModuleHealth = {
    state: 'ok',
    detail: `未启动；常驻提示上限 ${RESIDENT_HINT_MAX_CHARS} 字符，过程卡在 skills omb-r1…r8`,
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
    let lastRender: RenderTrace | null = null
    let renderFailures = 0
    let lastRenderFailure = ''

    const now = (): number => {
      try {
        return kernel.clock.now()
      } catch {
        return 0
      }
    }

    // ── 常驻提示：apply 内算一次，之后逐字节不变（缓存前缀靠它保稳定） ──
    const hintBudget = clampHintBudget(config.residentHintChars, kernel, degradations)
    const hint = residentHint(hintBudget)

    /** 取会话状态。**LRU**：命中即刷新次序；新建超过上界就淘汰最久未活动的一会话。 */
    const ensure = (session: SessionRef): SessionState => {
      const existing = sessions.get(session)
      if (existing !== undefined) {
        sessions.delete(session)
        sessions.set(session, existing)
        return existing
      }
      const state = newSessionState()
      sessions.set(session, state)
      while (sessions.size > MAX_TRACKED_SESSIONS) {
        const oldest = sessions.keys().next()
        if (oldest.done === true) break
        sessions.delete(oldest.value)
      }
      return state
    }

    const healthNow = (): ModuleHealth => {
      let withSignal = 0
      for (const state of sessions.values()) if (state.lastSignal !== null) withSignal += 1
      const parts = [
        `过程卡 skills omb-r1…r8`,
        `常驻提示 ${hint.length}/${RESIDENT_HINT_MAX_CHARS} 字符`,
        `跟踪会话 ${sessions.size}`,
        withSignal > 0 ? `循环信号 ${withSignal} 个` : '无循环信号',
      ]
      if (renderFailures > 0) parts.push(`上下文渲染失败 ${renderFailures} 次（最近：${lastRenderFailure}）`)
      if (degradations.length > 0) parts.push(`降级：${degradations.join('；')}`)
      return {
        state: degradations.length > 0 || renderFailures > 0 ? 'degraded' : 'ok',
        detail: parts.join('；'),
        metrics: {
          residentHintChars: hint.length,
          trackedSessions: sessions.size,
          activeLoopSignals: withSignal,
          renderFailures,
          lastRenderChars: lastRender?.chars ?? 0,
          lastRenderExitChars: lastRender?.exitChars ?? 0,
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
    // dsh 在 `evidence/observed` 上传入 callId / tool / generation（ABI 已声明）：
    // callId 精确配对、tool 只用于提示文案、generation 变化即丢弃旧窗口。
    disposers.push(
      kernel.on('evidence/observed', payload => {
        const state = ensure(payload.sessionId)
        const generation = typeof payload.generation === 'number' && Number.isFinite(payload.generation)
          ? Math.max(0, Math.floor(payload.generation))
          : state.generation
        if (generation !== state.generation) {
          state.generation = generation
          state.window = []
          state.announce = NO_ANNOUNCE
        }
        state.window = noteObservation(
          state.window,
          {
            actionHash: payload.actionHash,
            evidenceHash: payload.evidenceHash,
            at: payload.at,
            ...(payload.callId === undefined ? {} : { callId: payload.callId }),
            ...(payload.tool === undefined ? {} : { tool: payload.tool }),
          },
          DEFAULT_WINDOW_SIZE,
          state.generation,
        )
        state.lastSignal = detectLoop(state.window)
        report()
      }),
    )

    disposers.push(
      kernel.on('focus/changed', payload => {
        // 档位由用户命令 `/omb-depth` 设置；本模块**只记录、不注入**（v4 删除逐回合档位提示）
        const state = ensure(payload.sessionId)
        state.explicitDepth = payload.depth
        state.depthReason = payload.reason
        report()
      }),
    )

    disposers.push(
      kernel.on('turn/start', payload => {
        heartbeat('reasoning-turn', { sessionId: payload.sessionId })
        const state = ensure(payload.sessionId)
        state.lastSignal = detectLoop(state.window)
        // 迟滞时钟：单调 +1（不依赖宿主 turn/step 是否按回合重置）
        state.ticks += 1
        report()
      }),
    )

    // ── 服务面：只留 loop（状态面/测试读窗口与信号） ──
    const loopService: ReasoningLoopService = {
      signal: session => sessions.get(session)?.lastSignal ?? null,
      window: session => sessions.get(session)?.window ?? [],
      reset: session => {
        const state = sessions.get(session)
        if (state === undefined) return
        state.window = []
        state.lastSignal = null
        state.announce = NO_ANNOUNCE
      },
    }

    /**
     * `PromptContribution`：`resident` 是那句常驻提示；`context` 只在**真信号**
     * 出现时注入一到两行（循环提示 ≤80 字符 + 出口段 ≤120 字符）。
     *
     * **没有信号时注入恒为空**——不随档位、压力或会话状态加字（v4 删除了
     * 控制读数/自动注入卡/紧档索引）。迟滞保证同一信号不会每轮重复。
     */
    const contribution: PromptContribution = {
      resident: hint,
      context: (input: ContextRenderInput): string => {
        try {
          const state = sessions.get(input.sessionId)
          const signal = state?.lastSignal ?? null
          const announcement = announceLoop(state?.announce ?? NO_ANNOUNCE, signal, state?.ticks ?? 0)
          if (state !== undefined) state.announce = announcement.state

          const parts: string[] = []
          const given: string[] = []
          let exitChars = 0
          if (announcement.inject) {
            const loopLine = renderLoopSignal(signal)
            if (loopLine !== '') {
              parts.push(loopLine)
              given.push('循环提示')
            }
            const exitLine = renderExitOptions(signal)
            if (exitLine !== '') {
              parts.push(exitLine)
              given.push('出口段')
              exitChars = exitLine.length
            }
          }
          const text = parts.join('\n')

          const sampled = readPressure(kernel, input.sessionId)
          lastRender = {
            session: input.sessionId,
            at: now(),
            band: input.band,
            total: sampled?.totalTokens ?? null,
            window: sampled !== null && sampled.fillRatio !== null && sampled.fillRatio > 0
              ? Math.round(sampled.totalTokens / sampled.fillRatio)
              : null,
            chars: text.length,
            form: given.join('+'),
            exitChars,
          }
          report()
          return text
        } catch (error) {
          // 渲染失败不得影响宿主回合；但失败必须留声（计数与原因进状态面/健康面）
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
          // 压力**现读**：采样值与现读值同屏，两个时刻不一致时一眼可见
          const live = lastRender === null ? null : readPressure(kernel, lastRender.session)
          const lines = [
            healthNow().detail,
            describeLastRender(lastRender, renderFailures, lastRenderFailure, live, isoAt),
          ]
          for (const [session, state] of sessions) {
            if (state.lastSignal === null && state.explicitDepth === undefined) continue
            const bits: string[] = []
            if (state.explicitDepth !== undefined) {
              bits.push(`深度 ${state.explicitDepth}${state.depthReason === '' ? '' : `（${state.depthReason}）`}`)
            }
            if (state.lastSignal !== null) bits.push(`${state.lastSignal.kind}——${state.lastSignal.detail}`)
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
    provide(SERVICES.reasoningLoop, loopService)

    // 状态面：登记处由微内核提供；缺失时记入降级原因。
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
      lastHealth = { state: 'ok', detail: `模块已卸载；过程卡仍在 skills omb-r1…r8` }
    }
  }

  return { manifest, apply }
}

/** 常驻提示预算：受模块上限与内核上限双重约束；任何调整都记入降级原因（不静默改配置）。 */
function clampHintBudget(requested: unknown, kernel: Kernel, degradations: string[]): number {
  const raw = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.floor(requested)
    : RESIDENT_HINT_MAX_CHARS
  const upper = Math.min(RESIDENT_HINT_MAX_CHARS, RESIDENT_HINT_MAX)
  const clamped = Math.min(Math.max(raw, 20), upper)
  if (clamped !== raw) {
    const note = `residentHintChars=${raw} 已收敛到 ${clamped}（允许区间 20…${upper}）`
    degradations.push(note)
    kernel.logger.warn(`${MODULE_ID}：${note}`)
  }
  return clamped
}

/** 时间戳渲染（状态面用）。**纯算术**：模块层不得直接取时间（omb/no-direct-clock）。 */
function isoAt(at: number): string {
  const value = Number.isFinite(at) ? Math.floor(at) : 0
  const day = Math.floor(value / 86_400_000)
  const msOfDay = value - day * 86_400_000
  const civil = civilFromDays(day)
  const pad = (number: number, width: number): string => String(number).padStart(width, '0')
  const hour = Math.floor(msOfDay / 3_600_000)
  const minute = Math.floor((msOfDay % 3_600_000) / 60_000)
  const second = Math.floor((msOfDay % 60_000) / 1000)
  const millis = msOfDay % 1000
  return `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}`
    + `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millis, 3)}Z`
}

/** 从 Unix 天数得到公历年月日（Hinnant 算法；纯整数运算，不依赖 Date）。 */
function civilFromDays(day: number): { readonly year: number; readonly month: number; readonly day: number } {
  const z = day + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return { year: y, month: m, day: d }
}

/** 目录里登记的模块实例（`dsh/` 直接取用）。 */
export const reasoningRegistration: ModuleRegistration<ReasoningConfig> = createReasoningModule()

export default toHostPlugin(reasoningRegistration)

