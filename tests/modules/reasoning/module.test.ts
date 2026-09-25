/**
 * `omb-reasoning` 模块注册（热插拔 + 事件接线 + 服务面）。
 *
 * 用**真实微内核**（`createKernel`）+ 一个 `omb-kernel` 占位注册，
 * 覆盖：清单与目录一致、配置缺省、服务面、事件 → 滚动窗口 → 循环信号、
 * 提示贡献的三档行为、默认档位幂等、卸载后零残留。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import type { ModuleRegistration, PromptContribution, ToolDefinition, ToolFactory } from '../../../kernel/abi/index.js'
import { MODULE_CATALOG, RESIDENT_HINT_MAX, SERVICES } from '../../../kernel/abi/index.js'
import { QUICK_DIRECTIVE, FOCUS_DEPTH_VALUES } from '../../../modules/reasoning/focus.js'
import { FOCUS_DEPTHS } from '../../../kernel/abi/index.js'
import type {
  ReasoningConfig,
  ReasoningLoopService,
  ReasoningMethodsService,
  ReasoningToolInput,
} from '../../../modules/reasoning/index.js'
import {
  DEFAULT_REASONING_CONFIG,
  MODULE_ID,
  createReasoningModule,
  reasoningConfigSchema,
} from '../../../modules/reasoning/index.js'
import { cardById, residentHint } from '../../../modules/reasoning/methods.js'

/** `omb-kernel` 占位注册：本测试只验证 reasoning 模块，不重复测内核。 */
const KERNEL_STUB: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.0.0',
    requires: [],
    capabilities: ['kernel.services', 'kernel.events', 'kernel.health'],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试用内核占位' }),
  },
  apply: () => {},
}

const entry = MODULE_CATALOG.find(candidate => candidate.id === 'omb-reasoning')

function start(config?: unknown) {
  const handle = createKernel()
  const registration = createReasoningModule()
  const configs = config === undefined ? undefined : new Map<string, unknown>([[MODULE_ID, config]])
  const blocked = handle.start([KERNEL_STUB, registration], configs)
  return { handle, blocked, registration }
}

function contributionOf(handle: ReturnType<typeof createKernel>): PromptContribution {
  const contribution = handle.kernel.service<PromptContribution>(SERVICES.promptReasoning)
  expect(contribution).toBeDefined()
  return contribution!
}

function loopOf(handle: ReturnType<typeof createKernel>): ReasoningLoopService {
  const service = handle.kernel.service<ReasoningLoopService>(SERVICES.reasoningLoop)
  expect(service).toBeDefined()
  return service!
}

describe('清单与目录一致（catalog 冻结契约）', () => {
  it('目录里有 omb-reasoning，且 requires / capabilities 对齐', () => {
    expect(entry).toBeDefined()
    const registration = createReasoningModule()
    expect(registration.manifest.id).toBe(MODULE_ID)
    expect(registration.manifest.requires).toEqual(entry!.requires)
    expect([...registration.manifest.capabilities].sort()).toEqual([...entry!.capabilities].sort())
  })

  it('manifest.health() 永远返回带 detail 的健康值', async () => {
    const health = await createReasoningModule().manifest.health()
    expect(['ok', 'degraded', 'failed']).toContain(health.state)
    expect(health.detail.length).toBeGreaterThan(0)
  })

  it('缺少 omb-kernel 时被阻断并写明原因（不抛到会话）', () => {
    const handle = createKernel()
    const blocked = handle.start([createReasoningModule()])
    expect(blocked.map(item => item.id)).toEqual([MODULE_ID])
    expect(blocked[0]?.reason).toContain('omb-kernel')
    expect(handle.health()[MODULE_ID]?.state).toBe('failed')
    handle.dispose()
  })
})

describe('configSchema（缺省值必须完整）', () => {
  it('parse(undefined) 得到完整缺省配置——内核确实会传 undefined', () => {
    expect(reasoningConfigSchema.parse(undefined)).toEqual(DEFAULT_REASONING_CONFIG)
  })

  it('缺字段各自走缺省', () => {
    expect(reasoningConfigSchema.parse({})).toEqual(DEFAULT_REASONING_CONFIG)
    expect(reasoningConfigSchema.parse({ defaultDepth: 'deep' })).toEqual({
      defaultDepth: 'deep',
      residentHintChars: RESIDENT_HINT_MAX,
    })
  })

  it('非法取值抛异常（由内核标 failed 并写明原因，不静默接受）', () => {
    expect(() => reasoningConfigSchema.parse({ defaultDepth: 'DEEP' })).toThrow()
    expect(() => reasoningConfigSchema.parse({ residentHintChars: 0 })).toThrow()
    expect(() => reasoningConfigSchema.parse({ defaultDepth: 3 })).toThrow()
  })

  it('档位取值与 ABI 的 FOCUS_DEPTHS 完全一致', () => {
    expect([...FOCUS_DEPTH_VALUES]).toEqual([...FOCUS_DEPTHS])
  })
})

describe('启动后的服务面', () => {
  it('五个服务/登记项都在：prompt:reasoning / reasoning:tools / loop / methods / 状态段', () => {
    const { handle, blocked } = start()
    expect(blocked).toEqual([])
    expect(handle.health()[MODULE_ID]?.state).toBe('ok')

    const contribution = contributionOf(handle)
    expect(contribution.resident).toBe(residentHint())
    expect(contribution.resident!.length).toBeLessThanOrEqual(RESIDENT_HINT_MAX)

    const factory = handle.kernel.service<ToolFactory<ReasoningToolInput>>(SERVICES.reasoningTools)
    expect(factory).toBeDefined()
    const tools = factory!.create({ currentSession: 's1' })
    expect(tools.map(tool => tool.name)).toEqual(entry!.tools)

    expect(loopOf(handle).signal('没人用过的会话')).toBeNull()

    const methods = handle.kernel.service<ReasoningMethodsService>(SERVICES.reasoningMethods)
    expect(methods?.cardsFor('deep').map(card => card.id)).toEqual(['R3', 'R4', 'R5'])
    expect(methods?.resident()).toBe(contribution.resident)

    expect(handle.statusNames()).toContain('思维链质量（omb-reasoning）')
    expect(handle.status().join('\n')).toContain('规则卡 8 张')
    handle.dispose()
  })

  it('工具带原始 JSON Schema（dsh 注册需要；缺失会让模型看不到入参）', () => {
    const { handle } = start()
    const factory = handle.kernel.service<ToolFactory<ReasoningToolInput>>(SERVICES.reasoningTools)
    const tools = factory!.create({ currentSession: 's1' })
    const schemaOf = (tool: ToolDefinition | undefined): Record<string, unknown> =>
      (tool?.parameters as unknown as { jsonSchema?: Record<string, unknown> }).jsonSchema ?? {}

    const methodSchema = schemaOf(tools.find(tool => tool.name === 'omb_method'))
    expect(Object.keys((methodSchema.properties as Record<string, unknown>) ?? {})).toContain('topic')

    const focusSchema = schemaOf(tools.find(tool => tool.name === 'omb_focus'))
    const depth = (focusSchema.properties as Record<string, { enum?: readonly string[] }>).depth
    expect(depth?.enum).toEqual([...FOCUS_DEPTHS])
    expect(focusSchema.required).toEqual(['depth'])
    handle.dispose()
  })
})

describe('事件 → 滚动窗口 → 循环信号', () => {
  it('三条同证据的自省事件触发 no-new-evidence；窗口与健康面都反映', () => {
    const { handle } = start()
    const loop = loopOf(handle)
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    expect(loop.window('s').length).toBe(3)
    expect(loop.signal('s')?.kind).toBe('no-new-evidence')
    expect(handle.health()[MODULE_ID]?.detail).toContain('循环信号 1 个')
    expect(handle.health()[MODULE_ID]?.metrics?.activeLoopSignals).toBe(1)
    handle.dispose()
  })

  it('新证据到达后信号消失；reset 清空窗口', () => {
    const { handle } = start()
    const loop = loopOf(handle)
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    expect(loop.signal('s')?.kind).toBe('no-new-evidence')
    handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: 'd', evidenceHash: 'new', at: 2 })
    expect(loop.signal('s')).toBeNull()
    loop.reset('s')
    expect(loop.window('s')).toEqual([])
    expect(loop.signal('s')).toBeNull()
    handle.dispose()
  })

  it('会话之间互不串味', () => {
    const { handle } = start()
    const loop = loopOf(handle)
    for (const action of ['a', 'a']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's1', actionHash: action, evidenceHash: 'e', at: 1 })
    }
    expect(loop.signal('s1')?.kind).toBe('repeat-action')
    expect(loop.signal('s2')).toBeNull()
    handle.dispose()
  })
})

describe('提示贡献：三档行为 + 压力塑形', () => {
  it('resident 逐字节稳定且 ≤120；不含会话 id / 时间戳', () => {
    const { handle } = start()
    const contribution = contributionOf(handle)
    expect(contribution.resident).toBe(contributionOf(handle).resident)
    expect(contribution.resident).not.toContain('s-')
    handle.dispose()
  })

  it('standard + relaxed：不注入任何东西（拉取式）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    expect(render({ sessionId: 's', depth: 'standard', band: 'relaxed' })).toBe('')
    handle.dispose()
  })

  it('quick：注入抑制指令（不管压力档）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    expect(render({ sessionId: 's', depth: 'quick', band: 'relaxed' })).toContain(QUICK_DIRECTIVE)
    expect(render({ sessionId: 's', depth: 'quick', band: 'tight' })).toContain(QUICK_DIRECTIVE)
    handle.dispose()
  })

  it('deep + 非紧张档：给 R3/R4/R5 全文（模型显式动作提出的需求）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    for (const id of ['R3', 'R4', 'R5']) expect(text).toContain(cardById(id)?.text ?? '')
    handle.dispose()
  })

  it('deep + tight：只留索引（内容全部转工具拉取，不静默丢弃）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'deep', band: 'tight' })
    expect(text).toContain('omb_method')
    expect(text).not.toContain(cardById('R3')?.text ?? '不可能匹配')
    handle.dispose()
  })

  it('有循环信号时每轮注入那句话（≤80 字符）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    const text = render({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    expect(text).toContain(loopOf(handle).signal('s')?.hint ?? '不可能匹配')
    expect(text.length).toBeLessThanOrEqual(80 + 8)
    handle.dispose()
  })

  it('非法 depth 输入回落内核读数（不抛）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    handle.kernel.setFocus('s', 'quick', '测试')
    expect(render({ sessionId: 's', depth: 'bogus' as never, band: 'relaxed' })).toContain(QUICK_DIRECTIVE)
    handle.dispose()
  })
})

describe('默认档位只在会话首次落地（幂等，不逐轮抖动）', () => {
  it('配置 quick：首个回合落地，模型显式设档后不再被覆盖', () => {
    const { handle } = start({ defaultDepth: 'quick', residentHintChars: RESIDENT_HINT_MAX })
    expect(handle.kernel.focus('s1')).toBe('standard')
    handle.kernel.emit('turn/start', { sessionId: 's1', turn: 1 })
    expect(handle.kernel.focus('s1')).toBe('quick')
    handle.kernel.setFocus('s1', 'deep', '模型显式设档')
    handle.kernel.emit('turn/start', { sessionId: 's1', turn: 2 })
    expect(handle.kernel.focus('s1')).toBe('deep')
    handle.dispose()
  })

  it('缺省配置不干预档位（standard 是内核缺省，不必写）', () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    expect(handle.kernel.focus('s')).toBe('standard')
    handle.dispose()
  })
})

describe('工具工厂的会话回落（dsh 目前传空 currentSession）', () => {
  it('空会话时回落到最近活跃会话，omb_focus 仍然可用', () => {
    const { handle } = start()
    const factory = handle.kernel.service<ToolFactory<ReasoningToolInput>>(SERVICES.reasoningTools)
    const tools = factory!.create({ currentSession: '' })
    handle.kernel.emit('turn/start', { sessionId: 'live', turn: 1 })
    const focusTool = tools.find(tool => tool.name === 'omb_focus')
    const outcome = focusTool?.execute({ depth: 'deep', reason: '测试回落' })
    expect(outcome?.kind).toBe('text')
    expect(handle.kernel.focus('live')).toBe('deep')
    handle.dispose()
  })

  it('从未有过任何会话时给可读错误（不是抛异常）', () => {
    const { handle } = start()
    const factory = handle.kernel.service<ToolFactory<ReasoningToolInput>>(SERVICES.reasoningTools)
    const tools = factory!.create({ currentSession: '' })
    const outcome = tools.find(tool => tool.name === 'omb_focus')?.execute({ depth: 'deep', reason: 'r' })
    expect(outcome?.kind).toBe('error')
    expect(outcome?.text).toContain('会话')
    handle.dispose()
  })
})

describe('热插拔（H-1 / H-2）', () => {
  it('卸载后零残留：订阅者、服务、状态段都清干净；重复卸载不抛', () => {
    const { handle } = start()
    const kernel = handle.kernel
    expect(handle.listenerCount()).toBeGreaterThan(0)
    handle.dispose()
    expect(handle.listenerCount()).toBe(0)
    expect(kernel.service(SERVICES.promptReasoning)).toBeUndefined()
    expect(kernel.service(SERVICES.reasoningTools)).toBeUndefined()
    expect(kernel.service(SERVICES.reasoningLoop)).toBeUndefined()
    expect(kernel.service(SERVICES.reasoningMethods)).toBeUndefined()
    expect(handle.statusNames()).not.toContain('思维链质量（omb-reasoning）')
    expect(() => handle.dispose()).not.toThrow()
  })

  it('卸载后 manifest.health() 仍可读（说清是未启动状态）', async () => {
    const { handle, registration } = start()
    handle.dispose()
    const health = await registration.manifest.health()
    expect(health.detail.length).toBeGreaterThan(0)
  })

  it('配置超限时降级可见（manifest + 状态段 + 下一个事件后的健康面），常驻提示仍守 120 上限', async () => {
    const { handle, registration } = start({ defaultDepth: 'standard', residentHintChars: 500 })

    // 内核在 `apply` 返回后会写一条通用的 `{state:'ok'}`（kernel/index.ts:173），
    // 因此**启动瞬间**的 handle.health() 不反映模块自报的降级。降级本身不丢：
    // ① manifest.health() ② 状态面段落 ③ 下一个事件触发的重新上报都会写明原因。
    const own = await registration.manifest.health()
    expect(own.state).toBe('degraded')
    expect(own.detail).toContain('residentHintChars=500')

    expect(handle.status().join('\n')).toContain('residentHintChars=500')

    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const health = handle.health()[MODULE_ID]
    expect(health?.state).toBe('degraded')
    expect(health?.detail).toContain('residentHintChars=500')
    expect(contributionOf(handle).resident!.length).toBeLessThanOrEqual(RESIDENT_HINT_MAX)
    handle.dispose()
  })

  it('模块实例互不干扰（两个实例的窗口不共享）', () => {
    const first = start()
    const second = start()
    for (const action of ['a', 'b', 'c']) {
      first.handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    expect(loopOf(first.handle).signal('s')?.kind).toBe('no-new-evidence')
    expect(loopOf(second.handle).signal('s')).toBeNull()
    first.handle.dispose()
    second.handle.dispose()
  })
})

describe('配置类型（编译期契约）', () => {
  it('ReasoningConfig 的两个字段都是必填（缺省由 schema 补）', () => {
    const config: ReasoningConfig = { defaultDepth: 'deep', residentHintChars: 120 }
    expect(Object.keys(config).sort()).toEqual(['defaultDepth', 'residentHintChars'])
  })
})
