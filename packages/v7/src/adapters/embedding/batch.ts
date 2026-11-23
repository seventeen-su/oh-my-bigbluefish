/**
 * 批量嵌入的分片器。
 *
 * 为什么必须有上限：一次前向的峰值内存与批大小成线性（`[batch, seq, 512]` 的激活值），
 * 而调用方是同步的写入/检索路径，可能一次拿到整页实体文本。不设上限时，一个大批量
 * 会同时占住 ORT 的工作内存与事件循环，把前台请求拖到超时。32 条是 CPU 推理下
 * 单批毫秒级、内存可控的经验值，可由实现按需覆盖。
 */

/** 默认每批条数。 */
export const DEFAULT_MAX_BATCH = 32

/**
 * 把 `texts` 按 `batchSize` 切片后逐批调用 `embedBatch`，按原顺序拼回。
 *
 * - 空输入直接返回 `[]`，**不调用** `embedBatch`（无文本时不应触发模型装载/推理）；
 * - `batchSize` 必须是正整数，非法值在入口直接抛 `RangeError`（配置错误不该等到第一次嵌入才暴露）；
 * - 批间串行：CPU 推理并发只会互相抢线程，反而拉长尾延迟。
 */
export async function embedBatched<R>(
  texts: readonly string[],
  batchSize: number,
  embedBatch: (batch: readonly string[]) => Promise<readonly R[]>,
): Promise<R[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`批量嵌入上限必须是正整数，实际：${String(batchSize)}`)
  }
  if (texts.length === 0) return []
  const out: R[] = []
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize)
    const encoded = await embedBatch(batch)
    if (encoded.length !== batch.length) {
      throw new Error(`嵌入实现返回条数不符：批内 ${batch.length} 条，返回 ${encoded.length} 条`)
    }
    for (const item of encoded) out.push(item)
  }
  return out
}
