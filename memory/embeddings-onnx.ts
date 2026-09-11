// layer 2（memory/）：中文小嵌入模型（BGE-small-zh-v1.5，ONNX 量化版）——已知问题《小向量模型未接入》落地。
//
// 目标（设计原意）：小中文嵌入模型、**纯 CPU、不占显卡**、零模型调用；取代"零依赖替代品"
// （哈希词袋）作为**默认**向量通道，真正具备语义召回（同义改写、跨语言）。
//
// 依赖与自包含（用户裁决：允许新增依赖，但要"优化依赖"）：
//   - 运行时 = `onnxruntime-node`（**预编译二进制**，自带 win32/linux/darwin × x64/arm64，无需 C++ 工具链；
//     它同时是 `@huggingface/transformers` 的依赖，即"本来就要装的那一份"，不引入第二套原生栈）；
//   - 分词器 = **本文件自实现**的 BERT WordPiece（BGE 用的就是它）：只读一个 `vocab.txt`（107KB）。
//     代价对比：引入 `@huggingface/transformers` 会连带 `sharp`（图像库，本场景完全用不到）——
//     自实现分词（约 120 行）换掉一个重型依赖，这是这里"优化依赖"的具体含义；
//   - 模型权重 = 外部文件（量化版约 23MB），**不进仓库**：按 `OMB_EMBEDDING_MODEL` → 数据根 models/ →
//     常见缓存目录的顺序查找；缺失即**诚实降级**到哈希词袋并给出可读原因（绝不静默换语义）。
//
// 形态说明（为什么是线程池 + 串行化）：
//   `onnxruntime-node` 的 `run` 返回 Promise，但其原生绑定是"同步执行 + Promise 外壳"（实测：调用返回
//   0.02ms、settle 7–8ms，期间事件循环不推进）。也就是说每次 embed 都会**阻塞事件循环**约 1–8ms
//   （取决于序列长度与线程数）。这一点无法回避；能控制的是**别把它放进同步热路径**：
//   编码统一走空闲期批量任务（`encodePendingBatch`），写入路径只做"标脏待编码"。
//
// 维度变化（256 → 512）：换嵌入器会让存量向量维度不匹配，`vectorStats().mismatched` 会如实暴露
//   条数，维护任务 `memory_vector_encode` 逐批重编码补齐；检索侧跳过异维行（不报错、不静默错算）。
import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Embedder } from './embeddings.js';

/** 嵌入器标识（状态面/审计可读；与 `Embedder.id` 同值） */
export const BGE_SMALL_ZH_ID = 'bge-small-zh-v1.5-onnx';
/** BGE-small-zh 的输出维度（CLS 池化后 512 维） */
export const BGE_SMALL_ZH_DIM = 512;

/**
 * 候选下限（余弦）：低于此值不算向量命中。
 *
 * 实测分布（2026-09，本机真模型，14 组对照）：
 *   - **无关**中文对：0.174 ~ 0.315（上沿 0.3147）
 *   - **相关**对（同义改写 0.795；跨语言 0.433 ~ 0.592）：下沿 0.4333
 * 即两类之间存在一段清晰空档（0.315 ~ 0.433），阈值取空档中点最稳。
 *
 * 为什么必须有它：检索侧原先的判据是"`score <= 0` 才丢"——那是按稀疏哈希词袋标定的
 *（无关文本落在 0 附近或负值）。稠密模型的余弦**恒为正**，于是该判据永不命中：任何查询都返回
 * 满额候选池，无关记忆被稳定塞进注入预算，价值模型的"向量命中"分量在所有候选上趋于恒定、排序被压平。
 *
 * 取 0.375（= 空档中点）：到无关带上沿留 0.06 余量、到相关带下沿留 0.058 余量，两侧等距。
 * **它只负责砍掉正相关基线，不是"相关性判定"**——阈值之上的实际余弦大小仍照常参与排序。
 *
 * 校准过程本身也留在测试里（`tests/m3/embeddings-onnx.test.ts` 断言"无关 < 下限 < 相关"），
 * 换模型或换版本时该断言会先把"下限失效"暴露出来，而不是悄悄漏召回。
 */
export const BGE_MIN_SCORE = 0.375;

// ---------------------------------------------------------------------------
// BERT WordPiece 分词（自实现；只依赖 vocab.txt）
// ---------------------------------------------------------------------------

/** 空白 */
function isWhitespace(c: string): boolean {
  return /\s/u.test(c);
}
/**
 * 控制字符（BERT 的 `_is_control` 口径）。
 * **`\t` / `\n` / `\r` 不算控制符**——HF 的 `_is_control` 对它们显式返回 False，靠 `isspace()` 变成
 * 单个空格。此前本实现把它们一并判为控制符**直接丢弃**，于是换行两侧的 token 被粘成一个词
 *（`"a\nb"` → `ab`），与模型训练时的切分口径不一致；本仓记忆正文大量是多行文本，影响面很广
 * 且完全不可观测（不是 OOV，是切分错）。
 */
function isControl(c: string): boolean {
  if (c === '\t' || c === '\n' || c === '\r') {
    return false;
  }
  return /[\u0000-\u001f\u007f-\u009f]/u.test(c);
}
/** ASCII 标点 + Unicode 标点（BERT 的 _is_punctuation：ASCII 区间 + P* 类） */
function isPunctuation(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true;
  }
  return /\p{P}/u.test(c);
}
/** CJK 表意文字（逐字切分；与 BERT 的 _is_chinese_char 同区间集合） */
function isCjk(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/**
 * BERT 基础清洗（与 HF BertTokenizer.do_lower_case=true 的 BasicTokenizer 对齐）：
 * 去空字符/替换符/控制符 → 空白折叠为单空格 → 去组合重音（NFD + 去 Mn）。
 */
function cleanText(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
    if (isWhitespace(ch)) {
      out += ' ';
      continue;
    }
    out += ch.normalize('NFD').replace(/\p{Mn}/gu, '');
  }
  return out;
}

/** WordPiece 单 token 上限（与 HF `max_input_chars_per_word` 同口径；本模型 tokenizer.json 亦为 100） */
const MAX_INPUT_CHARS_PER_WORD = 100;

/** WordPiece 分词器（vocab.txt：一行一个 token，行号即 id） */
export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  readonly clsId: number;
  readonly sepId: number;
  readonly unkId: number;
  readonly padId: number;
  /** 最大序列长度（含 [CLS]/[SEP]；BGE 训练长度 512） */
  readonly maxLength: number;

  constructor(vocab: Map<string, number>, maxLength = 512) {
    this.vocab = vocab;
    this.clsId = vocab.get('[CLS]') ?? 101;
    this.sepId = vocab.get('[SEP]') ?? 102;
    this.unkId = vocab.get('[UNK]') ?? 100;
    this.padId = vocab.get('[PAD]') ?? 0;
    this.maxLength = maxLength;
  }

  /** 从 vocab.txt 装载（行号 = id；CRLF 容错） */
  static fromFile(file: string, maxLength = 512): WordPieceTokenizer {
    const raw = readFileSync(file, 'utf8');
    const vocab = new Map<string, number>();
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const token = (lines[i] ?? '').replace(/\r$/, '');
      if (token.length === 0 && i !== 0) continue; // 空行跳过（首行反而可能是空 token）
      if (!vocab.has(token)) vocab.set(token, i);
    }
    if (vocab.size === 0) {
      throw new Error(`WordPieceTokenizer: 词表为空（${file}）`);
    }
    return new WordPieceTokenizer(vocab, maxLength);
  }

  /** 基础切分：CJK 逐字、标点独立成 token、其余按空白并小写 */
  private basicTokens(text: string): string[] {
    const out: string[] = [];
    let buf = '';
    const flush = (): void => {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
    };
    for (const ch of text) {
      if (isWhitespace(ch)) {
        flush();
        continue;
      }
      if (isCjk(ch) || isPunctuation(ch)) {
        flush();
        out.push(ch);
        continue;
      }
      buf += ch.toLowerCase();
    }
    flush();
    return out;
  }

  /**
   * greedy longest-match WordPiece；整词不可分 → [UNK]。
   *
   * **超长 token 必须短路**（真机实测的灾难级缺陷）：内层从串尾往前扫，对长度 n 的 token 是 O(n²)
   * 且每步都 `slice`+字符串拼接。一段 8KB 的**无空白**文本（压缩过的代码、长 base64、超长 URL 或
   * 哈希行——记忆正文完全可能是这些）实测让单次 encode 阻塞事件循环 **40 秒**；而 `mergeMemories`
   * 是在**写事务内**调用编码的 → 写事务与 WAL 一起挂住。
   * HF 的 WordPiece 对这种情况有 `max_input_chars_per_word = 100`（本模型 tokenizer.json 里就是 100），
   * 超过即整词判 [UNK]。这里照同一口径短路，复杂度降到常数。
   */
  private wordPiece(token: string): number[] {
    if (token.length > MAX_INPUT_CHARS_PER_WORD) {
      return [this.unkId];
    }
    const ids: number[] = [];
    let start = 0;
    while (start < token.length) {
      let end = token.length;
      let matched: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + token.slice(start, end);
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          matched = id;
          break;
        }
        end--;
      }
      if (matched === undefined) {
        return [this.unkId];
      }
      ids.push(matched);
      start = end;
    }
    return ids;
  }

  /** 文本 → token id 序列（含 [CLS]/[SEP]；超长按 maxLength 截断） */
  encode(text: string): number[] {
    const ids: number[] = [this.clsId];
    for (const token of this.basicTokens(cleanText(text))) {
      for (const id of this.wordPiece(token)) {
        ids.push(id);
        if (ids.length >= this.maxLength - 1) break;
      }
      if (ids.length >= this.maxLength - 1) break;
    }
    ids.push(this.sepId);
    return ids;
  }
}

// ---------------------------------------------------------------------------
// 模型查找与装配
// ---------------------------------------------------------------------------

/**
 * 模型文件布局：ONNX 大模型把权重拆成外部数据文件（`<图文件名>_data`），且**图文件内部记录的
 * 就是该数据文件名**（`External data path`）——所以落盘时**必须保持上游文件名配对**，
 * 不能把 `model_quantized.onnx_data` 改名成 `model.onnx_data`（改名会让 ORT 找不到权重）。
 * 因此这里按"图 + 同名前缀的数据文件"成对探测，兼容量化版与 fp32 版。
 */
export const MODEL_PAIRS = [
  { graph: 'model_quantized.onnx', data: 'model_quantized.onnx_data' },
  { graph: 'model.onnx', data: 'model.onnx_data' },
] as const;

/** 词表文件名（模型目录内可选；缺失 → 回落随仓库分发的那份） */
export const VOCAB_FILE = 'vocab.txt';

/**
 * 词表的候选位置（按顺序探测，取第一个存在的）。
 *
 * 为什么是候选表而不是单一路径：模块有两种布局，`import.meta.url` 在两种布局下指向不同深度——
 *   - 源码布局：`<preset>/memory/embeddings-onnx.ts` → 同级 `./bge-small-zh/vocab.txt`；
 *   - 编译布局：`<preset>/lib/memory/embeddings-onnx.js` → 词表**不在 lib/ 下**，而在
 *     `<preset>/memory/bge-small-zh/vocab.txt`（`../../` 退回 preset 根再进 memory）。
 *
 * 真实事故：`tsc` 不会把 `.txt` 搬进 `lib/`，而插件入口是编译产物 → 单一路径在**生产部署**里
 * 必然不存在 → 分词器装载抛 ENOENT → 神经嵌入永久回落哈希词袋，降级原因还写成"词表装载失败"
 *（把"打包丢了资产"误报成"模型资产有问题"）。修复分两层：`pnpm build` 现在会同步资产
 *（`scripts/copy-assets.ts`），本候选表则保证**即使资产没同步**也能从仓库真实位置找到词表。
 */
export function vocabCandidates(): string[] {
  return [
    fileURLToPath(new URL('./bge-small-zh/vocab.txt', import.meta.url)), // 源码布局
    fileURLToPath(new URL('../../memory/bge-small-zh/vocab.txt', import.meta.url)), // 编译布局（lib/ 下）
  ];
}

/**
 * 随仓库分发的词表（`memory/bge-small-zh/vocab.txt`，21128 行 / 107KB，MIT）。
 * 权重（约 23MB 量化）**不进仓库**（体积 + git 不适配大二进制），由 `pnpm fetch-embedding-model` 落到数据根。
 * 取第一个真实存在的候选（见 vocabCandidates）；都不在时回落到源码布局路径，让报错信息指向最可能的位置。
 */
export const VENDORED_VOCAB = vocabCandidates().find((p) => existsSync(p)) ?? vocabCandidates()[0]!;

/**
 * 解析词表路径：优先模型目录内的（与权重同源，最可靠）→ 回落到随仓库分发的那份。
 * 这样即便权重还没下载，分词器也能独立自检（部署前就能验分词正确性）。
 * 两端都不存在 → 抛错并把**所有**尝试过的路径列出来（排障不必猜布局）。
 */
export function resolveVocabPath(modelDir: string): string {
  const inModel = join(modelDir, VOCAB_FILE);
  if (existsSync(inModel)) {
    return inModel;
  }
  const candidate = vocabCandidates().find((p) => existsSync(p));
  if (candidate !== undefined) {
    return candidate;
  }
  throw new Error(
    `未找到词表 ${VOCAB_FILE}：模型目录 ${modelDir} 内没有，随仓库分发的位置也不存在` +
      `（已试：${vocabCandidates().join(' / ')}）——` +
      '源码布局下应为 memory/bge-small-zh/vocab.txt；编译布局请确认 pnpm build 同步了资产',
  );
}

/** 在目录内找一组可用的（图 + 外部权重）配对；找不到 → null */
export function resolveModelPair(dir: string): { graph: string; data: string } | null {
  for (const pair of MODEL_PAIRS) {
    try {
      if (existsSync(join(dir, pair.graph)) && existsSync(join(dir, pair.data))) {
        return pair;
      }
    } catch {
      // 探测失败 → 试下一组
    }
  }
  return null;
}

/** 模型目录探测顺序（先环境变量，再数据根，再常见缓存；都不存在 → null） */
export function findModelDir(opts: { explicit?: string; dataRoot?: string; extra?: readonly string[] } = {}): string | null {
  const candidates: string[] = [];
  if (opts.explicit !== undefined && opts.explicit.length > 0) candidates.push(opts.explicit);
  const fromEnv = process.env.OMB_EMBEDDING_MODEL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) candidates.push(fromEnv);
  if (opts.dataRoot !== undefined && opts.dataRoot.length > 0) {
    candidates.push(join(opts.dataRoot, 'models', 'bge-small-zh-v1.5'));
  }
  for (const extra of opts.extra ?? []) candidates.push(extra);
  for (const dir of candidates) {
    if (resolveModelPair(dir) !== null) {
      return dir;
    }
  }
  return null;
}

/** ONNX Runtime 的最小结构面（动态 import；缺失/不兼容 → 降级到哈希词袋） */
interface OrtLike {
  InferenceSession: {
    create(path: string, opts?: Record<string, unknown>): Promise<OrtSessionLike>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: readonly number[]) => unknown;
}

interface OrtSessionLike {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  /**
   * 释放原生会话与其线程池（onnxruntime-node 的 `InferenceSession.release`）。
   * 可选：接口按结构面定义（不引包），旧版本/形状变化时缺失 → 跳过释放而不是崩。
   * **必须有这个出口**：装载自检失败时若不放掉会话，原生资源会随进程存活（装配侧只在 ok:true
   * 时接管嵌入器 → 失败分支的会话成孤儿，且它已占住线程池）。
   */
  release?(): Promise<void>;
}

/** 嵌入器装载结果（诚实降级：失败 → 原因可读，调用方回落到哈希词袋） */
export type OnnxEmbedderLoad =
  | { ok: true; embedder: Embedder; modelDir: string }
  | { ok: false; reason: string };

/** L2 归一化（原地；零向量原样返回） */
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  }
  return vec;
}

/**
 * 装载 BGE-small-zh ONNX 嵌入器（**异步一次**：会话创建 + 词表装载）。
 * 失败一律返回 `{ok:false, reason}`（不抛）——装配面据此降级并如实记录，绝不静默换语义。
 *
 * @param opts.modelDir 显式模型目录（缺省按 findModelDir 探测）
 * @param opts.threads 推理线程数（缺省 2：单条 1.5ms 量级；调大可并行但会抢主对话的 CPU）
 */
export async function loadOnnxEmbedder(
  opts: { modelDir?: string; dataRoot?: string; threads?: number } = {},
): Promise<OnnxEmbedderLoad> {
  const modelDir = findModelDir({ explicit: opts.modelDir, dataRoot: opts.dataRoot });
  if (modelDir === null) {
    return {
      ok: false,
      reason:
        '未找到模型目录（需含一组「图 + 同名前缀的外部权重」配对，例如 ' +
        `${MODEL_PAIRS[0].graph} + ${MODEL_PAIRS[0].data}；词表可选，缺失时用随仓库分发的那份）——` +
        '可用 OMB_EMBEDDING_MODEL 指定，或放到 <数据根>/models/bge-small-zh-v1.5/',
    };
  }
  let ort: OrtLike;
  try {
    // **非字面量说明符**（故意的，不要"优化"成 `import('onnxruntime-node')`）：
    // onnxruntime-node 是 optionalDependency（解包约 296MB，只想用哈希词袋的部署不装它）。
    // 一旦写成字面量，`tsc` 会在**构建期**尝试解析它，未安装即报 TS2307 → 构建失败——
    // 那等于把一个"可选"依赖变成了"必须安装才能构建"。而本模块的整个设计前提是"运行时缺失就
    // 诚实降级"。用变量拼接可让 tsc 不解析（模块类型由本文件的 OrtLike 结构面承担），
    // 运行时若真缺失，下面的 catch 会给出可读原因。
    const pkg = 'onnxruntime-node';
    ort = (await import(pkg)) as unknown as OrtLike;
  } catch (err) {
    return { ok: false, reason: `onnxruntime-node 不可加载（${(err as Error).message}）` };
  }
  let tokenizer: WordPieceTokenizer;
  try {
    tokenizer = WordPieceTokenizer.fromFile(resolveVocabPath(modelDir));
  } catch (err) {
    return { ok: false, reason: `词表装载失败（${(err as Error).message}）` };
  }
  let session: OrtSessionLike;
  const pair = resolveModelPair(modelDir);
  if (pair === null) {
    return { ok: false, reason: `模型目录内找不到可用的（图 + 外部权重）配对：${modelDir}` };
  }
  try {
    session = await ort.InferenceSession.create(join(modelDir, pair.graph), {
      intraOpNumThreads: Math.max(1, Math.floor(opts.threads ?? 2)),
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    return { ok: false, reason: `ONNX 会话创建失败（${(err as Error).message}）` };
  }
  /**
   * 单条编码（分词 → 前向 → 取句向量 → L2 归一化）。
   * 维度不符一律**抛错**（绝不静默产出错维向量）：向量列的维度即通道契约，错维会在检索侧被当成
   * "陈旧向量"跳掉，静默降级比报错更难查。
   */
  const embed = async (text: string): Promise<Float32Array> => {
    const ids = tokenizer.encode(text);
    const len = ids.length;
    const idsBuf = BigInt64Array.from(ids, (x) => BigInt(x));
    const mask = BigInt64Array.from({ length: len }, () => 1n);
    const types = new BigInt64Array(len);
    const feeds: Record<string, unknown> = {};
    for (const name of session.inputNames) {
      // 按名字喂：input_ids / attention_mask / token_type_ids（形状由模型声明决定）
      const data = name === 'attention_mask' ? mask : name === 'token_type_ids' ? types : idsBuf;
      feeds[name] = new ort.Tensor('int64', data, [1, len]);
    }
    const out = await session.run(feeds);
    const preferred = out['sentence_embedding'] ?? out['last_hidden_state'];
    if (preferred === undefined) {
      throw new Error(`ONNX 输出缺少 sentence_embedding/last_hidden_state（实际：${Object.keys(out).join(',')}）`);
    }
    const data = preferred.data;
    const dim = preferred.dims[preferred.dims.length - 1] ?? 0;
    if (dim !== BGE_SMALL_ZH_DIM) {
      throw new Error(`ONNX 输出维度 ${dim} ≠ 预期 ${BGE_SMALL_ZH_DIM}（模型与嵌入器标识不匹配）`);
    }
    // sentence_embedding 已是 [1, dim]（CLS 池化在模型内完成）；last_hidden_state 是 [1, len, dim] → 取 CLS 行
    const vec = new Float32Array(dim);
    for (let i = 0; i < dim; i++) vec[i] = data[i] ?? 0;
    return l2Normalize(vec);
  };

  // 自检一次（真实前向，代价 ~2ms）：把"模型跑不通/形状不符"挡在装配期，而不是等第一次编码才发现。
  try {
    await embed('自检');
  } catch (err) {
    // 自检失败 → 这个会话不会被任何人接管（装配侧只在 ok:true 时 setEmbedder）→ 主动释放，
    // 否则原生会话与其线程池会随进程存活。释放本身失败不影响降级结论（如实返回自检原因）。
    try {
      await session.release?.();
    } catch {
      // 释放失败 → 忽略（进程退出时由宿主回收）
    }
    return { ok: false, reason: `模型自检失败（${(err as Error).message}）` };
  }

  return {
    ok: true,
    modelDir,
    embedder: { id: BGE_SMALL_ZH_ID, dim: BGE_SMALL_ZH_DIM, embed, minScore: BGE_MIN_SCORE },
  };
}

/**
 * 模型目录已落盘的字节数（状态面可读：确认权重真的在盘上）。
 * 按"已解析到的配对"统计——外部权重文件名与图名绑定（ONNX 内部记录了 `*_data` 名），
 * 所以只认配对文件，不能按固定文件名列表猜。
 */
export function modelDirBytes(dir: string): number {
  const pair = resolveModelPair(dir);
  if (pair === null) return 0;
  let total = 0;
  for (const name of [pair.graph, pair.data, VOCAB_FILE]) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // 缺失 → 不计
    }
  }
  return total;
}

/** 确保模型目录存在（装配期准备用；不下载——下载属部署动作，见 docs） */
export function ensureModelDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
