/**
 * 第二通道登记处。见 `abi/catalog.ts` 的 `SecondaryChannelRegistry`。
 *
 * 纯数据结构，无副作用——便于单独测试。
 * 泛型化以保持 ABI 对 `modules/` 的零依赖：`T` 由调用方以模块层的类型实例化。
 */
import type { SecondaryChannelRegistry } from './abi/index.js'

/** 登记处需要 `name` 才能稳定排序；不强制 T 的其余形状（ABI 不引模块层类型）。 */
interface Named {
  readonly name: string
}

export class ChannelTable<T extends Named> implements SecondaryChannelRegistry<T> {
  readonly #channels: T[] = []

  register(channel: T): () => void {
    this.#channels.push(channel)
    let removed = false
    return () => {
      if (removed) return // 幂等
      removed = true
      const at = this.#channels.indexOf(channel)
      if (at >= 0) this.#channels.splice(at, 1)
    }
  }

  /**
   * 按 `name` 稳定排序。
   *
   * 排序保证：融合顺序与注册顺序无关，因此 RRF 的并列打破规则是确定的
   * （否则"同一个查询两次跑出不同排名"会变成随机的）。
   */
  list(): readonly T[] {
    return [...this.#channels].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
}
