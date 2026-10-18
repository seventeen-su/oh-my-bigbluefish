/**
 * 记忆反馈与隐式效用（3.7 Wave 2 / R9 C1+C2）。
 *
 * ## 为什么是**命令**而不是工具
 *
 * 反馈是**用户的判断**（"这条错了/过时了"）。做成模型工具等于让模型给自己打分：
 * R9 §3.3 的证据是自偏好、自验证悬崖、不能自我纠错。因此这里是 `/omb-feedback`
 * 斜杠命令（宿主 `commands` 服务，与 `/omb-privacy` 同一路径），模型碰不到。
 *
 * ## 语义（R9 §3 C2：动作分级，不同轴分开动）
 *
 * | 动作 | 动哪个轴 | 可逆性 |
 * | --- | --- | --- |
 * | `useful` | 效用（α += 2）；若条目是被反馈归档的 → **复活** | 再 `stale`/`wrong` 可反向 |
 * | `wrong` | 真值轴：第一次只挂"待二次确认"；**不同会话**第二次才写 `valid_to` | `useful` 复活（只清反馈设置的 valid_to） |
 * | `stale` | 归档轴：最近未使用才写 `valid_to`（可逆归档；不删行） | `useful` 复活 |
 * | `noise` | 只降权（β += 1），**不归档** | 无需撤销（下一次 `useful` 抵消） |
 *
 * 三条硬约束：① 未知 id 拒绝；② 隐私闸门先判（sealed 不读不写、read-only 不写）；
 * ③ 只增审计日志（`memory_feedback`），撤销靠反向动作而不是删日志。
 */
import type { Kernel, MemoryScope, TaggedStore } from '../../kernel/abi/index.js'
import type { CommandInvocationLike, CommandResultLike } from './privacy/command.js'
import { sessionOfInvocation } from './privacy/command.js'
import { asUtilityStore, type FeedbackAction, type UtilityStoreApi } from './store.js'
import { extractEntityKeys, sharedEntityKeys } from './link.js'

/** 命令名（用户手打；模型看不到）。 */
export const FEEDBACK_COMMAND_NAME = 'omb-feedback'
export const FEEDBACK_COMMAND_ID = 'omb-memory/feedback'

export const FEEDBACK_USAGE =
  '用法：/omb-feedback <记忆id> [useful|wrong|stale|noise|revive]'
  + '（不带动作 = 查看该条的状态与最近反馈；'
  + 'wrong 需在另一个会话再确认一次才会归档；stale 是"最近未使用才归档"；'
  + 'noise 只降权；撤销：/omb-feedback <id> useful 或 revive）'

const ACTIONS: readonly FeedbackAction[] = ['useful', 'wrong', 'stale', 'noise', 'revive']
/** 命令里允许的"查看"形态（不带动作）。 */
const SHOW_ONLY = 'show'

export type FeedbackRequest =
  | { readonly ok: true; readonly id: string; readonly action: FeedbackAction | typeof SHOW_ONLY }
  | { readonly ok: false; readonly error: string }

/** 解析命令参数。**不抛**；纯函数。 */
export function parseFeedbackArgs(raw: string): FeedbackRequest {
  const tokens = (typeof raw === 'string' ? raw : '').trim().split(/\s+/).filter(token => token.length > 0)
  if (tokens.length === 0) return { ok: false, error: FEEDBACK_USAGE }
  const id = tokens[0] as string
  if (tokens.length === 1) return { ok: true, id, action: SHOW_ONLY }
  if (tokens.length > 2) return { ok: false, error: `多余的参数：${tokens.slice(2).join(' ')}。${FEEDBACK_USAGE}` }
  const action = (tokens[1] as string).toLowerCase()
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `未知动作 ${JSON.stringify(tokens[1])}；可选：${ACTIONS.join(' / ')}` }
  }
  return { ok: true, id, action: action as FeedbackAction }
}

/** 宿主 commands 服务的最小结构面（与 privacy/index.ts 同一形状）。 */
interface CommandsLike {
  register(definition: {
    readonly definitionId: string
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): unknown
}

/** 命令执行依赖（由 `modules/memory/index.ts` 装配）。 */
export interface FeedbackDeps {
  readonly clock: { now(): number }
  /** 本次调用的会话可用库（与 `omb_recall` 同一解析口径；id 两个作用域都查）。 */
  readonly resolveStores: (sessionId: string | undefined) => readonly TaggedStore[] | undefined
  /** 隐私闸门（结构面；缺省视为无闸门——单测可省，生产一定给）。 */
  readonly privacy?: () => {
    decide(sessionId: string): { readonly allowRead: boolean; readonly allowWrite: boolean }
    decideUnattributed(): { readonly allowRead: boolean; readonly allowWrite: boolean }
  } | undefined
  readonly logger?: { info(message: string): void; warn(message: string): void }
  /** 命令结果观测口（健康面按动作计数；绝不改变命令结果）。 */
  readonly onFeedback?: (info: {
    readonly action: FeedbackAction
    readonly change: string
    readonly sessionId: string | null
  }) => void
}

export interface FeedbackInstallation {
  readonly commandState: () => string
  dispose(): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从各库找 id（返回记录与所属库；找不到 undefined）。 */
async function findRecord(
  stores: readonly TaggedStore[],
  id: string,
): Promise<{ readonly store: TaggedStore; readonly record: { readonly id: string; readonly scope: MemoryScope } } | undefined> {
  for (const tagged of stores) {
    try {
      const found = await tagged.store.getMany([id])
      const record = found.find(candidate => candidate.id === id)
      if (record !== undefined) return { store: tagged, record }
    } catch {
      // 单库失败不拦：另一个库可能还有这条
    }
  }
  return undefined
}

function actionTitle(action: FeedbackAction): string {
  switch (action) {
    case 'useful': return 'useful（效用 +，并可能复活归档）'
    case 'wrong': return 'wrong（真值：需二次确认）'
    case 'stale': return 'stale（可逆归档候选）'
    case 'noise': return 'noise（只降权）'
    case 'revive': return 'revive（撤销反馈归档）'
    case 'archive': return 'archive（内部：写 valid_to）'
  }
}

/** 反馈回执：说清"改了什么、当前状态、怎么撤销"。 */
export function renderFeedbackResult(input: {
  readonly id: string
  readonly scope: MemoryScope
  readonly action: FeedbackAction
  readonly result: Awaited<ReturnType<UtilityStoreApi['recordFeedback']>>
  readonly replayed: boolean
}): string {
  const { result } = input
  const counters = result.counters
  const lines: string[] = [
    `反馈已记录：${input.id}（${input.scope}） · 动作 ${actionTitle(input.action)}`,
  ]
  const effect: Record<string, string> = {
    useful: '效用 +1',
    'wrong-pending': '已挂"待二次确认"（**未改真值**）——请在另一个会话再执行一次 /omb-feedback <id> wrong 才会归档',
    'wrong-confirmed': '第二次独立确认：已写 valid_to（非破坏性 supersede；正文与溯源保留）',
    'stale-archived': '最近未使用 → 已可逆归档（valid_to；不删行）',
    'stale-recorded': '仅记录负信号（最近使用过或已失效：不归档）',
    noise: '只降权（β += 1），未归档',
    revive: result.revived ? '已撤销归档：valid_to 已清除，条目回到可注入' : '不是反馈归档（或已被其它记忆取代）：未改动真值',
    'not-found': '未找到该 id（跨库查询后仍不存在）',
  }
  lines.push(`结果：${effect[result.change] ?? result.change}`)
  lines.push(
    `当前：曝光 ${counters.exposed} / 使用 ${counters.used} / useful ${counters.useful} / wrong ${counters.wrong} / stale ${counters.stale} / noise ${counters.noise}`,
  )
  if (counters.archivedAt !== null) {
    lines.push(`归档：${counters.archiveReason ?? '未知原因'}（at ${counters.archivedAt}）`)
  }
  if (input.action === 'wrong' && result.change === 'wrong-pending') {
    lines.push('撤销：/omb-feedback <id> useful（清除待确认并加正反馈）')
  } else if (result.archived) {
    lines.push('撤销：/omb-feedback <id> useful 或 /omb-feedback <id> revive（只清反馈设置的 valid_to）')
  } else {
    lines.push('撤销：/omb-feedback <id> useful（加正反馈，抵消负信号）')
  }
  if (input.replayed) lines.push('（本动作是重复执行：计数照实累加，审计日志保留每一次）')
  return lines.join('\n')
}

/** 状态视图：计数 + 最近 3 条反馈（审计）。 */
export async function renderFeedbackStatus(
  id: string,
  scope: MemoryScope,
  api: UtilityStoreApi,
): Promise<string> {
  const [row] = await api.utilityStats([id])
  const log = await api.feedbackLog(id, 3)
  const lines = [
    `记忆 ${id}（${scope}）`,
    row === undefined
      ? '效用账本：无行（从未曝光；utility = 基率 0.2）'
      : `效用账本：曝光 ${row.exposed} / 使用 ${row.used} / useful ${row.useful} / wrong ${row.wrong} / stale ${row.stale} / noise ${row.noise}` +
        (row.pendingWrongAt === null ? '' : `；待二次确认 wrong（首个确认会话 ${row.pendingWrongSession ?? '未知'}）`) +
        (row.archivedAt === null ? '' : `；归档 ${row.archiveReason ?? '未知'}（at ${row.archivedAt}）`),
    log.length === 0 ? '最近反馈：无' : `最近反馈：${log.map(entry => `${entry.action}@${entry.at}${entry.detail === null ? '' : `（${entry.detail}）`}`).join('；')}`,
    '可用动作：useful / wrong / stale / noise / revive',
  ]
  return lines.join('\n')
}

/**
 * 执行一次命令（纯装配：解析 → 隐私 → 跨库定位 → 写账本 → 回执）。
 *
 * 绝不抛；任何失败都返回可读错误。
 */
export async function runFeedbackCommand(
  raw: string,
  sessionId: string | null,
  deps: FeedbackDeps,
): Promise<CommandResultLike> {
  try {
    const parsed = parseFeedbackArgs(raw)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }

    // ① 隐私闸门：sealed 不读不写；read-only 不写；归属未知按"禁写不禁读"。
    let decision: { allowRead: boolean; allowWrite: boolean } = { allowRead: true, allowWrite: true }
    try {
      const gate = deps.privacy?.()
      if (gate !== undefined) {
        decision = sessionId === null ? gate.decideUnattributed() : gate.decide(sessionId)
      }
    } catch {
      decision = { allowRead: false, allowWrite: false }
    }
    if (!decision.allowRead) {
      return { kind: 'error', text: '当前会话处于 sealed（禁读禁写）隐私模式：反馈命令不读取记忆库，也不改动任何条目。' }
    }
    if (parsed.action !== SHOW_ONLY && !decision.allowWrite) {
      return {
        kind: 'error',
        text: '当前会话处于 read-only/未知归属：反馈会写库，已拒绝（反馈不能放宽隐私）。用 /omb-privacy normal 解除写限制后再试。',
      }
    }

    const stores = deps.resolveStores(sessionId ?? undefined)
    if (stores === undefined || stores.length === 0) {
      return { kind: 'error', text: '记忆服务未就绪：没有可查的库（omb-memory 未挂载或项目库尚未打开）。' }
    }
    const found = await findRecord(stores, parsed.id)
    if (found === undefined) {
      return { kind: 'error', text: `未知 id：${parsed.id}。跨用户库/项目库都没有这条记忆（不会按"最近一条"猜）。` }
    }
    const api = asUtilityStore(found.store.store)
    if (api === undefined) {
      return { kind: 'error', text: '当前库不支持效用账本（旧实现）：反馈无法记录，未改动任何数据。' }
    }

    if (parsed.action === SHOW_ONLY) {
      return { kind: 'success', text: await renderFeedbackStatus(parsed.id, found.record.scope, api) }
    }

    const at = deps.clock.now()
    const replay = (await api.feedbackLog(parsed.id, 1))[0]
    const result = await api.recordFeedback({ memoryId: parsed.id, action: parsed.action, sessionId, at })
    if (result.change === 'not-found') {
      return { kind: 'error', text: `未知 id：${parsed.id}（记录在写入账本前被删除？未改动任何数据）。` }
    }
    const text = renderFeedbackResult({
      id: parsed.id,
      scope: found.record.scope,
      action: parsed.action,
      result,
      replayed: replay !== undefined && replay.action === parsed.action,
    })
    try {
      deps.onFeedback?.({ action: parsed.action, change: result.change, sessionId })
    } catch {
      // 观测口失败不影响反馈结果
    }
    deps.logger?.info(`OMB 反馈：${sessionId ?? '未知会话'} ${parsed.id} ${parsed.action} → ${result.change}`)
    return { kind: 'success', text }
  } catch (error) {
    deps.logger?.warn(`OMB 反馈命令失败（已隔离）：${messageOf(error)}`)
    return { kind: 'error', text: `反馈命令执行失败（已隔离，未改动任何数据）：${messageOf(error)}` }
  }
}

/**
 * 装配 `/omb-feedback`（通过宿主 `commands` 服务；不可用则如实记录原因）。
 */
export function installFeedback(kernel: Kernel, deps: FeedbackDeps): FeedbackInstallation {
  const disposers: (() => void)[] = []
  let commandState = '（尚未尝试注册）'
  try {
    const commands = kernel.service<CommandsLike>('commands')
    if (commands === undefined || typeof commands.register !== 'function') {
      commandState = '**未注册**：宿主 commands 服务不可用（行缺 inject: commands？）'
      deps.logger?.warn('OMB 反馈：宿主 commands 服务不可用——/omb-feedback 在界面里不可用（记忆功能不受影响）。')
    } else {
      const returned = commands.register({
        definitionId: FEEDBACK_COMMAND_ID,
        name: FEEDBACK_COMMAND_NAME,
        description: '对记忆条目给一次显式反馈（useful / wrong / stale / noise；不新增模型工具）',
        input: { hint: '<记忆id> [useful | wrong | stale | noise | revive]' },
        handler: (invocation: CommandInvocationLike): Promise<CommandResultLike> => {
          const session = sessionOfInvocation(invocation)
          const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
          return runFeedbackCommand(raw, session.sessionId, deps)
        },
      })
      if (typeof returned === 'function') disposers.push(returned as () => void)
      commandState = `已注册（宿主返回 ${typeof returned}）`
    }
  } catch (error) {
    commandState = `**未注册**：注册抛错——${messageOf(error)}`
    deps.logger?.warn(`OMB 反馈：命令注册失败（已隔离）——${messageOf(error)}`)
  }
  return {
    commandState: () => commandState,
    dispose(): void {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 幂等、不抛（H-1）
        }
      }
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 隐式使用（used_tool）：曝光后工具调用命中实体键 → 记 used
// ────────────────────────────────────────────────────────────────────────────

/** 一条已曝光的记忆（跟踪器内部）。 */
interface Exposure {
  readonly memoryId: string
  readonly keys: readonly string[]
  readonly at: number
}

export interface UsageTracker {
  /** 记一次召回曝光（每会话保留最近 `EXPOSURE_WINDOW` 条）。 */
  noteExposure(sessionId: string, items: readonly { readonly id: string; readonly text: string }[], at: number): void
  /**
   * 匹配一次工具调用：与最近曝光条目共享 ≥2 个实体键（或 1 个足够长的路径键）→ used。
   * 返回命中的 memory id（调用方负责写账本）。
   */
  matchToolCall(sessionId: string, tool: string, args: string): readonly string[]
  stats(): { readonly exposed: number; readonly used: number }
  forget(sessionId: string): void
}

/** 每会话保留多少条曝光用于匹配。 */
export const EXPOSURE_WINDOW = 30
/** 匹配成功所需的最少共享键（与自动连边同阈值）。 */
export const USED_MIN_SHARED_KEYS = 2
/** 单个路径键成立的最短长度（`src/a.ts` 这种短名不单独算"用了这条"）。 */
export const USED_LONE_KEY_MIN_CHARS = 12

export function createUsageTracker(): UsageTracker {
  const sessions = new Map<string, Exposure[]>()
  let exposed = 0
  let used = 0
  const stateOf = (sessionId: string): Exposure[] => {
    let list = sessions.get(sessionId)
    if (list === undefined) {
      if (sessions.size >= 64) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
      list = []
      sessions.set(sessionId, list)
    }
    return list
  }
  return {
    noteExposure(sessionId, items, at) {
      const list = stateOf(sessionId)
      for (const item of items) {
        list.push({ memoryId: item.id, keys: extractEntityKeys(item.text), at })
        exposed += 1
      }
      while (list.length > EXPOSURE_WINDOW) list.shift()
    },
    matchToolCall(sessionId, tool, args) {
      const list = sessions.get(sessionId)
      if (list === undefined || list.length === 0) return []
      const haystack = `${tool} ${args}`
      const keys = extractEntityKeys(haystack)
      if (keys.length === 0) return []
      const matched = new Set<string>()
      for (const exposure of list) {
        if (exposure.keys.length === 0) continue
        const shared = sharedEntityKeys(exposure.keys, keys)
        const strongPath = shared.some(key => key.startsWith('path:') && key.length - 5 >= USED_LONE_KEY_MIN_CHARS)
        if (shared.length >= USED_MIN_SHARED_KEYS || strongPath) matched.add(exposure.memoryId)
      }
      used += matched.size
      return [...matched].sort()
    },
    stats: () => ({ exposed, used }),
    forget(sessionId) {
      sessions.delete(sessionId)
    },
  }
}
