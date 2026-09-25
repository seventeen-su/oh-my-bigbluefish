/**
 * 降级向量通道的**语义鉴别力量化**。
 *
 * ## 为什么要测这个
 *
 * 自检报告提过：「降级只测到『词法仍可用』，没测到『降级是否影响排序质量』…
 * 余弦下限 0 意味着阈值被下调到 0 以避免误杀，这可能同时意味着噪声条目更容易被召回」。
 *
 * 这是一个**可以量化**的疑问，不该停留在"无法判断"。下面用五组对照把
 * `hash-bow-256` 的实际行为测出来。
 *
 * ## 实测结论（这些数字就是判据，改动算法会让它们变化）
 *
 * | 对照 | 余弦 |
 * | --- | --- |
 * | 同义改写（无字面重合） | ≈ 0.10 |
 * | 同主题不同表述 | ≈ 0.10 |
 * | 无关 | 0.00 |
 * | **语义相反但字面重合** | ≈ 0.33 |
 *
 * 三条结论：
 *
 * ① **它度量的是哈希字符袋的重合度，不是语义**——同义改写只拿到 0.10，
 *    与噪声同量级；而反义词 `删除记忆`/`添加记忆` 拿到 0.33，**比同义改写高 3.5 倍**。
 * ② 因此"同义改写能召回哈希词袋召不回的记忆"这句宣传**对降级路径不成立**
 *    （它是对神经嵌入的承诺）。降级通道的价值是**字符级模糊匹配**。
 * ③ 余弦下限 0 是**正确的防御**：任何 >0 的阈值都会误杀同义改写（0.10 太接近噪声），
 *    代价是反义词条也会进来。**这是降级路径的固有权衡，不是配置失误。**
 *
 * 修复方向只有一个：装上 BGE 权重走神经通道。在权重缺席时，
 * 状态面应当如实说"这是字符匹配，不是语义"，而不是沿用神经通道的宣传语。
 */
import { describe, expect, it } from 'vitest'

import { hashBagEmbedder } from '../../../modules/memory/embed.js'

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    na += (a[i] ?? 0) ** 2
    nb += (b[i] ?? 0) ** 2
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

describe('降级向量通道：它度量字符重合，不度量语义', () => {
  const embedder = hashBagEmbedder(256)

  const sim = async (a: string, b: string): Promise<number> => {
    const [va, vb] = await embedder.embed([a, b])
    return cosine(va ?? [], vb ?? [])
  }

  it('同义改写（无字面重合）拿不到高分——与噪声同量级', async () => {
    const score = await sim('这个函数太长了需要拆分', '这个方法篇幅过大应当分解')
    // 0.10 上下：**不是**"召回了同义改写"，只是共享了几个虚词/助词
    expect(score).toBeGreaterThan(0)
    expect(score, '同义改写的相似度与噪声同量级，说明它不是语义通道').toBeLessThan(0.2)
  })

  it('无关内容接近 0', async () => {
    expect(await sim('这个函数太长了需要拆分', '今天天气不错适合散步')).toBeLessThan(0.05)
  })

  it('**语义相反但字面重合** 得分显著高于同义改写（这是该通道的本质）', async () => {
    const opposite = await sim('删除记忆', '添加记忆')
    const paraphrase = await sim('这个函数太长了需要拆分', '这个方法篇幅过大应当分解')
    expect(
      opposite,
      '反义词得分高于同义改写，证明它认的是字符重合而不是语义',
    ).toBeGreaterThan(paraphrase * 2)
  })

  it('余弦下限为 0 是正确防御：任何正阈值都会误杀同义改写', async () => {
    // 同义改写只有 ≈0.10，与"无关 0.00"太接近——阈值调高就会把同义改写杀掉。
    // 所以阈值只能取 0，代价是反义词条也会进来。**这是固有权衡。**
    const paraphrase = await sim('这个函数太长了需要拆分', '这个方法篇幅过大应当分解')
    const unrelated = await sim('这个函数太长了需要拆分', '今天天气不错适合散步')
    expect(paraphrase - unrelated, '信噪差距太小，无法设出有效阈值').toBeLessThan(0.2)
  })
})
