/**
 * 循环与空转检测（规划 §4.5；Wave 1 / R3 重写归并层）。
 *
 * 状态（滚动指纹窗口）由 `index.ts` 维护，**判定在这里是纯函数**。
 * 为什么必须由外部提供：模型自己看不见"我已经绕了三圈"。
 *
 * ## Wave 1 改了什么（v3.7 §2.3 / R3）
 *
 * v3.6 的归并假设"一次工具调用 = 一条 call 事件 + 紧跟着一条 result 事件"，
 * 用"上一条缺证据就补"来配对。真实接线里 DSH 每步平均 **1.27 次**工具调用
 * （49,440 / 39,081），同一批并发调用的 call 事件会先成批出现、result 才陆续到达：
 * 按"上一条缺证据"归并会把 A 的证据挂到 B 上，制造假的重复/无进展。
 *
 * 现在：
 * ① **callId 精确配对**：`tool/call` 与 `tools/result` 都带 `callId`（dsh 传出），
 *    证据只补到同 id 且还缺证据的那一条；
 * ② **surface 代际分区**：压缩/替换后 surface 代际 +1，旧代际的指纹整段丢弃
 *    （压缩后的循环判断不得沿用压缩前的窗口）；
 * ③ **注入迟滞**：同一信号 N 步内不重复注入（`announceLoop`），避免每轮重复刷同一句；
 * ④ 旧接线（没有 callId）仍走兜底归并：上一条缺证据就补——但不是主路径。
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
  /**
   * 同一步的调用 id（`tool/call.callId` / `tools/result` 对应的 callId）。
   * 缺省 `''` = 旧接线（没有 callId），归并走兜底路径。
   */
  readonly callId?: string
  /** surface 代际；缺省 0。压缩/替换后由 dsh 递增。 */
  readonly generation?: number
  /** 工具名（dsh 提供；只用于审计与提示文案，不参与判定）。 */
  readonly tool?: string
}

/**
 * 一次证据观察（`evidence/observed` 的模块内形状）。
 *
 * 与内核 ABI 的差别：`callId` / `generation` 是 Wave 1 由 `dsh/` 传出的**可选**
 * 运行期字段（ABI 本轮不改；Wave 2 再评估是否入 ABI）。缺省时退化为旧行为。
 */
export interface EvidenceObservation {
  readonly actionHash: string
  readonly evidenceHash: string
  readonly at: number
  readonly callId?: string
  /** 工具名（`tool/call` / result 侧由调用台账反查）。缺省 = 未知。 */
  readonly tool?: string
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
 * 自调离线进行（§4.4），运行时只记账。Wave 2 用日志标注再标定。
 */
export const DEFAULT_LOOP_THRESHOLDS: LoopThresholds = {
  flatEvidenceTurns: 3,
  oscillationCycles: 2,
  stalledRepeats: 3,
  stalledWindow: 5,
}

/** 提示字符上限：`hint` 是注入给模型的一句话，必须短。 */
export const LOOP_HINT_MAX = 80

/** 同一种信号在多少步内不重复注入（迟滞；Wave 1 / R3）。 */
export const LOOP_HYSTERESIS_STEPS = 5

/**
 * "无进展"信号：这两类说的是同一件事——**做了动作但没有新增证据**。
 *
 * 单列一个集合，是因为它有两个消费者，而它们必须判同一件事：
 * ① 注入侧的"合法出口"段（`hints.ts` 的 `renderExitOptions`）——
 *    无进展时才需要把出口写出来；
 * ② 状态面的会话行（直接复用同一个信号与 detail）。
 * 两处各写一份 kind 列表，就会出现"注入说这套、状态面说那套"的漂移。
 */
export const NO_PROGRESS_KINDS: readonly LoopKind[] = ['stalled', 'no-new-evidence']

/** 是不是"无进展"信号（空信号恒为 false）。 */
export function isNoProgressSignal(signal: LoopSignal | null | undefined): signal is LoopSignal {
  return signal !== null
    && signal !== undefined
    && (NO_PROGRESS_KINDS as readonly string[]).includes(signal.kind)
}

/** 滚动窗口默认保留的指纹数（够判定四类信号，且不随会话无限增长）。 */
export const DEFAULT_WINDOW_SIZE = 12

/** 追加一条指纹，保留最近 `max` 条。纯函数：返回新数组，不改入参。 */
export function appendFingerprint(
  window: readonly TurnFingerprint[],
  fingerprint: TurnFingerprint,
  max: number = DEFAULT_WINDOW_SIZE,
): readonly TurnFingerprint[] {
  const limit = limitOf(max)
  const next = [...(Array.isArray(window) ? window : []), normalize(fingerprint)]
  return cap(next, limit)
}

/**
 * 把一次"证据观察"并入滚动窗口——**一步 = 一个动作 + 它产生的证据**。
 *
 * 配对规则（按优先级）：
 * 1. **callId 精确配对**：证据哈希非空且带 callId → 找同 callId、还缺证据的那条，
 *    就地补上（并发调用的结果乱序到达也能对上）；
 * 2. **旧接线兜底**：证据不带 callId，且上一条正缺证据 → 就地补上；
 * 3. 其余情况追加新指纹（没有对应动作的结果也单独成步，例如用户消息）。
 *
 * `generation` 变化（压缩/替换后 dsh 递增）时，**旧代际的指纹整段丢弃**：
 * 压缩后的循环判断不得沿用压缩前的窗口。
 *
 * 空事件（动作与证据都空）不入账。
 */
export function noteObservation(
  window: readonly TurnFingerprint[],
  observation: EvidenceObservation | TurnFingerprint,
  max: number = DEFAULT_WINDOW_SIZE,
  generation: number = 0,
): readonly TurnFingerprint[] {
  const limit = limitOf(max)
  const gen = generationOf(generation)
  const sameGeneration = (Array.isArray(window) ? window : [])
    .filter(isFingerprint)
    .map(normalize)
    .filter(entry => entry.generation === gen)
  const next = normalize({ ...observation, generation: gen })

  if (next.actionHash === '' && next.evidenceHash === '') return cap(sameGeneration, limit)

  if (next.evidenceHash !== '') {
    const pending = pendingCallIndex(sameGeneration, next.callId ?? '')
    if (pending >= 0) {
      const merged = [...sameGeneration]
      const target = merged[pending] as TurnFingerprint
      merged[pending] = {
        ...target,
        evidenceHash: next.evidenceHash,
        at: next.at,
        ...(target.tool !== undefined && target.tool !== '' ? {} : next.tool === undefined ? {} : { tool: next.tool }),
      }
      return cap(merged, limit)
    }
    if ((next.callId ?? '') === '') {
      const last = sameGeneration[sameGeneration.length - 1]
      if (last !== undefined && last.evidenceHash === '') {
        const merged = [...sameGeneration]
        merged[merged.length - 1] = {
          ...last,
          evidenceHash: next.evidenceHash,
          at: next.at,
          ...(last.tool !== undefined && last.tool !== '' ? {} : next.tool === undefined ? {} : { tool: next.tool }),
        }
        return cap(merged, limit)
      }
    }
  }
  return cap([...sameGeneration, next], limit)
}

/** 注入迟滞状态：上一次注入过什么、在第几步。 */
export interface LoopAnnounceState {
  readonly kind: LoopKind | null
  readonly step: number
}

/** 空状态（**每会话**一份；`kind=null` 表示"没有注入过"）。 */
export const NO_ANNOUNCE: LoopAnnounceState = Object.freeze({ kind: null, step: 0 })

export interface LoopAnnouncement {
  readonly inject: boolean
  readonly state: LoopAnnounceState
}

/**
 * 迟滞判定：同一信号在 `gap` 步内不重复注入；信号变化或窗口到期才放行。
 *
 * 为什么需要它：v3.6 在信号持续期间**每一轮**都注入同一句提示（实测 553 个快照 /
 * 82 个会话），既占上下文又降低信噪比。迟滞是"发现时立刻说一次，之后冷却"。
 *
 * 纯函数；`step` 非法时按 0 处理。
 */
export function announceLoop(
  previous: LoopAnnounceState | null | undefined,
  signal: LoopSignal | null | undefined,
  step: number,
  gap: number = LOOP_HYSTERESIS_STEPS,
): LoopAnnouncement {
  const base = normalizeAnnounce(previous)
  const at = Number.isFinite(step) ? Math.floor(step) : 0
  if (signal === null || signal === undefined) {
    return { inject: false, state: base.kind === null ? base : { kind: null, step: at } }
  }
  if (base.kind !== signal.kind) {
    return { inject: true, state: { kind: signal.kind, step: at } }
  }
  const elapsed = at - base.step
  const cooldown = Number.isFinite(gap) ? Math.max(1, Math.floor(gap)) : LOOP_HYSTERESIS_STEPS
  if (elapsed >= cooldown) return { inject: true, state: { kind: signal.kind, step: at } }
  return { inject: false, state: base }
}

function pendingCallIndex(window: readonly TurnFingerprint[], callId: string): number {
  if (callId === '') return -1
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const entry = window[index]
    if (entry !== undefined && entry.callId === callId && entry.evidenceHash === '') return index
  }
  return -1
}

function cap(window: readonly TurnFingerprint[], limit: number): readonly TurnFingerprint[] {
  return window.length > limit ? window.slice(window.length - limit) : window
}

function limitOf(max: number): number {
  return Number.isFinite(max) ? Math.max(1, Math.floor(max)) : DEFAULT_WINDOW_SIZE
}

function generationOf(generation: unknown): number {
  return typeof generation === 'number' && Number.isFinite(generation) ? Math.max(0, Math.floor(generation)) : 0
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
  const window = (Array.isArray(recent) ? recent : []).filter(isFingerprint).map(normalize)
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
  const tool = last.tool === undefined || last.tool === '' ? '' : shortTool(last.tool)
  const toolText = tool === '' ? '' : `（${tool}）`
  return {
    kind: 'repeat-action',
    detail: `连续两步的动作与参数完全相同${toolText}（动作指纹 ${short(last.actionHash)}）`,
    hint: `这一步刚做过${toolText}，别原样再来一次；换参数或换个做法。`,
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

/** 工具名在提示里最多占 16 字符（hint 总上限 80）。 */
function shortTool(tool: string): string {
  return tool.length <= 16 ? tool : `${tool.slice(0, 15)}…`
}

function normalize(fingerprint: TurnFingerprint): TurnFingerprint {
  return {
    actionHash: String(fingerprint?.actionHash ?? ''),
    evidenceHash: String(fingerprint?.evidenceHash ?? ''),
    at: Number.isFinite(fingerprint?.at) ? fingerprint.at : 0,
    callId: typeof fingerprint?.callId === 'string' ? fingerprint.callId : '',
    generation: generationOf(fingerprint?.generation),
    tool: typeof fingerprint?.tool === 'string' ? fingerprint.tool : '',
  }
}

function normalizeAnnounce(state: LoopAnnounceState | null | undefined): LoopAnnounceState {
  if (state === null || state === undefined) return NO_ANNOUNCE
  const kind = typeof state.kind === 'string' ? state.kind : null
  return { kind: kind as LoopKind | null, step: Number.isFinite(state.step) ? Math.floor(state.step) : 0 }
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
