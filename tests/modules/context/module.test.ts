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
    version: '3.3.0',
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
    const before = handle.statusNames()
    const first = registry!.register({ name: '甲', render: () => '甲的内容' })
    const second = registry!.register({ name: '乙', render: () => '乙的内容' })
    // 别的模块（内核自带的"模块依赖图"等）也可能登记段落：只断言本用例的两条
    // 各就各位、互不覆盖，不断言"总数恰好是 2"。
    expect(handle.statusNames()).toContain('甲')
    expect(handle.statusNames()).toContain('乙')
    expect(handle.status().join('\n')).toContain('甲的内容')
    expect(handle.status().join('\n')).toContain('乙的内容')
    first()
    expect(handle.statusNames()).not.toContain('甲')
    expect(handle.statusNames()).toContain('乙')
    second()
    expect(handle.statusNames()).toEqual(before)
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

  it('不传 session 时**不挑"最近活跃会话"**：压力读数缺失，显式会话才读得到', () => {
    const { handle } = start({ fillRatio: 0.45 })
    handle.kernel.emit('turn/start', { sessionId: 'live', turn: 1 })
    // 归属只认"这次是谁"：不传会话 → 读数缺失 → 宽松档、不施压
    // （旧行为是借用 live 的压力去塑形本次注入——那正是交错会话下的错误来源）
    expect(metricsOf(handle).select(pool, []).length).toBe(0)
    const noSession = pressureOf(handle).read()
    expect(noSession.pressure.fillRatio).toBeNull()
    expect(noSession.band).toBe('relaxed')
    // 显式给会话 → 读到它的真实压力（0.45 在缺省阈值下是 moderate）
    expect(pressureOf(handle).read('live').pressure.fillRatio).toBeCloseTo(0.45, 6)
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
  it('记录拉取后计数、轮次与 pullsPerTurn 都可读（按会话口径）', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 2 })
    metrics.recordPull('omb_recall', 's')
    metrics.recordPull('omb_recall', 's')
    metrics.recordPull('omb_method', 's')

    const snapshot: PullSnapshot = metrics.snapshot('s')
    expect(snapshot.turns).toBe(2)
    expect(snapshot.totalPulls).toBe(3)
    expect(snapshot.views.find(view => view.view === 'omb_recall')?.pulls).toBe(2)
    expect(snapshot.views.find(view => view.view === 'omb_recall')?.lastTurn).toBe(2)
    expect(metrics.views('s').map(view => view.view)).toEqual([...VIEW_TOOLS].sort())
    // 缺省口径是**未知会话**（不挑"当前会话"）：这条断言就是"不猜"的机器化
    expect(metrics.snapshot().session).toBeNull()
    expect(metrics.snapshot().totalPulls).toBe(0)
    handle.dispose()
  })

  it('长期 0 拉取 → 该会话的杀死判据可读（状态面逐会话列出）', () => {
    const { handle } = start()
    for (let turn = 1; turn <= 20; turn += 1) handle.kernel.emit('turn/start', { sessionId: 's', turn })
    const metrics = metricsOf(handle)
    // 判据挂在会话上：显式会话才给结论
    expect(metrics.killList('s')).toContain('omb_recall')
    expect(metrics.snapshot('s').deadViews).toHaveLength(5)
    expect(metrics.snapshot().deadViews).toEqual([]) // 未知会话桶永远不下结论
    // 状态面：分会话一行一行列出（读者不需要猜这个数是谁的）
    const text = handle.status().join('\n')
    expect(text).toContain('分会话拉取台账')
    expect(text).toContain('- s：')
    expect(text).toContain('待删除视图')
    expect(text).toContain('omb_files')
    // 模块行只说"分会话计 N 个会话"，不再冒充"本会话"
    const detail = handle.health()[MODULE_ID]?.detail ?? ''
    expect(detail).toContain('分会话计 1 个会话')
    handle.dispose()
  })

  it('轮数不足时该会话的判据如实说"暂不下删除结论"（不把样本不够说成一切正常）', () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const verdict = metricsOf(handle).snapshot('s').verdict
    expect(verdict).toContain('暂不下')
    // 理由必须钉住：旧文案写"轮数不足"，新文案写"已观察 1 轮（判定需 20 轮）"。
    // 只断"暂不下"是不够的——那样文案退化成一句空洞的"暂不下"也照样绿。
    expect(verdict).toContain('本会话已观察 1 轮')
    expect(verdict).toContain('判定需 20 轮')
    expect(verdict).not.toContain('无视图趋近 0')
    expect(metricsOf(handle).snapshot('s').deadViews).toEqual([])
    handle.dispose()
  })

  it('缓存命中率来自度量桥；无缓存数据时为 null（不可测，不是 0）', () => {
    const { handle } = start()
    expect(metricsOf(handle).cacheHitRate('s')).toBeCloseTo(0.8, 6)
    handle.dispose()
  })

  it('recordPull 拿不到会话 → 落进"未知会话"桶；显式传会话 → 记到该会话名下（都不抛）', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    expect(() => metrics.recordPull('omb_files')).not.toThrow()
    const unknown = metrics.snapshot()
    expect(unknown.session).toBeNull()
    expect(unknown.totalPulls).toBe(1)
    expect(unknown.turnsKnown).toBe(false)

    metrics.recordPull('omb_files', '从未见过的会话')
    expect(metrics.snapshot('从未见过的会话').totalPulls).toBe(1)
    // 显式会话的账不会被并进"未知会话"桶
    expect(metrics.snapshot().totalPulls).toBe(1)
    handle.dispose()
  })
})

describe('台账按会话隔离（本会话口径）', () => {
  it('两个会话各自记账、互不串味；待删除列表只在各自口径下给出', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)

    // 会话 A：跑满 20 轮，一次都没拉过任何一个视图
    for (let turn = 1; turn <= 20; turn += 1) handle.kernel.emit('turn/start', { sessionId: 'A', turn })
    // 会话 B：只有 1 轮，拉了 3 次 omb_recall
    handle.kernel.emit('turn/start', { sessionId: 'B', turn: 1 })
    metrics.recordPull('omb_recall', 'B')
    metrics.recordPull('omb_recall', 'B')
    metrics.recordPull('omb_recall', 'B')

    // A 的账：20 轮、0 拉取 → 判据成立，五个视图都在待删除列表里
    const a = metrics.snapshot('A')
    expect(a.session).toBe('A')
    expect(a.turns).toBe(20)
    expect(a.totalPulls).toBe(0)
    expect(a.settled).toBe(true)
    expect(a.deadViews.length).toBe(5)
    expect(metrics.killList('A')).toContain('omb_recall')

    // B 的账：1 轮、3 拉取 → 轮数不足，**不给待删除列表**；A 的 20 轮不进来
    const b = metrics.snapshot('B')
    expect(b.session).toBe('B')
    expect(b.turns).toBe(1)
    expect(b.totalPulls).toBe(3)
    expect(b.settled).toBe(false)
    expect(b.deadViews).toEqual([])
    expect(b.verdict).toContain('暂不下')
    expect(metrics.killList('B')).toEqual([])
    expect(b.views.find(view => view.view === 'omb_recall')?.pulls).toBe(3)

    // A 那边仍然是 0 次：B 的拉取没有串进 A
    expect(a.views.find(view => view.view === 'omb_recall')?.pulls).toBe(0)
    expect(metrics.views('A').find(view => view.view === 'omb_recall')?.pulls).toBe(0)

    // 缺省口径 = **未知会话**（不再挑"最近活跃会话"）——B 的账不会被当成"当前会话"
    expect(metrics.snapshot().session).toBeNull()
    expect(metrics.snapshot().totalPulls).toBe(0)
    const detail = handle.health()[MODULE_ID]?.detail ?? ''
    expect(detail).toContain('分会话计 2 个会话')
    expect(detail).not.toContain('待删除视图')
    // 逐会话读数在状态面里（A 的判据与 B 的"轮数不足"都在）
    const text = handle.status().join('\n')
    expect(text).toContain('待删除视图')
    expect(text).toContain('轮数不足')
    handle.dispose()
  })

  it('归属来自调用方而不是任何"登记处"：不传会话就落未知桶（不借用内核当前会话）', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    // 模块订阅到的回合 + 内核登记处都指向具体会话
    handle.kernel.emit('turn/start', { sessionId: 'from-event', turn: 1 })
    handle.kernel.service<{ remember(session: string): void }>(SERVICES.activeSession)?.remember('from-kernel')

    // 但调用方没给会话 → 记进未知桶，**不**记到 from-event / from-kernel 名下
    metrics.recordPull('omb_recall')
    expect(metrics.snapshot('from-event').totalPulls).toBe(0)
    expect(metrics.snapshot('from-kernel').totalPulls).toBe(0)
    expect(metrics.snapshot().session).toBeNull()
    expect(metrics.snapshot().totalPulls).toBe(1)

    // 显式给会话时才是那个会话的账
    metrics.recordPull('omb_recall', 'from-event')
    expect(metrics.snapshot('from-event').totalPulls).toBe(1)
    handle.dispose()
  })

  it('拿不到会话时落进"未知会话"桶，并在状态面明说（不混进任何具体会话）', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    metrics.recordPull('omb_recall')

    const unknown = metrics.snapshot()
    expect(unknown.session).toBeNull()
    expect(unknown.totalPulls).toBe(1)
    expect(unknown.turnsKnown).toBe(false)
    expect(unknown.deadViews).toEqual([])
    expect(unknown.verdict).toContain('回合数未知')

    // 状态面必须说清这个数是谁的
    const text = handle.status().join('\n')
    expect(text).toContain('未知会话拉取 1 次')
    expect(text).toContain('轮数未知')
    expect(text).toContain('不并入任何具体会话')
    expect(text).not.toContain('待删除视图')

    // 之后出现了具体会话：未知桶的计数不会被并进去
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    expect(metrics.snapshot('s').totalPulls).toBe(0)
    expect(metrics.snapshot('s').turns).toBe(1)
    handle.dispose()
  })

  it('本会话回合数未知时不下结论（分母未知，不用别的会话的轮数顶替）', () => {
    const { handle } = start()
    const metrics = metricsOf(handle)
    // 别的会话跑满 20 轮
    for (let turn = 1; turn <= 20; turn += 1) handle.kernel.emit('turn/start', { sessionId: 'other', turn })
    // 本会话只有一次拉取、没有任何回合边界
    metrics.recordPull('omb_recall', 'mine')
    const mine = metrics.snapshot('mine')
    expect(mine.turns).toBe(0)
    expect(mine.turnsKnown).toBe(false)
    expect(mine.pullsPerTurn).toBe(0)
    expect(mine.deadViews).toEqual([])
    expect(mine.verdict).toContain('回合数未知')
    handle.dispose()
  })
})

describe('状态面段落与热插拔', () => {
  it('段落内容包括档位行为、分会话台账与降级原因', () => {
    const { handle } = start({ fillRatio: 0.8 })
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const text = handle.status().join('\n')
    expect(text).toContain('### 上下文优化（omb-context）')
    // 压力读数**按会话**给（不再挑"当前会话"）：这一行就是 s 的读数，
    // 而且必须**连塑形后果一起给**——只写"压力 tight"读者不知道行为会怎么变。
    // 顶层的"档位行为"行是**无会话口径**（relaxed / pushLimit 0），代表不了 s，
    // 所以"有读数 → 有后果"这一点只能钉在分会话行上。
    expect(text).toContain('压力 tight（只保留索引）｜')
    // 服务面同一口径（面板若退化成"只有档位、没有后果"，上面那条会红）
    expect(pressureOf(handle).read('s').behavior.indexOnly).toBe(true)
    expect(text).toContain('拉取台账')
    expect(text).toContain('分会话拉取台账')
    handle.dispose()
  })

  it('说明由**本次**读数推出：拿到会话后不再留"无活跃会话"（旧结论不许累积）', () => {
    const { handle } = start({ fillRatio: 0.45 })
    const contributor = handle.kernel
      .service<StatusRegistry>(SERVICES.statusContributor)
      ?.list()
      .find(c => c.name === '上下文优化（omb-context）')
    expect(contributor, '上下文模块必须登记状态段').toBeDefined()
    // 状态面（`dsh/status-tool.ts`）渲染时会把本次会话作为第一个实参传进来
    const renderWith = (session?: string): string =>
      (contributor!.render as (session?: string) => string)(session)

    // 没有会话：读数缺失，且说明里明写原因（这是"未测量"的正确呈现）
    expect(renderWith()).toContain('fillRatio 未知')
    expect(renderWith()).toContain('无活跃会话：压力读数缺失')

    // 有会话：**同一段**必须整体切到实时读数，且不许再留着上面那句旧结论。
    // 旧实现把它 push 进累积的 `notes`，于是拿到会话后同一次输出里一边报
    // 真实 fillRatio、一边说"无活跃会话：读数缺失"——两个相反的说法。
    const live = renderWith('s')
    expect(live).toContain('fillRatio 0.450')
    expect(live).not.toContain('无活跃会话')
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
    // 这次拉取**只**落在（实例一，会话 s）这一格上：别的格必须仍是 0。
    // 既验"两个实例不共享"，也验"没有溅进未知会话桶"。
    expect(metricsOf(first.handle).snapshot('s').totalPulls).toBe(1)
    expect(metricsOf(first.handle).snapshot().totalPulls).toBe(0)
    expect(metricsOf(second.handle).snapshot('s').totalPulls).toBe(0)
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
