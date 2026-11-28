/**
 * `omb_status` 的实现：每个读数都来自一次真实探测，不读缓存、不伪报健康。
 *
 * 先做一次真实连接探测（`select 1`），数据库恢复时立刻反映出来并触发被跳过的初始化；
 * 各段（投影/事件运行时/巩固/LISTEN/宿主面/任务健康）独立失败隔离，
 * 一处查询失败只把该段标 unknown + 原因。
 */
import type { PgBossQueue } from '../../packages/v7/src/adapters/pg-boss/index.js'
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { OnnxEmbedder } from '../../packages/v7/src/adapters/embedding/index.js'
import type { JobFinalFailureSummary } from '../../packages/v7/src/ports/jobs.js'
import { describeJobHealth } from '../../packages/v7/src/adapters/pg-boss/index.js'
import { ok, type Result } from '../../packages/v7/src/domain/errors.js'
import type { LazyInitializer } from './startup.js'
import type { V7Config } from './config.js'
import type { Supervisor } from './supervisor.js'
import { messageOf } from './messages.js'
import { runtimeUnknownLines } from './event-runtime.js'

export interface StatusDeps {
  readonly config: V7Config
  readonly supervisor: Supervisor
  readonly store: PostgresStore
  readonly embedder: OnnxEmbedder
  readonly queue: PgBossQueue
  readonly startup: LazyInitializer
  readonly projectionStatusLines: () => Promise<string[]>
  readonly runtimeStatusLines: () => Promise<string[]>
  readonly listenStatusLines: () => string[]
  /** 主动记忆两条提示通道是否真的接上；不把“代码存在”当成“模型看得到”。 */
  readonly promptSurface: () => {
    readonly protocol: boolean
    readonly checkpoint: boolean
    /** T0 常驻注入；它与检查点走不同的 context，任一失败都必须可见。 */
    readonly injection: boolean
    readonly reasons: readonly string[]
  }
}

export async function createStatusTool(deps: StatusDeps): Promise<Result<string>> {
  const { config, supervisor, store, embedder, queue, startup } = deps
  // 宿主面读数：每次状态调用做一次真实自检（tools.get），不轮询、不缓存成 7/7。
  const surfaceLines = supervisor.statusLines()
  const prompt = deps.promptSurface()
  const promptLines = prompt.protocol && prompt.checkpoint && prompt.injection
    ? ['prompt=protocol+checkpoint+t0']
    : [
        'prompt=degraded',
        ...(prompt.reasons.length === 0 ? [] : [`promptReason=${prompt.reasons.join('; ')}`]),
      ]
  // 持久最终失败与连接探测分开：数据库不可达时也要如实报“查不到”，
  // 不能因为 db=down 就把跨进程的失败显示成 0。
  let finalFailureHealth: {
    finalFailures?: JobFinalFailureSummary
    finalFailureError?: string
  } = {}
  if (config.jobs) {
    try {
      finalFailureHealth = { finalFailures: await queue.finalFailures(5) }
    } catch (error) {
      finalFailureHealth = { finalFailureError: messageOf(error) }
    }
  }
  // 先做一次真实连接探测，而不是相信启动时的旧错误。数据库已经恢复时
  // 这里必须立刻反映出来，并触发一次被跳过的初始化。
  try {
    await store.db.query('select 1')
  } catch (error) {
    // 数据库不可达时任务同样跑不了；已有的 handler 失败仍要报出来，不能因为
    // db=down 就把队列侧的错误吞掉。
    return ok([
      'db=down',
      `reason=${messageOf(error)}`,
      'projection=unknown',
      'projectionReason=db-down',
      ...runtimeUnknownLines(config.jobs, 'db-down'),
      // 数据库不可达时 LISTEN 也必然断开/在退避：连接读数正是这时候最该如实报出来。
      ...deps.listenStatusLines(),
      ...describeJobHealth({
        enabled: config.jobs,
        initialized: false,
        failures: queue.handlerFailures(),
        ...finalFailureHealth,
      }),
      ...surfaceLines,
      ...promptLines,
    ].join('\n'))
  }
  const initialized = await startup.ensureReady({ force: true })
  try {
    const counts = await store.db.query<{ kind: string; count: string }>(
      `select kind, count(*)::text as count from omb.entity where archived_at is null group by kind order by kind`,
    )
    const archived = await store.db.query<{ count: string }>('select count(*)::text as count from omb.entity where archived_at is not null')
    const meta = await store.db.query<{ key: string; value: Record<string, unknown> }>(
      'select key, value from omb.meta order by key',
    )
    const embeddingAvailable = await embedder.available().catch(() => false)
    const embeddingReason = embedder.unavailableReason()
    const lines = [
      `db=ok`,
      `entities=${counts.rows.map(row => `${row.kind}:${row.count}`).join(', ') || 'none'}`,
      `archived=${archived.rows[0]?.count ?? '0'}`,
      `embedding=${embeddingAvailable ? embedder.model : 'unavailable'}`,
      ...(embeddingReason === undefined ? [] : [`embeddingReason=${embeddingReason}`]),
      `meta=${meta.rows.map(row => `${row.key}:${JSON.stringify(row.value)}`).join(',') || 'none'}`,
      ...describeJobHealth({
        enabled: config.jobs,
        initialized,
        failures: queue.handlerFailures(),
        ...finalFailureHealth,
      }),
      ...(await deps.projectionStatusLines()),
      ...(await deps.runtimeStatusLines()),
      // LISTEN 断连不再静默：connected/reconnects 是运维判断“要不要重启”的第一手读数。
      ...deps.listenStatusLines(),
      ...surfaceLines,
      ...promptLines,
    ]
    if (!initialized && startup.error !== undefined) {
      lines.push(`startup=degraded`, `reason=${startup.error}`)
    }
    return ok(lines.join('\n'))
  } catch (error) {
    return ok([
      'db=error',
      `reason=${messageOf(error)}`,
      'projection=unknown',
      'projectionReason=status-query-failed',
      ...runtimeUnknownLines(config.jobs, 'status-query-failed'),
      ...deps.listenStatusLines(),
      ...describeJobHealth({
        enabled: config.jobs,
        initialized,
        failures: queue.handlerFailures(),
        ...finalFailureHealth,
      }),
      ...surfaceLines,
      ...promptLines,
    ].join('\n'))
  }
}
