import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BATCH, embedBatched } from '../../../../packages/v7/src/adapters/embedding/batch.js'

describe('embedBatched', () => {
  it('给定空输入当批量嵌入则返回空数组且不调用实现', async () => {
    let calls = 0
    const result = await embedBatched([], 32, async batch => {
      calls++
      return batch.map(String)
    })
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })

  it('给定 40 条文本当批量嵌入则按默认上限切成 32 + 8 两批', async () => {
    const sizes: number[] = []
    const texts = Array.from({ length: 40 }, (_, index) => `t${index}`)
    const result = await embedBatched(texts, DEFAULT_MAX_BATCH, async batch => {
      sizes.push(batch.length)
      return batch.map(text => text.toUpperCase())
    })
    expect(DEFAULT_MAX_BATCH).toBe(32)
    expect(sizes).toEqual([32, 8])
    expect(result.length).toBe(40)
    expect(result[0]).toBe('T0')
    expect(result[39]).toBe('T39')
  })

  it('给定自定义上限 7 与 15 条文本则分 7+7+1 三批并保持顺序', async () => {
    const sizes: number[] = []
    const texts = Array.from({ length: 15 }, (_, index) => String(index))
    const result = await embedBatched(texts, 7, async batch => {
      sizes.push(batch.length)
      return batch.map(Number)
    })
    expect(sizes).toEqual([7, 7, 1])
    expect(result).toEqual(texts.map(Number))
  })

  it('给定非法上限当批量嵌入则抛 RangeError', async () => {
    const identity = async (batch: readonly string[]): Promise<string[]> => [...batch]
    await expect(embedBatched(['a'], 0, identity)).rejects.toThrow(RangeError)
    await expect(embedBatched(['a'], -1, identity)).rejects.toThrow(RangeError)
    await expect(embedBatched(['a'], 1.5, identity)).rejects.toThrow(RangeError)
  })

  it('给定实现返回条数不符当批量嵌入则抛错（不静默错位）', async () => {
    await expect(embedBatched(['a', 'b'], 2, async () => ['only-one'])).rejects.toThrow(/条数不符/)
  })

  it('给定实现抛错当批量嵌入则原样外抛', async () => {
    await expect(
      embedBatched(['a', 'b'], 1, async batch => {
        if (batch[0] === 'b') throw new Error('模型炸了')
        return batch.map(String)
      }),
    ).rejects.toThrow('模型炸了')
  })
})
