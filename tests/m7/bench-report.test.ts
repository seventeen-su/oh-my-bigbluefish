// T7.3 行为测试：复盘报告工具（scripts/bench-report.ts，developer tooling；架构 §15 月度复盘 / §16 1.0.0
// 候选 / §17 参数标定；施工计划 T7.3 + 用户 2026-08-21 指示：1.0.0 候选评审报告不提交、提请用户裁定）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-6）：
//   ① 可运行：spawn 脚本 → 输出报告文件（markdown 存在且含关键节：通过率/成本/参数建议）
//   ② 汇总正确性：预置两份 fake bench 报告 → 汇总数字匹配（通过率/成本均值）
//   ③ 退出码：全部达标 → 0；有未达标 → 1（含 spawn 端到端）
//   ④ 无自动运行：脚本被 import 时不执行主逻辑（主逻辑在 main() 且仅直接运行时调用——import 无副作用）
//   ⑤ 报告幂等：同数据跑两次 → 同报告内容（确定性）
//   ⑥ 参数标定建议：预置数据 → 建议文本含数据依据（非凭空数字；全零成本 → 不产出凭空建议）
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
  renderMarkdown,
  summarizeReports,
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
