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
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  ModuleHealth,
  ModuleManifest,
  ModuleRegistration,
  SecondaryChannelRegistry,
  StorageHostPort,
  TaggedStore,
  ToolDefinition,
} from '../../kernel/abi/index.js'
import { SERVICES, catalogEntryOf, derivedCapabilities, derivedRequires, toolsServiceFor } from '../../kernel/abi/index.js'
// 隐私闸门**并入本模块**（3.6，用户指令 1）：装配、命令、状态段全在 `./privacy/index.js`，
// 本文件只负责"什么时候装、读数怎么并进健康面与状态面"。
// 服务名仍是 `SERVICES.privacy`——因此两个消费者（本模块的库访问边界 `store.ts`、
// 制品读写闸门 `modules/artifact/index.ts`）一个字都不用改。
import {
  installPrivacy,
  privacyConfigSchema,
  PRIVACY_DEFAULT_CONFIG,
  type PrivacyInstallation,
} from './privacy/index.js'
// 准入判据要**真的核验工件存在**。核验本身在 `./artifacts.ts`（用 git 索引，
// 不做文件系统遍历——理由见那个文件）。这里只负责把会话 cwd 交给它。
import { createStoresService, asMemoryStore, asRecordScanner, type MemoryStoresService, type PrivacyGatePort } from './store.js'
import { planConsolidation } from './consolidate.js'
import { createRelateTool } from './graph.js'
import { createMemoryTools } from './recall.js'
import { createCapture, type Capture, type CaptureStats } from './capture.js'
import { autoLinkRelated } from './link.js'
import { createProjectTool, type ProjectProfilePort, type SessionSituationView } from './project.js'
import { createUsageTracker, installFeedback } from './feedback.js'
import { AdaptiveFloorCalibrator } from './utility.js'
import { asUtilityStore } from './store.js'
import type { AbstentionCategory, ArtifactKind } from './remember.js'
import { createRememberTool } from './remember.js'
import { artifactVerificationDegradeReason, verifyArtifactExists } from './artifacts.js'
import type { RetrievalChannel } from './retrieve.js'
import { readSessionWitness } from './witness.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

/** 模块 id。必须与 `MODULE_CATALOG` 和 `cordis.patch.yml` 完全一致。 */
export const MODULE_ID = 'omb-memory'

/**
 * 常驻提示（3.7-M1）。
 *
 * 为什么是这一句、为什么这么短：
 * - 模型此前**完全不知道记忆库存在**（常驻提示只点名推理类工具），`omb_recall`
 *   的使用率只有 27/391 会话；而修这条不需要第二个常驻段——推理模块换短变体后
 *   （71 字符）余量足够放下这一句；
 * - 常驻预算 120 字符是**所有模块合计**（`kernel/abi/host.ts:110-122`），
 *   所以这句必须 ≤24 字符且**逐字节稳定**（进静态前缀，跨轮不变才能保缓存）；
 * - 只点"何时用"，不承诺返回什么（与 `omb_recall` 描述同一分工）。
 */
export const MEMORY_RESIDENT_HINT = '跨会话结论用 omb_recall 查'

/**
 * 提示贡献的服务名。
 *
 * 集成层按 `prompt:` 前缀自动发现（`dsh/session.ts` 的 `collectPromptContributions`），
 * 模块不需要改宿主代码。名字与 `SERVICES` 目录里的条目不强制绑定：
 * 服务名本身就是契约（`prompt:<模块 id>`）。
 */
export const PROMPT_SERVICE = 'prompt:omb-memory'

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
  /**
   * 常驻提示开关（3.7-M1 的回滚开关）。
   *
   * `false` 时 apply 不注册 `prompt:omb-memory`，回到"模型只能从工具描述知道记忆库"的旧行为。
   */
  residentHint: z.boolean().default(true),
  /**
   * 召回缺省详细度（3.7-M2 的回滚开关）。
   *
   * `snippet`（默认）单次 ≤1,600 字符；`full` 是旧行为（逐字全文，单次可达 ~3,877 字符）。
   * 单个调用仍可用 `detail` 参数覆盖本缺省。
   */
  recallDetail: z.enum(['snippet', 'full']).default('snippet'),
  /** 自主捕获：用户偏好/决定（3.7 Wave 2；默认开，回滚可关）。 */
  autoCapturePreferences: z.boolean().default(true),
  /** 自主捕获：项目活动（命令/改文件；默认开）。 */
  autoCaptureActivity: z.boolean().default(true),
  /** 自主捕获：会话结局兜底（≥3 次调用且一条活动都没捕获时写 1 条；默认开）。 */
  autoCaptureOutcome: z.boolean().default(true),
  /** 新记忆自动连 `related` 边（默认开）。 */
  autoLinkRelated: z.boolean().default(true),
  /** 召回时 1-hop 关联扩展（默认开；回滚可关）。 */
  relatedExpansion: z.boolean().default(true),
  /** 项目库写入未就绪时的重试等待（毫秒；冷启动竞态，默认 250，0=不重试）。 */
  coldStartRetryMs: z.number().int().min(0).max(2000).default(250),
  /** 词法下限模式（3.7 Wave 2 / R9 C3）：`relative`（默认）/ `fixed`（旧 0.5 回滚）。 */
  lexicalFloorMode: z.enum(['relative', 'fixed']).default('relative'),
  /** 自适应下限的目标精度（EWMA 工作点；[0.3,0.9]，默认 0.6）。 */
  lexicalFloorTargetPrecision: z.number().min(0.3).max(0.9).default(0.6),
  /** `/omb-feedback` 命令开关（默认开；关掉只影响显式反馈，隐式效用照常）。 */
  feedbackCommand: z.boolean().default(true),
  /**
   * **隐私闸门**（3.6 从独立的 `omb-privacy` 行并入本行）。
   *
   * 配置项本身没有改名也没有改语义：`failClosedMode`（状态读不出时的基线档位）与
   * `path`（显式状态文件路径）原样保留，只是从"那一行的 config 块"搬到本行的
   * `privacy` 子块——`cordis.patch.yml` 里 `omb-privacy` 那一行连同它的 config 一起删掉。
   */
  privacy: privacyConfigSchema,
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
  residentHint: true,
  recallDetail: 'snippet',
  autoCapturePreferences: true,
  autoCaptureActivity: true,
  autoCaptureOutcome: true,
  autoLinkRelated: true,
  relatedExpansion: true,
  coldStartRetryMs: 250,
  lexicalFloorMode: 'relative',
  lexicalFloorTargetPrecision: 0.6,
  feedbackCommand: true,
  privacy: PRIVACY_DEFAULT_CONFIG,
}

// requires/capabilities 从模块目录派生：**唯一真源是 `kernel/abi/catalog.ts`**。
// 不再用 `?? ['omb-kernel']` 这类静默兜底——猜出来的依赖图比没有更坏。
const REQUIRES: readonly string[] = derivedRequires(MODULE_ID)
const CAPABILITIES: readonly string[] = derivedCapabilities(MODULE_ID)

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
  /**
   * 按原因分档的弃权计数（3.7-M4）。
   *
   * 旧账本只有总数：`no-ground`（可能是没带工件的真结论）与 `missing-source`
   * （接线/归属问题）的修法完全不同，混在一个数字里就无法据此决策。
   */
  abstentionsByCategory: Partial<Record<AbstentionCategory, number>>
}

/**
 * 使用计数账本（M5）。
 *
 * 为什么单独记账：`use_count`/`last_used_at` 有了生产者之后，**写不成**也必须看得见——
 * 否则"这条记忆被用过几次"又变回一个没有来源的数字（只是这次错在另一个方向）。
 */
export interface MemoryUsageLedger {
  failures: number
  /** 最近一次没写成的可读原因。 */
  lastFailure: string
}

/**
 * 离线整合的运行台账（M3）。
 *
 * 为什么要它：整合曾经**全链零生产消费者**（只在测试里存在），而状态面/健康面
 * 一个字都不提——没人能看出"这件事没接线"。现在它每次运行（或失败）都留读数，
 * 于是"没跑"与"跑了但没找到可合并的东西"在读数上是两件不同的事。
 */
export interface ConsolidationLedger {
  /** 触发节奏（回合边界数），来自配置——写进读数，免得使用者去翻 cordis.patch.yml。 */
  everyTurns: number
  runs: number
  /** 本次实际标失效（`validTo`+`supersededBy`）的条数（非破坏性，不删行）。 */
  lastSuperseded: number
  /** 本次实际发出的新边数（`supersedes` / `conflicts_with`）。 */
  lastEdges: number
  /** 本次参与塌缩的合并组数。 */
  lastMergedGroups: number
  /**
   * 本次"独立来源 ≥ 2"的组数 = **够格谈晋升**的独立单元。
   * 同源回响（`independentSources === 1`）不计入——这就是假晋升防线在读数上的形态。
   */
  lastIndependentUnits: number
  /** 最近一次运行遇到的问题（空串 = 没有）。按库累积，绝不静默。 */
  lastError: string
}

/** 单次整合扫描的条数上界：让每次运行的代价与库大小无关（见 `listRecentRecords`）。 */
export const CONSOLIDATION_SCAN_LIMIT = 500

/**
 * 项目画像工具的运行读数（3.7 Wave 2）。
 *
 * `degraded` = 服务缺席/读取失败次数：**"没接线"与"画像为空"必须能分开**，
 * 否则状态面会把"宿主没实现"显示成"这个项目没有画像"。
 */
export interface ProjectToolLedger {
  reads: number
  refreshes: number
  degraded: number
  lastError: string
}

/** 冷启动读数（P4 验收：项目库未就绪失败要能被量化）。 */
export interface ColdStartLedger {
  /** 项目库首次解析失败、触发 250ms 重试的次数。 */
  retries: number
  /** 重试后仍未就绪（随后返回可读失败，**不回落用户库**）。 */
  failures: number
}

/** `/omb-feedback` 的运行读数（R9 C2：反馈动作按类计数）。 */
export interface FeedbackLedger {
  commands: number
  useful: number
  wrongPending: number
  wrongConfirmed: number
  archived: number
  revived: number
  refused: number
  lastChange: string
}

/**
 * 跑一轮离线整合（M3）：**离线、无 LLM、非破坏性**。
 *
 * 为什么按**库**分别规划而不是把所有库合起来：记录只属于一个库，
 * 跨库合并既写不进去（`put` 会拒 scope 不符），也会让"谁取代了谁"跨库失真。
 *
 * 写侧严格按 `planConsolidation` 的产物执行：
 * - `supersessions` → `put({...原记录, validTo, supersededBy})`：**只标失效、不删行**
 *   （"我当时相信什么"必须仍可回答）；
 * - `edges` → `upsertEdge`；
 * - `decay` **不落盘**（它只是排序先验）；
 * - `erasures` **不由本驱动器执行**：硬删除只走用户显式要求的 `omb_forget`
 *   （本驱动不给 `erasureIds`，因此 `plan.erasures` 恒为空）。
 *
 * 绝不抛：任何一步失败都记进 `ledger.lastError`（状态面/健康面可见），
 * 且单库失败不影响其它库。**重入由调用方保证**（`consolidating` 闸）。
 */
async function runConsolidationOnce(
  kernel: Kernel,
  service: MemoryStoresService,
  ledger: ConsolidationLedger,
): Promise<void> {
  const now = kernel.clock.now()
  const snapshot = service.snapshot()
  /** 去重后的库（`snapshot()` 里每个项目套件都含用户库，不去重会白跑一遍）。 */
  const targets = new Map<string, MemoryStore>()
  for (const set of [snapshot.user, ...snapshot.projects]) {
    if (set === undefined) continue
    for (const tagged of set.stores) {
      const key = asMemoryStore(tagged.store)?.dbPath
      if (key !== undefined && !targets.has(key)) targets.set(key, tagged.store)
    }
  }

  const problems: string[] = []
  let superseded = 0
  let edges = 0
  let mergedGroups = 0
  let independentUnits = 0

  for (const [key, store] of targets) {
    const scanner = asRecordScanner(store)
    if (scanner === undefined) {
      problems.push(`${key}：库不提供记录扫描面（asRecordScanner 未命中），本轮跳过`)
      continue
    }
    try {
      const records = await scanner.listRecentRecords({ limit: CONSOLIDATION_SCAN_LIMIT })
      if (records.length < 2) continue
      const plan = planConsolidation({ records }, { now })
      mergedGroups += plan.merges.length
      independentUnits += plan.stats.independentUnits
      const byId = new Map(records.map(record => [record.id, record]))
      for (const item of plan.supersessions) {
        const target = byId.get(item.id)
        if (target === undefined) continue
        try {
          await store.put({ ...target, validTo: item.validTo, supersededBy: item.supersededBy })
          superseded += 1
        } catch (error) {
          problems.push(`${key}：标失效 ${item.id} 失败（${messageOf(error)}）`)
        }
      }
      for (const edge of plan.edges) {
        try {
          await store.upsertEdge(edge)
          edges += 1
        } catch (error) {
          problems.push(`${key}：写边 ${edge.fromId}→${edge.toId} 失败（${messageOf(error)}）`)
        }
      }
    } catch (error) {
      problems.push(`${key}：读取或规划失败（${messageOf(error)}）`)
    }
  }

  ledger.runs += 1
  ledger.lastSuperseded = superseded
  ledger.lastEdges = edges
  ledger.lastMergedGroups = mergedGroups
  ledger.lastIndependentUnits = independentUnits
  ledger.lastError = problems.join('；')
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
  usage: MemoryUsageLedger | undefined,
  consolidation: ConsolidationLedger | undefined,
  privacyReadings: (() => ModuleHealth) | undefined,
  runtime?: {
    readonly capture?: CaptureStats
    readonly project?: ProjectToolLedger
    readonly coldStart?: ColdStartLedger
    readonly relatedExpanded?: number
    readonly feedback?: FeedbackLedger
    readonly floor?: { readonly q: number; readonly recalls: number; readonly precision: number | null; readonly mode: string }
  },
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
    // 分档弃权：`abstentions.no-ground` 等。**没有条目的原因不出现**（0 与未发生同形，
    // 这里宁可少一个键，也不要印一个"这条原因被关了"的假 0）。
    for (const [category, count] of Object.entries(ledger.abstentionsByCategory)) {
      if (typeof count === 'number' && count > 0) metrics[`abstentions.${category}`] = count
    }
  }
  if (usage !== undefined && usage.failures > 0) metrics['usageFailures'] = usage.failures

  /**
   * 3.7 Wave 2 运行读数（W4 验收用；全部来自本模块自己的台账，不是"被观测对象自报"）：
   * - 自主捕获按类计数 + 跳过原因（P1：为什么没写）；
   * - 项目画像读取/重建/降级（"未接线"必须可见）；
   * - 冷启动重试与失败（P4：283 次失败要能降到 <10）；
   * - 1-hop 关联扩展累计（P2：扩展真的被用到）。
   */
  if (runtime?.capture !== undefined) {
    metrics['capture.preferences'] = runtime.capture.preferences
    metrics['capture.activity'] = runtime.capture.activity
    metrics['capture.outcomes'] = runtime.capture.outcomes
    // v4.1 §3.5：生命周期读数（没有成功就没有"完成过"；尝试与结果分开计数）
    metrics['capture.failed'] = runtime.capture.failed
    metrics['capture.unconfirmed'] = runtime.capture.unconfirmed
    metrics['capture.unknownResult'] = runtime.capture.unknownResult
    metrics['capture.noPending'] = runtime.capture.noPending
    metrics['capture.unconfirmedCall'] = runtime.capture.unconfirmedCall
    metrics['capture.pending'] = runtime.capture.pending
    for (const [reason, count] of Object.entries(runtime.capture.skipped)) {
      if (count > 0) metrics[`capture.skipped.${reason}`] = count
    }
  }
  if (runtime?.project !== undefined) {
    metrics['project.reads'] = runtime.project.reads
    metrics['project.refreshes'] = runtime.project.refreshes
    metrics['project.degraded'] = runtime.project.degraded
  }
  if (runtime?.coldStart !== undefined) {
    metrics['coldStart.retries'] = runtime.coldStart.retries
    metrics['coldStart.failures'] = runtime.coldStart.failures
  }
  if (runtime?.relatedExpanded !== undefined && runtime.relatedExpanded > 0) {
    metrics['recall.relatedExpanded'] = runtime.relatedExpanded
  }
  if (runtime?.feedback !== undefined) {
    metrics['feedback.commands'] = runtime.feedback.commands
    if (runtime.feedback.useful > 0) metrics['feedback.useful'] = runtime.feedback.useful
    if (runtime.feedback.wrongPending > 0) metrics['feedback.wrongPending'] = runtime.feedback.wrongPending
    if (runtime.feedback.wrongConfirmed > 0) metrics['feedback.wrongConfirmed'] = runtime.feedback.wrongConfirmed
    if (runtime.feedback.archived > 0) metrics['feedback.archived'] = runtime.feedback.archived
    if (runtime.feedback.revived > 0) metrics['feedback.revived'] = runtime.feedback.revived
    if (runtime.feedback.refused > 0) metrics['feedback.refused'] = runtime.feedback.refused
  }
  if (runtime?.floor !== undefined) {
    metrics['lexical.floor.q'] = Number(runtime.floor.q.toFixed(3))
    metrics['lexical.floor.recalls'] = runtime.floor.recalls
    metrics[runtime.floor.mode === 'relative' ? 'lexical.floor.relative' : 'lexical.floor.fixed'] = 1
    if (runtime.floor.precision !== null) metrics['lexical.floor.precision'] = Number(runtime.floor.precision.toFixed(3))
  }

  /**
   * **隐私读数（3.6 并入）**。
   *
   * 为什么必须并进本行：`omb-privacy` 那一行没了，本行现在同时代表隐私闸门。
   * 不并进来，插件页会显示"记忆库正常"，而对"状态文件损坏 → 所有会话按 sealed 兜底"
   * 或"状态文件路径解析不出 → 未持久化"只字不提——那正是"没有静默失效"要挡的形态。
   *
   * 读数**未接线**（`privacyReadings === undefined`）单独写一句，不假装 ok：
   * 那种情况下闸门根本没装，模式一条都不会生效。
   */
  const privacyHealth = privacyReadings?.()
  const privacyNote =
    privacyHealth === undefined
      ? '；⚠ 隐私闸门**未接线**（apply 没有安装它）：隐私模式不会生效'
      : `；隐私闸门（/omb-privacy）：${privacyHealth.state === 'ok' ? '' : '⚠ '}${privacyHealth.detail}`
  if (privacyHealth?.metrics !== undefined) {
    for (const [key, value] of Object.entries(privacyHealth.metrics)) metrics[`privacy.${key}`] = value
  }

  // 目录漂移是**契约问题**，必须留声（task-6 把 requires/capabilities 改成从目录派生后，
  // 这里不再有一个 `CATALOG` 变量，直接查目录本身）。
  const catalogNote = catalogEntryOf(MODULE_ID) === undefined
    ? '；⚠ 模块目录里缺少 omb-memory 登记项（契约漂移）'
    : ''
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
  // 工件核验的降级也要可见：核验不了时准入结论只会表现为"这条不算依据"，
  // 而真因（不是 git 仓库 / git 不可执行 / 超时）没有任何别的地方说。
  const artifactWhy = artifactVerificationDegradeReason()
  const artifactNote =
    artifactWhy === null ? '' : `；⚠ 最近一次工件核验降级（该条的工件不算依据）：${artifactWhy}`
  // 使用计数是唯一能回答"这条记忆被用过几次"的账；它写不成时照样要有人喊
  const usageNote =
    usage === undefined || usage.failures === 0
      ? ''
      : `；⚠ 使用计数未写成 ${usage.failures} 次（最近：${usage.lastFailure.slice(0, 60)}${
          usage.lastFailure.length > 60 ? '…' : ''
        }）`
  // 离线整合（M3）：曾经全链零生产消费者，读数上一个字都没有——现在跑没跑、跑了什么都在这里
  const consolidationNote =
    consolidation === undefined
      ? ''
      : consolidation.runs === 0
        ? `；离线整合：已接线（每 ${consolidation.everyTurns} 个回合边界跑一次；本进程尚未到点）`
        : `；离线整合：已运行 ${consolidation.runs} 次（最近一次合并 ${consolidation.lastMergedGroups} 组、` +
          `标失效 ${consolidation.lastSuperseded} 条、新边 ${consolidation.lastEdges} 条；` +
          `独立来源≥2 的组 ${consolidation.lastIndependentUnits} 个）` +
          (consolidation.lastError.length === 0
            ? ''
            : `；⚠ 整合最近一次有失败：${consolidation.lastError.slice(0, 120)}${
                consolidation.lastError.length > 120 ? '…' : ''
              }`)
  const detail = `${pointer}${why === undefined ? '' : `；本模块记录的失败原因：${why}`}${ledgerNote}${catalogNote}${artifactNote}${usageNote}${consolidationNote}${privacyNote}`

  // 隐私闸门降级也是**本行**的降级：它现在是同一个组件的一部分。
  // 三处都不满足才算 ok：存储就绪、没有记录的失败、隐私读数 ok。
  if (why === undefined && status.ready && privacyHealth?.state === 'ok') {
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
  let usageRef: MemoryUsageLedger | undefined
  let consolidationRef: ConsolidationLedger | undefined
  /** 隐私闸门的装配产物（3.6 并入；见 `./privacy/index.js`）。 */
  let privacyRef: PrivacyInstallation | undefined
  /** 3.7 Wave 2 运行读数（惰性读：热插拔会换实例）。 */
  let captureRef: (() => CaptureStats) | undefined
  let projectLedgerRef: ProjectToolLedger | undefined
  let coldStartRef: ColdStartLedger | undefined
  let relatedExpandedRef = 0
  let feedbackLedgerRef: FeedbackLedger | undefined
  let floorRef: { q: number; recalls: number; precision: number | null; mode: string } | undefined

  const manifest: ModuleManifest<MemoryConfig> = {
    id: MODULE_ID,
    version: options.version ?? '4.1.0',
    requires: REQUIRES,
    capabilities: CAPABILITIES,
    configSchema: memoryConfigSchema,
    async health(): Promise<ModuleHealth> {
      const service = current
      if (service === undefined) {
        return { state: 'degraded', detail: '模块未启动：apply 尚未执行（或已被卸载）' }
      }
      try {
        return await describeHealth(
          service,
          ledgerRef,
          usageRef,
          consolidationRef,
          // 惰性读（不是取一次存下来）：热插拔时新实例的 install 产物必须立刻被读到
          privacyRef === undefined ? undefined : () => privacyRef!.health(),
          {
            ...(captureRef === undefined ? {} : { capture: captureRef() }),
            ...(projectLedgerRef === undefined ? {} : { project: projectLedgerRef }),
            ...(coldStartRef === undefined ? {} : { coldStart: coldStartRef }),
            relatedExpanded: relatedExpandedRef,
            ...(feedbackLedgerRef === undefined ? {} : { feedback: feedbackLedgerRef }),
            ...(floorRef === undefined ? {} : { floor: floorRef }),
          },
        )
      } catch (error) {
        // health() 自身绝不抛：状态面拿不到原因比拿到"检查失败"更糟
        return { state: 'degraded', detail: `健康检查失败：${messageOf(error)}` }
      }
    },
  }

  return {
    manifest,

    apply(kernel: Kernel, config: MemoryConfig): () => Promise<void> {
      /**
       * 宿主存储端口的**唯一解析点**。
       *
       * 隐私闸门与记忆库共用它——隐私状态文件因此落在与记忆库同一个
       * `<dshHome>/.omb/` 下；测试注入的临时端口也会把隐私状态文件带进临时目录
       * （见 `PrivacyInstallOptions.storagePort` 的说明）。
       */
      const resolveStoragePort = (): StorageHostPort | undefined =>
        options.storageHost ?? kernel.service<StorageHostPort>(STORAGE_HOST_SERVICE)

      // ── 隐私闸门（3.6 并入）：**先于 stores 装好** ─────────────────────
      //
      // 顺序有语义：`stores` 的库访问边界在**每一次调用**时惰性解析
      // `SERVICES.privacy`（见下面的 `privacy:` 注入），所以只要闸门在
      // `apply` 返回前进了服务表，"apply 之后任何一次库访问"就都过闸。
      // 先装它可以让这个窗口不存在（而不是"很短"）。
      //
      // 装不上**不抛**：隐私是记忆库的一个子能力，它坏了不该把整个记忆库拖成 failed；
      // 降级会写进健康面（`describeHealth` 的 privacyNote）与状态段。
      // `installPrivacy` 内部就完成了 `SERVICES.privacy` 的 `provide`（连同命令面、
      // 状态段与血缘订阅），所以这里**不再 provide 第二次**：同名重复注册虽然语义上是
      // "替换"（ABI 契约），但会多出一个没人持有的 disposer——那正是"同一件事两处各写一遍"的开端。
      const privacy = installPrivacy(kernel, config.privacy, { storagePort: resolveStoragePort() })
      privacyRef = privacy

      /**
       * 项目根解析（v4.1 §3.1/§3.6）：**唯一来源**是宿主 `SERVICES.projectRoot`。
       *
       * 记忆库与 `omb_project` 共用同一个闭包：两处各解析一次会出现"库按根、
       * 画像按 cwd"的裂缝（正是 v4.1 要修的项目身份分裂）。
       * 服务缺席/抛错/返回空串 → cwd 本身（非 git 目录的同一语义），绝不抛。
       */
      const projectRootOf = (cwd: string): string => {
        try {
          const port = kernel.service<{ resolve(cwd: string): string }>(SERVICES.projectRoot)
          const root = port?.resolve?.(cwd)
          if (typeof root === 'string' && root.length > 0) return root
        } catch {
          // 上游失败 → cwd（与 `dsh/project-root.ts` 的降级同一语义）
        }
        return cwd
      }
      const cwdSource = sessionCwdSource(kernel)

      const service = createStoresService({
        logger: kernel.logger,
        clock: kernel.clock,
        config: { ...config },
        maxOpenProjects: options.maxOpenProjects,
        resolvePort: resolveStoragePort,
        // **隐私强制点的唯一注入处**：惰性解析。
        // 3.6 起闸门由**本模块自己的 apply** 装上，所以这里取不到只可能是
        // `installPrivacy` 没跑成（或它注册失败）——那种降级由本模块健康面
        // （`describeHealth` 的 privacyNote）与 `modules/artifact/module.ts` 的
        // `ungatedWrites` 双双点名，不是静默失效。
        privacy: () => kernel.service<PrivacyGatePort>(SERVICES.privacy),
        // 「会话 → cwd」不再由本模块存：唯一来源是内核登记处（见 sessionCwdSource 的说明）
        ...cwdSource,
        // v4.1 §3.6：项目身份 = 项目根（子目录会话与根会话共享同一个项目库）
        projectRootOf,
      })
      // 同名重复注册 = 替换（ABI 契约，热插拔重载必然发生）；因此这里不 catch——
      // 若宿主实现真的抛，apply 抛出会由内核记为本模块 failed，语义正确。
      const off = kernel.provide(SERVICES.stores, service)
      current = service

      // ── 工具面（`tools:omb-memory` → ToolDefinition[]，契约见 SERVICES.toolsPrefix）──
      // 工具**定义**在 `recall.ts`/`graph.ts`，**装配**在本模块的 apply：
      // 这是仓库既有模式（reasoning/context/artifact 都这么做），也是 H-2 的要求
      // （注册必须在 apply 返回前完成，且只有 dsh/ 能接触宿主）。
      //
      // **会话归属来自每次调用自己的 `call.sessionId`**（宿主 `exec.agent` 投影，
      // 见 `kernel/sessionRuntime.ts`）。这里**不再有 `lastActiveSession`**：
      // "最近看到的会话"在两个会话交错时会把 A 的记忆写进 B 的项目库，
      // 而工具调用本来就带着确切归属，没有理由去猜。
      //
      // `turnBySession` 只用来把**回合号**写进 `sourceRef`（宿主 `step/start` 的 step）：
      // 它是**按会话**键控的表，不是一个"最近回合"变量。
      const turnBySession = new Map<string, number>()
      const offTurn = kernel.on('turn/start', payload => {
        turnBySession.set(payload.sessionId, payload.turn)
        // 预热该会话的项目库：打开是异步的，工具执行体只能同步取库（`peek`）。
        // 失败由服务记入状态面（`status().detail`），这里吞掉是刻意的。
        void service.forSession(payload.sessionId)
      })

      /**
       * 离线整合的**回合边界驱动**（M3）。
       *
       * ## 事实核验（本轮实读代码，不是照抄规划稿）
       *
       * `kernel/abi/kernel.ts:29` 声明了 `'turn/end': { sessionId, turn }`，
       * 而 `dsh/session.ts:815` 在宿主 `step/end` 时把它发到**内核总线**上
       * （紧邻那行就是 `flushVectorEncoder`）。因此本模块可以直接订阅它——
       * 不需要 `dsh/` 配合，也就不必动 S1 的文件。
       * 规划稿的退路（"以下一个 `turn/start` 作为上一回合边界"）因此**不必用**：
       * 这里用的是真正的回合结束事件。
       *
       * ## 口径
       *
       * - 计数是**全局**的（跨会话）：整合遍历所有已打开库，不按会话分片；
       * - 每 `consolidationEveryTurns` 个回合边界跑一次（`consolidationEveryTurns`
       *   从此是**活的**配置，不再是只进一条 debug 日志的死旋钮）；
       * - 回调**立即返回**，真正的活在 `void` 起的异步链里：回合边界绝不能被整合拖住；
       * - 重入闸：上一轮还在跑时不再启动新的一轮（不重复标失效、不重复发边）。
       */
      /** 离线整合台账（见 `ConsolidationLedger`）：跑没跑、跑了什么、出没出错都在这里。 */
      const consolidationLedger: ConsolidationLedger = {
        everyTurns: config.consolidationEveryTurns,
        runs: 0,
        lastSuperseded: 0,
        lastEdges: 0,
        lastMergedGroups: 0,
        lastIndependentUnits: 0,
        lastError: '',
      }
      consolidationRef = consolidationLedger
      let turnsSinceConsolidation = 0
      let consolidating = false
      const offTurnEnd = kernel.on('turn/end', () => {
        turnsSinceConsolidation += 1
        if (consolidating) return
        if (turnsSinceConsolidation < config.consolidationEveryTurns) return
        turnsSinceConsolidation = 0
        consolidating = true
        void runConsolidationOnce(kernel, service, consolidationLedger)
          .catch((error: unknown) => {
            // 驱动器自己绝不抛；这一层只是防未来的改动引入未捕获的 rejection
            consolidationLedger.runs += 1
            consolidationLedger.lastError = `整合运行异常（已隔离）：${messageOf(error)}`
          })
          .finally(() => {
            consolidating = false
          })
      })

      /**
       * 写入账本。**弃权必须可审计**（§5.6）：弃权率是发现"该记的没记"的唯一手段。
       * 通过 health 的 metrics 与 detail 暴露给状态面。
       */
      const ledger: MemoryWriteLedger = {
        writes: 0,
        abstentions: 0,
        lastAbstention: '',
        abstentionsByCategory: {},
      }
      ledgerRef = ledger
      /** 使用计数账本（见 `MemoryUsageLedger`）：写不成也要可见。 */
      const usageLedger: MemoryUsageLedger = { failures: 0, lastFailure: '' }
      usageRef = usageLedger

      /**
       * 解析本次调用该用哪些库。
       *
       * 有会话 → 该会话的项目库（`peek` 只在已打开时命中）；没有会话 → **只给用户库**，
       * 调用方会在回执里写明"归属未知"。**绝不**退化成"最近一个会话"的库。
       */
      const resolveStores = (sessionId?: string): readonly TaggedStore[] | undefined => {
        const set = sessionId === undefined ? undefined : service.peek(sessionId)
        return (set ?? service.snapshot().user)?.stores
      }

      // ── 3.7 Wave 2：冷启动重试、自主捕获、项目画像、自动连边 ─────────────
      const projectToolLedger: ProjectToolLedger = { reads: 0, refreshes: 0, degraded: 0, lastError: '' }
      projectLedgerRef = projectToolLedger
      const coldStart: ColdStartLedger = { retries: 0, failures: 0 }
      coldStartRef = coldStart

      const waitMs = async (ms: number): Promise<void> => {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, ms)
          if (typeof (timer as { unref?: () => void }).unref === 'function') {
            ;(timer as { unref: () => void }).unref()
          }
        })
      }

      /**
       * **写入解析**（P4 冷启动）：项目库未就绪 → 等 `coldStartRetryMs` 再取一次。
       *
       * 为什么必须在此处重试：宿主 `turn/start` 才预热项目库，而自主捕获/工具调用
       * 可能更早发生；实测 283 次"项目库尚未就绪"写入失败大多是这个竞态。
       * **绝不回落用户库**：项目作用域写进用户库会污染跨项目面（位置即权威）。
       */
      const resolveWriteStore = async (
        scope: MemoryScope,
        sessionId?: string,
      ): Promise<MemoryStore | undefined> => {
        if (sessionId === undefined) {
          return scope === 'user' ? service.snapshot().user?.store('user') : undefined
        }
        const first = (await service.forSession(sessionId)) ?? service.snapshot().user
        const direct = first?.store(scope)
        if (direct !== undefined || scope !== 'project' || config.coldStartRetryMs <= 0) {
          if (direct === undefined && scope === 'project') {
            coldStart.failures += 1
            kernel.logger.warn(`OMB：项目库写入未就绪（会话 ${sessionId}）——不回落用户库`)
          }
          return direct
        }
        coldStart.retries += 1
        await waitMs(config.coldStartRetryMs)
        const second = (service.peek(sessionId) ?? (await service.forSession(sessionId))) ?? service.snapshot().user
        const retried = second?.store('project')
        if (retried === undefined) {
          coldStart.failures += 1
          kernel.logger.warn(`OMB：项目库重试仍未就绪（会话 ${sessionId}，等了 ${config.coldStartRetryMs}ms）`)
        }
        return retried
      }

      /** 隐私写许可（自主捕获必须过闸；库访问边界还会再拦一次）。 */
      const writeAllowed = (sessionId: string): boolean => {
        try {
          const gate = kernel.service<{ decide(id: string): { allowWrite: boolean } }>(SERVICES.privacy)
          return gate?.decide(sessionId).allowWrite ?? true
        } catch {
          return false
        }
      }

      /** 写入后的图自动连边（3.7 Wave 2 §4）：失败只留声，不影响写入。 */
      const linkOnStored = async (store: MemoryStore, record: MemoryRecord): Promise<void> => {
        if (!config.autoLinkRelated) return
        const outcome = await autoLinkRelated(store, record, {
          now: kernel.clock.now(),
          projectName: record.project,
        })
        if (outcome.linked.length > 0) {
          kernel.logger.debug(
            `OMB：自动连边 ${outcome.linked.length} 条（${record.scope}/${record.kind}，` +
              `共享键示例：${outcome.linked[0]?.shared.slice(0, 2).join('、') ?? ''}）`,
          )
        }
      }

      const capture: Capture = createCapture({
        clock: kernel.clock,
        resolveStore: resolveWriteStore,
        currentProject: sessionId => service.peek(sessionId)?.projectScope ?? undefined,
        privacyAllowsWrite: writeAllowed,
        onMemoryWritten: payload => {
          ledger.writes += 1
          kernel.emit('memory/written', payload)
        },
        onMemoryStored: linkOnStored,
        logger: kernel.logger,
        enabledPreferences: config.autoCapturePreferences,
        enabledActivity: config.autoCaptureActivity,
        enabledOutcome: config.autoCaptureOutcome,
        projectRetryMs: config.coldStartRetryMs,
      })
      captureRef = () => capture.stats()

      // ── 3.7 Wave 2（R9 C1/C2/C3）：隐式效用、显式反馈、自适应下限 ──────────
      const usageTracker = createUsageTracker()
      const feedbackLedger: FeedbackLedger = {
        commands: 0, useful: 0, wrongPending: 0, wrongConfirmed: 0, archived: 0, revived: 0, refused: 0, lastChange: '',
      }
      feedbackLedgerRef = feedbackLedger
      let calibrator = new AdaptiveFloorCalibrator({}, config.lexicalFloorTargetPrecision)
      const floorState = {
        q: calibrator.q,
        recalls: 0,
        precision: null as number | null,
        mode: config.lexicalFloorMode,
      }
      floorRef = floorState
      let floorLoaded = false
      let lastTotals = { exposed: 0, used: 0 }

      const userUtility = (): ReturnType<typeof asUtilityStore> => {
        const store = service.snapshot().user?.store('user')
        return store === undefined ? undefined : asUtilityStore(store)
      }
      /** 从 `memory_meta` 恢复 q（跨重启确定；读不出就用初值，不假装学过了）。 */
      const loadFloorState = async (): Promise<void> => {
        if (floorLoaded) return
        floorLoaded = true
        try {
          const api = userUtility()
          if (api === undefined) return
          const saved = await api.utilityMeta('lexical.floor.q')
          const parsed = saved === undefined ? Number.NaN : Number(saved)
          if (Number.isFinite(parsed)) {
            calibrator = new AdaptiveFloorCalibrator({ q: parsed }, config.lexicalFloorTargetPrecision)
            floorState.q = calibrator.q
          }
          const totals = await api.utilityTotals()
          lastTotals = { exposed: totals.exposed, used: totals.used }
        } catch {
          // 读不出 = 用初值（状态面会显示 recalls/q，不显示"已学习"）
        }
      }
      /**
       * 每次召回后尝试一次校准：每 20 次用"本窗口 used/exposed"更新 q（步长 ≤0.05）。
       * 失败一律隔离（校准是旁路，不得影响召回）。
       */
      const calibrateAfterRecall = async (): Promise<void> => {
        try {
          await loadFloorState()
          floorState.recalls += 1
          let deltaExposed = 0
          let deltaUsed = 0
          const api = userUtility()
          if (api !== undefined) {
            const totals = await api.utilityTotals()
            deltaExposed = Math.max(0, totals.exposed - lastTotals.exposed)
            deltaUsed = Math.max(0, totals.used - lastTotals.used)
            lastTotals = { exposed: totals.exposed, used: totals.used }
          }
          const updated = calibrator.observe({ exposures: deltaExposed, used: deltaUsed })
          const state = calibrator.state()
          floorState.q = state.q
          floorState.precision = state.precision
          if (updated && api !== undefined) {
            await api.setUtilityMeta('lexical.floor.q', String(state.q))
            await api.setUtilityMeta('lexical.floor.precision', state.precision === null ? '' : String(state.precision))
          }
        } catch (error) {
          kernel.logger.warn(`OMB：自适应下限校准失败（已隔离）——${messageOf(error)}`)
        }
      }
      /** `used_tool`：工具调用与最近曝光记忆共享实体键 → 隐式使用 +1。 */
      const recordUsedFromToolCall = async (payload: {
        readonly sessionId: string
        readonly tool: string
        readonly args: string
        readonly at: number
      }): Promise<void> => {
        try {
          const ids = usageTracker.matchToolCall(payload.sessionId, payload.tool, payload.args)
          if (ids.length === 0) return
          for (const tagged of resolveStores(payload.sessionId) ?? []) {
            const api = asUtilityStore(tagged.store)
            if (api !== undefined) await api.recordUsed(ids, payload.at)
          }
        } catch (error) {
          kernel.logger.warn(`OMB：隐式使用记账失败（已隔离）——${messageOf(error)}`)
        }
      }
      const feedback = config.feedbackCommand
        ? installFeedback(kernel, {
            clock: kernel.clock,
            resolveStores: sessionId => resolveStores(sessionId),
            privacy: () => kernel.service(SERVICES.privacy),
            logger: kernel.logger,
            onFeedback: info => {
              feedbackLedger.commands += 1
              feedbackLedger.lastChange = `${info.action}→${info.change}`
              if (info.change === 'useful' || info.change === 'revive') feedbackLedger.useful += 1
              if (info.change === 'wrong-pending') feedbackLedger.wrongPending += 1
              if (info.change === 'wrong-confirmed') feedbackLedger.wrongConfirmed += 1
              if (info.change === 'stale-archived') feedbackLedger.archived += 1
              if (info.change === 'revive') feedbackLedger.revived += 1
            },
          })
        : {
            commandState: () => '未启用（config.feedbackCommand=false）',
            dispose: (): void => {},
          }

      const offCaptureMessage = kernel.on('user/message/observed', payload => {
        void capture.onUserMessage(payload)
      })
      const offCaptureCall = kernel.on('tool/call/observed', payload => {
        void capture.onToolCall(payload)
        void recordUsedFromToolCall(payload)
      })
      const offCaptureResult = kernel.on('tool/result/observed', payload => {
        void capture.onToolResult(payload)
      })
      const offCaptureOutcome = kernel.on('turn/end', payload => {
        void capture.onTurnEnd({ sessionId: payload.sessionId, turn: payload.turn })
      })
      const offCaptureWarm = kernel.on('turn/start', payload => {
        capture.warm(payload.sessionId)
      })

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
          // 压力是**按会话**的读数：没有会话就不施压（不拿别人的读数塑形本次检索）
          pressureBand: sessionId =>
            sessionId === undefined ? undefined : kernel.pressure(sessionId).band,
          // 召回缺省详细度（3.7-M2）：配置开关，个体调用仍可用 detail 覆盖
          defaultDetail: config.recallDetail,
          // 1-hop `related` 扩展（3.7 Wave 2，默认开）
          expandRelated: config.relatedExpansion,
          // 自适应词法下限（R9 C3）：q 由校准器在线更新；fixed 模式走旧 0.5
          lexicalFloorMode: config.lexicalFloorMode,
          lexicalFloorQuantile: () => floorState.q,
          onRetrieved: (result, sessionId) => {
            relatedExpandedRef += result.stats.relatedExpanded
            // 曝光登记（隐式效用的分母；`markUsed` 已写 exposed，这里登记实体键供 used_tool 匹配）
            if (result.items.length > 0 && sessionId !== undefined) {
              usageTracker.noteExposure(
                sessionId,
                result.items.map(item => ({ id: item.id, text: item.text })),
                kernel.clock.now(),
              )
            }
            void calibrateAfterRecall()
          },
          // 使用计数写不成：计数 + 原因进健康面（记账失败不改变召回结果，但绝不静默）
          onUsageFailure: info => {
            usageLedger.failures += 1
            usageLedger.lastFailure = info.reason
            kernel.logger.warn(`OMB：使用计数未写成（${info.ids.length} 条）——${info.reason}`)
          },
        }),
        createRelateTool({ resolveStores }),
        // ── 写入路径（规划 §5.6 在线部分）：不写，两个库永远是空的 ──────────────
        createRememberTool({
          // 写入可**等库打开**（读路径不行，它有延迟预算）：项目库尚未预热也能落库。
          // 3.7 Wave 2：项目库未就绪时**重试一次**（冷启动竞态），仍不行则返回可读失败，
          // **绝不**回落用户库（见 `resolveWriteStore`）。
          resolveStore: async (scope: MemoryScope, sessionId?: string) =>
            await resolveWriteStore(scope, sessionId),
          clock: kernel.clock,
          // 回合号按会话取（查不到就是 undefined：`sourceRef` 会退化成 `session:<id>`）
          currentTurn: sessionId =>
            sessionId === undefined ? undefined : turnBySession.get(sessionId),
          // 项目身份：套件的 projectScope 就是规范化 cwd（§5.3）
          currentProject: sessionId =>
            sessionId === undefined ? undefined : service.peek(sessionId)?.projectScope ?? undefined,
          degradeReason: () => service.failure(),
          /**
           * 工件存在性核验——准入判据里"可由具体工件复现"**真的去核验**。
           *
           * 判据本身是纯函数，碰不了文件系统；而只做形态匹配的后果实测过：
           * 编造的 `does-not-exist-9f3a.json` 与真实文件名拿到同一个准入结论，
           * 字段却叫 `reproducible-artifact`。**名不副实的闸门等于没有闸门。**
           *
           * 这里按语义解析相对路径，主查 cwd。**基准目录优先本次调用的会话**：
           * 拿错 cwd 只会让核验更保守（判成不存在 → 不算依据），不会收下假事实。
           * 代价是**一次同步 `git ls-files`**（不是 `existsSync`）：
           * 按 cwd 复用索引窗口 64 次核验，**负结果同样缓存**（非 git 目录下不会每条都 spawn），
           * 降级原因见 `./artifacts.ts` 的 `artifactVerificationDegradeReason()`（进健康面）。
           * 任何异常都返回 `undefined`（=核验不了 → 不算依据），绝不抛。
           */
          verifyArtifact: (candidate: string, kind: ArtifactKind, sessionId?: string) => {
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
            const registry = kernel.service<{ cwd(session?: string): string | null }>(
              SERVICES.activeSession,
            )
            // 优先本次调用所属会话的 cwd；没有会话/查不到才退回内核登记处的当前会话。
            let sessionCwd: string | null = null
            if (sessionId !== undefined) sessionCwd = registry?.cwd(sessionId) ?? null
            if (sessionCwd === null) sessionCwd = registry?.cwd() ?? null
            return verifyArtifactExists(candidate, sessionCwd)
          },
          /**
           * `memory/written` 是**向量落盘的唯一触发源**：embed-dev 订阅它做批量编码。
           * 在 put 成功之后发；订阅者异常由事件总线隔离，`emit` 自身也不会抛。
           *
           * ⚠️ 载荷里**没有会话**（`kernel/abi/kernel.ts` 的 `memory/written`）：
           * 编码按 memory id 从库里取文本，本就不需要会话，但**不得**把它当会话信号。
           */
          onWritten: payload => {
            ledger.writes += 1
            kernel.emit('memory/written', payload)
          },
          /**
           * **会话见证**（3.7-M4）：惰性读内核服务，拿不到就退化为旧行为。
           *
           * 服务由 Lead 在 `dsh/session.ts` 侧实现并 provide（`user/message` 缓存 +
           * `tool/call` 台账）。每次执行再解析：热插拔换实例后立刻生效。
           */
          witness: () => readSessionWitness(name => kernel.service(name)),
          // 3.7 Wave 2：写入成功后自动连 `related` 边（仅附加索引，失败不影响写入）
          onStored: linkOnStored,
          logger: kernel.logger,
          onAbstained: info => {
            ledger.abstentions += 1
            ledger.lastAbstention = info.reason
            // 按原因分档计数：健康面据此区分"该记的没记"与"接线/归属问题"
            ledger.abstentionsByCategory[info.category] =
              (ledger.abstentionsByCategory[info.category] ?? 0) + 1
            // 完整原因进日志（detail 里只放截断版，避免状态面被长文本淹没）
            kernel.logger.info(`OMB：记忆写入弃权（${info.category}）——${info.reason}`)
          },
        }),
        // ── 项目画像入口（3.7 Wave 2 §3）：任务开始时先读，画像服务可缺席 ──────────
        createProjectTool({
          clock: kernel.clock,
          resolveProject: sessionId => {
            if (sessionId === undefined) return undefined
            const set = service.peek(sessionId)
            if (set === undefined) return undefined
            // 画像的 `cwd` 是**本次会话目录**（L0 的 `cwd 相对根` 靠它），不是项目根；
            // 项目库/记忆仍按根统一（`set.projectScope` 已是根）。
            const cwd = cwdSource.resolveSessionCwd(sessionId) ?? set.projectScope ?? undefined
            return { cwd, store: set.store('project') }
          },
          // v4.1 §3.4：状态机 situation（L2/L3/L5）；缺省=未接线，渲染里如实写
          situation: sessionId => {
            if (sessionId === undefined) return undefined
            try {
              const svc = kernel.service<{ situation?(id: string): SessionSituationView | undefined }>(
                SERVICES.sessionState,
              )
              return svc?.situation?.(sessionId)
            } catch {
              return undefined
            }
          },
          // v4.1 §5：隐私先于读取。服务缺席=可读；判定抛错=不可读（fail-closed）
          privacyAllowsRead: sessionId => {
            const gate = kernel.service<PrivacyGatePort>(SERVICES.privacy)
            if (gate === undefined) return true
            try {
              return gate.decide(sessionId).allowRead
            } catch {
              return false
            }
          },
          // v4.1 §3.1：项目根解析与记忆库共用同一闭包
          projectRoot: projectRootOf,
          profile: () => {
            const port = kernel.service<ProjectProfilePort>(SERVICES.projectProfile)
            if (port === undefined) return undefined
            return {
              read: cwd => {
                projectToolLedger.reads += 1
                try {
                  const view = port.read(cwd)
                  if (view === undefined) projectToolLedger.degraded += 1
                  return view
                } catch (error) {
                  projectToolLedger.degraded += 1
                  projectToolLedger.lastError = messageOf(error)
                  throw error
                }
              },
              refresh: async cwd => {
                projectToolLedger.refreshes += 1
                try {
                  const view = await port.refresh(cwd)
                  if (view === undefined) projectToolLedger.degraded += 1
                  return view
                } catch (error) {
                  projectToolLedger.degraded += 1
                  projectToolLedger.lastError = messageOf(error)
                  throw error
                }
              },
            }
          },
        }),
      ]
      const offTools = kernel.provide(toolsServiceFor(MODULE_ID), tools)
      /**
       * **常驻提示**（3.7-M1）：`prompt:omb-memory` 由集成层按前缀自动发现。
       *
       * 不在 apply 里写任何时间/计数：它进静态前缀，逐字节稳定是硬要求。
       * 配置 `residentHint:false` 时不注册（回滚开关），行为回到 3.6。
       */
      const offPrompt = config.residentHint
        ? kernel.provide(PROMPT_SERVICE, { id: MODULE_ID, resident: MEMORY_RESIDENT_HINT })
        : () => {}
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
        `omb-memory：consolidationEveryTurns=${config.consolidationEveryTurns}（已接线：每这么多个回合边界` +
          `跑一次离线整合，见 apply 里的 turn/end 订阅），` +
          `embeddingThreads=${config.embeddingThreads}（存储层不消费，供向量子能力读取）`,
      )

      return async (): Promise<void> => {
        // H-1：dispose 绝不抛异常。任何一步失败都只记日志。
        for (const [label, close] of [
          ['工具服务', offTools],
          ['常驻提示', offPrompt],
          ['捕获·用户消息订阅', offCaptureMessage],
          ['反馈命令', () => feedback.dispose()],
          ['捕获·工具调用订阅', offCaptureCall],
          ['捕获·工具结果订阅', offCaptureResult],
          ['捕获·回合结局订阅', offCaptureOutcome],
          ['捕获·回合预热订阅', offCaptureWarm],
          ['回合订阅', offTurn],
          ['回合结束订阅', offTurnEnd],
          // 隐私闸门：注销服务、命令、状态段与血缘订阅。
          // **放在同步前缀里**：`kernel.dispose()` 不等 Promise（`kernel/index.ts:109`），
          // 而"卸载后 SERVICES.privacy 立刻消失"是测试与热插拔都依赖的可见事实。
          ['隐私闸门', () => privacy.dispose()],
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
        if (usageRef === usageLedger) usageRef = undefined
        if (consolidationRef === consolidationLedger) consolidationRef = undefined
        if (privacyRef === privacy) privacyRef = undefined
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

