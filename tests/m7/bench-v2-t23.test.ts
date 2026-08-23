// T2.3 行为测试：基准 v2 契约化接线（prompt renderer + parseModelOutputV2 + makeRealExecutorV2 +
// runBenchV2 真实路径；施工计划 2026-08-23-bench-v2-contract.md T2.3）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① renderPromptV2 确定性：同契约同 fixture 两次 → 逐字符一致（字节级可复现）；
//   ② renderPromptV2 内容：requirement + 逐输入工件（json 紧凑文本 / text 原文 / file-list 确定性说明 /
//      test-cases language + 用例表）+ output_schema 序列化（唯一权威形状）+ 「不要输出 JSON 以外的解释文字」；
//   ③ renderOutputSchemaPrompt：序列化往返 == 契约 output_schema（prompt/verifier 共享同一 expectation）；
//   ④ parseModelOutputV2：裸 JSON / 围栏 JSON / 非法文本三分支；错误含片段截断；
//   ⑤ makeRealExecutorV2 + fake adapter：合法 JSON → output 正确 + cost 映射（model_tokens=usage 和、
//      latency_ms 计时、其余 0）+ 默认 maxTokens=8000 / reasoningEffort=low + system 含「不要长推理」；
//      非法文本 → output=undefined 不抛（rawText 保留）；opts 覆盖生效；
//   ⑥ runBenchV2 真实路径：oracle fake adapter（从 prompt 读任务 id → reference 输出序列化文本）→ 20/20；
//      解析失败任务 → passed=false 且落盘 failure_reason 含 parse 错误；
//   ⑦ makeRealExecutorV2：adapter 抛错 → 传播（fail-loud，不静默）。
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderOutputSchemaPrompt, renderPromptV2 } from '../../supervisor/bench-prompt-v2.js';
import {
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  parseModelOutputV2,
  runBenchV2,
  type BenchExecutorV2,
} from '../../supervisor/bench-v2.js';
import { makeRealExecutorV2 } from '../../supervisor/real-executor.js';
import type { ModelAdapter, ModelGenerateOptions, ModelGenerateResult } from '../../kernel/schemas/model-adapter.js';
import type { BenchContractV2, BenchFixtureV2 } from '../../kernel/schemas/bench.js';
import { getReference } from '../../kernel/bench-tasks/reference/index.js';

/** 临时目录工具 */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-bench-v2-t23-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 加载契约 + 夹具（测试内多次复用） */
async function loadAll() {
  const contracts = await loadBenchContractsV2();
  const fixtures = await loadBenchFixturesV2();
  const fixtureById = new Map(fixtures.map((f): [string, BenchFixtureV2] => [f.task_id, f]));
  return { contracts, fixtures, fixtureById };
}

/** oracle fake adapter：从 prompt 首行读任务 id → reference 输出序列化文本（模拟「模型答对」） */
function oracleAdapter(contracts: readonly BenchContractV2[]): ModelAdapter {
  const byId = new Map(contracts.map((c): [string, BenchContractV2] => [c.id, c]));
  return {
    provider: 'test',
    model: 'fake-oracle',
    async generate(prompt: string): Promise<ModelGenerateResult> {
      const m = /^# 基准任务 (\S+)/m.exec(prompt);
      const id = m?.[1];
      const contract = id === undefined ? undefined : byId.get(id);
      if (contract === undefined) {
        throw new Error(`fake adapter: prompt 缺任务 id（${prompt.slice(0, 40)}…）`);
      }
      const expected = getReference(contract.id)(contract.input_artifacts);
      return { text: JSON.stringify(expected), usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };
}

// ---- ①/②/③ 渲染器 ----

describe('① renderPromptV2 确定性（同契约同 fixture → 同文本）', () => {
  it('全量 20 契约：两次渲染逐字符一致', async () => {
    const { contracts, fixtureById } = await loadAll();
    for (const c of contracts) {
      const f = fixtureById.get(c.id)!;
      expect(renderPromptV2(c, f), c.id).toBe(renderPromptV2(c, f));
    }
  });
});

describe('② renderPromptV2 内容（requirement + 输入工件 + output_schema 唯一权威 + 禁止解释）', () => {
  it('data-01：requirement + json 工件紧凑内容 + output_schema 序列化', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'data-01')!;
    const f = fixtureById.get('data-01')!;
    const prompt = renderPromptV2(c, f);
    expect(prompt).toContain('# 基准任务 data-01');
    expect(prompt).toContain('将用户记录数组规范化为'); // requirement
    expect(prompt).toContain('### 输入工件 users'); // 工件名
    expect(prompt).toContain('"alice@example.com"'); // json 工件紧凑内容
    expect(prompt).toContain('"users"'); // output_schema 序列化（唯一权威形状）
    expect(prompt).toContain('不要输出 JSON 以外的解释文字');
  });

  it('code-01：test-cases → language + 用例表', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'code-01')!;
    const f = fixtureById.get('code-01')!;
    const prompt = renderPromptV2(c, f);
    expect(prompt).toContain('语言：TypeScript'); // language 工件并入 test-cases 块
    expect(prompt).toContain('| name | input | expected |');
    expect(prompt).toContain('| fib(0) | 0 | 0 |'); // 用例表行
    expect(prompt).toContain('| fib(20) | 20 | 6765 |');
  });

  it('sys-04：file-list → 显式 path/sorted/recursive 说明 + path 前缀清单', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'sys-04')!;
    const f = fixtureById.get('sys-04')!;
    const prompt = renderPromptV2(c, f);
    expect(prompt).toContain('目录扫描说明：根路径 = src；排序 = true；递归 = false');
    expect(prompt).toContain('- src/a.txt');
    expect(prompt).toContain('- src/b.txt');
  });

  it('text 工件：原文原样出现（language 工件内容 Python 与用例表并存）', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'code-02')!;
    const f = fixtureById.get('code-02')!;
    const prompt = renderPromptV2(c, f);
    expect(prompt).toContain('语言：Python'); // test-cases 块并入 language
    expect(prompt).toContain('| 忽略标点与空格 | "A man, a plan, a canal: Panama" | true |'); // text/JSON 确定性
  });
});

describe('③ renderOutputSchemaPrompt（序列化往返 == 契约 output_schema；prompt/verifier 同一 expectation）', () => {
  it('全量契约：JSON.parse(renderOutputSchemaPrompt(schema)) 深等于契约 output_schema', async () => {
    const { contracts } = await loadAll();
    for (const c of contracts) {
      const rendered = renderOutputSchemaPrompt(c.output_schema);
      expect(JSON.parse(rendered), c.id).toEqual(c.output_schema);
    }
  });
});

// ---- ④ 模型输出解析 ----

describe('④ parseModelOutputV2（裸 JSON / 围栏 JSON / 非法文本三分支）', () => {
  it('裸 JSON → ok:true + 解析值', () => {
    expect(parseModelOutputV2('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseModelOutputV2('  [1,2,3]  ')).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('围栏 JSON（```json / ```js / ```）→ ok:true（剥围栏后解析）', () => {
    expect(parseModelOutputV2('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseModelOutputV2('```js\n[1,2]\n```')).toEqual({ ok: true, value: [1, 2] });
    expect(parseModelOutputV2('```\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('非法文本 → ok:false + error 含解析详情与原文片段', () => {
    const r = parseModelOutputV2('这不是 JSON');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('模型输出解析失败');
      expect(r.error).toContain('这不是 JSON'); // 片段截断
    }
  });

  it('超长非法文本 → error 片段截断（…（截断））', () => {
    const long = 'x'.repeat(300);
    const r = parseModelOutputV2(long);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('…（截断）');
      expect(r.error.length).toBeLessThan(300);
    }
  });
});

// ---- ⑤/⑦ 真实执行器 v2 ----

describe('⑤ makeRealExecutorV2 + fake adapter（合法 JSON → output + cost 映射 + 默认参数）', () => {
  it('合法 JSON → output 正确；cost：model_tokens=usage 和、latency_ms≥0、其余 0；rawText 保留', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'data-01')!;
    const f = fixtureById.get('data-01')!;
    const expected = getReference('data-01')(c.input_artifacts);
    const adapter: ModelAdapter = {
      provider: 'test',
      model: 'fake',
      async generate(): Promise<ModelGenerateResult> {
        return { text: JSON.stringify(expected), usage: { inputTokens: 100, outputTokens: 50 } };
      },
    };
    const executor = makeRealExecutorV2(adapter);
    const t0 = Date.now();
    const r = await executor(c, f);
    const elapsed = Date.now() - t0;
    expect(r.output).toEqual(expected);
    expect(r.rawText).toBe(JSON.stringify(expected));
    expect(r.cost.model_tokens).toBe(150);
    expect(r.cost.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.cost.latency_ms).toBeLessThanOrEqual(elapsed + 5);
    expect(r.cost.tool_calls).toBe(0);
    expect(r.cost.retrieval_calls).toBe(0);
    expect(r.cost.reacquisition).toBe(0);
    expect(r.cost.branch_count).toBe(0);
    expect(r.cost.memory_pollution).toBe(0);
    expect(r.cost.corrections).toBe(0);
  });

  it('默认 generate opts：maxTokens=8000、reasoningEffort=low、system 含「不要长推理」与 output_schema；opts 覆盖生效', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'data-01')!;
    const f = fixtureById.get('data-01')!;
    const captured: ModelGenerateOptions[] = [];
    const adapter: ModelAdapter = {
      provider: 'test',
      model: 'fake',
      async generate(_prompt: string, genOpts: ModelGenerateOptions = {}): Promise<ModelGenerateResult> {
        captured.push(genOpts);
        return { text: '{"users":[]}', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const executor = makeRealExecutorV2(adapter);
    await executor(c, f);
    expect(captured[0]!.maxTokens).toBe(8000);
    expect(captured[0]!.reasoningEffort).toBe('low');
    expect(captured[0]!.system).toContain('不要长推理');
    expect(captured[0]!.system).toContain('output_schema');
    // opts 覆盖（预算/推理档位可调）
    const overridden = makeRealExecutorV2(adapter, { maxTokens: 16000, reasoningEffort: 'high' });
    await overridden(c, f);
    expect(captured[1]!.maxTokens).toBe(16000);
    expect(captured[1]!.reasoningEffort).toBe('high');
  });

  it('非法文本 → output=undefined 不抛（rawText 保留；判定交由 runBenchV2）', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'data-01')!;
    const f = fixtureById.get('data-01')!;
    const adapter: ModelAdapter = {
      provider: 'test',
      model: 'fake',
      async generate(): Promise<ModelGenerateResult> {
        return { text: '这不是 JSON', usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const executor = makeRealExecutorV2(adapter);
    const r = await executor(c, f);
    expect(r.output).toBeUndefined();
    expect(r.rawText).toBe('这不是 JSON');
  });
});

describe('⑦ makeRealExecutorV2 fail-loud：adapter 抛错 → 传播（不静默）', () => {
  it('generate 抛错 → executor reject', async () => {
    const { contracts, fixtureById } = await loadAll();
    const c = contracts.find((x) => x.id === 'data-01')!;
    const f = fixtureById.get('data-01')!;
    const failing: ModelAdapter = {
      provider: 'test',
      model: 'fake',
      async generate() {
        throw new Error('provider unreachable');
      },
    };
    await expect(makeRealExecutorV2(failing)(c, f)).rejects.toThrow(/provider unreachable/);
  });
});

// ---- ⑥ runBenchV2 真实路径 ----

describe('⑥ runBenchV2 真实路径（oracle fake adapter → 20/20；解析失败 → passed=false + parse 归因）', () => {
  it('oracle adapter（prompt 读任务 id → reference 输出序列化文本）→ 20/20', async () => {
    const { contracts, fixtures, fixtureById } = await loadAll();
    const realV2 = makeRealExecutorV2(oracleAdapter(contracts));
    const executor: BenchExecutorV2 = (task) => realV2(task, fixtureById.get(task.id)!);
    const report = await runBenchV2({ contracts, fixtures, line: 'stable', executor, mode: 'real' });
    expect(report.total).toBe(20);
    expect(report.passed).toBe(20);
    expect(report.results.every((r) => r.passed)).toBe(true);
    expect(report.results.map((r) => r.task_id).sort()).toEqual(contracts.map((c) => c.id).sort());
  });

  it('解析失败任务 → passed=false 且落盘 failure_reason 含 parse 错误；其余 19 任务通过', async () => {
    await withTempDir(async (dir) => {
      const { contracts, fixtures, fixtureById } = await loadAll();
      const base = oracleAdapter(contracts);
      const adapter: ModelAdapter = {
        provider: 'test',
        model: 'fake-garbage-sys04',
        async generate(prompt: string): Promise<ModelGenerateResult> {
          const m = /^# 基准任务 (\S+)/m.exec(prompt);
          if (m?.[1] === 'sys-04') {
            return { text: '这是一个不可解析的模型输出', usage: { inputTokens: 3, outputTokens: 3 } };
          }
          return base.generate(prompt);
        },
      };
      const realV2 = makeRealExecutorV2(adapter);
      const executor: BenchExecutorV2 = (task) => realV2(task, fixtureById.get(task.id)!);
      const report = await runBenchV2({
        contracts,
        fixtures,
        line: 'stable',
        executor,
        mode: 'real',
        persistDir: dir,
      });
      expect(report.passed).toBe(19);
      const sys04 = report.results.find((r) => r.task_id === 'sys-04')!;
      expect(sys04.passed).toBe(false);
      // 落盘明细：sys-04 记录 failure_reason 含 parse 错误（归因可查）
      const files = (await readdir(dir)).filter((f) => f.startsWith('real-v2-stable-') && f.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      const lines = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(20);
      const record = JSON.parse(lines.find((l) => (JSON.parse(l) as { task_id: string }).task_id === 'sys-04')!) as {
        failure_reason: string | null;
        output: unknown;
      };
      expect(record.failure_reason).toContain('parse');
      expect(record.failure_reason).toContain('模型输出解析失败');
      expect(record.output).toBeUndefined();
    });
  });

  it('回放执行器仍 20/20（T2.3 接线不回归 T2.1/T2.2 回放语义）', async () => {
    const { contracts, fixtures } = await loadAll();
    const report = await runBenchV2({
      contracts,
      fixtures,
      line: 'initial',
      executor: makeReplayExecutorV2(fixtures),
    });
    expect(report.total).toBe(20);
    expect(report.passed).toBe(20);
  });
});
