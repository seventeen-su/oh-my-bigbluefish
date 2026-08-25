// R2（P0）启动顺序竞态修复测试：boot gate 机制（runtime/plugin.ts apply）。
// 背景（ChatGPT 评估 #2，P0）：bootStable 异步后台执行期间 CognitiveRuntime 已按（可能损坏的）
// stable 装配——恢复根最终运行 Vn、认知已按损坏 Vm 装配。修复原则：**恢复完成以前，
// 认知运行时不得进入可服务状态**。方案：gate（装配结构不动，钩子内部 gate——改动面最小）——
// 认知服务入口（prepareTurn/observeEvent/finalizeTurn 三钩子 + /mode 认知部分 + /evolve）统一经
// cognitiveServiceable() 等待 bootReady settle；boot 失败（无恢复路径）→ 认知降级为仅命令模式
//（cognitive/boot 一次性记录），命令仍可用。
// 注入面（最小可测性）：apply config.bootStableOverride（语义等同 bootStable(opts)——测试注入
// 延迟 resolve / 失败 boot；缺省真实 bootStable）。
// 覆盖：
//   ① boot 慢（延迟 resolve 注入）→ 认知不提前服务：provider 返回空串（pending 语义）、
//      无 context/injected 入链；boot settle（ok）后 prepareTurn 正常出投影
//   ② boot settle 前到达的事件暂存：不丢事件——resolve（ok）后按序入链
//   ③ boot ok → prepareTurn 正常（投影注入 + context/injected 入链；无 cognitive/boot 降级）
//   ④ boot 失败（ok:false 无恢复路径）→ 认知降级（cognitive/boot + boot/stable 记录）、仅命令模式：
//      provider 恒空串、事件不入链、/mode 空输入返回当前线、/evolve now 明确 error
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import type { BootResult } from '../../substrate/boot.js';

const SESSION = 'sess-r2-boot-gate';
const GOAL = '启动竞态修复验证目标';

interface Bus {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emit(event: string, ...args: unknown[]): void;
}

interface CapturedCommand {
  name: string;
  description: string;
  input?: { hint?: string };
  recordInput?: boolean;
  handler: (invocation: {
    commandId: unknown;
    agent: { session?: { id?: string; events?: ReadonlyArray<{ type?: string }> } };
    rawInput: string;
    signal: unknown;
  }) => Promise<{ kind: 'success' | 'error'; text: string }>;
}

/** fake ctx：捕获 commands/systemPrompt.context/on（三钩子共用装配面，与 hook-finalize 同款） */
function makeFakeCtx(opts: { runtime?: CognitiveRuntime }): {
  ctx: ContextLike;
  bus: Bus;
  contexts: Array<{ name: string; order: number; text: unknown }>;
  captured: CapturedCommand[];
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
  const captured: CapturedCommand[] = [];
  const ctx: ContextLike = {
    commands: {
      register: (def: unknown) => {
        captured.push(def as CapturedCommand);
      },
    },
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
  return { ctx, bus, contexts, captured };
}

/** W5：按名取投影 section（context 现注册 contract(80)/capabilities(85)/projection(90) 三段——order 小者在前） */
function projectionProvider(contexts: Array<{ name: string; order: number; text: unknown }>): (assembleCtx: unknown) => string {
  const def = contexts.find((c) => c.name === 'cognitive:projection')!;
  return def.text as (assembleCtx: unknown) => string;
}

function dshEvent(type: string, data: unknown, time: number): { type: string; data: unknown; time: number } {
  return { type, data, time };
}

/** DSH user/message 消息体（bus emit 用：dshEvent('user/message', userMessage(...), ts)） */
function userMessage(id: string, text: string): unknown {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** 完整 user/message 会话事件（assembleCtx 事件数组用：lastUserMessageText 按 { type, data } 形状提取 goal） */
function userEvent(id: string, text: string): unknown {
  return { type: 'user/message', data: userMessage(id, text) };
}

function makeAssembleCtx(events: unknown[] = []): { agent: { session: { id: string; events: unknown[] } } } {
  return { agent: { session: { id: SESSION, events } } };
}

/** boot ok 载荷（注入面：语义等同 bootStable 健康路径——ok:true 无告警无回退） */
function okBoot(treeRoot: string): BootResult {
  return { ok: true, line: 'stable', git_revision: 'a'.repeat(40), tree_root: treeRoot, warnings: [] };
}

/** boot 失败载荷（注入面：语义等同 bootStable 无恢复路径——ok:false + no_recovery） */
function failBoot(): BootResult {
  return {
    ok: false,
    line: 'stable',
    git_revision: '',
    tree_root: '',
    warnings: [{ kind: 'no_recovery', detail: 'fixture: 全历史均无完好 revision（manifest.json 不可读）' }],
  };
}

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-bootgate-'));
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
  runtimes.push(rt);
  return rt;
}

describe('R2 boot gate（runtime/plugin.ts apply）', () => {
  it('boot 慢（延迟 resolve 注入）→ 认知不提前服务：provider 空串 + 无 context/injected；boot settle（ok）后 prepareTurn 正常出投影', async () => {
    const runtime = track(createCognitiveRuntime({ root }));
    let resolveBoot!: (r: BootResult) => void;
    const bootGate = new Promise<BootResult>((resolve) => {
      resolveBoot = resolve;
    });
    const { ctx, contexts } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false, bootStableOverride: () => bootGate });

    // 装配结构照旧（gate 方案）：context 钩子已注册（认知不提前“服务”，但结构在位）
    expect(contexts).toHaveLength(3); // W5：contract(80)/capabilities(85)/projection(90) 三段
    const provider = projectionProvider(contexts);

    // pending 语义：boot 未 settle → provider 返回空串（异步预热不产出），无 context/injected 入链
    const assembleCtx = makeAssembleCtx([userEvent('msg-1', GOAL)]);
    expect(provider(assembleCtx)).toBe('');
    await new Promise((r) => setTimeout(r, 20));
    expect((await runtime.eventStore.query({ session_id: SESSION })).events).toHaveLength(0);

    // boot settle（ok:true）→ prepareTurn 正常：context/injected 入链 + 投影文本含 goal
    resolveBoot(okBoot(root));
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'context/injected')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    const text = provider(assembleCtx);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(GOAL);
    // 认知未降级：无 cognitive/boot 记录
    expect(degradationLog().some((r) => r.hook === 'cognitive/boot')).toBe(false);
  });

  it('boot settle 前到达的事件暂存：不丢事件——resolve（ok）后按序入链', async () => {
    const runtime = track(createCognitiveRuntime({ root }));
    let resolveBoot!: (r: BootResult) => void;
    const bootGate = new Promise<BootResult>((resolve) => {
      resolveBoot = resolve;
    });
    const { ctx, bus } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false, bootStableOverride: () => bootGate });

    // boot 未 settle：事件到达 → 不入链（认知不提前服务）
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1001));
    await new Promise((r) => setTimeout(r, 20));
    expect((await runtime.eventStore.query({ session_id: SESSION })).events).toHaveLength(0);

    // boot settle（ok）→ 暂存事件按序处理（session/start + claim/update 入链）
    resolveBoot(okBoot(root));
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000, interval: 10 },
    );
    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    expect(evs.some((e) => e.type === 'session/start')).toBe(true);
  });

  it('boot ok（立即 resolve）→ prepareTurn 正常：投影注入 + context/injected 入链；无降级记录', async () => {
    const runtime = track(createCognitiveRuntime({ root }));
    const { ctx, contexts } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(okBoot(root)) });

    const provider = projectionProvider(contexts);
    const assembleCtx = makeAssembleCtx([userEvent('msg-1', GOAL)]);
    expect(provider(assembleCtx)).toBe('');
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'context/injected')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    expect(provider(assembleCtx)).toContain(GOAL);
    expect(degradationLog().some((r) => r.hook === 'cognitive/boot')).toBe(false);
  });

  it('boot 失败（无恢复路径）→ 认知降级（cognitive/boot + boot/stable 记录）、仅命令模式：provider 恒空串、事件不入链、/mode 空输入可用、/evolve now 明确 error', async () => {
    const runtime = track(createCognitiveRuntime({ root }));
    const { ctx, bus, contexts, captured } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false, bootStableOverride: () => Promise.resolve(failBoot()) });

    // 认知不进入服务：provider 恒空串（gate 首次调用即记录认知侧降级）、无 context/injected；事件不入链
    const provider = projectionProvider(contexts);
    expect(provider(makeAssembleCtx([userEvent('msg-1', GOAL)]))).toBe('');
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1001));
    await new Promise((r) => setTimeout(r, 20));
    expect((await runtime.eventStore.query({ session_id: SESSION })).events).toHaveLength(0);

    // 命令仍可用：/mode 空输入返回当前线（不触认知 gate）
    const mode = captured.find((c) => c.name === 'mode')!;
    const cur = await mode.handler({ commandId: 'c', agent: { session: { id: SESSION, events: [] } }, rawInput: '', signal: undefined });
    expect(cur.kind).toBe('success');
    expect(cur.text).toContain('当前版本线：stable');

    // /evolve now → 明确 error（认知不进入服务；仅命令模式）
    const evolve = captured.find((c) => c.name === 'evolve')!;
    const ev = await evolve.handler({ commandId: 'c', agent: { session: { id: SESSION, events: [] } }, rawInput: 'now', signal: undefined });
    expect(ev.kind).toBe('error');
    expect(ev.text).toContain('仅命令模式');

    // 降级记录：既有 boot/stable（无恢复路径）+ 认知侧 cognitive/boot（gate 首次调用后记录，一次性）
    await vi.waitFor(
      () => {
        expect(degradationLog().some((r) => r.hook === 'boot/stable')).toBe(true);
        expect(degradationLog().some((r) => r.hook === 'cognitive/boot')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
  });
});
