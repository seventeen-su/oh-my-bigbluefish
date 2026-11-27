/**
 * OMB v7 宿主入口：单行插件，无 HTTP、无浏览器 bundle。
 *
 * 装配顺序：数据库迁移（可关）→ pg-boss → 工具 / 事件 / pre-step。
 * 加载期不因数据库不可用而抛；错误在首次真实调用时返回。
 */
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { OnnxEmbedder } from '../../packages/v7/src/adapters/embedding/index.js'
import { DefaultDynamicResolver } from '../../packages/v7/src/adapters/dynamic/index.js'
import { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import { PostgresMaintenance } from '../../packages/v7/src/adapters/postgres/maintenance.js'
import { migrateDatabase } from '../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresLifecycle } from '../../packages/v7/src/adapters/postgres/lifecycle.js'
import { PostgresJobFailureLog } from '../../packages/v7/src/adapters/postgres/jobs.js'
import { PgBossQueue, describeJobHealth } from '../../packages/v7/src/adapters/pg-boss/index.js'
import type { JobFinalFailureSummary } from '../../packages/v7/src/ports/jobs.js'
import { createEventCapture } from '../../packages/v7/src/adapters/dsh/events.js'
import { createDshTaskReader } from '../../packages/v7/src/adapters/dsh/tasks.js'
import { asRecord, createLogger, createPromptSink, sessionFromExec, type HostContextLike, type ToolContext } from '../../packages/v7/src/adapters/dsh/host.js'
import {
  registerTools,
  resolveToolContext,
  type AdminToolArgs,
  type RecallToolArgs,
  type ToolRuntime,
} from '../../packages/v7/src/adapters/dsh/tools.js'
import { DynamicService } from '../../packages/v7/src/app/dynamic.js'
import { RecallService, recallScenarioForQuery, type RecallInjection } from '../../packages/v7/src/app/recall.js'
import { RememberService } from '../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../packages/v7/src/app/update.js'
import { OmbFailure, err, ok, type Result } from '../../packages/v7/src/domain/errors.js'
import type { PatchEntityInput, WriteEntityInput } from '../../packages/v7/src/domain/entity.js'
import { extractQuerySignals } from '../../packages/v7/src/domain/text.js'
import type { LinkInput } from '../../packages/v7/src/domain/link.js'
import { registerConsolidationJobs, registerEmbedJob, startConsolidationLoop } from '../../packages/v7/src/jobs/index.js'
import { RecallEngine } from '../../packages/v7/src/retrieval/engine.js'
import type { RecallScenario } from '../../packages/v7/src/retrieval/types.js'
import { buildEventRecallText, buildResident } from '../../packages/v7/src/recall/resident.js'
import { LazyInitializer } from './startup.js'
import { Supervisor, runTeardownSteps, wireHostHook, type TeardownStep } from './supervisor.js'
import {
  hasStrongSignal,
  isRecallTriggerEvent,
  recallContentFingerprint,
  shouldRecallOnPreStep,
  shouldRecallToolResult,
  stepKeyOf,
  toolFailed,
} from './t1.js'

export interface V7Config {
  readonly databaseUrl: string
  readonly adminDatabaseUrl?: string
  readonly embeddingModelDir?: string
  readonly residentBudget: number
  readonly jobs: boolean
  readonly autoMigrate: boolean
  readonly managePostgres: boolean
  readonly postgresBinDir?: string
  readonly postgresDataDir?: string
  readonly postgresLogPath?: string
  readonly adoptExisting: boolean
  /** 空数组表示 url 动态值保持关闭；配置后仍需 allowlist + 私网/环回排除。 */
  readonly urlAllowlist: readonly string[]
  readonly urlAllowPrivateAddresses: boolean
  readonly urlTimeoutMs: number
  readonly urlMaxBytes: number
}

export interface ParsedV7Config {
  readonly config: V7Config
  readonly problems: readonly string[]
}

const DEFAULT_DATABASE_URL = 'postgres://omb:omb@127.0.0.1:5432/omb'

export function parseConfig(raw: unknown): ParsedV7Config {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const problems: string[] = []
  const stringValue = (key: string): string | undefined => {
    const value = record[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push(`${key} 必须是非空字符串`)
      return undefined
    }
    return value
  }
  const boolValue = (key: string, fallback: boolean): boolean => {
    const value = record[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') {
      problems.push(`${key} 必须是 boolean`)
      return fallback
    }
    return value
  }
  const numberValue = (key: string, fallback: number, min: number, max: number): number => {
    const value = record[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      problems.push(`${key} 必须在 ${min}-${max} 之间`)
      return fallback
    }
    return Math.floor(value)
  }
  const stringArrayValue = (key: string): readonly string[] => {
    const value = record[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim().length > 0)) {
      problems.push(`${key} 必须是非空字符串数组`)
      return []
    }
    return value
  }
  const databaseUrl = stringValue('databaseUrl') ?? process.env.OMB_DATABASE_URL ?? DEFAULT_DATABASE_URL
  const adminDatabaseUrl = stringValue('adminDatabaseUrl') ?? process.env.OMB_ADMIN_DATABASE_URL
  const embeddingModelDir = stringValue('embeddingModelDir') ?? process.env.OMB_EMBEDDING_MODEL
  const managePostgres = boolValue('managePostgres', false)
  const postgresBinDir = stringValue('postgresBinDir') ?? process.env.OMB_PG_BIN_DIR
  const postgresDataDir = stringValue('postgresDataDir') ?? process.env.OMB_PG_DATA_DIR
  const postgresLogPath = stringValue('postgresLogPath') ?? process.env.OMB_PG_LOG_PATH
  if (managePostgres && (postgresBinDir === undefined || postgresDataDir === undefined)) {
    problems.push('managePostgres=true 时必须同时配置 postgresBinDir 和 postgresDataDir')
  }
  return {
    config: {
      databaseUrl,
      ...(adminDatabaseUrl !== undefined ? { adminDatabaseUrl } : {}),
      ...(embeddingModelDir !== undefined ? { embeddingModelDir } : {}),
      ...(postgresBinDir !== undefined ? { postgresBinDir } : {}),
      ...(postgresDataDir !== undefined ? { postgresDataDir } : {}),
      ...(postgresLogPath !== undefined ? { postgresLogPath } : {}),
      residentBudget: numberValue('residentBudget', 600, 100, 2000),
      jobs: boolValue('jobs', true),
      autoMigrate: boolValue('autoMigrate', true),
      managePostgres,
      adoptExisting: boolValue('adoptExisting', false),
      urlAllowlist: stringArrayValue('urlAllowlist'),
      urlAllowPrivateAddresses: boolValue('urlAllowPrivateAddresses', false),
      urlTimeoutMs: numberValue('urlTimeoutMs', 5_000, 250, 60_000),
      urlMaxBytes: numberValue('urlMaxBytes', 256 * 1024, 1024, 4 * 1024 * 1024),
    },
    problems,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultError(error: unknown): Result<never> {
  if (error instanceof OmbFailure) return err(error.error)
  return err({ code: 'internal', message: messageOf(error) })
}

function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = typeof messages[index] === 'object' && messages[index] !== null ? messages[index] as Record<string, unknown> : undefined
    if (message === undefined) continue
    const source = typeof message['source'] === 'object' && message['source'] !== null ? message['source'] as Record<string, unknown> : undefined
    const content = message['content']
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => {
            if (typeof block === 'string') return block
            const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
            return typeof record?.['text'] === 'string' ? record['text'] as string : ''
          }).filter(Boolean).join('\n')
        : ''
    if (text.trim().length > 0 && (source?.['kind'] === 'user' || source?.['kind'] === undefined)) return text.trim()
  }
  return undefined
}

function lastToolText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = typeof messages[index] === 'object' && messages[index] !== null ? messages[index] as Record<string, unknown> : undefined
    if (message === undefined) continue
    const source = typeof message['source'] === 'object' && message['source'] !== null ? message['source'] as Record<string, unknown> : undefined
    if (source?.['kind'] !== 'tool' && message['role'] !== 'tool') continue
    const content = message['content']
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => {
            if (typeof block === 'string') return block
            const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
            return typeof record?.['text'] === 'string' ? record['text'] as string : ''
          }).filter(Boolean).join('\n')
        : ''
    if (text.trim().length > 0) return text
  }
  return undefined
}

/** 取最近 N 条非空消息文本；用于 T1 查询的“最近几轮”，而不是只看最后一条。 */
function lastRoundsText(messages: unknown, rounds: number): string | undefined {
  if (!Array.isArray(messages) || rounds <= 0) return undefined
  const texts: string[] = []
  for (let index = messages.length - 1; index >= 0 && texts.length < rounds; index -= 1) {
    const message = typeof messages[index] === 'object' && messages[index] !== null ? messages[index] as Record<string, unknown> : undefined
    if (message === undefined) continue
    const content = message['content']
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => {
            if (typeof block === 'string') return block
            const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
            return typeof record?.['text'] === 'string' ? record['text'] as string : ''
          }).filter(Boolean).join('\n')
        : ''
    if (text.trim().length > 0) texts.push(text.trim())
  }
  return texts.length === 0 ? undefined : texts.reverse().join('\n')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
    promise.then(value => {
      clearTimeout(timer)
      resolve(value)
    }).catch(() => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

const SESSION_STATE_LIMIT = 256

/** 会话级 Map 的 LRU 上限：长会话/多会话运行时不能无限增长（RET-13）。 */
function rememberSessionState<T>(map: Map<string, T>, sessionId: string, value: T): void {
  map.delete(sessionId)
  map.set(sessionId, value)
  while (map.size > SESSION_STATE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function formatWrite(result: Awaited<ReturnType<RememberService['remember']>>): string {
  if (!result.ok) return ''
  const written = result.value
  const lines = [`已写入 ${written.entity.kind} ${written.entity.id}（revision ${written.entity.revision}，嵌入 ${written.embedding}）`]
  if (written.similarAttributes.length > 0) {
    lines.push(`相似属性：${written.similarAttributes.slice(0, 8).map(item => `${item.name}(${item.usageCount})`).join('、')}`)
  }
  if (written.similarEntities.length > 0) {
    lines.push(`相似记忆：${written.similarEntities.slice(0, 5).map(item => `${item.title ?? item.id}(${item.id})`).join('；')}`)
  }
  if (written.archivedMatches.length > 0) {
    lines.push(`已归档冲突：${written.archivedMatches.slice(0, 3).map(item => `${item.title ?? item.id}(${item.id})`).join('；')}`)
  }
  return lines.join('\n')
}

function formatPatch(result: Awaited<ReturnType<UpdateService['update']>>): string {
  if (!result.ok) return ''
  const patched = result.value
  return `已更新 ${patched.entity.kind} ${patched.entity.id}（revision ${patched.entity.revision}）` +
    (patched.history === undefined ? '' : `；历史 ${patched.history.id}`)
}

/** 从 DSH content block 数组提取可检索文本；图片等非文本块跳过。 */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(part => part.length > 0).join('\n')
  const record = asRecord(value)
  if (record === undefined) return ''
  if (typeof record['text'] === 'string') return record['text']
  if (typeof record['content'] === 'string') return record['content']
  return ''
}

function toolResultText(result: unknown): string {
  const record = asRecord(result)
  if (record === undefined) return ''
  const parts = [contentText(record['content']), contentText(record['value'])]
  const error = asRecord(record['error'])
  if (error !== undefined) {
    parts.push([error['name'], error['code'], error['reason']]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' '))
  }
  return parts.filter(part => part.length > 0).join('\n')
}

export function apply(ctx: HostContextLike, rawConfig?: unknown): () => void {
  const parsed = parseConfig(rawConfig)
  const logger = createLogger(ctx)
  // 宿主面自检：记录承诺注册的 7 个工具 / 4 个钩子与真实结果，供 omb_status 报读数。
  const supervisor = new Supervisor({ ctx, logger })
  for (const problem of parsed.problems) logger.warn(`配置问题：${problem}`)
  const config = parsed.config
  const clock = { now: () => new Date(), iso: () => new Date().toISOString() }
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
  // 会话级 T1 状态：全部按 sessionId 键控，session/disposed 与插件卸载时清理（RET-13/RUN-05）。
  const pendingRecall = new Map<string, RecallInjection[]>()
  // T1 由 session/event 触发；pre-step 消费后清空，避免重复注入。
  const pendingT1 = new Map<string, { readonly scenario: RecallScenario; readonly query: string }>()
  // tools/post-execute 已经即时注入的 T1 文本；下一次 pre-step 直接复用，避免同一次工具结果重复召回。
  const immediateT1 = new Map<string, string>()
  // tools/pre-execute 在派发前启动的召回；post-execute 有结果后优先复用，避免重复查库。
  // 带上 sessionId 才能在 session/disposed 时清掉未消费的预取。
  const prefetchedT1 = new Map<string, { readonly sessionId: string; readonly promise: Promise<string> }>()
  // 最近一次 pre-step 的 turn/step：post-execute 没有步号，只能沿用它判断「本步是否已投递 T1」。
  const currentStep = new Map<string, { readonly turn: number; readonly step: number; readonly key: string }>()
  // 已经消费过 T1 的步键（pre-step 或工具结果）。
  const t1Step = new Map<string, string>()
  const recallService = new RecallService(engine, dynamicService, injection => {
    const list = pendingRecall.get(injection.sessionId) ?? []
    list.push(injection)
    pendingRecall.set(injection.sessionId, list)
  })

  const maintenance = new PostgresMaintenance(store.db)
  let stopConsolidation: (() => void) | undefined
  let migrated = false
  let embedJobRegistered = false
  let consolidationJobsRegistered = false
  let queueStarted = false
  let consolidationStarted = false
  const startup = new LazyInitializer({
    cooldownMs: 1_000,
    onError: error => logger.error(`v7 启动失败（下次调用会重试）：${messageOf(error)}`),
    initialize: async () => {
      // 分步幂等：迁移成功后不再重跑；队列注册/启动失败后只补未完成的部分。
      // 这样数据库在插件启动后才恢复时，不需要重启 DSH。
      await lifecycle?.ensureStarted()
      if (config.autoMigrate && !migrated) {
        await migrateDatabase(config.databaseUrl, config.adminDatabaseUrl)
        migrated = true
      }
      if (!config.jobs) return
      if (!embedJobRegistered) {
        await registerEmbedJob(queue, { store, embedder })
        embedJobRegistered = true
      }
      if (!consolidationJobsRegistered) {
        await registerConsolidationJobs(queue, {
          store,
          queries: maintenance,
          updateService,
          clock,
          logger,
          dynamic: dynamicService,
          embedder,
        })
        consolidationJobsRegistered = true
      }
      if (!queueStarted) {
        await queue.start()
        queueStarted = true
      }
      if (!consolidationStarted) {
        stopConsolidation = startConsolidationLoop(queue, logger)
        consolidationStarted = true
      }
    },
  })
  // 加载期只发起、不等待；失败由下一次真实调用重试。
  void startup.ensureReady()

  async function requireReady(): Promise<Result<never> | undefined> {
    if (await startup.ensureReady()) return undefined
    return err({
      code: 'db-unavailable',
      message: startup.error ?? '数据库尚未就绪',
      retryable: true,
    })
  }

  const runtime: ToolRuntime = {
    context: resolveToolContext,
    async remember(input: WriteEntityInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await rememberService.remember(input)
        return result.ok ? ok(formatWrite(result)) : result
      } catch (error) {
        return resultError(error)
      }
    },
    async recall(input: RecallToolArgs, context: ToolContext): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      return recallService.recall(input, context)
    },
    async update(input: PatchEntityInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await updateService.update(input)
        return result.ok ? ok(formatPatch(result)) : result
      } catch (error) {
        return resultError(error)
      }
    },
    async link(input: LinkInput): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const result = await store.link(input)
        return ok(`${result.created ? '已建立' : '已存在'}链接 ${result.link.fromId} -[${result.link.relation}]-> ${result.link.toId}`)
      } catch (error) {
        return resultError(error)
      }
    },
    async unlink(id: string): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        await store.unlink(id, 'model')
        return ok(`已归档链接 ${id}`)
      } catch (error) {
        return resultError(error)
      }
    },
    async history(id: string, limit: number): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        const versions = await store.history(id, limit)
        if (versions.length === 0) return ok(`状态机 ${id} 暂无历史版本`)
        return ok(versions.map(version => `${version.id} rev=${version.revision} status=${version.status} time=${version.time}`).join('\n'))
      } catch (error) {
        return resultError(error)
      }
    },
    async status(): Promise<Result<string>> {
      // 宿主面读数：每次状态调用做一次真实自检（tools.get），不轮询、不缓存成 7/7。
      const surfaceLines = supervisor.statusLines()
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
          ...describeJobHealth({
            enabled: config.jobs,
            initialized: false,
            failures: queue.handlerFailures(),
            ...finalFailureHealth,
          }),
          ...surfaceLines,
        ].join('\n'))
      }
      const initialized = await startup.ensureReady({ force: true })
      try {
        const counts = await store.db.query<{ kind: string; count: string }>(
          `select kind, count(*)::text as count from omb.entity where archived_at is null group by kind order by kind`,
        )
        const archived = await store.db.query<{ count: string }>('select count(*)::text as count from omb.entity where archived_at is not null')
        const lines = [
          `db=ok`,
          `entities=${counts.rows.map(row => `${row.kind}:${row.count}`).join(', ') || 'none'}`,
          `archived=${archived.rows[0]?.count ?? '0'}`,
          `embedding=${await embedder.available().catch(() => false) ? embedder.model : 'unavailable'}`,
          ...describeJobHealth({
            enabled: config.jobs,
            initialized,
            failures: queue.handlerFailures(),
            ...finalFailureHealth,
          }),
          ...surfaceLines,
        ]
        if (!initialized && startup.error !== undefined) {
          lines.push(`startup=degraded`, `reason=${startup.error}`)
        }
        return ok(lines.join('\n'))
      } catch (error) {
        return ok([
          'db=error',
          `reason=${messageOf(error)}`,
          ...describeJobHealth({
            enabled: config.jobs,
            initialized,
            failures: queue.handlerFailures(),
            ...finalFailureHealth,
          }),
          ...surfaceLines,
        ].join('\n'))
      }
    },
    async admin(input: AdminToolArgs): Promise<Result<string>> {
      const unavailable = await requireReady()
      if (unavailable !== undefined) return unavailable
      try {
        if (input.action === 'audit') {
          const rows = await store.listAudit(input.limit ?? 20)
          if (rows.length === 0) return ok('暂无审计记录')
          return ok(rows.map(row => `${row.id} ${row.action} by=${row.actor} at=${row.createdAt} rolled=${row.rolledBackAt ?? 'no'}`).join('\n'))
        }
        if (input.action === 'archive' || input.action === 'unarchive') {
          if (input.targetId === undefined) return err({ code: 'invalid-input', message: `${input.action} 需要 targetId` })
          if (input.action === 'archive') await store.archive(input.targetId, input.reason ?? 'manual', 'model')
          else await store.unarchive(input.targetId, input.reason ?? 'manual', 'model')
          return ok(`${input.action === 'archive' ? '已归档' : '已取消归档'} ${input.targetId}`)
        }
        if (input.auditId === undefined) return err({ code: 'invalid-input', message: 'rollback 需要 auditId' })
        const result = await store.rollback(input.auditId, 'model')
        return ok(`已回滚审计 ${result.auditId}；新审计 ${result.rollbackAuditId}；动作 ${result.applied.join(', ')}`)
      } catch (error) {
        return resultError(error)
      }
    },
  }

  const tools = registerTools(ctx, runtime, logger)
  supervisor.recordToolRegistration(tools)
  const promptSink = createPromptSink(ctx)
  if (!promptSink.available) logger.warn(`提示注入未接线：${promptSink.reason ?? '未知原因'}`)

  const residentCache = new Map<string, { readonly turn: number | undefined; readonly text: string }>()
  // 已投递 T1 的跨 step 内容指纹（session+query+result，不含 turn/step）；
  // 同一步的配额由 t1Step 负责，这里挡住「步号变了、内容没变」的重复注入。
  const lastT1 = new Map<string, string>()
  // 钩子 disposer 在接线处一次性取得；卸载时逐个调用，任一失败不阻断后续。

  /** 清掉一个 session 的全部 T0/T1 会话态，并清空它的 system prompt 文本。 */
  const clearSessionState = (sessionId: string): void => {
    pendingRecall.delete(sessionId)
    pendingT1.delete(sessionId)
    immediateT1.delete(sessionId)
    residentCache.delete(sessionId)
    lastT1.delete(sessionId)
    currentStep.delete(sessionId)
    t1Step.delete(sessionId)
    for (const [callId, entry] of prefetchedT1) {
      if (entry.sessionId === sessionId) prefetchedT1.delete(callId)
    }
    promptSink.write(sessionId, '')
  }

  const rememberInjection = (sessionId: string, notice: { traceId: string; hits: readonly { id: string; title?: string }[] }): void => {
    if (notice.hits.length === 0) return
    const list = pendingRecall.get(sessionId) ?? []
    list.push({ sessionId, traceId: notice.traceId, hits: notice.hits })
    pendingRecall.set(sessionId, list)
  }

  const adoptPending = (sessionId: string, text: string, kind: 'text' | 'tool'): void => {
    const pending = pendingRecall.get(sessionId)
    if (pending === undefined || pending.length === 0 || text.length === 0) return
    const adopted = new Map<string, { traceId: string; id: string }>()
    for (const injection of pending) {
      for (const hit of injection.hits) {
        const matched = text.includes(hit.id)
          || (hit.title !== undefined && hit.title.length >= 4 && text.includes(hit.title))
        if (matched) adopted.set(`${injection.traceId}\u0000${hit.id}`, { traceId: injection.traceId, id: hit.id })
      }
    }
    pendingRecall.delete(sessionId)
    void Promise.all([...adopted.values()].map(item => store.markAdopted(item.traceId, item.id, kind))).catch(() => {})
  }

  const eventText = (value: unknown): string => {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value) ?? ''
    } catch {
      return ''
    }
  }

  const observeEvent = (sessionId: string, type: string, data: unknown): void => {
    const text = eventText(data)
    if (type === 'assistant/message') {
      adoptPending(sessionId, text, 'text')
      return
    }
    if (type === 'tool/call') {
      adoptPending(sessionId, text, 'tool')
      return
    }
    if (type === 'tool/result') {
      adoptPending(sessionId, text, 'tool')
      return
    }
    if (type.startsWith('compaction/')) {
      residentCache.delete(sessionId)
      // 压缩后旧工具结果的 T1 已经过期；丢掉 immediateT1 与指纹，让待消费事件重新召回。
      immediateT1.delete(sessionId)
      lastT1.delete(sessionId)
      pendingT1.set(sessionId, { scenario: 'session-start', query: text.slice(0, 4_000) })
      return
    }
    if (isRecallTriggerEvent(type)) {
      residentCache.delete(sessionId)
      immediateT1.delete(sessionId)
      lastT1.delete(sessionId)
      pendingT1.set(sessionId, { scenario: 'session-start', query: text.slice(0, 4_000) })
    }
  }

  const capture = createEventCapture({ ctx, store, logger, onEvent: observeEvent })

  /** 在工具派发前启动 T1 召回；不阻塞 dispatch，结果由 post-execute 复用。 */
  const prefetchToolRecall = (exec: unknown, sessionId: string | undefined): void => {
    const record = asRecord(exec)
    const callId = typeof record?.['callId'] === 'string' ? record['callId'] : undefined
    const name = typeof record?.['name'] === 'string' ? record['name'] : ''
    if (callId === undefined || name.length === 0 || name.startsWith('omb_')) return
    const raw = [name, eventText(record?.['arguments'])].filter(part => part.length > 0).join('\n').slice(0, 8_000)
    if (raw.trim().length === 0) return
    // 只有路径/错误码/代码样式标识符才值得在派发前先查一次；普通成功工具不预取。
    if (!hasStrongSignal(raw)) return
    // 本步已经投递过 T1（pre-step 或前一个工具结果），不再为第二个工具预取。
    const position = sessionId === undefined ? undefined : currentStep.get(sessionId)
    if (sessionId !== undefined && position !== undefined && t1Step.get(sessionId) === position.key) return
    const query = (() => {
      const signals = extractQuerySignals(raw)
      return [raw, ...signals.paths, ...signals.errorCodes, ...signals.identifiers.slice(0, 8)].join(' ')
    })()
    const promise = (async (): Promise<string> => {
      const context = await resolveToolContext(exec)
      if (context === undefined) return ''
      return await buildEventRecallText(
        engine,
        context,
        query,
        'tool-before',
        400,
        notice => rememberInjection(context.sessionId, notice),
      )
    })().catch(() => '')
    // 工具被取消时不会走到 post-execute，限制缓存条目避免长期泄漏。
    if (prefetchedT1.size >= 64) {
      const oldest = prefetchedT1.keys().next().value
      if (oldest !== undefined) prefetchedT1.delete(oldest)
    }
    prefetchedT1.set(callId, { sessionId: sessionId ?? '', promise })
  }

  const preExecuteTool = async (exec: unknown, next?: () => unknown): Promise<unknown> => {
    const decision = typeof next === 'function' ? await next() : { kind: 'allow' }
    if (asRecord(decision)?.['kind'] === 'allow') prefetchToolRecall(exec, sessionFromExec(exec)?.sessionId)
    return decision
  }

  /**
   * T1 工具结果通道：tools/post-execute 允许把 additionalContexts 直接挂到本次结果，
   * 模型在下一步就看见，不必等 agent/pre-step。工具调用前没有等价的上下文通道
   * （pre-execute 只能 allow/deny/ask），所以「调用前」仍由上一次 pre-step 的主动召回
   * 覆盖；这里负责调用后的结果与报错。
   */
  const postExecuteTool = async (exec: unknown, result: unknown, next?: () => unknown): Promise<unknown> => {
    const decision = typeof next === 'function' ? await next() : { kind: 'accept' }
    const decisionRecord = asRecord(decision)
    if (decisionRecord === undefined) return decision
    try {
      const execRecord = asRecord(exec)
      const name = typeof execRecord?.['name'] === 'string' ? execRecord['name'] : ''
      const callId = typeof execRecord?.['callId'] === 'string' ? execRecord['callId'] : undefined
      // OMB 自己的工具结果不需要再被 OMB 召回，避免自激。
      if (name.length === 0 || name.startsWith('omb_')) return decision
      const context = await resolveToolContext(exec)
      if (context === undefined) return decision
      const sessionId = context.sessionId
      const argumentsText = eventText(execRecord?.['arguments'])
      const resultText = toolResultText(result)
      const raw = [name, argumentsText, resultText].filter(part => part.length > 0).join('\n').slice(0, 8_000)
      if (raw.trim().length === 0) return decision
      const resultRecord = asRecord(result)
      const failed = toolFailed(resultRecord?.['isError'] === true, resultText)
      // 普通成功工具不召回：只有失败，或参数/结果带路径、错误码、代码样式标识符才进入 T1。
      if (!shouldRecallToolResult({ failed, argumentsText, resultText })) {
        if (callId !== undefined) prefetchedT1.delete(callId)
        return decision
      }
      const position = currentStep.get(sessionId)
      if (position !== undefined && t1Step.get(sessionId) === position.key) {
        // 本步的 T1 已由 pre-step 或前一个工具结果投递；第二个工具不再追加一段。
        if (callId !== undefined) prefetchedT1.delete(callId)
        return decision
      }
      const signals = extractQuerySignals(raw)
      const query = [raw, ...signals.paths, ...signals.errorCodes, ...signals.identifiers.slice(0, 8)].join(' ')
      // 跨 step 内容指纹：同一个工具结果重复出现时不重复注入；步内配额由 t1Step 负责。
      const fingerprint = recallContentFingerprint({ sessionId, query, result: resultText })
      if (lastT1.get(sessionId) === fingerprint) {
        if (callId !== undefined) prefetchedT1.delete(callId)
        return decision
      }
      const prefetched = callId === undefined ? undefined : prefetchedT1.get(callId)?.promise
      if (callId !== undefined) prefetchedT1.delete(callId)
      // 成功的工具优先复用派发前的召回；报错时结果里的错误码更有价值，重新查一次。
      let injected = !failed && prefetched !== undefined
        ? await withTimeout(prefetched, 500) ?? ''
        : ''
      if (injected.length === 0) {
        injected = await withTimeout(
          buildEventRecallText(
            engine,
            context,
            query,
            failed ? 'tool-error' : 'tool-before',
            400,
            notice => rememberInjection(sessionId, notice),
          ),
          1_500,
        ) ?? ''
      }
      if (injected.length === 0) return decision
      // 只登记真正投递出去的 T1：下一轮 pre-step 认领它，本步配额同时记为已用。
      rememberSessionState(immediateT1, sessionId, injected)
      rememberSessionState(lastT1, sessionId, fingerprint)
      if (position !== undefined) rememberSessionState(t1Step, sessionId, position.key)
      const additional = {
        id: `msg_omb_${randomUUID()}`,
        role: 'user',
        // DSH v4 只接受 producer-owned source：`kind:'plugin'` 已被明确拒绝。
        // 用迁移器给外部插件生成的规范 kind（plugin:<name>），不要带 plugin 字段。
        source: { kind: 'plugin:oh-my-bigbluefish/v7' },
        content: [{ type: 'text', text: injected }],
      }
      const existing = Array.isArray(decisionRecord['additionalContexts'])
        ? decisionRecord['additionalContexts']
        : []
      return { ...decisionRecord, additionalContexts: [...existing, additional] }
    } catch (error) {
      logger.warn('工具结果即时召回失败', messageOf(error))
      return decision
    }
  }

  const preStep = async (payload: unknown, next?: () => unknown): Promise<unknown> => {
    try {
      const context = await resolveToolContext(payload)
      const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined
      if (context !== undefined && record !== undefined) {
        const sessionId = context.sessionId
        const turn = typeof record['turn'] === 'number' ? record['turn'] : undefined
        const step = typeof record['step'] === 'number' ? record['step'] : undefined
        const stepKey = stepKeyOf({ turn, step })
        // post-execute 拿不到步号，只能沿用最近一次 pre-step 的 turn/step 判断本步配额。
        if (turn !== undefined && step !== undefined && stepKey !== undefined) {
          rememberSessionState(currentStep, sessionId, { turn, step, key: stepKey })
        }
        const triggered = pendingT1.get(sessionId)
        if (triggered !== undefined) {
          pendingT1.delete(sessionId)
          // 压缩/子任务切换后常驻层必须重建，不能吃同一 turn 的旧文本。
          residentCache.delete(sessionId)
        }
        const cached = residentCache.get(sessionId)
        let resident = cached !== undefined && cached.turn === turn ? cached.text : ''
        if (resident.length === 0) {
          const built = await withTimeout(
            buildResident(
              engine,
              context,
              config.residentBudget,
              () => store.stats(),
              notice => rememberInjection(sessionId, notice),
              () => store.preferenceSummaries?.(5) ?? Promise.resolve([]),
            ),
            1_500,
          )
          resident = built?.text ?? ''
          if (built !== undefined) {
            const trace = turn === undefined
              ? built.trace
              : { ...built.trace, turnId: String(turn) }
            // trace 是 T0 的预算/裁剪证据；写失败不能阻断本轮注入。
            void store.recordResidentTrace(trace).catch(error => {
              logger.warn('T0 常驻 trace 写入失败', messageOf(error))
            })
            const preferenceHits = built.preferenceHits
            if (preferenceHits.length > 0) {
              const preferenceTraceId = built.trace.traceId
              // 偏好不走 engine.recall；必须单独写 recall_event，后续才能记录 adopted。
              void store.recordRecall(preferenceHits.map((hit, index) => ({
                traceId: preferenceTraceId,
                sessionId,
                ...(turn === undefined ? {} : { turnId: String(turn) }),
                query: 'T0 常驻偏好',
                trigger: 't0',
                entityId: hit.id,
                channel: 'resident',
                rank: index + 1,
                injected: true,
              }))).then(() => {
                // 只有 recall_event 已落库后才登记采用等待，避免 adopted 更新不到行。
                rememberInjection(sessionId, {
                  traceId: preferenceTraceId,
                  hits: preferenceHits,
                })
              }).catch(error => {
                logger.warn('T0 偏好 recall_event 写入失败', messageOf(error))
              })
            }
          }
          rememberSessionState(residentCache, sessionId, { turn, text: resident })
        }
        const userText = lastUserText(record['messages'])
        const toolText = lastToolText(record['messages'])
        const recentText = lastRoundsText(record['messages'], 2)
        const eventSource = [triggered?.query, recentText, userText, toolText]
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .join('\n')
        // 工具结果已经通过 additionalContexts 进入下一步：本步不再把同一段文本写回
        // system prompt，但仍记为本步已消费 T1，避免同一步的后续工具结果再挂一段。
        // 跨 step 的内容指纹不含 turn/step：同一段事件源在下一步不能因步号变化重复召回。
        // 注意 Map.delete 返回 boolean，不是旧文本。
        const contentFingerprint = recallContentFingerprint({ sessionId, query: eventSource })
        const consumedImmediate = immediateT1.delete(sessionId)
        let injected = ''
        if (consumedImmediate) {
          if (stepKey !== undefined) rememberSessionState(t1Step, sessionId, stepKey)
          // 工具结果已经把这批内容送进上下文；下一步事件源不变时 pre-step 不再重复召回。
          if (eventSource.length > 0) rememberSessionState(lastT1, sessionId, contentFingerprint)
        } else if (shouldRecallOnPreStep({ pending: triggered !== undefined, text: eventSource })) {
          const alreadyRecalled = stepKey !== undefined && t1Step.get(sessionId) === stepKey
          if (!alreadyRecalled && lastT1.get(sessionId) !== contentFingerprint) {
            const signals = extractQuerySignals(eventSource)
            const query = [eventSource, ...signals.paths, ...signals.errorCodes, ...signals.identifiers.slice(0, 8)].join(' ')
            const scenario: RecallScenario = triggered?.scenario
              ?? (userText !== undefined && recallScenarioForQuery(userText) === 'last-time'
                ? 'last-time'
                : toolFailed(false, eventSource)
                  ? 'tool-error'
                  : turn === 1 ? 'session-start' : 'manual')
            injected = await withTimeout(
              buildEventRecallText(
                engine,
                context,
                query,
                scenario,
                400,
                notice => rememberInjection(sessionId, notice),
              ),
              1_500,
            ) ?? ''
            if (injected.length > 0) {
              // 只有真正进入 system prompt 的召回才占用本步配额与去重指纹。
              rememberSessionState(lastT1, sessionId, contentFingerprint)
              if (stepKey !== undefined) rememberSessionState(t1Step, sessionId, stepKey)
            }
          }
        }
        const text = [resident, injected].filter(part => part.length > 0).join('\n\n')
        // RUN-04：本次没有 T1（甚至 T0 也为空）时也要覆盖写空串，清掉上一轮旧文本。
        promptSink.write(sessionId, text)
      }
    } catch (error) {
      logger.warn('pre-step 注入失败', messageOf(error))
    }
    if (typeof next !== 'function') {
      return { kind: 'enter', messages: Array.isArray((payload as { messages?: unknown })?.messages) ? (payload as { messages: unknown[] }).messages : [] }
    }
    return next()
  }

  const preStepOff = wireHostHook({ ctx, supervisor, name: 'agent/pre-step', handler: preStep }).off

  const toolPreExecuteOff = wireHostHook({
    ctx,
    supervisor,
    name: 'tools/pre-execute',
    handler: preExecuteTool,
  }).off

  const toolContextOff = wireHostHook({
    ctx,
    supervisor,
    name: 'tools/post-execute',
    handler: postExecuteTool,
  }).off

  // 会话结束必须清掉该 session 的 T0/T1 会话态与 system prompt 文本，
  // 否则长会话/多会话运行时会一直增长并看到已结束会话的旧记忆（RET-13/RUN-05）。
  const sessionDisposedOff = wireHostHook({
    ctx,
    supervisor,
    name: 'session/disposed',
    handler: ((session: unknown) => {
      const record = asRecord(session)
      const id = typeof record?.['id'] === 'string'
        ? record['id']
        : typeof record?.['sessionId'] === 'string'
          ? record['sessionId']
          : undefined
      if (id !== undefined && id.trim().length > 0) clearSessionState(id)
    }),
  }).off
  // 注册期事实落一条摘要日志：工具数/钩子数 + 未接线原因（audit R01）。
  supervisor.logWiringSummary()

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      tools.dispose()
    } catch {
      // 注销失败不阻断卸载。
    }
    try {
      capture.dispose()
    } catch {
      // 同上。
    }
    try {
      promptSink.dispose()
    } catch {
      // 同上。
    }
    try {
      preStepOff?.()
    } catch {
      // 同上。
    }
    try {
      toolContextOff?.()
    } catch {
      // 同上。
    }
    try {
      toolPreExecuteOff?.()
    } catch {
      // 同上。
    }
    try {
      sessionDisposedOff?.()
    } catch {
      // 同上。
    }
    // 卸载后没有任何调用者会再读这些会话态；显式清空，避免热重载时旧缓存跨实例存活。
    pendingRecall.clear()
    pendingT1.clear()
    immediateT1.clear()
    prefetchedT1.clear()
    residentCache.clear()
    lastT1.clear()
    currentStep.clear()
    t1Step.clear()
    try {
      stopConsolidation?.()
    } catch (error) {
      // 巩固循环停不下来不能阻断后面的队列/连接/PG 收尾。
      logger.warn('巩固循环停止失败', messageOf(error))
    }
    // 先让 worker 停掉，再关业务连接池，最后才停便携 PostgreSQL；三个动作不能并发，
    // 否则 queue 仍在跑时 store 已关、或 PG 已被 fast shutdown。每步独立 5s 超时，
    // 超时/失败只记日志并继续，绝不把异常抛回宿主。
    const teardownSteps: TeardownStep[] = [
      { name: 'queue.stop', run: () => queue.stop() },
      { name: 'store.close', run: () => store.close() },
      ...(lifecycle === undefined ? [] : [{ name: 'lifecycle.stop', run: () => lifecycle.stop() }]),
    ]
    void runTeardownSteps(teardownSteps, { logger })
      .then(report => {
        logger.info('teardown 收尾完成', report)
      })
      .catch(error => {
        // runTeardownSteps 约定不 reject；这里只是最后一道保险。
        logger.warn('teardown 收尾异常', messageOf(error))
      })
  }
}

export default apply
