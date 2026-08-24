// S8（完成清扫专项 2026-08-24）行为测试：投影一拍时序改进——turn/start 事件驱动预热（runtime/plugin.ts apply）。
// 背景（下一步说明.md 十五节）：DSH systemPrompt.context 为同步求值、prepareTurn 异步 → 首次 context
// 请求返回空串、下次才用缓存投影（宿主 API 约束折中）。S8：session/event 的 turn/start 处理器提前触发
// prepareTurn 预热（事件回调为异步面，不阻塞 DSH 事件派发；DSH 事件流顺序 turn/start → context 求值 → 模型）
// → context 同步求值时投影通常已就绪（首拍命中）；仍可能未完成 → 既有缓存兜底（空串/上次投影）。
// 覆盖：
//   ① 时序：turn/start 事件 → prepareTurn 预热调用（早于任何 context 求值）；goal 取最近已观察用户指令
//   ② 首拍命中：预热完成 → context 求值返回缓存投影（含 goal，同步命中，无等待）
//   ③ 防重入：同 turn 重复 turn/start + 预热在飞时 context 求值 → prepareTurn 只跑一次
//   ④ boot pending 期间 turn/start → 预热等待 bootReady（prepareTurn 未提前调用）；boot ok → 执行
//   ⑤ boot 失败（无恢复路径）→ turn/start 不预热（仅命令模式；prepareTurn 不被调用）
//   ⑥ 投影管线未激活（systemPrompt.context 未注册）→ turn/start 不预热（缓存无人消费，降级路径行为不变）
//   ⑦ goal 收敛（首拍余量恢复）：user/message 在 turn/start 后到达 → 下一次 context 求值以新 goal 重新预热
// 用 fake 运行时（prepareTurn 可注入阻塞/即时）+ bootStableOverride 控制时序——确定性断言，不依赖真实 I/O。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, type CognitiveRuntimeLike, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import type { ContextProjection } from '../../kernel/schemas/a.js';
import type { BootResult } from '../../substrate/boot.js';
import type { GovernorDecision } from '../../runtime/governor.js';
import type { PromptWorkingState } from '../../runtime/prompt.js';

const SESSION = 'sess-s8-preheat';
const GOAL = 'S8 首拍投影验证目标';

// ---- fixture 帮手 ----

function fakeProjection(goal: string): ContextProjection {
  return {
    id: 'proj:preheat-1',
    ir_version: '2.0',
    schema: 'omb/A3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: '2026-08-24T00:00:00.000Z',
    updated: '2026-08-24T00:00:00.000Z',
    provenance: {
      source: 'test',
      event: 'test/preheat',
      actor: 'test',
      environment: { os: 'win32', node: 'v24', dsh_version: 'test', project: 'omb-v2' },
      runtime_snapshot: 'rs:fake',
      timestamp: '2026-08-24T00:00:00.000Z',
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    type: 'planning',
    sections: [{ source_ref: 's:goal', view: 'planning', content: `目标：${goal}`, tokens: 8 }],
    original_artifact_ids: [],
    total_tokens: 8,
    restore_capable: true,
    deterministic: true,
  };
}

const fakeDecision: GovernorDecision = {
  decision: 'Stop',
  reason: 'test',
  budget_allocation: { depth: 0, breadth: 0, tools: 0, retrieval: 0, branches: 0, context: 0 },
  expected_gain: 0,
  snapshot: 'rs:fake',
};

const fakeWorkingState: PromptWorkingState = {
  goal: '',
  confirmed_facts: [],
  active_hypotheses: [],
  contradictions: [],
  open_questions: [],
  evidence_gaps: [],
  next_best_action: '',
  environment: 'win32',
};

/** fake 认知运行时：prepareTurn 可注入实现（即时/阻塞）——确定性时序控制 */
function makeFakeRuntime(
  prepareImpl: (req: unknown, opts?: { inject?: (p: ContextProjection) => void | Promise<void> }) => Promise<{
    decision: GovernorDecision;
    working_state: PromptWorkingState;
    projection: ContextProjection;
    events_appended: number;
  }>,
): { rt: CognitiveRuntimeLike; prepareSpy: ReturnType<typeof vi.fn> } {
  const prepareSpy = vi.fn(prepareImpl);
  const rt: CognitiveRuntimeLike = {
    eventStore: {
      append: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ events: [] })),
    },
    memory: { ingest: vi.fn(async () => 'mem:preheat') },
    snapshotHash: 'rs:fake',
    prepareTurn: prepareSpy,
    observeEvent: vi.fn(async () => ({ appended: true, degraded: null })),
    finalizeTurn: vi.fn(async () => ({ decision_event_id: 'd:1', events_appended: 1 })),
    handleRequest: vi.fn(async () => ({
      decision: { decision: 'Stop' },
      retrieval: { items: [], channel_used: 'none' },
      prompt: { system: '', total_tokens: 0 },
      events_appended: 0,
    })),
    close: vi.fn(async () => undefined),
  };
  return { rt, prepareSpy };
}

/** 即时 prepareTurn：goal 写入投影 section → context 求值文本含 goal */
function makeInstantRuntime(): { rt: CognitiveRuntimeLike; prepareSpy: ReturnType<typeof vi.fn> } {
  return makeFakeRuntime(async (req, opts) => {
    const goal = (req as { goal?: string }).goal ?? '';
    const projection = fakeProjection(goal);
    if (opts?.inject !== undefined) {
      await opts.inject(projection);
    }
    return { decision: fakeDecision, working_state: { ...fakeWorkingState, goal }, projection, events_appended: 1 };
  });
}

/** 阻塞 prepareTurn：调用即记录（防重入断言），gate open 前不完成 */
function makeBlockingRuntime(): { rt: CognitiveRuntimeLike; prepareSpy: ReturnType<typeof vi.fn>; open: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { rt, prepareSpy } = makeFakeRuntime(async (req, opts) => {
    await gate;
    const goal = (req as { goal?: string }).goal ?? '';
    const projection = fakeProjection(goal);
    if (opts?.inject !== undefined) {
      await opts.inject(projection);
    }
    return { decision: fakeDecision, working_state: { ...fakeWorkingState, goal }, projection, events_appended: 1 };
  });
  return { rt, prepareSpy, open: release };
}

// ---- fake ctx（捕获 commands/systemPrompt.context/on，与 hook-finalize 同款装配面） ----

interface Bus {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emit(event: string, ...args: unknown[]): void;
}

function makeFakeCtx(opts: {
  runtime: CognitiveRuntimeLike;
  withSystemPrompt?: boolean;
}): { ctx: ContextLike; bus: Bus; contexts: Array<{ name: string; order: number; text: unknown }> } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const bus: Bus = {
    listeners,
    emit: (event, ...args) => {
      for (const h of listeners.get(event) ?? []) {
        h(...args);
      }
    },
  };
  const contexts: Array<{ name: string; order: number; text: unknown }> = [];
  const ctx: ContextLike = {
    commands: { register: () => undefined },
    cognitive: opts.runtime,
    systemPrompt:
      opts.withSystemPrompt === false
        ? undefined
        : {
            context: (def: unknown) => {
              contexts.push(def as { name: string; order: number; text: unknown });
            },
          },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
  };
  return { ctx, bus, contexts };
}

function dshEvent(type: string, data: unknown, time = 1000): { type: string; data: unknown; time: number } {
  return { type, data, time };
}

function userMessage(id: string, text: string): unknown {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } };
}

function makeAssembleCtx(events: unknown[] = []): { agent: { session: { id: string; events: unknown[] } } } {
  return { agent: { session: { id: SESSION, events } } };
}

// ---- boot 注入面（语义等同 bootStable：ok / 失败无恢复路径；延迟 resolve 由测试持有） ----

function okBoot(): BootResult {
  return { ok: true, line: 'stable', git_revision: 'a'.repeat(40), tree_root: 't', warnings: [] };
}

function failBoot(): BootResult {
  return {
    ok: false,
    line: 'stable',
    git_revision: '',
    tree_root: '',
    warnings: [{ kind: 'no_recovery', detail: 'fixture: 无恢复路径' }],
  };
}

beforeEach(() => {
  clearDegradations();
});

describe('S8 投影一拍时序：turn/start 事件驱动预热（plugin.ts apply）', () => {
  it('时序：turn/start 事件触发 prepareTurn 预热（早于任何 context 求值）；goal 取最近已观察用户指令', async () => {
    const { rt, prepareSpy } = makeInstantRuntime();
    const { ctx, bus } = makeFakeCtx({ runtime: rt });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(okBoot()) });

    // goal 先可观察（宿主变体：user/message 在 turn 前入链）→ turn/start 预热用该 goal
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1000));
    // 尚未发生任何 context 求值——预热必须由 turn/start 触发而非求值惰性 kick
    expect(prepareSpy.mock.calls).toHaveLength(0);

    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1001));
    // 预热链异步（boot gate 微任务）——等 prepareTurn 被调用；断言发生在任何 provider 求值之前
    await vi.waitFor(() => {
      expect(prepareSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const req = prepareSpy.mock.calls[0]![0] as { session_id: string; goal: string };
    expect(req.session_id).toBe(SESSION);
    expect(req.goal).toBe(GOAL);
  });

  it('首拍命中：turn/start 预热完成 → context 求值同步返回缓存投影（含 goal，无等待）', async () => {
    const { rt } = makeInstantRuntime();
    const { ctx, bus, contexts } = makeFakeCtx({ runtime: rt });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(okBoot()) });
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;

    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1000));
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1001));

    // 预热（turn/start 触发）完成后，首次 context 求值即命中缓存投影（goal 可见）
    await vi.waitFor(() => {
      expect(provider(makeAssembleCtx())).toContain(GOAL);
    });
  });

  it('防重入：同 turn 重复 turn/start + 预热在飞时 context 求值 → prepareTurn 只跑一次', async () => {
    const { rt, prepareSpy, open } = makeBlockingRuntime();
    const { ctx, bus, contexts } = makeFakeCtx({ runtime: rt });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(okBoot()) });
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;

    // 预热在飞（prepareTurn 内部 gate 未 open）：重复 turn/start + context 求值 kick 均被 preparing 抑制
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 999));
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1000));
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1001));
    provider(makeAssembleCtx());
    await vi.waitFor(() => {
      expect(prepareSpy.mock.calls).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(prepareSpy.mock.calls).toHaveLength(1); // 在飞期间始终只一次

    open(); // 放行首个 prepare → 投影可命中
    await vi.waitFor(() => {
      expect(provider(makeAssembleCtx())).toContain(GOAL);
    });
  });

  it('boot pending 期间 turn/start → 预热等待 bootReady（prepareTurn 未提前调用）；boot ok → 执行', async () => {
    const { rt, prepareSpy } = makeInstantRuntime();
    let resolveBoot!: (r: BootResult) => void;
    const bootGate = new Promise<BootResult>((resolve) => {
      resolveBoot = resolve;
    });
    const { ctx, bus, contexts } = makeFakeCtx({ runtime: rt });
    apply(ctx, { bootstrap: false, bootStableOverride: () => bootGate });
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;

    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1000));
    await new Promise((r) => setTimeout(r, 20));
    // boot 未 settle → 预热链等待 gate：prepareTurn 未被调用、provider 空串（认知不提前服务）
    expect(prepareSpy.mock.calls).toHaveLength(0);
    expect(provider(makeAssembleCtx())).toBe('');

    // boot settle（ok）→ 预热链放行：prepareTurn 执行 + 投影可命中
    resolveBoot(okBoot());
    await vi.waitFor(() => {
      expect(prepareSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    await vi.waitFor(() => {
      expect(provider(makeAssembleCtx()).length).toBeGreaterThan(0);
    });
  });

  it('boot 失败（无恢复路径）→ turn/start 不预热（仅命令模式；prepareTurn 不被调用）', async () => {
    const { rt, prepareSpy } = makeInstantRuntime();
    const { ctx, bus, contexts } = makeFakeCtx({ runtime: rt });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(failBoot()) });
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;

    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1000));
    await new Promise((r) => setTimeout(r, 20));
    expect(prepareSpy.mock.calls).toHaveLength(0);
    expect(provider(makeAssembleCtx())).toBe('');
    // 认知侧降级记录（gate 首次调用后一次性：仅命令模式）
    await vi.waitFor(() => {
      expect(degradationLog().some((r) => r.hook === 'cognitive/boot')).toBe(true);
    });
  });

  it('投影管线未激活（systemPrompt.context 未注册）→ turn/start 不预热（缓存无人消费，降级路径行为不变）', async () => {
    const { rt, prepareSpy } = makeInstantRuntime();
    const { ctx, bus } = makeFakeCtx({ runtime: rt, withSystemPrompt: false });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(okBoot()) });

    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1000));
    await new Promise((r) => setTimeout(r, 20));
    expect(prepareSpy.mock.calls).toHaveLength(0);
    expect(degradationLog().some((r) => r.hook === 'systemPrompt.context')).toBe(true);
  });

  it('goal 收敛（首拍余量恢复）：user/message 在 turn/start 后到达 → 下一次 context 求值以新 goal 重新预热', async () => {
    const { rt } = makeInstantRuntime();
    const { ctx, bus, contexts } = makeFakeCtx({ runtime: rt });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(okBoot()) });
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;

    // 上一 turn 的 goal 已观察；turn/start 预热用该 goal（首拍：上一已知目标投影）
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', '上一目标'), 1000));
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1001));
    await vi.waitFor(() => {
      expect(provider(makeAssembleCtx())).toContain('上一目标');
    });

    // 本 turn 新指令入链（宿主 canonical 顺序：assemble 后 step() 内 append user/message）
    // → 下一次 context 求值以新 goal 重新预热（既有「每求值即 kick」语义）→ 投影收敛
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-2', GOAL), 1002));
    await vi.waitFor(() => {
      expect(provider(makeAssembleCtx())).toContain(GOAL);
    });
  });
});
