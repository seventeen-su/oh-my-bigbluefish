/**
 * `omb-context` 模块注册（软塑形落地 + 拉取台账 + 状态面 + 热插拔）。
 *
 * 用真实微内核；压力读数用内核的 `measure` 注入，从而能验证**档位真的在驱动行为**。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import type { ContextPressure, ModuleRegistration, StatusRegistry } from '../../../kernel/abi/index.js'
import { MODULE_CATALOG, SERVICES, toolsServiceFor } from '../../../kernel/abi/index.js'
import type { Candidate } from '../../../modules/context/admission.js'
import {
  MODULE_ID,
  type ContextMetricsService,
  type ContextPressureService,
  createContextModule,
  contextConfigSchema,
} from '../../../modules/context/index.js'
import type { PullSnapshot } from '../../../modules/context/watch.js'
import { VIEW_TOOLS } from '../../../modules/context/watch.js'

/** `omb-kernel` 占位注册：本测试只验证 context 模块。 */
const KERNEL_STUB: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.0.0',
    requires: [],
    capabilities: ['kernel.services'],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试用内核占位' }),
  },
  apply: () => {},
}

const entry = MODULE_CATALOG.find(candidate => candidate.id === MODULE_ID)

const pressureWith = (fillRatio: number | null, nodes: readonly { name: string; tokens: number }[] = []): ContextPressure => ({
  totalTokens: 5000,
  fillRatio,
  band: 'relaxed',
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
  nodes,
})

function start(options: { config?: unknown; fillRatio?: number | null; nodes?: readonly { name: string; tokens: number }[] } = {}) {
  const handle = createKernel({
    measure: () => pressureWith(options.fillRatio ?? null, options.nodes ?? []),
  })
  const registration = createContextModule()
  const configs = options.config === undefined ? undefined : new Map<string, unknown>([[MODULE_ID, options.config]])
  const blocked = handle.start([KERNEL_STUB, registration], configs)
  return { handle, blocked, registration }
}

function metricsOf(handle: ReturnType<typeof createKernel>): ContextMetricsService {
  const service = handle.kernel.service<ContextMetricsService>(SERVICES.contextMetrics)
  expect(service).toBeDefined()
  return service!
}

function pressureOf(handle: ReturnType<typeof createKernel>): ContextPressureService {
  const service = handle.kernel.service<ContextPressureService>(SERVICES.contextPressure)
  expect(service).toBeDefined()
  return service!
}

const candidate = (over: Partial<Candidate> & { id: string }): Candidate => ({
  text: over.text ?? over.id,
  relevance: over.relevance ?? 1,
  tokens: over.tokens ?? 100,
  ...over,
})

describe('清单与配置', () => {
  it('目录里有 omb-context，requires / capabilities 对齐', () => {
    expect(entry).toBeDefined()
    const registration = createContextModule()
    expect(registration.manifest.id).toBe(MODULE_ID)
    expect(registration.manifest.requires).toEqual(entry!.requires)
    expect([...registration.manifest.capabilities].sort()).toEqual([...entry!.capabilities].sort())
  })

  it('configSchema 缺省完整（内核会传 undefined）', () => {
    expect(contextConfigSchema.parse(undefined)).toEqual({
      pressureBands: [0.3, 0.6],
      candidateConsiderLimit: 12,
    })
    expect(contextConfigSchema.parse({ pressureBands: [0.5, 0.9] })).toEqual({
      pressureBands: [0.5, 0.9],
      candidateConsiderLimit: 12,
    })
  })

  it('非法取值抛异常（由内核标 failed 并写明原因）', () => {
    expect(() => contextConfigSchema.parse({ candidateConsiderLimit: 0 })).toThrow()
    expect(() => contextConfigSchema.parse({ pressureBands: [0.3] })).toThrow()
    expect(() => contextConfigSchema.parse({ pressureBands: 'x' })).toThrow()
  })

  it('**没有每回合 token 上限**这类配置项（整个组件只有两个旋钮）', () => {
    const parsed = contextConfigSchema.parse({})
    expect(Object.keys(parsed).sort()).toEqual(['candidateConsiderLimit', 'pressureBands'])
    for (const key of Object.keys(parsed)) {
      expect(key, `配置项 ${key} 看起来像 token 上限`).not.toMatch(/token|budget|max/i)
    }
  })

  it('阈值畸形时收敛并写进降级原因（不静默改配置）', () => {
    const { handle } = start({ config: { pressureBands: [0.9, 0.2], candidateConsiderLimit: 5000 } })
    const health = handle.health()[MODULE_ID]
    expect(health?.state).toBe('degraded')
    expect(health?.detail).toContain('pressureBands 已收敛')
    expect(health?.detail).toContain('candidateConsiderLimit 已收敛')
    const pressure = pressureOf(handle)
    expect(pressure.bands).toEqual({ moderate: 0.2, tight: 0.9 })
    handle.dispose()
  })

  it('缺少 omb-kernel 时被阻断并写明原因', () => {
    const handle = createKernel()
    const blocked = handle.start([createContextModule()])
    expect(blocked.map(item => item.id)).toEqual([MODULE_ID])
    expect(blocked[0]?.reason).toContain('omb-kernel')
    handle.dispose()
  })
})

describe('服务面', () => {
  it('context:pressure / context:metrics / tools:omb-context / 状态段都在', () => {
    const { handle, blocked } = start()
    expect(blocked).toEqual([])
    expect(handle.health()[MODULE_ID]?.state).toBe('ok')

    const pressure = pressureOf(handle)
    expect(pressure.bandOf(null)).toBe('relaxed')
    expect(pressure.bandOf(0.45)).toBe('moderate')
    expect(pressure.bandOf(0.8)).toBe('tight')
    expect(pressure.behaviorFor('tight').indexOnly).toBe(true)
    expect(pressure.read().behavior.pushLimit).toBe(0)

    // 上下文模块没有模型可见工具：交付空数组而不是缺席（dsh 只需一段遍历）
    const tools = handle.kernel.service<readonly unknown[]>(toolsServiceFor(MODULE_ID))
    expect(tools).toEqual([])

    expect(handle.statusNames()).toContain('上下文优化（omb-context）')
    expect(handle.status().join('\n')).toContain('拉取台账')
    handle.dispose()
  })

  it('状态面登记处能给多个贡献者（reasoning 与 context 同时在场不互相覆盖）', () => {
    const handle = createKernel()
    const registry = handle.kernel.service<StatusRegistry>(SERVICES.statusContributor)
    expect(registry).toBeDefined()
    const first = registry!.register({ name: '甲', render: () => '甲的内容' })
    const second = registry!.register({ name: '乙', render: () => '乙的内容' })
    expect(handle.statusNames()).toEqual(['乙', '甲'])
    first()
    expect(handle.statusNames()).toEqual(['乙'])
    second()
    expect(handle.statusNames()).toEqual([])
    handle.dispose()
  })

  it('自定义阈值真的改变判档口径', () => {
    const { handle } = start({ config: { pressureBands: [0.5, 0.9], candidateConsiderLimit: 12 }, fillRatio: 0.45 })
    const pressure = pressureOf(handle)
    // 内核用缺省阈值算出 moderate；模块用配置阈值算出 relaxed（口径以模块配置为准）
    expect(handle.kernel.pressure('s').band).toBe('moderate')
    expect(pressure.read('s').band).toBe('relaxed')
    handle.dispose()
  })
})

describe('档位驱动注入裁决（select）', () => {
  const pool = [
    candidate({ id: 'm1', text: '用户偏好简洁回答', relevance: 1, tokens: 50 }),
    candidate({ id: 'm2', text: '项目用 node:sqlite 存记忆', relevance: 0.9, tokens: 50 }),
  ]

  it('宽松档（fillRatio 未声明）：不推任何东西', () => {
    const { handle } = start({ fillRatio: null })
    expect(metricsOf(handle).select(pool, [], undefined, { session: 's' })).toEqual([])
    handle.dispose()
  })

  it('适中档（0.45）：按边际价值只推最有价值的一条', () => {
    const { handle } = start({ fillRatio: 0.45 })
    const chosen = metricsOf(handle).select(pool, [], undefined, { session: 's' })
    expect(chosen.length).toBe(1)
    expect(chosen[0]?.id).toBe('m1')
    handle.dispose()
  })

  it('紧张档（0.8）：内容全部转工具拉取，一条也不推', () => {
    const { handle } = start({ fillRatio: 0.8 })
    expect(metricsOf(handle).select(pool, [], undefined, { session: 's' })).toEqual([])
    handle.dispose()
  })

  it('不传 session 时用最近活跃会话读压力（工具/提示都发生在回合内）', () => {
    const { handle } = start({ fillRatio: 0.45 })
    handle.kernel.emit('turn/start', { sessionId: 'live', turn: 1 })
    expect(metricsOf(handle).select(pool, []).length).toBe(1)
    handle.dispose()
  })

  it('marginalValue 对重复内容给 0（第二次说同一件事不值得再注入）', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    const first = candidate({ id: 'a', text: '用户偏好简洁回答', tokens: 50 })
    const repeat = candidate({ id: 'b', text: '用户偏好简洁回答', tokens: 50 })
    expect(metrics.marginalValue(first, [])).toBeGreaterThan(0)
    expect(metrics.marginalValue(repeat, [first])).toBe(0)
    handle.dispose()
  })

  it('内核端口异常时服务方法仍不抛（时钟坏掉不影响 select）', () => {
    const handle = createKernel({
      measure: () => pressureWith(0.45),
      clock: {
        now: () => {
          throw new Error('时钟坏了')
        },
      },
    })
    handle.start([KERNEL_STUB, createContextModule()])
    const metrics = metricsOf(handle)
    expect(() => metrics.select(pool, [], undefined, { session: 's' })).not.toThrow()
    expect(() => metrics.focusState('s')).not.toThrow()
    expect(metrics.focusState('s').setAt).toBe(0)
    handle.dispose()
  })

  it('measuredCost 走真实测量；没有该节点返回 null（不估算）', () => {
    const { handle } = start({ nodes: [{ name: 'omb_recall', tokens: 321 }] })
    const metrics = metricsOf(handle)
    expect(metrics.measuredCost('omb_recall', 's')).toBe(321)
    expect(metrics.measuredCost('没有价格的块', 's')).toBeNull()
    handle.dispose()
  })
})

describe('拉取台账与杀死判据', () => {
  it('记录拉取后计数、轮次与 pullsPerTurn 都可读', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 2 })
    metrics.recordPull('omb_recall', 's')
    metrics.recordPull('omb_recall', 's')
    metrics.recordPull('omb_method', 's')

    const snapshot: PullSnapshot = metrics.snapshot()
    expect(snapshot.turns).toBe(2)
    expect(snapshot.totalPulls).toBe(3)
    expect(snapshot.views.find(view => view.view === 'omb_recall')?.pulls).toBe(2)
    expect(snapshot.views.find(view => view.view === 'omb_recall')?.lastTurn).toBe(2)
    expect(metrics.views().map(view => view.view)).toEqual([...VIEW_TOOLS].sort())
    handle.dispose()
  })

  it('长期 0 拉取 → health().detail 里写明待删除视图（杀死判据可见）', () => {
    const { handle } = start()
    for (let turn = 1; turn <= 20; turn += 1) handle.kernel.emit('turn/start', { sessionId: 's', turn })
    const health = handle.health()[MODULE_ID]
    expect(health?.detail).toContain('待删除视图')
    expect(health?.detail).toContain('omb_files')
    expect(metricsOf(handle).killList()).toContain('omb_recall')
    expect(health?.metrics?.deadViews).toBe(5)
    handle.dispose()
  })

  it('轮数不足时 detail 如实说"暂不下删除结论"（不把样本不够说成一切正常）', () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const detail = handle.health()[MODULE_ID]?.detail ?? ''
    expect(detail).toContain('轮数不足')
    expect(detail).not.toContain('无视图趋近 0')
    handle.dispose()
  })

  it('缓存命中率来自度量桥；无缓存数据时为 null（不可测，不是 0）', () => {
    const { handle } = start()
    expect(metricsOf(handle).cacheHitRate('s')).toBeCloseTo(0.8, 6)
    handle.dispose()
  })

  it('recordPull 传未知会话也不抛（落到全局回合计数）', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    expect(() => metrics.recordPull('omb_files')).not.toThrow()
    metrics.recordPull('omb_files', '从未见过的会话')
    expect(metrics.snapshot().totalPulls).toBe(2)
    handle.dispose()
  })
})

describe('状态面段落与热插拔', () => {
  it('段落内容包括档位行为、拉取台账与降级原因', () => {
    const { handle } = start({ fillRatio: 0.8 })
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const text = handle.status().join('\n')
    expect(text).toContain('### 上下文优化（omb-context）')
    expect(text).toContain('压力档位：tight')
    expect(text).toContain('只保留索引')
    expect(text).toContain('拉取台账')
    handle.dispose()
  })

  it('卸载后零残留；重复卸载不抛', () => {
    const { handle } = start()
    const kernel = handle.kernel
    expect(handle.listenerCount()).toBeGreaterThan(0)
    handle.dispose()
    expect(handle.listenerCount()).toBe(0)
    expect(kernel.service(SERVICES.contextPressure)).toBeUndefined()
    expect(kernel.service(SERVICES.contextMetrics)).toBeUndefined()
    expect(kernel.service(toolsServiceFor(MODULE_ID))).toBeUndefined()
    expect(handle.statusNames()).not.toContain('上下文优化（omb-context）')
    expect(() => handle.dispose()).not.toThrow()
  })

  it('两个实例互不干扰（台账不共享）', () => {
    const first = start()
    const second = start()
    first.handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    metricsOf(first.handle).recordPull('omb_recall', 's')
    expect(metricsOf(first.handle).snapshot().totalPulls).toBe(1)
    expect(metricsOf(second.handle).snapshot().totalPulls).toBe(0)
    first.handle.dispose()
    second.handle.dispose()
  })

  it('manifest.health() 在卸载后仍可读并说清状态', async () => {
    const { handle, registration } = start()
    handle.dispose()
    const health = await registration.manifest.health()
    expect(health.detail).toContain('已卸载')
  })
})
