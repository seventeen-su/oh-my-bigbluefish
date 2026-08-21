// layer 2：DSH 模型调用适配器装配（架构 §5.3 Generate 阶梯 LLM 路径 / §12.2 组合根；施工计划 T8.12）。
// 生产适配器经 DSH LlmRuntime.stream 装配（结构最小接口 LlmStreamLike——本 preset 不 import
// '@deepseek-ai/dsh-llm'，以最小结构类型化 ctx.llm，运行时以存在性守卫装配，同 plugin.ts 先例）；
// 流协议按 DSH StreamChunk（packages/llm/llm/src/types.ts）：
//   text-delta{index,text} 逐块增量 → 拼装文本；block-end{index,block} 携带完整块（text-delta
//   缺失时回退）；usage{usage:{inputTokens,outputTokens}} → token 计数；finish{reason} 终止——
//   reason.kind ∈ {stop, tool-calls, max-tokens} 正常；error/aborted → 抛错（受限降级文档化：
//   模型调用失败显式化，绝不静默返回空文本冒充生成）。
// 无真实 DSH 会话 → 不装配 adapter（缺省受限：generator 走纯规则阶梯，不注入任何假生成器）。
// layer 2（runtime/）：仅 import node: 内置 + kernel/schemas/（同层契约）+ runtime/ 内文件。
import type { ModelAdapter, ModelGenerateResult, ModelUsage } from '../kernel/schemas/model-adapter.js';

/** DSH LlmRuntime.stream 的 GenerateOptions 最小结构（真实类型 @deepseek-ai/dsh-llm，不引包） */
export interface LlmStreamOptionsLike {
  provider: string;
  model: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

/** DSH LlmRuntime.stream 的最小结构接口（AsyncIterable<StreamChunk-like>） */
export interface LlmStreamLike {
  stream(options: LlmStreamOptionsLike): AsyncIterable<unknown>;
}

/** 装配参数：provider 路由 + model id */
export interface DshModelAdapterOptions {
  provider: string;
  model: string;
}

/**
 * 从 DSH llm 服务装配 ModelAdapter：prompt → user 消息 → llm.stream → 拼装文本 + usage。
 * 流抛错或 finish reason=error/aborted → reject（模型调用失败显式化）。
 */
export function createDshModelAdapter(llm: LlmStreamLike, opts: DshModelAdapterOptions): ModelAdapter {
  return {
    provider: opts.provider,
    model: opts.model,
    async generate(prompt, genOpts = {}): Promise<ModelGenerateResult> {
      const stream = llm.stream({
        provider: opts.provider,
        model: opts.model,
        messages: [{ role: 'user', content: prompt }],
        ...(genOpts.system === undefined ? {} : { system: genOpts.system }),
        ...(genOpts.temperature === undefined ? {} : { temperature: genOpts.temperature }),
        ...(genOpts.maxTokens === undefined ? {} : { maxTokens: genOpts.maxTokens }),
      });
      let text = '';
      let sawDelta = false;
      let blockEndText: string | undefined;
      let usage: ModelUsage | undefined;
      let finishError: string | undefined;
      for await (const raw of stream) {
        if (raw === null || typeof raw !== 'object') {
          continue;
        }
        const chunk = raw as Record<string, unknown>;
        switch (chunk.type) {
          case 'text-delta':
            if (typeof chunk.text === 'string') {
              text += chunk.text;
              sawDelta = true;
            }
            break;
          case 'block-end': {
            const block = chunk.block;
            if (block !== null && typeof block === 'object') {
              const b = block as Record<string, unknown>;
              if (b.type === 'text' && typeof b.text === 'string') {
                blockEndText = b.text;
              }
            }
            break;
          }
          case 'usage': {
            const u = chunk.usage;
            if (u !== null && typeof u === 'object') {
              const usageChunk = u as Record<string, unknown>;
              if (typeof usageChunk.inputTokens === 'number' && typeof usageChunk.outputTokens === 'number') {
                usage = { inputTokens: usageChunk.inputTokens, outputTokens: usageChunk.outputTokens };
              }
            }
            break;
          }
          case 'finish': {
            const reason = chunk.reason;
            if (reason !== null && typeof reason === 'object') {
              const r = reason as Record<string, unknown>;
              if (r.kind === 'error' || r.kind === 'aborted') {
                const f = r.failure as Record<string, unknown> | null | undefined;
                finishError = f !== null && f !== undefined && typeof f.message === 'string'
                  ? f.message
                  : `finish reason=${String(r.kind)}`;
              }
            }
            break;
          }
          default:
            break;
        }
      }
      if (finishError !== undefined) {
        throw new Error(`dsh model adapter: 模型调用失败（${opts.provider}/${opts.model}）— ${finishError}`);
      }
      const finalText = sawDelta ? text : (blockEndText ?? '');
      return { text: finalText, ...(usage === undefined ? {} : { usage }) };
    },
  };
}
