/**
 * 微内核行为测试。
 *
 * 覆盖三类硬约束：
 * ① 单模块失败不连坐（微内核相对分层内核的核心收益）
 * ② `service()` 缺失返回 undefined 而不抛（热插拔基础）
 * ③ `dispose` 绝不抛异常（宿主 reconcileProfilePatches 会 await 旧 fiber）
 */
import { describe, expect, it, vi } from 'vitest'
import { createKernel, DEFAULT_PRESSURE_BANDS } from '../../kernel/index.js'
import { EventBus, ServiceTable } from '../../kernel/services.js'
import { BudgetTable } from '../../kernel/budget.js'
import { planModules } from '../../kernel/registry.js'
import type { Kernel, ModuleRegistration } from '../../kernel/abi/index.js'

/** 造一个模块。`apply` 的第二参即经 schema 校验后的配置。 */
function mod(
  id: string,
  requires: readonly string[] = [],
  apply: (kernel: Kernel, config: unknown) => void | (() => void | Promise<void>) = () => {},
): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '1.0.0',
      requires,
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: 'test' }),
    },
    apply,
  }
}

describe('planModules：依赖拓扑', () => {
  it('依赖先于被依赖者启动', () => {
    const plan = planModules([mod('b', ['a']), mod('a')])
    expect(plan.ordered.map(m => m.id)).toEqual(['a', 'b'])
    expect(plan.blocked).toEqual([])
  })

  it('缺失依赖 → 阻断该模块并写明原因，不影响其余', () => {
    const plan = planModules([mod('b', ['missing']), mod('a')])
    expect(plan.ordered.map(m => m.id)).toEqual(['a'])
    expect(plan.blocked).toEqual([{ id: 'b', reason: '缺少必需依赖：missing' }])
  })

  it('依赖成环 → 阻断且原因可读', () => {
    const plan = planModules([mod('a', ['b']), mod('b', ['a'])])
    expect(plan.blocked.length).toBeGreaterThan(0)
    expect(plan.blocked[0]?.reason).toContain('依赖成环')
  })

  it('id 重复 → 阻断', () => {
    const plan = planModules([mod('a'), mod('a')])
    expect(plan.blocked).toEqual([{ id: 'a', reason: '模块 id 重复：a' }])
  })

  it('可选依赖缺失不算失败', () => {
    const m = mod('a')
    const withOptional: ModuleRegistration<unknown> = {
      ...m,
      manifest: { ...m.manifest, optional: ['nope'] },
    }
    expect(planModules([withOptional]).blocked).toEqual([])
  })
})

describe('ServiceTable：缺失不抛', () => {
  it('未注册的服务返回 undefined', () => {
    expect(new ServiceTable().get('nope')).toBeUndefined()
  })

  it('重复注册同名服务抛错（配置错误应当早失败）', () => {
    const t = new ServiceTable()
    t.provide('x', 1)
    expect(() => t.provide('x', 2)).toThrow(/已被注册/)
  })

  it('注销只移除自己注册的那个实例', () => {
    const t = new ServiceTable()
    const off = t.provide('x', 1)
    off()
    expect(t.get('x')).toBeUndefined()
  })
})

describe('EventBus：订阅者异常被隔离', () => {
  it('一个订阅者抛异常不影响其他订阅者与发布者', () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on('e', () => { throw new Error('boom') })
    bus.on('e', () => { seen.push('ok') })
    expect(() => bus.emit('e', {})).not.toThrow()
    expect(seen).toEqual(['ok'])
  })

  it('注销后不再收到事件，订阅者计数归零（热插拔验收）', () => {
    const bus = new EventBus()
    const off = bus.on('e', () => {})
    expect(bus.listenerCount()).toBe(1)
    off()
    expect(bus.listenerCount()).toBe(0)
  })
})

describe('BudgetTable：超限返回 undefined 由调用方降级', () => {
  it('未声明类别 → undefined', () => {
    expect(new BudgetTable().grant('tokens', 1)).toBeUndefined()
  })

  it('超限 → undefined；归还后可再次申请', () => {
    const b = new BudgetTable()
    b.declare('tokens', 10)
    const g = b.grant('tokens', 10)
    expect(g).toBeDefined()
    expect(b.grant('tokens', 1)).toBeUndefined()
    g?.release()
    expect(b.grant('tokens', 10)).toBeDefined()
  })

  it('release 幂等', () => {
    const b = new BudgetTable()
    b.declare('tokens', 10)
    const g = b.grant('tokens', 4)
    g?.release()
    g?.release()
    expect(b.snapshot()['tokens']).toEqual({ used: 0, limit: 10 })
  })
})

describe('createKernel：生命周期', () => {
  it('单模块启动失败不连坐其余模块', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    h.start([
      mod('bad', [], () => { throw new Error('故意失败') }),
      mod('good'),
    ])
    const health = h.health()
    expect(health['bad']?.state).toBe('failed')
    expect(health['bad']?.detail).toContain('故意失败')
    expect(health['good']?.state).toBe('ok')
    expect(warn).toHaveBeenCalled()
  })

  it('缺失依赖的模块记为 failed 且原因可读', () => {
    const h = createKernel()
    h.start([mod('b', ['missing'])])
    expect(h.health()['b']?.detail).toBe('缺少必需依赖：missing')
  })

  it('模块配置经 schema 校验后交给 apply', () => {
    let received: unknown = 'unset'
    const seen = (config: unknown): void => { received = config }
    const h = createKernel()
    h.start([mod('a', [], (_k, config) => seen(config))], new Map([['a', { x: 1 }]]))
    expect(received).toEqual({ x: 1 })
  })

  it('未提供配置时 apply 收到 undefined，由 schema 缺省值补齐', () => {
    let received: unknown = 'unset'
    const seen = (config: unknown): void => { received = config }
    const h = createKernel()
    h.start([mod('a', [], (_k, config) => seen(config))])
    expect(received).toBeUndefined()
  })

  it('dispose 绝不抛异常，即使模块 disposer 抛错', () => {
    const h = createKernel()
    h.start([mod('a', [], () => () => { throw new Error('dispose boom') })])
    expect(() => h.dispose()).not.toThrow()
  })

  it('dispose 后 service 读取安全（不抛）', () => {
    const h = createKernel()
    h.start([mod('a', [], k => { k.provide('svc', 1) })])
    expect(h.kernel.service('svc')).toBe(1)
    h.dispose()
    expect(h.kernel.service('svc')).toBe(1) // 服务表由模块自行注销；此处只断言不抛
  })

  it('service 缺失返回 undefined 而不抛（热插拔基础）', () => {
    const h = createKernel()
    expect(h.kernel.service('nope')).toBeUndefined()
  })

  it('focus 缺省为 standard，设置后可读回', () => {
    const h = createKernel()
    expect(h.kernel.focus('s1')).toBe('standard')
    h.kernel.setFocus('s1', 'deep', '复杂推导')
    expect(h.kernel.focus('s1')).toBe('deep')
  })

  it('focus 设置会广播 focus/changed', () => {
    const h = createKernel()
    const seen: string[] = []
    h.kernel.on('focus/changed', p => { seen.push(p.depth) })
    h.kernel.setFocus('s1', 'quick', '闲聊')
    expect(seen).toEqual(['quick'])
  })

  it('pressure：无度量桥时恒为 relaxed 且 fillRatio 为 null（不臆断）', () => {
    const h = createKernel()
    const p = h.kernel.pressure('s1')
    expect(p.band).toBe('relaxed')
    expect(p.fillRatio).toBeNull()
  })

  it('pressure：档位由 fillRatio 与阈值统一判定', () => {
    expect(DEFAULT_PRESSURE_BANDS).toEqual({ moderate: 0.3, tight: 0.6 })
    const h = createKernel({
      measure: () => ({
        totalTokens: 100, fillRatio: 0.7, band: 'relaxed',
        cacheReadTokens: 0, cacheWriteTokens: 0, nodes: [],
      }),
    })
    expect(h.kernel.pressure('s1').band).toBe('tight')
  })
})
