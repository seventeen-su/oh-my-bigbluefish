/**
 * 部署守卫：在 `--apply` 写 DSH profile 之前判断宿主是否正在运行。
 *
 * 背景：DSH 正在运行时改写 profile 会触发 HMR recompose；实测一次运行期
 * profile 改写让 `include:omb-v7` 变成「enabled 但无 fiber」，7 个 omb_* 工具
 * 静默消失，loader 也不给 diagnostic（docs/v7/review/audit/02-runtime-host.md §0）。
 * 所以「运行中热写 profile」必须默认拒绝，只有显式 `--force` 或
 * `OMB_DEPLOY_ALLOW_RUNNING=1` 才放行。
 *
 * 探测只做**一次** TCP connect：连上就是有进程监听，拒绝/超时/错误就是没有。
 * 不轮询、不 setInterval、不重试；调用方（v7-deploy.mjs）在 dry-run 下不探测。
 */
import { connect } from 'node:net'

export const DEFAULT_DSH_HOST = '127.0.0.1'
export const DEFAULT_DSH_PORT = 3080
export const DEFAULT_PROBE_TIMEOUT_MS = 500

/**
 * 一次 TCP connect 探活。
 * @param {{ host?: string, port?: number, timeoutMs?: number }} options
 * @returns {Promise<boolean>} true = 端口在监听（DSH 大概率在运行）
 */
export function probeTcp(options = {}) {
  const host = options.host ?? DEFAULT_DSH_HOST
  const port = options.port ?? DEFAULT_DSH_PORT
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  return new Promise(resolveProbe => {
    let settled = false
    let socket
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        // 探测失败不影响判定：连接已经不可用。
      }
      resolveProbe(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    // 探测计时器不能拖住宿主/脚本退出。
    timer.unref?.()
    try {
      socket = connect({ host, port })
    } catch {
      // 非法 host/port：当作未监听，调用方会保留自己的参数校验。
      finish(false)
      return
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** 环境变量开关：只接受显式的 `1` 或 `true`，避免空串/`0` 被误当放行。 */
export function isAllowRunningFlag(value) {
  return value === '1' || value === 'true'
}

/**
 * 纯策略判定：是否允许写 profile。
 * - dry-run：允许，且调用方不会探测也不会写盘；
 * - `--force`：允许；
 * - `OMB_DEPLOY_ALLOW_RUNNING=1`：允许；
 * - 端口正在监听：拒绝；
 * - 未监听：允许。
 * @param {{ apply: boolean, force?: boolean, env?: Record<string, string | undefined>, listening: boolean }} input
 * @returns {{ allowed: boolean, reason: 'dry-run' | 'force' | 'env' | 'dsh-running' | 'offline' }}
 */
export function evaluateDeployGuard(input) {
  if (!input.apply) return { allowed: true, reason: 'dry-run' }
  if (input.force === true) return { allowed: true, reason: 'force' }
  if (isAllowRunningFlag(input.env?.OMB_DEPLOY_ALLOW_RUNNING)) return { allowed: true, reason: 'env' }
  if (input.listening) return { allowed: false, reason: 'dsh-running' }
  return { allowed: true, reason: 'offline' }
}

/**
 * 编排：只在真正要写（apply 且没有 force/env 放行）时做一次探测。
 * 探测函数可注入，测试用本地临时 TCP server 或假函数，避免碰真实 3080。
 * @param {{
 *   apply: boolean,
 *   force?: boolean,
 *   env?: Record<string, string | undefined>,
 *   host?: string,
 *   port?: number,
 *   timeoutMs?: number,
 *   probe?: (options: { host: string, port: number, timeoutMs: number }) => Promise<boolean>,
 * }} options
 */
export async function ensureDeployAllowed(options) {
  const env = options.env ?? {}
  const host = options.host ?? env.OMB_DSH_HOST ?? DEFAULT_DSH_HOST
  const parsedPort = Number(env.OMB_DSH_PORT ?? DEFAULT_DSH_PORT)
  const port = options.port ?? (Number.isSafeInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_DSH_PORT)
  const force = options.force === true
  // dry-run / force / env 放行都不需要连端口；运行中探测只发生一次。
  if (!options.apply || force || isAllowRunningFlag(env.OMB_DEPLOY_ALLOW_RUNNING)) {
    return { ...evaluateDeployGuard({ apply: options.apply, force, env, listening: false }), listening: undefined, host, port }
  }
  const probe = options.probe ?? probeTcp
  const listening = await probe({ host, port, timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS })
  return { ...evaluateDeployGuard({ apply: options.apply, force, env, listening }), listening, host, port }
}

/** 拒绝时的可操作提示；由部署脚本原样写到 stderr。 */
export function describeDenied(result) {
  const endpoint = `${result.host ?? DEFAULT_DSH_HOST}:${result.port ?? DEFAULT_DSH_PORT}`
  return [
    `检测到 DSH 正在监听 ${endpoint}，拒绝写 profile。`,
    '运行中改写 profile 会触发 HMR recompose，插件工具可能静默失挂载（7 个 omb_* 工具消失）。',
    '请先关闭 DSH 再部署。确实需要热写时显式加 --force，或设置 OMB_DEPLOY_ALLOW_RUNNING=1。',
  ].join('\n')
}
