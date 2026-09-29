/**
 * 依赖断裂通知的测试。
 *
 * 这一条补的是**宿主不会替用户检查**的那件事：关掉一个前置组件之后，
 * 依赖方的行仍然是启用状态（宿主只卸载 fiber，不改它的 `disabled`），
 * 页面上只显示"等待依赖"。用户看到的是"我关了一个，另一个还在，但不干活了"，
 * 没有任何地方告诉他是谁连累了谁。
 *
 * 断言全部落在**推送出去的正文**上：只断言"推了一条"会放过
 * "标题里没有模块名、用户照样不知道该怎么办"的退化。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import type { Kernel, ModuleRegistration } from '../../../kernel/abi/index.js'
import {
  createNotifyModule,
  KERNEL_DEPENDENCY_BROKEN_KIND,
  NOTIFY_HOST_SERVICE,
  NOTIFY_SERVICE,
} from '../../../modules/notify/index.js'

/** 宿主收到的一条推送。 */
interface Pushed {
  readonly title: string
  readonly message?: string
  readonly urgency?: string
}

/** 假宿主通知服务：把推送记下来，按宿主契约返回 true。 */
function notifyHost(sink: Pushed[]): { push: (item: Pushed) => boolean } {
  return {
    push: (item: Pushed) => {
      sink.push(item)
      return true
    },
  }
}

function mod(id: string, requires: readonly string[] = []): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '1.0.0',
      requires,
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: 'stub' }),
    },
    apply: () => () => {},
  }
}

/** 把假宿主服务放进内核服务表的占位模块。 */
function hostStub(host: unknown): ModuleRegistration<unknown> {
  return { ...mod('stub-desktop-notify'), apply: (kernel: Kernel) => { kernel.provide(NOTIFY_HOST_SERVICE, host) } }
}

/** 装配：内核占位 + 假宿主通知 + 两个业务模块 + 真通知模块，全部走 `mount` 以便逐个卸载。 */
function bench(): {
  off: (id: string) => () => void
  mount: (registration: ModuleRegistration<unknown>) => void
  sink: Pushed[]
} {
  const handle = createKernel()
  const sink: Pushed[] = []
  const offs = new Map<string, () => void>()
  const mount = (registration: ModuleRegistration<unknown>): void => {
    offs.set(registration.manifest.id, handle.mount(registration))
  }
  mount(mod('omb-kernel'))
  mount(hostStub(notifyHost(sink)))
  mount(mod('omb-memory'))
  mount(mod('omb-memory-vector', ['omb-memory']))
  mount(createNotifyModule() as ModuleRegistration<unknown>)
  if (handle.kernel.service(NOTIFY_SERVICE) === undefined) throw new Error('通知服务未注册（测试装配有误）')
  return {
    sink,
    mount,
    off: (id: string) => {
      const disposer = offs.get(id)
      if (disposer === undefined) throw new Error(`测试自身错误：${id} 没有被 mount 过`)
      return disposer
    },
  }
}

describe('关掉前置组件 → 推送提醒，并说清是谁连累了谁', () => {
  it('关掉被依赖的模块 → 推一条，标题与正文都点名"谁被关、谁失效"', () => {
    const b = bench()
    b.off('omb-memory')()
    expect(b.sink).toHaveLength(1)
    const pushed = b.sink[0]!
    expect(pushed.title).toContain('omb-memory')
    expect(pushed.title, '标题要说出连累了几个人').toContain('1')
    expect(pushed.message).toContain('omb-memory-vector')
    expect(pushed.message, '必须给修法，否则用户不知道怎么办').toContain('重新打开')
  })

  it('关掉没有任何依赖方的模块 → 不打扰（空提醒只会训练用户忽略通知）', () => {
    const b = bench()
    b.off('omb-memory-vector')()
    expect(b.sink).toEqual([])
  })

  it('只认"卸下"：挂载一条都不会发（启动期因此天然无噪音，不需要额外做首轮抑制）', () => {
    const b = bench() // 装配过程本身挂载了 5 个模块
    expect(b.sink).toEqual([])
  })

  it('重新打开前置 → 不会再推一条（提醒只在"关掉"这个动作上）', () => {
    const b = bench()
    b.off('omb-memory')()
    expect(b.sink).toHaveLength(1)
    // 宿主"把那一行打开" = 重新挂载 → 账本恢复，但不再打扰
    b.mount(mod('omb-memory'))
    expect(b.sink).toHaveLength(1)
  })

  it('通知种类是专用键，不与"模块自己失败了"混为一类', () => {
    const b = bench()
    b.off('omb-memory')()
    // 种类键不给人看，但它决定节流与去重；两类混用会让其中一类被另一类静默吃掉
    expect(KERNEL_DEPENDENCY_BROKEN_KIND).not.toBe('kernel-module-failed')
  })
})

describe('宿主没装通知服务时：照旧静默降级，不抛', () => {
  it('没有 desktopNotify → 关掉前置不抛异常，也不影响销账本身', () => {
    const handle = createKernel()
    const offs = new Map<string, () => void>()
    const mount = (registration: ModuleRegistration<unknown>): void => {
      offs.set(registration.manifest.id, handle.mount(registration))
    }
    mount(mod('omb-kernel'))
    mount(mod('omb-memory'))
    mount(mod('omb-memory-vector', ['omb-memory']))
    mount(createNotifyModule() as ModuleRegistration<unknown>)
    expect(() => offs.get('omb-memory')?.()).not.toThrow()
    // 账本照样如实：销账与通知是两件事，通知失败不得让账本失真
    expect(handle.moduleGraph().missingDependencies).toEqual(['omb-memory-vector ← omb-memory'])
  })
})
