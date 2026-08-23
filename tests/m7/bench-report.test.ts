// T7.3 行为测试：复盘报告工具（scripts/bench-report.ts，developer tooling；架构 §15 月度复盘 / §16 1.0.0
// 候选 / §17 参数标定；施工计划 T7.3 + 用户 2026-08-21 ）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-6 + T2.3 v2 支持）：
//   ① 可运行：spawn 脚本 → 输出报告文件（markdown 存在且含关键节：通过率/成本/参数建议）
//   ② 汇总正确性：预置两份 fake bench 报告 → 汇总数字匹配（通过率/成本均值）
//   ③ 退出码：全部达标 → 0；有未达标 → 1（含 spawn 端到端）
//   ④ 无自动运行：脚本被 import 时不执行主逻辑（主逻辑在 main() 且仅直接运行时调用——import 无副作用）
//   ⑤ 报告幂等：同数据跑两次 → 同报告内容（确定性）
//   ⑥ 参数标定建议：预置数据 → 建议文本含数据依据（非凭空数字；全零成本 → 不产出凭空建议）
//   ⑦ v2 明细聚合（T2.3）：replay-v2-*/real-v2-*.jsonl 按线汇总 + renderMarkdown v2 段 + CLI 端到端；v1 路径可用
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BENCH_LINES, type BenchLine, type BenchReport, type CognitiveCost } from '../../kernel/schemas/bench.js';
import {
  computeExitCode,
  loadBenchReports,
  renderMarkdown,
  summarizeReports,
  summarizeV2Detail,
} from '../../scripts/bench-report.js';

const PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(PRESET_ROOT, 'scripts', 'bench-report.ts');
const REAL_BENCH_DIR = join(PRESET_ROOT, 'workspace', '.omb', 'bench');

// ---- 测试工具 ----

/** CognitiveCost 工厂（全零 → overrides） */
function cost(overrides: Partial<CognitiveCost> = {}): CognitiveCost {
  return {
    model_tokens: 0,
    tool_calls: 0,
    retrieval_calls: 0,
    reacquisition: 0,
    latency_ms: 0,
    branch_count: 0,
    memory_pollution: 0,
    corrections: 0,
    ...overrides,
  };
}

/** BenchReport 工厂（结果 line 与报告 line 一致） */
function report(line: BenchLine, results: ReadonlyArray<{ id: string; passed: boolean; cost?: Partial<CognitiveCost> }>): BenchReport {
  return {
    line,
    results: results.map((r) => ({ task_id: r.id, line, passed: r.passed, cost: cost(r.cost) })),
  };
}

/** 全部达标的 4 线 fake 数据（每线 2 任务：data-01 1000 tokens / code-01 1500 tokens） */
function allPassReports(): BenchReport[] {
  return BENCH_LINES.map((line) =>
    report(line, [
      { id: 'bench:data-01', passed: true, cost: { model_tokens: 1000 } },
      { id: 'bench:code-01', passed: true, cost: { model_tokens: 1500 } },
    ]),
  );
}

/** 预置 bench-<line>.json 到临时目录（模拟 T7.1 产物持久化位置） */
async function writeBenchData(dir: string, reports: readonly BenchReport[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const r of reports) {
    await writeFile(join(dir, `bench-${r.line}.json`), JSON.stringify(r, null, 2), 'utf8');
  }
}

/**
 * 预置 v2 明细 JSONL 到临时目录（T2.3：replay-v2-<line>-<ts>.jsonl / real-v2-<line>-<ts>.jsonl）：
 * - replay-v2-initial-*：2 条全过（全零成本）；
 * - real-v2-stable-*：1 条通过（model_tokens 100）；
 * - replay-v2-stable-*：1 条失败（model_tokens 50）→ stable 汇总 1/2、real/replay = 1/1、均值 75。
 */
async function writeBenchV2Data(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const record = (line: BenchLine, mode: string, passed: boolean, costOver: Partial<CognitiveCost>): string =>
    JSON.stringify({
      ts: 1780000000000,
      task_id: 'data-01',
      mode,
      line,
      passed,
      verifier_kind: 'exact',
      failure_reason: passed ? null : 'exact: 输出与 expected 不一致',
      output: { users: [] },
      cost: cost(costOver),
    });
  const initial = [
    record('initial', 'replay', true, {}),
    record('initial', 'replay', true, {}),
  ].join('\n');
  const stableReal = record('stable', 'real', true, { model_tokens: 100 });
  const stableReplay = record('stable', 'replay', false, { model_tokens: 50 });
  await writeFile(join(dir, 'replay-v2-initial-2026-08-23T00-00-00-000Z.jsonl'), `${initial}\n`, 'utf8');
  await writeFile(join(dir, 'real-v2-stable-2026-08-23T00-00-00-000Z.jsonl'), `${stableReal}\n`, 'utf8');
  await writeFile(join(dir, 'replay-v2-stable-2026-08-23T00-00-00-000Z.jsonl'), `${stableReplay}\n`, 'utf8');
}

/** spawn 脚本（node --import tsx，tsx 为 devDep；cwd = preset 根保证 tsx 可解析） */
function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 临时目录中的 report-*.md 内容 */
async function readReport(dir: string): Promise<string> {
  const files = await readdir(dir);
  const md = files.find((f) => f.startsWith('report-') && f.endsWith('.md'));
  expect(md, `报告文件应存在（目录: ${dir}）`).toBeDefined();
  return readFile(join(dir, md!), 'utf8');
}

/** 独立 node 进程执行一段代码（node --import tsx -e；argv[1] 缺失 → 模块 import 不触发 main） */
function runNodeEval(code: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', code], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ code: exitCode, stdout, stderr }));
  });
}

// ---- ① 可运行 ----

describe('① 可运行：spawn 脚本 → 输出报告文件（关键节：通过率/成本/参数建议）', () => {
  it('spawn scripts/bench-report.ts --dir <tmp> → 退出码 0 + report-<date>.md 含关键节', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-br-run-'));
    try {
      await writeBenchData(dir, allPassReports());
      const { code, stderr } = await runCli(['--dir', dir], PRESET_ROOT);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const content = await readReport(dir);
      expect(content).toContain('基准通过率');
      expect(content).toContain('Cognitive Cost');
      expect(content).toContain('参数标定建议');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- ② 汇总正确性 ----

describe('② 汇总正确性（预置 fake 报告 → 通过率/成本均值匹配）', () => {
  it('两份报告：stable 2/2 + latest 1/2 → 各线通过率 + 跨报告 model_tokens 均值', () => {
    const reports = [
      report('stable', [
        { id: 'bench:data-01', passed: true, cost: { model_tokens: 1000 } },
        { id: 'bench:code-01', passed: true, cost: { model_tokens: 1500 } },
      ]),
      report('latest', [
        { id: 'bench:data-02', passed: true, cost: { model_tokens: 2000 } },
        { id: 'bench:web-01', passed: false, cost: { model_tokens: 3000 } },
      ]),
    ];
    const s = summarizeReports(reports);
    expect(s.byLine.stable).toEqual({ passed: 2, total: 2, rate: 1 });
    expect(s.byLine.latest).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(s.costMean.model_tokens).toBe(1875); // (1000+1500+2000+3000)/4
    expect(s.passRate).toBe(0.75);
    expect(s.passedCount).toBe(3);
    expect(s.resultCount).toBe(4);
    expect(s.reportCount).toBe(2);
  });

  it('line 未覆盖（缺 initial/baseline）→ missingLines 列出；该线 rate 为 0', () => {
    const s = summarizeReports([report('stable', [{ id: 'bench:data-01', passed: true }])]);
    expect(s.missingLines).toContain('initial');
    expect(s.missingLines).toContain('baseline');
    expect(s.byLine.initial.total).toBe(0);
    expect(s.byLine.initial.rate).toBe(0);
  });

  it('能力向量维度（按类别聚合）：类别通过率与 tokens 均值正确', () => {
    const reports = [
      report('stable', [
        { id: 'bench:data-01', passed: true, cost: { model_tokens: 1000 } },
        { id: 'bench:code-01', passed: true, cost: { model_tokens: 1500 } },
        { id: 'bench:code-02', passed: false, cost: { model_tokens: 2500 } },
      ]),
    ];
    const s = summarizeReports(reports);
    expect(s.byCategory.data).toEqual({ passed: 1, total: 1, rate: 1, tokensMean: 1000 });
    expect(s.byCategory.code).toEqual({ passed: 1, total: 2, rate: 0.5, tokensMean: 2000 });
  });
});

// ---- ③ 退出码 ----

describe('③ 退出码：全部达标 → 0；有未达标 → 1', () => {
  it('computeExitCode：全过 + 四线齐备 → 0', () => {
    expect(computeExitCode(summarizeReports(allPassReports()))).toBe(0);
  });

  it('computeExitCode：任一任务失败 → 1', () => {
    const reports = allPassReports();
    reports[0]!.results[0]!.passed = false;
    expect(computeExitCode(summarizeReports(reports))).toBe(1);
  });

  it('computeExitCode：缺线（数据不完整，无法确认达标）→ 1', () => {
    const s = summarizeReports([report('stable', [{ id: 'bench:data-01', passed: true }])]);
    expect(computeExitCode(s)).toBe(1);
  });

  it('spawn：有未达标报告 → 进程退出码 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-br-fail-'));
    try {
      const reports = allPassReports();
      reports[2]!.results[1]!.passed = false; // latest 线一个任务失败
      await writeBenchData(dir, reports);
      const { code } = await runCli(['--dir', dir], PRESET_ROOT);
      expect(code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- ④ import 无副作用 ----

describe('④ 无自动运行：import 模块不执行主逻辑（无副作用）', () => {
  it('独立进程仅 import 模块（argv[1] 缺失，非直接运行）→ 真实 workspace/.omb/bench 无新增产物', async () => {
    // 若模块加载时执行了 main()，会在 import 时刻向真实 workspace/.omb/bench/ 写出
    // bench-*.json 与 report-*.md——before/after 快照对比可检出（不依赖目录初始为空）。
    const before = existsSync(REAL_BENCH_DIR) ? readdirSync(REAL_BENCH_DIR).sort() : [];
    const spec = pathToFileURL(SCRIPT).href;
    const { code, stderr } = await runNodeEval(`import(${JSON.stringify(spec)})`, PRESET_ROOT);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const after = existsSync(REAL_BENCH_DIR) ? readdirSync(REAL_BENCH_DIR).sort() : [];
    expect(after).toEqual(before);
  });
});

// ---- ⑤ 报告幂等 ----

describe('⑤ 报告幂等：同数据两次 → 同内容（确定性）', () => {
  it('renderMarkdown 纯函数：同 summary 两次 → 逐字符一致', () => {
    const s = summarizeReports(allPassReports());
    expect(renderMarkdown(s, { date: '2026-08-21' })).toBe(renderMarkdown(s, { date: '2026-08-21' }));
  });

  it('端到端：同数据 spawn 两次 → 两次 report-*.md 内容一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-br-idem-'));
    try {
      await writeBenchData(dir, allPassReports());
      const r1 = await runCli(['--dir', dir], PRESET_ROOT);
      const r2 = await runCli(['--dir', dir], PRESET_ROOT);
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      const c1 = await readReport(dir);
      const c2 = await readReport(dir);
      expect(c2).toBe(c1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- ⑥ 参数标定建议 ----

describe('⑥ 参数标定建议：数据驱动（建议文本含数据依据，非凭空数字）', () => {
  it('预置数据 → Context budget 建议含实际均值数字（依据来自报告数据）', () => {
    const reports = [
      report('baseline', [
        { id: 'bench:data-01', passed: true, cost: { model_tokens: 1200, tool_calls: 4, latency_ms: 800 } },
        { id: 'bench:code-01', passed: true, cost: { model_tokens: 1800, tool_calls: 6, latency_ms: 1200 } },
      ]),
    ];
    const s = summarizeReports(reports);
    expect(s.calibration.length).toBeGreaterThan(0);
    // Context budget 建议基于 baseline model_tokens 均值 1500
    const ctx = s.calibration.find(
      (c) => c.parameter.includes('context') || c.parameter.includes('Context'),
    );
    expect(ctx).toBeDefined();
    expect(ctx!.basis).toContain('1500'); // 数据依据 = 实际均值
    expect(ctx!.suggested).toContain('1500');
    // 渲染后的报告也含该数据依据
    const md = renderMarkdown(s, { date: '2026-08-21' });
    expect(md).toContain('1500');
    expect(md).toContain('数据依据');
  });

  it('全零成本（无信号）→ 不产出凭空建议', () => {
    const reports = [report('baseline', [{ id: 'bench:data-01', passed: true }])]; // cost 全零
    const s = summarizeReports(reports);
    expect(s.calibration).toEqual([]);
  });
});

// ---- ⑦ v2 明细聚合（T2.3：replay-v2-<line>-<ts>.jsonl / real-v2-<line>-<ts>.jsonl） ----

describe('⑦ v2 明细聚合（summarizeV2Detail + renderMarkdown v2 段；v1 路径保持可用）', () => {
  it('注入 v2 JSONL → 按线汇总 passed/total + real/replay 分列 + 成本字段均值', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-br-v2-'));
    try {
      await writeBenchV2Data(dir);
      const s = await summarizeV2Detail(dir);
      expect(s.present).toBe(true);
      expect(s.files).toBe(3);
      expect(s.records).toBe(4);
      // stable：real 1 通过 + replay 1 失败 → 1/2、real/replay=1/1、model_tokens 均值 (100+50)/2=75
      expect(s.byLine.stable.total).toBe(2);
      expect(s.byLine.stable.passed).toBe(1);
      expect(s.byLine.stable.rate).toBe(0.5);
      expect(s.byLine.stable.realCount).toBe(1);
      expect(s.byLine.stable.replayCount).toBe(1);
      expect(s.byLine.stable.costMean.model_tokens).toBe(75);
      // initial：replay 2 全过（全零成本）
      expect(s.byLine.initial.total).toBe(2);
      expect(s.byLine.initial.passed).toBe(2);
      expect(s.byLine.initial.rate).toBe(1);
      expect(s.byLine.initial.realCount).toBe(0);
      expect(s.byLine.initial.replayCount).toBe(2);
      expect(s.byLine.initial.costMean.model_tokens).toBe(0);
      // 未注入的线 total=0、rate=0
      expect(s.byLine.latest.total).toBe(0);
      expect(s.byLine.latest.rate).toBe(0);
      expect(s.byLine.baseline.total).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('目录无 v2 文件 → present=false（v1 汇总不受影响）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-br-v2-empty-'));
    try {
      await writeBenchData(dir, allPassReports()); // 仅 v1 bench-*.json
      const s = await summarizeV2Detail(dir);
      expect(s.present).toBe(false);
      expect(s.files).toBe(0);
      expect(s.records).toBe(0);
      const summary = summarizeReports(await loadBenchReports(dir));
      expect(summary.passRate).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renderMarkdown 带 v2 → 含 v2 契约基准段（按线通过率 + real/replay + 成本均值）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-br-v2-md-'));
    try {
      await writeBenchV2Data(dir);
      const v2 = await summarizeV2Detail(dir);
      const md = renderMarkdown(summarizeReports(allPassReports()), { date: '2026-08-23', benchDir: dir, v2 });
      expect(md).toContain('## 7. v2 契约基准');
      expect(md).toContain('replay-v2-<line>-<ts>.jsonl');
      expect(md).toContain('| stable | 1/2 | 50.0% | 1/1 |');
      expect(md).toContain('| initial | 2/2 | 100.0% | 0/2 |');
      // v2 段不渲染 total=0 的线（latest/baseline 无记录；注意 v1 段 §1 仍有 0/0 行，用 real/replay 列区分）
      expect(md).not.toContain('| latest | 0/0 | 0.0% | 0/0 |');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CLI 端到端：临时目录注入 v2 JSONL → 报告含 v2 段 + 控制台 v2 摘要', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-br-v2-cli-'));
    try {
      await writeBenchData(dir, allPassReports());
      await writeBenchV2Data(dir);
      const { code, stdout } = await runCli(['--dir', dir], PRESET_ROOT);
      expect(code).toBe(0);
      expect(stdout).toContain('v2 契约基准明细');
      expect(stdout).toContain('v2 stable: 1/2');
      const content = await readReport(dir);
      expect(content).toContain('## 7. v2 契约基准');
      expect(content).toContain('| stable | 1/2 | 50.0% | 1/1 |');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
