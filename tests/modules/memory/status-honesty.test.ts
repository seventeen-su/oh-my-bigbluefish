/**
 * 自述的诚实性：**未测量 ≠ 测量为零**，且**同一份事实只报一处**。
 *
 * 报告踩过的坑：状态面把"没测到"渲染成 `0`，或者把"一次都没发生过"渲染成"正常"。
 * 两者都会让状态面**看起来在报数，其实什么都没测**——比不报更坏（它把真问题掩盖了）。
 *
 * 本文件把记忆模块自己的输出钉住：
 * ① 「会话→cwd」与「已打开项目库」**只在「存储」段报**：模块行进的是上报快照，
 *    印实时计数必然与实时读数打架（实测模块段 0/0、存储段 1/1，三次调用都一样）
 * ② 一个库都没打开时，行数/向量合计是"未测量"，**不写 0**
 * ③ 一次向量检索都没发生过时，报"尚未发生（无读数）"，**不写"正常"**
 * ④ 没有迁移发生时，不写"迁移 v0→v0"（那会把"未记录"伪装成一个版本号）
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import type { MemoryStore, ModuleRegistration, ScoredHit, TaggedStore } from '../../../kernel/abi/index.js'
import { createMemoryRegistration } from '../../../modules/memory/index.js'
import type { MemoryStoresService } from '../../../modules/memory/store.js'
import { createStoresService, openMemoryStore } from '../../../modules/memory/store.js'
import { retrieve } from '../../../modules/memory/retrieve.js'
import { createVectorModule } from '../../../modules/memory/vector.js'
import { capturingLogger, fixedClock, tempWorkspace, testPort, testSessionCwds } from './helpers.js'

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

describe('存储服务的自述：不再出现第二份会话→cwd / 已打开项目库计数', () => {
  it('status().detail 只讲就绪与失败原因，计数交给状态面的「存储」段', async () => {
    const ws = tempWorkspace('omb-status-')
    const cwds = testSessionCwds()
    const service = createStoresService({
      logger: capturingLogger(),
      clock: fixedClock(),
      resolvePort: () => testPort(ws.dir),
      resolveSessionCwd: cwds.resolveSessionCwd,
      knownSessionCwds: cwds.knownSessionCwds,
    })
    cwds.remember('s1', ws.dir)
    await service.forSession('s1') // 真的打开一个项目库

    const status = service.status()
    expect(status.openProjects).toHaveLength(1)
    expect(status.maxOpenProjects).toBe(16) // 计数由调用方（状态面）报，且只报一次
    expect(status.detail).not.toMatch(/会话→cwd|已打开项目库|项目库 \d+\//)

    await service.close()
    ws.cleanup()
  })

  it('没有迁移发生时写"本次打开未迁移"，不写"迁移 v0→v0"', async () => {
    const ws = tempWorkspace('omb-status-')
    const port = testPort(ws.dir)
    const first = createStoresService({ logger: capturingLogger(), clock: fixedClock(), resolvePort: () => port })
    await first.forProject(ws.dir) // 首次打开：v0→v1，真的迁移了
    expect(first.status().detail).toContain('迁移 v0→v1')
    await first.close()

    // 第二次打开：库已是最新，没有任何迁移发生 —— 这里绝不能写 v0→v0
    const second = createStoresService({ logger: capturingLogger(), clock: fixedClock(), resolvePort: () => port })
    await second.forProject(ws.dir)
    const detail = second.status().detail
    expect(detail).toContain('本次打开未迁移：schema v1')
    expect(detail).not.toContain('迁移 v0→v0')
    await second.close()
    ws.cleanup()
  })
})

describe('健康面：没测到的不要写 0', () => {
  it('一个库都没打开：metrics 里不出现 rows.total/vectors.total（未测量不是 0）', async () => {
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
    const registration = createMemoryRegistration() // 无 storageHost → 库打不开

    expect(handle.start([kernelRow, registration])).toEqual([])
    const health = await registration.manifest.health()

    expect(health.state).toBe('degraded')
    expect(health.metrics?.['rows.total']).toBeUndefined()
    expect(health.metrics?.['vectors.total']).toBeUndefined()
    // 模块行只指向「存储」段，不重复报数
    expect(health.detail).toContain('见「存储」段')
    // openProjects 是**测到的**（0 个已打开），所以它照常报 0
    expect(health.metrics?.['openProjects']).toBe(0)
    // 降级原因不空：模块行与存储段都写得出为什么
    const service = handle.kernel.service<MemoryStoresService>('stores')
    expect(health.detail + (service?.status().detail ?? '')).toContain('未注入')

    handle.dispose()
  })

  it('库确实打开了且是空库：才允许出现 rows.total=0（那是测到的 0）', async () => {
    const ws = tempWorkspace('omb-status-')
    const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
    const registration = createMemoryRegistration({ storageHost: testPort(ws.dir) })
    expect(handle.start([kernelRow, registration])).toEqual([])

    const service = handle.kernel.service<MemoryStoresService>('stores')
    expect(service).toBeDefined()
    await service?.forProject(ws.dir) // 真的打开了库

    const health = await registration.manifest.health()
    expect(health.state).toBe('ok')
    expect(health.metrics?.['rows.total']).toBe(0) // 测到了：确实是 0 行
    expect(health.metrics?.['vectors.total']).toBe(0)
    // 库路径由「存储」段给出（唯一一处）
    expect(service?.status().detail).toContain('knowledge.db')

    handle.dispose()
    await service?.close()
    ws.cleanup()
  })
})

describe('向量状态面：没检索过就不能说"正常"', () => {  /** 最小库替身：只要 searchVector 返回空数组，通道就算"走通了一次"。 */
  function stubStore(): TaggedStore {
    const store = {
      scope: 'user',
      async searchVector(): Promise<readonly ScoredHit[]> {
        return []
      },
    } as unknown as MemoryStore
    return { scope: 'user', store }
  }

  it('一次检索都没发生 → "尚未发生（无读数）"，metrics.searches=0', () => {
    const kern = createKernel()
    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: 'C:/definitely/not/here' })

    const status = kern.status().join('\n')
    expect(status).toContain('最近一次检索：尚未发生（无读数')
    expect(status).not.toContain('最近一次检索：正常')
    expect(module.state().searches).toBe(0)
    expect(module.manifest.health().metrics?.['searches']).toBe(0)
    dispose()
  })

  it('真的检索过一次（走通）后才报"正常"，且次数可数', async () => {
    const kern = createKernel()
    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: 'C:/definitely/not/here' })

    await module.channel(kern.kernel).search({
      store: stubStore(),
      text: '长期记忆系统',
      scope: 'user',
      limit: 5,
    })

    expect(module.state().searches).toBe(1)
    expect(module.state().lastSearchError).toBeNull()
    expect(kern.status().join('\n')).toContain('最近一次检索：正常；已观测检索 1 次')
    dispose()
  })

  it('卸载后清掉检索读数：下次装载不能把"还没检索"错报成"检索过 N 次"', () => {
    const kern = createKernel()
    const module = createVectorModule()
    const dispose = module.apply(kern.kernel, { modelDir: 'C:/definitely/not/here' })
    dispose()
    expect(module.state().searches).toBe(0)
    expect(module.state().channelErrors).toBe(0)
  })
})

describe('检索结果：时钟不可用时是"未知"，不是 epoch 0', () => {
  it('时钟读数拿不到 → now=null 并写明降级原因（0 是看起来合法的假时间）', async () => {
    const ws = tempWorkspace('omb-status-')
    const port = testPort(ws.dir)
    const store = openMemoryStore({
      scope: 'user',
      dbPath: port.userDbPath,
      port,
      logger: capturingLogger(),
      clock: fixedClock(),
    })
    const brokenClock = {
      now: (): number => {
        throw new Error('时钟故障')
      },
    }
    const tagged: readonly TaggedStore[] = [{ scope: 'user', store }]

    const normal = await retrieve(tagged, { text: '端口', limit: 5 }, { clock: brokenClock })
    expect(normal.now).toBeNull()
    expect(normal.degraded.join('；')).toContain('时钟不可用')

    // 门控跳过的早退路径也必须如实（不能一边说"跳过"一边给一个假时间）
    const skipped = await retrieve(tagged, { text: '端口', limit: 5, mode: 'never' }, { clock: brokenClock })
    expect(skipped.now).toBeNull()
    expect(skipped.degraded.join('；')).toContain('时钟不可用')

    await store.close()
    ws.cleanup()
  })
})
