// OMB v2 演化信号契约（架构 §6.5.1 触发链 / §6.5.2 候选产物 / §6.5.7 维护债务；P1c）。
// 纯 zod schema + 类型（契约层纪律：无 I/O、无业务逻辑、无副作用——supervisor 可经契约例外 import）。
// 内容：
//   - SignalRecord：.evolution/signals/<yyyy-mm-dd>.jsonl 每行形状（{ts, kind, session_id?, payload}）
//   - SignalSummary：判定输入（窗口 + 按 kind 聚合计数）
//   - EvolutionDecision：判定输出（是否演化/强度/对象层/预算估计）
//   - MaintenanceUrgency：维护债务紧迫度（与 supervisor/maintenance.ts Urgency 同值域，防枚举漂移）
import { z } from 'zod';

// ---- 信号记录（JSONL 行） ----

/** 演化信号记录（signals/ JSONL 每行；ts = epoch ms；kind = 信号种类（utility 键/L1 kind/后续扩展）） */
export const SignalRecordSchema = z.object({
  ts: z.number().int().nonnegative(),
  kind: z.string().min(1),
  session_id: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type SignalRecord = z.infer<typeof SignalRecordSchema>;

// ---- 信号摘要（判定输入） ----

/** 信号摘要：观察窗口 + 按 kind 聚合计数（decideEvolution 输入；纯函数构造，确定性） */
export interface SignalSummary {
  window: { from: number; to: number };
  counts: Record<string, number>;
}

// ---- 演化判定输出（§6.5.1：是否演化 / 演化什么对象 / 演化强度） ----

/** 演化对象层（§6.5.2 对象分层：L0 数据 → L1 代码 → 宪法层人工门） */
export type EvolutionObjectLayer = 'L0' | 'L1' | 'constitution';

/** 演化判定输出（纯函数决定；budget_estimate 为本次演化估算成本） */
export interface EvolutionDecision {
  should_evolve: boolean;
  /** 演化强度（0..1；取命中触发规则的最大强度；未命中 0） */
  strength: number;
  /** 目标对象层（命中规则决定；未命中 L0） */
  object_layer: EvolutionObjectLayer;
  /** 本次演化估算成本（Σ strength×count×单位成本，单位成本数据见 kernel/evolve-decision） */
  budget_estimate: number;
  /** 命中的触发规则（确定性顺序：kind 字典序） */
  triggers: Array<{ kind: string; strength: number; object_layer: EvolutionObjectLayer }>;
  /** 判定理由（machine-readable 键 + 细节） */
  reason: string;
}

// ---- 维护债务紧迫度（§10.1 urgency 语义；与 supervisor/maintenance.ts 共享，防漂移） ----

export const MAINTENANCE_URGENCIES = ['normal', 'soft', 'hard', 'critical'] as const;
export type MaintenanceUrgency = (typeof MAINTENANCE_URGENCIES)[number];
