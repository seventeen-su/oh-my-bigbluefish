// M 组（记忆/系统，架构 §4.2 M1-M8 + §7.1 四维枚举 + §12.1 Event）。
import { z } from 'zod';
import { ProvenanceSchema, ScopeEnum, irBase } from './base.js';

// ---- §7.1 Memory 四维正交枚举 ----

export const MemoryKindEnum = z.enum(['Semantic', 'Episodic', 'Procedural', 'Profile', 'Constraint', 'Decision']);
export const MemoryLifecycleEnum = z.enum(['Active', 'Dormant', 'Suspicious', 'Frozen', 'Retired']);
export const MemoryProvClassEnum = z.enum([
  'Observation',
  'User-declared',
  'Tool-derived',
  'Model-inferred',
  'Externally-attested',
  'System-derived',
]);
export type MemoryKind = z.infer<typeof MemoryKindEnum>;
export type MemoryLifecycle = z.infer<typeof MemoryLifecycleEnum>;
export type MemoryProvClass = z.infer<typeof MemoryProvClassEnum>;

/** M1 Memory { scope, kind, lifecycle, prov_class, payload, value_score, utility_counts, belief_ref?, lineage_ref? } */
export const MemorySchema = irBase({
  scope: ScopeEnum,
  kind: MemoryKindEnum,
  lifecycle: MemoryLifecycleEnum,
  prov_class: MemoryProvClassEnum,
  payload: z.string().min(1),
  value_score: z.number().min(0).max(1),
  utility_counts: z.record(z.string(), z.number().int().nonnegative()),
  belief_ref: z.string().optional(),
  lineage_ref: z.string().optional(),
});
export type Memory = z.infer<typeof MemorySchema>;

// ---- §12.1 Event（M3） ----

/** 固定段事件类型 + 通配段（process/operator/*、evolution/* 按前缀段建模） */
export const FIXED_EVENT_TYPES = [
  'session/start',
  'session/end',
  'context/injected',
  'tool/call',
  'tool/result',
  'claim/update',
  'hypothesis/transition',
  'decision/made',
  'contradiction/found',
  'observation/contradictory',
  'evidence/revoked',
  'memory/admitted',
  'memory/consolidated',
  'checkpoint/saved',
  'activation/committed',
  'maintenance/quantum',
] as const;

export const EventTypeSchema = z.union([
  z.enum(FIXED_EVENT_TYPES),
  z.string().regex(/^process\/operator\/[a-z][a-z0-9_-]*$/),
  z.string().regex(/^evolution\/[a-z][a-z0-9_-]*$/),
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/** M3 Event {id, type, session_id, runtime_snapshot, parent_event, causality, payload, provenance, timestamp} */
export const EventSchema = irBase({
  type: EventTypeSchema,
  session_id: z.string().min(1),
  runtime_snapshot: z.string().min(1),
  parent_event: z.string().nullable().optional(),
  causality: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  provenance: ProvenanceSchema,
  timestamp: z.string().min(1),
});
export type Event = z.infer<typeof EventSchema>;

/** M4 EvolutionObject { id=sha256, protocol_version, parent, diff, compat, bench, provenance, spdx, verifications } */
export const EvolutionObjectSchema = irBase({
  protocol_version: z.string().min(1),
  parent: z.string().nullable().optional(),
  diff: z.string().min(1),
  compat: z.string().min(1),
  bench: z.string().min(1),
  provenance: ProvenanceSchema,
  spdx: z.string().min(1),
  verifications: z.array(z.string()),
});
export type EvolutionObject = z.infer<typeof EvolutionObjectSchema>;

/** M5 RuntimeSnapshot { components{scheduler,memory,verifier,renderer,capability,philosophy: sha256}, task_contract_ref, created, activation_contract_ref } */
export const RuntimeSnapshotSchema = irBase({
  components: z.object({
    scheduler: z.string().min(1),
    memory: z.string().min(1),
    verifier: z.string().min(1),
    renderer: z.string().min(1),
    capability: z.string().min(1),
    philosophy: z.string().regex(/^[0-9a-f]{64}$/i),
  }),
  task_contract_ref: z.string().min(1),
  created: z.string().min(1),
  activation_contract_ref: z.string().min(1),
});
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;

/** M6 ActivationContract { predecessor, candidate, required_capabilities, evidence_certificate, compatible_schema, activation_scope, rollback_snapshot } */
export const ActivationContractSchema = irBase({
  predecessor: z.string().min(1),
  candidate: z.string().min(1),
  required_capabilities: z.array(z.string()),
  evidence_certificate: z.string().min(1),
  compatible_schema: z.string().min(1),
  activation_scope: z.string().min(1),
  rollback_snapshot: z.string().min(1),
});
export type ActivationContract = z.infer<typeof ActivationContractSchema>;

/** M7 Checkpoint { working_state, hash, timestamp, runtime_snapshot, provenance } */
export const CheckpointSchema = irBase({
  working_state: z.string().min(1),
  hash: z.string().min(1),
  timestamp: z.string().min(1),
  runtime_snapshot: z.string().min(1),
  provenance: ProvenanceSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/** M8 MaintenanceDebt { task_id, value, accumulated_at, priority, estimated_cost, urgency } */
export const MaintenanceDebtSchema = irBase({
  task_id: z.string().min(1),
  value: z.number().nonnegative(),
  accumulated_at: z.string().min(1),
  priority: z.string().min(1),
  estimated_cost: z.number().nonnegative(),
  urgency: z.number().nonnegative(),
});
export type MaintenanceDebt = z.infer<typeof MaintenanceDebtSchema>;
