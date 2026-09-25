/**
 * `modules/memory/embed.ts`：哈希词袋嵌入器、向量原语、归属校验。
 *
 * 移植自 §11.3 的 `tests/m3/vector-retrieval.test.ts` 语义（维度不匹配自报告、重编码幂等），
 * 并补上旧实现的两处缺陷的反例：**向量可归属**、**损坏 BLOB 可见**。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HASH_BOW_REVISION,
  blobDecodeFailureCount,
  blobToVector,
  checkEmbedderCompat,
  cosineSimilarity,
  hashBagEmbedder,
  resetBlobDecodeFailures,
  vectorToBlob,
} from '../../../modules/memory/embed.js'

describe('hashBagEmbedder —— 身份标签（归属标签会随向量持久化）', () => {
  it('默认 256 维：id / dimensions / revision 三者如实标注', () => {
    const e = hashBagEmbedder()
    expect(e.id).toBe('hash-bow-256')
    expect(e.dimensions).toBe(256)
    expect(e.revision).toBe(HASH_BOW_REVISION)
    expect(e.revision).toBe('1')
  })

  it('维度改变时 id 随之改变——同一算法不同维度不是同一个空间', () => {
    const e = hashBagEmbedder(512)
    expect(e.id).toBe('hash-bow-512')
    expect(e.dimensions).toBe(512)
  })

  it('非法维度 fail-loud（不静默产出一个坏维度的嵌入器）', () => {
    expect(() => hashBagEmbedder(0)).toThrow(/正整数/)
    expect(() => hashBagEmbedder(-8)).toThrow(/正整数/)
    expect(() => hashBagEmbedder(12.5)).toThrow(/正整数/)
  })
})

describe('hashBagEmbedder —— 向量范围与行为', () => {
  it('批量编码：条数一致、维度一致', async () => {
    const e = hashBagEmbedder()
    const out = await e.embed(['长期记忆系统', 'SQLite FTS5', ''])
    expect(out).toHaveLength(3)
    for (const v of out) expect(v).toHaveLength(256)
  })

  it('L2 归一化：非空文本范数为 1（因此点积即余弦）', async () => {
    const e = hashBagEmbedder()
    const [v] = await e.embed(['长期记忆系统与 SQLite FTS5'])
    let norm = 0
    for (const x of v!) norm += x * x
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6)
  })

  it('分量全部有限且落在 [-1, 1]（归一化后的必然范围）', async () => {
    const e = hashBagEmbedder()
    const [v] = await e.embed(['确定性哈希词袋：长期记忆系统 FTS5 ENOENT'])
    let nonzero = 0
    for (const x of v!) {
      expect(Number.isFinite(x)).toBe(true)
      expect(Math.abs(x)).toBeLessThanOrEqual(1)
      if (x !== 0) nonzero++
    }
    expect(nonzero).toBeGreaterThan(0)
  })

  it('空文本 → 零向量（不参与检索，而不是随机方向）', async () => {
    const e = hashBagEmbedder()
    const [v] = await e.embed(['   '])
    expect([...v!].every((x) => x === 0)).toBe(true)
  })

  it('确定性：同文本 → 逐位相同的向量（重编码幂等的前提）', async () => {
    const e = hashBagEmbedder()
    const [a] = await e.embed(['长期记忆系统'])
    const [b] = await e.embed(['长期记忆系统'])
    expect([...a!]).toEqual([...b!])
  })

  it('token 集合相似者更近：改写/词序变化层面召回（不是语义模型）', async () => {
    const e = hashBagEmbedder()
    const [q, near, far] = await e.embed([
      '长期记忆系统',
      '记忆系统',
      'unrelated english sentence about weather',
    ])
    expect(cosineSimilarity(q!, near!)).toBeGreaterThan(cosineSimilarity(q!, far!))
  })
})

describe('cosineSimilarity —— 不同维度不可比较', () => {
  it('相同向量 → 1', () => {
    const v = new Float32Array([0.6, 0.8])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6)
  })

  it('正交 → 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0)
  })

  it('零向量任一侧 → 0（空文本不产生 NaN）', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0)
  })

  it('维度不一致 → 抛错（不允许静默截断或补零）', () => {
    expect(() => cosineSimilarity(new Float32Array(256), new Float32Array(512))).toThrow(
      /维度不一致/,
    )
  })
})

describe('vectorToBlob / blobToVector —— 往返与损坏可见', () => {
  beforeEach(() => {
    resetBlobDecodeFailures()
  })

  it('往返逐位一致（Float32 精度内精确）', async () => {
    const e = hashBagEmbedder()
    const [v] = await e.embed(['长期记忆系统'])
    const back = blobToVector(vectorToBlob(v!))
    expect(back).not.toBeNull()
    expect([...back!]).toEqual([...v!])
    expect(blobDecodeFailureCount()).toBe(0)
  })

  it('写出的是副本：之后改向量不会污染已落库字节', async () => {
    const e = hashBagEmbedder()
    const [v] = await e.embed(['长期记忆系统'])
    const blob = vectorToBlob(v!)
    const snapshot = [...blob]
    v!.fill(0)
    expect([...blob]).toEqual(snapshot)
  })

  it('带偏移的视图也能解码（SQLite 读回的 BLOB 未必 4 字节对齐）', async () => {
    const e = hashBagEmbedder()
    const [v] = await e.embed(['记忆'])
    const inner = vectorToBlob(v!)
    const padded = new Uint8Array(inner.byteLength + 1)
    padded.set(inner, 1)
    const view = padded.subarray(1) // byteOffset = 1，未对齐
    const back = blobToVector(view)
    expect([...back!]).toEqual([...v!])
    expect(blobDecodeFailureCount()).toBe(0)
  })

  it('长度非 4 的倍数 → null **并计数**（旧实现静默返回 null，损坏不可见）', () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5])
    expect(blobToVector(bad)).toBeNull()
    expect(blobDecodeFailureCount()).toBe(1)
    expect(blobToVector(new Uint8Array([1, 2]))).toBeNull()
    expect(blobDecodeFailureCount()).toBe(2)
  })

  it('类型不可识别 → null 并计数（列被写进别的东西也必须可见）', () => {
    expect(blobToVector('not a blob')).toBeNull()
    expect(blobToVector(42)).toBeNull()
    expect(blobToVector({ length: 4 })).toBeNull()
    expect(blobDecodeFailureCount()).toBe(3)
  })

  it('未编码（null / undefined / 空字节串）→ null 但**不**计为损坏', () => {
    expect(blobToVector(null)).toBeNull()
    expect(blobToVector(undefined)).toBeNull()
    expect(blobToVector(new Uint8Array(0))).toBeNull()
    expect(blobDecodeFailureCount()).toBe(0)
  })

  it('reset 归零计数（维护窗口可重新观测）', () => {
    blobToVector(new Uint8Array([1]))
    expect(blobDecodeFailureCount()).toBe(1)
    resetBlobDecodeFailures()
    expect(blobDecodeFailureCount()).toBe(0)
  })
})

describe('checkEmbedderCompat —— 拒绝无法归属的向量（D2）', () => {
  const bow256 = hashBagEmbedder(256)
  /** 神经嵌入通道的归属标签（id 携带维度；见 kernel/abi/ports.ts:101 的命名口径）。 */
  const BGE_ID = 'bge-small-zh-v1.5-512'

  it('库内无向量（stored = null）→ 允许（首次建立通道）', () => {
    expect(checkEmbedderCompat(null, bow256)).toEqual({ ok: true })
  })

  it('库内 512 维 BGE vs 当前 256 维哈希词袋 → **检出维度不匹配**', () => {
    const verdict = checkEmbedderCompat(
      { modelId: 'bge-small-zh-v1.5-512', dim: 512, revision: '1' },
      bow256,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('维度不匹配')
    expect(verdict.reason).toContain('库内 512')
    expect(verdict.reason).toContain('当前嵌入器 256')
  })

  it('同维但不同模型 → 拒绝（余弦不可比）', () => {
    const verdict = checkEmbedderCompat({ modelId: 'other-model', dim: 256, revision: '1' }, bow256)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('模型不匹配')
  })

  it('同模型不同修订 → 拒绝并说明需重编码', () => {
    const verdict = checkEmbedderCompat({ modelId: bow256.id, dim: 256, revision: '0' }, bow256)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('修订不匹配')
    expect(verdict.reason).toContain('需重编码')
  })

  it('完全一致 → 通过（同空间可比较）', () => {
    expect(
      checkEmbedderCompat({ modelId: bow256.id, dim: bow256.dimensions, revision: bow256.revision }, bow256),
    ).toEqual({ ok: true })
  })

  it('BGE 与哈希词袋即便维度被强行对齐也仍然不匹配（id 不同 → 不同空间）', () => {
    const verdict = checkEmbedderCompat({ modelId: BGE_ID, dim: 256, revision: '1' }, bow256)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('模型不匹配')
  })
})
