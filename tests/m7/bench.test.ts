// T7.1 行为测试：冻结基准集与成本度量（supervisor/bench.ts + kernel/schemas/bench.ts +
// kernel/bench-tasks/ 数据文件；架构 §15 成功标准与基准 / §17 参数标定）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖（brief 测试清单 1-7）：
//   ① 基准集完整性：20 任务 = 5 类 × 4；schema 校验全过；每任务 verifier 类型合法（含 §15 category→kind 映射）
//   ② verifier 接入：tests/exact/predicate/state_assert/blind_judge 各验证一例（对/错各构造）
//   ③ 三线对照：initial/stable/latest + baseline 各跑 → 报告结构完整（4 × N 结果）
//   ④ 数字可复现：同 executor 跑两次 → 相同 passed/cost（确定性断言）
//   ⑤ CognitiveCost 八字段：结构校验；全零合法（无信号时）
//   ⑥ 失败任务：verifier 不过 → passed false 记录
//   ⑦ blind_judge：离线规则化 judge 对固定语料给出确定判定（无 LLM 依赖）
//   ⑧ 数据完整性守卫：assertFixtureMatchesVerifier 每种 kind 缺载荷 fail-loud；接线后回放 executor
//      在 loadBenchFixture 后调用（fixture 与 verifier 不匹配 → runBench 抛错，而非静默 passed=false）
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BENCH_CATEGORIES,
  BenchReportSchema,
  BenchTaskSchema,
  CATEGORY_VERIFIER_KIND,
  CognitiveCostSchema,
  FROZEN_BENCH_COUNTS,
  VERIFIER_KINDS,
  type BenchFixture,
  type BenchLine,
  type BenchTask,
  type CognitiveCost,
  type VerifierKind,
} from '../../kernel/schemas/bench.js';
import {
  assertFixtureMatchesVerifier,
  assertFrozenSetComplete,
  loadBenchFixture,
  loadBenchTasks,
  makeReplayExecutor,
  runBench,
  runVerifier,
  zeroCost,
  type BenchExecutor,
} from '../../supervisor/bench.js';

// ---- 测试工具 ----

/** 基准任务工厂（overrides 覆盖单字段，便于造样例） */
function task(overrides: Partial<BenchTask> = {}): BenchTask {
  return {
    id: 'bench:test',
    category: 'data',
    prompt: '测试任务',
    fixture_ref: 'test.fixture.json',
    verifier: { kind: 'exact', ref: 'test.fixture.json' },
    ...overrides,
  };
}

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

describe('① 基准集完整性（架构 §15：20 任务 = 5 类 × 4；schema 校验全过）', () => {
  it('加载 kernel/bench-tasks 数据 → 恰好 20 任务', async () => {
    const tasks = await loadBenchTasks();
    expect(tasks).toHaveLength(20);
  });

  it('每类恰好 4 任务（5 类 × 4 = 20，FROZEN_BENCH_COUNTS 为数据）', async () => {
    const tasks = await loadBenchTasks();
    for (const category of BENCH_CATEGORIES) {
      const n = tasks.filter((t) => t.category === category).length;
      expect(n, category).toBe(FROZEN_BENCH_COUNTS[category]);
    }
  });

  it('assertFrozenSetComplete：5 类 × 4 通过；缺类/超额/重复 id 拒绝', async () => {
    const tasks = await loadBenchTasks();
    expect(() => assertFrozenSetComplete(tasks)).not.toThrow();
    // 缺一类（research 全删）→ 拒绝
    expect(() => assertFrozenSetComplete(tasks.filter((t) => t.category !== 'research'))).toThrow();
    // 超额（21 任务）→ 拒绝
    expect(() => assertFrozenSetComplete([...tasks, task({ id: 'bench:x1', category: 'data' })])).toThrow();
    // 重复 id → 拒绝
    const dup = [...tasks];
    dup[19] = { ...tasks[19]!, id: tasks[0]!.id };
    expect(() => assertFrozenSetComplete(dup)).toThrow();
  });

  it('每任务过 BenchTaskSchema；verifier kind 合法且匹配 §15 category→kind 映射', async () => {
    const tasks = await loadBenchTasks();
    for (const t of tasks) {
      expect(BenchTaskSchema.safeParse(t).success, t.id).toBe(true);
      expect(VERIFIER_KINDS).toContain(t.verifier.kind);
      expect(t.verifier.kind, t.id).toBe(CATEGORY_VERIFIER_KIND[t.category]);
    }
  });

  it('fixture 可加载、载荷与 verifier kind 匹配、录制 output 自洽通过 verifier', async () => {
    const tasks = await loadBenchTasks();
    for (const t of tasks) {
      const fixture = await loadBenchFixture(t.verifier.ref);
      expect(() => assertFrozenSetComplete(tasks)).not.toThrow(); // 集合整体自洽（每次重查）
      expect(runVerifier(t, fixture.output, fixture), t.id).toBe(true);
    }
  });
});

describe('② verifier 接入（tests/exact/predicate/state_assert/blind_judge：对/错各构造）', () => {
  it('tests：测试摘要全过 → true；失败用例/总数不符 → false', () => {
    const t = task({
      id: 'bench:ut-tests',
      category: 'code',
      verifier: { kind: 'tests', ref: 'ut.fixture.json', expected_pass: 5 },
    });
    const fixture: BenchFixture = { output: { passed: 5, failed: 0, total: 5 }, cost: cost(), total: 5 };
    expect(runVerifier(t, { passed: 5, failed: 0, total: 5 }, fixture)).toBe(true);
    expect(runVerifier(t, { passed: 4, failed: 1, total: 5 }, fixture)).toBe(false);
    expect(runVerifier(t, { passed: 5, failed: 0, total: 6 }, fixture)).toBe(false);
  });

  it('exact：深度相等 → true；不等 → false', () => {
    const t = task({
      id: 'bench:ut-exact',
      category: 'data',
      verifier: { kind: 'exact', ref: 'ut.fixture.json' },
    });
    const fixture: BenchFixture = {
      output: { users: [{ id: 'u1' }] },
      cost: cost(),
      expected: { users: [{ id: 'u1' }] },
    };
    expect(runVerifier(t, { users: [{ id: 'u1' }] }, fixture)).toBe(true);
    expect(runVerifier(t, { users: [{ id: 'u2' }] }, fixture)).toBe(false);
  });

  it('predicate：全部目标谓词满足 → true；任一不满足 → false', () => {
    const t = task({
      id: 'bench:ut-pred',
      category: 'web',
      verifier: { kind: 'predicate', ref: 'ut.fixture.json' },
    });
    const fixture: BenchFixture = {
      output: { title: 'OMB 文档中心', nav: { items: ['首页', '文档'] }, count: 2 },
      cost: cost(),
      predicates: [
        { path: 'title', matches: 'OMB' },
        { path: 'nav.items', contains: '文档' },
        { path: 'count', equals: 2 },
      ],
    };
    expect(runVerifier(t, { title: 'OMB 文档中心', nav: { items: ['首页', '文档'] }, count: 2 }, fixture)).toBe(true);
    expect(runVerifier(t, { title: '别的', nav: { items: ['首页', '文档'] }, count: 2 }, fixture)).toBe(false);
    expect(runVerifier(t, { title: 'OMB 文档中心', nav: { items: [] }, count: 2 }, fixture)).toBe(false);
  });

  it('state_assert：前后状态均匹配 → true；after 不符 → false', () => {
    const t = task({
      id: 'bench:ut-sys',
      category: 'sys',
      verifier: { kind: 'state_assert', ref: 'ut.fixture.json' },
    });
    const fixture: BenchFixture = {
      output: { before: { 'cfg.ini': null }, after: { 'cfg.ini': '[settings]' } },
      cost: cost(),
      before: { 'cfg.ini': null },
      after: { 'cfg.ini': '[settings]' },
    };
    expect(runVerifier(t, { before: { 'cfg.ini': null }, after: { 'cfg.ini': '[settings]' } }, fixture)).toBe(true);
    expect(runVerifier(t, { before: { 'cfg.ini': null }, after: { 'cfg.ini': '[other]' } }, fixture)).toBe(false);
  });

  it('blind_judge：含全部必需术语 → true；缺一 → false（规则化，无 LLM）', () => {
    const t = task({
      id: 'bench:ut-bj',
      category: 'research',
      verifier: { kind: 'blind_judge', ref: 'ut.fixture.json' },
    });
    const fixture: BenchFixture = {
      output: '采用 SQLite 与 FTS5',
      cost: cost(),
      rubric: { required_terms: ['SQLite', 'FTS5'] },
    };
    expect(runVerifier(t, '采用 SQLite 与 FTS5', fixture)).toBe(true);
    expect(runVerifier(t, '采用 SQLite', fixture)).toBe(false);
  });
});

describe('③ 三线对照 + 无插件基线（4 × N 结果结构完整）', () => {
  it('initial/stable/latest/baseline 各跑一次 → 每线 N 结果，合计 4 × N', async () => {
    const tasks = await loadBenchTasks();
    const executor = makeReplayExecutor();
    const lines: BenchLine[] = ['initial', 'stable', 'latest', 'baseline'];
    const reports: Array<Awaited<ReturnType<typeof runBench>>> = [];
    for (const line of lines) {
      const report = await runBench({ tasks, line, executor });
      expect(BenchReportSchema.safeParse(report).success).toBe(true);
      expect(report.line).toBe(line);
      expect(report.results).toHaveLength(tasks.length);
      for (const r of report.results) {
        expect(r.line).toBe(line);
        expect(CognitiveCostSchema.safeParse(r.cost).success).toBe(true);
        expect(tasks.some((t) => t.id === r.task_id)).toBe(true);
      }
      reports.push(report);
    }
    const all = reports.flatMap((r) => r.results);
    expect(all).toHaveLength(4 * tasks.length);
  });

  it('冻结基准集自洽：录制 output 通过各自 verifier（passed 全 true，基线亦然）', async () => {
    const tasks = await loadBenchTasks();
    for (const line of ['stable', 'baseline'] as const) {
      const report = await runBench({ tasks, line, executor: makeReplayExecutor() });
      expect(report.results.every((r) => r.passed), line).toBe(true);
    }
  });
});

describe('④ 数字可复现（同 fixture 同 executor → 同 passed + 同 cost）', () => {
  it('同回放 executor 跑两次 → 报告逐位一致', async () => {
    const tasks = await loadBenchTasks();
    const executor = makeReplayExecutor();
    const r1 = await runBench({ tasks, line: 'stable', executor });
    const r2 = await runBench({ tasks, line: 'stable', executor });
    expect(r2).toEqual(r1);
    for (let i = 0; i < r1.results.length; i++) {
      expect(r2.results[i]?.passed).toBe(r1.results[i]?.passed);
      expect(r2.results[i]?.cost).toEqual(r1.results[i]?.cost);
    }
  });

  it('注入的确定性 executor 两次 → 相同（executor 注入可复现契约）', async () => {
    const tasks = [task({ id: 'bench:rep', category: 'data', verifier: { kind: 'exact', ref: 'x' } })];
    const executor: BenchExecutor = async () => ({ passed: true, cost: cost({ model_tokens: 100 }) });
    const a = await runBench({ tasks, line: 'initial', executor });
    const b = await runBench({ tasks, line: 'initial', executor });
    expect(a).toEqual(b);
  });
});

describe('⑤ CognitiveCost 八字段（架构 §15；最低 token ≠ 最低成本）', () => {
  it('八字段结构校验：合法值通过', () => {
    const c: CognitiveCost = {
      model_tokens: 1200,
      tool_calls: 8,
      retrieval_calls: 2,
      reacquisition: 1,
      latency_ms: 3420.5,
      branch_count: 3,
      memory_pollution: 0.4,
      corrections: 1,
    };
    expect(CognitiveCostSchema.safeParse(c).success).toBe(true);
  });

  it('全零合法（无信号时）', () => {
    expect(CognitiveCostSchema.safeParse(zeroCost()).success).toBe(true);
    expect(zeroCost()).toEqual({
      model_tokens: 0,
      tool_calls: 0,
      retrieval_calls: 0,
      reacquisition: 0,
      latency_ms: 0,
      branch_count: 0,
      memory_pollution: 0,
      corrections: 0,
    });
  });

  it('负值拒绝；计数类字段非整数拒绝', () => {
    expect(CognitiveCostSchema.safeParse(cost({ model_tokens: -1 })).success).toBe(false);
    expect(CognitiveCostSchema.safeParse(cost({ tool_calls: -1 })).success).toBe(false);
    expect(CognitiveCostSchema.safeParse(cost({ model_tokens: 1.5 })).success).toBe(false);
    expect(CognitiveCostSchema.safeParse(cost({ corrections: 0.5 })).success).toBe(false);
  });

  it('缺字段拒绝（八字段必填）', () => {
    const c = cost() as Partial<CognitiveCost>;
    delete c.latency_ms;
    expect(CognitiveCostSchema.safeParse(c).success).toBe(false);
  });
});

describe('⑥ 失败任务：verifier 不过 → passed false 记录', () => {
  it('回放 executor + 篡改输出 → verifier 不过 → 报告中 passed false + cost 记录', async () => {
    const tasks = await loadBenchTasks();
    const t = tasks.find((x) => x.id === 'bench:data-01');
    expect(t).toBeDefined();
    const fixture = await loadBenchFixture(t!.verifier.ref);
    // executor：对 data-01 用错误输出（verifier 不过），cost 仍如实采集
    const executor: BenchExecutor = async (task) => {
      const f = await loadBenchFixture(task.verifier.ref);
      const output = task.id === 'bench:data-01' ? { tampered: true } : f.output;
      return { passed: runVerifier(task, output, f), cost: f.cost };
    };
    const report = await runBench({ tasks: [t!], line: 'baseline', executor });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.line).toBe('baseline');
    expect(report.results[0]?.cost).toEqual(fixture.cost);
  });

  it('混合运行：通过/失败任务并存记录（失败任务被如实标记）', async () => {
    const tasks = await loadBenchTasks();
    const badId = tasks[0]!.id;
    const executor: BenchExecutor = async (task) => {
      const f = await loadBenchFixture(task.verifier.ref);
      const output = task.id === badId ? 'WRONG-ANSWER' : f.output;
      return { passed: runVerifier(task, output, f), cost: f.cost };
    };
    const report = await runBench({ tasks, line: 'initial', executor });
    const bad = report.results.find((r) => r.task_id === badId);
    expect(bad?.passed).toBe(false);
    expect(report.results.filter((r) => r.passed)).toHaveLength(tasks.length - 1);
  });
});

describe('⑦ blind_judge 离线规则化（无 LLM 依赖，固定语料确定性判定）', () => {
  const t = task({
    id: 'bench:ut-bj2',
    category: 'research',
    verifier: { kind: 'blind_judge', ref: 'ut.fixture.json' },
  });
  const fixture: BenchFixture = {
    output: '使用 sqlite 与 fts5',
    cost: cost(),
    rubric: { required_terms: ['SQLite', 'FTS5'] },
  };

  it('含全部必需术语（大小写不敏感）→ true', () => {
    expect(runVerifier(t, '采用 SQLite 和 FTS5 存储', fixture)).toBe(true);
    expect(runVerifier(t, '采用 sqlite 和 fts5 存储', fixture)).toBe(true);
  });

  it('缺任一必需术语 / 空输出 → false', () => {
    expect(runVerifier(t, '采用 SQLite', fixture)).toBe(false);
    expect(runVerifier(t, '采用 FTS5', fixture)).toBe(false);
    expect(runVerifier(t, '', fixture)).toBe(false);
  });

  it('确定性：同输入两次 → 同判定（无随机/无外部依赖）', () => {
    const input = '采用 SQLite 和 FTS5 存储';
    expect(runVerifier(t, input, fixture)).toBe(runVerifier(t, input, fixture));
  });

  it('空 rubric（无术语）→ false（不误判通过）', () => {
    const empty: BenchFixture = { output: 'x', cost: cost(), rubric: { required_terms: [] } };
    expect(runVerifier(t, 'anything', empty)).toBe(false);
  });
});

describe('⑧ 数据完整性守卫（assertFixtureMatchesVerifier：fail-loud 接线）', () => {
  /** 全载荷 fixture：五类 verifier 所需载荷齐备（守卫不抛的基准） */
  const fullFixture = (): BenchFixture => ({
    output: { ok: 1 },
    cost: cost(),
    expected: { ok: 1 },
    predicates: [{ path: 'ok', equals: 1 }],
    before: null,
    after: null,
    total: 1,
    rubric: { required_terms: ['ok'] },
  });

  /** 每种 kind 缺其必需载荷的 fixture（守卫应 fail-loud） */
  const missingPayloadByKind: Readonly<Record<VerifierKind, { fixture: BenchFixture; token: string }>> = {
    tests: { fixture: { output: { passed: 1, failed: 0, total: 1 }, cost: cost() }, token: 'total' },
    exact: { fixture: { output: { ok: 1 }, cost: cost() }, token: 'expected' },
    predicate: { fixture: { output: { ok: 1 }, cost: cost() }, token: 'predicates' },
    state_assert: { fixture: { output: { before: null, after: null }, cost: cost() }, token: 'before' },
    blind_judge: { fixture: { output: 'x', cost: cost() }, token: 'required_terms' },
  };

  it('每种 kind：缺必需载荷 → 抛错（fail-loud，报不匹配 + 缺载荷名）；载荷齐备 → 不抛', () => {
    for (const kind of VERIFIER_KINDS) {
      const t = task({ id: `bench:guard-${kind}`, verifier: { kind, ref: 'x.json' } });
      const { fixture, token } = missingPayloadByKind[kind];
      let caught: unknown;
      try {
        assertFixtureMatchesVerifier(t, fixture);
      } catch (e) {
        caught = e;
      }
      expect(caught, kind).toBeInstanceOf(Error);
      expect((caught as Error).message, kind).toMatch(/不匹配/);
      expect((caught as Error).message, kind).toContain(token);
      expect(() => assertFixtureMatchesVerifier(t, fullFixture()), kind).not.toThrow();
    }
  });

  it('接线：exact kind + fixture 缺 expected → 回放 executor fail-loud，runBench 抛错（而非静默 passed=false）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-bench-guard-'));
    try {
      const ref = 'guard.mismatch.json';
      await writeFile(join(dir, ref), JSON.stringify({ output: { ok: 1 }, cost: cost() }), 'utf8');
      const t = task({
        id: 'bench:guard-exact',
        category: 'data',
        verifier: { kind: 'exact', ref },
      });
      const executor = makeReplayExecutor({ fixturesDir: dir });
      await expect(runBench({ tasks: [t], line: 'stable', executor })).rejects.toThrow(/不匹配/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
