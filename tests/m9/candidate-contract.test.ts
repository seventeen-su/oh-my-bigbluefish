// P4（2026-08-25-verification-contract）：候选晋升验证契约门禁 + stable 晋升信任门禁测试
//（kernel/candidate-contract.ts；用户裁决 P4 范围 ①/②/⑤）。
// 覆盖（计划 §P4 交付物）：
//   ① seedCandidateContract 形状：id=`candidate:<id>` / goal=motivation / hard_constraints=G1+G3 /
//      outcome_conditions=G4 / process_conditions=[] / verifier origin='kernel:gates' 独立来源 /
//      trust='L2' + trust_required='L2' / verdict_semantics='all_must_pass' / schema 合法
//   ② buildCandidateEvidence 布尔映射：g1/g3/g4 true→pass false→fail；contract_id/source/ts
//   ③ runCandidateGate：全过 → ok + verdict PASS；G3 失败 → ok=false + verdict FAIL；
//      trust 不足路径（构造低 trust 契约注入）→ ok=false；非循环拒绝路径（draft.id == origin）→ ok=false
//   ④ stablePromotionTrustGate：无 verification → fail-closed（验证标准不能被验证器自己定义）；
//      verdict 非 PASS → 拒绝；trust L1 < L2 → 拒绝；非循环拒绝（对象 id == origin）→ 拒绝；全过 → ok
//   ⑤ 确定性：同输入同输出（deep equal）
import { describe, expect, it } from 'vitest';
import {
  buildCandidateEvidence,
  CANDIDATE_G1_CHECK,
  CANDIDATE_G3_CHECK,
  CANDIDATE_G4_CHECK,
  CANDIDATE_GATES_ORIGIN,
  CANDIDATE_GATES_VERIFIER_ID,
  runCandidateGate,
  seedCandidateContract,
  stablePromotionTrustGate,
} from '../../kernel/candidate-contract.js';
import { decideVerdict, trustGate } from '../../kernel/verification.js';
import {
  VerificationContractSchema,
  type VerificationContract,
} from '../../kernel/schemas/verification.js';

// ---- ① seedCandidateContract 形状 ----

describe('① seedCandidateContract（候选晋升验证契约种子）', () => {
  it('形状：id/goal/hard/outcome/process/verifier/trust_required/verdict_semantics 全部按契约语义', () => {
    const c = seedCandidateContract({ id: 'cand-x', motivation: 'corrections 触发微调' });
    expect(c.id).toBe('candidate:cand-x');
    expect(c.goal).toBe('corrections 触发微调');
    expect(c.hard_constraints).toEqual([CANDIDATE_G1_CHECK, CANDIDATE_G3_CHECK]);
    expect(c.outcome_conditions).toEqual([CANDIDATE_G4_CHECK]);
    expect(c.process_conditions).toEqual([]);
    expect(c.trust_required).toBe('L2');
    expect(c.verdict_semantics).toBe('all_must_pass');
  });

  it('motivation 缺省 → goal 兜底「数据候选晋升验证」', () => {
    expect(seedCandidateContract({ id: 'cand-y' }).goal).toBe('数据候选晋升验证');
  });

  it('verifier：deterministic 权威、trust L2、origin kernel:gates（独立来源——非循环检查通过）、checks=三项检查名', () => {
    const c = seedCandidateContract({ id: 'cand-x' });
    expect(c.verifiers).toHaveLength(1);
    const v = c.verifiers[0]!;
    expect(v.id).toBe(CANDIDATE_GATES_VERIFIER_ID);
    expect(v.kind).toBe('deterministic');
    expect(v.trust).toBe('L2');
    expect(v.origin).toBe(CANDIDATE_GATES_ORIGIN);
    expect(v.checks).toEqual([CANDIDATE_G1_CHECK, CANDIDATE_G3_CHECK, CANDIDATE_G4_CHECK]);
    expect(v.blind_spots[0]).toMatch(/语义/);
  });

  it('schema 合法（VerificationContractSchema 通过——消费方 fail-loud 面）', () => {
    expect(() => VerificationContractSchema.parse(seedCandidateContract({ id: 'cand-x' }))).not.toThrow();
  });
});

// ---- ② buildCandidateEvidence 布尔映射 ----

describe('② buildCandidateEvidence（门布尔 → 权威证据）', () => {
  it('全 true → 三项检查全 pass；contract_id/source 正确；ts 为数值', () => {
    const c = seedCandidateContract({ id: 'cand-x' });
    const ev = buildCandidateEvidence(c, { g1: true, g3: true, g4: true });
    expect(ev.verifier_id).toBe(CANDIDATE_GATES_VERIFIER_ID);
    expect(ev.contract_id).toBe(c.id);
    expect(ev.source).toBe('candidate-pipeline:gates');
    expect(typeof ev.ts).toBe('number');
    expect(ev.checks).toEqual([
      { name: CANDIDATE_G1_CHECK, result: 'pass', detail: expect.any(String) },
      { name: CANDIDATE_G3_CHECK, result: 'pass', detail: expect.any(String) },
      { name: CANDIDATE_G4_CHECK, result: 'pass', detail: expect.any(String) },
    ]);
  });

  it('g3=false → G3 检查 fail（其余 pass）', () => {
    const c = seedCandidateContract({ id: 'cand-x' });
    const ev = buildCandidateEvidence(c, { g1: true, g3: false, g4: true });
    expect(ev.checks.map((x) => x.result)).toEqual(['pass', 'fail', 'pass']);
    expect(ev.checks[1]!.name).toBe(CANDIDATE_G3_CHECK);
  });

  it('g4=false → G4 检查 fail', () => {
    const c = seedCandidateContract({ id: 'cand-x' });
    const ev = buildCandidateEvidence(c, { g1: true, g3: true, g4: false });
    expect(ev.checks[2]!.result).toBe('fail');
  });
});

// ---- ③ runCandidateGate ----

describe('③ runCandidateGate（seed → evidence → decideVerdict + trust + 非循环）', () => {
  it('全过 → ok=true，verdict PASS，reason 含判定/trust/非循环', () => {
    const r = runCandidateGate({ id: 'cand-x', motivation: 'm' }, { g1: true, g3: true, g4: true });
    expect(r.ok).toBe(true);
    expect(r.result.verdict).toBe('PASS');
    expect(r.result.hard_failures).toEqual([]);
    expect(r.reason).toContain('判定 PASS');
    expect(r.reason).toContain('trustGate(L2 >= L2) = 通过');
    expect(r.reason).toContain('非循环检查（origin=kernel:gates vs 候选 cand-x）= 通过');
  });

  it('G3 失败 → ok=false，verdict FAIL（权威证据判 fail——hard 优先）', () => {
    const r = runCandidateGate({ id: 'cand-x' }, { g1: true, g3: false, g4: true });
    expect(r.ok).toBe(false);
    expect(r.result.verdict).toBe('FAIL');
    expect(r.result.hard_failures).toContain(CANDIDATE_G3_CHECK);
  });

  it('trust 不足路径（注入低 trust 契约）→ ok=false（VerifierTrust < required 不能用于晋升）', () => {
    const lowTrust: VerificationContract = {
      ...seedCandidateContract({ id: 'cand-x' }),
      verifiers: [
        {
          id: CANDIDATE_GATES_VERIFIER_ID,
          kind: 'deterministic',
          checks: [CANDIDATE_G1_CHECK, CANDIDATE_G3_CHECK, CANDIDATE_G4_CHECK],
          blind_spots: [],
          trust: 'L1',
          origin: CANDIDATE_GATES_ORIGIN,
        },
      ],
    };
    expect(trustGate('L1', 'L2')).toBe(false); // 前置：trust 语义确认
    const r = runCandidateGate({ id: 'cand-x' }, { g1: true, g3: true, g4: true }, { contract: lowTrust });
    expect(r.ok).toBe(false);
    expect(r.result.verdict).toBe('PASS'); // 判定本身通过——拒绝来自 trust 面
    expect(r.reason).toContain('trustGate(L1 >= L2) = 拒绝');
  });

  it('非循环拒绝路径（draft.id == origin kernel:gates）→ ok=false（循环自证阻断）', () => {
    const r = runCandidateGate({ id: CANDIDATE_GATES_ORIGIN }, { g1: true, g3: true, g4: true });
    expect(r.ok).toBe(false);
    expect(r.result.verdict).toBe('PASS'); // 判定本身通过——拒绝来自非循环面
    expect(r.reason).toContain('非循环检查（origin=kernel:gates vs 候选 kernel:gates）= 拒绝');
  });

  it('确定性：同输入两次 → reason 一致（ts 由调用方注入面，判定/trust/非循环三段稳定）', () => {
    const a = runCandidateGate({ id: 'cand-x' }, { g1: true, g3: true, g4: true });
    const b = runCandidateGate({ id: 'cand-x' }, { g1: true, g3: true, g4: true });
    expect(b.reason).toBe(a.reason);
    expect(b.ok).toBe(a.ok);
  });
});

// ---- ④ stablePromotionTrustGate ----

describe('④ stablePromotionTrustGate（stable 晋升信任门禁——fail-closed）', () => {
  it('无 verification → ok=false（fail-closed：「对象无验证记录——拒绝晋升（验证标准不能被验证器自己定义）」）', () => {
    const r = stablePromotionTrustGate({ id: 'sha256:obj' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('对象无验证记录');
    expect(r.reason).toContain('验证标准不能被验证器自己定义');
  });

  it('verdict 非 PASS（FAIL/UNKNOWN/缺失）→ ok=false', () => {
    for (const verdict of ['FAIL', 'UNKNOWN', undefined] as const) {
      const r = stablePromotionTrustGate({
        id: 'sha256:obj',
        verification: { verdict, verifier_trust: 'L2' },
      });
      expect(r.ok, String(verdict)).toBe(false);
      expect(r.reason, String(verdict)).toContain('验证判定非 PASS');
    }
  });

  it('trust L1 < required L2 → ok=false（VerifierTrust < required 不能用于 stable 晋升）', () => {
    const r = stablePromotionTrustGate({
      id: 'sha256:obj',
      verification: { verdict: 'PASS', verifier_trust: 'L1' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('VerifierTrust L1 < required L2');
  });

  it('verifier_trust 缺失 → 按 L0 处理 → ok=false', () => {
    const r = stablePromotionTrustGate({ id: 'sha256:obj', verification: { verdict: 'PASS' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('VerifierTrust L0 < required L2');
  });

  it('非循环拒绝：对象 id == origin（缺省 kernel:gates）→ ok=false', () => {
    const r = stablePromotionTrustGate({
      id: CANDIDATE_GATES_ORIGIN,
      verification: { verdict: 'PASS', verifier_trust: 'L2' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('循环自证拒绝');
  });

  it('全过（verdict PASS + trust L2 + 独立来源）→ ok=true，reason 可审计', () => {
    const r = stablePromotionTrustGate({
      id: 'sha256:obj',
      verification: { verdict: 'PASS', verifier_trust: 'L2' },
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('验证契约信任门禁通过');
    expect(r.reason).toContain('verdict=PASS');
    expect(r.reason).toContain('kernel:gates 独立于对象');
  });

  it('opts.origin 显式传入 → 非循环检查按该来源判定（独立 → ok）', () => {
    const r = stablePromotionTrustGate(
      { id: 'sha256:obj', verification: { verdict: 'PASS', verifier_trust: 'L4' } },
      { origin: 'verifier-registry:official' },
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('verifier-registry:official 独立于对象');
  });
});

// ---- ⑤ 全链集成（runCandidateGate ↔ decideVerdict 同一套契约语义） ----

describe('⑤ 全链一致性（门禁 ok ⇔ decideVerdict 判定 + trust + 非循环同时成立）', () => {
  it('runCandidateGate 的 ok 与独立组合判定结果一致（防组合漂移）', () => {
    const draft = { id: 'cand-x' };
    const gates = { g1: true, g3: true, g4: true };
    const c = seedCandidateContract(draft);
    const ev = buildCandidateEvidence(c, gates);
    const verdict = decideVerdict(c, [ev]).verdict;
    const trust = trustGate(c.verifiers[0]!.trust, c.trust_required);
    const r = runCandidateGate(draft, gates);
    expect(r.ok).toBe(verdict === 'PASS' && trust);
    expect(r.ok).toBe(true);
  });
});
