/**
 * 3.7 Wave 2 / 审计 P9：向量查询必须按当前嵌入器归属过滤。
 *
 * 背景：用户库实测有 16 条 bge-small-zh-512 + 3 条 hash-bow-256 向量共存。
 * 审计怀疑"它们会被喂进同一个查询空间"。结论：`searchVector` 的 SQL 按
 * `model_id/dim/revision` 三元组过滤（`store.ts` 的 `searchVector`），因此
 * 旧模型行**结构性**不参与排序；本测试把这条结构保证钉住（不是靠注释）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EmbeddingVector } from '../../../modules/memory/store.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { vectorToBlob } from '../../../modules/memory/embed.js'
import { fixedClock, makeRecord, tempWorkspace, testPort, type TempWorkspace } from './helpers.js'

const BGE = { modelId: 'bge-small-zh-v1.5-512', dim: 512, revision: '1' } as const
const HASH_BOW = { modelId: 'hash-bow-256', dim: 256, revision: '1' } as const

interface Fixture {
  readonly store: SqliteMemoryStore
  readonly raw: { prepare(sql: string): { run(...params: readonly unknown[]): unknown } }
  cleanup(): Promise<void>
}

function fixture(): Fixture {
  const ws: TempWorkspace = tempWorkspace('omb-vec-attr-')
  const clock = fixedClock()
  const port = testPort(ws.dir)
  const logger = { debug: () => {}, info: () => {}, warn: () => {} }
  const store = openMemoryStore({ scope: 'user', dbPath: join(ws.dir, 'identity', 'knowledge.db'), port, logger, clock })
  const raw = port.databases[0]?.raw as unknown as Fixture['raw']
  return {
    store,
    raw,
    async cleanup(): Promise<void> {
      await store.close()
      ws.cleanup()
    },
  }
}

function unitVector(dim: number): Float32Array {
  const vector = new Float32Array(dim)
  vector[0] = 1
  return vector
}

describe('向量归属过滤（P9）', () => {
  it('混排库里只返回当前嵌入器的行；旧 hash-bow 行结构性不参与', async () => {
    const f = fixture()
    await f.store.put(makeRecord({ id: 'm1', text: '当前模型编码的记忆' }))
    await f.store.put(makeRecord({ id: 'm2', text: '旧哈希词袋编码的记忆' }))
    await f.store.setEmbeddingMeta(BGE)

    const current: EmbeddingVector = { memoryId: 'm1', ...BGE, vector: unitVector(512) }
    await f.store.putEmbedding(current)
    // 直接写一条旧身份的行（模拟换模型前的存量；putEmbedding 会拒绝跨身份，所以走原始 SQL）
    f.raw
      .prepare(
        'INSERT INTO embedding (memory_id, model_id, dim, revision, vector, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('m2', HASH_BOW.modelId, HASH_BOW.dim, HASH_BOW.revision, vectorToBlob(unitVector(256)), null)

    expect(await f.store.countEmbeddings()).toBe(2) // 混排是真实存在的

    const hits = await f.store.searchVector({
      embedding: unitVector(512),
      expect: BGE,
      limit: 10,
      minScore: 0,
    })
    expect(hits.map(hit => hit.id)).toEqual(['m1'])
    await f.cleanup()
  })

  it('归属三元组不匹配时查询为空（不会退化成"忽略身份"）', async () => {
    const f = fixture()
    await f.store.put(makeRecord({ id: 'm1', text: '当前模型编码的记忆' }))
    await f.store.setEmbeddingMeta(BGE)
    await f.store.putEmbedding({ memoryId: 'm1', ...BGE, vector: unitVector(512) })

    const mismatched = await f.store.searchVector({
      embedding: unitVector(512),
      expect: { modelId: 'bge-small-zh-v1.5-512', dim: 512, revision: '2' },
      limit: 10,
      minScore: 0,
    })
    expect(mismatched).toEqual([])
    await f.cleanup()
  })
})
