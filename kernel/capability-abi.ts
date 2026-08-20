// OMB v2 能力 ABI 接口定义（架构 §8.1 契约匹配字段 + §4.4 Fingerprint）。
// layer 2（kernel/）：仅 import node: 内置、zod 与 kernel/schemas（同层，CONVENTIONS §4）。
// 只定义接口与执行边界，不实现调度/注册（M6 完善）。
// 契约校验 schema 独立定义于本文件（契约是 ABI 的一部分），与 P3 Capability 的
// IR schema（kernel/schemas/p.ts，T1.1）分离。
import { z, type ZodType } from 'zod';
import { FingerprintSchema, OwnerEnum } from './schemas/base.js';

/** 输入/输出契约面：M2 简化——zod schema 实例（与 T1.1 选型一致），执行前由调用方用于校验 */
export type JSONSchemaLike = ZodType;

/**
 * 契约（§8.1 契约匹配字段子集，M2 定稿）。
 * input/output：zod schema 实例；environment：环境指纹（§4.4，无指纹不跨环境迁移）；
 * authority_scope 与 §4.1 owner 对齐（kernel|system|user|community）。
 */
export const CapabilityContractSchema = z.object({
  id: z.string().min(1), // capability:<uuid>
  name: z.string().min(1),
  input: z.custom<ZodType>((v) => v instanceof z.ZodType, {
    message: 'input 必须是 zod schema 实例',
  }),
  output: z.custom<ZodType>((v) => v instanceof z.ZodType, {
    message: 'output 必须是 zod schema 实例',
  }),
  cost: z.object({
    tokens: z.number().int().nonnegative().optional(),
    latency_ms: z.number().nonnegative().optional(),
  }),
  side_effect: z.enum(['none', 'read_only', 'mutate', 'external']),
  reversibility: z.object({
    declared: z.boolean(),
    rollback_path: z.string().min(1).optional(),
  }),
  reliability: z.enum(['high', 'medium', 'low']),
  evidence_quality: z.enum(['none', 'attested', 'verified']),
  idempotency: z.enum(['idempotent', 'not_idempotent']),
  concurrency: z.enum(['safe', 'exclusive']),
  environment: FingerprintSchema.optional(),
  authority_scope: OwnerEnum,
});
export type CapabilityContract = z.infer<typeof CapabilityContractSchema>;

/** 执行结果（执行边界；observation_ref 绑定 Observation，对应 actual_effect） */
export interface CapabilityResult {
  ok: boolean;
  /** ok 时存在 */
  output?: unknown;
  /** !ok 时存在 */
  error?: { code: string; message: string; retryable: boolean };
  observation_ref?: string;
  metrics: { tokens: number; latency_ms: number };
}

/** 执行边界：绑定契约的调用句柄；cancel 可选（不支持取消的能力省略） */
export interface CapabilityHandle {
  contract: CapabilityContract;
  execute(input: unknown): Promise<CapabilityResult>;
  cancel?(): Promise<void>;
}

/** Provider（注册者视角）：manifest + 按执行上下文创建句柄 */
export interface CapabilityProvider {
  manifest: CapabilityContract;
  createHandle(ctx: { scope: string; budget: number }): Promise<CapabilityHandle>;
}

/** 契约校验（safeParse；合法返回 success:true） */
export function validateContract(c: unknown) {
  return CapabilityContractSchema.safeParse(c);
}
