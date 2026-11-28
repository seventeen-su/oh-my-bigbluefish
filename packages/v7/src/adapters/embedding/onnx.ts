/**
 * BGE-small-zh-v1.5 嵌入适配器（ONNX，纯 CPU）。
 *
 * 三件事刻意分开，因为失败语义不同：
 * 1. **模型目录解析**（同步、只看文件系统）：决定"能不能试"；
 * 2. **运行时装载**（`onnxruntime-node` 是 optionalDependency，动态 import）：缺失就诚实降级；
 * 3. **会话创建 + 一次真实前向自检**：把"跑不通 / 形状不符 / 池化出零向量"挡在装载期，
 *    而不是等第一次写入才发现向量是垃圾。
 *
 * 任一环节失败：`available()` 返回 `false`（并可用 `unavailableReason()` 取原因），
 * `embed()` 抛 `OmbFailure(code: 'unsupported')`。绝不产出零向量、随机向量或换模型顶替。
 *
 * 推理口径（v7 SPEC §7.1 / 存储契约 `vector(512)`）：
 * - 分词：BERT WordPiece，`[CLS] ids… [SEP]`，最长 512；
 * - 输入：`input_ids` / `attention_mask` / `token_type_ids`（按模型实际输入名映射；单序列无 padding）；
 * - 池化：**attention-mask 加权 mean pooling**（padding 不参与）；
 * - 归一化：L2，单位向量直接支持 pgvector cosine；
 * - 维度：512；
 * - 前向：一次 RUN 只放一个序列——量化模型对同批其它样本敏感，批量会让同一文本的向量漂移
 *   （详见 `#forward` 的实测说明），而向量要落库并跨调用比较，必须逐条确定。
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Embedder } from '../../ports/embedding.js'
import { fail } from '../../domain/errors.js'
import { DEFAULT_MAX_BATCH, embedBatched } from './batch.js'
import { meanPoolNormalize } from './pooling.js'
import { BERT_MAX_LENGTH, WordPieceTokenizer } from './tokenizer.js'

/** 向量来源标识（与 `omb.meta` 里的 `embedding.model` 一致）。 */
export const BGE_MODEL = 'bge-small-zh-v1.5'
/** BGE-small-zh 输出维度。 */
export const BGE_DIMS = 512
/** 默认模型目录名：`<仓库根>/models/bge-small-zh-v1.5/`。 */
export const BGE_MODEL_DIR = 'bge-small-zh-v1.5'
/** 词表文件名（BERT WordPiece；行号即 token id）。 */
export const VOCAB_FILE = 'vocab.txt'
/** 环境变量：显式指定模型目录（**一旦设置即权威**，解析失败不再回退其他候选）。 */
export const MODEL_DIR_ENV = 'OMB_EMBEDDING_MODEL'
/** 图文件候选（量化版优先）。外部权重数据文件同名 `_data`，由 ONNX 自己校验。 */
export const MODEL_GRAPHS = ['model_quantized.onnx', 'model.onnx'] as const

/** `close()` 之后的状态说明（`unavailableReason()` 会原样给出）。 */
const CLOSED_REASON = '嵌入器已关闭（close() 之后不再装载模型）'

/** ONNX 张量的最小结构面（不引包类型，便于测试注入假运行时）。 */
export interface OnnxTensorLike {
  readonly data: ArrayLike<number>
  readonly dims: readonly number[]
}

/** ONNX 会话的最小结构面。`release` 可选（按结构面定义，不引包）。 */
export interface OnnxSessionLike {
  readonly inputNames: readonly string[]
  readonly outputNames?: readonly string[]
  run(feeds: Record<string, OnnxTensorLike>): Promise<Record<string, OnnxTensorLike>>
  release?(): Promise<void>
}

/** `onnxruntime-node` 的最小结构面。 */
export interface OnnxRuntimeLike {
  readonly InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OnnxSessionLike>
  }
  readonly Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => OnnxTensorLike
}

export type OnnxRuntimeLoader = () => Promise<OnnxRuntimeLike>

/** 模型目录解析选项（测试注入 `env` / `moduleUrl`，生产用缺省值）。 */
export interface OnnxModelDirOptions {
  /** 显式模型目录（**权威**：不存在即失败，不回退其他候选）。 */
  readonly modelDir?: string
  /** 环境变量来源（缺省 `process.env`）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 模块位置（仓库根解析用；缺省 `import.meta.url`）。 */
  readonly moduleUrl?: string
}

export type ModelDirResolution =
  | { readonly ok: true; readonly dir: string; readonly graphPath: string; readonly dataPath?: string }
  | { readonly ok: false; readonly reason: string }

export interface OnnxEmbedderOptions extends OnnxModelDirOptions {
  /** 词表路径（缺省 `<modelDir>/vocab.txt`）。 */
  readonly vocabPath?: string
  /** 推理线程数（默认 2：单条毫秒级；调大会抢主对话的 CPU）。 */
  readonly threads?: number
  /** 每批条数（默认 32，见 `DEFAULT_MAX_BATCH`）。 */
  readonly batchSize?: number
  /** 分词最大长度（默认 512；仅测试用更小值）。 */
  readonly maxLength?: number
  /** 注入运行时加载器（测试用假实现；缺省动态 import `onnxruntime-node`）。 */
  readonly loadRuntime?: OnnxRuntimeLoader
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正整数，实际：${String(value)}`)
  }
  return value
}

function graphIn(dir: string): string | undefined {
  for (const graph of MODEL_GRAPHS) {
    if (existsSync(join(dir, graph))) return join(dir, graph)
  }
  return undefined
}

function describeRequirement(): string {
  return `${MODEL_GRAPHS.join(' 或 ')} + ${VOCAB_FILE}（量化版权重还需同名 .onnx_data）`
}

function checkDir(dir: string, source: string): ModelDirResolution {
  if (!existsSync(dir)) {
    return { ok: false, reason: `权重目录不存在：${dir}（来源：${source}）` }
  }
  const graphPath = graphIn(dir)
  if (graphPath === undefined) {
    return {
      ok: false,
      reason: `权重目录内缺少图文件：${dir}（已试：${MODEL_GRAPHS.join(' / ')}；来源：${source}）`,
    }
  }
  if (!existsSync(join(dir, VOCAB_FILE))) {
    return { ok: false, reason: `权重目录内缺少词表：${join(dir, VOCAB_FILE)}（来源：${source}）` }
  }
  const dataPath = join(dir, `${basename(graphPath)}_data`)
  return existsSync(dataPath) ? { ok: true, dir, graphPath, dataPath } : { ok: true, dir, graphPath }
}

/**
 * 解析模型目录。顺序：
 * ① `modelDir` 参数（权威）② `$OMB_EMBEDDING_MODEL`（权威）
 * ③ 从模块位置向上最多 8 层的 `<dir>/models/bge-small-zh-v1.5`
 *
 * ①② 一旦给出就是权威：指向坏目录时直接返回原因，不再回退——显式意图被静默覆盖会让
 * "我明明配了模型却不生效"变成无从排查的问题。
 */
export function resolveModelDir(options: OnnxModelDirOptions = {}): ModelDirResolution {
  const explicit = options.modelDir?.trim()
  if (explicit !== undefined && explicit.length > 0) return checkDir(explicit, 'modelDir 参数')

  const env = options.env ?? process.env
  const fromEnv = env[MODEL_DIR_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return checkDir(fromEnv, `$${MODEL_DIR_ENV}`)

  let cursor: string | undefined
  try {
    cursor = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url))
  } catch {
    cursor = undefined
  }
  const tried: string[] = []
  let specific: string | undefined
  for (let depth = 0; depth < 8 && cursor !== undefined; depth++) {
    const candidate = join(cursor, 'models', BGE_MODEL_DIR)
    tried.push(candidate)
    if (existsSync(candidate)) {
      const verdict = checkDir(candidate, '仓库根 models/')
      if (verdict.ok) return verdict
      if (specific === undefined) specific = verdict.reason
    }
    const parent = dirname(cursor)
    cursor = parent === cursor ? undefined : parent
  }
  if (specific !== undefined) return { ok: false, reason: specific }
  return {
    ok: false,
    reason:
      `未找到模型（已试：${tried.length > 0 ? tried.join(' / ') : '无候选'}）。` +
      `可设 $${MODEL_DIR_ENV} 或传 modelDir 指向模型目录，或把 BGE-small-zh-v1.5 放到 ` +
      `<仓库根>/models/${BGE_MODEL_DIR}/（需 ${describeRequirement()}）`,
  }
}

/**
 * 默认运行时加载器：动态 import（**非字面量说明符是故意的**）。
 *
 * `onnxruntime-node` 是 optionalDependency。写成字面量 `import('onnxruntime-node')` 会让
 * `tsc` 在构建期尝试解析它，未安装即 TS2307——把"可选"变成"必须安装才能构建"。
 * 用变量拼接可让 tsc 不解析（模块类型由上面的结构面承担）。
 */
/**
 * 进程级 ONNX runtime 缓存。
 *
 * DSH 的插件热重载会重新执行本模块；如果每次重新 `import('onnxruntime-node')`，
 * 原生模块会在同一进程内重复注册 N-API cleanup hook，Node 会直接 assert 崩溃
 * （`napi_add_env_cleanup_hook` insertion failed）。模块缓存必须跨插件实例存活，
 * 因此放在 globalThis，而不是模块作用域。
 */
const runtimeHolder = globalThis as typeof globalThis & {
  __ombOnnxRuntimePromise?: Promise<OnnxRuntimeLike>
}

async function defaultLoadRuntime(): Promise<OnnxRuntimeLike> {
  const specifier = 'onnxruntime-node'
  runtimeHolder.__ombOnnxRuntimePromise ??=
    import(specifier).then(module => module as unknown as OnnxRuntimeLike)
  return runtimeHolder.__ombOnnxRuntimePromise
}

interface SessionHandle {
  readonly session: OnnxSessionLike
  readonly runtime: OnnxRuntimeLike
  readonly tokenizer: WordPieceTokenizer
}

type LoadOutcome =
  | { readonly ok: true; readonly handle: SessionHandle }
  | { readonly ok: false; readonly reason: string }

async function releaseQuietly(session: OnnxSessionLike): Promise<void> {
  try {
    await session.release?.()
  } catch {
    // 释放失败不改变降级结论（进程退出时由宿主回收原生句柄）。
  }
}

/** BGE-small-zh-v1.5 的 ONNX 实现。 */
export class OnnxEmbedder implements Embedder {
  readonly model = BGE_MODEL
  readonly dims = BGE_DIMS

  readonly #options: OnnxEmbedderOptions
  readonly #threads: number
  readonly #batchSize: number
  readonly #maxLength: number
  #load: Promise<LoadOutcome> | undefined
  #outcome: LoadOutcome | undefined
  #closed = false

  constructor(options: OnnxEmbedderOptions = {}) {
    this.#options = options
    this.#threads = positiveInt(options.threads, 2, 'threads')
    this.#batchSize = positiveInt(options.batchSize, DEFAULT_MAX_BATCH, 'batchSize')
    this.#maxLength = positiveInt(options.maxLength, BERT_MAX_LENGTH, 'maxLength')
    if (this.#maxLength < 2) throw new RangeError(`maxLength 必须是 ≥2 的整数，实际：${String(this.#maxLength)}`)
    if (this.#maxLength > BERT_MAX_LENGTH) {
      throw new RangeError(`maxLength 不能超过 BGE 训练长度 ${BERT_MAX_LENGTH}，实际：${String(this.#maxLength)}`)
    }
  }

  /** 装载失败原因；未装载或可用时为 `undefined`。不会触发装载（配合 `available()` 使用）。 */
  unavailableReason(): string | undefined {
    return this.#outcome !== undefined && !this.#outcome.ok ? this.#outcome.reason : undefined
  }

  async available(): Promise<boolean> {
    const outcome = await this.#ensureLoaded()
    return outcome.ok
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const outcome = await this.#ensureLoaded()
    if (!outcome.ok) {
      fail({
        code: 'unsupported',
        message: `嵌入不可用（${this.model}）：${outcome.reason}`,
        details: { model: this.model, dims: this.dims, reason: outcome.reason },
        retryable: false,
      })
    }
    try {
      return await embedBatched(texts, this.#batchSize, batch => this.#forward(outcome.handle, batch))
    } catch (error) {
      fail({
        code: 'internal',
        message: `嵌入推理失败（${this.model}）：${messageOf(error)}`,
        details: { model: this.model, dims: this.dims },
        retryable: true,
      })
    }
  }

  /** 释放原生会话（幂等；之后 `available()` 为 false、`embed()` 抛不可用）。 */
  async close(): Promise<void> {
    this.#closed = true
    const outcome = this.#outcome
    this.#outcome = { ok: false, reason: CLOSED_REASON }
    this.#load = undefined
    if (outcome?.ok === true) await releaseQuietly(outcome.handle.session)
  }

  async #ensureLoaded(): Promise<LoadOutcome> {
    if (this.#closed) return { ok: false, reason: CLOSED_REASON }
    if (this.#outcome !== undefined) return this.#outcome
    if (this.#load === undefined) {
      // 兜底：装载期任何未预期异常都转成"不可用 + 原因"，`available()` 的契约是不抛。
      this.#load = this.#loadModel()
        .catch((error: unknown): LoadOutcome => ({ ok: false, reason: `模型装载异常：${messageOf(error)}` }))
        .then(async outcome => {
          // close() 可能发生在装载进行中：此时会话必须被释放，不能把已关闭的实例复活。
          if (this.#closed) {
            if (outcome.ok) await releaseQuietly(outcome.handle.session)
            const closed: LoadOutcome = { ok: false, reason: CLOSED_REASON }
            this.#outcome = closed
            return closed
          }
          this.#outcome = outcome
          return outcome
        })
    }
    return this.#load
  }

  async #loadModel(): Promise<LoadOutcome> {
    const resolved = resolveModelDir(this.#options)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }

    const vocabPath = this.#options.vocabPath?.trim() || join(resolved.dir, VOCAB_FILE)
    let tokenizer: WordPieceTokenizer
    try {
      tokenizer = WordPieceTokenizer.fromFile(vocabPath, this.#maxLength)
    } catch (error) {
      return { ok: false, reason: `词表装载失败（${vocabPath}）：${messageOf(error)}` }
    }

    const loadRuntime = this.#options.loadRuntime ?? defaultLoadRuntime
    let runtime: OnnxRuntimeLike
    try {
      runtime = await loadRuntime()
    } catch (error) {
      return {
        ok: false,
        reason: `onnxruntime-node 不可加载（optionalDependency 未安装或原生二进制不兼容）：${messageOf(error)}`,
      }
    }

    let session: OnnxSessionLike
    try {
      session = await runtime.InferenceSession.create(resolved.graphPath, {
        intraOpNumThreads: this.#threads,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      })
    } catch (error) {
      return { ok: false, reason: `ONNX 会话创建失败（${resolved.graphPath}）：${messageOf(error)}` }
    }

    const handle: SessionHandle = { session, runtime, tokenizer }
    try {
      const probe = await this.#forward(handle, ['自检'])
      const vector = probe[0]
      if (vector === undefined || vector.length !== this.dims) {
        throw new Error(`自检向量维度异常：期望 ${this.dims}，实际 ${String(vector?.length)}`)
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      if (!Number.isFinite(norm) || norm === 0) throw new Error('自检向量为零向量或含非有限值')
    } catch (error) {
      await releaseQuietly(session)
      return { ok: false, reason: `模型自检失败（${resolved.graphPath}）：${messageOf(error)}` }
    }

    return { ok: true, handle }
  }

  /**
   * 一批文本 → 一批 512 维单位向量。
   *
   * **逐条前向（一次 RUN 只放一个序列）是实测约束，不是保守**：
   * 本仓库的 `model_quantized.onnx` 是动态量化权重，激活的量化 scale 按整张输入张量计算，
   * 于是**同一文本的向量依赖同批其它样本**。实测（intraOpNumThreads=1，重复运行逐位一致）：
   * 同一句单独编码 vs 与另一句凑成 batch=2，`last_hidden_state` 元素差 0.29、池化后余弦 0.992；
   * 换一个邻居（[A,B] vs [A,C]）行 A 的向量也不同。补 PAD 同样会改变真实 token 的隐状态
   * （mask=0 的 padding 实测元素差 0.27）。既然向量要落库并跨调用比较，就必须让
   * "同一文本 → 同一向量" 在任何批组合下成立，因此这里只做单序列前向；
   * `embedBatched` 的 32 条上限只约束每次 `embed` 调用的分块粒度。
   */
  async #forward(handle: SessionHandle, texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = []
    for (const text of texts) vectors.push(await this.#forwardOne(handle, text))
    return vectors
  }

  /** 单序列前向：`input_ids` / `attention_mask` / `token_type_ids` → mean pooling → L2。 */
  async #forwardOne(handle: SessionHandle, text: string): Promise<number[]> {
    const ids = handle.tokenizer.encode(text)
    const length = ids.length
    const inputIds = new BigInt64Array(length)
    // 单序列没有 padding，mask 全 1（它仍是模型必填输入）。
    const attention = new BigInt64Array(length).fill(1n)
    const tokenTypes = new BigInt64Array(length)
    for (let position = 0; position < length; position++) inputIds[position] = BigInt(ids[position] ?? handle.tokenizer.padId)

    const feeds: Record<string, OnnxTensorLike> = {}
    for (const name of handle.session.inputNames) {
      const data = name === 'input_ids' ? inputIds : name === 'attention_mask' ? attention : name === 'token_type_ids' ? tokenTypes : undefined
      if (data === undefined) {
        throw new Error(`模型输入名无法映射：${name}（只支持 input_ids/attention_mask/token_type_ids）`)
      }
      feeds[name] = new handle.runtime.Tensor('int64', data, [1, length])
    }
    if (!handle.session.inputNames.includes('input_ids')) {
      throw new Error(`模型缺少 input_ids 输入（实际：${handle.session.inputNames.join(', ') || '无'}）`)
    }

    const output = await handle.session.run(feeds)
    const hidden = output['last_hidden_state']
    if (hidden === undefined) {
      throw new Error(
        `ONNX 输出缺少 last_hidden_state（实际：${Object.keys(output).join(', ') || '无'}）；` +
          'mean pooling 需要逐 token 隐状态，不能用 sentence_embedding 顶替',
      )
    }
    const dims = hidden.dims
    if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== length || dims[2] !== this.dims) {
      throw new Error(`last_hidden_state 形状不符：期望 [1, ${length}, ${this.dims}]，实际 [${dims.join(', ')}]`)
    }

    const mask = new Uint8Array(length).fill(1)
    return Array.from(meanPoolNormalize(hidden.data, mask, this.dims))
  }
}
