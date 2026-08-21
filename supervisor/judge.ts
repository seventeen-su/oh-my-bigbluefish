// OMB v2 离线 LLM judge（架构 §15 blind_judge / §10.1 L3 语义信号；施工计划 T8.13）。
// 仅基准用（非 runtime）：blind_judge 规则化占位（verifyBlindJudge，bench.ts）→ 离线 LLM judge——
// rubric 结构化评分（评分维度 + 证据引用），输出过 BlindJudgeScoreSchema（非法 fail-loud）。
// 与规则占位并存可对照：runBenchWithJudges（bench.ts）同任务记录 rule_passed 与 llm 两路结果。
// judge 走 T8.12 的 ModelAdapter（同一适配器注入；fake 测试 / 生产经 DSH 装配）。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（契约例外，CONVENTIONS §4）+ 同层文件。
import { z, type ZodIssue } from 'zod';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import type { BenchFixture, BenchTask } from '../kernel/schemas/bench.js';

// ---- 结构化评分 schema（§15 rubric 评分：维度 + 证据引用） ----

export const BlindJudgeScoreSchema = z.object({
  task_id: z.string().min(1),
  verdict: z.boolean(),
  score: z.number().min(0).max(1),
  dimensions: z
    .array(
      z.object({
        name: z.string().min(1),
        score: z.number().min(0).max(1),
        rationale: z.string().min(1),
      }),
    )
    .min(1),
  evidence: z.array(z.string().min(1)).min(1),
});
export type BlindJudgeScore = z.infer<typeof BlindJudgeScoreSchema>;

// ---- 常量 ----

/** judge 系统提示（仅基准用；要求结构化 JSON 输出） */
const JUDGE_SYSTEM =
  '你是 OMB v2 基准盲评员。按 rubric 对候选输出逐维度评分（0-1），给出证据引用（候选输出中的文本片段）。仅输出 JSON。';

/** judge 单次调用输出上限 */
const JUDGE_MAX_TOKENS = 2000;

function formatIssues(issues: ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

// ---- 提示构造 ----

/**
 * judge 提示构造（盲评：judge 只见任务 prompt + 候选输出 + rubric，不见参考答案/录制输出——
 * 与规则占位同输入面，防 judge 作弊）。
 */
export function buildJudgePrompt(task: BenchTask, output: unknown, fixture: BenchFixture): string {
  return JSON.stringify({
    task_id: task.id,
    prompt: task.prompt,
    output,
    rubric: fixture.rubric,
    instruction:
      '按 rubric 逐维度评分（0-1 每维），并给出证据引用（来自 output 的文本片段）。' +
      '仅输出 JSON（无解释）：{"task_id","verdict","score","dimensions":[{"name","score","rationale"}],"evidence":[string]}',
  });
}

/** 模型产物解析（容忍 ```json 代码围栏）→ unknown；解析失败 → null */
function parseJudgeJson(text: string): unknown {
  const trimmed = text.trim();
  const cleaned = /^```/i.test(trimmed)
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
    : trimmed;
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    return null;
  }
}

// ---- judge 入口 ----

export interface JudgeOptions {
  system?: string;
  maxTokens?: number;
}

/**
 * 离线 LLM judge：构造盲评提示 → ModelAdapter.generate → 解析 → BlindJudgeScoreSchema 校验
 * （非法评分 / 串任务 task_id → fail-loud，绝不静默通过）。
 */
export async function judgeBlind(
  adapter: ModelAdapter,
  task: BenchTask,
  output: unknown,
  fixture: BenchFixture,
  opts: JudgeOptions = {},
): Promise<BlindJudgeScore> {
  const prompt = buildJudgePrompt(task, output, fixture);
  const res = await adapter.generate(prompt, {
    system: opts.system ?? JUDGE_SYSTEM,
    maxTokens: opts.maxTokens ?? JUDGE_MAX_TOKENS,
  });
  const parsed = parseJudgeJson(res.text);
  const checked = BlindJudgeScoreSchema.safeParse(parsed);
  if (!checked.success) {
    throw new Error(`judge: 结构化评分非法——${formatIssues(checked.error.issues)}`);
  }
  if (checked.data.task_id !== task.id) {
    throw new Error(`judge: 评分 task_id 与任务不符（串任务防护）——${checked.data.task_id} ≠ ${task.id}`);
  }
  return checked.data;
}
