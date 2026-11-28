/**
 * OMB v7 组合根：装配适配器 → 服务 → 运行时 → 宿主面，返回同步 disposer。
 *
 * 装配顺序：配置/日志/自检 → 数据库/嵌入/队列 → 服务与检索 → T1 会话态 →
 * 巩固调度 → 投影链路 → 事件运行时 → 懒初始化（加载期只发起、不等待）→ 工具/事件/钩子 →
 * 卸载收尾。每个职责拆在独立模块里（config/hooks/t1-session/runtime/status/teardown），
 * 本文件只保留 wiring 与顺序。
 *
 * 不变量：加载期不因数据库不可用而抛；错误在首次真实调用时返回可重试错误；
 * `apply` 同步返回 disposer；钩子注册失败只记进 Supervisor，不抛宿主。
 */
import { readFile, realpath } from 'node:fs/promises'
import { OnnxEmbedder } from '../../packages/v7/src/adapters/embedding/index.js'
import { DefaultDynamicResolver } from '../../packages/v7/src/adapters/dynamic/index.js'
import { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import { PostgresMaintenance } from '../../packages/v7/src/adapters/postgres/maintenance.js'
import { PostgresLifecycle } from '../../packages/v7/src/adapters/postgres/lifecycle.js'
import { PostgresJobFailureLog } from '../../packages/v7/src/adapters/postgres/jobs.js'
import { PgBossQueue } from '../../packages/v7/src/adapters/pg-boss/index.js'
import { PostgresTimerStore } from '../../packages/v7/src/adapters/postgres/timer.js'
import { createDshTaskReader } from '../../packages/v7/src/adapters/dsh/tasks.js'
import { createLogger, createPromptSink, type HostContextLike } from '../../packages/v7/src/adapters/dsh/host.js'
import { registerTools } from '../../packages/v7/src/adapters/dsh/tools.js'
import { DynamicService } from '../../packages/v7/src/app/dynamic.js'
import { RecallService } from '../../packages/v7/src/app/recall.js'
import { RememberService } from '../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../packages/v7/src/app/update.js'
import { RecallEngine } from '../../packages/v7/src/retrieval/engine.js'
import type { Clock } from '../../packages/v7/src/ports/clock.js'
import { Supervisor } from './supervisor.js'
import { registerSkills } from './skills.js'
import { registerMemoryProtocol } from './memory-protocol.js'
import { parseConfig } from './config.js'
import { createBoot } from './boot.js'
import { createConsolidationRuntime } from './consolidation.js'
import { createEventRuntime, type EventRuntime } from './event-runtime.js'
import { createProjectionRuntime } from './projection.js'
import { createHostHooks } from './hooks.js'
import { createStatusTool, type StatusDeps } from './status.js'
import { createToolRuntime } from './tool-runtime.js'
import { createT1Session } from './t1-session.js'
import { createDisposer } from './teardown.js'
import type { LazyInitializer } from './startup.js'

export function apply(ctx: HostContextLike, rawConfig?: unknown): () => void {
  const parsed = parseConfig(rawConfig)
  const logger = createLogger(ctx)
  // 宿主面自检：记录承诺注册的 7 个工具 / 4 个钩子与真实结果，供 omb_status 报读数。
  const supervisor = new Supervisor({ ctx, logger })
  for (const problem of parsed.problems) logger.warn(`配置问题：${problem}`)
  const config = parsed.config
  const clock: Clock = { now: () => new Date(), iso: () => new Date().toISOString() }
  const lifecycle = config.managePostgres && config.postgresBinDir !== undefined && config.postgresDataDir !== undefined
    ? new PostgresLifecycle({
        binDir: config.postgresBinDir,
        dataDir: config.postgresDataDir,
        adoptExisting: config.adoptExisting,
        ...(config.postgresLogPath !== undefined ? { logPath: config.postgresLogPath } : {}),
      })
    : undefined
  const store = new PostgresStore(config.databaseUrl)
  const embedder = new OnnxEmbedder({ ...(config.embeddingModelDir !== undefined ? { modelDir: config.embeddingModelDir } : {}) })
  const queue = new PgBossQueue({
    connectionString: config.databaseUrl,
    failureLog: new PostgresJobFailureLog(store.db),
    logger,
  })
  const rememberService = new RememberService({
    store,
    embedder,
    ...(config.jobs ? { jobs: queue } : {}),
    clock,
    logger,
  })
  // schema 没有 stale 列（001_init.sql 的 omb.embedding 只有 model/dims/embedding）：
  // 更新正文后先删旧向量行，让 vector 通道在 omb.embed 重建完成前拿不到旧文本的向量。
  const updateService = new UpdateService({
    store,
    embedder,
    ...(config.jobs ? { jobs: queue } : {}),
    clock,
    logger,
    invalidateEmbedding: entityId => store.deleteEmbedding(entityId),
  })
  const dynamicService = new DynamicService({
    store,
    resolver: new DefaultDynamicResolver({
      realpath,
      ...(config.urlAllowlist.length > 0
        ? {
            url: {
              enabled: true,
              allowlist: config.urlAllowlist,
              allowPrivateAddresses: config.urlAllowPrivateAddresses,
              timeoutMs: config.urlTimeoutMs,
              maxBytes: config.urlMaxBytes,
            },
          }
        : {}),
    }),
    clock,
    readFile: path => readFile(path, 'utf8'),
    taskReader: createDshTaskReader(ctx),
  })
  const engine = new RecallEngine({ store, embedder, clock })

  const session = createT1Session({ store, logger })
  const recallService = new RecallService(engine, dynamicService, injection => session.rememberPendingRecall(injection))

  const maintenance = new PostgresMaintenance(store.db)
  // timer 适配器无状态：worker 与 durable 调度共用一个实例，避免两套连接/两套语义。
  const timerStore = new PostgresTimerStore(store.db)

  // 运行时未启动时 status 的 reason：读 `startup.error`，不缓存第二份错误。
  // 用 holder 让「投影/事件运行时先构造、boot 后构造」的顺序不产生可变绑定。
  const startupRef: { current?: LazyInitializer } = {}
  const startupError = (): string | undefined => startupRef.current?.error

  // 巩固调度必须先于事件运行时构造：timer handler 要注入 TimerWorker 的 handlers。
  // `queries` 让 forget 的 workflow step 与后台 handler 用同一份维护查询。
  const consolidation = createConsolidationRuntime({ store, queue, clock, logger, timerStore, queries: maintenance, startupError })
  // 投影的 LISTEN 重连对账落在事件运行时上；用 holder 打破二者构造顺序（运行时才调用）。
  const handles: { event?: EventRuntime } = {}
  const projection = createProjectionRuntime({
    databaseUrl: config.databaseUrl,
    store,
    clock,
    logger,
    startupError,
    onReconnect: () => handles.event?.scheduleReconcile(),
  })
  const eventRuntime = createEventRuntime({
    databaseUrl: config.databaseUrl,
    jobsEnabled: config.jobs,
    store,
    embedder,
    queue,
    clock,
    logger,
    timerStore,
    // 真实业务 workflow 定义（forget）；绑定后 timer 到期才有地方 start run。
    workflowDefinitions: consolidation.workflows,
    bindConsolidationWorkflow: consolidation.bindWorkflowStart,
    consolidationTimerHandler: consolidation.timerHandler,
    consolidationStatusLines: consolidation.statusLines,
    projectionNotifier: projection.notifier,
    startupError,
  })
  handles.event = eventRuntime

  // 加载期只发起、不等待初始化；失败由下一次真实调用重试。
  const boot = createBoot({
    config,
    logger,
    clock,
    lifecycle,
    store,
    embedder,
    queue,
    maintenance,
    updateService,
    dynamicService,
    projection,
    eventRuntime,
    consolidation,
  })
  startupRef.current = boot.startup

  const statusDeps: StatusDeps = {
    config,
    supervisor,
    store,
    embedder,
    queue,
    startup: boot.startup,
    projectionStatusLines: () => projection.statusLines(),
    runtimeStatusLines: () => eventRuntime.runtimeStatusLines(),
    listenStatusLines: () => eventRuntime.listenStatusLines(),
    promptSurface: () => ({
      protocol: protocol.available,
      checkpoint: checkpointSink.available,
      injection: promptSink.available,
      reasons: [
        ...(protocol.reason === undefined ? [] : [`protocol: ${protocol.reason}`]),
        ...(checkpointSink.reason === undefined ? [] : [`checkpoint: ${checkpointSink.reason}`]),
        ...(promptSink.reason === undefined ? [] : [`injection: ${promptSink.reason}`]),
      ],
    }),
  }
  // 只在 `omb_status` 被真实调用时探测；不在加载期跑状态查询。
  const status = () => createStatusTool(statusDeps)

  const runtime = createToolRuntime({
    requireReady: () => boot.requireReady(),
    rememberService,
    updateService,
    recallService,
    store,
    status,
  })

  const tools = registerTools(ctx, runtime, logger)
  supervisor.recordToolRegistration(tools)
  // 4 篇功能说明走宿主 skills provider；加载期不读盘，由 provider 惰性读取。
  const skillsOff = registerSkills(ctx, logger)
  const protocol = registerMemoryProtocol(ctx, logger)
  const promptSink = createPromptSink(ctx)
  if (!promptSink.available) logger.warn(`提示注入未接线：${promptSink.reason ?? '未知原因'}`)
  // 检查点单独一条 context，紧跟在 T0 后；T0 的数据头不能承载行为要求。
  const checkpointSink = createPromptSink(ctx, {
    name: 'omb-v7:memory-checkpoint',
    orderOffset: 6,
    required: true,
  })
  if (!checkpointSink.available) logger.warn(`记忆检查点未接线：${checkpointSink.reason ?? '未知原因'}`)

  const hooks = createHostHooks({
    ctx,
    supervisor,
    logger,
    config,
    store,
    engine,
    promptSink,
    checkpointSink,
    session,
    boards: () => projection.residentBoardsOptions(),
  })
  // 注册期事实落一条摘要日志：工具数/钩子数 + 未接线原因（audit R01）。
  supervisor.logWiringSummary()

  return createDisposer({
    logger,
    tools,
    capture: hooks.capture,
    skillsOff,
    protocolOff: protocol.dispose,
    promptSink,
    checkpointSink,
    hooks: hooks.offs,
    session,
    eventSteps: eventRuntime.teardownSteps(),
    projectionSteps: projection.teardownSteps(),
    queue,
    store,
    lifecycle,
  })
}
