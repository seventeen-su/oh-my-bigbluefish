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
import type { Kernel, ModuleHealth, ModuleRegistration, PromptContribution } from '../../../kernel/abi/index.js'
import {
  createProfileModule,
  profileConfigSchema,
  PROFILE_PROMPT_SERVICE,
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

  it('同一取值重复观察不改变快照引用（重复观察不让消费者引用抖动）', () => {
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

    // 声明路径同样拒绝：否则调用方会以为"声明成功"而实际什么都没写
    const declared = await service.declare({ axis: 'capability' as never, key: 'lang', value: '中文' })
    expect(declared.ok).toBe(false)
    expect(declared.error).toContain('observeCapability')
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

describe('R8 呈现路径（prompt:omb-profile）', () => {
  it('无冲突时为空串；有冲突时同时给出两种说法与"不替你选择"', async () => {
    const stores = new FakeStores()
    const { kernel, service } = startProfile(stores)
    const contribution = kernel.service<PromptContribution>(PROFILE_PROMPT_SERVICE)
    expect(contribution).toBeDefined()
    expect(contribution?.resident).toBeUndefined() // 常驻前缀必须稳定，冲突是易变信息

    const render = (): string =>
      contribution?.context?.({ sessionId: 's1', depth: 'standard', band: 'relaxed' }) ?? ''

    await service.declare({ axis: 'stable', key: 'tone', value: '简洁' })
    expect(render()).toBe('') // 无冲突 → 不占用任何上下文

    await service.declare({ axis: 'stable', key: 'tone', value: '详尽' })
    const text = render()
    expect(text).toContain('简洁')
    expect(text).toContain('详尽')
    expect(text).toContain('不替你选择')
  })

  it('只推冲突，不推显式偏好（不推"可能有用"的东西）', async () => {
    const stores = new FakeStores()
    const { kernel, service } = startProfile(stores)
    const contribution = kernel.service<PromptContribution>(PROFILE_PROMPT_SERVICE)
    await service.declare({ axis: 'stable', key: 'editor', value: '用 vim' })
    const text = contribution?.context?.({ sessionId: 's1', depth: 'standard', band: 'relaxed' }) ?? ''
    expect(text).not.toContain('vim')
  })

  it('卸载后提示贡献被注销，旧贡献渲染为空串（不抛）', async () => {
    const handle = createKernel({ clock: fakeClock() })
    const module = createProfileModule()
    handle.start([memoryStub(new FakeStores()), module as ModuleRegistration<unknown>])
    const service = handle.kernel.service<ProfileService>(PROFILE_SERVICE)
    const contribution = handle.kernel.service<PromptContribution>(PROFILE_PROMPT_SERVICE)
    await service?.declare({ axis: 'stable', key: 'tone', value: '简洁' })
    await service?.declare({ axis: 'stable', key: 'tone', value: '详尽' })
    const render = (): string =>
      contribution?.context?.({ sessionId: 's1', depth: 'standard', band: 'relaxed' }) ?? ''
    expect(render()).not.toBe('')

    handle.dispose()
    expect(handle.kernel.service(PROFILE_PROMPT_SERVICE)).toBeUndefined()
    expect(() => render()).not.toThrow()
    expect(render()).toBe('')
  })
})

describe('降级与热插拔', () => {
  it('会话由调用方显式给出（不再订阅 turn/start 记"当前会话"）', async () => {
    const stores = new FakeStores()
    const { kernel, service } = startProfile(stores)
    // 挂载时会预热一次（此时还没有会话，按空会话取库=记忆侧降级为仅用户库）
    expect(stores.sessionCalls).toEqual([''])

    // 回合事件**不再**被当成会话来源：那是"最近一个会话"，交错时会读错/写错项目库
    kernel.emit('turn/start', { sessionId: 'sess-42', turn: 1 })
    await service.entries()
    expect(stores.sessionCalls.at(-1)).toBe('')

    // 显式给会话 → 才是那个会话的库
    await service.entries('sess-42')
    expect(stores.sessionCalls.at(-1)).toBe('sess-42')
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

/**
 * S3-e：**写入面零消费者**必须如实标注。
 *
 * 审计 C5：`declare` / `infer` / `clearDeduced` / `observeCapability` 全仓
 * 生产调用点为 0（命中只在 `tests/modules/profile/**`）。于是"显式条目 0 条"
 * 有两种相反的含义：**没人写过** 与 **没有写入口**。状态面必须能分开说——
 * 否则用户会以为自己从未表达过偏好，而事实是这些入口根本没接上。
 *
 * 修复前：健康面只有"显式条目 0 条、推断条目 0 条"，两者同形。
 */
describe('写入面零消费者：状态面如实标注（S3-e）', () => {
  it('没有写入调用时，健康面与 status 都写明「写入面暂无调用方」', async () => {
    const { service, health } = startProfile(new FakeStores())
    const detail = (await health()).detail
    expect(detail).toContain('写入面暂无调用方（服务已声明，等待消费方）')
    expect(detail).toContain('收到 0 次请求')
    expect(detail).toContain('0 条')
    expect(service.status().detail).toContain('写入面暂无调用方')
    expect((await health()).metrics?.writeFaceCalls).toBe(0)
  })

  it('一旦有调用，文案改成实际请求数（不留过期承诺）', async () => {
    const { service, health } = startProfile(new FakeStores())
    await service.declare({ axis: 'stable', key: 'tone', value: '简洁' })
    const detail = (await health()).detail
    expect(detail).not.toContain('写入面暂无调用方')
    expect(detail).toContain('收到 1 次写入请求')
    expect(detail).toContain('declare 1')
    expect((await health()).metrics?.writeFaceCalls).toBe(1)
  })

  it('能力观察会话表口径：上界与淘汰数分开报（0 与"未测量"不同）', async () => {
    const { service, health } = startProfile(new FakeStores(), { inferCapabilityAxis: true })
    const before = await health()
    expect(before.detail).toContain('能力观察会话表 0/32 个会话')
    expect(before.metrics?.capabilitySessions).toBe(0)
    expect(before.metrics?.capabilitySessionsEvicted).toBe(0)

    for (let index = 1; index <= 40; index += 1) {
      service.observeCapability(`s${index}`, { key: 'k', value: `v${index}` })
    }
    const after = await health()
    expect(after.detail).toContain('能力观察会话表 32/32 个会话')
    expect(after.detail).toContain('已淘汰 8 个更早的会话')
    expect(after.metrics?.capabilitySessions).toBe(32)
    expect(after.metrics?.capabilitySessionsEvicted).toBe(8)
  })
})
