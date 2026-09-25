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
  SERVICES,
  type Embedder,
  type Kernel,
  type ModuleHealth,
  type ModuleManifest,
  type ModuleRegistration,
  type StatusRegistry,
} from '../../kernel/abi/index.js'
import { blobDecodeFailureCount, hashBagEmbedder } from './embed.js'
import {
  BGE_EMBEDDER_ID,
  loadOnnxEmbedder,
  resolveOnnxModelDir,
  type OnnxEmbedderOptions,
  type OnnxLoad,
} from './onnx.js'

/** 模块 id = `cordis.patch.yml` 行 id = 插件页开关 id（`kernel/abi/catalog.ts`）。 */
export const VECTOR_MODULE_ID = 'omb-memory-vector'
/** 本模块注册的内核服务名（契约见 `SERVICES`）。 */
export const EMBEDDER_SERVICE = SERVICES.embedder

/**
 * 配置 schema（缺省值必须完整：`apply` 永远收到完整配置）。
 *
 * `dimensions` 是**哈希兜底路径**的维度，不是神经模型的维度——神经模型的维度由模型自身决定
 * （BGE-small-zh = 512），并作为归属标签随向量持久化。
 */
export const vectorConfigSchema = z.object({
  /** 模型目录（显式注入）。缺省按 `$OMB_EMBEDDING_MODEL` → `<数据根>/models/bge-small-zh-v1.5` 解析。 */
  modelDir: z.string().optional(),
  /** 推理线程数（默认 2：单条毫秒级；调大会抢主对话的 CPU）。 */
  threads: z.number().int().min(1).default(2),
  /** 哈希兜底维度（默认 256）。 */
  dimensions: z.number().int().positive().default(256),
})

export type VectorConfig = z.infer<typeof vectorConfigSchema>

/** 当前通道状态（`health()` 与状态面读它）。 */
export interface VectorChannelState {
  /** `onnx` = 神经嵌入；`hash-bow` = 诚实降级；`off` = 模块未启动/已卸载。 */
  readonly channel: 'onnx' | 'hash-bow' | 'off'
  /** ONNX 探测是否在飞行中。 */
  readonly probing: boolean
  /** 解析到的权重目录（无则 null）。 */
  readonly modelDir: string | null
  /** 降级原因；`null` 表示无降级。**不允许为空字符串**。 */
  readonly reason: string | null
}

/** 装载器签名（默认 = `loadOnnxEmbedder`；测试可注入，避免碰真实权重）。 */
export type OnnxLoader = (options: OnnxEmbedderOptions) => Promise<OnnxLoad>

/** 可注入依赖。**生产不传**：默认即真实实现。 */
export interface VectorModuleDeps {
  readonly loadOnnx?: OnnxLoader
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
): Record<string, number> {
  return {
    // 通道读数：1 = 向量通道可用（含降级），0 = 不可用。词法路径不受影响。
    channel: state.channel === 'off' ? 0 : 1,
    onnx: state.channel === 'onnx' ? 1 : 0,
    probing: state.probing ? 1 : 0,
    dimensions: current?.dimensions ?? 0,
    // 损坏 BLOB 计数：让"某条记忆就是搜不到"变成可读数字（旧实现静默返回 null）。
    blobDecodeFailures: blobDecodeFailureCount(),
  }
}

/** 把通道状态渲染成健康面。**detail 永远写明当前通道**，降级必须带原因。 */
function renderHealth(state: VectorChannelState, current: Embedder | undefined): ModuleHealth {
  const metrics = channelMetrics(state, current)

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
 * 状态面段落。**多行、可读、含原因**——`omb_status` 会原样拼接。
 * 为什么需要它：内核 `start()` 在 `apply` 之后会写入一句通用的"模块已启动"，
 * 那会盖掉模块自己的 `report`；状态面登记处才是降级原因稳定的可见位置。
 */
function renderStatus(state: VectorChannelState, current: Embedder | undefined): string {
  const lines = [`通道：${channelLabel(state, current)}`]
  lines.push(
    `当前嵌入器：${
      current === undefined
        ? '未注册'
        : `${current.id}（${current.dimensions} 维，revision ${current.revision}）`
    }`,
  )
  lines.push(`降级原因：${state.reason === null ? '无' : state.reason}`)
  if (state.modelDir !== null) lines.push(`权重目录：${state.modelDir}`)
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

  let state: VectorChannelState = {
    channel: 'off',
    probing: false,
    modelDir: null,
    reason: '模块尚未启动（apply 未被调用）',
  }
  let installed: SwitchableEmbedder | undefined

  const health = (): ModuleHealth => renderHealth(state, installed)

  const apply = (kernel: Kernel, input?: unknown): (() => void) => {
    const config: VectorConfig = vectorConfigSchema.parse(input ?? {})
    const slot = new SwitchableEmbedder(hashBagEmbedder(config.dimensions))

    // ① 同步注册嵌入器服务（H-2）。重复注册会抛——那是对的：同一内核里两个向量通道是配置错误。
    const unprovide = kernel.provide<Embedder>(EMBEDDER_SERVICE, slot)
    installed = slot

    // ② 同步登记状态面段落（H-2）。登记处缺失不致命：health() 仍带原因。
    let unregister: (() => void) | undefined
    try {
      unregister = kernel.service<StatusRegistry>(SERVICES.statusContributor)?.register({
        name: VECTOR_MODULE_ID,
        render: () => renderStatus(state, installed),
        metrics: () => channelMetrics(state, installed),
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

    // ③ 是否值得尝试 ONNX：**同步**的文件系统判断（廉价、不进事件循环），
    //    失败原因本身就是状态面要显示的内容。
    const resolved = resolveOnnxModelDir({ modelDir: config.modelDir })
    if (!resolved.ok) {
      state = { channel: 'hash-bow', probing: false, modelDir: null, reason: resolved.reason }
      report()
    } else {
      const modelDir = resolved.dir
      state = { channel: 'hash-bow', probing: true, modelDir, reason: null }
      report()
      // ④ 异步装载：不阻塞 apply 返回；成功后升级门面，失败留下可读原因。
      void loadOnnx({ modelDir, threads: config.threads })
        .then((loaded) => {
          if (disposed) return // 已卸载 → 绝不升级（否则泄漏原生会话）
          if (loaded.ok) {
            slot.upgrade(loaded.embedder)
            state = { channel: 'onnx', probing: false, modelDir: loaded.modelDir, reason: null }
          } else {
            state = { channel: 'hash-bow', probing: false, modelDir, reason: loaded.reason }
          }
          report()
        })
        .catch((error: unknown) => {
          if (disposed) return
          state = {
            channel: 'hash-bow',
            probing: false,
            modelDir,
            reason: `ONNX 探测异常：${messageOf(error)}`,
          }
          report()
        })
    }

    // ⑤ disposer：幂等、绝不抛（H-1）。先注销，再改状态。
    return () => {
      if (disposed) return
      disposed = true
      installed = undefined
      state = { channel: 'off', probing: false, modelDir: null, reason: null }
      try {
        unregister?.()
      } catch {
        // 注销失败不得向上传播（宿主 reconcile 会 await 旧 fiber）
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

  return {
    manifest,
    registration: { manifest, apply },
    apply,
    state: () => state,
    embedder: () => installed,
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
