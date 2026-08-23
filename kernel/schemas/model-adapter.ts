// OMB v2 ModelAdapter 契约（架构 §5.3 Generate 阶梯 LLM 路径 / §12.2 装配；施工计划 T8.12）。
// 纯类型 + zod schema（P3 机制即数据）：无 I/O、无副作用——契约层（CONVENTIONS §4 例外：
// 仅 supervisor(1) → kernel/schemas/ 放行；runtime(2)/memory(2) 同层 import 亦合法）。
// 形态（brief 关键约束）：generate(prompt, opts) → text；测试用 fake adapter（契约回归不破坏）；
// 无真实 DSH 会话时缺省受限（runtime/model-adapter.ts 的工厂 + 文档化降级）。
import { z } from 'zod';

/** DSH reasoningEffort 档位（合法值以 llm-deepseek 源码为准：off|low|high|max；P5 起供 policy 预算共用防漂移） */
export const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** generate 可选参数（system 提示 / 采样温度 / 输出上限 / 推理档位；全部可选，缺省由适配器/平台决定） */
export const ModelGenerateOptionsSchema = z.object({
  system: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** DSH reasoningEffort 档位（合法值以 llm-deepseek 源码为准：off|low|high|max；缺省 → 适配器默认 low） */
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
});
export type ModelGenerateOptions = z.infer<typeof ModelGenerateOptionsSchema>;

/** 一次模型调用的 token 计数（成本八字段实测输入：model_tokens = input + output） */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 生成结果：text + 可选 usage（适配器可上报 token 计数） */
export interface ModelGenerateResult {
  text: string;
  usage?: ModelUsage;
}

/**
 * ModelAdapter 接口（跨层 ABI：supervisor 基准 judge/executor 与 runtime 生成器共用）。
 * generate(prompt, opts) → text。实现侧：
 * - 生产经 DSH LlmRuntime.stream 装配（runtime/model-adapter.ts createDshModelAdapter，结构最小接口）；
 * - 测试用 fake adapter（确定性返回）；
 * - 无真实 DSH 会话 → 缺省受限（不装配 adapter → generator 走纯规则阶梯；文档化降级）。
 */
export interface ModelAdapter {
  /** 提供方路由标识（DSH provider route；测试用 'test' 等） */
  readonly provider: string;
  /** 模型标识（DSH model id；测试用 'fake' 等） */
  readonly model: string;
  generate(prompt: string, opts?: ModelGenerateOptions): Promise<ModelGenerateResult>;
}
