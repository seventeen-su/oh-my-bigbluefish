// T8.26.2 行为测试：认知运行时三能力拆分（prepareTurn/observeEvent/finalizeTurn，Loop Integration 专项 §3.1-3.3）。
// 严格 TDD：本文件先于实现编写并确认失败（方法缺失）。
// 覆盖：
//   prepareTurn：快照/工作状态/Governor 决策/检索/ContextCompiler 投影编译；注入钩子 → context/injected 事件入链（Model-visible ⟺ logged）
//   observeEvent：EventSchema 校验 → append（幂等）→ state-reducer 归约（含 Contradiction 检测）；schema 非法/未注册类型 → 明确降级（不抛）
//   finalizeTurn：decision/made 入链（reducer 可归约 payload）→ Experience 候选（PCR）→ 信号聚合 → checkpoint 保存 → maintenance 入队
//   handleRequest：组合后事件流可归约重建（P7），行为不变（2 事件、events_appended 2、决策/检索/prompt 一致）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { ExperienceSchema } from '../../kernel/schemas/c.js';
import type { Event } from '../../kernel/schemas/m.js';
import type { State } from '../../kernel/schemas/s.js';
import { restore as restoreCheckpoint } from '../../supervisor/checkpoint.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { EVENTS_HANDLED, reduce } from '../../supervisor/state-reducer.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { S2_VALID, PROV } from '../m1/ir-samples.js';

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

const SESSION = 'sess-t8.26.2-1';
const GOAL = '量子引力 全息对偶';

function req(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    goal: GOAL,
    success_criteria: ['给出判别实验'],
    constraints: ['预算内'],
    working_state: {
      goal: GOAL,
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: ['全息对偶是否成立'],
      evidence_gaps: ['判别观测'],
      next_best_action: '',
      environment: 'test',
    },
    ...over,
  };
}

/** M3 Event 工厂（observeEvent 输入；provenance 复用 ir-samples PROV） */
function evt(type: string, payload: Record<string, unknown>, sessionId = SESSION): Event {
  const ts = new Date().toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: PROV,
    refs: [],
    type: type as Event['type'],
    session_id: sessionId,
    runtime_snapshot: 'rs:test',
    parent_event: null,
    payload,
    timestamp: ts,
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-t8262-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtime = rt;
  runtimes.push(rt);
  return rt;
}

describe('prepareTurn（turn 开始：认知准备与上下文注入）', () => {
  it('快照解析 + 工作状态 + Governor 决策 + 检索 + ContextCompiler 投影编译（无注入 → 0 事件）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    // 预置记忆（检索面）
    await runtime.memory.ingest({
      ir_version: '2.0',
      id: 'mem:00000000-0000-4000-8000-000000000001',
      schema: 'omb/M1',
      scope: 'Project',
      kind: 'Semantic',
      lifecycle: 'Active',
      prov_class: 'Observation',
      immutable: false,
      owner: 'kernel',
      created: '2026-08-21T00:00:00.000Z',
      updated: '2026-08-21T00:00:00.000Z',
      provenance: {
        source: 'test',
        event: 'test/ingest-1',
        actor: 't8.26.2',
        environment: { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' },
        runtime_snapshot: 'rs:test',
        timestamp: '2026-08-21T00:00:00.000Z',
        transformation_chain: [],
        verification: 'test',
      },
      refs: [],
      payload: '量子引力 全息对偶 相关事实',
      value_score: 0.8,
      utility_counts: {},
    });

    const prepared = await runtime.prepareTurn(req() as never);

    // ① 快照解析（请求级快照身份）
    expect(prepared.snapshot).toBe(runtime.snapshotHash);
    // ② 工作状态（请求携带）
    expect(prepared.working_state.goal).toBe(GOAL);
    // ③ Governor 决策（OOD + 缺口 some + 预算 ok → GenerateProcess）
    expect(prepared.decision.decision).toBe('GenerateProcess');
    expect(prepared.decision.reason).toContain('GenerateProcess');
    // ④ 检索命中
    expect(prepared.retrieval.items.length).toBeGreaterThan(0);
    expect(prepared.retrieval.items[0]!.memory.payload).toContain('量子引力');
    // ⑤ ContextCompiler 投影（planning 视图 + token 非零）
    expect(prepared.projection.sections.some((s) => s.view === 'planning')).toBe(true);
    expect(prepared.projection.total_tokens).toBeGreaterThan(0);
    // 无注入钩子 → 不产生 context/injected（Model-visible ⟺ logged）
    expect(prepared.events_appended).toBe(0);
    expect(await runtime.eventStore.count()).toBe(0);
  });

  it('注入钩子 → context/injected 事件入链（配投影摘要；Model-visible ⟺ logged）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const injected: unknown[] = [];
    const prepared = await runtime.prepareTurn(req() as never, {
      inject: (projection) => {
        injected.push(projection);
      },
    });

    expect(injected).toHaveLength(1);
    expect(prepared.events_appended).toBe(1);
    const events = (await runtime.eventStore.query({ session_id: SESSION })).events;
    expect(events.map((e) => e.type)).toEqual(['context/injected']);
    // 配投影摘要（projection_id/total_tokens）
    expect((events[0]!.payload as Record<string, unknown>).projection_id).toBe(prepared.projection.id);
    expect(typeof (events[0]!.payload as Record<string, unknown>).total_tokens).toBe('number');
  });
});

describe('observeEvent（运行中：事实入链）', () => {
  it('session/start → append + 归约（goal 更新）；claim/update → confirmed_facts；contradiction/found → Contradiction 检测', async () => {
    runtime = track(createCognitiveRuntime({ root }));

    const r1 = await runtime.observeEvent(evt('session/start', { goal: GOAL }));
    expect(r1.appended).toBe(true);
    expect(r1.state?.working.goal).toBe(GOAL);

    const r2 = await runtime.observeEvent(evt('claim/update', { claim_id: 'c:1', epistemic: 'supported' }));
    expect(r2.state?.working.confirmed_facts).toEqual(['c:1']);

    await runtime.observeEvent(evt('claim/update', { claim_id: 'c:2', epistemic: 'unresolved' }));
    const r3 = await runtime.observeEvent(
      evt('contradiction/found', { contradiction_id: 'x:1', left_claim: 'c:1', right_claim: 'c:2' }),
    );
    expect(r3.state?.working.contradictions).toEqual(['x:1']);
    expect(r3.degraded).toBeNull();
    // 事件全部入链（事实源完整）
    expect(await runtime.eventStore.count()).toBe(4);
  });

  it('schema 非法事件 → 明确降级（不抛、不追加）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const bad = { ...evt('session/start', {}), type: 'bogus/type' };
    const r = await runtime.observeEvent(bad);
    expect(r.appended).toBe(false);
    expect(r.degraded).not.toBeNull();
    expect(await runtime.eventStore.count()).toBe(0);
  });

  it('重复 id → 幂等（appended false，不重复追加）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const e = evt('session/start', { goal: GOAL });
    await runtime.observeEvent(e);
    const r = await runtime.observeEvent(e);
    expect(r.appended).toBe(false);
    expect(await runtime.eventStore.count()).toBe(1);
  });

  it('未注册事件类型（schema 合法）→ 事件已追加但归约明确降级（不抛）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const r = await runtime.observeEvent(evt('process/operator/foo', { operator_id: 'op:1' }));
    expect(r.appended).toBe(true); // 事实源完整（P7：Event 唯一事实源）
    expect(r.state).toBeNull(); // 归约降级（reducer 未注册类型）
    expect(r.degraded).not.toBeNull();
  });
});

describe('finalizeTurn（turn 结束：经验与信号）', () => {
  const decision = {
    decision: 'GenerateProcess',
    reason: 'rule: applicability=OOD, evidence_gaps=some, budget_ok=true → GenerateProcess',
    budget_allocation: { depth: 1, breadth: 1, tools: 1, retrieval: 1, branches: 1, context: 1 },
    expected_gain: 0.5,
    snapshot: 'rs:assembly',
  };

  it('decision/made 入链（reducer 可归约 payload：decision_id/question/chosen）+ Experience 候选（PCR）+ 信号聚合', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.observeEvent(evt('session/start', { goal: GOAL }));

    const res = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: req().working_state as never,
    });

    expect(res.events_appended).toBe(1);
    const events = (await runtime.eventStore.query({ session_id: SESSION })).events;
    expect(events.map((e) => e.type)).toEqual(['session/start', 'decision/made']);
    // decision/made payload 为 reducer 兼容形状（P7：事件流可归约）
    const payload = events[1]!.payload as Record<string, unknown>;
    expect(typeof payload.decision_id).toBe('string');
    expect(payload.question).toBe(GOAL);
    expect(payload.chosen).toBe('GenerateProcess');
    // 整条事件流可归约重建（decision/made 不再缺 decision_id）
    const { state } = reduce(events);
    expect(state.working.goal).toBe(GOAL);
    // Experience 候选（PCR：context/action/result；C11 schema 校验）
    expect(res.experience).not.toBeNull();
    expect(ExperienceSchema.safeParse(res.experience).success).toBe(true);
    expect(res.experience!.action).toBe('GenerateProcess');
    // 信号聚合（零成本：reducer projections.utility_counts）
    expect(res.signals.tool_calls).toBe(0);
  });

  it('checkpointDir + state → checkpoint 保存，restore 恢复一致', async () => {
    const cpDir = join(root, 'checkpoints');
    runtime = track(createCognitiveRuntime({ root, checkpointDir: cpDir }));
    // schema 合规 State（带 initial 的完整回放，T1.5 契约）
    const { state } = reduce([evt('session/start', { goal: GOAL })], {
      initial: S2_VALID as unknown as State,
    });

    const res = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: req().working_state as never,
      state: state as unknown as State,
    });

    expect(res.checkpoint).not.toBeNull();
    const restored = await restoreCheckpoint(res.checkpoint!.id, { dir: cpDir });
    expect(restored).toEqual(state);
  });

  it('maintenance 注入 → 信号聚合入队（量子可执行该维护任务）', async () => {
    const debtFile = join(base, 'debt.json');
    const scheduler = new MaintenanceScheduler({ debtFile });
    runtime = track(createCognitiveRuntime({ root, maintenance: scheduler }));

    const res = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: req().working_state as never,
    });

    expect(res.maintenance.enqueued).toBe(true);
    const report = await scheduler.requestQuantum();
    expect(report.ran).toContain(`turn-finalize:${SESSION}`);
    scheduler.stop();
  });
});

describe('handleRequest 组合（行为不变 + P7 可归约）', () => {
  it('prepareTurn → observeEvent(session/start) → 单轮模拟(prompt) → finalizeTurn：2 事件、事件流可归约重建', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.memory.ingest({
      ir_version: '2.0',
      id: 'mem:00000000-0000-4000-8000-000000000001',
      schema: 'omb/M1',
      scope: 'Project',
      kind: 'Semantic',
      lifecycle: 'Active',
      prov_class: 'Observation',
      immutable: false,
      owner: 'kernel',
      created: '2026-08-21T00:00:00.000Z',
      updated: '2026-08-21T00:00:00.000Z',
      provenance: {
        source: 'test',
        event: 'test/ingest-1',
        actor: 't8.26.2',
        environment: { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' },
        runtime_snapshot: 'rs:test',
        timestamp: '2026-08-21T00:00:00.000Z',
        transformation_chain: [],
        verification: 'test',
      },
      refs: [],
      payload: '量子引力 全息对偶 相关事实',
      value_score: 0.8,
      utility_counts: {},
    });

    const res = await runtime.handleRequest(req() as never);

    // 行为不变：2 事件（session/start + decision/made）、events_appended 2、决策/检索/prompt 一致
    const events = (await runtime.eventStore.query({ session_id: SESSION })).events;
    expect(events.map((e) => e.type).sort()).toEqual(['decision/made', 'session/start']);
    expect(res.events_appended).toBe(2);
    expect(res.decision.decision).toBe('GenerateProcess');
    expect(res.retrieval.items.length).toBeGreaterThan(0);
    expect(res.retrieval.items[0]!.memory.payload).toContain('量子引力');
    expect(res.prompt.system).toContain('任务：量子引力 全息对偶');
    expect(res.prompt.total_tokens).toBeGreaterThan(0);
    // P7：组合后事件流可归约重建（decision/made 为 reducer 兼容 payload）
    const { state } = reduce(events);
    expect(state.working.goal).toBe(GOAL);
    expect(state.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('context/injected 事件类型消费者同步', () => {
  it('EVENTS_HANDLED 已注册 context/injected（新类型须先注册；M8b 先例）', () => {
    expect(EVENTS_HANDLED).toContain('context/injected');
  });
});
