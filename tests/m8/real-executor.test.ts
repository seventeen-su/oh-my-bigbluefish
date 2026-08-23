// T8.18 真实基准 executor 测试（supervisor/bench.ts makeRealExecutor；架构 §15 三线对照——
// 回放执行器 → 真实 DSH 执行：经 ModelAdapter 跑任务 + 真实工具语义，成本八字段实测）。
// 受限说明（主会话分析）：真实 DSH 执行需会话/模型环境（依赖 T8.12 ModelAdapter + DSH 会话）——
// 测试用差异化适配器注入验证真实执行路径；无真实会话时生产降级为回放 executor（文档化，plugin.ts）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① 真实执行路径：fake adapter 返回 JSON 输出 → verifier 判定 + 成本实测（model_tokens 来自 usage、
//      latency_ms 计时、其余字段 0）
//   ② 输出解析：JSON → 结构化（exact/predicate 用）；非 JSON → 原样字符串（blind_judge 用）
//   ③ 三线真实分化：注入差异化适配器 → 三线 passed/cost 数字不同；与基线（回放）亦不同
//   ④ 成本八字段实测记录（真实执行路径）
//   ⑤ fail-loud：fixture 与 verifier 不匹配 → 抛错；adapter 抛错 → 传播
//   ⑥ 输出预算：默认 maxTokens 提升至 8000（容纳推理+正文）与精简系统提示；opts.maxTokens 覆盖
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeRealExecutor,
  parseExecOutput,
} from '../../supervisor/real-executor.js';
import { makeReplayExecutor, runBench } from '../../supervisor/bench.js';
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

/** 差异化 fake adapter：每次调用返回给定输出 + 固定 usage（模拟不同线不同模型） */
function adapter(label: string, text: string, usage: { inputTokens: number; outputTokens: number }): ModelAdapter {
  return {
    provider: `provider-${label}`,
    model: `model-${label}`,
    async generate(): Promise<ModelGenerateResult> {
      return { text, usage };
    },
  };
}

/** exact fixture：expected = { answer: 42 } */
const exactFixture = (): BenchFixture => ({
  output: { answer: 42 }, // 录制输出（回放用；真实 executor 忽略，用模型输出）
  cost: cost({ model_tokens: 500 }),
  expected: { answer: 42 },
});

const exactTask: BenchTask = {
  id: 'bench:real-exact',
  category: 'data',
  prompt: '计算 6×7',
  fixture_ref: 'real.json',
  verifier: { kind: 'exact', ref: 'real.json' },
};

/** 临时 fixtures 目录（写入 exact fixture） */
async function withFixtures(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-real-exec-'));
  try {
    await writeFile(join(dir, 'real.json'), JSON.stringify(exactFixture()), 'utf8');
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- 主测试 ----

describe('① 真实执行路径：ModelAdapter 跑任务 → verifier 判定 + 成本实测', () => {
  it('fake adapter 返回合法 JSON 输出 → passed=true；成本实测（model_tokens=usage、latency_ms>0、其余 0）', async () => {
    await withFixtures(async (dir) => {
      const executor = makeRealExecutor(adapter('A', JSON.stringify({ answer: 42 }), { inputTokens: 100, outputTokens: 50 }), {
        fixturesDir: dir,
      });
      const t0 = Date.now();
      const r = await executor(exactTask);
      const elapsed = Date.now() - t0;
      expect(r.passed).toBe(true);
      expect(r.output).toEqual({ answer: 42 });
      // 成本八字段实测：model_tokens = input+output；latency_ms 真实计时；其余字段 0（无工具/检索）
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
  });
});

describe('② 输出解析：JSON → 结构化；非 JSON → 原样字符串', () => {
  it('parseExecOutput：直接 JSON / 代码围栏 JSON → 结构化；非 JSON → 原样文本', () => {
    expect(parseExecOutput('{"answer":42}')).toEqual({ answer: 42 });
    expect(parseExecOutput('```json\n{"answer":42}\n```')).toEqual({ answer: 42 });
    expect(parseExecOutput('采用 SQLite 与 FTS5')).toBe('采用 SQLite 与 FTS5');
  });

  it('非 JSON 输出（blind_judge 文本场景）→ passed 按字符串判定', async () => {
    await withFixtures(async (dir) => {
      // exact verifier 对字符串输出 → 不匹配 → passed=false（判定路径真实走 verifier）
      const executor = makeRealExecutor(adapter('B', '无法解析为 JSON', { inputTokens: 1, outputTokens: 1 }), {
        fixturesDir: dir,
      });
      const r = await executor(exactTask);
      expect(r.passed).toBe(false);
      expect(r.output).toBe('无法解析为 JSON');
    });
  });
});

describe('③ 三线真实分化：注入差异化适配器 → 三线数字可不同；与基线（回放）亦不同', () => {
  it('initial/stable/latest 各配不同适配器 → passed/cost 数字不同；baseline 用回放 → 数字不同', async () => {
    await withFixtures(async (dir) => {
      const tasks = [exactTask];
      // 三线差异化适配器：答案对/错、usage 不同 → 数字分化
      const lineAdapters: Record<string, ModelAdapter> = {
        initial: adapter('i', JSON.stringify({ answer: 43 }), { inputTokens: 10, outputTokens: 5 }), // 错
        stable: adapter('s', JSON.stringify({ answer: 42 }), { inputTokens: 100, outputTokens: 50 }), // 对
        latest: adapter('l', JSON.stringify({ answer: 42 }), { inputTokens: 200, outputTokens: 80 }), // 对，cost 不同
      };
      const reports = [];
      for (const line of ['initial', 'stable', 'latest'] as const) {
        const report = await runBench({
          tasks,
          line,
          executor: makeRealExecutor(lineAdapters[line]!, { fixturesDir: dir }),
        });
        reports.push(report);
      }
      // 基线：回放执行器（录制输出 → 通过；录制 cost）
      const baseline = await runBench({
        tasks,
        line: 'baseline',
        executor: makeReplayExecutor({ fixturesDir: dir }),
      });
      reports.push(baseline);
      // 四线数字全部不同（passed 分化 + cost 分化）
      const signatures = reports.map((r) => JSON.stringify(r.results));
      expect(new Set(signatures).size).toBe(4);
      // 具体断言：initial 错（passed=false）；stable/latest 对但 cost 不同
      expect(reports[0]!.results[0]!.passed).toBe(false);
      expect(reports[1]!.results[0]!.passed).toBe(true);
      expect(reports[2]!.results[0]!.passed).toBe(true);
      expect(reports[1]!.results[0]!.cost.model_tokens).toBe(150);
      expect(reports[2]!.results[0]!.cost.model_tokens).toBe(280);
      expect(reports[3]!.results[0]!.cost.model_tokens).toBe(500); // 回放录制 cost
      expect(reports[1]!.results[0]!.cost.model_tokens).not.toBe(reports[2]!.results[0]!.cost.model_tokens);
      expect(reports[1]!.results[0]!.cost.model_tokens).not.toBe(reports[3]!.results[0]!.cost.model_tokens);
    });
  });
});

describe('④ 成本八字段实测（真实执行路径记录）', () => {
  it('runBench 真实 executor → 报告 cost 八字段结构完整且通过 CognitiveCostSchema', async () => {
    await withFixtures(async (dir) => {
      const executor = makeRealExecutor(adapter('C', JSON.stringify({ answer: 42 }), { inputTokens: 30, outputTokens: 20 }), {
        fixturesDir: dir,
      });
      const report = await runBench({ tasks: [exactTask], line: 'latest', executor });
      const r = report.results[0]!;
      expect(r.passed).toBe(true);
      expect(r.cost.model_tokens).toBe(50);
      expect(r.cost.latency_ms).toBeGreaterThanOrEqual(0);
      expect(Object.keys(r.cost).sort()).toEqual([
        'branch_count',
        'corrections',
        'latency_ms',
        'memory_pollution',
        'model_tokens',
        'reacquisition',
        'retrieval_calls',
        'tool_calls',
      ]);
    });
  });
});

describe('⑥ 输出预算：默认 maxTokens 提升至 8000（容纳推理+正文——4000 被 DSH 默认 high 推理吃光的修复）', () => {
  it('makeRealExecutor 默认传 maxTokens=8000 与精简系统提示；opts.maxTokens 覆盖生效', async () => {
    await withFixtures(async (dir) => {
      const captured: Array<{ system?: string; maxTokens?: number }> = [];
      const spy: ModelAdapter = {
        provider: 'p',
        model: 'm',
        async generate(_prompt, genOpts = {}): Promise<ModelGenerateResult> {
          captured.push(genOpts);
          return { text: JSON.stringify({ answer: 42 }), usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const executor = makeRealExecutor(spy, { fixturesDir: dir });
      const r = await executor(exactTask);
      expect(r.passed).toBe(true);
      // 输出预算须容纳推理+正文：默认 8000（4000 被 high 推理吃光 → text 零输出的实测根因）
      expect(captured[0]!.maxTokens).toBe(8000);
      // 系统提示克制地加一句「不要长推理」
      expect(captured[0]!.system).toContain('不要长推理');
      // 显式 maxTokens 覆盖默认（预算面可调）
      const overridden = makeRealExecutor(spy, { fixturesDir: dir, maxTokens: 16000 });
      await overridden(exactTask);
      expect(captured[1]!.maxTokens).toBe(16000);
    });
  });
});

describe('⑤ fail-loud', () => {
  it('fixture 与 verifier 不匹配 → 抛错（数据完整性守卫，真实路径同样接线）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-real-guard-'));
    try {
      await writeFile(join(dir, 'bad.json'), JSON.stringify({ output: 'x', cost: cost() }), 'utf8');
      const t: BenchTask = {
        id: 'bench:real-guard',
        category: 'data',
        prompt: 'x',
        fixture_ref: 'bad.json',
        verifier: { kind: 'exact', ref: 'bad.json' },
      };
      const executor = makeRealExecutor(adapter('D', '{}', { inputTokens: 1, outputTokens: 1 }), { fixturesDir: dir });
      await expect(executor(t)).rejects.toThrow(/不匹配/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adapter 抛错 → 传播（真实执行失败不静默）', async () => {
    await withFixtures(async (dir) => {
      const failing: ModelAdapter = {
        provider: 'p',
        model: 'm',
        async generate() {
          throw new Error('provider unreachable');
        },
      };
      const executor = makeRealExecutor(failing, { fixturesDir: dir });
      await expect(executor(exactTask)).rejects.toThrow(/provider unreachable/);
    });
  });
});
