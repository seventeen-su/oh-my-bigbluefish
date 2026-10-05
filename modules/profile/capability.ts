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
 * 形态：能力观察**只存在于当前会话内存**，进程结束即消失——这是要求的形态，
 * 不是缺陷。
 *
 * ⚠️ **删掉的一句假承诺**：这里曾经写着"只存在于当前会话内存 + `sessionProjections`"。
 * 那个投影**不存在**——全仓没有任何地方为能力观察注册 `sessionProjections`
 * 投影（`dsh/pressure.ts` 注册的那份只服务上下文压力）。本项目的硬规则是
 * **不许留下与实现不符的承诺**：承诺要么兑现、要么删掉，不许停在中间态。
 * 将来真的注册投影时，再把形态写回这里。
 *
 * 另一个硬约束（**保留**，它是将来任何投影消费者的前提）：快照必须
 * **同步可读且内容未变时返回同一引用**（规划事实 G）。当前没有消费者，
 * 但这是 `list()` 的稳定契约，`tests/modules/profile/module.test.ts` 钉住它。
 */
import type { Clock } from '../../kernel/abi/index.js'
import type { ProfileEntry } from './entries.js'
import { applyEntry } from './entries.js'

/** 单会话能力观察上限：内存驻留项必须有界（防止长会话无界增长）。 */
export const CAPABILITY_ENTRIES_PER_SESSION = 20

/**
 * 分会话能力观察表的 **LRU 上界**（会话数）。
 *
 * 为什么需要：`#bySession` 每会话有 20 条上限，但**会话数没有上限**；
 * `clearSession()` 在全仓零生产调用方（宿主不发会话结束事件给模块，本片刻意
 * 不依赖它，见规划 §4 S3-f）→ 长跑宿主上这张表随历史会话数单调增长。
 *
 * 取值理由（32）：与 `modules/context` / `modules/notify` 的会话表上界同值，
 * 便于一句"三处同一口径"解释；真实同时活跃会话是个位数，32 给足余量，
 * 而每份记录最多 20 条小对象，代价可忽略。淘汰按**最久未活动**，
 * 被淘汰会话的能力观察随之消失（与"进程结束即消失"同一性质，只是更早）。
 */
export const CAPABILITY_SESSION_MAX = 32

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
  readonly #maxSessions: number
  readonly #bySession = new Map<string, readonly ProfileEntry[]>()
  /** 最近活动顺序（LRU，末尾最新；三张分会话表这里只有一张，但同样按活动排序）。 */
  readonly #order = new Map<string, true>()
  #sessionsEvicted = 0

  constructor(deps: { readonly clock: Clock; readonly maxPerSession?: number; readonly maxSessions?: number }) {
    this.#clock = deps.clock
    this.#maxPerSession = Math.max(1, deps.maxPerSession ?? CAPABILITY_ENTRIES_PER_SESSION)
    this.#maxSessions = Math.max(1, deps.maxSessions ?? CAPABILITY_SESSION_MAX)
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
    // 无论内容是否变化，这都是一次"会话活动"：先记 LRU，再决定要不要改内容。
    this.#touchSession(sessionId)
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

  /**
   * 会话快照。未观察过的会话返回共享空引用。
   *
   * **读取不算活动**：LRU 顺序只由 `observe()` 推进。读一次快照就让老会话
   * "续命"会把淘汰次序变成"谁被读得多"，与"谁在用"不是一回事。
   */
  list(sessionId: string): readonly ProfileEntry[] {
    return this.#bySession.get(sessionId) ?? EMPTY
  }

  clearSession(sessionId: string): void {
    this.#bySession.delete(sessionId)
    this.#order.delete(sessionId)
  }

  /** 一键清空全部会话的能力观察（`clearDeduced` 会调用它）。 */
  clearAll(): void {
    this.#bySession.clear()
    this.#order.clear()
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

  /** 因 LRU 上界被淘汰的会话数（**累计**：>0 表示更早会话的观察已不再保留）。 */
  evictedSessions(): number {
    return this.#sessionsEvicted
  }

  /** 分会话表上界（状态面据此说明口径）。 */
  sessionMax(): number {
    return this.#maxSessions
  }

  /** 记一次会话活动并淘汰最久未活动的会话（按活动排序，不是插入序）。 */
  #touchSession(sessionId: string): void {
    this.#order.delete(sessionId)
    this.#order.set(sessionId, true)
    while (this.#order.size > this.#maxSessions) {
      const oldest = this.#order.keys().next().value
      if (oldest === undefined) break
      this.#order.delete(oldest)
      this.#bySession.delete(oldest)
      this.#sessionsEvicted += 1
    }
  }
}
