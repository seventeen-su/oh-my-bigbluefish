/**
 * 度量桥测试。
 *
 * 这一层的存在理由就是"`band` 恒为 relaxed 时没人会发现"，所以每个用例都同时断言
 * **读数**与**原因**：只断言"返回 undefined"会放过"四种成因混成一种"的退化，
 * 而那正是这条线当初断掉却全绿的原因。
 */
import { describe, expect, it } from 'vitest'
import { createPressureBridge } from '../../dsh/pressure.js'
import type { HostContextLike } from '../../dsh/host.js'
import { createKernel } from '../../kernel/index.js'
import { SERVICES } from '../../kernel/abi/index.js'

/** 一个假宿主 ctx：`get` 只认已注册的服务，其余返回 undefined（与真宿主同语义）。 */
function fakeCtx(services: Record<string, unknown> = {}, options: { throwing?: readonly string[] } = {}): HostContextLike {
  const throwing = new Set(options.throwing ?? [])
  return {
    get: (name: string) => {
      if (throwing.has(name)) throw new Error(`Guard 拒绝：${name} 未 inject`)
      return services[name]
    },
  }
}

/** 投影注册表替身：按 key 给状态。 */
function registry(states: Record<string, unknown>, options: { throwing?: readonly string[] } = {}): unknown {
  const throwing = new Set(options.throwing ?? [])
  return {
    stateOf: (_session: unknown, key: string) => {
      if (throwing.has(key)) throw new Error(`单元 ${key} 内部异常`)
      return states[key]
    },
  }
}

const SESSION = { id: 's1', header: { cwd: 'D:/p' } }

/** 完整读数：projectedTokens + 窗口 + 缓存 + 构成。 */
const FULL = {
  contextPressure: { pressureTokens: 1000, projectedTokens: 1500, contextWindow: 5000 },
  tokenUsage: { cacheReadTokens: 400, cacheWriteTokens: 100 },
  contextBreakdown: { systemTokens: 300, toolsTokens: 200, messageTokens: 900 },
}

describe('度量桥：读数', () => {
  it('完整投影 → fillRatio = projectedTokens / contextWindow，缓存与构成一并带上', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({ sessionProjections: registry(FULL) }) })
    bridge.remember('s1', SESSION)
    const reading = bridge.measure('s1')
    expect(reading).toBeDefined()
    expect(reading?.totalTokens).toBe(1500)
    expect(reading?.fillRatio).toBeCloseTo(0.3, 6)
    expect(reading?.cacheReadTokens).toBe(400)
    expect(reading?.cacheWriteTokens).toBe(100)
    expect(reading?.nodes.map(n => n.tokens)).toEqual([300, 200, 900])
    // 名字必须自带「估算」：这三个数用固定密度估计，不与 totalTokens 相加对齐
    expect(reading?.nodes.every(n => n.name.includes('估算'))).toBe(true)
  })

  it('优先 projectedTokens：compaction 之后 pressureTokens 仍是旧值，用旧值档位不会回落', () => {
    const bridge = createPressureBridge({
      ctx: fakeCtx({
        sessionProjections: registry({
          contextPressure: { pressureTokens: 4900, projectedTokens: 500, contextWindow: 5000 },
        }),
      }),
    })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')?.totalTokens).toBe(500)
    expect(bridge.measure('s1')?.fillRatio).toBeCloseTo(0.1, 6)
  })

  it('没有 projectedTokens 时退回 pressureTokens（不该因为缺一个字段就整条失效）', () => {
    const bridge = createPressureBridge({
      ctx: fakeCtx({ sessionProjections: registry({ contextPressure: { pressureTokens: 2000, contextWindow: 4000 } }) }),
    })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')?.totalTokens).toBe(2000)
    expect(bridge.measure('s1')?.fillRatio).toBeCloseTo(0.5, 6)
  })

  it('宿主没声明窗口 → 有总量但比例是 null，且原因是"没声明窗口"而不是别的', () => {
    const bridge = createPressureBridge({
      ctx: fakeCtx({ sessionProjections: registry({ contextPressure: { projectedTokens: 1234 } }) }),
    })
    bridge.remember('s1', SESSION)
    const reading = bridge.measure('s1')
    expect(reading?.totalTokens).toBe(1234)
    expect(reading?.fillRatio).toBeNull()
    expect(bridge.reason()).toContain('窗口')
  })

  it('比例可以超过 1：溢出是真实发生过的事，夹到 1 等于粉饰', () => {
    const bridge = createPressureBridge({
      ctx: fakeCtx({ sessionProjections: registry({ contextPressure: { projectedTokens: 9000, contextWindow: 6000 } }) }),
    })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')?.fillRatio).toBeCloseTo(1.5, 6)
  })

  it('NaN / Infinity 一律当"没有"，不冒充 0 也不冒充大数', () => {
    const bridge = createPressureBridge({
      ctx: fakeCtx({ sessionProjections: registry({ contextPressure: { projectedTokens: Number.NaN, pressureTokens: Number.POSITIVE_INFINITY } }) }),
    })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')).toBeUndefined()
    expect(bridge.reason()).toContain('usage')
  })

  it('缺 tokenUsage / contextBreakdown 不影响主读数，缓存记 0、节点为空', () => {
    const bridge = createPressureBridge({
      ctx: fakeCtx({ sessionProjections: registry({ contextPressure: { projectedTokens: 10, contextWindow: 100 } }) }),
    })
    bridge.remember('s1', SESSION)
    const reading = bridge.measure('s1')
    expect(reading?.cacheReadTokens).toBe(0)
    expect(reading?.cacheWriteTokens).toBe(0)
    expect(reading?.nodes).toEqual([])
  })
})

describe('度量桥：Session 对象映射', () => {
  it('remember 过就直接用缓存，不查宿主注册表', () => {
    let asked = 0
    const ctx = fakeCtx({
      sessionProjections: registry(FULL),
      sessions: { get: () => { asked += 1; return SESSION } },
    })
    const bridge = createPressureBridge({ ctx })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')?.totalTokens).toBe(1500)
    expect(asked).toBe(0)
  })

  it('缓存未命中时问宿主的 sessions 注册表（兜底路）', () => {
    const ctx = fakeCtx({
      sessionProjections: registry(FULL),
      sessions: { get: (id: string) => (id === 's1' ? SESSION : undefined) },
    })
    const bridge = createPressureBridge({ ctx })
    expect(bridge.measure('s1')?.totalTokens).toBe(1500)
    expect(bridge.stats().remembered).toBe(1)
  })

  it('两条路都拿不到 → 原因是"没观察到该会话"，不是"宿主没声明窗口"', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({ sessionProjections: registry(FULL) }) })
    expect(bridge.measure('never-seen')).toBeUndefined()
    expect(bridge.reason()).toContain('never-seen')
  })

  it('remember 拒绝空 id 与非对象（免得把 undefined 塞进表再当成"已观察"）', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({ sessionProjections: registry(FULL) }) })
    bridge.remember('', SESSION)
    bridge.remember('s1', undefined)
    bridge.remember('s1', null)
    bridge.remember('s1', '字符串不是 Session')
    expect(bridge.stats().remembered).toBe(0)
  })
})

describe('度量桥：降级与隔离（H-1 / H-3）', () => {
  it('宿主没有 sessionProjections → 原因指名道姓说出缺的是哪个服务', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({}) })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')).toBeUndefined()
    expect(bridge.reason()).toContain('sessionProjections')
  })

  it('宿主还没上报过 usage → 投影存在但为空，原因与"缺服务"不同', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({ sessionProjections: registry({ contextPressure: {} }) }) })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')).toBeUndefined()
    expect(bridge.reason()).toContain('usage')
  })

  it('ctx.get 本身被 Guard 拒绝也不抛（未 inject 的服务读取会抛）', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({}, { throwing: ['sessionProjections', 'sessions'] }) })
    bridge.remember('s1', SESSION)
    expect(() => bridge.measure('s1')).not.toThrow()
    expect(bridge.measure('s1')).toBeUndefined()
  })

  it('投影单元自己抛错 → 当作读不到，不冒泡', () => {
    const bridge = createPressureBridge({
      ctx: fakeCtx({ sessionProjections: registry(FULL, { throwing: ['contextPressure'] }) }),
    })
    bridge.remember('s1', SESSION)
    expect(() => bridge.measure('s1')).not.toThrow()
    expect(bridge.measure('s1')).toBeUndefined()
  })

  it('宿主 ctx 完全没有 get（测试替身）也不抛', () => {
    const bridge = createPressureBridge({ ctx: {} })
    bridge.remember('s1', SESSION)
    expect(bridge.measure('s1')).toBeUndefined()
  })

  it('没有会话标识时不度量，且不冒充"某个会话的读数"', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({ sessionProjections: registry(FULL) }) })
    expect(bridge.measure('')).toBeUndefined()
    expect(bridge.reason()).toContain('会话标识')
  })

  it('dispose 之后不再度量也不抛（disposer 绝不抛）', () => {
    const bridge = createPressureBridge({ ctx: fakeCtx({ sessionProjections: registry(FULL) }) })
    bridge.remember('s1', SESSION)
    bridge.dispose()
    expect(() => bridge.dispose()).not.toThrow()
    expect(bridge.measure('s1')).toBeUndefined()
    expect(bridge.stats().remembered).toBe(0)
  })
})

describe('度量桥接到内核：档位真的被驱动', () => {
  /** 用真内核 + 真桥：这是"线接通了"与"桥自己会算"的区别。 */
  const kernelWith = (states: Record<string, unknown>) => {
    const bridge = createPressureBridge({ ctx: fakeCtx({ sessionProjections: registry(states) }) })
    bridge.remember('s1', SESSION)
    const handle = createKernel({ measure: bridge.measure })
    return { handle, bridge }
  }

  it('低占用 → relaxed；中占用 → moderate；高占用 → tight（阈值来自内核那一份）', () => {
    expect(kernelWith({ contextPressure: { projectedTokens: 100, contextWindow: 1000 } }).handle.kernel.pressure('s1').band)
      .toBe('relaxed')
    expect(kernelWith({ contextPressure: { projectedTokens: 400, contextWindow: 1000 } }).handle.kernel.pressure('s1').band)
      .toBe('moderate')
    expect(kernelWith({ contextPressure: { projectedTokens: 800, contextWindow: 1000 } }).handle.kernel.pressure('s1').band)
      .toBe('tight')
  })

  it('量不到时回落到 UNKNOWN_PRESSURE，而不是把 0 当成"上下文是空的"', () => {
    const { handle } = kernelWith({})
    const pressure = handle.kernel.pressure('s1')
    expect(pressure.fillRatio).toBeNull()
    expect(pressure.band).toBe('relaxed')
    expect(pressure.totalTokens).toBe(0)
  })

  it('桥的 reason 经内核服务暴露出去（两条 omb_status 构造路径共用同一份答案）', () => {
    const { handle, bridge } = kernelWith({ contextPressure: {} })
    handle.kernel.provide(SERVICES.pressureReading, { reason: bridge.reason, stats: bridge.stats })
    const service = handle.kernel.service<{ reason(): string }>(SERVICES.pressureReading)
    expect(service).toBeDefined()
    handle.kernel.pressure('s1')
    expect(service?.reason()).toContain('usage')
  })
})
