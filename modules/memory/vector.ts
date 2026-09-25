/**
 * 向量通道模块入口（`omb-memory-vector`）。
 *
 * 这是一个**可关模块**（规划 §5.7）：关掉它 → 检索退化为**完整的纯词法版本**。
 * 因此本模块只做三件事，且都不改动词法路径：
 * ① 把嵌入器注册为内核服务 `embedder`（`SERVICES.embedder`，见 `kernel/abi/catalog.ts`）；
 * ② 尝试装载 BGE-small-zh ONNX，失败则留在**哈希词袋**这条诚实降级路径上；
 * ③ 把"当前通道 + 降级原因"写进 `health()` 与状态面贡献（无空降级）。
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
  type Embedder,
  type Kernel,
  type MemoryRecord,
  type MemoryScope,
  type ModuleHealth,
  type ModuleManifest,
  type ModuleRegistration,
  type ScoredHit,
  type StatusRegistry,
  type StoreSet,
  type StoresService,
  type VectorAttribution,
} from '../../kernel/abi/index.js'
import { HASH_BOW_COSINE_FLOOR, blobDecodeFailureCount, hashBagEmbedder } from './embed.js'
import {
  BGE_COSINE_FLOOR,
  BGE_EMBEDDER_ID,
  loadOnnxEmbedder,
  resolveOnnxModelDir,
  type OnnxEmbedderOptions,
  type OnnxLoad,
} from './onnx.js'
import type { ChannelQuery, RetrievalChannel } from './retrieve.js'
import { asVectorStore, type VectorStoreApi } from './store.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

/** 模块 id = `cordis.patch.yml` 行 id = 插件页开关 id（`kernel/abi/catalog.ts`）。 */
export const VECTOR_MODULE_ID = 'omb-memory-vector'
/** 本模块注册的嵌入器服务名（契约见 `SERVICES`）。 */
export const EMBEDDER_SERVICE = SERVICES.embedder
/**
 * 本模块注册的**编码队列**服务名。
 *
 * ⚠️ 待 `kernel/abi/catalog.ts` 冻结 `SERVICES.vectorEncoder = 'vectorEncoder'` 后改为引用常量
 * （字面量临时用，避免 ABI 变更阻塞施工）。
 */
export const VECTOR_ENCODER_SERVICE = 'vectorEncoder'
/** 待编码队列的默认上界（`maxPending` 配置的缺省值）。 */
export const DEFAULT_MAX_PENDING = 256

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
}

/**
 * 向量编码队列（内核服务 `VECTOR_ENCODER_SERVICE`）。
 *
 * 为什么是"队列 + 冲刷"而不是"写入时同步编码"：嵌入是一次真实推理（ONNX 毫秒级、
 * 且原生绑定会阻塞事件循环），把它压进写入路径会让每一次记忆写入都变慢。
 * 因此写入只**入队**（`memory/written`），编码由 `dsh/` 在回合边界调 `encodePending()` 批量做。
 */
export interface VectorEncoder {
  /** 待编码条目数。 */
  pending(): number
  /**
   * 批量冲刷：`getMany` 读文本（**禁 N+1**）→ `embed` **一次批编码** → 逐条落盘。
   *
   * 归属标签取**当前嵌入器身份**（`modelId`/`dim`/`revision`），库侧会拒绝不符的写入。
   * 无嵌入器 / 库不支持向量 / 编码失败 → 返回可读 `reason` 且**保留队列**（下次再试）；
   * 文本为空或记录已不存在 → 跳过并计数；被库拒绝的单条 → 出队并计数（重试不会成功）。
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

/** 解析"当前已就绪的库套件"（编码队列据此定位某条 id 在哪个库）。 */
export type StoreSetResolver = (kernel: Kernel) => readonly StoreSet[]

/**
 * 缺省解析：读内核 `stores` 服务的 `snapshot()`。
 *
 * ⚠️ `snapshot()` 目前是 store 实现的**附加**方法（`MemoryStoresService`，尚未进 ABI）。
 * 已向 lead 申请把它提升进 `StoresService`；在那之前用结构面读取：
 * 缺失或抛错 → 空数组（上层给可读原因），**绝不抛**。ABI 冻结后应删掉这个 cast。
 */
const defaultResolveStoreSets: StoreSetResolver = (kernel) => {
  const stores = kernel.service<StoresService>(SERVICES.stores) as
    | (StoresService & { snapshot?: () => { user?: StoreSet; projects?: readonly StoreSet[] } })
    | undefined
  if (stores === undefined || typeof stores.snapshot !== 'function') return []
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

/** 通道的一句话标签（health 与状态面共用，避免两处口径漂移）。 */
function channelLabel(state: VectorChannelState, current: Embedder | undefined): string {
  if (state.channel === 'onnx') {
    return `神经嵌入 ${current?.id ?? BGE_EMBEDDER_ID}（${current?.dimensions ?? 0} 维，revision ${current?.revision ?? '?'}）`
  }
  if (state.channel === 'off') return '未启动/已关闭'
  const fallback = current === undefined ? '哈希词袋' : `哈希词袋 ${current.id}（${current.dimensions} 维）`
  return state.probing ? `${fallback}，ONNX 装载中` : `${fallback}（诚实降级路径）`
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
    // 落盘读数：待编码队列与累计计数（"写入却没向量"必须可见，而不是查表为空却无人知道）
    pendingEmbeddings: enc.pending,
    encodedEmbeddings: enc.encoded,
    encodeSkipped: enc.skipped,
    encodeFailures: enc.failures,
    encodeRejected: enc.rejected,
    encodeDropped: enc.dropped,
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
 * 健康面 = 装载期状态（`baseHealth`）+ **检索期**降级 + **落盘期**读数。
 *
 * 两类运行期问题都必须显式呈现（而不是被"通道可用"盖住）：
 * ① 通道选型正常但某次检索返回空（语义召回实际没发生）；
 * ② 待编码队列积压或被拒（记忆写进去了却没有向量 → `searchVector` 结构上查不到）。
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
  lines.push(
    `最近一次检索：${state.lastSearchError === null ? '正常' : `降级（${state.lastSearchError}）`}` +
      `；累计降级 ${state.channelErrors} 次`,
  )
  lines.push(
    `向量落盘：待编码 ${enc.pending} 条；已编码 ${enc.encoded}；跳过 ${enc.skipped}；` +
      `失败 ${enc.failures}（其中被拒 ${enc.rejected}）；超界丢弃 ${enc.dropped}`,
  )
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
  }
  let installed: SwitchableEmbedder | undefined
  /** apply 装上的健康上报出口；通道的**检索期**降级也要经它上报。 */
  let reportHealth: (() => void) | undefined

  // ── 向量落盘：待编码队列 ────────────────────────────────────────────────────
  // `memory/written` 回调里**只入队**；编码在 `encodePending()` 里批量做。
  // 为什么不在回调里编码：嵌入是一次真实推理（ONNX 毫秒级，且原生绑定阻塞事件循环），
  // 把它压进写入路径会让每次记忆写入都变慢——而写入路径的正确性并不依赖向量。
  /** 队列：`Map` 保序 + 去重；值 = 事件声明的作用域（无法识别 → null，冲刷时两个作用域都试）。 */
  const queue = new Map<string, MemoryScope | null>()
  let maxPending = DEFAULT_MAX_PENDING
  let droppedOldest = 0
  let encodedTotal = 0
  let skippedTotal = 0
  let failureTotal = 0
  let rejectedTotal = 0
  let lastEncodeReason: string | null = null
  /** apply 装上的内核句柄（冲刷时解析嵌入器与库）；卸载后置空。 */
  let kernelRef: Kernel | undefined
  let installedEncoder: VectorEncoder | undefined

  const health = (): ModuleHealth => renderHealth(state, installed, encoderStats())

  const encoderStats = (): VectorEncoderStats => ({
    pending: queue.size,
    encoded: encodedTotal,
    skipped: skippedTotal,
    failures: failureTotal,
    dropped: droppedOldest,
    rejected: rejectedTotal,
    lastReason: lastEncodeReason,
  })

  const isMemoryScope = (value: string): value is MemoryScope =>
    (MEMORY_SCOPES as readonly string[]).includes(value)

  /**
   * 入队（去重、保序、超界丢最旧并计数）。
   * **纯内存操作**：不做 I/O、不编码——这是"写入路径不变慢"的全部机制。
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
    queue.set(id, isMemoryScope(payload.scope) ? payload.scope : null)
  }

  /**
   * 批量冲刷待编码队列：`getMany`（每库一次）→ `embed`（**一次**，N 条不是 N 次）→ 逐条落盘。
   *
   * 归属标签取当前嵌入器身份，库侧会拒绝不符的写入（D2：写入时拒绝无法归属的向量）。
   * 绝不抛：整批失败给 `reason` 且**保留队列**；单条被库拒绝则出队并计数（重试不会成功）。
   */
  const encodePending = async (limit?: number): Promise<VectorEncodeOutcome> => {
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
    const sets = resolveStoreSets(kernel)
    if (sets.length === 0) {
      return nothing('记忆库未就绪（stores.snapshot() 没有可用库）；待编码队列保留')
    }

    const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit as number)) : queue.size
    const batch = [...queue.entries()].slice(0, cap)

    // ① 批量水合：每个（库套件 × 作用域）一次 `getMany`——禁 N+1
    const found = new Map<string, { record: MemoryRecord; api: VectorStoreApi | undefined }>()
    let vectorCapable = false
    let hydrateError: string | null = null
    for (const set of sets) {
      for (const scope of MEMORY_SCOPES) {
        const target = set.store(scope)
        if (target === undefined) continue
        const ids = batch
          .filter(
            ([id, queuedScope]) =>
              !found.has(id) && (queuedScope === null || queuedScope === scope),
          )
          .map(([id]) => id)
        if (ids.length === 0) continue
        const api = asVectorStore(target)
        if (api !== undefined) vectorCapable = true
        try {
          for (const record of await target.getMany(ids)) {
            found.set(record.id, { record, api })
          }
        } catch (error) {
          hydrateError = `读取记忆文本失败（${messageOf(error)}）`
        }
      }
    }
    if (found.size === 0) {
      if (hydrateError !== null) return nothing(`${hydrateError}；待编码队列保留`)
      if (!vectorCapable) return nothing('库不支持向量写入（asVectorStore 未命中）；待编码队列保留')
      // 记录已不存在（被删除）：出队并计数——既不是失败，也不是可重试的状态
      for (const [id] of batch) queue.delete(id)
      skippedTotal += batch.length
      return { encoded: 0, skipped: batch.length, failures: 0 }
    }

    // ② 分类：空文本 / 无向量口 → 跳过；其余待编码
    const encodable: { id: string; text: string; api: VectorStoreApi }[] = []
    let skipped = 0
    for (const [id] of batch) {
      const hit = found.get(id)
      if (hit === undefined) {
        queue.delete(id) // 库里没有这条（已删除）
        skipped += 1
        continue
      }
      if (hit.record.text.trim().length === 0) {
        queue.delete(id) // 空文本没有可编码的内容
        skipped += 1
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
      encodable.push({ id, text: hit.record.text, api: hit.api })
    }

    // ③ 一次批编码（N 条 → 一次 embed）
    let vectors: readonly Float32Array[] = []
    if (encodable.length > 0) {
      try {
        vectors = await embedder.embed(encodable.map((entry) => entry.text))
      } catch (error) {
        failureTotal += encodable.length
        lastEncodeReason = `编码失败（${messageOf(error)}）；待编码队列保留`
        reportHealth?.()
        return { encoded: 0, skipped, failures: encodable.length, reason: lastEncodeReason }
      }
      if (vectors.length !== encodable.length) {
        failureTotal += encodable.length
        lastEncodeReason =
          `嵌入器 ${embedder.id} 返回 ${vectors.length} 条向量、期望 ${encodable.length} 条；` +
          '待编码队列保留'
        reportHealth?.()
        return { encoded: 0, skipped, failures: encodable.length, reason: lastEncodeReason }
      }
    }

    // ④ 逐条落盘（归属标签 = 当前嵌入器身份）
    let encoded = 0
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
        })
        queue.delete(entry.id)
        encoded += 1
      } catch (error) {
        // 单条被库拒绝（归属不符 / 维度不符）→ 重试不会成功：出队并计数，原因留在状态面
        queue.delete(entry.id)
        failures += 1
        rejectedTotal += 1
        callReason = `向量写入被拒（${entry.id}）：${messageOf(error)}`
        lastEncodeReason = callReason
      }
    }
    encodedTotal += encoded
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

  /** 注册到内核的编码队列服务值。 */
  const encoder: VectorEncoder = {
    pending: () => queue.size,
    encodePending,
    stats: encoderStats,
  }

  /** 换"装载期"状态（通道选型）；**不动**检索期字段——两者语义不同。 */
  const commit = (
    next: Pick<VectorChannelState, 'channel' | 'probing' | 'modelDir' | 'reason'>,
    runtime: { readonly lastSearchError?: string | null; readonly channelErrors?: number } = {},
  ): void => {
    state = {
      ...next,
      lastSearchError:
        runtime.lastSearchError !== undefined ? runtime.lastSearchError : state.lastSearchError,
      channelErrors:
        runtime.channelErrors !== undefined ? runtime.channelErrors : state.channelErrors,
    }
  }

  /**
   * 记一次检索结果（`null` = 恢复正常）。
   *
   * 为什么成功也要记：不清掉上一次的原因，健康面会永远停在"降级"——
   * 那会让"现在到底好不好"变成不可回答的问题。
   */
  const noteSearchOutcome = (failure: string | null): void => {
    if (failure === null) {
      if (state.lastSearchError === null) return
      state = { ...state, lastSearchError: null }
    } else {
      state = { ...state, lastSearchError: failure, channelErrors: state.channelErrors + 1 }
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

    const report = (): void => {
      try {
        kernel.report(health())
      } catch {
        // 上报失败不得影响模块可用性（健康面是观测，不是控制面）
      }
    }
    reportHealth = report

    // ⑤ 编码队列：**同步**注册服务 + 订阅写入事件（H-2）。
    //    回调里只入队，绝不在这里编码——嵌入是真实推理，不能压进写入路径。
    kernelRef = kernel
    maxPending = config.maxPending
    const offWritten = kernel.on('memory/written', payload => {
      if (disposed) return
      enqueueWritten(payload)
    })
    const unprovideEncoder = kernel.provide<VectorEncoder>(VECTOR_ENCODER_SERVICE, encoder)
    installedEncoder = encoder

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
        { channel: 'off', probing: false, modelDir: null, reason: null },
        { lastSearchError: null, channelErrors: 0 },
      )
      try {
        offWritten()
      } catch {
        // 退订失败不得向上传播（事件总线监听器泄漏会让热插拔验收不过）
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
    version: '3.0.0',
    // 依赖 `omb-memory`：关掉记忆库，向量通道没有意义（依赖方会标 failed 并写明原因）。
    requires: ['omb-memory'],
    capabilities: ['memory.recall.semantic'],
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
