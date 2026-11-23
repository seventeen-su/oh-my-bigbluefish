/**
 * 池化与归一化：`last_hidden_state` → 句向量。
 *
 * v7 用 **attention-mask 加权的 mean pooling**（不是 CLS 池化）：
 * 对每个非 padding 位置取隐状态求平均，再 L2 归一化，得到余弦可直接比较的单位向量。
 * padding 位置必须在池化前用 mask 排除——`last_hidden_state` 里它们不是零，而是模型对
 * `[PAD]` 的输出；漏掉 mask 会让同一句文本因为同批邻居更长而得到不同向量。
 */

/** L2 归一化（返回新数组；零向量抛错，绝不产出 NaN 的余弦输入）。 */
export function l2Normalize(vector: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vector.length)
  let sum = 0
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index] ?? 0
    if (!Number.isFinite(value)) {
      throw new Error(`向量第 ${index} 维不是有限数：${String(value)}`)
    }
    out[index] = value
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  if (norm === 0) {
    throw new Error('向量范数为 0，无法归一化（零向量不能参与余弦比较）')
  }
  for (let index = 0; index < out.length; index++) out[index] = (out[index] ?? 0) / norm
  return out
}

/**
 * 对 `hidden` 中从 `offset` 开始的一段做 attention-mask 加权平均并 L2 归一化。
 *
 * @param hidden 扁平隐状态（`rows * dims` 个数，或批内更长；只看 `offset` 之后 `mask.length * dims` 个）。
 * @param mask   每个 token 位置的权重，0 = padding，忽略。
 * @param dims   向量维度。
 * @param offset 该序列在 `hidden` 中的起始元素偏移。
 */
export function meanPoolNormalize(
  hidden: ArrayLike<number>,
  mask: ArrayLike<number>,
  dims: number,
  offset = 0,
): Float32Array {
  if (!Number.isInteger(dims) || dims < 1) {
    throw new RangeError(`向量维度必须是正整数，实际：${String(dims)}`)
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`offset 必须是 ≥0 的整数，实际：${String(offset)}`)
  }
  if (mask.length === 0) {
    throw new Error('attention_mask 为空：没有可池化的 token（至少应含 [CLS]/[SEP]）')
  }
  const span = mask.length * dims
  if (hidden.length < offset + span) {
    throw new Error(
      `隐状态长度不足：需要 offset ${offset} + mask ${mask.length} × dims ${dims} = ${offset + span}，` +
        `实际 ${hidden.length}`,
    )
  }

  const pooled = new Float32Array(dims)
  let count = 0
  for (let row = 0; row < mask.length; row++) {
    if ((mask[row] ?? 0) === 0) continue
    count++
    const base = offset + row * dims
    for (let dim = 0; dim < dims; dim++) pooled[dim] = (pooled[dim] ?? 0) + (hidden[base + dim] ?? 0)
  }
  if (count === 0) {
    throw new Error('attention_mask 全为 0：没有可池化的 token')
  }
  for (let dim = 0; dim < dims; dim++) pooled[dim] = (pooled[dim] ?? 0) / count
  return l2Normalize(pooled)
}
