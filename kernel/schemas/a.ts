// A 组（一等对象，架构 §4.3 A1-A4）。
// A4 MemoryBackend 为接口（§4.3；M3 实现）——本任务只定义类型/接口签名。
import { z } from 'zod';
import { ProvenanceSchema, ScopeEnum, irBase } from './base.js';
import { MemoryKindEnum, MemoryLifecycleEnum, MemoryProvClassEnum } from './m.js';

/** A1 Artifact { id=sha256, type, content, provenance, scope, hash, version, parent[], derived_from[], restore_policy, compressed_views[] } */
export const ArtifactSchema = irBase({
  type: z.string().min(1),
  content: z.string().min(1),
  provenance: ProvenanceSchema,
  scope: ScopeEnum,
  hash: z.string().regex(/^[0-9a-f]{64}$/i),
  version: z.string().min(1),
  parent: z.array(z.string()),
  derived_from: z.array(z.string()),
  restore_policy: z.string().min(1),
  compressed_views: z.array(z.string()),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** A2 SkillStack { id, version, immutable, skills[{id, pin}], capabilities[], assumptions[], validated, context_plan? }（不可变组合） */
export const SkillStackSchema = irBase({
  version: z.string().min(1),
  immutable: z.literal(true),
  skills: z.array(
    z.object({
      id: z.string().min(1),
      pin: z.string().min(1),
    }),
  ),
  capabilities: z.array(z.string()),
  assumptions: z.array(z.string()),
  validated: z.boolean(),
  context_plan: z.string().optional(),
});
export type SkillStack = z.infer<typeof SkillStackSchema>;

/** A3 ContextProjection { id, type, sections[{source_ref, view, content, tokens}], original_artifact_ids[], total_tokens, restore_capable, deterministic } */
export const ContextProjectionSchema = irBase({
  type: z.enum(['planning', 'execution_scratch', 'evidence_artifact', 'mixed']),
  sections: z.array(
    z.object({
      source_ref: z.string().min(1),
      view: z.string().min(1),
      content: z.string().min(1),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  original_artifact_ids: z.array(z.string()),
  total_tokens: z.number().int().nonnegative(),
  restore_capable: z.boolean(),
  deterministic: z.boolean(),
});
export type ContextProjection = z.infer<typeof ContextProjectionSchema>;

// ---- A4 MemoryBackend（接口签名，§4.3） ----

/** MemoryQuery（§4.3）：scope 必填；kind/lifecycle/prov_class/text/relation 可选 */
export const MemoryQuerySchema = z.object({
  scope: ScopeEnum,
  kind: MemoryKindEnum.optional(),
  lifecycle: MemoryLifecycleEnum.optional(),
  prov_class: MemoryProvClassEnum.optional(),
  text: z.string().optional(),
  relation: z.string().optional(),
  limit: z.number().int().nonnegative(),
  budget: z.number().nonnegative(),
});
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export interface MemoryPage {
  items: unknown[];
  cursor?: string;
  total?: number;
}

export interface RelationWalk {
  nodes: unknown[];
  edges: unknown[];
}

/** MemoryBackend 接口（§4.3；M3 实现本接口——本任务仅签名） */
export interface MemoryBackend {
  query(q: MemoryQuery, opts: { page?: number; cursor?: string; sort?: string }): Promise<MemoryPage>;
  ingest(entry: unknown): Promise<string>;
  update(id: string, patch: unknown): Promise<void>;
  delete(id: string): Promise<void>;
  relationTraverse(seed: string, types: string[], depth: number): Promise<RelationWalk>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/** OMB_OBJECTS 中 A4 的清单描述（无运行时 schema，仅接口） */
export const MemoryBackendDescriptor = { kind: 'interface', name: 'MemoryBackend' } as const;
export type MemoryBackendDescriptor = typeof MemoryBackendDescriptor;
