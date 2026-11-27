import { isJsonValue, isPlainObject } from '../../domain/json.js'
import type { JsonValue } from '../../domain/json.js'
import type { WorkflowDefinition } from './definition.js'

/**
 * 真实业务 workflow 定义：忘记任务（`omb.forget`）。
 *
 * 为什么是 workflow 而不是一条 pg-boss 任务：遗忘是「按显著度衰减逐条归档」的多步副作用，
 * 需要重放稳定的 commandId、崩溃后从 step checkpoint 继续、失败/死信可见。WorkflowRuntime
 * 提供这三样；pg-boss 只保证「执行一次/重试」，没有 step 级 checkpoint。
 *
 * 确定性：步骤内不读系统时间/随机数——时间只来自 `ctx.now`（注入的 Clock），幂等键只来自
 * `ctx.commandId`（`<runId>:<step>`，重试/租约过期/人工重放都相同）。实际归档逻辑与后台
 * 队列入口共用 `jobs/consolidate.ts` 的 `runForget`，所以两条入口行为一致。
 *
 * 节奏：本定义只负责「一期内的执行」。本期结束后由 `rearm` 把同一个 dedupeKey 的 timer
 * 排到下一网格点——续期不在 timer handler 里做：那时 timer 行还是 claimed，
 * 重排期会把行改成 pending，让派发器随后的 complete CAS 失败。
 */
export const FORGET_WORKFLOW = 'forget'
export const FORGET_WORKFLOW_VERSION = 1
export const FORGET_STEP = 'archive'

export interface ForgetStepRequest {
  /** 重放稳定的命令幂等键：`<runId>:<step>`。 */
  readonly commandId: string
  /** 注入的时钟读数；步骤内不得再读系统时间。 */
  readonly now: Date
  /** 取消信号：中止后应尽快抛错，运行时按取消收尾。 */
  readonly signal: AbortSignal
}

export interface ForgetStepResult {
  readonly archived: number
  /** 与请求同源的幂等键，写进 run state 便于审计。 */
  readonly commandId: string
  /** 本次执行的时钟读数（ISO），来自 `ctx.now`。 */
  readonly at: string
}

export interface ForgetWorkflowDeps {
  /** 与后台队列入口共用的同一个 handler（`runForget`），不得另写一份归档逻辑。 */
  forget(request: ForgetStepRequest): Promise<ForgetStepResult>
  /**
   * 本期真实执行结束后把 timer 续到下一期（同一个 dedupeKey 重排期）。
   *
   * 放在 step 里而不是 timer handler 里：handler 返回前 timer 行仍是 claimed，此时重排期
   * 会让派发器的 complete CAS 失败；step 由 WorkflowRuntime 异步执行，正常路径上 timer 行
   * 已经被 complete 成 done。续期失败让 step 失败重试，宁可重试也不静默断掉调度链。
   */
  rearm(): Promise<void>
}

/**
 * 构造 forget workflow 定义。
 *
 * `initial` 只放工作流意图标记；start 时传入的额外 JSON 字段会原样带到步骤输出里，
 * 所以一次 run 的 state 同时记录了「输入上下文 + 本期归档结果 + 命令幂等键 + 时钟读数」。
 */
export function createForgetWorkflow(deps: ForgetWorkflowDeps): WorkflowDefinition {
  return {
    name: FORGET_WORKFLOW,
    version: FORGET_WORKFLOW_VERSION,
    initial: { target: FORGET_WORKFLOW },
    steps: [
      {
        name: FORGET_STEP,
        async run(state, ctx) {
          try {
            const result = await deps.forget({
              commandId: ctx.commandId,
              now: ctx.now,
              signal: ctx.signal,
            })
            const nextState: JsonValue = {
              ...carriedState(state),
              archived: result.archived,
              commandId: result.commandId,
              at: result.at,
            }
            return { state: nextState, next: null }
          } finally {
            // 与队列入口「执行完再续期」同一语义：即使归档失败也续下一期（失败本身由
            // step 的重试/死信暴露）；续期抛错会覆盖 step 结果并触发重试。
            await deps.rearm()
          }
        },
      },
    ],
  }
}

/** 只透传上一次 state 里仍是合法 JSON 的字段：start 传入的额外上下文不会在步骤后丢失。 */
function carriedState(state: JsonValue): Record<string, JsonValue> {
  if (!isPlainObject(state)) return {}
  const carried: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(state)) {
    if (isJsonValue(value)) carried[key] = value
  }
  return carried
}
