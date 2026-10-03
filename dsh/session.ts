/**
 * 会话侧集成：把宿主会话事实喂给内核与模块。
 *
 * 三件事：
 * ① 记住会话的 cwd（项目库身份由此确定）
 * ② 汇总各模块的 `PromptContribution` 注入宿主提示层
 * ③ 把宿主会话事件转成内核事件（`turn/start`、`turn/end`、`evidence/observed`）
 *
 * **不接管 Agent Loop**（DSH 硬约束，`docs/cookbook/extension-cookbook.md:100`）：
 * 本层只观察、只注入，不替换也不包装回合。
 *
 * ## 「会话 → cwd」这张表**不在这里**
 *
 * 它曾经在这里（本文件的 `SessionTable`）、在内核登记处、在记忆模块各存一份，
 * 三处更新时机不同 → 同一次 `omb_status` 里出现稳定矛盾（模块段 0 条、存储段 1 条）。
 * 现在唯一存放处是内核的 `ActiveSessionTable`（`SERVICES.activeSession`）：
 * 本文件只**写**它、状态面只从它**读**、模块按需**查**。
 */
import { createHash } from 'node:crypto'
import type { HostContextLike } from './host.js'
import { readService } from './host.js'
import type {
  ContextRenderInput,
  Kernel,
  PromptContribution,
  StatusRegistry,
} from '../kernel/abi/index.js'
import { RESIDENT_HINT_MAX, SERVICES } from '../kernel/abi/index.js'
import { heartbeat } from '../kernel/hostEntry.js'

/** 宿主系统提示服务的最小结构面。 */
export interface SystemPromptLike {
  /**
   * 注册动态上下文。`text` 可为函数，每轮装配时求值。
   * 返回 disposer。见 `packages/core/system-prompt/src/index.ts:489-498`。
   */
  context(entry: {
    name: string
    order: number
    text: string | ((ctx: unknown) => string)
  }): unknown
}

/**
 * 注入顺序。
 *
 * 宿主自己的 `CONTEXT_ORDERS` 是 110/115/120（sandbox/approval/subagent）。
 * 我们用 200 段，落在宿主的内置段之后、保证不插队——插队会改变宿主的提示结构。
 */
export const CONTEXT_ORDER = 200

/** 从可能的事件载荷里稳取字符串字段（宿主事件形状跨版本可能变）。 */
function pickString(source: unknown, ...keys: readonly string[]): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 稳定短哈希，用于动作/证据指纹（跨进程确定，便于重放与测试）。 */
export function fingerprint(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/** 提示贡献的服务名前缀（`kernel/abi/catalog.ts:195` 的命名约定）。 */
const PROMPT_SERVICE_PREFIX = 'prompt:'

/**
 * 收集内核服务表里所有 `prompt:*` 贡献。
 *
 * 为什么按前缀扫描而不是硬编码名字：新增模块不应改 `dsh/`。
 * 这也是"模块化"在集成层的体现——加一个模块只需它自己 provide 一个 `prompt:<id>`。
 *
 * **顺带补上署名**：`prompt:<id>` 里的 `<id>` 就是模块自己声明的身份，
 * 因此超限报告能点名到模块，而**不依赖模块主动配合**（`PromptContribution.id` 是可选的）。
 * "署不署名"这种自觉性靠不住——真出事时说不清是谁被截了，这次就白踩一遍。
 *
 * 返回的是**副本**：模块读自己那份服务时不该看见别人塞进去的字段
 * （`kernel.service('prompt:x')` 返回的仍是它 provide 的那个对象本身）。
 */
export function collectPromptContributions(kernel: Kernel): readonly PromptContribution[] {
  const contributions: PromptContribution[] = []
  for (const name of kernel.services()) {
    if (!name.startsWith(PROMPT_SERVICE_PREFIX)) continue
    // 服务表按名字排序（`kernel/services.ts:33`），因此贡献顺序跨次稳定。
    // 类型里带上 `null`：模块 provide 什么运行时都可能，诊断路径不许因此抛。
    const value = kernel.service<PromptContribution | null>(name)
    if (value === undefined || value === null) continue
    const derived = name.slice(PROMPT_SERVICE_PREFIX.length)
    const declared = typeof value.id === 'string' && value.id.trim().length > 0 ? value.id : undefined
    const id = declared ?? (derived.length > 0 ? derived : undefined)
    contributions.push(id === undefined ? { ...value } : { ...value, id })
  }
  return contributions
}

/**
 * 一个贡献者在常驻提示合并里的账目。
 *
 * 为什么需要它：`resident` 的上限是**合计**的（`RESIDENT_HINT_MAX`），
 * 而每个模块手上只有自己那一条——"我被截了多少"只有合并处知道。
 * 这个结构就是把合并处知道的事交出来。
 */
export interface ResidentHintEntry {
  /** 贡献者标识：模块自报的 `id`、从服务名推出的名字，都没有则按序号点名。 */
  readonly id: string
  /** 本贡献者规范化后的字符数（截断前）。 */
  readonly chars: number
  /** 实际进入常驻文本的字符数；`0` = 整条被挤掉了。 */
  readonly kept: number
  /** 是否被截（`kept < chars`）。 */
  readonly truncated: boolean
}

/** 常驻提示的预算账目。见 `residentHintReport`。 */
export interface ResidentHintReport {
  /** 实际注入的文本：逐字节稳定，长度 ≤ `limit`。 */
  readonly text: string
  readonly limit: number
  /** 实际用掉的字符数（`text.length`）。 */
  readonly used: number
  /** 截断前把全部贡献拼起来的长度（含分隔符）。 */
  readonly total: number
  /** 是否有内容被截掉（`total > limit`）。 */
  readonly truncated: boolean
  /** 逐项账目，顺序 = 贡献顺序（服务名排序，跨次稳定）。 */
  readonly entries: readonly ResidentHintEntry[]
  /** 被截的贡献者（含整条被挤掉的）——`entries` 的子集。 */
  readonly clipped: readonly ResidentHintEntry[]
  /** 一行可读报告：谁贡献了多少、合计多少、被截的是谁、丢了多少字符。日志与状态面都用它。 */
  readonly report: string
}

/** 贡献之间的分隔符。改这里会让常驻文本变样 → 前缀缓存失效，所以刻意写成常量。 */
const RESIDENT_SEPARATOR = '\n'

/** 匿名贡献的点名格式（`未署名#2` = 贡献集合里第 2 条）——宁可点名到位置，也不要"某一条"。 */
const ANONYMOUS_PREFIX = '未署名'

/**
 * 按上限截断，但不切出"半个字符"。
 *
 * `slice` 按 UTF-16 码元切：截断点落在代理对（emoji 等）中间时会留下一个孤立的高位代理，
 * 那是非法字符串，进系统提示会变成替换字符。少一个码元比给出半个字符好。
 */
function cutWholeCharacters(text: string, max: number): string {
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** 一行可读账目。**不含时钟/计数**——同一份输入必须得到同一行文本（便于断言与比对）。 */
function residencyLine(input: {
  readonly limit: number
  readonly used: number
  readonly total: number
  readonly truncated: boolean
  readonly entries: readonly ResidentHintEntry[]
  readonly clipped: readonly ResidentHintEntry[]
}): string {
  const { limit, used, total, truncated, entries, clipped } = input
  if (entries.length === 0) return `常驻提示 0/${limit} 字符（无贡献者）`
  const ledger = entries.map(e => `${e.id} ${e.kept}/${e.chars}`).join('、')
  if (!truncated) {
    return `常驻提示 ${used}/${limit} 字符（未截断，余量 ${limit - used}）｜逐项：${ledger}`
  }
  const lost = clipped.map(e => `${e.id} 丢 ${e.chars - e.kept}/${e.chars}`).join('、')
  return `常驻提示 ${used}/${limit} 字符（超限：截断前 ${total}，丢掉 ${total - used}）`
    + `｜被截的是：${lost}｜逐项：${ledger}`
}

/**
 * 合并常驻提示并**如实记账**。
 *
 * ## 为什么要有这个函数（这次踩的坑）
 *
 * 旧实现只有一句 `joined.length <= MAX ? joined : joined.slice(0, MAX)`：
 * 超限一刀切掉尾巴，不报错、不告警、不改健康面。实测推理模块一条就占 104/120
 * （`modules/reasoning/methods.ts:152` 的变体选择），**只剩 16 字符余量**——
 * 任何模块多写一句文案，就会悄悄吃掉排在它后面的模块的常驻提示，
 * 而被吃掉的模块**完全不知道自己被截了**（它只看得见自己那一条）。
 * 症状是"某个能力莫名其妙不生效"，而所有模块健康面都是绿的。
 *
 * ## 现在的契约
 *
 * ① 截断**保留**（总得有个上限），但返回值把这件事说清楚：
 *    `truncated` + 逐项 `entries` + 被截的 `clipped` + 一行可读 `report`
 * ② 绝不抛：超预算是**配置/文案问题**，不是崩溃；调用方（`wirePromptInjection`）
 *    把它写进 `kernel.logger` 与状态面，而**不是**让插件加载失败（与 H-1 同源）
 * ③ 逐字节稳定不变：同一输入 → 同一文本、同一报告
 *
 * @param contributions 贡献集合。
 * @param limit 合计上限；非有限值退回 `RESIDENT_HINT_MAX`
 *   （模块层同样这么兜底：`modules/reasoning/methods.ts:153`）。
 */
export function residentHintReport(
  contributions: readonly PromptContribution[],
  limit: number = RESIDENT_HINT_MAX,
): ResidentHintReport {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : RESIDENT_HINT_MAX

  // 匿名贡献也**必须留位**：否则它的字符数会变成没有主的数字，
  // 超限时就说不清"被吃掉的到底是谁"——那正是这次要修的静默。
  const parts: { id: string; text: string }[] = []
  contributions.forEach((c, index) => {
    const text = c.resident?.trim()
    if (text === undefined || text.length === 0) return
    const declared = typeof c.id === 'string' ? c.id.trim() : ''
    parts.push({ id: declared.length > 0 ? declared : `${ANONYMOUS_PREFIX}#${index + 1}`, text })
  })

  const joined = parts.map(p => p.text).join(RESIDENT_SEPARATOR)
  const truncated = joined.length > max
  const text = truncated ? cutWholeCharacters(joined, max) : joined

  // 逐项归属：按拼接顺序累计偏移算出"谁进去多少"——算出来的账，不是估的。
  const entries: ResidentHintEntry[] = []
  let offset = 0
  for (const part of parts) {
    const start = offset
    offset += part.text.length + RESIDENT_SEPARATOR.length
    const kept = Math.max(0, Math.min(part.text.length, text.length - start))
    entries.push({ id: part.id, chars: part.text.length, kept, truncated: kept < part.text.length })
  }
  const clipped = entries.filter(e => e.truncated)

  return {
    text,
    limit: max,
    used: text.length,
    total: joined.length,
    truncated,
    entries,
    clipped,
    report: residencyLine({
      limit: max,
      used: text.length,
      total: joined.length,
      truncated,
      entries,
      clipped,
    }),
  }
}

/**
 * 规范化常驻提示：合并所有模块的 `resident`，裁到上限。
 *
 * **逐字节稳定是硬要求**：常驻提示进入系统提示的稳定前缀，
 * 任何跨轮变化都会使其后的整段前缀缓存失效（规划 §6.5）。
 * 因此这里不注入时间戳、计数器，也不随会话变化——只有内容真的变了才变。
 *
 * 只返回文本（旧契约，调用方拿不到账目）；要诊断就调 `residentHintReport`——
 * 文本与账目**同源**（这里直接取报告的 `text`），不可能出现"说的"与"做的"两套数字。
 */
export function residentHint(contributions: readonly PromptContribution[]): string {
  return residentHintReport(contributions).text
}

/**
 * 渲染易变上下文。所有模块的动态段合并成一段，避免污染宿主提示结构。
 */
export function renderContext(
  contributions: readonly PromptContribution[],
  input: ContextRenderInput,
): string {
  const parts: string[] = []
  for (const c of contributions) {
    if (c.context === undefined) continue
    try {
      const text = c.context(input)
      if (text.trim().length > 0) parts.push(text)
    } catch {
      // 单个模块渲染失败不得让整份注入失败
    }
  }
  return parts.join('\n\n')
}

export interface SessionWiringOptions {
  readonly kernel: Kernel
  readonly contributions: readonly PromptContribution[]
  readonly systemPrompt: SystemPromptLike | undefined
  readonly clock: { now(): number }
}

/**
 * 从会话对象里取 cwd 并登记。
 *
 * 宿主形状：`Session.header.cwd`（`packages/core/session/src/types.ts:105`）。
 * 取不到就**什么都不做**——记忆模块会如实报「宿主尚未告知该会话的 cwd」，
 * 而不是猜一个路径（猜错会把记忆写到别人的项目库）。
 */
export function cwdOfSession(session: unknown): string | undefined {
  const header = (session as { header?: unknown } | undefined)?.header
  const fromHeader = pickString(header, 'cwd')
  if (fromHeader !== undefined) return fromHeader
  // 少数宿主形状把 cwd 直接挂在会话上
  return pickString(session, 'cwd')
}

/**
 * 把一次会话观测登记到**唯一来源**（内核 `ActiveSessionTable`），并返回解析到的 cwd。
 *
 * 这是"按 cwd 惰性打开项目库"这条设计的**唯一**驱动点：
 * 少了它，项目库永远不会被打开，"记忆随项目走"就不成立。
 *
 * 注意只写内核登记处：**不再**同时写一份到别处——同一份事实存两遍必然漂
 * （曾经就是"模块段 0 条、存储段 1 条"那个稳定矛盾的根因）。
 *
 * **没有 cwd 的观测也要写**：它更新"当前活跃会话"（`omb_focus` 一类工具靠这个），
 * 而 `remember(session, undefined)` 按会话保留已知 cwd、绝不把别的会话的 cwd 记过来。
 *
 * @param sessions 唯一来源（`SERVICES.activeSession`）。缺省时只解析不登记。
 */
export function rememberCwdFrom(
  sessionId: string,
  session: unknown,
  sessions: { remember(session: string, cwd?: string): void } | undefined = undefined,
): string | undefined {
  const cwd = cwdOfSession(session)
  try {
    sessions?.remember(sessionId, cwd)
  } catch {
    // 登记失败不影响会话；记忆会如实降级为"仅用户库"
  }
  return cwd
}

/** 注入接线状态：状态面必须能分辨"记了账"与"真的接上了"（看着对 ≠ 生效）。 */
interface WiringState {
  injected: boolean
  /** 未接入时的可读原因（不写"未知"，写清是服务缺失还是注册被拒）。 */
  detail: string
}

/** 状态面段落名：常驻提示预算账目（`omb_status` 里可见）。 */
export const RESIDENT_BUDGET_STATUS_NAME = '常驻提示预算（omb 提示注入）'

/**
 * 把常驻提示预算账目登记进状态面。
 *
 * 为什么在 `wirePromptInjection` 里登记（而不是让模块各自上报）：
 * **合并结果只有这里看得到**——模块手上只有自己那一条，它无从知道别人占了多少、
 * 自己有没有被截。这正是"看着对 ≠ 生效"的藏身处，账目必须记在能看见全局的地方。
 *
 * 登记是同步的（H-2：宿主挂载审计只查一次）且**绝不抛**：登记处缺席或登记失败
 * 都只记日志——诊断失败不得让提示注入失败，更不得让插件加载失败。
 *
 * @returns 注销函数（幂等、绝不抛）。
 */
function registerResidentBudget(
  kernel: Kernel,
  report: ResidentHintReport,
  wiring: WiringState,
): () => void {
  try {
    const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
    if (registry === undefined) {
      kernel.logger.warn(
        `OMB：状态面登记处 ${SERVICES.statusContributor} 不可用，常驻提示预算账目不会出现在 omb_status`,
      )
      return () => {}
    }
    const unregister = registry.register({
      name: RESIDENT_BUDGET_STATUS_NAME,
      // 数据在装配时快照（与**实际注入的那一份**同源），渲染时只读它——
      // 若渲染时重算，状态面就可能与真正注入的文本不是同一份事实（本项目吃过这个亏）。
      render: () => [
        report.report,
        // 说清这是"装配时那一份"：与真正注入的文本**同源**（不重算，否则两处数字会漂）。
        `注入：${wiring.injected ? `已接入（order ${CONTEXT_ORDER}；本段为装配时快照）` : `未接入——${wiring.detail}`}`,
      ].join('\n'),
      // 机器可读的同一份数字（供 omb_status 之外的消费者按数判断，不用解析中文）。
      metrics: () => ({
        residentChars: report.used,
        residentLimit: report.limit,
        residentTotal: report.total,
        residentTruncated: report.truncated ? 1 : 0,
        residentClipped: report.clipped.length,
        residentContributors: report.entries.length,
      }),
    })
    return () => {
      try {
        unregister()
      } catch {
        // H-1：注销失败不得向上传播
      }
    }
  } catch (error) {
    kernel.logger.warn(`OMB：常驻提示预算账目登记失败（已隔离）——${String(error)}`)
    return () => {}
  }
}

/**
 * 把预算事实写进日志：未超限走 debug（每次装配一行账目），超限走 warn。
 *
 * 为什么**不抛异常**：超预算是**配置/文案问题**——抛出去会让整行插件加载失败，
 * 把"某句话写长了"升级成"插件用不了"。要的是如实上报，不是拒绝服务
 * （与 H-1「disposer 绝不抛」同源：加载路径同理）。
 *
 * 为什么未超限也要记一行：余量只剩 16 字符时，风险必须在**爆掉之前**就看得见
 * （`omb_status` 与 debug 日志都能读到"余量 16"）。
 */
function announceResidentBudget(kernel: Kernel, report: ResidentHintReport): void {
  try {
    if (!report.truncated) {
      kernel.logger.debug(`OMB：常驻提示账目——${report.report}`)
      return
    }
    kernel.logger.warn(
      `OMB：常驻提示超预算（合计 ${report.total} > 上限 ${report.limit}）——${report.report}；`
      + '已按上限截断，被截的模块不会生效——请改短文案或调低各模块自己的常驻预算',
    )
  } catch {
    // 日志失败不影响注入（诊断不得成为新的失败源）
  }
}

/**
 * 把提示注入接到宿主。
 *
 * 注册时机：**同步**完成（热插拔 H-2——宿主挂载审计只查一次，
 * 事后异步注册会触发进程级失败告警）。
 *
 * 常驻提示的预算账目在这里留声（日志 + 状态面）：
 * 合并结果只有本函数看得到，因此"谁被截了"也只有这里能说清。
 *
 * @returns 幂等 disposer；**绝不抛异常**（H-1）。
 */
export function wirePromptInjection(options: SessionWiringOptions): () => void {
  const { kernel, contributions, systemPrompt, clock } = options

  // ① **先记账再接线**。顺序刻意如此：即使宿主那边接不上，
  //    "各模块贡献了多少、有没有被截、被截的是谁"也已经在状态面上了。
  const budget = residentHintReport(contributions)
  const wiring: WiringState = { injected: false, detail: '尚未接线' }
  const disposeStatus = registerResidentBudget(kernel, budget, wiring)
  announceResidentBudget(kernel, budget)

  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') {
    wiring.detail = '宿主 systemPrompt 服务不可用'
    kernel.logger.warn('OMB：宿主 systemPrompt 服务不可用，认知投影未注入（状态面已记录）')
    return disposeStatus
  }

  let disposer: unknown
  try {
    disposer = systemPrompt.context({
      name: 'omb:cognitive',
      order: CONTEXT_ORDER,
      text: (ctx: unknown): string => {
        // 会话 id 用于按会话取档位/压力（`AssembleContext.agent` 由 agent 包增强）
        const sessionId = sessionIdOf(ctx)
        const input: ContextRenderInput = {
          sessionId,
          depth: kernel.focus(sessionId),
          band: kernel.pressure(sessionId).band,
        }
        // 易变快照里也带常驻提示：宿主对运行时上下文的语义是
        // 「本快照取代此前的运行时上下文快照」，所以完整自包含比精简更重要。
        const dynamic = renderContext(contributions, input)
        return [budget.text, dynamic].filter(p => p.length > 0).join('\n\n')
      },
    })
    wiring.injected = true
    // 记录一次注入时间，供诊断（不进入提示文本，因此不影响缓存）
    kernel.logger.debug(`OMB：认知投影已注入（常驻 ${budget.used}/${budget.limit} 字符，order ${CONTEXT_ORDER}，t=${clock.now()}）`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    wiring.detail = `注册失败：${message}`
    kernel.logger.warn(`OMB：认知投影注册失败——${message}`)
    return disposeStatus
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      if (typeof disposer === 'function') (disposer as () => void)()
    } catch {
      // H-1：回收失败不得向上传播
    }
    // 状态面段落随注入一起撤掉（幂等、内部已隔离）——热插拔不残留
    disposeStatus()
  }
}

/** 从宿主装配上下文里取会话 id。宿主未提供时退化为空串（不影响功能，只影响按会话的档位）。 */
function sessionIdOf(ctx: unknown): string {
  const agent = (ctx as { agent?: unknown } | undefined)?.agent
  const fromAgent = pickString(agent, 'id')
  if (fromAgent !== undefined) return fromAgent
  const session = (agent as { session?: unknown } | undefined)?.session
  const fromSession = pickString(session, 'id')
  if (fromSession !== undefined) return fromSession
  return pickString(ctx, 'scope') ?? ''
}

/**
 * 订阅宿主会话事件并转成内核事件。
 *
 * 只订阅**三个**宿主事件面（与规划一致，不扩张观察面）：
 * `session/event`（回合/工具）、`session/flush`、`tools/result`。
 *
 * @returns 幂等 disposer；绝不抛。
 */
export function wireSessionEvents(options: {
  readonly ctx: HostContextLike
  readonly kernel: Kernel
  readonly onToolResult?: (payload: { sessionId: string; text: string; callId: string | undefined }) => void
  /**
   * 每观测到一次会话事件时把 **Session 对象本身**交出去。
   *
   * 为什么需要它：宿主几个有用的读数（上下文压力、token 用量）是**按 Session 对象**
   * 取投影的（`stateOf(session, key)`），而 OMB 内部一律以 sessionId 为准。
   * 这个回调就是那个映射的**唯一采集点**——事件载荷的 `args[0]` 正是 Session 本身，
   * 不在这里拿，别处就只能靠 `ctx.get('sessions')` 反查（那条路要过 Cordis Guard，
   * 是兜底而非常路）。
   */
  readonly onHostSession?: (sessionId: string, session: unknown) => void
}): () => void {
  const { ctx, kernel, onToolResult, onHostSession } = options
  /** 见过的会话事件类型 → 次数（诊断用）。 */
  const sawEventTypes = new Map<string, number>()
  if (typeof ctx.on !== 'function') {
    kernel.logger.warn('OMB：宿主事件订阅不可用，认知层将只做注入不做观察（状态面已记录）')
    return () => {}
  }

  /**
   * **会话 → cwd 的唯一来源**。读一次拿住引用即可：它是内核自己 provide 的登记处
   * （`kernel/index.ts`），随内核存活，不是会被换掉的模块服务。
   */
  const activeSessions = (): { remember(session: string, cwd?: string): void } | undefined =>
    kernel.service<{ remember(session: string, cwd?: string): void }>(SERVICES.activeSession)

  const offs: (() => void)[] = []
  const safeOn = (event: string, fn: (...args: never[]) => void): void => {
    try {
      const returned = ctx.on?.(event, fn)
      if (typeof returned === 'function') offs.push(returned as () => void)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      kernel.logger.warn(`OMB：订阅 ${event} 失败——${message}`)
    }
  }

  safeOn('session/event', (async (...args: unknown[]) => {
    const [session, event] = args
    const sessionId = pickString(session, 'id') ?? ''
    const type = pickString(event, 'type')
    if (sessionId.length === 0) return

    // ① 会话的 cwd 是项目库身份的唯一来源。
    //    没有这一步，`stores.forSession()` 永远走"未登记 cwd"分支、
    //    只返回用户库，于是 `<cwd>/.omb/memory/` 在生产里永远不会被打开——
    //    "记忆随项目走"这条设计等于没生效。会话头在 `session/event` 里可取到。
    //
    //    **只写内核登记处**（唯一存放处）：状态面、记忆模块都从这里读，
    //    因此不存在"两处数字"的可能。这一次写同时更新"当前活跃会话"——
    //    事件里没带 cwd 时 `remember` 会按会话保留已知 cwd，绝不张冠李戴。
    //
    //    为什么必须由 `dsh/` 写进内核（而不是让模块自己订阅事件记）：
    //    模块经收养视图订阅 `turn/start` 时 `on` 优先绑**宿主**事件面，而下面
    //    `kernel.emit` 发在**内核总线**——两者永远碰不到且不报错。实测症状就是
    //    `omb_focus` 报"取不到当前会话标识"（详见 kernel/activeSession.ts）。
    const cwd = rememberCwdFrom(sessionId, session, activeSessions())

    // ② Session 对象本身交给度量桥。
    //    投影读数（上下文压力 / token 用量）按 Session 对象取，不按 id 取，
    //    所以这里存的是"宿主认识的那个对象"。回调在桥里已经整段 try/catch，
    //    外面再包一层是因为监听器是 async 的——抛出去会变成未处理的 rejection。
    try {
      onHostSession?.(sessionId, session)
    } catch (error) {
      kernel.logger.warn(`OMB：会话对象交接失败（度量将降级为"未测量"）——${String(error)}`)
    }

    if (type === undefined) return
    // 最后一次收到的会话事件类型（诊断）。
    // 用途：`omb_focus` 报"取不到会话"时，需要立刻分清是"事件没到"还是
    // "到了但字段取错"——两者的修法完全不同，而症状一模一样。
    sawEventTypes.set(type, (sawEventTypes.get(type) ?? 0) + 1)
    heartbeat('session-event', {
      type,
      hasSessionId: sessionId.length > 0,
      cwd: cwd ?? null,
      seen: Object.fromEntries(sawEventTypes),
    })
    const data = (event as { data?: unknown } | undefined)?.data
    switch (type) {
      // **DSH 的会话事件里没有 `turn/start` / `turn/end`** —— 这是本次实测纠正的
      // 一个错误假设：实际边界是 `step/start` / `step/end`
      // （`packages/core/session/src/known-event-types.ts`，心跳日志实测到
      // `step/start`/`step/end`/`tool/call`/`tool/result`/`request/header` 等）。
      //
      // 后果曾很具体：认知层从不发 `turn/start`，于是推理模块的
      // `lastActiveSession` 永远是 null → `omb_focus` 报"取不到当前会话标识"；
      // 上下文模块的拉取台账也永远是 0 轮。
      //
      // 一个 step 是"模型一轮内的单次工具往返"；把它当作回合边界对本用途是合适的
      // （要在每次往返后冲刷编码队列、刷新观测窗口）。
      case 'step/start': {
        const step = typeof data === 'object' && data !== null && 'step' in data
          && typeof (data as { step?: unknown }).step === 'number'
          ? (data as { step: number }).step
          : 0
        // 诊断：确认这一段真的被执行。
        // `omb_focus` 报"取不到会话"时，分叉点就在这：是这段没跑（事件类型不符），
        // 还是跑了但订阅者不在这个内核实例上。只有这里能分辨。
        heartbeat('step-start', { sessionId })
        kernel.emit('turn/start', { sessionId, turn: step })
        return
      }
      case 'step/end': {
        const step = typeof data === 'object' && data !== null && 'step' in data
          && typeof (data as { step?: unknown }).step === 'number'
          ? (data as { step: number }).step
          : 0
        kernel.emit('turn/end', { sessionId, turn: step })
        // 回合边界冲刷向量编码队列。
        //
        // **不驱动的话 `embedding` 表恒空**：写入侧会发 `memory/written`，
        // 但队列要有人冲——这与"拉取计数不接线则台账恒 0"是同一类失败：
        // 一条测量/处理链的中间环节没人接，表现为功能"看起来在工作但没有结果"。
        //
        // 带 limit 是刻意的：避免单个回合把大批积压一次编码完而卡住事件循环。
        void flushVectorEncoder(kernel, 32)
        return
      }
      case 'tool/call': {
        // 动作指纹：工具名 + 参数摘要。用于循环检测（同一动作重复即信号）
        const name = pickString(data, 'name') ?? 'unknown'
        const argsText = JSON.stringify((data as { arguments?: unknown })?.arguments ?? null)
        kernel.emit('evidence/observed', {
          sessionId,
          actionHash: fingerprint('call', name, argsText),
          evidenceHash: '',
          at: kernel.clock.now(),
        })
        return
      }
      default:
        return
    }
  }) as never)

  safeOn('tools/result', (async (...args: unknown[]) => {
    const [exec, result] = args
    const sessionId = pickString((exec as { agent?: { session?: unknown } } | undefined)?.agent?.session, 'id')
      ?? pickString(exec, 'sessionId')
      ?? ''
    if (sessionId.length === 0) return
    const callId = pickString(exec, 'callId')
    const text = extractText(result)
    kernel.emit('evidence/observed', {
      sessionId,
      actionHash: fingerprint('result', callId ?? ''),
      evidenceHash: fingerprint('evidence', text.slice(0, 512)),
      at: kernel.clock.now(),
    })

    // 拉取计数：**这是"拉取式设计"唯一的有效性证据**。
    // 不接线的话台账永远是 0，而杀死判据（"拉取次数/轮次长期趋近 0 → 删除该视图"）
    // 会把五个视图全部误判为待删除——把一条测量缺失变成一次错误决策。
    const toolName = pickString(exec, 'name') ?? pickString(exec, 'toolName') ?? ''
    if (toolName.length > 0) {
      try {
        kernel
          .service<{ recordPull?(tool: string, session: string): void }>(SERVICES.contextMetrics)
          ?.recordPull?.(toolName, sessionId)
      } catch {
        // 计量失败不得影响会话
      }
    }

    try {
      onToolResult?.({ sessionId, text, callId })
    } catch {
      // 观察者的失败不得影响会话
    }
  }) as never)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const off of offs.reverse()) {
      try {
        off()
      } catch {
        // H-1
      }
    }
    offs.length = 0
  }
}

/** 从工具结果里抽可读文本（形状跨版本可能变，尽力而为）。 */
export function extractText(result: unknown): string {
  if (typeof result === 'string') return result
  const content = (result as { content?: unknown } | undefined)?.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const text = pickString(block, 'text')
      if (text !== undefined) parts.push(text)
    }
    return parts.join('\n')
  }
  try {
    return JSON.stringify(result ?? '')
  } catch {
    return ''
  }
}

/** 便利：从宿主上下文取系统提示服务。 */
export function readSystemPrompt(ctx: HostContextLike): SystemPromptLike | undefined {
  return readService<SystemPromptLike>(ctx, 'systemPrompt')
}

/**
 * 冲刷向量编码队列。
 *
 * 由回合边界调用（见 `wireSessionEvents` 的 `turn/end`）。
 * **失败绝不抛**：编码是后台增益，不得影响会话；原因进健康面由模块自己报。
 */
export async function flushVectorEncoder(kernel: Kernel, limit: number): Promise<void> {
  try {
    const encoder = kernel.service<{ encodePending?(n?: number): Promise<unknown> }>(
      SERVICES.vectorEncoder,
    )
    await encoder?.encodePending?.(limit)
  } catch (error) {
    kernel.logger.warn(`OMB：向量编码冲刷失败（已隔离）——${String(error)}`)
  }
}
