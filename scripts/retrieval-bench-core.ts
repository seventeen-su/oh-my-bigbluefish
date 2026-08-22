// OMB v2 中文技术检索基准核心（§17 开放项「中文 BM25 分词」测量脚手架；施工计划 T8.16 后续对比）。
// 目标：对比 ngram（生产双侧 bigram）/ jieba / 混合方案在 Recall@K、MRR、任务成功率与成本上的差异，
// 数据驱动决定最终分词方案。jieba/hybrid 未安装时如实返回空分词（度量全零 + note 标注未安装），不伪造分数。
// 度量口径（确定性：同数据同参数 → 同数字；FTS5 排序 rank 稳定）：
//   recall_at_5 = |命中∩相关| / |相关|（K=5）；mrr = 首个相关文档位置倒数（未命中 0）；hits = 首条即相关。
// layer 2（memory/ 供 tokenize；scripts 引入）：核心逻辑可被测试直接调用（bench-report-core 同款先例）。
import { tokenizeForFts } from '../memory/cjk-ngram.js';
import { DatabaseSync } from 'node:sqlite';

export type TokenizerKind = 'ngram' | 'jieba' | 'hybrid';

export interface BenchDoc {
  id: string;
  text: string;
}

export interface BenchQuery {
  id: string;
  text: string;
  relevant: string[];
}

export interface QueryMetrics {
  query_id: string;
  hits: boolean;
  recall_at_5: number;
  mrr: number;
  tokenizer_ms: number;
  query_tokens: number;
}

export interface BenchSummary {
  queries: number;
  hits: number;
  mean_recall_at_5: number;
  mean_mrr: number;
  mean_tokenizer_ms: number;
}

export interface BenchResult {
  kind: TokenizerKind;
  note: string;
  metrics: QueryMetrics[];
  summary: BenchSummary;
}

/** 分词器工厂（可插拔；jieba/hybrid 未安装 → 空分词占位 + 明示未安装，不伪造） */
export function makeTokenizer(kind: TokenizerKind): { tokenize: (text: string) => string; note: string } {
  switch (kind) {
    case 'ngram':
      return { tokenize: tokenizeForFts, note: '生产双侧 bigram（T8.16 落地；单字查询不命中为文档化限制）' };
    case 'jieba':
      return { tokenize: () => '', note: 'jieba 未安装（新依赖边界，报告主会话后接入）' };
    case 'hybrid':
      return { tokenize: () => '', note: '混合方案未定型（基准对比数据产出后决定）' };
  }
}

const K = 5;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/** 运行一次基准（单分词器）：FTS5 双侧索引 → 逐查询 MATCH 排序 → Recall@K/MRR/命中/成本。
 *  FTS5 查询非法（如空串/语法）→ 该查询零结果（不抛；度量如实为零）。 */
export function runRetrievalBench(
  docs: readonly BenchDoc[],
  queries: readonly BenchQuery[],
  kind: TokenizerKind,
): BenchResult {
  const { tokenize, note } = makeTokenizer(kind);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE docs_fts USING fts5(id UNINDEXED, content)');
    const insert = db.prepare('INSERT INTO docs_fts (id, content) VALUES (?, ?)');
    for (const d of docs) {
      insert.run(d.id, tokenize(d.text));
    }
    const search = db.prepare('SELECT id FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?');
    const metrics: QueryMetrics[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      const tokens = tokenize(q.text);
      const tokenizerMs = performance.now() - t0;
      let ranked: string[] = [];
      if (tokens.trim().length > 0) {
        try {
          ranked = (search.all(tokens, K) as Array<{ id: string }>).map((r) => r.id);
        } catch {
          ranked = []; // FTS5 查询非法（语法/无匹配）→ 零结果，如实记录
        }
      }
      const first = q.relevant.findIndex((id) => ranked.includes(id));
      const hits = ranked.filter((id) => q.relevant.includes(id));
      metrics.push({
        query_id: q.id,
        hits: first >= 0,
        recall_at_5: q.relevant.length === 0 ? 0 : hits.length / q.relevant.length,
        mrr: first >= 0 ? 1 / (first + 1) : 0,
        tokenizer_ms: tokenizerMs,
        query_tokens: tokens.split(/\s+/).filter((s) => s.length > 0).length,
      });
    }
    return {
      kind,
      note,
      metrics,
      summary: {
        queries: metrics.length,
        hits: metrics.filter((m) => m.hits).length,
        mean_recall_at_5: mean(metrics.map((m) => m.recall_at_5)),
        mean_mrr: mean(metrics.map((m) => m.mrr)),
        mean_tokenizer_ms: mean(metrics.map((m) => m.tokenizer_ms)),
      },
    };
  } finally {
    db.close();
  }
}

/** 全方案对比（ngram/jieba/hybrid 各跑一次 → 汇总表数据；jieba/hybrid 未安装时如实全零） */
export function runComparison(
  docs: readonly BenchDoc[],
  queries: readonly BenchQuery[],
): BenchResult[] {
  return (['ngram', 'jieba', 'hybrid'] as const).map((kind) => runRetrievalBench(docs, queries, kind));
}
