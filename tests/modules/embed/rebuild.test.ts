/**
 * 陈旧向量的**回填**：换嵌入器后，库里"当前身份下没有向量"的记忆在回合边界被重新编码。
 *
 * ## 这一层存在的理由（缺陷 A）
 *
 * `embedding` 表用 `model_id`/`dim`/`revision` 标注归属（`modules/memory/store.ts:111`），
 * 换嵌入器时旧向量随之成为"陈旧"、**不再参与检索**（`store.ts:172`）；
 * 而唯一的编码入口只由 `memory/written` 喂（`vector.ts` 的 `enqueueWritten`）——
 * 它**只编码新写入的记忆**。于是从 `hash-bow-256` 换成 `bge-small-zh-v1.5-512` 时，
 * 全部存量向量一夜之间失效且**永远不会被重建**：检索不报错（词法通道还在），
 * 只是向量通道对旧记忆静默返回空。
 *
 * ## 机制的形状（本文件把它钉住）
 *
 * ① 回填**寄生在 `encodePending()` 里**（`dsh/` 只在回合边界调这一个方法：
 *    `dsh/session.ts:736` 的 `flushVectorEncoder`）——另开入口就不会有人驱动；
 * ② 与写入共用**同一条**批通路与队列（`embed` 一次 N 条），不另起并发编码；
 * ③ 有上界（`maxBackfill` + 队列余量）：不把整个库拉进内存；
 * ④ 幂等可重入：失败保留待办，下次继续；正文已不存在的残留行才回收；
 * ⑤ 如实上报（`stats().rebuild` 与状态面/健康面）；
 * ⑥ 嵌入器不可用时**停住**：不切归属、不写坏数据。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import {
  type Embedder,
  type Kernel,
  type Logger,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type SqliteStatementLike,
  type StorageHostPort,
  type StoreSet,
} from '../../../kernel/abi/index.js'
import { hashBagEmbedder } from '../../../modules/memory/embed.js'
import { contentHashOf } from '../../../modules/memory/remember.js'
import {
  BGE_DIMENSIONS,
  BGE_EMBEDDER_ID,
  BGE_MODEL_DIR_NAME,
  BGE_REVISION,
  MODEL_PAIRS,
  VOCAB_FILE,
} from '../../../modules/memory/onnx.js'
import {
  asVectorStore,
  openMemoryStore,
  type EmbeddingMeta,
  type SqliteMemoryStore,
} from '../../../modules/memory/store.js'
import {
  DEFAULT_MAX_BACKFILL,
  DEFAULT_MAX_PENDING,
  EMBEDDER_SERVICE,
  VECTOR_ENCODER_SERVICE,
  createVectorModule,
  type VectorEncoder,
  type VectorModuleInstance,
} from '../../../modules/memory/vector.js'
import { delta, snapshotCounters, testPort, type CountingSqlite } from '../memory/helpers.js'

const TEMP_DIRS: string[] = []

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论（临时目录）
    }
  }
})

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {} }
const clock = { now: () => 1 }

/** 「上线前」的嵌入器身份（与 `embed.ts` 的 `hashBagEmbedder(256)` 一致）。 */
const HASH_IDENTITY: EmbeddingMeta = { modelId: 'hash-bow-256', dim: 256, revision: '1' }
/** 「换上去」的嵌入器身份（= 真 BGE 的 id/dim/revision，见 `onnx.ts:30-34`）。 */
const NEURAL_IDENTITY: EmbeddingMeta = {
  modelId: BGE_EMBEDDER_ID,
  dim: BGE_DIMENSIONS,
  revision: BGE_REVISION,
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omb-rebuild-'))
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

/** 带**逐语句计数**的真实库：用来断言"某个状态下一条 SQL 都没发"。 */
function countingStore(): { readonly store: SqliteMemoryStore; readonly db: CountingSqlite } {
  const port = testPort(tempDir())
  const store = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })
  const db = port.databases[0]
  if (db === undefined) throw new Error('夹具未打开数据库')
  return { store, db }
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
    contentHash: contentHashOf(text),
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

/**
 * 造一个"看起来像 BGE 权重"的目录。
 *
 * `resolveOnnxModelDir` 只看**文件在不在**（`onnx.ts:291`），真正的装载由注入的 loader 负责，
 * 所以本文件不碰 ONNX 运行时、也不碰真权重。
 */
function fakeModelDir(): string {
  const dir = join(tempDir(), 'models', BGE_MODEL_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const pair = MODEL_PAIRS[0]
  writeFileSync(join(dir, pair.graph), 'graph-bytes')
  writeFileSync(join(dir, pair.data), 'weights-bytes')
  writeFileSync(join(dir, VOCAB_FILE), '[PAD]\n[UNK]\n')
  return dir
}

/**
 * 假神经嵌入器：身份是 BGE（512 维），数值用哈希词袋（确定性；同一文本自查询余弦 = 1）。
 *
 * 为什么可以这样造：本文件测的是**回填的通路与读数**，不是模型质量——
 * 但"换上去的嵌入器与旧身份不同"必须是真实的（id/dim 都不同），否则测不到陈旧。
 */
function fakeNeuralEmbedder(): Embedder {
  const inner = hashBagEmbedder(BGE_DIMENSIONS)
  return {
    id: BGE_EMBEDDER_ID,
    dimensions: BGE_DIMENSIONS,
    revision: BGE_REVISION,
    embed: texts => inner.embed(texts),
  }
}

interface Booted {
  readonly kernel: Kernel
  readonly instance: VectorModuleInstance
  readonly encoder: VectorEncoder
  readonly dispose: () => void
  readonly status: () => readonly string[]
}

interface BootOptions {
  readonly maxPending?: number
  readonly maxBackfill?: number
  /** 覆盖 ONNX 装载结果（缺省 = 装上一个 512 维的假神经嵌入器）。 */
  readonly loadOnnx?: () => Promise<
    { readonly ok: true; readonly embedder: Embedder; readonly modelDir: string } | { readonly ok: false; readonly reason: string }
  >
}

/** 起一个模块实例；库套件由 `resolveStoreSets` 注入（不依赖 store-dev 的服务实现）。 */
function boot(sets: () => readonly StoreSet[], options: BootOptions = {}): Booted {
  const handle = createKernel()
  const modelDir = fakeModelDir()
  const loadOnnx =
    options.loadOnnx ?? (async () => ({ ok: true as const, embedder: fakeNeuralEmbedder(), modelDir }))
  const instance = createVectorModule({ loadOnnx, resolveStoreSets: () => sets() })
  const dispose = instance.apply(handle.kernel, {
    modelDir,
    maxPending: options.maxPending ?? DEFAULT_MAX_PENDING,
    maxBackfill: options.maxBackfill ?? DEFAULT_MAX_BACKFILL,
  })
  const encoder = handle.kernel.service<VectorEncoder>(VECTOR_ENCODER_SERVICE)
  if (encoder === undefined) throw new Error('编码队列服务未注册（H-2 违约）')
  return { kernel: handle.kernel, instance, encoder, dispose, status: () => handle.status() }
}

/** `memory/written` 的载荷形状（跨模块契约，本模块不改它）。 */
function written(id: string, scope = 'user'): { id: string; scope: string; kind: string } {
  return { id, scope, kind: 'semantic' }
}

/**
 * 等 ONNX 探测落地。
 *
 * `apply` 是同步的（H-2），升级发生在微任务里——不等它，通道还停在 `probing`，
 * 而 `probing` 期间回填按设计是**停住**的（身份随时会被换掉，切了要切第二次）。
 */
async function settle(instance: VectorModuleInstance): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(instance.state().probing).toBe(false)
}

/** 按旧身份（哈希词袋 256 维）直接写一条向量，模拟"上线前落下的存量向量"。 */
async function seedLegacyVector(
  store: SqliteMemoryStore,
  id: string,
  text: string,
  scope: MemoryScope = 'user',
): Promise<void> {
  const api = asVectorStore(store)
  if (api === undefined) throw new Error('夹具必须用真实库（asVectorStore 只认本实现）')
  const legacy = hashBagEmbedder(HASH_IDENTITY.dim)
  await store.put(recordOf(id, text, scope))
  await api.putEmbedding({
    memoryId: id,
    modelId: HASH_IDENTITY.modelId,
    dim: HASH_IDENTITY.dim,
    revision: HASH_IDENTITY.revision,
    vector: (await legacy.embed([text]))[0] as Float32Array,
  })
}

/** 一直冲到没有待重建（每轮 = 一个回合边界）；返回每轮**实际编码**的条数。 */
async function runTurns(booted: Booted, maxTurns = 12): Promise<readonly number[]> {
  const encoded: number[] = []
  for (let turn = 0; turn < maxTurns; turn++) {
    encoded.push((await booted.encoder.encodePending()).encoded)
    if (booted.encoder.stats().rebuild.stale === 0) break
  }
  return encoded
}

describe('库身份：回填条目按**列出它的库**判存活', () => {
  it('那个库被淘汰时保留队列（不得出队计 skipped），回来后照常重建', async () => {
    const projectA = realStore('project')
    const projectB = realStore('project')
    await seedLegacyVector(projectA, 'm-a', 'A 项目里的旧身份向量记忆', 'project')
    let sets: readonly StoreSet[] = [storeSetOf('project', projectA), storeSetOf('project', projectB)]
    const booted = boot(() => sets)
    await settle(booted.instance)

    // 第一轮：扫描把 A 的陈旧条目放进队列（此刻 A 还开着）
    await booted.encoder.encodePending()
    expect(booted.encoder.pending()).toBe(1)

    // A 被淘汰 → 只剩 B。作用域名 'project' 仍被 B 覆盖，但 **A 没被查询过**：
    // 按作用域名判会把这条当成"已删除"，那条记忆就再也拿不到向量了（M7）。
    sets = [storeSetOf('project', projectB)]
    const evicted = await booted.encoder.encodePending()
    expect(evicted.skipped).toBe(0)
    expect(booted.encoder.pending()).toBe(1)
    expect(booted.encoder.stats().skipped).toBe(0)
    expect(booted.encoder.stats().lastReason).toContain('库尚未就绪')
    expect(booted.status().join('\n')).toContain('库尚未就绪')

    // A 回来 → 照常重建，并且这一次真的落盘了
    sets = [storeSetOf('project', projectA), storeSetOf('project', projectB)]
    const back = await booted.encoder.encodePending()
    expect(back.encoded).toBe(1)
    expect(booted.encoder.pending()).toBe(0)
    // 旧身份行按设计保留（非破坏性），但当前身份的向量确实补上了
    const stored = await asVectorStore(projectA)!.getEmbeddings(['m-a'])
    expect(stored.some(v => v.modelId === NEURAL_IDENTITY.modelId && v.dim === NEURAL_IDENTITY.dim)).toBe(true)
    booted.dispose()
    await projectA.close()
    await projectB.close()
  })
})


describe('换嵌入器：陈旧向量在回合边界被重建', () => {
  it('哈希词袋 → 512 维神经嵌入器：逐批重建、归属切换、旧行保留、重建后可检索', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    const texts: readonly (readonly [string, string])[] = [
      ['m1', '长期记忆系统'],
      ['m2', 'FTS5 词法检索'],
      ['m3', '向量通道与余弦'],
    ]
    for (const [id, text] of texts) await seedLegacyVector(store, id, text)
    expect(await api.embeddingMeta()).toEqual(HASH_IDENTITY)

    // 通道换成神经嵌入器（同一个库、同一批记忆）
    const booted = boot(() => [storeSetOf('user', store)])
    await settle(booted.instance)
    expect(booted.instance.state().channel).toBe('onnx')

    // 第 1 个回合边界：库里 3 条记忆都没有当前身份的向量 → 入队（编码在下一个回合边界）
    const first = await booted.encoder.encodePending()
    expect(first.encoded).toBe(0)
    expect(booted.encoder.stats().rebuild.stale).toBe(3)
    expect(booted.encoder.pending()).toBe(3)

    // 第 2 个回合边界：一次批编码（N 条一次 embed）→ 落盘
    const second = await booted.encoder.encodePending()
    expect(second.encoded).toBe(3)
    expect(booted.encoder.stats().rebuild.rebuilt).toBe(3)
    expect(booted.encoder.stats().rebuild.failures).toBe(0)
    expect(booted.encoder.stats().rebuild.stale).toBe(0)

    // 归属已切换；新向量按 512 维落盘；**旧行留着**（可查询、可换回原嵌入器）
    expect(await api.embeddingMeta()).toEqual(NEURAL_IDENTITY)
    const rows = await api.getEmbeddings(['m1', 'm2', 'm3'])
    // 同一个 id 会有两行（旧身份 + 当前身份）——`getEmbeddings` 按 id 取，不做归属过滤
    const current = rows.filter(vector => vector.modelId === NEURAL_IDENTITY.modelId)
    expect(current.map(v => v.memoryId).sort()).toEqual(['m1', 'm2', 'm3'])
    for (const vector of current) {
      expect(vector.dim).toBe(NEURAL_IDENTITY.dim)
      expect(vector.vector).toHaveLength(NEURAL_IDENTITY.dim)
    }
    expect(await api.countEmbeddings()).toBe(6) // 3 条旧身份 + 3 条当前身份
    expect((await api.listEmbeddings({ modelId: HASH_IDENTITY.modelId })).map(v => v.memoryId).sort()).toEqual([
      'm1',
      'm2',
      'm3',
    ])

    // 判据：重建后的向量**真的能参与检索**（这正是缺陷 A 说"静默返回空"的那一步）
    const embedder = booted.kernel.service<Embedder>(EMBEDDER_SERVICE)
    expect(embedder).toBeDefined()
    const [query] = await embedder!.embed([texts[0]?.[1] ?? ''])
    const hits = await store.searchVector({
      embedding: query as Float32Array,
      expect: NEURAL_IDENTITY,
      limit: 5,
    })
    expect(hits.map(hit => hit.id)).toContain('m1')
    // 状态面：对齐之后是"记账口径的 0"（不是"刚刚又扫了一遍"），来源写在括号里
    const statusText = booted.status().join('\n')
    expect(statusText).toContain('向量回填：待重建 0 条（已对齐')
    booted.dispose()
  })

  it('对齐之后的读数不得自相矛盾：0 条必须点名**实测基准**，原因快照必须标成过去时', async () => {
    const store = realStore()
    for (const [id, text] of [
      ['m1', '长期记忆系统'],
      ['m2', 'FTS5 词法检索'],
      ['m3', '向量通道与余弦'],
    ] as const) {
      await seedLegacyVector(store, id, text)
    }
    const booted = boot(() => [storeSetOf('user', store)])
    await settle(booted.instance)

    await booted.encoder.encodePending() // 第 1 个边界：实测基准 3、入队
    expect(booted.encoder.stats().rebuild.stale).toBe(3)
    const rebuilt = await booted.encoder.encodePending() // 第 2 个边界：编码 3 条
    expect(rebuilt.encoded).toBe(3)

    const stats = booted.encoder.stats().rebuild
    expect(stats.stale).toBe(0)
    // 这个 0 是**记账**推出来的（基准 3 − 已完成 3），不是这一刻又扫了一遍库
    expect(stats.staleFromScan).toBe(false)

    const statusText = booted.status().join('\n')
    // ① "0 条"那行必须点名实测基准，且**不许**声称"最近一次统计未发现待重建"
    //    （最近一次统计实测到的正是 3 条——写成"未发现"就是来源谎报）
    const zeroLine = statusText.split('\n').find(line => line.includes('向量回填：待重建 0 条'))
    expect(zeroLine).toBeDefined()
    expect(zeroLine).toContain('实测基准 3')
    expect(statusText).not.toContain('最近一次统计未发现待重建')

    // ② 现在时的「待重建原因：」不许出现：那 3 条原因之和（=3）≠ 当前 stale（=0）
    expect(statusText).not.toMatch(/^待重建原因：/m)
    // ③ 过去时那一行必须点名基准与"不是当前待办"，原因拆分照样可读
    expect(statusText).toMatch(
      /^上一轮实测的积压构成（实测基准 3 条、已处理 3 条，\*\*不是当前待办\*\*）：/m,
    )
    expect(statusText).toContain('缺当前身份 3 条')
    booted.dispose()
  })

  it('补齐了一部分时：原因快照写成过去时并给出基准（健康面也不许把它说成当前）', async () => {
    const store = realStore()
    for (const [id, text] of [
      ['m1', '长期记忆系统'],
      ['m2', 'FTS5 词法检索'],
      ['m3', '向量通道与余弦'],
    ] as const) {
      await seedLegacyVector(store, id, text)
    }
    const booted = boot(() => [storeSetOf('user', store)], { maxBackfill: 1 })
    await settle(booted.instance)

    await booted.encoder.encodePending() // 基准 3、入队 1 条
    const encoded = await booted.encoder.encodePending() // 编码 1 条 → 还剩 2 条
    expect(encoded.encoded).toBe(1)

    const rb = booted.encoder.stats().rebuild
    expect(rb.stale).toBe(2)
    expect(rb.staleBase).toBe(3)
    expect(rb.staleFromScan).toBe(false)

    // 状态面：读数仍是现在时的"2 条"（记账精确），但原因快照是过去时
    const statusText = booted.status().join('\n')
    expect(statusText).toContain('待重建 2 条（本轮回填记账：实测基准 3 减去已完成的量）')
    expect(statusText).not.toMatch(/^待重建原因：/m)
    expect(statusText).toContain('实测基准 3 条、已处理 1 条，**不是当前待办**')

    // 健康面同一口径（两处渲染不许各说各话）
    const health = booted.instance.manifest.health()
    expect(health.detail).toContain('陈旧待重建 2 条')
    expect(health.detail).toContain('上一轮实测的积压构成（基准 3 条、已处理 1 条')
    expect(health.detail).not.toContain('当前原因拆分')
    booted.dispose()
  })

  it('上界生效：maxBackfill=2 时每轮最多 2 条进队列（不把整个库拉进来）', async () => {
    const store = realStore()
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
    for (const id of ids) await seedLegacyVector(store, id, `记忆内容 ${id}`)

    const booted = boot(() => [storeSetOf('user', store)], { maxBackfill: 2 })
    await settle(booted.instance)
    const perTurn = await runTurns(booted)

    // 第一轮只入队（2 条），随后每轮编码上界内的那批；最后一轮收尾 1 条
    expect(perTurn).toEqual([0, 2, 2, 1])
    expect(booted.encoder.stats().rebuild.rebuilt).toBe(5)
    expect(booted.encoder.stats().rebuild.stale).toBe(0)
    expect(booted.encoder.pending()).toBe(0)
    const api = asVectorStore(store)
    expect(await api?.countStaleEmbeddings(NEURAL_IDENTITY)).toBe(0)
    booted.dispose()
  })

  it('多个库套件共用用户库时**按库去重**：待重建数不翻倍，两个库都被回填', async () => {
    const user = realStore()
    const project = realStore('project')
    await seedLegacyVector(user, 'm1', '长期记忆系统')
    await seedLegacyVector(project, 'p1', '项目情境记忆', 'project')

    // `stores.snapshot()` 的真实形状：`user` 是用户库专属套件，而每个项目套件**也含用户库**
    // （`store.ts:1733` 的 `projectSet`）。不去重就会对着同一个库扫两遍、计数翻倍。
    const userOnly = storeSetOf('user', user)
    const projectSuite: StoreSet = {
      projectScope: 'D:/proj',
      stores: [
        { scope: 'user', store: user },
        { scope: 'project', store: project },
      ],
      store: wanted => (wanted === 'user' ? user : wanted === 'project' ? project : undefined),
      migrated: [],
      close: async () => {},
    }
    const booted = boot(() => [userOnly, projectSuite])
    await settle(booted.instance)

    const first = await booted.encoder.encodePending()
    expect(first.encoded).toBe(0)
    expect(booted.encoder.stats().rebuild.stale).toBe(2) // 1 + 1，而不是 1 + 1 + 1
    expect(booted.encoder.stats().rebuild.staleFromScan).toBe(true)

    await runTurns(booted)
    expect(booted.encoder.stats().rebuild.rebuilt).toBe(2)
    expect(await asVectorStore(user)?.countStaleEmbeddings(NEURAL_IDENTITY)).toBe(0)
    expect(await asVectorStore(project)?.countStaleEmbeddings(NEURAL_IDENTITY)).toBe(0)
    expect((await asVectorStore(project)?.getEmbeddings(['p1']))?.[0]?.dim).toBe(NEURAL_IDENTITY.dim)
    booted.dispose()
  })

  it('对齐之后不再每回合扫库：回填的代价随时间归零（只有身份变化才会重扫）', async () => {
    const { store, db } = countingStore()
    await seedLegacyVector(store, 'm1', '长期记忆系统')
    const booted = boot(() => [storeSetOf('user', store)])
    await settle(booted.instance)
    await runTurns(booted) // 把这一条重建完 → 对齐

    expect(booted.encoder.stats().rebuild.stale).toBe(0)
    // 关键：这个 0 是"本轮回填记账"的结论，不是"刚刚又扫了一遍库"（状态面据此说清来源）
    expect(booted.encoder.stats().rebuild.staleFromScan).toBe(false)

    // 对齐态下再走一个回合边界：**不做全表统计**（一次 COUNT/LIST 都不发）。
    // （全表统计一次就要 200~400ms/万条 —— 每回合做一次等于给会话挂一个随记忆增长的常数）
    //
    // 唯一允许的那条语句是**孤儿行清理**（`DELETE ... WHERE NOT EXISTS (memory)`，
    // 走 `embedding` 主键、不读 BLOB、不随库做全表物化）：它是另一本账——
    // "对齐"说的是"有正文的记忆都有当前向量"，而"没有正文的行"在本次的判定里根本不可见
    // （判定以 `memory` 为外层），所以它必须有自己的清理入口，且必须是 O(库) 的一条 SQL
    // 而不是"每回合重扫一遍待重建集合"。
    const before = snapshotCounters(db.counters)
    const outcome = await booted.encoder.encodePending()
    const spent = delta(db.counters, before)
    expect(outcome.encoded).toBe(0)
    expect(spent.all + spent.get + spent.prepare).toBe(1) // 只有孤儿清理那一条
    booted.dispose()
  })
})

describe('幂等与可重入：失败保留待办，绝不静默丢', () => {
  it('编码抛错：队列保留、meta 不切、旧向量一字未动；修好后下一轮继续', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    await seedLegacyVector(store, 'm1', '长期记忆系统')
    await seedLegacyVector(store, 'm2', 'FTS5 词法检索')

    let broken = true
    const inner = fakeNeuralEmbedder()
    const flaky: Embedder = {
      id: inner.id,
      dimensions: inner.dimensions,
      revision: inner.revision,
      async embed(texts) {
        if (broken) throw new Error('onnxruntime-node 崩了')
        return inner.embed(texts)
      },
    }
    const booted = boot(() => [storeSetOf('user', store)], {
      loadOnnx: async () => ({ ok: true, embedder: flaky, modelDir: fakeModelDir() }),
    })
    await settle(booted.instance)

    await booted.encoder.encodePending() // 入队 2 条
    const failed = await booted.encoder.encodePending()
    expect(failed.failures).toBe(2)
    expect(failed.reason).toContain('编码失败')
    expect(booted.encoder.pending()).toBe(2) // **保留**，不是丢掉重来
    expect(booted.encoder.stats().rebuild.failures).toBe(2)
    expect(booted.encoder.stats().rebuild.rebuilt).toBe(0)
    // 关键：编码都没成功，就**不能**宣布库的归属变了——切了等于把旧向量全部作废
    expect(await api.embeddingMeta()).toEqual(HASH_IDENTITY)
    expect((await api.getEmbeddings(['m1', 'm2'])).map(v => v.dim)).toEqual([256, 256])
    expect(await api.countEmbeddings()).toBe(2)

    broken = false // 故障消失（例如 onnxruntime 装好了 / 权重下好了）
    const ok = await booted.encoder.encodePending()
    expect(ok.encoded).toBe(2)
    expect(booted.encoder.stats().rebuild.rebuilt).toBe(2)
    expect(booted.encoder.stats().rebuild.stale).toBe(0)
    expect(await api.embeddingMeta()).toEqual(NEURAL_IDENTITY)
    booted.dispose()
  })

  it('正文已不存在的残留向量行被回收：待重建计数清零，不会每轮被重复列出', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    await seedLegacyVector(store, 'm1', '长期记忆系统')
    // 一条**没有正文**的向量行（`forget` 中途崩掉就是这个形态：`store.ts:628` 删了向量、还没删正文，
    // 或者反过来正文被别的路径删掉）。它永远重建不出来，留着只会每轮被重新列出。
    // 它带着一个内容哈希（那时正文还在，编码是 → 哈希也是），这样它在库里**只**因为
    // "没有正文"而成为待办——正是这条用例要测的那一类。
    await api.putEmbedding({
      memoryId: 'ghost',
      modelId: HASH_IDENTITY.modelId,
      dim: HASH_IDENTITY.dim,
      revision: HASH_IDENTITY.revision,
      vector: new Float32Array(HASH_IDENTITY.dim),
      contentHash: 'h-ghost',
    })

    const booted = boot(() => [storeSetOf('user', store)])
    await settle(booted.instance)
    const perTurn = await runTurns(booted)
    expect(perTurn).toEqual([0, 1]) // 只重建得出一条（另一条没有可编码的正文）
    expect(booted.encoder.stats().rebuild.rebuilt).toBe(1)
    expect(booted.encoder.stats().rebuild.scavenged).toBe(1)
    expect(booted.encoder.stats().rebuild.stale).toBe(0) // 计数会清零：不会永远挂着
    expect((await api.listEmbeddings({ modelId: HASH_IDENTITY.modelId })).map(v => v.memoryId)).toEqual(['m1'])
    expect(await api.countEmbeddings()).toBe(2) // m1 的旧行 + m1 的新行
    booted.dispose()
  })
})

describe('兜底不许变成灾难：嵌入器不可用时回填停住', () => {
  it('降级通道（onnxruntime 缺失）：不切归属、不写哈希向量，原因与待办都如实上报', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    // 库里是"神经嵌入器时代"的 512 维向量
    await store.put(recordOf('m1', '长期记忆系统'))
    await api.setEmbeddingMeta(NEURAL_IDENTITY)
    await api.putEmbedding({
      memoryId: 'm1',
      modelId: NEURAL_IDENTITY.modelId,
      dim: NEURAL_IDENTITY.dim,
      revision: NEURAL_IDENTITY.revision,
      vector: new Float32Array(NEURAL_IDENTITY.dim).fill(0.5),
    })

    const booted = boot(() => [storeSetOf('user', store)], {
      loadOnnx: async () => ({ ok: false, reason: 'onnxruntime-node 缺失：原生绑定不可用' }),
    })
    expect(booted.instance.state().channel).toBe('hash-bow')

    // 新写入照样走既有通路（它会因为归属不符被库拒绝——这是可见的，不是静默的）
    booted.kernel.emit('memory/written', written('m1'))
    const outcome = await booted.encoder.encodePending()
    expect(outcome.reason).toContain('被拒')

    // ① 归属没有被切到哈希词袋（切了就等于宣布 512 维向量全部作废）
    expect(await api.embeddingMeta()).toEqual(NEURAL_IDENTITY)
    // ② 库里没有多出任何向量：那条 512 维向量一字未动
    expect(await api.countEmbeddings()).toBe(1)
    expect((await api.getEmbeddings(['m1']))[0]?.dim).toBe(NEURAL_IDENTITY.dim)
    // ③ 停住的原因可读，待重建条数是**测到的**（不是猜的），并且没有被当成"已重建"
    const stats = booted.encoder.stats()
    expect(stats.rebuild.stale).toBe(1)
    expect(stats.rebuild.rebuilt).toBe(0)
    expect(stats.rebuild.blocked).toContain('降级')
    expect(stats.rebuild.blocked).toContain('onnxruntime-node')
    expect(stats.rejected).toBeGreaterThan(0)
    // ④ 状态面与健康面都看得见（降级必须可读、无空降级）
    expect(booted.status().join('\n')).toContain('回填停住')
    const health = booted.instance.manifest.health()
    expect(health.detail).toContain('回填停住')
    expect(health.metrics?.['rebuildBlocked']).toBe(1)
    expect(health.metrics?.['staleEmbeddings']).toBe(1)
    booted.dispose()
  })

  it('嵌入器输出维度与声明不符：**不切归属**（否则旧向量被白白作废），队列保留', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    await seedLegacyVector(store, 'm1', '长期记忆系统')

    // 说谎的嵌入器：声明 512 维，却返回 256 维（真装载器有自检，这里模拟漏网的那一类）
    const liar: Embedder = {
      id: BGE_EMBEDDER_ID,
      dimensions: BGE_DIMENSIONS,
      revision: BGE_REVISION,
      async embed(texts) {
        return texts.map(() => new Float32Array(HASH_IDENTITY.dim))
      },
    }
    const booted = boot(() => [storeSetOf('user', store)], {
      loadOnnx: async () => ({ ok: true, embedder: liar, modelDir: fakeModelDir() }),
    })
    await settle(booted.instance)

    await booted.encoder.encodePending() // 入队
    const outcome = await booted.encoder.encodePending()
    expect(outcome.failures).toBe(1)
    expect(outcome.reason).toContain('不一致') // 库的拒绝原因可读（不是静默失败）
    expect(booted.encoder.pending()).toBe(1) // 待办保留
    expect(await api.embeddingMeta()).toEqual(HASH_IDENTITY) // 归属没被切
    expect((await api.getEmbeddings(['m1']))[0]?.dim).toBe(HASH_IDENTITY.dim) // 旧向量一字未动
    booted.dispose()
  })

  it('显式放行时（allowFallbackRebuild）降级通道也能回填：这是使用者的决定，不是默认行为', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    await store.put(recordOf('m1', '长期记忆系统'))
    await api.setEmbeddingMeta(NEURAL_IDENTITY)
    await api.putEmbedding({
      memoryId: 'm1',
      modelId: NEURAL_IDENTITY.modelId,
      dim: NEURAL_IDENTITY.dim,
      revision: NEURAL_IDENTITY.revision,
      vector: new Float32Array(NEURAL_IDENTITY.dim).fill(0.5),
    })

    const handle = createKernel()
    const instance = createVectorModule({
      loadOnnx: async () => ({ ok: false, reason: '测试：不装载 ONNX' }),
      resolveStoreSets: () => [storeSetOf('user', store)],
    })
    const dispose = instance.apply(handle.kernel, {
      modelDir: join(tempDir(), '不存在'),
      allowFallbackRebuild: true,
    })
    const encoder = instance.encoder()
    expect(encoder).toBeDefined()

    await encoder!.encodePending() // 入队
    const rebuilt = await encoder!.encodePending()
    expect(rebuilt.encoded).toBe(1)
    expect(encoder!.stats().rebuild.rebuilt).toBe(1)
    expect(encoder!.stats().rebuild.blocked).toBeNull()
    // 归属被切到当前的降级身份：语义向量随之不再参与检索（这正是"默认不许"的原因）
    expect(await api.embeddingMeta()).toEqual(HASH_IDENTITY)
    expect((await api.getEmbeddings(['m1'])).filter(v => v.dim === HASH_IDENTITY.dim)).toHaveLength(1)
    dispose()
  })

  it('回填绝不挤掉待落盘的写入：队列没有余量时本轮不扫描', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    await seedLegacyVector(store, 'm1', '长期记忆系统') // 待重建的一条
    await store.put(recordOf('m2', '这条是刚写入、还没落盘的')) // 新写入的一条

    let failNext = true
    const inner = fakeNeuralEmbedder()
    const flaky: Embedder = {
      id: inner.id,
      dimensions: inner.dimensions,
      revision: inner.revision,
      async embed(texts) {
        if (failNext) {
          failNext = false
          throw new Error('第一次嵌入失败')
        }
        return inner.embed(texts)
      },
    }
    const booted = boot(() => [storeSetOf('user', store)], {
      maxPending: 1,
      maxBackfill: 8,
      loadOnnx: async () => ({ ok: true, embedder: flaky, modelDir: fakeModelDir() }),
    })
    await settle(booted.instance)

    booted.kernel.emit('memory/written', written('m2'))
    await booted.encoder.encodePending() // 冲刷失败 → m2 留在队列（已占满 maxPending=1）
    expect(booted.encoder.pending()).toBe(1)
    // 待重建 2 条：m1（换嵌入器后的存量）+ m2（刚写入、还没有向量）。
    // 后者也算——"这条记忆的当前向量不可用"正是待重建的语义，而它此刻确实没有向量。
    expect(booted.encoder.stats().rebuild.stale).toBe(2)
    expect(booted.encoder.stats().rebuild.causes.lackingIdentity).toBe(2)
    // 队列没有余量 → 本轮不扫描（回填绝不挤掉待落盘的写入）
    expect(booted.encoder.stats().rebuild.blocked).toContain('队列已满')
    expect(booted.encoder.stats().rebuild.rebuilt).toBe(0)

    // 故障消失：先落盘 m2（一条都没丢），再开始回填 m1
    const next = await booted.encoder.encodePending()
    expect(next.encoded).toBe(1)
    expect(booted.encoder.stats().dropped).toBe(0)
    expect(booted.encoder.pending()).toBe(1) // 回填的那条已入队，等下一个回合边界编码
    expect(await api.getEmbeddings(['m2'])).toHaveLength(1)
    booted.dispose()
  })
})

describe('状态面：待重建条数必须"测到了才报"', () => {
  it('一次都没扫过 → "尚未测量"（不是 0）；扫过之后的 0 才是测到的 0', async () => {
    const handle = createKernel()
    const instance = createVectorModule({
      loadOnnx: async () => ({ ok: false, reason: '测试：不装载 ONNX' }),
      resolveStoreSets: () => [],
    })
    const dispose = instance.apply(handle.kernel, { modelDir: join(tempDir(), '不存在') })

    // 尚未发生任何回填扫描：stale 是 null（未测量），metrics 里是 -1（不是 0）
    expect(instance.encoder()?.stats().rebuild.stale).toBeNull()
    expect(instance.manifest.health().metrics?.['staleEmbeddings']).toBe(-1)
    const before = handle.status().join('\n')
    expect(before).toContain('待重建 尚未测量')
    expect(before).not.toContain('回填停住')

    // 库一个都没打开：扫不出来 → 仍然"未测量"，但原因可读（不把"没测"写成 0）
    await instance.encoder()?.encodePending()
    expect(instance.encoder()?.stats().rebuild.stale).toBeNull()
    expect(instance.encoder()?.stats().rebuild.blocked).toContain('记忆库未就绪')
    dispose()
  })

  /**
   * 两类待重建必须**在读数上分得开**（本仓库的规矩：降级必须可读）。
   *
   * 合成一个数字时，"换了嵌入器"（等回填即可）与"正文被人改写而向量没跟上"
   * （要查是谁在改写）在状态面上长得一模一样——而后者才是"检索结果莫名其妙"的那一类。
   */
  it('换嵌入器 vs 正文已改写：状态面、健康面与 metrics 都分得开', async () => {
    const store = realStore()
    const api = asVectorStore(store)
    if (api === undefined) throw new Error('夹具必须用真实库')
    await seedLegacyVector(store, 'm1', '长期记忆系统') // 存量：神经身份下"缺当前身份"
    await store.put(recordOf('m2', '这条的正文会被改写'))
    // 先声明当前身份是神经嵌入器，才能给 m2 落一条"当前身份、但编码的是旧正文"的行
    await api.setEmbeddingMeta(NEURAL_IDENTITY)
    await api.putEmbedding({
      memoryId: 'm2',
      modelId: NEURAL_IDENTITY.modelId,
      dim: NEURAL_IDENTITY.dim,
      revision: NEURAL_IDENTITY.revision,
      vector: new Float32Array(NEURAL_IDENTITY.dim),
      contentHash: '旧正文的哈希',
    })

    const booted = boot(() => [storeSetOf('user', store)])
    await settle(booted.instance)
    await booted.encoder.encodePending() // 一次扫描：只测量、只入队

    const stats = booted.encoder.stats().rebuild
    expect(stats.stale).toBe(2)
    expect(stats.causes).toEqual({ lackingIdentity: 1, contentChanged: 1 })

    const status = booted.status().join('\n')
    expect(status).toContain('缺当前身份 1 条')
    expect(status).toContain('正文已改写 1 条')
    const health = booted.instance.manifest.health()
    expect(health.detail).toContain('缺当前身份 1 条')
    expect(health.detail).toContain('正文已改写 1 条')
    expect(health.metrics?.['staleEmbeddings']).toBe(2)
    expect(health.metrics?.['staleLackingIdentity']).toBe(1)
    expect(health.metrics?.['staleContentChanged']).toBe(1)
    booted.dispose()
  })
})
