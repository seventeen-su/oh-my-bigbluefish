/**
 * `modules/memory/onnx.ts`：BGE-small-zh 的**模型目录解析**与**诚实降级**。
 *
 * 本文件**不加载真实 ONNX 权重**（本机 `models/` 可能不存在，测试也不该下载任何东西）：
 * - 目录解析用临时目录测（文件系统探测是纯同步的）；
 * - 运行时用**注入的 fake**（`loadRuntime`）测，覆盖成功路径与全部降级分支；
 * - 真实权重存在时才跑最后一段 `describe.skipIf` 保护的用例。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Embedder } from '../../../kernel/abi/index.js'
import {
  BGE_DIMENSIONS,
  BGE_EMBEDDER_ID,
  BGE_MODEL_DIR_NAME,
  BGE_REVISION,
  MODEL_DIR_ENV,
  WordPieceTokenizer,
  createOnnxEmbedder,
  findRepoRoot,
  loadOnnxEmbedder,
  modelDirBytes,
  resolveOnnxModelDir,
  type OnnxRuntimeLike,
} from '../../../modules/memory/onnx.js'

const TEMP_ROOTS: string[] = []

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论（临时目录）
    }
  }
})

/** 最小可用的 BERT 词表（行号 = id）：[PAD]=0 [UNK]=1 [CLS]=2 [SEP]=3 自=4 检=5 hello=6 world=7 */
const MINI_VOCAB = '[PAD]\n[UNK]\n[CLS]\n[SEP]\n自\n检\nhello\nworld\n'

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omb-onnx-'))
  TEMP_ROOTS.push(root)
  return root
}

/** 造一个带（图 + 外部权重 + 词表）的模型目录。 */
function makeModelDir(opts: { pair?: boolean; vocab?: string | null } = {}): string {
  const dir = join(tempRoot(), 'models', BGE_MODEL_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  if (opts.pair !== false) {
    writeFileSync(join(dir, 'model_quantized.onnx'), 'graph-bytes')
    writeFileSync(join(dir, 'model_quantized.onnx_data'), 'weights-bytes')
  }
  if (opts.vocab !== null) writeFileSync(join(dir, 'vocab.txt'), opts.vocab ?? MINI_VOCAB)
  return dir
}

interface FakeCalls {
  readonly created: { path: string; options?: Record<string, unknown> }[]
  runs: number
  released: number
  readonly tensors: { type: string; dims: readonly number[]; data: BigInt64Array }[]
}

/** 注入用的假运行时：不发真实推理，只记录被怎么调用、返回可编程的形状。 */
function fakeRuntime(opts: {
  dim?: number
  output?: 'sentence_embedding' | 'last_hidden_state' | 'none'
  failCreate?: boolean
  failRun?: boolean
} = {}): { runtime: OnnxRuntimeLike; calls: FakeCalls } {
  const calls: FakeCalls = { created: [], runs: 0, released: 0, tensors: [] }
  const runtime: OnnxRuntimeLike = {
    Tensor: class {
      constructor(type: string, data: BigInt64Array, dims: readonly number[]) {
        calls.tensors.push({ type, dims, data })
      }
    } as unknown as OnnxRuntimeLike['Tensor'],
    InferenceSession: {
      async create(path: string, options?: Record<string, unknown>) {
        if (opts.failCreate === true) throw new Error('create boom')
        calls.created.push({ path, ...(options !== undefined ? { options } : {}) })
        return {
          inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
          async run() {
            calls.runs++
            if (opts.failRun === true) throw new Error('run boom')
            const key = opts.output ?? 'sentence_embedding'
            if (key === 'none') return {}
            const dim = opts.dim ?? BGE_DIMENSIONS
            const len = key === 'last_hidden_state' ? dim * 3 : dim
            const data = new Float32Array(len)
            data[0] = 3
            data[1] = 4 // 3-4-5：归一化后应为 [0.6, 0.8, 0, …]
            return { [key]: { data, dims: key === 'last_hidden_state' ? [1, 3, dim] : [1, dim] } }
          },
          async release() {
            calls.released++
          },
        }
      },
    },
  }
  return { runtime, calls }
}

describe('resolveOnnxModelDir —— 注入的数据根，不写死路径', () => {
  it('显式 modelDir 是权威：不存在即失败并指出路径与来源', () => {
    const missing = join(tempRoot(), 'nope')
    const verdict = resolveOnnxModelDir({ modelDir: missing, env: {} })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('权重目录不存在')
    expect(verdict.reason).toContain(missing)
    expect(verdict.reason).toContain('modelDir 参数')
  })

  it('$OMB_EMBEDDING_MODEL 设置后即权威：坏路径不会被其他候选静默覆盖', () => {
    const good = makeModelDir()
    const missing = join(tempRoot(), 'nope')
    const verdict = resolveOnnxModelDir({
      dataRoot: good.replace(/models.*$/, ''),
      env: { [MODEL_DIR_ENV]: missing },
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain(missing)
    expect(verdict.reason).toContain(`$${MODEL_DIR_ENV}`)
  })

  it('dataRoot 参数解析出 <dataRoot>/models/bge-small-zh-v1.5', () => {
    const dir = makeModelDir()
    const dataRoot = dir.replace(/[/\\]models[/\\].*$/, '')
    const verdict = resolveOnnxModelDir({ dataRoot, env: {} })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.dir).toBe(dir)
    expect(verdict.graph).toBe('model_quantized.onnx')
    expect(verdict.data).toBe('model_quantized.onnx_data')
  })

  it('目录存在但缺少「图 + 同名前缀权重」配对 → 指出配对要求', () => {
    const dir = makeModelDir({ pair: false })
    const verdict = resolveOnnxModelDir({ modelDir: dir, env: {} })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('配对')
    expect(verdict.reason).toContain('model_quantized.onnx')
  })

  it('没有任何候选存在 → 原因里列出试过的位置与配置办法', () => {
    const fakeModule = join(tempRoot(), 'modules', 'memory', 'onnx.ts')
    const verdict = resolveOnnxModelDir({
      env: {},
      moduleUrl: pathToFileURL(fakeModule).href,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain('权重目录不存在')
    expect(verdict.reason).toContain(MODEL_DIR_ENV)
  })

  it('仓库根由模块位置向上找 package.json 得到（不写死绝对路径）', () => {
    const root = findRepoRoot()
    expect(root).not.toBeNull()
    expect(existsSync(join(root!, 'package.json'))).toBe(true)
  })
})

describe('WordPieceTokenizer —— 词表与切分', () => {
  it('行号即 id，编码含 [CLS]/[SEP]', () => {
    const dir = makeModelDir()
    const tokenizer = WordPieceTokenizer.fromFile(join(dir, 'vocab.txt'))
    expect(tokenizer.clsId).toBe(2)
    expect(tokenizer.sepId).toBe(3)
    expect(tokenizer.unkId).toBe(1)
    expect(tokenizer.encode('自检')).toEqual([2, 4, 5, 3])
  })

  it('英文小写化后按词匹配', () => {
    const dir = makeModelDir()
    const tokenizer = WordPieceTokenizer.fromFile(join(dir, 'vocab.txt'))
    expect(tokenizer.encode('Hello world')).toEqual([2, 6, 7, 3])
  })

  it('超长无空白 token 短路为 [UNK]（O(n²) 扫描是实测的 40 秒阻塞源）', () => {
    const dir = makeModelDir()
    const tokenizer = WordPieceTokenizer.fromFile(join(dir, 'vocab.txt'))
    expect(tokenizer.encode('x'.repeat(150))).toEqual([2, 1, 3])
  })

  it('空词表 / 不是 BERT 词表 → 抛错（否则所有文本都会编码成同一个 [UNK]）', () => {
    const empty = makeModelDir({ vocab: '' })
    expect(() => WordPieceTokenizer.fromFile(join(empty, 'vocab.txt'))).toThrow(/不是可用的 BERT 词表/)
    const foreign = makeModelDir({ vocab: 'a\nb\nc\n' })
    expect(() => WordPieceTokenizer.fromFile(join(foreign, 'vocab.txt'))).toThrow(/缺少 \[CLS\]\/\[SEP\]/)
  })
})

describe('loadOnnxEmbedder —— 成功路径（注入 fake 运行时，不碰真实权重）', () => {
  it('装载成功：身份标签、会话参数、喂给模型的张量都正确', async () => {
    const dir = makeModelDir()
    const { runtime, calls } = fakeRuntime()
    const loaded = await loadOnnxEmbedder({ modelDir: dir, env: {}, loadRuntime: async () => runtime })

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) throw new Error(loaded.reason)
    expect(loaded.modelDir).toBe(dir)
    expect(loaded.embedder.id).toBe(BGE_EMBEDDER_ID)
    expect(loaded.embedder.dimensions).toBe(BGE_DIMENSIONS)
    expect(loaded.embedder.revision).toBe(BGE_REVISION)

    expect(calls.created).toHaveLength(1)
    expect(calls.created[0]!.path).toBe(join(dir, 'model_quantized.onnx'))
    expect(calls.created[0]!.options?.['intraOpNumThreads']).toBe(2)
    expect(calls.created[0]!.options?.['interOpNumThreads']).toBe(1)

    // 自检已跑过一次真实前向（把"跑不通"挡在装配期）
    expect(calls.runs).toBe(1)
    // 三个输入都按名字喂 int64 张量：[CLS] 自 检 [SEP]
    expect(calls.tensors.map((t) => t.type)).toEqual(['int64', 'int64', 'int64'])
    expect(calls.tensors.map((t) => [...t.data])).toEqual([
      [2n, 4n, 5n, 3n],
      [1n, 1n, 1n, 1n],
      [0n, 0n, 0n, 0n],
    ])
    for (const tensor of calls.tensors) expect(tensor.dims).toEqual([1, 4])
  })

  it('编码结果 L2 归一化（3-4-5 → [0.6, 0.8, 0, …]）', async () => {
    const dir = makeModelDir()
    const { runtime } = fakeRuntime()
    const loaded = await loadOnnxEmbedder({ modelDir: dir, env: {}, loadRuntime: async () => runtime })
    if (!loaded.ok) throw new Error(loaded.reason)
    const [vec] = await loaded.embedder.embed(['自检'])
    expect(vec).toHaveLength(BGE_DIMENSIONS)
    expect(vec![0]).toBeCloseTo(0.6, 5)
    expect(vec![1]).toBeCloseTo(0.8, 5)
    expect(vec![2]).toBe(0)
  })

  it('线程数可配置（threads → intraOpNumThreads）', async () => {
    const dir = makeModelDir()
    const { runtime, calls } = fakeRuntime()
    const loaded = await loadOnnxEmbedder({
      modelDir: dir,
      env: {},
      threads: 4,
      loadRuntime: async () => runtime,
    })
    expect(loaded.ok).toBe(true)
    expect(calls.created[0]!.options?.['intraOpNumThreads']).toBe(4)
  })

  it('sentence_embedding 与 last_hidden_state（取 CLS 行）都能用', async () => {
    const dir = makeModelDir()
    const hidden = fakeRuntime({ output: 'last_hidden_state' })
    const loaded = await loadOnnxEmbedder({
      modelDir: dir,
      env: {},
      loadRuntime: async () => hidden.runtime,
    })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) throw new Error(loaded.reason)
    const [vec] = await loaded.embedder.embed(['自检'])
    expect(vec).toHaveLength(BGE_DIMENSIONS)
    expect(vec![0]).toBeCloseTo(0.6, 5)
  })

  it('批量编码逐条前向，条数与维度一致', async () => {
    const dir = makeModelDir()
    const { runtime, calls } = fakeRuntime()
    const loaded = await loadOnnxEmbedder({ modelDir: dir, env: {}, loadRuntime: async () => runtime })
    if (!loaded.ok) throw new Error(loaded.reason)
    const out = await loaded.embedder.embed(['自检', 'hello world'])
    expect(out).toHaveLength(2)
    for (const vec of out) expect(vec).toHaveLength(BGE_DIMENSIONS)
    expect(calls.runs).toBe(3) // 1 次自检 + 2 次编码
  })
})

describe('loadOnnxEmbedder —— 诚实降级（原因必须可读、可行动）', () => {
  async function reasonOf(options: Parameters<typeof loadOnnxEmbedder>[0]): Promise<string> {
    const loaded = await loadOnnxEmbedder(options)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) throw new Error('unreachable')
    return loaded.reason
  }

  it('权重目录不存在', async () => {
    const reason = await reasonOf({ modelDir: join(tempRoot(), 'nope'), env: {} })
    expect(reason).toContain('权重目录不存在')
  })

  it('词表缺失（只在模型目录里找，不做隐式回退）', async () => {
    const dir = makeModelDir({ vocab: null })
    const reason = await reasonOf({ modelDir: dir, env: {} })
    expect(reason).toContain('词表缺失')
    expect(reason).toContain('vocab.txt')
  })

  it('onnxruntime-node 不可加载（optionalDependency 未安装）', async () => {
    const dir = makeModelDir()
    const reason = await reasonOf({
      modelDir: dir,
      env: {},
      loadRuntime: async () => {
        throw new Error("Cannot find package 'onnxruntime-node'")
      },
    })
    expect(reason).toContain('onnxruntime-node 不可加载')
    expect(reason).toContain('onnxruntime-node')
  })

  it('会话创建失败', async () => {
    const dir = makeModelDir()
    const { runtime } = fakeRuntime({ failCreate: true })
    const reason = await reasonOf({ modelDir: dir, env: {}, loadRuntime: async () => runtime })
    expect(reason).toContain('会话创建失败')
    expect(reason).toContain('create boom')
  })

  it('自检失败 → 释放原生会话（否则线程池随进程存活）', async () => {
    const dir = makeModelDir()
    const { runtime, calls } = fakeRuntime({ failRun: true })
    const reason = await reasonOf({ modelDir: dir, env: {}, loadRuntime: async () => runtime })
    expect(reason).toContain('模型自检失败')
    expect(reason).toContain('run boom')
    expect(calls.released).toBe(1)
  })

  it('输出既无 sentence_embedding 也无 last_hidden_state', async () => {
    const dir = makeModelDir()
    const { runtime } = fakeRuntime({ output: 'none' })
    const reason = await reasonOf({ modelDir: dir, env: {}, loadRuntime: async () => runtime })
    expect(reason).toContain('模型自检失败')
    expect(reason).toContain('sentence_embedding')
  })

  it('模型输出维度不是 512 → 拒绝装载（不产出错维向量）', async () => {
    const dir = makeModelDir()
    const { runtime, calls } = fakeRuntime({ dim: 768 })
    const reason = await reasonOf({ modelDir: dir, env: {}, loadRuntime: async () => runtime })
    expect(reason).toContain('维度不匹配')
    expect(reason).toContain('模型输出 768')
    expect(calls.released).toBe(1)
  })

  it('库内是 256 维（哈希词袋）而模型输出 512 → 维度不匹配', async () => {
    const dir = makeModelDir()
    const { runtime } = fakeRuntime()
    const reason = await reasonOf({
      modelDir: dir,
      env: {},
      expectedDimensions: 256,
      loadRuntime: async () => runtime,
    })
    expect(reason).toContain('维度不匹配')
    expect(reason).toContain('库内 256')
    expect(reason).toContain('模型输出 512')
  })
})

describe('createOnnxEmbedder —— 不可用返回 null 且原因可读', () => {
  it('null 表示不可用；onUnavailable 给出同一条原因', async () => {
    const missing = join(tempRoot(), 'nope')
    const reasons: string[] = []
    const embedder: Embedder | null = await createOnnxEmbedder({
      modelDir: missing,
      env: {},
      onUnavailable: (reason) => reasons.push(reason),
    })
    expect(embedder).toBeNull()
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('权重目录不存在')
  })

  it('可用时返回嵌入器（fake 运行时）', async () => {
    const dir = makeModelDir()
    const { runtime } = fakeRuntime()
    const embedder = await createOnnxEmbedder({
      modelDir: dir,
      env: {},
      loadRuntime: async () => runtime,
    })
    expect(embedder).not.toBeNull()
    expect(embedder?.id).toBe(BGE_EMBEDDER_ID)
  })

  it('onUnavailable 自己抛异常不改变结论', async () => {
    const embedder = await createOnnxEmbedder({
      modelDir: join(tempRoot(), 'nope'),
      env: {},
      onUnavailable: () => {
        throw new Error('callback boom')
      },
    })
    expect(embedder).toBeNull()
  })
})

describe('modelDirBytes —— 状态面确认权重真的在盘上', () => {
  it('只统计已解析到的配对 + 词表；无配对 → 0', () => {
    const dir = makeModelDir()
    const expected =
      readFileSync(join(dir, 'model_quantized.onnx')).byteLength +
      readFileSync(join(dir, 'model_quantized.onnx_data')).byteLength +
      readFileSync(join(dir, 'vocab.txt')).byteLength
    expect(modelDirBytes(dir)).toBe(expected)
    expect(modelDirBytes(makeModelDir({ pair: false }))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 真实权重（本机通常没有：`models/` 已被 .gitignore；不存在则跳过）
// ---------------------------------------------------------------------------

const REAL_DIR =
  findRepoRoot() === null ? null : join(findRepoRoot()!, 'models', BGE_MODEL_DIR_NAME)
const HAS_REAL_WEIGHTS = REAL_DIR !== null && existsSync(join(REAL_DIR, 'vocab.txt'))

describe.skipIf(!HAS_REAL_WEIGHTS)('真实权重（可选）：真正加载一次 ONNX 会话', () => {
  it('装载成功、维度 512、同文本余弦为 1', async () => {
    const loaded = await loadOnnxEmbedder({ modelDir: REAL_DIR!, env: {}, threads: 2 })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) throw new Error(loaded.reason)
    expect(loaded.embedder.dimensions).toBe(BGE_DIMENSIONS)
    const [a, b] = await loaded.embedder.embed(['长期记忆系统', '长期记忆系统'])
    let dot = 0
    for (let i = 0; i < a!.length; i++) dot += a![i]! * b![i]!
    expect(dot).toBeCloseTo(1, 4)
  })
})
