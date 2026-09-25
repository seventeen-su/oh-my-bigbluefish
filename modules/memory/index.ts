/**
 * `omb-memory` 模块注册入口。
 *
 * 契约三方一致（`kernel/abi/catalog.ts`）：`manifest.id` = `cordis.patch.yml` 的行 id
 * = 插件页开关 id = `MODULE_CATALOG` 里的登记项。本文件不自造这些值，
 * 能力名与工具名一律取自目录，避免两处漂移。
 *
 * `apply` 的两条硬约束（热插拔）：
 * ① **同步** `provide('stores', …)`，异步打开只填内部状态，**不再注册任何东西**（H-2）
 * ② 返回的 disposer **绝不抛异常**（H-1：宿主 `reconcileProfilePatches` 会 await 旧 fiber）
 */
import { z } from 'zod'
import type {
  Kernel,
  MemoryStore,
  ModuleHealth,
  ModuleManifest,
  ModuleRegistration,
  StorageHostPort,
  StoreStats,
} from '../../kernel/abi/index.js'
import { MODULE_CATALOG, SERVICES } from '../../kernel/abi/index.js'
import { asMemoryStore, createStoresService, type MemoryStoresService } from './store.js'

/** 模块 id。必须与 `MODULE_CATALOG` 和 `cordis.patch.yml` 完全一致。 */
export const MODULE_ID = 'omb-memory'

/**
 * 宿主存储端口（`StorageHostPort`）的服务名。
 *
 * `StorageHostPort` 由 `dsh/` 构造（它知道 DSH_HOME 与 `node:sqlite`），
 * 有两条等价的注入路径，二者都支持：
 * ① `createMemoryRegistration({ storageHost })`（首选：不依赖服务名约定）
 * ② `kernel.provide(STORAGE_HOST_SERVICE, port)`
 */
export const STORAGE_HOST_SERVICE = 'omb.storage-host'

const rawConfigSchema = z.object({
  /** 每多少回合触发一次离线整合（宿主回合边界驱动，见规划 §5.6）。 */
  consolidationEveryTurns: z.number().int().min(1).default(32),
  /** 向量编码线程数（ONNX 路径用；纯 JS 路径忽略）。 */
  embeddingThreads: z.number().int().min(1).default(2),
})

/**
 * 配置 schema。**缺省值完整**：`parse(undefined)` 返回完整配置，
 * 使 `apply` 永远收到可直接使用的对象（内核可能在无 `config` 行时传 undefined）。
 */
export const memoryConfigSchema = z.preprocess(
  value => (value === undefined || value === null ? {} : value),
  rawConfigSchema,
)

export type MemoryConfig = z.infer<typeof rawConfigSchema>

/** 缺省配置的显式副本，供状态面与测试断言"缺省值完整"。 */
export const MEMORY_CONFIG_DEFAULTS: MemoryConfig = {
  consolidationEveryTurns: 32,
  embeddingThreads: 2,
}

const CATALOG = MODULE_CATALOG.find(entry => entry.id === MODULE_ID)
const REQUIRES: readonly string[] = CATALOG?.requires ?? ['omb-kernel']
const CAPABILITIES: readonly string[] = CATALOG?.capabilities ?? []

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeVectors(stats: StoreStats): string {
  return stats.vectors === null ? '无' : `${stats.vectors.rows}@${stats.vectors.modelId}/${stats.vectors.dim}`
}

async function describeStore(label: string, store: MemoryStore | undefined): Promise<{
  readonly line: string
  readonly stats: StoreStats | undefined
}> {
  if (store === undefined) return { line: `${label}=未打开`, stats: undefined }
  const concrete = asMemoryStore(store)
  const path = concrete?.dbPath ?? '（路径未知：非本实现）'
  const migrated = concrete === undefined ? '' : `（迁移 v${concrete.migrated.from}→v${concrete.migrated.to}）`
  const stats = await store.stats()
  return {
    line: `${label}=${path}${migrated} 行数=${stats.rows} schema=v${stats.schemaVersion} 向量=${describeVectors(stats)}`,
    stats,
  }
}

/**
 * 健康面。**必须写明原因**（无空降级）：
 * 库路径、行数、schema 版本、迁移结果、项目库打开情况，缺一不可。
 */
async function describeHealth(service: MemoryStoresService): Promise<ModuleHealth> {
  const status = service.status()
  const snapshot = service.snapshot()

  const parts: string[] = []
  const metrics: Record<string, number> = { openProjects: status.openProjects.length }
  let totalRows = 0
  let vectorRows = 0
  let schemaVersion = 0

  const user = await describeStore('用户库', snapshot.user?.store('user'))
  parts.push(user.line)
  if (user.stats !== undefined) {
    totalRows += user.stats.rows
    vectorRows += user.stats.vectors?.rows ?? 0
    schemaVersion = Math.max(schemaVersion, user.stats.schemaVersion)
  }

  for (const set of snapshot.projects) {
    const described = await describeStore(`项目库(${set.projectScope ?? '未知 cwd'})`, set.store('project'))
    parts.push(described.line)
    if (described.stats !== undefined) {
      totalRows += described.stats.rows
      vectorRows += described.stats.vectors?.rows ?? 0
      schemaVersion = Math.max(schemaVersion, described.stats.schemaVersion)
    }
  }

  metrics['rows.total'] = totalRows
  metrics['vectors.total'] = vectorRows
  if (schemaVersion > 0) metrics['schemaVersion'] = schemaVersion

  const catalogNote =
    CATALOG === undefined ? '；⚠ 模块目录里缺少 omb-memory 登记项（契约漂移）' : ''
  const detail = `${parts.join('；')}；${status.detail}${catalogNote}`

  if (service.failure() === undefined && status.ready) {
    return { state: 'ok', detail, metrics }
  }
  return { state: 'degraded', detail, metrics }
}

export interface MemoryModuleOptions {
  /** 宿主存储端口。给了就直接用；否则在需要时经 `STORAGE_HOST_SERVICE` 解析。 */
  readonly storageHost?: StorageHostPort
  /** 项目库连接缓存上限（缺省 16）。 */
  readonly maxOpenProjects?: number
  /** 模块版本号，写进 manifest。 */
  readonly version?: string
}

/**
 * 造一个注册项。
 *
 * 工厂而不是裸常量：`dsh/` 可以在构造时直接注入宿主端口与上限，
 * 且每个宿主 fiber 拿到独立的模块状态（`health()` 读的是本实例的库）。
 */
export function createMemoryRegistration(options: MemoryModuleOptions = {}): ModuleRegistration<MemoryConfig> {
  let current: MemoryStoresService | undefined

  const manifest: ModuleManifest<MemoryConfig> = {
    id: MODULE_ID,
    version: options.version ?? '3.0.0',
    requires: REQUIRES,
    capabilities: CAPABILITIES,
    configSchema: memoryConfigSchema,
    async health(): Promise<ModuleHealth> {
      const service = current
      if (service === undefined) {
        return { state: 'degraded', detail: '模块未启动：apply 尚未执行（或已被卸载）' }
      }
      try {
        return await describeHealth(service)
      } catch (error) {
        // health() 自身绝不抛：状态面拿不到原因比拿到"检查失败"更糟
        return { state: 'degraded', detail: `健康检查失败：${messageOf(error)}` }
      }
    },
  }

  return {
    manifest,

    apply(kernel: Kernel, config: MemoryConfig): () => Promise<void> {
      const service = createStoresService({
        logger: kernel.logger,
        clock: kernel.clock,
        config: { ...config },
        maxOpenProjects: options.maxOpenProjects,
        resolvePort: () => options.storageHost ?? kernel.service<StorageHostPort>(STORAGE_HOST_SERVICE),
      })
      // 同名重复注册 = 替换（ABI 契约，热插拔重载必然发生）；因此这里不 catch——
      // 若宿主实现真的抛，apply 抛出会由内核记为本模块 failed，语义正确。
      const off = kernel.provide(SERVICES.stores, service)
      current = service

      // 打开是异步的，但注册已经全部完成——这里只填内部状态（H-2）。
      // `start()` 内部吞掉一切异常，`.catch` 只是防止未来的改动引入 unhandled rejection。
      void service
        .start()
        .then(() => {
          const status = service.status()
          kernel.report(
            status.ready
              ? { state: 'ok', detail: `记忆库就绪：${status.detail}` }
              : { state: 'degraded', detail: `记忆库未就绪：${status.detail}` },
          )
        })
        .catch((error: unknown) => {
          kernel.logger.warn(`OMB：记忆库预热回调异常（已隔离）——${messageOf(error)}`)
        })

      kernel.logger.debug(
        `omb-memory：consolidationEveryTurns=${config.consolidationEveryTurns}，` +
          `embeddingThreads=${config.embeddingThreads}（存储层不消费，供整合与向量子能力读取）`,
      )

      return async (): Promise<void> => {
        // H-1：dispose 绝不抛异常。任何一步失败都只记日志。
        try {
          off()
        } catch (error) {
          kernel.logger.warn(`OMB：注销 "${SERVICES.stores}" 服务失败（已隔离）——${messageOf(error)}`)
        }
        if (current === service) current = undefined
        await service.dispose()
      }
    },
  }
}

/**
 * 读模块配置（含完整缺省值）。
 *
 * 子能力（如 `omb-memory-vector` 的线程数）**不该 import 本模块的常量**：
 * 它们经内核服务读同一份配置，关闭 `omb-memory` 时自然拿到缺省值而不是崩溃。
 */
export function readMemoryConfig(kernel: Kernel): MemoryConfig {
  const service = kernel.service<MemoryStoresService>(SERVICES.stores)
  return memoryConfigSchema.parse(service?.config)
}

/** 默认注册项：宿主端口经 `STORAGE_HOST_SERVICE` 解析。 */
export const registration = createMemoryRegistration()

export default registration
