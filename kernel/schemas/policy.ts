// OMB v2 策略数据契约（架构 §5.1 Fast Governor / §5.3 过程数据化 / §4.2 P1 / §9.5 元演化；施工计划 T2.1 + T7.2）。
// 纯 zod schema + 枚举常量 + 类型（P3 机制即数据）：无 I/O、无副作用——契约层（CONVENTIONS §4 例外：
// 仅 supervisor 可经契约例外 import 本层；kernel/policy-loader.ts 从本层 import 并 re-export 保持公共 API）。
// T7.2 元演化门禁 diff 校验复用本层 schema（GovernorPolicySchema / EvolvePolicySchema）。
import { z } from 'zod';
import { BudgetSchema } from './base.js';
import { REASONING_EFFORTS } from './model-adapter.js';

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

/**
 * P5：LLM 生成预算（架构 §5.3 Generate 阶梯触发条件② + D7：阶梯不满足且预算允许时走 LLM）。
 * 数据可演化（改 budget.yaml 即生效）；字段存在但非法（enabled 非布尔、次数/token 非正、档位越界）→ fail-loud。
 * 段缺省（旧 budget.yaml 无 generation）→ 保守默认 disabled——无显式配置不启用 LLM 生成（防 token 黑洞）。
 */
export const GenerationBudgetSchema = z.object({
  /** LLM 生成开关（阶梯最后手段；false → 纯规则降级并记录） */
  enabled: z.boolean().default(false),
  /** 单请求 LLM 生成调用次数上限（预算守卫：超上限 → 纯规则降级；generator 实例即单请求语义） */
  max_generate_per_request: z.number().int().positive().default(1),
  /** HYPOTHESIZE 输出 token 上限（adapter.generate maxTokens；防输出预算被推理/长文本吃光） */
  max_generate_tokens: z.number().int().positive().default(4000),
  /** 推理档位（DSH reasoningEffort：off|low|high|max；沿用 model-adapter 默认 low，防推理吃光输出预算） */
  reasoning_effort: z.enum(REASONING_EFFORTS).default('low'),
});
export type GenerationBudget = z.infer<typeof GenerationBudgetSchema>;

/** P5：generation 段缺省（保守：未显式配置 → LLM 生成不启用） */
export const DEFAULT_GENERATION_BUDGET: GenerationBudget = {
  enabled: false,
  max_generate_per_request: 1,
  max_generate_tokens: 4000,
  reasoning_effort: 'low',
};

/** BudgetPolicy：计算分配器六维预算 + Context 投影预算（§5.1/§17 初值） */
export const BudgetPolicySchema = z.object({
  depth: z.number().int().positive(),
  breadth: z.number().int().positive(),
  tools: z.number().int().positive(),
  retrieval: z.number().int().positive(),
  branches: z.number().int().positive(),
  context: z.number().int().positive(),
  context_budget_tokens: z.number().int().positive(),
  /** P5：LLM 生成预算（§5.3 Generate 阶梯最后手段触发数据化 / D7 受 generation budget 约束；段缺省兼容旧 budget.yaml） */
  generation: GenerationBudgetSchema.default(DEFAULT_GENERATION_BUDGET),
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

// ---- P1c：演化判定数据化（§6.5.1 触发链 / §6.5.7 债务阈值） ----

/** 演化对象层（§6.5.2 对象分层：L0 数据 → L1 代码 → 宪法层人工门；数据即机制，可演化） */
export const OBJECT_LAYERS = ['L0', 'L1', 'constitution'] as const;
export type ObjectLayer = (typeof OBJECT_LAYERS)[number];

/** 信号触发规则（§6.5.1 数据化判定：信号种类 → 是否演化 / 强度 / 对象层） */
export const SignalTriggerSchema = z.object({
  evolve: z.boolean(),
  /** 演化强度（0..1；多个触发取最大） */
  strength: z.number().min(0).max(1),
  object_layer: z.enum(OBJECT_LAYERS),
});
export type SignalTrigger = z.infer<typeof SignalTriggerSchema>;

/** 维护债务阈值（§6.5.7：soft → 提高 quantum 频率；hard → 限制非必要演化；critical → 请求边界强制） */
export const DebtThresholdsSchema = z.object({
  soft: z.number().nonnegative(),
  hard: z.number().nonnegative(),
  critical: z.number().nonnegative(),
});
export type DebtThresholds = z.infer<typeof DebtThresholdsSchema>;

// ---- P1d：候选管线门禁数据化（§6.5.3 验证链 G3 门禁判定 / §6.5.2 生成器步长上限，防激进） ----

/** 候选门禁数据（P1d：生成器上限/步长 + G3 成本劣化容忍；全部入 evolve.policy，改 YAML 即生效） */
export const CandidateGateSchema = z.object({
  /** 单次 /evolve（与空闲期量子）最多生成+验证的候选数 K（预算守卫，§6.5.6 evolution_cost/day） */
  max_candidates_per_run: z.number().int().positive(),
  /** 参数单次调整相对步长上限（0..1；strength 绝对、ratio 相对——防激进，§6.5.2） */
  max_step_ratio: z.number().min(0).max(1),
  /** G3 成本劣化容忍（相对比例；基准报告比较语义——成本代理劣化超此值拒绝，§6.5.3 fitness 不降） */
  cost_degradation_tolerance: z.number().nonnegative(),
});
export type CandidateGate = z.infer<typeof CandidateGateSchema>;

/** 候选门禁缺省（初值待冻结基准标定 §17：K=3、步长 20%、成本劣化容忍 10%） */
export const DEFAULT_CANDIDATE_GATE = {
  max_candidates_per_run: 3,
  max_step_ratio: 0.2,
  cost_degradation_tolerance: 0.1,
} as const;

// ---- P1e：晋升门禁数据化（§6.5.3 防退化 / §7 三层信号；stable ← trusted-latest 显式门禁） ----

/** 晋升门禁数据（P1e：L1 成本容忍 + L2 shadow 统计阈值；可选段——缺省按 resolvePromotionGate 回退） */
export const PromotionGateSchema = z.object({
  /** L2：shadow exposure 样本纳入判定的最低数（n ≥ 此值才按失败率判定；n=0 → 无 shadow 数据不阻塞） */
  min_shadow_samples: z.number().int().nonnegative(),
  /** L2：shadow 失败率上限（n ≥ min_shadow_samples 时，失败率 > 此值 → 拒晋升，§7.1 后验不劣化） */
  max_shadow_failure_rate: z.number().min(0).max(1),
  /** L1：冻结基准成本劣化容忍（相对比例；缺省回退 candidate_gate.cost_degradation_tolerance——向后兼容） */
  cost_degradation_tolerance: z.number().nonnegative(),
});
export type PromotionGate = z.infer<typeof PromotionGateSchema>;

/** 晋升门禁缺省（初值待冻结基准标定 §17；min_shadow_samples=0 → 有样本即纳入 L2，无样本不阻塞） */
export const DEFAULT_PROMOTION_GATE = {
  min_shadow_samples: 0,
  max_shadow_failure_rate: 0.1,
  cost_degradation_tolerance: 0.1,
} as const;

/** 债务阈值缺省（对齐 supervisor/maintenance.ts DEFAULT_SOFT_LIMIT=10 / DEFAULT_HARD_LIMIT=50；critical 待标定 §17） */
export const DEFAULT_DEBT_THRESHOLDS = { soft: 10, hard: 50, critical: 100 } as const;

/**
 * EvolvePolicy：演化规则（架构 §9.5 预算与元演化 + P1c §6.5.1/§6.5.7 数据化判定）——
 *   - Daily Evolution Budget：evolution_cost/day 上限（仅 DSH 运行期间累计）
 *   - Learning ROI：value gained / evolution cost → 自动调 evolution priority
 *   - LLM maintenance rate：可观测指标 + 自适应软预算（超预算降优先级，非硬禁止）
 *   - signal_triggers：触发信号种类 → 是否演化/强度/对象层映射（§6.5.1 判定表；缺省空 = 不演化）
 *   - debt_thresholds：soft/hard/critical 债务阈值（§6.5.7；缺省 DEFAULT_DEBT_THRESHOLDS）
 * 旧形状（仅前三字段）经缺省仍合法（向后兼容，元演化门禁 T7.2 复用本 schema）；
 * 字段存在但非法（strength>1、负阈值等）→ fail-loud 拒绝（对齐既有 policy 纪律）。
 * 元演化门禁（T7.2）diff 校验：evolve.policy 目标内容必须过本 schema（数据即机制）。
 */
export const EvolvePolicySchema = z.object({
  /** §9.5 Daily Evolution Budget：日演化成本上限（初值待标定） */
  daily_evolution_cost: z.number().nonnegative(),
  /** §9.5 Learning ROI：价值/成本 门槛（低于则不优先演化） */
  roi_min: z.number().nonnegative(),
  /** §9.5 LLM maintenance rate：维护率软预算系数（0..1，超预算降优先级） */
  maintenance_rate: z.number().min(0).max(1),
  /** P1c：触发信号种类 → 判定规则（缺省 {} = 无触发不演化） */
  signal_triggers: z.record(z.string().min(1), SignalTriggerSchema).default({}),
  /** P1c：soft/hard/critical 债务阈值（缺省 DEFAULT_DEBT_THRESHOLDS） */
  debt_thresholds: DebtThresholdsSchema.default(DEFAULT_DEBT_THRESHOLDS),
  /** P1d：候选管线门禁数据（生成器上限/步长 + G3 成本容忍；缺省 DEFAULT_CANDIDATE_GATE） */
  candidate_gate: CandidateGateSchema.default(DEFAULT_CANDIDATE_GATE),
  /** P1e：晋升门禁数据（stable ← trusted-latest 三层信号；可选——缺省回退 candidate_gate/DEFAULT） */
  promotion_gate: PromotionGateSchema.optional(),
});
export type EvolvePolicy = z.infer<typeof EvolvePolicySchema>;
