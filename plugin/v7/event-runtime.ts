/**
 * 事件运行时（outbox relay / timer worker / workflow runtime）的组合根片段。
 *
 * 顺序固定：
 * 1. 两个 notifier 先 `ready()`：LISTEN 建立后才能保证“事务提交后的 NOTIFY”不丢；
 *    漏通知仍由 relay 首次 drain 与 timer 的 `nextDueAt` 单次定时器兜底。
 * 2. 注册真实 reaction（EntityCreated/EntityPatched → 入队 `omb.embed` + 合并 `omb.refresh`）与
 *    两个 timer handler（到期唤醒 workflow runtime；巩固任务的 durable schedule 到期入队）。
 *    未注册 topic 由 relay 的 `unknownTopic='dead'` 明示进死信。
 * 3. 启动 relay/timer/workflow，再跑一次 workflow `recover()`：租约过期的 running 回
 *    pending 并唤醒循环（启动恢复）。
 *
 * 没有固定轮询：relay 空闲时等 NOTIFY，timer/workflow 只在有未来到期行时 arm 一个
 * 单次定时器；本模块不新增 setInterval。
 *
 * 断连恢复：两个 LISTEN 连接自带指数退避重连（`adapters/postgres/listen.ts`），重连成功后
 * 重新 LISTEN、唤醒对应 worker，并触发一次有界 `reconcileOnce()`（数一次旧 pending/到期
 * timer 并叫醒）。这样数据库重启/kill 连接后不需要重启插件，也不会靠固定轮询兜底。
 */
import { PostgresOutboxNotifier, PostgresOutboxStore } from '../../packages/v7/src/adapters/postgres/outbox.js'
import { PostgresTimerNotifier } from '../../packages/v7/src/adapters/postgres/timer.js'
import { PostgresWorkflowStore } from '../../packages/v7/src/adapters/postgres/workflow.js'
import type { ListenNotifierStatus } from '../../packages/v7/src/adapters/postgres/listen.js'
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { PostgresTimerStore } from '../../packages/v7/src/adapters/postgres/timer.js'
import type { OnnxEmbedder } from '../../packages/v7/src/adapters/embedding/index.js'
import { OutboxRelay, ReactionRegistry } from '../../packages/v7/src/app/outbox/index.js'
import type { Reaction } from '../../packages/v7/src/app/outbox/index.js'
import { TimerWorker, WorkflowRuntime } from '../../packages/v7/src/app/workflow/index.js'
import type { TimerHandler } from '../../packages/v7/src/app/workflow/index.js'
import type { Clock } from '../../packages/v7/src/ports/clock.js'
import type { JobQueue, Logger } from '../../packages/v7/src/ports/jobs.js'
import {
  EMBED_REACTION_TOPICS,
  LINK_REACTION_TOPICS,
  REFRESH_REACTION_TOPICS,
  WRITE_SIDE_EFFECT_TOPICS,
  createAckReaction,
  createEmbedReaction,
  createLinkSuggestReaction,
  createReactionAckMetrics,
  createRefreshReaction,
  type ReactionAckMetrics,
} from './reactions.js'
import type { TeardownStep } from './supervisor.js'
import { messageOf } from './messages.js'

/** timer 的两类真实消费者之一：到点唤醒 workflow runtime。 */
const WORKFLOW_WAKE_TIMER_TOPIC = 'omb.workflow.wake'

export interface EventRuntimeDeps {
  readonly databaseUrl: string
  readonly jobsEnabled: boolean
  readonly store: PostgresStore
  readonly embedder: OnnxEmbedder
  readonly queue: JobQueue
  readonly clock: Clock
  readonly logger: Logger
  readonly timerStore: PostgresTimerStore
  readonly consolidationTimerHandler: TimerHandler
  readonly consolidationStatusLines: () => Promise<string[]>
  /** 投影链路属于另一个模块，但 `omb_status` 的 LISTEN 三段读数必须一起报。 */
  readonly projectionNotifier: () => { status(): ListenNotifierStatus } | undefined
  /** 未启动/启动失败时的原因：读 `startup.error`，不在这里缓存第二份状态。 */
  readonly startupError: () => string | undefined
}

export interface EventRuntime {
  /** 幂等启动：已启动直接返回；失败时先停循环/关 LISTEN 再抛出。 */
  start(): Promise<void>
  /** 重连回调里触发一次有界对账；失败只记日志，绝不把异常抛进 pg 的事件循环/宿主。 */
  scheduleReconcile(): void
  /** `omb_status` 的事件运行时读数（outbox/timer/workflow/巩固）。 */
  runtimeStatusLines(): Promise<string[]>
  /** LISTEN 连接的可观测读数（三段各一行）。 */
  listenStatusLines(): string[]
  teardownSteps(): readonly TeardownStep[]
}

/** 半启动清理：失败/original 错误优先，收尾失败只吞掉，不掩盖启动错误。 */
async function stopQuietly(target: { stop(): Promise<void> } | undefined): Promise<void> {
  if (target === undefined) return
  try {
    await target.stop()
  } catch {
    // 启动失败路径的清理失败没有调用方可处理；下一次真实调用会重建。
  }
}

async function closeQuietly(target: { close(): Promise<void> } | undefined): Promise<void> {
  if (target === undefined) return
  try {
    await target.close()
  } catch {
    // 同上。
  }
}

/** 运行时未启动/未测量时的统一读数：显式 unknown + 原因，不把“没跑”报成 0。 */
export function runtimeUnknownLines(jobsEnabled: boolean, reason: string): string[] {
  // 后台任务关闭时，真正原因不是 DB/启动错误：如实说是配置关掉的。
  const detail = jobsEnabled ? reason : 'jobs-disabled'
  return [
    'outbox=unknown',
    `outboxReason=${detail}`,
    'timer=unknown',
    `timerReason=${detail}`,
    'workflow=unknown',
    `workflowReason=${detail}`,
    'consolidation=unknown',
    `consolidationReason=${detail}`,
  ]
}

export function createEventRuntime(deps: EventRuntimeDeps): EventRuntime {
  const { store, embedder, queue, clock, logger } = deps
  /** 事件运行时：DB ready 且投影启动之后才构造/启动（task-42 的顺序要求）。 */
  let runtimeStarted = false
  let outboxNotifier: PostgresOutboxNotifier | undefined
  let outboxRelay: OutboxRelay | undefined
  /**
   * 死信读取/重放与 relay 共用同一个 `PostgresOutboxStore` 实例（无状态）。
   * relay 的 `OutboxStore` 端口不含运维面，status 的 dead 读数从这里读。
   */
  let outboxReplayStore: PostgresOutboxStore | undefined
  let reactionRegistry: ReactionRegistry | undefined
  /** 合法 topic 的明确 ack 计数；进程内累计，和 relay 的 delivered/dead 同口径。 */
  const reactionAcks: ReactionAckMetrics = createReactionAckMetrics()
  let timerNotifier: PostgresTimerNotifier | undefined
  let timerWorker: TimerWorker | undefined
  let workflowRuntime: WorkflowRuntime | undefined
  // runtime.stats() 的 dead/completed 是**本进程累计**；status 里的 workflow 状态计数
  // 要读 DB 行状态，所以单独保留 workflow store 的实时读数入口。
  let workflowStoreRef: PostgresWorkflowStore | undefined
  /** 进行中的一次有界对账：三个 notifier 同时重连时合并，避免重复查询。 */
  let reconcileRunning: Promise<void> | undefined

  /**
   * LISTEN 连接的可观测读数（三段各一行）：是否连着、重连了几次、发起过几次连接。
   *
   * 断连后不再静默停摆：重连计数在 `omb_status` 里可见，`connected=false` 表示退避中。
   * 未启动（jobs=false / 初始化失败）时显式报 unknown，不伪报 true。
   */
  function listenStatusLines(): string[] {
    const line = (label: string, notifier: { status(): ListenNotifierStatus } | undefined): string[] => {
      if (notifier === undefined) {
        return [`${label}ListenConnected=unknown ${label}ListenReconnects=unknown ${label}ListenAttempts=unknown`]
      }
      const status = notifier.status()
      return [
        [
          `${label}ListenConnected=${status.connected}`,
          `${label}ListenReconnects=${status.reconnects}`,
          `${label}ListenAttempts=${status.connectAttempts}`,
        ].join(' '),
        ...(status.lastError === undefined ? [] : [`${label}ListenLastError=${status.lastError}`]),
      ]
    }
    return [
      ...line('projection', deps.projectionNotifier()),
      ...line('outbox', outboxNotifier),
      ...line('timer', timerNotifier),
    ]
  }

  /**
   * 一次性、有界的对账：各查一次“有没有到期/旧 pending”，有就叫醒对应循环。
   *
   * 触发点只有两个：LISTEN 重连成功、`omb_status` 调用——两者都不是固定节拍，
   * 所以它既不让漏掉的 NOTIFY 变成永久停摆，也不额外引入轮询。
   * 数据库重启会让三个 notifier 同时重连：这里合并成一次对账，仍然是“有界一次”。
   */
  async function reconcileOnce(source: 'reconnect' | 'status'): Promise<void> {
    const running = reconcileRunning
    if (running !== undefined) {
      await running
      return
    }
    const run = runReconcile(source)
    reconcileRunning = run
    try {
      await run
    } finally {
      if (reconcileRunning === run) reconcileRunning = undefined
    }
  }

  async function runReconcile(source: 'reconnect' | 'status'): Promise<void> {
    const pending: Promise<unknown>[] = []
    if (outboxRelay !== undefined) pending.push(outboxRelay.reconcile())
    if (timerWorker !== undefined) pending.push(timerWorker.recover())
    workflowRuntime?.wake()
    if (pending.length === 0) return
    const settled = await Promise.allSettled(pending)
    const failed = settled.filter(item => item.status === 'rejected')
    if (failed.length > 0) {
      const reasons = failed
        .map(item => (item.status === 'rejected' ? messageOf(item.reason) : ''))
        .filter(reason => reason.length > 0)
        .join('; ')
      logger.warn('事件运行时对账失败（下一次 status/重连会再试）', { source, reasons })
    }
  }

  /** 重连回调里触发一次对账；失败只记日志，绝不把异常抛进 pg 的事件循环/宿主。 */
  function scheduleReconcile(): void {
    void reconcileOnce('reconnect').catch(error => {
      logger.warn('事件运行时对账异常', messageOf(error))
    })
  }

  /**
   * 构造并启动事件运行时（outbox relay / timer worker / workflow runtime）。
   *
   * 失败时把已启动的循环停掉、LISTEN 连接关掉再抛出，由 LazyInitializer 的下一次真实
   * 调用整体重试，不留半启动的 worker/连接。
   */
  async function start(): Promise<void> {
    if (runtimeStarted) return
    const outboxListen = new PostgresOutboxNotifier({ connectionString: deps.databaseUrl })
    const timerListen = new PostgresTimerNotifier({ connectionString: deps.databaseUrl })
    const registry = new ReactionRegistry()
    let relay: OutboxRelay | undefined
    let timer: TimerWorker | undefined
    let workflow: WorkflowRuntime | undefined
    try {
      await outboxListen.ready()
      await timerListen.ready()
      const embedReaction: Reaction = createEmbedReaction({ store, queue, embedder, logger })
      for (const topic of EMBED_REACTION_TOPICS) registry.register(topic, embedReaction)
      const refreshReaction: Reaction = createRefreshReaction({ store, queue, logger })
      for (const topic of REFRESH_REACTION_TOPICS) registry.register(topic, refreshReaction)
      // 链接变化 → link-suggest；写事务已完成的副作用 topic 只 ack 并计数（不进死信）。
      const linkReaction: Reaction = createLinkSuggestReaction({ queue })
      for (const topic of LINK_REACTION_TOPICS) registry.register(topic, linkReaction)
      const ackReaction: Reaction = createAckReaction({ metrics: reactionAcks })
      for (const topic of WRITE_SIDE_EFFECT_TOPICS) registry.register(topic, ackReaction)
      const outboxStore = new PostgresOutboxStore(store.db)
      relay = new OutboxRelay(
        {
          store: outboxStore,
          registry,
          clock,
          wake: outboxListen,
          logger,
        },
        { batchSize: 25, leaseMs: 30_000, unknownTopic: 'dead' },
      )
      const workflowStore = new PostgresWorkflowStore(store.db)
      workflow = new WorkflowRuntime(
        { store: workflowStore, clock, logger },
        { batchSize: 10, leaseMs: 30_000 },
      )
      const workflowWake: TimerHandler = {
        topic: WORKFLOW_WAKE_TIMER_TOPIC,
        async run(): Promise<void> {
          workflow?.wake()
        },
      }
      timer = new TimerWorker(
        {
          store: deps.timerStore,
          // 顺序有含义：status 里 timerTopics 先报 workflow wake，再报巩固任务 schedule。
          handlers: [workflowWake, deps.consolidationTimerHandler],
          clock,
          wake: timerListen,
          logger,
        },
        { batchSize: 25, leaseMs: 30_000 },
      )
      relay.start()
      timer.start()
      workflow.start()
      const recovered = await workflow.recover()
      // 断线重连只触发一次有界对账，不引入固定轮询；close 时 notifier 会清掉这些监听。
      outboxListen.onReconnect(() => {
        logger.info('outbox LISTEN 已重连', outboxListen.status())
        scheduleReconcile()
      })
      timerListen.onReconnect(() => {
        logger.info('timer LISTEN 已重连', timerListen.status())
        scheduleReconcile()
      })
      // 全部成功后才回写状态：失败时不留“看起来在跑”的引用。
      outboxNotifier = outboxListen
      timerNotifier = timerListen
      reactionRegistry = registry
      outboxRelay = relay
      outboxReplayStore = outboxStore
      timerWorker = timer
      workflowRuntime = workflow
      workflowStoreRef = workflowStore
      runtimeStarted = true
      logger.info('事件运行时已启动', {
        order: 'projection→outbox→timer→workflow',
        outboxTopics: registry.topics(),
        timerTopics: timer.topics(),
        workflowDefinitions: workflow.names(),
        unknownTopic: 'dead',
        recovered,
      })
    } catch (error) {
      runtimeStarted = false
      // 先停循环再关 LISTEN：反过来会让仍在跑的循环失去唤醒通道/连接。
      await stopQuietly(workflow)
      await stopQuietly(timer)
      await stopQuietly(relay)
      await closeQuietly(timerListen)
      await closeQuietly(outboxListen)
      throw error
    }
  }

  /**
   * `omb_status` 的事件运行时读数：outbox lag/pending/dead、timer due、workflow 状态。
   *
   * 口径说明：relay/timer/workflow 的 dead/delivered/fired 是**本进程累计**（端口只暴露
   * 内存 totals，没有跨进程 dead 聚合查询），这里按进程口径如实输出，不冒充全局总数；
   * pending/claimed/lag 来自各自 store 的实时 SQL。任一查询失败只把对应段落标 unknown，
   * 不影响其它段落的实测读数。
   */
  async function runtimeStatusLines(): Promise<string[]> {
    if (!deps.jobsEnabled) return runtimeUnknownLines(false, 'jobs-disabled')
    if (!runtimeStarted
      || outboxRelay === undefined
      || outboxReplayStore === undefined
      || timerWorker === undefined
      || workflowRuntime === undefined
      || workflowStoreRef === undefined
      || reactionRegistry === undefined) {
      return runtimeUnknownLines(deps.jobsEnabled, deps.startupError() ?? 'not-started')
    }
    const lines: string[] = []
    try {
      const stats = await outboxRelay.stats()
      // status 调用时做一次有界“叫醒”：有 pending 就 wake relay 补一次 drain。
      // 这不是轮询——只有用户/模型真的调用 omb_status 时才发生。
      if (stats.pending > 0) outboxRelay.wake()
      const acked = reactionAcks.snapshot()
      const ackedTotal = Object.values(acked).reduce((sum, count) => sum + count, 0)
      const ackedByTopic = Object.entries(acked).map(([topic, count]) => `${topic}:${count}`).join(',') || 'none'
      lines.push(
        'outbox=ok',
        // pending/claimed/lag 是实时 SQL；dead/delivered/acked 是本进程累计（端口只暴露
        // 内存 totals），用 scope 标清口径，不把进程读数当成全局总数。
        `outboxLagMs=${stats.oldestAgeMs} outboxPending=${stats.pending} outboxClaimed=${stats.claimed} outboxDead=${stats.dead} outboxDeadScope=process`,
        `outboxDelivered=${stats.delivered} outboxSkipped=${stats.skipped} outboxRetried=${stats.retried} outboxLost=${stats.lost} outboxAcked=${ackedTotal} outboxAckedScope=process`,
        // 合法 topic 被明确 ack（写事务已完成副作用）的逐 topic 计数：它不是 dead，也不是
        // 未注册 topic 的 skip；运维可以据此判断“事件确实被看过”。
        `outboxAckedByTopic=${ackedByTopic}`,
        `outboxTopics=${reactionRegistry.topics().join(',') || 'none'} outboxUnknownTopic=dead`,
      )
      if (stats.lastError !== undefined) lines.push(`outboxLastError=${stats.lastError}`)
      // 死信原因来自真实表：进程累计的 outboxDead 只覆盖本进程，跨进程/重启后的死信必须查库。
      try {
        const dead = await outboxReplayStore.deadSummary(3)
        lines.push(`outboxDeadRows=${dead.count} outboxDeadRowsScope=db`)
        for (const row of dead.rows) {
          lines.push(
            `outboxDeadRecent=id=${row.id} attempts=${row.attempts} topic=${row.topic} error=${JSON.stringify(row.lastError)}`,
          )
        }
      } catch (error) {
        lines.push('outboxDeadRows=unknown', `outboxDeadReason=${messageOf(error)}`)
      }
    } catch (error) {
      lines.push('outbox=unknown', `outboxReason=${messageOf(error)}`)
    }
    try {
      const stats = await timerWorker.stats()
      // 与 outbox 同款：有未派发的 timer 就 wake 一次，让停在“无未来到期”的循环重新算延时。
      if (stats.pending > 0) timerWorker.wake()
      lines.push(
        'timer=ok',
        `timerPending=${stats.pending} timerClaimed=${stats.claimed} timerDueAgeMs=${stats.oldestDueAgeMs} timerDead=${stats.deadTimers}`,
        `timerFired=${stats.fired} timerRetried=${stats.retried} timerTopics=${timerWorker.topics().join(',') || 'none'}`,
      )
      if (stats.lastError !== undefined) lines.push(`timerLastError=${stats.lastError}`)
    } catch (error) {
      lines.push('timer=unknown', `timerReason=${messageOf(error)}`)
    }
    try {
      // run 状态计数读 DB（pending/running/waiting/completed/failed/dead/cancelled），
      // 进程累计（本进程领取/推进/死信）另列，避免把 totals 当成全局死信数。
      const storeStats = await workflowStoreRef.stats()
      const processStats = await workflowRuntime.stats()
      lines.push(
        'workflow=ok',
        `workflowPending=${storeStats.pending} workflowRunning=${storeStats.running} workflowWaiting=${storeStats.waiting} workflowDead=${storeStats.dead}`,
        `workflowCompleted=${storeStats.completed} workflowFailed=${storeStats.failed} workflowDueAgeMs=${storeStats.oldestDueAgeMs}`,
        `workflowDeadLettered=${processStats.dead} workflowRetried=${processStats.retried} workflowSteps=${processStats.steps}`,
        `workflowDefinitions=${workflowRuntime.names().join(',') || 'none'}`,
      )
      if (processStats.lastError !== undefined) lines.push(`workflowLastError=${processStats.lastError}`)
    } catch (error) {
      lines.push('workflow=unknown', `workflowReason=${messageOf(error)}`)
    }
    lines.push(...(await deps.consolidationStatusLines()))
    return lines
  }

  /** 每个 worker 与它的 notifier 分成两步，worker 卡住超时也不会让 LISTEN 连接泄漏。 */
  function teardownSteps(): readonly TeardownStep[] {
    return [
      { name: 'outbox.relay.stop', run: () => outboxRelay?.stop() },
      { name: 'timer.worker.stop', run: () => timerWorker?.stop() },
      { name: 'workflow.runtime.stop', run: () => workflowRuntime?.stop() },
      { name: 'outbox.notifier.close', run: () => outboxNotifier?.close() },
      { name: 'timer.notifier.close', run: () => timerNotifier?.close() },
    ]
  }

  return {
    start,
    scheduleReconcile,
    runtimeStatusLines,
    listenStatusLines,
    teardownSteps,
  }
}
