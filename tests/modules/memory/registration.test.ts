/**
 * 注册入口测试：清单契约、配置缺省值、`stores` 服务与 disposer 的 H-1 保证。
 *
 * 一份用 **fake Kernel**（可以直接拿到并调用 disposer，验证"绝不抛"），
 * 一份用 **真实内核**（验证 `start` 的装配顺序与 health 面的实际输出）。
 */
import { describe, expect, it } from 'vitest'
import type {
  ContextPressure,
  Kernel,
  ModuleHealth,
  ModuleRegistration,
  SecondaryChannelRegistry,
  ToolDefinition,
} from '../../../kernel/abi/index.js'
import { MODULE_CATALOG, SERVICES, SCHEMA_VERSION, toolsServiceFor } from '../../../kernel/abi/index.js'
import type { RetrievalChannel } from '../../../modules/memory/retrieve.js'
import { createKernel } from '../../../kernel/index.js'
import {
  MEMORY_CONFIG_DEFAULTS,
  MODULE_ID,
  STORAGE_HOST_SERVICE,
  createMemoryRegistration,
  memoryConfigSchema,
  readMemoryConfig,
} from '../../../modules/memory/index.js'
import { asMemoryStore, type MemoryStoresService } from '../../../modules/memory/store.js'
import {
  type CapturingLogger,
  capturingLogger,
  countingSqlite,
  fixedClock,
  makeRecord,
  nodeSqlite,
  tempWorkspace,
  testPort,
} from './helpers.js'

interface FakeKernel {
  readonly kernel: Kernel
  readonly services: Map<string, unknown>
  readonly reported: ModuleHealth[]
  readonly logger: CapturingLogger
}

function fakeKernel(): FakeKernel {
  const services = new Map<string, unknown>()
  const reported: ModuleHealth[] = []
  const logger = capturingLogger()
  const pressure: ContextPressure = {
    totalTokens: 0,
    fillRatio: null,
    band: 'relaxed',
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    nodes: [],
  }
  const kernel: Kernel = {
    provide: <T,>(name: string, service: T) => {
      services.set(name, service)
      return () => {
        if (services.get(name) === service) services.delete(name)
      }
    },
    service: <T,>(name: string) => services.get(name) as T | undefined,
    services: () => [...services.keys()].sort(),
    emit: () => {},
    on: () => () => {},
    budget: () => undefined,
    report: health => void reported.push(health),
    pressure: () => pressure,
    focus: () => 'standard',
    setFocus: () => {},
    logger,
    clock: fixedClock(),
  }
  return { kernel, services, reported, logger }
}

function disposerOf(registration: ReturnType<typeof createMemoryRegistration>, kernel: Kernel): () => void | Promise<void> {
  const disposer = registration.apply(kernel, MEMORY_CONFIG_DEFAULTS)
  if (typeof disposer !== 'function') throw new Error('apply 必须返回 disposer（热插拔要求）')
  return disposer
}

/**
 * `omb-memory` 依赖 `omb-kernel`，因此内核 `start()` 里必须有这一行。
 * 这是**测试替身**而不是 `dsh/` 的真实内核行：模块测试不该依赖集成层。
 */
const kernelRow: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.0.0',
    requires: [],
    capabilities: [],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试替身' }),
  },
  apply: () => {},
}

describe('omb-memory 清单', () => {
  it('id / requires / capabilities 与 MODULE_CATALOG 完全一致（契约三方一致）', () => {
    const registration = createMemoryRegistration()
    const entry = MODULE_CATALOG.find(candidate => candidate.id === MODULE_ID)
    expect(entry).toBeDefined()
    expect(registration.manifest.id).toBe('omb-memory')
    expect(registration.manifest.requires).toEqual(entry?.requires)
    // 能力与工具是**目录**的权威内容：这里只断言"清单照抄目录"，不复制目录里的取值
    // （复制一份就会变成第二处需要同步的契约；目录自身的合法性由内核契约测试保证）
    expect(registration.manifest.capabilities).toEqual(entry?.capabilities)
    expect(registration.manifest.requires).toEqual(['omb-kernel'])
    expect(entry?.tools).toEqual(expect.arrayContaining(['omb_recall', 'omb_forget']))
    expect(entry?.capabilities).toEqual(expect.arrayContaining(['memory.write', 'memory.recall']))
    expect(registration.manifest.version).toBe('3.0.0')
  })

  it('服务名契约为 stores（与 ABI 的 SERVICES 一致）', () => {
    expect(SERVICES.stores).toBe('stores')
    expect(STORAGE_HOST_SERVICE).toBe('omb.storage-host')
  })
})

describe('omb-memory 配置', () => {
  it('缺省值完整：undefined / null / {} 都得到可直接使用的配置', () => {
    expect(memoryConfigSchema.parse(undefined)).toEqual(MEMORY_CONFIG_DEFAULTS)
    expect(memoryConfigSchema.parse(null)).toEqual(MEMORY_CONFIG_DEFAULTS)
    expect(memoryConfigSchema.parse({})).toEqual(MEMORY_CONFIG_DEFAULTS)
    expect(MEMORY_CONFIG_DEFAULTS).toEqual({ consolidationEveryTurns: 32, embeddingThreads: 2 })
  })

  it('部分配置补齐其余缺省值（apply 永远收到完整配置）', () => {
    expect(memoryConfigSchema.parse({ consolidationEveryTurns: 8 })).toEqual({
      consolidationEveryTurns: 8,
      embeddingThreads: 2,
    })
    expect(memoryConfigSchema.parse({ embeddingThreads: 4 })).toEqual({
      consolidationEveryTurns: 32,
      embeddingThreads: 4,
    })
  })

  it('非法配置被拒（路径可读）', () => {
    expect(() => memoryConfigSchema.parse({ consolidationEveryTurns: 0 })).toThrow()
    expect(() => memoryConfigSchema.parse({ consolidationEveryTurns: 1.5 })).toThrow()
    expect(() => memoryConfigSchema.parse({ embeddingThreads: 'many' })).toThrow()
  })

  it('readMemoryConfig：服务缺失时回落到缺省值，存在时读同一份配置', () => {
    const { kernel, services } = fakeKernel()
    expect(readMemoryConfig(kernel)).toEqual(MEMORY_CONFIG_DEFAULTS)

    services.set(SERVICES.stores, { config: { embeddingThreads: 4 } })
    expect(readMemoryConfig(kernel)).toEqual({ consolidationEveryTurns: 32, embeddingThreads: 4 })
  })
})

describe('omb-memory apply（fake Kernel）', () => {
  it('同步 provide("stores")，返回 disposer；端口经内核服务注入也生效', async () => {
    const ws = tempWorkspace()
    const { kernel, services } = fakeKernel()
    services.set(STORAGE_HOST_SERVICE, testPort(ws.dir))

    const registration = createMemoryRegistration()
    const dispose = disposerOf(registration, kernel)

    const service = services.get(SERVICES.stores) as MemoryStoresService | undefined
    expect(service).toBeDefined()
    expect(await service?.forProject(ws.dir)).toBeDefined()

    await dispose()
    expect(services.has(SERVICES.stores)).toBe(false)
    // 注销后旧句柄不可再用，但操作本身只是报错，不会静默返回脏数据
    await expect(service?.forProject(ws.dir)).resolves.toBeUndefined()
    ws.cleanup()
  })

  it('构造时直接注入 storageHost 是首选路径（不依赖服务名）', async () => {
    const ws = tempWorkspace()
    const { kernel, services } = fakeKernel()
    const registration = createMemoryRegistration({ storageHost: testPort(ws.dir) })
    const dispose = disposerOf(registration, kernel)

    const service = services.get(SERVICES.stores) as MemoryStoresService
    expect(await service.forProject(ws.dir)).toBeDefined()
    await dispose()
    ws.cleanup()
  })

  it('disposer 绝不抛：底层关闭失败时也 resolve（H-1，保护 reconcileProfilePatches）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir, {
      openDatabase: path => {
        const real = countingSqlite(nodeSqlite(path))
        return {
          exec: sql => real.exec(sql),
          prepare: sql => real.prepare(sql),
          close: () => {
            real.close()
            throw new Error('关闭爆炸')
          },
        }
      },
    })
    const { kernel, services, logger } = fakeKernel()
    const registration = createMemoryRegistration({ storageHost: port })
    const dispose = disposerOf(registration, kernel)

    const service = services.get(SERVICES.stores) as MemoryStoresService
    expect(await service.forProject(ws.dir)).toBeDefined()

    await expect(Promise.resolve(dispose())).resolves.toBeUndefined()
    await expect(Promise.resolve(dispose())).resolves.toBeUndefined()
    expect(logger.warnings.join('\n')).toContain('关闭爆炸')
    ws.cleanup()
  })

  it('未启动时 health 是 degraded 且写明原因（无空降级）', async () => {
    const registration = createMemoryRegistration()
    const health = await registration.manifest.health()
    expect(health.state).toBe('degraded')
    expect(health.detail).toContain('未启动')
  })

  it('端口缺失时 health 说明"宿主未注入"，而不是"不可用"', async () => {
    const { kernel } = fakeKernel()
    const registration = createMemoryRegistration()
    disposerOf(registration, kernel)

    const health = await registration.manifest.health()
    expect(health.state).toBe('degraded')
    expect(health.detail).toContain('宿主未注入')
  })
})

describe('omb-memory 与真实内核', () => {
  it('start 装配成功；health 写明库路径、行数、schema 版本与迁移结果', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const logger = capturingLogger()
    const handle = createKernel({ logger, clock: fixedClock() })
    const registration = createMemoryRegistration({ storageHost: port })

    expect(handle.start([kernelRow, registration])).toEqual([])

    const service = handle.kernel.service<MemoryStoresService>(SERVICES.stores)
    expect(service).toBeDefined()
    const set = await service?.forProject(ws.dir)
    expect(set?.projectScope).toBeTruthy()
    await set?.store('project')?.put(makeRecord({ scope: 'project', id: 'p1', text: '项目记忆' }))

    const health = await registration.manifest.health()
    expect(health.state).toBe('ok')
    expect(health.detail).toContain('knowledge.db')
    expect(health.detail).toContain('session.db')
    expect(health.detail).toContain('行数=1')
    expect(health.detail).toContain(`schema=v${SCHEMA_VERSION}`)
    expect(health.detail).toContain('迁移 v0→v1')
    expect(health.metrics?.['rows.total']).toBe(1)
    expect(health.metrics?.['openProjects']).toBe(1)

    // 关闭后库确实关了：旧句柄报错而不是继续读写
    handle.dispose()
    await service?.close()
    await expect(set?.store('project')?.stats()).rejects.toThrow(/关闭/)

    ws.cleanup()
  })

  it('内核未传 config 时走完整缺省值，且模块仍可读写', async () => {
    const ws = tempWorkspace()
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
    const registration = createMemoryRegistration({ storageHost: testPort(ws.dir) })

    expect(handle.start([kernelRow, registration])).toEqual([])
    expect(readMemoryConfig(handle.kernel)).toEqual(MEMORY_CONFIG_DEFAULTS)

    const service = handle.kernel.service<MemoryStoresService>(SERVICES.stores)
    const set = await service?.forProject(ws.dir)
    const store = set?.store('project')
    expect(store).toBeDefined()
    await store?.put(makeRecord({ scope: 'project', id: 'p1', text: '记忆内容' }))
    expect(await store?.get('p1')).toMatchObject({ id: 'p1' })
    expect(asMemoryStore(store as never)?.dbPath).toContain('session.db')

    handle.dispose()
    await service?.close()
    ws.cleanup()
  })

  it('宿主端口缺失时模块仍启动成功（降级而非失败，绝不连坐会话）', async () => {
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
    const registration = createMemoryRegistration()

    expect(handle.start([kernelRow, registration])).toEqual([])
    expect(handle.kernel.service(SERVICES.stores)).toBeDefined()

    const health = await registration.manifest.health()
    expect(health.state).toBe('degraded')
    expect(health.detail).toContain('未注入')

    handle.dispose()
  })
})

describe('omb-memory 工具面（tools:omb-memory）', () => {
  function toolsOf(handle: ReturnType<typeof createKernel>): readonly ToolDefinition[] | undefined {
    return handle.kernel.service<readonly ToolDefinition[]>(toolsServiceFor('omb-memory'))
  }

  it('apply 内同步提供三个工具（recall/forget/relate），与目录声明一致', () => {
    const ws = tempWorkspace()
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
    const registration = createMemoryRegistration({ storageHost: testPort(ws.dir) })
    handle.start([kernelRow, registration])

    const tools = toolsOf(handle)
    expect(tools?.map(tool => tool.name).sort()).toEqual(['omb_forget', 'omb_recall', 'omb_relate'])

    handle.dispose()
    // 注销后工具服务消失 → dsh 的工具面里不会留下"关掉了还在"的工具
    expect(toolsOf(handle)).toBeUndefined()
    ws.cleanup()
  })

  it('端到端：turn/start 预热项目库后，omb_recall 能取回该项目库的记忆（逐字 + 溯源）', async () => {
    const ws = tempWorkspace()
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
    const registration = createMemoryRegistration({ storageHost: testPort(ws.dir) })
    handle.start([kernelRow, registration])

    const service = handle.kernel.service<MemoryStoresService>(SERVICES.stores)
    expect(service).toBeDefined()
    service?.rememberCwd('s1', ws.dir)
    handle.kernel.emit('turn/start', { sessionId: 's1', turn: 1 })

    const set = await service?.forSession('s1')
    await set?.store('project')?.put(
      makeRecord({ scope: 'project', id: 'p-conv', text: '项目约定：提交前先跑 pnpm verify', sourceRef: 'session:s1#turn-1' }),
    )
    expect(service?.peek('s1')?.projectScope).toBeTruthy()

    const recall = toolsOf(handle)?.find(tool => tool.name === 'omb_recall')
    const outcome = await recall?.execute({ query: 'pnpm verify', limit: 5 })
    expect(outcome?.kind).toBe('text')
    expect(outcome?.kind === 'text' ? outcome.text : '').toContain('pnpm verify')
    // 溯源随行：消费者免费拿到 sourceRef 与 observedAt（逐字 + 溯源，不再需要额外查询）
    expect(outcome?.kind === 'text' ? outcome.text : '').toContain('session:s1#turn-1')
    expect(outcome?.kind === 'text' ? outcome.text : '').toContain('observedAt=')

    handle.dispose()
    await service?.close()
    ws.cleanup()
  })

  it('服务未就绪时工具返回 kind:error（绝不抛）——H-3', async () => {
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
    const registration = createMemoryRegistration() // 没有存储端口 → 库永远打不开
    handle.start([kernelRow, registration])

    const tools = toolsOf(handle)
    expect(tools).toHaveLength(3)
    for (const tool of tools ?? []) {
      const outcome = await tool.execute({ query: '任意', id: '任意', ids: ['任意'] })
      expect(outcome.kind).toBe('error')
    }

    handle.dispose()
  })

  it('消费第二通道登记处：只有向量通道能命中的记忆也会被召回（关掉则退化纯词法）', async () => {
    const ws = tempWorkspace()
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })

    // 向量模块的等价物：Embedder 槽 + 把自己的通道登记进**内核提供的**登记处
    // （ABI `retrieval:channels`，由 `kernel/index.ts` provide）
    handle.kernel.provide(SERVICES.embedder, {
      id: 'fake-vector',
      dimensions: 4,
      revision: '1',
      embed: async (texts: readonly string[]) => texts.map(() => new Float32Array(4)),
    })
    const registry = handle.kernel.service<SecondaryChannelRegistry<RetrievalChannel>>(
      SERVICES.channelRegistry,
    )
    expect(registry).toBeDefined()

    const registration = createMemoryRegistration({ storageHost: testPort(ws.dir) })
    handle.start([kernelRow, registration])
    const service = handle.kernel.service<MemoryStoresService>(SERVICES.stores)
    service?.rememberCwd('s1', ws.dir)
    handle.kernel.emit('turn/start', { sessionId: 's1', turn: 1 })
    const set = await service?.forSession('s1')
    await set?.store('project')?.put(
      makeRecord({ scope: 'project', id: 'vec-only', text: '词法上完全不同的内容', sourceRef: 'src:vec' }),
    )
    // 第二通道声称这条记忆相关（真实实现里是被 embedder 算出的近邻）。
    // 通道按库被调用：只对真正拥有该记忆的项目库回话，否则水合会按作用域找不到它。
    const offChannel = registry?.register({
      name: 'vector',
      search: async query =>
        query.store.scope === 'project' ? [{ id: 'vec-only', score: 0.9, channel: 'vector' }] : [],
    })

    const recall = toolsOf(handle)?.find(tool => tool.name === 'omb_recall')
    const withChannel = await recall?.execute({ query: '查询里不出现任何相同字词 zzzz' })
    expect(withChannel?.kind).toBe('text')
    expect(withChannel?.kind === 'text' ? withChannel.text : '').toContain('词法上完全不同的内容')

    // 关掉第二通道（注销登记）→ 同一次查询退回纯词法：召回不到（§5.7 完整可用）
    offChannel?.()
    const lexicalOnly = await recall?.execute({ query: '查询里不出现任何相同字词 zzzz' })
    expect(lexicalOnly?.kind).toBe('text')
    expect(lexicalOnly?.kind === 'text' ? lexicalOnly.text : '').not.toContain('词法上完全不同的内容')

    handle.dispose()
    await service?.close()
    ws.cleanup()
  })
})
