// layer 2：Negative Pattern 落库（T8.8；架构 §9.2 演化信号 / CapabilityGap 输入）。
// operator-executor 整图失败 → 失败样本写入 negative_pattern 表（memory/sql.ts DDL）：
//   graph hash / 失败算子 / 错误 / 环境 / 时间 + provenance 链（表行 → 事件/过程引用，可回溯）。
// id = 内容寻址（sha256(canonical{graph_hash, failed_operator, code, message})）——同失败重复 → 同 id
//   → INSERT OR IGNORE 幂等去重（同一失败只留一条样本）。
// 本模块为存储面（node:sqlite 同步 API，方法按约定保持 Promise）；记录构造在执行器侧
// （runtime/operator-executor.ts 经注入 sink 调用本后端）。
// layer 2（memory/）：仅 import node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SCHEMA_SQL } from './sql.js';

/** Negative Pattern 记录（表行保真重建依据；provenance = 回溯链：事件/过程引用） */
export interface NegativePatternRecord {
  /** 内容寻址 id（sha256:<64hex>；同失败幂等） */
  id: string;
  /** 失败算子图 hash（sha256(canonicalJson(graph))） */
  graph_hash: string;
  /** 失败算子（整图级失败无算子 → 'graph'） */
  failed_operator: string;
  /** 错误码（E_OPERATOR / BUDGET_EXCEEDED / TIMEOUT / …） */
  code: string;
  /** 错误消息 */
  message: string;
  /** 环境指纹（os/node/dsh_version/project） */
  environment: { os: string; node: string; dsh_version: string; project: string };
  /** 失败时刻（epoch ms） */
  created: number;
  /** 回溯链：表行 → 事件（process/operator/failed:<op>）/ 过程引用（graph_id 或 entry→exit） */
  provenance: {
    source: string;
    event: string;
    process_ref: string;
    graph_hash: string;
    timestamp: string;
    transformation_chain: string[];
    verification: string;
  };
}

/** 查询过滤（全可选；组合 = AND） */
export interface NegativePatternQuery {
  graph_hash?: string;
  failed_operator?: string;
  code?: string;
  limit?: number;
}

const BUSY_TIMEOUT_MS = 5000;

export class NegativePatternBackend {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(SCHEMA_SQL); // 含 negative_pattern 表（IF NOT EXISTS 幂等；与 memory.db 同 schema）
  }

  /** 写失败样本（内容寻址幂等：同 id 重复 → no-op） */
  async write(record: NegativePatternRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO negative_pattern
           (id, graph_hash, failed_operator, code, message, environment, created, provenance, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.graph_hash,
        record.failed_operator,
        record.code,
        record.message,
        JSON.stringify(record.environment),
        record.created,
        JSON.stringify(record.provenance),
        JSON.stringify(record),
      );
  }

  /** 查询失败样本（过滤 + limit；body 保真重建完整记录） */
  async query(filter: NegativePatternQuery = {}): Promise<NegativePatternRecord[]> {
    const conds: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.graph_hash !== undefined) {
      conds.push('graph_hash = ?');
      args.push(filter.graph_hash);
    }
    if (filter.failed_operator !== undefined) {
      conds.push('failed_operator = ?');
      args.push(filter.failed_operator);
    }
    if (filter.code !== undefined) {
      conds.push('code = ?');
      args.push(filter.code);
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    const limit = filter.limit !== undefined ? filter.limit : 100;
    const rows = this.db
      .prepare(`SELECT body FROM negative_pattern${where} ORDER BY created ASC LIMIT ?`)
      .all(...args, limit) as unknown as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as NegativePatternRecord);
  }

  /** 表行数 */
  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM negative_pattern').get() as { n: number };
    return row.n;
  }

  /** 关闭连接（幂等） */
  async close(): Promise<void> {
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}
