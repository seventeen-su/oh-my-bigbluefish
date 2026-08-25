// layer 2（kernel/）：S2 机械过程质量向量（用户裁决 2026-08-25 第二阶段 S2/S7）。
// 语义（裁决 S7）：先保留原始向量 {progress_gain, evidence_gain, recovery, redundancy,
//   tool_efficiency, branch_efficiency}，再产生综合分——未来有真实数据后学习综合权重，
//   不一开始训练黑盒评分器。机械评分优先，LLM 评分只在无法机械化时（本文件纯机械）。
// 零 I/O、零副作用、零随机、零墙钟：同输入 → 同输出（测试锚定）。
// 层 DAG：kernel 纯函数（layer 2）——零 import（仅自身类型），消费方 = runtime/assembly.ts（接线）。

// ---- 机械向量定义 ----

/** 过程质量向量键（裁决 S7 定型六维；消费方/落盘按此键序） */
export const PROCESS_QUALITY_VECTOR_KEYS = [
  'progress_gain',
  'evidence_gain',
  'recovery',
  'redundancy',
  'tool_efficiency',
  'branch_efficiency',
] as const;

/** 过程质量向量（Record<键, 0~1 原始分量>——保留原始向量，综合分由 normalizeProcessQuality 另行产出） */
export type ProcessQualityVector = Record<(typeof PROCESS_QUALITY_VECTOR_KEYS)[number], number>;

/** 综合分权重（键 → 权重；占位常量——未来 §17 观测标定学习真实权重，不训练黑盒） */
export type ProcessQualityWeights = Record<(typeof PROCESS_QUALITY_VECTOR_KEYS)[number], number>;

/**
 * 缺省综合权重（占位常量，§17 观测标定）：
 *   progress_gain 0.3（决策推进最重要）/ evidence_gain 0.2（证据积累）/ recovery 0.2（降级恢复）/
 *   tool_efficiency 0.15（工具效率）/ redundancy 0.1（冗余度）/ branch_efficiency 0.05（分支效率——
 *   无分支数据，权重最低——中性占位不假装精确）。权重和 = 1.0（加权和即 0~1 均值语义）。
 */
export const DEFAULT_QUALITY_WEIGHTS: ProcessQualityWeights = {
  progress_gain: 0.3,
  evidence_gain: 0.2,
  recovery: 0.2,
  tool_efficiency: 0.15,
  redundancy: 0.1,
  branch_efficiency: 0.05,
};

/** 质量向量信号输入（信号源：finalizeTurn 的 decision/signals(utility_counts)/归约 claims/降级日志） */
export interface QualityVectorInput {
  /** 决策是否产生（decision/made 兜底；finalize 路径恒 true） */
  decision_made: boolean;
  /** 归约投影 claims 数（证据积累面；无归约 → 0） */
  claims_count: number;
  /** 工具调用次数（signals.utility_counts.tool_calls） */
  tool_calls: number;
  /** 纠正次数（signals.utility_counts.corrections——冗余度近似面） */
  corrections: number;
  /** 降级记录数（degradationLog().length——恢复/健康近似面） */
  degradations: number;
}

/**
 * 信号 → 机械质量向量（确定性纯函数；各分量 0~1 封顶）：
 *   progress_gain = decision_made ? 1 : 0（决策推进：二元信号，诚实不细分）；
 *   evidence_gain = min(1, claims_count / 5)（5 条 claim 达满值——线性饱和）；
 *   recovery = max(0, 1 - degradations / 5)（无恢复计数面，以降级数近似"成功恢复"——降级越少越健康）；
 *   redundancy = max(0, 1 - corrections / 3)（以纠正数近似冗余度——纠正越多说明过程越绕）；
 *   tool_efficiency = tool_calls <= 0 ? 1 : 1 / (1 + tool_calls / 10)（无工具调用 = 1 满分；
 *     10 次调用 → 0.5——工具使用边际递减，非零即非满效率）；
 *   branch_efficiency = 0.5（无分支数据——中性占位，不假装精确；未来分支观测面接入后替换）。
 */
export function qualityVectorFromSignals(input: QualityVectorInput): ProcessQualityVector {
  return {
    progress_gain: input.decision_made ? 1 : 0,
    evidence_gain: Math.min(1, input.claims_count / 5),
    recovery: Math.max(0, 1 - input.degradations / 5),
    redundancy: Math.max(0, 1 - input.corrections / 3),
    tool_efficiency: input.tool_calls <= 0 ? 1 : 1 / (1 + input.tool_calls / 10),
    branch_efficiency: 0.5,
  };
}

/**
 * 综合分（加权和 → clamp [0,1] → 保留两位）。weights 缺省 DEFAULT_QUALITY_WEIGHTS
 * （未来 §17 观测标定替换权重——调用方保留原始向量，本函数只负责合成）。
 * 确定性：同向量同权重 → 同输出。
 */
export function normalizeProcessQuality(
  v: ProcessQualityVector,
  weights: ProcessQualityWeights = DEFAULT_QUALITY_WEIGHTS,
): number {
  let sum = 0;
  for (const key of PROCESS_QUALITY_VECTOR_KEYS) {
    sum += (v[key] ?? 0) * (weights[key] ?? 0);
  }
  const clamped = Math.max(0, Math.min(1, sum));
  return Math.round(clamped * 100) / 100;
}
