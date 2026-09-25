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
  Embedder,
  Kernel,
  MemoryScope,
  ModuleHealth,
  ModuleManifest,
  ModuleRegistration,
  SecondaryChannelRegistry,
  StorageHostPort,
  TaggedStore,
  ToolDefinition,
} from '../../kernel/abi/index.js'
import { MODULE_CATALOG, SERVICES, toolsServiceFor } from '../../kernel/abi/index.js'
// 准入判据要**真的核验工件存在**。核验本身在 `./artifacts.ts`（用 git 索引，
// 不做文件系统遍历——理由见那个文件）。这里只负责把会话 cwd 交给它。
import { createStoresService, type MemoryStoresService } from './store.js'
import { createRelateTool } from './graph.js'
import { createMemoryTools } from './recall.js'
import type { ArtifactKind } from './remember.js'
import { createRememberTool } from './remember.js'
import { verifyArtifactExists } from './artifacts.js'
import type { RetrievalChannel } from './retrieve.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

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

/**
 * 读「会话 → cwd」的**唯一来源**（内核 `ActiveSessionTable`）。
 *
 * 本模块**不自己存**这条事实：曾经存过一份 `cwdBySession`，与内核登记处更新时机
 * 不同 → 状态面稳定矛盾（模块段 0 条、存储段 1 条）。现在每次按需问内核，
 * 因此"宿主刚告知 cwd"与"这里能取到项目库"之间没有时间差。
 *
 * 服务缺失/畸形/抛异常一律当作"不知道"（降级为仅用户库），**绝不抛**。
 */
function sessionCwdSource(kernel: Kernel): {
  readonly resolveSessionCwd: (sessionId: string) => string | undefined
  readonly knownSessionCwds: () => readonly string[]
} {
  const table = (): {
    cwd(session?: string): string | null
    sessions(): readonly string[]
  } | undefined => kernel.service(SERVICES.activeSession)
  return {
    resolveSessionCwd: sessionId => {
      try {
        const cwd = table()?.cwd(sessionId) ?? null
        return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
      } catch {
        return undefined
      }
    },
    knownSessionCwds: () => {
      try {
        const sessions = table()
        if (sessions === undefined) return []
        const cwds: string[] = []
        for (const sessionId of sessions.sessions()) {
          const cwd = sessions.cwd(sessionId)
          if (typeof cwd === 'string' && cwd.length > 0) cwds.push(cwd)
        }
        return cwds
      } catch {
        return []
      }
    },
  }
}

/**
 * 写入账本。**弃权必须可审计**（规划 §5.6）：弃权率是发现"该记的没记"的唯一手段。
 * 经 `health()` 的 metrics 与 detail 暴露给状态面。
 */
export interface MemoryWriteLedger {
  writes: number
  abstentions: number
  /** 最近一次弃权的原因（截断后进 detail，完整原因在日志里）。 */
  lastAbstention: string
}

/**
 * 健康面。
 *
 * ## 这里**不再**报库路径/行数/已打开项目库/会话→cwd 计数
 *
 * 原因不是"少写点"，而是**报数必然打架**：内核健康面保存的是模块**最近一次上报
 * 的快照**（`kernel/health.ts`），而 `## 存储` 段每次都读实时状态。快照里印实时
 * 计数，就会出现同一次 `omb_status` 里「模块段 项目库 0/16 已打开；会话→cwd
 * 登记 0 条」对「存储段 1 个 / 1 条」——实测三次调用都一样，是稳定矛盾而非抖动。
 *
 * 所以本行只报**本模块自有**的事实（写入账本、目录漂移），库相关一律指向
 * 「存储」段（唯一报数处）。`metrics` 仍带实时统计——它给健康面消费者用，
 * **不进 `omb_status` 文本**，因此不会制造第二个可见数字。
 */
async function describeHealth(
  service: MemoryStoresService,
  ledger: MemoryWriteLedger | undefined,
): Promise<ModuleHealth> {
  const status = service.status()
  const snapshot = service.snapshot()

  const metrics: Record<string, number> = { openProjects: status.openProjects.length }
  let totalRows = 0
  let vectorRows = 0
  let schemaVersion = 0
  /** 真正测到行数的库数。**0 = 未测量**（没有任何库打开），不是"合计 0 行"。 */
  let measuredStores = 0

  const stores = [
    snapshot.user?.store('user'),
    ...snapshot.projects.map(set => set.store('project')),
  ]
  for (const store of stores) {
    if (store === undefined) continue
    try {
      const stats = await store.stats()
      measuredStores += 1
      totalRows += stats.rows
      vectorRows += stats.vectors?.rows ?? 0
      schemaVersion = Math.max(schemaVersion, stats.schemaVersion)
    } catch {
      // 单个库统计失败不得让整份健康检查失败（真原因由 status().detail / failure() 说）
    }
  }

  // **只报测到的**：一个库都没打开时，"合计行数"是未知而不是 0。
  // 把未测量写成 0 会让状态面看起来像"库是空的"——那正好掩盖了"库根本没打开"这个真问题。
  if (measuredStores > 0) {
    metrics['rows.total'] = totalRows
    metrics['vectors.total'] = vectorRows
  }
  if (schemaVersion > 0) metrics['schemaVersion'] = schemaVersion
  if (ledger !== undefined) {
    metrics['writes'] = ledger.writes
    metrics['abstentions'] = ledger.abstentions
  }

  const catalogNote =
    CATALOG === undefined ? '；⚠ 模块目录里缺少 omb-memory 登记项（契约漂移）' : ''
  const ledgerNote =
    ledger === undefined || (ledger.writes === 0 && ledger.abstentions === 0)
      ? ''
      : `；写入 ${ledger.writes} 次、准入弃权 ${ledger.abstentions} 次${
          ledger.lastAbstention.length === 0
            ? ''
            : `（最近弃权：${ledger.lastAbstention.slice(0, 60)}${ledger.lastAbstention.length > 60 ? '…' : ''}）`
        }`
  // 「无空降级」：降级时原因仍写在本行，只是**不抄计数**。
  const why = service.failure()
  const pointer = '库、路径与计数见「存储」段（本行是健康上报快照，不重复报实时读数）'
  const detail = `${pointer}${why === undefined ? '' : `；本模块记录的失败原因：${why}`}${ledgerNote}${catalogNote}`

  if (why === undefined && status.ready) {
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
  let ledgerRef: MemoryWriteLedger | undefined

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
        return await describeHealth(service, ledgerRef)
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
        // 「会话 → cwd」不再由本模块存：唯一来源是内核登记处（见 sessionCwdSource 的说明）
        ...sessionCwdSource(kernel),
      })
      // 同名重复注册 = 替换（ABI 契约，热插拔重载必然发生）；因此这里不 catch——
      // 若宿主实现真的抛，apply 抛出会由内核记为本模块 failed，语义正确。
      const off = kernel.provide(SERVICES.stores, service)
      current = service

      // ── 工具面（`tools:omb-memory` → ToolDefinition[]，契约见 SERVICES.toolsPrefix）──
      // 工具**定义**在 `recall.ts`/`graph.ts`，**装配**在本模块的 apply：
      // 这是仓库既有模式（reasoning/context/artifact 都这么做），也是 H-2 的要求
      // （注册必须在 apply 返回前完成，且只有 dsh/ 能接触宿主）。
      let lastActiveSession: string | null = null
      let lastTurn: number | undefined
      const offTurn = kernel.on('turn/start', payload => {
        lastActiveSession = payload.sessionId
        lastTurn = payload.turn
        // 预热该会话的项目库：打开是异步的，工具执行体只能同步取库（`peek`）。
        // 失败由服务记入状态面（`status().detail`），这里吞掉是刻意的。
        void service.forSession(payload.sessionId)
      })

      /**
       * 写入账本。**弃权必须可审计**（§5.6）：弃权率是发现"该记的没记"的唯一手段。
       * 通过 health 的 metrics 与 detail 暴露给状态面。
       */
      const ledger: MemoryWriteLedger = { writes: 0, abstentions: 0, lastAbstention: '' }
      ledgerRef = ledger
      const resolveStores = (): readonly TaggedStore[] | undefined => {
        const set = lastActiveSession === null ? undefined : service.peek(lastActiveSession)
        return (set ?? service.snapshot().user)?.stores
      }

      const tools: readonly ToolDefinition[] = [
        ...createMemoryTools({
          resolveStores,
          clock: kernel.clock,
          /**
           * 检索端口在**每次调用时**读服务表：向量模块可能后到、也可能被关掉，
           * 两种情形都必须只影响通道数，不影响词法主路径（§5.7）。
           */
          ports: () => {
            const embedder = kernel.service<Embedder>(SERVICES.embedder)
            const channels = kernel
              .service<SecondaryChannelRegistry<RetrievalChannel>>(SERVICES.channelRegistry)
              ?.list()
            return {
              clock: kernel.clock,
              ...(embedder === undefined ? {} : { embedder }),
              ...(channels === undefined || channels.length === 0 ? {} : { channels }),
            }
          },
          pressureBand: () =>
            lastActiveSession === null ? undefined : kernel.pressure(lastActiveSession).band,
        }),
        createRelateTool({ resolveStores }),
        // ── 写入路径（规划 §5.6 在线部分）：不写，两个库永远是空的 ──────────────
        createRememberTool({
          // 写入可**等库打开**（读路径不行，它有延迟预算）：项目库尚未预热也能落库
          resolveStore: async (scope: MemoryScope) => {
            const set =
              lastActiveSession === null
                ? service.snapshot().user
                : (await service.forSession(lastActiveSession)) ?? service.snapshot().user
            return set?.store(scope)
          },
          clock: kernel.clock,
          currentSession: () => lastActiveSession ?? undefined,
          currentTurn: () => lastTurn,
          // 项目身份：套件的 projectScope 就是规范化 cwd（§5.3）
          currentProject: () =>
            lastActiveSession === null ? undefined : service.peek(lastActiveSession)?.projectScope ?? undefined,
          degradeReason: () => service.failure(),
          /**
           * 工件存在性核验——准入判据里"可由具体工件复现"**真的去核验**。
           *
           * 判据本身是纯函数，碰不了文件系统；而只做形态匹配的后果实测过：
           * 编造的 `does-not-exist-9f3a.json` 与真实文件名拿到同一个准入结论，
           * 字段却叫 `reproducible-artifact`。**名不副实的闸门等于没有闸门。**
           *
           * 这里按语义解析相对路径，主查 cwd，再退项目根（`currentProject`）。
           * 只做同步 `existsSync`：一次系统调用，准入路径上可接受。
           * 任何异常都返回 `undefined`（=核验不了 → 不算依据），绝不抛。
           */
          verifyArtifact: (candidate: string, kind: ArtifactKind) => {
            if (kind !== 'path' && kind !== 'line') return undefined
            /**
             * **用 git 索引核验，不做文件系统遍历**。
             *
             * 判据匹配到的往往是**裸文件名**（正文写 `modules/memory/remember.ts`，
             * 正则只捕获 `remember.ts`），而它相对基准的位置未知：
             * 直接拼 `<cwd>/remember.ts` 不存在；从 cwd **向上**找永远找不到
             * （文件在仓库**内部**）；**向下**递归则要遍历整棵树。
             *
             * 实测确认过这三条都不通，`git ls-files` 一次给出权威答案
             * （裸名用后缀匹配），且本仓库只用 167 条。详见 `./artifacts.ts`。
             *
             * 会话 cwd 优先于宿主进程 cwd：前者才是用户眼里的"当前目录"。
             */
            const sessionCwd = kernel
              .service<{ cwd(): string | null }>(SERVICES.activeSession)
              ?.cwd() ?? null
            return verifyArtifactExists(candidate, sessionCwd)
          },
          /**
           * `memory/written` 是**向量落盘的唯一触发源**：embed-dev 订阅它做批量编码。
           * 在 put 成功之后发；订阅者异常由事件总线隔离，`emit` 自身也不会抛。
           */
          onWritten: payload => {
            ledger.writes += 1
            kernel.emit('memory/written', payload)
          },
          onAbstained: info => {
            ledger.abstentions += 1
            ledger.lastAbstention = info.reason
            // 完整原因进日志（detail 里只放截断版，避免状态面被长文本淹没）
            kernel.logger.info(`OMB：记忆写入弃权——${info.reason}`)
          },
        }),
      ]
      const offTools = kernel.provide(toolsServiceFor(MODULE_ID), tools)

      // 打开是异步的，但注册已经全部完成——这里只填内部状态（H-2）。
      // `start()` 内部吞掉一切异常，`.catch` 只是防止未来的改动引入 unhandled rejection。
      //
      // **上报的 detail 里不放库与计数**：内核健康面保存的是这份上报的**快照**，
      // 而 `## 存储` 段每次读实时状态——快照印实时数字就是那个稳定矛盾的来源
      // （模块段 0/0，存储段 1/1）。库相关一律指向「存储」段；降级原因照样写清楚。
      void service
        .start()
        .then(() => {
          const status = service.status()
          const why = service.failure()
          if (status.ready) {
            kernel.report({
              state: 'ok',
              detail: '记忆库就绪（库、路径与计数见「存储」段：本行是上报快照，不重复报实时读数）',
            })
          } else {
            kernel.report({
              state: 'degraded',
              detail: `记忆库未就绪：${why ?? '用户库未打开'}（详情见「存储」段）`,
            })
          }
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
        for (const [label, close] of [
          ['工具服务', offTools],
          ['回合订阅', offTurn],
          ['stores 服务', off],
        ] as const) {
          try {
            close()
          } catch (error) {
            kernel.logger.warn(`OMB：注销${label}失败（已隔离）——${messageOf(error)}`)
          }
        }
        if (current === service) current = undefined
        if (ledgerRef === ledger) ledgerRef = undefined
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

export default toHostPlugin(registration)
