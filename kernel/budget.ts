/**
 * 资源槽。超限返回 undefined，由调用方自行降级——内核不替模块决定策略。
 *
 * 内核只做两件事：记账、归还。分配策略属于模块。
 */
import type { BudgetGrant, BudgetKind } from './abi/index.js'

interface Slot {
  readonly limit: number
  used: number
}

export class BudgetTable {
  readonly #slots = new Map<BudgetKind, Slot>()

  /** 声明某类预算的上限。重复声明以最后一次为准（热插拔重载时会发生）。 */
  declare(kind: BudgetKind, limit: number): void {
    this.#slots.set(kind, { limit, used: 0 })
  }

  grant(kind: BudgetKind, amount: number): BudgetGrant | undefined {
    const slot = this.#slots.get(kind)
    if (slot === undefined) return undefined
    if (slot.used + amount > slot.limit) return undefined
    slot.used += amount
    let released = false
    return {
      kind,
      amount,
      release: () => {
        if (released) return // 幂等
        released = true
        slot.used = Math.max(0, slot.used - amount)
      },
    }
  }

  /** 已用/上限，供状态面显示。 */
  snapshot(): Readonly<Record<string, { used: number; limit: number }>> {
    const out: Record<string, { used: number; limit: number }> = {}
    for (const [kind, slot] of this.#slots) out[kind] = { used: slot.used, limit: slot.limit }
    return out
  }
}
