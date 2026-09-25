/**
 * 状态面贡献登记处。见 `abi/catalog.ts` 的 `StatusRegistry`。
 *
 * 纯数据结构，无副作用——便于单独测试。
 */
import type { StatusContributor, StatusRegistry } from './abi/index.js'

export class StatusTable implements StatusRegistry {
  readonly #contributors: StatusContributor[] = []

  register(contributor: StatusContributor): () => void {
    this.#contributors.push(contributor)
    let removed = false
    return () => {
      if (removed) return // 幂等
      removed = true
      const at = this.#contributors.indexOf(contributor)
      if (at >= 0) this.#contributors.splice(at, 1)
    }
  }

  /** 按 `name` 稳定排序——输出确定，便于测试与阅读。 */
  list(): readonly StatusContributor[] {
    return [...this.#contributors].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /**
   * 汇总渲染。
   *
   * **单个贡献者抛异常不得让整份状态面失败**——渲染成一行可读错误，
   * 因为"状态面本身挂了"是最难排查的故障。
   */
  render(): readonly string[] {
    const lines: string[] = []
    for (const c of this.list()) {
      try {
        lines.push(`### ${c.name}`, c.render(), '')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lines.push(`### ${c.name}`, `（该段落渲染失败：${message}）`, '')
      }
    }
    return lines
  }
}
