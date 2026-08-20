// OMB v2 记忆 staging 与准入（架构 §7.2 / §11.3）：Event → staging（TTL/priority/来源最低要求）
// → metadata admission（重复/新信息/稳定/scope/来源）→ memory 表；sweepExpired 回收 TTL 过期行。
// 单写者（§11.3）：admit/sweep 走同一 db 连接顺序执行（WAL 单写者语义）；admit 直接 SQL 写 memory
// （brief 允许「调用 backend.ingest 或直接 SQL」）——与 backend.ingest 同列集、ON CONFLICT(event_id)
// DO NOTHING 幂等，FTS 由 memory 表触发器自动同步；恢复 = 幂等重跑（event_id 已存在 → no-op 收敛）。
// 幂等键 event_id = event.provenance.event（与 backend.ingest 的 provenance.event 同键，§11.3）。
// 常量表/纯函数（TTL/priority/信任序/稳定门槛/规范化/哈希/Event→Memory 映射）T3.3 前置拆至
// staging-policy.ts（本文件引用之；公共常量再导出保持既有调用方兼容）。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { makeMutableId, type Scope } from '../kernel/schemas/base.js';
import {
  EventSchema,
  MemorySchema,
  type Event,
  type MemoryKind,
  type MemoryProvClass,
} from '../kernel/schemas/m.js';
import { DEFAULT_MEMORY_DB } from './backend.js';
import { SCHEMA_SQL } from './sql.js';
import {
  DEFAULT_MIN_PROV_CLASS,
  DEFAULT_PRIORITY,
  DEFAULT_PRIORITY_BY_TYPE,
  DEFAULT_TTL_MS,
  PROV_CLASS_TRUST,
  STABILITY_MIN_PRIORITY,
  buildMemory,
  contentHash,
  memoryCandidate,
  stageProvClass,
} from './staging-policy.js';

// 兼容再导出（常量表已迁 staging-policy.ts；import 自 staging.js 的既有调用方不变）
export {
  DEFAULT_MIN_PROV_CLASS,
  DEFAULT_PRIORITY,
  DEFAULT_PRIORITY_BY_TYPE,
  DEFAULT_TTL_MS,
  STABILITY_MIN_PRIORITY,
} from './staging-policy.js';

const BUSY_TIMEOUT_MS = 5000;

// ---- 公共类型 ----

export interface StageOptions {
  priority?: number;
  ttlMs?: number;
  minProvClass?: MemoryProvClass;
}

export type StageResult =
  | { admitted: true; id: string }
  | { admitted: false; reason: 'duplicate' | 'below-min-prov-class' };

export interface AdmitOptions {
  now?: number;
  /** 最多准入行数（按 priority 降序处理，达限即停；缺省不限） */
  limit?: number;
}

export interface AdmitResult {
  /** 准入事件的 event_id（幂等键，§11.3） */
  admitted: string[];
  rejected: { id: string; reason: string }[];
}

interface StagingRow {
  id: string;
  event_id: string;
  priority: number;
  payload: string;
}

type AdmitRowOutcome =
  | { status: 'admitted'; eventId: string }
  | { status: 'rejected'; eventId: string; reason: string };

// ---- StagingManager ----

export class StagingManager {
  private readonly db: DatabaseSync;
  private readonly insertStage: StatementSync;
  private readonly selectStaging: StatementSync;
  private readonly insertMemory: StatementSync;
  private readonly insertStats: StatementSync;
  private readonly deleteStaging: StatementSync;

  constructor(dbPath: string = DEFAULT_MEMORY_DB) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(SCHEMA_SQL);
    this.insertStage = this.db.prepare(
      `INSERT INTO staging (id, event_id, priority, ttl_until, payload, created)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    );
    this.selectStaging = this.db.prepare(
      `SELECT id, event_id, priority, payload FROM staging
       WHERE ttl_until IS NULL OR ttl_until >= ?
       ORDER BY priority DESC, created ASC, id ASC`,
    );
    this.insertMemory = this.db.prepare(
      `INSERT INTO memory (id, scope, kind, lifecycle, prov_class, payload, value_score,
                           utility_counts, belief_ref, lineage_ref, created, updated, event_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    );
    this.insertStats = this.db.prepare('INSERT INTO memory_stats (id) VALUES (?)');
    this.deleteStaging = this.db.prepare('DELETE FROM staging WHERE id = ?');
  }

  /** Event → staging 行；来源最低要求/幂等（event_id UNIQUE）两道 gate */
  async stage(event: Event, opts: StageOptions = {}): Promise<StageResult> {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`StagingManager.stage: Event 校验失败 — ${parsed.error.message}`);
    }
    const ev = parsed.data;
    const provClass = stageProvClass(ev);
    const minProvClass = opts.minProvClass ?? DEFAULT_MIN_PROV_CLASS;
    if ((PROV_CLASS_TRUST[provClass] ?? 0) < (PROV_CLASS_TRUST[minProvClass] ?? 0)) {
      return { admitted: false, reason: 'below-min-prov-class' }; // 记录并丢弃：不入 staging
    }
    const now = Date.now();
    const priority = opts.priority ?? DEFAULT_PRIORITY_BY_TYPE[ev.type] ?? DEFAULT_PRIORITY;
    const ttlUntil = now + (opts.ttlMs ?? DEFAULT_TTL_MS);
    const id = makeMutableId('stage');
    const r = this.insertStage.run(id, ev.provenance.event, priority, ttlUntil, JSON.stringify(ev), now);
    if (r.changes === 0) {
      return { admitted: false, reason: 'duplicate' }; // 幂等：同 event_id 重复 stage → no-op
    }
    return { admitted: true, id };
  }

  /** metadata admission：遍历 staging（priority 降序、TTL 未过期）→ 通过写 memory 表并移除 staging 行 */
  async admit(opts: AdmitOptions = {}): Promise<AdmitResult> {
    const now = opts.now ?? Date.now();
    const limit = opts.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new Error(`StagingManager.admit: 非法 limit: ${limit}`);
    }
    const rows = this.selectStaging.all(now) as unknown as StagingRow[];
    const admitted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    let admittedCount = 0;
    const outer = this.db.isTransaction;
    if (!outer) {
      this.db.exec('BEGIN');
    }
    try {
      for (const row of rows) {
        if (limit !== undefined && admittedCount >= limit) break;
        const outcome = this.tryAdmitRow(row);
        if (outcome.status === 'admitted') {
          admitted.push(outcome.eventId);
          admittedCount++;
        } else {
          rejected.push({ id: outcome.eventId, reason: outcome.reason });
        }
        this.deleteStaging.run(row.id); // 已处理行（准入/拒绝）均移除；limit 未处理行保留
      }
      if (!outer) {
        this.db.exec('COMMIT');
      }
    } catch (err) {
      if (!outer && this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw err;
    }
    return { admitted, rejected };
  }

  /** TTL 过期回收：删除 staging 中 ttl_until < now 的行；返回删除数 */
  async sweepExpired(opts: { now?: number } = {}): Promise<number> {
    const now = opts.now ?? Date.now();
    const r = this.db.prepare('DELETE FROM staging WHERE ttl_until < ?').run(now);
    return Number(r.changes);
  }

  /** 关闭连接（幂等；Windows WAL 侧车文件锁要求收尾先 close） */
  async close(): Promise<void> {
    if (this.db.isOpen) {
      this.db.close();
    }
  }

  /** 单行 admission：重复/新信息 → 稳定 → scope/来源（MemorySchema 全量校验）→ 写 memory */
  private tryAdmitRow(row: StagingRow): AdmitRowOutcome {
    let event: Event;
    try {
      event = EventSchema.parse(JSON.parse(row.payload) as unknown);
    } catch {
      return { status: 'rejected', eventId: row.event_id, reason: 'invalid' }; // 载荷损坏
    }
    const cand = memoryCandidate(event);
    if (!cand) {
      return { status: 'rejected', eventId: row.event_id, reason: 'invalid' }; // 无记忆候选/声明非法
    }
    const hash = contentHash(cand.scope, cand.kind, cand.payload);
    if (this.contentExists(cand.scope, cand.kind, hash)) {
      return { status: 'rejected', eventId: row.event_id, reason: 'duplicate' }; // 防重复记忆
    }
    if (row.priority < (STABILITY_MIN_PRIORITY[cand.prov_class] ?? 0)) {
      return { status: 'rejected', eventId: row.event_id, reason: 'unstable' }; // 来源不达标
    }
    const memory = buildMemory(event, cand);
    const parsed = MemorySchema.safeParse(memory);
    if (!parsed.success) {
      return { status: 'rejected', eventId: row.event_id, reason: 'invalid' }; // scope/来源/字段非法
    }
    const created = Date.parse(memory.created);
    const updated = Date.parse(memory.updated);
    const r = this.insertMemory.run(
      memory.id, memory.scope, memory.kind, memory.lifecycle, memory.prov_class, memory.payload,
      memory.value_score, JSON.stringify(memory.utility_counts), memory.belief_ref ?? null,
      memory.lineage_ref ?? null, created, updated, memory.provenance.event, JSON.stringify(memory),
    );
    if (r.changes > 0) {
      this.insertStats.run(memory.id);
    }
    // changes === 0 → event_id 已存在（幂等重跑恢复）：no-op，行随后删除收敛
    return { status: 'admitted', eventId: row.event_id };
  }

  /** 同 scope+kind 下是否存在规范化内容哈希相同的既有记忆（重复/新信息判定） */
  private contentExists(scope: Scope, kind: MemoryKind, hash: string): boolean {
    const rows = this.db.prepare('SELECT payload FROM memory WHERE scope = ? AND kind = ?').all(scope, kind) as unknown as {
      payload: string;
    }[];
    return rows.some((r) => contentHash(scope, kind, r.payload) === hash);
  }
}
