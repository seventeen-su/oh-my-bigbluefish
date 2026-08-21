// M7 出口整体连通测试：基准与元演化闭环（冻结基准 → 四线真实运行 → 数字可复现 →
// 元演化门禁（真实 governor.yaml 内容）→ 写回 → 复盘汇总 → M4 过程执行链连通）。
// 用户强化指示（CONVENTIONS §5.1）：每里程碑出口必须有整体连通测试——把 M7 全产物
// （T7.1 冻结基准集 bench / T7.2 元演化门禁 evolve-meta / T7.3 复盘工具 bench-report）
// 串成端到端闭环，并连通前置链：M4 过程执行链（process-adapter → executeGraph）。
// 真实模块 + 真实数据文件（kernel/bench-tasks/ + kernel/policy/governor.yaml），禁 mock；
// 仅依赖注入真实行为 deps（T7.2 frozenBaseline/runBaseline、M4 registry/verifiers）。
// 覆盖：① 冻结基准完整性 ② 四线对照真实运行 ③ 数字可复现 ④ 元演化门禁连通
//       ⑤ bench-report 连通 ⑥ 跨里程碑连通（M4） ⑦ 确定性/幂等。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import {
  BENCH_CATEGORIES,
  BENCH_LINES,
  BenchReportSchema,
  CATEGORY_VERIFIER_KIND,
  CognitiveCostSchema,
  FROZEN_BENCH_COUNTS,
  type BenchReport,
  type BenchTask,
} from '../../kernel/schemas/bench.js';
import { GovernorPolicySchema } from '../../kernel/schemas/policy.js';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import {
  loadBenchFixture,
  loadBenchTasks,
  makeReplayExecutor,
  runBench,
  runVerifier,
  type BenchExecutor,
} from '../../supervisor/bench.js';
import {
  applyMetaChange,
  evaluateMetaChange,
  type MetaChange,
} from '../../supervisor/evolve-meta.js';
import { EventStore } from '../../supervisor/event-store.js';
import { computeExitCode, summarizeReports } from '../../scripts/bench-report.js';
import { ProcessDefSchema, type ProcessDef } from '../../kernel/policy-loader.js';
import { toOperatorGraph } from '../../runtime/process-adapter.js';
import { executeGraph } from '../../runtime/operator.js';

// ---- 常量 ----

const PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY_DIR = join(PRESET_ROOT, 'kernel', 'policy');
/** 测试环境指纹（§4.4；与 m7 单测一致） */
const ENV: Fingerprint = { os: 'test', node: 'v24', dsh_version: '0.7.0', project: 'omb-v2' };
/** CognitiveCost 八字段（架构 §15 明示字段集） */
const COST_FIELDS = [
  'model_tokens',
  'tool_calls',
  'retrieval_calls',
  'reacquisition',
  'latency_ms',
  'branch_count',
  'memory_pollution',
  'corrections',
].sort();

// ---- 共享 fixture（真实数据：冻结基准集 + 真实 governor.yaml；跨 it 复用） ----

let tasks: BenchTask[];
let executor: BenchExecutor;
/** 真实四线之一：baseline 报告（② 产物，④⑦ 复用为冻结基线） */
let baselineReport: BenchReport;
/** 真实 governor.yaml 内容（④ diff.from 基；复制到 fixture 目录作 applyMetaChange 目标） */
let govFrom: string;
/** schema 合法改动（首个 RunProcess → Verify；决策表改动，规则数/默认规则不变） */
let govTo: string;
let tmpRoot: string;
let policyDir: string;
let eventStore: EventStore;

beforeAll(async () => {
  tasks = await loadBenchTasks();
  executor = makeReplayExecutor();
  baselineReport = await runBench({ tasks, line: 'baseline', executor });
  govFrom = await readFile(join(POLICY_DIR, 'governor.yaml'), 'utf8');
  govTo = govFrom.replace('decision: RunProcess', 'decision: Verify');
  tmpRoot = await mkdtemp(join(tmpdir(), 'omb-m7loop-'));
  policyDir = join(tmpRoot, 'policy'); // fixture 目录 = 真实 policy 目录副本
  await mkdir(policyDir, { recursive: true });
  await copyFile(join(POLICY_DIR, 'governor.yaml'), join(policyDir, 'governor.yaml'));
  eventStore = new EventStore(join(tmpRoot, 'events.db'));
});

afterAll(async () => {
  await eventStore.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---- ① 冻结基准完整性 ----

describe('① 冻结基准完整性（真实数据文件：20 任务 = 5 类 × 4）', () => {
  it('loadBenchTasks → 恰好 20 任务，每类 4 个，id 形如 bench:<cat>-NN', async () => {
    expect(tasks).toHaveLength(20);
    expect(tasks.length).toBe(Object.values(FROZEN_BENCH_COUNTS).reduce((a, b) => a + b, 0));
    for (const cat of BENCH_CATEGORIES) {
      expect(tasks.filter((t) => t.category === cat), cat).toHaveLength(FROZEN_BENCH_COUNTS[cat]);
    }
    for (const t of tasks) {
      expect(t.id, t.id).toMatch(new RegExp(`^bench:(${BENCH_CATEGORIES.join('|')})-\\d+$`));
    }
  });

  it('每任务 verifier.kind 与类别映射一致（§15）且 fixture 载荷可加载、录制输出自洽', async () => {
    for (const t of tasks) {
      expect(t.verifier.kind, t.id).toBe(CATEGORY_VERIFIER_KIND[t.category]);
      const fixture = await loadBenchFixture(t.verifier.ref);
      expect(fixture.cost, t.id).toBeDefined();
      expect(runVerifier(t, fixture.output, fixture), t.id).toBe(true); // 冻结集自洽
    }
  });
});

// ---- ② 四线对照真实运行 ----

describe('② 四线对照真实运行（回放 executor + 真实 fixtures）', () => {
  it('initial/stable/latest/baseline 各 20 任务全部通过（冻结集自洽）', async () => {
    const reports: BenchReport[] = [];
    for (const line of BENCH_LINES) {
      const r = await runBench({ tasks, line, executor });
      expect(BenchReportSchema.safeParse(r).success, line).toBe(true);
      expect(r.results, line).toHaveLength(20);
      expect(r.results.every((x) => x.passed), line).toBe(true);
      reports.push(r);
    }
    expect(reports.flatMap((r) => r.results)).toHaveLength(80);
  });

  it('CognitiveCost 八字段齐全（每条结果）', async () => {
    for (const line of BENCH_LINES) {
      const r = await runBench({ tasks, line, executor });
      for (const res of r.results) {
        expect(CognitiveCostSchema.safeParse(res.cost).success, `${line}:${res.task_id}`).toBe(true);
        expect(Object.keys(res.cost).sort(), `${line}:${res.task_id}`).toEqual(COST_FIELDS);
      }
    }
  });
});

// ---- ③ 数字可复现 ----

describe('③ 数字可复现：同数据两次 runBench → 报告深度相等', () => {
  it('四线各跑两次 → 逐线报告 toEqual（passed + cost 逐位一致）', async () => {
    for (const line of BENCH_LINES) {
      const a = await runBench({ tasks, line, executor });
      const b = await runBench({ tasks, line, executor });
      expect(b).toEqual(a);
      expect(b.results.map((r) => r.cost)).toEqual(a.results.map((r) => r.cost));
    }
  });
});

// ---- ④ 元演化门禁连通（真实 governor.yaml 内容为 diff.from） ----

describe('④ 元演化门禁连通（governance.policy diff，from = 真实 governor.yaml）', () => {
  const noBaselineDeps = () => ({
    frozenBaseline: async () => null,
    runBaseline: async () => baselineReport,
  });
  const gateDeps = () => ({
    frozenBaseline: async () => baselineReport, // 当前冻结基线 = ② 真实 baseline 报告
    runBaseline: async () => baselineReport, // 应用 diff 后无回归（同数据）
  });
  const mc = (over: Partial<MetaChange> = {}): MetaChange => ({
    id: 'MC-LOOP-001',
    target: 'governance.policy',
    diff: { from: govFrom, to: govTo },
    proposed_by: 'm7-loop',
    human_review: { required: true },
    ...over,
  });

  it('无冻结基线 → 拒绝（no_frozen_baseline）', async () => {
    const r = await evaluateMetaChange(mc(), noBaselineDeps());
    expect(r).toEqual({ ok: false, reason: 'no_frozen_baseline' });
  });

  it('附真实基准 + 无回归但无人工批准 → 拒绝（awaiting_human_review）', async () => {
    const r = await evaluateMetaChange(mc({ baseline_report: baselineReport }), gateDeps());
    expect(r).toEqual({ ok: false, reason: 'awaiting_human_review' });
  });

  it('人工批准 → ok；applyMetaChange 真实写回（fixture 目录 = 真实 policy 副本，内容 = diff.to 且 schema 合规）', async () => {
    expect(await readFile(join(policyDir, 'governor.yaml'), 'utf8')).toBe(govFrom); // 写回前 = diff.from
    const approved = mc({
      baseline_report: baselineReport,
      human_review: { required: true, approved: true, reviewed_by: 'human-loop' },
    });
    const gate = await evaluateMetaChange(approved, gateDeps());
    expect(gate).toEqual({ ok: true, reason: 'ok' });
    await applyMetaChange(approved, { policyDir, eventStore, environment: ENV });

    const written = await readFile(join(policyDir, 'governor.yaml'), 'utf8');
    expect(written).toBe(govTo);
    expect(GovernorPolicySchema.safeParse(parseYaml(written)).success).toBe(true); // schema 合规
    const { events } = await eventStore.query({ type: 'evolution/policy-applied' });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.change_id).toBe('MC-LOOP-001');
    expect(events[0]!.payload.from).toBe(govFrom);
    expect(events[0]!.payload.to).toBe(govTo);
  });

  it('防呆连通：当前文件 ≠ diff.from（写回后）→ applyMetaChange 拒绝不覆盖', async () => {
    const drifted = mc({
      baseline_report: baselineReport,
      human_review: { required: true, approved: true, reviewed_by: 'human-loop' },
      diff: { from: `${govFrom}\n`, to: govTo }, // from 与磁盘现状（已是 govTo）不一致
    });
    await expect(applyMetaChange(drifted, { policyDir, eventStore, environment: ENV })).rejects.toThrow(
      /diff\.from/,
    );
  });
});

// ---- ⑤ bench-report 连通（真实 bench 数据 → 汇总正确；in-process，无 spawn） ----

describe('⑤ bench-report 连通（真实四线报告 → summarize 正确）', () => {
  it('80 结果全过、四线齐备、能力向量/成本均值/标定建议来自真实数据', async () => {
    const reports: BenchReport[] = [];
    for (const line of BENCH_LINES) {
      reports.push(await runBench({ tasks, line, executor }));
    }
    const s = summarizeReports(reports);
    expect(s.reportCount).toBe(4);
    expect(s.resultCount).toBe(80);
    expect(s.passedCount).toBe(80);
    expect(s.passRate).toBe(1);
    expect(s.allPass).toBe(true);
    expect(s.missingLines).toEqual([]);
    expect(s.failedTaskIds).toEqual([]);
    expect(computeExitCode(s)).toBe(0);
    for (const line of BENCH_LINES) {
      expect(s.byLine[line]).toEqual({ passed: 20, total: 20, rate: 1 });
    }
    for (const cat of BENCH_CATEGORIES) {
      expect(s.byCategory[cat].passed, cat).toBe(16); // 4 线 × 每类 4 任务
      expect(s.byCategory[cat].total, cat).toBe(16);
      expect(s.byCategory[cat].rate, cat).toBe(1);
      expect(s.byCategory[cat].tokensMean, cat).toBeGreaterThan(0);
    }
    expect(s.costMean.model_tokens).toBeGreaterThan(0);
    expect(s.calibration.length).toBeGreaterThan(0); // 真实成本数据 → 数据驱动建议（非凭空）
  });
});

// ---- ⑥ 跨里程碑连通（M4 过程执行链执行基准任务） ----

describe('⑥ 跨里程碑连通：基准任务经 M4 过程执行链（process-adapter → executeGraph）', () => {
  it('code 类任务 verifier 用真实断言：ProcessDef → toOperatorGraph → executeGraph 验证谓词 = runVerifier', async () => {
    const codeTask = tasks.find((t) => t.id === 'bench:code-01')!;
    const fixture = await loadBenchFixture(codeTask.verifier.ref);
    const verifyKey = `bench-verifier:${codeTask.id}`;
    const process: ProcessDef = {
      id: 'bench-m4-chain',
      version: '1.0.0',
      entry: 'EXECUTE',
      exit: 'EXECUTE',
      budget: { tokens: 100000, time_ms: 100000 },
      operators: [
        {
          id: 'run-bench',
          op: 'EXECUTE',
          input_binding: {},
          output: 'candidate_output',
          cost: { tokens: 100 },
          verification: verifyKey, // 算子验证谓词 = 基准任务 verifier（真实断言）
          error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无' },
        },
      ],
    };
    expect(ProcessDefSchema.safeParse(process).success).toBe(true);
    const graph = toOperatorGraph(process);
    // 回放执行语义（与 T7.1 同源：canned 输出）+ 真实 verifier 谓词
    const ctx = (output: unknown) => ({
      inputs: {},
      budget: 100000,
      registry: { EXECUTE: { run: async () => output } },
      verifiers: { [verifyKey]: (out: unknown) => runVerifier(codeTask, out, fixture) },
    });

    // 真实 fixture 输出 → verifier 真实断言通过 → 图成功
    const ok = await executeGraph(graph, ctx(fixture.output));
    expect(ok.ok).toBe(true);
    expect(ok.failed).toBe(false);
    expect(ok.completed).toEqual(['EXECUTE']);

    // 篡改输出（tests 摘要失败）→ 真实断言拒绝 → VERIFICATION_FAILED（错误契约连通）
    const bad = await executeGraph(graph, ctx({ passed: 4, failed: 1, total: 5 }));
    expect(bad.failed).toBe(true);
    expect(bad.error?.code).toBe('VERIFICATION_FAILED');
    expect(bad.error?.operator_id).toBe('EXECUTE');
  });
});

// ---- ⑦ 确定性/幂等：同数据两次全链一致 ----

describe('⑦ 确定性/幂等：同数据两次全链（四线 runBench → 元演化门禁 → 复盘汇总）一致', () => {
  it('两次全链运行 → 报告 / 门禁结果 / 汇总全部深相等', async () => {
    const runChain = async () => {
      const reports: BenchReport[] = [];
      for (const line of BENCH_LINES) {
        reports.push(await runBench({ tasks, line, executor }));
      }
      const mc: MetaChange = {
        id: 'MC-LOOP-002',
        target: 'governance.policy',
        diff: { from: govFrom, to: govTo },
        proposed_by: 'm7-loop',
        baseline_report: baselineReport,
        human_review: { required: true, approved: true, reviewed_by: 'human-loop' },
      };
      const gate = await evaluateMetaChange(mc, {
        frozenBaseline: async () => baselineReport,
        runBaseline: async () => baselineReport,
      });
      return { reports, gate, summary: summarizeReports(reports) };
    };
    const a = await runChain();
    const b = await runChain();
    expect(JSON.stringify(b.reports)).toBe(JSON.stringify(a.reports));
    expect(b.gate).toEqual(a.gate);
    expect(JSON.stringify(b.summary)).toBe(JSON.stringify(a.summary));
  });
});
