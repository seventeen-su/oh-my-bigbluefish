// P 组（过程/能力，架构 §4.2 P1-P5 + §5.3 Operator ABI）。
import { z } from 'zod';
import { BudgetSchema, FingerprintSchema, irBase } from './base.js';

/** P2 Operator（§5.3 ABI）：{id, version, input_binding, output, cost, side_effect, verification, error{...}, transaction} */
export const OperatorSchema = irBase({
  version: z.string().min(1),
  input_binding: z.record(z.string(), z.unknown()),
  output: z.string().min(1),
  cost: BudgetSchema,
  side_effect: z.string().min(1),
  verification: z.string().min(1),
  error: z.object({
    retryable: z.boolean(),
    timeout_ms: z.number().nonnegative(),
    cancelable: z.boolean(),
    rollback: z.string().min(1),
  }),
  transaction: z.boolean(),
});
export type Operator = z.infer<typeof OperatorSchema>;

/** P1 Process { operator_graph[], entry, exit, budget, version, parent } */
export const ProcessSchema = irBase({
  operator_graph: z.array(OperatorSchema),
  entry: z.string().min(1),
  exit: z.string().min(1),
  budget: BudgetSchema,
  version: z.string().min(1),
  parent: z.string().nullable().optional(),
});
export type Process = z.infer<typeof ProcessSchema>;

/** CapabilityContract（§8.1 契约匹配面：input/output/cost/latency/side_effect/reversibility/reliability/evidence_quality/idempotency/concurrency/environment） */
export const CapabilityContractSchema = z.object({
  input: z.string().min(1),
  output: z.string().min(1),
  cost: BudgetSchema,
  latency_ms: z.number().nonnegative().optional(),
  side_effect: z.string().min(1),
  reversibility: z.object({
    declared: z.boolean(),
    rollback_path: z.string().min(1),
  }),
  reliability: z.number().min(0).max(1).optional(),
  evidence_quality: z.string().optional(),
  idempotency: z.boolean().optional(),
  concurrency: z.number().int().nonnegative().optional(),
  environment: FingerprintSchema.optional(),
});
export type CapabilityContract = z.infer<typeof CapabilityContractSchema>;

/** P3 Capability { contract: CapabilityContract, provider, authority_scope, stats } */
export const CapabilitySchema = irBase({
  contract: CapabilityContractSchema,
  provider: z.string().min(1),
  authority_scope: z.string().min(1),
  stats: z.object({
    calls: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    avg_latency_ms: z.number().nonnegative().optional(),
  }),
});
export type Capability = z.infer<typeof CapabilitySchema>;

/** P4 Intent { verb, object, scope, effects: read_only|mutate|external, constraints, required_verification }（scope 为领域作用域字符串，覆盖基座枚举） */
export const IntentSchema = irBase({
  verb: z.string().min(1),
  object: z.string().min(1),
  scope: z.string().min(1),
  effects: z.enum(['read_only', 'mutate', 'external']),
  constraints: z.array(z.string()),
  required_verification: z.string().min(1),
});
export type Intent = z.infer<typeof IntentSchema>;

/** P5 Skill（§8.3：source: bundled|community|learned|user；ownership: global|project|user；继承 parent + overrides） */
export const SkillSchema = irBase({
  name: z.string().min(1),
  source: z.enum(['bundled', 'community', 'learned', 'user']),
  ownership: z.enum(['global', 'project', 'user']),
  parent: z.string().nullable().optional(),
  overrides: z.array(z.string()),
  version: z.string().min(1),
});
export type Skill = z.infer<typeof SkillSchema>;
