// T8.16 后续：中文技术检索基准脚手架测试（§17「中文 BM25 分词」测量脚手架）。
// 断言：ngram（生产双侧 bigram）在冻结数据上产出确定性指标（同数据两次 → 同数字）；
// jieba/hybrid 未安装 → 如实全零 + note 明示未安装（不伪造分数）；Recall/MRR 值域合法。
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runComparison, runRetrievalBench, type BenchDoc, type BenchQuery } from '../../scripts/retrieval-bench-core.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = join(HERE, '..', 'kernel', 'retrieval-bench');

async function loadData(): Promise<{ docs: BenchDoc[]; queries: BenchQuery[] }> {
  const docs = JSON.parse(await readFile(join(DATA_DIR, 'docs.json'), 'utf8')) as BenchDoc[];
  const queries = JSON.parse(await readFile(join(DATA_DIR, 'queries.json'), 'utf8')) as BenchQuery[];
  return { docs, queries };
}

describe('中文技术检索基准脚手架（§17 分词选型）', () => {
  it('ngram（生产双侧 bigram）：冻结数据上产出确定性指标（两次运行除计时外同数字）且 Recall/MRR 值域合法', async () => {
    const { docs, queries } = await loadData();
    const a = runRetrievalBench(docs, queries, 'ngram');
    const b = runRetrievalBench(docs, queries, 'ngram');
    // 确定性：除 tokenizer_ms（计时抖动）外逐字段一致
    expect({ ...a, metrics: a.metrics.map((m) => ({ ...m, tokenizer_ms: 0 })) }).toEqual({
      ...b,
      metrics: b.metrics.map((m) => ({ ...m, tokenizer_ms: 0 })),
    });
    expect(a.summary.queries).toBe(queries.length);
    for (const m of a.metrics) {
      expect(m.recall_at_5).toBeGreaterThanOrEqual(0);
      expect(m.recall_at_5).toBeLessThanOrEqual(1);
      expect(m.mrr).toBeGreaterThanOrEqual(0);
      expect(m.mrr).toBeLessThanOrEqual(1);
      expect(m.tokenizer_ms).toBeGreaterThanOrEqual(0);
    }
    // 中文子串命中基线：至少一半查询有召回（bigram 双侧分词对双字/短语查询应命中）
    expect(a.summary.mean_recall_at_5).toBeGreaterThan(0.5);
    expect(a.summary.mean_mrr).toBeGreaterThan(0);
  });

  it('jieba/hybrid 未安装 → 如实全零 + note 明示（不伪造分数）', async () => {
    const { docs, queries } = await loadData();
    for (const kind of ['jieba', 'hybrid'] as const) {
      const r = runRetrievalBench(docs, queries, kind);
      expect(r.summary.hits).toBe(0);
      expect(r.summary.mean_recall_at_5).toBe(0);
      expect(r.summary.mean_mrr).toBe(0);
      expect(r.note).toMatch(/未安装|未定型/);
    }
  });

  it('对比运行：三方案齐备（ngram 有数据；jieba/hybrid 占位零）', async () => {
    const { docs, queries } = await loadData();
    const results = runComparison(docs, queries);
    expect(results.map((r) => r.kind)).toEqual(['ngram', 'jieba', 'hybrid']);
    expect(results[0]!.summary.mean_mrr).toBeGreaterThan(0);
    expect(results[1]!.summary.mean_mrr).toBe(0);
    expect(results[2]!.summary.mean_mrr).toBe(0);
  });
});
