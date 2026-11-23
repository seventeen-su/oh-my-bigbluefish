/**
 * 嵌入端口：文本 → 定长稠密向量，供 `vector` 通道、`dedupe` 任务与 `embed` 补齐任务使用。
 *
 * 诚实降级是本端口的硬契约（SPEC §7.1：嵌入不可用时通道标 `unavailable`，不当 0 分）：
 *
 * - `available()` 只报事实：模型/运行时缺失、权重损坏或装载失败一律返回 `false`，**不抛**；
 * - `embed()` 在不可用时抛 `OmbFailure`（`code: 'unsupported'`，`details.reason` 是可读原因），
 *   绝不用零向量、随机向量或另一个模型顶替——伪装的向量会让检索"看起来在工作"却毫无区分力；
 * - `embed([])` 返回 `[]`：没有文本要编码不是不可用；
 * - `dims` 是通道契约（v7 库内 `vector(512)` 与 HNSW 索引），实现必须严格产出该维度；
 * - `model` 是向量来源标识，写入 `omb.embedding.model` 与 `omb.meta`，换模型/量化版本时
 *   必须变化，否则存量向量会被当成同源复用。
 */
export interface Embedder {
  /** 向量来源标识（写库时记录，用于识别陈旧向量）。 */
  readonly model: string
  /** 向量维度（v7 固定 512，与 `omb.embedding.embedding vector(512)` 一致）。 */
  readonly dims: number
  available(): Promise<boolean>
  embed(texts: readonly string[]): Promise<number[][]>
}
