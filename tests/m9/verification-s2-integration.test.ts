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
import { clearDegradations, recordDegradation } from '../../runtime/loop-hooks.js';
import { normalizeProcessQuality, qualityVectorFromSignals } from '../../kernel/process-quality.js';

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
