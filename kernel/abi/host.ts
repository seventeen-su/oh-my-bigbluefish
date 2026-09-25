/**
 * 宿主面对模块暴露的**声明式**接口。
 *
 * 模块不注册工具、不注入提示段——它只**声明**要什么；
 * 由 `dsh/` 层在正确的作用域与生命周期里完成实际注册。
 *
 * 这样做有两个硬收益：
 * ① 模块层不接触宿主，因此可零 mock 测试
 * ② 注册时机集中在一处，便于满足 DSH 的"不得在 apply 返回后异步注册"约束（热插拔 H-2）
 */
import type { FocusDepth } from './kinds.js'

/**
 * 工具的输入 schema。
 *
 * 只要求 `parse`——对校验库零依赖（模块用 zod、schemastery 或手写校验器都行）。
 *
 * **但模块必须另外提供 `jsonSchema`**（把同一条工具参数附成
 * `{ jsonSchema: Record<string, unknown> }`），因为**模型看不到 zod**：
 * 宿主 `tools.register` 把参数当原始 JSON Schema 用，
 * 只给 `parse` 会让模型看到一个空参数表（工具"存在但无从填写"）。
 *
 * 推荐用 `z.toJSONSchema(sameSchema)` 从**同一份** zod 生成，避免两处漂移。
 * 缺失 `jsonSchema` 时 `dsh/` 回落到空参数表——**这是降级不是崩溃**，
 * 且状态面会记录（工具仍可用，只是模型看不到入参说明）。
 */
export interface ToolInputSchema {
  parse(input: unknown): unknown
}

/**
 * 工具定义。
 *
 * **执行体绝不抛异常**（热插拔要求）：服务缺失、参数非法、内部错误
 * 一律返回 `ToolOutcome` 的错误分支。模型看到的是可读文本，不是中断的回合。
 *
 * **同步或异步都可以，调用方必须 `await`。** 返回类型是
 * `ToolOutcome | Promise<ToolOutcome>`——写同步实现是合法的（更简单），
 * 但任何消费方都不得假设拿到的是终值。这条约定写在类型旁边，
 * 因为"测试按同步值用"是实际发生过的集成错误来源。
 */
export interface ToolDefinition {
  /** 工具名，`omb_` 前缀。 */
  readonly name: string
  readonly description: string
  readonly parameters: ToolInputSchema
  execute(args: unknown): Promise<ToolOutcome> | ToolOutcome
}

export type ToolOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * 提示段贡献。
 *
 * 两个槽位对应宿主的两个不同层（见规划 §6.5）：
 * - `resident`：**逐字节稳定**的小提示（≤120 字符），跨轮不变 → 保住前缀缓存
 * - `context`：易变的运行时上下文，走宿主的动态上下文快照
 *
 * 把易变内容放 `resident` 会破坏缓存；把稳定内容放 `context` 会浪费。
 */
export interface PromptContribution {
  /** 常驻提示：必须逐字节稳定，长度受内核约束（≤ `RESIDENT_HINT_MAX`）。 */
  readonly resident?: string
  /** 易变上下文：每轮可变的运行时说明。 */
  readonly context?: (input: ContextRenderInput) => string
}

export interface ContextRenderInput {
  readonly sessionId: string
  readonly depth: FocusDepth
  /** 当前上下文压力档位，供模块决定是否收敛说明。 */
  readonly band: 'relaxed' | 'moderate' | 'tight'
}

/** `resident` 的字符上限：常驻内容越短，缓存前缀越稳定、越省。 */
export const RESIDENT_HINT_MAX = 120
