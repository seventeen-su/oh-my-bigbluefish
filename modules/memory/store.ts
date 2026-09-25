/**
 * 记忆库存储实现：`MemoryStore` 端口 + `StoresService`（内核服务名 `stores`）。
 *
 * 设计要点（规划 §5.2 / §5.3 / §5.7，契约见 `kernel/abi/storage.ts`）：
 *
 * - **双库**：用户库（跨项目，进程级单例）+ 项目库（跨会话，按规范化 cwd 惰性打开并缓存）。
 *   保留双库的真正理由是**删除语义**：用户库是独立物理工件，"删除关于我的一切"因此是一次文件操作。
 * - **一库一连接**：`busy_timeout = 1000`，写事务 `BEGIN IMMEDIATE`（快速失败而不是死等），
 *   写操作经 promise 链串行化。
 * - **批量而非 N+1**：`getMany` 一条 SQL 取回全部 id（按 `MAX_SQL_VARS` 分块），
 *   旧实现"每 id 一次 SELECT"是明确的缺陷。
 * - **可归属向量**：`embedding` 表的 `model_id`/`dim`/`revision` 非空，
 *   写入时与 `meta` 表比对，不一致的向量**直接拒绝**——从结构上消灭"混入哈希词袋"的旧缺陷。
 * - **FTS5 由触发器与节点表同步**：索引不可能漂移；分词在 JS 侧做
 *   （`node:sqlite` 不能注册自定义 FTS5 tokenizer，见规划 §8.3），
 *   写入与查询两侧都用 `./text.js` 的同一个分词器。
 *
 * 本文件不 import `node:sqlite`：连接由 `dsh/` 经 `StorageHostPort.openDatabase` 注入。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Clock,
  Edge,
  GraphQuery,
  GraphWalk,
  LexicalQuery,
  Logger,
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  ScoredHit,
  SqliteLike,
  StorageHostPort,
  StoreSet,
  StoreStats,
  StoresService,
  TaggedStore,
} from '../../kernel/abi/index.js'
import { ASSERTED_BY, EDGE_TYPES, MEMORY_KINDS } from '../../kernel/abi/index.js'
import {
  DATA_DIR_NAME,
  MEMORY_DIR_NAME,
  PROJECT_DB_FILE,
  ensureMemoryDirs,
  projectIdentity,
  type MemoryPaths,
} from './paths.js'
import { migrate, readUserVersion } from './migrate.js'
import { ftsMatchExpr, tokenizeForFts } from './text.js'

/** 写锁等待上限：1000ms。**快速失败**，不做无限等待（规划 R8）。 */
export const WRITE_BUSY_TIMEOUT_MS = 1000

/** 单条 SQL 的最大绑定参数个数（SQLite 默认上限 32766，取保守值以便确定性分块）。 */
export const MAX_SQL_VARS = 500

/** 图遍历的深度上限。规划 §5.5 只暴露 depth 1|2；这里留一格余量并硬性封顶。 */
export const MAX_WALK_DEPTH = 3

/** 项目库连接缓存上限；超限按 LRU 淘汰并关库（防止长跑进程里句柄无限增长）。 */
export const MAX_OPEN_PROJECTS = 16

const NOOP = (): void => {}

// ────────────────────────────────────────────────────────────────────────────
// 错误类型：调用方据此区分"可以降级"与"必须修代码"
// ────────────────────────────────────────────────────────────────────────────

/** 库已关闭（或正在关闭）时的操作。热插拔后旧引用继续被调用是正常的，因此要可读。 */
export class StoreClosedError extends Error {
  constructor(scope: MemoryScope, phase: 'closing' | 'closed') {
    super(`记忆库（${scope}）已${phase === 'closing' ? '在关闭中' : '关闭'}：请重新获取 stores 服务，不要继续用旧句柄`)
    this.name = 'StoreClosedError'
  }
}

/** 向错误的库写错类型。**直接拒绝，不静默接受**（规划 §5.3 写入路由）。 */
export class ScopeRoutingError extends Error {
  constructor(recordScope: MemoryScope, storeScope: MemoryScope, id: string) {
    super(
      `记忆写入被拒：记录 ${id} 声明 scope=${recordScope}，但这条连接属于 ${storeScope} 库。` +
        `位置即权威——请按 SCOPE_BY_KIND 路由，显式覆盖时也要与目标库一致。`,
    )
    this.name = 'ScopeRoutingError'
  }
}

/**
 * 向量无法归属：缺少 `model_id`/`dim`/`revision`，长度与声明维度不符，含非有限值，
 * 或与 `meta` 表记录的当前嵌入器不一致。
 *
 * 这类向量**不可用于搜索**，因此在写入时就被拒绝（规划 §5.7 / D2）。
 */
export class VectorAttributionError extends Error {
  constructor(reason: string) {
    super(`向量写入被拒：${reason}`)
    this.name = 'VectorAttributionError'
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 向量附加面（非 ABI：ABI 的 MemoryStore 没有向量读写，但 §5.7 需要它）
// ────────────────────────────────────────────────────────────────────────────

/** 一条可归属的向量。四个归属标签必须齐备。 */
export interface EmbeddingVector {
  readonly memoryId: string
  /** 嵌入器稳定标识，如 `hash-bow-256` / `bge-small-zh-v1.5-512`。 */
  readonly modelId: string
  /** 维度；必须与 `vector.length` 一致，且 > 0。 */
  readonly dim: number
  /** 模型修订号；换模型时用于判定哪些向量已陈旧。 */
  readonly revision: string
  readonly vector: Float32Array
}

/** `meta` 表记录的当前嵌入器（权威身份）。 */
export interface EmbeddingMeta {
  readonly modelId: string
  readonly dim: number
  readonly revision: string
}

/**
 * 某个库的向量读写面。
 *
 * `omb-memory-vector` 经 `asVectorStore(store)` 取得；不可用时返回 undefined，
 * 调用方降级为纯词法（规划 §5.7：关掉向量模块，词法路径仍完整可用）。
 */
export interface VectorStoreApi {
  /** 写一条向量。归属标签非法或与 `meta` 不一致 → `VectorAttributionError`。 */
  putEmbedding(vector: EmbeddingVector): Promise<void>
  /** **批量**取向量（禁 N+1）。 */
  getEmbeddings(ids: readonly string[]): Promise<readonly EmbeddingVector[]>
  /** 列出向量（供陈旧度查询与重建）。 */
  listEmbeddings(filter?: {
    readonly modelId?: string
    readonly revision?: string
    readonly limit?: number
  }): Promise<readonly EmbeddingVector[]>
  countEmbeddings(): Promise<number>
  /** 当前嵌入器身份；未声明返回 null（此时任何向量都不可归属）。 */
  embeddingMeta(): Promise<EmbeddingMeta | null>
  /** 声明/切换当前嵌入器。已有向量随之成为"陈旧"（可查询、可重建，但不再被使用）。 */
  setEmbeddingMeta(meta: EmbeddingMeta): Promise<void>
}

/** 具体实现类型。除端口外还暴露状态面需要的诊断字段。 */
export interface SqliteMemoryStore extends MemoryStore, VectorStoreApi {
  /** 库文件路径（`:memory:` 时为该字面量）。 */
  readonly dbPath: string
  /** 打开时的迁移结果；未迁移时为 `{from: n, to: n}`。 */
  readonly migrated: { readonly from: number; readonly to: number }
}

/** 从端口句柄取向量面；不是本实现返回 undefined（调用方降级，不抛）。 */
export function asVectorStore(store: MemoryStore): VectorStoreApi | undefined {
  return store instanceof SqliteStore ? store : undefined
}

/** 从端口句柄取诊断面（库路径、迁移结果）；不是本实现返回 undefined。 */
export function asMemoryStore(store: MemoryStore): SqliteMemoryStore | undefined {
  return store instanceof SqliteStore ? store : undefined
}

// ────────────────────────────────────────────────────────────────────────────
// 行 ↔ 记录
// ────────────────────────────────────────────────────────────────────────────

const RECORD_COLUMNS = `id, scope, kind, text, content_hash, source_ref, asserted_by,
  observed_at, valid_to, superseded_by, last_used_at, use_count, project`

const INSERT_RECORD_SQL = `
INSERT INTO memory (
  id, scope, kind, text, content_hash, source_ref, asserted_by,
  observed_at, valid_to, superseded_by, last_used_at, use_count, project, payload_fts
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  scope = excluded.scope,
  kind = excluded.kind,
  text = excluded.text,
  content_hash = excluded.content_hash,
  source_ref = excluded.source_ref,
  asserted_by = excluded.asserted_by,
  observed_at = excluded.observed_at,
  valid_to = excluded.valid_to,
  superseded_by = excluded.superseded_by,
  last_used_at = excluded.last_used_at,
  use_count = excluded.use_count,
  project = excluded.project,
  payload_fts = excluded.payload_fts`

const UPSERT_EDGE_SQL = `
INSERT INTO edge (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)
ON CONFLICT(from_id, to_id, type) DO UPDATE SET created_at = excluded.created_at`

const UPSERT_EMBEDDING_SQL = `
INSERT INTO embedding (memory_id, model_id, dim, revision, vector) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(memory_id, model_id, revision) DO UPDATE SET
  dim = excluded.dim, vector = excluded.vector`

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRow(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error(`OMB：${where} 期望一行记录，实际得到 ${String(value)}`)
  }
  return value as Record<string, unknown>
}

function textOf(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`OMB：读取记忆库时字段 ${field} 不是文本（实际 ${typeof value}）——数据已损坏`)
  }
  return value
}

function integerOf(value: unknown, field: string): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`OMB：读取记忆库时字段 ${field} 不是整数（实际 ${String(value)}）——数据已损坏`)
  }
  return value
}

function nullableIntegerOf(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : integerOf(value, field)
}

function nullableTextOf(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : textOf(value, field)
}

function countOf(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 同 `countOf`，名字用在非计数场景（如 bm25 分数）。 */
const numberOf = countOf

function enumOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new Error(
    `OMB：字段 ${field} 的取值 ${String(value)} 不在允许集合 [${allowed.join(', ')}] 内——数据已损坏`,
  )
}

function toRecord(row: unknown): MemoryRecord {
  const r = asRow(row, 'memory 行')
  return {
    id: textOf(r['id'], 'id'),
    scope: enumOf(r['scope'], ['user', 'project'] as const, 'scope'),
    kind: enumOf(r['kind'], MEMORY_KINDS, 'kind'),
    text: textOf(r['text'], 'text'),
    contentHash: textOf(r['content_hash'], 'content_hash'),
    sourceRef: textOf(r['source_ref'], 'source_ref'),
    assertedBy: enumOf(r['asserted_by'], ASSERTED_BY, 'asserted_by'),
    observedAt: integerOf(r['observed_at'], 'observed_at'),
    validTo: nullableIntegerOf(r['valid_to'], 'valid_to'),
    supersededBy: nullableTextOf(r['superseded_by'], 'superseded_by'),
    lastUsedAt: integerOf(r['last_used_at'], 'last_used_at'),
    useCount: integerOf(r['use_count'], 'use_count'),
    project: nullableTextOf(r['project'], 'project'),
  }
}

function toEdge(row: unknown): Edge {
  const r = asRow(row, 'edge 行')
  return {
    fromId: textOf(r['from_id'], 'from_id'),
    toId: textOf(r['to_id'], 'to_id'),
    type: enumOf(r['type'], EDGE_TYPES, 'type'),
    createdAt: integerOf(r['created_at'], 'created_at'),
  }
}

/** Float32Array → BLOB。拷贝而不是共享 buffer：调用方可能复用同一块内存。 */
function float32ToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

function blobToFloat32(value: unknown, where: string): Float32Array {
  let bytes: Uint8Array
  if (value instanceof Uint8Array) bytes = value
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else throw new Error(`OMB：${where} 期望 BLOB，实际得到 ${typeof value}——数据已损坏`)
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`OMB：${where} 的 BLOB 长度 ${bytes.byteLength} 不是 4 的倍数——数据已损坏`)
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

function chunkArray<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  if (items.length <= size) return [items]
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function requireNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`OMB：记忆写入被拒——字段 ${field} 必须是非空字符串`)
  }
  return value
}

/**
 * 校验并补齐一条记录。
 *
 * `lastUsedAt` 未给有限值时退化为 `observedAt`（"刚写入"的合理语义），
 * 但其余字段一律拒绝猜测——尤其 `sourceRef`：空来源等于没有来源，
 * 投毒防御与证据独立性都建立在它之上。
 */
function normalizeRecord(record: MemoryRecord, clock: Clock): MemoryRecord {
  const id = requireNonEmptyText(record.id, 'id')
  const text = requireNonEmptyText(record.text, 'text')
  const contentHash = requireNonEmptyText(record.contentHash, 'contentHash')
  const sourceRef = requireNonEmptyText(record.sourceRef, 'sourceRef')
  const kind = enumOf(record.kind, MEMORY_KINDS, 'kind')
  const assertedBy = enumOf(record.assertedBy, ASSERTED_BY, 'assertedBy')
  if (!Number.isInteger(record.observedAt)) {
    throw new Error(`OMB：记忆写入被拒——observedAt 必须是整数事件时间，收到 ${String(record.observedAt)}`)
  }
  let validTo: number | null = null
  if (record.validTo !== null && record.validTo !== undefined) {
    if (!Number.isInteger(record.validTo)) {
      throw new Error(`OMB：记忆写入被拒——validTo 必须是整数或 null，收到 ${String(record.validTo)}`)
    }
    validTo = record.validTo
  }
  const supersededBy =
    record.supersededBy === null || record.supersededBy === undefined
      ? null
      : requireNonEmptyText(record.supersededBy, 'supersededBy')
  if (!Number.isInteger(record.useCount) || record.useCount < 0) {
    throw new Error(`OMB：记忆写入被拒——useCount 必须是 ≥0 的整数，收到 ${String(record.useCount)}`)
  }
  let project: string | null = null
  if (record.project !== null && record.project !== undefined) {
    project = requireNonEmptyText(record.project, 'project')
  }
  // 未给有限值时退化为事件时间（"刚写入"的合理语义）
  const lastUsedAt = Number.isInteger(record.lastUsedAt) ? record.lastUsedAt : clock.now()
  return {
    id,
    scope: record.scope,
    kind,
    text,
    contentHash,
    sourceRef,
    assertedBy,
    observedAt: record.observedAt,
    validTo,
    supersededBy,
    lastUsedAt,
    useCount: record.useCount,
    project,
  }
}

/** 向量归属校验：返回拒绝原因，或 undefined 表示可写入。 */
function validateVectorAttribution(vector: EmbeddingVector): string | undefined {
  if (typeof vector.memoryId !== 'string' || vector.memoryId.length === 0) {
    return '缺少 memory_id——向量必须归属到一条记忆'
  }
  if (typeof vector.modelId !== 'string' || vector.modelId.trim().length === 0) {
    return '缺少 model_id——不可归属的向量不允许写入'
  }
  if (!Number.isInteger(vector.dim) || vector.dim <= 0) {
    return `维度非法（${String(vector.dim)}）——必须为 >0 的整数`
  }
  if (typeof vector.revision !== 'string' || vector.revision.trim().length === 0) {
    return '缺少 revision——没有修订号就无法判定"哪些向量已陈旧"'
  }
  if (!(vector.vector instanceof Float32Array)) {
    return `vector 必须是 Float32Array，收到 ${Object.prototype.toString.call(vector.vector)}`
  }
  if (vector.vector.length !== vector.dim) {
    return `向量长度 ${vector.vector.length} 与声明维度 ${vector.dim} 不一致`
  }
  for (const component of vector.vector) {
    if (!Number.isFinite(component)) return '向量含 NaN/Infinity——不可用于距离计算'
  }
  return undefined
}

// ────────────────────────────────────────────────────────────────────────────
// 单库实现
// ────────────────────────────────────────────────────────────────────────────

export interface CreateMemoryStoreOptions {
  readonly scope: MemoryScope
  readonly db: SqliteLike
  readonly dbPath: string
  readonly logger: Logger
  /** 注入时钟（内核 `kernel.clock`），**禁止**直接 `Date.now()`。 */
  readonly clock: Clock
  readonly migrated?: { readonly from: number; readonly to: number }
}

/** 建一个库句柄。**不打开文件、不迁移**——由 `openMemoryStore` 负责。 */
export function createMemoryStore(options: CreateMemoryStoreOptions): SqliteMemoryStore {
  return new SqliteStore(options)
}

class SqliteStore implements SqliteMemoryStore {
  readonly scope: MemoryScope
  readonly dbPath: string
  readonly migrated: { readonly from: number; readonly to: number }

  readonly #db: SqliteLike
  readonly #logger: Logger
  readonly #clock: Clock

  /** 写操作串行化链：**一次只有一个写事务在飞**。 */
  #queue: Promise<unknown> = Promise.resolve()
  /** 当前事务（含 savepoint）嵌套深度。>0 时写入并入当前事务，避免自死锁。 */
  #txDepth = 0
  #savepointSeq = 0
  #closing = false
  #closed = false
  #closePromise: Promise<void> | undefined

  constructor(options: CreateMemoryStoreOptions) {
    this.scope = options.scope
    this.dbPath = options.dbPath
    this.migrated = options.migrated ?? { from: 0, to: 0 }
    this.#db = options.db
    this.#logger = options.logger
    this.#clock = options.clock
  }

  // ── 连接与查询原语 ──────────────────────────────────────────────────────

  #all(sql: string, params: readonly unknown[] = []): readonly unknown[] {
    return this.#db.prepare(sql).all(...params)
  }

  #get(sql: string, params: readonly unknown[] = []): Record<string, unknown> | undefined {
    const row = this.#db.prepare(sql).get(...params)
    return row === undefined ? undefined : asRow(row, '查询结果')
  }

  #run(sql: string, params: readonly unknown[] = []): number {
    return countOf(this.#db.prepare(sql).run(...params).changes)
  }

  #assertUsable(): void {
    if (this.#closing) throw new StoreClosedError(this.scope, 'closing')
    if (this.#closed) throw new StoreClosedError(this.scope, 'closed')
  }

  /** 排队后才执行的守卫：`close()` 会先等队列排空再关连接，因此这里只挡真正已关的库。 */
  #assertOpen(): void {
    if (this.#closed) throw new StoreClosedError(this.scope, 'closed')
  }

  /**
   * 写操作入口。
   *
   * 事务中发起的写入（同一库）**并入当前事务**——若继续排队，会与持有队列的事务互相等待。
   * 因此本实现的语义是**单写者**：并发写入被串行化；事务挂起期间的外部写入属于该事务的一部分。
   */
  #enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    if (this.#txDepth > 0) return Promise.resolve().then(op)
    const run = this.#queue.then(op, op)
    this.#queue = run.then(NOOP, NOOP)
    return run
  }

  // ── 写入 ────────────────────────────────────────────────────────────────

  async put(record: MemoryRecord): Promise<void> {
    this.#assertUsable()
    await this.#enqueue(() => {
      this.#assertOpen()
      if (record.scope !== this.scope) throw new ScopeRoutingError(record.scope, this.scope, record.id)
      const row = normalizeRecord(record, this.#clock)
      // 分词只在写入侧做一次：FTS 索引由触发器跟随 payload_fts，不会漂移
      this.#run(INSERT_RECORD_SQL, [
        row.id,
        row.scope,
        row.kind,
        row.text,
        row.contentHash,
        row.sourceRef,
        row.assertedBy,
        row.observedAt,
        row.validTo,
        row.supersededBy,
        row.lastUsedAt,
        row.useCount,
        row.project,
        tokenizeForFts(row.text),
      ])
    })
  }

  async upsertEdge(edge: Edge): Promise<void> {
    this.#assertUsable()
    await this.#enqueue(() => {
      this.#assertOpen()
      const fromId = requireNonEmptyText(edge.fromId, 'fromId')
      const toId = requireNonEmptyText(edge.toId, 'toId')
      if (fromId === toId) throw new Error(`OMB：边被拒——from 与 to 相同（${fromId}）不是一条关系`)
      const type = enumOf(edge.type, EDGE_TYPES, 'type')
      if (!Number.isInteger(edge.createdAt)) {
        throw new Error(`OMB：边被拒——createdAt 必须是整数，收到 ${String(edge.createdAt)}`)
      }
      this.#run(UPSERT_EDGE_SQL, [fromId, toId, type, edge.createdAt])
    })
  }

  async forget(ids: readonly string[]): Promise<number> {
    this.#assertUsable()
    const unique = [...new Set(ids)].filter(id => typeof id === 'string' && id.length > 0)
    if (unique.length === 0) return 0
    return await this.#enqueue(() => {
      this.#assertOpen()
      let removed = 0
      for (const chunk of chunkArray(unique, MAX_SQL_VARS)) {
        const placeholders = chunk.map(() => '?').join(', ')
        // 边、向量随节点一起删：留下指向已删除记忆的边会泄漏 id，向量则会把被删文本留在磁盘上
        this.#run(`DELETE FROM edge WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`, [
          ...chunk,
          ...chunk,
        ])
        this.#run(`DELETE FROM embedding WHERE memory_id IN (${placeholders})`, chunk)
        removed += this.#run(`DELETE FROM memory WHERE id IN (${placeholders})`, chunk)
      }
      return removed
    })
  }

  async putEmbedding(vector: EmbeddingVector): Promise<void> {
    this.#assertUsable()
    await this.#enqueue(() => {
      this.#assertOpen()
      const problem = validateVectorAttribution(vector)
      if (problem !== undefined) throw new VectorAttributionError(problem)

      const meta = this.#readEmbeddingMeta()
      if (meta === null) {
        // 首次写入即声明身份：向量与标签同生共死，不存在"无标签的向量"
        this.#writeEmbeddingMeta({ modelId: vector.modelId, dim: vector.dim, revision: vector.revision })
      } else if (meta.modelId !== vector.modelId || meta.dim !== vector.dim) {
        throw new VectorAttributionError(
          `声明 ${vector.modelId}/${vector.dim} 与 meta 记录的当前嵌入器 ${meta.modelId}/${meta.dim} 不一致——` +
            `不同模型或维度的向量不可比，换模型请先 setEmbeddingMeta 并重建`,
        )
      }
      this.#run(UPSERT_EMBEDDING_SQL, [
        vector.memoryId,
        vector.modelId,
        vector.dim,
        vector.revision,
        float32ToBlob(vector.vector),
      ])
    })
  }

  async setEmbeddingMeta(meta: EmbeddingMeta): Promise<void> {
    this.#assertUsable()
    const problem =
      typeof meta.modelId !== 'string' || meta.modelId.trim().length === 0
        ? '缺少 model_id'
        : !Number.isInteger(meta.dim) || meta.dim <= 0
          ? `维度非法（${String(meta.dim)}）`
          : typeof meta.revision !== 'string' || meta.revision.trim().length === 0
            ? '缺少 revision'
            : undefined
    if (problem !== undefined) throw new VectorAttributionError(problem)
    await this.#enqueue(() => {
      this.#assertOpen()
      const stale = countOf(
        this.#get('SELECT COUNT(*) AS c FROM embedding WHERE model_id <> ? OR dim <> ?', [
          meta.modelId,
          meta.dim,
        ])?.['c'],
      )
      this.#writeEmbeddingMeta(meta)
      if (stale > 0) {
        this.#logger.info(
          `OMB：嵌入器切换为 ${meta.modelId}/${meta.dim}（rev ${meta.revision}）；` +
            `${stale} 条向量成为陈旧——它们仍可查询与重建，但不参与检索`,
        )
      }
    })
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<MemoryRecord | undefined> {
    this.#assertUsable()
    const row = this.#get(`SELECT ${RECORD_COLUMNS} FROM memory WHERE id = ?`, [id])
    return row === undefined ? undefined : toRecord(row)
  }

  /**
   * 批量读取。**一条 SQL 取回全部 id**（超过 `MAX_SQL_VARS` 才分块），
   * 返回顺序与入参一致（去重后），缺失的 id 直接跳过。
   */
  async getMany(ids: readonly string[]): Promise<readonly MemoryRecord[]> {
    this.#assertUsable()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const found = new Map<string, MemoryRecord>()
    for (const chunk of chunkArray(unique, MAX_SQL_VARS)) {
      const placeholders = chunk.map(() => '?').join(', ')
      for (const row of this.#all(`SELECT ${RECORD_COLUMNS} FROM memory WHERE id IN (${placeholders})`, chunk)) {
        const record = toRecord(row)
        found.set(record.id, record)
      }
    }
    const result: MemoryRecord[] = []
    for (const id of unique) {
      const record = found.get(id)
      if (record !== undefined) result.push(record)
    }
    return result
  }

  /**
   * 词法检索（FTS5 + BM25）。
   *
   * - 查询串用**与写入侧相同的分词器**处理后构造 MATCH 表达式（规划 §8.3）
   * - `score` 为 `-bm25()`：**越大越相关**；同一通道内降序即排名。跨通道禁止算术语义（融合只按排名）
   * - 默认**排除失效记忆**：`valid_to` 或 `superseded_by` 非空的行不注入（精度优先，规划 §5.1）。
   *   `get`/`getMany` 仍会返回它们——"我当时相信什么"必须可回答
   */
  async searchLexical(query: LexicalQuery): Promise<readonly ScoredHit[]> {
    this.#assertUsable()
    if (query.scope !== this.scope) {
      // 读错库不抛：检索侧按库扇出，一个库的调用参数错不该让整次召回失败
      this.#logger.warn(`OMB：searchLexical 的 scope=${query.scope} 与库 ${this.scope} 不符——返回空结果`)
      return []
    }
    const limit = Number.isFinite(query.limit) ? Math.max(0, Math.floor(query.limit)) : 0
    if (limit === 0) return []

    const expression = ftsMatchExpr(tokenizeForFts(query.text))
    if (expression.trim().length === 0) return [] // 空表达式不得拿去 MATCH（会语法错误）

    const kinds = query.kinds === undefined ? [] : [...new Set(query.kinds)]
    for (const kind of kinds) enumOf(kind, MEMORY_KINDS, 'kinds')

    const params: unknown[] = [expression, this.scope]
    let kindClause = ''
    if (kinds.length > 0) {
      kindClause = ` AND m.kind IN (${kinds.map(() => '?').join(', ')})`
      params.push(...kinds)
    }
    params.push(limit)

    const rows = this.#all(
      `SELECT m.id AS id, -bm25(memory_fts) AS score
         FROM memory_fts
         JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
          AND m.scope = ?
          AND m.valid_to IS NULL
          AND m.superseded_by IS NULL${kindClause}
        ORDER BY score DESC, m.observed_at DESC, m.id ASC
        LIMIT ?`,
      params,
    )
    return rows.map(row => {
      const r = asRow(row, '检索命中')
      return {
        id: textOf(r['id'], 'id'),
        score: numberOf(r['score']),
        channel: 'lexical' as const,
      }
    })
  }

  // ── 图 ──────────────────────────────────────────────────────────────────

  /**
   * 多跳关联扩展（规划 §5.5）。**无向遍历**：`supersedes`/`derived_from` 两个方向都跟，
   * 因为"关联链"关心的是可达性而不是边的书写方向。
   *
   * 逐层批量查询（`IN (...)`），不做逐节点查询。
   */
  async walkGraph(query: GraphQuery): Promise<GraphWalk> {
    this.#assertUsable()
    const depth = Number.isFinite(query.depth) ? Math.min(Math.max(Math.floor(query.depth), 0), MAX_WALK_DEPTH) : 0
    const types = query.types === undefined ? [] : [...new Set(query.types)]
    for (const type of types) enumOf(type, EDGE_TYPES, 'types')

    const visited = new Set<string>()
    if (typeof query.fromId === 'string' && query.fromId.length > 0) visited.add(query.fromId)
    const edges = new Map<string, Edge>()
    let frontier = [...visited]

    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const next: string[] = []
      for (const edge of this.#edgesTouching(frontier, types)) {
        edges.set(`${edge.fromId}\u0000${edge.toId}\u0000${edge.type}`, edge)
        for (const id of [edge.fromId, edge.toId]) {
          if (!visited.has(id)) {
            visited.add(id)
            next.push(id)
          }
        }
      }
      frontier = next
    }

    return { nodes: await this.getMany([...visited]), edges: [...edges.values()] }
  }

  #edgesTouching(ids: readonly string[], types: readonly string[]): readonly Edge[] {
    const collected = new Map<string, Edge>()
    const typeClause = types.length === 0 ? '' : ` AND type IN (${types.map(() => '?').join(', ')})`
    for (const chunk of chunkArray(ids, Math.floor(MAX_SQL_VARS / 2))) {
      const placeholders = chunk.map(() => '?').join(', ')
      for (const column of ['from_id', 'to_id'] as const) {
        const rows = this.#all(
          `SELECT from_id, to_id, type, created_at FROM edge WHERE ${column} IN (${placeholders})${typeClause}`,
          [...chunk, ...types],
        )
        for (const row of rows) {
          const edge = toEdge(row)
          collected.set(`${edge.fromId}\u0000${edge.toId}\u0000${edge.type}`, edge)
        }
      }
    }
    return [...collected.values()]
  }

  // ── 事务 ────────────────────────────────────────────────────────────────

  /**
   * 单库事务：`BEGIN IMMEDIATE`（立刻抢写锁，拿不到就在 `busy_timeout` 后失败）。
   *
   * 嵌套调用使用 `SAVEPOINT`：内层失败只回滚内层，外层可继续。
   * `fn` 内的 `put`/`upsertEdge`/`forget` 自动并入当前事务。
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#assertUsable()
    return await this.#enqueue(async () => {
      this.#assertOpen()
      const nested = this.#txDepth > 0
      const savepoint = `omb_sp_${++this.#savepointSeq}`
      this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
      this.#txDepth++
      try {
        const result = await fn()
        this.#txDepth--
        this.#db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        this.#txDepth--
        try {
          this.#db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK')
          if (nested) this.#db.exec(`RELEASE ${savepoint}`)
        } catch (rollbackError) {
          // 回滚失败不吞掉原始异常：它才是调用方需要看到的
          this.#logger.warn(
            `OMB：事务回滚失败（原始异常仍向上抛）——${messageOf(rollbackError)}`,
          )
        }
        throw error
      }
    })
  }

  // ── 状态与关闭 ──────────────────────────────────────────────────────────

  async stats(): Promise<StoreStats> {
    this.#assertUsable()
    const rows = countOf(this.#get('SELECT COUNT(*) AS c FROM memory')?.['c'])
    const schemaVersion = readUserVersion(this.#db)
    const vectorRows = countOf(this.#get('SELECT COUNT(*) AS c FROM embedding')?.['c'])
    let vectors: StoreStats['vectors'] = null
    if (vectorRows > 0) {
      const meta = this.#readEmbeddingMeta()
      const fallback = this.#get('SELECT model_id, dim FROM embedding LIMIT 1')
      vectors = {
        rows: vectorRows,
        dim: meta?.dim ?? numberOf(fallback?.['dim']),
        modelId: meta?.modelId ?? textOf(fallback?.['model_id'], 'model_id'),
      }
    }
    return { scope: this.scope, rows, schemaVersion, vectors }
  }

  async embeddingMeta(): Promise<EmbeddingMeta | null> {
    this.#assertUsable()
    return this.#readEmbeddingMeta()
  }

  async getEmbeddings(ids: readonly string[]): Promise<readonly EmbeddingVector[]> {
    this.#assertUsable()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const result: EmbeddingVector[] = []
    for (const chunk of chunkArray(unique, MAX_SQL_VARS)) {
      const placeholders = chunk.map(() => '?').join(', ')
      for (const row of this.#all(
        `SELECT memory_id, model_id, dim, revision, vector FROM embedding WHERE memory_id IN (${placeholders})`,
        chunk,
      )) {
        result.push(this.#toEmbedding(row))
      }
    }
    return result
  }

  async listEmbeddings(filter?: {
    readonly modelId?: string
    readonly revision?: string
    readonly limit?: number
  }): Promise<readonly EmbeddingVector[]> {
    this.#assertUsable()
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter?.modelId !== undefined) {
      clauses.push('model_id = ?')
      params.push(filter.modelId)
    }
    if (filter?.revision !== undefined) {
      clauses.push('revision = ?')
      params.push(filter.revision)
    }
    const limit = filter?.limit === undefined ? '' : ' LIMIT ?'
    if (filter?.limit !== undefined) {
      params.push(Number.isFinite(filter.limit) ? Math.max(0, Math.floor(filter.limit)) : 0)
    }
    const rows = this.#all(
      `SELECT memory_id, model_id, dim, revision, vector FROM embedding${
        clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      }${limit}`,
      params,
    )
    return rows.map(row => this.#toEmbedding(row))
  }

  async countEmbeddings(): Promise<number> {
    this.#assertUsable()
    return countOf(this.#get('SELECT COUNT(*) AS c FROM embedding')?.['c'])
  }

  #toEmbedding(row: unknown): EmbeddingVector {
    const r = asRow(row, 'embedding 行')
    const memoryId = textOf(r['memory_id'], 'memory_id')
    const dim = integerOf(r['dim'], 'dim')
    return {
      memoryId,
      modelId: textOf(r['model_id'], 'model_id'),
      dim,
      revision: textOf(r['revision'], 'revision'),
      vector: blobToFloat32(r['vector'], `embedding(${memoryId})`),
    }
  }

  #readEmbeddingMeta(): EmbeddingMeta | null {
    const row = this.#get(
      'SELECT embedding_model_id, embedding_dim, embedding_revision FROM meta LIMIT 1',
    )
    if (row === undefined) return null
    const modelId = row['embedding_model_id']
    const dim = row['embedding_dim']
    const revision = row['embedding_revision']
    if (typeof modelId !== 'string' || modelId.length === 0) return null
    if (typeof dim !== 'number' || !Number.isInteger(dim) || dim <= 0) return null
    if (typeof revision !== 'string' || revision.length === 0) return null
    return { modelId, dim, revision }
  }

  #writeEmbeddingMeta(meta: EmbeddingMeta): void {
    this.#run('UPDATE meta SET embedding_model_id = ?, embedding_dim = ?, embedding_revision = ?', [
      meta.modelId,
      meta.dim,
      meta.revision,
    ])
  }

  /**
   * 关闭连接。**绝不抛异常**（热插拔 H-1）：任何失败都只记日志。
   * 关闭前先等在飞的写入结束，避免"关到一半"。
   */
  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#closing = true
      try {
        await this.#queue
      } catch {
        // 队列里的失败与该次关闭无关；调用方各自的 promise 已经收到过异常
      }
      try {
        this.#db.close()
      } catch (error) {
        this.#logger.warn(`OMB：关闭记忆库（${this.scope}，${this.dbPath}）失败（已隔离）——${messageOf(error)}`)
      }
      this.#closed = true
    })()
    return this.#closePromise
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 打开一个库：目录、连接参数、迁移
// ────────────────────────────────────────────────────────────────────────────

export interface OpenMemoryStoreOptions {
  /** 库的作用域。`project` 会按 cwd 的目录布局创建目录与说明文件。 */
  readonly scope: MemoryScope
  /** 该库的绝对路径。 */
  readonly dbPath: string
  /** 宿主注入的存储端口（打开函数 + 目录策略）。 */
  readonly port: StorageHostPort
  readonly logger: Logger
  /** 注入时钟（内核 `kernel.clock`）：模块层**禁止**直接 `Date.now()`。 */
  readonly clock: Clock
}

/** 项目库路径 = `<cwd>/.omb/memory/session.db`（与 `paths.ts` 同一套常量，不重复拼字面量）。 */
export function projectDbPathFor(cwd: string): string {
  return join(projectIdentity(cwd), DATA_DIR_NAME, MEMORY_DIR_NAME, PROJECT_DB_FILE)
}

/** 连接级设置：一库一连接，写锁快速失败。 */
function configureConnection(db: SqliteLike, logger: Logger): void {
  db.exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`)
  try {
    db.exec('PRAGMA journal_mode = WAL')
  } catch (error) {
    // 某些文件系统（网络盘）不支持 WAL：降级而不是拒绝打开，但必须留下原因
    logger.warn(`OMB：无法启用 WAL（退化为 rollback journal）——${messageOf(error)}`)
  }
  // WAL 下的标准搭配：崩溃不会损坏库，代价是最后若干事务可能丢失（可接受：记忆不是账本）
  db.exec('PRAGMA synchronous = NORMAL')
}

function ensureStoreDirs(options: OpenMemoryStoreOptions): void {
  if (options.scope === 'project') {
    // 复用 paths.ts 的目录与说明文件写入（幂等）；四个字段自洽，与 memoryPaths 的布局一致
    const paths: MemoryPaths = {
      userDbPath: options.port.userDbPath,
      userDir: dirname(options.port.userDbPath),
      projectDbPath: options.dbPath,
      projectDir: dirname(options.dbPath),
    }
    ensureMemoryDirs(paths)
    return
  }
  const dir = dirname(options.dbPath)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new Error(`OMB：无法创建记忆目录 ${dir}——${messageOf(error)}`)
  }
}

function safeClose(db: SqliteLike, logger: Logger, where: string): void {
  try {
    db.close()
  } catch (error) {
    logger.warn(`OMB：关闭 ${where} 失败（已隔离）——${messageOf(error)}`)
  }
}

/**
 * 打开并迁移一个库。
 *
 * **异常一律向上抛**（打开失败、迁移失败、未来版本拒绝）：
 * 由调用方决定是降级（`StoresService` 返回 undefined）还是让整次启动失败。
 */
export function openMemoryStore(options: OpenMemoryStoreOptions): SqliteMemoryStore {
  if (options.port.createDirs) ensureStoreDirs(options)
  const db = options.port.openDatabase(options.dbPath)
  try {
    configureConnection(db, options.logger)
    const outcome = migrate(db, { logger: options.logger })
    if (outcome.applied.length > 0) {
      options.logger.info(
        `OMB：记忆库已迁移 ${options.scope} v${outcome.from} → v${outcome.to}（${options.dbPath}）`,
      )
    }
    return createMemoryStore({
      scope: options.scope,
      db,
      dbPath: options.dbPath,
      logger: options.logger,
      clock: options.clock,
      migrated: { from: outcome.from, to: outcome.to },
    })
  } catch (error) {
    safeClose(db, options.logger, `打开失败的库 ${options.dbPath}`)
    throw error
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 服务：用户库单例 + 项目库按 cwd 惰性缓存
// ────────────────────────────────────────────────────────────────────────────

export interface StoresServiceOptions {
  readonly logger: Logger
  /** 注入时钟（内核 `kernel.clock`），传给每个库句柄。 */
  readonly clock: Clock
  /**
   * 解析宿主存储端口。每次需要时调用；返回 undefined 表示宿主尚未注入
   * （**不缓存失败**：宿主可能在 apply 之后才注册端口）。
   */
  readonly resolvePort: () => StorageHostPort | undefined
  /** 模块配置的只读副本，供子能力（向量线程数等）读取。 */
  readonly config?: Readonly<Record<string, unknown>>
  /** 项目库连接缓存上限。 */
  readonly maxOpenProjects?: number
  /**
   * 已装配好的宿主端口。给了就不再走 `resolvePort`——
   * `dsh/` 在构造注册项时直接注入是首选路径（不依赖服务名约定）。
   */
  readonly port?: StorageHostPort
}

/**
 * `StoresService` 的具体实现面。除 ABI 声明的方法外，额外暴露状态面需要的东西
 * （`snapshot` / `failure` / `config`）——这些是**附加**方法，不影响 ABI 兼容。
 */
export interface MemoryStoresService extends StoresService {
  readonly config: Readonly<Record<string, unknown>>
  /** apply 里的 fire-and-forget 预热入口：只打开用户库。**绝不抛**。 */
  start(): Promise<void>
  /** 已打开的套件快照（不触发新打开）。 */
  snapshot(): { readonly user: StoreSet | undefined; readonly projects: readonly StoreSet[] }
  /** 最近一次失败的可读原因（状态面"诚实降级"用）。 */
  failure(): string | undefined
  /** 等价于 ABI 的 `close()`；供模块 disposer 使用。 */
  dispose(): Promise<void>
}

/** 项目库默认缓存上限。 */
const DEFAULT_MAX_OPEN_PROJECTS = MAX_OPEN_PROJECTS

export function createStoresService(options: StoresServiceOptions): MemoryStoresService {
  const logger = options.logger
  const config = options.config ?? {}
  const maxOpenProjects = Math.max(1, options.maxOpenProjects ?? DEFAULT_MAX_OPEN_PROJECTS)

  /** 会话 → cwd（宿主告知）。未登记时 forSession 降级为"仅用户库"。 */
  const cwdBySession = new Map<string, string>()
  /** 已打开的项目库套件，插入顺序 = LRU 顺序。 */
  const projects = new Map<string, StoreSet>()
  /** 正在打开的项目库（去重并发打开）。 */
  const pendingProjects = new Map<string, Promise<StoreSet | undefined>>()
  const projectFailures = new Map<string, string>()

  let userStore: SqliteMemoryStore | undefined
  let userSet: StoreSet | undefined
  let userPromise: Promise<StoreSet | undefined> | undefined
  let userFailure: string | undefined
  let unexpectedFailure: string | undefined
  let resolvedPort: StorageHostPort | undefined
  let closing = false
  let closePromise: Promise<void> | undefined

  const port = (): StorageHostPort | undefined => {
    if (closing) return undefined
    if (resolvedPort === undefined) resolvedPort = options.port ?? options.resolvePort()
    return resolvedPort
  }

  function recordUserFailure(reason: string): void {
    userFailure = reason
    logger.warn(`OMB 记忆库：${reason}`)
  }

  function recordProjectFailure(key: string, reason: string): void {
    projectFailures.set(key, reason)
    logger.warn(`OMB 记忆库：${reason}`)
  }

  function taggedStore(store: SqliteMemoryStore): TaggedStore {
    return { scope: store.scope, store }
  }

  function migrationOf(store: SqliteMemoryStore): { scope: MemoryScope; from: number; to: number } {
    return { scope: store.scope, from: store.migrated.from, to: store.migrated.to }
  }

  /** 用户库专属套件：`projectScope = null`（"本项目不可用"的显式信号）。 */
  function userOnlySet(store: SqliteMemoryStore): StoreSet {
    return {
      projectScope: null,
      stores: [taggedStore(store)],
      store: scope => (scope === 'user' ? store : undefined),
      migrated: [migrationOf(store)],
      close: () => store.close(),
    }
  }

  /** 项目套件：用户库 + 该项目库。关闭时**只关项目库**——用户库由服务拥有。 */
  function projectSet(projectScope: string, projectStore: SqliteMemoryStore): StoreSet {
    const stores: TaggedStore[] = []
    if (userStore !== undefined) stores.push(taggedStore(userStore))
    stores.push(taggedStore(projectStore))
    return {
      projectScope,
      stores,
      store: scope => {
        if (scope === 'user') return userStore
        if (scope === 'project') return projectStore
        return undefined
      },
      migrated: [...(userStore === undefined ? [] : [migrationOf(userStore)]), migrationOf(projectStore)],
      close: () => projectStore.close(),
    }
  }

  async function ensureUser(): Promise<StoreSet | undefined> {
    if (closing) return undefined
    if (userSet !== undefined) return userSet
    if (userPromise !== undefined) return await userPromise

    const hostPort = port()
    if (hostPort === undefined) {
      userFailure = '宿主未注入存储端口（omb.storage-host / storageHost 未提供）——用户库未打开'
      return undefined
    }

    userPromise = (async (): Promise<StoreSet | undefined> => {
      try {
        const store = openMemoryStore({
          scope: 'user',
          dbPath: hostPort.userDbPath,
          port: hostPort,
          logger,
          clock: options.clock,
        })
        if (closing) {
          await store.close()
          return undefined
        }
        userStore = store
        userSet = userOnlySet(store)
        userFailure = undefined
        return userSet
      } catch (error) {
        recordUserFailure(`用户库打开失败（${hostPort.userDbPath}）：${messageOf(error)}`)
        return undefined
      }
    })()

    const result = await userPromise
    if (result === undefined) userPromise = undefined // 允许下次调用重试
    return result
  }

  /** LRU 淘汰：关掉最久未用的项目库，防止长跑进程句柄无限增长。 */
  function evictProjects(): void {
    while (projects.size > maxOpenProjects) {
      const oldest = projects.keys().next().value
      if (oldest === undefined) break
      const victim = projects.get(oldest)
      projects.delete(oldest)
      projectFailures.delete(oldest)
      logger.warn(`OMB：项目库缓存超过上限 ${maxOpenProjects}，淘汰并关闭 ${oldest}`)
      void Promise.resolve(victim)
        .then(set => set?.close())
        .catch(NOOP)
    }
  }

  async function ensureProject(cwd: string): Promise<StoreSet | undefined> {
    if (closing) return undefined
    if (typeof cwd !== 'string' || cwd.length === 0) {
      unexpectedFailure = '项目库需要一个非空 cwd'
      return undefined
    }
    const key = projectIdentity(cwd)

    const opened = projects.get(key)
    if (opened !== undefined) {
      projects.delete(key)
      projects.set(key, opened) // LRU 触碰
      return opened
    }
    const inflight = pendingProjects.get(key)
    if (inflight !== undefined) return await inflight

    const user = await ensureUser()
    if (user === undefined) return undefined
    const hostPort = port()
    if (hostPort === undefined) return undefined
    if (userStore === undefined) return undefined

    const task = (async (): Promise<StoreSet | undefined> => {
      try {
        const store = openMemoryStore({
          scope: 'project',
          dbPath: projectDbPathFor(key),
          port: hostPort,
          logger,
          clock: options.clock,
        })
        if (closing) {
          await store.close()
          return undefined
        }
        projectFailures.delete(key)
        return projectSet(key, store)
      } catch (error) {
        recordProjectFailure(key, `项目库打开失败（${key}）：${messageOf(error)}`)
        return undefined
      }
    })()

    pendingProjects.set(key, task)
    let set: StoreSet | undefined
    try {
      set = await task
    } finally {
      pendingProjects.delete(key)
    }
    if (set === undefined) return undefined
    projects.set(key, set)
    evictProjects()
    return set
  }

  /**
   * 关闭全部库。**绝不抛异常**（热插拔 H-1）。
   *
   * 定义为闭包而不是对象方法：`close`/`dispose` 会被解构后单独传递，
   * 那时 `this` 不再指向服务对象。
   */
  const closeService = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true
      const openSets = [...projects.values()]
      projects.clear()
      const inflight = [...pendingProjects.values()]
      const settled = await Promise.all(inflight.map(task => task.then(set => set, () => undefined)))
      for (const set of [...openSets, ...settled]) {
        if (set === undefined) continue
        try {
          await set.close()
        } catch (error) {
          logger.warn(`OMB：关闭项目库失败（已隔离）——${messageOf(error)}`)
        }
      }
      if (userSet !== undefined) {
        try {
          await userSet.close()
        } catch (error) {
          logger.warn(`OMB：关闭用户库失败（已隔离）——${messageOf(error)}`)
        }
      }
      userSet = undefined
      userStore = undefined
      userPromise = undefined
      cwdBySession.clear()
    })()
    return closePromise
  }

  return {
    config,

    async start(): Promise<void> {
      try {
        await ensureUser()
      } catch (error) {
        // 预热失败绝不能冒泡到 apply 的 fire-and-forget 链（会变成 unhandled rejection）
        unexpectedFailure = `预热失败：${messageOf(error)}`
        logger.warn(`OMB 记忆库：${unexpectedFailure}`)
      }
    },

    status() {
      const openProjects = [...projects.keys()]
      const parts: string[] = []
      if (closing) parts.push('已关闭')
      const userPath = resolvedPort?.userDbPath ?? '（宿主端口未注入）'
      if (userSet === undefined) {
        parts.push(`用户库未打开：${userFailure ?? userPath}`)
      } else {
        parts.push(`用户库=${resolvedPort?.userDbPath ?? userPath}（迁移 v${userSet.migrated[0]?.from ?? 0}→v${userSet.migrated[0]?.to ?? 0}）`)
      }
      parts.push(`项目库 ${openProjects.length}/${maxOpenProjects} 已打开${openProjects.length === 0 ? '' : `：${openProjects.join('、')}`}`)
      if (projectFailures.size > 0) {
        parts.push(
          `项目库失败 ${projectFailures.size} 个：${[...projectFailures]
            .map(([key, reason]) => `${key}（${reason}）`)
            .join('；')}`,
        )
      }
      if (unexpectedFailure !== undefined) parts.push(`意外失败：${unexpectedFailure}`)
      parts.push(`会话→cwd 映射 ${cwdBySession.size} 条`)
      return { ready: !closing && userSet !== undefined, detail: parts.join('；'), openProjects }
    },

    async forSession(sessionId: string): Promise<StoreSet | undefined> {
      try {
        const user = await ensureUser()
        if (user === undefined) return undefined
        const cwd = cwdBySession.get(sessionId)
        // 宿主尚未告知 cwd：降级为"仅用户库"，projectScope=null 是给调用方的显式信号
        if (cwd === undefined) return user
        const project = await ensureProject(cwd)
        return project ?? user
      } catch (error) {
        unexpectedFailure = `会话 ${sessionId} 取库失败：${messageOf(error)}`
        logger.warn(`OMB 记忆库：${unexpectedFailure}`)
        return undefined
      }
    },

    async forProject(cwd: string): Promise<StoreSet | undefined> {
      try {
        return await ensureProject(cwd)
      } catch (error) {
        unexpectedFailure = `项目 ${cwd} 取库失败：${messageOf(error)}`
        logger.warn(`OMB 记忆库：${unexpectedFailure}`)
        return undefined
      }
    },

    rememberCwd(sessionId: string, cwd: string): void {
      if (closing) return
      if (sessionId.length === 0 || cwd.length === 0) return
      // 只记映射，不打开库：会话很多而项目很少，预热会浪费句柄
      cwdBySession.set(sessionId, cwd)
    },

    snapshot() {
      return { user: userSet, projects: [...projects.values()] }
    },

    failure(): string | undefined {
      if (userFailure !== undefined) return userFailure
      if (unexpectedFailure !== undefined) return unexpectedFailure
      const first = projectFailures.entries().next()
      return first.done === true ? undefined : first.value[1]
    },

    close: closeService,

    dispose: closeService,
  }
}
