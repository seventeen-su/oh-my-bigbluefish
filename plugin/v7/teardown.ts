/**
 * 卸载收尾：同步返回的 disposer（宿主可能不等待异步清理）。
 *
 * 顺序有含义：事件运行时（relay/timer/workflow）→ 各自的 LISTEN 连接 → 队列 → 投影链路 →
 * store.close → 便携 PostgreSQL。relay/timer/workflow 还在跑时不能先关连接池；
 * 每个 worker 与它的 notifier 分成两步，worker 卡住超时也不会让 LISTEN 连接泄漏。
 *
 * 每个宿主面 disposer 与每个 teardown 步骤都独立隔离：失败只记日志，绝不把异常抛回宿主；
 * 每步独立 5s 超时，超时只记录并继续下一步（不串行累加）。
 */
import { TEARDOWN_STEP_TIMEOUT_MS, runTeardownSteps, type TeardownStep } from './supervisor.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import { messageOf } from './messages.js'

export interface DisposerOptions {
  readonly logger: Logger
  /** 工具注册面：`registerTools` 的返回值（只有 dispose）。 */
  readonly tools: { dispose(): void }
  /** session/event 捕获面。 */
  readonly capture: { dispose(): void }
  readonly skillsOff: () => void
  readonly promptSink: { dispose(): void }
  readonly hooks: {
    readonly preStep: (() => void) | undefined
    readonly toolPreExecute: (() => void) | undefined
    readonly toolPostExecute: (() => void) | undefined
    readonly sessionDisposed: (() => void) | undefined
  }
  /** T1 会话态：卸载后没有任何调用者会再读它，显式清空避免热重载时旧缓存跨实例存活。 */
  readonly session: { dispose(): void }
  /** 事件运行时自己的收尾步骤（relay/timer/workflow + 两个 notifier）。 */
  readonly eventSteps: readonly TeardownStep[]
  /** 投影链路的收尾步骤（worker/read/notifier）。 */
  readonly projectionSteps: readonly TeardownStep[]
  /** 队列必须排在事件运行时之后、投影链路之前停止。 */
  readonly queue: { stop(): Promise<void> }
  readonly store: { close(): Promise<void> }
  readonly lifecycle: { stop(): Promise<void> } | undefined
}

export function createDisposer(options: DisposerOptions): () => void {
  const { logger } = options
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      options.tools.dispose()
    } catch {
      // 注销失败不阻断卸载。
    }
    try {
      options.capture.dispose()
    } catch {
      // 同上。
    }
    try {
      options.skillsOff()
    } catch {
      // 注销失败不阻断卸载。
    }
    try {
      options.promptSink.dispose()
    } catch {
      // 同上。
    }
    try {
      options.hooks.preStep?.()
    } catch {
      // 同上。
    }
    try {
      options.hooks.toolPostExecute?.()
    } catch {
      // 同上。
    }
    try {
      options.hooks.toolPreExecute?.()
    } catch {
      // 同上。
    }
    try {
      options.hooks.sessionDisposed?.()
    } catch {
      // 同上。
    }
    options.session.dispose()
    // 没有可停的巩固循环了：durable schedule 是 omb.timer 里的行，进程退出后仍保留，
    // 下一个进程启动时靠幂等 ensure 接管；这里不需要（也不应该）取消它们。
    const teardownSteps: TeardownStep[] = [
      ...options.eventSteps,
      { name: 'queue.stop', run: () => options.queue.stop() },
      ...options.projectionSteps,
      { name: 'store.close', run: () => options.store.close() },
      ...(options.lifecycle === undefined ? [] : [{ name: 'lifecycle.stop', run: () => options.lifecycle?.stop() }]),
    ]
    void runTeardownSteps(teardownSteps, { logger, timeoutMs: TEARDOWN_STEP_TIMEOUT_MS })
      .then(report => {
        logger.info('teardown 收尾完成', report)
      })
      .catch(error => {
        // runTeardownSteps 约定不 reject；这里只是最后一道保险。
        logger.warn('teardown 收尾异常', messageOf(error))
      })
  }
}
