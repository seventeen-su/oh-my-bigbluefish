/**
 * 投影链路的组合根片段：LISTEN notifier、worker、读 API、看板读取器。
 *
 * 顺序固定（task-42）：
 * 1. `notifier.ready()` 先建立 LISTEN（worker/读 API 都靠它被 NOTIFY 唤醒）；
 * 2. `worker.recover()` 统计崩溃遗留的可领取任务（租约到期的 claimed + pending），
 *    启动后的事件循环会立刻 tick 处理；
 * 3. `worker.start()` 后没有 setInterval：只在本批领满时继续 drain，否则等待 NOTIFY/wake。
 *
 * 失败时关闭 notifier 并抛出，由 LazyInitializer 的下一次真实调用整体重试，
 * 不留半启动的 worker/连接。
 */
import {
  createBoardProjectors,
  createBoardReader,
  PostgresProjectionNotifier,
  PostgresProjectionTaskStore,
  REGISTERED_PROJECTIONS,
} from '../../packages/v7/src/adapters/postgres/projection.js'
import { ProjectionReadApi, ProjectionWorker } from '../../packages/v7/src/app/projections/index.js'
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { ListenNotifierStatus } from '../../packages/v7/src/adapters/postgres/listen.js'
import type { ResidentBoardsOptions, ResidentBoardsQuery } from '../../packages/v7/src/recall/resident.js'
import type { Clock } from '../../packages/v7/src/ports/clock.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import type { TeardownStep } from './supervisor.js'
import { messageOf } from './messages.js'

export interface ProjectionRuntimeDeps {
  readonly databaseUrl: string
  readonly store: PostgresStore
  readonly clock: Clock
  readonly logger: Logger
  /** 未启动/启动失败时的原因：读 `startup.error`，不在这里缓存第二份状态。 */
  readonly startupError: () => string | undefined
  /** LISTEN 重连后触发一次有界对账（由组合根接到事件运行时）。 */
  readonly onReconnect: () => void
}

export interface ProjectionRuntime {
  /** 幂等启动：已启动直接返回；失败时清理半启动状态后抛出。 */
  start(): Promise<void>
  readonly started: boolean
  /** `omb_status` 的投影读数；从未成功投影时显式 unknown，不伪报 0。 */
  statusLines(): Promise<string[]>
  /** T0 看板读取器（投影未启动时返回 undefined，回退写模型路径）。 */
  residentBoardsOptions(): ResidentBoardsOptions | undefined
  /** LISTEN notifier（`omb_status` 的三段 LISTEN 读数需要它）；未启动时 undefined。 */
  notifier(): { status(): ListenNotifierStatus } | undefined
  teardownSteps(): readonly TeardownStep[]
}

export function createProjectionRuntime(deps: ProjectionRuntimeDeps): ProjectionRuntime {
  const { databaseUrl, store, clock, logger } = deps
  let projectionStarted = false
  let projectionWorker: ProjectionWorker | undefined
  let projectionReadApi: ProjectionReadApi | undefined
  let projectionNotifier: PostgresProjectionNotifier | undefined
  /** T0 用的看板读取器：除看板行外还要读一次水位新鲜度（worker 停摆时读模型会静默变旧）。 */
  let projectionBoardReader: ReturnType<typeof createBoardReader> | undefined

  async function start(): Promise<void> {
    if (projectionStarted) return
    const notifier = new PostgresProjectionNotifier({ connectionString: databaseUrl })
    projectionNotifier = notifier
    try {
      await notifier.ready()
      const tasks = new PostgresProjectionTaskStore(store.db)
      const boards = createBoardReader(store.db)
      const worker = new ProjectionWorker(
        {
          store: tasks,
          projectors: createBoardProjectors(store.db),
          clock,
          wake: notifier,
          logger,
        },
        { batchSize: 25, leaseMs: 30_000 },
      )
      const recovered = await worker.recover()
      worker.start()
      projectionWorker = worker
      projectionBoardReader = boards
      projectionReadApi = new ProjectionReadApi({
        store: tasks,
        boards,
        clock,
        wake: notifier,
      })
      // LISTEN 断线重连后做一次有界对账（扫一次 lag 并叫醒），不引入固定轮询。
      notifier.onReconnect(() => {
        logger.info('投影 LISTEN 已重连', notifier.status())
        deps.onReconnect()
      })
      projectionStarted = true
      logger.info('投影 worker 已启动', { projections: worker.projections(), recovered })
    } catch (error) {
      projectionWorker = undefined
      projectionReadApi = undefined
      projectionBoardReader = undefined
      await notifier.close().catch(() => {})
      throw error
    }
  }

  /**
   * `omb_status` 的投影读数：每个投影 pending/due/dead/oldestDueAgeMs/watermarkAgeMs。
   * 从未成功投影（没有水位）时 watermarkAgeMs 报 unknown，不伪报 0；
   * DB down / 未初始化 / lag 查询失败时整体报 `projection=unknown` + 原因，同样不伪造读数。
   */
  async function statusLines(): Promise<string[]> {
    if (!projectionStarted || projectionReadApi === undefined) {
      return ['projection=unknown', `projectionReason=${deps.startupError() ?? 'not-started'}`]
    }
    try {
      const lag = await projectionReadApi.lag()
      // status 也是一次有界的“叫醒”机会：worker 停摆（NOTIFY 丢了/连接刚恢复）时
      // 不该等到下一次写入才恢复。这里只 wake，不 tick、不轮询。
      if (lag.some(item => item.due > 0)) projectionWorker?.wake()
      // 只有 writer 真正入队的投影才标 registered=yes：其余读模型还没接线，不能让它看起来在跑。
      const registered = new Set(REGISTERED_PROJECTIONS.map(item => item.projection))
      return [
        'projection=ok',
        ...lag.map(item => [
          `projectionLag:${item.projection}`,
          `pending=${item.pending}`,
          `due=${item.due}`,
          `dead=${item.dead}`,
          `oldestDueAgeMs=${item.oldestDueAgeMs}`,
          `watermarkAgeMs=${item.watermarkAgeMs ?? 'unknown'}`,
          `registered=${registered.has(item.projection) ? 'yes' : 'no'}`,
        ].join(' ')),
      ]
    } catch (error) {
      return ['projection=unknown', `projectionReason=${messageOf(error)}`]
    }
  }

  /**
   * T0 用的投影看板读取器：两块看板（各 1 条 SQL）+ 看板新鲜度（1 条 SQL）。
   *
   * 新鲜度必须来自读模型侧：水位年龄与未投影任务数是判断“worker 是否停摆”的唯一可信
   * 信号，`recall/resident.ts` 只做阈值判断（它不依赖适配器，也就不能自己查库）。
   * 新鲜度查询失败不阻断 T0：退化成“没有新鲜度”的旧语义，并留下日志。
   */
  function residentBoardsOptions(): ResidentBoardsOptions | undefined {
    const api = projectionReadApi
    const boards = projectionBoardReader
    if (!projectionStarted || api === undefined || boards === undefined) return undefined
    return {
      reader: {
        async readResidentBoards(query: ResidentBoardsQuery) {
          const [snapshot, freshness] = await Promise.all([
            api.readResidentBoards(query),
            boards.readFreshness().catch(error => {
              logger.warn('T0 看板新鲜度查询失败', messageOf(error))
              return undefined
            }),
          ])
          return freshness === undefined ? snapshot : { ...snapshot, ...freshness }
        },
      },
    }
  }

  /** worker 与它的 notifier 分开两步：worker 卡住超时也不会让 LISTEN 连接泄漏。 */
  function teardownSteps(): readonly TeardownStep[] {
    return [
      { name: 'projection.worker.stop', run: () => projectionWorker?.stop() },
      { name: 'projection.read.close', run: () => projectionReadApi?.close() },
      { name: 'projection.notifier.close', run: () => projectionNotifier?.close() },
    ]
  }

  return {
    start,
    get started() {
      return projectionStarted
    },
    statusLines,
    residentBoardsOptions,
    notifier: () => projectionNotifier,
    teardownSteps,
  }
}
