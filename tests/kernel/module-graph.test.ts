/**
 * **模块依赖图自检**（lead 裁决的 (B) 方案：只做守卫，但把"行序被改错"从静默变成可读事实）。
 *
 * 为什么不是运行时硬阻断：模块行之间只有 `inject: ['omb:kernel']` 一道门、**没有顺序保证**，
 * 硬阻断会把"晚一点就绪"误判成"依赖缺失" → 静默丢失能力；把 `apply` 挪到 `mount` 返回之后
 * 又会让宿主的一次性安装审计（H-2）失效。所以：**守卫 + 启动自检 + 如实降级**。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Kernel, ModuleRegistration } from '../../kernel/abi/index.js'
import { createKernel } from '../../kernel/index.js'

function mod(id: string, requires: readonly string[] = []): ModuleRegistration<unknown> {
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
    },
  }
}

describe('moduleGraph：真实挂载顺序 vs 声明的依赖', () => {
  it('顺序正确（依赖先挂载）→ 无违规，状态面显示"自检通过"', () => {
    const h = createKernel()
    h.mount(mod('omb-memory'))
    h.mount(mod('omb-memory-vector', ['omb-memory']))
    const report = h.moduleGraph()
    expect(report.mounted).toEqual(['omb-memory', 'omb-memory-vector'])
    expect(report.orderViolations).toEqual([])
    expect(report.missingDependencies).toEqual([])
    expect(h.status().join('\n')).toContain('顺序自检通过')
  })

  it('顺序被改错（依赖挂在依赖方之后）→ 违规可见 + 日志留声 + 状态面给出修法', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    h.mount(mod('omb-memory-vector', ['omb-memory'])) // 依赖方先来
    h.mount(mod('omb-memory')) // 依赖后到 → 依赖方启动时拿不到服务

    const report = h.moduleGraph()
    expect(report.mounted).toEqual(['omb-memory-vector', 'omb-memory'])
    expect(report.orderViolations).toEqual(['omb-memory-vector ← omb-memory'])
    expect(report.missingDependencies).toEqual([])

    const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(logged).toContain('模块挂载顺序违反依赖图')
    expect(logged).toContain('cordis.patch.yml')

    const status = h.status().join('\n')
    expect(status).toContain('顺序违规')
    expect(status).toContain('omb-memory-vector ← omb-memory')
    expect(status).toContain('依赖行必须排在依赖方之前')
  })

  it('依赖从未挂载（那一行被禁用）→ 归为"前置条件未满足"，不是顺序违规', () => {
    const h = createKernel()
    h.mount(mod('omb-profile', ['omb-memory']))
    const report = h.moduleGraph()
    expect(report.orderViolations).toEqual([])
    expect(report.missingDependencies).toEqual(['omb-profile ← omb-memory'])
    const status = h.status().join('\n')
    expect(status).toContain('依赖未挂载')
    expect(status).toContain('omb-profile ← omb-memory')
  })

  it('自检读到的是**当前**事实：依赖晚到后，先前的"未挂载"会变成"顺序违规"（或反过来消失）', () => {
    const h = createKernel()
    h.mount(mod('omb-profile', ['omb-memory']))
    expect(h.moduleGraph().missingDependencies).toEqual(['omb-profile ← omb-memory'])
    // 依赖迟到 → 从"未挂载"变成"顺序违规"，因为依赖方已经在它之前启动过了
    h.mount(mod('omb-memory'))
    expect(h.moduleGraph().missingDependencies).toEqual([])
    expect(h.moduleGraph().orderViolations).toEqual(['omb-profile ← omb-memory'])
  })

  it('start() 路径按拓扑序挂载 → 自检通过（离线装配不误报）', () => {
    const h = createKernel()
    h.start([mod('omb-memory-vector', ['omb-memory']), mod('omb-memory')])
    expect(h.moduleGraph()).toEqual({
      mounted: ['omb-memory', 'omb-memory-vector'],
      orderViolations: [],
      missingDependencies: [],
    })
  })

  it('配置解析失败/apply 抛错 → 该模块不算挂载过（账本里不出现）', () => {
    const h = createKernel()
    const broken: ModuleRegistration<unknown> = {
      ...mod('omb-broken'),
      apply: () => {
        throw new Error('故意失败')
      },
    }
    h.mount(broken)
    expect(h.moduleGraph().mounted).toEqual([])
    expect(h.health()['omb-broken']?.state).toBe('failed')
  })

  it('状态面段落可渲染且不抛（哪怕违规很多）', () => {
    const h = createKernel()
    h.mount(mod('a', ['b', 'c']))
    h.mount(mod('b', ['c']))
    h.mount(mod('c'))
    expect(() => h.status()).not.toThrow()
    const report = h.moduleGraph()
    expect([...report.orderViolations].sort()).toEqual(['a ← b', 'a ← c', 'b ← c'])
  })
})
