/**
 * 账本**出账**路径的测试。
 *
 * 为什么单开一个文件：这里的每一条都是"曾经不存在、而且不存在时一切照绿"的那类缺陷——
 * 账本自称记"当前装上了哪些模块"，却只有入账没有出账。于是关掉一个前置组件之后，
 * `mounted` 里仍然列着它、`missingDependencies` 恒为空、自检报"顺序自检通过"，
 * 而依赖方早已在空转降级。**用户关掉前置组件时，OMB 连"检测到了"都做不到。**
 */
import { describe, expect, it, vi } from 'vitest'
import type { Kernel, ModuleRegistration } from '../../kernel/abi/index.js'
import { createKernel } from '../../kernel/index.js'

/** 一个最小模块；`apply` 返回 disposer，这样卸载路径才走得通。 */
function mod(id: string, requires: readonly string[] = [], onDispose?: () => void): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '1.0.0',
      requires,
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: 'test' }),
    },
    apply: (kernel: Kernel) => {
      kernel.report({ state: 'ok', detail: `${id} 已挂载` })
      return () => { onDispose?.() }
    },
  }
}

/**
 * 测试台：包一层 `mount`，把返回的卸载函数记下来。
 *
 * 真实宿主就是这么用的（`kernel/hostEntry.ts:307,327`：模块入口把 `mount` 的返回值
 * 当作交给宿主的 disposer，宿主关掉那一行时调它）。这里记下来只为让"关掉一行"
 * 在测试里可复现——**不另造卸载入口**，否则测的就不是生产路径。
 */
function bench() {
  const handle = createKernel()
  const offs = new Map<string, () => void>()
  return {
    handle,
    mount(registration: ModuleRegistration<unknown>): void {
      offs.set(registration.manifest.id, handle.mount(registration))
    },
    /** 关掉某一行（= 调用它挂载时拿到的那个 disposer）。 */
    off(id: string): () => void {
      const disposer = offs.get(id)
      if (disposer === undefined) throw new Error(`测试自身错误：${id} 没有被 mount 过`)
      return disposer
    },
    graph: () => handle.moduleGraph(),
    status: () => handle.status().join('\n'),
  }
}

describe('账本出账：卸载必须从"当前装着的模块"里消失', () => {
  it('卸载前置 → 依赖方进入 missingDependencies（此前恒为空）', () => {
    const b = bench()
    b.mount(mod('omb-memory'))
    b.mount(mod('omb-memory-vector', ['omb-memory']))
    b.mount(mod('omb-artifact')) // 旁观者：不该被牵连
    expect(b.graph().missingDependencies).toEqual([])

    b.off('omb-memory')() // 宿主关掉这一行

    const report = b.graph()
    expect(report.mounted, '关掉的模块不该还列在"已挂载"里').not.toContain('omb-memory')
    expect(report.mounted, '旁观者照旧').toContain('omb-artifact')
    expect(report.missingDependencies, '依赖方必须被报出来').toEqual(['omb-memory-vector ← omb-memory'])
    expect(b.status()).toContain('omb-memory-vector ← omb-memory')
  })

  it('卸载无依赖方的模块 → 账本少一个，不产生任何未满足依赖', () => {
    const b = bench()
    b.mount(mod('omb-artifact'))
    b.off('omb-artifact')()
    const report = b.graph()
    expect(report.mounted).toEqual(['omb-kernel'])
    expect(report.missingDependencies).toEqual([])
    expect(report.orderViolations).toEqual([])
  })

  it('卸载真的调到了模块自己的 disposer（销账不是"假装卸载"）', () => {
    const disposed = vi.fn()
    const b = bench()
    b.mount(mod('omb-x', [], disposed))
    b.off('omb-x')()
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('disposer 调两次只销一次账、只收一次尾（幂等）', () => {
    const disposed = vi.fn()
    const b = bench()
    b.mount(mod('omb-x', [], disposed))
    const off = b.off('omb-x')
    off()
    off()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(b.graph().mounted).toEqual(['omb-kernel'])
  })

  it('内核整体注销后账本清空，只剩内核自己（仍然如实）', () => {
    const b = bench()
    b.mount(mod('omb-memory'))
    b.mount(mod('omb-memory-vector', ['omb-memory']))
    b.handle.dispose()
    expect(b.graph().mounted).toEqual(['omb-kernel'])
  })
})

describe('热开关：卸下再挂回必须回到原位', () => {
  it('重挂回原位 → **不产生假顺序违规**（这是最容易漏的一条）', () => {
    const b = bench()
    b.mount(mod('omb-memory'))
    b.mount(mod('omb-memory-vector', ['omb-memory']))

    // 热开关就是这两步：关掉、再打开
    b.off('omb-memory')()
    b.mount(mod('omb-memory'))

    const report = b.graph()
    expect(report.mounted).toEqual(['omb-kernel', 'omb-memory', 'omb-memory-vector'])
    expect(report.orderViolations, '回原位就不该报顺序违规——追加到末尾才会').toEqual([])
    expect(report.missingDependencies).toEqual([])
  })

  it('关掉依赖方再挂回：回到自己的位置，同样不误报', () => {
    const b = bench()
    b.mount(mod('omb-memory'))
    b.mount(mod('omb-memory-vector', ['omb-memory']))
    b.off('omb-memory-vector')()
    b.mount(mod('omb-memory-vector', ['omb-memory']))
    expect(b.graph().orderViolations).toEqual([])
  })

  it('前置确实还在缺 → 仍然如实报缺（销账不等于假装一切正常）', () => {
    const b = bench()
    b.mount(mod('omb-memory'))
    b.mount(mod('omb-memory-vector', ['omb-memory']))
    b.off('omb-memory')()
    b.off('omb-memory-vector')()
    b.mount(mod('omb-memory-vector', ['omb-memory']))
    const report = b.graph()
    expect(report.missingDependencies).toEqual(['omb-memory-vector ← omb-memory'])
    expect(report.orderViolations).toEqual([])
  })
})

describe('变更广播：订阅方拿到的与状态面显示的是同一份', () => {
  it('卸载事件带 dependents，且 missingDependencies 与 moduleGraph() 一致', () => {
    const b = bench()
    const seen: {
      change: string; id: string; dependents: readonly string[]; missingDependencies: readonly string[]
    }[] = []
    b.handle.kernel.on('kernel/module-graph-changed', payload => { seen.push(payload) })
    b.mount(mod('omb-memory'))
    b.mount(mod('omb-memory-vector', ['omb-memory']))
    b.mount(mod('omb-profile', ['omb-memory']))
    b.mount(mod('omb-artifact')) // 不依赖 memory，不该出现在 dependents 里

    b.off('omb-memory')()
    const last = seen.at(-1)!
    expect(last.change).toBe('unmount')
    expect(last.id).toBe('omb-memory')
    expect([...last.dependents].sort()).toEqual(['omb-memory-vector', 'omb-profile'])
    expect(last.missingDependencies).toEqual(b.graph().missingDependencies)
  })

  it('卸载没有依赖方的模块 → dependents 为空（提醒方据此决定不打扰）', () => {
    const b = bench()
    const seen: { dependents: readonly string[] }[] = []
    b.handle.kernel.on('kernel/module-graph-changed', payload => { seen.push(payload) })
    b.mount(mod('omb-artifact'))
    b.off('omb-artifact')()
    expect(seen.at(-1)?.dependents).toEqual([])
  })

  it('挂载也广播（账本确实变了），且挂载事件不带 unmetRequires', () => {
    const b = bench()
    const seen: { change: string; id: string; unmetRequires: readonly string[] }[] = []
    b.handle.kernel.on('kernel/module-graph-changed', payload => { seen.push(payload) })
    b.mount(mod('omb-memory'))
    const last = seen.at(-1)!
    expect(last.change).toBe('mount')
    expect(last.id).toBe('omb-memory')
    expect(last.unmetRequires).toEqual([])
  })
})

describe('健康广播：这条线曾经只有测试在发', () => {
  it('mount() 会让订阅者真的收到 kernel/module-health（生产路径，不是测试手动 emit）', () => {
    const b = bench()
    const heard: string[] = []
    b.handle.kernel.on('kernel/module-health', payload => { heard.push(`${payload.id}:${payload.health.state}`) })
    b.mount(mod('omb-memory'))
    expect(heard).toContain('omb-memory:ok')
  })

  it('启动失败也广播（挂载失败这条路径同样要能被订阅方看到）', () => {
    const b = bench()
    const heard: string[] = []
    b.handle.kernel.on('kernel/module-health', payload => { heard.push(`${payload.id}:${payload.health.state}`) })
    b.mount({ ...mod('omb-broken'), apply: () => { throw new Error('故意失败') } })
    expect(heard).toContain('omb-broken:failed')
  })

  it('订阅方抛错不影响上报本身（广播是附属品，事实才是主体）', () => {
    const b = bench()
    b.handle.kernel.on('kernel/module-health', () => { throw new Error('订阅方炸了') })
    expect(() => b.mount(mod('omb-memory'))).not.toThrow()
    expect(b.handle.health()['omb-memory']?.state).toBe('ok')
  })
})
