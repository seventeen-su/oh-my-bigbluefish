// OMB v2 记忆 staging 与准入（架构 §7.2 / §11.3）：Event → staging（TTL/priority/来源最低要求）
// → metadata admission（重复/新信息/稳定/scope/来源）→ memory 表；sweepExpired 回收 TTL 过期行。
// 单写者（§11.3）：admit/sweep 走同一 db 连接顺序执行（WAL 单写者语义）；admit 直接 SQL 写 memory
// （brief 允许「调用 backend.ingest 或直接 SQL」）——与 backend.ingest 同列集、ON CONFLICT(event_id)
// DO NOTHING 幂等，FTS 由 memory 表触发器自动同步；恢复 = 幂等重跑（event_id 已存在 → no-op 收敛）。
// 幂等键 event_id = event.provenance.event（与 backend.ingest 的 provenance.event 同键，§11.3）。
// Event → Memory 映射（本任务定型）：event.payload.memory = 候选 {scope?,kind?,lifecycle?,prov_class?,
// payload(文本),value_score?,utility_counts?,belief_ref?,lineage_ref?}；scope 缺省 event.scope、
// kind 缺省 Semantic、lifecycle 缺省 Active、prov_class 缺省由 provenance.source 映射（失败 →
// Model-inferred）；显式声明但值非法 → admit 拒绝 invalid（fail-loud，不静默改默认）。
// TTL/priority/来源最低要求/稳定门槛初始值为常量表（标注待标定，§17）。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { makeMutableId, ScopeEnum, type Scope } from '../kernel/schemas/base.js';
import {
  EventSchema,
  MemoryKindEnum,
  MemoryLifecycleEnum,
  MemoryProvClassEnum,
  MemorySchema,
  type Event,
  type Memory,
  type MemoryKind,
  type MemoryLifecycle,
  type MemoryProvClass,
} from '../kernel/schemas/m.js';
import { DEFAULT_MEMORY_DB } from './backend.js';
import { SCHEMA_SQL } from './sql.js';

const BUSY_TIMEOUT_MS = 5000;

// ---- 初始常量表（待标定，§17） ----

/** 默认 TTL（stage 未指定 ttlMs 时）：7 天 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 事件类型 → 默认 priority（初始映射：session/* 低、contradiction/found 高） */
export const DEFAULT_PRIORITY_BY_TYPE: Record<string, number> = {
  'session/start': 1,
  'session/end': 1,
  'tool/call': 2,
  'tool/result': 3,
  'claim/update': 5,
  'hypothesis/transition': 6,
  'decision/made': 7,
  'contradiction/found': 9,
  'memory/admitted': 4,
  'memory/consolidated': 4,
  'checkpoint/saved': 2,
  'activation/committed': 5,
  'maintenance/quantum': 1,
};

/** 类型映射未命中（通配段等）时的默认 priority */
export const DEFAULT_PRIORITY = 3;

/** 来源最低要求默认值（最低档，默认不拦截；待标定） */
export const DEFAULT_MIN_PROV_CLASS: MemoryProvClass = 'Model-inferred';

/** prov_class 信任序（stage 来源最低要求比较；值越大越可信；待标定） */
const PROV_CLASS_TRUST: Record<MemoryProvClass, number> = {
  'Model-inferred': 0,
  'System-derived': 1,
  'Tool-derived': 2,
  'Observation': 3,
  'User-declared': 4,
  'Externally-attested': 5,
};

/** admission 稳定门槛：prov_class → 所需最低 priority（Observation/User-declared/Externally-attested 直接过；待标定） */
export const STABILITY_MIN_PRIORITY: Record<MemoryProvClass, number> = {
  Observation: 0,
  'User-declared': 0,
  'Externally-attested': 0,
  'Tool-derived': 1,
  'System-derived': 2,
  'Model-inferred': 5,
};

/** provenance.source → prov_class 映射（stage/admit 的来源最低要求与稳定判定共用） */
const SOURCE_TO_PROV_CLASS: Record<string, MemoryProvClass> = {
  user: 'User-declared',
  observation: 'Observation',
  tool: 'Tool-derived',
  model: 'Model-inferred',
  external: 'Externally-attested',
  system: 'System-derived',
};

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

/** Event → Memory 候选（payload.memory 提取后的定型结构） */
interface MemoryCandidate {
  scope: Scope;
  kind: MemoryKind;
  lifecycle: MemoryLifecycle;
  prov_class: MemoryProvClass;
  payload: string;
  value_score: number;
  utility_counts: Record<string, number>;
  belief_ref?: string;
  lineage_ref?: string;
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

// ---- 纯函数 ----

/** 规范化文本：trim + 折叠连续空白（新信息判定，§7.2 简化：规范化哈希相同即视为重复） */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** scope+kind+规范化文本 → sha256（重复/新信息判定键） */
function contentHash(scope: Scope, kind: MemoryKind, payload: string): string {
  return createHash('sha256').update(`${scope}\u0000${kind}\u0000${normalizeText(payload)}`, 'utf8').digest('hex');
}

function parseScope(v: unknown): Scope | null {
  if (typeof v !== 'string') return null;
  const p = ScopeEnum.safeParse(v);
  return p.success ? p.data : null;
}

function parseKind(v: unknown): MemoryKind | null {
  if (typeof v !== 'string') return null;
  const p = MemoryKindEnum.safeParse(v);
  return p.success ? p.data : null;
}

function parseLifecycle(v: unknown): MemoryLifecycle | null {
  if (typeof v !== 'string') return null;
  const p = MemoryLifecycleEnum.safeParse(v);
  return p.success ? p.data : null;
}

function parseProvClass(v: unknown): MemoryProvClass | null {
  if (typeof v !== 'string') return null;
  const p = MemoryProvClassEnum.safeParse(v);
  return p.success ? p.data : null;
}

/** stage 门槛用 prov_class（宽容：声明合法 → 用之；否则 source 映射 → Model-inferred） */
function stageProvClass(event: Event): MemoryProvClass {
  const mem = (event.payload as { memory?: { prov_class?: unknown } }).memory;
  const declared = typeof mem === 'object' && mem !== null ? parseProvClass(mem.prov_class) : null;
  if (declared) return declared;
  return SOURCE_TO_PROV_CLASS[event.provenance.source] ?? 'Model-inferred';
}

/** payload.memory 提取；缺失/内容空/显式声明非法 → null（admit 拒绝 invalid） */
function memoryCandidate(event: Event): MemoryCandidate | null {
  const raw = (event.payload as { memory?: unknown }).memory;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.payload !== 'string' || m.payload.trim().length === 0) return null;
  const scope = m.scope === undefined ? (event.scope ?? 'Project') : parseScope(m.scope);
  if (!scope) return null;
  const kind = m.kind === undefined ? 'Semantic' : parseKind(m.kind);
  if (!kind) return null;
  const lifecycle = m.lifecycle === undefined ? 'Active' : parseLifecycle(m.lifecycle);
  if (!lifecycle) return null;
  const provClass = m.prov_class === undefined
    ? (SOURCE_TO_PROV_CLASS[event.provenance.source] ?? 'Model-inferred')
    : parseProvClass(m.prov_class);
  if (!provClass) return null;
  return {
    scope,
    kind,
    lifecycle,
    prov_class: provClass,
    payload: m.payload as string,
    value_score: typeof m.value_score === 'number' ? (m.value_score as number) : 0.5,
    utility_counts: isRecord(m.utility_counts) ? (m.utility_counts as Record<string, number>) : { read: 0, hit: 0 },
    belief_ref: typeof m.belief_ref === 'string' ? (m.belief_ref as string) : undefined,
    lineage_ref: typeof m.lineage_ref === 'string' ? (m.lineage_ref as string) : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Event → Memory（候选 + event.provenance 直接复用，provenance.event 即幂等键） */
function buildMemory(event: Event, cand: MemoryCandidate): Memory {
  const ts = Number.isNaN(Date.parse(event.timestamp)) ? new Date().toISOString() : event.timestamp;
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: cand.scope,
    lifecycle: cand.lifecycle,
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: event.provenance,
    refs: [],
    kind: cand.kind,
    prov_class: cand.prov_class,
    payload: cand.payload,
    value_score: cand.value_score,
    utility_counts: cand.utility_counts,
    ...(cand.belief_ref ? { belief_ref: cand.belief_ref } : {}),
    ...(cand.lineage_ref ? { lineage_ref: cand.lineage_ref } : {}),
  };
}

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
