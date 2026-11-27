/**
 * 懒初始化编排：把数据库迁移、投影链路、pg-boss 队列、事件运行时、巩固调度的启动
 * 串成一次性初始化，交给 `LazyInitializer` 做单飞 + 失败重试 + 冷却。
 *
 * 为什么不是一个大的 `await ready`：DSH 的 `apply` 是同步组合根，插件加载时数据库可能
 * 还没起来；把首次失败永久缓存会让整个进程在数据库恢复后仍然不可用，必须重启 DSH
 * 才能重新探测。这里的约定是：
 *
 * - 加载期只发起一次后台初始化，不阻塞宿主；
 * - 失败只记录“上一次错误”，下一次真实调用仍会重试；
 * - 分步幂等：迁移成功后不再重跑；队列注册/启动失败后只补未完成的部分。
 */
import { migrateDatabase } from '../../packages/v7/src/adapters/postgres/migrate.js'
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { PostgresLifecycle } from '../../packages/v7/src/adapters/postgres/lifecycle.js'
import type { PostgresMaintenance } from '../../packages/v7/src/adapters/postgres/maintenance.js'
import type { OnnxEmbedder } from '../../packages/v7/src/adapters/embedding/index.js'
import type { PgBossQueue } from '../../packages/v7/src/adapters/pg-boss/index.js'
import { registerConsolidationJobs, registerEmbedJob } from '../../packages/v7/src/jobs/index.js'
import type { DynamicService } from '../../packages/v7/src/app/dynamic.js'
import type { UpdateService } from '../../packages/v7/src/app/update.js'
import { err, type Result } from '../../packages/v7/src/domain/errors.js'
import type { Clock } from '../../packages/v7/src/ports/clock.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import { LazyInitializer } from './startup.js'
import { messageOf } from './messages.js'
import type { V7Config } from './config.js'
import type { ConsolidationRuntime } from './consolidation.js'
import type { EventRuntime } from './event-runtime.js'
import type { ProjectionRuntime } from './projection.js'

export interface BootDeps {
  readonly config: V7Config
  readonly logger: Logger
  readonly clock: Clock
  readonly lifecycle: PostgresLifecycle | undefined
  readonly store: PostgresStore
  readonly embedder: OnnxEmbedder
  readonly queue: PgBossQueue
  readonly maintenance: PostgresMaintenance
  readonly updateService: UpdateService
  readonly dynamicService: DynamicService
  readonly projection: ProjectionRuntime
  readonly eventRuntime: EventRuntime
  readonly consolidation: ConsolidationRuntime
}

export interface BootHandle {
  readonly startup: LazyInitializer
  /** 工具调用前的就绪检查：未就绪返回可重试的 `db-unavailable`，而不是把错误抛给宿主。 */
  requireReady(): Promise<Result<never> | undefined>
}

export function createBoot(deps: BootDeps): BootHandle {
  const { config, logger, clock, store, embedder, queue } = deps
  let migrated = false
  let embedJobRegistered = false
  let consolidationJobsRegistered = false
  let queueStarted = false

  const startup = new LazyInitializer({
    cooldownMs: 1_000,
    onError: error => logger.error(`v7 启动失败（下次调用会重试）：${messageOf(error)}`),
    initialize: async () => {
      // 分步幂等：迁移成功后不再重跑；队列注册/启动失败后只补未完成的部分。
      // 这样数据库在插件启动后才恢复时，不需要重启 DSH。
      await deps.lifecycle?.ensureStarted()
      if (config.autoMigrate && !migrated) {
        await migrateDatabase(config.databaseUrl, config.adminDatabaseUrl)
        migrated = true
      }
      // 投影不依赖后台任务开关：jobs=false 也要维护读模型/提供 lag 读数。
      if (!deps.projection.started) await deps.projection.start()
      if (!config.jobs) return
      if (!embedJobRegistered) {
        await registerEmbedJob(queue, { store, embedder })
        embedJobRegistered = true
      }
      if (!consolidationJobsRegistered) {
        const registered = await registerConsolidationJobs(queue, {
          store,
          queries: deps.maintenance,
          updateService: deps.updateService,
          clock,
          logger,
          dynamic: deps.dynamicService,
          embedder,
        }, { scheduler: deps.consolidation.scheduler })
        deps.consolidation.setRegisteredJobs(registered)
        consolidationJobsRegistered = true
      }
      if (!queueStarted) {
        await queue.start()
        queueStarted = true
      }
      // 事件运行时必须在投影之后（task-42）且在队列启动之后：reaction 要往已启动的队列入队。
      await deps.eventRuntime.start()
      // 没有固定 loop：启动只做一次**幂等**排期——已 armed 的 timer 原样保留（崩溃期间
      // 逾期的到期后立刻执行），缺失的才补一条立即到期的。之后由 timer 到期 + 任务
      // 执行完的 rearm 续期；不再有 setInterval/固定节拍。
      await deps.consolidation.ensure()
    },
  })

  async function requireReady(): Promise<Result<never> | undefined> {
    if (await startup.ensureReady()) return undefined
    return err({
      code: 'db-unavailable',
      message: startup.error ?? '数据库尚未就绪',
      retryable: true,
    })
  }

  // 加载期只发起、不等待；失败由下一次真实调用重试。
  void startup.ensureReady()

  return { startup, requireReady }
}
