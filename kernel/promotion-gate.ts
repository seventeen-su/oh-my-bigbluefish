// layer 2（kernel/）：P1e 晋升门禁判定纯函数（架构 §6.5.3 防退化「只接受通过全部门 + fitness 不降」/
// §7 三层信号 / §6.5.4 晋升决策 + 实现规格 §10 Activation 事务门禁）。
// 零 I/O、零副作用、零随机：同输入 → 同输出（测试锚定）。
// 依赖：仅契约层 kernel/schemas/（policy.ts：EvolvePolicy/PromotionGate）——层 DAG 合规。
//
// 三层信号（§7）：
//   L1 机械硬门（零成本，最高优先）：冻结基准 fitness 不降（candidate passed ≥ baseline passed）+
//     成本劣化 ≤ 容忍（cost_degradation_ratio，门禁阈值数据化）；
//   L2 贝叶斯统计层（shadow/canary exposure）：有样本（n ≥ min_shadow_samples）时失败率后验不劣化
//     （failure_rate ≤ max_shadow_failure_rate）；无样本 → 记录「无 shadow 数据，以基准门禁为准」不阻塞；
//     样本不足（0 < n < min_shadow_samples）→ 记录不阻塞（§7.3 样本不足 → 延后/降级，不构成硬拒绝）；
//   L3 语义层（低频空闲期盲化 judge，P4 后接入）：本次仅占位注释——judge 仅旁证不作晋升硬信号（§7.1）。
//
// 门禁阈值数据化（P3 机制即数据）：policy.promotion_gate（evolve.yaml 可选段）→ resolvePromotionGate
// 回退 candidate_gate.cost_degradation_tolerance（缺省）——旧布局 evolve.yaml 无 promotion_gate 也合法
// （向后兼容）；改 YAML 即生效。
//
// 消费方 = runtime(2)（assembly 晋升检查，supervisor 不 import kernel 非 schemas——层 DAG）；
// bench 对照数据由调用方传入（runBenchV2 回放 + 成本代理），本函数只判。
import { DEFAULT_PROMOTION_GATE, type EvolvePolicy } from './schemas/policy.js';

/** 冻结基准 fitness 单侧（passed/total；成本劣化为相对量，单独字段） */
export interface PromotionBenchSide {
  passed: number;
  total: number;
}

/** 晋升基准对照输入（同 P1d BenchCompare 形状；bench 数据由调用方传入，函数只判） */
export interface PromotionBenchCompare {
  baseline: PromotionBenchSide;
  candidate: PromotionBenchSide;
  /** 成本代理劣化率（相对；≤ policy.cost_degradation_tolerance 通过） */
  cost_degradation_ratio: number;
}

/** L2 shadow exposure 统计（readShadowSignals 产物；n=0 → 无 shadow 数据不阻塞） */
export interface ShadowSignals {
  n: number;
  failures: number;
}

/** 晋升门禁策略（数据化阈值；resolvePromotionGate 从 evolve.policy 解析） */
export interface PromotionGatePolicy {
  /** L2：shadow 样本纳入判定的最低数（n ≥ 此值才按失败率判定） */
  min_shadow_samples: number;
  /** L2：shadow 失败率上限（n ≥ min_shadow_samples 时超限拒晋升） */
  max_shadow_failure_rate: number;
  /** L1：成本劣化容忍（相对比例） */
  cost_degradation_tolerance: number;
  /**
   * L1：是否要求候选的执行型验证**真实跑过**才可晋升（缺省 true = fail-closed）。
   * 来源 = evolve.policy.candidate_gate.require_execution_verification（resolvePromotionGate 同源注入，
   * 与候选门禁同一开关，避免"候选侧 fail-closed、晋升侧放行"的口径分叉）。
   * 缺省 undefined 亦按 true 判定（无证据不得晋升）——只有显式 false 才接受降级候选。
   * 注：`verify_evidence` 未提供（旧对象/无留痕）时，本项为 true 会拒绝晋升；早期调用方若只想
   * 复用 L1 基准/成本判定，须显式传 `require_execution_verification: false` 或在输入里给出证据。
   */
  require_execution_verification?: boolean;
}

/**
 * 执行型验证证据（候选晋升门禁新增输入；来源 = 候选记录的 gates_passed 留痕，
 * supervisor/candidate-pipeline 的 executionVerificationGateNote 写入）。
 * 语义：候选携带执行型验证脚本时，是否在受限通道里**真实跑过并通过**。
 *   - `verified`：跑过并通过（或候选本无执行型验证内容——L0 数据候选 N/A，无可执行之物）；
 *   - `degraded`：通道不可用/异常 → 没跑过（旧实现把它当"通过"，是已知问题）；
 *   - `rejected`/`unknown`：跑失败，或无法判定（旧记录无该留痕 → unknown，按未验证处理）。
 */
export type ExecutionEvidenceKind = 'verified' | 'degraded' | 'rejected' | 'unknown';

/** 执行型验证证据（可选输入——未提供时按 unknown 处理，由 require 开关决定是否阻塞） */
export interface ExecutionEvidence {
  kind: ExecutionEvidenceKind;
  /** 证据来源说明（候选记录的 gates_passed 条目；审计用） */
  detail: string;
}

/** shouldPromoteToStable 输入（brief 契约：baseline/candidate/shadow_signals/policy；bench 由调用方传入） */
export interface PromotionGateInput {
  baseline: { stable_commit: string; stable_bench: PromotionBenchSide };
  candidate: { latest_commit: string; latest_bench: PromotionBenchSide };
  cost_degradation_ratio: number;
  shadow_signals: ShadowSignals;
  policy: PromotionGatePolicy;
  /**
   * L1：执行型验证证据（可选——旧调用方/旧对象无此输入 → unknown）。
   * 与 candidate-pipeline 的 require_execution_verification 同一取舍：缺省 policy 要求"跑过"。
   */
  verify_evidence?: ExecutionEvidence;
}

/** 判定结果（reasons = 三层信号逐条说明；ok=false 时至少一条 reason 为拒绝原因） */
export interface PromotionGateVerdict {
  ok: boolean;
  reasons: string[];
}

/** commit 短显示（可追溯 reason 引用） */
function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}

/**
 * 晋升门禁策略解析（数据化阈值 + 向后兼容）：
 * promotion_gate 显式提供 → 逐字段使用；cost_degradation_tolerance 缺省回退
 * candidate_gate.cost_degradation_tolerance（既有候选门禁同值）；全部缺省 → DEFAULT_PROMOTION_GATE。
 */
export function resolvePromotionGate(policy: EvolvePolicy): PromotionGatePolicy {
  const pg = policy.promotion_gate;
  return {
    min_shadow_samples: pg?.min_shadow_samples ?? DEFAULT_PROMOTION_GATE.min_shadow_samples,
    max_shadow_failure_rate: pg?.max_shadow_failure_rate ?? DEFAULT_PROMOTION_GATE.max_shadow_failure_rate,
    cost_degradation_tolerance:
      pg?.cost_degradation_tolerance ??
      policy.candidate_gate.cost_degradation_tolerance ??
      DEFAULT_PROMOTION_GATE.cost_degradation_tolerance,
    // 与候选门禁同源（单一开关，避免"候选侧 fail-closed、晋升侧放行"的口径分叉）
    require_execution_verification: policy.candidate_gate.require_execution_verification ?? true,
  };
}

/**
 * 执行型验证证据 → 门禁判定（通过 → null；不通过 → 拒绝理由）。
 *
 * **缺证据不等于证据为负**（第一轮实现的修正）：`verify_evidence` 缺失表示「该候选产生于本门禁项
 * 存在之前」（旧 Evolution Object / 既有 trusted-latest 链）或「调用方未传」——这两种情况下把
 * 已有信任链上的对象一律拒晋升会造成级联停摆，且并非这套门禁要拦的东西。本门禁拦的是**显式记录**：
 *   - `kind='degraded'`（候选自己写了「没跑成」）→ 拒绝；
 *   - `kind='rejected'`（跑了但失败）→ 拒绝；
 *   - `kind='verified'` → 通过；
 *   - 未提供/`unknown` → 记录「无留痕，按未验证放行（不阻塞）」，不拒绝。
 * `require_execution_verification === false` 时降级证据也不阻塞（部署方显式接受），但理由如实标注。
 */
function judgeExecutionEvidence(
  evidence: ExecutionEvidence | undefined,
  policy: PromotionGatePolicy,
): string | null {
  const kind = evidence?.kind ?? 'unknown';
  const detail = evidence?.detail ?? '候选无执行型验证留痕（本门禁项引入前的旧对象）';
  if (kind === 'verified' || kind === 'unknown') {
    return null; // 无留痕不构成拒绝理由（见上方说明）
  }
  if (policy.require_execution_verification === false) {
    return null; // 显式接受降级（理由里如实标注）
  }
  switch (kind) {
    case 'degraded':
      return `L1 硬门: 执行型验证未真实发生（${detail}）——受限通道不可用/异常时候选没跑过，拒绝晋升`;
    default:
      return `L1 硬门: 执行型验证未通过（${detail}）——拒绝晋升`;
  }
}

/** 候选记录/Evolution Object 的验证留痕 → 执行型验证证据（无相关条目 → undefined = 无留痕） */
export function executionEvidenceFromVerifications(
  verifications: readonly string[] | undefined,
): ExecutionEvidence | undefined {
  if (verifications === undefined) {
    return undefined;
  }
  const note = verifications.find((v) => v.startsWith('G3-exec:'));
  if (note === undefined) {
    return undefined;
  }
  const kind: ExecutionEvidenceKind = note.startsWith('G3-exec:strict')
    ? 'verified'
    : note.startsWith('G3-exec:degraded')
      ? 'degraded'
      : note.startsWith('G3-exec:rejected')
        ? 'rejected'
        : note.startsWith('G3-exec:na')
          ? 'verified' // 无执行型验证内容（L0 数据候选）——无可执行之物，不构成"没验过"
          : 'unknown';
  return { kind, detail: `候选留痕 ${note}` };
}

/**
 * 晋升门禁判定纯函数（§6.5.3 防退化 + §7 三层信号）：stable ← trusted-latest 显式门禁。
 * 判定顺序：L1 硬门（fitness 不降 + 成本容忍）→ L2 统计（样本足够时失败率不劣化）→ L3 旁证占位。
 * 任一层拒绝 → ok=false（reasons 含拒绝原因与信号证据）；全部通过 → ok=true。
 * 无 shadow 数据 / 样本不足 → 记录说明不阻塞（基准门禁为准——防冻结演化闭环）。
 */
export function shouldPromoteToStable(input: PromotionGateInput): PromotionGateVerdict {
  const reasons: string[] = [];
  const { baseline, candidate, shadow_signals: shadow, policy } = input;

  // ---- L1 机械硬门（零成本，最高优先）：fitness 不降 + 成本劣化 ≤ 容忍 ----
  const b = baseline.stable_bench;
  const c = candidate.latest_bench;
  const fitOk = c.passed >= b.passed;
  reasons.push(
    `L1 硬门: 冻结基准 fitness 不降（候选 ${c.passed}/${c.total} ≥ 基线 ${b.passed}/${b.total}，` +
      `${shortCommit(baseline.stable_commit)} → ${shortCommit(candidate.latest_commit)}）` +
      (fitOk ? '通过' : '——拒绝（passed 不得降，AlphaEvolve 严格保留制）'),
  );
  const costOk = input.cost_degradation_ratio <= policy.cost_degradation_tolerance;
  reasons.push(
    `L1 硬门: 成本劣化 ${(input.cost_degradation_ratio * 100).toFixed(1)}% ≤ 容忍 ` +
      `${(policy.cost_degradation_tolerance * 100).toFixed(1)}%（数据化阈值）` +
      (costOk ? '通过' : '——拒绝'),
  );
  // L1：执行型验证证据（已知问题《Linux 适配不完整》派生条——"降级也当通过"不得跨到晋升侧）
  const execReject = judgeExecutionEvidence(input.verify_evidence, policy);
  const execKind = input.verify_evidence?.kind ?? 'unknown';
  const execDetail = input.verify_evidence?.detail ?? '候选无执行型验证留痕（本门禁项引入前的旧对象）';
  reasons.push(
    execReject ??
      `L1 硬门: 执行型验证证据 ${execKind}（${execDetail}）` +
        (execKind === 'verified'
          ? '通过'
          : execKind === 'unknown'
            ? '——无留痕不阻塞（缺证据 ≠ 证据为负）'
            : '——未真实执行，但 require_execution_verification=false（部署方显式接受）不阻塞'),
  );

  // ---- L2 统计层（shadow/canary exposure；无样本/样本不足不阻塞，基准门禁为准） ----
  let l2Ok = true;
  if (shadow.n === 0) {
    reasons.push('L2 统计: 无 shadow 数据（exposure log 空），以基准门禁为准——不阻塞（§7.1）');
  } else if (shadow.n < policy.min_shadow_samples) {
    reasons.push(
      `L2 统计: shadow 样本不足（n=${shadow.n} < min_shadow_samples=${policy.min_shadow_samples}）——` +
        '记录不阻塞（§7.3 样本不足 → 后验方差大 → 延后/降级，不构成硬拒绝）',
    );
  } else {
    const failureRate = shadow.failures / shadow.n;
    l2Ok = failureRate <= policy.max_shadow_failure_rate;
    reasons.push(
      `L2 统计: shadow 失败率 ${(failureRate * 100).toFixed(1)}%（${shadow.failures}/${shadow.n}）≤ ` +
        `上限 ${(policy.max_shadow_failure_rate * 100).toFixed(1)}%（后验不劣化）` +
        (l2Ok ? '通过' : '——拒绝'),
    );
  }

  // ---- L3 语义层（低频空闲期盲化 judge，P4 后接入）：本次仅占位注释——judge 仅旁证不作硬信号 ----
  reasons.push(
    'L3 语义: judge 旁证接口占位（P4 盲化 judge 接入；judge 仅旁证不作晋升硬信号，§7.1 设计纪律）——不阻塞',
  );

  return { ok: fitOk && costOk && l2Ok && execReject === null, reasons };
}
