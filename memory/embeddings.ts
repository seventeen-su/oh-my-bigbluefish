// layer 2（memory/）：CPU 嵌入服务（已知问题《新增向量检索》与《重构方向：双通道记忆系统》的向量通道）。
//
// 选型与约束（与 实测结论一致，零新依赖）：
//   - **不得占用显卡**：本实现为纯 JS 计算（无 ONNX/无 WASM/无 GPU），只用 CPU；单条编码为
//     一次 token 扫描 + 定长数组累加（实测微秒级），批量编码放在空闲期执行（见 backend 的
//     `encodePendingBatch`，由维护任务调用）。
//   - **可替换**：`Embedder` 是唯一接口。当前实现 = 确定性哈希词袋（hashed bag-of-tokens，
//     带符号哈希 + 次线性词频 + L2 归一化），保证「同文本 → 同向量」；将来若引入真正的
//     中文小嵌入模型（约 2000 万参数级，CPU 可跑），只需按本接口实现并在装配处替换，
//     检索链路与存储格式不变（向量列即 Float32 字节串）。
//   - **诚实的定位说明**：哈希词袋提升的是「改写/近义/词序变化」层面的召回（token 集合相似即相近），
//     不等价于神经嵌入的深层语义；最初设计里"向量通道"的目标（补齐召回）由它达成，
//     但不应把它宣传为语义模型。文档与状态面均按此口径描述。
//
// 分词口径复用 memory/cjk-ngram.ts（CJK bigram / 非 CJK 空白分词）——与 FTS 索引同源，
// 使「词法命中」与「向量命中」在同一个 token 空间里互补（词法是 AND/OR 精确匹配，向量是集合相似度）。
import { tokenizeForFts } from './cjk-ngram.js';

/** 向量维度（哈希空间；256 维在 10^4 量级记忆上足够区分，且暴力余弦仍为亚毫秒级；§17 可标定） */
export const EMBEDDING_DIM = 256;

/**
 * 嵌入接口（唯一替换点：真实中文小嵌入模型按此实现即可接入）。
 *
 * **为什么是异步**（已知问题《小向量模型未接入》落地的关键取舍，2026-09 真机/实测结论）：
 * 神经嵌入的推理运行时（onnxruntime-node）**只提供 Promise 形态的 `run`**——其原生绑定在
 * `setImmediate` 之后同步执行、再 resolve（实测：调用返回 0.02ms、settle 7–8ms，事件循环期间
 * 不推进），即"同步阻塞 + Promise 外壳"。因此无论怎样包装，真实推理都无法在**不阻塞事件循环**的
 * 前提下同步返回；把这层伪装成同步只会把"阻塞"藏进调用方看不见的地方。
 * 故接口显式声明为异步：调用方明确知道自己在等一次推理，编码缺口也在空闲期补齐（见 backend）。
 * `embedSync` 只对**纯 JS 实现**可用（哈希词袋），供不应阻塞的同步路径与测试使用。
 */
export interface Embedder {
  /** 实现标识（状态面/审计可读，如 'hash-bow-v1' / 'bge-small-zh-v1.5-onnx'） */
  readonly id: string;
  /** 维度（存储与比较必须一致） */
  readonly dim: number;
  /** 单条编码（确定性：同文本 → 同向量） */
  embed(text: string): Promise<Float32Array>;
  /**
   * 同步快路径（可选）：只有纯计算实现（哈希词袋）能提供。
   * 神经嵌入的运行时不允许同步推理（见上方说明）→ 不实现本方法；调用方须回落 `embed`。
   */
  embedSync?(text: string): Float32Array;
  /**
   * 候选下限（可选；余弦值域 -1~1）：**低于该值不算命中**。
   *
   * 为什么需要它（审查发现的质量缺陷）：检索侧的过滤曾是"`score <= 0` 才算负相关"，这个阈值是按
   * **稀疏**哈希词袋的余弦分布标定的（无关文本落在 0 附近或负值）。稠密神经嵌入的分布完全不同——
   * 实测 BGE-small-zh 上**无关中文对的余弦仍有 0.25~0.27**（相关对 0.57~0.80），于是"非正才丢"
   * 永不命中：任何查询都返回满额候选池，无关记忆被稳定塞进注入预算尾部，价值模型的
   * "向量命中"分量在所有候选上趋于恒定、排序被压平。
   *
   * 缺省 0（= 保持既有语义，只对真正非正的分数设限）；稠密模型按自身实测分布声明下限。
   */
  readonly minScore?: number;
}

/** token 的符号哈希（FNV-1a 变体；确定性、无随机种子） */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 确定性哈希词袋嵌入器（CPU 专用，**零依赖**）。
 * - token 权重 = 1 + ln(计数)（次线性：重复不主导）；
 * - 桶位 = hash(token) % dim；符号 = 另一比特（带符号哈希减少哈希碰撞的系统性偏置）；
 * - 输出 L2 归一化 → 点积即余弦相似度。
 *
 * 定位（诚实口径，勿夸大）：它补的是"改写/近义/词序变化"层面的召回，**不是语义模型**
 * （同义改写与跨语言无力）。作为神经嵌入不可用时的**确定性兜底**保留——装配面在模型缺失/
 * 运行时不兼容时回落到它，而不是让向量通道整个失效。
 */
export const HASH_BOW_EMBEDDER: Embedder = {
  id: 'hash-bow-v1',
  dim: EMBEDDING_DIM,
  async embed(text: string): Promise<Float32Array> {
    return this.embedSync!(text);
  },
  embedSync(text: string): Float32Array {
    const vec = new Float32Array(EMBEDDING_DIM);
    const tokens = tokenizeForFts(text).split(' ').filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return vec; // 空文本 → 零向量（余弦相似度按 0 处理，不参与检索）
    }
    const counts = new Map<string, number>();
    for (const t of tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const [token, n] of counts) {
      const h = hashToken(token);
      const idx = h % EMBEDDING_DIM;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      vec[idx] = (vec[idx] ?? 0) + sign * (1 + Math.log(n));
    }
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
    }
    return vec;
  },
};

/** 默认嵌入器（装配处注入可替换实现；缺省 = CPU 哈希词袋） */
export const DEFAULT_EMBEDDER: Embedder = HASH_BOW_EMBEDDER;

/** 余弦相似度（两侧若为零向量 → 0；不同维度 → fail-loud，避免静默错算） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: 维度不一致（${a.length} vs ${b.length}）`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) * (a[i] ?? 0);
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Float32 向量 → Buffer（BLOB 列存储；小端，与 node:sqlite 的 BLOB 读写一致） */
export function vectorToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Buffer → Float32 向量（长度为 0/非 4 字节倍数 → null：视为未编码，诚实跳过） */
export function blobToVector(blob: unknown): Float32Array | null {
  if (blob === null || blob === undefined) return null;
  const bytes =
    blob instanceof Uint8Array
      ? blob
      : blob instanceof ArrayBuffer
        ? new Uint8Array(blob)
        : null;
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  // 复制到对齐缓冲（BLOB 读取可能返回非 4 字节对齐的视图）
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}
