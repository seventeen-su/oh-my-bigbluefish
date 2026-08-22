// C 组（认知对象，架构 §4.2 C1-C11）。
import { z } from 'zod';
import { FingerprintSchema, ProvenanceSchema, irBase } from './base.js';

/** §14.1 证据态原语（evidence plane：claim 如何被知晓；与 §5.2 三值裁决态正交，分层协调见 M8b 报告；
 *  revoked = 证据效力被撤销（evidence/revoked 事件，历史不删除）） */
export const EvidenceStatusEnum = z.enum(['inferred', 'observed', 'verified', 'revoked']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusEnum>;

/** C1 Claim { text, epistemic, evidence_status, supported_by[], contradicted_by[], confidence } */
export const ClaimSchema = irBase({
  text: z.string().min(1),
  epistemic: z.enum(['supported', 'contradicted', 'unresolved']),
  evidence_status: EvidenceStatusEnum.default('inferred'),
  supported_by: z.array(z.string()),
  contradicted_by: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type Claim = z.infer<typeof ClaimSchema>;

/** C2 Hypothesis { claim, status, alternatives[] } */
export const HypothesisSchema = irBase({
  claim: z.string().min(1),
  status: z.enum(['active', 'discriminated', 'rejected', 'confirmed']),
  alternatives: z.array(z.string()),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

/** C3 Contradiction { id, left_claim, right_claim, scope, evidence, severity, unresolved } */
export const ContradictionSchema = irBase({
  left_claim: z.string().min(1),
  right_claim: z.string().min(1),
  scope: z.string().min(1),
  evidence: z.array(z.string()),
  severity: z.string().min(1),
  unresolved: z.boolean(),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

/** C4 Evidence { observation_ref, strength, reproducibility, environment } */
export const EvidenceSchema = irBase({
  observation_ref: z.string().min(1),
  strength: z.string().min(1),
  reproducibility: z.string().min(1),
  environment: FingerprintSchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** C5 Observation { from: tool|user|model|system, payload: ArtifactRef, ts } */
export const ObservationSchema = irBase({
  from: z.enum(['tool', 'user', 'model', 'system']),
  payload: z.string().min(1),
  ts: z.string().min(1),
});
export type Observation = z.infer<typeof ObservationSchema>;

/** C6 Belief { claim_ref, state{historical, current, transition_event, confidence}, revision_log[] } */
export const BeliefSchema = irBase({
  claim_ref: z.string().min(1),
  state: z.object({
    historical: z.array(z.string()),
    current: z.string().min(1),
    transition_event: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }),
  revision_log: z.array(z.string()),
});
export type Belief = z.infer<typeof BeliefSchema>;

/** C7 OpenQuestion { question, why_unresolved, candidate_answers, discriminating_observation, expected_information_gain, cost } */
export const OpenQuestionSchema = irBase({
  question: z.string().min(1),
  why_unresolved: z.string().min(1),
  candidate_answers: z.array(z.string()),
  discriminating_observation: z.string().min(1),
  expected_information_gain: z.string().min(1),
  cost: z.number().nonnegative(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

/** C9 ActionContract { preconditions[], expected_effect[], actual_effect[], cost, risk, reversibility{declared, rollback_path}, side_effects[], provenance } */
export const ActionContractSchema = irBase({
  preconditions: z.array(z.string()),
  expected_effect: z.array(z.string()),
  actual_effect: z.array(z.string()),
  cost: z.number().nonnegative(),
  risk: z.string().min(1),
  reversibility: z.object({
    declared: z.boolean(),
    rollback_path: z.string().min(1),
  }),
  side_effects: z.array(z.string()),
  provenance: ProvenanceSchema,
});
export type ActionContract = z.infer<typeof ActionContractSchema>;

/** C8 Action { contract: ActionContract, state: planned|executing|done|failed|aborted } */
export const ActionSchema = irBase({
  contract: ActionContractSchema,
  state: z.enum(['planned', 'executing', 'done', 'failed', 'aborted']),
});
export type Action = z.infer<typeof ActionSchema>;

/** C10 Decision { question, alternatives[], chosen, evidence_used[], environment, lineage[] } */
export const DecisionSchema = irBase({
  question: z.string().min(1),
  alternatives: z.array(z.string()),
  chosen: z.string().min(1),
  evidence_used: z.array(z.string()),
  environment: FingerprintSchema,
  lineage: z.array(z.string()),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** C11 Experience { context: FingerprintRef, action, result, relations{requires,excludes,fallback,causes,supersedes} }（PCR） */
export const ExperienceSchema = irBase({
  context: z.string().min(1),
  action: z.string().min(1),
  result: z.string().min(1),
  relations: z.object({
    requires: z.array(z.string()),
    excludes: z.array(z.string()),
    fallback: z.array(z.string()),
    causes: z.array(z.string()),
    supersedes: z.array(z.string()),
  }),
});
export type Experience = z.infer<typeof ExperienceSchema>;
