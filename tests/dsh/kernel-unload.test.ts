/**
 * 卸载不双重释放：`toHostPlugin` 交给宿主的那条路径 ↔ 内核 `dispose`/`disposeAsync`。
 *
 * 这就是真实的宿主路径：`cordis.patch.yml` 每一行被宿主独立加载 → `toHostPlugin.apply(ctx)`
 * → `ctx.get('omb:kernel')` → `handle.mount(registration, ctx)`。
 * 宿主卸载该行时会调用 `apply` 返回的 disposer；内核行自己卸载时又会 `dispose()`。
 * 两条路径都必须落到**同一个 disposer 的同一个幂等包装**上：模块的收尾只能跑一次。
 */
import { describe, expect, it } from 'vitest'
import type { Kernel, ModuleRegistration } from '../../kernel/abi/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { createKernel } from '../../kernel/index.js'
import { KERNEL_READY_KEY, toHostPlugin } from '../../kernel/hostEntry.js'

function mod(
  id: string,
  apply: (kernel: Kernel, config: unknown) => void | (() => void | Promise<void>),
): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '1.0.0',
      requires: [],
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: 'test' }),
    },
    // 自报健康：`mount()` 会把"未自报"如实标成 degraded（那是另一条约束），
    // 这里要的是"挂载成功"这个事实，所以显式上报。
    apply: (kernel, config) => {
      kernel.report({ state: 'ok', detail: `${id} 已挂载` })
      return apply(kernel, config)
    },
  }
}

/** 与宿主 ctx 同形的假对象：只暴露 `get`（Guard 会对别的属性抛）。 */
function hostCtx(kernel: Kernel): { get(name: string): unknown } {
  return {
    get(name: string): unknown {
      if (name === SERVICES.kernel) return kernel
      if (name === KERNEL_READY_KEY) return Promise.resolve(true)
      return undefined
    },
  }
}

function flush(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

describe('toHostPlugin → mount：单次释放', () => {
  it('宿主调自己那份 disposer，再 disposeAsync → 模块收尾只跑一次', async () => {
    const handle = createKernel()
    const ctx = hostCtx(handle.kernel)
    let disposals = 0
    const plugin = toHostPlugin(mod('omb-demo', () => () => { disposals += 1 }))

    const hostDisposer = plugin.apply(ctx)
    await flush()
    expect(handle.health()['omb-demo']?.state, '模块应已挂载').toBe('ok')
    expect(disposals).toBe(0)

    hostDisposer()
    expect(disposals).toBe(1)
    await handle.disposeAsync()
    expect(disposals, '宿主已释放过 → 内核不得再释放一次').toBe(1)
  })

  it('宿主不调，只 disposeAsync → 模块收尾仍然发生（不会漏）', async () => {
    const handle = createKernel()
    const ctx = hostCtx(handle.kernel)
    let disposals = 0
    const plugin = toHostPlugin(mod('omb-demo', () => () => { disposals += 1 }))

    plugin.apply(ctx)
    await flush()
    await handle.disposeAsync()
    expect(disposals).toBe(1)
  })

  it('异步收尾被等待：disposeAsync 返回后副作用已完成', async () => {
    const handle = createKernel()
    const ctx = hostCtx(handle.kernel)
    let closed = false
    const plugin = toHostPlugin(mod('omb-demo', () => async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 10)
      })
      closed = true
    }))

    plugin.apply(ctx)
    await flush()
    await handle.disposeAsync()
    expect(closed).toBe(true)
  })

  it('宿主先释放、内核后释放、宿主再释放一次 → 仍然只有一次', async () => {
    const handle = createKernel()
    const ctx = hostCtx(handle.kernel)
    let disposals = 0
    const plugin = toHostPlugin(mod('omb-demo', () => () => { disposals += 1 }))

    const hostDisposer = plugin.apply(ctx)
    await flush()
    hostDisposer()
    await handle.disposeAsync()
    hostDisposer()
    expect(disposals).toBe(1)
  })
})
