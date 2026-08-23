// T8.13 基准 LLM judge 测试（supervisor/judge.ts + supervisor/bench.ts runBenchWithJudges +
// kernel/schemas/bench.ts 对照报告；架构 §15 blind_judge / §10.1 L3 语义信号）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① judgeBlind：fake adapter 返回结构化评分 JSON → 过 BlindJudgeScoreSchema（维度 + 证据引用）
//   ② judgeBlind：非 JSON / schema 不过 → fail-loud（盲化后 prompt 不含任务 id，模型无需回显——
//      串任务防护随盲化移除，task_id 为可选自标字段，缺失/任意值均合法）
//   ③ buildJudgePrompt 含 rubric 与 output（盲评：judge 不见答案；P4 盲化：不含任务 id/候选身份）
//   ④ runBenchWithJudges：规则占位 + LLM judge 并存可对照（同任务两 judge 结果都记录；
//      blind_judge 任务 llm 非空；非 blind_judge 任务 llm=null）
//   ⑤ 无 judge 注入 → llm=null（离线规则化占位仍是默认）
//   ⑥ 结构化评分 schema 边界（score 越界 / dimensions 空 → 拒绝）
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BlindJudgeScoreSchema,
  judgeBlind,
  type BlindJudgeScore,
} from '../../supervisor/judge.js';
import { runBenchWithJudges, type BenchExecutor } from '../../supervisor/bench.js';
import type { ModelAdapter, ModelGenerateResult } from '../../kernel/schemas/model-adapter.js';
import type { BenchFixture, BenchTask, CognitiveCost } from '../../kernel/schemas/bench.js';

// ---- 测试工具 ----

function cost(over: Partial<CognitiveCost> = {}): CognitiveCost {
  return {
    model_tokens: 0,
    tool_calls: 0,
    retrieval_calls: 0,
    reacquisition: 0,
    latency_ms: 0,
    branch_count: 0,
    memory_pollution: 0,
    corrections: 0,
    ...over,
  };
}

function blindTask(over: Partial<BenchTask> = {}): BenchTask {
  return {
    id: 'bench:judge',
    category: 'research',
    prompt: '评估 SQLite 方案',
    fixture_ref: 'j.json',
    verifier: { kind: 'blind_judge', ref: 'j.json' },
    ...over,
  };
}

function blindFixture(): BenchFixture {
  return {
    output: '采用 SQLite 与 FTS5 存储',
    cost: cost(),
    rubric: { required_terms: ['SQLite', 'FTS5'] },
  };
}

/** 合法 judge 评分 JSON */
function scoreJson(over: Partial<BlindJudgeScore> = {}): string {
  return JSON.stringify({
    task_id: 'bench:judge',
    verdict: true,
    score: 0.85,
    dimensions: [
      { name: '术语覆盖', score: 1, rationale: '输出含 SQLite 与 FTS5' },
      { name: '方案完整性', score: 0.7, rationale: '提到存储但未展开' },
    ],
    evidence: ['采用 SQLite 与 FTS5 存储'],
    ...over,
  });
}

function judgeAdapter(over: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    provider: 'test',
    model: 'fake-judge',
    async generate(): Promise<ModelGenerateResult> {
      return { text: scoreJson() };
    },
    ...over,
  };
}

/** 记录调用 prompt 的 adapter */
function recordingAdapter(): ModelAdapter & { prompts: string[] } {
  const prompts: string[] = [];
  const adapter = judgeAdapter({
    async generate(prompt): Promise<ModelGenerateResult> {
      prompts.push(prompt);
      return { text: scoreJson() };
    },
  });
  return Object.assign(adapter, { prompts });
}

// ---- 主测试 ----

describe('① judgeBlind：结构化评分（rubric 维度 + 证据引用，schema 校验）', () => {
  it('fake adapter 返回结构化评分 → 解析过 BlindJudgeScoreSchema（verdict/score/dimensions/evidence）', async () => {
    const score = await judgeBlind(judgeAdapter(), blindTask(), blindFixture().output, blindFixture());
    expect(BlindJudgeScoreSchema.safeParse(score).success).toBe(true);
    expect(score.task_id).toBe('bench:judge');
    expect(score.verdict).toBe(true);
    expect(score.score).toBe(0.85);
    expect(score.dimensions.length).toBeGreaterThanOrEqual(1);
    expect(score.dimensions[0]!.name).toBe('术语覆盖');
    expect(score.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('buildJudgePrompt：含 task prompt、output 与 rubric；不含任务 id（P4 盲化：judge 不知候选身份）', async () => {
    const adapter = recordingAdapter();
    const fixture = blindFixture();
    await judgeBlind(adapter, blindTask(), '候选输出文本', fixture);
    const prompt = adapter.prompts[0]!;
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    // 盲化钉住（§7.1）：prompt 只含任务要求/rubric/输出文本——任务 id 不泄漏（id 不在 prompt/output 中）
    expect(parsed.task_id).toBeUndefined();
    expect(prompt).not.toContain('bench:judge');
    expect(parsed.prompt).toContain('评估');
    expect(parsed.output).toBe('候选输出文本');
    expect(parsed.rubric).toEqual(fixture.rubric);
    expect(parsed.instruction).toContain('dimensions');
  });
});

describe('② judgeBlind：非法评分 fail-loud', () => {
  it('非 JSON → 抛错（结构化评分缺失即失败，不静默通过）', async () => {
    const adapter = judgeAdapter({ generate: async () => ({ text: '无法评分' }) });
    await expect(judgeBlind(adapter, blindTask(), 'x', blindFixture())).rejects.toThrow(/非法|评分/);
  });

  it('schema 不过（score 越界）→ 抛错', async () => {
    const adapter = judgeAdapter({
      generate: async () => ({ text: scoreJson({ score: 1.5 }) }),
    });
    await expect(judgeBlind(adapter, blindTask(), 'x', blindFixture())).rejects.toThrow();
  });

  it('模型评分缺 task_id → 接受（盲化后 prompt 不含任务 id，模型无需回显；task_id 可选自标字段）', async () => {
    const rest = JSON.parse(scoreJson()) as Record<string, unknown>;
    delete rest.task_id;
    const adapter = judgeAdapter({
      generate: async () => ({ text: JSON.stringify(rest) }),
    });
    const score = await judgeBlind(adapter, blindTask(), 'x', blindFixture());
    expect(score.verdict).toBe(true);
    expect(score.task_id).toBeUndefined();
  });
});

describe('④ runBenchWithJudges：规则占位 + LLM judge 并存可对照（两 judge 结果都记录）', () => {
  it('blind_judge 任务 → llm 非空（verdict/score 记录）；非 blind_judge → llm=null；rule_passed 来自 executor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-judge-bench-'));
    try {
      const ref = 'j.json';
      await writeFile(join(dir, ref), JSON.stringify(blindFixture()), 'utf8');
      const tasks: BenchTask[] = [
        blindTask(),
        {
          id: 'bench:exact',
          category: 'data',
          prompt: 'x',
          fixture_ref: ref,
          verifier: { kind: 'exact', ref },
        },
      ];
      const executor: BenchExecutor = async (task) => ({
        passed: true,
        cost: cost({ model_tokens: 10 }),
        output: task.verifier.kind === 'blind_judge' ? '采用 SQLite 与 FTS5 存储' : { ok: 1 },
      });
      const report = await runBenchWithJudges({
        tasks,
        line: 'stable',
        executor,
        judge: judgeAdapter(),
        fixturesDir: dir,
      });
      expect(report.line).toBe('stable');
      expect(report.results).toHaveLength(2);
      const bj = report.results.find((r) => r.task_id === 'bench:judge')!;
      expect(bj.rule_passed).toBe(true);
      expect(bj.llm).not.toBeNull();
      expect(bj.llm!.verdict).toBe(true);
      expect(bj.llm!.score).toBe(0.85);
      const exact = report.results.find((r) => r.task_id === 'bench:exact')!;
      expect(exact.llm).toBeNull();
      expect(exact.cost.model_tokens).toBe(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('规则占位与 LLM judge 结论分歧也可对照（rule_passed 与 llm.verdict 都如实记录）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-judge-div-'));
    try {
      const ref = 'j.json';
      await writeFile(join(dir, ref), JSON.stringify(blindFixture()), 'utf8');
      // 规则占位通过（输出含必需术语），LLM judge 判 fail → 两结果并存
      const adapter = judgeAdapter({
        generate: async () => ({ text: scoreJson({ verdict: false, score: 0.2 }) }),
      });
      const report = await runBenchWithJudges({
        tasks: [blindTask()],
        line: 'latest',
        executor: makePassingExecutor(),
        judge: adapter,
        fixturesDir: dir,
      });
      const r = report.results[0]!;
      expect(r.rule_passed).toBe(true);
      expect(r.llm!.verdict).toBe(false);
      expect(r.llm!.score).toBe(0.2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('⑤ 无 judge 注入 → llm=null（离线规则化占位仍是默认路径）', () => {
  it('runBenchWithJudges 不传 judge → blind_judge 任务 llm=null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-judge-none-'));
    try {
      const ref = 'j.json';
      await writeFile(join(dir, ref), JSON.stringify(blindFixture()), 'utf8');
      const report = await runBenchWithJudges({
        tasks: [blindTask()],
        line: 'baseline',
        executor: makePassingExecutor(),
        fixturesDir: dir,
      });
      expect(report.results[0]!.llm).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('⑥ 结构化评分 schema 边界', () => {
  it('score 越界 / dimensions 空 / evidence 空 → 拒绝', () => {
    const base: BlindJudgeScore = {
      task_id: 't',
      verdict: true,
      score: 0.5,
      dimensions: [{ name: 'd', score: 0.5, rationale: 'r' }],
      evidence: ['e'],
    };
    expect(BlindJudgeScoreSchema.safeParse(base).success).toBe(true);
    expect(BlindJudgeScoreSchema.safeParse({ ...base, score: 1.01 }).success).toBe(false);
    expect(BlindJudgeScoreSchema.safeParse({ ...base, dimensions: [] }).success).toBe(false);
    expect(BlindJudgeScoreSchema.safeParse({ ...base, evidence: [] }).success).toBe(false);
    expect(
      BlindJudgeScoreSchema.safeParse({ ...base, dimensions: [{ name: 'd', score: 2, rationale: 'r' }] }).success,
    ).toBe(false);
  });
});

/** 固定通过的 executor（盲评规则占位通过：输出含必需术语） */
function makePassingExecutor(): BenchExecutor {
  return async () => ({ passed: true, cost: cost(), output: '采用 SQLite 与 FTS5 存储' });
}
