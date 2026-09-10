// OMB v2 检索域存储操作（架构 §7.4 Retrieval Episode / memory_stats 计数 / §7.3 检索按 id 回捞）。
// 拆分说明（CONVENTIONS §9 LOC ≤ 400）：T3.1 已将 sql.ts 拆出 backend.ts 控预算；T3.4 需在类上新增
// 6 个检索域方法（getById/insertEpisode/getEpisode/updateEpisodeOutcome/bumpStats/getStats），
// 若直接加入 backend.ts 会使其超出 400 行，故以 SqliteMemoryBackend 子类承载（方法需访问受保护 db
// 句柄，子类是保持封装的拆分方式，记录在 T3.4 报告）。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import type { Memory } from '../kernel/schemas/m.js';
import type { EnvironmentFieldDelta } from '../kernel/schemas/evolution.js';
import type { ArtifactRef } from '../kernel/schemas/evolution.js';
import { DEFAULT_EMBEDDER, type Embedder } from './embeddings.js';
import { VectorBackend } from './backend-vector.js';

/** retrieval_episode 行（数组列在 DB 中以 JSON 存储，此处为解析后形态，§7.4 Retrieval Episode） */
export interface EpisodeRow {
  id: string;
  query: string;
  scope: string;
  candidate_ids: string[];
  ranked_ids: string[];
  injected_ids: string[];
  outcome: string | null;
  created: number;
}

/** memory_stats 行（bumpUtility 同步用） */
export interface StatsRow {
  id: string;
  retrievals: number;
  hits: number;
  misses: number;
  last_retrieved: number | null;
}

/** retrieval_episode 原始行（DB 形态：数组列为 TEXT） */
interface EpisodeRowRaw {
  id: string;
  query: string;
  scope: string;
  candidate_ids: string;
  ranked_ids: string;
  injected_ids: string;
  outcome: string | null;
  created: number;
}

/** LIKE 模式转义（%/_/反斜杠字面匹配；配合 SQL `ESCAPE '\'` 使用） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 记忆后端 + 检索域存储操作（T3.4 检索路由/效用反馈用；其余方法继承 SqliteMemoryBackend）。
 *  向量通道（已知问题《新增向量检索》）：继承 VectorBackend——构造注入嵌入器（缺省 CPU 哈希词袋），
 *  提供 vectorSearch / encodePendingBatch / vectorStats；词法与向量在 retrieve 的语义检索组内融合。 */
export class RetrievalBackend extends VectorBackend {
  constructor(dbPath: string, embedder: Embedder = DEFAULT_EMBEDDER) {
    super(dbPath, embedder);
  }
  /**
   * R5：环境声明索引定位受影响对象（Predictive Invalidation §14.5/§15.4）——按指纹 delta 字段
   * 匹配声明环境的 memory 记录（environment 列，ingest 时写入 provenance.environment 的固定字段序 JSON）。
   * 匹配语义（诚实）：delta 字段 f 的旧值 = 记录声明值（声明了旧环境的记录在新环境下可能失效）；
   * delta.from === undefined（可选键新增）→ 匹配「未声明该键」的记录（曾在无该键环境下验证）。
   * 返回 ArtifactRef[]（id = memory id，kind = 'memory'）；无 delta / 无声明匹配 → 空数组（不臆造）。
   * 检索消费面：suspicious 降级后 retrieve.ts 的 Memory Value 已按 lifecycle 扣 pollution 降权（§7.4）。
   */
  async findAffectedObjects(delta: Record<string, EnvironmentFieldDelta>): Promise<ArtifactRef[]> {
    const fields = Object.keys(delta);
    if (fields.length === 0) {
      return [];
    }
    const rows: { id: string }[] = [];
    for (const f of fields) {
      const d = delta[f]!;
      if (d.from === undefined) {
        // 字段新增（from=无）→ 受影响 = 未声明该键的记录（LIKE 子串匹配不到 `"<key>":`）
        const pat = `%${escapeLike(`"${f}":`)}%`;
        rows.push(
          ...(this.db
            .prepare(`SELECT id FROM memory WHERE environment IS NOT NULL AND environment NOT LIKE ? ESCAPE '\\'`)
            .all(pat) as unknown as { id: string }[]),
        );
      } else {
        // 字段从旧值变为新值 → 受影响 = 声明旧值的记录（`"<key>":"<旧值>"` 子串匹配）
        const pat = `%${escapeLike(`"${f}":"${JSON.stringify(d.from).slice(1, -1)}"`)}%`;
        rows.push(
          ...(this.db
            .prepare(`SELECT id FROM memory WHERE environment LIKE ? ESCAPE '\\'`)
            .all(pat) as unknown as { id: string }[]),
        );
      }
    }
    // 去重（同一记录可能命中多个 delta 字段）
    const seen = new Map<string, ArtifactRef>();
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.set(r.id, { id: r.id, kind: 'memory' });
      }
    }
    return [...seen.values()];
  }

  /** getById：按 id 取完整 Memory（relation/expansion 检索需按 id 回捞；未知 id → undefined） */
  async getById(id: string): Promise<Memory | undefined> {
    const row = this.db.prepare('SELECT body FROM memory WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Memory) : undefined;
  }

  /** insertEpisode：写 retrieval_episode 行（§7.4；Retrieve 算子每次记录） */
  async insertEpisode(ep: EpisodeRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO retrieval_episode (id, query, scope, candidate_ids, ranked_ids, injected_ids, outcome, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ep.id, ep.query, ep.scope, JSON.stringify(ep.candidate_ids), JSON.stringify(ep.ranked_ids),
        JSON.stringify(ep.injected_ids), ep.outcome, ep.created,
      );
  }

  /** getEpisode：读 retrieval_episode 行（数组列 JSON 解析）；未知 id → undefined */
  async getEpisode(id: string): Promise<EpisodeRow | undefined> {
    const row = this.db
      .prepare(
        'SELECT id, query, scope, candidate_ids, ranked_ids, injected_ids, outcome, created FROM retrieval_episode WHERE id = ?',
      )
      .get(id) as EpisodeRowRaw | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      query: row.query,
      scope: row.scope,
      candidate_ids: JSON.parse(row.candidate_ids) as string[],
      ranked_ids: JSON.parse(row.ranked_ids) as string[],
      injected_ids: JSON.parse(row.injected_ids) as string[],
      outcome: row.outcome,
      created: row.created,
    };
  }

  /** updateEpisodeOutcome：reportEpisodeOutcome 更新 outcome 列；未知 id fail-loud */
  async updateEpisodeOutcome(id: string, outcome: string): Promise<void> {
    const r = this.db.prepare('UPDATE retrieval_episode SET outcome = ? WHERE id = ?').run(outcome, id);
    if (r.changes === 0) {
      throw new Error(`RetrievalBackend.updateEpisodeOutcome: episode 不存在: ${id}`);
    }
  }

  /** bumpStats：memory_stats 计数器 +1（retrievals/hits/misses，bumpUtility 同步用）并刷新 last_retrieved；
   *  行不存在则先创建（INSERT OR IGNORE）。counter 为白名单字面量，拼接安全。 */
  async bumpStats(id: string, counter: 'retrievals' | 'hits' | 'misses'): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO memory_stats (id) VALUES (?)').run(id);
    this.db
      .prepare(`UPDATE memory_stats SET ${counter} = ${counter} + 1, last_retrieved = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  /** getStats：读 memory_stats 行；未知 id → undefined */
  async getStats(id: string): Promise<StatsRow | undefined> {
    return this.db
      .prepare('SELECT id, retrievals, hits, misses, last_retrieved FROM memory_stats WHERE id = ?')
      .get(id) as StatsRow | undefined;
  }

  /** listEpisodes：全量 retrieval_episode 行（T8.21 generalization 采集源——跨 scope episode 归因统计；
   *  数组列 JSON 解析；created ASC, id ASC 确定性排序） */
  async listEpisodes(): Promise<EpisodeRow[]> {
    const rows = this.db
      .prepare(
        'SELECT id, query, scope, candidate_ids, ranked_ids, injected_ids, outcome, created FROM retrieval_episode ORDER BY created ASC, id ASC',
      )
      .all() as unknown as EpisodeRowRaw[];
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      scope: r.scope,
      candidate_ids: JSON.parse(r.candidate_ids) as string[],
      ranked_ids: JSON.parse(r.ranked_ids) as string[],
      injected_ids: JSON.parse(r.injected_ids) as string[],
      outcome: r.outcome,
      created: r.created,
    }));
  }
}
