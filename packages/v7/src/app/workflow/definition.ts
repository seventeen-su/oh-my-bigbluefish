import type { JsonValue } from '../../domain/json.js'

/**
 * Workflow 定义与步骤契约（ARCHITECTURE-PLAN §4.3、ADR-0011）。
 *
 * 确定性：step 的参数只能来自 run.state 与 `WorkflowContext`（`now` 来自注入的 Clock，
 * `commandId` 由 runId+step 派生）。禁止在 step 内读系统时间/随机数，否则重放会漂移。
 *
 * 步骤通过闭包持有 CommandBus/其它依赖，用 `ctx.commandId` 作为命令幂等键；
 * 运行时只负责 checkpoint/重试/补偿，不解释命令语义。
 */

/**
 * 单个步骤的执行上下文。
 *
 * `commandId` 是**重放稳定的**幂等键：同一逻辑步骤无论重试多少次（租约过期、进程崩溃、
 * 人工重放 `<runId>:<step>`）都相同。步骤通过闭包拿到 CommandBus/依赖，用这个 commandId
 * 提交命令；不要用 `attempt` 拼幂等键，否则重放会双写。
 */
export interface WorkflowContext {
  readonly runId: string
  readonly step: string
  /** claim 代数（>=1）；complete/fail 的 CAS 参数。 */
  readonly attempt: number
  /** 重放稳定的幂等键：`<runId>:<step>`。 */
  readonly commandId: string
  /** 注入的时钟读数；步骤内不得再读系统时间，否则重放结果不确定。 */
  readonly now: Date
  /** 取消时触发；步骤应尽快返回或抛错，运行时不会再为取消的 run 安排重试。 */
  readonly signal: AbortSignal
}

export interface WorkflowStepOutcome {
  readonly state: JsonValue
  /** 下一步；缺省按定义顺序推进，`null` 表示到此结束（run 变 completed）。 */
  readonly next?: string | null
}

export interface WorkflowStep {
  readonly name: string
  run(state: JsonValue, ctx: WorkflowContext): Promise<WorkflowStepOutcome>
  /** 逆序补偿；只对已经 checkpoint 的步骤调用，state 是该步骤执行后的 state。 */
  compensate?(state: JsonValue, ctx: WorkflowContext): Promise<void>
}

export interface WorkflowDefinition {
  readonly name: string
  readonly version: number
  /** `start(name, input)` 未传 input 时的初始 state；必须是可序列化 JSON。 */
  readonly initial: JsonValue
  /** 至少一个步骤；名字唯一，`next` 只能指向已声明步骤（缺省按顺序推进）。 */
  readonly steps: readonly WorkflowStep[]
}
