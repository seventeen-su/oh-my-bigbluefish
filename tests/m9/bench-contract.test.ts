// P4（2026-08-25-verification-contract）：bench v2 适配层测试（kernel/bench-contract.ts；用户裁决 P4 范围 ④：
// bench 收敛到同一套 Contract/Evidence/Result 契约语义，冻结基准 20/20 零破坏）。
// 覆盖（计划 §P4 交付物）：
//   ① benchContractFromTask 形状：id=`bench:<id>` / goal=prompt 截断摘要（80 字符）/ hard=verifier 规则判定 /
//      outcome=output_schema 合法 / verifier origin='kernel:bench' / trust L2 + trust_required L2 / schema 合法
//   ② benchEvidenceFromResult 映射：passed/parse_ok → 两项检查 pass/fail；source='runBenchV2:rules'
//   ③ 集成：runBenchV2 回放 20/20（冻结基准）→ 逐任务 evidence → decideVerdict 全 PASS
//      （证明同一套契约语义覆盖 bench，冻结基准零改动）
//   ④ 失败路径：passed=false → FAIL；parse_ok=false（schema 不合法）→ FAIL；契约定义全通过 → PASS
import { describe, expect, it } from 'vitest';
import {
  benchContractFromTask,
  benchEvidenceFromResult,
  BENCH_RULES_CHECK,
  BENCH_RULES_ORIGIN,
  BENCH_RULES_VERIFIER_ID,
  BENCH_SCHEMA_CHECK,
} from '../../kernel/bench-contract.js';
import { decideVerdict } from '../../kernel/verification.js';
import { VerificationContractSchema } from '../../kernel/schemas/verification.js';
import {
  loadBenchContractsV2,
  loadBenchFixturesV2,
  makeReplayExecutorV2,
  runBenchV2,
} from '../../supervisor/bench-v2.js';

// ---- ① benchContractFromTask 形状 ----

describe('① benchContractFromTask（bench 任务 → 验证契约）', () => {
  it('形状：id/goal 截断摘要/hard/outcome/verifier/trust_required/verdict_semantics 全部按契约语义', () => {
    const c = benchContractFromTask({ id: 'code-01', prompt: '运行测试用例并报告通过情况' });
    expect(c.id).toBe('bench:code-01');
    expect(c.goal).toBe('运行测试用例并报告通过情况');
    expect(c.hard_constraints).toEqual([BENCH_RULES_CHECK]);
    expect(c.outcome_conditions).toEqual([BENCH_SCHEMA_CHECK]);
    expect(c.trust_required).toBe('L2');
    expect(c.verdict_semantics).toBe('all_must_pass');
  });

  it('goal 截断：prompt > 80 字符 → 前 80 + 省略号', () => {
    const long = '字'.repeat(120);
    const c = benchContractFromTask({ id: 't', prompt: long });
    expect(c.goal.length).toBe(81);
    expect(c.goal.endsWith('…')).toBe(true);
    expect(c.goal.slice(0, 80)).toBe(long.slice(0, 80));
  });

  it('verifier：deterministic 权威、trust L2、origin kernel:bench（独立来源）、checks=两项检查名、盲区 judge 旁证', () => {
    const c = benchContractFromTask({ id: 'data-01', prompt: '按 schema 输出数据' });
    expect(c.verifiers).toHaveLength(1);
    const v = c.verifiers[0]!;
    expect(v.id).toBe(BENCH_RULES_VERIFIER_ID);
    expect(v.kind).toBe('deterministic');
    expect(v.trust).toBe('L2');
    expect(v.origin).toBe(BENCH_RULES_ORIGIN);
    expect(v.checks).toEqual([BENCH_RULES_CHECK, BENCH_SCHEMA_CHECK]);
    expect(v.blind_spots[0]).toMatch(/judge|语义/);
  });

  it('schema 合法（VerificationContractSchema 通过）', () => {
    expect(() => VerificationContractSchema.parse(benchContractFromTask({ id: 'sys-01', prompt: 'p' }))).not.toThrow();
  });
});

// ---- ② benchEvidenceFromResult 映射 ----

describe('② benchEvidenceFromResult（运行结果 → 权威证据）', () => {
  it('passed=true parse_ok=true → 两项检查全 pass；contract_id/source/ts 正确', () => {
    const c = benchContractFromTask({ id: 'web-01', prompt: 'p' });
    const ev = benchEvidenceFromResult(c, { passed: true, parse_ok: true });
    expect(ev.verifier_id).toBe(BENCH_RULES_VERIFIER_ID);
    expect(ev.contract_id).toBe(c.id);
    expect(ev.source).toBe('runBenchV2:rules');
    expect(typeof ev.ts).toBe('number');
    expect(ev.checks.map((x) => x.result)).toEqual(['pass', 'pass']);
  });

  it('passed=false → verifier 规则判定 fail；parse_ok=true → output_schema pass', () => {
    const c = benchContractFromTask({ id: 'code-01', prompt: 'p' });
    const ev = benchEvidenceFromResult(c, { passed: false, parse_ok: true });
    expect(ev.checks[0]!.result).toBe('fail');
    expect(ev.checks[1]!.result).toBe('pass');
  });

  it('parse_ok=false → output_schema fail；passed=true 但 parse_ok=false → schema 面 fail', () => {
    const c = benchContractFromTask({ id: 'data-01', prompt: 'p' });
    const ev = benchEvidenceFromResult(c, { passed: false, parse_ok: false });
    expect(ev.checks.map((x) => x.result)).toEqual(['fail', 'fail']);
    const ev2 = benchEvidenceFromResult(c, { passed: true, parse_ok: false });
    expect(ev2.checks[1]!.result).toBe('fail');
  });
});

// ---- ③ 集成：runBenchV2 回放 20/20 → 契约语义全 PASS（冻结基准零改动） ----

describe('③ 集成：runBenchV2 回放 20/20 → bench-contract 适配层 decideVerdict 全 PASS', () => {
  it('回放 20/20（T2.2 同款接线）→ 逐任务契约判定全 PASS（同一套契约语义覆盖 bench）', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    const report = await runBenchV2({
      contracts,
      fixtures,
      line: 'stable',
      executor: makeReplayExecutorV2(fixtures),
      mode: 'replay',
    });
    expect(report.total).toBe(20);
    expect(report.passed).toBe(20); // 冻结基准回放 20/20（零破坏前提）

    for (const r of report.results) {
      const task = contracts.find((c) => c.id === r.task_id);
      expect(task, r.task_id).toBeDefined();
      const contract = benchContractFromTask({ id: task!.id, prompt: task!.requirement });
      const evidence = benchEvidenceFromResult(contract, { passed: r.passed, parse_ok: r.passed });
      const verdict = decideVerdict(contract, [evidence]);
      expect(verdict.verdict, `${r.task_id}: ${verdict.reason}`).toBe('PASS');
      expect(verdict.hard_failures).toEqual([]);
      expect(verdict.evidence_quality).toBe(1);
    }
  });

  it('确定性：同输入两次 → 契约判定结果逐任务一致', async () => {
    const contracts = await loadBenchContractsV2();
    const fixtures = await loadBenchFixturesV2();
    const run = async () => {
      const report = await runBenchV2({ contracts, fixtures, line: 'latest', executor: makeReplayExecutorV2(fixtures) });
      return report.results.map((r) => {
        const task = contracts.find((c) => c.id === r.task_id)!;
        const contract = benchContractFromTask({ id: task.id, prompt: task.requirement });
        return decideVerdict(contract, [benchEvidenceFromResult(contract, { passed: r.passed, parse_ok: r.passed })])
          .verdict;
      });
    };
    expect(await run()).toEqual(await run());
  });
});

// ---- ④ 失败路径（契约语义下的 FAIL/UNKNOWN 面） ----

describe('④ 失败路径（同一套契约语义的 FAIL 判定）', () => {
  it('passed=false → 契约判定 FAIL（verifier 规则判定 fail——权威证据判 fail）', () => {
    const c = benchContractFromTask({ id: 'code-01', prompt: 'p' });
    const ev = benchEvidenceFromResult(c, { passed: false, parse_ok: true });
    const r = decideVerdict(c, [ev]);
    expect(r.verdict).toBe('FAIL');
    expect(r.hard_failures).toEqual([BENCH_RULES_CHECK]); // hard 优先
  });

  it('parse_ok=false → 契约判定 FAIL（output_schema 不合法）', () => {
    const c = benchContractFromTask({ id: 'data-01', prompt: 'p' });
    const ev = benchEvidenceFromResult(c, { passed: true, parse_ok: false });
    const r = decideVerdict(c, [ev]);
    expect(r.verdict).toBe('FAIL');
    expect(r.hard_failures).toEqual([BENCH_SCHEMA_CHECK]);
  });

  it('无证据 → UNKNOWN（证据不足不强行裁决——同一契约语义）', () => {
    const c = benchContractFromTask({ id: 'web-01', prompt: 'p' });
    const r = decideVerdict(c, []);
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.evidence_quality).toBe(0);
  });
});
