/**
 * `omb-profile` 模块级集成测试（真内核 + 假记忆库，零宿主 mock）。
 *
 * 覆盖本轮硬性验收：
 * ① 显式压过推断、冲突两条都保留
 * ② `clearDeduced` 只删推断型
 * ③ **能力轴即使开启也不产生任何落盘写入**（假的 put 计数为 0）
 * ④ 每个失败路径返回可读错误，dispose 绝不抛
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import { MODULE_CATALOG } from '../../../kernel/abi/index.js'
import type { Kernel, ModuleHealth, ModuleRegistration } from '../../../kernel/abi/index.js'
import {
  createProfileModule,
  profileConfigSchema,
  PROFILE_SERVICE,
  type ProfileService,
} from '../../../modules/profile/index.js'
import { FakeStores, fakeClock } from './fakes.js'

/** 记忆模块替身：只负责提供 `stores` 服务（满足画像的 requires）。 */
function memoryStub(stores: unknown): ModuleRegistration<unknown> {
  return {
    manifest: {
      id: 'omb-memory',
      version: '1.0.0',
      requires: [],
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: 'stub' }),
    },
    apply: (kernel: Kernel) => {
      if (stores !== undefined) kernel.provide('stores', stores)
    },
  }
}

function startProfile(
  stores: unknown,
  config?: unknown,
): { kernel: Kernel; service: ProfileService; health: () => Promise<ModuleHealth> } {
  const handle = createKernel({ clock: fakeClock() })
  const module = createProfileModule()
  handle.start(
    [memoryStub(stores), module as ModuleRegistration<unknown>],
    config === undefined ? undefined : new Map([['omb-profile', config]]),
  )
  const service = handle.kernel.service<ProfileService>(PROFILE_SERVICE)
  if (service === undefined) throw new Error('画像服务未注册（测试装配有误）')
  return {
    kernel: handle.kernel,
    service,
    health: async () => await module.manifest.health(),
  }
}

describe('注册面', () => {
  it('模块 id / 依赖 / 能力名与目录契约一致', () => {
    const module = createProfileModule()
    const entry = MODULE_CATALOG.find(candidate => candidate.id === 'omb-profile')
    expect(module.manifest.id).toBe('omb-profile')
    expect(module.manifest.requires).toEqual(entry?.requires)
    expect(module.manifest.capabilities).toEqual(entry?.capabilities)
    // 目录声明画像不注册工具（能力轴不落盘、显式条目由服务与投影消费）
    expect(entry?.tools).toEqual([])
  })

  it('配置缺省值完整：inferCapabilityAxis 默认 false（D4）', () => {
    expect(profileConfigSchema.parse(undefined)).toEqual({ inferCapabilityAxis: false })
    expect(profileConfigSchema.parse({ inferCapabilityAxis: true })).toEqual({ inferCapabilityAxis: true })
  })
})

describe('显式条目与冲突', () => {
  it('显式声明写入记忆库，可读回', async () => {
    const stores = new FakeStores()
    const { service } = startProfile(stores)
    const mutation = await service.declare({ axis: 'stable', key: 'tone', value: '简洁', evidence: ['s1#2'] })

    expect(mutation.ok).toBe(true)
    expect(mutation.outcome).toBe('added')
    expect(stores.puts).toBe(1)
    const entries = await service.entries()
    expect(entries).toEqual([
      { axis: 'stable', key: 'tone', value: '简洁', provenance: 'declared', evidence: ['s1#2'], updated: expect.any(Number) },
    ])
  })

  it('矛盾的两条显式声明都保留，并作为冲突被检出、被渲染', async () => {
    const stores = new FakeStores()
    const { service } = startProfile(stores)
    await service.declare({ axis: 'stable', key: 'tone', value: '简洁' })
    const second = await service.declare({ axis: 'stable', key: 'tone', value: '详尽' })

    expect(second.outcome).toBe('conflict')
    expect(second.conflict).toBe(true)
    expect(await service.entries()).toHaveLength(2)

    const conflicts = await service.conflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.values.map(v => v.value).sort()).toEqual(['简洁', '详尽'])

    const text = await service.renderConflicts()
    expect(text).toContain('简洁')
    expect(text).toContain('详尽')
    expect(text).toContain('不替你选择')
  })

  it('推断进不来：显式声明在，推断被拒且不写存储、不改变取值', async () => {
    const stores = new FakeStores()
    const { service } = startProfile(stores)
    await service.declare({ axis: 'stable', key: 'tone', value: '简洁' })
    const before = stores.puts

    const mutation = await service.infer({ axis: 'stable', key: 'tone', value: '冗长' })
    expect(mutation.outcome).toBe('inferred-blocked-by-declared')
    expect(mutation.ok).toBe(true)
    expect(stores.puts).toBe(before) // 被拒绝 → 没有写入
    expect((await service.entries()).map(e => e.value)).toEqual(['简洁'])
  })

  it('推断条目落项目库（不外溢），clearDeduced 只删它', async () => {
    const stores = new FakeStores()
    const { service } = startProfile(stores)
    await service.declare({ axis: 'stable', key: 'tone', value: '简洁' })
    await service.infer({ axis: 'collaboration', key: 'style', value: '直接给结论' })
    expect(stores.project.putCalls).toHaveLength(1)
    expect((await service.entries()).some(e => e.provenance === 'inferred')).toBe(true)

    const cleared = await service.clearDeduced()
    expect(cleared.ok).toBe(true)
    expect(cleared.removed).toBe(1)
    const left = await service.entries()
    expect(left.map(e => e.value)).toEqual(['简洁'])
    expect(left.every(e => e.provenance === 'declared')).toBe(true)
  })
})

describe('能力轴：默认关闭，且永不落盘（D4）', () => {
  it('默认关闭：不接受任何能力观察', async () => {
    const stores = new FakeStores()
    const { service, health } = startProfile(stores)
    expect(service.observeCapability('s1', { key: 'lang', value: '中文' })).toBe(false)
    expect(service.capability('s1')).toEqual([])
    expect((await health()).detail).toContain('能力轴关闭')
  })

  it('开启后：观察只进会话内存，**存储写入次数为 0**，健康面如实写明', async () => {
    const stores = new FakeStores()
    const { service, health } = startProfile(stores, { inferCapabilityAxis: true })
    const before = stores.puts

    expect(service.observeCapability('s1', { key: 'lang', value: '中文', evidence: ['s1#1'] })).toBe(true)
    expect(service.observeCapability('s1', { key: 'level', value: '熟练' })).toBe(true)

    // 关键断言：能力轴开启也不会产生任何落盘写入
    expect(stores.puts).toBe(before)
    expect(stores.puts).toBe(0)
    expect(service.capability('s1')).toHaveLength(2)

    const status = service.status()
    expect(status.capabilityAxis).toBe('on-session-only')
    const detail = (await health()).detail
    expect(detail).toContain('不写任何存储')
    expect(detail).toContain('能力轴已开启')
  })

  it('同一取值重复观察不改变快照引用（供 sessionProjections 的同一引用不变量）', () => {
    const { service } = startProfile(new FakeStores(), { inferCapabilityAxis: true })
    const first = service.capability('s1')
    service.observeCapability('s1', { key: 'lang', value: '中文' })
    const after = service.capability('s1')
    expect(after).not.toBe(first) // 有变化 → 新引用
    service.observeCapability('s1', { key: 'lang', value: '中文' })
    expect(service.capability('s1')).toBe(after) // 无新信息 → 同一引用
  })

  it('能力轴即使误传也不会落盘（结构性拒绝），且 clearDeduced 会清会话内存', async () => {
    const stores = new FakeStores()
    const { service } = startProfile(stores, { inferCapabilityAxis: true })
    service.observeCapability('s1', { key: 'lang', value: '中文' })

    // 绕过类型：模拟运行期传入 capability 轴的 infer
    const rejected = await service.infer({ axis: 'capability' as never, key: 'lang', value: '中文' })
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('observeCapability')
    expect(stores.puts).toBe(0)

    const cleared = await service.clearDeduced()
    expect(cleared.removed).toBe(1)
    expect(service.capability('s1')).toEqual([])
  })

  it('空会话 id / 空 key 不记录', () => {
    const { service } = startProfile(new FakeStores(), { inferCapabilityAxis: true })
    expect(service.observeCapability('', { key: 'k', value: 'v' })).toBe(false)
    expect(service.observeCapability('s1', { key: '  ', value: 'v' })).toBe(false)
  })
})

describe('降级与热插拔', () => {
  it('订阅 turn/start：会话 id 用于取库（dsh 侧无需为画像额外接线）', async () => {
    const stores = new FakeStores()
    const { kernel, service } = startProfile(stores)
    kernel.emit('turn/start', { sessionId: 'sess-42', turn: 1 })
    await service.entries()
    expect(stores.sessionCalls).toEqual(['sess-42'])
  })

  it('记忆服务缺失 → 健康面 degraded 且原因可读，能力轴说明不受影响', async () => {
    const { service, health } = startProfile(undefined)
    const detail = (await health()).detail
    expect(detail).toContain('stores 不可用')
    expect(detail).toContain('能力轴关闭')

    const mutation = await service.declare({ axis: 'stable', key: 'k', value: 'v' })
    expect(mutation.ok).toBe(false)
    expect(mutation.error).toContain('stores 不可用')
  })

  it('配置非法 → 模块标记 failed 且原因可读', () => {
    const handle = createKernel()
    handle.start(
      [memoryStub(new FakeStores()), createProfileModule() as ModuleRegistration<unknown>],
      new Map([['omb-profile', { inferCapabilityAxis: 'yes' }]]),
    )
    expect(handle.health()['omb-profile']?.state).toBe('failed')
    expect(handle.health()['omb-profile']?.detail).toContain('启动失败')
  })

  it('dispose 注销服务、清会话内存且绝不抛', async () => {
    const handle = createKernel()
    const module = createProfileModule()
    handle.start([memoryStub(new FakeStores()), module as ModuleRegistration<unknown>], new Map([['omb-profile', { inferCapabilityAxis: true }]]))
    const service = handle.kernel.service<ProfileService>(PROFILE_SERVICE)
    expect(service).toBeDefined()
    service?.observeCapability('s1', { key: 'k', value: 'v' })

    expect(() => handle.dispose()).not.toThrow()
    expect(handle.listenerCount()).toBe(0)
    expect(handle.kernel.service(PROFILE_SERVICE)).toBeUndefined()

    // 卸载后旧引用仍可调用：返回可读错误而不是抛
    const after = await service!.declare({ axis: 'stable', key: 'k', value: 'v' })
    expect(after.ok).toBe(false)
    expect(after.error).toContain('已卸载')
    expect((await module.manifest.health()).detail).toContain('模块未启动')
  })
})
