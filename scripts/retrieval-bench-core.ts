// OMB v2 中文技术检索基准核心（§17 开放项「中文 BM25 分词」测量脚手架；施工计划 T8.16 后续对比）。
// 目标：对比 ngram（生产双侧 bigram）/ jieba / 混合方案在 Recall@K、MRR、任务成功率与成本上的差异，
// 数据驱动决定最终分词方案。jieba 已接入（jieba-wasm 2.4.0，devDependency、仅基准工具链）；未安装/
// 加载失败时如实返回空分词（度量全零 + note 标注未安装），不伪造分数。hybrid 暂定为 jieba 词级 ∪ ngram
// bigram 并集（去重；FTS5 默认 AND 语义），方案定义待主会话/用户裁决。
// 度量口径（确定性：同数据同参数 → 同数字；FTS5 排序 rank 稳定）：
//   recall_at_5 = |命中∩相关| / |相关|（K=5）；mrr = 首个相关文档位置倒数（未命中 0）；hits = 首条即相关。
// layer 2（memory/ 供 tokenize；scripts 引入）：核心逻辑可被测试直接调用（bench-report-core 同款先例）。
import { createRequire } from 'node:module';
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

// --- jieba 适配层 ---
// 选型：jieba-wasm@2.4.0（jieba-rs 引擎的预编译 WASM，无构建链/无 allowBuilds；同步 cut API）。
// 弃用说明：npm 'jieba'@1.0.0 与 'jieba-js'@1.0.2 均为发布缺 main 入口的坏包（实测 require 即崩），故不采用。
// 加载：createRequire 同步 require CJS glue（ESM 内兼容）；惰性 + try/catch → 未安装/坏包降级为空分词占位。
interface JiebaLike {
  cut: (text: string) => string[];
}

const nodeRequire = createRequire(import.meta.url);
let jiebaModule: JiebaLike | null | undefined; // undefined=未尝试；null=加载失败/不可用

function loadJieba(): JiebaLike | null {
  if (jiebaModule === undefined) {
    try {
      const mod = nodeRequire('jieba-wasm') as unknown as JiebaLike;
      if (typeof mod.cut !== 'function') {
        throw new Error('jieba-wasm 缺少 cut API');
      }
      jiebaModule = mod;
    } catch {
      jiebaModule = null; // 未安装/坏包 → 降级占位（度量如实零）
    }
  }
  return jiebaModule;
}

/** jieba 分词 → 空格连接 token 串（FTS5 列/查询双侧同用）；过滤纯标点 token；未安装 → '' */
function tokenizeWithJieba(text: string): string {
  const jieba = loadJieba();
  if (!jieba) {
    return '';
  }
  try {
    return jieba
      .cut(text)
      .filter((t) => /[a-zA-Z0-9\u3400-\u4dbf\u4e00-\u9fff]/.test(t))
      .join(' ');
  } catch {
    return ''; // 分词异常 → 空（如实）
  }
}

/** 混合方案（暂定）：jieba 词级 ∪ ngram bigram 并集（保序去重）；jieba 不可用 → 空（如实全零） */
function tokenizeHybrid(text: string): string {
  const jiebaTokens = tokenizeWithJieba(text);
  if (jiebaTokens === '') {
    return '';
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of [...jiebaTokens.split(/\s+/), ...tokenizeForFts(text).split(/\s+/)]) {
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out.join(' ');
}

/** jieba 一次性初始化成本（wasm 实例化 + 词典加载，首次 cut 时产生）；未安装 → null */
export function jiebaInitCostMs(): number | null {
  const jieba = loadJieba();
  if (!jieba) {
    return null;
  }
  const t0 = performance.now();
  try {
    jieba.cut('分词初始化冒烟');
  } catch {
    return null;
  }
  return performance.now() - t0;
}

/** 分词器工厂（可插拔；jieba 未安装 → 空分词占位 + 明示未安装，不伪造） */
export function makeTokenizer(kind: TokenizerKind): { tokenize: (text: string) => string; note: string } {
  switch (kind) {
    case 'ngram':
      return { tokenize: tokenizeForFts, note: '生产双侧 bigram（T8.16 落地；单字查询不命中为文档化限制）' };
    case 'jieba':
      return loadJieba() !== null
        ? { tokenize: tokenizeWithJieba, note: 'jieba（jieba-wasm 2.4.0，devDependency 仅基准工具链；cut 默认模式，过滤纯标点 token）' }
        : { tokenize: () => '', note: 'jieba 未安装（新依赖边界，报告主会话后接入；度量如实为零）' };
    case 'hybrid':
      return loadJieba() !== null
        ? { tokenize: tokenizeHybrid, note: '混合方案（暂定：jieba 词级 ∪ ngram bigram 并集去重；FTS5 默认 AND 语义；定义待主会话裁决）' }
        : { tokenize: () => '', note: '混合方案未定型（jieba 未安装，度量如实为零；接入后重跑基准）' };
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
