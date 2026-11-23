import { describe, expect, it } from 'vitest'
import { l2Normalize, meanPoolNormalize } from '../../../../packages/v7/src/adapters/embedding/pooling.js'

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

describe('l2Normalize', () => {
  it('给定 [3,4] 当归一化则得到单位向量 [0.6,0.8]', () => {
    const [x, y] = Array.from(l2Normalize([3, 4]))
    expect(x).toBeCloseTo(0.6, 6)
    expect(y).toBeCloseTo(0.8, 6)
  })

  it('给定零向量当归一化则抛错（不产出 NaN 的余弦输入）', () => {
    expect(() => l2Normalize([0, 0])).toThrow(/范数为 0/)
  })

  it('给定含 NaN 的向量当归一化则抛错', () => {
    expect(() => l2Normalize([1, Number.NaN])).toThrow(/不是有限数/)
  })
})

describe('meanPoolNormalize', () => {
  it('给定 mask 为 [1,0] 当池化则 padding 行不参与平均', () => {
    // 真实行 [3,4] 归一化后是 [0.6,0.8]；padding 行 [100,100] 若被算进去会得到完全不同的方向。
    const [x, y] = Array.from(meanPoolNormalize([3, 4, 100, 100], [1, 0], 2))
    expect(x).toBeCloseTo(0.6, 6)
    expect(y).toBeCloseTo(0.8, 6)
  })

  it('给定 offset 当池化则只读该序列那一段隐状态', () => {
    const [x, y] = Array.from(meanPoolNormalize([9, 9, 9, 9, 3, 4], [1], 2, 4))
    expect(x).toBeCloseTo(0.6, 6)
    expect(y).toBeCloseTo(0.8, 6)
  })

  it('给定多行 mask 当池化则按行求平均后再归一化', () => {
    // [1,0] 与 [0,3] 的平均是 [0.5,1.5]，归一化后 [0.316,0.949]。
    const pooled = meanPoolNormalize([1, 0, 0, 3], [1, 1], 2)
    expect(pooled[0]).toBeCloseTo(0.31622776, 6)
    expect(pooled[1]).toBeCloseTo(0.94868329, 6)
  })

  it('给定全零 mask 当池化则抛错（不返回零向量）', () => {
    expect(() => meanPoolNormalize([1, 2, 3, 4], [0, 0], 2)).toThrow(/全为 0/)
  })

  it('给定空 mask 当池化则抛错', () => {
    expect(() => meanPoolNormalize([], [], 2)).toThrow(/为空/)
  })

  it('给定 dims 非法当池化则抛 RangeError', () => {
    expect(() => meanPoolNormalize([1, 2], [1], 0)).toThrow(RangeError)
  })

  it('给定 offset 非法当池化则抛 RangeError', () => {
    expect(() => meanPoolNormalize([1, 2], [1], 2, -1)).toThrow(RangeError)
  })

  it('给定隐状态长度不足当池化则抛错并说明缺口', () => {
    expect(() => meanPoolNormalize([1, 2], [1, 1], 2)).toThrow(/长度不足/)
  })

  it('给定池化结果为零向量当归一化则抛错', () => {
    expect(() => meanPoolNormalize([0, 0, 0, 0], [1, 1], 2)).toThrow(/范数为 0/)
  })

  it('给定归一化结果当计算范数则为 1', () => {
    const pooled = meanPoolNormalize([2, 4, 6, 8], [1, 1], 2)
    expect(norm(Array.from(pooled))).toBeCloseTo(1, 6)
  })
})
