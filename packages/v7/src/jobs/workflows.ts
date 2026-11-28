import { isJsonValue, isPlainObject } from '../domain/json.js'
import type { JsonValue } from '../domain/json.js'
import type { WorkflowDefinition } from '../app/workflow/index.js'
import type { ConsolidationJobName } from './names.js'
import type { ConsolidationJobRunner } from './runners.js'

/**
 * 九个巩固任务的真实 workflow 定义（forget 在 `app/workflow/business.ts`，同样是真实定义）。
 *
 * 为什么是 workflow 而不是一条 pg-boss 任务：
 * - pg-boss 只保证「任务至少执行一次 + 整条重试」，进程崩溃后从头再跑，没有 step 级 checkpoint；
 * - 这里的周期兜底是多步副作用（抽取候选、去重合并、补链、刷新、补向量），需要重放稳定的
 *   commandId、崩溃后从 checkpoint 继续、失败/死信可见、可人工 retry。WorkflowRuntime 提供这些，
 *   step 只负责调用与 pg-boss 入口**同一个** runner（`jobs/runners.ts`）。
 *
 * 节奏：timer 到期只 `startRun`；本期真实执行结束后由 step 的 `rearm` 把同一 dedupeKey 续到
 * 下一网格点。续期放在 step 而不是 timer handler：handler 返回前 timer 行仍是 claimed，此时
 * 重排期会让派发器的 complete CAS 失败。
 *
 * 确定性：step 不读系统时间/随机数——时间只来自 `ctx.now`，幂等键只来自 `ctx.commandId`
 * （`<runId>:<step>`，重试/租约过期/人工重放都相同），并原样写进 run state 便于审计。
 */
export const CONSOLIDATION_WORKFLOW_VERSION = 1

export interface ConsolidationWorkflowSpec {
  readonly job: ConsolidationJobName
  /** WorkflowRuntime 里注册的定义名。 */
  readonly workflow: string
  /** 唯一 step 名；真实工作在这个 step 里完成。 */
  readonly step: string
}

/**
 * 任务 → workflow 定义的稳定映射（9 个任务，不含 forget）。
 *
 * 名字与 step 是契约：status、timer 派发、测试都按这里的值对齐；改名等于换调度身份，
 * 必须同时处理运行中的旧 run（version 不匹配会落死信等人工核对）。
 */
export const CONSOLIDATION_WORKFLOW_SPECS: readonly ConsolidationWorkflowSpec[] = [
  { job: 'omb.extract', workflow: 'extract', step: 'extract' },
  { job: 'omb.reference-rot', workflow: 'reference-rot', step: 'scan' },
  { job: 'omb.clue-promote', workflow: 'clue-promote', step: 'promote' },
  { job: 'omb.dedupe', workflow: 'dedupe', step: 'dedupe' },
  { job: 'omb.conflict', workflow: 'conflict', step: 'detect' },
  { job: 'omb.link-suggest', workflow: 'link-suggest', step: 'suggest' },
  { job: 'omb.attr-alias', workflow: 'attr-alias', step: 'rename' },
  { job: 'omb.refresh', workflow: 'refresh', step: 'refresh' },
  { job: 'omb.embed-sweep', workflow: 'embed-sweep', step: 'embed' },
]

export interface ConsolidationWorkflowDeps {
  /** 与 pg-boss handler 共用的执行体；step 不另写业务逻辑。 */
  readonly runners: Readonly<Record<ConsolidationJobName, ConsolidationJobRunner>>
  /** 本期真实执行结束后把同一 dedupeKey 续到下一网格点（同 timer 行重排期，不新增行）。 */
  readonly rearm: (job: ConsolidationJobName) => Promise<void>
}

/**
 * 构造 9 个真实定义（每个恰好一个 step）。
 *
 * 每个 step 的 state 同时记录「输入上下文 + 本次结果 + 命令幂等键 + 时钟读数」；
 * `next: null` 表示一次 run 只执行一期，下一期由 timer 重新驱动。
 */
export function createConsolidationWorkflows(deps: ConsolidationWorkflowDeps): readonly WorkflowDefinition[] {
  return CONSOLIDATION_WORKFLOW_SPECS.map(spec => createDefinition(spec, deps))
}

function createDefinition(spec: ConsolidationWorkflowSpec, deps: ConsolidationWorkflowDeps): WorkflowDefinition {
  return {
    name: spec.workflow,
    version: CONSOLIDATION_WORKFLOW_VERSION,
    initial: { target: spec.workflow, job: spec.job },
    steps: [
      {
        name: spec.step,
        async run(state, ctx) {
          try {
            const result = await deps.runners[spec.job](undefined, {
              commandId: ctx.commandId,
              now: ctx.now,
              signal: ctx.signal,
            })
            return {
              state: {
                ...carriedState(state),
                job: spec.job,
                commandId: ctx.commandId,
                at: ctx.now.toISOString(),
                ...jsonFieldsOf(result),
              },
              next: null,
            }
          } finally {
            // 与队列入口「执行完再续期」同一语义：失败也续下一期（失败本身由 step 的
            // 重试/死信暴露）；rearm 抛错会覆盖 step 结果并触发重试，宁可重试也不静默断链。
            await deps.rearm(spec.job)
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

/** runner 的结果合并进 state：对象按字段展开，异常形状（理论上不会出现）整体落到 `result`。 */
function jsonFieldsOf(result: JsonValue): Record<string, JsonValue> {
  return isPlainObject(result) ? carriedState(result) : { result }
}
