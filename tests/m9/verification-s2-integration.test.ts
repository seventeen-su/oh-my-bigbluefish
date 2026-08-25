// S2（2026-08-25-verification-contract 第二阶段裁决 S2）：验证基础设施集成测试（assembly 接线）。
// 第一部分（提交 1）：writeShadowOutcome 机械评分器落盘——process_quality（原始向量 + 综合分）/
//   controllability（机械分类）经 finalizeTurn 真实路径落盘到 exposure-*.jsonl。
// 第二部分（提交 2，追加）：验证债务——UNKNOWN+criteria → debt.jsonl 入队 / FAIL 不入队 /
//   runRepair UNKNOWN → repair 债务 / verification_review 复核（PASS→resolved、UNKNOWN→attempts→
//   pending_manual、judge 不可用→pending_manual、signal 中断让出）。
// 测试技巧：writeShadowOutcome 为私有方法且依赖 shadowSessions（prepareTurn 真实路由需 git fixture）——
//   此处白盒注入 shadowSessions（route 形状与 computeShadowRoute 产出一致），经 finalizeTurn 走真实回写链。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { createJudgeExecutor } from '../../runtime/judge-executor.js';
import { clearDegradations, recordDegradation } from '../../runtime/loop-hooks.js';
import { normalizeProcessQuality, qualityVectorFromSignals } from '../../kernel/process-quality.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { PROV, TS, base } from '../m1/ir-samples.js';

const SHADOW_SESSION = 's2-shadow-1';

let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-s2-'));
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close().catch(() => undefined);
  }
  runtimes = [];
  fs.rmSync(root, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

/** 白盒注入 shadow 会话路由（形状与 computeShadowRoute 产出一致——finalizeTurn 回写前置条件） */
function pokeShadowSession(rt: CognitiveRuntime, sessionId: string): void {
  (
    rt as unknown as {
      shadowSessions: Map<string, { route: boolean; bucket: number; candidate_id: string; reason: string; task_domain: string }>;
    }
  ).shadowSessions.set(sessionId, {
    route: true,
    bucket: 3,
    candidate_id: 'latest',
    reason: 'test 注入',
    task_domain: 'general',
  });
}

/** 最小 GovernorDecision（process.degraded 可注入——degraded 非空 → 契约硬约束 fail → FAIL） */
function decision(degraded?: string | null): Parameters<CognitiveRuntime['finalizeTurn']>[0]['decision'] {
  return {
    decision: 'Verify',
    reason: '测试决策',
    budget_allocation: { depth: 1, breadth: 1, tools: 1, retrieval: 1, branches: 1, context: 1 },
    expected_gain: 0.5,
    snapshot: 'rs:test',
    process: {
      kind: 'none',
      process_id: null,
      name: null,
      steps: [],
      method: 'none',
      applicability: null,
      budget_tokens: null,
      degraded: degraded ?? null,
    },
  };
}

/** 最小 PromptWorkingState */
function workingState(goal: string): Parameters<CognitiveRuntime['finalizeTurn']>[0]['working_state'] {
  return {
    goal,
    confirmed_facts: [],
    active_hypotheses: [],
    contradictions: [],
    open_questions: [],
    evidence_gaps: [],
    next_best_action: '',
    environment: 'test',
  };
}

/** 读取 shadows 目录全部 exposure-*.jsonl 条目（按行解析） */
function readOutcomes(shadowsDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(shadowsDir)) {
    return [];
  }
  const files = fs
    .readdirSync(shadowsDir)
    .filter((f) => f.startsWith('exposure-') && f.endsWith('.jsonl'))
    .sort();
  const entries: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(shadowsDir, f), 'utf8').split('\n')) {
      const t = line.trim();
      if (t.length > 0) {
        entries.push(JSON.parse(t) as Record<string, unknown>);
      }
    }
  }
  return entries;
}

// ---- 第一部分（提交 1）：writeShadowOutcome 机械评分器落盘 ----

describe('S2 集成 ①：writeShadowOutcome 落 process_quality/controllability（机械评分器）', () => {
  it('finalizeTurn 回写 outcome：process_quality 原始向量 + 综合分（信号源 = 降级日志/signals/claims）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, SHADOW_SESSION);
    recordDegradation('test/hook', '降级一'); // degradationLog().length = 1 → recovery = max(0, 1-1/5) = 0.8

    await rt.finalizeTurn({
      session_id: SHADOW_SESSION,
      decision: decision('ETIMEDOUT 网络超时'),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: ['标准 1'] },
    });

    const entries = readOutcomes(path.join(root, '.evolution', 'shadows'));
    expect(entries).toHaveLength(1); // 白盒注入 → 仅 outcome 回写（无 exposure 占位行）
    const outcome = entries[0]!;
    // P2 既有形状回归（verdict/contract_id/evidence_quality/reason）：degraded 非空 → 硬约束 fail → FAIL；
    // evidence_quality = 2/3（hard + 决策有结果，criteria 无证据 unknown）
    expect(outcome.verdict).toBe('FAIL');
    expect(outcome.contract_id).toBe(`shadow:${SHADOW_SESSION}`);
    expect(outcome.evidence_quality).toBe(0.67);
    // S2 机械向量（无会话事件 → tool_calls/corrections=0、claims_count=0；降级日志 1 条）
    expect(outcome.process_quality_vector).toEqual({
      progress_gain: 1,
      evidence_gain: 0,
      recovery: 0.8,
      redundancy: 1,
      tool_efficiency: 1,
      branch_efficiency: 0.5,
    });
    // 综合分 = normalize（同一管线输入——确定性断言，不钉浮点边界）
    const expected = normalizeProcessQuality(
      qualityVectorFromSignals({
        decision_made: true,
        claims_count: 0,
        tool_calls: 0,
        corrections: 0,
        degradations: 1,
      }),
    );
    expect(outcome.process_quality).toBe(expected);
    expect(typeof outcome.process_quality).toBe('number');
    // S2 可控性：degraded 文本含 ETIMEDOUT → network/external
    expect(outcome.controllability).toEqual({ controllability: 'external', cause: 'network' });
  });

  it('degraded=验证码 → controllability captcha/external（机械规则表命中）；verdict FAIL', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, SHADOW_SESSION);

    await rt.finalizeTurn({
      session_id: SHADOW_SESSION,
      decision: decision('页面要求输入验证码'),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: ['标准 1'] },
    });

    const outcome = readOutcomes(path.join(root, '.evolution', 'shadows'))[0]!;
    expect(outcome.verdict).toBe('FAIL');
    expect(outcome.controllability).toEqual({ controllability: 'external', cause: 'captcha' });
  });

  it('degraded=null → UNKNOWN（有 criteria 无证据）；controllability unknown/unknown（诚实缺省）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, SHADOW_SESSION);

    await rt.finalizeTurn({
      session_id: SHADOW_SESSION,
      decision: decision(null),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: ['标准 1'] },
    });

    const outcome = readOutcomes(path.join(root, '.evolution', 'shadows'))[0]!;
    expect(outcome.verdict).toBe('UNKNOWN');
    expect(outcome.evidence_quality).toBe(0.67); // 3 项应查（hard + 决策 + criteria），2 项权威有结果
    expect(outcome.controllability).toEqual({ controllability: 'unknown', cause: 'unknown' });
  });

  it('非 shadow 会话（未注入路由）→ 不回写（零落盘）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    await rt.finalizeTurn({
      session_id: 'not-shadow',
      decision: decision(null),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: ['标准 1'] },
    });
    expect(fs.existsSync(path.join(root, '.evolution', 'shadows'))).toBe(false);
  });
});

// ---- 第二部分（提交 2）：验证债务入队 + verification_review 复核 ----

/** 读取债务队列全量记录（测试断言面） */
function readDebtRecords(rootDir: string): Array<Record<string, unknown>> {
  const file = path.join(rootDir, '.evolution', 'verification', 'debt.jsonl');
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** M1 Memory 最小 fixture（runRepair 受影响对象——M1 schema 合规） */
async function ingestMemory(rt: CognitiveRuntime, payload: string): Promise<string> {
  const id = await rt.memory.ingest({
    ...base({ id: makeMutableId('memory'), schema: 'omb/M1' }),
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: { ...PROV, event: makeMutableId('evt') },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as never);
  return id;
}

/** decay 记录落盘（.evolution/decay/<file>.json——runRepair 数据源） */
async function writeDecay(rootDir: string, file: string, affectedId: string): Promise<void> {
  const dir = path.join(rootDir, '.evolution', 'decay');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, file),
    JSON.stringify({
      ts: Date.now(),
      environment_delta: {},
      affected_objects: [{ id: affectedId, kind: 'memory' }],
      regression_set: [],
      capability_vector_before: {},
      capability_vector_after: {},
      attribution: {},
      fingerprint_before: {},
      fingerprint_after: {},
    }),
    'utf8',
  );
}

describe('S2 集成 ②：验证债务入队（shadow/repair）', () => {
  it('outcome=UNKNOWN 且 criteria 非空 → shadow 债务入队（key/materials/status）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, SHADOW_SESSION);
    await rt.finalizeTurn({
      session_id: SHADOW_SESSION,
      decision: decision(null), // degraded=null → UNKNOWN（有 criteria 无证据）
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: ['标准 1'] },
    });
    const debt = readDebtRecords(root);
    expect(debt).toHaveLength(1);
    expect(debt[0]!.key).toBe(`shadow:${SHADOW_SESSION}`);
    expect(debt[0]!.kind).toBe('shadow');
    expect(debt[0]!.contract_id).toBe(`shadow:${SHADOW_SESSION}`);
    expect(debt[0]!.status).toBe('pending');
    expect(debt[0]!.attempts).toBe(0);
    expect(debt[0]!.materials).toEqual({
      goal: '目标 X',
      success_criteria: ['标准 1'],
      degraded: null,
      decision_made: true,
    });
  });

  it('outcome 非 UNKNOWN（degraded → FAIL）→ 不产生债务', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, SHADOW_SESSION);
    await rt.finalizeTurn({
      session_id: SHADOW_SESSION,
      decision: decision('ETIMEDOUT 网络超时'),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: ['标准 1'] },
    });
    expect(readDebtRecords(root)).toHaveLength(0);
  });

  it('criteria 为空 → 无语义应查（PASS）→ 不产生债务', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, SHADOW_SESSION);
    await rt.finalizeTurn({
      session_id: SHADOW_SESSION,
      decision: decision(null),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: [] },
    });
    expect(readDebtRecords(root)).toHaveLength(0);
  });

  it('runRepair：per-object verdict=UNKNOWN 且 evidence_quality<1 → repair 债务入队', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    const memId = await ingestMemory(rt, '受影响对象 X');
    await rt.memory.update(memId, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'a.json', memId);

    const rec = await rt.runRepair();
    const o = rec.objects[0]!;
    expect(o.verdict).toBe('UNKNOWN'); // 语义面无证据 → 诚实 UNKNOWN
    expect(o.evidence_quality).toBeLessThan(1);

    const debt = readDebtRecords(root);
    expect(debt).toHaveLength(1);
    expect(debt[0]!.key).toBe(`repair:${memId}`);
    expect(debt[0]!.kind).toBe('repair');
    expect(debt[0]!.contract_id).toBe(`repair:${memId}`);
    expect(debt[0]!.object_ref).toBe(memId);
    expect(debt[0]!.materials).toMatchObject({ kind: 'memory', verdict: 'UNKNOWN', disposition: 'keep_suspicious' });
    expect((debt[0]!.materials as { evidence_quality: number }).evidence_quality).toBe(0.67);
  });
});

describe('S2 集成 ③：verification_review 复核（空白子代理单次裁判）', () => {
  it('fake judge PASS → 债务 resolved（resolution {verdict, judge_used:true, ts}）', async () => {
    const rt = track(
      createCognitiveRuntime({
        root,
        judgeExecutor: createJudgeExecutor({
          spawnJudge: async () =>
            JSON.stringify({ result_quality: 0.8, evidence_quality: 0.6, process_quality: 0.7, controllability: 'controllable', uncertainty: 0.1 }),
        }),
      }),
    );
    await rt.verificationDebt.enqueue({ key: 'shadow:s-1', kind: 'shadow', contract_id: 'shadow:s-1', materials: { goal: 'g', success_criteria: ['c'] } });
    await rt.runVerificationReview();
    const all = readDebtRecords(root);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('resolved');
    expect((all[0]!.resolution as Record<string, unknown>).verdict).toBe('PASS');
    expect((all[0]!.resolution as Record<string, unknown>).judge_used).toBe(true);
    expect(typeof (all[0]!.resolution as Record<string, unknown>).ts).toBe('number');
    expect(await rt.verificationDebt.listPending()).toHaveLength(0);
  });

  it('fake judge UNKNOWN → attempts 递增；2 次未决 → pending_manual（低频人工复核）', async () => {
    const rt = track(
      createCognitiveRuntime({
        root,
        judgeExecutor: createJudgeExecutor({
          spawnJudge: async () =>
            JSON.stringify({ result_quality: 0.5, evidence_quality: 0.5, process_quality: 0.5, controllability: 'unknown', uncertainty: 0.5 }),
        }),
      }),
    );
    await rt.verificationDebt.enqueue({ key: 'shadow:s-2', kind: 'shadow', contract_id: 'shadow:s-2', materials: { goal: 'g' } });
    await rt.runVerificationReview(); // 第 1 次：attempts 1（仍 pending）
    let all = readDebtRecords(root);
    expect(all[0]!.status).toBe('pending');
    expect(all[0]!.attempts).toBe(1);
    await rt.runVerificationReview(); // 第 2 次：attempts 2 → pending_manual
    all = readDebtRecords(root);
    expect(all[0]!.status).toBe('pending_manual');
    expect(all[0]!.attempts).toBe(2);
    expect((all[0]!.resolution as Record<string, unknown>).detail).toContain('人工复核');
  });

  it('judge 不可用（未注入）→ pending_manual（detail 记 judge 不可用——诚实降级）', async () => {
    const rt = track(createCognitiveRuntime({ root })); // 无 judgeExecutor
    await rt.verificationDebt.enqueue({ key: 'shadow:s-3', kind: 'shadow', contract_id: 'shadow:s-3', materials: { goal: 'g' } });
    await rt.runVerificationReview();
    const all = readDebtRecords(root);
    expect(all[0]!.status).toBe('pending_manual');
    expect((all[0]!.resolution as Record<string, unknown>).detail).toContain('judge 不可用');
  });

  it('signal 中断 → 让出（不标记——债务保留 pending/attempts 0）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    await rt.verificationDebt.enqueue({ key: 'shadow:s-4', kind: 'shadow', contract_id: 'shadow:s-4', materials: { goal: 'g' } });
    const ac = new AbortController();
    ac.abort();
    await rt.runVerificationReview(ac.signal);
    const all = readDebtRecords(root);
    expect(all[0]!.status).toBe('pending');
    expect(all[0]!.attempts).toBe(0);
  });

  it('队列空 → 正常完成（不抛）；多债务 → 每批最多 3 条', async () => {
    const rt = track(
      createCognitiveRuntime({
        root,
        judgeExecutor: createJudgeExecutor({
          spawnJudge: async () =>
            JSON.stringify({ result_quality: 0.8, evidence_quality: 0.6, process_quality: 0.7, controllability: 'controllable', uncertainty: 0.1 }),
        }),
      }),
    );
    await expect(rt.runVerificationReview()).resolves.toBeUndefined(); // 空队列正常完成
    for (let i = 1; i <= 5; i++) {
      await rt.verificationDebt.enqueue({ key: `shadow:s-${i}`, kind: 'shadow', contract_id: `shadow:s-${i}`, materials: { goal: 'g' } });
    }
    await rt.runVerificationReview(); // 一批最多 3 条 → 前 3 条 resolved，后 2 条仍 pending
    const all = readDebtRecords(root);
    expect(all.filter((r) => r.status === 'resolved')).toHaveLength(3);
    expect(all.filter((r) => r.status === 'pending')).toHaveLength(2);
  });
});
