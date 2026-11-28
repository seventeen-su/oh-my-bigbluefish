/**
 * 卸载收尾：返回**可等待的** disposer。
 *
 * DSH/cordis 在 `Entry.update(disabled)`、`ctx.registry.delete` 与 fiber reload 时都会
 * `await` 插件回调返回的 disposer（`vendor/cordis/src/fiber.ts` 的 `_unload` 对返回的
 * Promise 做 await），所以这里不再 `void` 掉异步收尾——宿主等待它，开关关闭时 DB 与
 * 队列才真的停了。
 *
 * 顺序与预算（阶段内并行，阶段间串行）：
 * 1. drain：事件运行时 / 投影 / 队列 / 嵌入器并行停，每个资源内部再限时；
 * 2. store.close：所有数据库使用者让出连接池后再关池；
 * 3. managedDb.release：最后释放受管 PostgreSQL，**有独立预算**，前两阶段超时也不会跳过。
 *
 * 每个宿主面 disposer 与每个 teardown 步骤都独立隔离：失败只记日志，绝不把异常抛回；
 * 收尾结果写进进程级 ledger，`omb_status` 可读上一代是否真的停了。
 */
import { randomUUID } from 'node:crypto'
import {
  TEARDOWN_PHASE_BUDGET_MS,
  runTeardownPhases,
  valueWithin,
  type TeardownPhase,
  type TeardownReport,
} from './supervisor.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import type { ManagedPostgresStatus } from '../../packages/v7/src/adapters/postgres/managed.js'
import { messageOf } from './messages.js'

export type ManagedDbAfter = 'running' | 'stopped' | 'disabled' | 'unknown'

/** 一代插件卸载的收尾结果；进程级保存最近一次，供下一次 `omb_status` 对账。 */
export interface TeardownLedgerEntry {
  readonly at: string
  readonly instance: string
  readonly completed: readonly string[]
  readonly timedOut: readonly string[]
  readonly failed: readonly { readonly name: string; readonly reason: string }[]
  readonly managedDbAfter: ManagedDbAfter
}

export interface DisposerOptions {
  readonly logger: Logger
  /** 工具注册面：`registerTools` 的返回值（只有 dispose）。 */
  readonly tools: { dispose(): void }
  /** session/event 捕获面。 */
  readonly capture: { dispose(): void }
  readonly skillsOff: () => void
  /** 常驻记忆协议 section 的注销；未接线时是空函数。 */
  readonly protocolOff: () => void
  readonly promptSink: { dispose(): void }
  /** 主动记忆检查点 context；与 T0 分开注销。 */
  readonly checkpointSink: { dispose(): void }
  readonly hooks: {
    readonly preStep?: (() => void) | undefined
    readonly toolPreExecute?: (() => void) | undefined
    readonly toolPostExecute?: (() => void) | undefined
    readonly sessionDisposed?: (() => void) | undefined
  }
  /** T1 会话态：卸载后没有任何调用者会再读它，显式清空避免热重载时旧缓存跨实例存活。 */
  readonly session: { dispose(): void }
  /** 关闭启动闸门：之后不再发起迁移/队列注册/运行时启动。 */
  readonly boot: { dispose(): void }
  /** 事件运行时（relay/timer/workflow + 两个 LISTEN notifier）。 */
  readonly eventRuntime: { stop(): Promise<void> }
  /** 投影链路（worker/read/LISTEN notifier）。 */
  readonly projection: { stop(): Promise<void> }
  /** pg-boss 队列：内部等待 in-flight start，并限制 graceful drain 时间。 */
  readonly queue: { stop(): Promise<void> }
  /** ONNX 会话释放（runtime 本身是进程级单例，不在这里释放）。 */
  readonly embedder: { close(): Promise<void> }
  readonly store: { close(): Promise<void> }
  /** 受管 PostgreSQL 的进程级句柄；`managePostgres=false` 时 undefined。 */
  readonly managedDb: {
    release(): Promise<void>
    status(): Promise<ManagedPostgresStatus>
  } | undefined
  /** 覆盖预算（测试用）。 */
  readonly budgets?: { readonly drainMs?: number; readonly storeMs?: number; readonly lifecycleMs?: number }
}

const ledgerHolder = globalThis as typeof globalThis & {
  __ombLastTeardown?: TeardownLedgerEntry
}

/** 最近一次卸载结果；从未卸载时 undefined。 */
export function lastTeardown(): TeardownLedgerEntry | undefined {
  return ledgerHolder.__ombLastTeardown
}

/** 测试用：清空 ledger，避免跨用例串读。 */
export function resetTeardownLedger(): void {
  delete ledgerHolder.__ombLastTeardown
}

export function createDisposer(options: DisposerOptions): () => Promise<void> {
  let disposal: Promise<void> | undefined
  return () => {
    disposal ??= disposeOnce(options)
    return disposal
  }
}

async function disposeOnce(options: DisposerOptions): Promise<void> {
  const { logger } = options
  // 同步注销宿主面：这些必须在同一 tick 完成，宿主注销工具后模型不再能调用它们。
  unregister('tools', () => options.tools.dispose())
  unregister('capture', () => options.capture.dispose())
  unregister('skills', () => options.skillsOff())
  unregister('protocol', () => options.protocolOff())
  unregister('promptSink', () => options.promptSink.dispose())
  unregister('checkpointSink', () => options.checkpointSink.dispose())
  unregister('preStep', () => options.hooks.preStep?.())
  unregister('toolPostExecute', () => options.hooks.toolPostExecute?.())
  unregister('toolPreExecute', () => options.hooks.toolPreExecute?.())
  unregister('sessionDisposed', () => options.hooks.sessionDisposed?.())
  unregister('session', () => options.session.dispose())
  // 先关闭启动闸门（同步），避免 drain 阶段还在跑时 boot 又发起新步骤。
  unregister('boot', () => options.boot.dispose())

  const budgets = options.budgets
  const phases: TeardownPhase[] = [
    {
      name: 'drain',
      budgetMs: budgets?.drainMs ?? TEARDOWN_PHASE_BUDGET_MS.drain,
      steps: [
        { name: 'eventRuntime.stop', run: () => options.eventRuntime.stop() },
        { name: 'projection.stop', run: () => options.projection.stop() },
        { name: 'queue.stop', run: () => options.queue.stop() },
        { name: 'embedder.close', run: () => options.embedder.close() },
      ],
    },
    {
      name: 'store',
      budgetMs: budgets?.storeMs ?? TEARDOWN_PHASE_BUDGET_MS.store,
      steps: [{ name: 'store.close', run: () => options.store.close() }],
    },
  ]
  // DB release 是整条收尾的最后一件事，也是唯一不能因前面超时被跳过的一步。
  if (options.managedDb !== undefined) {
    phases.push({
      name: 'lifecycle',
      budgetMs: budgets?.lifecycleMs ?? TEARDOWN_PHASE_BUDGET_MS.lifecycle,
      steps: [{ name: 'managedDb.release', run: () => options.managedDb?.release() }],
    })
  }

  const report = await runTeardownPhases(phases, { logger })
  const managedDbAfter = await probeManagedDb(options)
  const entry: TeardownLedgerEntry = {
    at: new Date().toISOString(),
    instance: randomUUID(),
    completed: [...report.completed],
    timedOut: [...report.timedOut],
    failed: [...report.failed],
    managedDbAfter,
  }
  ledgerHolder.__ombLastTeardown = entry
  logReport(logger, report, managedDbAfter)
}

function unregister(name: string, dispose: () => void): void {
  try {
    dispose()
  } catch {
    // 注销失败不阻断卸载；后续阶段仍要执行。
  }
}

async function probeManagedDb(options: DisposerOptions): Promise<ManagedDbAfter> {
  const managed = options.managedDb
  if (managed === undefined) return 'disabled'
  try {
    // 收尾结果不能因为一次 pg_ctl 探测卡住而拖住宿主；2s 内拿不到就如实报 unknown。
    const status = await valueWithin(managed.status(), 2_000)
    return status?.probe ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function logReport(logger: Logger, report: TeardownReport, managedDbAfter: ManagedDbAfter): void {
  // 既有测试/运维用它判断“收尾真的完成”，保留固定消息。
  logger.info('teardown 收尾完成', report)
  logger.info('teardown 资源状态', {
    completed: report.completed,
    timedOut: report.timedOut,
    failed: report.failed,
    managedDbAfter,
  })
  if (report.timedOut.length > 0 || report.failed.length > 0) {
    logger.warn('teardown 收尾不完整', {
      timedOut: report.timedOut,
      failed: report.failed.map(item => `${item.name}: ${messageOf(item.reason)}`),
    })
  }
}
