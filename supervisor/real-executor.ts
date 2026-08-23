// OMB v2 真实基准执行器（架构 §15 三线对照；施工计划 T8.18——回放执行器 → 真实 DSH 执行）。
// 拆分说明（CONVENTIONS §9 LOC ≤ 400）：bench.ts 已含运行/verifier/回放/judge 对照（353 行），
// 真实执行器独立成模块（bench 域内拆分，同 oracle.ts/e-process.ts 先例；bench.ts 不 re-export，
// 避免循环 import——调用方直接 import 本模块）。
// 真实执行路径：task.prompt → ModelAdapter.generate（T8.12 契约；生产经 DSH LlmRuntime.stream 装配）→
// 输出解析（JSON → 结构化；非 JSON → 原样文本）→ runVerifier 判定 → 成本八字段实测
// （model_tokens = usage input+output；latency_ms = 真实计时；无工具/检索调用 → 其余字段 0，如实记录）。
// 受限说明（主会话分析）：真实 DSH 执行需会话/模型环境（依赖 T8.12 ModelAdapter + DSH 会话）——
// 测试用差异化适配器注入验证真实执行路径（三线真实分化：passed/cost 数字不同）；
// 无真实会话时生产降级为回放 executor（plugin.ts /bench 命令：有 modelAdapter 用真实、否则回放，文档化）。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（契约例外）+ 同层文件。
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import type { BenchTask, CognitiveCost } from '../kernel/schemas/bench.js';
import {
  BENCH_FIXTURES_DIR,
  assertFixtureMatchesVerifier,
  loadBenchFixture,
  runVerifier,
  type BenchExecutor,
} from './bench.js';

// ---- 常量 ----

/** 真实执行系统提示（要求 JSON 输出；非结构化场景可给文本） */
const REAL_EXEC_SYSTEM =
  '你是 OMB v2 基准执行器。完成任务：能结构化则输出 JSON（无解释），否则直接给出结果文本。不要长推理，直接给出答案。';

/**
 * 真实执行单次输出上限（输出预算须容纳推理+正文：真实 /bench 实测 4000 被 DSH 默认
 * reasoningEffort=high 的推理吃光——research-03 raw_text 全空、model_tokens=4012；
 * 装配端已显式传 reasoningEffort=low（runtime/model-adapter.ts 默认），此处 8000 =
 * 正文 4000 + 推理余量双保险。DSH 契约无显式上限（GenerateOptions.maxTokens?: number，
 * llm/types.ts:358；llm-deepseek 默认 256_000，adapter.ts:101），8000 远低于默认值）。
 */
const REAL_EXEC_MAX_TOKENS = 8000;

// ---- 提示构造 / 输出解析（纯函数） ----

/** 执行提示：任务 prompt 原样（fixture 的录制输出是答案，绝不注入——模型从任务本身求解） */
function buildExecPrompt(task: BenchTask): string {
  return task.prompt;
}

/** 输出解析：容忍 ```json / ```js / ``` 等任意代码围栏 → JSON.parse；失败 → 原样文本
 *  （blind_judge 接受字符串；rawText 由执行器原样带回供明细落盘） */
export function parseExecOutput(text: string): unknown {
  const trimmed = text.trim();
  const cleaned = /^```/i.test(trimmed)
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/```\s*$/i, '')
    : trimmed;
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    return text;
  }
}

// ---- 真实执行器 ----

export interface RealExecutorOptions {
  fixturesDir?: string;
  system?: string;
  maxTokens?: number;
}

/**
 * 真实执行器：task.prompt → ModelAdapter.generate → 输出解析 → runVerifier → 成本八字段实测。
 * 与回放执行器同 BenchExecutor 契约（runBench 直接可接）；三线各配不同适配器 → 数字真实分化。
 * adapter 抛错 / fixture 与 verifier 不匹配 → fail-loud（不静默）。
 */
export function makeRealExecutor(adapter: ModelAdapter, opts: RealExecutorOptions = {}): BenchExecutor {
  const dir = opts.fixturesDir ?? BENCH_FIXTURES_DIR;
  return async (task: BenchTask) => {
    const t0 = Date.now();
    const fixture = await loadBenchFixture(task.verifier.ref, dir);
    assertFixtureMatchesVerifier(task, fixture);
    const res = await adapter.generate(buildExecPrompt(task), {
      system: opts.system ?? REAL_EXEC_SYSTEM,
      maxTokens: opts.maxTokens ?? REAL_EXEC_MAX_TOKENS,
    });
    const output = parseExecOutput(res.text);
    const passed = runVerifier(task, output, fixture);
    const cost: CognitiveCost = {
      model_tokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
      tool_calls: 0,
      retrieval_calls: 0,
      reacquisition: 0,
      latency_ms: Date.now() - t0,
      branch_count: 0,
      memory_pollution: 0,
      corrections: 0,
    };
    return { passed, cost, output, rawText: res.text, fixture };
  };
}
