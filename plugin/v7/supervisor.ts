/**
 * 宿主面自检与卸载收尾。
 *
 * 为什么需要自检：DSH 运行期改写 profile 触发 HMR recompose 后，插件可能
 * 「enabled 但无 fiber」，7 个 omb_* 工具静默消失，宿主 loader 不给 diagnostic
 * （历史运行审查结论）。所以插件必须自己记下
 * 「准备注册 7 个工具、接线 4 个钩子」，并让 `omb_status` 报真实读数。
 *
 * 自检只在两类时机发生，不做周期性轮询：
 * - `registerTools` / `ctx.on` 的返回值（注册期事实）；
 * - `omb_status` 调用（运行期实测）。
 *
 * DSH `@deepseek-ai/dsh-tools` 有 `tools/change`（emit）事件，可在工具增删时
 * 收到通知；但本插件自己的 disposer 注销工具同样会触发它，若在监听器里自动
 * 重注册，会在插件卸载/作用域销毁后把工具「复活」，与宿主生命周期相反。
 * 这里因此**不伪造自动重连**：只如实报告缺失，由下一次调用/人工重启恢复。
 */
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import { readTools, type HostContextLike } from '../../packages/v7/src/adapters/dsh/host.js'

/** 插件承诺注册的工具名；DSH 侧任一缺失都说明宿主面不完整。 */
export const EXPECTED_TOOL_NAMES: readonly string[] = [
  'omb_remember',
  'omb_recall',
  'omb_update',
  'omb_link',
  'omb_history',
  'omb_status',
  'omb_admin',
]

/** 插件承诺接线的 4 个宿主钩子（session/event 属于事件捕获面，单独统计）。 */
export type HostHookName = 'agent/pre-step' | 'tools/pre-execute' | 'tools/post-execute' | 'session/disposed'

export const EXPECTED_HOOK_NAMES: readonly HostHookName[] = [
  'agent/pre-step',
  'tools/pre-execute',
  'tools/post-execute',
  'session/disposed',
]

export interface ToolRegistrationSnapshot {
  readonly registered: readonly string[]
  readonly unavailable: readonly { readonly name: string; readonly reason: string }[]
}

export interface SurfaceCheck {
  readonly expectedTools: number
  readonly registeredTools: number
  readonly unavailableTools: readonly { readonly name: string; readonly reason: string }[]
  readonly missingTools: readonly string[]
  readonly expectedHooks: number
  readonly wiredHooks: number
  readonly missingHooks: readonly HostHookName[]
  /** `live` = 本次通过宿主 tools.get 实测；`records` = 宿主无 get，退回注册记录。 */
  readonly toolProbe: 'live' | 'records'
  readonly healthy: boolean
}

export interface SupervisorOptions {
  readonly ctx: HostContextLike | undefined
  readonly logger?: Logger
  readonly expectedTools?: readonly string[]
  readonly expectedHooks?: readonly HostHookName[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class Supervisor {
  private readonly ctx: HostContextLike | undefined
  private readonly logger: Logger | undefined
  private readonly expectedTools: readonly string[]
  private readonly expectedHooks: readonly HostHookName[]
  private registered = new Set<string>()
  private unavailable: { name: string; reason: string }[] = []
  private readonly wiredHooks = new Set<HostHookName>()
  private readonly unwiredReasons = new Map<string, string>()
  private lastDegradedSignature: string | undefined

  constructor(options: SupervisorOptions) {
    this.ctx = options.ctx
    this.logger = options.logger
    this.expectedTools = options.expectedTools ?? EXPECTED_TOOL_NAMES
    this.expectedHooks = options.expectedHooks ?? EXPECTED_HOOK_NAMES
  }

  /** 记录 `registerTools` 的注册结果（注册期事实，不是实时探测）。 */
  recordToolRegistration(snapshot: ToolRegistrationSnapshot): void {
    this.registered = new Set(snapshot.registered)
    this.unavailable = snapshot.unavailable.map(item => ({ name: item.name, reason: item.reason }))
  }

  /** 记录一个钩子的接线结果；失败/未返回 disposer 时必须可见。 */
  recordHook(name: HostHookName, wired: boolean, reason?: string): void {
    if (wired) {
      this.wiredHooks.add(name)
      this.unwiredReasons.delete(name)
      return
    }
    this.wiredHooks.delete(name)
    this.unwiredReasons.set(name, reason ?? 'ctx.on 未返回 disposer')
    this.logger?.warn(`宿主钩子未接线：${name}`, reason ?? 'ctx.on 未返回 disposer')
  }

  /**
   * 运行期自检。宿主 `tools.get(name)` 可用时逐项实测；否则如实退回注册记录，
   * 并在 `toolProbe` 标 `records`，不把注册记录冒充成实时结果。
   */
  check(): SurfaceCheck {
    const tools = readTools(this.ctx)
    const get = tools !== undefined && typeof tools.get === 'function' ? tools.get : undefined
    const missingTools: string[] = []
    let registeredTools = 0
    for (const name of this.expectedTools) {
      let visible: boolean
      if (get !== undefined) {
        try {
          visible = get.call(tools, name) !== undefined
        } catch {
          // 宿主探测自身失败按缺失处理：宁可报 degraded，也不伪造 7/7。
          visible = false
        }
      } else {
        visible = this.registered.has(name)
      }
      if (visible) registeredTools += 1
      else missingTools.push(name)
    }
    const missingHooks = this.expectedHooks.filter(name => !this.wiredHooks.has(name))
    const unhealthy = missingTools.length > 0 || missingHooks.length > 0 || this.unavailable.length > 0
    return {
      expectedTools: this.expectedTools.length,
      registeredTools,
      unavailableTools: this.unavailable,
      missingTools,
      expectedHooks: this.expectedHooks.length,
      wiredHooks: this.wiredHooks.size,
      missingHooks,
      toolProbe: get === undefined ? 'records' : 'live',
      healthy: !unhealthy,
    }
  }

  /** `omb_status` 的宿主面读数；每次调用都做一次自检（不轮询）。 */
  statusLines(): readonly string[] {
    const check = this.check()
    const lines = [
      `tools=${check.registeredTools}/${check.expectedTools}`,
      `hooks=${check.wiredHooks}/${check.expectedHooks}`,
    ]
    if (check.toolProbe === 'records') lines.push('toolsProbe=records')
    if (!check.healthy) {
      lines.push('surface=degraded')
      if (check.missingTools.length > 0) lines.push(`toolsMissing=${check.missingTools.join(',')}`)
      if (check.missingHooks.length > 0) lines.push(`hooksMissing=${check.missingHooks.join(',')}`)
      if (check.unavailableTools.length > 0) {
        lines.push(`toolErrors=${check.unavailableTools.map(item => `${item.name}:${item.reason}`).join('; ')}`)
      }
      this.warnOnce(check)
    }
    return lines
  }

  /** apply 末尾的一条接线摘要：注册数/钩子数 + 未接线原因（audit R01）。 */
  logWiringSummary(): void {
    const check = this.check()
    const summary = `宿主面接线：tools=${check.registeredTools}/${check.expectedTools} hooks=${check.wiredHooks}/${check.expectedHooks}`
    if (check.healthy) {
      this.logger?.info(summary)
      return
    }
    this.logger?.warn(summary, {
      missingTools: check.missingTools,
      missingHooks: check.missingHooks,
      unavailable: check.unavailableTools,
      unwired: Object.fromEntries(this.unwiredReasons),
    })
    this.warnOnce(check)
  }

  /** 同一份降级快照只 warn 一次，避免每次 omb_status 刷屏。 */
  private warnOnce(check: SurfaceCheck): void {
    const signature = [
      check.missingTools.join(','),
      check.missingHooks.join(','),
      check.unavailableTools.map(item => item.name).join(','),
    ].join('|')
    if (signature === this.lastDegradedSignature) return
    this.lastDegradedSignature = signature
    this.logger?.warn('宿主面自检降级', {
      tools: `${check.registeredTools}/${check.expectedTools}`,
      hooks: `${check.wiredHooks}/${check.expectedHooks}`,
      missingTools: check.missingTools,
      missingHooks: check.missingHooks,
      reasons: Object.fromEntries(this.unwiredReasons),
    })
  }
}

/**
 * 接线一个宿主钩子：隐藏 try/catch 与 disposer 校验，并把结果记进 Supervisor。
 * 返回的 `off` 只在宿主真的返回 disposer 时才存在；disposer 由调用方持有。
 */
export function wireHostHook(options: {
  readonly ctx: HostContextLike | undefined
  readonly supervisor: Supervisor
  readonly name: HostHookName
  readonly handler: (...args: never[]) => unknown
}): { readonly off: (() => void) | undefined } {
  const { ctx, supervisor, name, handler } = options
  if (typeof ctx?.on !== 'function') {
    supervisor.recordHook(name, false, '宿主没有 on()')
    return { off: undefined }
  }
  try {
    const returned = ctx.on(name, handler)
    const wired = typeof returned === 'function'
    supervisor.recordHook(name, wired)
    return { off: wired ? returned as () => void : undefined }
  } catch (error) {
    supervisor.recordHook(name, false, `注册抛错：${messageOf(error)}`)
    return { off: undefined }
  }
}

/** 每一步独立的卸载预算；等待超时后继续下一步，不串行累加。 */
export const TEARDOWN_STEP_TIMEOUT_MS = 5_000

/**
 * 分阶段卸载预算：阶段内步骤并行，阶段之间串行。
 *
 * `drain` 里并行的各步互不依赖（事件运行时、投影、队列、嵌入器），共享一份预算；
 * `store.close` 必须等它们全部让出数据库；`lifecycle.stop` 有独立预算，前两阶段
 * 超时也不会被跳过——这正是旧实现把 DB stop 排在队尾时丢掉的那一步。
 */
export const TEARDOWN_PHASE_BUDGET_MS = {
  drain: 3_500,
  store: 1_500,
  lifecycle: 2_500,
} as const

/** 单个资源内部停机的上界：一个 worker 卡住不能连累同一阶段里的其它资源。 */
export const RESOURCE_STOP_TIMEOUT_MS = 2_000

export interface TeardownStep {
  readonly name: string
  readonly run: () => Promise<unknown> | unknown
}

export interface TeardownPhase {
  readonly name: string
  readonly budgetMs: number
  readonly steps: readonly TeardownStep[]
}

export interface TeardownReport {
  readonly completed: readonly string[]
  readonly timedOut: readonly string[]
  readonly failed: readonly { readonly name: string; readonly reason: string }[]
}

export interface TeardownOptions {
  readonly timeoutMs?: number
  readonly logger?: Logger
}

export type StepOutcome = { readonly kind: 'ok' } | { readonly kind: 'timeout' } | { readonly kind: 'failed'; readonly reason: string }

/**
 * 顺序执行卸载步骤，每步独立超时并记日志。
 *
 * 关键约定：前一步超时/失败**不**跳过后面的步骤；本函数永不 reject
 * （disposer 不能把异常抛给宿主）。
 */
export async function runTeardownSteps(
  steps: readonly TeardownStep[],
  options: TeardownOptions = {},
): Promise<TeardownReport> {
  const timeoutMs = options.timeoutMs ?? TEARDOWN_STEP_TIMEOUT_MS
  const completed: string[] = []
  const timedOut: string[] = []
  const failed: { name: string; reason: string }[] = []
  for (const step of steps) {
    let outcome: StepOutcome
    try {
      outcome = await settleWithin(step.run(), timeoutMs)
    } catch (error) {
      // step.run() 同步抛错也只是一步失败，继续后面的收尾。
      outcome = { kind: 'failed', reason: messageOf(error) }
    }
    classifyStep(step.name, outcome, { completed, timedOut, failed }, options.logger, timeoutMs)
  }
  return { completed, timedOut, failed }
}

/**
 * 分阶段卸载：阶段内步骤**并行**且共享阶段预算，阶段之间按声明顺序串行。
 *
 * 阶段预算固定，因此 `lifecycle` 阶段始终拿到自己的整份预算；即使 drain/store
 * 全部超时，DB release 仍会被执行。每一步单独计时与记录，一个资源卡住不会拖住
 * 同阶段的其它资源。本函数永不 reject。
 */
export async function runTeardownPhases(
  phases: readonly TeardownPhase[],
  options: TeardownOptions = {},
): Promise<TeardownReport> {
  const completed: string[] = []
  const timedOut: string[] = []
  const failed: { name: string; reason: string }[] = []
  for (const phase of phases) {
    const outcomes = await Promise.all(phase.steps.map(async (step): Promise<readonly [string, StepOutcome]> => {
      try {
        return [step.name, await settleWithin(step.run(), phase.budgetMs)] as const
      } catch (error) {
        return [step.name, { kind: 'failed', reason: messageOf(error) }] as const
      }
    }))
    for (const [name, outcome] of outcomes) {
      classifyStep(name, outcome, { completed, timedOut, failed }, options.logger, phase.budgetMs)
    }
  }
  return { completed, timedOut, failed }
}

/** 一步的收尾结果分类 + 日志；阶段只决定预算，报告口径始终按步骤名。 */
function classifyStep(
  name: string,
  outcome: StepOutcome,
  report: { completed: string[]; timedOut: string[]; failed: { name: string; reason: string }[] },
  logger: Logger | undefined,
  timeoutMs: number,
): void {
  if (outcome.kind === 'ok') {
    report.completed.push(name)
    logger?.info(`teardown ${name} 完成`)
    return
  }
  if (outcome.kind === 'timeout') {
    report.timedOut.push(name)
    logger?.warn(`teardown ${name} 超过 ${timeoutMs}ms 未完成，继续后续步骤`)
    return
  }
  report.failed.push({ name, reason: outcome.reason })
  logger?.warn(`teardown ${name} 失败：${outcome.reason}；继续后续步骤`)
}

/**
 * 给单个资源停机加预算；超时只返回结果，不取消底层 promise（其拒绝仍会被消费）。
 * 用于同一阶段内互不依赖的资源：一个 worker 卡死不能阻止其它 LISTEN 连接关闭。
 */
export function settleWithin(work: Promise<unknown> | unknown, timeoutMs: number): Promise<StepOutcome> {
  return new Promise(resolveOutcome => {
    let settled = false
    const finish = (outcome: StepOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveOutcome(outcome)
    }
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    timer.unref?.()
    // 超时后才 reject 的 promise 也必须被消费，否则会变成 unhandledRejection。
    Promise.resolve(work).then(
      () => finish({ kind: 'ok' }),
      (error: unknown) => finish({ kind: 'failed', reason: messageOf(error) }),
    )
  })
}

/**
 * 有界取值：超时返回 undefined，原 promise 的拒绝照常被消费。
 * 用于 `omb_status`/teardown 这类“观测不能拖住宿主”的单次探测。
 */
export async function valueWithin<T>(work: Promise<T> | (() => Promise<T>), timeoutMs: number): Promise<T | undefined> {
  const task = Promise.resolve().then(typeof work === 'function' ? work : () => work)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

