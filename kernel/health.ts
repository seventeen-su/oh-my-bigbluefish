/**
 * 健康聚合。状态面唯一的真源：任何降级都必须带原因。
 *
 * 旧实现有 8 处吞异常导致"功能仍可用但语义弱"且无人知道为什么。
 * 这里的 `detail` 是**必填**的，类型上就无法省略。
 */
import type { ModuleHealth } from './abi/index.js'

export class HealthTable {
  readonly #health = new Map<string, ModuleHealth>()

  report(id: string, health: ModuleHealth): void {
    this.#health.set(id, health)
  }

  get(id: string): ModuleHealth | undefined {
    return this.#health.get(id)
  }

  /** 该模块是否已上报过健康。内核据此决定是否补通用值——不得覆盖模块自报的降级原因。 */
  has(id: string): boolean {
    return this.#health.has(id)
  }

  remove(id: string): void {
    this.#health.delete(id)
  }

  /** 全体快照；排序固定，便于测试与界面稳定呈现。 */
  snapshot(): Readonly<Record<string, ModuleHealth>> {
    const out: Record<string, ModuleHealth> = {}
    for (const id of [...this.#health.keys()].sort()) {
      const health = this.#health.get(id)
      if (health !== undefined) out[id] = health
    }
    return out
  }

  /** 总体状态：任一 failed → failed；任一 degraded → degraded；否则 ok。 */
  overall(): ModuleHealth {
    let state: ModuleHealth['state'] = 'ok'
    const degraded: string[] = []
    const failed: string[] = []
    for (const [id, health] of this.#health) {
      if (health.state === 'failed') failed.push(id)
      else if (health.state === 'degraded') degraded.push(id)
    }
    if (failed.length > 0) state = 'failed'
    else if (degraded.length > 0) state = 'degraded'
    const detail = failed.length > 0
      ? `失败模块：${failed.join('、')}`
      : degraded.length > 0
        ? `降级模块：${degraded.join('、')}`
        : '全部模块正常'
    return { state, detail }
  }
}
