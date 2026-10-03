/**
 * 状态面贡献登记处。见 `abi/catalog.ts` 的 `StatusRegistry`。
 *
 * 纯数据结构，无副作用——便于单独测试。
 */
import type { StatusContributor, StatusRegistry } from './abi/index.js'

/**
 * 段落名（去重的键）。
 *
 * `name` 在 ABI 里是 `string`，但登记处是**诊断路径**：模块 provide 什么形状的
 * 贡献运行时都可能，这里不许因为一个脏名字把整份状态面打掉（与 `render()` 里
 * 逐段隔离同源）。非字符串一律按 `String()` 收敛——两个没署名的贡献于是算同一段，
 * 与"同名即同一段"的语义一致。
 */
function sectionNameOf(contributor: StatusContributor | null | undefined): string {
  const name = (contributor as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' ? name : String(name ?? '')
}

export class StatusTable implements StatusRegistry {
  /**
   * **按名字键控**的段落表（`name` → 那一段）。
   *
   * 为什么不是一个数组：数组装得下两个同名段落，于是热重载时状态面会**同名渲染两遍**。
   * 值里带 `seq`（注册序号）：注销动作因此能认准"**哪一次**注册"，而不是按对象身份删。
   */
  readonly #sections = new Map<string, { readonly contributor: StatusContributor; readonly seq: number }>()

  /** 注册序号：同名替换后，旧注册的 disposer 必须认得出"我已经被顶替了"。 */
  #seq = 0

  /**
   * 登记一个贡献者，**同名的新贡献替换旧的**。@returns 注销函数（幂等）。
   *
   * ## 为什么必须按名去重（热重载时的双段）
   *
   * 热重载的真实时序是：新实例先挂上（`register`），旧实例的 disposer 稍后才被调用
   * ——两者**不在同一个同步块里**（宿主的挂载与卸载各走各的路径）。过去这里是纯 `push`，
   * 于是这中间每一次 `omb_status` 都会把同一个名字渲染两遍：
   *
   * ```
   * ### 常驻提示预算（omb 提示注入）   常驻提示 104/120 字符（未截断，余量 16）
   * ### 常驻提示预算（omb 提示注入）   常驻提示 0/120 字符（无贡献者）   ← 旧实例，尚未退场
   * ```
   *
   * 代价不是"多两行字"：两段**同名**文字给出互相矛盾的数字，而读者无法判断哪一段是活的
   * （`omb_status` 是唯一的模型可见诊断入口）；更糟的是它把"重载成功与否"这件事弄成不可读
   * ——同一个名字出现两次，只说明旧实例还没退场，却看起来像两份互相打架的账。
   *
   * ## 被替换者的注销动作必须是**无操作**
   *
   * 若注销仍按下标或对象身份删，上面那个"稍后到场的旧 disposer"就会把**新段**带走：
   * 热重载后状态面莫名其妙少一段，且没有任何报错（`render` 只会渲染剩下的段落）。
   * 因此注销时比对 `seq`：不是自己那一次注册，就什么都不做。
   *
   * ## 向后兼容
   *
   * 判据只有一条："每个名字在渲染里出现一次"。不同名字的贡献照旧各自成段
   * （`modules/context/module.test.ts` 的多贡献者用例、各模块自己的段落都不变），
   * 所以**现有模块一行都不用改**。
   *
   * ## 去重顺带遮住的那件事（如实记下）
   *
   * 双段曾经是"旧实例还没退场"的**可见症状**；去重之后它不再可见——旧实例可能
   * 还活着（服务、订阅都没撤）。这不是去重引入的问题（症状本来就不该由状态面的重影
   * 来承担），但要判断"重载干净不干净"，得看别处：内核健康面（按模块 id）、
   * `kernel/module-graph`（已挂载清单）、以及服务表里那个模块的 `tools:<id>` 是否还在。
   * 将来若要**主动**报告重复注册，正确做法是在这里计数并把"顶替发生了几次"交给
   * 状态面显示，而不是继续渲染两段互相矛盾的账。
   */
  register(contributor: StatusContributor): () => void {
    const name = sectionNameOf(contributor)
    const seq = (this.#seq += 1)
    this.#sections.set(name, { contributor, seq })
    return () => {
      const current = this.#sections.get(name)
      // 已被同名的新注册顶替（seq 不同）= 这次注销是**无操作**：
      // 删掉它等于删掉别人的段落——"删一个新的、少一个旧的"是比双段更难查的故障。
      if (current === undefined || current.seq !== seq) return
      this.#sections.delete(name)
    }
  }

  /** 按 `name` 稳定排序——输出确定，便于测试与阅读。 */
  list(): readonly StatusContributor[] {
    return [...this.#sections.values()]
      .map(entry => entry.contributor)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
