import type { Embedder } from '../ports/embedding.js'
import type { Store } from '../ports/store.js'
import type { ChannelHit } from '../ports/search.js'
import type { RetrievalConfig, ScenarioConfig } from './config.js'
import { RECALL_SCENARIOS, STAGE_ONE_CHANNELS } from './constants.js'
import { compileRetrievalPlan, type ProviderChannel, type RetrievalPlan } from './compiler.js'
import { createStageOneProviders } from './providers/index.js'
import { runProviderSet } from './providers/run.js'
import type { ProviderOutcome, ProviderStatus } from './providers/types.js'
import type { ChannelError, ChannelReport, ChannelStatus, RecallRequest, RecallScenario, StageOneChannel } from './types.js'

export interface StageOneDeps {
  readonly store: Store
  readonly embedder: Embedder
}

export interface StageOneInput {
  readonly request: RecallRequest
  readonly config: RetrievalConfig
  /** 调用方已解析好的场景配置；只用于推导查询时间窗，权重由引擎按配置再取。 */
  readonly scenario: ScenarioConfig
  readonly now: string
  /** 执行锚点（ms）；缺省用墙钟（旧入口没有宿主时钟）。 */
  readonly executionAnchorMs?: number
}

export interface StageOneOutcome {
  readonly hitsByChannel: ReadonlyMap<StageOneChannel, readonly ChannelHit[]>
  readonly reports: readonly ChannelReport[]
  readonly errors: readonly ChannelError[]
  readonly warnings: readonly string[]
}

function isStageOneChannel(channel: ProviderChannel): channel is StageOneChannel {
  return (STAGE_ONE_CHANNELS as readonly string[]).includes(channel)
}

/**
 * provider 状态 → 结果报告状态。
 * `ChannelStatus` 没有 `deadline`（types.ts 属于 RecallResult 公共契约，本次不改），
 * 所以 deadline 在报告里记为 failed，并由 reason 前缀 `deadline:` 与 warning 明确暴露；
 * provider 自身的 `ProviderOutcome.status` 仍是精确的 `deadline`。
 */
function reportStatus(status: ProviderStatus): ChannelStatus {
  return status === 'deadline' ? 'failed' : status
}

function reportOf(outcome: ProviderOutcome | undefined, channel: StageOneChannel): ChannelReport {
  if (outcome === undefined) return { channel, status: 'failed', hitCount: 0, reason: '通道没有执行结果' }
  const configured = outcome.status === 'deadline'
    ? `deadline: ${outcome.reason ?? '超出计划 deadline'}`
    : outcome.reason
  // RET-08：失败/deadline 必须带可审计原因；空原因会让“全部失败”退化成无法解释的空结果。
  const reason = configured !== undefined && configured.trim().length > 0
    ? configured
    : outcome.status === 'failed' || outcome.status === 'deadline'
      ? `通道 ${channel} ${outcome.status === 'deadline' ? '在 deadline 内未完成' : '执行失败'}（provider 未给出原因）`
      : undefined
  return {
    channel,
    status: reportStatus(outcome.status),
    hitCount: outcome.hits.length,
    ...(reason === undefined ? {} : { reason }),
  }
}

/**
 * 用**已编译的计划**执行阶段一：
 * 1. 无依赖的 provider 并行（trigger/fulltext/vector/time/state_board）；
 * 2. single_char 等第 1 步结束后串行执行（它要 fulltext 命中数决定是否回退）。
 *
 * 每个 provider 的 deadline/失败隔离都在 runner 里，这里只做调度、状态汇总与命中归并。
 */
export async function runStageOnePlan(
  deps: StageOneDeps,
  plan: RetrievalPlan,
  options: { readonly executionAnchorMs?: number } = {},
): Promise<StageOneOutcome> {
  const nowMs = options.executionAnchorMs ?? Date.now()
  const providers = createStageOneProviders()
  const parallel = providers.filter(provider => provider.afterStageOne !== true)
  const dependent = providers.filter(provider => provider.afterStageOne === true)

  const roundStartedAt = performance.now()
  const first = await runProviderSet(parallel, plan, deps, { nowMs })
  const hitsByChannel = new Map<StageOneChannel, readonly ChannelHit[]>()
  for (const outcome of first) {
    if (outcome.hits.length === 0 || !isStageOneChannel(outcome.channel)) continue
    hitsByChannel.set(outcome.channel, outcome.hits)
  }
  // 依赖轮要按“已经过去多少毫秒”重新检查预算，否则并行的第一轮用掉的预算不会计入 single_char。
  const elapsedMs = performance.now() - roundStartedAt
  const second = dependent.length === 0
    ? []
    : await runProviderSet(dependent, plan, deps, { nowMs: nowMs + elapsedMs, previous: hitsByChannel })
  for (const outcome of second) {
    if (outcome.hits.length === 0 || !isStageOneChannel(outcome.channel)) continue
    hitsByChannel.set(outcome.channel, outcome.hits)
  }

  const outcomes = [...first, ...second]
  const warnings: string[] = []
  if (plan.time.fallbackReason !== undefined) warnings.push(plan.time.fallbackReason)
  const errors: ChannelError[] = []
  const byChannel = new Map<StageOneChannel, ProviderOutcome>()
  for (const outcome of outcomes) {
    if (!isStageOneChannel(outcome.channel)) continue
    byChannel.set(outcome.channel, outcome)
    warnings.push(...outcome.warnings)
    if (outcome.status === 'deadline') {
      warnings.push(`通道 ${outcome.channel} 在 deadline 内未完成：${outcome.reason ?? '未知原因'}`)
    }
    for (const issue of outcome.issues) {
      errors.push({
        channel: outcome.channel,
        code: issue.code,
        // RET-08：空错误文本会让“失败”退化成无法诊断；这里补一条最小可读原因。
        message: issue.message.trim().length > 0
          ? issue.message
          : `通道 ${outcome.channel} 失败但没有给出错误详情`,
        retryable: issue.retryable,
      })
    }
  }
  const reports = STAGE_ONE_CHANNELS.map(channel => reportOf(byChannel.get(channel), channel))
  return { hitsByChannel, reports, errors, warnings }
}

/** 场景配置对象 → 场景名；旧入口只拿到对象，必须找回名字才能编译计划。 */
function scenarioNameOf(config: RetrievalConfig, scenario: ScenarioConfig): RecallScenario | undefined {
  for (const name of RECALL_SCENARIOS) {
    if (config.scenarios[name] === scenario) return name
  }
  return undefined
}

/**
 * 兼容入口：旧调用方（测试/基准）传 request+config+scenario+now，这里先编译计划再执行。
 * 新代码应直接用 `RecallEngine.compilePlan` + `runStageOnePlan`，避免每次调用重新编一个临时计划。
 */
export async function runStageOne(deps: StageOneDeps, input: StageOneInput): Promise<StageOneOutcome> {
  const executionAnchorMs = input.executionAnchorMs ?? Date.now()
  const scenarioName = scenarioNameOf(input.config, input.scenario)
  const request: RecallRequest = scenarioName === undefined || input.request.scenario !== undefined
    ? input.request
    : { ...input.request, scenario: scenarioName }
  const plan = compileRetrievalPlan(request, {
    config: input.config,
    now: input.now,
    executionAnchorMs,
  })
  return runStageOnePlan(deps, plan, { executionAnchorMs })
}
