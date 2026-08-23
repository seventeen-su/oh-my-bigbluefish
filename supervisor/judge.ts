// OMB v2 离线 LLM judge（架构 §15 blind_judge / §10.1 L3 语义信号；施工计划 T8.13；P4 全任务双判）。
// 仅基准用（非 runtime）：blind_judge 规则化占位（verifyBlindJudge，bench.ts）→ 离线 LLM judge——
// rubric 结构化评分（评分维度 + 证据引用），输出过 BlindJudgeScoreSchema（非法 fail-loud）。
// 与规则占位并存可对照：runBenchWithJudges（bench.ts）同任务记录 rule_passed 与 llm 两路结果。
// judge 走 T8.12 的 ModelAdapter（同一适配器注入；fake 测试 / 生产经 DSH 装配）。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（契约例外，CONVENTIONS §4）+ 同层文件。
//
// P4 盲化与判定纪律（D6 全任务双判；架构 §7.1 L3 语义层）：
//   - 盲化：judge prompt 只含任务要求/rubric/输出文本，不含任务 id、候选身份、来源标记
//     （v1 buildJudgePrompt 与 v2 buildJudgePromptV2 均不含任务 id；judge 不知候选身份——防污染/作弊）；
//   - 判定纪律：judge 仅旁证，永不作晋升硬信号（P1e 晋升门禁保持规则/基准判定，本模块不参与晋升——
//     §7.1：JudgeBench 实证 judge 有位置/长度偏差、可与候选共谋 reward hacking）；
//   - 双向顺序交换 / 多模型共识：留真实会话数据阶段实现（注释文档化，本次不实现）。
import { z, type ZodIssue } from 'zod';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import type { BenchFixture, BenchTask } from '../kernel/schemas/bench.js';
import { JudgeVerdictSchema, type JudgeVerdict } from '../kernel/schemas/bench.js';
import type { BenchContractV2, BenchFixtureV2 } from '../kernel/schemas/bench.js';
import type { JudgeFnV2 } from './bench-v2.js';

// ---- 结构化评分 schema（§15 rubric 评分：维度 + 证据引用） ----

export const BlindJudgeScoreSchema = z.object({
  // P4 盲化：task_id 为可选自标字段——judge prompt 不含任务 id，模型无法回显（串任务防护随盲化移除）
  task_id: z.string().min(1).optional(),
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
 * 与规则占位同输入面，防 judge 作弊；P4 盲化：不含任务 id/候选身份/来源标记——judge 不知候选身份）。
 */
export function buildJudgePrompt(task: BenchTask, output: unknown, fixture: BenchFixture): string {
  return JSON.stringify({
    prompt: task.prompt,
    output,
    rubric: fixture.rubric,
    instruction:
      '按 rubric 逐维度评分（0-1 每维），并给出证据引用（来自 output 的文本片段）。' +
      '仅输出 JSON（无解释）：{"verdict","score","dimensions":[{"name","score","rationale"}],"evidence":[string]}',
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
 * （非法评分 → fail-loud，绝不静默通过）。P4 盲化后 prompt 不含任务 id → 模型无法回显任务 id，
 * 串任务防护移除（task_id 为可选自标字段；v1 为 legacy 库实现，生产 /bench 路径走 v2 makeJudgeV2）。
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
  return checked.data;
}

// ---- P4：v2 管道 LLM judge（D6 全任务双判；生产 /bench 默认路径） ----

/**
 * v2 judge 提示构造（盲评：judge 只见任务要求 + 评判依据 + 候选输出，不见任务 id/候选身份/来源标记）。
 * 按 verifier.kind 构造评判依据（D6 全任务双判）：
 * - exact/tests/state_assert → expected（对「输出与期望一致性」做语义评判——期望输出属任务规格，
 *   与候选身份无关，供一致性评判；盲化指不知候选身份，非隐藏参考答案）；
 * - predicate/blind_judge → rubric（rules：predicates / rubric.required_terms，语义评判）。
 */
export function buildJudgePromptV2(
  task: BenchContractV2,
  fixture: BenchFixtureV2,
  output: unknown,
): string {
  const expectedKind =
    task.verifier.kind === 'exact' || task.verifier.kind === 'tests' || task.verifier.kind === 'state_assert';
  const criteria = expectedKind ? { expected: fixture.expected } : { rubric: task.verifier.rules ?? {} };
  return JSON.stringify({
    requirement: task.requirement,
    ...criteria,
    output,
    instruction: `判断候选输出是否满足要求${
      expectedKind ? '（与期望输出语义一致，忽略格式化差异）' : '（按 rubric 语义评判）'
    }。仅输出 JSON（无解释）：{"verdict":"pass"|"fail"|"unknown","reason":"一句理由"}`,
  });
}

/** v2 judge 系统提示（仅基准用；要求结构化判词 JSON 输出） */
const JUDGE_V2_SYSTEM =
  '你是 OMB v2 基准盲评员。按给定要求对候选输出给出判词（pass/fail/unknown），只输出 JSON，不要解释。';

/** v2 judge 单次调用输出上限（判词短小；reason 一句——与执行器 8000 分开预算） */
const JUDGE_V2_MAX_TOKENS = 1000;

export interface JudgeV2Options {
  system?: string;
  maxTokens?: number;
  reasoningEffort?: 'off' | 'low' | 'high' | 'max';
}

/**
 * v2 judge 工厂：ModelAdapter → JudgeFnV2（与执行器同一 adapter；生产 /bench 真实会话经此注入）。
 * - judge 调用复用 modelAdapter.generate，默认 reasoningEffort='low'（与执行器一致，显式控推理预算）、
 *   maxTokens=1000（判词输出上限）；
 * - 成本单列：model_tokens = usage input+output；latency_ms = 真实计时（D6：judge 成本入 CognitiveCost 单列）；
 * - 失败降级：非法判词（非 JSON / verdict 非法）/ adapter 抛错（超时/无模型）→ 返回 null——
 *   judge 仅旁证（§7.1），不 fail-loud、不影响规则判定（降级计数由 runBenchV2 记录）。
 */
export function makeJudgeV2(adapter: ModelAdapter, opts: JudgeV2Options = {}): JudgeFnV2 {
  return async (task, fixture, output, rawText) => {
    try {
      // 输出解析失败（output=undefined）时用 rawText 兜底（judge 对原始模型文本评判）
      const subject = output === undefined && rawText !== undefined ? rawText : output ?? null;
      const prompt = buildJudgePromptV2(task, fixture, subject);
      const t0 = Date.now();
      const res = await adapter.generate(prompt, {
        system: opts.system ?? JUDGE_V2_SYSTEM,
        maxTokens: opts.maxTokens ?? JUDGE_V2_MAX_TOKENS,
        reasoningEffort: opts.reasoningEffort ?? 'low',
      });
      const parsed = parseJudgeJson(res.text);
      const checked = JudgeVerdictSchema.safeParse(parsed);
      if (!checked.success) {
        return null; // 非法判词 → 降级（judge 仅旁证）
      }
      const verdict: JudgeVerdict = {
        ...checked.data,
        cost: {
          model_tokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
          latency_ms: Date.now() - t0,
        },
      };
      return verdict;
    } catch {
      return null; // judge 失败/超时/无模型 → 降级（规则判定照常，降级计数由 runBenchV2 记录）
    }
  };
}
