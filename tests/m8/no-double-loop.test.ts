// T8.26.7 无双 Loop 验证测试：DSH Agent Loop 未被替换/包装（Loop Integration 专项 §1 硬约束 / §6 验收 4）。
// 证据面（钩子实现审查 + 动态断言）：
//   a. 监听面审查（静态）：apply() 注册的 ctx.on 监听仅为观察型事件（session/event、session/flush、tools/result）——
//      无任何模型调用/消息分发的拦截监听（模型调用归 DSH Agent Loop）
//   b. ctx.llm 未被包装/替换：装配 ModelAdapter 只读 ctx.llm（新对象闭包捕获），llm 引用与方法身份不变
//   c. 模型调用零介入（动态）：完整模拟会话（三钩子全链：prepareTurn 注入 → 事件入链 → flush 收尾）期间
//      llm.stream 从未被调用——OMB 钩子不驱动、不拦截、不包装模型调用
//   d. systemPrompt 为追加贡献而非替换：仅调用 context()（additive section，cognitive:projection），无替换型 API
//   e. 插件不再接触 agentPresets.recompose（recompose 能力已整体移除——/mode = OMB 内部版本线切换，单模式）
//   f. 命令注册仅为 DSH 扩展点（mode/bench 两个），无 loop 控制命令
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';
import type { LlmStreamLike } from '../../runtime/model-adapter.js';

const SESSION = 'sess-t8.26.7-loop';
const GOAL = '无双 Loop 验证：模型调用归 DSH';

interface Bus {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emit(event: string, ...args: unknown[]): void;
}

function userMessage(id: string, text: string): unknown {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } };
}

function dshEvent(type: string, data: unknown, time: number): { type: string; data: unknown; time: number } {
  return { type, data, time };
}

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-loop-'));
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

describe('T8.26.7 无双 Loop 验证（DSH Agent Loop 未被替换/包装）', () => {
  it('监听面审查：仅注册观察型事件（session/event、session/flush、tools/result），无模型调用/消息拦截监听', () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const ctx: ContextLike = {
      commands: { register: () => undefined },
      cognitive: track(createCognitiveRuntime({ root })),
      systemPrompt: { context: () => undefined },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(handler);
        listeners.set(event, arr);
      },
    };
    apply(ctx, { bootstrap: false });
    // 三钩子均为观察/注入面；无任何 agent-loop 控制/拦截事件（如 model call、message 分发等）
    expect([...listeners.keys()].sort()).toEqual(['session/event', 'session/flush', 'tools/result']);
  });

  it('ctx.llm 未被包装：装配 ModelAdapter 只读 ctx.llm（引用与方法身份不变）；完整模拟会话期间 llm.stream 零调用', async () => {
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
    const stream = vi.fn(async function* (): AsyncGenerator<never> {
      /* 空流：本测试断言其从未被调用 */
    });
    const llm: LlmStreamLike = { stream };
    const ctx: ContextLike = {
      commands: { register: () => undefined },
      cognitive: track(createCognitiveRuntime({ root })),
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
      llm,
    };
    // config 为 apply 第二参（B3 契约）：model 路由配置经 apply config 传入（ctx 不再承载配置面）
    apply(ctx, { bootstrap: false, model: { provider: 'test', model: 't1' } });

    // ① 装配后 ctx.llm 引用与方法身份不变（未包装/替换：adapter 为捕获 llm 的新对象，不修改原对象）
    expect(ctx.llm).toBe(llm);
    expect(llm.stream).toBe(stream);

    // ② 完整模拟会话（三钩子全链：prepareTurn 注入 → 事件入链 → flush 收尾）——模型调用零介入
    bus.emit('session/event', { id: SESSION }, dshEvent('user/message', userMessage('msg-1', GOAL), 1001));
    const provider = contexts[0]!.text as (assembleCtx: unknown) => string;
    provider({ agent: { session: { id: SESSION, events: [userMessage('msg-1', GOAL)] } } });
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'context/injected')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }, 1002));
    bus.emit('session/event', { id: SESSION }, dshEvent('tool/result', {
      turn: 1,
      step: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok', isError: false }] },
    }, 1003));
    bus.emit('session/event', { id: SESSION }, dshEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2000));
    bus.emit('session/flush', { id: SESSION });
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'decision/made')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );

    // ③ 全链结束：llm.stream 零调用（OMB 钩子不驱动/不拦截模型调用；模型调用归 DSH Agent Loop）
    expect(stream).not.toHaveBeenCalled();
    expect((await runtime.eventStore.query({ session_id: SESSION })).events.some((e) => e.type === 'tool/result')).toBe(true);
  });

  it('systemPrompt 为追加贡献而非替换；插件不再接触 recompose（装配/命令注册零触发）；命令仅注册 mode/bench（DSH 扩展点）', () => {
    const systemPromptCalls: string[] = [];
    const contexts: Array<{ name: string; order: number; text: unknown }> = [];
    const registered: Array<{ name: string }> = [];
    const recompose = vi.fn(async () => ({ ok: true, detail: 'should-not-be-called' }));
    const ctx: ContextLike = {
      commands: {
        register: (def: { name: string }) => {
          registered.push(def);
          return undefined;
        },
      },
      cognitive: track(createCognitiveRuntime({ root })),
      systemPrompt: {
        context: (def: unknown) => {
          systemPromptCalls.push('context');
          contexts.push(def as { name: string; order: number; text: unknown });
        },
      },
      on: () => undefined,
    };
    // ContextLike 已无 agentPresets 面（recompose 能力已从插件移除）——经宽化引用注入，断言插件零接触
    (ctx as { agentPresets?: { recompose: typeof recompose } }).agentPresets = { recompose };
    apply(ctx, { bootstrap: false });

    // d. 仅调用 context()（additive section）；无 section()/替换型 API（若插件调用未定义方法会直接抛错）
    expect(systemPromptCalls).toEqual(['context']);
    expect(contexts[0]!.name).toBe('cognitive:projection');
    expect(typeof contexts[0]!.order).toBe('number');
    // e. 插件不再接触 recompose：即使 ctx 提供 agentPresets.recompose，装配/命令注册也从未触发它
    //   （recompose 能力整体移除；/mode = OMB 内部版本线切换，单模式）
    expect(recompose).not.toHaveBeenCalled();
    // f. 命令注册仅为 DSH 扩展点（mode/bench），无 loop 控制命令
    expect(registered.map((r) => r.name).sort()).toEqual(['bench', 'mode']);
  });
});
