/**
 * `createVectorChannel` —— 向量通道的适配层（`retrieve.ts` 的 `RetrievalChannel`）。
 *
 * 契约要点（Lead 冻结的方案 a）：
 * - 通道**只**负责：解析嵌入器、取得查询向量、给出归属标签与余弦下限；
 * - 归属过滤与余弦由 `MemoryStore.searchVector` 负责（**下推到 SQL**）→ 本文件断言"通道没算余弦"；
 * - 不可用（无嵌入器 / 无向量口 / 编码失败 / 维度不符 / 检索抛错）→ **返回空数组 + 可读原因**，绝不抛。
 *
 * 真实权重不参与：模型目录用临时目录，装载器注入 fake。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import {
  SERVICES,
  type Embedder,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type ScoredHit,
  type SecondaryChannelRegistry,
  type TaggedStore,
  type VectorQuery,
} from '../../../kernel/abi/index.js'
import { HASH_BOW_COSINE_FLOOR, hashBagEmbedder } from '../../../modules/memory/embed.js'
import { BGE_COSINE_FLOOR, BGE_DIMENSIONS, BGE_EMBEDDER_ID } from '../../../modules/memory/onnx.js'
import { retrieve } from '../../../modules/memory/retrieve.js'
import type { RetrievalChannel } from '../../../modules/memory/retrieve.js'
import {
  EMBEDDER_SERVICE,
  cosineFloorFor,
  createVectorChannel,
  createVectorModule,
  vectorChannel,
  type VectorModuleInstance,
} from '../../../modules/memory/vector.js'
import { fuseByRank, rankHits } from '../../../modules/memory/retrieve.js'
import type { OnnxLoad } from '../../../modules/memory/onnx.js'

const TEMP_ROOTS: string[] = []

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omb-channel-'))
  TEMP_ROOTS.push(root)
  return root
}

function makeModelDir(): string {
  const dir = join(tempRoot(), 'models', 'bge-small-zh-v1.5')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model_quantized.onnx'), 'graph')
  writeFileSync(join(dir, 'model_quantized.onnx_data'), 'weights')
  writeFileSync(join(dir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\n')
  return dir
}

const BGE: Embedder = {
  id: BGE_EMBEDDER_ID,
  dimensions: BGE_DIMENSIONS,
  revision: '1',
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map(() => {
      const v = new Float32Array(BGE_DIMENSIONS)
      v[0] = 1
      return v
    })
  },
}

/** 记录调用参数的假 store：通道交给它的东西就是本用例要断言的东西。 */
function spyStore(options: {
  hits?: readonly ScoredHit[]
  throwOnVector?: string
  omitSearchVector?: boolean
} = {}): { store: MemoryStore; calls: VectorQuery[] } {
  const calls: VectorQuery[] = []
  const base = {
    scope: 'user' as MemoryScope,
    async put(): Promise<void> {},
    async get(): Promise<MemoryRecord | undefined> {
      return undefined
    },
    async getMany(): Promise<readonly MemoryRecord[]> {
      return []
    },
    async searchLexical(): Promise<readonly ScoredHit[]> {
      return []
    },
    async upsertEdge(): Promise<void> {},
    async walkGraph() {
      return { nodes: [], edges: [] }
    },
    async forget() {
      return 0
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      return fn()
    },
    async stats() {
      return { scope: 'user' as MemoryScope, rows: 0, schemaVersion: 1, vectors: null }
    },
    async close(): Promise<void> {},
  }
  const store = {
    ...base,
    async searchVector(query: VectorQuery): Promise<readonly ScoredHit[]> {
      calls.push(query)
      if (options.throwOnVector !== undefined) throw new Error(options.throwOnVector)
      return options.hits ?? [{ id: 'v1', score: 0.66, channel: 'vector' as const }]
    },
  } as MemoryStore
  if (options.omitSearchVector === true) {
    // 模拟"旧版/替身 store 没有向量口"：结构面检查必须降级而不是抛 TypeError
    delete (store as unknown as Record<string, unknown>)['searchVector']
  }
  return { store, calls }
}

function tagged(store: MemoryStore): TaggedStore {
  return { scope: 'user', store }
}

function query(overrides: Partial<Parameters<ReturnType<typeof createVectorChannel>['search']>[0]> = {}) {
  return {
    store: tagged(spyStore().store),
    text: '长期记忆系统',
    scope: 'user' as MemoryScope,
    limit: 7,
    ...overrides,
  }
}

describe('createVectorChannel —— 交给库的东西必须精确', () => {
  it('名字是 vector，命中按库返回的顺序原样透传（通道不重排）', async () => {
    const hits: ScoredHit[] = [
      { id: 'b', score: 0.9, channel: 'vector' },
      { id: 'a', score: 0.8, channel: 'vector' },
    ]
    const spy = spyStore({ hits })
    const kern = createKernel()
    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope'), dimensions: 256 })

    const channel = module.channel(kern.kernel)
    expect(channel.name).toBe('vector')
    const got = await channel.search(
      query({ store: tagged(spy.store), kinds: ['semantic' as MemoryKind] }),
    )
    expect(got).toBe(hits) // 同一个引用：通道不复制、不重排、不算分
    dispose()
  })

  it('归属标签 = 当前嵌入器身份；kinds/limit 透传', async () => {
    const spy = spyStore()
    const kern = createKernel()
    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope'), dimensions: 256 })

    await module.channel(kern.kernel).search(
      query({ store: tagged(spy.store), kinds: ['episodic' as MemoryKind], limit: 3 }),
    )
    expect(spy.calls).toHaveLength(1)
    const sent = spy.calls[0]!
    expect(sent.expect).toEqual({ modelId: 'hash-bow-256', dim: 256, revision: '1' })
    expect(sent.kinds).toEqual(['episodic'])
    expect(sent.limit).toBe(3)
    expect(sent.embedding).toBeInstanceOf(Float32Array)
    expect(sent.embedding).toHaveLength(256)
    // 哈希词袋路径 → 稀疏下限 0（**不是** BGE 的 0.375；混用会静默改变召回量）
    expect(sent.minScore).toBe(HASH_BOW_COSINE_FLOOR)
    expect(sent.minScore).toBe(0)
    dispose()
  })

  it('BGE 通道：归属标签变 512，下限变标定过的 0.375', async () => {
    const spy = spyStore()
    const kern = createKernel()
    const module = createVectorModule({
      loadOnnx: async (options): Promise<OnnxLoad> => ({
        ok: true,
        embedder: BGE,
        modelDir: options.modelDir ?? 'x',
      }),
    })
    const dispose = module.apply(kern.kernel, { modelDir: makeModelDir() })
    await vi.waitFor(() => expect(module.state().channel).toBe('onnx'))

    await module.channel(kern.kernel).search(query({ store: tagged(spy.store) }))
    const sent = spy.calls[0]!
    expect(sent.expect).toEqual({ modelId: BGE_EMBEDDER_ID, dim: BGE_DIMENSIONS, revision: '1' })
    expect(sent.minScore).toBe(BGE_COSINE_FLOOR)
    expect(sent.embedding).toHaveLength(BGE_DIMENSIONS)
    dispose()
  })

  it('检索侧已算好的查询向量会被复用（不重复编码）', async () => {
    let embedCalls = 0
    const counting: Embedder = {
      id: 'hash-bow-256',
      dimensions: 256,
      revision: '1',
      async embed(texts) {
        embedCalls++
        return texts.map(() => new Float32Array(256))
      },
    }
    const spy = spyStore()
    const kern = createKernel()
    kern.kernel.provide(EMBEDDER_SERVICE, counting)
    const channel = createVectorChannel({ kernel: kern.kernel })
    const precomputed = new Float32Array(256)
    precomputed[7] = 1

    await channel.search(query({ store: tagged(spy.store), embedding: precomputed }))
    expect(embedCalls).toBe(0)
    expect(spy.calls[0]!.embedding).toBe(precomputed)
  })

  it('minScore 可覆盖（标定用）', async () => {
    const spy = spyStore()
    const kern = createKernel()
    kern.kernel.provide(EMBEDDER_SERVICE, hashBagEmbedder(256))
    const channel = createVectorChannel({ kernel: kern.kernel, minScore: 0.42 })
    await channel.search(query({ store: tagged(spy.store) }))
    expect(spy.calls[0]!.minScore).toBe(0.42)
  })

  it('cosineFloorFor：按嵌入器身份选下限（两条路径不共用阈值）', () => {
    expect(cosineFloorFor(hashBagEmbedder(256))).toBe(HASH_BOW_COSINE_FLOOR)
    expect(cosineFloorFor(hashBagEmbedder(512))).toBe(HASH_BOW_COSINE_FLOOR)
    expect(cosineFloorFor(BGE)).toBe(BGE_COSINE_FLOOR)
  })
})

describe('createVectorChannel —— 不可用一律返回空 + 可读原因（绝不抛）', () => {
  it('无嵌入器服务（模块已关闭）→ 空 + 原因', async () => {
    const kern = createKernel()
    const reasons: string[] = []
    const channel = createVectorChannel({
      kernel: kern.kernel,
      onDegraded: (r) => reasons.push(r),
    })
    const got = await channel.search(query({ store: tagged(spyStore().store) }))
    expect(got).toEqual([])
    expect(reasons[0]).toContain('嵌入器服务不可用')
  })

  it('库没有 searchVector（版本不一致）→ 空 + 原因', async () => {
    const kern = createKernel()
    kern.kernel.provide(EMBEDDER_SERVICE, hashBagEmbedder())
    const reasons: string[] = []
    const channel = createVectorChannel({ kernel: kern.kernel, onDegraded: (r) => reasons.push(r) })
    const got = await channel.search(query({ store: tagged(spyStore({ omitSearchVector: true }).store) }))
    expect(got).toEqual([])
    expect(reasons[0]).toContain('未实现 searchVector')
  })

  it('编码失败 → 空 + 原因（嵌入器抛异常不外泄）', async () => {
    const kern = createKernel()
    kern.kernel.provide(EMBEDDER_SERVICE, {
      id: 'boom',
      dimensions: 8,
      revision: '1',
      async embed() {
        throw new Error('embed boom')
      },
    } satisfies Embedder)
    const reasons: string[] = []
    const channel = createVectorChannel({ kernel: kern.kernel, onDegraded: (r) => reasons.push(r) })
    expect(await channel.search(query({ store: tagged(spyStore().store) }))).toEqual([])
    expect(reasons[0]).toContain('编码失败')
    expect(reasons[0]).toContain('embed boom')
  })

  it('库抛异常（归属不符 / 维度不符）→ 空 + 原因', async () => {
    const kern = createKernel()
    kern.kernel.provide(EMBEDDER_SERVICE, hashBagEmbedder())
    const reasons: string[] = []
    const channel = createVectorChannel({ kernel: kern.kernel, onDegraded: (r) => reasons.push(r) })
    const got = await channel.search(
      query({ store: tagged(spyStore({ throwOnVector: '向量检索缺少完整归属标签' }).store) }),
    )
    expect(got).toEqual([])
    expect(reasons[0]).toContain('向量检索失败')
    expect(reasons[0]).toContain('归属标签')
  })

  it('查询向量维度与当前嵌入器不符 → 空 + 原因（跨空间比距离无意义）', async () => {
    const kern = createKernel()
    kern.kernel.provide(EMBEDDER_SERVICE, hashBagEmbedder(256))
    const reasons: string[] = []
    const channel = createVectorChannel({ kernel: kern.kernel, onDegraded: (r) => reasons.push(r) })
    const got = await channel.search(
      query({ store: tagged(spyStore().store), embedding: new Float32Array(512) }),
    )
    expect(got).toEqual([])
    expect(reasons[0]).toContain('512 维')
    expect(reasons[0]).toContain('256 维')
  })

  it('原因出口自己抛异常也不影响检索结果', async () => {
    const kern = createKernel()
    const channel = createVectorChannel({
      kernel: kern.kernel,
      onDegraded: () => {
        throw new Error('sink boom')
      },
    })
    await expect(channel.search(query({ store: tagged(spyStore().store) }))).resolves.toEqual([])
  })
})

describe('检索期降级写进模块状态与状态面（空通道不是静默的）', () => {
  it('降级 → 计数与原因可见；恢复正常 → 原因被清掉', async () => {
    const kern = createKernel()
    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope') })
    const channel = module.channel(kern.kernel)
    const spy = spyStore()

    // 查询向量维度不符 → 降级
    await channel.search(query({ store: tagged(spy.store), embedding: new Float32Array(512) }))
    expect(module.state().lastSearchError).toContain('不符')
    expect(module.state().channelErrors).toBe(1)

    const health = module.manifest.health()
    expect(health.state).toBe('degraded')
    expect(health.detail).toContain('最近一次向量检索降级')
    expect(health.metrics?.['channelErrors']).toBe(1)
    const status = kern.status().join('\n')
    expect(status).toContain('最近一次检索：降级')
    expect(status).toContain('累计降级 1 次')

    // 正常一次 → 清掉检索期原因，健康不再提"最近一次检索降级"
    //（装载期原因仍在：本用例的模型目录故意不存在 → 通道仍是哈希兜底）
    await channel.search(query({ store: tagged(spy.store) }))
    expect(module.state().lastSearchError).toBeNull()
    expect(module.state().channelErrors).toBe(1) // 累计次数保留（历史可见）
    expect(module.manifest.health().detail).not.toContain('最近一次向量检索降级')
    expect(kern.status().join('\n')).toContain('最近一次检索：正常')

    // 卸载后无残留读数
    dispose()
    expect(module.state().lastSearchError).toBeNull()
    expect(module.state().channelErrors).toBe(0)
  })

  it('断开模块后调用残留通道：空 + 原因，不抛', async () => {
    const kern = createKernel()
    const module = createVectorModule()
    const channel = module.channel(kern.kernel)
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope') })
    dispose()
    await expect(channel.search(query({ store: tagged(spyStore().store) }))).resolves.toEqual([])
    expect(module.state().lastSearchError).toContain('嵌入器服务不可用')
  })
})

// ---------------------------------------------------------------------------
// §5.7 端到端：词法 + 向量经 RRF 融合（这才是"语义召回真的发生"的证据）
// ---------------------------------------------------------------------------

function record(id: string, text: string): MemoryRecord {
  return {
    id,
    scope: 'user',
    kind: 'semantic',
    text,
    contentHash: `h-${id}`,
    sourceRef: 'session:t1',
    assertedBy: 'user',
    observedAt: 1,
    validTo: null,
    supersededBy: null,
    lastUsedAt: 0,
    useCount: 0,
    project: null,
  }
}

/** 词法命中 A，向量命中 B（两条通道各贡献一条）→ 融合后两条都要在。 */
function twoChannelStore(): MemoryStore {
  const a = record('a', '长期记忆系统')
  const b = record('b', '向量通道召回的改写句')
  const spy = spyStore({ hits: [{ id: 'b', score: 0.83, channel: 'vector' }] })
  return {
    ...spy.store,
    async getMany(ids: readonly string[]): Promise<readonly MemoryRecord[]> {
      return [a, b].filter((r) => ids.includes(r.id))
    },
    async searchLexical(): Promise<readonly ScoredHit[]> {
      return [{ id: 'a', score: 2.5, channel: 'lexical' }]
    },
    async searchVector(query: VectorQuery): Promise<readonly ScoredHit[]> {
      return spy.store.searchVector(query)
    },
  }
}

describe('§5.7 端到端：向量通道注入 retrieve 后与词法 RRF 融合', () => {
  it('通道输出可直接进入 RRF（形状契约：id + channel 标签 + 顺序即排名）', async () => {
    const kern = createKernel()
    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope') })
    const channel = module.channel(kern.kernel)

    const hits = await channel.search(query({ store: tagged(spyStore().store) }))
    expect(hits).toHaveLength(1)
    const fused = fuseByRank(
      [
        { channel: 'lexical', scope: 'user', hits: rankHits([{ id: 'a', score: 3, channel: 'lexical' }]) },
        { channel: 'vector', scope: 'user', hits: rankHits(hits) },
      ],
      60,
    )
    expect(fused.map((c) => c.id).sort()).toEqual(['a', 'v1'])
    const vectorOnly = fused.find((c) => c.id === 'v1')
    expect(vectorOnly?.channels).toEqual(['vector'])
    expect(vectorOnly?.scopes).toEqual(['user'])
    dispose()
  })

  it('两条通道的命中都被召回，且通道名可区分（排名融合而非分数相加）', async () => {
    const kern = createKernel()
    const module: VectorModuleInstance = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope'), dimensions: 256 })
    const stores: readonly TaggedStore[] = [{ scope: 'user', store: twoChannelStore() }]

    const embedder = kern.kernel.service<Embedder>(EMBEDDER_SERVICE)
    expect(embedder).toBeDefined()

    const result = await retrieve(stores, { text: '记忆系统', limit: 5 }, {
      clock: { now: () => 1 },
      embedder: embedder!,
      channels: [module.channel(kern.kernel)],
    })

    expect(result.items.map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect([...result.stats.channelsUsed].sort()).toEqual(['lexical', 'vector'])
    expect(result.degraded).toEqual([])
    const byId = new Map(result.items.map((i) => [i.id, i]))
    expect(byId.get('b')!.channels).toContain('vector')
    expect(byId.get('a')!.channels).toContain('lexical')
    dispose()
  })

  it('关掉向量模块（服务消失）→ 只有词法命中，且**不记为降级**', async () => {
    const kern = createKernel()
    const module = createVectorModule()
    // 通道对象照旧被 dsh 持有（模块被拨掉但引用还在）：它必须自己降级而不是让检索出错
    const channel = module.channel(kern.kernel)
    const stores: readonly TaggedStore[] = [{ scope: 'user', store: twoChannelStore() }]

    const result = await retrieve(stores, { text: '记忆系统', limit: 5 }, {
      clock: { now: () => 1 },
      channels: [channel],
    })
    expect(result.items.map((i) => i.id)).toEqual(['a'])
    expect(result.stats.channelsUsed).toEqual(['lexical'])
    // 通道返回空数组是"这一路没有贡献"，不是"检索降级"
    expect(result.degraded).toEqual([])
  })

  it('单例导出 vectorChannel(kernel) 可直接接线', async () => {
    const kern = createKernel()
    const channel = vectorChannel(kern.kernel)
    expect(channel.name).toBe('vector')
    await expect(channel.search(query({ store: tagged(spyStore().store) }))).resolves.toEqual([])
  })
})

describe('生产接线：登记进 retrieval:channels（否则通道再对也没人消费）', () => {
  it('apply 同步登记、dispose 注销（登记处是检索侧唯一的取通道入口）', () => {
    const kern = createKernel()
    const registry = kern.kernel.service<SecondaryChannelRegistry<RetrievalChannel>>(
      SERVICES.channelRegistry,
    )
    expect(registry).toBeDefined()
    expect(registry!.list()).toEqual([])

    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope') })
    expect(registry!.list().map((c) => c.name)).toEqual(['vector'])

    // 幂等：重复 dispose 不抛，且不会把别人的通道删掉
    dispose()
    dispose()
    expect(registry!.list()).toEqual([])
  })

  it('§5.7 端到端（走生产接线）：registry.list() 喂给 retrieve → 两条通道都参与融合', async () => {
    const kern = createKernel()
    const module: VectorModuleInstance = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: join(tempRoot(), 'nope'), dimensions: 256 })
    const registry = kern.kernel.service<SecondaryChannelRegistry<RetrievalChannel>>(
      SERVICES.channelRegistry,
    )!
    const stores: readonly TaggedStore[] = [{ scope: 'user', store: twoChannelStore() }]
    const embedder = kern.kernel.service<Embedder>(EMBEDDER_SERVICE)

    const result = await retrieve(stores, { text: '记忆系统', limit: 5 }, {
      clock: { now: () => 1 },
      ...(embedder !== undefined ? { embedder } : {}),
      channels: registry.list(), // ← 与 modules/memory/index.ts 的 ports() 同一路径
    })

    expect(result.items.map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect([...result.stats.channelsUsed].sort()).toEqual(['lexical', 'vector'])
    expect(result.degraded).toEqual([])

    dispose()
    const after = await retrieve(stores, { text: '记忆系统', limit: 5 }, {
      clock: { now: () => 1 },
      ...(embedder !== undefined ? { embedder } : {}),
      channels: registry.list(), // 关掉模块 → 登记处为空 → 纯词法（完整可用）
    })
    expect(after.items.map((i) => i.id)).toEqual(['a'])
    expect(after.stats.channelsUsed).toEqual(['lexical'])
  })
})
