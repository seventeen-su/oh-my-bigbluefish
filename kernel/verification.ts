// layer 2（kernel/）：统一验证基础设施 P1 核心纯函数（计划 .omb/plans/2026-08-25-verification-contract.md）。
// 零 I/O、零副作用、零随机、零墙钟：同输入 → 同输出（测试锚定）。
// 依赖：仅契约层 kernel/schemas/verification.ts（类型 + 枚举）——层 DAG 合规
//（kernel 不 import supervisor/runtime 任何东西；消费端接线 P2-P4 由上层经契约例外消费）。
//
// 语义（用户裁决 2026-08-25）：
//   decideVerdict：权威证据（deterministic/external）与补充证据（structured_llm/human_multi）分层合并——
//     · 任一应查检查（hard_constraints ∪ outcome_conditions）被权威证据判 fail → FAIL（hard 优先，LLM 不能覆盖硬约束）；
//     · 全部应查检查有权威 pass（或权威无 fail 且补充证据 pass 覆盖）→ PASS；
//     · 其余（存在 unknown、或检查仅被补充证据判 fail——LLM 不能定 FAIL）→ UNKNOWN（证据不足不强行裁决）；
//     · evidence_quality = 有结果（pass/fail 而非 unknown）的应查检查数 / 全部应查检查数（0~1 保留两位）；
//     · process_quality / controllability 不在此计算（调用方注入——结果与过程质量分离）。
//   trustGate：TRUST_LEVELS 序号 >= required 序号 → 放行（含 equal）；trust < required 不能用于 stable 晋升（P4 消费）。
//   nonCircularityCheck：Verifier 来源若等于候选自身 → 拒绝（防循环自证：AI 生成 Candidate → AI 生成 Verifier →
//     Verifier 通过 Candidate 的循环链被阻断）。
import type {
  TrustLevel,
  Verdict,
  Verifier,
  VerificationContract,
  VerificationEvidence,
  VerificationResult,
} from './schemas/verification.js';

/** 权威验证器种类（验证阶梯一级/二级：确定性验证、外部工具验证） */
export const AUTHORITY_VERIFIER_KINDS = ['deterministic', 'external'] as const;

/** 补充验证器种类（验证阶梯三级/四级：结构化语义 LLM judge、人工/多模型裁判——不能独立定 FAIL） */
export const SUPPLEMENTARY_VERIFIER_KINDS = ['structured_llm', 'human_multi'] as const;

/** TRUST_LEVELS 序号（L0=0 … L4=4；trustGate 门槛比较用；Record 穷举防枚举漂移） */
const TRUST_ORDER: Record<TrustLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

/**
 * 可信等级门槛：verifierTrust 序号 >= required 序号 → true（含 equal）。
 * 理论不可达的未穷举输入 → false（fail-safe，不静默放行）。
 */
export function trustGate(verifierTrust: TrustLevel, required: TrustLevel): boolean {
  const got = TRUST_ORDER[verifierTrust];
  const need = TRUST_ORDER[required];
  if (got === undefined || need === undefined) {
    return false; // 枚举已穷尽，理论不可达——fail-safe
  }
  return got >= need;
}

/** 非循环检查判定结果（ok=false = 循环自证拒绝） */
export interface NonCircularityVerdict {
  ok: boolean;
  reason: string;
}

/**
 * 防循环自证检查（裁决要点⑤）：verifier.origin === undefined → ok（外部/独立来源）；
 * origin === candidateId（字符串精确比较）→ 拒绝；其余独立来源 → ok。
 */
export function nonCircularityCheck(
  verifier: Pick<Verifier, 'origin'>,
  candidateId: string,
): NonCircularityVerdict {
  const origin = verifier.origin;
  if (origin === undefined) {
    return { ok: true, reason: 'verifier 未声明来源（外部/独立来源）——非循环检查通过' };
  }
  if (origin === candidateId) {
    return { ok: false, reason: `循环自证拒绝：verifier.origin（${origin}）等于候选自身（${candidateId}）` };
  }
  return { ok: true, reason: `verifier 来源（${origin}）独立于候选（${candidateId}）——非循环检查通过` };
}

/**
 * 合并单个验证器桶对某检查名的聚合结果（fail > pass > unknown > none）：
 * 任一 fail 即 fail（桶内同检查多条目时，最坏结果优先——权威桶内任一 fail 触发 FAIL）。
 */
type Aggregated = 'pass' | 'fail' | 'unknown' | 'none';
function aggregateCheck(bucket: VerificationEvidence[], name: string): Aggregated {
  let result: Aggregated = 'none';
  for (const ev of bucket) {
    for (const c of ev.checks) {
      if (c.name !== name) {
        continue;
      }
      if (c.result === 'fail') {
        return 'fail';
      }
      if (c.result === 'pass' && result === 'none') {
        result = 'pass';
      }
      if (c.result === 'unknown' && result === 'none') {
        result = 'unknown';
      }
    }
  }
  return result;
}

/**
 * 验证契约判定（确定性纯函数；输入须已过 schema——调用方负责 parse）：
 *   ① 应查检查 = hard_constraints ∪ outcome_conditions（去重保序；process_conditions 不参与判定——
 *      P2 起由 process_quality 注入面覆盖）；
 *   ② 证据按 verifier_id → 契约内 kind 归类：deterministic/external = 权威，structured_llm/human_multi = 补充；
 *      contract_id 不匹配或未在契约声明的 verifier 证据 → 忽略（契约隔离）；
 *   ③ 任一应查检查被权威证据判 fail → FAIL（hard_failures 记录，含 outcome 检查——裁决要点①）；
 *      全部应查检查有权威 pass（或权威无 fail 且补充证据 pass 覆盖）→ PASS；
 *      其余（权威 unknown / 仅补充证据 fail / 无证据）→ UNKNOWN（unknown_checks 记录；LLM 不能定 FAIL）；
 *   ④ evidence_quality = 有结果（pass/fail）的应查检查数 / 全部应查检查数（0~1 保留两位）；
 *   ⑤ process_quality / controllability 不在本函数计算（保留调用方注入——纯函数只合并 evidence 判定）。
 */
export function decideVerdict(
  contract: VerificationContract,
  evidenceList: VerificationEvidence[],
): VerificationResult {
  // ① 应查检查（hard ∪ outcome，去重保序）
  const expected: string[] = [];
  const seen = new Set<string>();
  for (const name of [...contract.hard_constraints, ...contract.outcome_conditions]) {
    if (!seen.has(name)) {
      seen.add(name);
      expected.push(name);
    }
  }

  // ② 证据分层（契约隔离：contract_id 匹配 + verifier_id 在契约内声明）
  const kindById = new Map(contract.verifiers.map((v) => [v.id, v.kind]));
  const authority: VerificationEvidence[] = [];
  const supplementary: VerificationEvidence[] = [];
  const authoritySources: string[] = [];
  const supplementarySources: string[] = [];
  const matched: VerificationEvidence[] = [];
  for (const ev of evidenceList) {
    if (ev.contract_id !== contract.id) {
      continue;
    }
    const kind = kindById.get(ev.verifier_id);
    if (kind === undefined) {
      continue; // 未声明 verifier → 忽略（契约隔离）
    }
    matched.push(ev);
    const sources = kind === 'deterministic' || kind === 'external' ? authority : supplementary;
    const sourceList =
      kind === 'deterministic' || kind === 'external' ? authoritySources : supplementarySources;
    sources.push(ev);
    if (!sourceList.includes(ev.verifier_id)) {
      sourceList.push(ev.verifier_id);
    }
  }

  // ③ 逐应查检查合并判定
  const hardFailures: string[] = [];
  const unknownChecks: string[] = [];
  const llmFailedHard: string[] = []; // hard 检查仅被补充证据判 fail（LLM 不能定 FAIL）——reason 审计用
  let resolvedCount = 0;
  for (const name of expected) {
    const a = aggregateCheck(authority, name);
    const s = aggregateCheck(supplementary, name);
    if (a === 'fail') {
      hardFailures.push(name);
      resolvedCount += 1; // fail 也是有结果（evidence_quality 计入）
    } else if (a === 'pass') {
      resolvedCount += 1;
    } else if (a === 'unknown') {
      unknownChecks.push(name); // 权威证据不明确 → UNKNOWN（不强行裁决）
    } else if (s === 'pass') {
      resolvedCount += 1; // 权威无覆盖 → 补充证据 pass 兜底（语义补充验证器补缺）
    } else {
      // 权威无覆盖且补充证据非 pass（fail/unknown/无证据）→ 证据不足（LLM 不能定 FAIL）
      unknownChecks.push(name);
      if (s === 'fail' && contract.hard_constraints.includes(name)) {
        llmFailedHard.push(name);
      }
    }
  }

  const verdict: Verdict = hardFailures.length > 0 ? 'FAIL' : unknownChecks.length > 0 ? 'UNKNOWN' : 'PASS';

  // ④ evidence_quality（0~1 保留两位；应查检查恒 ≥1——hard_constraints.min(1)，除零防御仍保留）
  const total = expected.length === 0 ? 1 : expected.length;
  const evidenceQuality = Math.round((resolvedCount / total) * 100) / 100;

  const reason =
    `decideVerdict(${contract.id})：应查 ${expected.length} 项（hard ${contract.hard_constraints.length} + ` +
    `outcome ${contract.outcome_conditions.length}）；权威证据来源：${authoritySources.join('、') || '无'}；` +
    `补充证据来源：${supplementarySources.join('、') || '无'}；权威判 fail：${hardFailures.join('、') || '无'}；` +
    `unknown 检查：${unknownChecks.join('、') || '无'}；` +
    `hard 仅补充证据判 fail（LLM 不能定 FAIL）：${llmFailedHard.join('、') || '无'}；判定 ${verdict}`;

  return {
    contract_id: contract.id,
    verdict,
    hard_failures: hardFailures,
    unknown_checks: unknownChecks,
    evidence_quality: evidenceQuality,
    reason,
    evidence: matched,
  };
}
