import { describe, expect, it } from 'vitest'
import { OmbFailure } from '../../../../packages/v7/src/domain/errors.js'
import { OnnxEmbedder, resolveModelDir } from '../../../../packages/v7/src/adapters/embedding/onnx.js'

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index++) {
    dot += (a[index] ?? 0) * (b[index] ?? 0)
    normA += (a[index] ?? 0) ** 2
    normB += (b[index] ?? 0) ** 2
  }
  return dot / Math.sqrt(normA * normB)
}

/**
 * 本机模型探测：`models/` 在 .gitignore 里（24MB 权重不入库），所以这里必须按"有则真测、
 * 无则真测不可用路径"分支，而不是 skip——两条分支都断言真实行为，没有一边是空转。
 */
const resolution = resolveModelDir({ moduleUrl: import.meta.url })

if (resolution.ok) {
  describe('OnnxEmbedder（本机 BGE-small-zh-v1.5 权重）', () => {
    it('给定真实模型当嵌入则产出 512 维单位向量，且同文本与批组合无关', async () => {
      const embedder = new OnnxEmbedder()
      const available = await embedder.available()
      expect(available, `模型不可用原因：${embedder.unavailableReason() ?? '未知'}`).toBe(true)

      const weather = '今天天气很好'
      const weather2 = '今天的天气真不错'
      const database = 'PostgreSQL 单库事务与 pgvector 向量检索'
      const vectors = await embedder.embed([weather, weather2, database])
      expect(vectors).toHaveLength(3)
      for (const vector of vectors) {
        expect(vector).toHaveLength(512)
        expect(vector.every(value => Number.isFinite(value))).toBe(true)
        expect(vector.some(value => value !== 0)).toBe(true)
        expect(norm(vector)).toBeCloseTo(1, 5)
      }

      // 同一文本单独嵌入 vs 与其它文本同批嵌入必须逐位相同（量化模型对批内邻居敏感，已改为逐条前向）。
      const single = (await embedder.embed([weather]))[0] ?? []
      expect(single).toEqual(vectors[0])

      // 语义门控：同义句明显比跨领域句更近（实测 0.89 vs 0.16），证明不是伪向量。
      const related = cosine(vectors[0] ?? [], vectors[1] ?? [])
      const unrelated = cosine(vectors[0] ?? [], vectors[2] ?? [])
      expect(related).toBeGreaterThan(0.6)
      expect(unrelated).toBeLessThan(0.5)
      expect(related).toBeGreaterThan(unrelated)

      await expect(embedder.embed([])).resolves.toEqual([])
      await embedder.close()
      await expect(embedder.available()).resolves.toBe(false)
      expect(embedder.unavailableReason()).toMatch(/已关闭/)
    })
  })
} else {
  describe('OnnxEmbedder（本机缺少 BGE 权重）', () => {
    it('给定模型缺失当探测则 available=false 且 embed 抛 unsupported，并给出可复现原因', async () => {
      const embedder = new OnnxEmbedder()
      await expect(embedder.available()).resolves.toBe(false)
      const reason = embedder.unavailableReason()
      expect(reason).toMatch(/未找到模型|权重目录不存在|缺少/)
      const failure = await embedder.embed(['x']).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(OmbFailure)
      if (failure instanceof OmbFailure) {
        expect(failure.error.code).toBe('unsupported')
        expect(String((failure.error.details as { reason?: string }).reason)).toContain('模型')
      }
      expect(resolution.reason).toBe(reason)
    })
  })
}
