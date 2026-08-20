// OMB v2 记忆后端 SQL 面（纯模块，无 DB 依赖）：建表 DDL（六表 + FTS5 虚拟表 + 同步触发器）与
// FTS5 MATCH 表达式/游标解析纯函数。拆分自 backend.ts 以遵守单模块 LOC ≤ 400（CONVENTIONS §9，见报告）。
// FTS5 触发器说明（实测结论，见 task-3.1-report）：FTS5 的 'delete' 特殊 INSERT 命令在本构建
// （SQLite 3.50.4 / Node 24.12）的普通 fts5 表上报 SQL logic error（external content 表可用）；
// 故 UPDATE/DELETE 同步改用 DELETE FROM memory_fts WHERE rowid = old.rowid（实测可用）。
// layer 2（memory/）：仅 node: 内置与同层模块——本模块无任何 import。
/** 建表 SQL：memory / memory_relation / memory_stats / retrieval_episode / staging / checkpoint
 *  + memory_fts（fts5 独立表）+ 触发器同步（INSERT 直插、UPDATE/DELETE 按 rowid 删后重插）。 */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, lifecycle TEXT NOT NULL,
    prov_class TEXT NOT NULL, payload TEXT NOT NULL, value_score REAL NOT NULL,
    utility_counts TEXT NOT NULL, belief_ref TEXT, lineage_ref TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, event_id TEXT UNIQUE, body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_scope_kind_lifecycle ON memory(scope, kind, lifecycle);
  CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory(updated);
  CREATE TABLE IF NOT EXISTS memory_relation (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    type TEXT NOT NULL, UNIQUE(from_id, to_id, type)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_relation_from ON memory_relation(from_id);
  CREATE INDEX IF NOT EXISTS idx_memory_relation_to ON memory_relation(to_id);
  CREATE TABLE IF NOT EXISTS memory_stats (
    id TEXT PRIMARY KEY, retrievals INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0, last_retrieved INTEGER
  );
  CREATE TABLE IF NOT EXISTS retrieval_episode (
    id TEXT PRIMARY KEY, query TEXT, scope TEXT, candidate_ids TEXT, ranked_ids TEXT,
    injected_ids TEXT, outcome TEXT, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS staging (
    id TEXT PRIMARY KEY, event_id TEXT UNIQUE, priority INTEGER, ttl_until INTEGER,
    payload TEXT, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS checkpoint (
    id TEXT PRIMARY KEY, working_state TEXT, hash TEXT, created INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED, scope, kind, lifecycle, prov_class, payload_text
  );
  CREATE TRIGGER IF NOT EXISTS trg_memory_fts_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, id, scope, kind, lifecycle, prov_class, payload_text)
    VALUES (new.rowid, new.id, new.scope, new.kind, new.lifecycle, new.prov_class, new.payload);
  END;
  CREATE TRIGGER IF NOT EXISTS trg_memory_fts_ad AFTER DELETE ON memory BEGIN
    DELETE FROM memory_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS trg_memory_fts_au AFTER UPDATE ON memory BEGIN
    DELETE FROM memory_fts WHERE rowid = old.rowid;
    INSERT INTO memory_fts(rowid, id, scope, kind, lifecycle, prov_class, payload_text)
    VALUES (new.rowid, new.id, new.scope, new.kind, new.lifecycle, new.prov_class, new.payload);
  END;
`;

/** FTS5 MATCH 表达式构造：单 token 一律引号化（规避 AND/OR/NOT/NEAR 保留字语法错误）；
 *  含特殊字符（冒号=列过滤语法、括号/星号/^/- 等操作符）→ 整体短语化 + 内部引号加倍转义；
 *  多 token 无特殊字符 → 原样（FTS5 空格 = 隐式 AND）。 */
export function ftsMatchExpr(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const hasSpace = /\s/.test(trimmed);
  const hasSpecial = /["():*^\-{}[\]\\]/.test(trimmed);
  if (!hasSpace && !hasSpecial) {
    return `"${trimmed}"`;
  }
  if (hasSpecial) {
    return `"${trimmed.replace(/"/g, '""')}"`;
  }
  return trimmed;
}

/** 复合游标解析：`<updated>:<id>`（updated 为 epoch ms 纯数字，首个 ':' 为分隔） */
export function parseCursor(cursor: string): { updated: number; id: string } {
  const idx = cursor.indexOf(':');
  const updated = Number(cursor.slice(0, idx));
  if (idx <= 0 || !Number.isFinite(updated)) {
    throw new Error(`SqliteMemoryBackend.query: 非法游标: ${cursor}`);
  }
  return { updated, id: cursor.slice(idx + 1) };
}
