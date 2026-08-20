// M2 出口整体连通测试：M1→M2 跨里程碑解释器闭环（用户指示：大阶段结束必须整体测试，不能只靠分段评审）。
// 把该里程碑全部产物（T2.1 策略/过程数据层 → T2.2 Governor → T2.3 Context Compiler → T2.4 prompt）
// 并连通前一里程碑链（事件 → State 归约，M1 已注册类型 + T1.4 initial 契约）串成一条端到端闭环：
// 真实模块、真实 YAML、真实事件 fixture（禁 mock）。
// 覆盖（任务 spec）：
//   ① 场景 A：任务完成（success_criteria 全覆盖 → isSuccessCriteriaCovered=true → 表外短路 Stop，
//      即使 critical_gaps 非空）；② 场景 B：任务未完成（未覆盖项 + Strong + 缺口非空 → Verify）；
//   ③ Context Compiler 接入（State.working → 视图、真实 context.yaml 权重、A3 schema）；
//   ④ prompt 接入（total_tokens ≤ 500、含 goal、机制词黑名单抽查）；
//   ⑤ 整链确定性（同一事件流两次全链回放 → JSON 深相等）；⑥ 跨里程碑一致性
//      （reduce 产物 working 字段作为 prompt working_state 输入，goal/confirmed_facts 内容保真）。
// fixture：事件/initial 同款 replay-chain.test.ts 风格（ir-samples PROV/TS/S2_VALID）；真实 kernel/policy 与 processes。
import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPolicy, loadProcesses, type PolicyBundle } from '../../kernel/policy-loader.js';
import type { Event } from '../../kernel/schemas/m.js';
import { StateSchema, type State } from '../../kernel/schemas/s.js';
import { ContextProjectionSchema, type ContextProjection } from '../../kernel/schemas/a.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { reduce, type ReducedState } from '../../supervisor/state-reducer.js';
import { decide, isSuccessCriteriaCovered, type GovernorInput } from '../../runtime/governor.js';
import { compile, type CandidateItem, type CompileInput } from '../../runtime/renderer.js';
import {
  buildPrompt,
  INTERNAL_MECHANISM_WORDS,
  type PromptInput,
  type PromptWorkingState,
} from '../../runtime/prompt.js';
import { PROV, S2_VALID, TS } from '../m1/ir-samples.js';

const POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const PROCESSES_DIR = fileURLToPath(new URL('../../kernel/processes', import.meta.url));
const NOW = Date.parse(TS);
const SESSION_ID = 'sess-interpreter-loop';
/** 合法 S3 working 种子（goal/next_best_action 非空 → S2 schema 合规；同款 replay-chain fixture） */
const INITIAL = S2_VALID as unknown as State;
/** 场景 A 成功条件（与事件流 goal 语义对齐；全覆盖 → decide 短路 Stop 用） */
const CRITERIA_A = ['端到端闭环验证', '决策语义正确'];

let policy: PolicyBundle;
let processIds: readonly string[];

beforeAll(async () => {
  policy = await loadPolicy(POLICY_DIR);
  processIds = (await loadProcesses(PROCESSES_DIR)).map((p) => p.id);
});

/** M3 Event 工厂：seq 递增、timestamp 递增、单一会话链（同款 replay-chain.test.ts fixture 风格） */
function evt(type: string, payload: Record<string, unknown>, seq: number): Event & { seq: number } {
  const t = new Date(NOW + seq * 1000).toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: t,
    updated: t,
    provenance: PROV,
    refs: [],
    type: type as Event['type'],
    session_id: SESSION_ID,
    runtime_snapshot: 'rs:1',
    parent_event: null,
    causality: `c:${seq}`,
    payload,
    timestamp: t,
    seq,
  };
}

/** 场景 A 事件链（任务完成：session/start → claim/update ×2 → decision/made → tool/call → session/end） */
function scenarioAEvents(): (Event & { seq: number })[] {
  return [
    evt('session/start', { goal: '端到端闭环验证' }, 1),
    evt('claim/update', { claim_id: 'c:1', text: '事件流重建正确', epistemic: 'supported', confidence: 0.8 }, 2),
    evt('claim/update', { claim_id: 'c:2', text: '决策语义正确', epistemic: 'supported', confidence: 0.9 }, 3),
    evt('decision/made', { decision_id: 'd:1', question: '是否终止本轮', chosen: 'stop', evidence_used: ['c:1'] }, 4),
    evt('tool/call', { tool_id: 't:1' }, 5),
    evt('session/end', {}, 6),
  ];
}

/** 跨里程碑视图映射：S3 WorkingState（environment=Fingerprint 对象）→ runtime 视图（environment=字符串渲染值） */
function wsView(state: ReducedState): PromptWorkingState {
  return {
    goal: state.working.goal,
    confirmed_facts: state.working.confirmed_facts,
    active_hypotheses: state.working.active_hypotheses,
    contradictions: state.working.contradictions,
    open_questions: state.working.open_questions,
    evidence_gaps: state.working.evidence_gaps,
    next_best_action: state.working.next_best_action,
    environment: state.working.environment.os,
  };
}

/** GovernorInput 工厂：M1 归约 State 派生（goal/snapshot_hash/environment 均取自 reduce 产物） */
function govInput(state: ReducedState, covered: string[], gaps: string[]): GovernorInput {
  return {
    task_contract: { goal: state.working.goal, success_criteria: CRITERIA_A },
    state_snapshot: { snapshot_hash: state.snapshot_hash },
    environment: state.working.environment.os,
    candidate_processes: ['retrieve-verify'],
    applicability_results: [{ process_id: 'retrieve-verify', applicability: 'Strong' }],
    budget: {
      envelope: policy.budget,
      remaining: { depth: 8, breadth: 4, tools: 12, retrieval: 6, branches: 8, context: 16000 },
    },
    risk: 0.1,
    progress_vector: {
      constraint_reduction: 0.5,
      hypothesis_reduction: 0.5,
      hypothesis_discrimination: 0.5,
      evidence_strengthening: 0.5,
      goal_completion: 0.5,
      reproducibility: 0.5,
      uncertainty_reduction: 0.5,
    },
    uncertainty_vector: { goal: 0.2 },
    maintenance_state: { debt: 0 },
    evidence_sufficiency: { covered_success_conditions: covered, critical_gaps: gaps, score: gaps.length ? 0.5 : 1 },
  };
}

/** CompileInput 工厂：working_state 取 M1 归约 State（verbatim）+ confirmed_facts 派生 evidence 候选（真实 context.yaml 权重） */
function compileInput(state: ReducedState): CompileInput {
  const evidenceCandidates: CandidateItem[] = state.working.confirmed_facts.map((cid) => ({
    id: `ev:${cid}`,
    kind: 'retrieval',
    content: `证据：${cid} 已确认`,
    tokens: 20,
    view: 'planning',
    info_value: 100,
    source_ref: `src:${cid}`,
  }));
  return {
    task_contract: { goal: state.working.goal, success_criteria: CRITERIA_A },
    working_state: wsView(state),
    candidates: evidenceCandidates,
    budget_tokens: 4000,
    policy: policy.context,
  };
}

/** PromptInput 工厂：task_contract 与 working_state 均取自 M1 归约 State（跨里程碑内容保真） */
function promptInput(state: ReducedState, projection: ContextProjection): PromptInput {
  return {
    session_id: SESSION_ID,
    task_contract: { goal: state.working.goal, constraints: ['验证先行'], success_criteria: CRITERIA_A },
    working_state: wsView(state),
    projection,
  };
}

describe('M1→M2 解释器闭环（事件 → State → Governor → Context Compiler → prompt）', () => {
  it('① 场景 A：任务完成（success_criteria 全覆盖）→ 表外短路 Stop；即使 critical_gaps 非空', () => {
    // M1 链：事件序列（全部已注册类型）→ 带 initial 归约 → S2 schema 合规 State（T1.4 契约）
    const { state } = reduce(scenarioAEvents(), { initial: INITIAL });
    expect(StateSchema.safeParse(state).success).toBe(true);
    expect(state.working.goal).toBe('端到端闭环验证'); // session/start 落位
    expect(state.working.confirmed_facts).toEqual(['c:1', 'c:2']); // claim/update ×2（supported）
    expect(state.lifecycle).toBe('retired'); // session/end 终结标记

    // T2.1 过程数据层连通：candidate_processes 引用真实加载的过程
    expect(processIds).toContain('retrieve-verify');

    // M2 Governor：全覆盖（含 critical_gaps 非空）→ isSuccessCriteriaCovered=true → 短路 Stop
    const input = govInput(state, CRITERIA_A, ['缺口-1']);
    expect(isSuccessCriteriaCovered(input.task_contract, input.evidence_sufficiency)).toBe(true);
    const d = decide(input, policy.governor);
    expect(d.decision).toBe('Stop');
    expect(d.reason).toMatch(/任务完成/);
    expect(d.reason).toMatch(/证据充分/);
    expect(d.snapshot).toBe(state.snapshot_hash); // 决策与 M1 归约状态快照绑定
  });

  it('② 场景 B：任务未完成（success_criteria 有未覆盖项 + Strong + 缺口非空）→ Verify（T2.1 真实表 strong-some-ok）', () => {
    // 进行中会话前缀（不含 session/end）：lifecycle active，与"任务未完成"语义一致（部分重放 M1 链语义）
    const { state } = reduce(scenarioAEvents().slice(0, 5), { initial: INITIAL });
    expect(state.lifecycle).toBe('active');

    const input = govInput(state, ['端到端闭环验证'], ['决策语义正确']); // c2 对应条件未覆盖
    expect(isSuccessCriteriaCovered(input.task_contract, input.evidence_sufficiency)).toBe(false);
    const d = decide(input, policy.governor);
    expect(d.decision).toBe('Verify');
    expect(d.reason).toMatch(/strong-some-ok/);
    expect(d.snapshot).toBe(state.snapshot_hash);
  });

  it('③④ Context Compiler + prompt 接入：A3 schema 合规、ws verbatim、≤500 token、含 goal、无机制词', () => {
    const { state } = reduce(scenarioAEvents(), { initial: INITIAL });

    // T2.3 Context Compiler：working_state（State 派生）+ evidence 候选（confirmed_facts 派生），真实 context.yaml 权重
    const projection = compile(compileInput(state));
    expect(ContextProjectionSchema.safeParse(projection).success).toBe(true);
    const wsSection = projection.sections.find((s) => s.source_ref === 'working_state');
    expect(wsSection).toBeDefined();
    expect(wsSection!.content).toBe(JSON.stringify(wsView(state))); // 绝不盲压缩：与输入逐字节一致
    expect(wsSection!.view).toBe('planning');
    expect(projection.sections.map((s) => s.source_ref)).toEqual(['working_state', 'src:c:1', 'src:c:2']);

    // T2.4 prompt：最小契约 + 动态尾部 + 投影上下文
    const p = buildPrompt(promptInput(state, projection));
    expect(p.system).toContain('任务：端到端闭环验证');
    expect(p.system).toContain('证据：c:1 已确认'); // planning 视图上下文进入 prompt
    expect(p.total_tokens).toBeLessThanOrEqual(500);
    for (const w of INTERNAL_MECHANISM_WORDS) {
      expect(p.system).not.toContain(w); // 机制词黑名单抽查（§14.1 宪法/机制不进入 prompt）
    }
  });

  it('⑤ 整链确定性：同一事件流两次全链回放（reduce→decide→compile→buildPrompt）→ JSON 深相等', () => {
    const events = scenarioAEvents(); // 同一事件流（生产语义：同一条已持久化流的两次回放）
    const run = () => {
      const { state } = reduce(events, { initial: INITIAL });
      const decision = decide(govInput(state, CRITERIA_A, []), policy.governor);
      const projection = compile(compileInput(state));
      const prompt = buildPrompt(promptInput(state, projection));
      return { state, decision, projection, prompt };
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a)); // 全链 JSON 相等
    expect(b.state.snapshot_hash).toBe(a.state.snapshot_hash); // P7 重建一致性
    expect(b.decision).toEqual(a.decision);
    expect(b.projection).toEqual(a.projection);
    expect(b.prompt).toEqual(a.prompt);
  });

  it('⑥ 跨里程碑一致性：reduce 产物 working 字段 → prompt working_state，goal/confirmed_facts 内容保真', () => {
    const { state } = reduce(scenarioAEvents(), { initial: INITIAL });
    const projection = compile(compileInput(state));
    const p = buildPrompt(promptInput(state, projection));

    // goal：静态区任务行与 working_state 渲染均来自 State.working.goal（不篡改）
    expect(p.system).toContain(`任务：${state.working.goal}`);
    // confirmed_facts：动态尾部逐项保真（顺序保留、值一致）
    expect(p.system).toContain('已确认事实：c:1；c:2');
    expect(p.system).toContain(state.working.confirmed_facts.join('；'));
    // State.working 经投影进入 prompt 上下文（working_state section 内容 = 输入视图 JSON）
    expect(p.system).toContain(JSON.stringify(wsView(state)));
  });
});
