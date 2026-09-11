// layer 2（memory/）：关系边存储面（已知问题《关系图为空图》——补边属性与治理面）。
//
// 背景：`memory_relation` 原本只有 (from_id, to_id, type) 三列，且唯一建边时机是整合任务的
// `KIND_LINK_RULES` 三条 kind 邻接规则（依赖生产中不存在的记忆类型）——关系表实测 0 行，
// 关系通道与「度数」价值信号恒为空转。本模块补上四个属性：**权重 / 时间 / 来源**（方向由
// from/to 表达），使关系图具备加权扩展能力（retrieve.ts 的扩展分按权重缩放），并给出治理面
// （列举 / 单条删除 / 统计——`kern_memory op=relations|unlink` 与状态段据此暴露）。
//
// 迁移纪律（同 R5 environment 与向量列）：旧库由本类构造器 ALTER 补列（此时尚未跑 SCHEMA_SQL 之外的
// 索引语句，新列不被任何索引引用），新库由 SCHEMA_SQL 直接建列；两者结果一致。
// 权重语义：0 < weight ≤ 1；规则边（kind 邻接 / 合并）恒为 1（既有扩展语义与实测数值不变），
// 相似度边为「词法 + 向量」合成强度（见 relations.ts）。
//
// layer 2（memory/）：仅 node: 内置 + 同层模块 + kernel/schemas/。
import { SqliteMemoryBackend } from './backend.js';

/** 边来源（可观测字段：回答"这条边是谁建的"）：rule=kind 邻接规则，merge=合并谱系，
 *  lexical/vector/both=相似度驱动（见 relations.ts），manual=人工。 */
export type RelationSource = 'rule' | 'merge' | 'lexical' | 'vector' | 'both' | 'manual';

/** link/upsert 的边属性（weight 缺省 1 = 既有规则边语义；created 缺省当前时间） */
export interface RelationAttrs {
  weight?: number;
  source?: RelationSource;
  created?: number;
}

/** 一条关系边（含属性；治理面与加权扩展的读取形状） */
export interface RelationEdge {
  from_id: string;
  to_id: string;
  type: string;
  /** 权重（0 < w ≤ 1；旧库历史行无值 → 按 1 读出——旧边语义即"满权规则边"） */
  weight: number;
  /** 建边时间（ms；旧库历史行无值 → null） */
  created: number | null;
  /** 来源（旧库历史行无值 → null） */
  source: RelationSource | null;
}

/** relationEdges 查询过滤（全部可选；limit 缺省 100，硬上限 1000） */
export interface RelationQuery {
  from?: string;
  to?: string;
  type?: string;
  source?: RelationSource;
  minWeight?: number;
  limit?: number;
  /** 排序：缺省 'id'（插入序，治理面列举语义）；'weight_desc' = 权重优先（检索扩展用——
   *  否则"先按 id 截断再按权重排序"会让高权重强边落在 LIMIT 之外而永不入选）。 */
  order?: 'id' | 'weight_desc';
}

/** 关系图统计（状态面/治理面观测：回答"图是不是还是空的、边都是哪来的"） */
export interface RelationStats {
  edges: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  /** 带显式权重的边数（旧库历史行不计——迁移完整度可观测） */
  weighted: number;
  maxWeight: number | null;
  meanWeight: number | null;
}

export const RELATION_EDGE_LIMIT_DEFAULT = 100;
export const RELATION_EDGE_LIMIT_MAX = 1000;

/** 结构判定：后端是否带边属性能力（纯 SqliteMemoryBackend 不具备 → 调用方退回规则边路径） */
export function asRelationBackend(b: unknown): RelationBackend | null {
  const o = b as Partial<RelationBackend> | null | undefined;
  return o != null && typeof o.upsertRelation === 'function' && typeof o.relationEdges === 'function'
    ? (b as RelationBackend)
    : null;
}

/** 权重合法化：非法（NaN/∞/≤0）→ fail-loud；>1 → 截到 1（权重是比例，不允许放大） */
export function normalizeWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`relation: 非法权重 ${String(weight)}（须为 0 < w ≤ 1 的有限数）`);
  }
  return weight > 1 ? 1 : weight;
}

export class RelationBackend extends SqliteMemoryBackend {
  constructor(dbPath?: string) {
    super(dbPath);
    // 旧库补列（新库已由 SCHEMA_SQL 建列；ALTER 失败 = 表不存在或列已存在 → no-op）
    for (const ddl of [
      'ALTER TABLE memory_relation ADD COLUMN weight REAL',
      'ALTER TABLE memory_relation ADD COLUMN created INTEGER',
      'ALTER TABLE memory_relation ADD COLUMN source TEXT',
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // no-op：列已存在（新库）或表尚未建立（SCHEMA_SQL 前的空库——不会发生，此处仅防御）
      }
    }
  }

  /** link（边写入；UNIQUE(from_id,to_id,type) 重复 → fail-loud——既有语义保持不变） */
  override async link(fromId: string, toId: string, type: string, attrs: RelationAttrs = {}): Promise<void> {
    if (type.length === 0) {
      throw new Error('SqliteMemoryBackend.link: type 不能为空');
    }
    const weight = normalizeWeight(attrs.weight ?? 1);
    try {
      this.db
        .prepare('INSERT INTO memory_relation (from_id, to_id, type, weight, created, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fromId, toId, type, weight, attrs.created ?? Date.now(), attrs.source ?? 'rule');
    } catch (err) {
      throw new Error(
        `RelationBackend.link: 边写入失败（${fromId} → ${toId} / ${type}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 幂等加权建边（相似度驱动的批量建图入口）：边不存在 → 新建；已存在 → 权重取**较大者**
   * （重复建图不衰减、不覆盖既有更强证据），并返回本次是否发生变化。
   * 与 link 的分工：link = fail-loud 单条写入（人工/规则路径），upsertRelation = 幂等批量（维护路径）。
   */
  async upsertRelation(
    fromId: string,
    toId: string,
    type: string,
    attrs: RelationAttrs = {},
  ): Promise<{ created: boolean; updated: boolean; weight: number }> {
    if (type.length === 0) {
      throw new Error('RelationBackend.upsertRelation: type 不能为空');
    }
    const weight = normalizeWeight(attrs.weight ?? 1);
    const cur = this.edgeOf(fromId, toId, type);
    if (cur === undefined) {
      await this.link(fromId, toId, type, { ...attrs, weight });
      return { created: true, updated: false, weight };
    }
    if (weight > cur.weight) {
      this.db
        .prepare('UPDATE memory_relation SET weight = ?, source = ?, created = ? WHERE from_id = ? AND to_id = ? AND type = ?')
        .run(weight, attrs.source ?? cur.source ?? 'rule', attrs.created ?? cur.created ?? Date.now(), fromId, toId, type);
      return { created: false, updated: true, weight };
    }
    return { created: false, updated: false, weight: cur.weight };
  }

  /** 单条边读取（不存在 → undefined） */
  edgeOf(fromId: string, toId: string, type: string): RelationEdge | undefined {
    const r = this.db
      .prepare('SELECT from_id, to_id, type, weight, created, source FROM memory_relation WHERE from_id = ? AND to_id = ? AND type = ?')
      .get(fromId, toId, type) as unknown as RawEdge | undefined;
    return r === undefined ? undefined : toEdge(r);
  }

  /** 边列举（治理面：按 from/to/type/source/最小权重过滤；`from` 与 `to` 同时给出 → 该点对的出边/入边） */
  relationEdges(q: RelationQuery = {}): RelationEdge[] {
    const conds: string[] = [];
    const args: (string | number)[] = [];
    if (q.from !== undefined) {
      conds.push('from_id = ?');
      args.push(q.from);
    }
    if (q.to !== undefined) {
      conds.push('to_id = ?');
      args.push(q.to);
    }
    if (q.type !== undefined) {
      conds.push('type = ?');
      args.push(q.type);
    }
    if (q.source !== undefined) {
      conds.push('source = ?');
      args.push(q.source);
    }
    if (q.minWeight !== undefined) {
      conds.push('COALESCE(weight, 1) >= ?');
      args.push(q.minWeight);
    }
    const limit = Math.min(RELATION_EDGE_LIMIT_MAX, Math.max(1, Math.floor(q.limit ?? RELATION_EDGE_LIMIT_DEFAULT)));
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const orderBy = q.order === 'weight_desc' ? 'ORDER BY COALESCE(weight, 1) DESC, id' : 'ORDER BY id';
    const rows = this.db
      .prepare(`SELECT from_id, to_id, type, weight, created, source FROM memory_relation ${where} ${orderBy} LIMIT ?`)
      .all(...args, limit) as unknown as RawEdge[];
    return rows.map(toEdge);
  }

  /** 单条边删除（治理面 `op=unlink`）：返回是否真的删掉了一行 */
  unlink(fromId: string, toId: string, type: string): boolean {
    const r = this.db
      .prepare('DELETE FROM memory_relation WHERE from_id = ? AND to_id = ? AND type = ?')
      .run(fromId, toId, type);
    return Number(r.changes) > 0;
  }

  /** 边总数（旧库历史行同样计入——"图是不是还是空的"以行数为准） */
  edgeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_relation').get() as { n: number }).n;
  }

  /** 记忆总条数（建图稀疏度判定的分母；只读计数） */
  memoryCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }).n;
  }

  /** 关系图统计（状态面；byType/bySource 升序键，含未迁移历史行的 null 归入 'unknown'） */
  relationStats(): RelationStats {
    const rows = this.db
      .prepare('SELECT type, source, weight FROM memory_relation')
      .all() as unknown as { type: string; source: string | null; weight: number | null }[];
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let weighted = 0;
    let maxWeight: number | null = null;
    let sum = 0;
    for (const r of rows) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      const src = r.source ?? 'unknown';
      bySource[src] = (bySource[src] ?? 0) + 1;
      if (r.weight !== null) {
        weighted++;
        sum += r.weight;
        maxWeight = maxWeight === null ? r.weight : Math.max(maxWeight, r.weight);
      }
    }
    return {
      edges: rows.length,
      byType: sortKeys(byType),
      bySource: sortKeys(bySource),
      weighted,
      maxWeight,
      meanWeight: weighted === 0 ? null : Number((sum / weighted).toFixed(4)),
    };
  }
}

interface RawEdge {
  from_id: string;
  to_id: string;
  type: string;
  weight: number | null;
  created: number | null;
  source: string | null;
}

/** 行 → 边（历史行无属性 → 权重按 1、时间/来源 null——不伪造建边来源） */
function toEdge(r: RawEdge): RelationEdge {
  return {
    from_id: r.from_id,
    to_id: r.to_id,
    type: r.type,
    weight: r.weight === null ? 1 : r.weight,
    created: r.created,
    source: (r.source as RelationSource | null) ?? null,
  };
}

function sortKeys(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) {
    out[k] = counts[k]!;
  }
  return out;
}
