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
import type { ToolCallContext } from '../sessionRuntime.js'

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
  /**
   * 执行体。
   *
   * `context` 是**本次调用**的归属（会话 / 调用 id / 子代理血统），由 `dsh/` 从宿主
   * `exec.agent` 投影而来（见 `kernel/sessionRuntime.ts` 的 `ToolCallContext`）。
   *
   * 它是可选参数，但语义**不是**"可以忽略"：
   * - `context?.attribution === 'session'` → 用 `context.sessionId` 定位会话；
   * - 否则**不得**改用"最近看到的那个会话"——要么给可读原因拒绝，要么在输出里
   *   明说"归属未知"。
   *
   * 为什么必须有：工具调用与回合事件是两条独立到达的流，交错会话时
   * "最近一个会话"会把 A 的状态写进 B（详见 `kernel/sessionRuntime.ts`）。
   */
  execute(args: unknown, context?: ToolCallContext): Promise<ToolOutcome> | ToolOutcome
}

export type ToolOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * 提示段贡献。
 *
 * 两个槽位对应宿主的两个不同层（见规划 §6.5）：
 * - `resident`：**逐字节稳定**的小提示（**全部模块合计** ≤120 字符），跨轮不变 → 保住前缀缓存
 * - `context`：易变的运行时上下文，走宿主的动态上下文快照
 *
 * 把易变内容放 `resident` 会破坏缓存；把稳定内容放 `context` 会浪费。
 */
export interface PromptContribution {
  /**
   * 贡献者标识（通常就是模块 id）。
   *
   * **可选**：不写也工作——集成层 `collectPromptContributions`（`dsh/session.ts`）
   * 会从服务名 `prompt:<id>` 兜底推导，所以模块**不需要改一行代码**就能被点名。
   * 写它的唯一理由是想要一个比服务名更可读的署名。
   *
   * 为什么需要这个名字：`resident` 的上限是**所有模块合计**的（见 `RESIDENT_HINT_MAX`）。
   * 合计超限时只能截断，而"被截掉的是谁"如果说不出来，被截的模块就永远不会知道自己
   * 被吃了——它手上只有自己那一条，看不到别人占了多少。没有名字时超限报告只能给一个
   * 字符数，那正是修复前的状态：静默、无人可见（见 `dsh/session.ts` 的 `residentHintReport`）。
   */
  readonly id?: string
  /**
   * 常驻提示：必须逐字节稳定，且**所有模块合计**受内核约束（≤ `RESIDENT_HINT_MAX`）。
   *
   * ⚠️ 不是"每个模块各 120 字符"：合计超限时排在后面的贡献会被整条挤出去。
   */
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

/**
 * `resident` 的字符上限：常驻内容越短，缓存前缀越稳定、越省。
 *
 * ⚠️ **这是所有模块合计的上限，不是每个模块各 120。**
 * 实测推理模块的常驻提示一条就占 104/120（`modules/reasoning/methods.ts:152` 的变体选择），
 * **只剩 16 字符余量**——下一个模块（或改长一句现有文案）就会把排在它后面的模块挤出去。
 *
 * 超限**不再是静默的**（旧实现只做 `slice(0, 120)`：不报错、不告警、状态面全绿，
 * 于是症状是"某个能力莫名其妙不生效"而所有模块健康面都是绿的）：
 * `dsh/session.ts` 的 `residentHintReport` 给出逐项账目，超限写进 `kernel.logger`
 * 并进状态面（段落名 `RESIDENT_BUDGET_STATUS_NAME`）。
 * 截断本身**保留**——总得有个上限——但"截了谁、截了多少"从此可查。
 */
export const RESIDENT_HINT_MAX = 120
