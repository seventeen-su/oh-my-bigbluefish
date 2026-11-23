/**
 * 确定性哈希嵌入器：**没有语义能力**，只用于单元测试与"本机没有模型"的环境。
 *
 * 算法（全部确定性，不依赖时钟/随机/平台）：
 * - 文本 NFKC + 小写后按码元取 unigram 与相邻 bigram；
 * - 每个特征用两路 FNV-1a 32 位哈希：一路定维度（`hash % 512`），一路定符号（±1）；
 * - 累加后 L2 归一化；空文本用固定哨兵特征，保证向量非零。
 *
 * 为什么需要它：单测不该依赖 24MB 权重与原生运行时（CI/离线机器常常没有）；
 * 为什么不能拿它冒充语义向量：`model` 名明确不同（`hash-bigram-512`），写库时不会被
 * 当成 BGE 向量复用；生产路径在模型不可用时必须走 `OnnxEmbedder.available() === false`
 * 并把向量通道标 `unavailable`，而不是换成哈希向量。
 */
import type { Embedder } from '../../ports/embedding.js'
import { DEFAULT_MAX_BATCH, embedBatched } from './batch.js'
import { l2Normalize } from './pooling.js'

export const HASH_MODEL = 'hash-bigram-512'
export const HASH_DIMS = 512

/** 空文本的固定哨兵特征（正常文本不会产生这个特征）。 */
const EMPTY_FEATURE = '\u0000empty'

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 文本 → 特征序列（unicode 码点 unigram + bigram；空白折叠后跳过）。 */
function featuresOf(text: string): string[] {
  const chars = Array.from(text.normalize('NFKC').toLowerCase())
  const visible = chars.filter(char => !/\s/u.test(char))
  if (visible.length === 0) return [EMPTY_FEATURE]
  const features: string[] = []
  for (let index = 0; index < visible.length; index++) {
    features.push(`u:${visible[index] ?? ''}`)
    const next = visible[index + 1]
    if (next !== undefined) features.push(`b:${visible[index] ?? ''}${next}`)
  }
  return features
}

/** 文本 → 512 维单位向量（同一实现在任何进程里都给同一结果）。 */
export function hashEmbed(text: string, dims: number = HASH_DIMS): number[] {
  if (!Number.isInteger(dims) || dims < 1) {
    throw new RangeError(`向量维度必须是正整数，实际：${String(dims)}`)
  }
  const pooled = new Float64Array(dims)
  for (const feature of featuresOf(text)) {
    const indexHash = fnv1a(feature, 0x811c9dc5)
    const signHash = fnv1a(feature, 0x9e3779b9)
    const weight = feature.startsWith('b:') ? 2 : 1
    const sign = (signHash & 1) === 1 ? 1 : -1
    const index = indexHash % dims
    pooled[index] = (pooled[index] ?? 0) + sign * weight
  }
  // 极端碰撞下的精确抵消会让向量为零；给一个固定分量，保持"非零且归一"的契约。
  let any = false
  for (let index = 0; index < dims; index++) {
    if ((pooled[index] ?? 0) !== 0) {
      any = true
      break
    }
  }
  if (!any) pooled[0] = 1
  return Array.from(l2Normalize(pooled))
}

/** 与 ONNX 实现同接口的确定性替身。 */
export class HashEmbedder implements Embedder {
  readonly model = HASH_MODEL
  readonly dims = HASH_DIMS
  readonly #batchSize: number

  constructor(batchSize: number = DEFAULT_MAX_BATCH) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError(`批量嵌入上限必须是正整数，实际：${String(batchSize)}`)
    }
    this.#batchSize = batchSize
  }

  async available(): Promise<boolean> {
    return true
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return embedBatched(texts, this.#batchSize, async batch => batch.map(text => hashEmbed(text, this.dims)))
  }
}
