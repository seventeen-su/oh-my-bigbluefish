/**
 * 事件驱动记忆控制器（v4.7.0，决策 + 执行）。
 *
 * ## 为什么需要它
 *
 * 之前的主动性靠两样东西：常驻提示 + `proactive.ts` 的行内提示。它们提高的是
 * "模型注意到该记忆"的概率，但模型仍可能忽略、不查重、不 supersedes、或把临时
 * 任务约束写成长期记忆。控制器把"是否写/查/请求模型"做成**确定性事件状态机**：
 *
 * ```
 * user-message ─┐
 * tool-result  ─┼─→ reduceMemoryEvent → actions: persist | lookup | request-model | track-task | expire
 * turn-end     ─┘
 * ```
 *
 * ## 执行边界（dry-run 是回滚档）
 *
 * - 本模块**仍是纯 reducer**（零 I/O、零时钟、零 LLM）；
 * - `capture.ts` 在 `execute` 模式下执行动作：persist 走既有隐私/去重/生命周期
 *   写入并查回验证，lookup 走词法检索端口，request-model 只注入一行易变提示；
 * - `dry-run` 模式保留为回滚开关：只计数、不改写入路径。
 *
 * ## 安全闸门（硬规则，写在 reducer 里）
 *
 * - 临时/任务约束 → 只 `track-task`，TTL/回合结束过期，**永不** persist；
 * - 用户明确要求记住 → 可 persist（显式优先，assertedBy=user）；
 * - 长期偏好/稳定决策 → 非显式时只产生 `candidate`（写入 assertedBy=model，
 *   生命周期显示"候选"），不冒充 `confirmed`；
 * - 疑问句/命令/代码/无偏好标记 → 不产生 persist（与捕获路径同一份判据）；
 * - 纠正旧结论 → 只 `lookup` + `request-model`（旧 id 未拿到前不写 supersedes）；
 * - 工具结果 → 不产生记忆动作（项目证据由 project-evidence 单独处理）；
 * - 同一文本在会话内去重；候选/任务表有界；任务按 TTL 与回合结束双过期。
 */
import type { MemoryKind, MemoryScope } from '../../kernel/abi/index.js'
import { classifyMemoryIntent, isDurableIntent } from './intent.js'
import { hasPreferenceMarker, isCommandOrCode, isQuestion } from './message-filter.js'
import { hasSecret } from './secrets.js'

export type ControllerStage = 'confirmed' | 'candidate'

/**
 * 控制器的显式阶段（v4.13.0，系统化重构）。
 *
 * 状态由**当前表内容**决定，不另存影子变量：
 * - `idle`：没有候选也没有任务；
 * - `candidate-pending`：有候选等待写入/去重；
 * - `tracking-tasks`：有任务约束（TTL/回合结束过期）；
 * - `mixed`：两者都有（不同事件的到达顺序都能得到同一结论）。
 */
export type ControllerPhase = 'idle' | 'candidate-pending' | 'tracking-tasks' | 'mixed'

/** 最近一次事件转移（每个会话只留最后一条；有界，不进 ring）。 */
export interface ControllerTransition {
  readonly event: ControllerEvent['type']
  readonly from: ControllerPhase
  readonly to: ControllerPhase
  readonly actions: readonly ControllerAction['type'][]
  readonly at: number
}

export interface ControllerCandidate {
  /** 确定性 id（文本指纹），便于去重与审计。 */
  readonly id: string
  readonly text: string
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly stage: ControllerStage
  readonly at: number
  readonly reason: string
}

export interface ControllerTask {
  readonly text: string
  readonly at: number
  readonly expiresAt: number
}

export interface ControllerSessionState {
  readonly candidates: readonly ControllerCandidate[]
  readonly tasks: readonly ControllerTask[]
  readonly lastEventAt: number | null
  /** v4.13.0：显式阶段（由表内容推导，不独立存储额外事实）。 */
  readonly phase: ControllerPhase
  /** v4.13.0：最近一次转移（事件 → 阶段 → 动作类型）。 */
  readonly transition: ControllerTransition | null
}

export const EMPTY_CONTROLLER_STATE: ControllerSessionState = {
  candidates: [],
  tasks: [],
  lastEventAt: null,
  phase: 'idle',
  transition: null,
}

export type ControllerEvent =
  | { readonly type: 'user-message'; readonly text: string; readonly at: number }
  | { readonly type: 'tool-result'; readonly tool: string; readonly text: string; readonly at: number }
  | { readonly type: 'turn-end'; readonly at: number }
  | { readonly type: 'memory-written'; readonly text: string; readonly at: number }

export type ControllerAction =
  | { readonly type: 'persist'; readonly id: string; readonly candidate: ControllerCandidate; readonly explicit: boolean }
  | { readonly type: 'lookup'; readonly id: string; readonly query: string; readonly reason: string }
  | { readonly type: 'request-model'; readonly id: string; readonly hint: string; readonly reason: string }
  | { readonly type: 'track-task'; readonly id: string; readonly text: string; readonly expiresAt: number; readonly reason: string }
  | { readonly type: 'expire-task'; readonly id: string; readonly text: string; readonly reason: string }

export interface ControllerReduction {
  readonly state: ControllerSessionState
  readonly actions: readonly ControllerAction[]
}

/** 每会话候选上限（有界；控制器只服务当前对话）。 */
export const MAX_CONTROLLER_CANDIDATES = 8
/** 每会话任务约束上限。 */
export const MAX_CONTROLLER_TASKS = 8
/** 临时任务约束的最长存活时间（回合结束还会提前过期）。 */
export const CONTROLLER_TASK_TTL_MS = 2 * 60 * 60 * 1000
/** 单条用户消息上限（超长粘贴不做记忆决策）。 */
export const CONTROLLER_MAX_MESSAGE_CHARS = 600

const EXPLICIT_REMEMBER = /(记住|帮我记|记一下|别忘了|不要忘记|存一下|记下来)/u
const CORRECTION = /(不对|错了|不是这样|改主意|改成|改为|更正|修正|撤销|收回|之前说|上次说|更新一下)/u

function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `ctrl_${hash.toString(36)}`
}

/** 动作 id（v4.13.0）：同一输入得到同一 id，执行侧据此做幂等/审计。 */
function actionId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${fingerprint(parts.join('\u0000'))}`
}

/** 由表内容推导阶段（纯函数，不存影子变量）。 */
function derivePhase(state: Pick<ControllerSessionState, 'candidates' | 'tasks'>): ControllerPhase {
  const candidates = state.candidates.length > 0
  const tasks = state.tasks.length > 0
  if (candidates && tasks) return 'mixed'
  if (candidates) return 'candidate-pending'
  if (tasks) return 'tracking-tasks'
  return 'idle'
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function hasCandidate(state: ControllerSessionState, text: string): boolean {
  const key = normalize(text)
  return state.candidates.some(candidate => normalize(candidate.text) === key)
}

function addCandidate(state: ControllerSessionState, candidate: ControllerCandidate): ControllerSessionState {
  if (hasCandidate(state, candidate.text)) return state
  return {
    ...state,
    candidates: [candidate, ...state.candidates].slice(0, MAX_CONTROLLER_CANDIDATES),
  }
}

function addTask(state: ControllerSessionState, text: string, at: number, expiresAt: number): ControllerSessionState {
  const key = normalize(text)
  const tasks = state.tasks.filter(task => normalize(task.text) !== key)
  return {
    ...state,
    tasks: [{ text, at, expiresAt }, ...tasks].slice(0, MAX_CONTROLLER_TASKS),
  }
}

function reduceUserMessage(
  state: ControllerSessionState,
  event: Extract<ControllerEvent, { type: 'user-message' }>,
): ControllerReduction {
  const text = typeof event.text === 'string' ? event.text.trim() : ''
  if (text.length === 0 || text.length > CONTROLLER_MAX_MESSAGE_CHARS || hasSecret(text)) {
    return { state: { ...state, lastEventAt: event.at }, actions: [] }
  }

  const intent = classifyMemoryIntent(text)
  const explicit = EXPLICIT_REMEMBER.test(text)

  // ⓪ 形态闸门：疑问句/命令/代码不是长期陈述。
  // 判据与 `capture.ts` 的 `classifyUserMessage` 共用 `message-filter.ts`，避免
  // "控制器决定写、写入路径认为该跳过"的分裂（v4.7.0）。
  if (isQuestion(text) || isCommandOrCode(text)) {
    return { state: { ...state, lastEventAt: event.at }, actions: [] }
  }

  // ① 纠正旧结论优先：即使句子里有“先/这次”等临时词，也要先查旧 id，不能当任务约束吞掉。
  if (CORRECTION.test(text)) {
    return {
      state: { ...state, lastEventAt: event.at },
      actions: [
        { type: 'lookup', id: actionId('lk', 'correction', text.slice(0, 120)), query: text.slice(0, 120), reason: 'correction-needs-old-id' },
        {
          type: 'request-model',
          id: actionId('rm', 'correction'),
          hint: '纠正旧结论：先用 lookup 结果里的旧 id，再 omb_remember(supersedes)。',
          reason: 'correction',
        },
      ],
    }
  }

  // ② 临时/任务约束：只跟踪，回合结束过期；永不 persist。
  if (intent.intent === 'task-constraint' || intent.intent === 'temporary-instruction') {
    if (explicit) {
      return {
        state: { ...state, lastEventAt: event.at },
        actions: [{
          type: 'request-model',
          id: actionId('rm', 'explicit-temporary'),
          hint: '用户明确要求记住的是临时约束：请限定作用域/失效边界，不要写成长期偏好。',
          reason: 'explicit-temporary',
        }],
      }
    }
    const expiresAt = event.at + CONTROLLER_TASK_TTL_MS
    return {
      state: { ...addTask(state, text, event.at, expiresAt), lastEventAt: event.at },
      actions: [{
        type: 'track-task',
        id: actionId('tt', text),
        text,
        expiresAt,
        reason: `intent:${intent.intent}`,
      }],
    }
  }

  // ③ 长期偏好/稳定决策：显式记住 → confirmed；否则只在有偏好标记时成为 candidate。
  // 非显式却没有任何偏好标记 → 不写（与捕获路径的 `no-marker` 一致）。
  if (explicit || (isDurableIntent(intent.intent) && hasPreferenceMarker(text))) {
    const scope: MemoryScope = intent.intent === 'stable-decision' ? 'project' : 'user'
    const reason = explicit ? 'explicit-remember' : `intent:${intent.intent}`
    const candidate: ControllerCandidate = {
      id: fingerprint(text),
      text,
      scope,
      kind: 'semantic',
      stage: explicit ? 'confirmed' : 'candidate',
      at: event.at,
      reason,
    }
    if (hasCandidate(state, text)) {
      return { state: { ...state, lastEventAt: event.at }, actions: [] }
    }
    return {
      state: { ...addCandidate(state, candidate), lastEventAt: event.at },
      actions: [{ type: 'persist', id: candidate.id, candidate, explicit }],
    }
  }

  return { state: { ...state, lastEventAt: event.at }, actions: [] }
}

/**
 * 移除同文本候选（真实写入已覆盖）。
 *
 * 控制器在 persist 成功后会调用它，`memory-written` 事件也走同一判定——
 * 两处都必须用同一个规范化键，否则候选表会因为空格差异留下"幽灵候选"。
 */
export function clearControllerCandidate(
  state: ControllerSessionState,
  text: string,
): ControllerSessionState {
  const key = normalize(text)
  const candidates = state.candidates.filter(candidate => normalize(candidate.text) !== key)
  return {
    ...state,
    candidates,
    phase: derivePhase({ candidates, tasks: state.tasks }),
  }
}

/** 任务 TTL 到期：任何事件到达时先清算（回合结束仍会清空剩余任务）。 */
function sweepExpiredTasks(state: ControllerSessionState, now: number): ControllerReduction {
  const expired = state.tasks.filter(task => task.expiresAt <= now)
  if (expired.length === 0) return { state, actions: [] }
  return {
    state: { ...state, tasks: state.tasks.filter(task => task.expiresAt > now) },
    actions: expired.map(task => ({
      type: 'expire-task' as const,
      id: actionId('ex', task.text, 'ttl'),
      text: task.text,
      reason: 'ttl',
    })),
  }
}

/**
 * 纯 reducer：同一事件序列 → 同一状态与动作序列（无时钟、无 I/O、无 LLM）。
 *
 * 任务约束的过期有两条路径，动作 reason 不同，便于状态面区分：
 * - `ttl`：事件时间越过 `expiresAt`（会话空闲后再次活动）；
 * - `turn-end`：回合边界无条件清空。
 */
export function reduceMemoryEvent(
  state: ControllerSessionState,
  event: ControllerEvent,
): ControllerReduction {
  const from = state.phase
  const reduced = reduceCore(state, event)
  const to = derivePhase(reduced.state)
  return {
    state: {
      ...reduced.state,
      phase: to,
      transition: {
        event: event.type,
        from,
        to,
        actions: reduced.actions.map(action => action.type),
        at: event.at,
      },
    },
    actions: reduced.actions,
  }
}

function reduceCore(
  state: ControllerSessionState,
  event: ControllerEvent,
): ControllerReduction {
  if (event.type === 'turn-end') {
    const actions: ControllerAction[] = state.tasks.map(task => ({
      type: 'expire-task',
      id: actionId('ex', task.text, 'turn-end'),
      text: task.text,
      reason: 'turn-end',
    }))
    return { state: { ...state, tasks: [], lastEventAt: event.at }, actions }
  }

  // 其它事件先清算到期任务（TTL 是"时间到了"，不依赖回合是否结束）。
  const swept = sweepExpiredTasks(state, event.at)

  if (event.type === 'user-message') {
    const reduced = reduceUserMessage(swept.state, event)
    return { state: reduced.state, actions: [...swept.actions, ...reduced.actions] }
  }
  if (event.type === 'tool-result') {
    // 工具结果不是记忆动作；项目证据由 project-evidence 负责。
    return { state: { ...swept.state, lastEventAt: event.at }, actions: swept.actions }
  }
  // memory-written：移除同文本候选（已被真实写库路径覆盖）。
  return {
    state: { ...clearControllerCandidate(swept.state, event.text), lastEventAt: event.at },
    actions: swept.actions,
  }
}
