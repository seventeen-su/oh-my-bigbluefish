// OMB v2 策略数据契约（架构 §5.1 Fast Governor / §5.3 过程数据化 / §4.2 P1 / §9.5 元演化；施工计划 T2.1 + T7.2）。
// 纯 zod schema + 枚举常量 + 类型（P3 机制即数据）：无 I/O、无副作用——契约层（CONVENTIONS §4 例外：
// 仅 supervisor 可经契约例外 import 本层；kernel/policy-loader.ts 从本层 import 并 re-export 保持公共 API）。
// T7.2 元演化门禁 diff 校验复用本层 schema（GovernorPolicySchema / EvolvePolicySchema）。
import { z } from 'zod';
import { BudgetSchema } from './base.js';

// ---- 枚举常量（as const 类型导出；决策/算子值域固定） ----

/** Process Applicability（架构 §5.1） */
export const APPLICABILITY = ['Strong', 'Partial', 'Failed', 'Contradictory', 'OOD'] as const;
/** 证据缺口状态（§5.1 evidence_sufficiency → 二值化：缺口空/有缺口） */
export const EVIDENCE_GAPS = ['none', 'some'] as const;
/** Governor 决策（§5.1 GovernorDecision） */
export const GOVERNOR_DECISIONS = [
  'RunProcess',
  'GenerateProcess',
  'ExpandSearch',
  'RetrieveMemory',
  'Verify',
  'Delegate',
  'Stop',
] as const;
/** 内置算子（§5.3 7 算子 + 预留 VERIFY；M4 若调整清单，此处同步） */
export const BUILTIN_OPERATORS = [
  'RETRIEVE',
  'HYPOTHESIZE',
  'DISCRIMINATE',
  'EXECUTE',
  'OBSERVE',
  'UPDATE',
  'STOP',
  'VERIFY',
] as const;

/** 候选 kind 值域（§6.1 ContentRouter 分型；策略 schema 与 runtime/renderer 共享同一常量，防枚举漂移） */
export const CANDIDATE_KINDS = [
  'code',
  'json',
  'logs',
  'retrieval',
  'memory',
  'working_state',
  'artifact',
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

// ---- Schema（zod；与类型同源，z.infer 导出） ----

/** Governor 决策表规则（默认规则无 when：匹配任何未命中组合） */
export const GovernorRuleSchema = z.object({
  id: z.string().min(1),
  when: z
    .object({
      applicability: z.enum(APPLICABILITY),
      evidence_gaps: z.enum(EVIDENCE_GAPS),
      budget_ok: z.boolean(),
    })
    .optional(),
  decision: z.enum(GOVERNOR_DECISIONS),
});
export type GovernorRule = z.infer<typeof GovernorRuleSchema>;

/** GovernorPolicy：决策表（§5.1 Fast Governor 结构化 policy） */
export const GovernorPolicySchema = z
  .object({
    rules: z.array(GovernorRuleSchema).min(1),
  })
  .refine(
    (v) => {
      const defaults = v.rules.filter((r) => r.when === undefined);
      return defaults.length === 1 && defaults[0]?.id === 'default';
    },
    { message: '决策表必须恰有一条默认规则（无 when 且 id=default）', path: ['rules'] },
  )
  .refine(
    (v) => {
      const seen = new Set<string>();
      for (const r of v.rules) {
        if (!r.when) continue;
        const key = `${r.when.applicability}|${r.when.evidence_gaps}|${r.when.budget_ok}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
    { message: '决策表 when 组合不得重复', path: ['rules'] },
  );
export type GovernorPolicy = z.infer<typeof GovernorPolicySchema>;

/** BudgetPolicy：计算分配器六维预算 + Context 投影预算（§5.1/§17 初值） */
export const BudgetPolicySchema = z.object({
  depth: z.number().int().positive(),
  breadth: z.number().int().positive(),
  tools: z.number().int().positive(),
  retrieval: z.number().int().positive(),
  branches: z.number().int().positive(),
  context: z.number().int().positive(),
  context_budget_tokens: z.number().int().positive(),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

/** kind 成本表（§6.1 reacquisition/attention_pollution/regression_risk；每 kind 一非负数值，§17 参数标定初值） */
export const KindCostTableSchema = z.object(
  CANDIDATE_KINDS.reduce(
    (shape, k) => ({ ...shape, [k]: z.number().nonnegative() }),
    {} as Record<CandidateKind, z.ZodNumber>,
  ),
);
export type KindCostTable = z.infer<typeof KindCostTableSchema>;

/** ContextPolicy：Context Compiler 参数（§6.1 边际价值权重 + kind 成本表；§17 开放项初值） */
export const ContextPolicySchema = z.object({
  marginal_weights: z.object({
    info_value: z.number().nonnegative(),
    token_cost: z.number().nonnegative(),
    reacquisition: z.number().nonnegative(),
    attention_pollution: z.number().nonnegative(),
    regression_risk: z.number().nonnegative(),
  }),
  working_state_never_compress: z.literal(true),
  kind_costs: z.object({
    reacquisition: KindCostTableSchema,
    attention_pollution: KindCostTableSchema,
    regression_risk: KindCostTableSchema,
  }),
});
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

/** 算子定义（§5.3 Operator ABI 数据化子集：M2 只做数据与校验，执行在 M4） */
export const OperatorDefSchema = z.object({
  id: z.string().min(1),
  op: z.enum(BUILTIN_OPERATORS),
  input_binding: z.record(z.string(), z.unknown()),
  output: z.string().min(1),
  cost: BudgetSchema,
  verification: z.string().min(1),
  error: z.object({
    retryable: z.boolean(),
    timeout_ms: z.number().nonnegative(),
    cancelable: z.boolean(),
    rollback: z.string().min(1),
  }),
});
export type OperatorDef = z.infer<typeof OperatorDefSchema>;

/** ProcessDef：过程 = 数据化程序（§4.2 P1；entry/exit 必须与图端点一致） */
export const ProcessDefSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    entry: z.enum(BUILTIN_OPERATORS),
    exit: z.enum(BUILTIN_OPERATORS),
    budget: BudgetSchema,
    operators: z.array(OperatorDefSchema).min(1),
  })
  .refine((v) => v.operators[0]?.op === v.entry, {
    message: 'entry 必须等于首算子 op',
    path: ['entry'],
  })
  .refine((v) => v.operators[v.operators.length - 1]?.op === v.exit, {
    message: 'exit 必须等于末算子 op',
    path: ['exit'],
  });
export type ProcessDef = z.infer<typeof ProcessDefSchema>;

// ---- EvolvePolicy（架构 §9.5 元演化规则；T7.2 新增契约，初值待冻结基准标定 §17） ----

/**
 * EvolvePolicy：演化规则（架构 §9.5 预算与元演化）——
 *   - Daily Evolution Budget：evolution_cost/day 上限（仅 DSH 运行期间累计）
 *   - Learning ROI：value gained / evolution cost → 自动调 evolution priority
 *   - LLM maintenance rate：可观测指标 + 自适应软预算（超预算降优先级，非硬禁止）
 * 元演化门禁（T7.2）diff 校验：evolve.policy 目标内容必须过本 schema（数据即机制）。
 */
export const EvolvePolicySchema = z.object({
  /** §9.5 Daily Evolution Budget：日演化成本上限（初值待标定） */
  daily_evolution_cost: z.number().nonnegative(),
  /** §9.5 Learning ROI：价值/成本 门槛（低于则不优先演化） */
  roi_min: z.number().nonnegative(),
  /** §9.5 LLM maintenance rate：维护率软预算系数（0..1，超预算降优先级） */
  maintenance_rate: z.number().min(0).max(1),
});
export type EvolvePolicy = z.infer<typeof EvolvePolicySchema>;
