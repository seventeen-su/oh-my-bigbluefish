// T8.26.3 行为测试：systemPrompt.context 钩子接线（Loop Integration 专项 §3.1/§4）。
// 严格 TDD：本文件先于实现编写——apply() 尚未注册 context 贡献 → RED（注册断言失败）。
// 覆盖：
//   注册断言：apply(fakeCtx) → systemPrompt.context 注册项存在（name/order/text 函数）
//   求值：text(assembleCtx) 调用 prepareTurn 并返回投影文本（含 working_state 投影 → goal 可见）
//   Model-visible ⟺ logged：注入发生时 context/injected 事件入链（摘要 + total_tokens）
//   守卫降级：无 systemPrompt → 不抛；无 cognitive（未装配）→ 求值返回空串不抛
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';

const SESSION = 'sess-t8.26.3-1';
const GOAL = '量子引力 全息对偶';

/** DSH session 事件的最小形状（assembleCtx.agent.session.events 里的项） */
interface FakeDshEvent {
  type?: string;
  data?: unknown;
  seq?: number;
  time?: number;
}

/** fake assembleCtx（DSH assembleContextFor 的结构最小面：{ agent, scope, signal }） */
function makeAssembleCtx(events: FakeDshEvent[] = []): { agent: { session: { id: string; events: FakeDshEvent[] } } } {
  return { agent: { session: { id: SESSION, events } } };
}

/** 捕获 systemPrompt.context 注册的 fake ctx */
function makeFakeCtx(opts: {
  runtime?: CognitiveRuntime;
  withSystemPrompt?: boolean;
}): { ctx: ContextLike; contexts: Array<{ name: string; order: number; text: unknown }> } {
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
  };
  return { ctx, contexts };
}

/** W5：按名取投影 section（context 现注册 contract(80)/capabilities(85)/projection(90) 三段——order 小者在前） */
function projectionProvider(contexts: Array<{ name: string; order: number; text: unknown }>): (assembleCtx: unknown) => string {
  const def = contexts.find((c) => c.name === 'cognitive:projection')!;
  return def.text as (assembleCtx: unknown) => string;
}

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-hctx-'));
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

describe('T8.26.3 systemPrompt.context 钩子（plugin.ts apply）', () => {
  it('注册断言：apply(fakeCtx) → systemPrompt.context 注册三段（order 80/85/90 存在）——name=cognitive:contract/capabilities/projection、text 分别为静态常量/同步文本/函数', () => {
    const { ctx, contexts } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })) });
    apply(ctx, { bootstrap: false });
    // W5：三层结构——第一层固定契约（80）+ 第二层动态能力（85）+ 既有投影（90）；order 小者在前
    expect(contexts.map((c) => c.name)).toEqual(['cognitive:contract', 'cognitive:capabilities', 'cognitive:projection']);
    expect(contexts.map((c) => c.order)).toEqual([80, 85, 90]);
    expect(typeof contexts.find((c) => c.name === 'cognitive:contract')!.text).toBe('string');
    expect(typeof contexts.find((c) => c.name === 'cognitive:capabilities')!.text).toBe('string');
    const projection = contexts.find((c) => c.name === 'cognitive:projection')!;
    expect(typeof projection.order).toBe('number');
    expect(typeof projection.text).toBe('function');
  });

  it('求值：text(assembleCtx) 调用 prepareTurn 并返回投影文本（含 working_state 投影 → goal 可见）；context/injected 入链（配 total_tokens）', async () => {
    const { ctx, contexts } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })) });
    apply(ctx, { bootstrap: false });
    const provider = projectionProvider(contexts);
    const assembleCtx = makeAssembleCtx([
      { type: 'user/message', data: { id: 'msg-1', content: [{ type: 'text', text: GOAL }], source: { kind: 'user' } } },
    ]);

    // 首次求值：prepareTurn 异步进行中 → 返回空串（无缓存投影，空内容不贡献）
    expect(provider(assembleCtx)).toBe('');

    // 等待 prepareTurn 完成：context/injected 事件入链（Model-visible ⟺ logged：注入对应事件）
    await vi.waitFor(
      async () => {
        const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
        expect(evs.some((e) => e.type === 'context/injected')).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );

    // 再次求值：返回缓存投影文本 → working_state 投影可见（goal 文本出现在投影中）
    const text = provider(assembleCtx);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(GOAL);

    // Model-visible ⟺ logged：注入文本对应的 context/injected 事件带投影摘要（projection_id/total_tokens）
    const evs = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const injected = evs.find((e) => e.type === 'context/injected')!;
    const payload = injected.payload as Record<string, unknown>;
    expect(typeof payload.projection_id).toBe('string');
    expect(typeof payload.total_tokens).toBe('number');
    expect((payload.total_tokens as number) > 0).toBe(true);
  });

  it('守卫降级：无 systemPrompt（接口缺失）→ apply 不抛、不注册，且记录降级', () => {
    const { ctx, contexts } = makeFakeCtx({ runtime: track(createCognitiveRuntime({ root })), withSystemPrompt: false });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    expect(contexts).toHaveLength(0);
    expect(degradationLog().some((r) => r.hook === 'systemPrompt.context')).toBe(true);
  });

  it('守卫降级：无 cognitive（未装配）→ 不注册 context（无认知注入，命令仍可用）+ 记录降级（不抛）', () => {
    const { ctx, contexts } = makeFakeCtx({ withSystemPrompt: true });
    expect(() => apply(ctx, { bootstrap: false })).not.toThrow();
    expect(contexts).toHaveLength(0);
    expect(degradationLog().some((r) => r.hook === 'cognitive-runtime')).toBe(true);
  });
});
