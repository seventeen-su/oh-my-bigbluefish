// OMB v2 Semantic IR 统一基座（架构 §4.1/§4.4/§7.1）：IRBase、Ref、Provenance、Fingerprint、
// 共享枚举与 id 工具（可变对象 `type:uuid`；不可变对象 `sha256:<hash>`，改 = 新 id）。
// layer 2（kernel/）：仅 import node: 内置与 zod（CONVENTIONS §4）。
import { createHash, randomUUID } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';

// ---- 共享枚举 ----

/** 所有权（§4.1：owner: kernel|system|user|community） */
export const OwnerEnum = z.enum(['kernel', 'system', 'user', 'community']);
export type Owner = z.infer<typeof OwnerEnum>;

/** IR 作用域（§7.1 Scope：Session/Project/Global） */
export const ScopeEnum = z.enum(['Session', 'Project', 'Global']);
export type Scope = z.infer<typeof ScopeEnum>;

/** IR 对象通用生命周期（active/retired；Memory 对象另用 §7.1 五态枚举） */
export const LifecycleEnum = z.enum(['active', 'retired']);
export type Lifecycle = z.infer<typeof LifecycleEnum>;

// ---- 共享结构 ----

/** Ref（§4.1 refs: Ref[]）：对其它 IR 对象的引用；type = 目标对象类型（如 'C1'、'artifact'） */
export const RefSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  relation: z.string().optional(),
});
export type Ref = z.infer<typeof RefSchema>;

/** 环境指纹（§4.4）：经验/过程/记忆声明适用环境，无指纹不跨环境迁移 */
export const FingerprintSchema = z.object({
  os: z.string().min(1),
  node: z.string().min(1),
  dsh_version: z.string().min(1),
  project: z.string().min(1),
  gpu: z.string().optional(),
  cuda: z.string().optional(),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

/** 计算/资源预算（S1/P1/P2/P3 等处复用；各维可选） */
export const BudgetSchema = z.object({
  tokens: z.number().int().nonnegative().optional(),
  time_ms: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** Provenance（M2；全对象经 provenance 引用同一结构，§4.4） */
export const ProvenanceSchema = z.object({
  source: z.string().min(1),
  event: z.string().min(1),
  actor: z.string().min(1),
  environment: FingerprintSchema,
  runtime_snapshot: z.string().min(1),
  timestamp: z.string().min(1),
  transformation_chain: z.array(z.string()),
  verification: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ---- IRBase ----

const IRBaseObject = z.object({
  id: z.string().min(1),
  ir_version: z.string().min(1),
  schema: z.string().min(1),
  scope: ScopeEnum,
  lifecycle: LifecycleEnum,
  immutable: z.boolean(),
  owner: OwnerEnum.default('kernel'),
  created: z.string().min(1),
  updated: z.string().min(1),
  provenance: ProvenanceSchema,
  refs: z.array(RefSchema).default([]),
});

/** ID 语义（§4.1）：不可变对象 id 必须 `sha256:<64hex>`；可变对象不得使用 sha256 id */
const SHA_ID = /^sha256:[0-9a-f]{64}$/i;

type IdView = { id: string; immutable: boolean };

/** IRBase + 对象字段 + id 语义 refine。所有对象 schema 经此构造（extend 后再 refine，zod v3/v4 兼容） */
export function irBase<T extends ZodRawShape>(shape: T) {
  return IRBaseObject.extend(shape)
    .refine((v) => !(v as IdView).immutable || SHA_ID.test((v as IdView).id), {
      message: 'immutable 对象 id 必须为 sha256:<64hex>',
      path: ['id'],
    })
    .refine((v) => (v as IdView).immutable || !SHA_ID.test((v as IdView).id), {
      message: '可变对象 id 不得为 sha256:<64hex>',
      path: ['id'],
    });
}

/** IRBase（§4.1 字段全量；owner/refs 有缺省） */
export const IRBaseSchema = irBase({});
export type IRBase = z.infer<typeof IRBaseSchema>;

// ---- id 工具（uuid / 内容哈希） ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 可变对象 id：`<type>:<uuid v4>`；非法 type fail-loud */
export function makeMutableId(type: string): string {
  if (!TYPE_RE.test(type)) {
    throw new Error(`invalid id type: ${type}`);
  }
  return `${type}:${randomUUID()}`;
}

/** 不可变对象 id：`sha256:<sha256(content)>`（同内容同 id，改内容 = 新 id） */
export function makeImmutableId(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** 校验 id 格式；type 提供时要求前缀 `type:` 且尾段为 uuid */
export function isValidId(id: string, type?: string): boolean {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }
  if (type !== undefined) {
    return TYPE_RE.test(type) && id.startsWith(`${type}:`) && UUID_RE.test(id.slice(type.length + 1));
  }
  if (id.startsWith('sha256:')) {
    return SHA256_RE.test(id.slice('sha256:'.length));
  }
  const idx = id.indexOf(':');
  if (idx <= 0) {
    return false;
  }
  return TYPE_RE.test(id.slice(0, idx)) && UUID_RE.test(id.slice(idx + 1));
}

/** 确定性 JSON（键序无关），供内容哈希使用 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 不可变对象派生：打补丁 → 新对象新 id（sha256 内容哈希，id 不参与自身哈希），原对象不变 */
export function deriveImmutable<T extends { id: string }>(obj: T, patch: Partial<Omit<T, 'id'>>): T {
  if ((obj as { immutable?: unknown }).immutable === false) {
    throw new Error('deriveImmutable: 目标对象 immutable 必须为 true');
  }
  const content = { ...obj, ...patch } as Record<string, unknown>;
  delete content.id;
  return { ...content, id: makeImmutableId(canonicalJson(content)) } as T;
}
