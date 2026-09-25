/** 服务与事件：模块间通信的唯一通道。 */

type Listener = (payload: unknown) => void
type Disposer = () => void

/** 命名服务表。 */
export class ServiceTable {
  readonly #services = new Map<string, unknown>()

  /**
   * 注册一个命名服务。
   *
   * **同名重复注册：先注销旧的再装新的，不抛异常。** 两种情形都会发生：
   * ① 热插拔重载同一模块（旧 fiber 的 disposer 可能晚于新注册执行）
   * ② 模块自己重建服务实例
   * 抛异常会把"重载"变成"插件加载失败"，与「开关不该让会话报错」直接冲突。
   * 返回的 disposer 仍然只移除**本次注册的那个实例**，避免误删后注册者。
   */
  provide(name: string, service: unknown): Disposer {
    this.#services.set(name, service)
    return () => {
      if (this.#services.get(name) === service) this.#services.delete(name)
    }
  }

  /** 缺失返回 undefined，**不抛**——热插拔下服务可能刚被卸下。 */
  get<T>(name: string): T | undefined {
    return this.#services.get(name) as T | undefined
  }

  /** 已注册的服务名（诊断与测试用）。 */
  names(): readonly string[] {
    return [...this.#services.keys()].sort()
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
