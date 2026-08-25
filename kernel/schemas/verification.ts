// 统一验证基础设施（P1：验证契约核心）契约层 schema——Shadow 成功判定 / Repair 重验证 / Evolution 晋升 / Benchmark
// 共享同一套「可执行验证契约」语义（计划 .omb/plans/2026-08-25-verification-contract.md；用户裁决 2026-08-25）。
// 核心 6 对象：VerificationContract（什么算成功）/ VerificationPlan（这次验什么）/ Verifier（怎么查）/
//   VerificationEvidence（查到了什么）/ VerificationResult（PASS/FAIL/UNKNOWN）/ VerifierTrust（为什么信）。
// 纯 zod schema + 类型（契约层纪律：无 I/O、无业务逻辑、无副作用——supervisor 可经契约例外 import）。
// 消费端接线在 P2-P4（本期不接线）；本文件被 kernel/verification.ts（layer 2）与 tests/m9 直接 import。
import { z } from 'zod';

// ---- 验证阶梯四级（裁决要点③：确定性 → 外部工具 → 结构化 LLM → 人工/多模型） ----

/** 验证器种类（验证阶梯四级；权威 = deterministic/external，补充 = structured_llm/human_multi） */
export const VERIFIER_KINDS = ['deterministic', 'external', 'structured_llm', 'human_multi'] as const;
export const VerifierKindSchema = z.enum(VERIFIER_KINDS);
export type VerifierKind = z.infer<typeof VerifierKindSchema>;

// ---- 三态判定（裁决要点①：UNKNOWN = 证据不足不强行裁决，晋升统计中独立一档） ----

/** 判定三态：PASS（全部必要条件满足）/ FAIL（至少一个确定性硬条件明确不满足）/ UNKNOWN（现有证据不足以判断） */
export const VERDICTS = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

// ---- 验证器可信等级（裁决要点④：L2=基准验证 为默认门槛；trust < required 不能用于 stable 晋升） ----

/** VerifierTrust L0-L4：L0 未验证 / L1 结构合法 / L2 基准验证 / L3 独立验证 / L4 多环境验证 */
export const TRUST_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export const TrustLevelSchema = z.enum(TRUST_LEVELS);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

/** 默认晋升门槛（L2 = 基准验证）；P4 晋升门禁消费 */
export const DEFAULT_TRUST_REQUIRED: TrustLevel = 'L2';

// ---- Verifier（怎么查：覆盖声明 + 可信等级 + 来源标识） ----

/**
 * 验证器：checks/blind_spots 为覆盖声明（能证明什么 / 证明不了什么——「测试通过 ≠ 功能完全正确」）；
 * trust 为自身可信等级；origin 为来源标识（非循环检查用——来源若等于候选自身 → 拒绝，裁决要点⑤）。
 */
export const VerifierSchema = z.object({
  id: z.string().min(1),
  kind: VerifierKindSchema,
  /** 覆盖声明：能证明什么（至少一项） */
  checks: z.array(z.string().min(1)).min(1),
  /** 覆盖声明：证明不了什么（盲区；可为空 = 无声明盲区） */
  blind_spots: z.array(z.string().min(1)),
  /** 可信等级（L0-L4） */
  trust: TrustLevelSchema,
  /** 来源标识（可选；非循环检查用：undefined = 外部/独立来源） */
  origin: z.string().min(1).optional(),
});
export type Verifier = z.infer<typeof VerifierSchema>;

// ---- VerificationContract（什么算成功：目标 + 硬约束 + 结果/过程条件 + 环境 + 可控性 + 验证器 + 判定语义） ----

/**
 * 验证契约：任务/对象「什么算成功」的机器可执行声明。
 * hard_constraints（硬约束，不可被 LLM judge 覆盖，裁决要点②）+ outcome_conditions（结果条件）共同构成应查检查；
 * process_conditions（过程条件，可选——P2 起由 process_quality 注入面覆盖）；environment/controllability 为环境边界；
 * verdict_semantics 固定 'all_must_pass'（判定语义：必须全部满足）。
 */
export const VerificationContractSchema = z.object({
  id: z.string().min(1),
  /** 目标（自然语言声明） */
  goal: z.string().min(1),
  /** 硬约束（至少一项；不能被 LLM judge 覆盖） */
  hard_constraints: z.array(z.string().min(1)).min(1),
  /** 结果条件（至少一项） */
  outcome_conditions: z.array(z.string().min(1)).min(1),
  /** 过程条件（可选） */
  process_conditions: z.array(z.string().min(1)).optional(),
  /** 环境边界（可选，如数据库版本） */
  environment: z.string().optional(),
  /** 可控性（可选，如 captcha: uncontrollable——外部不可控失败不污染能力评分，P3） */
  controllability: z.record(z.string(), z.string()).optional(),
  /** 验证器集合（至少一项） */
  verifiers: z.array(VerifierSchema).min(1),
  /** 晋升门槛（trust < required 不能用于 stable 晋升，P4 消费；缺省由 DEFAULT_TRUST_REQUIRED 提供） */
  trust_required: TrustLevelSchema,
  /** 判定语义（固定：必须全部满足） */
  verdict_semantics: z.literal('all_must_pass'),
});
export type VerificationContract = z.infer<typeof VerificationContractSchema>;

// ---- VerificationPlan（这次验什么：contract + 验证步骤） ----

/** 验证步骤：verifier_id 引用契约内验证器；args 为执行参数；evidence_required 为本次必须产出证据的检查名 */
export const VerificationStepSchema = z.object({
  verifier_id: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  /** 本次必须产出证据的检查名（对应 hard_constraints/outcome_conditions 条目） */
  evidence_required: z.array(z.string().min(1)).min(1),
});
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

/** 验证计划：本次实际执行哪些验证（Repair 生成最小计划 / Shadow 阶梯执行均产此物） */
export const VerificationPlanSchema = z.object({
  contract_id: z.string().min(1),
  steps: z.array(VerificationStepSchema).min(1),
});
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;

// ---- VerificationEvidence（查到了什么：按检查名的 pass/fail/unknown 结果集） ----

/** 单检查结果三态（pass/fail/unknown；unknown = 该检查证据不足） */
export const CHECK_RESULTS = ['pass', 'fail', 'unknown'] as const;
export const CheckResultSchema = z.enum(CHECK_RESULTS);
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** 检查条目：name 对应契约应查检查名（hard_constraints/outcome_conditions 条目字符串） */
export const EvidenceCheckSchema = z.object({
  name: z.string().min(1),
  result: CheckResultSchema,
  detail: z.string().optional(),
});
export type EvidenceCheck = z.infer<typeof EvidenceCheckSchema>;

/** 验证证据：一个验证器一次执行的全部检查结果（source = 证据来源描述，如 'exec:db_check@sha256:...'） */
export const VerificationEvidenceSchema = z.object({
  verifier_id: z.string().min(1),
  contract_id: z.string().min(1),
  checks: z.array(EvidenceCheckSchema).min(1),
  /** 执行时间戳（epoch ms；由调用方注入——decideVerdict 不读墙钟，保证确定性） */
  ts: z.number().int().nonnegative(),
  source: z.string().min(1),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

// ---- VerificationResult（判定输出：三态 + hard_failures + unknown_checks + 质量分量） ----

/**
 * 验证结果（decideVerdict 纯函数输出）：
 * hard_failures 记录被权威证据判 fail 的检查（hard 与 outcome 均记，裁决要点①）；unknown_checks 记录证据不足的检查；
 * process_quality（0~1，调用方注入——P2 起，结果与过程质量分离，裁决要点⑥）/ controllability 不在纯函数内计算；
 * evidence_quality（0~1，纯函数计算：有结果检查数 / 全部应查检查数）。
 */
export const VerificationResultSchema = z.object({
  contract_id: z.string().min(1),
  verdict: VerdictSchema,
  hard_failures: z.array(z.string().min(1)),
  unknown_checks: z.array(z.string().min(1)),
  /** 过程质量（0~1；调用方注入，纯函数不计算——P2 起消费） */
  process_quality: z.number().min(0).max(1).optional(),
  /** 可控性（调用方注入；P3 外部不可控失败不污染能力评分） */
  controllability: z.record(z.string(), z.string()).optional(),
  /** 证据质量（0~1；纯函数计算） */
  evidence_quality: z.number().min(0).max(1),
  /** 判定理由（中文可审计；确定性构造） */
  reason: z.string().min(1),
  /** 参与判定的证据（契约内、contract_id 匹配） */
  evidence: z.array(VerificationEvidenceSchema),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
