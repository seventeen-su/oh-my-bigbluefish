// layer 2（kernel/）：P4 Evolution 收敛——候选晋升验证契约门禁 + stable 晋升信任门禁
//（计划 .omb/plans/2026-08-25-verification-contract.md；用户裁决 P4 范围 ①/②/⑤）。零 I/O、零副作用、
// 零随机（buildCandidateEvidence 的 ts 由调用方按既有约定注入 Date.now()——与 P2/P3 契约种子同款）。
// 依赖：仅契约层 kernel/schemas/verification.ts（类型）+ kernel/verification.ts（纯函数）——层 DAG 合规
//（kernel 不 import supervisor/runtime 任何东西；消费端接线由 runtime/assembly.ts 经 deps 注入回调完成，
//  supervisor 层 1 只持有回调类型引用——见 supervisor/candidate-pipeline.ts / supervisor/promotion.ts）。
//
// 语义（用户裁决 P4 范围）：
//   seedCandidateContract：候选晋升验证契约种子——hard_constraints（不可被 LLM judge 覆盖）= G1 结构校验
//     通过 + G3 验证判定通过；outcome_conditions = G4 门禁通过（基准对照不降）；verifiers 恒声明一枚
//     deterministic 权威验证器（trust L2 = 基准验证，origin 'kernel:gates' 独立来源——非循环检查通过，
//     裁决 ② 防循环自证：Verifier 来源 ≠ 候选自身）；trust_required='L2'（裁决 ①：trust < required 不能
//     用于晋升）；verdict_semantics='all_must_pass'。
//   buildCandidateEvidence：G1/G3/G4 门布尔结果 → 权威证据（source='candidate-pipeline:gates'）。
//   runCandidateGate：seed → evidence → decideVerdict + trustGate + nonCircularityCheck 合并判定
//     （ok = verdict==='PASS' && trust && 非循环；reason 中文可审计）。
//   stablePromotionTrustGate：stable 晋升信任门禁（裁决 ①/②/⑤ fail-closed）——对象无验证记录 /
//     判定非 PASS / VerifierTrust < required L2 / 非循环检查失败 → 拒绝晋升；全部通过 → ok。
//     宪法级原则（P4 文档化注记）：验证标准不能被验证器自己定义——验证器可演化，但验证标准必须是
//     独立审计对象（fail-closed 缺省拒绝 = 无验证记录对象不得晋升）。
import { decideVerdict, nonCircularityCheck, trustGate } from './verification.js';
import type {
  TrustLevel,
  VerificationContract,
  VerificationEvidence,
  VerificationResult,
} from './schemas/verification.js';

// ---- 检查名常量（契约种子与证据构造共用——防漂移；对应 §6.5.3 验证链 G1/G3/G4） ----

/** hard 约束 1：G1 结构校验（YAML/policy schema/值域） */
export const CANDIDATE_G1_CHECK = 'G1 结构校验通过（YAML/policy schema/值域）';

/** hard 约束 2：G3 验证判定（冻结基准回放 fitness + 执行型验证） */
export const CANDIDATE_G3_CHECK = 'G3 验证判定通过（verdict.ok）';

/** outcome 条件：G4 门禁（基准对照不降 + shadow 标记） */
export const CANDIDATE_G4_CHECK = 'G4 门禁通过（基准对照不降）';

/** 候选门禁验证器 id（deterministic 权威一级） */
export const CANDIDATE_GATES_VERIFIER_ID = 'candidate:gates:deterministic';

/** 候选门禁验证器来源（独立来源——非循环检查通过；裁决 ② 内核门禁验证器 origin='kernel:gates'） */
export const CANDIDATE_GATES_ORIGIN = 'kernel:gates';

/** 候选晋升所需验证器可信等级（L2 = 基准验证——默认晋升门槛，裁决 ①） */
export const CANDIDATE_TRUST_REQUIRED: TrustLevel = 'L2';

/**
 * 候选晋升验证契约种子（确定性纯函数）：
 * id=`candidate:${draft.id}`；goal=motivation（缺省 '数据候选晋升验证'）；
 * hard_constraints=G1+G3（不可被 LLM judge 覆盖）；outcome_conditions=G4；process_conditions=[]（诚实空）；
 * verifiers=单枚 deterministic 权威验证器（trust L2，origin 'kernel:gates' 独立来源——非循环检查通过；
 * checks=三项检查名；blind_spots 声明语义盲区：候选动机合理性需语义验证器）；
 * trust_required='L2'；verdict_semantics='all_must_pass'。
 */
export function seedCandidateContract(draft: { id: string; motivation?: string }): VerificationContract {
  return {
    id: `candidate:${draft.id}`,
    goal: draft.motivation ?? '数据候选晋升验证',
    hard_constraints: [CANDIDATE_G1_CHECK, CANDIDATE_G3_CHECK],
    outcome_conditions: [CANDIDATE_G4_CHECK],
    process_conditions: [],
    verifiers: [
      {
        id: CANDIDATE_GATES_VERIFIER_ID,
        kind: 'deterministic',
        checks: [CANDIDATE_G1_CHECK, CANDIDATE_G3_CHECK, CANDIDATE_G4_CHECK],
        blind_spots: ['语义面（候选动机合理性）需语义验证器'],
        trust: 'L2',
        origin: CANDIDATE_GATES_ORIGIN,
      },
    ],
    trust_required: CANDIDATE_TRUST_REQUIRED,
    verdict_semantics: 'all_must_pass',
  };
}

/**
 * 候选门禁证据构造（确定性纯函数；ts 由调用方注入——与 P2/P3 契约种子同款约定）：
 * verifier_id='candidate:gates:deterministic'，source='candidate-pipeline:gates'；
 * G1/G3/G4 三项检查按布尔转 pass/fail（detail 可审计）。
 */
export function buildCandidateEvidence(
  contract: VerificationContract,
  gates: { g1: boolean; g3: boolean; g4: boolean },
): VerificationEvidence {
  return {
    verifier_id: CANDIDATE_GATES_VERIFIER_ID,
    contract_id: contract.id,
    checks: [
      {
        name: CANDIDATE_G1_CHECK,
        result: gates.g1 ? 'pass' : 'fail',
        detail: gates.g1 ? 'G1 结构校验通过' : 'G1 结构校验失败',
      },
      {
        name: CANDIDATE_G3_CHECK,
        result: gates.g3 ? 'pass' : 'fail',
        detail: gates.g3 ? 'G3 验证判定通过（verdict.ok）' : 'G3 验证判定失败',
      },
      {
        name: CANDIDATE_G4_CHECK,
        result: gates.g4 ? 'pass' : 'fail',
        detail: gates.g4 ? 'G4 门禁通过（基准对照不降）' : 'G4 门禁失败（基准对照下降）',
      },
    ],
    ts: Date.now(),
    source: 'candidate-pipeline:gates',
  };
}

/**
 * 候选验证契约门禁（确定性纯函数；opts.contract 测试注入面——缺省 seedCandidateContract）：
 * seed → evidence → decideVerdict（权威证据分层判定）→ trustGate（L2 >= L2）→
 * nonCircularityCheck（origin 'kernel:gates' 独立来源 vs draft.id）。
 * ok = verdict==='PASS' && trust && 非循环；reason 中文可审计（含 verdict/trust/非循环结果）。
 */
export function runCandidateGate(
  draft: { id: string; motivation?: string },
  gates: { g1: boolean; g3: boolean; g4: boolean },
  opts: { contract?: VerificationContract } = {},
): { ok: boolean; result: VerificationResult; reason: string } {
  const contract = opts.contract ?? seedCandidateContract(draft);
  const evidence = buildCandidateEvidence(contract, gates);
  const result = decideVerdict(contract, [evidence]);
  const verifier = contract.verifiers[0]!;
  const trust = trustGate(verifier.trust, contract.trust_required);
  const nc = nonCircularityCheck(verifier, draft.id);
  const ok = result.verdict === 'PASS' && trust && nc.ok;
  const reason =
    `候选验证契约门禁（${contract.id}）：判定 ${result.verdict}；` +
    `trustGate(${verifier.trust} >= ${contract.trust_required}) = ${trust ? '通过' : '拒绝'}；` +
    `非循环检查（origin=${verifier.origin ?? '未声明'} vs 候选 ${draft.id}）= ${nc.ok ? '通过' : '拒绝'}` +
    (ok ? '——门禁通过' : '——门禁拒绝');
  return { ok, result, reason };
}

// ---- P4 ③：stable 晋升信任门禁（裁决 ① VerifierTrust < required 不能用于 stable 晋升；② 防循环自证；⑤ 验证标准不能被验证器自己定义） ----

/**
 * stable 晋升信任门禁（确定性纯函数；fail-closed）：
 *   ① object.verification 缺失 → ok=false（「对象无验证记录——拒绝晋升（验证标准不能被验证器自己定义）」）；
 *   ② verification.verdict !== 'PASS' → ok=false；
 *   ③ trustGate(verifier_trust ?? 'L0', 'L2') 失败 → ok=false（「VerifierTrust < required 不能用于 stable 晋升」）；
 *   ④ nonCircularityCheck（verifier origin 由调用方传入（opts.origin）或按 'kernel:gates' 缺省）→ 失败 → ok=false；
 *   ⑤ 全部通过 → ok=true；reason 中文可审计。
 * 注：对象字段按最小视图声明（verification 未知载荷 → 内部窄化），与 supervisor/promotion.ts 注入面解耦。
 */
export function stablePromotionTrustGate(
  object: { id: string; verification?: { verdict?: string; verifier_trust?: string } },
  opts: { origin?: string } = {},
): { ok: boolean; reason: string } {
  const verification = object.verification;
  if (verification === undefined) {
    return {
      ok: false,
      reason: `对象无验证记录——拒绝晋升（验证标准不能被验证器自己定义）：${object.id}`,
    };
  }
  if (verification.verdict !== 'PASS') {
    return {
      ok: false,
      reason: `验证判定非 PASS（${verification.verdict ?? '无判定'}）——拒绝晋升：${object.id}`,
    };
  }
  const trust: TrustLevel = (verification.verifier_trust ?? 'L0') as TrustLevel;
  if (!trustGate(trust, CANDIDATE_TRUST_REQUIRED)) {
    return {
      ok: false,
      reason: `VerifierTrust ${verification.verifier_trust ?? 'L0'} < required ${CANDIDATE_TRUST_REQUIRED} 不能用于 stable 晋升：${object.id}`,
    };
  }
  const origin = opts.origin ?? CANDIDATE_GATES_ORIGIN;
  const nc = nonCircularityCheck({ origin }, object.id);
  if (!nc.ok) {
    return { ok: false, reason: `${nc.reason}——拒绝晋升：${object.id}` };
  }
  return {
    ok: true,
    reason: `验证契约信任门禁通过（verdict=PASS，trust=${trust}≥${CANDIDATE_TRUST_REQUIRED}，来源 ${origin} 独立于对象）：${object.id}`,
  };
}
