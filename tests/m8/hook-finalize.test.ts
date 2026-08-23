// T8.26.5 行为测试：turn 收尾钩子（session/flush + turn/end → finalizeTurn，Loop Integration 专项 §3.3/§4）。
// 严格 TDD：本文件先于实现编写——apply() 尚未注册 flush 监听/惰性收尾 → RED。
// 覆盖：
//   flush → finalizeTurn：decision/made 入链（reducer 兼容 payload）+ checkpoint 可恢复 + MaintenanceDebt 累计
//     （经 scheduler 注入）；双 flush 幂等（只 finalize 一次）
//   惰性收尾（无 flush）：turn/end 后下一次 prepareTurn 前 finalize（记录降级路径）
//   守卫：flush 触发但无收尾状态 → 无副作用不抛
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import { list as listCheckpoints, restore as restoreCheckpoint } from '../../supervisor/checkpoint.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';

const SESSION = 'sess-t8.26.5-1';
const GOAL = '量子引力 全息对偶';

interface Bus {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emit(event: string, ...args: unknown[]): void;
}

/** fake ctx：同时捕获 commands/systemPrompt.context/on（三钩子共用装配面） */
function makeFakeCtx(opts: {
  runtime?: CognitiveRuntime;
}): {
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
  base = await mkdtemp(join(tmpdir(), 'omb-hfin-'));
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

describe('T8.26.5 turn 收尾钩子（plugin.ts apply）', () => {
  it('flush → finalizeTurn：decision/made 入链 + checkpoint 可恢复 + MaintenanceDebt 累计；双 flush 幂等', async () => {
    const cpDir = join(root, 'checkpoints');
    const scheduler = new MaintenanceScheduler({ debtFile: join(base, 'debt.json') });
    runtime = track(createCognitiveRuntime({ root, checkpointDir: cpDir, maintenance: scheduler }));
    const { ctx, bus, contexts } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });

    // 会话事实入链（goal 经 user/message 映射）
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1001));
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 1002));

    // prepareTurn 预热（provider 求值 → 决策缓存 + context/injected；assembleCtx 携带会话事件）
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;
    provider(assembleCtx([userMessage('msg-1', GOAL)]));
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'context/injected')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );

    // flush → finalizeTurn
    bus.emit('session/flush', { id: SESSION });
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.filter((e) => e.type === 'decision/made')).toHaveLength(1);
      },
      { timeout: 5000, interval: 10 },
    );

    // ① decision/made 入链（reducer 兼容 payload：decision_id/question/chosen）
    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const made = evs.find((e) => e.type === 'decision/made')!;
    const payload = made.payload as Record<string, unknown>;
    expect(typeof payload.decision_id).toBe('string');
    expect(payload.question).toBe(GOAL);
    expect(typeof payload.chosen).toBe('string');

    // ② checkpoint 可恢复（state 来自会话事件流归约；checkpoint 写盘为异步 I/O，等其落盘）
    await vi.waitFor(
      async () => {
        expect(await listCheckpoints({ dir: cpDir })).toHaveLength(1);
      },
      { timeout: 5000, interval: 10 },
    );
    const cps = await listCheckpoints({ dir: cpDir });
    const restored = await restoreCheckpoint(cps[0]!.id, { dir: cpDir });
    expect(restored.working.goal).toBe(GOAL);

    // ③ MaintenanceDebt 累计（经 scheduler 注入）：中断量子 → 任务留队并累计债务；随后正常量子可执行
    const aborted = new AbortController();
    aborted.abort();
    const skipped = await scheduler.requestQuantum({ signal: aborted.signal });
    expect(skipped.skipped).toContain(`turn-finalize:${SESSION}`);
    const debt = scheduler.debtSnapshot();
    expect(debt.some((d) => d.task_id === `turn-finalize:${SESSION}`)).toBe(true);
    const report = await scheduler.requestQuantum();
    expect(report.ran).toContain(`turn-finalize:${SESSION}`);
    scheduler.stop();

    // ④ 双 flush 幂等：再次 flush → 不重复 finalize（decision/made 仍 1 条）
    bus.emit('session/flush', { id: SESSION });
    await new Promise((r) => setTimeout(r, 20));
    const after = (await runtime.eventStore.query({ session_id: SESSION })).events;
    expect(after.filter((e) => e.type === 'decision/made')).toHaveLength(1);
  });

  it('惰性收尾（无 flush）：turn/end 后下一次 prepareTurn 前 finalize（记录降级路径）', async () => {
    const cpDir = join(root, 'checkpoints');
    runtime = track(createCognitiveRuntime({ root, checkpointDir: cpDir }));
    const { ctx, bus, contexts } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });

    // turn 事实入链 + turn 结束（无 flush 事件）
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1001));
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 1002));
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2000));

    // 下一次 prepareTurn（provider 求值）→ 惰性收尾
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;
    provider(assembleCtx([userMessage('msg-1', GOAL)]));
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'decision/made')).toBe(true);
        // 记录降级路径（无 flush 触发 → 惰性收尾）——与 decision/made 同条件等待，消除微时序竞态
        expect(degradationLog().some((r) => r.hook === 'finalize/lazy')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );

    // 惰性收尾同样产生 checkpoint（事实流可归约；等其落盘）
    await vi.waitFor(
      async () => {
        expect(await listCheckpoints({ dir: cpDir })).toHaveLength(1);
      },
      { timeout: 5000, interval: 10 },
    );
    expect(await listCheckpoints({ dir: cpDir })).toHaveLength(1);
  });

  it('守卫：flush 触发但无收尾状态（无 prepare/无 turn/end）→ 无副作用不抛', async () => {
    const cpDir = join(root, 'checkpoints');
    runtime = track(createCognitiveRuntime({ root, checkpointDir: cpDir }));
    const { ctx, bus } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });

    expect(() => bus.emit('session/flush', { id: SESSION })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    expect(evs).toHaveLength(0); // 无收尾状态 → 不 finalize、不写 checkpoint
    expect(await listCheckpoints({ dir: cpDir })).toHaveLength(0);
  });
});
