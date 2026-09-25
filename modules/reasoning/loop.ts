/**
 * 循环与空转检测（规划 §4.5）——本组件**唯一带状态**的机制的外部形式：
 * 状态（滚动指纹窗口）由 `index.ts` 维护，**判定在这里是纯函数**。
 *
 * 为什么必须由外部提供：模型自己看不见"我已经绕了三圈"。
 *
 * 四类信号**领域中立**——指纹只有"做了什么"（动作哈希）与"知道了什么"
 * （证据哈希），因此"编程里重复同一条命令"、"生活建议里重复同一套说辞"、
 * "情感陪伴里反复给同一个安慰"是同一现象，不需要各自的检测器。
 */
import type { SessionRef } from '../../kernel/abi/index.js'

export type LoopKind = 'repeat-action' | 'no-new-evidence' | 'oscillation' | 'stalled'

export interface LoopSignal {
  readonly kind: LoopKind
  /** 判定依据（含轮数/次数），供审计与状态面；**不得为空**。 */
  readonly detail: string
  /** 注入给模型的一句话提示（≤ 80 字符）。 */
  readonly hint: string
}

/** 回合指纹。`actionHash` = 工具名 + 参数摘要；`evidenceHash` = 新增的可观察事实。 */
export interface TurnFingerprint {
  readonly actionHash: string
  readonly evidenceHash: string
  readonly at: number
}

export interface LoopThresholds {
  /** 连续几轮证据不变算 `no-new-evidence`。 */
  readonly flatEvidenceTurns: number
  /** 来回几次算振荡：2 次 = A→B→A→B。 */
  readonly oscillationCycles: number
  /** 同一动作在观察窗口里出现几次算"反复表达"。 */
  readonly stalledRepeats: number
  /** `stalled` 的观察窗口（最近几条指纹）。 */
  readonly stalledWindow: number
}

/**
 * 缺省阈值。它们是**可调参数而不是标定过的真理**：
 * 自调离线进行（§4.4），运行时只记账。
 */
export const DEFAULT_LOOP_THRESHOLDS: LoopThresholds = {
  flatEvidenceTurns: 3,
  oscillationCycles: 2,
  stalledRepeats: 3,
  stalledWindow: 5,
}

/** 提示字符上限：`hint` 是注入给模型的一句话，必须短。 */
export const LOOP_HINT_MAX = 80

/** 滚动窗口默认保留的指纹数（够判定四类信号，且不随会话无限增长）。 */
export const DEFAULT_WINDOW_SIZE = 12

/** 追加一条指纹，保留最近 `max` 条。纯函数：返回新数组，不改入参。 */
export function appendFingerprint(
  window: readonly TurnFingerprint[],
  fingerprint: TurnFingerprint,
  max: number = DEFAULT_WINDOW_SIZE,
): readonly TurnFingerprint[] {
  const limit = limitOf(max)
  const next = [...window, normalize(fingerprint)]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * 把一次"证据观察"并入滚动窗口——**一步 = 一个动作 + 它产生的证据**。
 *
 * 集成层对一次工具调用会发**两条** `evidence/observed`（`dsh/session.ts`）：
 * ① `tool/call`：动作指纹，`evidenceHash` 为空（"发生了这个动作，证据还没到"）
 * ② `tools/result`：证据指纹（动作哈希是结果指纹，不是动作本身）
 *
 * 因此这里做归并，而不是无脑追加：
 * - 证据哈希非空、且上一条正缺证据 → **就地补上证据**（同一个步骤，不新增）
 * - 证据哈希为空 → 新动作开始，追加一条待补证据的指纹
 * - 其余 → 追加新指纹
 *
 * 不做这一步归并，"连续两次同动作"与"连续 k 轮无新证据"在真实接线里
 * 会永远对不上号：调用与其结果会把窗口交替填满。
 */
export function noteObservation(
  window: readonly TurnFingerprint[],
  observation: TurnFingerprint,
  max: number = DEFAULT_WINDOW_SIZE,
): readonly TurnFingerprint[] {
  const limit = limitOf(max)
  const next = normalize(observation)
  const last = window[window.length - 1]

  if (next.evidenceHash !== '' && last !== undefined && last.evidenceHash === '') {
    const merged = [...window.slice(0, -1), { ...last, evidenceHash: next.evidenceHash, at: next.at }]
    return merged.length > limit ? merged.slice(merged.length - limit) : merged
  }
  if (next.actionHash === '' && next.evidenceHash === '') {
    // 空事件不入账：它既不表示动作，也不表示新证据
    return window.length > limit ? window.slice(window.length - limit) : [...window]
  }
  return appendFingerprint(window, next, limit)
}

function limitOf(max: number): number {
  return Number.isFinite(max) ? Math.max(1, Math.floor(max)) : DEFAULT_WINDOW_SIZE
}

/**
 * 检测循环信号。**优先级：repeat-action → oscillation → stalled → no-new-evidence**，
 * 先报最具体的诊断（"这一步刚做过"比"在原地打转"更可行动）。
 *
 * 返回 `null` = 没有信号（正常推进）。判定只用动作与证据两个哈希，不需要领域知识。
 */
export function detectLoop(
  recent: readonly TurnFingerprint[],
  thresholds: Partial<LoopThresholds> = {},
): LoopSignal | null {
  const t = { ...DEFAULT_LOOP_THRESHOLDS, ...clean(thresholds) }
  const window = recent.filter(isFingerprint).map(normalize)
  if (window.length === 0) return null

  const repeat = detectRepeatAction(window)
  if (repeat !== null) return repeat

  const oscillation = detectOscillation(window, t.oscillationCycles)
  if (oscillation !== null) return oscillation

  const stalled = detectStalled(window, t)
  if (stalled !== null) return stalled

  return detectNoNewEvidence(window, t.flatEvidenceTurns)
}

/** 注入用的渲染：无信号返回空串（**不注入任何东西**，不是注入"没有信号"）。 */
export function renderLoopSignal(signal: LoopSignal | null): string {
  return signal === null ? '' : `（检测到循环）${signal.hint}`
}

/** 连续两步动作+参数完全相同 → "这一步刚做过"。 */
function detectRepeatAction(window: readonly TurnFingerprint[]): LoopSignal | null {
  const last = window[window.length - 1]
  const prev = window[window.length - 2]
  if (last === undefined || prev === undefined) return null
  if (last.actionHash === '' || last.actionHash !== prev.actionHash) return null
  return {
    kind: 'repeat-action',
    detail: `连续两步的动作与参数完全相同（动作指纹 ${short(last.actionHash)}）`,
    hint: '这一步刚做过，别原样再来一次；换参数或换个做法。',
  }
}

/** A→B→A→B：在两种做法之间来回。 */
function detectOscillation(window: readonly TurnFingerprint[], cycles: number): LoopSignal | null {
  const span = Math.max(2, Math.floor(cycles)) * 2
  if (window.length < span) return null
  const tail = window.slice(window.length - span)
  const first = tail[0]
  const second = tail[1]
  if (first === undefined || second === undefined) return null
  if (first.actionHash === '' || second.actionHash === '') return null
  if (first.actionHash === second.actionHash) return null
  for (let i = 0; i < tail.length; i += 1) {
    const entry = tail[i]
    const expected = i % 2 === 0 ? first : second
    if (entry === undefined || entry.actionHash !== expected.actionHash) return null
  }
  const times = Math.floor(span / 2)
  return {
    kind: 'oscillation',
    detail: `在两种动作之间来回 ${times} 次（${short(first.actionHash)} ↔ ${short(second.actionHash)}）`,
    hint: '你在两种做法之间来回，需要第三个选项或先向用户确认。',
  }
}

/**
 * 同一意图反复表达但无进展。
 *
 * 指纹里没有"意图"字段，因此这里用它的可观测代理：**同一个动作在观察窗口内
 * 非相邻地重复出现 ≥ `stalledRepeats` 次，且窗口内没有任何新证据**。
 * 相邻重复会被 `repeat-action` 先接走，所以这条报的是"绕了一圈又回来"。
 */
function detectStalled(window: readonly TurnFingerprint[], t: LoopThresholds): LoopSignal | null {
  const size = Math.max(2, Math.floor(t.stalledWindow))
  const need = Math.max(2, Math.floor(t.stalledRepeats))
  if (window.length < need) return null
  const tail = window.slice(Math.max(0, window.length - size))
  const counts = new Map<string, number>()
  for (const entry of tail) {
    if (entry.actionHash === '') continue
    counts.set(entry.actionHash, (counts.get(entry.actionHash) ?? 0) + 1)
  }
  let topHash = ''
  let topCount = 0
  for (const [hash, count] of counts) {
    if (count > topCount) {
      topHash = hash
      topCount = count
    }
  }
  if (topCount < need) return null
  // 无进展：窗口内证据哈希全同（含"全是空"——那就是什么都没学到）
  const evidence = new Set(tail.map(entry => entry.evidenceHash))
  if (evidence.size > 1) return null
  return {
    kind: 'stalled',
    detail: `最近 ${tail.length} 步里同一动作出现 ${topCount} 次（动作指纹 ${short(topHash)}），且没有新证据`,
    hint: '同一件事反复表达但没进展，先确认目标是否理解一致。',
  }
}

/** 连续 k 轮证据哈希不变 → "在原地打转，换个方向"。 */
function detectNoNewEvidence(window: readonly TurnFingerprint[], turns: number): LoopSignal | null {
  const k = Math.max(2, Math.floor(turns))
  if (window.length < k) return null
  const tail = window.slice(window.length - k)
  const first = tail[0]
  if (first === undefined) return null
  const flat = tail.every(entry => entry.evidenceHash === first.evidenceHash)
  if (!flat) return null
  return {
    kind: 'no-new-evidence',
    detail: `连续 ${k} 轮没有新增证据（证据哈希 ${first.evidenceHash === '' ? '空' : short(first.evidenceHash)} 未变）`,
    hint: '连续几轮没有新证据，在原地打转；换个方向或直接说不确定。',
  }
}

function short(hash: string): string {
  return hash.length <= 8 ? hash : hash.slice(0, 8)
}

function normalize(fingerprint: TurnFingerprint): TurnFingerprint {
  return {
    actionHash: String(fingerprint.actionHash ?? ''),
    evidenceHash: String(fingerprint.evidenceHash ?? ''),
    at: Number.isFinite(fingerprint.at) ? fingerprint.at : 0,
  }
}

function isFingerprint(value: unknown): value is TurnFingerprint {
  return typeof value === 'object' && value !== null && 'actionHash' in value
}

/** 只在阈值合法时才保留；可变视图用于构造（`Partial<T>` 会保留 readonly 修饰符）。 */
type MutableThresholds = { -readonly [K in keyof LoopThresholds]?: LoopThresholds[K] }

/** 只接受 ≥2 的有限数阈值；非法值回落缺省（纯函数不抛，也不静默用 NaN 判定）。 */
function clean(thresholds: Partial<LoopThresholds>): Partial<LoopThresholds> {
  const out: MutableThresholds = {}
  for (const key of ['flatEvidenceTurns', 'oscillationCycles', 'stalledRepeats', 'stalledWindow'] as const) {
    const value = thresholds[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 2) out[key] = Math.floor(value)
  }
  return out
}

/** 会话 → 滚动窗口的键类型别名（供 `index.ts` 的窗口表使用）。 */
export type SessionWindows = ReadonlyMap<SessionRef, readonly TurnFingerprint[]>
