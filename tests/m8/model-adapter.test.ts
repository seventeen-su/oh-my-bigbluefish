// T8.12 llmGenerate 真实注入测试（runtime/generator.ts + runtime/model-adapter.ts +
// kernel/schemas/model-adapter.ts 契约；架构 §5.3 Generate 阶梯 / §12.2 装配）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① ModelAdapter 注入（无 llmGenerate）→ OOD 任务走 LLM 路径：fake 返回合法 ProcessDef JSON →
//      method=generate + 产物过 schema + 预算守卫
//   ② 提示构造：传给 adapter 的 prompt 含 goal/applicability/过程库摘要（HYPOTHESIZE 路径）
//   ③ 产物超预算 → none/budget（预算守卫；生成产物过 ProcessDef schema 后才查预算）
//   ④ 产物非法（非 JSON / schema 不过）→ none/validation
//   ⑤ adapter 抛错 → none（reason 含执行失败）
//   ⑥ llmGenerate 与 modelAdapter 并存 → llmGenerate 优先（modelAdapter 未被调用）
//   ⑦ 既有 llmGenerate 注入契约回归不破坏（method=generate，M4 契约）
//   ⑧ createDshModelAdapter：text-delta 流 → 拼装文本 + usage（token 计数）
//   ⑨ createDshModelAdapter：finish error → generate rejects（受限降级路径文档化）
//   ⑩ parseProcessJson 容忍代码围栏 / 非法 → null；buildHypothesizePrompt 结构断言
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHypothesizePrompt,
  parseProcessJson,
  ProcessGenerator,
  type WorkingState,
} from '../../runtime/generator.js';
import { createDshModelAdapter, type LlmStreamLike } from '../../runtime/model-adapter.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import type { ModelAdapter, ModelGenerateResult } from '../../kernel/schemas/model-adapter.js';
import type { ProcessDef } from '../../kernel/policy-loader.js';

// ---- 测试工具 ----

/** 合法 ProcessDef JSON（RETRIEVE → STOP，成本 200 ≤ 预算） */
function validProcessJson(): string {
  return JSON.stringify({
    id: 'llm-hyp',
    version: '1.0.0',
    entry: 'RETRIEVE',
    exit: 'STOP',
    budget: { tokens: 200 },
    operators: [
      {
        id: 'r',
        op: 'RETRIEVE',
        input_binding: {},
        output: 'pack',
        cost: { tokens: 100 },
        verification: 'v',
        error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'none' },
      },
      {
        id: 's',
        op: 'STOP',
        input_binding: {},
        output: 'report',
        cost: { tokens: 100 },
        verification: 'v',
        error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'none' },
      },
    ],
  });
}

/** 记录调用的 fake adapter（可覆盖 generate 行为） */
function fakeAdapter(over: Partial<ModelAdapter> = {}): ModelAdapter & { calls: string[] } {
  const calls: string[] = [];
  const adapter: ModelAdapter = {
    provider: 'test',
    model: 'fake',
    async generate(prompt): Promise<ModelGenerateResult> {
      calls.push(prompt);
      return { text: validProcessJson(), usage: { inputTokens: 10, outputTokens: 20 } };
    },
    ...over,
  };
  return Object.assign(adapter, { calls });
}

const oodTask = (state: WorkingState = {}): Parameters<ProcessGenerator['generate']>[0] => ({
  goal: '量子引力 全息对偶',
  state,
  applicability: 'OOD',
});

// ---- 主测试 ----

describe('① ModelAdapter 注入 → OOD 任务 LLM 路径（生成产物过 schema + 预算守卫）', () => {
  it('fake adapter 返回合法 ProcessDef JSON → method=generate + 产物过校验 + 预算内', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({ processes: [], budget: 1000, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('generate');
    expect(res.process).not.toBeNull();
    expect(res.process!.id).toBe('llm-hyp');
    expect(adapter.calls).toHaveLength(1);
  });

  it('产物超预算（预算守卫：schema 过但成本超）→ none/budget', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({ processes: [], budget: 100, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.process).toBeNull();
    expect(res.method).toBe('none');
    expect(res.reason).toMatch(/budget/);
  });

  it('预算 < 最小过程图成本 → 阶梯入口预算预检拦截（modelAdapter 不被调用）', async () => {
    const adapter = fakeAdapter();
    // 库非空：最小过程成本 200 > 预算 50 → 预检拦截（任何阶梯产物都不可负担）
    const library = [JSON.parse(validProcessJson()) as ProcessDef];
    const gen = new ProcessGenerator({ processes: library, budget: 50, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toMatch(/budget/);
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('② 提示构造（HYPOTHESIZE 路径：goal/applicability/过程库）', () => {
  it('传给 adapter 的 prompt 含 goal 与 applicability；buildHypothesizePrompt 结构含过程库摘要', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({ processes: [], budget: 1000, modelAdapter: adapter });
    await gen.generate(oodTask());
    const prompt = adapter.calls[0]!;
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    expect(parsed.goal).toBe('量子引力 全息对偶');
    expect(parsed.applicability).toBe('OOD');
    expect(Array.isArray(parsed.process_library)).toBe(true);
    // 直接调用 buildHypothesizePrompt：含指令与过程库字段
    const p = buildHypothesizePrompt(oodTask(), []);
    const pp = JSON.parse(p) as Record<string, unknown>;
    expect(pp.goal).toBe('量子引力 全息对偶');
    expect(pp.instruction).toContain('ProcessDef');
    expect(pp.process_library).toEqual([]);
  });
});

describe('④ 产物非法 → none/validation', () => {
  it('非 JSON 文本 → none（reason validation）', async () => {
    const adapter = fakeAdapter({ generate: async () => ({ text: '这不是 JSON' }) });
    const gen = new ProcessGenerator({ processes: [], budget: 1000, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toMatch(/validation|schema/);
  });

  it('JSON 但 schema 不过（非法算子）→ none/validation', async () => {
    const adapter = fakeAdapter({
      generate: async () => ({ text: JSON.stringify({ id: 'x', version: '1.0.0', entry: 'RETRIEVE', exit: 'STOP', budget: { tokens: 1 }, operators: [{ id: 'n', op: 'NOPE', input_binding: {}, output: 'o', cost: { tokens: 1 }, verification: 'v', error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'none' } }] }) }),
    });
    const gen = new ProcessGenerator({ processes: [], budget: 1000, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toMatch(/validation|schema/);
  });
});

describe('⑤ adapter 抛错 → none（reason 含执行失败）', () => {
  it('generate 抛错 → none + 失败文案', async () => {
    const adapter = fakeAdapter({
      generate: async () => {
        throw new Error('provider down');
      },
    });
    const gen = new ProcessGenerator({ processes: [], budget: 1000, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toMatch(/执行失败|provider down/);
  });
});

describe('⑥ llmGenerate 与 modelAdapter 并存 → llmGenerate 优先', () => {
  it('llmGenerate 注入 → method=generate；modelAdapter 未被调用', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      llmGenerate: async () => JSON.parse(validProcessJson()) as ProcessDef,
      modelAdapter: adapter,
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('generate');
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('⑦ 既有 llmGenerate 注入契约回归不破坏（M4 契约）', () => {
  it('直接注入 llmGenerate → method=generate（与 m4 语义一致）', async () => {
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      llmGenerate: async () => JSON.parse(validProcessJson()) as ProcessDef,
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('generate');
    expect(res.process?.id).toBe('llm-hyp');
  });
});

describe('⑧ createDshModelAdapter（DSH LlmRuntime.stream 结构最小接口适配）', () => {
  it('text-delta 流 → 拼装文本 + usage token 计数', async () => {
    const llm: LlmStreamLike = {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"id":' };
        yield { type: 'text-delta', index: 0, text: '"ok"}' };
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'deepseek', model: 'deepseek-chat' });
    expect(adapter.provider).toBe('deepseek');
    expect(adapter.model).toBe('deepseek-chat');
    const res = await adapter.generate('hi', { system: 'sys', maxTokens: 100 });
    expect(res.text).toBe('{"id":"ok"}');
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  it('仅 block-end 流（无 text-delta）→ 回退取 block-end.text', async () => {
    const llm: LlmStreamLike = {
      stream: async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'FALLBACK' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm' });
    expect((await adapter.generate('x')).text).toBe('FALLBACK');
  });
});

describe('⑨ createDshModelAdapter：finish error → generate rejects（受限降级文档化）', () => {
  it('finish reason=error → reject（模型调用失败显式化，不静默返回空文本）', async () => {
    const llm: LlmStreamLike = {
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'NO_ADAPTER', code: 'NO_ADAPTER' } } };
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm' });
    await expect(adapter.generate('x')).rejects.toThrow(/NO_ADAPTER|失败/);
  });

  it('流抛错 → reject 透传', async () => {
    const llm: LlmStreamLike = {
      stream: async function* () {
        throw new Error('stream broken');
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm' });
    await expect(adapter.generate('x')).rejects.toThrow(/stream broken/);
  });
});

describe('⑩ parseProcessJson / buildHypothesizePrompt 边界', () => {
  it('parseProcessJson：直接 JSON / 代码围栏 JSON → 合法 ProcessDef；非 JSON / 非法 → null', () => {
    expect(parseProcessJson(validProcessJson())?.id).toBe('llm-hyp');
    expect(parseProcessJson('```json\n' + validProcessJson() + '\n```')?.id).toBe('llm-hyp');
    expect(parseProcessJson('not json')).toBeNull();
    expect(parseProcessJson(JSON.stringify({ id: 'x' }))).toBeNull();
  });
});

describe('⑪ 装配：ModelAdapter 经组合根注入认知运行时（T8.12 deps 注入）', () => {
  it('createCognitiveRuntime({ modelAdapter }) → runtime.modelAdapter 注入；未注入 → null（缺省受限）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-ma-assembly-'));
    try {
      const adapter = fakeAdapter();
      const withAdapter = createCognitiveRuntime({ root: base, modelAdapter: adapter });
      expect(withAdapter.modelAdapter).toBe(adapter);
      await withAdapter.close();
      const without = createCognitiveRuntime({ root: base });
      expect(without.modelAdapter).toBeNull();
      await without.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('plugin apply：llm + config.model 齐备 → 自动装配 ModelAdapter 注入认知运行时；缺失 → 受限', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-ma-plugin-'));
    try {
      const captured: Array<{ name: string; handler: (i: unknown) => unknown }> = [];
      const llm: LlmStreamLike = {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
      const ctx: ContextLike = {
        commands: { register: (d: unknown) => captured.push(d as { name: string; handler: (i: unknown) => unknown }) },
        llm,
      };
      const handle = apply(ctx, { cognitiveRoot: base, model: { provider: 'deepseek', model: 'deepseek-chat' } });
      expect(captured.map((c) => c.name)).toEqual(expect.arrayContaining(['mode', 'bench']));
      const runtime = handle.cognitive as unknown as { modelAdapter: ModelAdapter | null; close(): Promise<void> };
      expect(runtime.modelAdapter).not.toBeNull();
      expect(runtime.modelAdapter!.provider).toBe('deepseek');
      expect(runtime.modelAdapter!.model).toBe('deepseek-chat');
      // 真实调用路径：adapter 走 llm.stream（fake stream → 空文本，不抛错）
      expect((await runtime.modelAdapter!.generate('goal')).text).toBe('');
      await runtime.close();

      // 无 llm → 缺省受限（modelAdapter null）
      const ctxNoLlm: ContextLike = {
        commands: { register: () => undefined },
      };
      const handleNoLlm = apply(ctxNoLlm, { cognitiveRoot: base });
      const runtimeNoLlm = handleNoLlm.cognitive as unknown as {
        modelAdapter: ModelAdapter | null;
        close(): Promise<void>;
      };
      expect(runtimeNoLlm.modelAdapter).toBeNull();
      await runtimeNoLlm.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
