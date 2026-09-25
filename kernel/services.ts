/** 服务与事件：模块间通信的唯一通道。 */

type Listener = (payload: unknown) => void
type Disposer = () => void

/** 命名服务表。 */
export class ServiceTable {
  readonly #services = new Map<string, unknown>()

  provide(name: string, service: unknown): Disposer {
    if (this.#services.has(name)) {
      throw new Error(`内核：服务 "${name}" 已被注册（同一实例内服务名必须唯一）`)
    }
    this.#services.set(name, service)
    return () => {
      // 仅在仍是本次注册的那个实例时移除，避免后注册者被先注销者误删
      if (this.#services.get(name) === service) this.#services.delete(name)
    }
  }

  /** 缺失返回 undefined，**不抛**——热插拔下服务可能刚被卸下。 */
  get<T>(name: string): T | undefined {
    return this.#services.get(name) as T | undefined
  }
}

/** 类型化事件总线。订阅者抛异常被隔离，不影响发布者与其他订阅者。 */
export class EventBus {
  readonly #listeners = new Map<string, Set<Listener>>()

  on(event: string, fn: Listener): Disposer {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(fn)
    return () => {
      const current = this.#listeners.get(event)
      if (current === undefined) return
      current.delete(fn)
      if (current.size === 0) this.#listeners.delete(event)
    }
  }

  emit(event: string, payload: unknown): void {
    const set = this.#listeners.get(event)
    if (set === undefined) return
    // 先快照：订阅者在回调里注销自己是常见写法
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch {
        // 单个订阅者失败不得中断发布——事件总线是模块隔离的一部分
      }
    }
  }

  /** 测试与热插拔验收用：当前订阅者总数。 */
  listenerCount(): number {
    let total = 0
    for (const set of this.#listeners.values()) total += set.size
    return total
  }
}
