import { describe, expect, it } from 'vitest'
import type { Embedder } from '../../../../packages/v7/src/ports/embedding.js'
import { HASH_DIMS, HASH_MODEL, hashEmbed, HashEmbedder } from '../../../../packages/v7/src/adapters/embedding/hash.js'

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

describe('HashEmbedder', () => {
  it('暴露 512 维且自报可用（无模型环境下的确定性替身）', async () => {
    const embedder: Embedder = new HashEmbedder()
    expect(embedder.model).toBe(HASH_MODEL)
    expect(embedder.dims).toBe(HASH_DIMS)
    expect(embedder.dims).toBe(512)
    await expect(embedder.available()).resolves.toBe(true)
  })

  it('给定同一文本当嵌入则两个实例与重复调用逐位相同', async () => {
    const first = await new HashEmbedder().embed(['记忆库是属性的集合'])
    const second = await new HashEmbedder().embed(['记忆库是属性的集合'])
    const again = await new HashEmbedder().embed(['记忆库是属性的集合'])
    expect(first[0]).toEqual(second[0])
    expect(first[0]).toEqual(again[0])
  })

  it('给定不同文本当嵌入则向量不同（不是常量向量）', async () => {
    const [a, b] = await new HashEmbedder().embed(['PostgreSQL 单库', 'pgvector 向量检索'])
    expect(a).not.toEqual(b)
  })

  it('给定空输入当嵌入则返回空数组', async () => {
    await expect(new HashEmbedder().embed([])).resolves.toEqual([])
  })

  it('给定任意文本当嵌入则每维有限、非零且 L2 范数为 1', async () => {
    const vectors = await new HashEmbedder().embed(['', '   ', '中文与 English 混合，带标点！', 'x'.repeat(3000)])
    expect(vectors.length).toBe(4)
    for (const vector of vectors) {
      expect(vector.length).toBe(512)
      expect(vector.every(value => Number.isFinite(value))).toBe(true)
      expect(vector.some(value => value !== 0)).toBe(true)
      expect(norm(vector)).toBeCloseTo(1, 5)
    }
  })

  it('给定 40 条文本当嵌入则逐条独立且顺序不变', async () => {
    const texts = Array.from({ length: 40 }, (_, index) => `文本-${index}`)
    const embedder = new HashEmbedder()
    const vectors = await embedder.embed(texts)
    expect(vectors.length).toBe(40)
    const single = await embedder.embed([texts[17] ?? ''])
    expect(vectors[17]).toEqual(single[0])
  })

  it('给定非法批量上限当构造则抛 RangeError', () => {
    expect(() => new HashEmbedder(0)).toThrow(RangeError)
    expect(() => new HashEmbedder(2.5)).toThrow(RangeError)
  })
})

describe('hashEmbed', () => {
  it('给定固定文本当哈希嵌入则返回值与维度参数一致', () => {
    expect(hashEmbed('abc')).toHaveLength(512)
    expect(hashEmbed('abc', 8)).toHaveLength(8)
  })

  it('给定非法维度当哈希嵌入则抛 RangeError', () => {
    expect(() => hashEmbed('abc', 0)).toThrow(RangeError)
  })

  it('给定空文本当哈希嵌入则返回非零单位向量（空文本也是合法输入）', () => {
    const vector = hashEmbed('')
    expect(vector.some(value => value !== 0)).toBe(true)
    expect(norm(vector)).toBeCloseTo(1, 5)
  })
})
