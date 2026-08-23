// OMB v2 中文技术检索基准 CLI（§17「中文 BM25 分词」测量脚手架）。
// 用法：`pnpm exec tsx scripts/retrieval-bench.ts [ngram|jieba|hybrid]`（缺省跑全部方案对比）。
// 输出：workspace/.omb/retrieval-bench/report-<date>.md（各方案 Recall@K/MRR/成功率/成本 + 对比表）。
// 数据：kernel/retrieval-bench/{docs,queries}.json（冻结于仓库；改数据须随提交，保证可复现）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { jiebaInitCostMs, runComparison, runRetrievalBench, type BenchResult, type TokenizerKind } from './retrieval-bench-core.js';

/** 仓库根（本文件在 <preset>/scripts/ → 上一级即 preset 根） */
const HERE = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = join(HERE, 'kernel', 'retrieval-bench');
const OUT_DIR = join(HERE, 'workspace', '.omb', 'retrieval-bench');

interface BenchDoc { id: string; text: string }
interface BenchQuery { id: string; text: string; relevant: string[] }

async function loadData(): Promise<{ docs: BenchDoc[]; queries: BenchQuery[] }> {
  const docs = JSON.parse(await readFile(join(DATA_DIR, 'docs.json'), 'utf8')) as BenchDoc[];
  const queries = JSON.parse(await readFile(join(DATA_DIR, 'queries.json'), 'utf8')) as BenchQuery[];
  return { docs, queries };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function renderResult(r: BenchResult): string {
  const lines = [
    `## ${r.kind}`,
    '',
    `> ${r.note}`,
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 查询数 | ${r.summary.queries} |`,
    `| 命中（首条相关） | ${r.summary.hits}/${r.summary.queries} (${pct(r.summary.queries === 0 ? 0 : r.summary.hits / r.summary.queries)}) |`,
    `| Recall@5 均值 | ${pct(r.summary.mean_recall_at_5)} |`,
    `| MRR 均值 | ${r.summary.mean_mrr.toFixed(4)} |`,
    `| 分词耗时均值 | ${r.summary.mean_tokenizer_ms.toFixed(2)}ms |`,
    '',
    '逐查询：',
    '',
    '| query | recall@5 | mrr | hits | tokens |',
    '| --- | --- | --- | --- | --- |',
    ...r.metrics.map((m) => `| ${m.query_id} | ${pct(m.recall_at_5)} | ${m.mrr.toFixed(4)} | ${m.hits ? '✓' : '✗'} | ${m.query_tokens} |`),
    '',
  ];
  return lines.join('\n');
}

function renderComparison(results: BenchResult[]): string {
  const lines = [
    '## 方案对比',
    '',
    '| 方案 | 命中率 | Recall@5 均值 | MRR 均值 | 分词耗时均值 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => {
      const s = r.summary;
      const hitRate = s.queries === 0 ? 0 : s.hits / s.queries;
      return `| ${r.kind} | ${pct(hitRate)} | ${pct(s.mean_recall_at_5)} | ${s.mean_mrr.toFixed(4)} | ${s.mean_tokenizer_ms.toFixed(2)}ms | ${r.note} |`;
    }),
    '',
    '> 决策标准（§17）：Recall@K、MRR、任务成功率与成本综合对比后定最终分词方案；',
    '> jieba 基于 jieba-wasm 2.4.0（devDependency 仅基准工具链）实测；未安装时如实为零（不伪造分数）。',
    '',
  ];
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<string> {
  const { docs, queries } = await loadData();
  const arg = argv[2];
  const jiebaInitMs = jiebaInitCostMs(); // 顺带预热 wasm/词典，使逐查询分词耗时反映稳态成本
  const results = arg === undefined
    ? runComparison(docs, queries)
    : [runRetrievalBench(docs, queries, arg as TokenizerKind)];
  const md = [
    '# OMB v2 中文技术检索基准（§17 分词选型测量）',
    '',
    `> 生成时间：${new Date().toISOString()} ｜ 数据：kernel/retrieval-bench/ ｜ 参数：K=5`,
    jiebaInitMs === null ? '' : `> jieba 一次性初始化（wasm 实例化 + 词典加载）：${jiebaInitMs.toFixed(1)}ms（不计入逐查询分词均值）`,
    '',
    ...results.flatMap((r) => [renderResult(r), '---', '']),
    renderComparison(results),
  ].join('\n');
  await mkdir(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `report-${new Date().toISOString().slice(0, 10)}.md`);
  await writeFile(file, md, 'utf8');
  return file;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main(process.argv).then((file) => {
    console.log(`检索基准报告已写入：${file}`);
  }).catch((err) => {
    console.error(`检索基准失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
