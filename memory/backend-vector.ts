// layer 2（memory/）：向量通道的存储面（已知问题《新增向量检索》/《重构方向：双通道记忆系统》）。
//
// 职责：
//   - 同步编码：写入流水末端的向量落库（`encodePendingBatch` 空闲期批量执行——不入主对话路径）；
//   - 向量检索：暴力余弦（当前量级：10^2~10^3 条为亚毫秒级；实测结论「1 万条约 10–20ms」，
//     到 10 万条再考虑专用索引，本版明确不做）；
//   - 编码缺口可观测：`vectorStats` 给出已编码/待编码计数（状态面可读，回答"向量通道为什么没生效"）。
//
// 与词法通道的关系（双通道融合见 retrieve.ts）：词法（FTS5，精确/术语/代号）与向量（token 集合相似，
// 跨改写/词序）**先融合**成候选，再交给关系图扩展与重排；向量只提升召回，不替代精确匹配。
//
// layer 2（memory/）：仅 node: 内置 + 同层模块 + kernel/schemas/。
import type { Memory } from '../kernel/schemas/m.js';
import { blobToVector, cosineSimilarity, vectorToBlob, type Embedder } from './embeddings.js';
import { RelationBackend } from './backend-relation.js';

/** 单条向量检索命中（score = 余弦相似度，越大越相近） */
export interface VectorHit {
  memory: Memory;
  score: number;
}

/** 编码缺口统计（状态面/观测面） */
export interface VectorStats {
  /** 已编码（vector 列非空）条数 */
  encoded: number;
  /** 待编码（vector 列为空）条数 */
  pending: number;
  /** 向量维度（未编码任何条目 → null） */
  dim: number | null;
  /** 嵌入器标识 */
  embedder: string;
  /** 存量向量维度与当前嵌入器不一致的条数（换过嵌入器 → 陈旧向量，检索侧跳过；>0 表示需重编码） */
  mismatched: number;
  /** 当前嵌入器维度（与 dim 对照可判断是否存在陈旧向量） */
  embedder_dim: number;
}

/** 批量编码上限（单次空闲期调用最多处理条数——防一次维护占用过久；§17 可标定） */
export const VECTOR_ENCODE_BATCH_LIMIT = 200;

/** 编码扫描窗口倍数（审查修复）：单批候选行全部编码失败时向后多看几批——避免"失败行占住批头"
 *  使后面的记忆永远编不上（旧实现每批都重取同一批 NULL 行，失败即静默跳过、不收敛）。
 *  仍以"成功编码 limit 条"为出口，故单次工作量有界（≤ limit × 该倍数）。 */
export const VECTOR_ENCODE_SCAN_FACTOR = 4;

/** 向量读取批大小（单条 SQL 的 IN 占位上限；关系建图按批取向量） */
export const VECTOR_READ_CHUNK = 100;

export class VectorBackend extends RelationBackend {
  /** 嵌入器（唯一替换点；缺省 CPU 哈希词袋——见 embeddings.ts 的选型说明） */
  private readonly embedder: Embedder;

  constructor(dbPath: string, embedder: Embedder) {
    super(dbPath);
    this.embedder = embedder;
  }

  /** 当前生效的嵌入器标识（状态面/观测面） */
  get embedderId(): string {
    return this.embedder.id;
  }

  /**
   * 空闲期批量编码（维护任务调用；也可由装配面在启动后调用一次）。
   * 只处理 vector 列为空的行（新写入 / payload 更新后清空者）；逐条 embed 后写回。
   * 返回 { encoded, remaining }——remaining > 0 表示还有待编码（下次维护继续）。
   * 失败语义：单条编码失败 → 跳过该条（不阻塞整批）；写库失败 → 抛（调用方按维护任务失败处理）。
   */
  async encodePendingBatch(opts: { limit?: number } = {}): Promise<{ encoded: number; remaining: number }> {
    return this.encodePending(this.embedder, opts);
  }

  /**
   * 内部批量编码（显式嵌入器版本——测试与「换嵌入器后重编码」场景用）。
   */
  async encodePending(
    embedder: Embedder,
    opts: { limit?: number } = {},
  ): Promise<{ encoded: number; remaining: number }> {
    const limit = Math.max(1, Math.floor(opts.limit ?? VECTOR_ENCODE_BATCH_LIMIT));
    // 扫描窗口（审查修复）：把候选行一次取到 limit×4（最坏情况 = 连续 800 条编码失败），
    // 逐条编码直到成功 limit 条或窗口用尽——失败行不再屏蔽其后的记忆（原来每批都重取同一批 NULL 行）。
    const rows = this.db
      .prepare('SELECT id, payload FROM memory WHERE vector IS NULL ORDER BY updated DESC, id ASC LIMIT ?')
      .all(limit * VECTOR_ENCODE_SCAN_FACTOR) as unknown as { id: string; payload: string }[];
    let encoded = 0;
    const update = this.db.prepare('UPDATE memory SET vector = ? WHERE id = ?');
    for (const r of rows) {
      if (encoded >= limit) break; // 本批目标已达成（其余留待下次维护）
      try {
        update.run(vectorToBlob(embedder.embed(r.payload)), r.id);
        encoded++;
      } catch {
        // 单条编码失败 → 跳过（该条保持待编码，状态面可见；不阻塞其余条目）
      }
    }
    const remaining = (this.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE vector IS NULL').get() as { n: number }).n;
    return { encoded, remaining };
  }

  /** 立即编码单条记忆（写入面同步编码用：新写入即编码，避免等待空闲期；未知 id → false） */
  encodeOne(id: string): boolean {
    const row = this.db.prepare('SELECT payload FROM memory WHERE id = ?').get(id) as { payload: string } | undefined;
    if (row === undefined) return false;
    this.db.prepare('UPDATE memory SET vector = ? WHERE id = ?').run(vectorToBlob(this.embedder.embed(row.payload)), id);
    return true;
  }

  /**
   * 向量检索（暴力余弦；scope/kind 过滤在 SQL 侧先缩小候选，再做相似度计算）。
   * 只扫 vector 非空的行（未编码条目不出现在结果里——诚实缺失，状态面可观测待编码数）。
   * @param topK 返回上限（默认 20；融合层再按预算裁剪）
   */
  async vectorSearch(
    text: string,
    opts: { scope?: string; kinds?: readonly string[]; lifecycles?: readonly string[]; provClasses?: readonly string[]; topK?: number } = {},
  ): Promise<VectorHit[]> {
    return this.vectorSearchWith(this.embedder, text, opts);
  }

  /** 显式嵌入器版本的向量检索（测试注入用；语义同 vectorSearch）。
   *  过滤面与词法通道对齐（审查修复）：scope / kind / lifecycle / prov_class 同款四维过滤——
   *  否则调用方传 lifecycle='Active' 时，词法候选被过滤而向量候选仍把 Frozen/Suspicious 拉进融合池。 */
  async vectorSearchWith(
    embedder: Embedder,
    text: string,
    opts: {
      scope?: string;
      kinds?: readonly string[];
      lifecycles?: readonly string[];
      provClasses?: readonly string[];
      topK?: number;
    } = {},
  ): Promise<VectorHit[]> {
    const query = embedder.embed(text);
    let norm = 0;
    for (let i = 0; i < query.length; i++) norm += (query[i] ?? 0) * (query[i] ?? 0);
    if (norm === 0) return []; // 空/无 token 查询 → 无向量候选
    const conds: string[] = ['vector IS NOT NULL'];
    const args: (string | number)[] = [];
    if (opts.scope !== undefined) {
      conds.push('scope = ?');
      args.push(opts.scope);
    }
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      conds.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      args.push(...opts.kinds);
    }
    if (opts.lifecycles !== undefined && opts.lifecycles.length > 0) {
      conds.push(`lifecycle IN (${opts.lifecycles.map(() => '?').join(', ')})`);
      args.push(...opts.lifecycles);
    }
    if (opts.provClasses !== undefined && opts.provClasses.length > 0) {
      conds.push(`prov_class IN (${opts.provClasses.map(() => '?').join(', ')})`);
      args.push(...opts.provClasses);
    }
    const rows = this.db
      .prepare(`SELECT body, vector FROM memory WHERE ${conds.join(' AND ')}`)
      .all(...args) as unknown as { body: string; vector: unknown }[];
    const hits: VectorHit[] = [];
    for (const r of rows) {
      const vec = blobToVector(r.vector);
      if (vec === null) continue;
      if (vec.length !== query.length) {
        // 陈旧/异维向量（换过嵌入器）：跳过该行而不是让整条通道抛错（审查修复 H1）——
        // 单行不可比不应使向量通道整体消失；缺口由 vectorStats().mismatched 暴露，供人工重编码。
        continue;
      }
      const score = cosineSimilarity(query, vec);
      if (!Number.isFinite(score)) continue; // 坏 BLOB 解出的 NaN/Inf 不入候选（审查修复）
      if (score <= 0) continue; // 非正相似 → 不入候选（负相关不是"相近"）
      hits.push({ memory: JSON.parse(r.body) as Memory, score });
    }
    hits.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
    const topK = Math.max(1, Math.floor(opts.topK ?? 20));
    return hits.slice(0, topK);
  }

  /** 待编码条数（同步只读——入队判断用；状态面亦可读） */
  pendingEncodeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE vector IS NULL').get() as { n: number }).n;
  }

  /**
   * 批量读取已存向量（关系建图的向量证据来源；未编码/未知 id 不在结果里——诚实缺失，
   * 建图侧据此退回纯词法证据，不假装有向量）。分块 IN 查询，避免单条 SQL 占位过多。
   */
  vectorsFor(ids: readonly string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += VECTOR_READ_CHUNK) {
      const chunk = uniq.slice(i, i + VECTOR_READ_CHUNK);
      const rows = this.db
        .prepare(`SELECT id, vector FROM memory WHERE id IN (${chunk.map(() => '?').join(', ')})`)
        .all(...chunk) as unknown as { id: string; vector: unknown }[];
      for (const r of rows) {
        const v = blobToVector(r.vector);
        if (v !== null) out.set(r.id, v);
      }
    }
    return out;
  }

  /** 编码缺口统计（状态面：向量通道是否可用、还差多少条没编码）。
   *  审查修复：`dim` 只在**与当前嵌入器一致**时给出，并单列 `mismatched`（存量向量维度 ≠ 当前嵌入器
   *  维度——换过嵌入器后的陈旧向量，检索侧会跳过它们）。否则状态面会出现
   *  "embedder=probe-dim64 但 dim=256"这种自相矛盾的报告，把"通道已失效"读成"通道正常"。 */
  vectorStats(): VectorStats {
    const encoded = (this.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE vector IS NOT NULL').get() as { n: number }).n;
    const pending = (this.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE vector IS NULL').get() as { n: number }).n;
    const mismatched = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM memory WHERE vector IS NOT NULL AND length(vector) <> ?')
        .get(this.embedder.dim * 4) as { n: number }
    ).n;
    return {
      encoded,
      pending,
      // dim 语义保持既有契约：无编码条目 → null（保持"尚无向量"的既有断言）；有编码但存在异维陈旧向量
      // → null（不能报告一个与库里内容不符的维度，否则把"通道已失效"读成"通道正常"）
      dim: encoded === 0 || mismatched > 0 ? null : this.embedder.dim,
      embedder: this.embedder.id,
      mismatched,
      embedder_dim: this.embedder.dim,
    };
  }
}
