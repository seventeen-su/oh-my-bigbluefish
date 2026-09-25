/**
 * 能力轴会话内存（决策 D4）。
 *
 * **这不是"默认不写存储"，是结构上没有写入的地方**：本类没有 store 参数、
 * 没有 flush、没有任何 I/O 依赖，只有内存 Map。因此"能力轴永不落盘"
 * 不依赖调用方自律，而是靠类型与依赖方向保证。
 *
 * 理由（D4 原文）：
 * ① 错误成本不对称——**高估用户会产生自信的错误帮助**；
 * ② 能力估计在心理测量学里成熟，但在智能体记忆里**未被迁移、未被评估**；
 * ③ "生活/陪伴"场景里对用户能力打分明确有害。
 *
 * 形态：能力观察只存在于当前会话内存 + `sessionProjections`。
 * 进程结束即消失——这是要求的形态，不是缺陷。
 *
 * 另一个硬约束来自宿主：`sessionProjections.apply` 必须**同步且返回同一引用**
 * （规划事实 G）。因此 `list()` 在内容未变时返回**同一个数组引用**。
 */
import type { Clock } from '../../kernel/abi/index.js'
import type { ProfileEntry } from './entries.js'
import { applyEntry } from './entries.js'

/** 单会话能力观察上限：内存驻留项必须有界（防止长会话无界增长）。 */
export const CAPABILITY_ENTRIES_PER_SESSION = 20

/** 共享的空快照：未观察过的会话拿到同一个冻结引用，便于投影做同一引用判断。 */
const EMPTY: readonly ProfileEntry[] = Object.freeze([])

export interface CapabilityObservation {
  readonly key: string
  readonly value: string
  readonly evidence?: readonly string[]
}

export class CapabilityMemory {
  readonly #clock: Clock
  readonly #maxPerSession: number
  readonly #bySession = new Map<string, readonly ProfileEntry[]>()

  constructor(deps: { readonly clock: Clock; readonly maxPerSession?: number }) {
    this.#clock = deps.clock
    this.#maxPerSession = Math.max(1, deps.maxPerSession ?? CAPABILITY_ENTRIES_PER_SESSION)
  }

  /**
   * 记录一条能力观察。返回该会话的最新快照（可能是同一引用）。
   *
   * 同键同值且证据未变 → **原样返回旧引用**：观察重复不该让会话投影的引用抖动。
   */
  observe(sessionId: string, observation: CapabilityObservation): readonly ProfileEntry[] {
    const current = this.#bySession.get(sessionId) ?? EMPTY
    const key = observation.key.trim()
    if (sessionId.length === 0 || key.length === 0) return current

    const evidence = observation.evidence ?? []
    const unchanged = current.some(
      entry => entry.key === key && entry.value === observation.value && entry.evidence.length === evidence.length,
    )
    if (unchanged) return current

    const entry: ProfileEntry = {
      axis: 'capability',
      key,
      value: observation.value,
      provenance: 'inferred',
      evidence,
      updated: this.#clock.now(),
    }
    // 复用同一套冲突消解：能力观察也不做静默裁决（同键异值 → 两条都在，会话内可见）
    const next = applyEntry(entry, current).entries
    const bounded = next.length > this.#maxPerSession ? next.slice(next.length - this.#maxPerSession) : next
    this.#bySession.set(sessionId, bounded)
    return bounded
  }

  /** 会话快照。未观察过的会话返回共享空引用。 */
  list(sessionId: string): readonly ProfileEntry[] {
    return this.#bySession.get(sessionId) ?? EMPTY
  }

  clearSession(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }

  /** 一键清空全部会话的能力观察（`clearDeduced` 会调用它）。 */
  clearAll(): void {
    this.#bySession.clear()
  }

  /** 条目总数（跨会话），供健康面与清空计数。 */
  entryCount(): number {
    let total = 0
    for (const entries of this.#bySession.values()) total += entries.length
    return total
  }

  sessionCount(): number {
    return this.#bySession.size
  }
}
