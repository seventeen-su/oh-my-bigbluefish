/**
 * BGE-small-zh-v1.5（ONNX，纯 CPU）嵌入器的**装载**。
 *
 * 三件事被刻意分开，因为它们各自的失败语义不同：
 * ① 模型目录解析（`resolveOnnxModelDir`，**同步**、只看文件系统）——决定"要不要/能不能试"；
 * ② 运行时装载（`onnxruntime-node` 是 **optionalDependency**，动态 import）——缺失就诚实降级；
 * ③ 会话创建 + **自检一次真实前向**——把"跑不通 / 形状不符"挡在装配期，而不是等第一次编码。
 *
 * 诚实降级的口径（规划 §5.7、§8.3）：
 *   - 任一环节失败都返回**可读原因**（`{ok:false, reason}`），调用方回落哈希词袋；
 *   - **绝不静默换语义**：不会"随手找个别的模型顶上"，也不会把 256 维词袋冒充成 512 维语义向量；
 *   - `createOnnxEmbedder` 只回 `null`（便于简单调用），要原因请用 `loadOnnxEmbedder`。
 *
 * 与旧实现（`memory/embeddings-onnx.ts:262-274` 的 `VENDORED_VOCAB` + 硬编码候选路径）的差别：
 *   **数据根由参数注入**（`modelDir` / `dataRoot`），缺省才按
 *   `$OMB_EMBEDDING_MODEL` → `<仓库根>/models/bge-small-zh-v1.5/` 解析，
 *   仓库根是从本模块位置向上找 `package.json` 得到的，不写死任何绝对路径。
 *   词表只在模型目录里找（`vocab.txt`，或用 `vocabPath` 注入），
 *   没有"随仓库分发的那份"这种隐式回退——**降级原因必须指向真正缺的那样东西**。
 *
 * 权重的落盘布局：ONNX 把大权重拆成外部数据文件（`<图名>_data`），且**图文件内部记录的就是该
 * 数据文件名**，所以必须按"图 + 同名前缀数据文件"成对探测，不能改名。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Embedder } from '../../kernel/abi/index.js'

/** 神经嵌入通道的稳定标识（命名口径见 `kernel/abi/ports.ts` 的 `Embedder.id` 注释）。 */
export const BGE_EMBEDDER_ID = 'bge-small-zh-v1.5-512'
/** BGE-small-zh 的输出维度（CLS 池化后 512 维）。 */
export const BGE_DIMENSIONS = 512
/** 模型修订号；换模型/换量化版本时递增，使存量向量按"陈旧"处理而不是被静默复用。 */
export const BGE_REVISION = '1'
/** 默认模型目录名（数据根下的相对路径：`models/bge-small-zh-v1.5`）。 */
export const BGE_MODEL_DIR_NAME = 'bge-small-zh-v1.5'
/** 词表文件名（BERT WordPiece；行号即 token id）。 */
export const VOCAB_FILE = 'vocab.txt'
/** 环境变量：显式指定模型目录（**一旦设置即权威**，解析失败不再回退其他候选）。 */
export const MODEL_DIR_ENV = 'OMB_EMBEDDING_MODEL'

/** 模型文件配对（量化版优先）。 */
export const MODEL_PAIRS = [
  { graph: 'model_quantized.onnx', data: 'model_quantized.onnx_data' },
  { graph: 'model.onnx', data: 'model.onnx_data' },
] as const

/**
 * 余弦下限（实测标定；**只负责砍掉正相关基线，不是相关性判定**）。
 *
 * 实测分布（2026-09，本机真模型，14 组对照）：无关中文对 0.174~0.315，相关对 0.433~0.795，
 * 两类之间有一段清晰空档 → 取空档中点 0.375。
 * 为什么必须有它：稀疏哈希词袋的无关文本余弦落在 0 附近（所以"非正才丢"够用），而**稠密模型
 * 的余弦恒为正**，于是"非正才丢"永不命中，任何查询都返回满额候选池、排序被压平。
 *
 * 为什么是常量而不是 `Embedder.minScore`：ABI 的 `Embedder` 没有这个字段（保持 ABI 冻结），
 * 因此由检索侧显式取用本常量，并在换模型时重新标定。
 */
export const BGE_COSINE_FLOOR = 0.375

// ---------------------------------------------------------------------------
// BERT WordPiece（自实现；只依赖 vocab.txt，不引第二个原生依赖）
// ---------------------------------------------------------------------------

function isWhitespace(c: string): boolean {
  return /\s/u.test(c)
}

/**
 * 控制字符（BERT `_is_control` 口径）。
 * **`\t` / `\n` / `\r` 不算控制符**：HF 对它们显式返回 False，靠 `isspace()` 变成单个空格。
 * 旧实现把它们一并丢弃，于是换行两侧的词被粘成一个 token（`"a\nb"` → `ab`）——切分错但完全不可观测。
 */
function isControl(c: string): boolean {
  if (c === '\t' || c === '\n' || c === '\r') return false
  return /[\u0000-\u001f\u007f-\u009f]/u.test(c)
}

/** ASCII + Unicode 标点（BERT `_is_punctuation`）。 */
function isPunctuation(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true
  }
  return /\p{P}/u.test(c)
}

/** CJK 表意文字（逐字切分；与 BERT `_is_chinese_char` 同区间集合）。 */
function isCjkChar(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

/** 基础清洗：去空字符/替换符/控制符 → 空白折叠为单空格 → 去组合重音（NFD + 去 Mn）。 */
function cleanText(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue
    if (isWhitespace(ch)) {
      out += ' '
      continue
    }
    out += ch.normalize('NFD').replace(/\p{Mn}/gu, '')
  }
  return out
}

/** 单 token 字符上限（与 HF `max_input_chars_per_word` 同口径；本模型 tokenizer 亦为 100）。 */
const MAX_INPUT_CHARS_PER_WORD = 100

/**
 * WordPiece 分词器。
 *
 * 超长 token **必须短路**：贪心最长匹配的内层从串尾往前扫，对长度 n 是 O(n²)；一段 8KB 无空白
 * 文本（压缩代码、base64、超长 URL——记忆正文完全可能是这些）实测能让单次编码阻塞事件循环 40 秒。
 * HF 的阈值是 100 字符，超过即整词判 `[UNK]`，这里照同一口径短路（复杂度降到常数）。
 */
export class WordPieceTokenizer {
  readonly #vocab: Map<string, number>
  readonly clsId: number
  readonly sepId: number
  readonly unkId: number
  readonly padId: number
  /** 最大序列长度（含 [CLS]/[SEP]；BGE 训练长度 512）。 */
  readonly maxLength: number

  constructor(vocab: Map<string, number>, maxLength = 512) {
    this.#vocab = vocab
    this.clsId = vocab.get('[CLS]') ?? 101
    this.sepId = vocab.get('[SEP]') ?? 102
    this.unkId = vocab.get('[UNK]') ?? 100
    this.padId = vocab.get('[PAD]') ?? 0
    this.maxLength = maxLength
  }

  /**
   * 从 `vocab.txt` 装载（行号 = id；CRLF 容错）。
   *
   * **必须校验这是一份可用的 BERT 词表**（含 `[CLS]`/`[SEP]`）：
   * 只查"非空"是不够的——一个被截断成 0 字节或下错文件的词表会安静地装载成功，
   * 之后每条文本都编码成同一个 `[UNK]`，于是**所有向量完全相同**、
   * 向量通道看起来在工作而实际毫无区分力。这类静默失效正是本重构要消灭的。
   */
  static fromFile(file: string, maxLength = 512): WordPieceTokenizer {
    const raw = readFileSync(file, 'utf8')
    const vocab = new Map<string, number>()
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const token = (lines[i] ?? '').replace(/\r$/, '')
      if (token.length === 0 && i !== 0) continue // 首行可能是空 token，其余空行跳过
      if (!vocab.has(token)) vocab.set(token, i)
    }
    if (vocab.size === 0 || !vocab.has('[CLS]') || !vocab.has('[SEP]')) {
      throw new Error(
        `不是可用的 BERT 词表（${file}）：${vocab.size === 0 ? '文件为空' : '缺少 [CLS]/[SEP]'}——` +
          '请确认 vocab.txt 与权重同源且完整',
      )
    }
    return new WordPieceTokenizer(vocab, maxLength)
  }

  /** 基础切分：CJK 逐字、标点独立成 token、其余按空白并小写。 */
  #basicTokens(text: string): string[] {
    const out: string[] = []
    let buf = ''
    const flush = (): void => {
      if (buf.length > 0) {
        out.push(buf)
        buf = ''
      }
    }
    for (const ch of text) {
      if (isWhitespace(ch)) {
        flush()
        continue
      }
      if (isCjkChar(ch) || isPunctuation(ch)) {
        flush()
        out.push(ch)
        continue
      }
      buf += ch.toLowerCase()
    }
    flush()
    return out
  }

  /** 贪心最长匹配；整词不可分 → `[UNK]`。 */
  #wordPiece(token: string): number[] {
    if (token.length > MAX_INPUT_CHARS_PER_WORD) return [this.unkId]
    const ids: number[] = []
    let start = 0
    while (start < token.length) {
      let end = token.length
      let matched: number | undefined
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + token.slice(start, end)
        const id = this.#vocab.get(piece)
        if (id !== undefined) {
          matched = id
          break
        }
        end--
      }
      if (matched === undefined) return [this.unkId]
      ids.push(matched)
      start = end
    }
    return ids
  }

  /** 文本 → token id（含 [CLS]/[SEP]；超长按 maxLength 截断）。 */
  encode(text: string): number[] {
    const ids: number[] = [this.clsId]
    for (const token of this.#basicTokens(cleanText(text))) {
      for (const id of this.#wordPiece(token)) {
        ids.push(id)
        if (ids.length >= this.maxLength - 1) break
      }
      if (ids.length >= this.maxLength - 1) break
    }
    ids.push(this.sepId)
    return ids
  }
}

// ---------------------------------------------------------------------------
// 模型目录解析（同步；只做文件系统探测）
// ---------------------------------------------------------------------------

export interface OnnxModelDirOptions {
  /** 显式模型目录（**权威**：不存在即失败，不回退其他候选）。 */
  readonly modelDir?: string
  /** 数据根：模型目录按 `<dataRoot>/models/bge-small-zh-v1.5` 解析。 */
  readonly dataRoot?: string
  /** 环境变量来源（测试注入；缺省 `process.env`）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 模块位置（仓库根解析用；测试注入；缺省 `import.meta.url`）。 */
  readonly moduleUrl?: string
}

export type OnnxModelDirResolution =
  | { readonly ok: true; readonly dir: string; readonly graph: string; readonly data: string }
  | { readonly ok: false; readonly reason: string }

/** 从模块位置向上找最近的含 `package.json` 的目录（**不写死绝对路径**）。 */
export function findRepoRoot(moduleUrl: string = import.meta.url): string | null {
  let dir: string
  try {
    dir = dirname(fileURLToPath(moduleUrl))
  } catch {
    return null
  }
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function pairIn(dir: string): { graph: string; data: string } | null {
  for (const pair of MODEL_PAIRS) {
    try {
      if (existsSync(join(dir, pair.graph)) && existsSync(join(dir, pair.data))) {
        return { graph: pair.graph, data: pair.data }
      }
    } catch {
      // 探测失败 → 试下一组
    }
  }
  return null
}

function describePairRequirement(): string {
  return MODEL_PAIRS.map((p) => `${p.graph} + ${p.data}`).join(' 或 ')
}

function checkDir(dir: string, source: string): OnnxModelDirResolution {
  if (!existsSync(dir)) {
    return { ok: false, reason: `权重目录不存在：${dir}（来源：${source}）` }
  }
  const pair = pairIn(dir)
  if (pair === null) {
    return {
      ok: false,
      reason: `权重目录内缺少「图 + 同名前缀外部权重」配对：${dir}（已试：${describePairRequirement()}）`,
    }
  }
  return { ok: true, dir, graph: pair.graph, data: pair.data }
}

/**
 * 解析模型目录。顺序：
 * ① `modelDir` 参数（权威）② `$OMB_EMBEDDING_MODEL`（权威）③ `<dataRoot>/models/bge-small-zh-v1.5`
 * ④ `<仓库根>/models/bge-small-zh-v1.5`
 *
 * ① ② 一旦给出就是**权威**：指向坏目录时直接返回原因，不再回退——显式意图被静默覆盖会让
 * "我明明配了模型却不生效"变成无从排查的问题。
 */
export function resolveOnnxModelDir(options: OnnxModelDirOptions = {}): OnnxModelDirResolution {
  const env = options.env ?? process.env
  const explicit = options.modelDir?.trim()
  if (explicit !== undefined && explicit.length > 0) return checkDir(explicit, 'modelDir 参数')

  const fromEnv = env[MODEL_DIR_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return checkDir(fromEnv, `$${MODEL_DIR_ENV}`)

  const candidates: { dir: string; source: string }[] = []
  const dataRoot = options.dataRoot?.trim()
  if (dataRoot !== undefined && dataRoot.length > 0) {
    candidates.push({ dir: join(dataRoot, 'models', BGE_MODEL_DIR_NAME), source: 'dataRoot 参数' })
  }
  const repoRoot = findRepoRoot(options.moduleUrl ?? import.meta.url)
  if (repoRoot !== null) {
    candidates.push({ dir: join(repoRoot, 'models', BGE_MODEL_DIR_NAME), source: '仓库根 models/' })
  }

  const tried: string[] = []
  let specific: string | null = null
  for (const candidate of candidates) {
    tried.push(candidate.dir)
    const verdict = checkDir(candidate.dir, candidate.source)
    if (verdict.ok) return verdict
    // 目录存在但内容不对 → 记住最具体的那条原因（比"都没找到"更有行动价值）
    if (specific === null && existsSync(candidate.dir)) specific = verdict.reason
  }
  if (specific !== null) return { ok: false, reason: specific }
  return {
    ok: false,
    reason:
      `权重目录不存在（已试：${tried.length > 0 ? tried.join(' / ') : '无候选'}）；` +
      `可用 ${MODEL_DIR_ENV} 指定，或把模型放到 <数据根>/models/${BGE_MODEL_DIR_NAME}/` +
      `（目录内需有 ${describePairRequirement()} 与 ${VOCAB_FILE}）`,
  }
}

/** 模型目录已落盘的字节数（状态面用：确认权重真的在盘上）。找不到配对 → 0。 */
export function modelDirBytes(dir: string): number {
  const pair = pairIn(dir)
  if (pair === null) return 0
  let total = 0
  for (const name of [pair.graph, pair.data, VOCAB_FILE]) {
    try {
      total += statSync(join(dir, name)).size
    } catch {
      // 缺失 → 不计
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// 运行时（动态 import；缺失 → 降级）
// ---------------------------------------------------------------------------

/** ONNX 张量的最小结构面。 */
export interface OnnxTensorLike {
  readonly data: Float32Array
  readonly dims: readonly number[]
}

/** ONNX 会话的最小结构面。`release` 可选（接口按结构面定义，不引包）。 */
export interface OnnxSessionLike {
  readonly inputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorLike>>
  release?(): Promise<void>
}

/** `onnxruntime-node` 的最小结构面。 */
export interface OnnxRuntimeLike {
  readonly InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OnnxSessionLike>
  }
  readonly Tensor: new (type: string, data: BigInt64Array, dims: readonly number[]) => unknown
}

export type OnnxRuntimeLoader = () => Promise<OnnxRuntimeLike>

/**
 * 默认运行时加载器：动态 import（**非字面量说明符是故意的**）。
 *
 * `onnxruntime-node` 是 optionalDependency（解包数百 MB，只想用哈希词袋的部署不装它）。
 * 一旦写成字面量 `import('onnxruntime-node')`，`tsc` 会在**构建期**尝试解析它，未安装即 TS2307
 * ——那等于把"可选"变成"必须安装才能构建"，而本模块的全部设计前提是"运行时缺失就诚实降级"。
 * 用变量拼接可让 tsc 不解析（模块类型由上面的结构面承担）。
 */
async function defaultLoadRuntime(): Promise<OnnxRuntimeLike> {
  const specifier = 'onnxruntime-node'
  return (await import(specifier)) as unknown as OnnxRuntimeLike
}

// ---------------------------------------------------------------------------
// 装载
// ---------------------------------------------------------------------------

export interface OnnxEmbedderOptions extends OnnxModelDirOptions {
  /** 推理线程数（默认 2：单条毫秒级；调大会抢主对话的 CPU）。 */
  readonly threads?: number
  /** 期望维度（例如库内 `meta.embedding_dim`）：模型输出与之不符 → **拒绝装载**。 */
  readonly expectedDimensions?: number
  /** 词表路径（缺省 `<modelDir>/vocab.txt`）。 */
  readonly vocabPath?: string
  /** 注入运行时加载器（测试用 fake；缺省动态 import `onnxruntime-node`）。 */
  readonly loadRuntime?: OnnxRuntimeLoader
  /** 装载失败原因的出口（可选）。`loadOnnxEmbedder` 的联合类型本身就带回原因。 */
  readonly onUnavailable?: (reason: string) => void
}

export type OnnxLoad =
  | { readonly ok: true; readonly embedder: Embedder; readonly modelDir: string }
  | { readonly ok: false; readonly reason: string }

/** L2 归一化（原地；零向量原样返回）。 */
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0)
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm
  }
  return vec
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 装载 BGE-small-zh ONNX 嵌入器（异步一次：运行时 + 词表 + 会话 + 自检）。
 *
 * **不抛**：任何失败都返回 `{ok:false, reason}`，调用方回落哈希词袋并如实记录原因。
 */
export async function loadOnnxEmbedder(options: OnnxEmbedderOptions = {}): Promise<OnnxLoad> {
  const fail = (reason: string): OnnxLoad => {
    try {
      options.onUnavailable?.(reason)
    } catch {
      // 原因出口自己抛异常不得改变装载结论
    }
    return { ok: false, reason }
  }

  const resolved = resolveOnnxModelDir(options)
  if (!resolved.ok) return fail(resolved.reason)
  const modelDir = resolved.dir

  const vocabPath = options.vocabPath?.trim() || join(modelDir, VOCAB_FILE)
  if (!existsSync(vocabPath)) {
    return fail(
      `词表缺失：${vocabPath}（${VOCAB_FILE} 应与权重同目录，或用 vocabPath 指定）`,
    )
  }
  let tokenizer: WordPieceTokenizer
  try {
    tokenizer = WordPieceTokenizer.fromFile(vocabPath)
  } catch (error) {
    return fail(`词表装载失败（${vocabPath}）：${messageOf(error)}`)
  }

  const loadRuntime = options.loadRuntime ?? defaultLoadRuntime
  let runtime: OnnxRuntimeLike
  try {
    runtime = await loadRuntime()
  } catch (error) {
    return fail(
      `onnxruntime-node 不可加载（optionalDependency 未安装，或原生二进制不兼容）：${messageOf(error)}`,
    )
  }

  let session: OnnxSessionLike
  try {
    session = await runtime.InferenceSession.create(join(modelDir, resolved.graph), {
      intraOpNumThreads: Math.max(1, Math.floor(options.threads ?? 2)),
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    })
  } catch (error) {
    return fail(`ONNX 会话创建失败（${join(modelDir, resolved.graph)}）：${messageOf(error)}`)
  }

  /**
   * 单条前向：分词 → 张量 → 输出向量（**原始维度，未归一化**）。
   * 池化：`sentence_embedding` 已是 `[1, dim]`（池化在模型内完成）；`last_hidden_state` 是
   * `[1, len, dim]`，其第 0 行即 CLS 位置——BGE 的句向量口径就是 CLS，故两种情况都取前 dim 个数。
   */
  const forward = async (text: string): Promise<Float32Array> => {
    const ids = tokenizer.encode(text)
    const len = ids.length
    const idsBuf = BigInt64Array.from(ids, (x) => BigInt(x))
    const mask = new BigInt64Array(len).fill(1n)
    const types = new BigInt64Array(len)
    const feeds: Record<string, unknown> = {}
    for (const name of session.inputNames) {
      const data = name === 'attention_mask' ? mask : name === 'token_type_ids' ? types : idsBuf
      feeds[name] = new runtime.Tensor('int64', data, [1, len])
    }
    const out = await session.run(feeds)
    const preferred = out['sentence_embedding'] ?? out['last_hidden_state']
    if (preferred === undefined) {
      throw new Error(`ONNX 输出缺少 sentence_embedding/last_hidden_state（实际：${Object.keys(out).join(',')}）`)
    }
    const dim = preferred.dims[preferred.dims.length - 1] ?? 0
    const vec = new Float32Array(dim)
    for (let i = 0; i < dim; i++) vec[i] = preferred.data[i] ?? 0
    return vec
  }

  // 自检一次真实前向（代价约 2ms）：把"跑不通 / 形状不符"挡在装配期，而不是等第一次编码才发现。
  let sessionDim: number
  try {
    sessionDim = (await forward('自检')).length
  } catch (error) {
    // 自检失败 → 这个会话不会被接管 → 主动释放，否则原生会话与线程池会随进程存活。
    await releaseQuietly(session)
    return fail(`模型自检失败（${messageOf(error)}）`)
  }

  // 维度不符一律**拒绝装载**（绝不静默产出错维向量）：维度即通道契约，错维会在检索侧被当成
  // 陈旧向量跳过，静默降级比报错更难查。
  if (sessionDim !== BGE_DIMENSIONS) {
    await releaseQuietly(session)
    return fail(
      `维度不匹配：模型输出 ${sessionDim}，本嵌入器预期 ${BGE_DIMENSIONS}` +
        `（${BGE_EMBEDDER_ID} 只装载 BGE-small-zh-v1.5）`,
    )
  }
  if (options.expectedDimensions !== undefined && options.expectedDimensions !== sessionDim) {
    await releaseQuietly(session)
    return fail(
      `维度不匹配：库内 ${options.expectedDimensions}，模型输出 ${sessionDim}` +
        `（不可比较；需重编码或换回原嵌入器）`,
    )
  }

  /** 编码一条（归一化后即为余弦可用的句向量）。 */
  const embedOne = async (text: string): Promise<Float32Array> => {
    const vec = await forward(text)
    if (vec.length !== sessionDim) {
      throw new Error(`ONNX 输出维度漂移：${vec.length} ≠ 自检时的 ${sessionDim}`)
    }
    return l2Normalize(vec)
  }

  const embedder: Embedder = {
    id: BGE_EMBEDDER_ID,
    dimensions: BGE_DIMENSIONS,
    revision: BGE_REVISION,
    async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
      // 逐条前向（不做 padding 批处理）：序列长度可变，批处理要么补 PAD（改变 attention 语义的
      // 风险）要么把形状搞复杂；当前规模下"一条一个前向"最不容易出错，且实测毫秒级。
      const out: Float32Array[] = []
      for (const text of texts) out.push(await embedOne(text))
      return out
    },
  }
  return { ok: true, embedder, modelDir }
}

async function releaseQuietly(session: OnnxSessionLike): Promise<void> {
  try {
    await session.release?.()
  } catch {
    // 释放失败不影响降级结论（进程退出时由宿主回收）
  }
}

/**
 * 装载嵌入器；**不可用返回 `null`**（便于 `?? hashBagEmbedder()` 这样的调用）。
 *
 * `null` 本身不携带原因——需要原因（状态面/健康）时请调用 `loadOnnxEmbedder`，
 * 或传 `onUnavailable` 回调。
 */
export async function createOnnxEmbedder(options: OnnxEmbedderOptions = {}): Promise<Embedder | null> {
  const loaded = await loadOnnxEmbedder(options)
  return loaded.ok ? loaded.embedder : null
}
