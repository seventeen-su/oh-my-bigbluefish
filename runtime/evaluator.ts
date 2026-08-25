// OMB v2 评估数据结构（架构 §10.1 能力向量 + P5 三层信号评估）。
// 九维独立事实（无总裁判，不设总分）；七分类结果；三层信号为维度事实采集器：
//   L1 机械/隐式（零成本；隐式行为仅相关性弱信号，不作因果）
//   L2 统计（区间表达不确定性，不伪装无参数）
//   L3 语义（低频空闲期盲化 judge，仅补不可验证维度）
// 本任务只定义数据结构 + zod schema + 序列化，演化评估实现（EvolutionEvaluator）留 M5。
// layer 2（runtime/）：仅 import zod 与同层 kernel/schemas（CONVENTIONS §4）；纯类型，无 I/O，顶层无副作用。
import { z } from 'zod';
import { FingerprintSchema, isValidId, makeMutableId } from '../kernel/schemas/base.js';

// ---- 九维（§10.1：正确性/成本/鲁棒性/泛化/可解释性/回归 + Transferability + Maintenance Cost + Contamination Risk） ----

export const CAPABILITY_DIMENSIONS = [
  'correctness',
  'cost',
  'robustness',
  'generalization',
  'interpretability',
  'regression',
  'transferability',
  'maintenance_cost',
  'contamination_risk',
] as const;
export const CapabilityDimensionSchema = z.enum(CAPABILITY_DIMENSIONS);
export type CapabilityDimension = z.infer<typeof CapabilityDimensionSchema>;

// ---- 七分类（§10.1：Stable/Candidate/Better-in-domain/Cheaper-but-weaker/More-robust/Unknown/Regressed） ----

export const CLASSIFICATIONS = [
  'Stable',
  'Candidate',
  'Better-in-domain',
  'Cheaper-but-weaker',
  'More-robust',
  'Unknown',
  'Regressed',
] as const;
export const ClassificationSchema = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof ClassificationSchema>;

// ---- 信号来源层（三层信号标签） ----

export const SIGNAL_SOURCES = ['L1_mechanical', 'L2_statistical', 'L3_semantic'] as const;
export const SignalSourceSchema = z.enum(SIGNAL_SOURCES);
export type SignalSource = z.infer<typeof SignalSourceSchema>;

// ---- 区间（L2 统计不确定性表达；low ≤ high 强制） ----

export const ConfidenceIntervalSchema = z
  .object({
    low: z.number(),
    high: z.number(),
  })
  .refine((v) => v.low <= v.high, {
    message: 'confidence_interval.low 必须 ≤ high',
    path: ['low'],
  });
export type ConfidenceInterval = z.infer<typeof ConfidenceIntervalSchema>;

// ---- 维度事实（每维独立事实，无总裁判；value null = 无数据，Unknown 依据） ----

export const DimensionFactSchema = z.object({
  dimension: CapabilityDimensionSchema,
  value: z.number().nullable(),
  confidence_interval: ConfidenceIntervalSchema.optional(),
  signal_sources: z.array(SignalSourceSchema),
  evidence_refs: z.array(z.string()),
  sample_size: z.number().int().nonnegative(),
});
export type DimensionFact = z.infer<typeof DimensionFactSchema>;

// ---- 能力向量 ----

export const CapabilityVectorSchema = z
  .object({
    id: z.string().refine((s) => isValidId(s, 'vector'), {
      message: 'id 必须为 vector:<uuid>',
      path: ['id'],
    }),
    target: z.string().min(1), // 被评估对象 id（capability/process/skill）
    facts: z.array(DimensionFactSchema), // 每维一条（可缺维）
    classification: ClassificationSchema,
    classification_confidence: z.number(),
    environment: FingerprintSchema, // §4.4 环境指纹：无指纹不跨环境迁移
    created: z.number().int().nonnegative(), // epoch ms
    provenance: z.object({
      source: z.string().min(1),
      events: z.array(z.string()),
    }),
  })
  .refine((v) => new Set(v.facts.map((f) => f.dimension)).size === v.facts.length, {
    message: 'facts 每维至多一条',
    path: ['facts'],
  });
export type CapabilityVector = z.infer<typeof CapabilityVectorSchema>;

/** 可变对象 id 工厂：`vector:<uuid>`（§4.1 可变对象 id 语义；M5 EvolutionEvaluator 用） */
export function makeVectorId(): string {
  return makeMutableId('vector');
}

// ---- 三层信号（L1 采集器接口形状——采集实现 M5） ----

export const L1_SIGNAL_KINDS = [
  'tool_success',
  'tool_failure',
  'retry',
  'correction',
  'memory_hit',
  'memory_miss',
  // T8.21 能力向量三维真实化（信号 kind 从 L3 占位改为真实采集路径）：
  'scope_hit', //         generalization：检索 episode 跨 scope 命中（§7.4 归因；来源 retrieval_episode 表）
  'scope_miss', //        generalization：检索 episode 未命中（§7.4 归因）
  'scope_recorded', //    generalization：检索 episode 已记录待归因（专项 D：outcome null 单独一类——
  //                      检索数据量照常入信号；不当作 hit 也不当作 miss，归因观测面留待）
  'oracle_pass', //       interpretability：reproduction oracle 判定通过（§9.2，T8.14 执行产物）
  'oracle_fail', //       interpretability：reproduction oracle 判定失败（不可信/复现失败）
  'trusted_object', //    contamination_risk：信任池 trusted 对象（§9.3，T5.1 CandidatePool）
  'untrusted_object', //  contamination_risk：信任池 untrusted+rejected 对象（污染风险来源审计）
] as const;

export const L1SignalSchema = z.object({
  layer: z.literal('L1'),
  kind: z.enum(L1_SIGNAL_KINDS),
  target: z.string().min(1),
  count: z.number().int().nonnegative(),
  window: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    })
    .refine((w) => w.from <= w.to, {
      message: 'window.from 必须 ≤ to',
      path: ['from'],
    }),
});
export type L1Signal = z.infer<typeof L1SignalSchema>;

export const L2SignalSchema = z.object({
  layer: z.literal('L2'),
  kind: z.enum(['bench_score', 'latency', 'token_cost', 'regression_delta']),
  target: z.string().min(1),
  value: z.number(),
  confidence_interval: ConfidenceIntervalSchema.optional(),
  sample_size: z.number().int().nonnegative(),
  bench_ref: z.string().min(1),
});
export type L2Signal = z.infer<typeof L2SignalSchema>;

export const L3SignalSchema = z.object({
  layer: z.literal('L3'),
  kind: z.literal('blinded_judge'),
  target: z.string().min(1),
  dimension: CapabilityDimensionSchema,
  verdict: z.enum(['supported', 'contradicted', 'unresolved']),
  note: z.string().optional(),
});
export type L3Signal = z.infer<typeof L3SignalSchema>;

export const EvaluationSignalSchema = z.discriminatedUnion('layer', [
  L1SignalSchema,
  L2SignalSchema,
  L3SignalSchema,
]);
export type EvaluationSignal = z.infer<typeof EvaluationSignalSchema>;

// ---- 序列化（zod schema parse 往返一致） ----

/** CapabilityVector → JSON 字符串（先 zod 校验，防坏数据出站） */
export function vectorToJSON(v: CapabilityVector): string {
  return JSON.stringify(CapabilityVectorSchema.parse(v));
}

/** JSON 字符串 → CapabilityVector（zod 校验，非法拒绝） */
export function vectorFromJSON(json: string): CapabilityVector {
  return CapabilityVectorSchema.parse(JSON.parse(json) as unknown);
}

/** EvaluationSignal → JSON 字符串（先 zod 校验） */
export function signalToJSON(s: EvaluationSignal): string {
  return JSON.stringify(EvaluationSignalSchema.parse(s));
}

/** JSON 字符串 → EvaluationSignal（zod 校验，非法拒绝） */
export function signalFromJSON(json: string): EvaluationSignal {
  return EvaluationSignalSchema.parse(JSON.parse(json) as unknown);
}

// ---- 六反馈键衔接（M1 Memory.utility_counts → L1 信号；M5 会用） ----
// 记忆级 utility_counts 键 = T3.4 定型六反馈键：retrieval / hit / miss / inject / decay / promote
// （state-reducer 的 tool_calls/retrieval_calls/memory_ops/corrections/reads/hits 是系统级 reduce 投影键，
// 不写入 memory 表，此处不可得）。
// L1 信号 kind 为六种机械观察；六反馈键中仅 hit 有直接语义对应（hit → memory_hit）；
// retrieval / miss / inject / decay / promote 无 L1 对应（不映射——诚实部分映射：
// tool_success / tool_failure / retry / memory_miss 需事件级数据，由 M5 采集器产生，不做无依据映射）。
// 未映射计数器与零计数不产生信号（避免噪声信号污染评估）。

const COUNTER_TO_L1_KIND: Readonly<Record<string, L1Signal['kind']>> = {
  hit: 'memory_hit',
};

/** 六反馈键 → L1 信号数组（纯转换；计数透传，零计数跳过；仅 hit 映射） */
export function fromUtilityCounts(
  counts: Readonly<Record<string, number>>,
  target: string,
  window: { from: number; to: number },
): EvaluationSignal[] {
  const signals: EvaluationSignal[] = [];
  for (const [counter, kind] of Object.entries(COUNTER_TO_L1_KIND)) {
    const count = counts[counter];
    if (typeof count === 'number' && count > 0) {
      signals.push({ layer: 'L1', kind, target, count, window });
    }
  }
  return signals;
}
