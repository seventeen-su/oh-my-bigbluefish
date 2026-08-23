// T8.26.6 装配冒烟测试：模拟 DSH 会话事件流走完整三钩子链（Loop Integration 专项 §5 T8.26.6 / §6 验收 1-3）。
// 冒烟方式（brief 路径 3，必做）：模拟事件流 session/start → 用户消息 → tools/result → session/flush，
// 经 plugin.ts apply() 真实接线（fake ctx 捕获 systemPrompt.context 注册 + on 监听派发），端到端断言：
//   ① 普通对话经过 OMB：context 注入投影可观测（context/injected total_tokens > 0；provider 文本含 goal）
//   ② 工具结果入链：tool/result 事件 Event Store 可查（call_id 匹配）
//   ③ turn 收尾闭环：flush → decision/made + checkpoint 可恢复（goal 恢复）+ MaintenanceDebt 有数据
//   + signals 聚合：reduce(events).utility_counts.tool_calls ≥ 1（signals = reducer 投影，见报告）
//   + 全链事件类型面完整 + happy path 无降级记录
// 另含 checkpoint 契约复核（T8.26.5 关注点 3 / T1.5 契约约定层）：插件路径 checkpoint State 为事件流直归约
// （world/self=null，reducer 解释性决策），working 视图可消费 + P7 回放一致性。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import { toPromptWorkingState } from '../../runtime/turn-helpers.js';
import { list as listCheckpoints, restore as restoreCheckpoint } from '../../supervisor/checkpoint.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { reduce } from '../../supervisor/state-reducer.js';

const SESSION = 'sess-t8.26.6-smoke';
const GOAL = '装配冒烟：验证请求生命周期全链接线';

interface Bus {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emit(event: string, ...args: unknown[]): void;
}

/** fake ctx：捕获 commands/systemPrompt.context/on（三钩子共用装配面，与 hook-finalize 同款） */
function makeFakeCtx(opts: { runtime: CognitiveRuntime }): {
  ctx: ContextLike;
  bus: Bus;
  contexts: Array<{ name: string; order: number; text: unknown }>;
} {
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
    systemPrompt: {
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

function dshEvent(type: string, data: unknown, time: number): { type: string; data: unknown; time: number } {
  return { type, data, time };
}

function userMessage(id: string, text: string): unknown {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } };
}

function assembleCtx(events: unknown[] = []): { agent: { session: { id: string; events: unknown[] } } } {
  return { agent: { session: { id: SESSION, events } } };
}

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-smoke-'));
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

describe('T8.26.6 装配冒烟（模拟会话，完整三钩子链端到端）', () => {
  it('session/start→用户消息→投影注入(token>0)→工具调用→flush 收尾：全链证据 + checkpoint 可恢复 + MaintenanceDebt 有数据', async () => {
    const cpDir = join(root, 'checkpoints');
    const scheduler = new MaintenanceScheduler({ debtFile: join(base, 'debt.json') });
    runtime = track(createCognitiveRuntime({ root, checkpointDir: cpDir, maintenance: scheduler }));
    const { ctx, bus, contexts } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });

    // ① 会话事实入链：turn/start + 用户消息（goal 经 user/message 映射为 session/start + claim/update）
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/start', { turn: 1 }, 1000));
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1001));

    // ② context 注入（prepareTurn）：provider 首次求值返回空串（异步预热），等待 context/injected 入链
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;
    expect(provider(assembleCtx([userMessage('msg-1', GOAL)]))).toBe('');
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'context/injected')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );

    // 验收① 投影可观测：provider 二次求值返回投影文本（含 working_state → goal 可见）；context/injected total_tokens > 0
    const projectionText = provider(assembleCtx([userMessage('msg-1', GOAL)]));
    expect(projectionText.length).toBeGreaterThan(0);
    expect(projectionText).toContain(GOAL);
    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const injected = evs.find((e) => e.type === 'context/injected')!;
    const injectedPayload = injected.payload as Record<string, unknown>;
    expect(typeof injectedPayload.projection_id).toBe('string');
    expect((injectedPayload.total_tokens as number) > 0).toBe(true);

    // ③ 一次工具调用（session 路径耐久事实）：tool/call + tool/result
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 1002));
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/result', {
      turn: 1,
      step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok', isError: false }] },
    }, 1003));

    // 验收② 工具结果入链：Event Store 可查（call_id 匹配）
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'tool/result')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    const tr = (await runtime.eventStore.query({ session_id: SESSION })).events.find((e) => e.type === 'tool/result')!;
    expect((tr.payload as Record<string, unknown>).call_id).toBe('c1');

    // ④ turn 结束 + flush → finalizeTurn（decision/made 入链）
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2000));
    bus.emit('session/flush', { id: SESSION });
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.filter((e) => e.type === 'decision/made')).toHaveLength(1);
      },
      { timeout: 5000, interval: 10 },
    );

    // 验收③ decision/made 语义（reducer 兼容 payload：question 为本次 goal、chosen 为 Governor 决策值）
    const made = (await runtime.eventStore.query({ session_id: SESSION })).events.find((e) => e.type === 'decision/made')!;
    const madePayload = made.payload as Record<string, unknown>;
    expect(madePayload.question).toBe(GOAL);
    expect(typeof madePayload.chosen).toBe('string');

    // 验收③ checkpoint 可恢复（state 来自会话事件流归约；等其落盘后 restore，goal 恢复）
    await vi.waitFor(
      async () => {
        expect(await listCheckpoints({ dir: cpDir })).toHaveLength(1);
      },
      { timeout: 5000, interval: 10 },
    );
    const cps = await listCheckpoints({ dir: cpDir });
    const restored = await restoreCheckpoint(cps[0]!.id, { dir: cpDir });
    expect(restored.working.goal).toBe(GOAL);

    // signals 聚合（signals = reducer utility_counts 投影；finalizeTurn 的 aggregateSignals 在收尾时读同一事件流）：
    // 工具调用计 1。注：必须在维护量子执行（compact 批处理）之前断言——fixture 事件时间戳为 1970 epoch ms，
    // compact 按 retention 30 天删除过期行会把它们清掉（生产 DSH 事件为真实时间戳，不受影响；见报告过程注记）。
    const preCompact = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const { projections } = reduce(preCompact);
    expect(projections.utility_counts.tool_calls).toBe(1);

    // 全链事件类型面完整（验收 1-3 的入链证据：session/start → claim/update → context/injected → tool/call → tool/result → decision/made）
    const types = preCompact.map((e) => e.type);
    for (const t of ['session/start', 'claim/update', 'context/injected', 'tool/call', 'tool/result', 'decision/made']) {
      expect(types).toContain(t);
    }
    // happy path 无降级记录（三钩子全接线 + 全成功）
    expect(degradationLog()).toHaveLength(0);

    // 验收③ MaintenanceDebt 有数据（scheduler 注入）：中断量子 → 任务留队并累计债务；随后正常量子可执行
    await vi.waitFor(
      async () => {
        const aborted = new AbortController();
        aborted.abort();
        const skipped = await scheduler.requestQuantum({ signal: aborted.signal });
        expect(skipped.skipped).toContain(`turn-finalize:${SESSION}`);
      },
      { timeout: 5000, interval: 10 },
    );
    const debt = scheduler.debtSnapshot();
    expect(debt.some((d) => d.task_id === `turn-finalize:${SESSION}`)).toBe(true);
    const report = await scheduler.requestQuantum();
    expect(report.ran).toContain(`turn-finalize:${SESSION}`);
    scheduler.stop();
  });

  it('checkpoint 契约复核：插件路径 checkpoint State = 事件流直归约（world/self=null 诚实未知），working 视图可消费 + P7 回放一致', async () => {
    const cpDir = join(root, 'checkpoints');
    runtime = track(createCognitiveRuntime({ root, checkpointDir: cpDir }));
    const { ctx, bus, contexts } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });

    // 最小冒烟流：用户消息 → 投影注入（prepareTurn 预热）→ flush 收尾 → checkpoint
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1001));
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;
    provider(assembleCtx([userMessage('msg-1', GOAL)]));
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'context/injected')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    bus.emit('session/flush', { id: SESSION });
    await vi.waitFor(
      async () => {
        expect(await listCheckpoints({ dir: cpDir })).toHaveLength(1);
      },
      { timeout: 5000, interval: 10 },
    );

    // 复核证据：checkpoint State 无 initial 回放 → world/self 为 null（T1.5 契约约定层：save 不机械校验内嵌 state，
    // 调用方保证 schema 合规；插件路径以事件流为源（P7），world/self 模型未接线 → null 为 reducer 诚实"未知"）
    const cps = await listCheckpoints({ dir: cpDir });
    const restored = await restoreCheckpoint(cps[0]!.id, { dir: cpDir });
    expect((restored as { world: string | null }).world).toBeNull();
    expect((restored as { self: string | null }).self).toBeNull();

    // working 视图可消费：prepareTurn loadWorkingState → toPromptWorkingState 只读 working.*（不触 world/self）
    const ws = toPromptWorkingState(restored);
    expect(ws.goal).toBe(GOAL);

    // P7 回放一致：checkpoint 保存的 state = reduce(保存时刻事件集)；decision/made 在 checkpoint 之后入链，
    // 过滤后重放 → snapshot_hash 一致（checkpoint 是事件流的忠实快照）
    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const { state } = reduce(evs.filter((e) => e.type !== 'decision/made'));
    expect(state.snapshot_hash).toBe(restored.snapshot_hash);
  });
});
