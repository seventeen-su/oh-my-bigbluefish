/**
 * 向量落盘：`memory/written` → 待编码队列 → `encodePending()` 批量编码 → `putEmbedding`。
 *
 * 这一层存在的理由（Lead 派的活）：`putEmbedding` 曾经全仓无调用方 → `embedding` 表恒空 →
 * `searchVector` 结构上恒返回 `[]`（通道接得再好也查空表）。
 *
 * 用例覆盖：入队去重 / 批量（N 条一次 `embed`）/ 归属标签 / 队列上界 / 空文本与缺失记录 /
 * 无嵌入器与无向量口时**保留队列** / 编码抛错 / 库拒绝（归属不符）/ 退订与注销 /
 * 以及**端到端：写入 → 编码 → `searchVector` 命中**（真实 SQLite 库 + 哈希词袋，不需要 ONNX）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import {
  SERVICES,
  type Embedder,
  type Kernel,
  type Logger,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type SecondaryChannelRegistry,
  type SqliteStatementLike,
  type StorageHostPort,
  type StoreSet,
} from '../../../kernel/abi/index.js'
import { asVectorStore, openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { retrieve, type RetrievalChannel } from '../../../modules/memory/retrieve.js'
import {
  DEFAULT_MAX_PENDING,
  EMBEDDER_SERVICE,
  VECTOR_ENCODER_SERVICE,
  createVectorModule,
  type VectorEncoder,
} from '../../../modules/memory/vector.js'

const TEMP_DIRS: string[] = []

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {} }
const clock = { now: () => 1 }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omb-encode-'))
  TEMP_DIRS.push(dir)
  return dir
}

/** 宿主存储端口：`node:sqlite` 的最小适配（与 store 的 `SqliteLike` 结构面对齐）。 */
function memoryPort(userDbPath: string): StorageHostPort {
  return {
    userDbPath,
    createDirs: true,
    openDatabase: (path: string) => {
      const db = new DatabaseSync(path)
      return {
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => db.prepare(sql) as unknown as SqliteStatementLike,
        close: () => db.close(),
      }
    },
  }
}

/** 真实 SQLite 库（`asVectorStore` 只认本实现，所以 happy path 必须用它）。 */
function realStore(scope: MemoryScope = 'user'): SqliteMemoryStore {
  const dir = tempDir()
  const dbPath =
    scope === 'user' ? join(dir, 'knowledge.db') : join(dir, 'proj', '.omb', 'memory', 'session.db')
  const port = memoryPort(join(dir, 'knowledge.db'))
  return openMemoryStore({ scope, dbPath, port, logger, clock })
}

function storeSetOf(scope: MemoryScope, store: MemoryStore): StoreSet {
  return {
    projectScope: null,
    stores: [{ scope, store }],
    store: wanted => (wanted === scope ? store : undefined),
    migrated: [],
    close: async () => {},
  }
}

function recordOf(id: string, text: string, scope: MemoryScope = 'user'): MemoryRecord {
  return {
    id,
    scope,
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

/** 普通对象形态的库（不是 `SqliteStore`）→ `asVectorStore` 必然未命中。 */
function fakeStore(options: { records?: readonly MemoryRecord[] } = {}): MemoryStore {
  const records = options.records ?? []
  return {
    scope: 'user',
    async put(): Promise<void> {},
    async get(id) {
      return records.find(r => r.id === id)
    },
    async getMany(ids) {
      return records.filter(r => ids.includes(r.id))
    },
    async searchLexical() {
      return []
    },
    async searchVector() {
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
      return { scope: 'user' as MemoryScope, rows: records.length, schemaVersion: 1, vectors: null }
    },
    async close(): Promise<void> {},
  }
}

interface Booted {
  readonly kernel: Kernel
  readonly encoder: VectorEncoder
  readonly dispose: () => void
  readonly status: () => readonly string[]
}

/**
 * 起一个模块实例。`modelDir` 指向不存在的目录 → 通道稳定留在哈希词袋（不碰真实 ONNX 权重）；
 * 库套件由 `resolveStoreSets` 注入，避免依赖 store-dev 的服务实现。
 */
function boot(
  sets: () => readonly StoreSet[],
  options: { readonly maxPending?: number } = {},
): Booted {
  const handle = createKernel()
  const instance = createVectorModule({
    loadOnnx: async () => ({ ok: false, reason: '测试：不装载 ONNX（用哈希词袋）' }),
    resolveStoreSets: () => sets(),
  })
  const dispose = instance.apply(handle.kernel, {
    modelDir: join(tempDir(), '不存在的模型目录'),
    maxPending: options.maxPending ?? DEFAULT_MAX_PENDING,
  })
  const encoder = handle.kernel.service<VectorEncoder>(VECTOR_ENCODER_SERVICE)
  if (encoder === undefined) throw new Error('编码队列服务未注册（H-2 违约）')
  return { kernel: handle.kernel, encoder, dispose, status: () => handle.status() }
}

/** `memory/written` 的载荷形状（跨模块契约，本模块不改它）。 */
function written(id: string, scope = 'user'): { id: string; scope: string; kind: string } {
  return { id, scope, kind: 'semantic' }
}

describe('入队：memory/written → 待编码队列', () => {
  it('事件入队、重复 id 只留一条（去重且保序）', () => {
    const store = realStore()
    const booted = boot(() => [storeSetOf('user', store)])
    booted.kernel.emit('memory/written', written('m1'))
    booted.kernel.emit('memory/written', written('m1'))
    booted.kernel.emit('memory/written', written('m2'))
    expect(booted.encoder.pending()).toBe(2)
    expect(booted.encoder.stats().pending).toBe(2)
    booted.dispose()
  })

  it('队列有上界：超界丢**最旧**并计数（写入多、冲刷慢时不无界增长）', () => {
    const store = realStore()
    const booted = boot(() => [storeSetOf('user', store)], { maxPending: 2 })
    for (const id of ['m1', 'm2', 'm3']) booted.kernel.emit('memory/written', written(id))
    expect(booted.encoder.pending()).toBe(2)
    expect(booted.encoder.stats().dropped).toBe(1)
    booted.dispose()
  })

  it('待编码数量写进状态面（写入却没向量必须看得见）', () => {
    const store = realStore()
    const booted = boot(() => [storeSetOf('user', store)])
    booted.kernel.emit('memory/written', written('m1'))
    expect(booted.status().join('\n')).toContain('向量落盘：待编码 1 条')
    booted.dispose()
  })
})

describe('冲刷：批量读 → 一次批编码 → 逐条落盘（带归属标签）', () => {
  it('N 条只调一次 embed；归属标签 = 当前嵌入器身份；全部出队', async () => {
    const store = realStore()
    for (const [id, text] of [
      ['m1', '长期记忆系统'],
      ['m2', 'FTS5 词法检索'],
      ['m3', '向量通道与余弦'],
    ] as const) {
      await store.put(recordOf(id, text))
    }
    const booted = boot(() => [storeSetOf('user', store)])

    const real = booted.kernel.service<Embedder>(EMBEDDER_SERVICE)
    expect(real).toBeDefined()
    let embedCalls = 0
    const batchSizes: number[] = []
    booted.kernel.provide<Embedder>(EMBEDDER_SERVICE, {
      id: real!.id,
      dimensions: real!.dimensions,
      revision: real!.revision,
      async embed(texts) {
        embedCalls += 1
        batchSizes.push(texts.length)
        return real!.embed(texts)
      },
    })

    for (const id of ['m1', 'm2', 'm3']) booted.kernel.emit('memory/written', written(id))
    const outcome = await booted.encoder.encodePending()

    expect(outcome).toEqual({ encoded: 3, skipped: 0, failures: 0 })
    expect(embedCalls).toBe(1)
    expect(batchSizes).toEqual([3])
    expect(booted.encoder.pending()).toBe(0)

    const api = asVectorStore(store)
    expect(api).toBeDefined()
    const stored = await api!.getEmbeddings(['m1', 'm2', 'm3'])
    expect(stored.map(v => v.memoryId).sort()).toEqual(['m1', 'm2', 'm3'])
    for (const vector of stored) {
      expect(vector.modelId).toBe('hash-bow-256')
      expect(vector.dim).toBe(256)
      expect(vector.revision).toBe('1')
      expect(vector.vector).toHaveLength(256)
    }
    booted.dispose()
  })

  it('limit 分批：一次只冲刷 N 条，其余留下', async () => {    const store = realStore()
    for (const id of ['m1', 'm2', 'm3']) await store.put(recordOf(id, `文本 ${id}`))
    const booted = boot(() => [storeSetOf('user', store)])
    for (const id of ['m1', 'm2', 'm3']) booted.kernel.emit('memory/written', written(id))

    const first = await booted.encoder.encodePending(2)
    expect(first.encoded).toBe(2)
    expect(booted.encoder.pending()).toBe(1)
    const second = await booted.encoder.encodePending(2)
    expect(second.encoded).toBe(1)
    expect(booted.encoder.pending()).toBe(0)
    booted.dispose()
  })

  it('端到端：写入 → 编码 → searchVector 能返回该条', async () => {
    const store = realStore()
    await store.put(recordOf('m1', '长期记忆系统'))
    const booted = boot(() => [storeSetOf('user', store)])

    booted.kernel.emit('memory/written', written('m1'))
    const outcome = await booted.encoder.encodePending()
    expect(outcome.encoded).toBe(1)

    const embedder = booted.kernel.service<Embedder>(EMBEDDER_SERVICE)!
    const [query] = await embedder.embed(['长期记忆系统'])
    const hits = await store.searchVector({
      embedding: query!,
      expect: { modelId: embedder.id, dim: embedder.dimensions, revision: embedder.revision },
      limit: 5,
    })
    expect(hits.map(h => h.id)).toEqual(['m1'])
    expect(hits[0]?.channel).toBe('vector')
    booted.dispose()
  })

  it('超界丢弃的是最旧那条：编码后只有最新的两条有向量', async () => {
    const store = realStore()
    for (const id of ['m1', 'm2', 'm3']) await store.put(recordOf(id, `文本 ${id}`))
    const booted = boot(() => [storeSetOf('user', store)], { maxPending: 2 })
    for (const id of ['m1', 'm2', 'm3']) booted.kernel.emit('memory/written', written(id))

    const outcome = await booted.encoder.encodePending()
    expect(outcome.encoded).toBe(2)
    const stored = await asVectorStore(store)!.getEmbeddings(['m1', 'm2', 'm3'])
    expect(stored.map(v => v.memoryId).sort()).toEqual(['m2', 'm3'])
    expect(booted.encoder.stats().dropped).toBe(1)
    booted.dispose()
  })
})

describe('缺省库套件解析：stores.snapshot()（生产路径，不注入 resolveStoreSets）', () => {
  it('从 stores 服务的 snapshot() 取库并完成编码', async () => {
    const store = realStore()
    await store.put(recordOf('m1', '长期记忆系统'))
    const handle = createKernel()
    // store-dev 的 MemoryStoresService 就是这样暴露 snapshot() 的（尚未进 ABI，用结构面）：
    // 本用例证明**生产缺省路径今天就能工作**，不依赖 ABI 冻结。
    handle.kernel.provide(SERVICES.stores, {
      status: () => ({ ready: true, detail: '桩：只有 snapshot 有用', openProjects: [] }),
      forSession: async () => undefined,
      forProject: async () => undefined,
      rememberCwd: () => {},
      close: async () => {},
      snapshot: () => ({ user: storeSetOf('user', store), projects: [] }),
    })

    const instance = createVectorModule({
      loadOnnx: async () => ({ ok: false, reason: '测试：不装载 ONNX（用哈希词袋）' }),
    })
    const dispose = instance.apply(handle.kernel, { modelDir: join(tempDir(), '不存在') })
    handle.kernel.emit('memory/written', written('m1'))

    const outcome = await instance.encoder()!.encodePending()
    expect(outcome).toEqual({ encoded: 1, skipped: 0, failures: 0 })
    expect(await asVectorStore(store)!.getEmbeddings(['m1'])).toHaveLength(1)
    dispose()
  })

  it('库未就绪（snapshot 里没有可用库）→ 可读原因 + 队列保留（不误报成功）', async () => {
    await realStore() // 保证库实现可用，但 stores 服务报告"未就绪"
    const handle = createKernel()
    handle.kernel.provide(SERVICES.stores, {
      status: () => ({ ready: false, detail: '桩：尚未打开任何库', openProjects: [] }),
      forSession: async () => undefined,
      forProject: async () => undefined,
      rememberCwd: () => {},
      close: async () => {},
      snapshot: () => ({ user: undefined, projects: [] }),
    })

    const instance = createVectorModule({ loadOnnx: async () => ({ ok: false, reason: '测试' }) })
    const dispose = instance.apply(handle.kernel, { modelDir: join(tempDir(), '不存在') })
    handle.kernel.emit('memory/written', written('m1'))

    const outcome = await instance.encoder()!.encodePending()
    expect(outcome.encoded).toBe(0)
    expect(outcome.reason).toContain('记忆库未就绪')
    expect(instance.encoder()!.pending()).toBe(1)
    dispose()
  })
})

describe('全链路（生产接线的四个接点）：写入 → 冲刷 → 登记处 → 检索命中', () => {
  it('真实库 + 真实通道 + 真实 retrieve：词法与向量两条通道都命中该条', async () => {
    const store = realStore()
    await store.put(recordOf('m1', '长期记忆系统与向量通道'))
    const handle = createKernel()
    handle.kernel.provide(SERVICES.stores, {
      status: () => ({ ready: true, detail: '桩：直接给库套件', openProjects: [] }),
      forSession: async () => undefined,
      forProject: async () => undefined,
      rememberCwd: () => {},
      close: async () => {},
      snapshot: () => ({ user: storeSetOf('user', store), projects: [] }),
    })
    const instance = createVectorModule({
      loadOnnx: async () => ({ ok: false, reason: '测试：不装载 ONNX（用哈希词袋）' }),
    })
    const dispose = instance.apply(handle.kernel, { modelDir: join(tempDir(), '不存在') })

    // ① 写入侧发事件 → 入队（回调里不编码）
    handle.kernel.emit('memory/written', written('m1'))
    expect(instance.encoder()!.pending()).toBe(1)

    // ② 回合边界冲刷（dsh 的 `flushVectorEncoder` 走同一个服务）
    const flushed = await handle.kernel
      .service<VectorEncoder>(VECTOR_ENCODER_SERVICE)!
      .encodePending(32)
    expect(flushed).toEqual({ encoded: 1, skipped: 0, failures: 0 })

    // ③ 检索侧从登记处取通道（`modules/memory/index.ts` 的 ports() 同一路径）
    const registry = handle.kernel.service<SecondaryChannelRegistry<RetrievalChannel>>(
      SERVICES.channelRegistry,
    )!
    const embedder = handle.kernel.service<Embedder>(EMBEDDER_SERVICE)!
    expect(registry.list().map(c => c.name)).toEqual(['vector'])

    const result = await retrieve([{ scope: 'user', store }], { text: '长期记忆系统', limit: 5 }, {
      clock: handle.kernel.clock,
      embedder,
      channels: registry.list(),
    })

    expect(result.items.map(i => i.id)).toEqual(['m1'])
    expect([...result.stats.channelsUsed].sort()).toEqual(['lexical', 'vector'])
    expect(result.degraded).toEqual([])
    dispose()
  })
})

describe('库就绪时机：晚到的库不算"记录已删除"', () => {
  it('项目库尚未预热（作用域没被任何已打开库覆盖）→ **保留队列**，不当作"已删除"', async () => {
    const user = realStore()
    const project = realStore('project')
    let sets: readonly StoreSet[] = [storeSetOf('user', user)]
    const booted = boot(() => sets)

    // 写入先落项目库（store-dev：项目库的打开可能晚于第一条 memory/written）
    await project.put(recordOf('p1', '项目情境记忆', 'project'))
    booted.kernel.emit('memory/written', written('p1', 'project'))

    const beforeReady = await booted.encoder.encodePending()
    expect(beforeReady.encoded).toBe(0)
    expect(beforeReady.reason).toContain('库尚未就绪')
    expect(booted.encoder.pending()).toBe(1) // 关键：保留，不静默丢

    // 项目库预热完成 → 下一次冲刷成功
    sets = [storeSetOf('user', user), storeSetOf('project', project)]
    const afterReady = await booted.encoder.encodePending()
    expect(afterReady).toEqual({ encoded: 1, skipped: 0, failures: 0 })
    expect(booted.encoder.pending()).toBe(0)
    expect(await asVectorStore(project)!.getEmbeddings(['p1'])).toHaveLength(1)
    booted.dispose()
  })

  it('记录已不存在（作用域被覆盖但库里没有）→ 跳过并出队', async () => {
    const store = realStore()
    const booted = boot(() => [storeSetOf('user', store)])
    booted.kernel.emit('memory/written', written('ghost'))

    const outcome = await booted.encoder.encodePending()
    expect(outcome).toEqual({ encoded: 0, skipped: 1, failures: 0 })
    expect(booted.encoder.pending()).toBe(0)
    booted.dispose()
  })
})

describe('跳过与失败：不静默、也不无限重试', () => {
  it('空文本 → 跳过并出队（没有可编码的内容）', async () => {
    const store = realStore()
    await store.put(recordOf('m1', '   '))
    const booted = boot(() => [storeSetOf('user', store)])
    booted.kernel.emit('memory/written', written('m1'))

    const outcome = await booted.encoder.encodePending()
    expect(outcome).toEqual({ encoded: 0, skipped: 1, failures: 0 })
    expect(booted.encoder.pending()).toBe(0)
    booted.dispose()
  })

  it('记录已不存在 → 跳过并出队（不是失败，也不是可重试状态）', async () => {
    const store = realStore()
    const booted = boot(() => [storeSetOf('user', store)])
    booted.kernel.emit('memory/written', written('ghost'))

    const outcome = await booted.encoder.encodePending()
    expect(outcome).toEqual({ encoded: 0, skipped: 1, failures: 0 })
    expect(booted.encoder.pending()).toBe(0)
    booted.dispose()
  })

  it('库不支持向量写入（整批 asVectorStore 未命中）→ 原因 + **保留队列**', async () => {
    const booted = boot(() => [storeSetOf('user', fakeStore())])
    booted.kernel.emit('memory/written', written('m1'))

    const outcome = await booted.encoder.encodePending()
    expect(outcome.reason).toContain('库不支持向量写入')
    expect(booted.encoder.pending()).toBe(1)
    booted.dispose()
  })

  it('单条所在的库没有向量口（同套件另有支持的库）→ 跳过并留原因，不无限重试', async () => {
    const booted = boot(() => [storeSetOf('user', fakeStore({ records: [recordOf('m1', '文本')] }))])
    booted.kernel.emit('memory/written', written('m1'))

    const outcome = await booted.encoder.encodePending()
    expect(outcome.skipped).toBe(1)
    expect(outcome.reason).toContain('库不支持向量写入')
    expect(booted.encoder.pending()).toBe(0)
    booted.dispose()
  })

  it('编码抛错 → 原因 + **保留队列**（下次再试）', async () => {
    const store = realStore()
    await store.put(recordOf('m1', '长期记忆系统'))
    const booted = boot(() => [storeSetOf('user', store)])
    booted.kernel.provide<Embedder>(EMBEDDER_SERVICE, {
      id: 'boom',
      dimensions: 256,
      revision: '1',
      async embed() {
        throw new Error('embed boom')
      },
    })
    booted.kernel.emit('memory/written', written('m1'))

    const outcome = await booted.encoder.encodePending()
    expect(outcome.failures).toBe(1)
    expect(outcome.reason).toContain('编码失败')
    expect(outcome.reason).toContain('embed boom')
    expect(booted.encoder.pending()).toBe(1)
    expect(booted.encoder.stats().lastReason).toContain('编码失败')
    booted.dispose()
  })

  it('库拒绝写入（归属不符）→ 出队并计数（重试不会成功），原因可读', async () => {
    const store = realStore()
    const api = asVectorStore(store)!
    // 库内声明的是 512 维 BGE，而当前嵌入器是 256 维哈希词袋 → 写入必然被拒
    await api.setEmbeddingMeta({ modelId: 'bge-small-zh-v1.5-512', dim: 512, revision: '1' })
    await store.put(recordOf('m1', '长期记忆系统'))
    const booted = boot(() => [storeSetOf('user', store)])
    booted.kernel.emit('memory/written', written('m1'))

    const outcome = await booted.encoder.encodePending()
    expect(outcome.failures).toBe(1)
    expect(outcome.reason).toContain('被拒')
    expect(booted.encoder.pending()).toBe(0)
    expect(booted.encoder.stats().rejected).toBe(1)
    booted.dispose()
  })
})

describe('无内核 / 无嵌入器：绝不抛，且队列保留（下次再试能成功）', () => {
  it('嵌入器服务不可用 → 原因 + 保留；恢复后再调一次就能编码', async () => {
    const store = realStore()
    await store.put(recordOf('m1', '长期记忆系统'))
    const handle = createKernel()
    // 遮蔽 embedder 服务：模拟"模块被关掉 / 嵌入器尚未就绪"
    let hide = true
    const gated: Kernel = {
      ...handle.kernel,
      service: <T,>(name: string) =>
        name === EMBEDDER_SERVICE && hide ? undefined : handle.kernel.service<T>(name),
    }
    const instance = createVectorModule({
      loadOnnx: async () => ({ ok: false, reason: '测试' }),
      resolveStoreSets: () => [storeSetOf('user', store)],
    })
    const dispose = instance.apply(gated, { modelDir: join(tempDir(), '不存在') })
    const encoder = instance.encoder()
    expect(encoder).toBeDefined()

    gated.emit('memory/written', written('m1'))
    const blocked = await encoder!.encodePending()
    expect(blocked.reason).toContain('嵌入器服务不可用')
    expect(encoder!.pending()).toBe(1) // **不丢队列**

    hide = false // 嵌入器恢复（例如模块被重新启用 / ONNX 装载完成）
    const ok = await encoder!.encodePending()
    expect(ok.encoded).toBe(1)
    expect(encoder!.pending()).toBe(0)
    dispose()
  })

  it('模块卸载后调用残留编码器 → 原因而非抛；卸载时退订事件、注销服务', async () => {
    const store = realStore()
    await store.put(recordOf('m1', '长期记忆系统'))
    const handle = createKernel()
    const instance = createVectorModule({
      loadOnnx: async () => ({ ok: false, reason: '测试' }),
      resolveStoreSets: () => [storeSetOf('user', store)],
    })
    const dispose = instance.apply(handle.kernel, { modelDir: join(tempDir(), '不存在') })
    const encoder = instance.encoder()!

    handle.kernel.emit('memory/written', written('m1'))
    expect(encoder.pending()).toBe(1)

    dispose()
    expect(handle.kernel.service(VECTOR_ENCODER_SERVICE)).toBeUndefined()
    expect(instance.encoder()).toBeUndefined()
    // 退订生效：卸载后的事件不再入队（队列保留的是卸载前那一条，不丢 pending 工作）
    handle.kernel.emit('memory/written', written('m2'))
    expect(encoder.pending()).toBe(1)
    // 残留引用仍可调用：给原因，绝不抛
    const outcome = await encoder.encodePending()
    expect(outcome.reason).toContain('模块未启动或已关闭')
    expect(encoder.pending()).toBe(1)
    expect(() => dispose()).not.toThrow()
  })
})
