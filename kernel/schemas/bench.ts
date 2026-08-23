// OMB v2 冻结基准集契约（架构 §15 成功标准与基准 / §17 参数标定；施工计划 T7.1）。
// 纯 zod schema + 类型 + 常量数据（P3 机制即数据）：无 I/O、无副作用——契约层（CONVENTIONS §4 例外：
// 仅 supervisor 可经契约例外 import 本层）。
// 数据文件在 kernel/bench-tasks/（20 任务 + fixtures）；解释器在 supervisor/bench.ts。
import { z } from 'zod';

// ---- 类别（§15：code/data/web/sys/research 五类） ----

export const BENCH_CATEGORIES = ['code', 'data', 'web', 'sys', 'research'] as const;
export const BenchCategorySchema = z.enum(BENCH_CATEGORIES);
export type BenchCategory = z.infer<typeof BenchCategorySchema>;

// ---- verifier 种类（§15：code→tests / data→exact / web→predicate / sys→state_assert / research→blind_judge） ----

export const VERIFIER_KINDS = ['tests', 'exact', 'predicate', 'state_assert', 'blind_judge'] as const;
export const VerifierKindSchema = z.enum(VERIFIER_KINDS);
export type VerifierKind = z.infer<typeof VerifierKindSchema>;

/** §15 类别→verifier 映射（冻结集契约：每类任务用固定 verifier 种类） */
export const CATEGORY_VERIFIER_KIND: Readonly<Record<BenchCategory, VerifierKind>> = {
  code: 'tests',
  data: 'exact',
  web: 'predicate',
  sys: 'state_assert',
  research: 'blind_judge',
};

/** VerifierSpec：{ kind, ref }（ref → kernel/bench-tasks/fixtures/ 下文件；tests 可带 expected_pass） */
export const VerifierSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tests'),
    ref: z.string().min(1),
    expected_pass: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('exact'), ref: z.string().min(1) }),
  z.object({ kind: z.literal('predicate'), ref: z.string().min(1) }),
  z.object({ kind: z.literal('state_assert'), ref: z.string().min(1) }),
  z.object({ kind: z.literal('blind_judge'), ref: z.string().min(1) }),
]);
export type VerifierSpec = z.infer<typeof VerifierSpecSchema>;

// ---- 基准任务（冻结集：20 任务 = 5 类 × 4） ----

export const BenchTaskSchema = z
  .object({
    id: z.string().min(1),
    category: BenchCategorySchema,
    prompt: z.string().min(1),
    fixture_ref: z.string().min(1), // 输入 fixture（回放 executor 的 canned output/cost）
    verifier: VerifierSpecSchema,
  })
  .refine((v) => v.verifier.kind === CATEGORY_VERIFIER_KIND[v.category], {
    message:
      'verifier.kind 必须匹配类别（§15：code→tests / data→exact / web→predicate / sys→state_assert / research→blind_judge）',
    path: ['verifier', 'kind'],
  });
export type BenchTask = z.infer<typeof BenchTaskSchema>;

/** 冻结集形状（机制即数据：5 类 × 4 = 20） */
export const FROZEN_BENCH_COUNTS: Readonly<Record<BenchCategory, number>> = {
  code: 4,
  data: 4,
  web: 4,
  sys: 4,
  research: 4,
};

// ---- 三线 + 基线（§15 三线对照 + 无插件基线） ----

export const BENCH_LINES = ['initial', 'stable', 'latest', 'baseline'] as const;
export const BenchLineSchema = z.enum(BENCH_LINES);
export type BenchLine = z.infer<typeof BenchLineSchema>;

// ---- CognitiveCost 八字段（§15：最低 token ≠ 最低成本） ----

export const CognitiveCostSchema = z.object({
  model_tokens: z.number().int().nonnegative(),
  tool_calls: z.number().int().nonnegative(),
  retrieval_calls: z.number().int().nonnegative(),
  reacquisition: z.number().int().nonnegative(),
  latency_ms: z.number().nonnegative(),
  branch_count: z.number().int().nonnegative(),
  memory_pollution: z.number().nonnegative(),
  corrections: z.number().int().nonnegative(),
});
export type CognitiveCost = z.infer<typeof CognitiveCostSchema>;

// ---- 结果与报告（T7.2 元演化门禁复用 BenchReport） ----

export const BenchResultSchema = z.object({
  task_id: z.string().min(1),
  line: BenchLineSchema,
  passed: z.boolean(),
  cost: CognitiveCostSchema,
});
export type BenchResult = z.infer<typeof BenchResultSchema>;

export const BenchReportSchema = z.object({
  line: BenchLineSchema,
  results: z.array(BenchResultSchema),
});
export type BenchReport = z.infer<typeof BenchReportSchema>;

// ---- 双 judge 对照报告（T8.13：规则占位 + 离线 LLM judge 结果并存记录） ----

/** 单任务双 judge 记录：rule_passed = 规则化占位判定（executor 产物）；llm = LLM judge 结果（仅 blind_judge 任务） */
export const JudgeComparisonResultSchema = z.object({
  task_id: z.string().min(1),
  rule_passed: z.boolean(),
  llm: z
    .object({
      verdict: z.boolean(),
      score: z.number().min(0).max(1),
    })
    .nullable(),
  cost: CognitiveCostSchema,
});
export type JudgeComparisonResult = z.infer<typeof JudgeComparisonResultSchema>;

export const JudgeComparisonReportSchema = z.object({
  line: BenchLineSchema,
  results: z.array(JudgeComparisonResultSchema),
});
export type JudgeComparisonReport = z.infer<typeof JudgeComparisonReportSchema>;

// ---- 目标谓词（web：path + equals/matches/contains 至少其一） ----

export const PredicateSpecSchema = z
  .object({
    path: z.string().min(1),
    equals: z.unknown().optional(),
    matches: z.string().optional(),
    contains: z.unknown().optional(),
  })
  .refine((p) => p.equals !== undefined || p.matches !== undefined || p.contains !== undefined, {
    message: '谓词必须含 equals/matches/contains 至少其一',
    path: ['predicates'],
  });
export type PredicateSpec = z.infer<typeof PredicateSpecSchema>;

// ---- 基准 fixture（数据文件形状：录制 output + 录制 cost + 各 verifier kind 的载荷） ----

export const BenchFixtureSchema = z.object({
  output: z.unknown(), // 录制输出（回放 executor 的 canned output）
  cost: CognitiveCostSchema, // 录制成本（executor 从 fixture 统计采集）
  // exact 载荷：
  expected: z.unknown().optional(),
  // predicate 载荷：
  predicates: z.array(PredicateSpecSchema).optional(),
  // state_assert 载荷（期望前后状态）：
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  // tests 载荷（候选测试总数）：
  total: z.number().int().nonnegative().optional(),
  // blind_judge 载荷（离线规则化 rubric：必需术语；LLM judge 记录为后续）：
  rubric: z
    .object({
      required_terms: z.array(z.string().min(1)),
    })
    .optional(),
});
export type BenchFixture = z.infer<typeof BenchFixtureSchema>;

// ================= v2 契约化基准（benchmark-v2-contract；施工计划 2026-08-23-bench-v2-contract.md T2.1） =================
// 与 v1（上方类型）并存：v1 legacy 原位保留；v2 = 输入工件 + output_schema + verifier rules + reference 生成
// expected（四要素单一权威，防 prompt/输入/输出/verifier 漂移）。本段为纯类型 + schema，无 I/O。

// ---- 输入工件（ChatGPT 意见 3/4：测试用例等数据属 Input Artifact；file-list 须确定性说明位） ----

export const INPUT_ARTIFACT_KINDS_V2 = ['text', 'json', 'file-list', 'test-cases'] as const;
export const InputArtifactKindV2Schema = z.enum(INPUT_ARTIFACT_KINDS_V2);
export type InputArtifactKindV2 = z.infer<typeof InputArtifactKindV2Schema>;

/** file-list 确定性说明位（ChatGPT 意见 4：显式规定路径/排序/是否递归，保证跨平台确定性） */
export const InputArtifactV2Schema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    kind: InputArtifactKindV2Schema,
    content: z.unknown(),
    constraints: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (v) =>
      v.kind !== 'file-list' ||
      (v.constraints !== undefined &&
        typeof v.constraints.path === 'string' &&
        typeof v.constraints.sorted === 'boolean' &&
        typeof v.constraints.recursive === 'boolean'),
    {
      message: 'file-list 输入工件必须声明 constraints.path/sorted/recursive（确定性说明位，ChatGPT 意见 4）',
      path: ['constraints'],
    },
  );
export type InputArtifactV2 = z.infer<typeof InputArtifactV2Schema>;

// ---- 输出 Schema（JSON Schema 子集：object/properties/required/items/enum/type；够用即可） ----

export const OUTPUT_FIELD_TYPES_V2 = ['string', 'number', 'boolean', 'object', 'array'] as const;
export const OutputFieldTypeV2Schema = z.enum(OUTPUT_FIELD_TYPES_V2);
export type OutputFieldTypeV2 = z.infer<typeof OutputFieldTypeV2Schema>;

export interface OutputFieldV2 {
  type: OutputFieldTypeV2;
  /** array 的元素类型 */
  items?: OutputFieldV2;
  /** object 的嵌套字段 */
  properties?: Record<string, OutputFieldV2>;
  /** 值枚举约束（任一字段可带） */
  enum?: unknown[];
}

export const OutputFieldV2Schema: z.ZodType<OutputFieldV2> = z.lazy(() =>
  z.object({
    type: OutputFieldTypeV2Schema,
    items: OutputFieldV2Schema.optional(),
    properties: z.record(z.string(), OutputFieldV2Schema).optional(),
    enum: z.array(z.unknown()).optional(),
  }),
);

export interface OutputSchemaV2 {
  type: 'object';
  properties: Record<string, OutputFieldV2>;
  required: string[];
}

export const OutputSchemaV2Schema: z.ZodType<OutputSchemaV2> = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), OutputFieldV2Schema),
  required: z.array(z.string().min(1)),
});

// ---- v2 契约（任务定义四要素：输入工件 + requirement + output_schema + verifier rules + generator 元数据） ----

export const BenchContractV2Schema = z
  .object({
    id: z.string().min(1),
    category: BenchCategorySchema,
    requirement: z.string().min(1),
    input_artifacts: z.array(InputArtifactV2Schema),
    output_schema: OutputSchemaV2Schema,
    verifier: z.object({
      kind: VerifierKindSchema,
      /** kind 专属规则：predicate → rules.predicates；blind_judge → rules.rubric.required_terms */
      rules: z.record(z.string(), z.unknown()).optional(),
    }),
    generator: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
    }),
  })
  .refine((v) => v.verifier.kind === CATEGORY_VERIFIER_KIND[v.category], {
    message:
      'v2 契约 verifier.kind 必须匹配类别（§15：code→tests / data→exact / web→predicate / sys→state_assert / research→blind_judge）',
    path: ['verifier', 'kind'],
  });
export type BenchContractV2 = z.infer<typeof BenchContractV2Schema>;

// ---- v2 夹具（input + expected + output；output 供回放执行器直通，生成时 = expected） ----

export const BenchFixtureV2Schema = z.object({
  task_id: z.string().min(1),
  generated_by: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  input: z.array(InputArtifactV2Schema),
  expected: z.unknown(),
  output: z.unknown(),
});
export type BenchFixtureV2 = z.infer<typeof BenchFixtureV2Schema>;
