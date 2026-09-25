/**
 * `omb-reasoning` 模块注册（热插拔 + 事件接线 + 服务面）。
 *
 * 用**真实微内核**（`createKernel`）+ 一个 `omb-kernel` 占位注册，
 * 覆盖：清单与目录一致、配置缺省、服务面、事件 → 滚动窗口 → 循环信号、
 * 提示贡献的三档行为、默认档位幂等、卸载后零残留。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import type { ModuleRegistration, PromptContribution, ToolDefinition } from '../../../kernel/abi/index.js'
import { MODULE_CATALOG, RESIDENT_HINT_MAX, SERVICES, toolsServiceFor } from '../../../kernel/abi/index.js'
import { QUICK_DIRECTIVE, FOCUS_DEPTH_VALUES } from '../../../modules/reasoning/focus.js'
import { FOCUS_DEPTHS } from '../../../kernel/abi/index.js'
import type {
  ReasoningConfig,
  ReasoningLoopService,
  ReasoningMethodsService,
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

/** `tools:<模块 id>` 的交付形状是数组（dsh/plugin.ts 的前缀遍历只消费数组）。 */
function toolsOf(handle: ReturnType<typeof createKernel>): readonly ToolDefinition[] {
  const tools = handle.kernel.service<readonly ToolDefinition[]>(toolsServiceFor(MODULE_ID))
  expect(Array.isArray(tools)).toBe(true)
  return tools ?? []
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
  it('五个服务/登记项都在：prompt:omb-reasoning / tools:omb-reasoning / loop / methods / 状态段', () => {
    const { handle, blocked } = start()
    expect(blocked).toEqual([])
    expect(handle.health()[MODULE_ID]?.state).toBe('ok')

    const contribution = contributionOf(handle)
    expect(contribution.resident).toBe(residentHint())
    expect(contribution.resident!.length).toBeLessThanOrEqual(RESIDENT_HINT_MAX)

    expect(toolsOf(handle).map(tool => tool.name)).toEqual(entry!.tools)

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
    const schemaOf = (tool: ToolDefinition | undefined): Record<string, unknown> =>
      (tool?.parameters as unknown as { jsonSchema?: Record<string, unknown> }).jsonSchema ?? {}

    const methodSchema = schemaOf(toolsOf(handle).find(tool => tool.name === 'omb_method'))
    expect(Object.keys((methodSchema.properties as Record<string, unknown>) ?? {})).toContain('topic')

    const focusSchema = schemaOf(toolsOf(handle).find(tool => tool.name === 'omb_focus'))
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

/**
 * 自检报告抓的缺陷：注入是渲染期行为，`catch → return ''` 让"说了要注入却没注入"
 * 变成静默事实。这一组用**状态面的留痕**把那件事变成可核验的读数。
 */
describe('注入可核验：渲染留痕与失败留声', () => {
  const statusText = (handle: ReturnType<typeof createKernel>): string => handle.status().join('\n')

  it('deep + relaxed：留痕显示真进了 R3/R4/R5 与字符数', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    expect(text.length).toBeGreaterThan(0)
    expect(statusText(handle)).toContain('上次注入：成功（R3/R4/R5，')
    expect(statusText(handle)).toContain(`${text.length} 字符`)
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderCards).toBe(3)
    handle.dispose()
  })

  it('deep + tight：请求了卡却没进上下文——留痕如实说"只给了指令未含卡片"', () => {
    const { handle } = start()
    contributionOf(handle).context!({ sessionId: 's', depth: 'deep', band: 'tight' })
    const line = statusText(handle)
    expect(line).toContain('上次注入：只给了指令未含卡片')
    expect(line).toContain('请求 R3/R4/R5')
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderCards).toBe(0)
    handle.dispose()
  })

  it('standard + relaxed：留痕说"空"，且不算失败', () => {
    const { handle } = start()
    contributionOf(handle).context!({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    expect(statusText(handle)).toContain('上次注入：空')
    expect(statusText(handle)).not.toContain('上次注入：失败')
    expect(handle.health()[MODULE_ID]?.state).toBe('ok')
    handle.dispose()
  })

  it('渲染抛异常：绝不外抛，但失败次数与原因进状态面与健康面（不再静默）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const exploding = {
      sessionId: 's',
      depth: 'deep',
      get band(): never {
        throw new Error('渲染输入坏了')
      },
    }
    expect(() => render(exploding as never)).not.toThrow()
    expect(render(exploding as never)).toBe('')
    const line = statusText(handle)
    expect(line).toContain('上次注入：失败（渲染输入坏了）')
    expect(line).toContain('渲染失败累计 2 次（最近：渲染输入坏了）')
    const health = handle.health()[MODULE_ID]
    expect(health?.state).toBe('degraded')
    expect(health?.detail).toContain('上下文渲染失败 2 次')
    expect(health?.metrics?.renderFailures).toBe(2)
    handle.dispose()
  })

  it('失败之后又成功：成功留痕在，失败历史不被抹掉', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const exploding = {
      sessionId: 's',
      depth: 'deep',
      get band(): never {
        throw new Error('坏了')
      },
    }
    render(exploding as never)
    render({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    const line = statusText(handle)
    expect(line).toContain('上次注入：成功（R3/R4/R5，')
    expect(line).toContain('渲染失败累计 1 次（最近：坏了）')
    // 失败进过健康面就不会自己消失：降级状态保留
    expect(handle.health()[MODULE_ID]?.state).toBe('degraded')
    handle.dispose()
  })

  it('渲染入参档位与内核分歧：按内核渲染，分歧写进状态面', () => {
    const { handle } = start()
    handle.kernel.setFocus('s', 'deep', '内核里是 deep')
    const text = contributionOf(handle).context!({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    // 内核是档位权威：宿主递来的旧快照不得让 deep 静默降级
    expect(text).toContain(cardById('R3')?.text ?? '不可能匹配')
    expect(statusText(handle)).toContain('档位分歧：渲染入参 standard / 内核 deep')
    handle.dispose()
  })

  it('还没渲染过时留痕如实说"尚无"，而不是假装成功', () => {
    const { handle } = start()
    expect(statusText(handle)).toContain('上次注入：尚无')
    handle.dispose()
  })
})

/** 自检报告的缺口：只证明过"设回 standard 后读到 standard"，deep 缺一次正证。 */
describe('deep 正证：设 → 读 → 内容含卡号', () => {
  it('工具设 deep：内核读回 deep，渲染内容含 R3/R4/R5 卡号与正文，状态面写 deep', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 'live', turn: 1 })
    const focusTool = toolsOf(handle).find(tool => tool.name === 'omb_focus')
    const outcome = await focusTool?.execute({ depth: 'deep', reason: 'deep 正证' })
    expect(outcome?.kind).toBe('text')
    expect(handle.kernel.focus('live')).toBe('deep')

    const text = contributionOf(handle).context!({ sessionId: 'live', depth: 'deep', band: 'relaxed' })
    for (const id of ['R3', 'R4', 'R5']) {
      expect(text, `${id} 卡号应出现在注入内容里`).toContain(`【${id} `)
      expect(text).toContain(cardById(id)?.text ?? '不可能匹配')
    }
    expect(handle.status().join('\n')).toContain('深度 deep')
    handle.dispose()
  })

  it('配置默认档为 deep：首个回合就落地，渲染即含卡号（写入路径无 deep 专属分支）', () => {
    const { handle } = start({ defaultDepth: 'deep', residentHintChars: RESIDENT_HINT_MAX })
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    expect(handle.kernel.focus('s')).toBe('deep')
    const text = contributionOf(handle).context!({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    for (const id of ['R3', 'R4', 'R5']) expect(text).toContain(`【${id} `)
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

describe('工具的会话归属（最近活跃会话，不是 hack）', () => {
  it('回合开始后 omb_focus 落到该会话', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 'live', turn: 1 })
    const focusTool = toolsOf(handle).find(tool => tool.name === 'omb_focus')
    const outcome = await focusTool?.execute({ depth: 'deep', reason: '测试归属' })
    expect(outcome?.kind).toBe('text')
    expect(handle.kernel.focus('live')).toBe('deep')
    handle.dispose()
  })

  it('从未有过任何会话时给可读错误（不是抛异常）', async () => {
    const { handle } = start()
    const outcome = await toolsOf(handle).find(tool => tool.name === 'omb_focus')?.execute({ depth: 'deep', reason: 'r' })
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
    expect(kernel.service(toolsServiceFor(MODULE_ID))).toBeUndefined()
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

  it('配置超限时降级在启动瞬间就可见（内核不覆盖模块自报健康）', async () => {
    const { handle, registration } = start({ defaultDepth: 'standard', residentHintChars: 500 })

    const own = await registration.manifest.health()
    expect(own.state).toBe('degraded')
    expect(own.detail).toContain('residentHintChars=500')

    // 三条都要如实：模块自报、状态段、内核健康面
    const health = handle.health()[MODULE_ID]
    expect(health?.state).toBe('degraded')
    expect(health?.detail).toContain('residentHintChars=500')
    expect(handle.status().join('\n')).toContain('residentHintChars=500')

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
