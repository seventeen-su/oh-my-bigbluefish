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

/** DSH LlmRuntime.stream 的 GenerateOptions 最小结构（真实类型 @deepseek-ai/dsh-llm，不引包）。
 *  消息 content 为内容块数组（ContentBlock[]：{type:'text',text} 等）——DSH 全链路
 *  （image 策略/序列化）按数组处理，字符串 content 会在 contentHasImage 处抛
 *  "content.some is not a function"（真实 /bench 实测暴露）。 */
export interface LlmStreamOptionsLike {
  provider: string;
  model: string;
  messages: ReadonlyArray<{ role: string; content: ReadonlyArray<{ type: string; text: string }> }>;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** DSH GenerateOptions.reasoningEffort（llm/types.ts:346；合法值以 llm-deepseek 契约为准：off|low|high|max） */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max';
}

/** DSH LlmRuntime.stream 的最小结构接口（AsyncIterable<StreamChunk-like>） */
export interface LlmStreamLike {
  stream(options: LlmStreamOptionsLike): AsyncIterable<unknown>;
}

// ---- P7：网络瞬时错误重试（真实执行加固——用户曾提议：瞬时错误短退避重试，仅网络层错误重试，逻辑错误不重试） ----

/** 网络层瞬时错误消息特征（fetch failed / ECONNRESET / ETIMEDOUT / 5xx / 429 等；逻辑错误 400/401/422 不匹配） */
const NETWORK_ERROR_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNREFUSED|UND_ERR|network|timeout|timed out|Too Many Requests|429|5\d\d/i;

/**
 * 错误分类（P7）：网络层瞬时错误（可重试）vs 逻辑错误（不可重试）。
 * 匹配面：message 中的网络特征（undici fetch failed / 系统 errno 码 / socket hang up /
 * 状态码 429/5xx——DSH 流协议不暴露 HTTP 状态，按消息特征分类，文档化）。
 * 逻辑错误（400/401/422 等）不匹配 → false（不重试，直接抛）。
 */
export function isRetryableNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NETWORK_ERROR_RE.test(message);
}

/** P7：重试选项（缺省 retries=2、退避 1s/2s——仿项目既有 LOCK_RETRY 短退避模式（tests/helpers/git.ts）） */
export interface DshModelAdapterRetryOptions {
  /** 网络瞬时错误重试次数（每次尝试间短退避；缺省 2 = 共 3 次尝试） */
  retries?: number;
  /** 第 attempt 次重试的退避毫秒（attempt 从 1 起；缺省 1000·attempt → 1s/2s） */
  backoffMs?: (attempt: number) => number;
}

/** 缺省重试参数（P7：2 次、间隔 1~2s） */
export const DEFAULT_RETRY: Required<DshModelAdapterRetryOptions> = {
  retries: 2,
  backoffMs: (attempt) => attempt * 1000,
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 装配参数：provider 路由 + model id + 推理档位（可选，默认 low） */
export interface DshModelAdapterOptions {
  provider: string;
  model: string;
  /**
   * 推理档位（DSH GenerateOptions.reasoningEffort，合法值 'off'|'low'|'high'|'max'）。
   * 默认 'low'：显式控制推理预算，防止小 maxTokens 被推理吃光——真实 /bench 实测
   * maxTokens=4000 被 llm-deepseek 默认 high 的推理吃光、text 零输出（research-03
   * raw_text 全空、model_tokens=4012）。基准/生成调用默认 low 即够，需要深度推理时可配 high/max。
   */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max';
  /** P7：网络瞬时错误重试（缺省 2 次、间隔 1~2s；逻辑错误不重试）——测试注入小退避加速 */
  retry?: DshModelAdapterRetryOptions;
}

/**
 * 从 DSH llm 服务装配 ModelAdapter：prompt → user 消息 → llm.stream → 拼装文本 + usage。
 * 流抛错或 finish reason=error/aborted → reject（模型调用失败显式化）。
 * P7 网络瞬时错误重试：fetch failed/ECONNRESET/ETIMEDOUT/5xx/429 → 短退避重试（缺省 2 次、1s/2s）；
 * 逻辑错误（400/401/422 等）不重试直接抛；重试耗尽 → 抛原错误（不包装，保留原始信息）。
 */
export function createDshModelAdapter(llm: LlmStreamLike, opts: DshModelAdapterOptions): ModelAdapter {
  const reasoningEffort = opts.reasoningEffort ?? 'low';
  const retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
  return {
    provider: opts.provider,
    model: opts.model,
    async generate(prompt, genOpts = {}): Promise<ModelGenerateResult> {
      /** 单次流执行（流协议拼装 + finish/error 显式化）；网络瞬时错误原样上抛供外层重试分类 */
      const runOnce = async (): Promise<ModelGenerateResult> => {
        const stream = llm.stream({
          provider: opts.provider,
          model: opts.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          ...(genOpts.system === undefined ? {} : { system: genOpts.system }),
          ...(genOpts.temperature === undefined ? {} : { temperature: genOpts.temperature }),
          ...(genOpts.maxTokens === undefined ? {} : { maxTokens: genOpts.maxTokens }),
          // 始终显式传推理档位（调用未指定 → 工厂默认 'low'）：不依赖 llm-deepseek 默认 high，
          // 防止推理独占输出预算；genOpts 显式指定（如 high/max）则覆盖。
          reasoningEffort: genOpts.reasoningEffort ?? reasoningEffort,
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
          // 显式化失败（含网络瞬时特征时外层可重试；逻辑失败信息原样保留）
          throw new Error(`dsh model adapter: 模型调用失败（${opts.provider}/${opts.model}）— ${finishError}`);
        }
        const finalText = sawDelta ? text : (blockEndText ?? '');
        return { text: finalText, ...(usage === undefined ? {} : { usage }) };
      };

      // P7：网络瞬时错误短退避重试（仅网络层错误重试；逻辑错误不重试直接抛；重试耗尽抛原错误）
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retry.retries; attempt++) {
        try {
          return await runOnce();
        } catch (err) {
          lastErr = err;
          if (!isRetryableNetworkError(err)) {
            throw err; // 逻辑错误（400/401/422 等）→ 不重试
          }
          if (attempt < retry.retries) {
            await sleepMs(retry.backoffMs(attempt + 1));
          }
        }
      }
      throw lastErr;
    },
  };
}
