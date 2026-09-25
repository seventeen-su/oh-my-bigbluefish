/**
 * `modules/memory/vector.ts`：向量通道模块入口（`omb-memory-vector`）。
 *
 * 覆盖四类断言：
 * ① 契约（id/requires/capabilities 与 `MODULE_CATALOG`、`cordis.patch.yml` 三方一致）；
 * ② **同步注册**（热插拔 H-2：`apply` 返回时服务已可用；升级是门面换实现，不是二次注册）；
 * ③ 诚实降级（通道 + 降级原因写进 health 与状态面）；
 * ④ **关掉模块 → 纯词法路径完整可用**（规划 §5.7 的硬要求，用真实 `retrieve` 跑）。
 *
 * 本文件不加载真实 ONNX 权重：模型目录解析走临时目录，装载器由 `createVectorModule({loadOnnx})`
 * 注入 fake，真实运行时只在 `tests/modules/embed/onnx.test.ts` 的 skipIf 段落里碰。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import {
  MODULE_CATALOG,
  MODULE_IDS,
  type Embedder,
  type Kernel,
  type MemoryRecord,
  type MemoryStore,
  type ModuleHealth,
  type ModuleRegistration,
  type TaggedStore,
} from '../../../kernel/abi/index.js'
import { retrieve } from '../../../modules/memory/retrieve.js'
import {
  DEFAULT_MAX_PENDING,
  EMBEDDER_SERVICE,
  VECTOR_MODULE_ID,
  createVectorModule,
  vectorManifest,
  vectorModule,
  type VectorModuleInstance,
} from '../../../modules/memory/vector.js'
import { BGE_EMBEDDER_ID, BGE_DIMENSIONS } from '../../../modules/memory/onnx.js'
import type { OnnxEmbedderOptions, OnnxLoad } from '../../../modules/memory/onnx.js'

const TEMP_ROOTS: string[] = []

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omb-vector-'))
  TEMP_ROOTS.push(root)
  return root
}

/** 造一个"看起来像"模型目录（含配对 + 词表）：只为让同步解析通过，不加载任何权重。 */
function makeModelDir(): string {
  const dir = join(tempRoot(), 'models', 'bge-small-zh-v1.5')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model_quantized.onnx'), 'graph')
  writeFileSync(join(dir, 'model_quantized.onnx_data'), 'weights')
  writeFileSync(join(dir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\n')
  return dir
}

/** 一定解析不到的模型目录（让 `apply` 走降级分支，且不碰环境变量）。 */
function missingDir(): string {
  return join(tempRoot(), 'nope')
}

const BGE: Embedder = {
  id: BGE_EMBEDDER_ID,
  dimensions: BGE_DIMENSIONS,
  revision: '1',
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map(() => new Float32Array(BGE_DIMENSIONS))
  },
}

/** 用临时环境变量跑一段代码（默认解析路径依赖 `$OMB_EMBEDDING_MODEL`）。 */
function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.OMB_EMBEDDING_MODEL
  if (value === undefined) delete process.env.OMB_EMBEDDING_MODEL
  else process.env.OMB_EMBEDDING_MODEL = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.OMB_EMBEDDING_MODEL
    else process.env.OMB_EMBEDDING_MODEL = prev
  }
}

describe('模块契约（三方一致：模块清单 / 目录 / cordis.patch.yml）', () => {
  it('id / requires / capabilities 与 MODULE_CATALOG 一致', () => {
    const entry = MODULE_CATALOG.find((e) => e.id === VECTOR_MODULE_ID)
    expect(entry).toBeDefined()
    expect(vectorManifest.id).toBe(VECTOR_MODULE_ID)
    expect(vectorManifest.id).toBe('omb-memory-vector')
    expect([...vectorManifest.requires]).toEqual([...entry!.requires])
    expect([...vectorManifest.capabilities]).toEqual([...entry!.capabilities])
    expect(entry!.enabledByDefault).toBe(true)
  })

  it('模块 id 在冻结的 MODULE_IDS 名单里', () => {
    expect(MODULE_IDS).toContain(VECTOR_MODULE_ID)
  })

  it('配置缺省值完整：空配置即可运行', () => {
    const config = vectorManifest.configSchema.parse({})
    expect(config.threads).toBe(2)
    expect(config.dimensions).toBe(256)
    expect(config.modelDir).toBeUndefined()
    expect(config.maxPending).toBe(DEFAULT_MAX_PENDING)
  })

  it('**没有 config 的 YAML 行也必须能启动**：parse(undefined) / parse(null) 走完整缺省值', () => {
    // 回归：`cordis.patch.yml` 的 omb-memory-vector 行没有 `config`
    //   → 内核 `start()` 里 `configSchema.parse(configs?.get(id))` 收到 undefined
    //   → 裸 `z.object` 抛 `expected object, received undefined`，整个模块被标 failed
    //   （`tests/dsh/assembly.smoke.test.ts` 暴露过）。YAML 里写空的 `config:` 则是 null。
    for (const input of [undefined, null]) {
      const config = vectorManifest.configSchema.parse(input)
      expect(config.threads).toBe(2)
      expect(config.dimensions).toBe(256)
      expect(config.modelDir).toBeUndefined()
    }
  })

  it('配置校验失败给出精确路径（不静默取默认值）', () => {
    expect(() => vectorManifest.configSchema.parse({ threads: 0 })).toThrow()
    expect(() => vectorManifest.configSchema.parse({ threads: 1.5 })).toThrow()
    expect(() => vectorManifest.configSchema.parse({ dimensions: 0 })).toThrow()
  })

  it('vectorModule（host 入口）与 vectorManifest 指向同一清单', () => {
    expect(vectorModule.manifest).toBe(vectorManifest)
  })
})

describe('内核启动路径 —— 无 config 行不得让模块 failed（assembly.smoke 回归）', () => {
  /** 最小 `omb-memory` 桩：本模块 requires 它，缺了会被内核判为 blocked（那是另一回事）。 */
  const memoryStub: ModuleRegistration<unknown> = {
    manifest: {
      id: 'omb-memory',
      version: '3.1.0',
      requires: [],
      capabilities: [],
      configSchema: { parse: () => ({}) },
      health: () => ({ state: 'ok', detail: '桩：只为满足依赖' }),
    },
    apply: () => {},
  }

  it('start([memory, vector]) 且**不给 configs** → 不阻断、服务可用、健康不是 failed', () => {
    const handle = createKernel()
    const instance = createVectorModule()
    const missing = missingDir()
    withEnv(missing, () => {
      const blocked = handle.start([memoryStub, instance.registration])
      expect(blocked).toEqual([])
      expect(handle.kernel.service<Embedder>(EMBEDDER_SERVICE)?.id).toBe('hash-bow-256')
      const health = handle.health()['omb-memory-vector']
      expect(health?.state).not.toBe('failed')
      expect(health?.detail).not.toContain('启动失败')
      expect(health?.detail).not.toContain('expected object')
    })
  })

  it('start 且 config 显式为 null（YAML 空 `config:`）→ 同样启动', () => {
    const handle = createKernel()
    const instance = createVectorModule()
    withEnv(missingDir(), () => {
      const blocked = handle.start(
        [memoryStub, instance.registration],
        new Map([[VECTOR_MODULE_ID, null]]),
      )
      expect(blocked).toEqual([])
      expect(handle.health()['omb-memory-vector']?.state).not.toBe('failed')
    })
  })
})

describe('apply —— 同步注册（热插拔 H-2）', () => {
  it('apply 返回时嵌入器服务已可用（不是异步注册）', () => {
    const kern = createKernel()
    const instance = createVectorModule()
    const dispose = instance.apply(kern.kernel, { modelDir: missingDir() })

    const embedder = kern.kernel.service<Embedder>(EMBEDDER_SERVICE)
    expect(embedder).toBeDefined()
    expect(embedder?.id).toBe('hash-bow-256')
    expect(embedder?.dimensions).toBe(256)
    expect(embedder?.revision).toBe('1')
    // 探测在飞行中（模型目录不存在时不会飞行；这里显式断言同步可见的状态）
    expect(instance.state().channel).toBe('hash-bow')
    dispose()
  })

  it('哈希兜底维度可配置（id 随维度改变，归属标签不说谎）', () => {
    const kern = createKernel()
    const instance = createVectorModule()
    const dispose = instance.apply(kern.kernel, { modelDir: missingDir(), dimensions: 512 })
    const embedder = kern.kernel.service<Embedder>(EMBEDDER_SERVICE)
    expect(embedder?.id).toBe('hash-bow-512')
    expect(embedder?.dimensions).toBe(512)
    dispose()
  })

  it('缺省配置（undefined）也能启动，并诚实说明为什么没走 ONNX', () => {
    const kern = createKernel()
    const instance = createVectorModule()
    const missing = missingDir()
    withEnv(missing, () => {
      const dispose = instance.apply(kern.kernel)
      expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)?.id).toBe('hash-bow-256')
      const health = instance.manifest.health()
      expect(health.state).toBe('degraded')
      expect(health.detail).toContain('降级原因')
      expect(health.detail).toContain('权重目录不存在')
      dispose()
    })
  })

  it('热重载语义：后注册者胜，且旧 disposer 不得误删新服务', () => {
    const kern = createKernel()
    const first = createVectorModule()
    const second = createVectorModule()
    const disposeFirst = first.apply(kern.kernel, { modelDir: missingDir(), dimensions: 256 })
    const disposeSecond = second.apply(kern.kernel, { modelDir: missingDir(), dimensions: 512 })
    expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)?.id).toBe('hash-bow-512')

    // 真实 reconcile 顺序：旧 fiber 的 disposer 可能晚于新注册执行
    disposeFirst()
    expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)?.id).toBe('hash-bow-512')
    disposeSecond()
    expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)).toBeUndefined()
  })
})

describe('ONNX 探测 —— 升级门面，不二次注册', () => {
  it('探测成功后服务就地升级为 512 维 BGE（身份/维度/修订都变）', async () => {
    const kern = createKernel()
    const modelDir = makeModelDir()
    const seen: OnnxEmbedderOptions[] = []
    const instance = createVectorModule({
      loadOnnx: async (options): Promise<OnnxLoad> => {
        seen.push(options)
        return { ok: true, embedder: BGE, modelDir: options.modelDir ?? 'unknown' }
      },
    })

    const dispose = instance.apply(kern.kernel, { modelDir, threads: 3 })
    // apply 刚返回：同步可见的是哈希兜底，且探测在飞行中
    expect(instance.state().probing).toBe(true)
    expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)?.dimensions).toBe(256)

    await vi.waitFor(() => expect(instance.state().channel).toBe('onnx'))
    const embedder = kern.kernel.service<Embedder>(EMBEDDER_SERVICE)
    expect(embedder?.id).toBe(BGE_EMBEDDER_ID)
    expect(embedder?.dimensions).toBe(512)
    expect(embedder?.revision).toBe('1')
    expect(seen[0]?.threads).toBe(3)
    expect(seen[0]?.modelDir).toBe(modelDir)

    const health = instance.manifest.health()
    expect(health.state).toBe('ok')
    expect(health.detail).toContain(BGE_EMBEDDER_ID)
    expect(health.metrics?.['onnx']).toBe(1)
    expect(kern.status().join('\n')).toContain('神经嵌入')
    dispose()
  })

  it('探测失败 → 留在哈希兜底，原因可读且出现在状态面', async () => {
    const kern = createKernel()
    const instance = createVectorModule({
      loadOnnx: async (): Promise<OnnxLoad> => ({
        ok: false,
        reason: 'onnxruntime-node 不可加载（optionalDependency 未安装）',
      }),
    })
    const dispose = instance.apply(kern.kernel, { modelDir: makeModelDir() })
    await vi.waitFor(() => expect(instance.state().probing).toBe(false))

    expect(instance.state().channel).toBe('hash-bow')
    expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)?.id).toBe('hash-bow-256')
    const health = instance.manifest.health()
    expect(health.state).toBe('degraded')
    expect(health.detail).toContain('hash-bow-256')
    expect(health.detail).toContain('onnxruntime-node 不可加载')
    expect(health.metrics?.['channel']).toBe(1)

    const status = kern.status().join('\n')
    expect(status).toContain(VECTOR_MODULE_ID)
    expect(status).toContain('onnxruntime-node 不可加载')
    dispose()
  })

  it('装载器抛异常也被接住（探测异常 ≠ 模块崩溃）', async () => {
    const kern = createKernel()
    const instance = createVectorModule({
      loadOnnx: async () => {
        throw new Error('probe boom')
      },
    })
    const dispose = instance.apply(kern.kernel, { modelDir: makeModelDir() })
    await vi.waitFor(() => expect(instance.state().reason).toContain('ONNX 探测异常'))
    expect(instance.state().channel).toBe('hash-bow')
    expect(instance.manifest.health().detail).toContain('probe boom')
    dispose()
  })
})

describe('health / 状态面 —— 必须写明通道与降级原因', () => {
  it('健康面写明当前通道；降级必带原因（无空降级）', () => {
    const instance = createVectorModule()
    const dispose = instance.apply(createKernel().kernel, { modelDir: missingDir() })
    const health = instance.manifest.health()
    expect(health.state).toBe('degraded')
    expect(health.detail).toContain('向量通道：哈希词袋 hash-bow-256（256 维）')
    expect(health.detail).toContain('降级原因：权重目录不存在')
    dispose()
  })

  it('未启动时的健康面也是可读的（不是空降级）', () => {
    const health = createVectorModule().manifest.health()
    expect(health.state).toBe('degraded')
    expect(health.detail).toContain('模块尚未启动')
  })

  it('apply 与 dispose 都会上报健康（观测面跟随真实状态）', () => {
    const kern = createKernel()
    const reported: ModuleHealth[] = []
    const scoped: Kernel = { ...kern.kernel, report: (h) => reported.push(h) }
    const instance = createVectorModule()
    const dispose = instance.apply(scoped, { modelDir: missingDir() })
    expect(reported.at(-1)?.state).toBe('degraded')
    expect(reported.at(-1)?.detail).toContain('降级原因')
    dispose()
    expect(reported.at(-1)?.state).toBe('ok')
    expect(reported.at(-1)?.detail).toContain('已关闭')
  })
})

describe('dispose —— 幂等、不抛、无残留（H-1）', () => {
  it('注销服务与状态面段落；重复 dispose 不抛', () => {
    const kern = createKernel()
    const instance = createVectorModule()
    const dispose = instance.apply(kern.kernel, { modelDir: missingDir() })
    expect(kern.status().join('\n')).toContain(VECTOR_MODULE_ID)

    dispose()
    expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)).toBeUndefined()
    expect(kern.status().join('\n')).not.toContain(VECTOR_MODULE_ID)
    expect(instance.state().channel).toBe('off')
    expect(instance.manifest.health().state).toBe('ok')
    expect(instance.manifest.health().detail).toContain('纯词法')

    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })

  it('卸载后到达的探测结果不得升级（否则原生会话泄漏）', async () => {
    const kern = createKernel()
    let resolveLoad: ((value: OnnxLoad) => void) | undefined
    const instance = createVectorModule({
      loadOnnx: () =>
        new Promise<OnnxLoad>((resolve) => {
          resolveLoad = resolve
        }),
    })
    const dispose = instance.apply(kern.kernel, { modelDir: makeModelDir() })
    dispose()
    resolveLoad?.({ ok: true, embedder: BGE, modelDir: 'late' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(instance.state().channel).toBe('off')
    expect(kern.kernel.service<Embedder>(EMBEDDER_SERVICE)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// §5.7 硬要求：关掉向量模块 → 纯词法路径完整可用
// ---------------------------------------------------------------------------

function sampleRecord(): MemoryRecord {
  return {
    id: 'm1',
    scope: 'user',
    kind: 'semantic',
    text: '长期记忆系统',
    contentHash: 'h1',
    sourceRef: 'session:t1',
    assertedBy: 'user',
    observedAt: 1,
    validTo: null,
    supersededBy: null,
    lastUsedAt: 0,
    useCount: 0,
    project: null,
  }
}

/** 只实现词法检索所需的最小存储（真实 store 由 store-dev 拥有）。 */
function fakeStore(record: MemoryRecord): MemoryStore {
  return {
    scope: 'user',
    async put(): Promise<void> {},
    async get(id) {
      return id === record.id ? record : undefined
    },
    async getMany(ids) {
      return ids.includes(record.id) ? [record] : []
    },
    async searchLexical() {
      return [{ id: record.id, score: 1, channel: 'lexical' as const }]
    },
    async searchVector() {
      return [] // 本用例只验词法路径：向量通道不参与（§5.7）
    },
    async upsertEdge(): Promise<void> {},
    async walkGraph() {
      return { nodes: [], edges: [] }
    },
    async forget() {
      return 0
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      return fn()
    },
    async stats() {
      return { scope: 'user' as const, rows: 1, schemaVersion: 1, vectors: null }
    },
    async close(): Promise<void> {},
  }
}

describe('§5.7 关掉向量模块 → 纯词法路径完整可用', () => {
  it('模块关/开/关三态下，词法结果完全一致且无降级记录', async () => {
    const kern = createKernel()
    const instance: VectorModuleInstance = createVectorModule()
    const stores: readonly TaggedStore[] = [{ scope: 'user', store: fakeStore(sampleRecord()) }]

    const run = async () => {
      const embedder = kern.kernel.service<Embedder>(EMBEDDER_SERVICE)
      return retrieve(stores, { text: '记忆', limit: 3 }, {
        clock: { now: () => 1 },
        ...(embedder !== undefined ? { embedder } : {}),
      })
    }

    const before = await run() // 模块未启动
    const dispose = instance.apply(kern.kernel, { modelDir: missingDir() })
    const during = await run() // 模块开启（哈希兜底；本模块不注册第二通道）
    dispose()
    const after = await run() // 模块关闭

    expect(before.gate.retrieve).toBe(true)
    expect(before.items.map((i) => i.text)).toEqual(['长期记忆系统'])
    expect(during.items).toEqual(before.items)
    expect(after.items).toEqual(before.items)
    // 关掉模块不是"降级"：词法路径本来就是完整的
    expect(after.degraded).toEqual([])
    expect(after.note).toBe(before.note)
  })
})
