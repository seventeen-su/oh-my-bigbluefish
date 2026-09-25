/**
 * 迁移框架：**`PRAGMA user_version` 驱动，每个库独立版本号**。
 *
 * 三条硬规则（规划 §9 阶段 2.1 / `kernel/abi/storage.ts`）：
 * ① 空库 → 升到最新（`user_version = 0` 走全部 step）
 * ② `user_version > SCHEMA_VERSION` → **拒绝打开并抛出**（不猜结构；猜错的代价是静默损坏）
 * ③ 迁移失败 → `ROLLBACK`，版本不变，异常向上抛（**绝不吞**）
 *
 * 为什么整次升级放在**一个**事务里：中途失败时"版本不变"必须是真的"什么都没变"。
 * 若每个 step 各自提交，前一个 step 的产物会留下来而版本号却对不上——
 * 那正是"半迁移"状态，比重试更危险。SQLite 的 DDL 是事务性的（含 `PRAGMA user_version`），
 * 因此这个保证是廉价的。
 *
 * 为什么 step 是 `up(db): void` 而不是 SQL 字符串：后续版本可能有数据搬移（改列、回填），
 * 那时需要 JS 参与；本版只有 DDL，但接口不留级。
 */
import type { Logger, SqliteLike } from '../../kernel/abi/index.js'
import { SCHEMA_VERSION } from '../../kernel/abi/index.js'

/** 一个迁移步骤。`version` 是执行**之后**的 `user_version`。 */
export interface MigrationStep {
  /** 目标版本号；必须 ≥ 1 且严格递增。 */
  readonly version: number
  /** 人类可读的名字，出现在日志与状态面里。 */
  readonly name: string
  /** 执行迁移；抛异常即视为该步失败（整次升级回滚）。 */
  readonly up: (db: SqliteLike) => void
}

/** 已应用的单个步骤。 */
export interface MigrationApplied {
  readonly version: number
  readonly name: string
}

/** 一次 `migrate()` 的结果。 */
export interface MigrationOutcome {
  /** 迁移前的版本。 */
  readonly from: number
  /** 迁移后的版本（成功时等于目标版本）。 */
  readonly to: number
  /** 本次实际执行的步骤（已是最新时为空）。 */
  readonly applied: readonly MigrationApplied[]
}

export interface MigrateOptions {
  /** 覆盖步骤表——**仅供测试**注入失败步骤以验证回滚。 */
  readonly steps?: readonly MigrationStep[]
  /** 仅用于汇报回滚失败这类"不能改变主流程"的异常。 */
  readonly logger?: Logger
}

/**
 * 库的 schema 版本高于本插件支持的版本。
 *
 * 刻意是**独立类型**：调用方（状态面、`stores` 服务）可以据此给出
 * "请升级插件"而不是"数据库损坏"的可行动提示。
 */
export class SchemaVersionAheadError extends Error {
  readonly found: number
  readonly supported: number

  constructor(found: number, supported: number) {
    super(
      `数据库 schema 版本 ${found} 高于本插件支持的 ${supported}：拒绝打开（不猜结构）。` +
        `请升级 OMB 插件，或改用与该库匹配的版本；本插件不会改写它。`,
    )
    this.name = 'SchemaVersionAheadError'
    this.found = found
    this.supported = supported
  }
}

/** 读取 `PRAGMA user_version`。空库为 0；非法值视为损坏并抛出（不静默当 0）。 */
export function readUserVersion(db: SqliteLike): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  const raw = row?.user_version ?? 0
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`OMB：读取 PRAGMA user_version 得到非法值 ${String(raw)}——数据库头已损坏`)
  }
  return value
}

/** 步骤表的最高版本（空表为 0）。 */
export function latestVersion(steps: readonly MigrationStep[]): number {
  let latest = 0
  for (const step of steps) latest = Math.max(latest, step.version)
  return latest
}

/** 校验步骤表自身合法：版本为正整数且严格递增。这是编程错误，直接抛。 */
function assertStepsValid(steps: readonly MigrationStep[]): void {
  let previous = 0
  for (const step of steps) {
    if (!Number.isInteger(step.version) || step.version < 1) {
      throw new Error(`OMB：迁移步骤 ${step.name} 的 version 必须是 ≥1 的整数，收到 ${step.version}`)
    }
    if (step.version <= previous) {
      throw new Error(`OMB：迁移步骤版本必须严格递增（${previous} → ${step.version}，步骤 ${step.name}）`)
    }
    previous = step.version
  }
}

/**
 * 执行迁移。
 *
 * @throws {SchemaVersionAheadError} `user_version` 大于目标版本（拒绝打开）
 * @throws {Error} 任一步骤失败（已回滚，版本不变）
 */
export function migrate(db: SqliteLike, options: MigrateOptions = {}): MigrationOutcome {
  const steps = options.steps ?? SCHEMA_MIGRATIONS
  assertStepsValid(steps)

  const target = latestVersion(steps)
  if (options.steps === undefined && target !== SCHEMA_VERSION) {
    // 契约漂移的自检：ABI 抬版本而迁移表没跟上（或反之）时必须响亮失败，
    // 否则"升到最新"会静默停在一个过期的结构上。
    throw new Error(
      `OMB：迁移表最高版本 ${target} 与 kernel/abi 的 SCHEMA_VERSION ${SCHEMA_VERSION} 不一致——契约漂移`,
    )
  }

  const from = readUserVersion(db)
  if (from > target) throw new SchemaVersionAheadError(from, target)

  const pending = steps.filter(step => step.version > from)
  if (pending.length === 0) return { from, to: from, applied: [] }

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const step of pending) {
      step.up(db)
      // 版本号随步骤推进，但整次升级是原子的：任一步抛异常都会连同版本一起回滚
      db.exec(`PRAGMA user_version = ${step.version}`)
    }
    syncMetaSchemaVersion(db, target)
    const after = readUserVersion(db)
    if (after !== target) {
      throw new Error(`OMB：迁移结束后 user_version=${after}，期望 ${target}`)
    }
    db.exec('COMMIT')
    return {
      from,
      to: target,
      applied: pending.map(step => ({ version: step.version, name: step.name })),
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      // 回滚失败不改变主流程：原始异常才是调用方需要看到的
      options.logger?.warn(
        `OMB：迁移回滚失败（原始异常仍向上抛）——${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`,
      )
    }
    throw error
  }
}

/**
 * 让 `meta.schema_version` 与 `user_version` 保持一致。
 *
 * 版本权威只有 `PRAGMA user_version`；`meta` 里的那一列是给 SQL 侧与状态面读的冗余视图。
 * 只由迁移写入 ⇒ 不可能漂移。
 */
function syncMetaSchemaVersion(db: SqliteLike, version: number): void {
  const exists = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get()
  if (exists === undefined) return
  db.prepare('UPDATE meta SET schema_version = ?').run(version)
}

/** 正式迁移步骤表。新增版本时在此追加，并把 `SCHEMA_VERSION` 同步到最高版本。 */
export const SCHEMA_MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, name: 'initial-schema', up: applySchemaV1 },
]

/**
 * v1 结构（规划 §5.2）。
 *
 * 刻意保留的结构性约束：
 * - `source_ref NOT NULL` 且非空：投毒防御与证据独立的必要条件（空串等于没有来源）
 * - `asserted_by` 枚举而非 0~1 置信度：可核对的来源等级，不是一个未校准的浮点数
 * - `edge` **没有 weight 列**：未归一化的边权与"和融合"是同一类量纲不可比错误
 * - `embedding` 的 `model_id`/`dim`/`revision` 非空 + `CHECK(dim > 0)`：
 *   让"混入 256 维哈希词袋"在结构上不可能
 */
function applySchemaV1(db: SqliteLike): void {
  db.exec(`
    -- 节点：一条记忆（逐字原文 + 完整溯源）
    CREATE TABLE memory (
      id            TEXT    PRIMARY KEY,
      scope         TEXT    NOT NULL CHECK (scope IN ('user', 'project')),
      kind          TEXT    NOT NULL CHECK (kind IN ('episodic', 'semantic', 'procedural')),
      text          TEXT    NOT NULL,
      content_hash  TEXT    NOT NULL,
      source_ref    TEXT    NOT NULL CHECK (length(source_ref) > 0),
      asserted_by   TEXT    NOT NULL CHECK (asserted_by IN ('user', 'execution', 'model')),
      observed_at   INTEGER NOT NULL,
      valid_to      INTEGER,
      superseded_by TEXT,
      last_used_at  INTEGER NOT NULL,
      use_count     INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
      project       TEXT,
      -- JS 侧分词的产物（node:sqlite 不能注册自定义 FTS5 tokenizer，见规划 §8.3）
      payload_fts   TEXT    NOT NULL
    ) STRICT;

    CREATE INDEX memory_content_hash ON memory(content_hash);
    CREATE INDEX memory_observed_at  ON memory(observed_at);
    CREATE INDEX memory_liveness     ON memory(valid_to, superseded_by);

    -- 边：三种类型，没有权重（布尔事实）
    CREATE TABLE edge (
      from_id    TEXT    NOT NULL,
      to_id      TEXT    NOT NULL,
      type       TEXT    NOT NULL CHECK (type IN ('supersedes', 'conflicts_with', 'derived_from')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX edge_to_type ON edge(to_id, type);

    -- 向量：独立表，可归属、可重建（D2）
    CREATE TABLE embedding (
      memory_id TEXT    NOT NULL,
      model_id  TEXT    NOT NULL CHECK (length(model_id) > 0),
      dim       INTEGER NOT NULL CHECK (dim > 0),
      revision  TEXT    NOT NULL CHECK (length(revision) > 0),
      vector    BLOB    NOT NULL,
      PRIMARY KEY (memory_id, model_id, revision)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX embedding_model ON embedding(model_id, revision);

    -- 元数据：单行。版本号由迁移写入；embedding_* 是"当前模型"的权威记录
    CREATE TABLE meta (
      schema_version     INTEGER NOT NULL,
      embedding_model_id TEXT,
      embedding_dim      INTEGER CHECK (embedding_dim IS NULL OR embedding_dim > 0),
      embedding_revision TEXT
    ) STRICT;

    CREATE TRIGGER meta_single_row BEFORE INSERT ON meta
    WHEN (SELECT count(*) FROM meta) >= 1
    BEGIN
      SELECT RAISE(ABORT, 'meta 表只允许一行');
    END;

    INSERT INTO meta (schema_version, embedding_model_id, embedding_dim, embedding_revision)
    VALUES (1, NULL, NULL, NULL);
  `)

  // FTS5 单独一段：不可用时给一条可行动的错因，而不是一句 SQL logic error
  try {
    db.exec(`
      -- 独立（非 external-content）FTS5 表，由 memory 上的触发器保持同步：
      -- 索引不可能与节点表漂移，写入方也不需要记得同时改两处。
      CREATE VIRTUAL TABLE memory_fts USING fts5(payload);

      CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, payload) VALUES (new.rowid, new.payload_fts);
      END;

      CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory BEGIN
        DELETE FROM memory_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER memory_fts_au AFTER UPDATE OF payload_fts ON memory BEGIN
        DELETE FROM memory_fts WHERE rowid = old.rowid;
        INSERT INTO memory_fts(rowid, payload) VALUES (new.rowid, new.payload_fts);
      END;
    `)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `OMB：本机 SQLite 不支持 FTS5（${message}）——词法检索是记忆库的主通道，` +
        `缺失时宁可拒绝打开，也不要静默退化成"没有任何检索能力"。`,
    )
  }
}
