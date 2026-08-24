// S 组（状态/任务，架构 §4.2 S1-S4）。
// S4 = WorldModel / SelfModel 双变体（kind 判别，S4Schema 为两者联合）。
import { z } from 'zod';
import { BudgetSchema, FingerprintSchema, irBase } from './base.js';

/** S1 TaskContract { goal, success_criteria, constraints, allowed_effects, verifier, budget, termination, environment } */
export const TaskContractSchema = irBase({
  goal: z.string().min(1),
  success_criteria: z.array(z.string()),
  constraints: z.array(z.string()),
  allowed_effects: z.array(z.string()),
  verifier: z.string().min(1),
  budget: BudgetSchema,
  termination: z.object({
    max_steps: z.number().int().nonnegative().optional(),
    timeout_ms: z.number().nonnegative().optional(),
    condition: z.string().optional(),
  }),
  environment: FingerprintSchema,
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

/** S3 WorkingState { goal, confirmed_facts, active_hypotheses, contradictions, open_questions, evidence_gaps, next_best_action, environment }（8 字段） */
export const WorkingStateSchema = irBase({
  goal: z.string().min(1),
  confirmed_facts: z.array(z.string()),
  active_hypotheses: z.array(z.string()),
  contradictions: z.array(z.string()),
  open_questions: z.array(z.string()),
  evidence_gaps: z.array(z.string()),
  next_best_action: z.string().min(1),
  environment: FingerprintSchema,
});
export type WorkingState = z.infer<typeof WorkingStateSchema>;

/** S2 State { working: WorkingState, world: WorldModelRef, self: SelfModelRef, snapshot_hash } */
export const StateSchema = irBase({
  working: WorkingStateSchema,
  world: z.string().min(1),
  self: z.string().min(1),
  snapshot_hash: z.string().min(1),
});
export type State = z.infer<typeof StateSchema>;

/** S4 WorldModel（引用对象：当前能力/限制；环境状态）。
 *  S1 运行接线扩展（可选字段——纯契约阶段对象可缺省）：项目架构事实（版本线/commit/lines 快照/布局/基准状态）。 */
export const WorldModelSchema = irBase({
  kind: z.literal('world_model'),
  capabilities: z.array(z.string()),
  limitations: z.array(z.string()),
  environment: FingerprintSchema,
  // S1 扩展：项目架构事实（装配期从 runtime 真实状态组装；commit/线快照未知 → 缺省（诚实，不臆造））
  line: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  line_snapshot: z.object({
    line: z.string().min(1),
    commit: z.string().min(1),
    dir: z.string().min(1),
  }).optional(),
  layout_state: z.string().min(1).optional(),
  bench: z.object({
    recent_real_reports: z.number().int().nonnegative(),
    recent_replay_reports: z.number().int().nonnegative(),
  }).optional(),
});
export type WorldModel = z.infer<typeof WorldModelSchema>;

/** S4 SelfModel（引用对象：可靠策略/盲点；当前状态）。
 *  S1 运行接线扩展（可选字段）：版本（R6 hostVersion/插件版本）与资源（无硬数据 → 缺省，诚实未知）。 */
export const SelfModelSchema = irBase({
  kind: z.literal('self_model'),
  reliable_strategies: z.array(z.string()),
  blind_spots: z.array(z.string()),
  current_state: z.string().min(1),
  environment: FingerprintSchema,
  // S1 扩展：版本与资源（装配期真实值；资源无硬数据源 → memory_mb/cpus = null + detail 说明）
  host_version: z.string().min(1).optional(),
  plugin_version: z.string().min(1).optional(),
  resources: z.object({
    memory_mb: z.number().int().nullable(),
    cpus: z.number().int().nullable(),
    detail: z.string().min(1),
  }).optional(),
});
export type SelfModel = z.infer<typeof SelfModelSchema>;

/** S4 联合（WorldModel | SelfModel，按 kind 判别） */
export const S4Schema = z.union([WorldModelSchema, SelfModelSchema]);
export type S4 = z.infer<typeof S4Schema>;
