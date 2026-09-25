/**
 * `omb-notify` 模块级集成测试（真内核 + 假宿主服务，零宿主 mock）。
 *
 * 验收点：
 * ① 未装通知服务 → 全静默、状态面写明原因、健康不是 failed
 * ② **零改码自动接上**：宿主服务后来注册进内核 → 同一条桥立刻可用
 * ③ 中途失败才打扰（默认关闭；开启后只报"非 failed → failed"的转变）
 * ④ dispose 干净且绝不抛
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import { MODULE_CATALOG } from '../../../kernel/abi/index.js'
import type { Kernel, ModuleRegistration } from '../../../kernel/abi/index.js'
import {
  createNotifyModule,
  KERNEL_FAILURE_KIND,
  NOTIFY_HOST_SERVICE,
  NOTIFY_SERVICE,
  notifyConfigSchema,
  type NotifyService,
} from '../../../modules/notify/index.js'

/** `omb-kernel` 占位注册：本测试只验证通知模块，不重复测内核。 */
const KERNEL_STUB: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.1.0',
    requires: [],
    capabilities: ['kernel.services'],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试用内核占位' }),
  },
  apply: () => {},
}

/** 模拟第三方插件装上后 `ctx.get('desktopNotify')` 的产出。 */
function hostStub(host: unknown): ModuleRegistration<unknown> {
  return {
    manifest: {
      id: 'stub-desktop-notify',
      version: '1.0.0',
      requires: [],
      capabilities: [],
      configSchema: { parse: () => ({}) },
      health: () => ({ state: 'ok', detail: '宿主通知服务占位' }),
    },
    apply: (kernel: Kernel) => {
      if (host !== undefined) kernel.provide(NOTIFY_HOST_SERVICE, host)
    },
  }
}

const catalogEntry = MODULE_CATALOG.find(candidate => candidate.id === 'omb-notify')

function start(
  host: unknown,
  config?: unknown,
): { kernel: Kernel; handle: ReturnType<typeof createKernel>; service: NotifyService; module: ModuleRegistration<unknown> } {
  const handle = createKernel()
  const module = createNotifyModule()
  handle.start(
    [KERNEL_STUB, hostStub(host), module as ModuleRegistration<unknown>],
    config === undefined ? undefined : new Map([['omb-notify', config]]),
  )
  const service = handle.kernel.service<NotifyService>(NOTIFY_SERVICE)
  if (service === undefined) throw new Error('通知服务未注册（测试装配有误）')
  return { kernel: handle.kernel, handle, service, module: module as ModuleRegistration<unknown> }
}

describe('注册面', () => {
  it('模块 id / 依赖 / 能力名与目录契约一致', () => {
    const module = createNotifyModule()
    expect(module.manifest.id).toBe('omb-notify')
    expect(module.manifest.requires).toEqual(catalogEntry?.requires)
    expect(module.manifest.capabilities).toEqual(catalogEntry?.capabilities)
  })

  it('服务名来自 ABI 契约', () => {
    expect(NOTIFY_SERVICE).toBe('notify')
  })

  it('配置缺省值完整：notifyModuleFailures 默认 **false**（启动期不打扰）', () => {
    expect(notifyConfigSchema.parse(undefined)).toEqual({ notifyModuleFailures: false })
  })
})

describe('未安装通知服务：全静默 + 原因可读', () => {
  it('push 返回 false 且不抛；健康是 ok（按设计降级，不是失败）', async () => {
    const { service, module } = start(undefined)
    expect(() => service.push('any', '消息')).not.toThrow()
    expect(service.push('any', '消息')).toBe(false)
    expect(service.status().available).toBe(false)
    expect(service.status().detail).toContain('未安装 desktopNotify')

    const health = await module.manifest.health()
    expect(health.state).toBe('ok')
    expect(health.detail).toContain('宿主未安装 desktopNotify 服务')
    expect(health.metrics?.available).toBe(0)
  })

  it('宿主给了形状不对的东西 → 原因写明"形状不匹配"', async () => {
    const { service, module } = start({ notA: 'notifier' })
    expect(service.push('any', '消息')).toBe(false)
    expect((await module.manifest.health()).detail).toContain('形状不匹配')
  })
})

describe('零改码自动接上', () => {
  it('宿主服务后来注册进内核 → 同一条桥立刻开始工作（无改码、无重启）', async () => {
    const { kernel, service } = start(undefined)
    expect(service.status().available).toBe(false)

    const sent: { title: string; message?: string; urgency?: string }[] = []
    // dsh-desktop-notify 更新后：dsh 层把 ctx.get('desktopNotify') 放进内核服务表
    kernel.provide(NOTIFY_HOST_SERVICE, { push: (payload: { title: string; message?: string; urgency?: string }) => { sent.push(payload) } })

    expect(service.status().available).toBe(true)
    expect(service.push('any', '现在能发了')).toBe(true)
    expect(sent).toEqual([{ title: '现在能发了', urgency: 'normal' }])
  })
})

describe('中途失败才打扰', () => {
  it('默认关闭：ok→failed 的转变也不发', async () => {
    const sent: { title: string; message?: string; urgency?: string }[] = []
    const { kernel, service } = start({ push: (payload: { title: string; message?: string; urgency?: string }) => { sent.push(payload) } })
    kernel.emit('kernel/module-health', { id: 'omb-x', health: { state: 'ok', detail: '启动正常' } })
    kernel.emit('kernel/module-health', { id: 'omb-x', health: { state: 'failed', detail: '运行中崩了' } })
    expect(sent).toEqual([])
    expect(service.status().sent).toBe(0)
  })

  it('开启后：首次健康（启动结果）不报，只报非 failed → failed 的转变', async () => {
    const sent: { title: string; message?: string; urgency?: string }[] = []
    const { kernel, service } = start({ push: (payload: { title: string; message?: string; urgency?: string }) => { sent.push(payload) } }, { notifyModuleFailures: true })

    // 启动首轮：即便是 failed 也不打扰（管理页已经显示）
    kernel.emit('kernel/module-health', { id: 'omb-broken', health: { state: 'failed', detail: '缺少依赖' } })
    expect(sent).toEqual([])

    // 运行中从 ok 变成 failed → 这才是值得打扰的
    kernel.emit('kernel/module-health', { id: 'omb-broken', health: { state: 'ok', detail: '已恢复' } })
    kernel.emit('kernel/module-health', { id: 'omb-broken', health: { state: 'failed', detail: '运行中崩了' } })
    expect(sent).toHaveLength(1)
    // 标题给人看、正文放细节（宿主对空标题一律拒绝）
    expect(sent[0]?.title).toContain('omb-broken')
    expect(sent[0]?.message).toContain('运行中崩了')
    expect(service.status().sent).toBe(1)

    // 重复的 failed 不再重复打扰（状态没变）
    kernel.emit('kernel/module-health', { id: 'omb-broken', health: { state: 'failed', detail: '运行中崩了' } })
    expect(sent).toHaveLength(1)
    expect(KERNEL_FAILURE_KIND).toBe('kernel-module-failed')
  })

  it('自己不报自己（通知模块坏掉时没有可用的桥）', () => {
    const sent: { title: string; message?: string; urgency?: string }[] = []
    const { kernel } = start({ push: (payload: { title: string; message?: string; urgency?: string }) => { sent.push(payload) } }, { notifyModuleFailures: true })
    kernel.emit('kernel/module-health', { id: 'omb-notify', health: { state: 'ok', detail: 'ok' } })
    kernel.emit('kernel/module-health', { id: 'omb-notify', health: { state: 'failed', detail: '崩了' } })
    expect(sent).toEqual([])
  })
})

describe('热插拔', () => {
  it('dispose 注销服务与订阅，且绝不抛', async () => {
    const { handle, kernel, module } = start(undefined)
    expect(handle.listenerCount()).toBe(1)
    expect(() => handle.dispose()).not.toThrow()
    expect(handle.listenerCount()).toBe(0)
    expect(kernel.service(NOTIFY_SERVICE)).toBeUndefined()
    expect((await module.manifest.health()).detail).toContain('模块未启动')
  })

  it('卸载后旧服务引用仍可调用（返回 false 而不是抛）', () => {
    const { handle, service } = start({ push: () => {} })
    handle.dispose()
    expect(() => service.push('any', '消息')).not.toThrow()
  })

  it('配置非法 → 模块 failed 且原因可读', () => {
    const handle = createKernel()
    handle.start(
      [KERNEL_STUB, createNotifyModule() as ModuleRegistration<unknown>],
      new Map([['omb-notify', { notifyModuleFailures: 'yes' }]]),
    )
    expect(handle.health()['omb-notify']?.state).toBe('failed')
  })
})
