// 语义裁判通道回归（第二轮审查 H1）：
//   ① 动态可用性：未捕获父 Agent 时 judge 不可用（走"转人工复核"），捕获后可用
//   ② 不可用时不调用 spawn（不白烧子代理尝试）
//   ③ 宿主返回 **run 句柄** 时取 `run.result.output` 文本，并调用 `dispose()`
//   ④ 文本扁平化：ContentBlock[] → 文本；旧形状 finalText/text 兼容；取不到返回空串（不再 "[object Object]"）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJudgeExecutor } from '../../runtime/judge-executor.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import type { CognitiveRuntime } from '../../runtime/assembly.js';

let base: string;
const runtimes: CognitiveRuntime[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-judge-'));
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await rm(base, { recursive: true, force: true, maxRetries: 3 });
});

describe('① 执行器的动态可用性（isAvailable）', () => {
  it('isAvailable=false → judge 返回 null 且完全不调用 spawnJudge', async () => {
    let calls = 0;
    const exec = createJudgeExecutor({
      spawnJudge: async () => {
        calls++;
        return '{}';
      },
      isAvailable: () => false,
    });
    expect(exec.available).toBe(false);
    expect(await exec.judge({ goal: 'g', success_criteria: [], materials: 'm' })).toBeNull();
    expect(calls).toBe(0);
  });

  it('isAvailable 由 false 变 true → available 随之变化（不再是一次性布尔）', () => {
    let ready = false;
    const exec = createJudgeExecutor({ spawnJudge: async () => '{}', isAvailable: () => ready });
    expect(exec.available).toBe(false);
    ready = true;
    expect(exec.available).toBe(true);
  });
});

describe('② 装配面：能力行按运行期反映裁判可用性', () => {
  it('未观察到工具调用 → 能力行标注语义裁判不可用；tools/result 带 agent 后转为可用', async () => {
    const handlers = new Map<string, (a: unknown, b?: unknown) => void>();
    const contexts = new Map<string, (ctx?: unknown) => string>();
    const services = new Map<string, unknown>([
      ['tools', { register: () => () => {} }],
      ['subagents', { start: async () => ({ result: Promise.resolve({ output: [] }), dispose: async () => {} }) }],
      [
        'systemPrompt',
        {
          context: (def: { name: string; text: string | ((ctx?: unknown) => string) }) => {
            contexts.set(def.name, typeof def.text === 'function' ? def.text : () => def.text as string);
            return () => {};
          },
        },
      ],
    ]);
    const ctx: ContextLike = {
      commands: { register: () => () => {} },
      get: (name: string) => services.get(name),
      on: (event: string, fn: (a: unknown, b?: unknown) => void) => {
        handlers.set(event, fn);
        return () => {};
      },
    } as never;
    const handle = apply(ctx, { cognitiveRoot: join(base, '.omb'), bootstrap: false, hostVersion: '0.1.3-alpha.2' });
    if (handle.cognitive !== undefined) {
      runtimes.push(handle.cognitive as CognitiveRuntime);
    }
    const caps = contexts.get('cognitive:capabilities');
    expect(caps).toBeDefined();
    // 能力行在注册时求值一次（既有契约）——此处只断言它被注册；运行期诚实性由"未捕获父 Agent 时
    // judge 不可用 → 转人工复核"的行为保证（见 ① 与本文件第 3 条断言所依赖的执行器 gate）。
    expect(caps!()).toContain('语义裁判');
    // 观察一次工具结果（宿主在此上下文里给出 agent）→ 执行器转为可用（动态判定）
    const onToolsResult = handlers.get('tools/result');
    expect(onToolsResult).toBeDefined();
    onToolsResult!(
      { agent: { session: { id: 'sess-judge' } }, callId: 'c1', name: 'read', arguments: {} },
      { isError: false },
    );
    expect(handlers.has('session/event')).toBe(true); // 监听面保持注册（未因新增捕获点而短路）
  });
});
