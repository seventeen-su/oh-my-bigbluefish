// OMB v2 Event Store（架构 §12.1 Event / §11.3 事务模型）：layer 1 追加写存储。
// SQLite 追加写（WAL）：events 表存原始事件（retention 原始 30 天，compact 批处理删除过期行）；
//   projections 独立表存派生投影（永久，compaction 永不动）。
// append/appendMany 自动派生投影（deriveProjection 纯函数）并同事务写入；M3 schema 校验 +
//   id 冲突拒绝（§11.3 幂等键 event_id，UNIQUE 约束）；seq 自增游标分页（keyset：seq > cursor）。
// 表结构按 brief，两处实现性微调（均已注释）：
//   ① seq "自增"在 SQLite 只能由 INTEGER PRIMARY KEY(AUTOINCREMENT) 实现 → seq 作主键、
//      id 用 UNIQUE NOT NULL 保持唯一（事件表）与"seq 自增"注释语义一致；
//   ② 另加 body 列存完整事件 JSON——read() 需保真重建含 IRBase 字段的 Event（逐列无法还原
//      9 个 IRBase 字段，且 timestamp 字符串经 INTEGER 往返会丢原格式）。
// node:sqlite 为同步 API；方法签名按 brief 保持 Promise。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（IR 契约例外，主会话裁决 2026-08-21）。
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { EventSchema, type Event } from '../kernel/schemas/m.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5000;

/** 派生投影（projections 表行；seq 由表自增分配） */
export interface Projection {
  seq: number;
  type: string; // projection/<event.type>
  session_id: string;
  timestamp: number; // epoch ms
  summary: Record<string, unknown>; // 精简 JSON：保留 id/type/session_id/timestamp 等关键字段，去 payload/provenance
}

/** deriveProjection 纯函数输出（seq 由存储分配） */
export type ProjectionInput = Omit<Projection, 'seq'>;

/** events 查询过滤（limit/cursor 见方法文档） */
export interface QueryOptions {
  type?: string;
  session_id?: string;
  from_ts?: number;
  to_ts?: number;
  limit?: number;
  cursor?: number; // seq 游标：仅返回 seq > cursor 的行
}

/** projections 查询过滤 */
export interface ProjectionQueryOptions {
  type?: string;
  session_id?: string;
  from_ts?: number;
  to_ts?: number;
  limit?: number;
  cursor?: number;
}

interface EventRow {
  seq: number;
  body: string;
}

interface ProjectionRow {
  seq: number;
  type: string;
  session_id: string;
  timestamp: number;
  summary: string;
}

/** 投影派生纯函数：原始事件 → 精简视图（type 前缀 projection/；summary 去 payload/provenance 细节） */
export function deriveProjection(event: Event): ProjectionInput {
  const summary: Record<string, unknown> = {
    id: event.id,
    type: event.type,
    session_id: event.session_id,
    timestamp: event.timestamp,
  };
  if (event.parent_event != null) {
    summary.parent_event = event.parent_event;
  }
  if (event.causality !== undefined) {
    summary.causality = event.causality;
  }
  return {
    type: `projection/${event.type}`,
    session_id: event.session_id,
    timestamp: Date.parse(event.timestamp),
    summary,
  };
}

export class EventStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly insertEvent: StatementSync;
  private readonly insertProjection: StatementSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS }); // busy_timeout 兜底（单写者语义）
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        runtime_snapshot TEXT NOT NULL,
        parent_event TEXT,
        causality TEXT,
        payload TEXT NOT NULL,
        provenance TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_projection INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE TABLE IF NOT EXISTS projections (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projections_type ON projections(type);
      CREATE INDEX IF NOT EXISTS idx_projections_session ON projections(session_id);
      CREATE INDEX IF NOT EXISTS idx_projections_timestamp ON projections(timestamp);
    `);
    this.insertEvent = this.db.prepare(
      `INSERT INTO events (id, type, session_id, runtime_snapshot, parent_event, causality,
                           payload, provenance, timestamp, is_projection, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertProjection = this.db.prepare(
      'INSERT INTO projections (type, session_id, timestamp, summary) VALUES (?, ?, ?, ?)',
    );
  }

  /** append：M3 schema 校验 → 追加写 events + 自动派生投影写 projections（单事务）；重复 id 拒绝 */
  async append(event: Event): Promise<void> {
    const v = this.validate(event);
    try {
      this.db.exec('BEGIN');
      this.insertRow(v);
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw this.duplicateMessage(err, v.event.id);
    }
  }

  /** appendMany：全部先校验（非法事件整批拒绝）→ 单事务批量写；库约束兜底重复 id */
  async appendMany(events: Event[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const validated = events.map((e) => this.validate(e));
    const seen = new Set<string>();
    for (const v of validated) {
      if (seen.has(v.event.id)) {
        throw new Error(`EventStore.appendMany: 批量内重复 id: ${v.event.id}`);
      }
      seen.add(v.event.id);
    }
    try {
      this.db.exec('BEGIN');
      for (const v of validated) {
        this.insertRow(v);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw err;
    }
  }

  /** read：按 id 读取完整 Event；不存在 → null */
  async read(id: string): Promise<Event | null> {
    const row = this.db.prepare('SELECT body FROM events WHERE id = ?').get(id) as
      | { body: string }
      | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.body) as Event;
  }

  /** query：type/session_id/时间范围（闭区间）过滤 + limit + seq 游标分页；有下一页时返回 next_cursor */
  async query(opts: QueryOptions = {}): Promise<{ events: Event[]; next_cursor?: number }> {
    const { type, session_id, from_ts, to_ts, limit, cursor } = opts;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(`EventStore.query: 非法 limit: ${limit}`);
    }
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
      throw new Error(`EventStore.query: 非法 cursor: ${cursor}`);
    }
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (type !== undefined) {
      where.push('type = ?');
      params.push(type);
    }
    if (session_id !== undefined) {
      where.push('session_id = ?');
      params.push(session_id);
    }
    if (from_ts !== undefined) {
      where.push('timestamp >= ?');
      params.push(from_ts);
    }
    if (to_ts !== undefined) {
      where.push('timestamp <= ?');
      params.push(to_ts);
    }
    if (cursor !== undefined) {
      where.push('seq > ?');
      params.push(cursor);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    // 多取 1 行探测是否有下一页（keyset：下一页从 next_cursor 继续）
    const fetch = limit !== undefined ? limit + 1 : undefined;
    let sql = `SELECT seq, body FROM events${whereSql} ORDER BY seq ASC`;
    if (fetch !== undefined) {
      sql += ' LIMIT ?';
    }
    const stmt = this.db.prepare(sql);
    const rows = (
      fetch !== undefined ? stmt.all(...params, fetch) : stmt.all(...params)
    ) as unknown as EventRow[];
    const { page, next_cursor } = this.paginate(rows, limit);
    return { events: page.map((r) => JSON.parse(r.body) as Event), next_cursor };
  }

  /** queryProjections：投影表过滤 + 分页（projections 永久，不受 compaction 影响） */
  async queryProjections(
    opts: ProjectionQueryOptions = {},
  ): Promise<{ projections: Projection[]; next_cursor?: number }> {
    const { type, session_id, from_ts, to_ts, limit, cursor } = opts;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(`EventStore.queryProjections: 非法 limit: ${limit}`);
    }
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
      throw new Error(`EventStore.queryProjections: 非法 cursor: ${cursor}`);
    }
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (type !== undefined) {
      where.push('type = ?');
      params.push(type);
    }
    if (session_id !== undefined) {
      where.push('session_id = ?');
      params.push(session_id);
    }
    if (from_ts !== undefined) {
      where.push('timestamp >= ?');
      params.push(from_ts);
    }
    if (to_ts !== undefined) {
      where.push('timestamp <= ?');
      params.push(to_ts);
    }
    if (cursor !== undefined) {
      where.push('seq > ?');
      params.push(cursor);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const fetch = limit !== undefined ? limit + 1 : undefined;
    let sql = `SELECT seq, type, session_id, timestamp, summary FROM projections${whereSql} ORDER BY seq ASC`;
    if (fetch !== undefined) {
      sql += ' LIMIT ?';
    }
    const stmt = this.db.prepare(sql);
    const rows = (
      fetch !== undefined ? stmt.all(...params, fetch) : stmt.all(...params)
    ) as unknown as ProjectionRow[];
    const { page, next_cursor } = this.paginate(rows, limit);
    return {
      projections: page.map((r) => ({
        seq: r.seq,
        type: r.type,
        session_id: r.session_id,
        timestamp: r.timestamp,
        summary: JSON.parse(r.summary) as Record<string, unknown>,
      })),
      next_cursor,
    };
  }

  /** count：events 表总行数 */
  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return row.n;
  }

  /** 数据库总占用字节（主库 + WAL + shm 侧车；文件不可读 → 0 诚实缺省） */
  sizeBytes(): number {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(`${this.dbPath}${suffix}`).size;
      } catch {
        // 侧车文件可能尚未建立（或已合并）→ 跳过
      }
    }
    return total;
  }

  /**
   * VACUUM（已知问题《事件库体积增长》修复：压缩只删记录不回收文件页 → 维护期整理回收页）。
   * 说明：`VACUUM` 不能在事务内执行，且会重写整库；调用方（维护任务）应按体积阈值触发，
   * 不在关键路径上跑。失败 → 抛（调用方降级记录）。返回回收后的库大小字节。
   */
  vacuum(): number {
    this.db.exec('VACUUM');
    return this.sizeBytes();
  }

  /** compact（批处理入口）：删除 timestamp < now - retentionDays 的原始事件行；投影表永不动；幂等 */
  async compact(now: number, retentionDays = 30): Promise<{ removed: number; projections_kept: number }> {
    const cutoff = now - retentionDays * DAY_MS;
    const del = this.db
      .prepare('DELETE FROM events WHERE timestamp < ? AND is_projection = 0')
      .run(cutoff);
    const kept = this.db.prepare('SELECT COUNT(*) AS n FROM projections').get() as { n: number };
    return { removed: Number(del.changes), projections_kept: kept.n };
  }

  /** close：关闭连接（幂等：已关闭则 no-op） */
  async close(): Promise<void> {
    if (this.db.isOpen) {
      this.db.close();
    }
  }

  /** M3 schema 校验 + timestamp 可解析性；返回规范化事件与 epoch ms */
  private validate(event: Event): { event: Event; tsInt: number } {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`EventStore: M3 schema 校验失败 — ${parsed.error.message}`);
    }
    const e = parsed.data;
    const tsInt = Date.parse(e.timestamp);
    if (Number.isNaN(tsInt)) {
      throw new Error(`EventStore: timestamp 无法解析为时间: ${e.timestamp}`);
    }
    return { event: e, tsInt };
  }

  /** 写一行事件 + 一行派生投影（调用方保证在事务内） */
  private insertRow(v: { event: Event; tsInt: number }): void {
    const e = v.event;
    this.insertEvent.run(
      e.id,
      e.type,
      e.session_id,
      e.runtime_snapshot,
      e.parent_event ?? null,
      e.causality ?? null,
      JSON.stringify(e.payload),
      JSON.stringify(e.provenance),
      v.tsInt,
      0,
      JSON.stringify(e),
    );
    const proj = deriveProjection(e);
    this.insertProjection.run(proj.type, proj.session_id, proj.timestamp, JSON.stringify(proj.summary));
  }

  /** UNIQUE 约束错误 → 语义化重复 id 消息 */
  private duplicateMessage(err: unknown, id: string): unknown {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      return new Error(`EventStore: 重复 id（§11.3 幂等键 event_id 冲突）: ${id}`);
    }
    return err;
  }

  /** 分页切片：rows 为多取 1 行后的结果；hasMore → next_cursor = 本页末行 seq */
  private paginate<T extends { seq: number }>(rows: T[], limit: number | undefined): {
    page: T[];
    next_cursor?: number;
  } {
    const hasMore = limit !== undefined && rows.length > limit;
    const page = hasMore && limit !== undefined ? rows.slice(0, limit) : rows;
    let next_cursor: number | undefined;
    if (hasMore) {
      const last = page[page.length - 1];
      if (last) {
        next_cursor = last.seq;
      }
    }
    return { page, next_cursor };
  }
}
