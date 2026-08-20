// Semantic IR 全量导出 + 对象清单（OMB_OBJECTS：编号 → schema，防漂移锚）。
// 编号固定：S1-S4/C1-C11/P1-P5/M1-M8（28 核心）+ A1-A4（4 一等）= 32 编号（架构 §4.2/§4.3 枚举全量）。
export * from './base.js';
export * from './s.js';
export * from './c.js';
export * from './p.js';
export * from './m.js';
export * from './a.js';

import { ProvenanceSchema } from './base.js';
import { S4Schema, StateSchema, TaskContractSchema, WorkingStateSchema } from './s.js';
import {
  ActionContractSchema,
  ActionSchema,
  BeliefSchema,
  ClaimSchema,
  ContradictionSchema,
  DecisionSchema,
  EvidenceSchema,
  ExperienceSchema,
  HypothesisSchema,
  ObservationSchema,
  OpenQuestionSchema,
} from './c.js';
import {
  CapabilitySchema,
  IntentSchema,
  OperatorSchema,
  ProcessSchema,
  SkillSchema,
} from './p.js';
import {
  ActivationContractSchema,
  CheckpointSchema,
  EventSchema,
  EvolutionObjectSchema,
  MaintenanceDebtSchema,
  MemorySchema,
  RuntimeSnapshotSchema,
} from './m.js';
import {
  ArtifactSchema,
  ContextProjectionSchema,
  MemoryBackendDescriptor,
  SkillStackSchema,
} from './a.js';

/** 编号 → schema 映射（A4 为接口描述）。值统一为 zod schema 或接口描述对象 */
export const OMB_OBJECTS = {
  S1: TaskContractSchema,
  S2: StateSchema,
  S3: WorkingStateSchema,
  S4: S4Schema,
  C1: ClaimSchema,
  C2: HypothesisSchema,
  C3: ContradictionSchema,
  C4: EvidenceSchema,
  C5: ObservationSchema,
  C6: BeliefSchema,
  C7: OpenQuestionSchema,
  C8: ActionSchema,
  C9: ActionContractSchema,
  C10: DecisionSchema,
  C11: ExperienceSchema,
  P1: ProcessSchema,
  P2: OperatorSchema,
  P3: CapabilitySchema,
  P4: IntentSchema,
  P5: SkillSchema,
  M1: MemorySchema,
  M2: ProvenanceSchema,
  M3: EventSchema,
  M4: EvolutionObjectSchema,
  M5: RuntimeSnapshotSchema,
  M6: ActivationContractSchema,
  M7: CheckpointSchema,
  M8: MaintenanceDebtSchema,
  A1: ArtifactSchema,
  A2: SkillStackSchema,
  A3: ContextProjectionSchema,
  A4: MemoryBackendDescriptor,
} as const satisfies Record<string, object>;

/** 对象编号字面量（S1|S2|...|A4） */
export type ObjectNumber = keyof typeof OMB_OBJECTS;

/** 编号顺序清单（防漂移测试用） */
export const OBJECT_NUMBERS = Object.keys(OMB_OBJECTS) as ObjectNumber[];
