// T8.26.4 行为测试：事件监听接线（session/event + tools/result → observeEvent，Loop Integration 专项 §3.2/§4）。
// 严格 TDD：本文件先于实现编写——apply() 尚未注册 on 监听 → RED。
// 覆盖：
//   注册断言：apply(fakeCtx) → 'session/event' 与 'tools/result' 监听已注册
//   事件流：user/message → session/start+claim/update；tool/call → tool/call；tool/result → tool/result；
//           同 turn 不同用户指令 → contradiction/found（Contradiction 检测）→ State 更新正确（goal/utility/contradictions）
//   双路径幂等：tools/result（live）与 session/event tool/result 对同一 callId → 同一事件 id → 只入链一次
//   守卫降级：无 ctx.on → 不抛 + 记录降级；无 cognitive → 不注册监听 + 记录降级
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import { reduce } from '../../supervisor/state-reducer.js';

const SESSION = 'sess-t8.26.4-1';

interface ListenerMap {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emit(event: string, ...args: unknown[]): void;
}

/** fake ctx：on 捕获监听；emit 分发给捕获的监听（模拟 DSH 事件派发） */
function makeFakeCtx(opts: { runtime?: CognitiveRuntime; withOn?: boolean }): { ctx: ContextLike; bus: ListenerMap } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const bus: ListenerMap = {
    listeners,
    emit: (event, ...args) => {
      for (const h of listeners.get(event) ?? []) {
        h(...args);
      }
    },
  };
  const ctx: ContextLike = {
    commands: { register: () => undefined },
    cognitive: opts.runtime,
    on:
      opts.withOn === false
        ? undefined
        : (event: string, handler: (...args: unknown[]) => void) => {
            const arr = listeners.get(event) ?? [];
            arr.push(handler);
            listeners.set(event, arr);
          },
  };
  return { ctx, bus };
}

/** DSH session 事件形状（{ type, data, time }） */
function dshEvent(type: string, data: unknown, time = 1000): { type: string; data: unknown; time: number } {
  return { type, data, time };
}

function userMessage(id: string, text: string): unknown {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } };
}

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-hevt-'));
  root = join(base, '.omb');
  runtimes = [];
  clearDegradations();
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

describe('T8.26.4 事件监听（plugin.ts apply）', () => {
  it('注册断言：apply(fakeCtx) → session/event 与 tools/result 监听已注册', () => {
    const { ctx, bus } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })) });
    apply(ctx);
    expect(bus.listeners.has('session/event')).toBe(true);
    expect(bus.listeners.has('tools/result')).toBe(true);
  });

  it('事件流 → Event Store 可查 → State 更新正确（goal/utility_tool_calls/Contradiction 检测）', async () => {
    const { ctx, bus } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })) });
    apply(ctx);

    // 模拟 DSH 事件流：turn/start → user/message(A) → tool/call → tool/result → user/message(B，同 turn 不同指令)
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1000));
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', '目标A：量子引力全息对偶'), 1001));
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 1002));
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/result', {
      turn: 1,
      step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok', isError: false }] },
    }, 1003));
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-2', '目标B：改为验证弦论'), 1004));

    // 等观察链落库（append 同步写，reduce 微任务）
    await vi.waitFor(
      async () => {
        expect(await runtime.eventStore.count()).toBeGreaterThanOrEqual(6);
      },
      { timeout: 5000, interval: 10 },
    );

    // ① Event Store 可查：类型面完整（session/start ×2、claim/update ×3（两条用户指令 + 工具结果证据 claim）、tool/call、tool/result、contradiction/found）
    const events = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'session/start')).toHaveLength(2);
    expect(types.filter((t) => t === 'claim/update')).toHaveLength(3);
    expect(types).toContain('tool/call');
    expect(types).toContain('tool/result');
    expect(types).toContain('contradiction/found');

    // ② State 更新正确：goal 取最近用户指令；工具调用计数；Contradiction 检测入 State
    const { state } = reduce(events);
    expect(state.working.goal).toBe('目标B：改为验证弦论');
    expect(state.working.contradictions).toHaveLength(1);
    // utility 计数经 projections 输出（reducer 约定）
    const { projections } = reduce(events);
    expect(projections.utility_counts.tool_calls).toBe(1);

    // ③ Contradiction 具体：left/right 为用户指令 claim（msg-1 vs msg-2）
    const contra = events.find((e) => e.type === 'contradiction/found')!;
    const payload = contra.payload as Record<string, unknown>;
    expect(payload.left_claim).toBe('u:msg-1');
    expect(payload.right_claim).toBe('u:msg-2');
  });

  it('双路径幂等：tools/result（live）与 session/event tool/result 对同一 callId → 同一事件 id → 只入链一次', async () => {
    const { ctx, bus } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })) });
    apply(ctx);

    // live 路径先到（tools/result，exec 携带 callId/name/agent.session.id）
    bus.emit('tools/result',
      { callId: 'c1', name: 'read', arguments: {}, agent: { session: { id: SESSION } } },
      { isError: true, error: { message: 'boom', info: { name: 'ReadError', code: 'E_READ' } }, content: [] });

    // session 路径后到（同一 callId 的耐久 tool/result）
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/result', {
      turn: 1,
      step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'boom', isError: true }] },
      error: { name: 'ReadError', code: 'E_READ' },
    }, 2000));

    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.filter((e) => e.type === 'tool/result')).toHaveLength(1);
      },
      { timeout: 5000, interval: 10 },
    );

    // 事件带 live 路径的失败信息（先到者胜；is_error 可观测）
    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    expect(evs.filter((e) => e.type === 'tool/result')).toHaveLength(1);
    const tr = evs.find((e) => e.type === 'tool/result')!;
    const payload = tr.payload as Record<string, unknown>;
    expect(payload.call_id).toBe('c1');
    expect(payload.is_error).toBe(true);
  });

  it('反证解除：同 callId 不同结果签名（工具结果被修正）→ evidence/revoked 入链，历史保留，claim 证据态撤销', async () => {
    const { ctx, bus } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })) });
    apply(ctx);

    bus.emit('session/event', { id: SESSION }, dshEvent('tool/result', {
      turn: 1,
      step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '答案 A', isError: false }] },
    }, 1001));

    bus.emit('session/event', { id: SESSION }, dshEvent('tool/result', {
      turn: 1,
      step: 2,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '答案 B（修正）', isError: false }] },
    }, 1002));

    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'evidence/revoked')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );

    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const revoked = evs.filter((e) => e.type === 'evidence/revoked');
    expect(revoked).toHaveLength(1);
    const rp = revoked[0]!.payload as Record<string, unknown>;
    expect(rp.claim_id).toBe('ev:tool:c1');
    // 历史保留：两条 tool/result 都在（修正结果用新确定性 id，不覆盖旧事件）
    const trs = evs.filter((e) => e.type === 'tool/result');
    expect(trs).toHaveLength(2);
    expect(new Set(trs.map((e) => e.id)).size).toBe(2);
    // State：claim 证据态 revoked；修正计数 +1
    const { projections } = reduce(evs);
    expect(projections.claims.get('ev:tool:c1')?.evidence_status).toBe('revoked');
    expect(projections.utility_counts.corrections).toBe(1);
  });

  it('守卫降级：无 ctx.on（接口缺失）→ apply 不抛、不注册监听、记录降级（命令仍可用）', () => {
    const { ctx, bus } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })), withOn: false });
    expect(() => apply(ctx)).not.toThrow();
    expect(bus.listeners.size).toBe(0);
    expect(degradationLog().some((r) => r.hook === 'ctx.on')).toBe(true);
  });

  it('守卫降级：无 cognitive（未装配）→ 不注册监听 + 记录降级', () => {
    const { ctx, bus } = makeFakeCtx({ withOn: true });
    expect(() => apply(ctx)).not.toThrow();
    expect(bus.listeners.size).toBe(0);
    expect(degradationLog().some((r) => r.hook === 'cognitive-runtime')).toBe(true);
  });
});
