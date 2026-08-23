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

// ---- P1d：候选草稿（§6.5.2 候选生成产物；纯类型契约——生成器在 kernel/，管线在 supervisor/，经契约层共享） ----

/** 候选变更（结构化：参数点路径 + 旧值 → 新值；测试与 Evolution Object.diff 锚定） */
export interface CandidateChange {
  /** 点路径（如 'signal_triggers.corrections.strength'） */
  path: string;
  /** 变更前值（策略参数） */
  old: number;
  /** 变更后值（策略参数） */
  new: number;
}

/**
 * P1d 候选草稿（首个候选源 = 信号驱动的策略参数微调确定性生成器，无需 LLM）：
 *  - id：内容寻址（sha256:<前缀>，同 target+content → 同 id → candidate_id 幂等键；前缀碰撞追加 -<seq>）
 *  - target：policy 文件路径（相对线快照根，如 kernel/policy/evolve.yaml）
 *  - content：新文件完整 YAML（覆盖式 diff 提交内容——不删除其余文件）
 *  - diff：变更说明（Evolution Object.diff 用；path old→new + 依据）
 */
export interface CandidateDraft {
  id: string;
  /** 集合内序号（确定性排序；不参与幂等键） */
  seq: number;
  /** 候选类型（首个候选源恒为 'policy'；L0 数据候选） */
  kind: 'policy';
  target: string;
  content: string;
  diff: string;
  motivation: string;
  /** 来源信号 kind（corrections/oracle_fail/scope_miss/untrusted_object） */
  signal: string;
  change: CandidateChange;
  /**
   * 可选执行型验证脚本（P3 G3-exec）：.cjs 源码。宿主把脚本写入候选验证目录 verify.cjs
   * （白名单固定名，仅候选目录内）后经 WRITE_RESTRICTED 受限通道执行（结果文件方案回传：
   * 脚本写 OMB_SANDBOX_RESULT_FILE，宿主读——受限进程不能管道捕获孙进程输出）。
   * 缺省 undefined = 无执行型验证内容（当前 L0 数据候选无脚本 → G3-exec N/A 标记；
   * L1 代码候选未来复用）。
   */
  verify?: { script: string };
}
