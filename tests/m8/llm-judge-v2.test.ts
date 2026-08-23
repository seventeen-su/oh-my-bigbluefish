// P4 TDD 测试：v2 管道 LLM judge 全任务双判对照（D6 裁决——/bench 真实路径 20 任务全部规则+LLM judge
// 对照；架构 §7.1 L3 语义层：盲化（judge 不知候选身份）+ judge 仅旁证、永不作晋升硬信号）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① buildJudgePromptV2 盲化：prompt 只含任务要求/rubric/输出文本，不含任务 id/候选身份/来源标记
//      （构造含敏感标记的任务/输出 → prompt 无泄漏断言）
//   ② buildJudgePromptV2 按 verifier.kind 构造评判依据：exact/tests/state_assert → expected
//      （语义一致性）；predicate/blind_judge → rubric
//   ③ makeJudgeV2：fake adapter 返回判词 JSON → JudgeVerdict + 成本单列（model_tokens=usage 和、
//      latency 计时）；非法判词/非 JSON/adapter 抛错 → null（降级不 fail-loud——judge 仅旁证）
//   ④ runBenchV2 双判（real 模式）：规则判定（verifyV2）+ judge 判定并存；JSONL 落盘含 judge 段
//   ⑤ judge 失败（返回 null/抛错）→ 该任务 judge=null、规则判定照常、报告记降级计数
//   ⑥ 全任务：20 契约 judge 全部被调用（计数=20）；judge 'unknown' 不计降级、不计一致率分母
//   ⑦ 回放模式（mode=replay）注入 judge → 不调用（judge 仅真实执行路径；回放产物无评判意义）
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJudgePromptV2, makeJudgeV2 } from '../../supervisor/judge.js';
import {
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  runBenchV2,
  type JudgeFnV2,
} from '../../supervisor/bench-v2.js';
import { zeroCost } from '../../supervisor/bench.js';
import type { ModelAdapter } from '../../kernel/schemas/model-adapter.js';
import type { BenchContractV2, BenchFixtureV2 } from '../../kernel/schemas/bench.js';

// ---- 测试工具 ----

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-judge-v2-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** exact 契约（id 含敏感标记——盲化断言用：id 不得出现在 prompt） */
function exactContract(over: Partial<BenchContractV2> = {}): BenchContractV2 {
  return {
    id: 'secret-task-42',
    category: 'data',
    requirement: '将用户记录数组规范化为 { users: [{ id, name, email }] }',
    input_artifacts: [],
    output_schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } },
          },
        },
      },
      required: ['users'],
    },
    verifier: { kind: 'exact' },
    generator: { name: 'test', version: '1.0.0' },
    ...over,
  };
}

function fixtureV2(over: Partial<BenchFixtureV2> = {}): BenchFixtureV2 {
  return {
    task_id: 'secret-task-42',
    generated_by: { name: 'test', version: '1.0.0' },
    input: [],
    expected: { users: [{ id: 'u1', name: 'Alice', email: 'a@x.com' }] },
    output: { users: [{ id: 'u1', name: 'Alice', email: 'a@x.com' }] },
    ...over,
  };
}

/** 固定通过的 v2 执行器（按 task_id 回传 fixture.expected；runBenchV2 executor 单参契约） */
function passingExecutor(fixtures: readonly BenchFixtureV2[]) {
  const byId = new Map(fixtures.map((f): [string, BenchFixtureV2] => [f.task_id, f]));
  return async (task: BenchContractV2) => ({ output: byId.get(task.id)!.expected, cost: zeroCost() });
}

// ---- ① 盲化 ----

describe('① buildJudgePromptV2 盲化（judge 只见任务要求/rubric/输出文本，不知候选身份——§7.1）', () => {
  it('prompt 不含任务 id / 候选身份 / 来源标记（敏感 id 不泄漏；顶层字段仅要求/期望/输出/指令）', () => {
    const prompt = buildJudgePromptV2(exactContract(), fixtureV2(), fixtureV2().expected);
    // 任务 id（敏感标记）不得泄漏——id 不在 requirement/output 中，出现即证明 prompt 带身份字段
    expect(prompt).not.toContain('secret-task-42');
    // 候选身份/来源标记（版本线、候选、fixture 引用）不得出现
    expect(prompt).not.toContain('candidate');
    expect(prompt).not.toContain('initial');
    expect(prompt).not.toContain('stable');
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['expected', 'instruction', 'output', 'requirement']);
  });

  it('构造含敏感标记的输出 → prompt 只以 output 原样承载，无独立身份字段（无泄漏断言）', () => {
    // 输出本身可含任意内容（这是被评判对象）；prompt 结构不得新增身份字段
    const output = { users: [{ id: 'u1', name: 'Alice', email: 'a@x.com' }], source: 'candidate-stable' };
    const prompt = buildJudgePromptV2(exactContract(), fixtureV2(), output);
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['expected', 'instruction', 'output', 'requirement']);
    expect(parsed.output).toEqual(output); // 输出原样（评判对象）
  });
});

// ---- ② 按任务类型构造评判依据 ----

describe('② buildJudgePromptV2 按 verifier.kind 构造评判依据（D6 全任务双判）', () => {
  it('exact/tests/state_assert → expected（语义一致性评判）', () => {
    const parsed = JSON.parse(buildJudgePromptV2(exactContract(), fixtureV2(), { x: 1 })) as Record<string, unknown>;
    expect(parsed.expected).toEqual(fixtureV2().expected);
    expect(parsed).not.toHaveProperty('rubric');
  });

  it('predicate → rubric = rules.predicates', () => {
    const c = exactContract({
      id: 'web-01',
      category: 'web',
      verifier: { kind: 'predicate', rules: { predicates: [{ path: 'title', matches: 'OMB' }] } },
    });
    const parsed = JSON.parse(buildJudgePromptV2(c, fixtureV2(), { title: 'OMB 文档中心' })) as Record<string, unknown>;
    expect(parsed.rubric).toEqual({ predicates: [{ path: 'title', matches: 'OMB' }] });
    expect(parsed).not.toHaveProperty('expected');
  });

  it('blind_judge → rubric = rules（required_terms 语义覆盖评判）', () => {
    const c = exactContract({
      id: 'research-01',
      category: 'research',
      verifier: { kind: 'blind_judge', rules: { rubric: { required_terms: ['动机', '方法'] } } },
    });
    const parsed = JSON.parse(buildJudgePromptV2(c, fixtureV2(), '答案文本')) as Record<string, unknown>;
    expect(parsed.rubric).toEqual({ rubric: { required_terms: ['动机', '方法'] } });
    expect(parsed).not.toHaveProperty('expected');
    expect(parsed.instruction).toContain('rubric');
  });
});

// ---- ③ makeJudgeV2 ----

describe('③ makeJudgeV2：判词 + 成本单列；非法/抛错 → null（降级不 fail-loud）', () => {
  it('fake adapter 返回判词 JSON → JudgeVerdict（verdict/reason）+ cost（model_tokens=usage 和、latency≥0）；默认参数 low/1000', async () => {
    let capturedMaxTokens: number | undefined;
    let capturedEffort: unknown;
    const adapter: ModelAdapter = {
      provider: 'test',
      model: 'fake-judge-v2',
      async generate(_prompt, opts = {}) {
        capturedMaxTokens = opts.maxTokens;
        capturedEffort = opts.reasoningEffort;
        return { text: JSON.stringify({ verdict: 'pass', reason: '语义一致' }), usage: { inputTokens: 30, outputTokens: 10 } };
      },
    };
    const judge = makeJudgeV2(adapter);
    const verdict = await judge(exactContract(), fixtureV2(), fixtureV2().expected);
    expect(capturedMaxTokens).toBe(1000);
    expect(capturedEffort).toBe('low');
    expect(verdict).not.toBeNull();
    expect(verdict!.verdict).toBe('pass');
    expect(verdict!.reason).toBe('语义一致');
    expect(verdict!.cost).toEqual({ model_tokens: 40, latency_ms: expect.any(Number) });
  });

  it('非法判词（非 JSON / verdict 越界）→ null（不 fail-loud：judge 仅旁证，规则判定照常）', async () => {
    const nonJson = makeJudgeV2({
      provider: 'test', model: 'x',
      async generate() { return { text: '无法判断' }; },
    });
    expect(await nonJson(exactContract(), fixtureV2(), 1)).toBeNull();

    const badVerdict = makeJudgeV2({
      provider: 'test', model: 'x',
      async generate() { return { text: JSON.stringify({ verdict: 'maybe' }) }; },
    });
    expect(await badVerdict(exactContract(), fixtureV2(), 1)).toBeNull();
  });

  it('adapter 抛错（超时/无模型）→ null（降级路径）', async () => {
    const failing = makeJudgeV2({
      provider: 'test', model: 'x',
      async generate() { throw new Error('provider timeout'); },
    });
    expect(await failing(exactContract(), fixtureV2(), 1)).toBeNull();
  });
});

// ---- ④/⑤/⑥/⑦ runBenchV2 双判 ----

describe('④ runBenchV2 双判（real 模式）：规则判定 + judge 判定并存；JSONL 含 judge 段', () => {
  it('fake judge 注入 → 结果与 JSONL 均含 judge（verdict + cost）；规则判定照常（passed=true 并存）', async () => {
    await withTempDir(async (dir) => {
      const c = exactContract();
      const f = fixtureV2();
      const report = await runBenchV2({
        contracts: [c],
        fixtures: [f],
        line: 'stable',
        executor: passingExecutor([f]),
        mode: 'real',
        judge: async () => ({
          verdict: 'pass',
          reason: '与期望语义一致',
          cost: { model_tokens: 40, latency_ms: 12 },
        }),
        persistDir: dir,
      });
      expect(report.results[0]!.passed).toBe(true); // 规则判定照常
      expect(report.results[0]!.judge).toEqual({
        verdict: 'pass',
        reason: '与期望语义一致',
        cost: { model_tokens: 40, latency_ms: 12 },
      });
      expect(report.judge.enabled).toBe(true);
      expect(report.judge.run).toBe(1);
      expect(report.judge.pass).toBe(1);
      expect(report.judge.agree).toBe(1);
      expect(report.judge.rate).toBe(1);
      expect(report.judge.degraded).toBe(0);
      // JSONL 落盘含 judge 段
      const files = (await readdir(dir)).filter((x) => x.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      const lines = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n');
      const record = JSON.parse(lines[0]!) as { judge: unknown; passed: boolean };
      expect(record.passed).toBe(true);
      expect(record.judge).toEqual({
        verdict: 'pass',
        reason: '与期望语义一致',
        cost: { model_tokens: 40, latency_ms: 12 },
      });
    });
  });
});

describe('⑤ judge 失败（返回 null / 抛错）→ judge=null + 降级计数；规则判定照常', () => {
  it('judge 返回 null → results[0].judge=null、report.judge.degraded=1、passed 不受影响', async () => {
    const c = exactContract();
    const f = fixtureV2();
    const report = await runBenchV2({
      contracts: [c],
      fixtures: [f],
      line: 'stable',
      executor: passingExecutor([f]),
      mode: 'real',
      judge: async () => null,
    });
    expect(report.results[0]!.passed).toBe(true);
    expect(report.results[0]!.judge).toBeNull();
    expect(report.judge.run).toBe(0);
    expect(report.judge.degraded).toBe(1);
  });

  it('judge 抛错 → 同上（降级不中断运行）', async () => {
    const c = exactContract();
    const f = fixtureV2();
    const report = await runBenchV2({
      contracts: [c],
      fixtures: [f],
      line: 'stable',
      executor: passingExecutor([f]),
      mode: 'real',
      judge: async () => {
        throw new Error('judge boom');
      },
    });
    expect(report.results[0]!.passed).toBe(true);
    expect(report.results[0]!.judge).toBeNull();
    expect(report.judge.degraded).toBe(1);
  });
});

describe('⑥ 全任务双判（D6）：20 契约 judge 全部被调用；unknown 不计降级', () => {
  it('real 模式 + fake judge → 20 次调用、run=20、degraded=0（全任务双判）', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    let calls = 0;
    const judge: JudgeFnV2 = async () => {
      calls++;
      return { verdict: 'pass' };
    };
    const report = await runBenchV2({
      contracts,
      fixtures,
      line: 'stable',
      executor: makeReplayExecutorV2(fixtures),
      mode: 'real',
      judge,
    });
    expect(calls).toBe(20);
    expect(report.judge.run).toBe(20);
    expect(report.judge.pass).toBe(20);
    expect(report.judge.degraded).toBe(0);
    expect(report.results.every((r) => r.judge !== null)).toBe(true);
  });

  it("judge 'unknown' 判词 → 计入 unknown 桶，不计降级、不计双判一致率分母", async () => {
    const c = exactContract();
    const f = fixtureV2();
    const report = await runBenchV2({
      contracts: [c],
      fixtures: [f],
      line: 'stable',
      executor: passingExecutor([f]),
      mode: 'real',
      judge: async () => ({ verdict: 'unknown' }),
    });
    expect(report.judge.unknown).toBe(1);
    expect(report.judge.degraded).toBe(0);
    expect(report.judge.rate).toBe(0);
    expect(report.results[0]!.judge).toEqual({ verdict: 'unknown' });
  });
});

describe('⑦ 回放模式注入 judge → 不调用（judge 仅真实执行路径；回放无真实产物）', () => {
  it('mode=replay + judge 注入 → calls=0、enabled=false、results[0].judge=null、degraded=0', async () => {
    const c = exactContract();
    const f = fixtureV2();
    let calls = 0;
    const report = await runBenchV2({
      contracts: [c],
      fixtures: [f],
      line: 'stable',
      executor: passingExecutor([f]),
      mode: 'replay',
      judge: async () => {
        calls++;
        return { verdict: 'pass' };
      },
    });
    expect(calls).toBe(0);
    expect(report.judge.enabled).toBe(false);
    expect(report.judge.run).toBe(0);
    expect(report.judge.degraded).toBe(0);
    expect(report.results[0]!.judge).toBeNull();
  });
});
