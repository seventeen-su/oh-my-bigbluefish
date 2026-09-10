// OMB v2 记忆后端 SQL 面（纯模块，无 DB 依赖）：建表 DDL（六表 + FTS5 虚拟表 + 同步触发器）与
// FTS5 MATCH 表达式/游标解析纯函数。拆分自 backend.ts 以遵守单模块 LOC ≤ 400（CONVENTIONS §9，见报告）。
// FTS5 触发器说明（实测结论，见 task-3.1-report）：FTS5 的 'delete' 特殊 INSERT 命令在本构建
// （SQLite 3.50.4 / Node 24.12）的普通 fts5 表上报 SQL logic error（external content 表可用）；
// 故 UPDATE/DELETE 同步改用 DELETE FROM memory_fts WHERE rowid = old.rowid（实测可用）。
// T8.16 双侧分词（中文分词接入）：memory 表新增 payload_fts 列（JS 侧分词结果）——FTS 虚拟表
// payload_text 改由 new.payload_fts 同步（触发器无法调用 JS 分词器；ingest/update 在 JS 侧
// tokenizeForFts 后写入 payload_fts，查询侧同分词再 MATCH——unicode61 中文子串不命中的修复）。
// R5（Predictive Invalidation 对象定位）：memory 表新增 environment 列——ingest 时写入
// provenance.environment 的固定字段序 JSON（仅含声明字段；可选键 gpu/cuda 未声明则省略），
// 供 findAffectedObjects 按 delta 字段做 `"<key>":"<value>"` 子串匹配（LIKE）。选择说明：
// 与「查询 body JSON 全量扫描」相比，本列提供了可索引/可查询的独立环境声明面（改动最小且
// 可索引——新库由 DDL 建列、既有库由 backend 构造器 ALTER 补列）；匹配面（backend-retrieval.ts
// findAffectedObjects）以键值相邻子串匹配，键序无关，仅要求序列化固定字段序（见 environmentJson）。
// layer 2（memory/）：仅 node: 内置与同层模块——本模块无任何 import（environmentJson 用结构类型
// 免引入 kernel/schemas 类型，保持纯模块；字段序与 kernel/environment-fingerprint.ts 同源防漂移）。
/** 建表 SQL：memory / memory_relation / memory_stats / retrieval_episode / staging / checkpoint
 *  / negative_pattern（T8.8 失败样本表）+ memory_fts（fts5 独立表）+ 触发器同步
 * （INSERT 直插、UPDATE/DELETE 按 rowid 删后重插；payload_text = new.payload_fts 分词列）。 */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, lifecycle TEXT NOT NULL,
    prov_class TEXT NOT NULL, payload TEXT NOT NULL, payload_fts TEXT NOT NULL DEFAULT '',
    value_score REAL NOT NULL,
    utility_counts TEXT NOT NULL, belief_ref TEXT, lineage_ref TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, event_id TEXT UNIQUE,
    environment TEXT, body TEXT NOT NULL,
    vector BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_memory_scope_kind_lifecycle ON memory(scope, kind, lifecycle);
  CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory(updated);
  CREATE INDEX IF NOT EXISTS idx_memory_environment ON memory(environment);
  CREATE TABLE IF NOT EXISTS memory_relation (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    type TEXT NOT NULL, weight REAL, created INTEGER, source TEXT, UNIQUE(from_id, to_id, type)
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
  CREATE TABLE IF NOT EXISTS negative_pattern (
    id TEXT PRIMARY KEY, graph_hash TEXT NOT NULL, failed_operator TEXT NOT NULL,
    code TEXT NOT NULL, message TEXT NOT NULL, environment TEXT NOT NULL,
    created INTEGER NOT NULL, provenance TEXT NOT NULL, body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_negative_pattern_graph ON negative_pattern(graph_hash);
  CREATE INDEX IF NOT EXISTS idx_negative_pattern_operator ON negative_pattern(failed_operator);
  CREATE INDEX IF NOT EXISTS idx_negative_pattern_created ON negative_pattern(created);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED, scope, kind, lifecycle, prov_class, payload_text
  );
  CREATE TRIGGER IF NOT EXISTS trg_memory_fts_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, id, scope, kind, lifecycle, prov_class, payload_text)
    VALUES (new.rowid, new.id, new.scope, new.kind, new.lifecycle, new.prov_class, new.payload_fts);
  END;
  CREATE TRIGGER IF NOT EXISTS trg_memory_fts_ad AFTER DELETE ON memory BEGIN
    DELETE FROM memory_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS trg_memory_fts_au AFTER UPDATE ON memory BEGIN
    DELETE FROM memory_fts WHERE rowid = old.rowid;
    INSERT INTO memory_fts(rowid, id, scope, kind, lifecycle, prov_class, payload_text)
    VALUES (new.rowid, new.id, new.scope, new.kind, new.lifecycle, new.prov_class, new.payload_fts);
  END;
`;

/** §4.4 Fingerprint 参与环境声明的字段序（与 kernel/environment-fingerprint.ts FINGERPRINT_FIELDS 同序——
 *  防漂移注释：environmentJson 与 findAffectedObjects 的 `"<key>":"<value>"` 子串匹配仅要求固定字段序，
 *  不要求键序与匹配面顺序一致（子串匹配与位置无关）。 */
const ENV_FIELD_ORDER = ['os', 'node', 'dsh_version', 'project', 'gpu', 'cuda'] as const;

/** R5：环境声明 JSON（memory.environment 列）——Fingerprint 固定字段序序列化（仅含声明字段，
 *  可选键 gpu/cuda 未声明则省略——findAffectedObjects 对 delta.from===undefined 以「未声明该键」匹配）。 */
export function environmentJson(fp: {
  os: string;
  node: string;
  dsh_version: string;
  project: string;
  gpu?: string;
  cuda?: string;
}): string {
  const obj: Record<string, string> = {};
  for (const f of ENV_FIELD_ORDER) {
    const v = fp[f];
    if (v !== undefined) {
      obj[f] = v;
    }
  }
  return JSON.stringify(obj);
}

/**
 * FTS5 MATCH 表达式构造（已知问题《中文命中率低与空结果记录》修复）。
 *
 * 修复前的口径：多 token 无特殊字符 → 原样（FTS5 空格 = **隐式 AND**）。在 CJK 双侧分词
 * （`tokenizeForFts` 把中文段切成 bigram、空格连接，见 cjk-ngram.ts）下这会造成系统性漏检：
 * 查询「契约边界」→ token「契约 约边 边界」→ 要求三条 bigram **同时**命中，而记忆里可能只有
 * 「契约」——实测该查询 0 命中（长查询比短查询更容易漏，与"中文查询命中极少"的现象一致）。
 *
 * 修复后的口径：**token 之间取 OR（各自整体短语化）**，相关度交给 bm25 排序——
 *   - 命中更多查询 bigram 的记录 bm25 更优 → 排序仍把最相关的排前（精度不丢）；
 *   - 只命中部分 bigram 的记录也能召回（召回率提升，正是修复目标）；
 *   - 每个 token 单独短语化 → 规避 AND/OR/NOT/NEAR 保留字与 `:`/`*`/`-` 等语法字符导致的语法错误。
 * 空 token 串 → 空表达式（调用方不应以此执行 MATCH）。
 */
export function ftsMatchExpr(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return '';
  }
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
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
