// P2（2026-08-25-verification-contract）：Shadow 真实判定测试——验证契约种子/证据构造/三态判定映射
// + L2 三元消费（计划 §P2 交付物；用户裁决 P2 范围）。
// 覆盖：
//   ① seedShadowContract：id=`shadow:<sessionId>` / goal / 默认硬约束 / outcome（success_criteria 并入 +
//      decision-made 兜底）/ process_conditions 诚实空 / verifiers 两枚恒声明（deterministic L1 + structured_llm L2）/
//      trust_required='L1' / verdict_semantics='all_must_pass' / schema 合法（非空 criteria）
//   ② buildShadowEvidence：degraded→fail、decision_made=false→fail、judgeChecks 非空 → 补充证据透传、
//      空 judgeChecks → 不产出补充证据
//   ③ 全链判定映射（seed → build → decideVerdict → shadowOutcomeFromResult）：
//      degraded → FAIL → 'degraded'；无 degraded + 无 criteria + decision made → PASS → 'success'；
//      有 criteria + 无 judge 证据 → UNKNOWN → 'unknown'（诚实不强行裁决）；注入 judgeChecks 全 pass → PASS →
//      'success'（补充证据补缺）；judge 判 criteria fail 但权威无覆盖 → UNKNOWN（LLM 不能定 FAIL）→ 'unknown'
//   ④ readShadowSignals 三元：unknown 独立档（不计 failures、不污染失败率评分）；新旧格式混合；pending 仅计 n；
//      decision 格式原计数语义；缺目录 → 空三元；确定性（同输入同输出）
//   ⑤ 确定性：seedShadowContract/shadowOutcomeFromResult 同输入同输出；buildShadowEvidence 结构同（ts 注入面除外）；
//      decideVerdict 同证据两次 → deep equal + JSON 字节一致
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideVerdict } from '../../kernel/verification.js';
import { VerificationContractSchema, type VerificationContract, type VerificationEvidence } from '../../kernel/schemas/verification.js';
import {
  buildShadowEvidence,
  seedShadowContract,
  shadowOutcomeFromResult,
  SHADOW_DECISION_CONDITION,
  SHADOW_HARD_CONSTRAINT,
  SHADOW_JUDGE_VERIFIER_ID,
  SHADOW_PROXY_VERIFIER_ID,
  type ShadowEvidenceSignals,
} from '../../kernel/shadow-contract.js';
import { readShadowSignals } from '../../supervisor/promotion.js';

// ---- 测试工具（确定性 fixture） ----

const SESSION = 'sess-shadow-p2';
const GOAL = '验证 Shadow 真实判定';
const CRITERIA = ['判别实验可复现', '结论与证据一致'];

/** 缺省任务契约（goal + 两 criteria） */
function task(over: Partial<{ goal: string; success_criteria: string[] }> = {}): { goal: string; success_criteria: string[] } {
  return { goal: GOAL, success_criteria: CRITERIA, ...over };
}

/** 全链判定：契约种子 → 证据 → decideVerdict → outcome（被测映射面） */
function runChain(
  sessionId: string,
  task_: { goal: string; success_criteria: string[] },
  signals: ShadowEvidenceSignals,
): {
  contract: VerificationContract;
  evidence: VerificationEvidence[];
  result: ReturnType<typeof decideVerdict>;
  outcome: 'success' | 'degraded' | 'unknown';
} {
  const contract = seedShadowContract(sessionId, task_);
  const evidence = buildShadowEvidence(contract, signals);
  const result = decideVerdict(contract, evidence);
  return { contract, evidence, result, outcome: shadowOutcomeFromResult(result) };
}

describe('① seedShadowContract（Shadow 契约种子）', () => {
  it('id/goal/硬约束/结果条件（success_criteria 并入 + decision-made 兜底）/process 诚实空/trust_required/语义', () => {
    const c = seedShadowContract(SESSION, task());
    expect(c.id).toBe(`shadow:${SESSION}`);
    expect(c.goal).toBe(GOAL);
    expect(c.hard_constraints).toEqual([SHADOW_HARD_CONSTRAINT]); // 默认硬约束（不可被 LLM judge 覆盖）
    expect(c.outcome_conditions).toEqual([SHADOW_DECISION_CONDITION, ...CRITERIA]); // 兜底 + success_criteria 并入
    expect(c.process_conditions).toEqual([]); // 通用会话无默认过程约束——诚实空
    expect(c.trust_required).toBe('L1');
    expect(c.verdict_semantics).toBe('all_must_pass');
  });

  it('verifiers 两枚恒声明：deterministic L1（权威代理）+ structured_llm L2（语义 judge，执行由调用方注入）', () => {
    const c = seedShadowContract(SESSION, task());
    expect(c.verifiers).toHaveLength(2);
    const proxy = c.verifiers[0]!;
    expect(proxy.id).toBe(SHADOW_PROXY_VERIFIER_ID);
    expect(proxy.kind).toBe('deterministic');
    expect(proxy.trust).toBe('L1');
    expect(proxy.checks).toEqual([SHADOW_HARD_CONSTRAINT, SHADOW_DECISION_CONDITION]);
    expect(proxy.blind_spots).toEqual(['任务语义成功（success_criteria 达成）——需语义验证器']);
    expect(proxy.origin).toBeUndefined(); // 外部/独立来源（非循环检查面）
    const judge = c.verifiers[1]!;
    expect(judge.id).toBe(SHADOW_JUDGE_VERIFIER_ID);
    expect(judge.kind).toBe('structured_llm');
    expect(judge.trust).toBe('L2');
    expect(judge.checks).toEqual(CRITERIA); // 恒声明——展示完整验证阶梯
    expect(judge.blind_spots).toEqual(['确定性/外部可验证面']);
    expect(judge.origin).toBeUndefined();
  });

  it('schema 合法（非空 criteria；确定性同输入同输出）', () => {
    const c = seedShadowContract(SESSION, task());
    expect(VerificationContractSchema.safeParse(c).success).toBe(true);
    expect(seedShadowContract(SESSION, task())).toEqual(seedShadowContract(SESSION, task()));
  });
});

describe('② buildShadowEvidence（确定性一级 + judge 注入面）', () => {
  it('正常（无降级 + 决策已产生）→ 仅确定性证据，双检查 pass（source=finalizeTurn:proxy）', () => {
    const contract = seedShadowContract(SESSION, task());
    const evs = buildShadowEvidence(contract, { degraded: false, decision_made: true });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.verifier_id).toBe(SHADOW_PROXY_VERIFIER_ID);
    expect(evs[0]!.contract_id).toBe(contract.id); // 契约隔离键
    expect(evs[0]!.source).toBe('finalizeTurn:proxy');
    expect(evs[0]!.checks.map((c) => [c.name, c.result])).toEqual([
      [SHADOW_HARD_CONSTRAINT, 'pass'],
      [SHADOW_DECISION_CONDITION, 'pass'],
    ]);
  });

  it('degraded → 硬约束 fail；decision_made=false → 决策条件 fail', () => {
    const contract = seedShadowContract(SESSION, task());
    const degraded = buildShadowEvidence(contract, { degraded: true, decision_made: true });
    expect(degraded[0]!.checks[0]!.result).toBe('fail');
    expect(degraded[0]!.checks[1]!.result).toBe('pass');
    const noDecision = buildShadowEvidence(contract, { degraded: false, decision_made: false });
    expect(noDecision[0]!.checks[0]!.result).toBe('pass');
    expect(noDecision[0]!.checks[1]!.result).toBe('fail');
  });

  it('judgeChecks 非空 → 补充证据透传（source=finalizeTurn:judge）；空 → 不产出', () => {
    const contract = seedShadowContract(SESSION, task());
    const withJudge = buildShadowEvidence(contract, {
      degraded: false,
      decision_made: true,
      judgeChecks: [
        { name: CRITERIA[0]!, result: 'pass', detail: '复现日志一致' },
        { name: CRITERIA[1]!, result: 'unknown' },
      ],
    });
    expect(withJudge).toHaveLength(2);
    const judgeEv = withJudge[1]!;
    expect(judgeEv.verifier_id).toBe(SHADOW_JUDGE_VERIFIER_ID);
    expect(judgeEv.contract_id).toBe(contract.id);
    expect(judgeEv.source).toBe('finalizeTurn:judge');
    expect(judgeEv.checks).toEqual([
      { name: CRITERIA[0], result: 'pass', detail: '复现日志一致' },
      { name: CRITERIA[1], result: 'unknown', detail: undefined },
    ]);
    const emptyJudge = buildShadowEvidence(contract, { degraded: false, decision_made: true, judgeChecks: [] });
    expect(emptyJudge).toHaveLength(1); // 空 judgeChecks → 不产出补充证据
  });
});

describe('③ 全链判定映射（seed → build → decideVerdict → shadowOutcomeFromResult）', () => {
  it('degraded → FAIL → degraded（硬约束 fail；兼容既有消费面语义）', () => {
    const { result, outcome } = runChain(SESSION, task(), { degraded: true, decision_made: true });
    expect(result.verdict).toBe('FAIL');
    expect(result.hard_failures).toEqual([SHADOW_HARD_CONSTRAINT]);
    expect(result.unknown_checks).toEqual(CRITERIA); // criteria 无确定性/补充证据——FAIL 由硬约束触发，其余仍 unknown
    expect(outcome).toBe('degraded');
  });

  it('无 degraded + 无 criteria + decision made → PASS → success', () => {
    const { result, outcome } = runChain(SESSION, { goal: GOAL, success_criteria: [] }, { degraded: false, decision_made: true });
    expect(result.verdict).toBe('PASS');
    expect(result.unknown_checks).toEqual([]);
    expect(outcome).toBe('success');
  });

  it('有 criteria + 无 judge 证据 → UNKNOWN → unknown（成功条件无确定性证据——诚实不强行裁决）', () => {
    const { result, outcome } = runChain(SESSION, task(), { degraded: false, decision_made: true });
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.hard_failures).toEqual([]);
    expect(result.unknown_checks).toEqual(CRITERIA);
    expect(outcome).toBe('unknown');
  });

  it('注入 judgeChecks 全 pass → PASS → success（补充证据补缺）', () => {
    const { result, outcome } = runChain(SESSION, task(), {
      degraded: false,
      decision_made: true,
      judgeChecks: CRITERIA.map((c) => ({ name: c, result: 'pass' as const, detail: '语义满足' })),
    });
    expect(result.verdict).toBe('PASS');
    expect(result.unknown_checks).toEqual([]);
    expect(outcome).toBe('success');
  });

  it('judge 判 criteria fail 但权威无覆盖 → UNKNOWN（LLM 不能定 FAIL）→ unknown', () => {
    const { result, outcome } = runChain(SESSION, task(), {
      degraded: false,
      decision_made: true,
      judgeChecks: CRITERIA.map((c) => ({ name: c, result: 'fail' as const, detail: '语义不符' })),
    });
    expect(result.verdict).toBe('UNKNOWN'); // 补充证据不能定 FAIL
    expect(result.hard_failures).toEqual([]);
    expect(result.unknown_checks).toEqual(CRITERIA);
    expect(outcome).toBe('unknown');
  });

  it('evidence_quality：无 criteria 全权威有结果 → 1；有 criteria 未查 → 确定性证据占比 0.5', () => {
    const noCriteria = runChain(SESSION, { goal: GOAL, success_criteria: [] }, { degraded: false, decision_made: true });
    expect(noCriteria.result.evidence_quality).toBe(1);
    const withCriteria = runChain(SESSION, task(), { degraded: false, decision_made: true });
    expect(withCriteria.result.evidence_quality).toBe(0.5); // 2/4 应查检查有结果
  });
});

describe('④ readShadowSignals 三元（P2 L2 消费）', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-shadow-p2-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unknown 独立档：不计 failures、不污染失败率评分；pending 仅计 n；新旧格式混合；decision 格式原语义', async () => {
    // S7 per-session 格式（含 P2 'unknown'；旧格式无 verdict 字段——天然兼容）
    fs.writeFileSync(
      path.join(dir, 'exposure-2026-08-25.jsonl'),
      [
        JSON.stringify({ candidate_id: 'latest', bucket: 1, session_id: 's1', outcome: 'pending' }),
        JSON.stringify({ candidate_id: 'latest', bucket: 1, session_id: 's1', outcome: 'unknown' }), // 覆盖占位 → unknown
        JSON.stringify({ candidate_id: 'latest', bucket: 2, session_id: 's2', outcome: 'pending' }),
        JSON.stringify({ candidate_id: 'latest', bucket: 2, session_id: 's2', outcome: 'success' }), // 覆盖占位 → success
        JSON.stringify({ candidate_id: 'latest', bucket: 3, session_id: 's3', outcome: 'pending' }),
        JSON.stringify({ candidate_id: 'latest', bucket: 3, session_id: 's3', outcome: 'degraded' }), // 覆盖占位 → degraded
        JSON.stringify({ candidate_id: 'latest', bucket: 4, session_id: 's4', outcome: 'pending' }), // 仅曝光未收尾 → 计 n
      ].join('\n'),
      'utf8',
    );
    // 既有 G4/T5.3 decision 格式（exposure.log）——原计数语义（无三态 → unknowns 恒 0）
    fs.writeFileSync(
      path.join(dir, 'exposure.log'),
      [
        JSON.stringify({ ts: 1, candidate_id: 'c:1', decision: 'shadow' }),
        JSON.stringify({ ts: 2, candidate_id: 'c:2', decision: 'canary_rollback', outcome: 'restore_failed' }),
      ].join('\n'),
      'utf8',
    );
    const signals = await readShadowSignals(dir);
    // S7：s1(unknown) + s2(success) + s3(degraded) + s4(pending) → n=4；failures=s3=1；unknowns=s1=1
    // G4：shadow → n+1；canary_rollback+restore_failed → n+1、failures+1
    expect(signals).toEqual({ n: 6, failures: 2, unknowns: 1 });
    // 失败率公式 failures/n 不变（unknowns 独立档不参与——不回归既有门禁宽松度）
    expect(signals.failures / signals.n).toBeCloseTo(2 / 6);
  });

  it('缺目录 → 空三元；同输入同输出（确定性）', async () => {
    expect(await readShadowSignals(path.join(dir, 'no-such-dir'))).toEqual({ n: 0, failures: 0, unknowns: 0 });
    const a = await readShadowSignals(dir);
    const b = await readShadowSignals(dir);
    expect(a).toEqual(b);
  });
});

describe('⑤ 确定性（同输入同输出）', () => {
  it('buildShadowEvidence 结构同（ts 为调用注入面除外）；shadowOutcomeFromResult 全映射确定', () => {
    const contract = seedShadowContract(SESSION, task());
    const a = buildShadowEvidence(contract, { degraded: false, decision_made: true, judgeChecks: [] });
    const b = buildShadowEvidence(contract, { degraded: false, decision_made: true, judgeChecks: [] });
    expect(a).toHaveLength(b.length);
    expect(a[0]!.verifier_id).toBe(b[0]!.verifier_id);
    expect(a[0]!.contract_id).toBe(b[0]!.contract_id);
    expect(a[0]!.source).toBe(b[0]!.source);
    expect(a[0]!.checks).toEqual(b[0]!.checks);
    expect(typeof a[0]!.ts).toBe('number');
    // 三态映射逐一确定
    expect(shadowOutcomeFromResult({ verdict: 'PASS' })).toBe('success');
    expect(shadowOutcomeFromResult({ verdict: 'FAIL' })).toBe('degraded');
    expect(shadowOutcomeFromResult({ verdict: 'UNKNOWN' })).toBe('unknown');
    expect(shadowOutcomeFromResult({ verdict: 'UNKNOWN' })).toBe(shadowOutcomeFromResult({ verdict: 'UNKNOWN' }));
  });

  it('decideVerdict 同证据两次 → deep equal + JSON 字节一致（含 UNKNOWN 路径）', () => {
    const contract = seedShadowContract(SESSION, task());
    const evidence = buildShadowEvidence(contract, { degraded: false, decision_made: true });
    const r1 = decideVerdict(contract, evidence);
    const r2 = decideVerdict(contract, evidence);
    expect(r1).toEqual(r2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.verdict).toBe('UNKNOWN'); // 路径确实落在 UNKNOWN 分支（非恒 PASS 假阳性）
  });
});
