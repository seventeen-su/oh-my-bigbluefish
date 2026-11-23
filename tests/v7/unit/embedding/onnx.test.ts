import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OmbFailure } from '../../../../packages/v7/src/domain/errors.js'
import {
  OnnxEmbedder,
  resolveModelDir,
  VOCAB_FILE,
} from '../../../../packages/v7/src/adapters/embedding/onnx.js'
import type {
  OnnxRuntimeLike,
  OnnxTensorLike,
} from '../../../../packages/v7/src/adapters/embedding/onnx.js'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'omb-v7-embedding-'))
const VOCAB_LINES = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '你', '好', 'hello', 'wor', '##ld', '，']

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

interface TempModelOptions {
  readonly graphs?: readonly string[]
  readonly vocab?: readonly string[] | null
}

/** 造一个只满足目录探测的假模型目录（图文件是空文件，只有假运行时才会读它）。 */
function tempModelDir(name: string, options: TempModelOptions = {}): string {
  const dir = join(TEMP_ROOT, name)
  mkdirSync(dir, { recursive: true })
  for (const graph of options.graphs ?? ['model_quantized.onnx']) writeFileSync(join(dir, graph), '')
  if (options.vocab !== null) writeFileSync(join(dir, VOCAB_FILE), (options.vocab ?? VOCAB_LINES).join('\n') + '\n')
  return dir
}

interface RunRecord {
  readonly rows: number
  readonly seq: number
  readonly mask: readonly number[]
}

interface FakeEvents {
  readonly runs: RunRecord[]
  releases: number
}

interface FakeOptions {
  /** 隐状态取值：`hidden(position, dim)`；缺省 dim0 = position+1、dim1 = 1、其余 0。 */
  readonly hidden?: (position: number, dim: number) => number
  /** 只返回 sentence_embedding（模拟缺少 last_hidden_state 的导出）。 */
  readonly omitLastHiddenState?: boolean
  /** 覆盖输出维度（模拟形状不符）。 */
  readonly outputDims?: (seq: number) => readonly number[]
  /** 第 N 次 run（1 起）抛错；缺省不抛。 */
  readonly failOnRun?: number
  /** 模型输入名（缺省三件套）。 */
  readonly inputNames?: readonly string[]
}

class FakeTensor implements OnnxTensorLike {
  readonly data: ArrayLike<number>
  readonly dims: readonly number[]

  constructor(_type: 'int64', data: BigInt64Array | ArrayLike<number>, dims: readonly number[]) {
    this.data = data as ArrayLike<number>
    this.dims = dims
  }
}

function numbersOf(tensor: OnnxTensorLike | undefined): number[] {
  if (tensor === undefined) throw new Error('假运行时缺少输入张量')
  return Array.from(tensor.data as ArrayLike<number | bigint>, value => Number(value))
}

function fakeRuntime(events: FakeEvents, options: FakeOptions = {}): OnnxRuntimeLike {
  const inputNames = options.inputNames ?? ['input_ids', 'attention_mask', 'token_type_ids']
  const hidden = options.hidden ?? ((position: number, dim: number) => (dim === 0 ? position + 1 : dim === 1 ? 1 : 0))
  let runCount = 0
  return {
    Tensor: FakeTensor,
    InferenceSession: {
      async create(): Promise<{
        readonly inputNames: readonly string[]
        readonly outputNames?: readonly string[]
        run(feeds: Record<string, OnnxTensorLike>): Promise<Record<string, OnnxTensorLike>>
        release(): Promise<void>
      }> {
        return {
          inputNames,
          outputNames: ['last_hidden_state', 'sentence_embedding'],
          async run(feeds: Record<string, OnnxTensorLike>): Promise<Record<string, OnnxTensorLike>> {
            runCount++
            if (options.failOnRun === runCount) throw new Error('模拟推理失败')
            const ids = numbersOf(feeds['input_ids'])
            const mask = numbersOf(feeds['attention_mask'])
            const dims = feeds['input_ids']?.dims ?? [1, ids.length]
            events.runs.push({ rows: dims[0] ?? 1, seq: dims[1] ?? ids.length, mask })
            const seq = ids.length
            const outputDims = options.outputDims?.(seq) ?? [1, seq, 512]
            const total = outputDims.reduce((product, value) => product * value, 1)
            const data = new Float32Array(total)
            if (outputDims.length === 3 && outputDims[0] === 1 && outputDims[1] === seq && outputDims[2] === 512) {
              for (let position = 0; position < seq; position++) {
                for (let dim = 0; dim < 512; dim++) data[position * 512 + dim] = hidden(position, dim)
              }
            }
            const hiddenTensor = new FakeTensor('int64', data, outputDims)
            const output: Record<string, OnnxTensorLike> = {}
            if (options.omitLastHiddenState === true) output['sentence_embedding'] = hiddenTensor
            else output['last_hidden_state'] = hiddenTensor
            return output
          },
          async release(): Promise<void> {
            events.releases++
          },
        }
      },
    },
  }
}

function newEvents(): FakeEvents {
  return { runs: [], releases: 0 }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('期望被拒绝，但调用成功了')
}

function expectUnsupported(failure: unknown): OmbFailure {
  expect(failure).toBeInstanceOf(OmbFailure)
  if (!(failure instanceof OmbFailure)) throw new Error('不是 OmbFailure')
  expect(failure.error.code).toBe('unsupported')
  expect(failure.error.retryable).toBe(false)
  return failure
}

describe('resolveModelDir', () => {
  it('给定显式目录不存在当解析则返回原因而不是静默回退仓库模型', () => {
    const missing = join(TEMP_ROOT, 'absent')
    const result = resolveModelDir({ modelDir: missing })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('权重目录不存在')
  })

  it('给定 OMB_EMBEDDING_MODEL 指向坏目录当解析则以环境变量为权威', () => {
    const bad = join(TEMP_ROOT, 'bad-env')
    const result = resolveModelDir({ env: { OMB_EMBEDDING_MODEL: bad } })
    expect(result.ok).toBe(false)
    // 仓库根下其实有模型；若实现偷偷回退，这里会变成 ok=true。
    if (!result.ok) expect(result.reason).toContain('bad-env')
  })

  it('给定含图与词表的目录当解析则返回图路径', () => {
    const dir = tempModelDir('good')
    const result = resolveModelDir({ modelDir: dir })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.graphPath).toBe(join(dir, 'model_quantized.onnx'))
      expect(result.dataPath).toBeUndefined()
    }
  })

  it('给定缺图文件当解析则指出缺少图', () => {
    const dir = tempModelDir('no-graph', { graphs: [] })
    const result = resolveModelDir({ modelDir: dir })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('缺少图文件')
  })

  it('给定缺词表当解析则指出缺少词表', () => {
    const dir = tempModelDir('no-vocab', { vocab: null })
    const result = resolveModelDir({ modelDir: dir })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('缺少词表')
  })
})

describe('OnnxEmbedder 不可用路径', () => {
  it('给定模型目录不存在当探测则 available=false 且 embed 抛 unsupported（不伪造向量）', async () => {
    let loaderCalls = 0
    const embedder = new OnnxEmbedder({
      modelDir: join(TEMP_ROOT, 'absent'),
      loadRuntime: async () => {
        loaderCalls++
        return fakeRuntime(newEvents())
      },
    })
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/权重目录不存在/)

    const failure = expectUnsupported(await rejectionOf(embedder.embed(['记忆库'])))
    expect(failure.error.details).toMatchObject({ model: 'bge-small-zh-v1.5', dims: 512 })
    expect(String((failure.error.details as { reason?: string }).reason)).toMatch(/权重目录不存在/)
    // 目录都解析不到时不该去装载原生运行时。
    expect(loaderCalls).toBe(0)
    // 空输入无事可做：不可用也返回 []，不是错误。
    await expect(embedder.embed([])).resolves.toEqual([])
  })

  it('给定 onnxruntime-node 装载失败当探测则 available=false 并保留原始错误', async () => {
    const dir = tempModelDir('runtime-fail')
    const embedder = new OnnxEmbedder({
      modelDir: dir,
      loadRuntime: async () => {
        throw new Error('native binding missing')
      },
    })
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/onnxruntime-node 不可加载/)
    expect(embedder.unavailableReason()).toMatch(/native binding missing/)
    expectUnsupported(await rejectionOf(embedder.embed(['x'])))
  })

  it('给定词表损坏当探测则 available=false 且原因是词表装载失败', async () => {
    const dir = tempModelDir('bad-vocab', { vocab: ['[PAD]', '[UNK]'] })
    const embedder = new OnnxEmbedder({ modelDir: dir, loadRuntime: async () => fakeRuntime(newEvents()) })
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/词表装载失败/)
    expect(embedder.unavailableReason()).toMatch(/\[CLS\]\/\[SEP\]/)
  })

  it('给定模型缺少 last_hidden_state 当自检则拒绝装载并释放会话', async () => {
    const dir = tempModelDir('omit-hidden')
    const events = newEvents()
    const embedder = new OnnxEmbedder({
      modelDir: dir,
      loadRuntime: async () => fakeRuntime(events, { omitLastHiddenState: true }),
    })
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/last_hidden_state/)
    expect(events.releases).toBe(1)
    expectUnsupported(await rejectionOf(embedder.embed(['x'])))
  })

  it('给定输出维度不是 512 当自检则拒绝装载而不是产出错维向量', async () => {
    const dir = tempModelDir('wrong-dims')
    const events = newEvents()
    const embedder = new OnnxEmbedder({
      modelDir: dir,
      loadRuntime: async () => fakeRuntime(events, { outputDims: seq => [1, seq, 256] }),
    })
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/形状不符/)
    expect(events.releases).toBe(1)
  })

  it('给定模型输入名无法映射当自检则拒绝装载', async () => {
    const dir = tempModelDir('unknown-input')
    const embedder = new OnnxEmbedder({
      modelDir: dir,
      loadRuntime: async () =>
        fakeRuntime(newEvents(), { inputNames: ['input_ids', 'attention_mask', 'position_ids'] }),
    })
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/无法映射/)
  })

  it('给定模型缺少 input_ids 输入当自检则拒绝装载', async () => {
    const dir = tempModelDir('no-input-ids')
    const embedder = new OnnxEmbedder({
      modelDir: dir,
      loadRuntime: async () => fakeRuntime(newEvents(), { inputNames: ['attention_mask'] }),
    })
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/缺少 input_ids/)
  })
})

describe('OnnxEmbedder 推理路径（假运行时）', () => {
  it('给定可用模型当嵌入则按 mean pooling 产出 512 维单位向量', async () => {
    const dir = tempModelDir('mean-pool')
    const events = newEvents()
    const embedder = new OnnxEmbedder({ modelDir: dir, loadRuntime: async () => fakeRuntime(events) })
    await expect(embedder.available()).resolves.toBe(true)

    const vectors = await embedder.embed(['你好', 'hello'])
    expect(vectors).toHaveLength(2)

    // 『你好』→ [CLS,你,好,SEP] 长度 4，假隐状态第 0 维 = 位置+1 → 平均 2.5；第 1 维恒 1。
    const norm4 = Math.sqrt(2.5 * 2.5 + 1)
    expect(vectors[0]).toHaveLength(512)
    expect(vectors[0]?.[0]).toBeCloseTo(2.5 / norm4, 6)
    expect(vectors[0]?.[1]).toBeCloseTo(1 / norm4, 6)
    expect(vectors[0]?.[2]).toBeCloseTo(0, 6)
    // 『hello』→ [CLS,hello,SEP] 长度 3 → 平均 2。
    const norm3 = Math.sqrt(2 * 2 + 1)
    expect(vectors[1]?.[0]).toBeCloseTo(2 / norm3, 6)
    expect(vectors[1]?.[1]).toBeCloseTo(1 / norm3, 6)

    // 自检 1 次 + 两条文本各 1 次；每次 RUN 只放一个序列（批量不会耦合样本）。
    expect(events.runs.map(run => ({ rows: run.rows, seq: run.seq }))).toEqual([
      { rows: 1, seq: 4 },
      { rows: 1, seq: 4 },
      { rows: 1, seq: 3 },
    ])
    expect(events.runs.every(run => run.mask.every(value => value === 1))).toBe(true)

    // 同一文本再嵌一次必须逐位相同（向量要落库跨调用比较）。
    const again = await embedder.embed(['你好'])
    expect(again[0]).toEqual(vectors[0])
    expect(Array.isArray(vectors[0])).toBe(true)
  })

  it('给定空输入当嵌入则返回空数组且不触发推理', async () => {
    const dir = tempModelDir('empty-input')
    const events = newEvents()
    const embedder = new OnnxEmbedder({ modelDir: dir, loadRuntime: async () => fakeRuntime(events) })
    await expect(embedder.embed([])).resolves.toEqual([])
    expect(events.runs).toHaveLength(0)
  })

  it('给定 40 条文本当嵌入则分块处理且每次 RUN 仍只放一个序列', async () => {
    const dir = tempModelDir('many-texts')
    const events = newEvents()
    const embedder = new OnnxEmbedder({ modelDir: dir, loadRuntime: async () => fakeRuntime(events) })
    const texts = Array.from({ length: 40 }, (_, index) => `文本${index}`)
    const vectors = await embedder.embed(texts)
    expect(vectors).toHaveLength(40)
    expect(events.runs).toHaveLength(41) // 自检 + 40
    expect(events.runs.every(run => run.rows === 1)).toBe(true)
  })

  it('给定装载成功后推理失败当嵌入则抛 internal 且可重试', async () => {
    const dir = tempModelDir('run-fail')
    const events = newEvents()
    const embedder = new OnnxEmbedder({
      modelDir: dir,
      loadRuntime: async () => fakeRuntime(events, { failOnRun: 2 }),
    })
    await expect(embedder.available()).resolves.toBe(true)
    const failure = await rejectionOf(embedder.embed(['你好']))
    expect(failure).toBeInstanceOf(OmbFailure)
    if (failure instanceof OmbFailure) {
      expect(failure.error.code).toBe('internal')
      expect(failure.error.retryable).toBe(true)
      expect(failure.error.message).toMatch(/模拟推理失败/)
    }
  })

  it('给定 close 当之后探测则不可用、embed 抛 unsupported 且重复 close 幂等', async () => {
    const dir = tempModelDir('close')
    const events = newEvents()
    const embedder = new OnnxEmbedder({ modelDir: dir, loadRuntime: async () => fakeRuntime(events) })
    await expect(embedder.available()).resolves.toBe(true)
    await embedder.close()
    expect(events.releases).toBe(1)
    await expect(embedder.available()).resolves.toBe(false)
    expect(embedder.unavailableReason()).toMatch(/已关闭/)
    expectUnsupported(await rejectionOf(embedder.embed(['x'])))
    await embedder.close()
    expect(events.releases).toBe(1)
  })

  it('给定装载进行中 close 当装载完成则释放会话且保持不可用（不复活已关闭实例）', async () => {
    const dir = tempModelDir('close-race')
    const events = newEvents()
    let releaseLoader: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      releaseLoader = resolve
    })
    const embedder = new OnnxEmbedder({
      modelDir: dir,
      loadRuntime: async () => {
        await gate
        return fakeRuntime(events)
      },
    })
    const pending = embedder.available()
    const closing = embedder.close()
    releaseLoader?.()
    await closing
    await expect(pending).resolves.toBe(false)
    expect(events.releases).toBe(1)
    expect(embedder.unavailableReason()).toMatch(/已关闭/)
    await expect(embedder.available()).resolves.toBe(false)
  })

  it('给定非法构造参数当创建则抛 RangeError', () => {
    expect(() => new OnnxEmbedder({ batchSize: 0 })).toThrow(RangeError)
    expect(() => new OnnxEmbedder({ threads: -1 })).toThrow(RangeError)
    expect(() => new OnnxEmbedder({ maxLength: 1 })).toThrow(RangeError)
    expect(() => new OnnxEmbedder({ maxLength: 513 })).toThrow(RangeError)
  })
})
