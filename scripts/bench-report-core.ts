// OMB v2 月度复盘报告工具——分析与渲染核心（developer tooling；架构 §15 月度复盘 / §17 参数标定；
// 施工计划 T7.3）。CLI 入口在 scripts/bench-report.ts（本文件仅核心逻辑，无进程副作用）。
//
// - 数据：workspace/.omb/bench/bench-<line>.json（T7.1 BenchReport 持久化位置；目录无报告时跑冻结基准
//   并持久化——确定性回放 executor，数字可复现）。汇总：各线通过率、Cognitive Cost 八字段统计、
//   能力向量（按类别聚合的基准维度事实；T2.6 向量无持久化存档 → 不做跨期变化对比）、演化活动
//   （.evolution trusted/untrusted/rejected 候选记录）。
// - 退出码语义（computeExitCode）：0 = 全基准达标（四线齐备 + 全部任务通过）+ 无已知破坏性缺陷；
//   1 = 有未达标项。
// - 参数标定建议：数据驱动（每条建议含数据依据，非魔法数字）；修正实施仍走元演化门（T7.2）。
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCH_CATEGORIES,
  BENCH_LINES,
  BenchReportSchema,
  type BenchCategory,
  type BenchLine,
  type BenchReport,
} from '../kernel/schemas/bench.js';
import { loadBenchTasks, makeReplayExecutor, runBench } from '../supervisor/bench.js';

// ---- 常量（目录相对本模块解析，与 cwd 无关） ----

const HERE = fileURLToPath(new URL('..', import.meta.url)); // 仓库根/
export const DEFAULT_BENCH_DIR = join(HERE, 'workspace', '.omb', 'bench');
export const DEFAULT_EVOLUTION_ROOT = join(HERE, 'workspace', '.omb', '.evolution');
const BENCH_PREFIX = 'bench-';
export const REPORT_PREFIX = 'report-';

/** CognitiveCost 八字段（架构 §15 明示字段集；跨全部结果统计） */
const COST_FIELDS = [
  'model_tokens',
  'tool_calls',
  'retrieval_calls',
  'reacquisition',
  'latency_ms',
  'branch_count',
  'memory_pollution',
  'corrections',
] as const;
type CostField = (typeof COST_FIELDS)[number];

// ---- 汇总数据结构 ----

export interface LineStats {
  passed: number;
  total: number;
  rate: number; // 0..1
}

export interface CategoryStats {
  passed: number;
  total: number;
  rate: number;
  tokensMean: number;
}

/** 参数标定建议（数据驱动：suggested/basis 均引用实际基准数字，非魔法数字） */
export interface CalibrationSuggestion {
  parameter: string;
  suggested: string;
  basis: string; // 数据依据
}

export interface EvolutionSummary {
  present: boolean; // .evolution 数据源是否存在
  candidates: number; // 候选记录总数（record.json）
  trusted: number;
  untrusted: number;
  rejected: number;
  byKind: Record<string, number>;
}

export interface BenchSummary {
  reportCount: number;
  resultCount: number;
  passedCount: number;
  passRate: number; // 0..1
  allPass: boolean; // 四线齐备 + 全部任务通过（M7 出口判定）
  missingLines: BenchLine[];
  failedTaskIds: string[];
  byLine: Record<BenchLine, LineStats>;
  costMean: Record<CostField, number>; // 八字段均值（跨全部结果，原始数值）
  byCategory: Record<BenchCategory, CategoryStats>; // 能力向量（基准分维度事实）
  calibration: CalibrationSuggestion[];
  evolution: EvolutionSummary;
}

const EMPTY_EVOLUTION: EvolutionSummary = {
  present: false,
  candidates: 0,
  trusted: 0,
  untrusted: 0,
  rejected: 0,
  byKind: {},
};

// ---- 格式化（确定性输出） ----
function fmt1(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 百分比（一位小数；控制台与报告共用） */
export function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** 本地日期（YYYY-MM-DD；报告文件名与内容共用） */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---- 汇总（纯函数） ----

/** 任务 id → 类别（冻结集 id 形如 bench:<category>-NN；不匹配 → 'other'，不计入类别维度） */
function categoryOf(taskId: string): BenchCategory | 'other' {
  const m = /^bench:([a-z]+)-\d+$/.exec(taskId);
  const c = m?.[1] ?? '';
  return (BENCH_CATEGORIES as readonly string[]).includes(c) ? (c as BenchCategory) : 'other';
}

/** 参数标定建议（§17：Context budget / maintenance quantum / cost estimator 初值；全零成本 → 无建议） */
function suggestCalibration(
  byLine: Record<BenchLine, LineStats>,
  costMean: Record<CostField, number>,
): CalibrationSuggestion[] {
  const out: CalibrationSuggestion[] = [];
  // 1) Context Compiler 投影预算（budget.yaml context_budget_tokens 初值 4000，§17 待标定）
  if (byLine.baseline.total > 0 && costMean.model_tokens > 0) {
    const mean = costMean.model_tokens;
    out.push({
      parameter: 'context_budget_tokens（Context Compiler 投影预算，budget.yaml 当前 4000）',
      suggested: `建议 ≈ ${Math.ceil(mean * 1.2)}（= baseline model_tokens 均值 ${fmt1(mean)} × 1.2 余量）`,
      basis: `baseline 线 model_tokens 均值 = ${fmt1(mean)}（${byLine.baseline.total} 任务，冻结基准集产出）`,
    });
  }
  // 2) 维护调度量子（maintenance quantum）：一轮维护应覆盖典型任务耗时（latency 均值）
  if (costMean.latency_ms > 0) {
    const mean = costMean.latency_ms;
    out.push({
      parameter: 'maintenance quantum（维护调度量子，supervisor/maintenance.ts）',
      suggested: `建议量子 ≥ ${Math.ceil(mean)}ms（= latency_ms 均值，覆盖典型任务耗时）`,
      basis: `latency_ms 均值 = ${fmt1(mean)}ms（跨全部结果）`,
    });
  }
  // 3) cost estimator 初值（§17）：单任务工具调用基线
  if (costMean.tool_calls > 0) {
    const mean = costMean.tool_calls;
    out.push({
      parameter: 'cost estimator 初值（§17；tool_calls 基线）',
      suggested: `建议单任务 tool_calls 基线 ≈ ${fmt1(mean)}（均值）`,
      basis: `tool_calls 均值 = ${fmt1(mean)}（跨全部结果）`,
    });
  }
  return out;
}

/** 汇总：各线通过率 + CognitiveCost 八字段均值 + 能力向量（类别聚合）+ 参数标定建议（纯函数，无 I/O） */
export function summarizeReports(reports: readonly BenchReport[]): BenchSummary {
  const all = reports.flatMap((r) => r.results);
  const byLine = {} as Record<BenchLine, LineStats>;
  for (const line of BENCH_LINES) {
    const rs = all.filter((r) => r.line === line);
    const passed = rs.filter((r) => r.passed).length;
    byLine[line] = { passed, total: rs.length, rate: rs.length === 0 ? 0 : passed / rs.length };
  }
  const passedCount = all.filter((r) => r.passed).length;
  const costMean = {} as Record<CostField, number>;
  for (const f of COST_FIELDS) {
    const sum = all.reduce((acc, r) => acc + r.cost[f], 0);
    costMean[f] = all.length === 0 ? 0 : sum / all.length;
  }
  const byCategory = {} as Record<BenchCategory, CategoryStats>;
  for (const cat of BENCH_CATEGORIES) {
    const rs = all.filter((r) => categoryOf(r.task_id) === cat);
    const passed = rs.filter((r) => r.passed).length;
    const tokensSum = rs.reduce((acc, r) => acc + r.cost.model_tokens, 0);
    byCategory[cat] = {
      passed,
      total: rs.length,
      rate: rs.length === 0 ? 0 : passed / rs.length,
      tokensMean: rs.length === 0 ? 0 : tokensSum / rs.length,
    };
  }
  const missingLines = BENCH_LINES.filter((l) => byLine[l].total === 0);
  const failedTaskIds = all.filter((r) => !r.passed).map((r) => r.task_id);
  const allPass = missingLines.length === 0 && all.length > 0 && failedTaskIds.length === 0;
  return {
    reportCount: reports.length,
    resultCount: all.length,
    passedCount,
    passRate: all.length === 0 ? 0 : passedCount / all.length,
    allPass,
    missingLines,
    failedTaskIds,
    byLine,
    costMean,
    byCategory,
    calibration: suggestCalibration(byLine, costMean),
    evolution: EMPTY_EVOLUTION,
  };
}

// ---- 报告渲染（纯函数，确定性：同 summary 同 opts → 同内容） ----

export function renderMarkdown(
  summary: BenchSummary,
  opts: { date?: string; benchDir?: string; v2?: BenchV2DetailSummary } = {},
): string {
  const date = opts.date ?? localDate();
  const benchDir = opts.benchDir ?? DEFAULT_BENCH_DIR;
  const lines: string[] = [];
  lines.push('# OMB v2 月度复盘报告');
  lines.push('');
  lines.push(`- 生成日期：${date}`);
  lines.push(
    `- 数据源：${benchDir}/bench-<line>.json（${summary.reportCount} 报告 / ${summary.resultCount} 结果 / ${summary.passedCount} 通过）`,
  );
  lines.push(
    `- 判定：全基准达标 = ${summary.allPass ? '是' : '否'}${
      summary.missingLines.length > 0 ? `（缺线：${summary.missingLines.join('、')}）` : ''
    }`,
  );
  lines.push('');
  lines.push('## 1. 基准通过率');
  lines.push('');
  lines.push('| 线 | 通过/总数 | 通过率 |');
  lines.push('| --- | --- | --- |');
  for (const line of BENCH_LINES) {
    const s = summary.byLine[line];
    lines.push(`| ${line} | ${s.passed}/${s.total} | ${pct(s.rate)} |`);
  }
  lines.push('');
  lines.push('## 2. Cognitive Cost 统计（八字段均值，跨全部结果）');
  lines.push('');
  lines.push('| 字段 | 均值 |');
  lines.push('| --- | --- |');
  for (const f of COST_FIELDS) {
    lines.push(`| ${f} | ${fmt1(summary.costMean[f])} |`);
  }
  lines.push('');
  lines.push('## 3. 能力向量（基准分维度事实；T2.6 向量无持久化存档 → 无跨期变化对比）');
  lines.push('');
  lines.push('| 类别 | 通过率 | model_tokens 均值 |');
  lines.push('| --- | --- | --- |');
  for (const cat of BENCH_CATEGORIES) {
    const c = summary.byCategory[cat];
    lines.push(`| ${cat} | ${c.passed}/${c.total} (${pct(c.rate)}) | ${fmt1(c.tokensMean)} |`);
  }
  lines.push('');
  lines.push('## 4. 演化活动');
  lines.push('');
  const evo = summary.evolution;
  if (evo.present) {
    lines.push(
      `- 候选记录（${evo.candidates}）：trusted ${evo.trusted} / untrusted ${evo.untrusted} / rejected ${evo.rejected}`,
    );
    const kinds = Object.keys(evo.byKind).sort();
    if (kinds.length > 0) {
      lines.push(`- 按类型：${kinds.map((k) => `${k} ${evo.byKind[k]}`).join(' / ')}`);
    }
  } else {
    lines.push('- 无持久化演化数据（workspace/.omb/.evolution 不存在或不可读）');
  }
  lines.push('');
  lines.push('## 5. 参数标定建议（数据驱动，非魔法数字；实施仍走元演化门 T7.2）');
  lines.push('');
  if (summary.calibration.length === 0) {
    lines.push('- 无建议（成本数据全零，无信号——不凭空建议）');
  } else {
    summary.calibration.forEach((c, i) => {
      lines.push(`${i + 1}. **${c.parameter}**：${c.suggested}`);
      lines.push(`   - 数据依据：${c.basis}`);
    });
  }
  lines.push('');
  lines.push('## 6. 出口核对');
  lines.push('');
  lines.push(`- 全基准达标：${summary.allPass ? '是（四线齐备 + 全部任务通过）' : '否'}`);
  if (summary.failedTaskIds.length > 0) {
    lines.push(`- 未达标任务：${summary.failedTaskIds.join('、')}`);
  }
  if (summary.missingLines.length > 0) {
    lines.push(`- 缺线（数据不完整）：${summary.missingLines.join('、')}`);
  }
  lines.push(
    `- 已知破坏性缺陷：${summary.allPass ? '无（基准全绿，无回归信号）' : '有（未达标任务见上，破坏性缺陷信号）'}`,
  );
  lines.push(`- 退出码：${computeExitCode(summary)}`);
  lines.push('');
  // v2 契约基准段（T2.3）：明细 JSONL 聚合（replay-v2-<line>-<ts>.jsonl / real-v2-<line>-<ts>.jsonl）
  if (opts.v2 !== undefined && opts.v2.present) {
    lines.push('## 7. v2 契约基准（明细聚合：replay-v2-<line>-<ts>.jsonl / real-v2-<line>-<ts>.jsonl）');
    lines.push('');
    lines.push(`- 明细文件 ${opts.v2.files} 个 / 记录 ${opts.v2.records} 条（按线汇总：passed/total + 成本字段均值；real/replay = 真实/回放记录数）`);
    lines.push('');
    lines.push(
      '| 线 | 通过/总数 | 通过率 | real/replay | model_tokens | tool_calls | retrieval_calls | reacquisition | latency_ms | branch_count | memory_pollution | corrections |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const line of BENCH_LINES) {
      const s = opts.v2.byLine[line];
      if (s.total === 0) {
        continue;
      }
      const costs = COST_FIELDS.map((f) => fmt1(s.costMean[f])).join(' | ');
      lines.push(`| ${line} | ${s.passed}/${s.total} | ${pct(s.rate)} | ${s.realCount}/${s.replayCount} | ${costs} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---- 退出码（0 = 全基准达标 + 无已知破坏性缺陷；1 = 有未达标项） ----
export function computeExitCode(summary: BenchSummary): 0 | 1 {
  return summary.allPass ? 0 : 1;
}

// ---- 数据读取 / 生成（workspace/.omb/bench/，T7.1 BenchReport 持久化位置） ----

/** 读取 bench-*.json（文件名排序保证确定性；非法报告 fail-loud） */
export async function loadBenchReports(dir: string): Promise<BenchReport[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // 目录不存在 → 无数据
  }
  const benchFiles = files.filter((f) => f.startsWith(BENCH_PREFIX) && f.endsWith('.json')).sort();
  const reports: BenchReport[] = [];
  for (const f of benchFiles) {
    const file = join(dir, f);
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = BenchReportSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`bench 报告校验失败 ${file}: ${detail}`);
    }
    reports.push(result.data);
  }
  return reports;
}

/** 持久化报告（bench-<line>.json，一次一线） */
export async function persistReports(dir: string, reports: readonly BenchReport[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const r of reports) {
    await writeFile(join(dir, `${BENCH_PREFIX}${r.line}.json`), JSON.stringify(r, null, 2), 'utf8');
  }
}

/**
 * 确保基准数据存在：目录已有报告 → 直接返回（读用户/历史数据）；无报告 → 跑冻结基准
 * （三线 + baseline，确定性回放 executor——同 fixture 同 executor 同结果）并持久化。
 */
export async function ensureBenchReports(dir: string): Promise<BenchReport[]> {
  const existing = await loadBenchReports(dir);
  if (existing.length > 0) {
    return existing;
  }
  const tasks = await loadBenchTasks();
  const executor = makeReplayExecutor();
  const reports: BenchReport[] = [];
  for (const line of BENCH_LINES) {
    reports.push(await runBench({ tasks, line, executor }));
  }
  await persistReports(dir, reports);
  return reports;
}

// ---- v2 契约基准明细聚合（T2.3：replay-v2-<line>-<ts>.jsonl / real-v2-<line>-<ts>.jsonl；
// 复盘工具对 v2 明细只读聚合，v1 路径（bench-*.json）保持可用） ----

/** v2 明细文件名匹配（<mode>-v2-<line>-<ts>.jsonl；line 限定四线） */
const V2_DETAIL_FILE_RE = /^(replay|real)-v2-(initial|stable|latest|baseline)-.+\.jsonl$/;

/** 单线 v2 汇总：passed/total/rate + real/replay 记录数 + 八字段成本均值 */
export interface BenchV2LineStats {
  passed: number;
  total: number;
  rate: number; // 0..1
  realCount: number;
  replayCount: number;
  costMean: Record<CostField, number>;
}

/** v2 明细聚合结果（present=false → 目录无 v2 明细文件） */
export interface BenchV2DetailSummary {
  present: boolean;
  files: number;
  records: number;
  byLine: Record<BenchLine, BenchV2LineStats>;
}

function emptyV2LineStats(): BenchV2LineStats {
  return {
    passed: 0,
    total: 0,
    rate: 0,
    realCount: 0,
    replayCount: 0,
    costMean: Object.fromEntries(COST_FIELDS.map((f) => [f, 0])) as Record<CostField, number>,
  };
}

function emptyV2DetailSummary(): BenchV2DetailSummary {
  return {
    present: false,
    files: 0,
    records: 0,
    byLine: Object.fromEntries(BENCH_LINES.map((l) => [l, emptyV2LineStats()])) as Record<
      BenchLine,
      BenchV2LineStats
    >,
  };
}

/**
 * 聚合 v2 明细 JSONL：按线汇总 passed/total + 成本字段均值（real/replay 记录数分列）。
 * 非破坏性读取：文件/单条记录不可读 → 跳过（同 summarizeEvolution 容错风格，不中断复盘）。
 */
export async function summarizeV2Detail(dir: string): Promise<BenchV2DetailSummary> {
  const empty = emptyV2DetailSummary();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return empty; // 目录不存在 → 无 v2 明细
  }
  const v2Files = files.filter((f) => V2_DETAIL_FILE_RE.test(f)).sort();
  const byLine = Object.fromEntries(BENCH_LINES.map((l) => [l, emptyV2LineStats()])) as Record<
    BenchLine,
    BenchV2LineStats
  >;
  const costSums = Object.fromEntries(
    BENCH_LINES.map((l) => [l, Object.fromEntries(COST_FIELDS.map((f) => [f, 0]))]),
  ) as Record<BenchLine, Record<CostField, number>>;
  let records = 0;
  for (const file of v2Files) {
    const match = V2_DETAIL_FILE_RE.exec(file);
    if (match === null) {
      continue;
    }
    const mode = match[1] as 'replay' | 'real';
    const line = match[2] as BenchLine;
    let raw: string;
    try {
      raw = await readFile(join(dir, file), 'utf8');
    } catch {
      continue; // 文件不可读 → 跳过（非破坏性）
    }
    for (const rawLine of raw.split('\n')) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue; // 单条非法 → 跳过（不中断聚合）
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        continue;
      }
      const rec = record as Record<string, unknown>;
      if (typeof rec.passed !== 'boolean' || rec.line !== line) {
        continue; // 记录缺 passed / line 与文件名不符 → 跳过
      }
      const cost = rec.cost;
      if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) {
        continue;
      }
      const stats = byLine[line]!;
      stats.total++;
      if (rec.passed) {
        stats.passed++;
      }
      if (mode === 'real') {
        stats.realCount++;
      } else {
        stats.replayCount++;
      }
      const costRecord = cost as Record<string, unknown>;
      for (const field of COST_FIELDS) {
        const value = costRecord[field];
        if (typeof value === 'number') {
          costSums[line]![field] += value;
        }
      }
      records++;
    }
  }
  for (const line of BENCH_LINES) {
    const stats = byLine[line]!;
    stats.rate = stats.total === 0 ? 0 : stats.passed / stats.total;
    for (const field of COST_FIELDS) {
      stats.costMean[field] = stats.total === 0 ? 0 : costSums[line]![field] / stats.total;
    }
  }
  return { present: v2Files.length > 0, files: v2Files.length, records, byLine };
}

// ---- 演化活动（.evolution 候选记录；非破坏性读取） ----

const EVO_ZONES = ['trusted', 'untrusted', 'rejected'] as const;

/** 汇总 .evolution 候选记录（trusted/untrusted/rejected 各区的 record.json；不可读记录跳过） */
export async function summarizeEvolution(evolutionRoot: string): Promise<EvolutionSummary> {
  const out: EvolutionSummary = { ...EMPTY_EVOLUTION, present: existsSync(evolutionRoot) };
  if (!out.present) {
    return out;
  }
  for (const zone of EVO_ZONES) {
    const zoneDir = join(evolutionRoot, zone);
    let ids: string[];
    try {
      ids = await readdir(zoneDir);
    } catch {
      continue; // 区目录不存在 → 无记录
    }
    for (const id of ids) {
      try {
        const raw = await readFile(join(zoneDir, id, 'record.json'), 'utf8');
        const rec = JSON.parse(raw) as { kind?: unknown };
        out.candidates++;
        if (typeof rec.kind === 'string' && rec.kind.length > 0) {
          out.byKind[rec.kind] = (out.byKind[rec.kind] ?? 0) + 1;
        }
        if (zone === 'trusted') {
          out.trusted++;
        } else if (zone === 'untrusted') {
          out.untrusted++;
        } else {
          out.rejected++;
        }
      } catch {
        // 记录缺失/非法 → 跳过（复盘工具非破坏性读取，不因旁路数据中断报告）
      }
    }
  }
  return out;
}