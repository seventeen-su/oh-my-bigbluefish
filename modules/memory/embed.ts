/**
 * 嵌入器与向量原语（**零外部依赖**）。
 *
 * 本文件提供三样东西：
 * ① `hashBagEmbedder`——哈希词袋，**诚实降级路径**（神经嵌入不可用时的确定性兜底）；
 * ② 向量 ↔ BLOB 的编解码，且**损坏可计数**（旧实现静默返回 null，使损坏不可见）；
 * ③ `checkEmbedderCompat`——归属校验：把"库内已存向量"与"当前嵌入器"是否同一空间判成可读结论。
 *
 * 为什么归属标签（`id` / `dimensions` / `revision`）是承重的：
 *   旧实现把 256 维哈希词袋与 512 维 BGE 向量写进**同一列且无维度标记**，
 *   于是两种不可比的向量混在一起、余弦值毫无意义，而且没有任何地方能发现。
 *   规划 §2 D2 的对策是：`id`/`dimensions`/`revision` **随向量一起持久化**，
 *   写入时拒绝无法归属的向量。本文件负责产生正确的标签并提供校验函数（表结构在 store 侧）。
 *
 * 哈希词袋的诚实定位：它提升的是「改写 / 近义 / 词序变化」层面的召回（token 集合相似即相近），
 * **不是语义模型**——同义改写与跨语言无力。状态面与文档不得把它宣传成语义嵌入。
 * 分词口径复用 `./text.js`（与 FTS 索引同源），使词法通道与向量通道在同一 token 空间互补。
 */
import type { Embedder } from '../../kernel/abi/index.js'
import { tokenizeForFts } from './text.js'

/**
 * 哈希词袋的修订号。**算法变了就递增**——存量向量的归属会因此不匹配，
 * 从而走"重编码"而不是被静默当成同一个空间复用。
 */
export const HASH_BOW_REVISION = '1'

/** FNV-1a（32 位，确定性、无随机种子）。 */
function hashToken(token: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** L2 归一化（原地；零向量原样返回）。归一化后点积即余弦。 */
function l2NormalizeInPlace(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0)
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm
  }
  return vec
}

/**
 * 确定性哈希词袋嵌入器（纯 CPU、零依赖、同步计算藏在 Promise 后面）。
 *
 * - token 权重 = `1 + ln(计数)`（次线性：重复 token 不主导方向）
 * - 桶位 = `hash(token) % dim`，符号 = 另一个比特（带符号哈希减少碰撞的系统性偏置）
 * - 输出 L2 归一化 → 点积即余弦
 * - 空文本 → **零向量**（余弦按 0 处理，不参与检索）
 *
 * `id` 携带维度（`hash-bow-256`）：维度是归属标签的一部分，**同一算法不同维度不是同一个空间**。
 * 让 `id` 与 `dimensions` 如实对应，正是旧实现"混入 256 维哈希词袋"缺陷的结构性对策。
 */
export function hashBagEmbedder(dimensions = 256): Embedder {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`hashBagEmbedder：维度必须是正整数（收到 ${String(dimensions)}）`)
  }
  const dim = dimensions

  const embedOne = (text: string): Float32Array => {
    const vec = new Float32Array(dim)
    const tokens = tokenizeForFts(text).split(' ').filter((t) => t.length > 0)
    if (tokens.length === 0) {
      return vec // 空文本 → 零向量
    }
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    for (const [token, n] of counts) {
      const h = hashToken(token)
      const idx = h % dim
      const sign = (h >>> 31) & 1 ? -1 : 1
      vec[idx] = (vec[idx] ?? 0) + sign * (1 + Math.log(n))
    }
    return l2NormalizeInPlace(vec)
  }

  return {
    id: `hash-bow-${dim}`,
    dimensions: dim,
    revision: HASH_BOW_REVISION,
    async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
      return texts.map(embedOne)
    },
  }
}

/**
 * 余弦相似度。
 *
 * **维度不一致直接抛错**（fail-loud）：两个不同维度的向量做点积是纯粹的数值错误，
 * 静默截断或补零会产出看起来合理的分数——这正是旧缺陷的形态。
 * 调用方应在比较之前用 `checkEmbedderCompat` 把异维数据挡在检索之外。
 * 任一侧为零向量（空文本）→ 返回 0。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity：维度不一致（${a.length} vs ${b.length}）——不同维度向量不可比较`,
    )
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Float32 向量 → BLOB 字节。
 *
 * 返回**副本**而不是原缓冲的视图：视图与调用方持有的向量共享内存，调用方之后原地修改向量
 * （重编码、归一化）会连带改掉"已落库"的字节，产生难以复现的持久化污染。
 *
 * 字节序：写的是本机 `Float32Array` 布局（x64/arm64 均小端）；读回走同一个解释方式
 * （`blobToVector`），因此本机往返一致。跨架构共享库文件不在支持范围内（库是本地产物）。
 */
export function vectorToBlob(vec: Float32Array): Uint8Array {
  const out = new Uint8Array(vec.byteLength)
  out.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength))
  return out
}

/** 已观测到的损坏 BLOB 数（长度非法 / 类型不可识别）。状态面据此暴露"损坏可见"。 */
let blobDecodeFailures = 0

/** 损坏计数（供状态面与自调读取；不重置）。 */
export function blobDecodeFailureCount(): number {
  return blobDecodeFailures
}

/** 归零损坏计数（测试与维护窗口用；不影响解码语义）。 */
export function resetBlobDecodeFailures(): void {
  blobDecodeFailures = 0
}

function toBytes(blob: unknown): Uint8Array | null {
  if (blob instanceof Uint8Array) return blob
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob)
  if (ArrayBuffer.isView(blob)) return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength)
  return null
}

/**
 * BLOB 字节 → Float32 向量。
 *
 * 诚实语义（三档，别混为一谈）：
 * - `null` / `undefined` → `null`：**未编码**（正常状态，不计数）
 * - 空字节串 → `null`：**未编码**（正常状态，不计数）
 * - 类型不可识别（字符串、数字、对象…）或**长度不是 4 的倍数** → `null` **并计数**
 *
 * 计数的意义：旧实现在这两种情况下同样返回 null，但**外面看不见**——损坏于是永远不被发现，
 * 表现为"某条记忆就是搜不到"。现在损坏是一个可读数字。
 *
 * 解码前先复制到对齐缓冲：SQLite 读回的 BLOB 可能是带偏移的视图，直接在其上建 Float32Array
 * 会因未对齐而抛错。
 */
export function blobToVector(blob: unknown): Float32Array | null {
  if (blob === null || blob === undefined) return null
  const bytes = toBytes(blob)
  if (bytes === null) {
    blobDecodeFailures++
    return null
  }
  if (bytes.byteLength === 0) return null
  if (bytes.byteLength % 4 !== 0) {
    blobDecodeFailures++
    return null
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

/** 库内已存向量的归属标签（`embedding` 表的 `model_id` / `dim` / `revision` 三列；见规划 §5.2）。 */
export interface VectorAttribution {
  readonly modelId: string
  readonly dim: number
  readonly revision: string
}

/** 归属校验结论。失败时 `reason` 必须是可行动的一句话（无空降级）。 */
export type EmbedderCompat =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * 判定"库内已存向量"与"当前嵌入器"能否归为**同一个向量空间**。
 *
 * 三种不匹配各自给出可读原因，且**都必须导致拒绝**（写入拒绝、检索跳过）——因为不同空间的
 * 余弦值不可比，混用不会有报错，只会安静地给出错误排序：
 * ① 维度不同（最根本）② 同维但模型不同 ③ 同模型不同修订（需重编码）
 *
 * `stored === null` 表示库内尚无向量 → 允许写入（这正是首次建立通道的情形）。
 */
export function checkEmbedderCompat(
  stored: VectorAttribution | null,
  current: Embedder,
): EmbedderCompat {
  if (stored === null) return { ok: true }
  if (stored.dim !== current.dimensions) {
    return {
      ok: false,
      reason: `维度不匹配：库内 ${stored.dim}，当前嵌入器 ${current.dimensions}（不可比较，需重编码或换回原嵌入器）`,
    }
  }
  if (stored.modelId !== current.id) {
    return {
      ok: false,
      reason: `模型不匹配：库内 ${stored.modelId}，当前嵌入器 ${current.id}（同维但不同空间，余弦不可比）`,
    }
  }
  if (stored.revision !== current.revision) {
    return {
      ok: false,
      reason: `模型修订不匹配：库内 ${stored.modelId}@${stored.revision}，当前 ${current.id}@${current.revision}（需重编码）`,
    }
  }
  return { ok: true }
}
