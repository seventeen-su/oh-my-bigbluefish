/**
 * 主动记忆检查点账本：把“用户刚说了值得长期保存的话”变成一次可见、可销账的提醒。
 *
 * 为什么不是再写一段静态提示：静态提示会被长上下文稀释，模型在任务中途不会主动回看。
 * 这里复用 DSH 的 `systemPrompt.context` 通道（与 Timeline 的进度提醒同构）：
 * - 用户消息出现 strong 信号时入队；
 * - 下一次 pre-step 立即显示检查点（含原文短句、要调用的工具、未记录原因）；
 * - 同一轮只显示一次，连续 3 步未销账升级再次显示；跨轮仍未写则标“上一轮未记录”；
 * - `omb_remember`/`omb_update` 成功后销账，检查点立即消失；
 * - 没有信号时不写任何文本，避免每轮都占预算。
 *
 * 这里只保存进程内会话态；DSH 重启后丢失是接受的，用户消息仍在会话日志/上下文里，
 * 下一次新消息会重新触发。检查点本身不写库、不自动写记忆，避免误判污染长期库。
 */
import { createHash } from 'node:crypto'
import {
  DURABLE_SIGNAL_LABELS,
  detectDurableSignals,
  type DurableSignal,
  type DurableSignalKind,
} from '../../packages/v7/src/domain/memory-signal.js'

export interface MemoryPosition {
  readonly turn?: number
  readonly step?: number
}

interface PendingSignal extends DurableSignal {
  readonly turn?: number
  readonly step?: number
  /** 超过这个轮次仍没有写入就过期，避免误判永久刷屏；新用户消息会重新入队。 */
  readonly expiresTurn?: number
  readonly seq: number
}

interface ShownCheckpoint {
  readonly key: string
  readonly turn?: number
  readonly step?: number
}

interface SessionMemory {
  readonly pending: PendingSignal[]
  lastUserHash?: string
  lastUserTurn?: number
  lastWriteTurn?: number
  shown?: ShownCheckpoint
  seq: number
}

const SESSION_LIMIT = 256
const PENDING_LIMIT = 4
/** 同一轮首次显示后，连续这么多步仍未写就再提醒一次。 */
const STALE_STEPS = 3
const MAX_EXCERPT = 140

function compact(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function excerpt(input: string): string {
  const text = compact(input)
  if (text.length <= MAX_EXCERPT) return text
  let end = MAX_EXCERPT
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

function kindLabel(kind: DurableSignalKind): string {
  return DURABLE_SIGNAL_LABELS[kind]
}

/**
 * 会话级检查点账本。所有方法失败都只影响提醒，不影响宿主主流程；调用方仍应 try/catch。
 */
export class MemoryCheckpointLedger {
  private readonly sessions = new Map<string, SessionMemory>()

  /** 观察一条**真实用户**消息；同一 turn 的同一文本只处理一次。 */
  observeUserMessage(sessionId: string, text: string, position: MemoryPosition = {}): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const state = this.stateOf(sessionId)
    const digest = hash(trimmed)
    if (state.lastUserHash === digest && state.lastUserTurn === position.turn) return
    state.lastUserHash = digest
    state.lastUserTurn = position.turn
    const signals = detectDurableSignals(trimmed, PENDING_LIMIT)
    if (signals.length === 0) return
    for (const signal of signals) {
      if (state.pending.some(item => item.text === signal.text && item.kind === signal.kind)) continue
      state.seq += 1
      state.pending.push({
        ...signal,
        ...(position.turn === undefined ? {} : { turn: position.turn }),
        ...(position.step === undefined ? {} : { step: position.step }),
        ...(position.turn === undefined ? {} : { expiresTurn: position.turn + 3 }),
        seq: state.seq,
      })
    }
    while (state.pending.length > PENDING_LIMIT) state.pending.shift()
    state.shown = undefined
  }

  /** 一次成功的 omb_remember/omb_update 销掉当前轮及更早的未记录信号。 */
  noteWrite(sessionId: string, position: MemoryPosition = {}): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    const writeTurn = position.turn ?? state.lastUserTurn
    state.lastWriteTurn = writeTurn
    const kept = writeTurn === undefined
      ? []
      : state.pending.filter(item => item.turn !== undefined && item.turn > writeTurn)
    state.pending.splice(0, state.pending.length, ...kept)
    state.shown = undefined
  }

  /**
   * 生成本次 pre-step 的检查点文本；空串表示不显示，并应覆盖写空以清掉旧文本。
   *
   * 显示策略：首次/信号变化/跨轮立即显示；同一轮同一信号只在连续 3 步未销账时再显示。
   */
  render(sessionId: string, position: MemoryPosition = {}): string {
    const state = this.sessions.get(sessionId)
    const turn = position.turn
    if (state !== undefined && turn !== undefined) {
      const kept = state.pending.filter(item => item.expiresTurn === undefined || turn < item.expiresTurn)
      state.pending.splice(0, state.pending.length, ...kept)
    }
    if (state === undefined || state.pending.length === 0) {
      if (state !== undefined) state.shown = undefined
      return ''
    }
    const missed = state.pending.some(item => (
      item.turn !== undefined && position.turn !== undefined && item.turn < position.turn
    ))
    const stale = state.pending.some(item => (
      item.step !== undefined && position.step !== undefined && position.step - item.step >= STALE_STEPS
    ))
    const signature = state.pending.map(item => `${item.kind}:${item.text}`).join('\u0000')
    const level = missed ? 'missed' : stale ? 'stale' : 'new'
    const key = `${signature}\u0000${level}`
    const shown = state.shown
    const sameTurn = shown !== undefined && shown.turn === position.turn
    const recentlyShown = sameTurn
      && shown.step !== undefined
      && position.step !== undefined
      && position.step - shown.step < STALE_STEPS
    // 同一轮已经显示过，且还没到升级步数：不重复占用提示预算。
    if (shown !== undefined && shown.key === key && recentlyShown) return ''
    state.shown = {
      key,
      ...(position.turn === undefined ? {} : { turn: position.turn }),
      ...(position.step === undefined ? {} : { step: position.step }),
    }
    return this.textOf(state, missed, stale)
  }

  /** 当前未记录条数；`omb_status`/诊断可读。 */
  pendingCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pending.length ?? 0
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    this.sessions.clear()
  }

  private textOf(state: SessionMemory, missed: boolean, stale: boolean): string {
    const lines = [
      `[OMB 记忆检查点${missed ? '｜上一轮未记录' : ''}]`,
      `用户已给出 ${state.pending.length} 条值得长期保存的信号，尚未写入：`,
      ...state.pending.map((item, index) => `${index + 1}. ${kindLabel(item.kind)}：${excerpt(item.text)}`),
      '请在最终回答前调用 omb_remember 写入（kind=memory, category=fact，attrs 至少含 title 与 body）；'
        + '如果这是已有状态机的变化，用 omb_update。若判定不需要长期保存，在回答中说明原因；不要只说“我会记住”。',
    ]
    if (missed) lines.push('上一轮已经出现过这些信号；先补写，再继续当前任务。')
    else if (stale) lines.push('已连续多步未记录；先补写，再继续当前任务。')
    return lines.join('\n')
  }

  private stateOf(sessionId: string): SessionMemory {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const state: SessionMemory = { pending: [], seq: 0 }
    this.sessions.set(sessionId, state)
    while (this.sessions.size > SESSION_LIMIT) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    return state
  }
}
