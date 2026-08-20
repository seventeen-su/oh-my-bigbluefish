// OMB v2 记忆后端（架构 §7.5 存储 / §4.3 A4 MemoryBackend / §7.1 四维）：SQLite（WAL 单写者）+ FTS5（bm25 rank）。
// 六表：memory / memory_relation / memory_stats / retrieval_episode / staging / checkpoint（T3.2/T3.4 用，本任务建表）。
// FTS5 方案（实现者选择并记录）：独立虚拟表 memory_fts + 触发器同步——brief 的 FTS 列集（payload_text）
// 与 memory 表列不一致，外部内容表（content=memory）需在 memory 上加列；独立表+触发器直接匹配 brief 列集。
// 幂等键（§11.3）：event_id = memory.provenance.event；同 event_id 二次 ingest → no-op 返回既有 id
// （恢复 = 幂等重跑；T3.2 admit 连跑两次无副作用依赖此语义）；同 id 异 event_id → 主键冲突 fail-loud。
// 表结构按 brief，一处实现性微调（记录，T1.3 同款先例）：新增 body 列存完整 Memory JSON——query 需保真
// 重建含 IRBase 字段的 Memory；标量列保留作过滤/索引；payload 列存原文（FTS payload_text 直接索引原文）。
// node:sqlite 为同步 API；方法签名按 brief 保持 Promise。layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { ScopeEnum } from '../kernel/schemas/base.js';
import {
  MemoryQuerySchema,
  type MemoryBackend,
  type MemoryQuery,
  type RelationWalk,
  type RelationWalkNode,
} from '../kernel/schemas/a.js';
import {
  MemoryKindEnum,
  MemoryLifecycleEnum,
  MemoryProvClassEnum,
  MemorySchema,
  type Memory,
} from '../kernel/schemas/m.js';
import { SCHEMA_SQL, ftsMatchExpr, parseCursor } from './sql.js';

/** 默认 DB 文件（用户态目录，CONVENTIONS §7：preset/omb-v2/workspace/.omb/） */
export const DEFAULT_MEMORY_DB = 'workspace/.omb/memory.db';

const BUSY_TIMEOUT_MS = 5000;

/** query() 第二参（§4.3 opts）：page = 1 起 OFFSET 页码（FTS 路径用）；cursor = (updated):(id) 复合游标；sort = updated_desc|updated_asc */
export interface QueryOpts {
  page?: number;
  cursor?: string;
  sort?: string;
}

/** query 返回：items 为完整 Memory（body 保真重建）；结构上满足 MemoryPage（items: Memory[] ⊂ unknown[]） */
export interface MemoryPageResult {
  items: Memory[];
  cursor?: string;
  total?: number;
}

/** update 可更新字段白名单（id/created/provenance/refs/event_id 等不可变） */
const PATCHABLE = ['scope', 'kind', 'lifecycle', 'prov_class', 'payload', 'value_score', 'utility_counts', 'belief_ref', 'lineage_ref'] as const;

/** update 补丁 schema：仅白名单字段、逐字段校验 */
const MemoryPatchSchema = z.object({
  scope: ScopeEnum.optional(),
  kind: MemoryKindEnum.optional(),
  lifecycle: MemoryLifecycleEnum.optional(),
  prov_class: MemoryProvClassEnum.optional(),
  payload: z.string().min(1).optional(),
  value_score: z.number().min(0).max(1).optional(),
  utility_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  belief_ref: z.string().optional(),
  lineage_ref: z.string().optional(),
});

export class SqliteMemoryBackend implements MemoryBackend {
  private readonly db: DatabaseSync;
  private readonly insertMemory: StatementSync;
  private readonly insertStats: StatementSync;

  constructor(dbPath: string = DEFAULT_MEMORY_DB) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS }); // busy_timeout 兜底（单写者语义）
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(SCHEMA_SQL);
    this.insertMemory = this.db.prepare(
      `INSERT INTO memory (id, scope, kind, lifecycle, prov_class, payload, value_score,
                           utility_counts, belief_ref, lineage_ref, created, updated, event_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    );
    this.insertStats = this.db.prepare('INSERT INTO memory_stats (id) VALUES (?)');
  }

  /** ingest：M1 schema 校验 → 事务写 memory + memory_stats（FTS 由触发器同步）；返回 memory id。
   *  幂等键 event_id = provenance.event：同 event_id 二次 ingest → no-op 返回既有 id（§11.3 恢复=幂等重跑）。 */
  async ingest(m: Memory): Promise<string> {
    const v = this.validateMemory(m);
    const created = Date.parse(v.created);
    const updated = Date.parse(v.updated);
    if (Number.isNaN(created) || Number.isNaN(updated)) {
      throw new Error('SqliteMemoryBackend.ingest: created/updated 无法解析为时间');
    }
    const outer = this.beginIfNeeded();
    try {
      const r = this.insertMemory.run(
        v.id, v.scope, v.kind, v.lifecycle, v.prov_class, v.payload, v.value_score,
        JSON.stringify(v.utility_counts), v.belief_ref ?? null, v.lineage_ref ?? null,
        created, updated, v.provenance.event, JSON.stringify(v),
      );
      let id: string;
      if (r.changes === 0) {
        // 幂等 no-op（event_id 已存在）：返回既有行 id
        const existing = this.db.prepare('SELECT id FROM memory WHERE event_id = ?').get(v.provenance.event) as
          | { id: string }
          | undefined;
        if (!existing) {
          throw new Error(`SqliteMemoryBackend.ingest: 幂等冲突但查无既有行（event_id=${v.provenance.event}）`);
        }
        id = existing.id;
      } else {
        this.insertStats.run(v.id);
        id = v.id;
      }
      this.endIfNeeded(outer);
      return id;
    } catch (err) {
      this.rollbackIfNeeded(outer);
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        throw new Error(`SqliteMemoryBackend.ingest: 主键/event_id 冲突（幂等键语义）: ${v.id}`);
      }
      throw err;
    }
  }

  /** query：text 存在 → FTS（bm25 rank，rank 升序=相关度降序；分页用 page）；否则四维过滤 + (updated,id) 排序。
   *  分页：cursor = 上一页末项 (updated):(id) 复合游标（keyset）；relation/budget 字段接收暂不执行（语义待 T3.4 检索算子定）。 */
  async query(q: MemoryQuery, opts: QueryOpts = {}): Promise<MemoryPageResult> {
    const parsed = MemoryQuerySchema.safeParse(q);
    if (!parsed.success) {
      throw new Error(`SqliteMemoryBackend.query: 查询校验失败 — ${parsed.error.message}`);
    }
    const { scope, kind, lifecycle, prov_class, text, limit } = parsed.data;
    const { page, cursor, sort } = opts;
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      throw new Error(`SqliteMemoryBackend.query: 非法 page: ${page}`);
    }
    if (cursor !== undefined && page !== undefined) {
      throw new Error('SqliteMemoryBackend.query: cursor 与 page 不能同时使用');
    }
    if (sort !== undefined && sort !== 'updated_asc' && sort !== 'updated_desc') {
      throw new Error(`SqliteMemoryBackend.query: 非法 sort: ${sort}`);
    }
    const asc = sort === 'updated_asc';
    const conds: string[] = ['m.scope = ?'];
    const args: SQLInputValue[] = [scope];
    if (kind !== undefined) {
      conds.push('m.kind = ?');
      args.push(kind);
    }
    if (lifecycle !== undefined) {
      conds.push('m.lifecycle = ?');
      args.push(lifecycle);
    }
    if (prov_class !== undefined) {
      conds.push('m.prov_class = ?');
      args.push(prov_class);
    }
    const condSql = conds.join(' AND ');

    const trimmedText = text?.trim() ?? '';
    if (trimmedText.length > 0) {
      const ftsArgs: SQLInputValue[] = [ftsMatchExpr(trimmedText), ...args];
      const ftsWhere = `memory_fts MATCH ? AND ${condSql}`;
      const offset = page !== undefined ? (page - 1) * limit : 0;
      const rows = this.db.prepare(
        `SELECT m.id, m.body FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
         WHERE ${ftsWhere} ORDER BY bm25(memory_fts) ASC, m.rowid ASC LIMIT ? OFFSET ?`,
      ).all(...ftsArgs, limit, offset) as unknown as { id: string; body: string }[];
      const total = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid WHERE ${ftsWhere}`,
      ).get(...ftsArgs) as { n: number }).n;
      return { items: rows.map((r) => JSON.parse(r.body) as Memory), total };
    }

    // 非 FTS 路径：过滤 + (updated,id) 排序；keyset 游标（多取 1 探测下一页）；page → OFFSET
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM memory m WHERE ${condSql}`).get(...args) as { n: number }).n;
    const order = asc ? 'm.updated ASC, m.id ASC' : 'm.updated DESC, m.id DESC';
    let items: Memory[] = [];
    let nextCursor: string | undefined;
    if (cursor !== undefined) {
      const c = parseCursor(cursor);
      const cmp = asc ? '>' : '<';
      const rows = this.db.prepare(
        `SELECT m.id, m.updated, m.body FROM memory m WHERE ${condSql}
         AND (m.updated ${cmp} ? OR (m.updated = ? AND m.id ${cmp} ?))
         ORDER BY ${order} LIMIT ?`,
      ).all(...args, c.updated, c.updated, c.id, limit + 1) as unknown as { id: string; updated: number; body: string }[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      items = pageRows.map((r) => JSON.parse(r.body) as Memory);
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = `${last.updated}:${last.id}`;
      }
    } else if (page !== undefined) {
      const offset = (page - 1) * limit;
      const rows = this.db.prepare(
        `SELECT m.id, m.body FROM memory m WHERE ${condSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ).all(...args, limit, offset) as unknown as { id: string; body: string }[];
      items = rows.map((r) => JSON.parse(r.body) as Memory);
    } else {
      // 首页（无游标无页码）：keyset 探测下一页（游标 = 本页末项 (updated):(id)）
      const rows = this.db.prepare(
        `SELECT m.id, m.updated, m.body FROM memory m WHERE ${condSql} ORDER BY ${order} LIMIT ?`,
      ).all(...args, limit + 1) as unknown as { id: string; updated: number; body: string }[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      items = pageRows.map((r) => JSON.parse(r.body) as Memory);
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = `${last.updated}:${last.id}`;
      }
    }
    return { items, cursor: nextCursor, total };
  }

  /** update：白名单字段补丁（MemoryPatchSchema 校验）→ 合并 + updated 刷新 + 全量再校验；FTS 由触发器同步；未知 id fail-loud */
  async update(id: string, patch: Partial<Memory>): Promise<void> {
    for (const k of Object.keys(patch)) {
      if (!(PATCHABLE as readonly string[]).includes(k)) {
        throw new Error(`SqliteMemoryBackend.update: 不可更新字段: ${k}`);
      }
    }
    const parsed = MemoryPatchSchema.safeParse(patch);
    if (!parsed.success) {
      throw new Error(`SqliteMemoryBackend.update: 补丁校验失败 — ${parsed.error.message}`);
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined) {
        clean[k] = v;
      }
    }
    const outer = this.beginIfNeeded();
    try {
      const row = this.db.prepare('SELECT body FROM memory WHERE id = ?').get(id) as { body: string } | undefined;
      if (!row) {
        throw new Error(`SqliteMemoryBackend.update: 记忆不存在: ${id}`);
      }
      const merged = this.validateMemory({ ...(JSON.parse(row.body) as Memory), ...clean, updated: new Date().toISOString() });
      this.db.prepare(
        `UPDATE memory SET scope = ?, kind = ?, lifecycle = ?, prov_class = ?, payload = ?, value_score = ?,
                           utility_counts = ?, belief_ref = ?, lineage_ref = ?, updated = ?, body = ?
         WHERE id = ?`,
      ).run(
        merged.scope, merged.kind, merged.lifecycle, merged.prov_class, merged.payload, merged.value_score,
        JSON.stringify(merged.utility_counts), merged.belief_ref ?? null, merged.lineage_ref ?? null,
        Date.parse(merged.updated), JSON.stringify(merged), id,
      );
      this.endIfNeeded(outer);
    } catch (err) {
      this.rollbackIfNeeded(outer);
      throw err;
    }
  }

  /** delete：事务删 memory（FTS 触发器同步）+ 级联删关系出入边 + stats；未知 id fail-loud */
  async delete(id: string): Promise<void> {
    const outer = this.beginIfNeeded();
    try {
      const del = this.db.prepare('DELETE FROM memory WHERE id = ?').run(id);
      if (del.changes === 0) {
        throw new Error(`SqliteMemoryBackend.delete: 记忆不存在: ${id}`);
      }
      this.db.prepare('DELETE FROM memory_relation WHERE from_id = ? OR to_id = ?').run(id, id);
      this.db.prepare('DELETE FROM memory_stats WHERE id = ?').run(id);
      this.endIfNeeded(outer);
    } catch (err) {
      this.rollbackIfNeeded(outer);
      throw err;
    }
  }

  /** link（§7.4 Link 算子基础，A4 附加方法）：写 memory_relation；UNIQUE(from_id,to_id,type) 重复 → fail-loud */
  async link(fromId: string, toId: string, type: string): Promise<void> {
    if (type.length === 0) {
      throw new Error('SqliteMemoryBackend.link: type 不能为空');
    }
    this.db.prepare('INSERT INTO memory_relation (from_id, to_id, type) VALUES (?, ?, ?)').run(fromId, toId, type);
  }

  /** relationTraverse：BFS 出边遍历 depth 层（types 过滤，types=[] 全类型）；
   *  返回 {seed, nodes[{id, depth, relations[{type,to_id}]}], truncated}；truncated = 深度边界层仍有未访问出边。 */
  async relationTraverse(seed: string, types: string[], depth: number): Promise<RelationWalk> {
    if (!Number.isInteger(depth) || depth < 0) {
      throw new Error(`SqliteMemoryBackend.relationTraverse: 非法 depth: ${depth}`);
    }
    const nodes: RelationWalkNode[] = [];
    const depthMap = new Map<string, number>();
    const relationsOf = new Map<string, { type: string; to_id: string }[]>();
    const edgeStmt =
      types.length > 0
        ? this.db.prepare(
            `SELECT to_id, type FROM memory_relation WHERE from_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id`,
          )
        : this.db.prepare('SELECT to_id, type FROM memory_relation WHERE from_id = ? ORDER BY id');
    let frontier = [seed];
    depthMap.set(seed, 0);
    let truncated = false;
    for (let d = 0; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const rows = (types.length > 0 ? edgeStmt.all(cur, ...types) : edgeStmt.all(cur)) as unknown as {
          to_id: string;
          type: string;
        }[];
        const rels = rows.map((r) => ({ type: r.type, to_id: r.to_id }));
        relationsOf.set(cur, rels);
        if (d === depth) {
          if (rels.some((r) => !depthMap.has(r.to_id))) {
            truncated = true;
          }
        } else {
          for (const r of rels) {
            if (!depthMap.has(r.to_id)) {
              depthMap.set(r.to_id, d + 1);
              next.push(r.to_id);
            }
          }
        }
      }
      frontier = next;
    }
    for (const [id, d] of depthMap) {
      nodes.push({ id, depth: d, relations: relationsOf.get(id) ?? [] });
    }
    return { seed, nodes, truncated };
  }

  /** transaction：BEGIN/COMMIT/ROLLBACK 手动事务（node:sqlite 无内置事务 API）；嵌套 fail-loud */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.db.isTransaction) {
      throw new Error('SqliteMemoryBackend.transaction: 嵌套事务不支持（fail-loud）');
    }
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw err;
    }
  }

  /** health：连接可读 → ok true；关闭/异常 → ok false + detail */
  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.db.isOpen) {
      return { ok: false, detail: 'db 已关闭' };
    }
    try {
      this.db.prepare('SELECT 1').get();
      return { ok: true, detail: 'ok' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** close：关闭连接（幂等；Windows WAL 侧车文件锁要求收尾先 close） */
  async close(): Promise<void> {
    if (this.db.isOpen) {
      this.db.close();
    }
  }

  /** M1 schema 校验（返回解析后对象；timestamp 可解析性由调用方保证） */
  private validateMemory(m: Memory): Memory {
    const parsed = MemorySchema.safeParse(m);
    if (!parsed.success) {
      throw new Error(`SqliteMemoryBackend: M1 schema 校验失败 — ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** 事务参与：外层已有事务（ingest 等加入其中，保证 transaction(fn) 组合原子性）则不自行 BEGIN；返回是否外层 */
  private beginIfNeeded(): boolean {
    const outer = this.db.isTransaction;
    if (!outer) {
      this.db.exec('BEGIN');
    }
    return outer;
  }

  private endIfNeeded(outer: boolean): void {
    if (!outer) {
      this.db.exec('COMMIT');
    }
  }

  private rollbackIfNeeded(outer: boolean): void {
    if (!outer && this.db.isTransaction) {
      this.db.exec('ROLLBACK');
    }
  }
}
