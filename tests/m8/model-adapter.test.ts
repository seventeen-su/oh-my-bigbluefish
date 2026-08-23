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
//   P7 ⑫ 网络瞬时错误重试：fetch failed/ECONNRESET/ETIMEDOUT/5xx/429 → 短退避重试（2 次、间隔 1~2s，
//      仿 LOCK_RETRY 模式）；逻辑错误（400/401/422）不重试直接抛；重试耗尽 → 抛原错误
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
import {
  createDshModelAdapter,
  isRetryableNetworkError,
  type LlmStreamLike,
  type LlmStreamOptionsLike,
} from '../../runtime/model-adapter.js';
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

  it('reasoningEffort 默认 low 且透传到 llm.stream 选项；工厂/调用显式指定则覆盖', async () => {
    const captured: LlmStreamOptionsLike[] = [];
    const llm: LlmStreamLike = {
      stream: async function* (options: LlmStreamOptionsLike) {
        captured.push(options);
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    // 未配置 → 默认 'low'（显式传档位，不依赖 llm-deepseek 默认 high——4000 被推理吃光的根因）
    const adapter = createDshModelAdapter(llm, { provider: 'deepseek', model: 'deepseek-chat' });
    await adapter.generate('hi');
    expect(captured[0]!.reasoningEffort).toBe('low');
    // 工厂级显式档位 → 覆盖默认
    const adapterHigh = createDshModelAdapter(llm, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
    await adapterHigh.generate('hi');
    expect(captured[1]!.reasoningEffort).toBe('high');
    // 调用级显式档位 → 覆盖工厂默认
    await adapter.generate('hi', { reasoningEffort: 'max' });
    expect(captured[2]!.reasoningEffort).toBe('max');
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

// ---- P7 ⑫ 网络瞬时错误重试（真实执行加固：瞬时错误短退避重试，仅网络层错误重试，逻辑错误不重试） ----

describe('P7 ⑫ 网络瞬时错误重试（isRetryableNetworkError / generate 重试循环）', () => {
  /** 快速重试配置（生产缺省 1s/2s 退避；测试注入 0ms 防慢） */
  const FAST_RETRY = { retries: 2, backoffMs: () => 0 };

  it('错误分类：fetch failed/ECONNRESET/ETIMEDOUT/5xx/429 → 可重试；400/401/422 → 不可重试', () => {
    for (const msg of ['fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'socket hang up', '429 Too Many Requests', '502 Bad Gateway', '503 Service Unavailable', '500 Internal Server Error']) {
      expect(isRetryableNetworkError(new Error(msg)), msg).toBe(true);
    }
    for (const msg of ['400 Bad Request', '401 Unauthorized', '422 Unprocessable Entity', 'NO_ADAPTER', 'invalid schema']) {
      expect(isRetryableNetworkError(new Error(msg)), msg).toBe(false);
    }
    expect(isRetryableNetworkError('fetch failed')).toBe(true); // 非 Error 兜底按字符串分类
  });

  it('fake llm 首抛网络错误（fetch failed）→ 重试后成功（stream 被调 2 次）', async () => {
    let calls = 0;
    const llm: LlmStreamLike = {
      stream: async function* () {
        calls++;
        if (calls === 1) {
          throw new Error('fetch failed');
        }
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm', retry: FAST_RETRY });
    const res = await adapter.generate('x');
    expect(res.text).toBe('ok');
    expect(calls).toBe(2); // 第 1 次失败 → 短退避 → 第 2 次成功
  });

  it('finish reason 网络错误（503）→ 重试后成功（重试分类覆盖 finish 显式化路径）', async () => {
    let calls = 0;
    const llm: LlmStreamLike = {
      stream: async function* () {
        calls++;
        if (calls === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: '503 Service Unavailable', code: 'HTTP_503' } } };
          return;
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm', retry: FAST_RETRY });
    expect((await adapter.generate('x')).text).toBe('');
    expect(calls).toBe(2);
  });

  it('逻辑错误（400）→ 不重试直接抛（stream 仅被调 1 次）', async () => {
    let calls = 0;
    const llm: LlmStreamLike = {
      stream: async function* () {
        calls++;
        throw new Error('400 Bad Request');
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm', retry: FAST_RETRY });
    await expect(adapter.generate('x')).rejects.toThrow(/400 Bad Request/);
    expect(calls).toBe(1);
  });

  it('逻辑错误（finish 422）→ 不重试直接抛', async () => {
    let calls = 0;
    const llm: LlmStreamLike = {
      stream: async function* () {
        calls++;
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '422 Unprocessable Entity', code: 'HTTP_422' } } };
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm', retry: FAST_RETRY });
    await expect(adapter.generate('x')).rejects.toThrow(/422/);
    expect(calls).toBe(1);
  });

  it('重试耗尽 → 抛原错误（3 次尝试全失败，错误信息保留不包装）', async () => {
    let calls = 0;
    const llm: LlmStreamLike = {
      stream: async function* () {
        calls++;
        throw new Error('ECONNRESET');
      },
    };
    const adapter = createDshModelAdapter(llm, { provider: 'p', model: 'm', retry: FAST_RETRY });
    await expect(adapter.generate('x')).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(3); // 初始 1 + 重试 2
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
      const handle = apply(ctx, { cognitiveRoot: base, model: { provider: 'deepseek', model: 'deepseek-chat' }, bootstrap: false });
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
      const handleNoLlm = apply(ctxNoLlm, { cognitiveRoot: base, bootstrap: false });
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
