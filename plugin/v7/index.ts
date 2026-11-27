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
import {
  createBoardProjectors,
  createBoardReader,
  PostgresProjectionNotifier,
  PostgresProjectionTaskStore,
  REGISTERED_PROJECTIONS,
} from '../../packages/v7/src/adapters/postgres/projection.js'
import { PgBossQueue, describeJobHealth } from '../../packages/v7/src/adapters/pg-boss/index.js'
import { PostgresOutboxNotifier, PostgresOutboxStore } from '../../packages/v7/src/adapters/postgres/outbox.js'
import { PostgresTimerNotifier, PostgresTimerStore } from '../../packages/v7/src/adapters/postgres/timer.js'
import type { ListenNotifierStatus } from '../../packages/v7/src/adapters/postgres/listen.js'
import { PostgresWorkflowStore } from '../../packages/v7/src/adapters/postgres/workflow.js'
import type { JobFinalFailureSummary, JobQueue, Logger } from '../../packages/v7/src/ports/jobs.js'
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
import { embeddingText } from '../../packages/v7/src/app/embedding.js'
import { OutboxRelay, ReactionRegistry, type Reaction } from '../../packages/v7/src/app/outbox/index.js'
import { TimerWorker, WorkflowRuntime, type TimerHandler } from '../../packages/v7/src/app/workflow/index.js'
import { ProjectionReadApi, ProjectionWorker } from '../../packages/v7/src/app/projections/index.js'
import { RecallService, recallScenarioForQuery } from '../../packages/v7/src/app/recall.js'
import { RememberService } from '../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../packages/v7/src/app/update.js'
import { OmbFailure, err, ok, type Result } from '../../packages/v7/src/domain/errors.js'
import type { PatchEntityInput, WriteEntityInput } from '../../packages/v7/src/domain/entity.js'
import type { JsonValue } from '../../packages/v7/src/domain/json.js'
import { extractQuerySignals } from '../../packages/v7/src/domain/text.js'
import type { LinkInput } from '../../packages/v7/src/domain/link.js'
import {
  createConsolidationScheduler,
  registerConsolidationJobs,
  registerEmbedJob,
} from '../../packages/v7/src/jobs/index.js'
import { RecallEngine } from '../../packages/v7/src/retrieval/engine.js'
import type { RecallScenario } from '../../packages/v7/src/retrieval/types.js'
import { buildEventRecallText, buildResident, type RecallNotice, type ResidentBoardsOptions, type ResidentBoardsQuery } from '../../packages/v7/src/recall/resident.js'
import type { InjectionReceipt } from '../../packages/v7/src/prompt/assembler.js'
import { LazyInitializer } from './startup.js'
import { Supervisor, TEARDOWN_STEP_TIMEOUT_MS, runTeardownSteps, wireHostHook, type TeardownStep } from './supervisor.js'
import { registerSkills } from './skills.js'
import {
  hasStrongSignal,
  isRecallTriggerEvent,
  recallContentFingerprint,
  shouldRecallOnPreStep,
  shouldRecallToolResult,
  stepKeyOf,
  toolFailed,
} from './t1.js'
import { appendT1Message, isEnterDecisionLike } from './t1-message.js'

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

/**
 * outbox 里注册了真实 reaction 的 topic。writer 的 `event_type` 就是 outbox `topic`
 * （`adapters/postgres/writer.ts` insertEvent），这里只接实体写入两条；
 * 其余 topic（归档/链接/改名）暂未接线：relay 的 `unknownTopic='dead'` 让它们进死信
 * 并在 status 里可见，而不是静默丢弃。
 */
const EMBED_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/**
 * 事件触发优先：实体写入后动态属性可能已过期（新建时还没有缓存、patch 改了 ref 目标），
 * 所以 Created/Patched 也触发一次合并的 `omb.refresh`。链接/归档不改动态值，仍由 timer 巩固。
 */
const REFRESH_REACTION_TOPICS: readonly string[] = ['EntityCreated', 'EntityPatched']

/**
 * timer 的两类真实消费者：
 * 1. `omb.workflow.wake`：到点唤醒 workflow runtime；
 * 2. `omb.consolidation`：每个巩固任务的 durable schedule 到期，把该任务入队 pg-boss 一次
 *    （见 `jobs/consolidate.ts` 的 `createConsolidationTimerHandler`）。
 * 两者都不是空实现；timer worker 只由 NOTIFY/到期单次唤醒，没有固定轮询。
 */
const WORKFLOW_WAKE_TIMER_TOPIC = 'omb.workflow.wake'

/**
 * outbox payload 是完整的 DomainEvent（writer 的 insertEvent）：实体事件优先读
 * `payload.entityId`，回退 `streamId`。两者都没有时不是实体事件，交给调用方报错。
 */
function entityIdFromOutboxPayload(payload: JsonValue): string | undefined {
  const event = asRecord(payload)
  const data = asRecord(event?.['payload'])
  const fromPayload = data?.['entityId']
  if (typeof fromPayload === 'string' && fromPayload.length > 0) return fromPayload
  const streamId = event?.['streamId']
  return typeof streamId === 'string' && streamId.length > 0 ? streamId : undefined
}

/**
 * EntityCreated / EntityPatched → 入队 `omb.embed`。
 *
 * 幂等：`singletonKey = embed:<entityId>` 让同一实体在已有一个未完成任务时不再建第二个；
 * relay 是 at-least-once（租约过期会重投），重复投递最多重建一次同文本向量，
 * `upsertEmbedding` 按实体覆盖，不会产生第二行。
 *
 * 嵌入器不可用时与 remember/update 同策略：不入队注定失败的任务（由 `omb.embed-sweep`
 * 在嵌入恢复后补齐），并只提示一次，避免每个事件刷日志。
 */
function createEmbedReaction(deps: {
  readonly store: PostgresStore
  readonly queue: JobQueue
  readonly embedder: OnnxEmbedder
  readonly logger: Logger
}): Reaction {
  let unavailableLogged = false
  return {
    name: 'enqueue-embed',
    async run(event): Promise<void> {
      const entityId = entityIdFromOutboxPayload(event.payload)
      if (entityId === undefined) {
        // 不是实体事件却注册到了实体 topic：抛错让 relay 走退避/死信，问题在 status 可见。
        throw new Error(`outbox ${event.topic} 事件缺少 entityId（event_id=${event.eventId}）`)
      }
      const entity = await deps.store.get(entityId, { includeArchived: true })
      if (entity === undefined) return
      const text = embeddingText(entity.attributes)
      if (text.trim().length === 0) return
      if (!(await deps.embedder.available().catch(() => false))) {
        if (!unavailableLogged) {
          unavailableLogged = true
          deps.logger.warn('嵌入器不可用：事件驱动嵌入暂不入队，等 omb.embed-sweep 补齐')
        }
        return
      }
      await deps.queue.enqueue('omb.embed', { entityId, text }, { singletonKey: `embed:${entityId}`, retryLimit: 3 })
    },
  }
}

/**
 * EntityCreated / EntityPatched → 合并入队一次 `omb.refresh`（事件触发优先）。
 *
 * 只有实体真的带动态属性才入队：`omb.refresh` 是“扫 staleDynamic”的聚合任务，
 * 普通记忆入队只会空跑一次全表查询。`singletonKey` 固定为 `refresh:event`，
 * 所以一次事件风暴最多留下一个待跑任务，不按事件放大。
 *
 * 与 embed reaction 同款：载荷不是实体事件时抛错让 relay 进死信（status 可见），
 * 不静默丢弃。
 */
function createRefreshReaction(deps: {
  readonly store: PostgresStore
  readonly queue: JobQueue
  readonly logger: Logger
}): Reaction {
  return {
    name: 'enqueue-refresh',
    async run(event): Promise<void> {
      const entityId = entityIdFromOutboxPayload(event.payload)
      if (entityId === undefined) {
        throw new Error(`outbox ${event.topic} 事件缺少 entityId（event_id=${event.eventId}）`)
      }
      const entity = await deps.store.get(entityId, { includeArchived: true })
      if (entity === undefined) return
      if (!entity.attributes.some(attribute => attribute.value.kind === 'dynamic')) return
      await deps.queue.enqueue('omb.refresh', { entityId }, { singletonKey: 'refresh:event', retryLimit: 3 })
    },
  }
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

/**
 * 一次 pre-step 里 T1 的准备结果。
 *
 * 配额/指纹不在这里登记：只有 decision 明确 `enter`、T1 消息真的追加进本步，
 * 这次召回才算投递过；`reject` 的 step 不消费 T1。
 */
interface PreparedT1Injection {
  readonly sessionId: string
  /** 本轮要追加进 decision.messages 的 T1 文本；空串表示本步不注入。 */
  readonly text: string
  /** 工具结果已通过 additionalContexts 投递过 T1：本步只登记配额，不重复追加。 */
  readonly immediate: boolean
  /** 跨 step 内容指纹；只有真正投递/消费时才登记。 */
  readonly fingerprint: string | undefined
  readonly stepKey: string | undefined
  /** 本次装配的 receipt/命中；只有文本真的追加进 decision.messages 时才登记采用。 */
  readonly notice?: RecallNotice
}

/** tools/pre-execute 预取的 T1：文本真正挂到结果上时，用它携带的 notice 登记 receipt 与采用等待。 */
interface PrefetchedT1 {
  readonly text: string
  readonly notice?: RecallNotice
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
  /**
   * 一次等待采用的注入：hits 必须来自这次注入的（T1）receipt，而不是检索候选全集。
   * T0 的偏好/状态命中没有逐实体 receipt（常驻段是整段块），由 recall 层按 receipt
   * 的 kept/隔离先过滤；T1 在 adoptPending 里再按 receipt 复核一次。
   */
  interface PendingInjection {
    readonly sessionId: string
    readonly traceId: string
    readonly hits: readonly { readonly id: string; readonly title?: string }[]
    readonly receipt?: InjectionReceipt
  }

  /** 会话级 T1 状态：全部按 sessionId 键控，session/disposed 与插件卸载时清理（RET-13/RUN-05）。 */
  const pendingRecall = new Map<string, PendingInjection[]>()
  // T1 由 session/event 触发；pre-step 消费后清空，避免重复注入。
  const pendingT1 = new Map<string, { readonly scenario: RecallScenario; readonly query: string }>()
  // tools/post-execute 已经即时注入的 T1 文本；下一次 pre-step 直接复用，避免同一次工具结果重复召回。
  const immediateT1 = new Map<string, string>()
  // tools/pre-execute 在派发前启动的召回；post-execute 有结果后优先复用，避免重复查库。
  // 带上 sessionId 才能在 session/disposed 时清掉未消费的预取；notice 只在真正复用时登记。
  const prefetchedT1 = new Map<string, { readonly sessionId: string; readonly promise: Promise<PrefetchedT1> }>()
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
  // timer 适配器无状态：worker 与 durable 调度共用一个实例，避免两套连接/两套语义。
  const timerStore = new PostgresTimerStore(store.db)
  /**
   * 巩固任务的 durable 调度器（jobs 层窄接口的唯一入口）：
   * - `schedule` 直接走 timer 适配器（同 dedupeKey 是重排期，不是新增行）；
   * - `armed` 一次查询判断“该任务是否已有 pending/claimed 行”；
   * - timer handler 到期只把对应任务入队 pg-boss 一次。
   * 不引入新表/迁移，只读现有的 omb.timer。
   */
  const consolidationScheduler = createConsolidationScheduler({
    timers: {
      schedule: input => timerStore.schedule(input),
      armed: keys => readArmedConsolidationKeys(keys),
    },
    queue,
    clock,
    logger,
  })
  let migrated = false
  let embedJobRegistered = false
  let consolidationJobsRegistered = false
  let queueStarted = false
  /** 真实注册成功的巩固任务名：只给它们排期，没 handler 的任务不建空跑 timer。 */
  let consolidationJobs: readonly string[] = []
  let consolidationStarted = false
  // 投影读模型：DB ready 后由组合根构造 task store / LISTEN notifier / worker / 读 API。
  let projectionStarted = false
  let projectionWorker: ProjectionWorker | undefined
  let projectionReadApi: ProjectionReadApi | undefined
  let projectionNotifier: PostgresProjectionNotifier | undefined
  /** T0 用的看板读取器：除看板行外还要读一次水位新鲜度（worker 停摆时读模型会静默变旧）。 */
  let projectionBoardReader: ReturnType<typeof createBoardReader> | undefined
  // 事件运行时：DB ready 且投影启动之后才构造/启动（task-42 的顺序要求）。
  // relay/timer/workflow 都依赖连接池，必须早于 store.close 停止。
  let runtimeStarted = false
  let outboxNotifier: PostgresOutboxNotifier | undefined
  let outboxRelay: OutboxRelay | undefined
  let reactionRegistry: ReactionRegistry | undefined
  let timerNotifier: PostgresTimerNotifier | undefined
  let timerWorker: TimerWorker | undefined
  let workflowRuntime: WorkflowRuntime | undefined
  // runtime.stats() 的 dead/completed 是**本进程累计**；status 里的 workflow 状态计数
  // 要读 DB 行状态，所以单独保留 workflow store 的实时读数入口。
  let workflowStoreRef: PostgresWorkflowStore | undefined
  /** 进行中的一次有界对账：三个 notifier 同时重连时合并，避免重复查询。 */
  let reconcileRunning: Promise<void> | undefined

  /**
   * 构造并启动投影链路。顺序固定：
   * 1. `notifier.ready()` 先建立 LISTEN（worker/读 API 都靠它被 NOTIFY 唤醒）；
   * 2. `worker.recover()` 统计崩溃遗留的可领取任务（租约到期的 claimed + pending），
   *    启动后的事件循环会立刻 tick 处理；
   * 3. `worker.start()` 后没有 setInterval：只在本批领满时继续 drain，否则等待 NOTIFY/wake。
   *
   * 失败时关闭 notifier 并抛出，由 LazyInitializer 的下一次真实调用整体重试，
   * 不留半启动的 worker/连接。
   */
  async function startProjection(): Promise<void> {
    const notifier = new PostgresProjectionNotifier({ connectionString: config.databaseUrl })
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
        scheduleReconcile()
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
  async function projectionStatusLines(): Promise<string[]> {
    if (!projectionStarted || projectionReadApi === undefined) {
      return ['projection=unknown', `projectionReason=${startup.error ?? 'not-started'}`]
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
      ...line('projection', projectionNotifier),
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
    if (projectionWorker !== undefined) pending.push(projectionWorker.recover())
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
   * 单次定时器；本函数不新增 setInterval。
   *
   * 断连恢复：两个 LISTEN 连接自带指数退避重连（`adapters/postgres/listen.ts`），重连成功后
   * 重新 LISTEN、唤醒对应 worker，并触发一次有界 `reconcileOnce()`（数一次旧 pending/到期
   * timer 并叫醒）。这样数据库重启/kill 连接后不需要重启插件，也不会靠固定轮询兜底；
   * `OutboxRelay.reconcile()` 因此有了真实消费者，不再是一条没接线的安全网。
   *
   * 失败时把已启动的循环停掉、LISTEN 连接关掉再抛出，由 LazyInitializer 的下一次真实
   * 调用整体重试，不留半启动的 worker/连接。
   */
  async function startRuntime(): Promise<void> {
    if (runtimeStarted) return
    const outboxListen = new PostgresOutboxNotifier({ connectionString: config.databaseUrl })
    const timerListen = new PostgresTimerNotifier({ connectionString: config.databaseUrl })
    const registry = new ReactionRegistry()
    let relay: OutboxRelay | undefined
    let timer: TimerWorker | undefined
    let workflow: WorkflowRuntime | undefined
    try {
      await outboxListen.ready()
      await timerListen.ready()
      const embedReaction = createEmbedReaction({ store, queue, embedder, logger })
      for (const topic of EMBED_REACTION_TOPICS) registry.register(topic, embedReaction)
      const refreshReaction = createRefreshReaction({ store, queue, logger })
      for (const topic of REFRESH_REACTION_TOPICS) registry.register(topic, refreshReaction)
      relay = new OutboxRelay(
        {
          store: new PostgresOutboxStore(store.db),
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
          store: timerStore,
          // 顺序有含义：status 里 timerTopics 先报 workflow wake，再报巩固任务 schedule。
          handlers: [workflowWake, consolidationScheduler.timerHandler],
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
   * 只给真实注册了 handler 的任务排期：没有 handler 的 timer 到期只会入队一个
   * 没人消费的 pg-boss 任务（看起来在跑，实际空转）。
   */
  function consolidationSchedules() {
    return consolidationScheduler.schedules.filter(schedule => consolidationJobs.includes(schedule.job))
  }

  /**
   * 已有 pending/claimed timer 的 dedupeKey（一次查询）。
   *
   * 同时给调度器的排期和 status 的自愈判据用：armed 的任务不动，缺失的才补。
   */
  async function readArmedConsolidationKeys(keys: readonly string[]): Promise<ReadonlySet<string>> {
    if (keys.length === 0) return new Set<string>()
    const rows = await store.db.query<{ dedupe_key: string }>(
      `select distinct dedupe_key
         from omb.timer
        where dedupe_key = any($1::text[]) and status in ('pending', 'claimed')`,
      [keys],
    )
    return new Set(rows.rows.map(row => row.dedupe_key))
  }

  interface ConsolidationTimerSnapshot {
    readonly pending: number
    readonly claimed: number
    readonly done: number
    readonly dead: number
    readonly dueAgeMs: number
    readonly nextDueAt?: string
  }

  /** 巩固调度的 timer 行读数：只认 `consolidation:` 前缀，业务 timer 不混进来。 */
  async function readConsolidationTimers(): Promise<ConsolidationTimerSnapshot> {
    const result = await store.db.query<{
      pending: number
      claimed: number
      done: number
      dead: number
      due_age_ms: number
      next_due: Date | string | null
    }>(
      `select
         count(*) filter (where status = 'pending')::int as pending,
         count(*) filter (where status = 'claimed')::int as claimed,
         count(*) filter (where status = 'done')::int as done,
         count(*) filter (where status = 'dead')::int as dead,
         coalesce(
           (extract(epoch from (
             now() - min(due_at) filter (where status in ('pending', 'claimed') and due_at <= now())
           )) * 1000)::int,
           0
         ) as due_age_ms,
         min(due_at) filter (where status in ('pending', 'claimed')) as next_due
       from omb.timer
      where dedupe_key like 'consolidation:%'`,
    )
    const row = result.rows[0]
    if (row === undefined) return { pending: 0, claimed: 0, done: 0, dead: 0, dueAgeMs: 0 }
    return {
      pending: row.pending,
      claimed: row.claimed,
      done: row.done,
      dead: row.dead,
      dueAgeMs: Math.max(0, Number(row.due_age_ms ?? 0)),
      ...(row.next_due === null ? {} : { nextDueAt: new Date(row.next_due).toISOString() }),
    }
  }

  /** 巩固任务在 pg-boss 里还没跑完的行（created/retry/active），按任务名聚合。 */
  async function readConsolidationQueued(
    schedules: readonly { readonly job: string }[],
  ): Promise<{ readonly total: number; readonly names: ReadonlySet<string> }> {
    if (schedules.length === 0) return { total: 0, names: new Set<string>() }
    const result = await store.db.query<{ name: string; queued: number }>(
      `select name, count(*)::int as queued
         from pgboss.job
        where name = any($1::text[]) and state in ('created', 'retry', 'active')
        group by name`,
      [schedules.map(schedule => schedule.job)],
    )
    let total = 0
    for (const row of result.rows) total += row.queued
    return { total, names: new Set(result.rows.map(row => row.name)) }
  }

  /**
   * `omb_status` 的巩固调度读数：必须与业务 timer 分开看。
   *
   * `timerPending/Claimed/...` 是 **全部** timer 的聚合，包含 consolidation 的 durable
   * schedule 行（合法 pending，不是泄漏）；这里的 consolidation* 给出其中属于巩固调度的
   * 份额，两者相减才是 workflow wake / 提醒等业务 timer 的空闲读数。
   *
   * 有界自愈：status 是一次真实观测，按任务判断“没有 armed timer 且队列里也没有在跑的
   * 同名任务”就补排一次。它不是轮询——只有 omb_status 被调用时才发生；也不会把正常在途
   * 误判成断链（timer handler 先入队再 complete，任务先 rearm 再 complete）。
   */
  async function consolidationStatusLines(): Promise<string[]> {
    if (!consolidationStarted) {
      return ['consolidation=unknown', `consolidationReason=${startup.error ?? 'not-started'}`]
    }
    const schedules = consolidationSchedules()
    try {
      const armed = await readArmedConsolidationKeys(schedules.map(schedule => schedule.dedupeKey))
      const queued = await readConsolidationQueued(schedules).catch(error => {
        logger.warn('巩固任务队列计数失败', messageOf(error))
        return undefined
      })
      let repaired = false
      if (queued !== undefined) {
        // 断链判据按任务看：没有 armed timer，队列里也没有同名在跑的任务。
        const missing = schedules.filter(schedule => (
          !armed.has(schedule.dedupeKey) && !queued.names.has(schedule.job)
        ))
        if (missing.length > 0) {
          const ensured = await consolidationScheduler.ensure(missing.map(schedule => schedule.job))
          if (ensured.scheduled.length > 0) {
            logger.warn('巩固任务的 timer 链路缺失，已按 durable schedule 补排', { jobs: ensured.scheduled })
            repaired = true
          }
        }
      }
      const snapshot = await readConsolidationTimers()
      const queuedAfter = repaired
        ? await readConsolidationQueued(schedules).catch(() => undefined)
        : queued
      const nextDueMs = snapshot.nextDueAt === undefined
        ? 'none'
        : String(Math.max(0, Date.parse(snapshot.nextDueAt) - clock.now().getTime()))
      return [
        'consolidation=ok',
        `consolidationJobs=${schedules.map(schedule => schedule.job).join(',') || 'none'}`,
        `consolidationPending=${snapshot.pending} consolidationClaimed=${snapshot.claimed} consolidationDone=${snapshot.done} consolidationDead=${snapshot.dead}`,
        `consolidationDueAgeMs=${snapshot.dueAgeMs} consolidationNextDueMs=${nextDueMs} consolidationQueued=${queuedAfter?.total ?? 'unknown'}`,
      ]
    } catch (error) {
      return ['consolidation=unknown', `consolidationReason=${messageOf(error)}`]
    }
  }

  /** 运行时未启动/未测量时的统一读数：显式 unknown + 原因，不把“没跑”报成 0。 */
  function runtimeUnknownLines(reason: string): string[] {
    // 后台任务关闭时，真正原因不是 DB/启动错误：如实说是配置关掉的。
    const detail = config.jobs ? reason : 'jobs-disabled'
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

  /**
   * `omb_status` 的事件运行时读数：outbox lag/pending/dead、timer due、workflow 状态。
   *
   * 口径说明：relay/timer/workflow 的 dead/delivered/fired 是**本进程累计**（端口只暴露
   * 内存 totals，没有跨进程 dead 聚合查询），这里按进程口径如实输出，不冒充全局总数；
   * pending/claimed/lag 来自各自 store 的实时 SQL。任一查询失败只把对应段落标 unknown，
   * 不影响其它段落的实测读数。
   */
  async function runtimeStatusLines(): Promise<string[]> {
    if (!config.jobs) return runtimeUnknownLines('jobs-disabled')
    if (!runtimeStarted
      || outboxRelay === undefined
      || timerWorker === undefined
      || workflowRuntime === undefined
      || workflowStoreRef === undefined
      || reactionRegistry === undefined) {
      return runtimeUnknownLines(startup.error ?? 'not-started')
    }
    const lines: string[] = []
    try {
      const stats = await outboxRelay.stats()
      // status 调用时做一次有界“叫醒”：有 pending 就 wake relay 补一次 drain。
      // 这不是轮询——只有用户/模型真的调用 omb_status 时才发生。
      if (stats.pending > 0) outboxRelay.wake()
      lines.push(
        'outbox=ok',
        // pending/claimed/lag 是实时 SQL；dead 是本进程累计（OutboxStore 端口没有跨进程
        // dead 计数），用 outboxDeadScope 标清口径，不把它当成全局死信总数。
        `outboxLagMs=${stats.oldestAgeMs} outboxPending=${stats.pending} outboxClaimed=${stats.claimed} outboxDead=${stats.dead} outboxDeadScope=process`,
        `outboxDelivered=${stats.delivered} outboxSkipped=${stats.skipped} outboxRetried=${stats.retried} outboxLost=${stats.lost}`,
        `outboxTopics=${reactionRegistry.topics().join(',') || 'none'} outboxUnknownTopic=dead`,
      )
      if (stats.lastError !== undefined) lines.push(`outboxLastError=${stats.lastError}`)
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
    lines.push(...(await consolidationStatusLines()))
    return lines
  }

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
      // 投影不依赖后台任务开关：jobs=false 也要维护读模型/提供 lag 读数。
      if (!projectionStarted) await startProjection()
      if (!config.jobs) return
      if (!embedJobRegistered) {
        await registerEmbedJob(queue, { store, embedder })
        embedJobRegistered = true
      }
      if (!consolidationJobsRegistered) {
        consolidationJobs = await registerConsolidationJobs(queue, {
          store,
          queries: maintenance,
          updateService,
          clock,
          logger,
          dynamic: dynamicService,
          embedder,
        }, { scheduler: consolidationScheduler })
        consolidationJobsRegistered = true
      }
      if (!queueStarted) {
        await queue.start()
        queueStarted = true
      }
      // 事件运行时必须在投影之后（task-42）且在队列启动之后：reaction 要往已启动的队列入队。
      if (!runtimeStarted) await startRuntime()
      if (!consolidationStarted) {
        // 没有固定 loop：启动只做一次**幂等**排期——已 armed 的 timer 原样保留（崩溃期间
        // 逾期的到期后立刻执行），缺失的才补一条立即到期的。之后由 timer 到期 + 任务
        // 执行完的 rearm 续期；不再有 setInterval/固定节拍。
        const schedules = consolidationSchedules()
        const ensured = await consolidationScheduler.ensure(schedules.map(schedule => schedule.job))
        consolidationStarted = true
        logger.info('巩固任务 durable 调度已就绪', {
          jobs: schedules.map(schedule => schedule.job),
          dedupeKeys: schedules.map(schedule => schedule.dedupeKey),
          scheduledNow: ensured.scheduled,
          armed: ensured.armed,
          driver: 'timer/omb.consolidation',
        })
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
          'projection=unknown',
          'projectionReason=db-down',
          ...runtimeUnknownLines('db-down'),
          // 数据库不可达时 LISTEN 也必然断开/在退避：连接读数正是这时候最该如实报出来。
          ...listenStatusLines(),
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
          ...(await projectionStatusLines()),
          ...(await runtimeStatusLines()),
          // LISTEN 断连不再静默：connected/reconnects 是运维判断“要不要重启”的第一手读数。
          ...listenStatusLines(),
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
          'projection=unknown',
          'projectionReason=status-query-failed',
          ...runtimeUnknownLines('status-query-failed'),
          ...listenStatusLines(),
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
  // 4 篇功能说明走宿主 skills provider；加载期不读盘，由 provider 惰性读取。
  const skillsOff = registerSkills(ctx, logger)
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

  /**
   * 记录一次注入：T1 的 receipt 落 `omb.resident_trace` 作为注入证据（与 recall_event
   * 共享 traceId）；hits 只进采用等待集合。
   *
   * 为什么仍写 resident_trace：schema 里没有独立的 injection_receipt 表，本任务不允许改
   * 迁移；resident_trace 是现有唯一的注入证据表，`sections` 是 JSONB，可放 receipt 而
   * 不动表结构。T1 行不带 session_id：T0 的“该 session 最新 trace”查询按 session 取最新
   * 一行，T1 receipt 若带 session 会把它顶成 T0 证据；按 trace_id 查 T1 receipt 即可。
   */
  const persistInjectionReceipt = (notice: RecallNotice): void => {
    const receipt = notice.receipt
    if (receipt === undefined) return
    void store.recordResidentTrace({
      traceId: notice.traceId,
      budgetTokens: Math.max(1, receipt.budgetTokens),
      usedTokens: Math.max(0, receipt.usedTokens),
      text: notice.text ?? '',
      sections: [{
        name: 'injection-receipt',
        tokens: receipt.usedTokens,
        kept: receipt.injected,
        text: JSON.stringify(receipt),
        entityIds: receipt.keptIds,
      }],
      droppedSections: [],
    }).catch(error => {
      logger.warn('T1 注入 receipt 写入失败', messageOf(error))
    })
  }

  const rememberInjection = (sessionId: string, notice: RecallNotice): void => {
    // receipt 与“有没有可采用的命中”无关：隔离块不进hits，但这次的隔离证据必须可查。
    persistInjectionReceipt(notice)
    if (notice.hits.length === 0) return
    const list = pendingRecall.get(sessionId) ?? []
    list.push({
      sessionId,
      traceId: notice.traceId,
      hits: notice.hits,
      ...(notice.receipt === undefined ? {} : { receipt: notice.receipt }),
    })
    pendingRecall.set(sessionId, list)
  }

  /**
   * T0 实际注入的偏好/状态写 recall_event（injected=true），落库成功后再登记采用等待。
   *
   * 读模型路径没有 engine 的 recall_event；不补写就会让 T0 注入在账本里消失，
   * 采用率分母失真。回退路径的偏好仍走这里（与旧行为一致），状态由 engine 自己写。
   */
  const recordResidentHits = (
    sessionId: string,
    turn: number | undefined,
    traceId: string,
    query: string,
    hits: readonly { readonly id: string; readonly title?: string }[],
  ): void => {
    if (hits.length === 0) return
    void store.recordRecall(hits.map((hit, index) => ({
      traceId,
      sessionId,
      ...(turn === undefined ? {} : { turnId: String(turn) }),
      query,
      trigger: 't0',
      entityId: hit.id,
      channel: 'resident',
      rank: index + 1,
      injected: true,
    }))).then(() => {
      // 只有 recall_event 已落库后才登记采用等待，避免 adopted 更新不到行。
      rememberInjection(sessionId, { traceId, hits })
    }).catch(error => {
      logger.warn('T0 常驻 recall_event 写入失败', messageOf(error))
    })
  }

  const adoptPending = (sessionId: string, text: string, kind: 'text' | 'tool'): void => {
    const pending = pendingRecall.get(sessionId)
    if (pending === undefined || pending.length === 0 || text.length === 0) return
    const adopted = new Map<string, { traceId: string; id: string }>()
    for (const injection of pending) {
      const kept = injection.receipt === undefined ? undefined : new Set(injection.receipt.keptIds)
      const quarantined = injection.receipt === undefined ? undefined : new Set(injection.receipt.quarantinedIds)
      for (const hit of injection.hits) {
        // adoption 只认这次注入的 receipt：没进 kept 或原文被隔离的命中不算采用。
        if (kept !== undefined && !kept.has(hit.id)) continue
        if (quarantined !== undefined && quarantined.has(hit.id)) continue
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
    const promise = (async (): Promise<PrefetchedT1> => {
      const context = await resolveToolContext(exec)
      if (context === undefined) return { text: '' }
      let notice: RecallNotice | undefined
      const text = await buildEventRecallText(
        engine,
        context,
        query,
        'tool-before',
        400,
        captured => { notice = captured },
      )
      // 预取可能被丢弃（报错时重新查、本步已有 T1、工具取消）：不在这里登记 receipt，
      // 只有 post-execute 真正把 text 挂到 additionalContexts 时才登记。
      return { text, ...(notice === undefined ? {} : { notice }) }
    })().catch(() => ({ text: '' }))
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
      const reused = !failed && prefetched !== undefined
        ? await withTimeout(prefetched, 500)
        : undefined
      let injected = reused?.text ?? ''
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
      } else if (reused?.notice !== undefined) {
        // 复用的预取文本此刻才真正挂到 additionalContexts：这时才登记 receipt 与采用等待。
        rememberInjection(sessionId, reused.notice)
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

  /**
   * 汇总本步的 T1 准备结果（只计算 + 写 T0），不碰 decision：
   * - T0（常驻）仍写 `systemPrompt.context` provider（promptSink）；空 T0 也覆盖写空串（RUN-04）；
   * - T1（事件召回）不再写 promptSink：provider 是装配期快照，逐步骤高频 T1 会退化成
   *   整段重装配（docs/v7/review/RESEARCH.md §8 #2）。T1 的注入口是 pre-step 的
   *   `decision.messages`（packages/core/agent/src/runtime-types.ts:139-146）：追加一条
   *   producer-owned user message，宿主准入时落成 durable `user/message`
   *   （time-context 同款：packages/context/time-context/src/index.ts:199-242）。
   */
  const prepareT1Injection = async (payload: unknown): Promise<PreparedT1Injection | undefined> => {
    const context = await resolveToolContext(payload)
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined
    if (context === undefined || record === undefined) return undefined
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
          // T0 优先读投影看板（两块看板各一条 SQL + 一条新鲜度 SQL）；投影未启动
          // （DB 未就绪/启动失败）时保持旧的 engine/stats 路径，行为与没有读模型前一致。
          residentBoardsOptions(),
        ),
        1_500,
      )
      resident = built?.text ?? ''
      if (built !== undefined) {
        const trace = turn === undefined
          ? built.trace
          : { ...built.trace, turnId: String(turn) }
        // 回退不是静默降级：原因已写进 trace 的 section.fallbackReason；错误/超时再落日志。
        // “读模型为空”在首次回填前是正常状态，不当错误刷日志。
        const fallback = built.trace.sections.find(section => (
          section.fallbackReason !== undefined && section.fallbackReason !== 'read-model-empty'
        ))
        if (fallback?.fallbackReason !== undefined) {
          logger.warn(`T0 读模型回退写模型：${fallback.fallbackReason}`, { sessionId, turn })
        }
        // trace 是 T0 的预算/裁剪证据；写失败不能阻断本轮注入。
        void store.recordResidentTrace(trace).catch(error => {
          logger.warn('T0 常驻 trace 写入失败', messageOf(error))
        })
        // 偏好与（读模型路径的）状态都必须写 recall_event，后续才能记录 adopted。
        recordResidentHits(sessionId, turn, built.trace.traceId, 'T0 常驻偏好', built.preferenceHits)
        recordResidentHits(sessionId, turn, built.trace.traceId, 'T0 常驻状态', built.stateHits)
      }
      rememberSessionState(residentCache, sessionId, { turn, text: resident })
    }
    const userText = lastUserText(record['messages'])
    const toolText = lastToolText(record['messages'])
    const recentText = lastRoundsText(record['messages'], 2)
    const eventSource = [triggered?.query, recentText, userText, toolText]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
    // 跨 step 的内容指纹不含 turn/step：同一段事件源在下一步不能因步号变化重复召回。
    const contentFingerprint = recallContentFingerprint({ sessionId, query: eventSource })
    // 工具结果已通过 additionalContexts 投递过 T1：本步不再追加同一段文本。
    // 这里只读取、不删除：decision 被下层 reject 时这次投递没有发生，配额不能被白占。
    const pendingImmediate = immediateT1.get(sessionId)
    let injected = ''
    let fingerprint: string | undefined
    let notice: RecallNotice | undefined
    if (pendingImmediate !== undefined) {
      // 工具结果已经把这批内容送进上下文；下一步事件源不变时 pre-step 不再重复召回。
      if (eventSource.length > 0) fingerprint = contentFingerprint
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
            // 先捕获 notice：宿主 reject 的 step 不会追加消息，那时不该登记 receipt/采用等待。
            captured => { notice = captured },
          ),
          1_500,
        ) ?? ''
        if (injected.length > 0) fingerprint = contentFingerprint
      }
    }
    // T0 仍走 promptSink；RUN-04：本轮没有 T0 时也要覆盖写空串，清掉上一轮旧文本。
    promptSink.write(sessionId, resident)
    return {
      sessionId,
      text: injected,
      immediate: pendingImmediate !== undefined,
      fingerprint,
      stepKey,
      ...(notice === undefined ? {} : { notice }),
    }
  }

  const preStep = async (payload: unknown, next: () => unknown): Promise<unknown> => {
    let prepared: PreparedT1Injection | undefined
    try {
      prepared = await prepareT1Injection(payload)
    } catch (error) {
      logger.warn('pre-step 注入失败', messageOf(error))
    }
    // next() 必须在 try 之外：其它 pre-step 监听器抛错要原样上抛，不能被 OMB 吞成放行。
    // 宿主契约要求 next 必传（DSH `packages/core/agent/src/runtime-types.ts:351`）。
    const decision = await next()
    if (!isEnterDecisionLike(decision)) return decision
    if (prepared === undefined) return decision
    if (prepared.immediate) {
      // 工具结果的即时注入已经送达：本步只消费一次配额，不再追加第二条 T1。
      immediateT1.delete(prepared.sessionId)
      if (prepared.stepKey !== undefined) rememberSessionState(t1Step, prepared.sessionId, prepared.stepKey)
      if (prepared.fingerprint !== undefined) rememberSessionState(lastT1, prepared.sessionId, prepared.fingerprint)
    } else if (prepared.text.length > 0) {
      // 只有真正追加进 decision.messages 的召回才占用本步配额与去重指纹；
      // receipt/采用等待也在这一刻登记（reject/未追加都不该留下“已注入”证据）。
      if (prepared.notice !== undefined) rememberInjection(prepared.sessionId, prepared.notice)
      if (prepared.stepKey !== undefined) rememberSessionState(t1Step, prepared.sessionId, prepared.stepKey)
      if (prepared.fingerprint !== undefined) rememberSessionState(lastT1, prepared.sessionId, prepared.fingerprint)
    }
    return appendT1Message(decision, prepared.text)
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
      skillsOff()
    } catch {
      // 注销失败不阻断卸载。
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
    // 没有可停的巩固循环了：durable schedule 是 omb.timer 里的行，进程退出后仍保留，
    // 下一个进程启动时靠幂等 ensure 接管；这里不需要（也不应该）取消它们。
    // 先让 worker 停掉，再关业务连接池，最后才停便携 PostgreSQL；三个动作不能并发，
    // 否则 queue 仍在跑时 store 已关、或 PG 已被 fast shutdown。每步独立 5s 超时，
    // 超时/失败只记日志并继续，绝不把异常抛回宿主。
    // 顺序：事件运行时（relay/timer/workflow）→ 各自的 LISTEN 连接 → 队列 → 投影链路 →
    // store.close → 便携 PostgreSQL。relay/timer/workflow 还在跑时不能先关连接池；
    // 每个 worker 与它的 notifier 分成两步，worker 卡住超时也不会让 LISTEN 连接泄漏。
    const teardownSteps: TeardownStep[] = [
      { name: 'outbox.relay.stop', run: () => outboxRelay?.stop() },
      { name: 'timer.worker.stop', run: () => timerWorker?.stop() },
      { name: 'workflow.runtime.stop', run: () => workflowRuntime?.stop() },
      { name: 'outbox.notifier.close', run: () => outboxNotifier?.close() },
      { name: 'timer.notifier.close', run: () => timerNotifier?.close() },
      { name: 'queue.stop', run: () => queue.stop() },
      { name: 'projection.worker.stop', run: () => projectionWorker?.stop() },
      { name: 'projection.read.close', run: () => projectionReadApi?.close() },
      { name: 'projection.notifier.close', run: () => projectionNotifier?.close() },
      { name: 'store.close', run: () => store.close() },
      ...(lifecycle === undefined ? [] : [{ name: 'lifecycle.stop', run: () => lifecycle.stop() }]),
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

export default apply
