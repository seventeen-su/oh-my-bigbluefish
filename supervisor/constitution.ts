// OMB v2 宪法内核（架构 §14.1/§14.2）：状态转换不变量可执行检查（证据门① + 降级门②），直接作用于 Semantic IR 事件流。
// layer 1（supervisor/）：纯函数/纯数据，无 IO、无副作用；仅结构类型（不 import state-reducer，避免环）。
// M8b 协调方案（供主会话确认）：§14.1 证据态原语（inferred/observed/verified）与 §5.2 三值裁决态
//   （supported/contradicted/unresolved）分层协调——evidence_status = 证据态（claim 如何被知晓），
//   epistemic = 裁决态（Governor 对矛盾的裁决结果）；本模块只约束证据态转换，裁决态由 claim/update 与
//   hypothesis/transition 驱动。§14.1 示例 "Claim=inferred 且 Evidence=absent → 不得转 verified" 落为证据门①。

/** §14.1 证据态（evidence plane 原语全集：inferred/observed/verified） */
export type EvidenceStatus = 'inferred' | 'observed' | 'verified';
export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = ['inferred', 'observed', 'verified'];

/** fail-loud 错误前缀（宪法 = 允许的状态转换约束，§14.1） */
export const CONSTITUTION_VIOLATION = '宪法不变量违规';

/** 宪法①（§14.1）：Claim 转 verified 需要证据在场——Evidence 引用非空或对应 observation 事件在场；否则 fail-loud */
export function assertVerifiedEvidence(claimId: string, evidence: unknown, observedClaims: ReadonlySet<string>): void {
  const refs = Array.isArray(evidence) ? evidence.filter((x): x is string => typeof x === 'string') : [];
  if (refs.length > 0 || observedClaims.has(claimId)) {
    return;
  }
  throw new Error(
    `${CONSTITUTION_VIOLATION}: Claim=${claimId} evidence absent → 不得转 verified（需要 Evidence 引用或对应 observation 事件在场）`,
  );
}

/** 宪法②目标状态校验：Observation=contradictory 只允许 active→discriminated/rejected；其余 fail-loud */
export function assertContradictoryDowngrade(status: unknown): asserts status is 'discriminated' | 'rejected' {
  if (status === 'discriminated' || status === 'rejected') {
    return;
  }
  throw new Error(
    `${CONSTITUTION_VIOLATION}: Observation=contradictory → 活动假设必须降级（active→discriminated/rejected），实际 status: ${String(status)}`,
  );
}

/** 归约器内部视图的最小结构面（结构兼容即用，避免环 import） */
export interface ConstitutionalHypothesis {
  claim_id: string;
  status: string;
}

/** 宪法②应用（§14.1：Intervention=executed 且 Observation=contradictory → 活动假设必须降级）：
 *  校验假设存在/属于该 claim/处于 active，且目标 status 为降级；应用 active→discriminated|rejected 并移出活动集 */
export function applyContradictoryObservation(
  hypotheses: Map<string, ConstitutionalHypothesis>,
  actives: string[],
  claimId: string,
  hypothesisId: string,
  status: unknown,
): void {
  const hyp = hypotheses.get(hypothesisId);
  if (!hyp) {
    throw new Error(`${CONSTITUTION_VIOLATION}: observation/contradictory 引用未知假设 ${hypothesisId}（缺事件）`);
  }
  if (hyp.claim_id !== claimId) {
    throw new Error(`${CONSTITUTION_VIOLATION}: 假设 ${hypothesisId} 不属于 claim ${claimId}`);
  }
  if (hyp.status !== 'active') {
    throw new Error(
      `${CONSTITUTION_VIOLATION}: 假设 ${hypothesisId} 必须处于 active（实际: ${hyp.status}）——Observation=contradictory 仅降级活动假设`,
    );
  }
  assertContradictoryDowngrade(status);
  hyp.status = status;
  const i = actives.indexOf(hypothesisId);
  if (i >= 0) {
    actives.splice(i, 1);
  }
}

/** observation/contradictory 事件 payload 提取（observation_id/claim_id/hypothesis_id 非空校验，缺则 fail-loud） */
export function parseObservationPayload(p: Record<string, unknown>): {
  observationId: string;
  claimId: string;
  hypothesisId: string;
} {
  const observationId = typeof p.observation_id === 'string' && p.observation_id.length > 0 ? p.observation_id : '';
  const claimId = typeof p.claim_id === 'string' && p.claim_id.length > 0 ? p.claim_id : '';
  const hypothesisId = typeof p.hypothesis_id === 'string' && p.hypothesis_id.length > 0 ? p.hypothesis_id : '';
  if (!observationId || !claimId || !hypothesisId) {
    throw new Error('reduce: observation/contradictory 缺少 observation_id/claim_id/hypothesis_id');
  }
  return { observationId, claimId, hypothesisId };
}
