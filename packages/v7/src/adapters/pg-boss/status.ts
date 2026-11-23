import type { JobFinalFailureSummary, JobHandlerFailureSummary } from '../../ports/jobs.js'

export interface JobHealthInput {
  /** 配置里是否开启后台任务。 */
  readonly enabled: boolean
  /** 懒初始化是否成功（pg-boss 已启动、任务已注册）。 */
  readonly initialized: boolean
  readonly failures: JobHandlerFailureSummary
  /** 跨进程最终失败；未配置持久日志时为 undefined（按 0 输出）。 */
  readonly finalFailures?: JobFinalFailureSummary
  /** 持久失败查询失败的原因；不能假装为零。 */
  readonly finalFailureError?: string
}

function oneLine(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length === 0 ? '-' : text
}

/**
 * 生成 omb_status 的任务健康行。
 *
 * `jobFailures` 是本进程尚未被同名成功清除的 handler 异常；`jobFinalFailures` 是
 * 耗尽重试且尚未被同名后续成功解除的最终失败，跨进程可见。两者都让 jobs=degraded，
 * 但摘要分别标明来源，不能把中间重试冒充成最终失败。
 */
export function describeJobHealth(input: JobHealthInput): readonly string[] {
  const latest = input.failures.recent[0]
  const latestFinal = input.finalFailures?.recent[0]
  const finalCount = input.finalFailures?.count ?? 0
  const degraded = input.enabled && (
    !input.initialized
    || input.failures.count > 0
    || finalCount > 0
    || input.finalFailureError !== undefined
  )
  const lines = [
    `jobs=${input.enabled ? (degraded ? 'degraded' : 'on') : 'off'}`,
    `jobFailures=${input.failures.count}`,
    `jobFinalFailures=${input.finalFailureError === undefined ? finalCount : 'unavailable'}`,
  ]
  if (input.finalFailureError !== undefined) {
    lines.push(`jobFinalFailureError=${oneLine(input.finalFailureError)}`)
  } else if (latestFinal !== undefined) {
    lines.push(
      `jobFinalFailure=name=${oneLine(latestFinal.name)} jobId=${oneLine(latestFinal.jobId)} attempt=${latestFinal.attempt} retryLimit=${latestFinal.retryLimit} at=${oneLine(latestFinal.at)} error=${oneLine(latestFinal.error)} payload=${oneLine(latestFinal.payload)}`,
    )
  }
  if (latest !== undefined) {
    lines.push(
      `jobFailure=kind=handler scope=process-memory name=${oneLine(latest.name)} attempt=${latest.attempt} at=${oneLine(latest.at)} error=${oneLine(latest.error)} payload=${oneLine(latest.payload)}`,
    )
  }
  return lines
}
