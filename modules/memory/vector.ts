/**
 * 向量通道模块入口（`omb-memory-vector`）。
 *
 * 这是一个**可关模块**（规划 §5.7）：关掉它 → 检索退化为**完整的纯词法版本**。
 * 因此本模块只做四件事，且都不改动词法路径：
 * ① 把嵌入器注册为内核服务 `embedder`（`SERVICES.embedder`，见 `kernel/abi/catalog.ts`）；
 * ② 尝试装载 BGE-small-zh ONNX，失败则留在**哈希词袋**这条诚实降级路径上；
 * ③ 把"当前通道 + 降级原因"写进 `health()` 与状态面贡献（无空降级）；
 * ④ **回合边界的陈旧向量回填**：换嵌入器后，库里"当前身份下没有向量"的记忆被重新编码
 *    （有上界、可重入、不阻塞回合、嵌入器不可用时停住）。见 `scanRebuild` 与 `encodePending`。
 *
 * ④ 存在的理由（缺陷 A）：归属标签（`model_id`/`dim`/`revision`）让换嵌入器后的旧向量
 * **不再参与检索**（`store.ts:172`），而唯一的编码入口只由 `memory/written` 喂——
 * 也就是**只编码新写入的记忆**。于是把兜底的 `hash-bow-256` 换成真正的
 * `bge-small-zh-v1.5-512` 时，全部存量向量一夜之间失效且**永远不会被重建**：
 * 检索不报错（词法通道还在），只是向量通道对旧记忆静默返回空。
 *
 * **同步注册（热插拔 H-2）**：`apply` 里 `kernel.provide` / `statusRegistry.register` 必须同步完成
 * ——宿主挂载审计只查一次，返回后再注册会触发进程级失败告警。而 ONNX 的装载是异步的，
 * 所以注册的对象是一个**身份稳定、内容可升级的门面**（`SwitchableEmbedder`）：
 * 属性（`id`/`dimensions`/`revision`）始终反映"此刻真正在用的那个嵌入器"，
 * 因此写库时的归属标签永远是真话。
 *
 * 升级窗口的诚实说明：探测完成前若有写入，那些向量归属为哈希词袋（256 维）；升级后写入的向量
 * 归属为 BGE（512 维）。**两种向量不会静默混存**——库内 `meta` 与 `checkEmbedderCompat`
 * 会把不匹配的写入**拒绝**并给出可读原因（规划 §2 D2），这正是"写入时拒绝无法归属的向量"。
 *
 * 关闭语义：`dispose` 先注销服务与状态面贡献再改状态，**绝不抛异常**（H-1）；
 * 注销后词法路径不受任何影响。
 */
import { z } from 'zod'
import {
  MEMORY_SCOPES,
  SERVICES,
  derivedCapabilities,
  derivedRequires,
  type Embedder,
  type Kernel,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type ModuleHealth,
  type ModuleManifest,
  type ModuleRegistration,
  type ScoredHit,
  type SecondaryChannelRegistry,
  type StatusRegistry,
  type StoreSet,
  type StoresService,
  type VectorAttribution,
} from '../../kernel/abi/index.js'
import { HASH_BOW_COSINE_FLOOR, blobDecodeFailureCount, checkEmbedderCompat, hashBagEmbedder } from './embed.js'
import {
  BGE_COSINE_FLOOR,
  BGE_EMBEDDER_ID,
  loadOnnxEmbedder,
  resolveOnnxModelDir,
  type OnnxEmbedderOptions,
  type OnnxLoad,
} from './onnx.js'
import type { ChannelQuery, RetrievalChannel } from './retrieve.js'
import {
  asMemoryStore,
  asVectorStore,
  type EmbeddingMeta,
  type VectorStoreApi,
} from './store.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

/** 模块 id = `cordis.patch.yml` 行 id = 插件页开关 id（`kernel/abi/catalog.ts`）。 */
export const VECTOR_MODULE_ID = 'omb-memory-vector'
/** 本模块注册的嵌入器服务名（契约见 `SERVICES`）。 */
export const EMBEDDER_SERVICE = SERVICES.embedder
/**
 * 本模块注册的**编码队列**服务名（契约见 `SERVICES.vectorEncoder`）。
 *
 * 写入只入队、编码由 `dsh/` 在宿主回合边界批量驱动（`dsh/session.ts` 的 `encodePending` 调用）。
 */
export const VECTOR_ENCODER_SERVICE = SERVICES.vectorEncoder
/** 待编码队列的默认上界（`maxPending` 配置的缺省值）。 */
export const DEFAULT_MAX_PENDING = 256
/**
 * 一次回合边界最多把多少条**待重建**（陈旧）向量放进队列（`maxBackfill` 配置的缺省值）。
 *
 * 为什么有上界而不是"一次重建全库"：换嵌入器后整个库都成了待重建，一次全塞进队列意味着
 * ① 一次 `getMany` 把整库正文拉进内存 ② 单次 `embed` 批过大而卡住事件循环。
 *
 * 为什么取 32（= 宿主每回合的编码预算，`dsh/session.ts:635` 传 32）：**扫描上界大于它不会更快**——
 * 每回合真正编码多少由那次 `encodePending(limit)` 决定。多塞的只会堆在队列里，
 * 让新写入更容易撞上"队满丢最旧"，而吞吐一模一样。
 */
export const DEFAULT_MAX_BACKFILL = 32

/**
 * 配置 schema（缺省值必须完整：`apply` 永远收到完整配置）。
 *
 * `preprocess` 把 `undefined`/`null` 归一成 `{}`：`cordis.patch.yml` 的
 * `omb-memory-vector` 行**没有 `config`**，宿主会把 `undefined` 传进来；
 * 裸 `z.object` 会因此抛 `expected object, received undefined`，让整个模块
 * 启动失败——**一条没有配置的行不该让模块起不来**。
 *
 * `dimensions` 是**哈希兜底路径**的维度，不是神经模型的维度——神经模型的维度由模型自身决定
 * （BGE-small-zh = 512），并作为归属标签随向量持久化。
 */
export const vectorConfigSchema = z.preprocess(
  value => (value === undefined || value === null ? {} : value),
  z.object({
    /** 模型目录（显式注入）。缺省按 `$OMB_EMBEDDING_MODEL` → `<数据根>/models/bge-small-zh-v1.5` 解析。 */
    modelDir: z.string().optional(),
    /** 推理线程数（默认 2：单条毫秒级；调大会抢主对话的 CPU）。 */
    threads: z.number().int().min(1).default(2),
    /** 哈希兜底维度（默认 256）。 */
    dimensions: z.number().int().positive().default(256),
    /**
     * 待编码队列上界（默认 {@link DEFAULT_MAX_PENDING}）。
     * 写入多、冲刷慢时队列不能无界增长：超界丢**最旧**的并计数（可见，不静默）。
     */
    maxPending: z.number().int().positive().default(DEFAULT_MAX_PENDING),
    /**
     * 一次回合边界最多让多少条**待重建**（陈旧）向量入队（默认 {@link DEFAULT_MAX_BACKFILL}）。
     *
     * 上界同时受 `maxPending` 的**余量**约束：回填只填空位，绝不挤掉"写了但还没落盘"的写入
     * （那些条目丢了就没有第二次机会，而回填条目丢了下一遍扫描会重新列出）。
     */
    maxBackfill: z.number().int().positive().default(DEFAULT_MAX_BACKFILL),
    /**
     * 是否允许**降级通道**（哈希词袋）发起回填。默认 **false**。
     *
     * 回填的第一步是把库的嵌入器归属切到当前身份，老向量随之不再参与检索。
     * ONNX 装不上时当前身份就是哈希词袋——自动切过去等于用"字符匹配"替换库里的语义向量，
     * 而且会在权重"忽有忽无"之间反复改写。默认停住并把原因写在状态面上；
     * 真要把库降到兜底空间，那是使用者的显式决定（开这个开关）。
     */
    allowFallbackRebuild: z.boolean().default(false),
  }),
)

export type VectorConfig = z.infer<typeof vectorConfigSchema>

/** 一次批量冲刷的结果。**绝不抛**：失败走 `reason`。 */
export interface VectorEncodeOutcome {
  readonly encoded: number
  readonly skipped: number
  readonly failures: number
  /** 整批未能编码的原因（队列已保留，下次再试）；成功时缺省。 */
  readonly reason?: string
}

/** 编码队列读数（状态面）。 */
export interface VectorEncoderStats {
  readonly pending: number
  readonly encoded: number
  readonly skipped: number
  readonly failures: number
  /** 因超界被丢弃的最旧条目数。 */
  readonly dropped: number
  /** 被库拒绝的写入数（如归属不符）——重试不会成功，故出队并计数。 */
  readonly rejected: number
  readonly lastReason: string | null
  /** 陈旧向量回填的读数（见 {@link VectorRebuildStats}）。 */
  readonly rebuild: VectorRebuildStats
}

/**
 * 待重建的**两类原因**读数（状态面/健康面据此区分）。
 *
 * 为什么必须分开：两类待办的"下一步"完全不同——`缺当前身份`只要等回填跑完；
 * `正文已改写`说明**有人在改写正文而向量没跟上**（要去查是谁在改写）。
 * 合成一个数字时，"检索结果莫名其妙"的现场无法判断是哪一类（本仓库的规矩：降级必须可读）。
 *
 * `null` = 尚未测量（不是零），与 `stale` 同一口径。
 */
export interface StaleEmbeddingCauses {
  /** 当前身份下**没有**向量的记忆条数（换嵌入器之后的存量失效，缺陷 A）。 */
  readonly lackingIdentity: number | null
  /** 有当前身份的行、但 `content_hash` 与此刻正文不符（含 NULL = 未知）的条数（缺陷 B）。 */
  readonly contentChanged: number | null
}

/**
 * 陈旧向量回填的读数。**每个字段都回答一个具体问题**（这块读数存在的理由见本文件头部 ④）：
 * 还有多少条记忆的向量通道是空的或过时的、已经补上多少、失败多少、这一刻为什么没在补。
 */
export interface VectorRebuildStats {
  /**
   * **待重建**条数：向量通道对它们**恒返回空或返回过时向量**的记忆条数。
   *
   * 两类合计（见 {@link StaleEmbeddingCauses}）：① 当前身份下没有向量 ② 有向量但正文已改写。
   *
   * `null` = 尚未测量（本进程还没完成一次回填统计），**不是零**——一次都没扫过时报 0
   * 会把"没测"说成"没有"（本仓库的硬规矩，见 `status-honesty.test.ts`）。
   */
  readonly stale: number | null
  /** `stale` 的**原因拆分**（与它同一次统计得到；未测量时两个字段都是 null）。 */
  readonly causes: StaleEmbeddingCauses
  /**
   * 本周期在库上**实测**的基准条数（`null` = 还没测过）。
   *
   * 为什么渲染层需要它：`causes` 是**基准那一刻**的快照（此后保持不变），
   * 而 `stale = 基准 − 已完成` 是当下还剩多少。两者口径不同，所以
   * "两类原因之和"只有**未完成任何一条**时才等于 `stale`；一旦补齐过，
   * 那份原因说的就是**过去**的积压构成，渲染时必须标成过去时并点名这个基准——
   * 否则同一段里会同时出现「待重建 0 条」与「待重建原因：缺当前身份 5 条、正文已改写 7 条」
   * 这种互相打脸的读数（用户真机复现过）。
   */
  readonly staleBase: number | null
  /**
   * `stale` 是不是**这一刻在库上重算出来的**。
   *
   * `false` 表示它来自本轮回填的记账（周期开始时的实测基准减去已完成的量）：数字仍然精确，
   * 但它不是"刚刚又扫了一遍库"。状态面据此说清这个数是怎么来的——否则"0"会同时意味着
   * "刚刚扫过，确实没有"和"上次扫过是 0，之后一直没再看"，那是两种不同的事实。
   */
  readonly staleFromScan: boolean
  /** 累计已重建（陈旧向量重新编码并落盘）的条数。 */
  readonly rebuilt: number
  /** 累计重建失败（整批编码抛错或单条写入被拒）；陈旧行仍在库里，下一轮/下一遍再试。 */
  readonly failures: number
  /**
   * 累计回收的残留向量行数（正文已不存在 → 那些行没有消费者）。
   * 这些条目的"跳过"同时计入 `skipped`（队列口径 = 逐条处理结果）。
   */
  readonly scavenged: number
  /** 非 null = 这一刻没有在回填，值是可读原因（"为什么没在回填"必须能回答）。 */
  readonly blocked: string | null
}

/**
 * 待编码队列的条目。
 *
 * `rebuildFrom` 非空 = 这条是**陈旧回填**（不是新写入）：值是列出它的那个库，
 * 正文已不存在时据此回收残留向量行（`store.ts` 的 `deleteStaleEmbeddings`）。
 * 两者分开计数——"落盘了多少新写入"与"补回了多少旧记忆"不是同一个数字。
 */
interface PendingEntry {
  readonly scope: MemoryScope | null
  readonly rebuildFrom: VectorStoreApi | null
  /**
   * 这条记录**可能所在的库身份**（`storeKeyOf` 的键），入队那一刻定下。
   *
   * 为什么必须按库身份而不是作用域名：作用域只有 `user`/`project` 两个值，
   * 而同时可以打开多个项目库。上次冲刷"在某个 project 库里没查到"就判"已删除"，
   * 在**属于另一个（例如被 LRU 淘汰的）项目库**的条目上恰好是错的——
   * 它会被出队并计入 `skipped`，而库里那条记忆仍然没有向量（M7）。
   *
   * `null` = 入队时拿不到库清单（服务不可用/抛错）：**不知道它在哪，就不判"已删除"**，
   * 退回按作用域名判定（旧口径）并在原因里说明。
   */
  readonly candidateKeys: readonly string[] | null
}

/**
 * 库身份键。**判"这条属于哪个库"必须用它**（作用域名不够，见 `PendingEntry`）。
 *
 * 用库文件路径（`dbPath`）而不是对象身份：`stores.snapshot()` 每次调用都会重建一层
 * 隐私闸门视图（`gateSet` 是 `Object.create(inner)`），因此同一个库在两次 `snapshot()`
 * 之间**不是同一个对象**——按 `===` 判存活会把"库好好的"误判成"库没打开"，
 * 那会让队列永远清不掉（比 M7 更难发现的坏法）。
 */
function storeKeyOf(set: StoreSet, scope: MemoryScope, target: MemoryStore): string {
  return asMemoryStore(target)?.dbPath ?? `${set.projectScope ?? 'user'}\u0000${scope}`
}

/** 作用域的中文名（保留队列的原因要指名道姓，别让使用者对着 `project` 猜是哪个库）。 */
function scopeLabel(scope: MemoryScope): string {
  return scope === 'user' ? '用户库' : '项目库'
}

/** 回填扫描看到的一个库：去重后的向量面 + 身份键 + 可读标签。 */
interface VectorStoreRef {
  /** 库身份（库文件路径）：游标与去重都按它。 */
  readonly key: string
  readonly scope: MemoryScope
  readonly api: VectorStoreApi
  /** 可读标签（写进原因与状态面时用，别让使用者对着一串 hex 猜）。 */
  readonly label: string
}

/**
 * 枚举"已打开库"里的向量面，**按库去重**。
 *
 * 为什么必须去重：`snapshot()` 里每个项目套件都**同时含用户库**（`store.ts:1733` 的
 * `projectSet` 会把用户库一起放进 `stores`），不去重就会对着同一个库扫两遍——
 * 待重建数翻倍、游标互相覆盖（状态面显示"待重建 200 条"而实际只有 100）。
 *
 * 身份键用**库文件路径**而不是作用域：作用域只有 `user`/`project` 两个值，
 * 同时打开多个项目库时它们会共用一个游标（一个库扫完把另一个库的进度顶掉）。
 */
function vectorStoreRefs(sets: readonly StoreSet[]): readonly VectorStoreRef[] {
  const seen = new Set<string>()
  const refs: VectorStoreRef[] = []
  for (const set of sets) {
    for (const scope of MEMORY_SCOPES) {
      const target = set.store(scope)
      if (target === undefined) continue
      const api = asVectorStore(target)
      if (api === undefined) continue
      // 库路径要经 `asMemoryStore`：`asVectorStore` 只承诺向量面，路径是诊断字段。
      // 隐私闸门视图是 `Object.create(inner)`（同一条原型链），因此这里照常命中。
      const key = storeKeyOf(set, scope, target)
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ key, scope: target.scope, api, label: `${target.scope} 库（${key}）` })
    }
  }
  return refs
}

/**
 * 向量编码队列（内核服务 `VECTOR_ENCODER_SERVICE`）。
 *
 * 为什么是"队列 + 冲刷"而不是"写入时同步编码"：嵌入是一次真实推理（ONNX 毫秒级、
 * 且原生绑定会阻塞事件循环），把它压进写入路径会让每一次记忆写入都变慢。
 * 因此写入只**入队**（`memory/written`），编码由 `dsh/` 在回合边界调 `encodePending()` 批量做。
 */
export interface VectorEncoder {
  /** 待编码条目数（新写入 + 已入队的待重建）。 */
  pending(): number
  /**
   * 回合边界入口，两件事（`dsh/` 只在回合边界调这一个方法，见 `dsh/session.ts:736`）：
   *
   * ① **冲刷**：`getMany` 读文本（**禁 N+1**）→ `embed` **一次批编码** → 逐条落盘。
   *    归属标签取**当前嵌入器身份**（`modelId`/`dim`/`revision`），库侧会拒绝不符的写入。
   *    无嵌入器 / 库不支持向量 / 编码失败 → 返回可读 `reason` 且**保留队列**（下次再试）；
   *    文本为空或记录已不存在 → 跳过并计数；被库拒绝的单条 → 出队并计数（重试不会成功）。
   * ② **回填扫描**：把库里"当前身份下没有向量"的记忆按 `maxBackfill` 放进同一个队列，
   *    下一轮由 ① 编码——这样陈旧向量与普通写入走**同一条**批通路，不另起并发编码。
   *
   * 不阻塞回合：两件事都在本方法内，没有额外定时器/循环；签名与返回结构未变
   * （宿主侧 `flushVectorEncoder` 不知道回填的存在，因此不必改它）。
   */
  encodePending(limit?: number): Promise<VectorEncodeOutcome>
  stats(): VectorEncoderStats
}

/** 当前通道状态（`health()` 与状态面读它）。 */
export interface VectorChannelState {
  /** `onnx` = 神经嵌入；`hash-bow` = 诚实降级；`off` = 模块未启动/已卸载。 */
  readonly channel: 'onnx' | 'hash-bow' | 'off'
  /** ONNX 探测是否在飞行中。 */
  readonly probing: boolean
  /** 解析到的权重目录（无则 null）。 */
  readonly modelDir: string | null
  /** 装载期降级原因；`null` 表示无降级。**不允许为空字符串**。 */
  readonly reason: string | null
  /**
   * **检索期**降级原因（最近一次向量检索为什么返回空数组）；`null` = 最近一次检索正常。
   * 与 `reason` 分开：装载期降级是"通道选型"，检索期降级是"这一次查询没走通"，
   * 混成一个字段会让"通道好好的但某次查询失败"看不见。
   */
  readonly lastSearchError: string | null
  /** 检索期降级累计次数（空通道不是静默的——它是可读数字）。 */
  readonly channelErrors: number
  /**
   * **已观测到的**向量检索次数（成功 + 失败）。
   *
   * 为什么必须与 `lastSearchError` 并存：`lastSearchError === null` 有两种完全不同的含义——
   * "检索过一次且正常"与"一次都没检索过（无读数）"。没有这个计数，状态面只能把后者
   * 渲染成"最近一次检索：正常"，那是拿未测量冒充测量结果。
   */
  readonly searches: number
}

/** 装载器签名（默认 = `loadOnnxEmbedder`；测试可注入，避免碰真实权重）。 */
export type OnnxLoader = (options: OnnxEmbedderOptions) => Promise<OnnxLoad>

/** 可注入依赖。**生产不传**：默认即真实实现。 */
export interface VectorModuleDeps {
  readonly loadOnnx?: OnnxLoader
  /** 库套件解析（编码队列定位"这条 id 在哪个库"）。缺省读 `stores` 服务的 `snapshot()`。 */
  readonly resolveStoreSets?: StoreSetResolver
}

/**
 * 可切换嵌入器门面。
 *
 * 为什么不是"注册两次"：服务名在同一内核实例内唯一，重复 `provide` 会抛错；而热插拔约束又要求
 * `apply` 同步完成注册。门面把"注册身份"与"当前实现"解耦：身份（服务名）稳定，
 * 内容（当前向量空间）可升级，且**属性读取总是当下的真实值**——归属标签因此不会说谎。
 */
class SwitchableEmbedder implements Embedder {
  #current: Embedder

  constructor(initial: Embedder) {
    this.#current = initial
  }

  get id(): string {
    return this.#current.id
  }

  get dimensions(): number {
    return this.#current.dimensions
  }

  get revision(): string {
    return this.#current.revision
  }

  embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return this.#current.embed(texts)
  }

  /** 换用新的嵌入器（探测成功后调用；由模块持有，不对外暴露）。 */
  upgrade(next: Embedder): void {
    this.#current = next
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 两类待重建原因的**一句话描述**（状态面渲染与健康面共用，避免两处口径漂移）。
 *
 * 未测量时返回空串：调用方据此**什么也不写**——绝不把"没测过"写成"0 条"
 * （那正是本仓库最忌讳的那种读数：拿未测量冒充测量结果）。
 * 原因都在 0 条时也返回空串：没有积压时列一堆"0 条"只是噪音。
 */
function causeText(causes: StaleEmbeddingCauses): string {
  const { lackingIdentity, contentChanged } = causes
  if (lackingIdentity === null || contentChanged === null) return ''
  const parts: string[] = []
  if (lackingIdentity > 0) parts.push(`缺当前身份 ${lackingIdentity} 条（换嵌入器后的存量）`)
  if (contentChanged > 0) parts.push(`正文已改写 ${contentChanged} 条（向量编码的是旧正文）`)
  return parts.join('、')
}

/**
 * 原因拆分能不能用**现在时**（状态面与健康面共用这一处判定，避免两处口径漂移）。
 *
 * 判据（总纲）：**任何现在时的待重建读数，其两类原因之和必须等于 `stale`**。
 * 相等 → 这份原因描述的就是**当前**积压；不等（已经补齐/回收过若干条，或基准是过去测的）
 * → 它只是**基准那一刻**的构成，必须写成过去时并点名基准。
 *
 * 反例就是用户真机看到的那两行：「待重建 0 条（已对齐）」与「待重建原因：缺当前身份 5 条、
 * 正文已改写 7 条」同屏——同一个 0 与 12 都来自同一次实测，却一个说现在、一个说过去。
 */
function causesDescribeCurrent(rb: VectorRebuildStats): boolean {
  const { lackingIdentity, contentChanged } = rb.causes
  if (rb.stale === null || lackingIdentity === null || contentChanged === null) return false
  return lackingIdentity + contentChanged === rb.stale
}

/** 解析"当前已就绪的库套件"（编码队列据此定位某条 id 在哪个库）。 */
export type StoreSetResolver = (kernel: Kernel) => readonly StoreSet[]

/**
 * 缺省解析：读内核 `stores` 服务的 `snapshot()`（ABI 已冻结，见 `kernel/abi/storage.ts`）。
 * 服务缺失或抛错 → 空数组（上层给可读原因），**绝不抛**。
 */
const defaultResolveStoreSets: StoreSetResolver = (kernel) => {
  const stores = kernel.service<StoresService>(SERVICES.stores)
  if (stores === undefined) return []
  try {
    const snapshot = stores.snapshot()
    const sets: StoreSet[] = []
    if (snapshot.user !== undefined) sets.push(snapshot.user)
    for (const project of snapshot.projects ?? []) sets.push(project)
    return sets
  } catch {
    return []
  }
}

/**
 * 通道的一句话标签（health 与状态面共用，避免两处口径漂移）。
 *
 * **降级路径的措辞经过实测校正**：原来的标签只写"哈希词袋（诚实降级路径）"，
 * 而用户会自然以为它仍提供语义召回（README 曾写"同义改写能召回哈希词袋召不回的
 * 记忆"）。实测五组对照后确认：
 *
 * | 对照 | 余弦 |
 * | --- | --- |
 * | 同义改写（`这个函数太长了需要拆分` ↔ `这个方法篇幅过大应当分解`） | ≈ 0.10 |
 * | 无关（`这个函数太长了需要拆分` ↔ `今天天气不错适合散步`） | 0.00 |
 * | **语义相反但字面重合**（`删除记忆` ↔ `添加记忆`） | ≈ 0.33 |
 *
 * 它度量的是**哈希字符袋的重合度**，不是语义——同义改写只比噪声高一点点，
 * 而反义词拿到最高分。所以标签必须说"字符匹配"，否则使用者会拿它当语义通道用。
 * 判据被 `tests/modules/memory/vector-discrimination.test.ts` 冻结。
 */
function channelLabel(state: VectorChannelState, current: Embedder | undefined): string {
  if (state.channel === 'onnx') {
    return `神经嵌入 ${current?.id ?? BGE_EMBEDDER_ID}（${current?.dimensions ?? 0} 维，revision ${current?.revision ?? '?'}）`
  }
  if (state.channel === 'off') return '未启动/已关闭'
  const fallback = current === undefined ? '哈希词袋' : `哈希词袋 ${current.id}（${current.dimensions} 维）`
  // **"字符匹配，非语义"这句必须写出来**：实测同义改写只拿到 ≈0.10、反义词拿到 ≈0.33，
  // 拿它当语义通道用会得到错误的召回预期。
  const what = '（降级路径：度量字符重合，不是语义——同义改写≈0.10、无关≈0.00、反义词≈0.33）'
  return state.probing ? `${fallback}，ONNX 装载中` : `${fallback}${what}`
}

function channelMetrics(
  state: VectorChannelState,
  current: Embedder | undefined,
  enc: VectorEncoderStats,
): Record<string, number> {
  return {
    // 通道读数：1 = 向量通道可用（含降级），0 = 不可用。词法路径不受影响。
    channel: state.channel === 'off' ? 0 : 1,
    onnx: state.channel === 'onnx' ? 1 : 0,
    probing: state.probing ? 1 : 0,
    dimensions: current?.dimensions ?? 0,
    // 检索期降级累计（空通道可观测）
    channelErrors: state.channelErrors,
    // 已观测检索次数：0 = 未测量（一次都没走过），与"走过且正常"必须能区分
    searches: state.searches,
    // 落盘读数：待编码队列与累计计数（"写入却没向量"必须可见，而不是查表为空却无人知道）
    pendingEmbeddings: enc.pending,
    encodedEmbeddings: enc.encoded,
    encodeSkipped: enc.skipped,
    encodeFailures: enc.failures,
    encodeRejected: enc.rejected,
    encodeDropped: enc.dropped,
    // 回填读数：换嵌入器之后"有多少条记忆的向量通道是空的或过时的"必须是一个数字，
    // 而不是一句"检索没报错"。`-1` = 尚未测量（**不是零**：没测过与测到 0 必须能区分）。
    staleEmbeddings: enc.rebuild.stale ?? -1,
    // 两类原因分开报（同一口径的两个数）：`-1` = 本进程还没测过原因拆分。
    // 合成一个数字时，"换了模型"与"有人改写了正文"在读数上无法区分，
    // 而这两件事的处置完全不同（前者等回填，后者要查改写来源）。
    staleLackingIdentity: enc.rebuild.causes.lackingIdentity ?? -1,
    staleContentChanged: enc.rebuild.causes.contentChanged ?? -1,
    /** 这个数是不是刚刚在库上重算的（0 = 本轮回填记账，1 = 本回合实测）。 */
    staleFromScan: enc.rebuild.staleFromScan ? 1 : 0,
    rebuiltEmbeddings: enc.rebuild.rebuilt,
    rebuildFailures: enc.rebuild.failures,
    rebuildScavenged: enc.rebuild.scavenged,
    rebuildBlocked: enc.rebuild.blocked === null ? 0 : 1,
    // 损坏 BLOB 计数：让"某条记忆就是搜不到"变成可读数字（旧实现静默返回 null）。
    blobDecodeFailures: blobDecodeFailureCount(),
  }
}

/**
 * 按当前嵌入器身份选余弦下限。
 *
 * **两条路径的下限不可混用**：稠密模型（BGE）的余弦恒为正，若沿用稀疏词袋的 0，
 * 任何查询都会返回满额候选池、把排序压平；反过来把 0.375 用在稀疏词袋上会静默砍掉大量召回。
 * 因此下限是"随嵌入器一起选"的，而不是一个全局常量。
 */
export function cosineFloorFor(embedder: Embedder): number {
  return embedder.id === BGE_EMBEDDER_ID ? BGE_COSINE_FLOOR : HASH_BOW_COSINE_FLOOR
}

/** `createVectorChannel` 的依赖。 */
export interface VectorChannelDeps {
  /** 内核句柄：通道每次检索都重新解析 `embedder` 服务（热插拔下服务可能刚被换掉）。 */
  readonly kernel: Kernel
  /** 通道级降级出口（写状态面）。**不得抛**；缺省无操作。 */
  readonly onDegraded?: (reason: string) => void
  /** 一次检索恢复正常时调用（供状态面清掉上一次的降级原因）。缺省无操作。 */
  readonly onRecovered?: () => void
  /** 覆盖余弦下限（标定用）。缺省按当前嵌入器身份选，见 `cosineFloorFor`。 */
  readonly minScore?: number
}

/**
 * 造一个可注入 `RetrievePorts.channels` 的向量通道（`name: 'vector'`）。
 *
 * 分工（**刻意很薄**）：
 * - 本函数：解析嵌入器、取得查询向量、给出**归属标签**与余弦下限，把活交给库；
 * - `MemoryStore.searchVector`：存取 + **归属过滤下推到 SQL** + 余弦打分（由 store 实现）；
 * - `retrieve.ts`：跨通道排名融合（RRF）。
 *
 * 因此这里**不算余弦、不碰 SQL、不重排**——它只把"谁来比、拿什么比、比到什么程度算命中"讲清楚。
 *
 * 绝不抛：无嵌入器 / 库未实现向量口 / 编码失败 / 维度不符 / 检索抛异常，
 * 一律返回空数组并把原因交给 `onDegraded`（检索侧还有一层 `safeSearch` 兜底）。
 * 返回空不是"降级成词法"——词法通道本来就独立在跑，这里只是"这一路没有贡献"。
 */
export function createVectorChannel(deps: VectorChannelDeps): RetrievalChannel {
  const degrade = (reason: string): readonly ScoredHit[] => {
    try {
      deps.onDegraded?.(reason)
    } catch {
      // 原因出口自己抛异常不得影响检索
    }
    return []
  }
  const recover = (): void => {
    try {
      deps.onRecovered?.()
    } catch {
      // 同上
    }
  }

  return {
    name: 'vector',
    async search(input: ChannelQuery): Promise<readonly ScoredHit[]> {
      const tagged = input?.store
      if (tagged === undefined || tagged === null) {
        return degrade('检索请求缺少库句柄（TaggedStore）')
      }
      const store = tagged.store
      if (store === undefined || store === null) {
        return degrade(`库 ${String(tagged.scope)} 的 store 句柄缺失`)
      }
      // 结构面检查：旧的/替身的 store 没有向量口时降级，而不是抛 TypeError
      if (typeof store.searchVector !== 'function') {
        return degrade(`库 ${String(tagged.scope)} 未实现 searchVector（存储层与向量通道版本不一致）`)
      }

      const embedder = deps.kernel.service<Embedder>(EMBEDDER_SERVICE)
      if (embedder === undefined) {
        return degrade('嵌入器服务不可用（omb-memory-vector 已关闭或尚未启动）')
      }

      // 查询向量优先用检索侧预算好的那份（`RetrievePorts.embedder` 已经算过一次，不重复算）
      let embedding = input.embedding
      if (!(embedding instanceof Float32Array)) {
        try {
          const vectors = await embedder.embed([input.text])
          embedding = vectors[0]
        } catch (error) {
          return degrade(`嵌入器 ${embedder.id} 编码失败：${messageOf(error)}`)
        }
        if (!(embedding instanceof Float32Array)) {
          return degrade(`嵌入器 ${embedder.id} 未返回查询向量`)
        }
      }
      if (embedding.length !== embedder.dimensions) {
        // 例：门面在两次调用之间从 256 维哈希词袋升级成 512 维 BGE。跨空间比距离毫无意义。
        return degrade(
          `查询向量 ${embedding.length} 维与当前嵌入器 ${embedder.id}（${embedder.dimensions} 维）不符`,
        )
      }

      const expect: VectorAttribution = {
        modelId: embedder.id,
        dim: embedder.dimensions,
        revision: embedder.revision,
      }
      try {
        const hits = await store.searchVector({
          embedding,
          expect,
          ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
          limit: input.limit,
          minScore: deps.minScore ?? cosineFloorFor(embedder),
        })
        if (hits === undefined || hits === null) {
          return degrade('库返回了空句柄的向量检索结果')
        }
        recover()
        return hits
      } catch (error) {
        return degrade(`库 ${String(tagged.scope)} 向量检索失败：${messageOf(error)}`)
      }
    },
  }
}

/** 把通道状态渲染成健康面。**detail 永远写明当前通道**，降级必须带原因。 */
function baseHealth(
  state: VectorChannelState,
  current: Embedder | undefined,
  enc: VectorEncoderStats,
): ModuleHealth {
  const metrics = channelMetrics(state, current, enc)

  if (state.channel === 'onnx') {
    return { state: 'ok', detail: `向量通道：${channelLabel(state, current)}`, metrics }
  }
  if (state.channel === 'off') {
    if (state.reason !== null) {
      return {
        state: 'degraded',
        detail: `向量通道未启动：${state.reason}（检索仍为完整纯词法路径）`,
        metrics,
      }
    }
    return {
      state: 'ok',
      detail: '向量通道已关闭（模块已卸载）：检索退化为完整纯词法路径，无残留状态',
      metrics,
    }
  }
  if (state.probing) {
    return {
      state: 'ok',
      detail: `向量通道：${channelLabel(state, current)}；权重目录 ${state.modelDir ?? '未知'}`,
      metrics,
    }
  }
  if (state.reason !== null) {
    return {
      state: 'degraded',
      detail: `向量通道：${channelLabel(state, current)}；降级原因：${state.reason}`,
      metrics,
    }
  }
  return {
    state: 'ok',
    detail: `向量通道：${channelLabel(state, current)}（未尝试 ONNX：配置未给出模型目录，且默认位置不存在）`,
    metrics,
  }
}

/**
 * 健康面 = 装载期状态（`baseHealth`）+ **检索期**降级 + **落盘期**读数 + **回填期**读数。
 *
 * 三类运行期问题都必须显式呈现（而不是被"通道可用"盖住）：
 * ① 通道选型正常但某次检索返回空（语义召回实际没发生）；
 * ② 待编码队列积压或被拒（记忆写进去了却没有向量 → `searchVector` 结构上查不到）；
 * ③ **问得出多少条记忆在当前嵌入器下没有向量**（换嵌入器之后的存量失效——
 *    这是"检索不报错但什么都搜不到"的根源，必须是一个可读数字而不是一片沉默）。
 */
function renderHealth(
  state: VectorChannelState,
  current: Embedder | undefined,
  enc: VectorEncoderStats,
): ModuleHealth {
  const base = baseHealth(state, current, enc)
  const notes: string[] = []
  let degraded = false
  if (state.lastSearchError !== null) {
    notes.push(`最近一次向量检索降级：${state.lastSearchError}`)
    degraded = true
  }
  if (enc.lastReason !== null) {
    notes.push(`向量落盘：${enc.lastReason}`)
    degraded = true
  }
  if (enc.pending > 0) notes.push(`待编码 ${enc.pending} 条（回合边界由 dsh 冲刷）`)
  const rb = enc.rebuild
  if (rb.stale !== null && rb.stale > 0) {
    // 两类原因分开写：把"换了模型"与"有人改写了正文"说成同一件事，
    // 使用者就没有任何线索去查后者的来源（而它才是"检索结果莫名其妙"的那种）。
    // 时态同样分开：原因之和 ≠ stale 时它描述的是**基准那一刻**，不许写成现在时（见 causesDescribeCurrent）。
    const causes = causeText(rb.causes)
    const causePart =
      causes === ''
        ? ''
        : causesDescribeCurrent(rb)
          ? `；当前原因拆分：${causes}`
          : `；上一轮实测的积压构成（基准 ${rb.staleBase ?? '?'} 条、已处理 ${
              rb.staleBase === null ? '?' : rb.staleBase - rb.stale
            } 条，与剩余量不是同一时刻）：${causes}`
    notes.push(
      `陈旧待重建 ${rb.stale} 条（这些记忆在当前嵌入器下要么没有向量、要么向量编码的是旧正文；` +
        `${rb.staleFromScan ? '本回合在库上实测' : '本轮回填记账'}${causePart}）`,
    )
    if (rb.blocked !== null) {
      // 待办还在、而回填**停着**：那是一个会一直存在的状态，健康面不能报"正常"
      notes.push(`回填停住：${rb.blocked}`)
      degraded = true
    }
  } else if (rb.stale === null && rb.blocked !== null) {
    // 测不出来 ≠ 没有问题：原因照写，但不据此判降级（那是拿没测到的东西下结论）
    notes.push(`回填未测量：${rb.blocked}`)
  }
  if (notes.length === 0) return base
  return {
    state: base.state === 'failed' ? 'failed' : degraded ? 'degraded' : base.state,
    detail: `${base.detail}；${notes.join('；')}`,
    metrics: base.metrics,
  }
}
/**
 * 状态面段落。**多行、可读、含原因**——`omb_status` 会原样拼接。
 * 为什么需要它：内核 `start()` 在 `apply` 之后会写入一句通用的"模块已启动"，
 * 那会盖掉模块自己的 `report`；状态面登记处才是降级原因稳定的可见位置。
 */
function renderStatus(
  state: VectorChannelState,
  current: Embedder | undefined,
  enc: VectorEncoderStats,
): string {
  const lines = [`通道：${channelLabel(state, current)}`]
  lines.push(
    `当前嵌入器：${
      current === undefined
        ? '未注册'
        : `${current.id}（${current.dimensions} 维，revision ${current.revision}）`
    }`,
  )
  lines.push(`装载期降级原因：${state.reason === null ? '无' : state.reason}`)
  if (state.modelDir !== null) lines.push(`权重目录：${state.modelDir}`)
  // **未测量 ≠ 测量为零**：一次检索都没发生过时，只能报"尚未发生（无读数）"，
  // 不能写成"正常"——那会把"没接线/没走过这条路"冒充成"走过且没问题"。
  const lastSearch =
    state.searches === 0
      ? '尚未发生（无读数：本进程还没有观测到一次向量检索）'
      : state.lastSearchError === null
        ? '正常'
        : `降级（${state.lastSearchError}）`
  lines.push(`最近一次检索：${lastSearch}；已观测检索 ${state.searches} 次；累计降级 ${state.channelErrors} 次`)
  lines.push(
    `向量落盘：待编码 ${enc.pending} 条；已编码 ${enc.encoded}；跳过 ${enc.skipped}；` +
      `失败 ${enc.failures}（其中被拒 ${enc.rejected}）；超界丢弃 ${enc.dropped}`,
  )
  // 回填读数：**"尚未测量"与"0 条"必须看着不一样**（前者是本进程还没统计过，后者是统计过且确实没有）；
  // 同样，"刚刚重算的 0"与"上轮统计后的记账值"也要看着不一样——否则同一个 0 会同时意味着两件事。
  // 换嵌入器之后这块数字就是"向量通道对多少条记忆是空的"，是缺陷 A 唯一可见的形态。
  const rb = enc.rebuild
  const base = rb.staleBase
  const staleText =
    rb.stale === null
      ? '尚未测量（本进程还没有完成一次回填统计）'
      : rb.staleFromScan
        ? `${rb.stale} 条（本回合在库上实测）`
        : rb.stale === 0
          ? base === 0
            ? '0 条（已对齐：本周期实测基准 0 条，此后未再扫库；嵌入器身份未变）'
            : `0 条（已对齐：实测基准 ${base ?? '?'} 条已全部补齐/回收，此后嵌入器身份未变）`
          : `${rb.stale} 条（本轮回填记账：实测基准 ${base ?? '?'} 减去已完成的量）`
  lines.push(
    `向量回填：待重建 ${staleText}；已重建 ${rb.rebuilt}；失败 ${rb.failures}；回收残留 ${rb.scavenged} 行`,
  )
  // 原因拆分行**只在测到原因时出现**（未测量时不写，免得"0 条"与"没测过"看着一样）。
  // 这一行是缺陷 B 唯一的可见位置：正文被改写时向量通道不会报错，只是悄悄继续用旧向量。
  //
  // **时态必须与 stale 一致**（总纲判据）：两类原因之和 = stale 时才是"当前待办的原因"；
  // 一旦补齐/回收过，那份原因快照说的就是基准那一刻的构成，必须写成过去时并点名基准——
  // 否则同一个 0 会同时被说成"没有待办"和"还有 12 条"（用户真机复现过的自相矛盾）。
  const causes = causeText(rb.causes)
  if (causes !== '') {
    lines.push(
      causesDescribeCurrent(rb)
        ? `待重建原因：${causes}`
        : `上一轮实测的积压构成（实测基准 ${base ?? '?'} 条、已处理 ${
            base === null || rb.stale === null ? '?' : base - rb.stale
          } 条，**不是当前待办**）：${causes}`,
    )
  }
  if (rb.blocked !== null) lines.push(`回填停住：${rb.blocked}`)
  if (enc.lastReason !== null) lines.push(`落盘最近原因：${enc.lastReason}`)
  if (current !== undefined) lines.push(`余弦下限：${cosineFloorFor(current)}（按当前嵌入器标定）`)
  lines.push(`损坏 BLOB（解码失败计数）：${blobDecodeFailureCount()}`)
  return lines.join('\n')
}

/** 一个向量通道模块实例（生产只有一个；测试用工厂拿隔离实例）。 */
export interface VectorModuleInstance {
  readonly manifest: VectorManifest
  readonly registration: ModuleRegistration<VectorConfig>
  /** 同步注册嵌入器服务与状态面贡献；@returns disposer（幂等，**绝不抛**）。 */
  apply(kernel: Kernel, config?: unknown): () => void
  /** 当前通道状态（不依赖 kernel，便于状态面与测试）。 */
  state(): VectorChannelState
  /** 当前已注册的嵌入器（未启动 → undefined）。 */
  embedder(): Embedder | undefined
  /**
   * 造一个向量通道；**检索期**降级会写进本实例的状态与健康面。
   *
   * 注入方式：`retrieve(stores, query, { clock, embedder, channels: [instance.channel(kernel)] })`。
   */
  channel(kernel: Kernel, options?: { readonly minScore?: number }): RetrievalChannel
  /** 已注册的编码队列（未启动 → undefined）。`dsh/` 在回合边界调它的 `encodePending()`。 */
  encoder(): VectorEncoder | undefined
}

/**
 * 本模块的清单：`health()` 收窄为**同步**返回值。
 *
 * 这不是形式主义：本模块的健康检查只读内存状态（通道 + 原因 + 损坏计数），**零 I/O**，
 * 因此类型上就不该允许异步——状态面渲染时不必担心"健康检查本身在等一个网络/文件"。
 */
export interface VectorManifest extends ModuleManifest<VectorConfig> {
  health(): ModuleHealth
}

/**
 * 造一个隔离的模块实例。
 *
 * 生产用模块级单例 `vectorModule`；测试用本工厂（可注入 `loadOnnx`），
 * 避免实例间通过模块级状态互相影响，也避免测试真的去加载 ONNX 权重。
 */
export function createVectorModule(deps: VectorModuleDeps = {}): VectorModuleInstance {
  const loadOnnx: OnnxLoader = deps.loadOnnx ?? loadOnnxEmbedder
  const resolveStoreSets: StoreSetResolver = deps.resolveStoreSets ?? defaultResolveStoreSets

  let state: VectorChannelState = {
    channel: 'off',
    probing: false,
    modelDir: null,
    reason: '模块尚未启动（apply 未被调用）',
    lastSearchError: null,
    channelErrors: 0,
    searches: 0,
  }
  let installed: SwitchableEmbedder | undefined
  /** apply 装上的健康上报出口；通道的**检索期**降级也要经它上报。 */
  let reportHealth: (() => void) | undefined

  // ── 向量落盘：待编码队列 ────────────────────────────────────────────────────
  // `memory/written` 回调里**只入队**；编码在 `encodePending()` 里批量做。
  // 为什么不在回调里编码：嵌入是一次真实推理（ONNX 毫秒级，且原生绑定阻塞事件循环），
  // 把它压进写入路径会让每次记忆写入都变慢——而写入路径的正确性并不依赖向量。
  /** 队列：`Map` 保序 + 去重；值 = 来源（事件声明的作用域或"待重建"及其来源库）。 */
  const queue = new Map<string, PendingEntry>()
  let maxPending = DEFAULT_MAX_PENDING
  let maxBackfill = DEFAULT_MAX_BACKFILL
  let allowFallbackRebuild = false
  let droppedOldest = 0
  let encodedTotal = 0
  let skippedTotal = 0
  let failureTotal = 0
  let rejectedTotal = 0
  let lastEncodeReason: string | null = null
  // ── 陈旧回填读数（"还有多少条待重建 / 补回多少 / 失败多少 / 为什么停住"） ──
  let rebuiltTotal = 0
  let rebuildFailureTotal = 0
  let scavengedTotal = 0
  /**
   * 回填的**周期记账**：周期开始时的实测基准 + 本周期已从"待重建"里移除的条数。
   *
   * 为什么不每回合都去库上重算"待重建多少条"：那个查询要在整表上逐行判定归属，
   * 而 `embedding` 行的负载是 1~2KB 的向量 BLOB——实测 1 万条 ≈ 200~400ms，且随库线性增长。
   * 每回合都跑一次，等于给会话挂上一个随记忆增长的常数；而**回填是后台增益，不该有这个代价**。
   *
   * 记账是精确的：重建成功让那条记忆多了一条当前身份的行（待重建 −1），
   * 回收把没有正文的残留行删掉（待重建 −1），失败不减（它仍然是待重建）。
   * 于是"基准 − 已完成"就是此刻库里的待重建条数，归零即**对齐**（此后不再碰库）。
   * 身份一变（换模型/换维度/换修订）整个集合就变了 → 基准作废，下回合重新实测。
   * 唯一测不到的情形是**别的进程**在同一时间改这个库：那会在下一次身份变化或重启时被重新实测纠正
   * （本进程的回填不会因此写错东西，只是读数需要一次重测）。
   *
   * ⚠️ **内容哈希那一类（缺陷 B）不在这本账里**：正文改写发生在库的写入侧，本进程看不见，
   * 因此它不会让基准失效。代价是"正文被改写"要等到下一轮实测（重启/换身份）才被发现——
   * 而单条被改写的记忆，只要它走了写入通路（`memory/written` → 编码），新向量会带着新哈希落盘，
   * 顺手把那一类就地修好。真正的兜底是下一轮实测，方向是**多测一次**而不是漏判。
   */
  let staleBase: number | null = null
  let staleDone = 0
  /**
   * 基准那一刻的**原因拆分**（`缺当前身份` / `正文已改写`）。
   *
   * 只在实测那一回合更新（与 `staleBase` 同源、同一次 SQL），此后保持不变：
   * 它回答的是"这个积压长什么样"，而 `stale` 回答的是"还剩多少"。两者口径不同，
   * 所以不做"基准减已完成"的推算——那会把两类混成一个无法拆分的数。
   */
  let staleCauses: StaleEmbeddingCauses = { lackingIdentity: null, contentChanged: null }
  /** 本回合是否真的在库上重算过基准（`staleFromScan` 的来源；不参与记账）。 */
  let staleFromScan = false
  let rebuildBlocked: string | null = null
  /** 回填游标：库身份（库文件路径）→ 上次扫到的 `memory_id`（键集分页，避免整表入内存）。 */
  const rebuildCursors = new Map<string, string>()
  /** 游标与基准对应的嵌入器身份；身份一变（换模型/换修订/换维度）两者一起作废。 */
  let rebuildCursorIdentity: string | null = null
  /** 冲刷重入闸：两次冲刷并行会让"已重建"翻倍计数、同一条被编码两次（读数因此说谎）。 */
  let flushing = false
  /** apply 装上的内核句柄（冲刷时解析嵌入器与库）；卸载后置空。 */
  let kernelRef: Kernel | undefined
  let installedEncoder: VectorEncoder | undefined

  const health = (): ModuleHealth => renderHealth(state, installed, encoderStats())

  /** 本轮的待重建读数：未测过 → null（**不是零**）；否则 = 实测基准 − 已完成。 */
  const staleRemaining = (): number | null =>
    staleBase === null ? null : Math.max(0, staleBase - staleDone)

  const encoderStats = (): VectorEncoderStats => ({
    pending: queue.size,
    encoded: encodedTotal,
    skipped: skippedTotal,
    failures: failureTotal,
    dropped: droppedOldest,
    rejected: rejectedTotal,
    lastReason: lastEncodeReason,
    rebuild: {
      stale: staleRemaining(),
      causes: staleCauses,
      staleBase,
      staleFromScan,
      rebuilt: rebuiltTotal,
      failures: rebuildFailureTotal,
      scavenged: scavengedTotal,
      blocked: rebuildBlocked,
    },
  })

  const isMemoryScope = (value: string): value is MemoryScope =>
    (MEMORY_SCOPES as readonly string[]).includes(value)

  /**
   * 入队那一刻，该作用域下**已打开的库身份**有哪些。
   *
   * 新写入必然落在其中之一，所以"这些库都查过、都没有"才是"已删除"的证据；
   * 少查一个就判删除，等于把"我没看"说成"它不存在"（M7）。
   * 拿不到库清单时返回 `null`（= 不知道），调用方据此退回按作用域名判定而不是乱判。
   */
  const candidateKeysFor = (scope: MemoryScope | null): readonly string[] | null => {
    const kernel = kernelRef
    if (kernel === undefined) return null
    try {
      const sets = resolveStoreSets(kernel)
      if (sets.length === 0) return null
      const keys: string[] = []
      for (const set of sets) {
        for (const wanted of scope === null ? MEMORY_SCOPES : [scope]) {
          const target = set.store(wanted)
          if (target === undefined) continue
          const key = storeKeyOf(set, wanted, target)
          if (!keys.includes(key)) keys.push(key)
        }
      }
      // 空清单 = 一个库都没打开 → 与"拿不到清单"同义（都不知道），不当作"它不可能在别处"
      return keys.length === 0 ? null : keys
    } catch {
      // 库清单不可得：退回按作用域名判定（旧口径），原因里会写清是哪个库没查过
      return null
    }
  }

  /**
   * 新写入入队（去重、保序、超界丢最旧并计数）。
   * **纯内存操作**：不做 I/O、不编码——这是"写入路径不变慢"的全部机制。
   *
   * 唯一新增的代价是 `resolveStoreSets()`（一次 `snapshot()`，无 I/O）：它记下
   * "这条可能落在哪些已打开的库"，供冲刷时按**库身份**判"已删除"（见 `PendingEntry`）。
   * 记忆写入是低频操作（每条一次 INSERT），这一次快照远小于写入本身的代价。
   */
  const enqueueWritten = (payload: { readonly id: string; readonly scope: string }): void => {
    const id = payload.id
    if (typeof id !== 'string' || id.length === 0) return
    if (queue.has(id)) return
    while (queue.size >= maxPending) {
      const oldest = queue.keys().next().value
      if (oldest === undefined) break
      queue.delete(oldest)
      droppedOldest += 1
    }
    const scope = isMemoryScope(payload.scope) ? payload.scope : null
    queue.set(id, { scope, rebuildFrom: null, candidateKeys: candidateKeysFor(scope) })
  }

  /**
   * 回填条目入队：**绝不挤掉待落盘的写入**。
   *
   * 与 `enqueueWritten` 的关键差别是超界时**放弃入队**而不是丢最旧：
   * 队列里最旧的那些是"记忆写进去了却还没有向量"的待办，丢掉它们没有第二次机会
   * （没有任何地方会重新入队）；而回填条目丢了毫无损失——向量行仍是待重建的，
   * 下一遍扫描会重新列出（幂等、可重入正是靠这个性质）。
   */
  const enqueueRebuild = (id: string, ref: VectorStoreRef): boolean => {
    if (typeof id !== 'string' || id.length === 0) return false
    if (queue.has(id)) return false
    if (queue.size >= maxPending) return false
    // 库身份精确到**列出它的那个库**：回填条目的候选库只有它自己，
    // 因此它被回收/关闭时不会被"另一个 project 库开着"掩盖成已删除（M7）。
    queue.set(id, { scope: ref.scope, rebuildFrom: ref.api, candidateKeys: [ref.key] })
    return true
  }

  /**
   * 把各库声明的嵌入器归属切到当前身份（幂等：已一致时一个字节都不写）。
   *
   * 调用点只有一处：**本批编码成功之后、落盘之前**（见 `flushQueue` 的 ③.5）。
   * 库侧 `setEmbeddingMeta` 会数出因此成为待重建的条数并记日志（`store.ts:704`），
   * 那是切换的唯一记录点，这里不重复报一遍。
   *
   * 失败不致命：单条落盘会照常被拒并计数（原因可读），**绝不吞、也绝不抛**——
   * 切换是后台增益的前置条件，不该让一次冲刷整体失败。
   */
  const alignEmbeddingMeta = async (
    apis: readonly VectorStoreApi[],
    embedder: Embedder,
  ): Promise<void> => {
    const current: EmbeddingMeta = {
      modelId: embedder.id,
      dim: embedder.dimensions,
      revision: embedder.revision,
    }
    const seen = new Set<VectorStoreApi>()
    for (const api of apis) {
      if (seen.has(api)) continue
      seen.add(api)
      try {
        const meta = await api.embeddingMeta()
        // 未声明（meta 行缺失/为空）：首次落盘会自行声明身份，这里不必也不能代劳
        if (meta === null) continue
        // 复用 `embed.ts` 的兼容判定：三个字段（dim/model/revision）的**同一个**真源，
        // 免得"什么算同一个向量空间"在这里再写一遍、并且写得不一样
        const compat = checkEmbedderCompat(meta, embedder)
        if (compat.ok) continue
        await api.setEmbeddingMeta(current)
      } catch (error) {
        lastEncodeReason = `切换嵌入器归属失败（${messageOf(error)}）——本批按原归属落盘，原因见库侧拒绝`
      }
    }
  }

  /**
   * 批量冲刷待编码队列：`getMany`（每库一次）→ `embed`（**一次**，N 条不是 N 次）→ 逐条落盘。
   *
   * 队列里可能是两种条目：新写入（`memory/written`）与**待重建**（陈旧回填），两者的编码通路
   * 完全一样——这正是"复用既有批处理通路"的含义（另起一套并发编码必然与这一套漂移）。
   *
   * 归属标签取当前嵌入器身份，库侧会拒绝不符的写入（D2：写入时拒绝无法归属的向量）。
   * 绝不抛：整批失败给 `reason` 且**保留队列**；单条被库拒绝则出队并计数（重试不会成功）。
   */
  const flushQueue = async (limit?: number): Promise<VectorEncodeOutcome> => {
    const kernel = kernelRef
    const nothing = (reason?: string): VectorEncodeOutcome => ({
      encoded: 0,
      skipped: 0,
      failures: 0,
      ...(reason !== undefined ? { reason } : {}),
    })
    if (kernel === undefined) return nothing('模块未启动或已关闭（无内核句柄）；待编码队列保留')
    if (queue.size === 0) return nothing()
    /** 本次调用内产生的可读原因（进 `outcome.reason`）；与跨调用的 `lastEncodeReason` 分开。 */
    let callReason: string | null = null

    const embedder = kernel.service<Embedder>(EMBEDDER_SERVICE)
    if (embedder === undefined) {
      return nothing('嵌入器服务不可用（omb-memory-vector 未启动）；待编码队列保留')
    }
    const currentIdentity: EmbeddingMeta = {
      modelId: embedder.id,
      dim: embedder.dimensions,
      revision: embedder.revision,
    }
    const sets = resolveStoreSets(kernel)
    if (sets.length === 0) {
      return nothing('记忆库未就绪（stores.snapshot() 没有可用库）；待编码队列保留')
    }

    const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit as number)) : queue.size
    const batch = [...queue.entries()].slice(0, cap)

    // ① 批量水合：每个（库套件 × 作用域）一次 `getMany`——禁 N+1
    const found = new Map<string, { record: MemoryRecord; api: VectorStoreApi | undefined }>()
    /** 本次真正检查过的作用域。**没被检查 ≠ 记录已删除**：项目库可能尚未预热。 */
    const coveredScopes = new Set<MemoryScope>()
    /**
     * 本次真正检查过的**库身份**（`storeKeyOf` 的键）。
     *
     * 判"这条已删除"只能靠它：作用域名只有 `user`/`project` 两个值，
     * "另一个项目库开着"会让被淘汰的那个库里的待编码条目被误判成已删除（M7）。
     */
    const openKeys = new Set<string>()
    let vectorCapable = false
    let hydrateError: string | null = null
    for (const set of sets) {
      for (const scope of MEMORY_SCOPES) {
        const target = set.store(scope)
        if (target === undefined) continue
        // 覆盖与能力是**库的属性**，与本批是否有该作用域的候选无关：
        // 先判定，再决定要不要 getMany（否则"项目库还没打开"会被误判成"库不支持向量"）。
        coveredScopes.add(scope)
        openKeys.add(storeKeyOf(set, scope, target))
        const api = asVectorStore(target)
        if (api !== undefined) vectorCapable = true
        const ids = batch
          .filter(
            ([id, entry]) =>
              !found.has(id) && (entry.scope === null || entry.scope === scope),
          )
          .map(([id]) => id)
        if (ids.length === 0) continue
        try {
          for (const record of await target.getMany(ids)) {
            found.set(record.id, { record, api })
          }
        } catch (error) {
          hydrateError = `读取记忆文本失败（${messageOf(error)}）`
        }
      }
    }
    /** 作用域未被任何已打开库覆盖的待编码条目（项目库尚未预热）→ **保留队列**，下次再试。 */
    const uncoveredScopes = (): readonly MemoryScope[] => [
      ...new Set(
        batch
          .map(([, entry]) => entry.scope)
          .filter((scope): scope is MemoryScope => scope !== null && !coveredScopes.has(scope)),
      ),
    ]

    /**
     * 这条"查不到"的记录，是否还有**库没被查到**？返回可读原因（`null` = 可以判"已删除"）。
     *
     * 判据（M7）：**只有它可能所在的库全部被本次冲刷真正查询过，才能说它是已删除**。
     * 按作用域名判会让"另一个项目库开着"冒充"它所在的库开着"：属于被淘汰库的条目
     * 会被出队并计入 `skipped`——读数上表现为"跳过"，而它其实还在库里等着编码。
     *
     * 入队时拿不到库清单（`candidateKeys === null`）时退回按作用域名判定（旧口径）：
     * 那种情况下"它可能在哪"本来就没有记录，假装知道会更坏。
     */
    const coverageGapOf = (entry: PendingEntry | undefined): string | null => {
      const candidates = entry?.candidateKeys ?? null
      if (candidates === null || candidates.length === 0) {
        const scope = entry?.scope ?? null
        // 作用域也未知：整批已按两个作用域都查过（每个已打开库都问过）→ 沿用旧口径
        if (scope === null) return null
        return coveredScopes.has(scope) ? null : `${scopeLabel(scope)}尚未打开`
      }
      const missing = candidates.filter(key => !openKeys.has(key))
      return missing.length === 0 ? null : `${missing.join('、')}尚未打开`
    }

    /**
     * 回填条目"正文已不存在"的登记与回收。
     *
     * 为什么必须回收而不是留在表里：待重建的判定是"当前身份下没有向量的记忆"
     * （`store.ts` 的 `countStaleEmbeddings`），没有正文的行永远重建不出来——
     * 留着它们，同一批 id 会每轮被重新列出、重新入队、再被跳过：待办数永远不清零，
     * 真正的积压反而看不见（读数变成噪音）。
     * 只删**非当前身份**的行（`deleteStaleEmbeddings` 的谓词），因此绝不会删掉刚写好的新向量。
     * 先登记、循环结束后**按库一次删完**（与读取侧同一条规矩：禁 N+1）。
     */
    const goneByStore = new Map<VectorStoreApi, string[]>()
    const markGone = (api: VectorStoreApi, id: string): void => {
      const ids = goneByStore.get(api)
      if (ids === undefined) goneByStore.set(api, [id])
      else ids.push(id)
    }
    const scavengeGone = async (): Promise<void> => {
      for (const [api, ids] of goneByStore) {
        try {
          scavengedTotal += await api.deleteStaleEmbeddings(ids, currentIdentity)
          // 记账：这些 id 不再"在当前身份下缺向量"（回收按**条**算，不按删掉的行数）
          staleDone += ids.length
        } catch (error) {
          // 回收失败 → 这些 id 会一直被列为待重建：计数一次失败，别让它们静默地烂在那里
          rebuildFailureTotal += 1
          lastEncodeReason =
            `回收残留向量失败（${ids.length} 条）：${messageOf(error)}；它们会一直被列为待重建`
        }
      }
      goneByStore.clear()
    }

    if (found.size === 0) {
      if (hydrateError !== null) return nothing(`${hydrateError}；待编码队列保留`)
      if (!vectorCapable) return nothing('库不支持向量写入（asVectorStore 未命中）；待编码队列保留')
      const pendingScopes = uncoveredScopes()
      if (pendingScopes.length > 0) {
        return nothing(
          `库尚未就绪（${pendingScopes.map(scopeLabel).join('、')}作用域的库还没打开）；待编码队列保留`,
        )
      }
      /**
       * 作用域名层面都覆盖了，但**库身份**层面未必（M7）：逐条核对，
       * 只有"它可能所在的库都查过、都没有"的那些才是真的已删除。
       * 整批无差别出队会把被淘汰库里的待办静默丢掉（读数上只表现为 skipped 变大）。
       */
      let goneCount = 0
      let firstGap: string | null = null
      for (const [id, entry] of batch) {
        const gap = coverageGapOf(entry)
        if (gap !== null) {
          firstGap ??= gap
          continue
        }
        queue.delete(id)
        if (entry.rebuildFrom !== null) markGone(entry.rebuildFrom, id)
        goneCount += 1
      }
      await scavengeGone()
      skippedTotal += goneCount
      if (goneCount < batch.length) {
        const retained = batch.length - goneCount
        const reason = `库尚未就绪（${firstGap ?? '库身份未能核对'}）；${retained} 条未确认的待编码条目保留队列`
        lastEncodeReason = reason
        return { encoded: 0, skipped: goneCount, failures: 0, reason }
      }
      return { encoded: 0, skipped: goneCount, failures: 0 }
    }

    // ② 分类：空文本 / 无向量口 → 跳过；其余待编码
    const encodable: {
      id: string
      text: string
      api: VectorStoreApi
      rebuild: boolean
      /** 这条向量即将编码的正文的哈希（落盘时一并写入，见 `putEmbedding` 的 `contentHash`）。 */
      contentHash: string
    }[] = []
    let skipped = 0
    for (const [id, entry] of batch) {
      const hit = found.get(id)
      if (hit === undefined) {
        const gap = coverageGapOf(entry)
        if (gap !== null) {
          // 它可能所在的库这次没被查询（例如项目库被 LRU 淘汰、尚未预热）→ 不是"已删除"，保留重试
          callReason = `库尚未就绪（${gap}）；待编码队列保留`
          lastEncodeReason = callReason
          continue
        }
        queue.delete(id) // 库里确实没有这条（已删除）
        skipped += 1
        // 正文没了 → 残留向量行没有消费者（换回原嵌入器也搜不出东西：检索要 JOIN memory）
        if (entry.rebuildFrom !== null) markGone(entry.rebuildFrom, id)
        continue
      }
      if (hit.record.text.trim().length === 0) {
        queue.delete(id) // 空文本没有可编码的内容（上面就是这个既定语义）
        skipped += 1
        // 同一个判定对回填条目也成立：这条正文**永远不会有**当前身份的向量，
        // 留着它只会让"待重建"永远挂在计数里 —— 回收它。
        if (entry.rebuildFrom !== null) markGone(entry.rebuildFrom, id)
        continue
      }
      if (hit.api === undefined) {
        // 该条所在的库没有向量口（同套件的另一个库有）：跳过并留原因，不无限重试
        queue.delete(id)
        skipped += 1
        callReason = `库不支持向量写入，已跳过 ${id}（asVectorStore 未命中）`
        lastEncodeReason = callReason
        continue
      }
      encodable.push({
        id,
        text: hit.record.text,
        contentHash: hit.record.contentHash,
        api: hit.api,
        rebuild: entry.rebuildFrom !== null,
      })
    }
    await scavengeGone()

    // ③ 一次批编码（N 条 → 一次 embed）
    let vectors: readonly Float32Array[] = []
    if (encodable.length > 0) {
      try {
        vectors = await embedder.embed(encodable.map((entry) => entry.text))
      } catch (error) {
        failureTotal += encodable.length
        rebuildFailureTotal += encodable.filter((entry) => entry.rebuild).length
        lastEncodeReason = `编码失败（${messageOf(error)}）；待编码队列保留`
        reportHealth?.()
        return { encoded: 0, skipped, failures: encodable.length, reason: lastEncodeReason }
      }
      if (vectors.length !== encodable.length) {
        failureTotal += encodable.length
        rebuildFailureTotal += encodable.filter((entry) => entry.rebuild).length
        lastEncodeReason =
          `嵌入器 ${embedder.id} 返回 ${vectors.length} 条向量、期望 ${encodable.length} 条；` +
          '待编码队列保留'
        reportHealth?.()
        return { encoded: 0, skipped, failures: encodable.length, reason: lastEncodeReason }
      }

      /**
       * ③.5 **身份对齐**：编码成功之后、落盘之前，把各库的嵌入器归属切到当前身份。
       *
       * 为什么必须正好在这个位置（三个约束同时成立）：
       * ① 不切 → `putEmbedding` 会拒绝与 `meta` 不符的向量（`store.ts:688`），整批被判"被拒"出队，
       *    等于把待办**静默丢掉**（`store.ts:691` 那句"换模型请先 setEmbeddingMeta 并重建"就是这个坑：
       *    在此之前全仓没有任何地方调用 `setEmbeddingMeta`）；
       * ② 切早了（编码之前）→ 嵌入器其实算不出来时也把库里的旧向量标成陈旧，
       *    向量通道对旧记忆静默返回空——那正是本次要修的缺陷，不能用一个新缺陷去修它；
       * ③ 切晚了（落盘之后）→ 这一批已经被拒了。
       * 于是"**本批编码成功**"本身就是"当前嵌入器真的能用"的证据，切换以它为条件。
       *
       * 还多一道**维度自检**：嵌入器说谎（输出长度 ≠ 声明的 `dimensions`）时同样不切——
       * 那些向量会被库逐条拒绝（`store.ts:458`），而归属一旦切了，库里的旧向量就白白不再参与检索。
       * 宁可这一批失败（队列保留、原因由库的拒绝给出），也不要制造"切了却写不进去"的空窗。
       *
       * 通道不可信时（探测中 / 降级路径）一律不切：理由见 `rebuildStopReason`。
       */
      const dimensionsAgree = vectors.every(
        vector => vector instanceof Float32Array && vector.length === embedder.dimensions,
      )
      if (dimensionsAgree && rebuildStopReason() === null) {
        await alignEmbeddingMeta(encodable.map((entry) => entry.api), embedder)
      }
    }

    // ④ 逐条落盘（归属标签 = 当前嵌入器身份）
    let encoded = 0
    let rebuilt = 0
    let failures = 0
    for (let i = 0; i < encodable.length; i++) {
      const entry = encodable[i]
      const vector = vectors[i]
      if (entry === undefined || vector === undefined) {
        failures += 1 // 长度已校验过，走到这里说明有 bug：计数并保留队列（下次再试）
        continue
      }
      try {
        await entry.api.putEmbedding({
          memoryId: entry.id,
          modelId: embedder.id,
          dim: embedder.dimensions,
          revision: embedder.revision,
          vector,
          // **这条向量编码的是哪份正文**：取刚刚水合到的那份记录的 `contentHash`。
          // 与归属标签同等重要——正文改写而嵌入器没换时，只有它能让旧向量被认出来
          // （`store.ts` 的 `STALE_WHERE_SQL` 比的就是这一列与 `memory.content_hash`）。
          // 库侧仍会以自己那列为准（不认识的调用方给错值时不会被写坏）。
          contentHash: entry.contentHash,
        })
        queue.delete(entry.id)
        encoded += 1
        if (entry.rebuild) {
          rebuilt += 1
          // 记账：这条记忆从此有了当前身份的行（见 `staleBase` 的说明）
          staleDone += 1
        }
      } catch (error) {
        // 单条被库拒绝（归属不符 / 维度不符）→ 重试不会成功：出队并计数，原因留在状态面
        queue.delete(entry.id)
        failures += 1
        rejectedTotal += 1
        // 回填条目被拒**不等于待办丢了**：那条记忆仍是"当前身份下没有向量"，
        // 下一遍扫描会重新列出（键集游标扫到表尾就回头）。绝不把它写进"已重建"。
        if (entry.rebuild) rebuildFailureTotal += 1
        callReason = `向量写入被拒（${entry.id}）：${messageOf(error)}`
        lastEncodeReason = callReason
      }
    }
    encodedTotal += encoded
    rebuiltTotal += rebuilt
    skippedTotal += skipped
    failureTotal += failures
    if (failures === 0 && callReason === null) lastEncodeReason = null // 本批干净 → 清掉上一次的原因
    reportHealth?.()
    return {
      encoded,
      skipped,
      failures,
      ...(callReason !== null ? { reason: callReason } : {}),
    }
  }

  /**
   * 回填停住的原因（`null` = 可以回填）。**每个分支都要说得出为什么**（无空降级）。
   *
   * 两条与本次机制直接相关的约束，都在这里：
   * - `probing`：ONNX 还在装载，此刻的身份（哈希词袋）**随时会被换掉**，
   *   这时候切归属等于一次启动里连切两次，而第一次切换已经把旧向量作废了；
   * - **降级通道**（`hash-bow` 且带原因）：把库的归属切到哈希词袋 = 用"字符匹配"替换库里的
   *   语义向量。ONNX 只是**暂时**装不上（权重没下好、原生绑定缺失）时这么做尤其糟，
   *   而且会在权重"忽有忽无"之间反复改写整个库。默认停住，`allowFallbackRebuild` 是显式那扇门。
   */
  const rebuildStopReason = (): string | null => {
    if (state.probing) {
      return `通道身份未定型（ONNX 仍在装载，此刻很可能回落哈希词袋）——不切归属，避免一次启动内切两次`
    }
    if (state.channel === 'onnx') return null
    if (state.channel === 'off') return '向量通道未启动'
    if (allowFallbackRebuild) return null
    return (
      `当前通道是降级路径（${state.reason ?? '原因未知'}）——` +
      `不自动把库里的语义向量改写成哈希词袋（那会替换掉语义召回；要这么做请显式开 allowFallbackRebuild）`
    )
  }

  /**
   * 回合边界的**陈旧向量回填扫描**（本文件头部 ④ 的落地）。
   *
   * 为什么寄生在 `encodePending` 里而不是另开驱动入口：`dsh/` 只在回合边界调那一个方法
   * （`dsh/session.ts:736` 的 `flushVectorEncoder`）。另开入口**没人驱动**——那正是缺陷 A 的形态
   * （`listEmbeddings` 写好了"供陈旧度查询与重建"，全仓没有一个调用方）。
   *
   * 三步，各自有界：
   * ① 一个周期的开头在库上**实测一次**待重建条数（`staleBase`；此后按已完成的量递减，
   *    见 `staleBase` 的说明——全表统计一次就要 200~400ms/万条，不能每回合做）；
   * ② 按 `maxBackfill`（并受队列余量约束）取下一批 **id** 入队——只取 id，正文留到下一次冲刷批量水合；
   * ③ 编码由下一次 `encodePending` 走既有批通路（`embed` 一次 N 条）完成。
   *
   * 幂等且可重入：入队用的是"当前身份下没有向量**或向量编码的是旧正文**"这个**库内事实**，
   * 不是内存里的差集，所以中途失败/进程重启之后，下一遍扫描自然会把没做完的继续列出来。
   * 键集游标只影响**顺序**（避免每轮都从表头开始），不影响正确性。
   *
   * 本机制判的是**归属 + 内容**：换了嵌入器（归属不符）与正文被改写（`content_hash` 不符，
   * 含 v2 迁移前的历史行 = 未知）都在待重建集合里。后一类之所以必须有，
   * 是因为它在旧实现里**完全不可见**：向量会一直拿着过时正文参与检索，不报错、只是排名莫名其妙。
   *
   * 绝不抛：任何失败转成 `rebuild.blocked` 或累计计数（回填是后台增益，不得影响会话）。
   */
  const scanRebuild = async (kernel: Kernel | undefined): Promise<void> => {
    if (kernel === undefined) {
      rebuildBlocked = '模块未启动或已关闭（无内核句柄）；待办保留在库里，下次启动继续'
      return
    }
    const embedder = kernel.service<Embedder>(EMBEDDER_SERVICE)
    if (embedder === undefined) {
      // 身份都拿不到：这一回合**没测**（读数保持"未测量"或上一次的记账值），原因写清
      rebuildBlocked = '嵌入器服务不可用（omb-memory-vector 未启动）——无法判定当前身份'
      return
    }
    const current: EmbeddingMeta = {
      modelId: embedder.id,
      dim: embedder.dimensions,
      revision: embedder.revision,
    }
    const sets = resolveStoreSets(kernel)
    if (sets.length === 0) {
      rebuildBlocked = '记忆库未就绪（stores.snapshot() 没有可用库）——待重建条数无法测量'
      return
    }
    const stop = rebuildStopReason()

    // 身份一变（换模型/换维度/换修订），"陈旧"的集合整个变了 → 游标、记账与原因拆分一起作废
    const identityKey = `${current.modelId}\u0000${current.dim}\u0000${current.revision}`
    if (identityKey !== rebuildCursorIdentity) {
      rebuildCursorIdentity = identityKey
      rebuildCursors.clear()
      staleBase = null
      staleDone = 0
      staleCauses = { lackingIdentity: null, contentChanged: null }
    }

    staleFromScan = false
    // 已对齐（上个周期实测的基准全部处理完）→ **不碰库**。这是"不每回合做全表统计"的兑现处：
    // 只有身份变化才会让这个结论失效，而身份变化在上面已经把基准清空了。
    if (staleBase !== null && staleBase - staleDone <= 0) {
      rebuildBlocked = null
      return
    }

    // 基准只在周期开头实测一次
    const needBase = staleBase === null
    let base = 0
    // 原因拆分与基准**同一次 SQL** 得到（`countStaleEmbeddingsByCause` 一条查询里两个求和项），
    // 所以这里不会为"读数更细"多付一次全表统计的代价。
    let causes: StaleEmbeddingCauses = { lackingIdentity: 0, contentChanged: 0 }
    let measured = needBase
    let scanReason: string | null = null
    // 队列余量：回填只填**空位**，绝不挤掉待落盘的写入（见 `enqueueRebuild`）
    let budget = Math.min(maxBackfill, Math.max(0, maxPending - queue.size))

    for (const ref of vectorStoreRefs(sets)) {
      if (needBase) {
        try {
          const counts = await ref.api.countStaleEmbeddingsByCause(current)
          base += counts.total
          causes = {
            lackingIdentity: (causes.lackingIdentity ?? 0) + counts.lackingIdentity,
            contentChanged: (causes.contentChanged ?? 0) + counts.contentChanged,
          }
        } catch (error) {
          // 有一个库数不出来 → 基准不成立：宁可继续报"未测量"，也不拿一个偏小的数当基准
          measured = false
          scanReason = `统计待重建条数失败（${ref.label}）：${messageOf(error)}`
          continue
        }
      }
      if (stop !== null || budget <= 0) continue
      const want = Math.min(budget, maxBackfill)
      try {
        const ids = await ref.api.listStaleEmbeddingIds(current, {
          afterId: rebuildCursors.get(ref.key) ?? '',
          limit: want,
        })
        for (const id of ids) {
          if (enqueueRebuild(id, ref)) budget -= 1
        }
        // 游标推进；取不满 `want` 说明这个库的待重建集合已到表尾 → 下一遍从头再扫。
        // 表尾回头是刻意的：失败（编码抛错 / 写入被拒）的条目仍是待重建，要靠下一遍重来。
        const last = ids[ids.length - 1]
        rebuildCursors.set(ref.key, ids.length < want || last === undefined ? '' : last)
      } catch (error) {
        scanReason = `列出待重建 id 失败（${ref.label}）：${messageOf(error)}`
      }
    }

    if (needBase) {
      if (measured) {
        staleBase = base
        staleDone = 0
        // 原因拆分与基准同源同时刻：它说的是"这个积压长什么样"（不随 `staleDone` 递减——
        // 那是另一个问题："还剩多少"）。测不出来时两个字段保持 null（未测量 ≠ 0）。
        staleCauses = causes
        staleFromScan = true
      } else {
        staleBase = null // 基准不成立 → 保持"未测量"，下一回合重试
        staleCauses = { lackingIdentity: null, contentChanged: null }
      }
    }

    const stale = staleRemaining()
    // "停住"只在**真有活要干**时才上报：库里一条待重建都没有时，那是没有信息量的噪音
    // （"有没有活"这一刻也说不清时例外：原因必须写出来）。
    rebuildBlocked =
      stale === null
        ? (scanReason ?? '待重建条数未能测量')
        : stale === 0
          ? null
          : (scanReason ??
            stop ??
            (budget <= 0
              ? `待编码队列已满（${queue.size}/${maxPending}）——本轮不扫描，待办仍在库里`
              : null))
  }

  /**
   * **孤儿向量行的清理**：正文已不存在的行者没有消费者（`searchVector` 要 JOIN `memory`）。
   *
   * 为什么它有独立入口（而不是等着"待重建"把 id 列出来）：待重建的判定以 `memory` 为外层
   * （情形②要 join 正文的当前哈希），而孤儿行**没有正文**，因此在判定里根本不可见——
   * 上一版靠"外层是 `embedding`"碰巧覆盖了它们，本次换判定式之后那条巧合没有了。
   *
   * 为什么每回合都能做：一条走 `embedding` 主键的 DELETE（无匹配 `memory` 的行），
   * 不读 BLOB、不随库增长做全表物化。已经对齐（不扫库）时它也只在有行要删时才有写代价。
   * 计数进 `rebuild.scavenged`——与"回收残留"同一本账（都是"没有消费者的向量行"）。
   */
  const scavengeOrphans = async (apis: readonly VectorStoreApi[]): Promise<void> => {
    const seen = new Set<VectorStoreApi>()
    for (const api of apis) {
      if (seen.has(api)) continue
      seen.add(api)
      try {
        scavengedTotal += await api.deleteOrphanEmbeddings()
      } catch (error) {
        // 清理失败不致命：孤儿行留在库里不影响检索（它们召不回来），下一轮再试
        lastEncodeReason = `清理残留向量行失败：${messageOf(error)}`
      }
    }
  }

  /**
   * 回合边界的唯一入口：先冲刷已有队列，再扫一遍陈旧向量。
   *
   * 顺序是刻意的：① 先落盘已有的待办，队列腾出空位；② 回填的入队与普通写入走**同一条**批通路，
   * 下一轮一起被编码——不另起并发编码（两套通路必然漂移，而且会互相抢同一个库的写锁）。
   *
   * 返回值与从前完全一致（宿主只知道"冲刷结果"）：回填读数在 `stats().rebuild` 与状态面上，
   * 因此 `dsh/` 不需要改一行（`dsh/session.ts:736` 只调 `encodePending(limit)`）。
   *
   * **重入闸**：两个回合边界叠在一起时（`dsh` 是 `void` 调用的），并行冲刷会把同一条记忆编码两次、
   * 把"已重建"记两遍——读数因此说谎。撞上时**跳过这一轮并说明**，队列与待办一个都不丢。
   */
  const encodePending = async (limit?: number): Promise<VectorEncodeOutcome> => {
    if (flushing) {
      return { encoded: 0, skipped: 0, failures: 0, reason: '上一次冲刷仍在进行；本轮跳过，队列保留' }
    }
    flushing = true
    try {
      const outcome = await flushQueue(limit)
      try {
        // 孤儿行清理**不受"已对齐就跳过扫描"那条优化影响**：它是另一本账（没有正文的行），
        // 而"对齐"说的是"有正文的记忆都有当前向量"。两者互不蕴含。
        // 内核句柄缺失（已卸载）时没有库可清——不是失败，只是没得清。
        if (kernelRef !== undefined) {
          await scavengeOrphans(vectorStoreRefs(resolveStoreSets(kernelRef)).map(ref => ref.api))
        }
      } catch (error) {
        // 清理异常不得影响冲刷结果（它已经落盘了）
        lastEncodeReason = `清理残留向量行异常：${messageOf(error)}`
      }
      try {
        await scanRebuild(kernelRef)
      } catch (error) {
        // 扫描异常不得让冲刷结果变成失败（它已经落盘了）：说清是扫描没走通
        rebuildBlocked = `回填扫描异常：${messageOf(error)}`
      }
      return outcome
    } finally {
      flushing = false
      reportHealth?.()
    }
  }

  /** 注册到内核的编码队列服务值。 */
  const encoder: VectorEncoder = {
    pending: () => queue.size,
    encodePending,
    stats: encoderStats,
  }

  /** 换"装载期"状态（通道选型）；**不动**检索期字段——两者语义不同。 */
  const commit = (
    next: Pick<VectorChannelState, 'channel' | 'probing' | 'modelDir' | 'reason'>,
    runtime: {
      readonly lastSearchError?: string | null
      readonly channelErrors?: number
      readonly searches?: number
    } = {},
  ): void => {
    state = {
      ...next,
      lastSearchError:
        runtime.lastSearchError !== undefined ? runtime.lastSearchError : state.lastSearchError,
      channelErrors:
        runtime.channelErrors !== undefined ? runtime.channelErrors : state.channelErrors,
      searches: runtime.searches !== undefined ? runtime.searches : state.searches,
    }
  }

  /**
   * 记一次检索结果（`null` = 恢复正常）。
   *
   * 为什么成功也要记：不清掉上一次的原因，健康面会永远停在"降级"——
   * 那会让"现在到底好不好"变成不可回答的问题。
   *
   * 同时**每次都累加 `searches`**（成功也累加）：否则"尚未检索过"与"最近一次正常"
   * 在读数上无法区分。只有计数变化时不重报健康（读数没变，避免无谓的重报）。
   */
  const noteSearchOutcome = (failure: string | null): void => {
    const searches = state.searches + 1
    if (failure === null) {
      if (state.lastSearchError === null) {
        state = { ...state, searches }
        return
      }
      state = { ...state, searches, lastSearchError: null }
    } else {
      state = { ...state, searches, lastSearchError: failure, channelErrors: state.channelErrors + 1 }
    }
    reportHealth?.()
  }

  const apply = (kernel: Kernel, input?: unknown): (() => void) => {
    const config: VectorConfig = vectorConfigSchema.parse(input ?? {})
    const slot = new SwitchableEmbedder(hashBagEmbedder(config.dimensions))

    // ① 同步注册嵌入器服务（H-2）。同名重复注册 = 替换（内核语义），旧 disposer 不会误删新的。
    const unprovide = kernel.provide<Embedder>(EMBEDDER_SERVICE, slot)
    installed = slot

    // ② 同步登记状态面段落（H-2）。登记处缺失不致命：health() 仍带原因。
    let unregister: (() => void) | undefined
    try {
      unregister = kernel.service<StatusRegistry>(SERVICES.statusContributor)?.register({
        name: VECTOR_MODULE_ID,
        render: () => renderStatus(state, installed, encoderStats()),
        metrics: () => channelMetrics(state, installed, encoderStats()),
      })
    } catch {
      // 状态面登记失败不得影响通道可用性
    }

    let disposed = false

    /**
     * **前置条件检查：`omb-memory` 没开时，如实点名。**
     *
     * 向量通道的库访问走 `SERVICES.stores`（见 `defaultResolveStoreSets`），
     * 而那个服务由 `omb-memory` 提供。所以"记忆库被关掉"是**可检测的事实**，
     * 不该让它表现成"通道自己的权重目录不存在"——使用者会去修错的东西。
     *
     * ## 为什么这不是"运行时硬阻断"
     *
     * 它**不阻止模块挂载**，也不 `apply` 之后再注册任何东西（H-2 不受影响）。
     * 它做的是：**让依赖方不假装正常**——健康面上直接写"缺哪个依赖"。
     * 这正是用户要的"依赖没开 → 依赖方自动关闭"在没有前端时的等价形态：
     * 能力不可用、且**原因可读**，而不是静默降级成别的理由。
     *
     * ## 为什么在 `report()` 里查，而不是 `apply` 时查一次
     *
     * 模块行的挂载顺序**没有保证**（行间只有 `inject: ['omb:kernel']` 一道门）：
     * 向量行可能先于记忆行挂载。apply 时查一次会把"晚一点就绪"误判成"缺失"。
     * 每次上报时实时查，两种情况都得到正确结论。
     */
    const missingDependency = (): string | null => {
      try {
        return kernel.service<unknown>(SERVICES.stores) === undefined
          ? '缺少必需依赖：omb-memory（stores 服务不存在）——记忆库被关掉时向量通道无法工作'
          : null
      } catch {
        // 服务表读取失败一律当"查不出来"：不制造假缺失
        return null
      }
    }

    const report = (): void => {
      try {
        const base = health()
        /**
         * **只在模块活跃时查前置条件。**
         *
         * 已 `dispose` 的模块报的是"已关闭"——那时说它"缺少必需依赖"是错的：
         * 它本来就不再需要那个依赖了。这一条是实测发现的：加上检查后，
         * `apply 与 dispose 都会上报健康` 那条测试从 `ok（已关闭）` 变成
         * `degraded`，而那不是使用者该看到的信息。
         */
        const missing = disposed ? null : missingDependency()
        kernel.report(
          missing === null
            ? base
            : {
                state: base.state === 'failed' ? 'failed' : 'degraded',
                detail: `${missing}；${base.detail}`,
                ...base.metrics === undefined ? {} : { metrics: base.metrics },
              },
        )
      } catch {
        // 上报失败不得影响模块可用性（健康面是观测，不是控制面）
      }
    }
    reportHealth = report

    // ⑤ 编码队列：**同步**注册服务 + 订阅写入事件（H-2）。
    //    回调里只入队，绝不在这里编码——嵌入是真实推理，不能压进写入路径。
    kernelRef = kernel
    maxPending = config.maxPending
    maxBackfill = config.maxBackfill
    allowFallbackRebuild = config.allowFallbackRebuild
    const offWritten = kernel.on('memory/written', payload => {
      if (disposed) return
      enqueueWritten(payload)
    })
    const unprovideEncoder = kernel.provide<VectorEncoder>(VECTOR_ENCODER_SERVICE, encoder)
    installedEncoder = encoder

    // ⑥ 同步登记向量通道（H-2）：检索侧从 `SERVICES.channelRegistry` 取全部第二通道，
    //    **只有登记了才会被消费**（否则查询向量算完没人用，语义召回静默不发生）。
    //    登记处缺失或抛错都不致命：检索退化为完整纯词法路径（§5.7）。
    let unregisterChannel: (() => void) | undefined
    try {
      unregisterChannel = kernel
        .service<SecondaryChannelRegistry<RetrievalChannel>>(SERVICES.channelRegistry)
        ?.register(channel(kernel))
    } catch {
      // 登记失败 → 只有词法通道；健康面/状态面仍写明向量通道状态与待编码队列
    }

    // ③ 是否值得尝试 ONNX：**同步**的文件系统判断（廉价、不进事件循环），
    //    失败原因本身就是状态面要显示的内容。
    const resolved = resolveOnnxModelDir({ modelDir: config.modelDir })
    if (!resolved.ok) {
      commit({ channel: 'hash-bow', probing: false, modelDir: null, reason: resolved.reason })
      report()
    } else {
      const modelDir = resolved.dir
      commit({ channel: 'hash-bow', probing: true, modelDir, reason: null })
      report()
      // ④ 异步装载：不阻塞 apply 返回；成功后升级门面，失败留下可读原因。
      void loadOnnx({ modelDir, threads: config.threads })
        .then((loaded) => {
          if (disposed) return // 已卸载 → 绝不升级（否则泄漏原生会话）
          if (loaded.ok) {
            slot.upgrade(loaded.embedder)
            commit({ channel: 'onnx', probing: false, modelDir: loaded.modelDir, reason: null })
          } else {
            commit({ channel: 'hash-bow', probing: false, modelDir, reason: loaded.reason })
          }
          report()
        })
        .catch((error: unknown) => {
          if (disposed) return
          commit({
            channel: 'hash-bow',
            probing: false,
            modelDir,
            reason: `ONNX 探测异常：${messageOf(error)}`,
          })
          report()
        })
    }

    // ⑤ disposer：幂等、绝不抛（H-1）。先注销，再改状态；连检索期读数一起清。
    return () => {
      if (disposed) return
      disposed = true
      installed = undefined
      installedEncoder = undefined
      kernelRef = undefined
      commit(
        // "卸载后无残留读数"：连 `searches` 一起清——残留的检索次数会让下一次装载
        // 把"还没检索过"错报成"检索过 N 次"。
        { channel: 'off', probing: false, modelDir: null, reason: null },
        { lastSearchError: null, channelErrors: 0, searches: 0 },
      )
      try {
        offWritten()
      } catch {
        // 退订失败不得向上传播（事件总线监听器泄漏会让热插拔验收不过）
      }
      try {
        unregisterChannel?.()
      } catch {
        // 通道注销失败同上；检索侧下次 list() 就看不到它
      }
      try {
        unregister?.()
      } catch {
        // 注销失败不得向上传播（宿主 reconcile 会 await 旧 fiber）
      }
      try {
        unprovideEncoder()
      } catch {
        // 同上
      }
      try {
        unprovide()
      } catch {
        // 同上
      }
      report()
    }
  }

  const manifest: VectorManifest = {
    id: VECTOR_MODULE_ID,
    version: '3.6.0',
    // 依赖 `omb-memory`：关掉记忆库，向量通道没有意义。依赖从目录派生（唯一真源）。
    requires: derivedRequires(VECTOR_MODULE_ID),
    capabilities: derivedCapabilities(VECTOR_MODULE_ID),
    configSchema: vectorConfigSchema,
    health,
  }

  /** 实例级通道：检索期降级写进本实例的状态与健康面（生产单例导出了 `vectorChannel`）。 */
  const channel = (
    kernel: Kernel,
    options: { readonly minScore?: number } = {},
  ): RetrievalChannel =>
    createVectorChannel({
      kernel,
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
      onDegraded: (reason) => noteSearchOutcome(reason),
      onRecovered: () => noteSearchOutcome(null),
    })

  return {
    manifest,
    registration: { manifest, apply },
    apply,
    state: () => state,
    embedder: () => installed,
    channel,
    encoder: () => installedEncoder,
  }
}

/** 生产单例（`dsh/` 侧直接取 `vectorModule`）。 */
const production = createVectorModule()
/** 模块注册项（host 入口用）：`{ manifest, apply }`。 */
export const vectorModule: ModuleRegistration<VectorConfig> = production.registration
/** 模块清单（= `vectorModule.manifest`）。 */
export const vectorManifest: VectorManifest = production.manifest
/** `apply(kernel, config)`；同步注册嵌入器服务，返回幂等 disposer。 */
export const apply: ModuleRegistration<VectorConfig>['apply'] = (kernel, config) =>
  production.apply(kernel, config)
/**
 * 生产单例的向量通道 —— `dsh/` 侧的一行接线：
 * ```ts
 * retrieve(stores, query, { clock, embedder, channels: [vectorChannel(kernel)] })
 * ```
 * 检索期降级会写进单例的状态面段落（`omb_status` 可见）。
 *
 * ⚠️ 多 fiber（一个宿主进程多个内核）应改用 `createVectorModule().channel(kernel)` 拿独立状态，
 * 否则多个内核共用一个状态闭包，状态面会互相覆盖。
 */
export const vectorChannel = (
  kernel: Kernel,
  options?: { readonly minScore?: number },
): RetrievalChannel => production.channel(kernel, options)

export default toHostPlugin(vectorModule)
