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
import { dirname, isAbsolute, join } from 'node:path'
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
  VectorAttribution,
  VectorQuery,
} from '../../kernel/abi/index.js'
import { ASSERTED_BY, EDGE_TYPES, MEMORY_KINDS } from '../../kernel/abi/index.js'
import { blobToVector, cosineSimilarity, vectorToBlob } from './embed.js'
import {
  DATA_DIR_NAME,
  MEMORY_DIR_NAME,
  PROJECT_DB_FILE,
  ensureMemoryDirs,
  projectIdentity,
  type MemoryPaths,
} from './paths.js'
import {
  migrate,
  readUserVersion,
  SchemaVersionAheadError,
} from './migrate.js'
import type { OverturnedHit, OverturnedProbe, OverturnedQuery } from './overturned.js'
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

/** 一条可归属的向量。四个归属标签必须齐备；`contentHash` 见下。 */
export interface EmbeddingVector {
  readonly memoryId: string
  /** 嵌入器稳定标识，如 `hash-bow-256` / `bge-small-zh-v1.5-512`。 */
  readonly modelId: string
  /** 维度；必须与 `vector.length` 一致，且 > 0。 */
  readonly dim: number
  /** 模型修订号；换模型时用于判定哪些向量已陈旧。 */
  readonly revision: string
  readonly vector: Float32Array
  /**
   * 这条向量编码的是**哪一份正文**（`contentHashOf(text)`，见 `remember.ts`）。
   *
   * 为什么归属标签之外还需要它：`model_id`/`dim`/`revision` 只说"谁来编码"，
   * 不说"编码的是哪份正文"。正文被改写而嵌入器没换时，归属判定看不见任何变化——
   * 旧向量会一直参与检索（检索结果莫名其妙，且不报错）。这一列就是那个缺陷的判据。
   *
   * **可缺省**：缺省时库自己按 `memory` 表里这条记忆的正文算（那是权威来源）；
   * 记忆不存在（孤儿行）且这里也没给 → 该行 hash 为 NULL，判定侧按"未知 → 需要重建"处理。
   * 不强制要求是为了不改变既有调用方的签名——但生产路径（`vector.ts`）总会给出，
   * 值来自它刚刚水合到的那份正文。
   */
  readonly contentHash?: string
}

/**
 * 待重建条数，**按原因拆开**（`vector.ts` 的状态面/健康面据此区分两类待办）。
 *
 * 为什么不是两个独立方法：两类待办的判定共用**同一次全表统计**（`COUNT_STALE_SQL`
 * 一条 SQL 里两个求和项），拆成两次调用就是把这个代价付两遍。
 */
export interface StaleEmbeddingCounts {
  /**
   * 当前身份（`model_id`/`dim`/`revision`）下**没有**向量的记忆条数
   * ——换嵌入器之后的存量失效（缺陷 A）。
   */
  readonly lackingIdentity: number
  /**
   * 有当前身份的行、但行的 `content_hash` 与**此刻的正文**不符（含 NULL = 未知）的记忆条数
   * ——正文被改写而向量没跟上（缺陷 B）。
   */
  readonly contentChanged: number
  /** 待重建总数。恒等于 `lackingIdentity + contentChanged`（两类互斥且穷尽）。 */
  readonly total: number
}


/** `meta` 表记录的当前嵌入器身份（与 ABI 的 `VectorAttribution` 同构，直接复用）。 */
export type EmbeddingMeta = VectorAttribution

/** 「待重建」列表的分页参数（键集分页，见 `VectorStoreApi.listStaleEmbeddingIds`）。 */
export interface StaleEmbeddingPage {
  /** 游标：只取 `memory_id > afterId` 的行。缺省 = 从头开始（空串等价于"从头"）。 */
  readonly afterId?: string
  /** 本页至多几条。缺省 = 不限（调用方**必须**给上界，否则就是把整个库拉进内存）。 */
  readonly limit?: number
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
  /**
   * **待重建**条数：向量通道对这条记忆**恒返回空或返回过时向量**的规模。
   *
   * 两种情形都算（见 `STALE_WHERE_SQL`）：① 当前身份下没有向量行 ② 有行但 `content_hash`
   * 与此刻正文不符（含 NULL = 未知）。为什么不是"有多少行不属于当前身份"——同一处有说明。
   *
   * 只要总数、不看原因时用它；要区分两类待办用 `countStaleEmbeddingsByCause`。
   */
  countStaleEmbeddings(current: EmbeddingMeta): Promise<number>
  /**
   * 同 `countStaleEmbeddings`，但**按原因拆开**（换嵌入器 vs 正文被改写）。
   *
   * 为什么必须有：两类待办的可行动结论不同——前者等回填跑完即可，后者说明**有人改写了记忆**，
   * 而"检索结果莫名其妙"的现场必须能区分这两件事（本仓库的规矩：降级必须可读）。
   * 一次查询同时给出两个数（`COUNT_STALE_SQL`），不额外增加全表统计的次数。
   */
  countStaleEmbeddingsByCause(current: EmbeddingMeta): Promise<StaleEmbeddingCounts>
  /**
   * 列出待重建的 `memory_id`（判定同 `countStaleEmbeddings`），按 `memory_id` 升序分页。
   *
   * **只取 id**：重建的输入是记忆**正文**（下一次冲刷时按 id 批量水合），旧向量对重建毫无用处——
   * 把 BLOB 读进内存只会让"一次把整个库拉进内存"成为可能。
   * 键集分页（`afterId`）而不是 `OFFSET`：游标前进时 OFFSET 会随集合缩小而**漏行**，
   * 而回填正好会让集合在扫描过程中不断缩小。
   */
  listStaleEmbeddingIds(
    current: EmbeddingMeta,
    page?: StaleEmbeddingPage,
  ): Promise<readonly string[]>
  /**
   * 清掉**没有正文**的残留向量行（孤儿行），返回删除行数。
   *
   * 用途只有一个：正文已不存在（`forget` 中途崩掉）时那些行的确没有消费者——
   * `searchVector` 要 JOIN `memory`，它们永远召不回来。回填的"回收残留"读数据它计数。
   * 与"旧身份的行一律保留"不矛盾：保留的前提是**正文还在**（换回原嵌入器仍可用）。
   */
  deleteOrphanEmbeddings(): Promise<number>
  countEmbeddings(): Promise<number>
  /** 当前嵌入器身份；未声明返回 null（此时任何向量都不可归属）。 */
  embeddingMeta(): Promise<EmbeddingMeta | null>
  /** 声明/切换当前嵌入器。已有向量随之成为"陈旧"（可查询、可重建，但不再被使用）。 */
  setEmbeddingMeta(meta: EmbeddingMeta): Promise<void>
  /**
   * 回收若干条记忆里**已经不用的**向量行。判据与"待重建"**同一个**谓词，因此只会删两种行：
   * ① 不属于当前身份的行（换嵌入器后的旧向量）；② 当前身份但正文已被改写（或 hash 未知）的行。
   * **仍然可用的行一律不动**（列出待重建与执行删除之间隔着若干次 await，中间可能有别的写入落盘）。
   *
   * 用途只有一个：这些行的确没有消费者（正文已不存在 / 正文已改写），
   * 而它们会让"待重建"永远数得出来、每轮扫描重复列出同一条 id。
   * 与"陈旧向量一律保留"不矛盾：保留的前提是**这行在某个身份下仍然对应当前正文**。
   * @returns 实际删除的行数
   */
  deleteStaleEmbeddings(ids: readonly string[], current: EmbeddingMeta): Promise<number>
}

/**
 * 具体实现类型。除端口外还暴露状态面需要的诊断字段，以及两个**结构面**能力
 * （`UsageApi` 的使用计数、`RecordScanApi` 的整合扫描）——它们不进 ABI，
 * 由 `asUsageStore` / `asRecordScanner` 按能力探测（模式同 `asVectorStore`）。
 */
export interface SqliteMemoryStore extends MemoryStore, VectorStoreApi, OverturnedProbe, UsageApi, RecordScanApi {
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

/**
 * **使用计数面**（结构探测，不进 ABI）。
 *
 * 为什么不进 `kernel/abi/ports.ts`：那是一个冻结契约，而这里只需要"能不能记账"这一个能力；
 * 向量面（`asVectorStore`）已经确立了同一条模式——**按能力探测，探测不到就降级**
 * （`markUsed` 落不成的库不影响召回本身）。ABI 上的 `use_count`/`last_used_at` 语义不变。
 */
export interface UsageApi {
  /** 见 `SqliteStore.markUsed`：被注入使用的行 `use_count+1`、`last_used_at = at`。 */
  markUsed(ids: readonly string[], at: number): Promise<number>
}

/** 从端口句柄取使用计数面；不是本实现返回 undefined（调用方跳过记账，不抛）。 */
export function asUsageStore(store: MemoryStore): UsageApi | undefined {
  return store instanceof SqliteStore ? store : undefined
}

/**
 * **整合扫描面**（结构探测，不进 ABI）：能按时间倒序读回最近的记录。
 *
 * 与 `UsageApi` 同一条理由：`MemoryStore`（ABI）里没有"列出记录"的能力，
 * 而离线整合需要一个输入端。探测不到就**跳过这个库**并如实计入问题，
 * 而不是让整合悄悄什么都不做（那正是 M3"只在测试里存在"的形态）。
 */
export interface RecordScanApi {
  /** 见 `SqliteStore.listRecentRecords`。 */
  listRecentRecords(input: { readonly limit: number }): Promise<readonly MemoryRecord[]>
}

/** 从端口句柄取整合扫描面；不是本实现返回 undefined。 */
export function asRecordScanner(store: MemoryStore): RecordScanApi | undefined {
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
INSERT INTO embedding (memory_id, model_id, dim, revision, vector, content_hash) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(memory_id, model_id, revision) DO UPDATE SET
  dim = excluded.dim, vector = excluded.vector, content_hash = excluded.content_hash`

/**
 * SQL 字面量（单引号转义）。`node:sqlite` 的位置参数在 **LEFT JOIN + 游标** 这个形状上
 * 有实测缺陷（见 `staleSql` 的说明），因此身份三元组以字面量内联；内联必须先过这里。
 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 「待重建」的全部 SQL 片段。**身份三元组以字面量内联，只有游标/上限仍是绑定参数。**
 *
 * ## 为什么不能把身份也当绑定参数（实测，不是偏好）
 *
 * 本站最初用的是位置参数版：
 * ```
 * ... LEFT JOIN embedding cur ON cur.memory_id = m.id AND cur.model_id = ? AND cur.dim = ?
 *      AND cur.revision = ? AND cur.content_hash IS NOT NULL AND cur.content_hash = m.content_hash
 *     WHERE m.id > ? AND cur.memory_id IS NULL ORDER BY m.id LIMIT ?
 * ```
 * 在 `node:sqlite` 上实测：**游标参数被静默忽略**——`afterId` 从 `''` 换成 `'m2'`、`'m3'`，
 * 返回永远是第一页 `[m1, m2]`。后果不是报错，而是回填**每一轮都把同一批记忆重新编码一次**
 * （`rebuild.rebuilt` 比库里的条数还多），且永远扫不到表尾。
 * 对照实验（同一台机器、同一个 SQLite）：
 * - 位置参数 + `NOT EXISTS (...)` 相关子查询：游标生效；
 * - 位置参数 + LEFT JOIN：游标失效；
 * - **命名参数 + LEFT JOIN：正确**；
 * - **身份内联为字面量 + 位置参数游标：正确**。
 *
 * 端口签名（`SqliteStatementLike`）只接受位置参数，全仓的绑定约定也是位置参数，
 * 所以这里选"把身份内联、把游标留给绑定参数"这条既稳定又不改 ABI 的路。
 * 内联的安全性由调用方保证：三个值都先过 `vetEmbeddingMeta`（非空文本 / 正整数维度），
 * 文本再过 {@link sqlLiteral} 转义——没有拼接用户数据进 SQL 的口子。
 *
 * ## 判定的语义
 *
 * `cur` = "在当前身份下**仍然可用**的那一行"：归属标签全等、`content_hash` 非空、
 * 且与 `memory` 里此刻的 `content_hash` 相等。三个条件缺一不可：
 * - 内容不符 = 正文被改写而向量没跟上（缺陷 B）；SQL 里 `NULL = m.content_hash` 求值为 NULL
 *   （不是假），若不明写 `IS NOT NULL`，三值逻辑会把"未知"放进"可用"那一侧
 *   ——**静默的错误方向**，比多重建一次贵得多；
 * - 归属不符 = 换嵌入器之后的存量失效（缺陷 A）。
 *
 * `STALE_WHERE_SQL`（`cur.memory_id IS NULL`）就是"没有这样一行"。
 * 判定只出现一次、没有嵌套 EXISTS，因此"缺行"与"有行但内容不符"互斥且穷尽。
 * `cur` 侧走主键 `(memory_id, model_id, revision)`（v1 建表，WITHOUT ROWID = 聚簇键）一次定位，
 * 选中列里没有 `vector`，**不读 BLOB**。
 */
function staleSql(current: EmbeddingMeta): {
  readonly join: string
  readonly count: string
  readonly list: string
} {
  const model = sqlLiteral(current.modelId)
  const revision = sqlLiteral(current.revision)
  const join = `LEFT JOIN embedding cur
       ON cur.memory_id = m.id
      AND cur.model_id = ${model}
      AND cur.dim = ${current.dim}
      AND cur.revision = ${revision}
      AND cur.content_hash IS NOT NULL
      AND cur.content_hash = m.content_hash`
  /** 「当前身份下有行吗」（不看内容）——只用于把待重建分成两类。 */
  const hasIdentityRow = `EXISTS (
      SELECT 1 FROM embedding idr
       WHERE idr.memory_id = m.id
         AND idr.model_id = ${model}
         AND idr.dim = ${current.dim}
         AND idr.revision = ${revision}
    )`
  return {
    join,
    // 两类按同一次扫描的每一行二选一（`缺行` / `有行`），互斥且穷尽，因此还有一个
    // `count(DISTINCT m.id)` 作为总数——它与两个分量相加一致，且万一判定式将来改了也不会说谎。
    count: `SELECT
      count(DISTINCT CASE WHEN NOT (${hasIdentityRow}) THEN m.id END) AS lacking_identity,
      count(DISTINCT CASE WHEN ${hasIdentityRow} THEN m.id END) AS content_changed,
      count(DISTINCT m.id) AS total
    FROM memory m
    ${join}
   WHERE cur.memory_id IS NULL`,
    // 键集分页（游标 + 上限是**仅有的**两个绑定参数）：`OFFSET` 会在集合缩小（回填会让它缩小）
    // 时漏行，而这里不回退。
    list: `SELECT DISTINCT m.id AS memory_id FROM memory m
    ${join}
  WHERE m.id > ? AND cur.memory_id IS NULL
  ORDER BY m.id ASC LIMIT ?`,
  }
}

/**
 * 回收：删掉这些记忆里**已经不用的**向量行。
 *
 * ## 判据（与"待重建"同一个谓词的可用侧）
 *
 * 只删**当前身份、但正文已被改写（或哈希未知）**的那一行。两条边界是刻意的：
 *
 * - **不属于当前身份的行一律不删**（换嵌入器后的旧向量）：它们是"换回原嵌入器"的退路
 *   （`setEmbeddingMeta` 的既有承诺），而且回填的记账已经把那条记忆算作"有当前身份的行"，
 *   删掉它会让"待重建"重新算一遍、把同一批重编码两次。
 * - **正文已不存在的孤儿行也不在这里删**：它们由回填的"回收残留"通路按 id 处理
 *   （`vector.ts` 的 `markGone` → `deleteStaleEmbeddings`，那时 `m` 已不存在、下面的
 *   `NOT EXISTS` 为真）。由那条通路删除会**同时留下一个可读的计数**；在这里顺手删掉，
 *   `rebuild.scavenged` 就永远是 0 —— 把一件发生过的事说成没发生过。
 *
 * 因此正文已改写的行由"下一次回填"清账，孤儿行由"残留回收"清账，两条路各有各的读数。
 *
 * 身份同样**内联为字面量**（理由见 `staleSql`）：这样仅有的绑定参数就是 id 列表本身，
 * 而 id 必须留在绑定参数里（数量可变、且来自库内数据）。
 */
function deleteStaleSql(ids: readonly string[], current: EmbeddingMeta): string {
  const placeholders = ids.map(() => '?').join(', ')
  return `DELETE FROM embedding
  WHERE memory_id IN (${placeholders})
    AND model_id = ${sqlLiteral(current.modelId)}
    AND dim = ${current.dim}
    AND revision = ${sqlLiteral(current.revision)}
    AND NOT EXISTS (
      SELECT 1 FROM memory m
       WHERE m.id = embedding.memory_id
         AND embedding.content_hash IS NOT NULL
         AND embedding.content_hash = m.content_hash
    )`
}

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
 * 迁移结果的**如实**文案。
 *
 * 为什么不能省事写成 `v${from}→v${to}`：没有迁移记录时那是 `v0→v0`，
 * 读起来像"库版本是 v0"——而 v0 是"未知/未打开"，不是版本号。
 * 只有**测到**的迁移才写迁移；测不到就写"未记录（版本未知）"。
 * （约束：没测到 ≠ 测到 0。`0` 只能表示"测到了，值就是 0"。）
 */
function migrationText(entry: { readonly from: number; readonly to: number } | undefined): string {
  if (entry === undefined) return '（迁移记录缺失：schema 版本未知）'
  if (entry.from === entry.to) return `（本次打开未迁移：schema v${entry.to}）`
  return `（迁移 v${entry.from}→v${entry.to}）`
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

/**
 * 嵌入器身份校验：返回拒绝原因，或 undefined 表示可用。
 *
 * 为什么**读取侧**（待重建计数/列表）也要校验，而不是只在写入侧校验：
 * 身份非法时 SQL 会安静地匹配不到任何行，于是"待重建 0 条"看起来像个测到的结论——
 * 那是拿假读数冒充测量结果（本仓库的硬规矩：未测量 ≠ 测量为零）。
 */
function vetEmbeddingMeta(meta: EmbeddingMeta): string | undefined {
  if (typeof meta.modelId !== 'string' || meta.modelId.trim().length === 0) return '缺少 model_id'
  if (!Number.isInteger(meta.dim) || meta.dim <= 0) return `维度非法（${String(meta.dim)}）`
  if (typeof meta.revision !== 'string' || meta.revision.trim().length === 0) return '缺少 revision'
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
  /**
   * 上一次 `forget` 的 WAL 截断是否失败。
   *
   * 隐私擦除的失败必须可见：行确实删了，但磁盘上可能仍有明文残留——
   * 那是两件事，回执不能把它们说成一件。
   */
  #checkpointFailed = false
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
      /**
       * **删完把明文从磁盘上彻底清掉。**两步，缺一不可：
       *
       * ## ① `secure_delete=ON`（连接建立时已开）
       * DELETE 当场覆写释放的字节区。所以**这一次**删除的文本从来没进过主库文件。
       *
       * ## ② 下面的 checkpoint + VACUUM
       * - `wal_checkpoint(TRUNCATE)`：把已提交页推进主库，并把 WAL 截回零长度。
       *   不做这步，明文就躺在 `<库>.db-wal` 里，`strings` 直接捞得出来（实测 6 处）。
       * - `VACUUM`：**重建整库文件**，只保留活数据，空闲页清零。
       *   它对付的是"加固之前就删掉的那些"——那些行的字节已经在旧文件里，
       *   `secure_delete` 管不到（它只在删除当下生效）。上一轮我只做了 checkpoint，
       *   所以那是妥协：明文从 WAL 挪进了主库空闲页，扫字节照样能捞。
       *
       * 两步都包在 try 里：**行已经删了**，清理失败不能把"已删除"变成"删除失败"；
       * 但必须置位让回执如实说"逻辑已删、磁盘残留未清干净"——
       * 隐私擦除的失败必须可见。
       */
      try {
        this.#run('PRAGMA wal_checkpoint(TRUNCATE)')
        this.#run('VACUUM')
        this.#run('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch (error) {
        this.#checkpointFailed = true
        this.#logger.warn(`OMB：隐私擦除的磁盘清理未完成（行已删除）——${messageOf(error)}`)
      }
      return removed
    })
  }

  /**
   * 被注入使用后的记账：`use_count += 1`、`last_used_at = at`。
   *
   * ## 为什么需要它（M5）
   *
   * `use_count` / `last_used_at` 有三个消费者，却长期**零个生产者**：
   * - `retrieve.ts` 的重排先验 `usage = useCount/(1+useCount)` 乘 `RERANK_WEIGHTS.usage = 0.12`；
   * - `consolidate.ts` 的 `decayPrior` usage 因子与"回响塌缩累加 useCount"。
   *
   * 而写入侧恒写 `useCount: 0`、`lastUsedAt: now` —— 于是 0.12 的权重永远是死分量，
   * "多久没被用过"永远等于"多久前写的"，且**没有任何读数能看出来**（典型的静默失效）。
   *
   * ## 只改这两列
   *
   * 正文、溯源、`valid_to`/`superseded_by` 一个字节都不动：它们不是"使用"，
   * 改了就是改写历史（本仓库的非破坏性口径）。也不动 FTS 索引（`text` 未变）。
   *
   * @returns 真正被更新的行数（id 不存在时不计；调用方据此判断是否"写了个寂寞"）
   */
  async markUsed(ids: readonly string[], at: number): Promise<number> {
    this.#assertUsable()
    const unique = [...new Set(ids)].filter(id => typeof id === 'string' && id.length > 0)
    if (unique.length === 0) return 0
    if (!Number.isInteger(at)) throw new Error(`OMB：使用时间必须是整数毫秒，收到 ${String(at)}`)
    return await this.#enqueue(() => {
      this.#assertOpen()
      let updated = 0
      // 参数是 `at` + N 个 id，所以按 MAX_SQL_VARS 的一半分块（与其它批量语句同一口径）
      for (const chunk of chunkArray(unique, Math.floor(MAX_SQL_VARS / 2))) {
        const placeholders = chunk.map(() => '?').join(', ')
        updated += this.#run(
          `UPDATE memory SET use_count = use_count + 1, last_used_at = ? WHERE id IN (${placeholders})`,
          [at, ...chunk],
        )
      }
      return updated
    })
  }

  /**
   * 上一次 `forget` 的 WAL 截断是否失败。
   *
   * 用途：`forget` 的回执要能如实说"逻辑已删，但磁盘残留未清干净"——
   * **隐私擦除的失败必须可见**，不能因为行删掉了就当整件事成功了。
   */
  checkpointAfterForgetFailed(): boolean {
    return this.#checkpointFailed
  }

  async putEmbedding(vector: EmbeddingVector): Promise<void> {
    this.#assertUsable()
    await this.#enqueue(() => {
      this.#assertOpen()
      const problem = validateVectorAttribution(vector)
      if (problem !== undefined) throw new VectorAttributionError(problem)

      const meta = this.#readEmbeddingMeta()
      if (meta === null) {
        // 首次写入即声明身份：向量与标签同生共死，不存在"无标签的向量"。
        // 若 meta 行缺失（库结构损坏），声明会写 0 行——此时必须拒绝写入，
        // 否则后续每条向量都会被当成"首次写入"而绕过归属校验。
        if (this.#writeEmbeddingMeta({ modelId: vector.modelId, dim: vector.dim, revision: vector.revision }) !== 1) {
          throw new VectorAttributionError(
            'meta 表缺失或为空——无法声明嵌入器身份，拒绝写入向量（库结构已损坏，请重建）',
          )
        }
      } else if (meta.modelId !== vector.modelId || meta.dim !== vector.dim) {
        throw new VectorAttributionError(
          `声明 ${vector.modelId}/${vector.dim} 与 meta 记录的当前嵌入器 ${meta.modelId}/${meta.dim} 不一致——` +
            `不同模型或维度的向量不可比，换模型请先 setEmbeddingMeta 并重建`,
        )
      }
      /**
       * **正文哈希必须有来源，且优先取调用方给的那份。**
       *
       * 调用方给的值来自它刚刚水合到的正文，是这条向量**真正编码的内容**——归属标签与内容标签
       * 必须描述同一份输入，否则标签就是错的。调用方没给时退回 `memory.content_hash`
       * （库里记着的当前正文哈希）。注意这里**只读那一列、不在本地重算**：不同调用方的哈希
       * 算法不同（`remember` 走 `contentHashOf` 64 位、画像文档走 `entries.fnv1a` 32 位），
       * 重算会在其中一部分上永远算不出相等——那是自己造出来的"清不掉的待办"。
       *
       * 两者都没有（这条 id 在库里没有正文，调用方也说不出正文哈希）→ 写 NULL。
       * 语义是**未知**，判定侧按"需要重建"处理（绝不当成"内容未变"）：
       * 这样的行下一次回填扫描会重新编码它，或者按残留行回收掉——不会永远挂着不动。
       */
      const stored = this.#storedContentHash(vector.memoryId)
      const hinted = typeof vector.contentHash === 'string' && vector.contentHash.length > 0 ? vector.contentHash : null
      const contentHash = hinted ?? stored
      // 两条路都拿不到（该 id 在库里没有记忆行）：写 NULL。**这条日志是必须的**——
      // 它同时说明"这次写入没有内容标签"与"为什么"，否则现场只能看到一个 NULL。
      if (contentHash === null) {
        this.#logger.debug(
          `OMB：向量落盘（${vector.memoryId}）没有内容哈希——库里没有这条记忆的正文，` +
            `调用方也没给 contentHash；该行按"未知"处理，下一次回填会重建或回收它`,
        )
      }

      this.#run(UPSERT_EMBEDDING_SQL, [
        vector.memoryId,
        vector.modelId,
        vector.dim,
        vector.revision,
        vectorToBlob(vector.vector),
        contentHash,
      ])
    })
  }

  async setEmbeddingMeta(meta: EmbeddingMeta): Promise<void> {
    this.#assertUsable()
    const problem = vetEmbeddingMeta(meta)
    if (problem !== undefined) throw new VectorAttributionError(problem)
    await this.#enqueue(() => {
      this.#assertOpen()
      const stale = this.#countStaleByCause(meta)
      if (this.#writeEmbeddingMeta(meta) !== 1) {
        throw new VectorAttributionError('meta 表缺失或为空——无法声明嵌入器身份（库结构已损坏，请重建）')
      }
      if (stale.total > 0) {
        // 两个原因分开写：`缺当前身份`是"换嵌入器"的直接后果（等回填即可），
        // `正文已改写`说明有人在改写正文而向量没跟上（要查是谁在改写）。
        this.#logger.info(
          `OMB：嵌入器切换为 ${meta.modelId}/${meta.dim}（rev ${meta.revision}）；` +
            `${stale.total} 条记忆的向量成为待重建（缺当前身份 ${stale.lackingIdentity} 条、` +
            `正文已改写 ${stale.contentChanged} 条 → 不参与检索；旧行保留，仍可查询与换回）`,
        )
      }
    })
  }

  /**
   * 待重建读数（**同步版**：`setEmbeddingMeta` 在自己的写操作里就地统计，
   * 不能借道异步公开方法——那会排到自己的队尾上，互相等死）。
   *
   * 两个原因分开报：切换身份后"原来是神经嵌入器、现在是哈希词袋"与
   * "正文被人改写过"是两件不同的事，日志里混成一个数字会让后者永远看不见。
   */
  #countStaleByCause(meta: EmbeddingMeta): StaleEmbeddingCounts {
    // **零绑定参数**：身份已经内联进 SQL（见 `staleSql` 的说明），游标/上限只属于列表查询。
    const row = this.#get(staleSql(meta).count)
    // `count()` 在零行时返回 0（不是 NULL）：`countOf` 把非数值记 0 也无歧义——
    // "没有任何记忆"确实是 0 条待重建；而查询本身成功返回了，不存在"没测到"。
    const lackingIdentity = countOf(row?.['lacking_identity'])
    const contentChanged = countOf(row?.['content_changed'])
    // 总数用 SQL 自己的 `count(DISTINCT m.id)`，而不是两个分量相加：
    // 相加只在"两类互斥且穷尽"成立时才对，而那是判定式的性质；直接用 SQL 的那个数
    // 让"读数与查询"保持一致（万一将来判定式改了，这里也不会悄悄给出一个错的合计）。
    const total = countOf(row?.['total'])
    return { lackingIdentity, contentChanged, total: total > 0 ? total : lackingIdentity + contentChanged }
  }

  /**
   * 一条记忆**库里记着**的正文哈希；记忆不存在 → null（孤儿行，无从谈起"内容是否已变"）。
   *
   * 只读那一列、不在本地重算：库里的 `content_hash` 混有不同调用方的不同哈希算法
   * （`contentHashOf` 64 位 / `entries.fnv1a` 32 位），重算会在其中一部分上永远算不出相等。
   * 判定侧比的是"两列相等"，所以这里也必须**照抄那一列**。
   */
  #storedContentHash(memoryId: string): string | null {
    const row = this.#get('SELECT content_hash FROM memory WHERE id = ?', [memoryId])
    if (row === undefined) return null
    const stored = row['content_hash']
    return typeof stored === 'string' && stored.length > 0 ? stored : null
  }

  /**
   * 回收若干条记忆里**已经不用的**向量行。
   *
   * 判据是"待重建"的**同一个**谓词（`DELETE_STALE_SQL`，与 `STALE_WHERE_SQL` 一致）：
   * 不属于当前身份的行，或当前身份但正文已被改写（hash 未知/不符）的行。
   * **绝不按 id 全删**——列出待重建与执行删除之间隔着若干次 await，中间可能有别的写入落盘，
   * 按 id 全删会顺手删掉一条刚写好的、当前正文的向量。
   */
  async deleteStaleEmbeddings(ids: readonly string[], current: EmbeddingMeta): Promise<number> {
    this.#assertUsable()
    const problem = vetEmbeddingMeta(current)
    if (problem !== undefined) throw new VectorAttributionError(problem)
    const unique = [...new Set(ids)].filter(id => typeof id === 'string' && id.length > 0)
    if (unique.length === 0) return 0
    return await this.#enqueue(() => {
      this.#assertOpen()
      let removed = 0
      for (const chunk of chunkArray(unique, MAX_SQL_VARS)) {
        // 仅有的绑定参数就是这一块的 id 列表（身份已内联，见 `deleteStaleSql`）
        removed += this.#run(deleteStaleSql(chunk, current), chunk)
      }
      return removed
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
   * 按 `observed_at` 倒序取**最近**的一批记录（离线整合的输入端；结构探测，不进 ABI）。
   *
   * 为什么有界、为什么倒序：整合要找的是"最近写下的痕迹里的重复与矛盾"，
   * 而全表读会在长跑宿主上变成一次几十 MB 的物化（`memory.text` 是变长文本）。
   * 有界读让每次运行的代价与库大小无关；倒序保证窗口里装的是刚发生的痕迹
   * （回响天然在时间上相邻：同一条错事被同一会话在相邻回合里重复写下）。
   *
   * @param input.limit 条数上界；调用方给上界（缺省/非法值按 `0` 处理，即不读）
   */
  async listRecentRecords(input: { readonly limit: number }): Promise<readonly MemoryRecord[]> {
    this.#assertUsable()
    const limit = Number.isFinite(input.limit) ? Math.max(0, Math.floor(input.limit)) : 0
    if (limit === 0) return []
    const rows = this.#all(
      `SELECT ${RECORD_COLUMNS} FROM memory ORDER BY observed_at DESC, id DESC LIMIT ?`,
      [limit],
    )
    return rows.map(row => toRecord(row))
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

  /**
   * 过时结论探测（非 ABI 面，契约见 `overturned.ts`）。
   *
   * **只读**，且与 `searchLexical` 查的是同一个 FTS 索引，只是**不排除**过时行：
   * 它回答"这条查询匹配到哪些已经不算数的条目、被谁取代了"，好让召回侧如实说出
   * "有过结论、已被推翻"，而不是报一个含义相反的"零命中"。
   * 返回结果绝不进注入列表（注入过滤仍在检索侧）。
   */
  async searchOverturned(query: OverturnedQuery): Promise<readonly OverturnedHit[]> {
    this.#assertUsable()
    if (query.scope !== this.scope) return [] // 与 searchLexical 同一口径：读错库返回空，不抛
    const limit = Number.isFinite(query.limit) ? Math.max(0, Math.floor(query.limit)) : 0
    if (limit === 0) return []

    const expression = ftsMatchExpr(tokenizeForFts(query.text))
    if (expression.trim().length === 0) return []

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
      `SELECT m.id AS id, m.valid_to AS valid_to, m.superseded_by AS superseded_by
         FROM memory_fts
         JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
          AND m.scope = ?
          AND (m.valid_to IS NOT NULL OR m.superseded_by IS NOT NULL)${kindClause}
        ORDER BY -bm25(memory_fts) DESC, m.observed_at DESC, m.id ASC
        LIMIT ?`,
      params,
    )
    return rows.map(row => {
      const r = asRow(row, '过时条目')
      return {
        id: textOf(r['id'], 'id'),
        supersededBy: nullableTextOf(r['superseded_by'], 'superseded_by'),
        validTo: nullableIntegerOf(r['valid_to'], 'valid_to'),
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
        `SELECT memory_id, model_id, dim, revision, vector, content_hash FROM embedding WHERE memory_id IN (${placeholders})`,
        chunk,
      )) {
        const embedding = this.#toEmbedding(row)
        if (embedding !== null) result.push(embedding)
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
      `SELECT memory_id, model_id, dim, revision, vector, content_hash FROM embedding${
        clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      }${limit}`,
      params,
    )
    const result: EmbeddingVector[] = []
    for (const row of rows) {
      const embedding = this.#toEmbedding(row)
      if (embedding !== null) result.push(embedding)
    }
    return result
  }

  /**
   * 待重建条数。**不读 BLOB**：回填只需要知道"有多少条记忆的向量不可用"。
   *
   * 与 `setEmbeddingMeta` 的日志读数同一口径（同一个谓词），
   * 因此"切换时报了 N 条"与"回填扫描看到 N 条"必然一致——两处口径漂移过一次就很难再信。
   */
  async countStaleEmbeddings(current: EmbeddingMeta): Promise<number> {
    return (await this.countStaleEmbeddingsByCause(current)).total
  }

  /** 待重建条数 + 两个原因（同上，一次全表统计）。 */
  async countStaleEmbeddingsByCause(current: EmbeddingMeta): Promise<StaleEmbeddingCounts> {
    this.#assertUsable()
    const problem = vetEmbeddingMeta(current)
    if (problem !== undefined) throw new VectorAttributionError(problem)
    return this.#countStaleByCause(current)
  }

  async listStaleEmbeddingIds(
    current: EmbeddingMeta,
    page: StaleEmbeddingPage = {},
  ): Promise<readonly string[]> {
    this.#assertUsable()
    const problem = vetEmbeddingMeta(current)
    if (problem !== undefined) throw new VectorAttributionError(problem)
    const afterId = typeof page.afterId === 'string' ? page.afterId : ''
    // 缺省"不限"是给诊断用的；回填侧**必须**给上界（否则一次扫描就把整个库的 id 拉进内存）
    const limit =
      page.limit === undefined
        ? -1
        : Number.isFinite(page.limit)
          ? Math.max(0, Math.floor(page.limit))
          : 0
    // 仅有的两个绑定参数：游标 → limit（身份已内联，见 `staleSql`）
    const rows = this.#all(staleSql(current).list, [afterId, limit])
    return rows.map(row => textOf(asRow(row, '待重建行')['memory_id'], 'memory_id'))
  }

  /**
   * 向量检索（ABI `MemoryStore.searchVector`）。
   *
   * 分工：**本方法负责存取、归属过滤（下推到 SQL）与余弦打分**；
   * 跨通道排名与融合是 `retrieve.ts` 的职责（§5.4 的 RRF），这里不做。
   *
   * 为什么归属过滤必须在 SQL 里：否则要把整表读进 JS 再逐行比对——
   * 那正是旧实现"读全部向量再打分"的性能缺陷，也让"混进别的向量空间"有机可乘。
   *
   * 与 `searchLexical` 一致：`valid_to` / `superseded_by` 非空的记忆不参与（精度优先）。
   * 库内没有匹配归属的向量行 → 空数组（**无向量是合法状态，不是错误**）。
   */
  async searchVector(query: VectorQuery): Promise<readonly ScoredHit[]> {
    this.#assertUsable()
    const limit = Number.isFinite(query.limit) ? Math.max(0, Math.floor(query.limit)) : 0
    if (limit === 0) return []

    const expect = query.expect
    if (
      typeof expect?.modelId !== 'string' ||
      expect.modelId.trim().length === 0 ||
      !Number.isInteger(expect.dim) ||
      expect.dim <= 0 ||
      typeof expect.revision !== 'string' ||
      expect.revision.trim().length === 0
    ) {
      throw new VectorAttributionError('向量检索缺少完整归属标签（modelId/dim/revision）')
    }
    if (!(query.embedding instanceof Float32Array) || query.embedding.length !== expect.dim) {
      throw new VectorAttributionError(
        `查询向量与声明维度不符：期望 ${expect.dim} 维，实际 ${
          query.embedding instanceof Float32Array ? query.embedding.length : typeof query.embedding
        }`,
      )
    }

    const kinds = query.kinds === undefined ? [] : [...new Set(query.kinds)]
    for (const kind of kinds) enumOf(kind, MEMORY_KINDS, 'kinds')

    const params: unknown[] = [expect.modelId, expect.dim, expect.revision, this.scope]
    let kindClause = ''
    if (kinds.length > 0) {
      kindClause = ` AND m.kind IN (${kinds.map(() => '?').join(', ')})`
      params.push(...kinds)
    }

    const rows = this.#all(
      `SELECT e.memory_id AS id, e.vector AS vector
         FROM embedding e
         JOIN memory m ON m.id = e.memory_id
        WHERE e.model_id = ?
          AND e.dim = ?
          AND e.revision = ?
          AND m.scope = ?
          AND m.valid_to IS NULL
          AND m.superseded_by IS NULL${kindClause}`,
      params,
    )

    // minScore 未给 → 不过滤（下限的标定属调用方责任）
    const minScore =
      typeof query.minScore === 'number' && Number.isFinite(query.minScore) ? query.minScore : undefined
    const hits: ScoredHit[] = []
    let unusable = 0
    for (const row of rows) {
      const r = asRow(row, '向量候选')
      const vector = blobToVector(r['vector'])
      // 解码失败或长度不等于声明维度 → 不可比，跳过（写入口已拒绝，这里防的是历史损坏）
      if (vector === null || vector.length !== expect.dim) {
        unusable++
        continue
      }
      const score = cosineSimilarity(query.embedding, vector)
      if (!Number.isFinite(score)) {
        unusable++
        continue
      }
      if (minScore !== undefined && score < minScore) continue
      hits.push({ id: textOf(r['id'], 'id'), score, channel: 'vector' })
    }
    if (unusable > 0) {
      // 诚实降级：跳过不是静默——计数与原因都要看得见
      this.#logger.warn(
        `OMB：向量检索跳过 ${unusable} 条不可用向量（损坏或维度不符）；解码失败计数见 embed.ts 的读数`,
      )
    }
    // 分数降序；同分按 id 升序，使同一输入下返回顺序确定（排名可复现）
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return hits.slice(0, limit)
  }

  /**
   * 清掉**没有正文**的残留向量行（孤儿行），返回删除行数。
   *
   * 为什么单独一个方法（而不是靠"待重建"把 id 列出来）：本次把判定改成**以 `memory` 为外层**
   * 之后，孤儿行（正文已被删、向量行还在，例如 `forget` 中途崩掉）在判定里**根本不可见**——
   * 没有正文就没有"待重建"可言。而它们确实是垃圾：`searchVector` 要 JOIN `memory`，
   * 所以这些行永远召不回来。
   *
   * 为什么不能顺手删掉所有"当前身份下用不到"的行：旧身份的行是"换回原嵌入器"的退路
   * （见 `deleteStaleEmbeddings` 的说明），只有**没有正文**这一条判据是无争议的垃圾定义。
   * 一条 SQL 走 `embedding` 主键，不读 BLOB。
   */
  async deleteOrphanEmbeddings(): Promise<number> {
    this.#assertUsable()
    return await this.#enqueue(() => {
      this.#assertOpen()
      return this.#run(`DELETE FROM embedding
         WHERE NOT EXISTS (SELECT 1 FROM memory m WHERE m.id = embedding.memory_id)`)
    })
  }

  async countEmbeddings(): Promise<number> {
    this.#assertUsable()
    return countOf(this.#get('SELECT COUNT(*) AS c FROM embedding')?.['c'])
  }

  #toEmbedding(row: unknown): EmbeddingVector | null {
    const r = asRow(row, 'embedding 行')
    const memoryId = textOf(r['memory_id'], 'memory_id')
    // 解码原语只有一份实现（`./embed.js`）：损坏 BLOB → null 并计数
    const vector = blobToVector(r['vector'])
    if (vector === null) return null
    // NULL（v2 迁移前的历史行）= 未知，如实报 null；**不要**在这里补一个哈希——
    // 读的一方无从知道这条向量编码的是哪份正文，替它断言就是编事实。
    const contentHash = nullableTextOf(r['content_hash'], 'content_hash')
    return {
      memoryId,
      modelId: textOf(r['model_id'], 'model_id'),
      dim: integerOf(r['dim'], 'dim'),
      revision: textOf(r['revision'], 'revision'),
      vector,
      ...(contentHash === null ? {} : { contentHash }),
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

  /** 写 `meta` 的嵌入器身份列。@returns 受影响行数（=1 表示成功；0 表示 meta 行缺失）。 */
  #writeEmbeddingMeta(meta: EmbeddingMeta): number {
    return this.#run('UPDATE meta SET embedding_model_id = ?, embedding_dim = ?, embedding_revision = ?', [
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

/**
 * 项目库路径 = `<cwd>/.omb/memory/session.db`（与 `paths.ts` 同一套常量，不重复拼字面量）。
 *
 * @throws 非绝对路径（与 `memoryPaths` 同一策略：拒绝静默采用进程 cwd）
 */
export function projectDbPathFor(cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`OMB：项目库路径需要绝对 cwd，收到 "${cwd}"（拒绝静默采用进程 cwd）`)
  }
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
  /**
   * **删除时覆写被释放的字节。**
   *
   * ## 为什么必须在这里开，而不是在 `forget` 里临时开
   *
   * `secure_delete` 控制 **DELETE 当下**是否把释放的字节区清零。它不是一个
   * "之后清理"的开关——事务已经提交、字节已经落盘之后，再开它没有意义。
   * 所以必须在**连接建立时**就是 ON，才能保证每一次删除都覆写。
   *
   * ## 实测背景
   *
   * 上一轮只做了 `wal_checkpoint(TRUNCATE)`，那**只是把明文从 WAL 挪走**：
   * 被删文本仍会随 checkpoint 进入主库文件的空闲页，逐字节扫描照样能捞出来。
   * 那是妥协方案，不是修复。
   *
   * `secure_delete=ON` 之后：
   * - `forget` 的 DELETE 当场覆写释放区 → **主库文件里从头到尾没有过明文**
   * - WAL 里那一份由 `forget` 末尾的 `TRUNCATE` 截掉
   * - 两者合起来才是"物理抹除"，而不是"查不到了"
   *
   * ## 代价与取舍
   *
   * 代价是**每次释放字节都要 memset**。对普通表它是 O(释放量)，对本库这种
   * 短文本记忆可忽略；真正值得在意的是它给所有写路径加了一点常数开销。
   * 隐私擦除的语义（"内容不再存在"）比这点开销重要，所以默认开。
   *
   * 失败不拒绝打开：某些 SQLite 构建可能不认这个 pragma，降级即可，
   * 但**必须留声**——静默失败会让"已抹除"变成一句无从核实的承诺。
   */
  try {
    db.exec('PRAGMA secure_delete = ON')
  } catch (error) {
    logger.warn(
      `OMB：无法启用 secure_delete（删除的字节将不被覆写，隐私擦除只保证"不可召回"）——${messageOf(error)}`,
    )
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
 *
 * ⚠️ **这里刻意不传步骤表**（`migrate()` 用缺省表 = `SCHEMA_MIGRATIONS`）：
 * "表最高版本 vs `kernel/abi` 的 `SCHEMA_VERSION`"那条**契约漂移自检只在缺省路径上跑**。
 * 本轮曾因常量落后于表（1 vs 2）而必须显式传表绕过——那等于把自检关掉，
 * 于是"迁移表与 ABI 不一致"这件事就再也没人喊了。常量已收口到 2（见 `migrate.ts` 的说明），
 * **照旧注释去做（显式传表）会重新关掉这条自检**，不要再改回去。
 */
export function openMemoryStore(options: OpenMemoryStoreOptions): SqliteMemoryStore {
  if (options.port.createDirs) ensureStoreDirs(options)
  const db = options.port.openDatabase(options.dbPath)
  try {
    configureConnection(db, options.logger)
    // **不显式传步骤表**：缺省表就是 `SCHEMA_MIGRATIONS`，而"表最高版本 vs
    // `kernel/abi` 的 `SCHEMA_VERSION`"那条漂移自检只在缺省路径上跑。
    // 本轮曾因常量落后于表（1 vs 2）而必须显式传表绕过——那等于把自检关掉，
    // 于是"迁移表与 ABI 不一致"这件事就再也没人喊了。常量已收口到 2。
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

/**
 * 打开失败后的重试节奏（毫秒）。
 *
 * 为什么需要：宿主的 `node:sqlite` 是**异步解析**的（`dsh/stores.ts` 的 `ensureSqlite()`），
 * 而模块的 `apply` 是同步的、开库必须在 `apply` 里发起——于是"首次打开"必然可能撞上
 * "sqlite 尚未解析"。一次时序竞态不该被固化成永久降级：这里按节奏重试，直到成功或预算耗尽。
 *
 * 首个延迟是 0（下一个宏任务就试）：异步解析通常只差一个动态 `import` 的时间。
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [0, 50, 150, 400, 1000]

/** 等待宿主"就绪回调"的上限：回调挂住时不能让开库无限期跟着挂。 */
export const DEFAULT_READY_WAIT_MS = 2000

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void }
  // 不阻止进程退出（宿主进程里长驻，测试里不留悬挂句柄）
  if (typeof candidate.unref === 'function') candidate.unref()
}

export interface StoresServiceOptions {
  readonly logger: Logger
  /** 注入时钟（内核 `kernel.clock`），传给每个库句柄。 */
  readonly clock: Clock
  /**
   * **隐私判定端口**（由 `omb-privacy` 提供，服务名 `SERVICES.privacy`）。
   *
   * 为什么是**惰性函数**而不是一次取好的对象：宿主按行加载模块，
   * `omb-privacy` 行可能在本行**之后**才挂载；一次取好会永久拿到 undefined，
   * 表现为"隐私模式设了但库照样被写"。惰性解析让顺序无关。
   *
   * 缺省（不注入）→ 一切不受限（模块被关掉 = 没有隐私模式，这是诚实的语义）。
   *
   * ⚠️ **这是隐私的强制点**：判定发生在**库访问边界**（每个读写方法入口），
   * 不在工具层、不在服务装饰层——因此没有"装饰被重挂挤掉"的窗口，
   * 直接 `service.forSession(id).store('user').put(...)` 也一样被拒。
   */
  readonly privacy?: () => PrivacyGatePort | undefined
  /**
   * 解析宿主存储端口。每次需要时调用；返回 undefined 表示宿主尚未注入
   * （**不缓存失败**：宿主可能在 apply 之后才注册端口）。
   */
  readonly resolvePort: () => StorageHostPort | undefined
  /**
   * 读「会话 → cwd」的**唯一来源**（生产：内核 `ActiveSessionTable`，见
   * `kernel/activeSession.ts` 与 `SERVICES.activeSession`）。
   *
   * 为什么是"读"而不是"本模块自己存"：这条事实曾经在本模块也存了一份
   * （`cwdBySession`），与内核登记处更新时机不同，于是状态面出现**稳定矛盾**
   * （模块段 0 条、存储段 1 条）。现在本模块**不缓存**——每次按需向唯一来源查。
   * 缓存要么需要失效规则，要么会再次制造"两个数字"。
   *
   * 缺省（不注入）→ 一律视为"宿主尚未告知 cwd"：`forSession` 退回仅用户库，
   * 与本模块的既有降级语义一致。
   */
  readonly resolveSessionCwd?: (sessionId: string) => string | undefined
  /**
   * 唯一来源里**当前已知 cwd 的会话列表**（去重前）。
   *
   * 用途只有一个：用户库就绪后补开这些会话的项目库（`warmKnownSessions`），
   * 使"sqlite 就绪前预热失败"不被固化成永久缺库。缺省即"没有已知会话"。
   */
  readonly knownSessionCwds?: () => readonly string[]
  /** 模块配置的只读副本，供子能力（向量线程数等）读取。 */
  readonly config?: Readonly<Record<string, unknown>>
  /** 项目库连接缓存上限。 */
  readonly maxOpenProjects?: number
  /**
   * 已装配好的宿主端口。给了就不再走 `resolvePort`——
   * `dsh/` 在构造注册项时直接注入是首选路径（不依赖服务名约定）。
   */
  readonly port?: StorageHostPort
  /** 覆盖打开失败的重试节奏（测试用；缺省 `DEFAULT_RETRY_DELAYS_MS`）。 */
  readonly retryDelaysMs?: readonly number[]
  /** 覆盖"等待宿主就绪"的上限（毫秒）。 */
  readonly readyWaitMs?: number
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
  /**
   * **同步**取"某会话当前可用的库"：已打开才返回，不触发打开、不抛。
   *
   * 存在的理由：工具执行体（`ToolDefinition.execute`）的库解析是同步的，
   * 而 `forSession` 是异步的。会话的项目库在 `turn/start` 预热后即已打开，
   * 因此 `peek` 在工具路径上总是命中；未命中时返回用户库（`projectScope=null`
   * 是显式信号：项目库还没打开），调用方据此降级而不是静默当成"没有项目记忆"。
   */
  peek(sessionId: string): StoreSet | undefined
  /** 最近一次失败的可读原因（状态面"诚实降级"用）。 */
  failure(): string | undefined
  /** 等价于 ABI 的 `close()`；供模块 disposer 使用。 */
  dispose(): Promise<void>
}

/** 项目库默认缓存上限。 */
const DEFAULT_MAX_OPEN_PROJECTS = MAX_OPEN_PROJECTS

// ────────────────────────────────────────────────────────────────────────────
// 隐私强制点（唯一一处；见 `StoresServiceOptions.privacy`）
// ────────────────────────────────────────────────────────────────────────────

/** 一次库访问的判定结果（由 `omb-privacy` 给出）。 */
export interface PrivacyDecisionPort {
  readonly allowRead: boolean
  readonly allowWrite: boolean
  readonly readReason: string
  readonly writeReason: string
}

/**
 * 隐私判定端口的结构契约。
 *
 * **定义在这里而不是 import `modules/privacy/`**：分层规则禁止模块之间互相 import
 * （`eslint.config.mjs` 的 `no-layer-violation`），双方只认形状——与
 * `SecondaryChannelRegistry<T>` 的处理方式一致。
 */
export interface PrivacyGatePort {
  /** 按会话判定；拿不到会话 id 时调用方用 `decideUnattributed()`。 */
  decide(sessionId: string): PrivacyDecisionPort
  /** 归属未知时的判定：**禁写不禁读**（见 `modules/privacy/modes.ts` 的说明）。 */
  decideUnattributed(): PrivacyDecisionPort
}

/**
 * 库方法 → 访问类别。
 *
 * **表里没有的方法一律按 `write` 处理**（fail-closed）：将来库里新增一个方法而忘了
 * 在这里登记时，隐私模式下它会被拒绝而不是悄悄放行。漏登记的代价是"多禁了一个"，
 * 而多禁是可恢复的。
 */
const STORE_ACCESS: Readonly<Record<string, 'read' | 'write' | 'transaction'>> = {
  // ── 读 ──
  get: 'read',
  getMany: 'read',
  searchLexical: 'read',
  searchOverturned: 'read',
  walkGraph: 'read',
  stats: 'read',
  embeddingMeta: 'read',
  getEmbeddings: 'read',
  listEmbeddings: 'read',
  countStaleEmbeddings: 'read',
  listStaleEmbeddingIds: 'read',
  searchVector: 'read',
  countEmbeddings: 'read',
  // 离线整合的输入端（列出最近记录）是**读**：受限会话里整合仍可运行，只是写会被拒
  listRecentRecords: 'read',
  // ── 写 ──
  put: 'write',
  upsertEdge: 'write',
  forget: 'write',
  // 使用计数是**写**：隐私受限的会话里不能悄悄积累"用过多少次"（它是行为痕迹）
  markUsed: 'write',
  putEmbedding: 'write',
  setEmbeddingMeta: 'write',
  // 回收残留向量行是一次真正的删除（只删"不属于当前身份"的行），按写处理
  deleteStaleEmbeddings: 'write',
  // ── 事务 ──
  // 按"读"放行：事务里的**每一次库调用**都会各自过闸（调用方拿到的是本视图），
  // 所以只读事务能跑、写操作照样被拒。全禁会让 read-only 下的检索路径直接断掉。
  transaction: 'transaction',
}

/** 生命周期方法：与记忆内容无关，不受隐私模式限制。 */
const STORE_LIFECYCLE: ReadonlySet<string> = new Set(['close', 'checkpointAfterForgetFailed'])

/** 收集一个库对象上的全部方法名（含原型链，去重）。 */
function methodNamesOf(store: object): readonly string[] {
  const names = new Set<string>()
  let cursor: object | null = store
  while (cursor !== null && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name === 'constructor') continue
      if (names.has(name)) continue
      const value = (cursor as Record<string, unknown>)[name]
      if (typeof value === 'function') names.add(name)
    }
    cursor = Object.getPrototypeOf(cursor) as object | null
  }
  return [...names]
}

/**
 * 造一个**受隐私闸门约束的库视图**。
 *
 * 用 `Object.create(inner)` 而不是普通包装对象：视图与内层库是同一原型链，
 * 于是 `asVectorStore` / `asMemoryStore` 的 `instanceof` 判定照常命中——
 * 否则向量通道会因为"不是本实现"而静默降级（检索悄悄少一条通道）。
 * 私有字段（`#db`）不会被继承，因此**每个方法都必须显式转发**（这正是下面的循环做的事），
 * 转发时以 `this = inner` 调用，私有字段照常可用。
 */
function gateStore(inner: MemoryStore, decide: () => PrivacyDecisionPort): MemoryStore {
  const view = Object.create(inner) as MemoryStore
  for (const name of methodNamesOf(inner)) {
    if (STORE_LIFECYCLE.has(name)) continue
    const kind = STORE_ACCESS[name] ?? 'write' // 表外方法按写入（fail-closed）
    const original = (inner as unknown as Record<string, unknown>)[name] as (
      ...args: unknown[]
    ) => unknown
    Object.defineProperty(view, name, {
      value: (...args: unknown[]) => {
        const decision = decide()
        if (kind === 'write' && !decision.allowWrite) {
          // 拒绝用**可读的 Error**：它会被上层（工具执行体 / 检索降级 / 整合）如实携带，
          // 因此"拒绝原因可读"不依赖任何一层额外的装饰。
          return Promise.reject(new Error(decision.writeReason))
        }
        if (kind !== 'write' && !decision.allowRead) {
          return Promise.reject(new Error(decision.readReason))
        }
        return original.apply(inner, args)
      },
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }
  return view
}

/**
 * 给一个库套件套上隐私闸门。
 *
 * @param sessionId 该套件被谁取用；**null = 归属未知**（`forProject` / `snapshot`），
 *   此时用 `decideUnattributed()`（禁写不禁读）。
 */
function gateSet(
  set: StoreSet | undefined,
  sessionId: string | null,
  resolve: () => PrivacyGatePort | undefined,
): StoreSet | undefined {
  if (set === undefined) return undefined
  const port = resolve()
  if (port === undefined) return set // 没有隐私模块：零开销、行为与从前完全一致
  const decide = (): PrivacyDecisionPort =>
    sessionId === null ? port.decideUnattributed() : port.decide(sessionId)
  const view = (store: MemoryStore): MemoryStore => gateStore(store, decide)

  return {
    projectScope: set.projectScope,
    // `stores` 数组同样要套：检索/整合是直接迭代 `set.stores` 拿库的
    stores: set.stores.map(tagged => ({ scope: tagged.scope, store: view(tagged.store) })),
    store: scope => {
      const found = set.store(scope)
      return found === undefined ? undefined : view(found)
    },
    migrated: set.migrated,
    // 关闭是生命周期：不拦（否则隐私模式会让库关不掉）
    close: () => set.close(),
  }
}

export function createStoresService(options: StoresServiceOptions): MemoryStoresService {
  const logger = options.logger
  const config = options.config ?? {}
  const maxOpenProjects = Math.max(1, options.maxOpenProjects ?? DEFAULT_MAX_OPEN_PROJECTS)
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const readyWaitMs = options.readyWaitMs ?? DEFAULT_READY_WAIT_MS
  /** 隐私闸门的惰性解析（见 `StoresServiceOptions.privacy`：行加载顺序不确定）。 */
  const privacyGate = (): PrivacyGatePort | undefined => options.privacy?.()

  /** 已打开的项目库套件，插入顺序 = LRU 顺序。 */
  const projects = new Map<string, StoreSet>()
  /** 正在打开的项目库（去重并发打开）。 */
  const pendingProjects = new Map<string, Promise<StoreSet | undefined>>()
  const projectFailures = new Map<string, string>()

  /**
   * 查「会话 → cwd」。**按需向唯一来源问，不存第二份**（见 `resolveSessionCwd` 的说明）。
   *
   * 来源故障/返回畸形值一律当作"未登记"：本模块降级为仅用户库，
   * 工具与检索照常可用（绝不抛）。
   */
  function sessionCwdOf(sessionId: string): string | undefined {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    try {
      const cwd = options.resolveSessionCwd?.(sessionId)
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    } catch {
      return undefined
    }
  }

  let userStore: SqliteMemoryStore | undefined
  let userSet: StoreSet | undefined
  let userPromise: Promise<StoreSet | undefined> | undefined
  let userFailure: string | undefined
  let unexpectedFailure: string | undefined
  let resolvedPort: StorageHostPort | undefined
  /** 已用掉的重试次数（成功即归零）。 */
  let userAttempts = 0
  /** 待执行的重试定时器（关闭时清掉，避免关库后又被唤醒）。 */
  let userRetryTimer: ReturnType<typeof setTimeout> | undefined
  /** 上一次用户库失败是否值得重试（确定性失败不重试）。 */
  let lastUserFailureRetryable = true
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

  /**
   * 等宿主声明"sqlite 就绪"（可选能力）。
   *
   * `StorageHostPort` 是冻结 ABI，所以这里**结构化探测**一个可选的 `whenReady()`：
   * `dsh/` 给了就等它（不再猜时序），没给就退化为下面的有界重试。
   * 等待失败/超时都不抛——真正的错误由 `openDatabase` 抛出来，那才有诊断价值。
   */
  async function awaitPortReady(hostPort: StorageHostPort): Promise<void> {
    const probe = (hostPort as { whenReady?: unknown }).whenReady
    if (typeof probe !== 'function') return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve((probe as () => unknown).call(hostPort)),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, readyWaitMs)
          unrefTimer(timer)
        }),
      ])
    } catch {
      // 就绪等待本身失败：继续尝试打开，让错误在 openDatabase 处显形
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 用户库就绪后补开"已登记会话"的项目库。
   *
   * 为什么需要：`turn/start` 的预热可能发生在 sqlite 就绪之前（那次必然失败），
   * 而项目库失败**不缓存**——但也没人再去开它。用户库一旦打开就补一次，
   * 使"记录在案的会话"不会被一次时序竞态永久漏掉。
   *
   * 会话列表同样从**唯一来源**取（`knownSessionCwds`），本模块不留第二份。
   */
  function warmKnownSessions(): void {
    let cwds: readonly string[] = []
    try {
      cwds = options.knownSessionCwds?.() ?? []
    } catch {
      // 来源故障 → 没有可补开的会话；后续会话自己会再触发 forSession
      return
    }
    for (const cwd of new Set(cwds)) {
      if (typeof cwd !== 'string' || cwd.length === 0) continue
      void ensureProject(cwd).catch(NOOP)
    }
  }

  /**
   * 排一次重试。
   * @returns `scheduled` 已排；`pending` 已有重试在排队；`exhausted` 预算耗尽（或已关闭）。
   */
  function scheduleUserRetry(): 'scheduled' | 'pending' | 'exhausted' {
    if (closing) return 'exhausted'
    if (userRetryTimer !== undefined) return 'pending'
    const delay = retryDelays[userAttempts]
    if (delay === undefined) return 'exhausted' // 预算耗尽：不再忙等，原因留在状态面
    userAttempts += 1
    userRetryTimer = setTimeout(() => {
      userRetryTimer = undefined
      void ensureUser().catch(NOOP)
    }, delay)
    unrefTimer(userRetryTimer)
    return 'scheduled'
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

    let lastError: unknown
    userPromise = (async (): Promise<StoreSet | undefined> => {
      try {
        await awaitPortReady(hostPort)
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
        userAttempts = 0
        warmKnownSessions()
        return userSet
      } catch (error) {
        lastError = error
        // 确定性失败（版本高于插件支持）重试没有意义；其余失败按节奏重试
        lastUserFailureRetryable = !(error instanceof SchemaVersionAheadError)
        return undefined
      }
    })()

    const result = await userPromise
    if (result === undefined) {
      userPromise = undefined // 允许下次调用立即重试
      // 重试决策**之后**才写原因：不能在还有重试排队时就说"放弃"（诚实降级）
      const retryState = lastUserFailureRetryable ? scheduleUserRetry() : 'exhausted'
      const suffix = !lastUserFailureRetryable
        ? '（确定性失败，不重试）'
        : retryState === 'scheduled'
          ? `（第 ${userAttempts} 次失败，将重试）`
          : retryState === 'pending'
            ? '（已有重试在排队）'
            : `（已重试 ${userAttempts} 次，放弃）`
      recordUserFailure(`用户库打开失败（${hostPort.userDbPath}）：${messageOf(lastError)}${suffix}`)
    }
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
    if (!isAbsolute(cwd)) {
      // 与 paths.ts 同一策略：相对路径会被静默锚到进程 cwd，宁可拒绝
      unexpectedFailure = `项目库需要绝对 cwd，收到 "${cwd}"——拒绝静默采用进程 cwd`
      logger.warn(`OMB 记忆库：${unexpectedFailure}`)
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

    // **同步**登记在飞任务：否则并发 forProject 会各自打开一次同一个库文件
    // （任务体里的第一个 await 之前，pendingProjects 必须已经可见）。
    const task = (async (): Promise<StoreSet | undefined> => {
      const user = await ensureUser()
      if (user === undefined) return undefined
      const hostPort = port()
      if (hostPort === undefined || userStore === undefined) return undefined
      if (closing) return undefined
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
        const set = projectSet(key, store)
        // 在任务内登记：任务 resolve 时 `projects` 已经可见，晚到的调用者不会重复打开
        projects.set(key, set)
        return set
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
      // 关库后不该再被重试定时器唤醒（否则会对已关闭的库再开一次）
      if (userRetryTimer !== undefined) {
        clearTimeout(userRetryTimer)
        userRetryTimer = undefined
      }
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
        parts.push(`用户库=${resolvedPort?.userDbPath ?? userPath}${migrationText(userSet.migrated[0])}`)
      }
      if (projectFailures.size > 0) {
        parts.push(
          `项目库失败 ${projectFailures.size} 个：${[...projectFailures]
            .map(([key, reason]) => `${key}（${reason}）`)
            .join('；')}`,
        )
      }
      if (unexpectedFailure !== undefined) parts.push(`意外失败：${unexpectedFailure}`)
      // **这里不再出现任何"已打开项目库 N/M"或"会话→cwd 登记 N 条"**：
      // 状态面只有一个报数处（`## 存储` 段），它读 `openProjects`/`maxOpenProjects`
      // 与内核 `ActiveSessionTable`。本 detail 只说就绪情况与失败原因
      // （"无空降级"要求原因写在这里，而不是把计数再抄一遍）。
      return { ready: !closing && userSet !== undefined, detail: parts.join('；'), openProjects, maxOpenProjects }
    },

    async forSession(sessionId: string): Promise<StoreSet | undefined> {
      try {
        const user = await ensureUser()
        if (user === undefined) return undefined
        // 按需向**唯一来源**查（不缓存）：宿主刚告知 cwd，这里立刻就能取到项目库。
        const cwd = sessionCwdOf(sessionId)
        // 宿主尚未告知 cwd：降级为"仅用户库"，projectScope=null 是给调用方的显式信号
        // 出口一律过隐私闸门：这是"直接调库也必须被拒"的那一道。
        if (cwd === undefined) return gateSet(user, sessionId, privacyGate)
        const project = await ensureProject(cwd)
        return gateSet(project ?? user, sessionId, privacyGate)
      } catch (error) {
        unexpectedFailure = `会话 ${sessionId} 取库失败：${messageOf(error)}`
        logger.warn(`OMB 记忆库：${unexpectedFailure}`)
        return undefined
      }
    },

    async forProject(cwd: string): Promise<StoreSet | undefined> {
      try {
        // `forProject` 只有 cwd，**没有会话归属** → 归属未知（禁写不禁读）
        return gateSet(await ensureProject(cwd), null, privacyGate)
      } catch (error) {
        unexpectedFailure = `项目 ${cwd} 取库失败：${messageOf(error)}`
        logger.warn(`OMB 记忆库：${unexpectedFailure}`)
        return undefined
      }
    },

    snapshot() {
      // `snapshot()` 没有会话归属（向量编码队列只带 {id, scope}）→ 归属未知。
      // **不返回空集**：空集会让调用方以为"库没打开"并做别的降级决定；
      // 用"归属未知的视图"表达，读照常、写被拒，作用域精确到这一次访问。
      return {
        user: gateSet(userSet, null, privacyGate),
        projects: [...projects.values()].map(set => gateSet(set, null, privacyGate) as StoreSet),
      }
    },

    peek(sessionId: string): StoreSet | undefined {
      if (closing) return undefined
      const cwd = sessionCwdOf(sessionId)
      if (cwd !== undefined) {
        const key = projectIdentity(cwd)
        const set = projects.get(key)
        if (set !== undefined) {
          projects.delete(key)
          projects.set(key, set) // LRU 触碰：正在被用的库不该被淘汰
          return gateSet(set, sessionId, privacyGate)
        }
      }
      return gateSet(userSet, sessionId, privacyGate)
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
