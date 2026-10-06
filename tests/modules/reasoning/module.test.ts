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
import {
  CONTROL_LINE_MAX,
  EXIT_SEGMENT_MAX,
  controlForBand,
  controlLine,
  renderExitOptions,
} from '../../../modules/reasoning/control.js'
import { LOOP_HINT_MAX } from '../../../modules/reasoning/loop.js'
import { GAMING_BANNED_WORDS } from '../../../modules/reasoning/gaming.js'
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
import { cardById, cardsFor, renderIndex, residentHint } from '../../../modules/reasoning/methods.js'

/** `omb-kernel` 占位注册：本测试只验证 reasoning 模块，不重复测内核。 */
const KERNEL_STUB: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.6.0',
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

    // 目录与生产的对应关系是**双向**的：目录声明的必须在生产注册，
    // **生产注册的也必须在目录里**。
    //
    // 为什么强调第二个方向（v3.6 补）：单向断言（只查"声明 ⊆ 实际"）**放过过一次真漂移**——
    // `omb_verify` 早已实现（`modules/reasoning/tools.ts`、`verify.ts`），
    // 而 `kernel/abi/catalog.ts` 的 `omb-reasoning` 行里长期只有两个工具名。
    // 漏登记永远不违反"声明 ⊆ 实际"，所以它一直没红；而目录是"这个模块提供什么"的对外声明，
    // 少了它，读者（与状态面）就以为这个模块只有两个工具。
    const names = toolsOf(handle).map(tool => tool.name).sort()
    const declaredNames = [...entry!.tools].sort()
    for (const declared of declaredNames) expect(names).toContain(declared)
    expect(names, '生产注册的工具与目录声明必须一一对应（双向断言）').toEqual(declaredNames)

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

    const verifySchema = schemaOf(toolsOf(handle).find(tool => tool.name === 'omb_verify'))
    const verifyProps = Object.keys((verifySchema.properties as Record<string, unknown>) ?? {})
    expect(verifyProps.sort()).toEqual(['claim', 'evidence', 'failure', 'falsifier'])
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

  it('deep + 非紧张档：一行控制读数 + 只注入 R4（不再注入 R3/R5 全文）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    expect(text).toContain(controlLine('deep', 0))
    expect(text).toContain(cardById('R4')?.text ?? '')
    expect(text).not.toContain(cardById('R3')?.text ?? '不可能匹配')
    expect(text).not.toContain(cardById('R5')?.text ?? '不可能匹配')
    handle.dispose()
  })

  it('注入的文本量不随档位线性膨胀：卡片数 0/0/1，deep 只比 standard 多一行读数', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const quick = render({ sessionId: 's', depth: 'quick', band: 'relaxed' })
    const standard = render({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    const deep = render({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    // standard 是基线（空）；quick 反而有一行抑制指令 → 文本量不是随档位单调膨胀
    expect(standard).toBe('')
    expect(quick.length).toBeGreaterThan(0)
    // deep 比 standard 多的只有那一行控制读数 + 一张卡，且读数有硬上限
    expect(deep.length - standard.length).toBeLessThanOrEqual(CONTROL_LINE_MAX + (cardById('R4')?.text.length ?? 0) + 2)
    // 今天的 deep 曾注入 R3+R4+R5 三张全文；现在必须显著更短
    const oldDeep = ['R3', 'R4', 'R5'].map(id => cardById(id)?.text ?? '').join('')
    expect(deep.length).toBeLessThan(oldDeep.length)
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderCards).toBe(1)
    handle.dispose()
  })

  it('deep + tight：读数保留 + 真的给索引（正文仍不给，全部转工具拉取）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'deep', band: 'tight' })
    /**
     * 这三条一起才叫"兑现承诺"（G2）：
     * ① 读数在——它是档位差异的唯一载体，紧张档压缩的是卡片正文，不是读数。
     *    此前这里断言的恰好相反（`not.toContain(controlLine)`），把错误行为钉住了。
     * ② 索引真的渲染出来（编号 + 标题 + 何时用），而不是一句"改用 omb_method 取"——
     *    那句承诺的索引此前**从未被渲染过**。
     * ③ 正文仍然不给：紧张档的本意没变。
     */
    expect(text).toContain(controlLine('deep', 0, 'tight'))
    expect(text).toContain('R3 备选再收敛')
    expect(text).toContain('R4 结论可检验')
    expect(text).toContain('R5 锚定具体')
    expect(text).toContain('何时用：')
    expect(text).toContain('omb_method')
    expect(text).not.toContain(cardById('R3')?.text ?? '不可能匹配')
    expect(text).not.toContain(cardById('R4')?.text ?? '不可能匹配')
    expect(text).not.toContain(cardById('R5')?.text ?? '不可能匹配')
    // 预算：紧张档增量 = 一行读数（≤CONTROL_LINE_MAX）+ 索引（deep 三行），仅此而已
    expect(text.length).toBeLessThanOrEqual(CONTROL_LINE_MAX + renderIndex(cardsFor('deep')).length + 1)
    // 留痕如实：读数真的进了上下文（记账 0 字符会与文本自相矛盾）
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderControlChars).toBe(controlLine('deep', 0, 'tight').length)
    handle.dispose()
  })

  it('有循环信号时每轮注入那句话（循环提示 ≤80 字符）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    const text = render({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    const hint = loopOf(handle).signal('s')?.hint ?? '不可能匹配'
    expect(text).toContain(hint)
    // 循环提示本身仍然 ≤ LOOP_HINT_MAX（这是这条用例原本的口径，不变）
    expect(hint.length).toBeLessThanOrEqual(LOOP_HINT_MAX)
    /**
     * 口径变更（v3.6，**不是放宽**）：此前这里断言整段注入 ≤ 80+8，
     * 那等于把"循环提示是压力下唯一出现的东西"钉住了——而 v3.6 的 A/B 两件改动
     * 恰恰是要在无进展时**多注入一段 ≤EXIT_SEGMENT_MAX 的合法出口**。
     * 现在改成逐段硬上限相加：循环提示（≤80）+ 出口段（≤200）+ 一个换行。
     */
    expect(text).toContain(renderExitOptions(loopOf(handle).signal('s'), controlForBand('standard', 'relaxed')))
    expect(text.length).toBeLessThanOrEqual(LOOP_HINT_MAX + EXIT_SEGMENT_MAX + 1)
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

  it('deep + relaxed：留痕显示真进了 R4、字符数，并写明自动注入上限', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    expect(text.length).toBeGreaterThan(0)
    expect(statusText(handle)).toContain('上次注入：成功（R4，')
    expect(statusText(handle)).toContain(`${text.length} 字符`)
    expect(statusText(handle)).toContain('自动注入上限 1 张')
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderCards).toBe(1)
    handle.dispose()
  })

  it('deep + tight：请求了卡却没进上下文——留痕如实说进了什么（读数+索引）', () => {
    const { handle } = start()
    contributionOf(handle).context!({ sessionId: 's', depth: 'deep', band: 'tight' })
    const line = statusText(handle)
    // 标签必须与内容对得上：紧张档进的是读数+索引，不是"只给了指令"
    expect(line).toContain('上次注入：只给了读数+索引、未含卡片正文')
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
    expect(line).toContain('上次注入：成功（R4，')
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
    expect(text).toContain(controlLine('deep', 0))
    expect(text).toContain(cardById('R4')?.text ?? '不可能匹配')
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
    // 正证：deep 的注入含控制读数与唯一那张卡（R4）
    expect(text).toContain(controlLine('deep', 0))
    expect(text).toContain('【R4 ')
    expect(text).toContain(cardById('R4')?.text ?? '不可能匹配')
    expect(handle.status().join('\n')).toContain('深度 deep')
    handle.dispose()
  })

  it('配置默认档为 deep：首个回合就落地，渲染即含控制读数与 R4（写入路径无 deep 专属分支）', () => {
    const { handle } = start({ defaultDepth: 'deep', residentHintChars: RESIDENT_HINT_MAX })
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    expect(handle.kernel.focus('s')).toBe('deep')
    const text = contributionOf(handle).context!({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    expect(text).toContain('【R4 ')
    expect(text).toContain(controlLine('deep', 0))
    handle.dispose()
  })
})

/**
 * 承诺一致性（G2 的另一半）：**回执说的、工具描述说的、渲染做的必须是同一件事**。
 *
 * 此前回执写"上下文紧张时只给读数、不给卡片"，而渲染在紧张档把读数整段丢掉、
 * 索引也从没渲染过——承诺与实现相反。这条测试把三者钉在一起。
 */
describe('回执 / 工具描述 / 渲染：紧张档说的是同一件事', () => {
  it('回执承诺"读数照给、正文降级为索引"，渲染侧兑现同一件事', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 'live', turn: 1 })
    const focusTool = toolsOf(handle).find(tool => tool.name === 'omb_focus')
    const outcome = await focusTool?.execute({ depth: 'deep', reason: '承诺一致性' })
    const receipt = outcome?.text ?? ''
    expect(receipt).toContain('上下文紧张时读数照给')
    expect(receipt).toContain('索引')
    // 工具描述也这么说（模型是先看描述、后看回执的）
    expect(focusTool?.description).toContain('上下文紧张时控制读数照给、规则卡只给索引')

    // 渲染侧：读数在、索引在、正文不在
    const tight = contributionOf(handle).context!({ sessionId: 'live', depth: 'deep', band: 'tight' })
    expect(tight).toContain(controlLine('deep', 0, 'tight'))
    expect(tight).toContain('何时用：')
    expect(tight).not.toContain(cardById('R4')?.text ?? '不可能匹配')
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

describe('Verify 可观测：验证段、台账、状态面与健康面', () => {
  const verifyToolOf = (handle: ReturnType<typeof createKernel>): ToolDefinition | undefined =>
    toolsOf(handle).find(tool => tool.name === 'omb_verify')

  it('核对一条没有来源的结论：回执给"缺来源"+下一步，台账记 1 次', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const outcome = await verifyToolOf(handle)?.execute({ claim: '这个函数是纯的' })
    expect(outcome?.kind).toBe('text')
    expect(outcome?.text).toContain('形式核对：缺来源')
    expect(outcome?.text).toContain('下一步')
    const health = handle.health()[MODULE_ID]
    expect(health?.metrics?.verifyCalls).toBe(1)
    expect(health?.metrics?.verifyUnresolved).toBe(1)
    expect(handle.status().join('\n')).toContain('验证：1 次')
    handle.dispose()
  })

  it('补上来源与否证条件后重核：同一条结论的未闭合数回落到 0，验证段随之消失', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const render = contributionOf(handle).context!
    await verifyToolOf(handle)?.execute({ claim: '这个函数是纯的' })
    // 有未闭合项 → 注入里出现验证段（状态驱动，不是档位驱动）
    expect(render({ sessionId: 's', depth: 'standard', band: 'relaxed' })).toContain('未过形式核对')
    await verifyToolOf(handle)?.execute({
      claim: '这个函数是纯的',
      evidence: 'src/a.ts:12',
      falsifier: '同输入不同结果就说明不纯',
    })
    expect(handle.health()[MODULE_ID]?.metrics?.verifyUnresolved).toBe(0)
    expect(render({ sessionId: 's', depth: 'standard', band: 'relaxed' })).not.toContain('未过形式核对')
    handle.dispose()
  })

  it('quick 档核对结论：明说本档不要求验证并建议升档（不阻塞）', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    handle.kernel.setFocus('s', 'quick', '简单问题')
    const outcome = await verifyToolOf(handle)?.execute({ claim: '甲' })
    expect(outcome?.kind).toBe('text')
    expect(outcome?.text).toContain('不要求验证')
    expect(outcome?.text).toContain('omb_focus')
    expect(handle.health()[MODULE_ID]?.metrics?.verifyOverBudget).toBe(1)
    handle.dispose()
  })

  it('给失败定性：回执含分类、策略与预算；状态面记下分布', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    const outcome = await verifyToolOf(handle)?.execute({ failure: 'parameter-error' })
    expect(outcome?.kind).toBe('text')
    expect(outcome?.text).toContain('parameter-error')
    expect(outcome?.text).toContain('alter')
    expect(outcome?.text).toContain('预算 1 次')
    expect(handle.status().join('\n')).toContain('失败分类：parameter-error 1')
    expect(handle.health()[MODULE_ID]?.metrics?.classifiedFailures).toBe(1)
    handle.dispose()
  })

  it('Loop → 分类：模型说 unknown，但窗口里有绕圈 → 判成 direction 问题（branch）', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    for (const action of ['a', 'a']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'e', at: 1 })
    }
    expect(loopOf(handle).signal('s')?.kind).toBe('repeat-action')
    const outcome = await verifyToolOf(handle)?.execute({ failure: 'unknown' })
    expect(outcome?.kind).toBe('text')
    expect(outcome?.text).toContain('strategy-error')
    expect(outcome?.text).toContain('branch')
    handle.dispose()
  })

  it('状态面回答"本回合验证了几次"（跨回合累计另有 calls）', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    await verifyToolOf(handle)?.execute({ claim: '甲' })
    await verifyToolOf(handle)?.execute({ claim: '乙' })
    expect(handle.status().join('\n')).toContain('本回合 2 次')
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 2 })
    await verifyToolOf(handle)?.execute({ claim: '丙' })
    expect(handle.status().join('\n')).toContain('验证：3 次（本回合 1 次')
    handle.dispose()
  })

  it('会话之间台账不串味；卸载后验证读数归零', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's1', turn: 1 })
    await verifyToolOf(handle)?.execute({ claim: '甲的结论' })
    expect(handle.health()[MODULE_ID]?.metrics?.verifyCalls).toBe(1)
    handle.kernel.emit('turn/start', { sessionId: 's2', turn: 1 })
    await verifyToolOf(handle)?.execute({ claim: '乙的结论' })
    expect(handle.health()[MODULE_ID]?.metrics?.verifyCalls).toBe(2)
    handle.dispose()
  })

  /**
   * G3（P1）：次数被 32 条台账上限截断后开始谎报。
   *
   * 现场：第 33 次之后回执永远说"这是第 33 次"，状态面会话行永远停在
   * "验证：32 次"，而同一次输出里的健康行是真实累计数——两个面互相矛盾。
   */
  it('同一会话核对 40 次：回执说"这是第 40 次"，状态面与健康面同为 40（不再互相矛盾）', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    let last = ''
    for (let index = 1; index <= 40; index += 1) {
      const outcome = await verifyToolOf(handle)?.execute({
        claim: `c${index}`,
        evidence: 'modules/reasoning/verify.ts:1',
        falsifier: '看到 Y 就说明这条不成立',
      })
      last = outcome?.text ?? ''
    }
    // 回执：这是第 40 次（此前永远是"第 33 次"）
    expect(last).toContain('这是第 40 次')
    const status = handle.status().join('\n')
    // 状态面会话行：验证 40 次（此前停在 32）
    expect(status).toContain('验证：40 次')
    // 健康行与状态行同口径：同一次输出里两个"验证次数"必须一样
    expect(status).toContain('验证 40 次')
    expect(handle.health()[MODULE_ID]?.metrics?.verifyCalls).toBe(40)
    // 超预算计数同样不能再被窗口截断（它此前是台账内的计数，会与健康面差 7）
    expect(status).toContain('超预算 39')
    expect(handle.health()[MODULE_ID]?.metrics?.verifyOverBudget).toBe(39)
    handle.dispose()
  })

  it('未闭合结论不随台账滚动消失：被挤出 32 条窗口的结论仍留在验证段与健康面里', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    for (let index = 1; index <= 40; index += 1) {
      // 无来源 → needs-evidence（未闭合）
      await verifyToolOf(handle)?.execute({ claim: `c${index}` })
    }
    expect(handle.health()[MODULE_ID]?.metrics?.verifyUnresolved).toBe(40)

    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    // 验证段还在（此前台账一滚，unresolved 掉到 0，这一段直接消失）
    expect(text).toContain('未过形式核对')
    expect(text).toContain('40 条结论未过形式核对')

    // 补上来源重核其中一条 → 未闭合按**最新判定**降到 39（待办不是历史）
    await verifyToolOf(handle)?.execute({
      claim: 'c1',
      evidence: 'modules/reasoning/verify.ts:1',
      falsifier: '看不到就说明这条不成立',
    })
    expect(handle.health()[MODULE_ID]?.metrics?.verifyUnresolved).toBe(39)
    expect(handle.health()[MODULE_ID]?.metrics?.verifyCalls).toBe(41)
    handle.dispose()
  })
})

/**
 * v3.6 A：压力—严谨度耦合。
 *
 * 缺陷形态（Lead 已按源码核实）：验证段写在 `else`（非 tight）分支里，
 * 于是**压力最大时"你还有 N 条结论未过形式核对"整段不注入**，
 * 而 `control.ts` 的 `stopRule` / `evidenceLevel` 又只由 depth 决定——
 * 压力最大 = 相对更松。这一组是它的判据：**把 else 写回去，第一条就会红**。
 */
describe('A 压力—严谨度耦合：压力最大时提醒与门槛只升不降', () => {
  const verifyToolOf = (handle: ReturnType<typeof createKernel>): ToolDefinition | undefined =>
    toolsOf(handle).find(tool => tool.name === 'omb_verify')

  it('A① tight 不再吞掉验证段：同一批未闭合结论，两种压力档都注入（写回 else 就红）', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    await verifyToolOf(handle)?.execute({ claim: '这个函数是纯的' })
    expect(handle.health()[MODULE_ID]?.metrics?.verifyUnresolved).toBe(1)

    const render = contributionOf(handle).context!
    const relaxed = render({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    const tight = render({ sessionId: 's', depth: 'standard', band: 'tight' })

    // 两档都必须出现——验证段是**状态**驱动（有未闭合结论），不是压力驱动
    expect(relaxed).toContain('未过形式核对')
    expect(tight).toContain('未过形式核对')
    // 且两档注入的是同一段（压力不改变这段的内容）
    expect(tight).toBe(relaxed)

    // 留痕必须跟上：压力档下的验证段也要记账（记账 0 会与文本自相矛盾）
    const metrics = handle.health()[MODULE_ID]?.metrics
    expect(metrics?.lastRenderVerifyChars).toBeGreaterThan(0)
    expect(handle.status().join('\n')).toMatch(/验证段 [1-9]\d* 字符/)
    handle.dispose()
  })

  it('A① 反向：没有未闭合结论时两种压力档都不注入验证段（不是"压力大就多说"）', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    expect(render({ sessionId: 's', depth: 'standard', band: 'tight' })).not.toContain('未过形式核对')
    expect(render({ sessionId: 's', depth: 'standard', band: 'relaxed' })).not.toContain('未过形式核对')
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderVerifyChars).toBe(0)
    handle.dispose()
  })

  it('A② tight 把 quick 的门槛抬到不低于 standard，且**抬了就真的读出来**', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    const text = render({ sessionId: 's', depth: 'quick', band: 'tight' })

    // ① 参数：只升不降（quick 在下限之下 → 抬到 standard 的水平）
    expect(controlForBand('quick', 'tight').stopRule).toBe(controlForBand('standard', 'tight').stopRule)
    expect(controlForBand('quick', 'tight').evidenceLevel).toBe(controlForBand('standard', 'tight').evidenceLevel)

    // ② 电来了：读数真的进了上下文（quick 平时不读数，这一档是"压力抬了门槛"才读）
    expect(text).toContain(controlLine('quick', 0, 'tight'))
    expect(text).toContain('压力 tight')
    // quick 自己的收尾条件是"给出答案即可"；tight 下它被抬到 standard 的水平
    expect(text).toContain('首选方案有证据支撑')
    expect(text).not.toContain('给出答案即可')
    expect(text).toContain(QUICK_DIRECTIVE)
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderControlChars).toBeGreaterThan(0)

    // ③ 没抬门槛的组合就不加字：standard + tight 的读数与 standard 无压力时相同
    expect(controlForBand('standard', 'tight')).toEqual(controlForBand('standard', 'relaxed'))
    expect(render({ sessionId: 's', depth: 'standard', band: 'tight' })).not.toContain('压力 tight')
    handle.dispose()
  })

  it('A② 压力不降门槛：任何 depth × band 组合下，tight 都不低于 standard 的下限', () => {
    const floor = controlForBand('standard', 'relaxed')
    const rank = { evidence: ['none', 'cite-source', 'cite-and-label'], stop: ['first-answer', 'evidence-backed', 'verified-or-labeled'] }
    for (const depth of FOCUS_DEPTH_VALUES) {
      const relaxed = controlForBand(depth, 'relaxed')
      for (const band of ['relaxed', 'moderate', 'tight'] as const) {
        const control = controlForBand(depth, band)
        // ① 同一 depth 下：压力升高**不得**把门槛降下来
        expect(rank.evidence.indexOf(control.evidenceLevel)).toBeGreaterThanOrEqual(
          rank.evidence.indexOf(relaxed.evidenceLevel),
        )
        expect(rank.stop.indexOf(control.stopRule)).toBeGreaterThanOrEqual(rank.stop.indexOf(relaxed.stopRule))
        // ② tight 下：不得低于 standard 档的下限
        if (band === 'tight') {
          expect(rank.evidence.indexOf(control.evidenceLevel)).toBeGreaterThanOrEqual(
            rank.evidence.indexOf(floor.evidenceLevel),
          )
          expect(rank.stop.indexOf(control.stopRule)).toBeGreaterThanOrEqual(rank.stop.indexOf(floor.stopRule))
        }
      }
    }
    // 档位阶梯本身不受影响：quick 在非 tight 下仍然是 quick（下限只在 tight 生效）
    expect(controlForBand('quick', 'relaxed').stopRule).toBe('first-answer')
  })
})

/**
 * v3.6 B：显式"合法出口" + 判据重述。
 *
 * 依据：**"诚实解仍可行"是压制生效的前提**，而"合法选项被封闭"会把 misalignment
 * 从 0% 推到 96%（研究报告 §3）。所以信号出现时注入的是**出口**，不是"别绕圈"。
 */
describe('B 合法出口：只在无进展时注入，且写出出口与判据', () => {
  /** 造一个真实的 `stalled` 窗口：同一动作非相邻重复 3 次、窗口内没有新证据。 */
  function stalledWindow(handle: ReturnType<typeof createKernel>): void {
    for (const action of ['a', 'b', 'a', 'c', 'a']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'e', at: 1 })
    }
  }

  it('stalled 触发：注入里出现三个出口与完成判据，且 ≤EXIT_SEGMENT_MAX 字符', () => {
    const { handle } = start()
    stalledWindow(handle)
    expect(loopOf(handle).signal('s')?.kind).toBe('stalled')

    const text = contributionOf(handle).context!({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    expect(text).toContain('三个合法出口')
    expect(text).toContain('完成判据')
    // 判据重述的是**本会话当前生效的门槛**（standard 档），不是一句"要严谨"
    expect(text).toContain('首选方案有证据支撑')
    // 长度上界：逐段的硬上限相加（循环提示 ≤80 + 出口段 ≤200 + 换行）
    expect(text.length).toBeLessThanOrEqual(LOOP_HINT_MAX + EXIT_SEGMENT_MAX + 1)
    // 电来了的留痕：出口段真的进了上下文，且状态面报得出它的字符数
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderExitChars).toBeGreaterThan(0)
    expect(handle.status().join('\n')).toMatch(/出口段 [1-9]\d* 字符/)
    handle.dispose()
  })

  it('no-new-evidence 同样触发（复用现有循环通道，不需要新信号源）', () => {
    const { handle } = start()
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    expect(loopOf(handle).signal('s')?.kind).toBe('no-new-evidence')
    expect(contributionOf(handle).context!({ sessionId: 's', depth: 'standard', band: 'relaxed' }))
      .toContain('三个合法出口')
    handle.dispose()
  })

  it('repeat-action / 无信号都不触发：不是每轮常驻，也不是所有循环信号都套同一段', () => {
    const { handle } = start()
    const render = contributionOf(handle).context!
    // 无信号
    expect(render({ sessionId: 's', depth: 'standard', band: 'relaxed' })).not.toContain('三个合法出口')
    // 有信号但属于"这一步做错了"（它自己的 hint 已给出具体出口）
    for (const action of ['a', 'a']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'e', at: 1 })
    }
    expect(loopOf(handle).signal('s')?.kind).toBe('repeat-action')
    const text = render({ sessionId: 's', depth: 'standard', band: 'relaxed' })
    expect(text).toContain('（检测到循环）')
    expect(text).not.toContain('三个合法出口')
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderExitChars).toBe(0)
    handle.dispose()
  })

  it('出口段在 tight 下同样注入（压力不吞掉它），并随抬升后的判据重述', () => {
    const { handle } = start()
    stalledWindow(handle)
    const text = contributionOf(handle).context!({ sessionId: 's', depth: 'quick', band: 'tight' })
    expect(text).toContain('三个合法出口')
    // quick+tight 的判据已被抬到 standard 的水平——重述的必须是**抬升后**的那条
    // （quick 自己的收尾条件是"给出答案即可"；tight 下不得低于 standard）
    expect(text).toContain('首选方案有证据支撑')
    expect(text).not.toContain('给出答案即可')
    handle.dispose()
  })
})

/**
 * v3.6 C：糊弄倾向**只做状态面观察**。
 *
 * 这一组同时钉住两件事：① 事实真的进了状态面；② 它**不进注入路径**
 * （证据不支持"检测到作弊"这类结论，CoT 自述承认作弊 <2%）。
 */
describe('C 糊弄倾向：状态面观察（信号，不是结论）', () => {
  const statusText = (handle: ReturnType<typeof createKernel>): string => handle.status().join('\n')
  const verifyToolOf = (handle: ReturnType<typeof createKernel>): ToolDefinition | undefined =>
    toolsOf(handle).find(tool => tool.name === 'omb_verify')

  it('无信号时明说"无信号"，并把**未测量项**写在同一条里（不把没测读成没有）', () => {
    const { handle } = start()
    const line = statusText(handle)
    expect(line).toContain('糊弄倾向：无信号')
    expect(line).toContain('未测量')
    expect(line).toContain('测试被改写/跳过')
    handle.dispose()
  })

  it('连续无新证据：状态面出现可核对的事实与计数，并标成"信号"', () => {
    const { handle } = start()
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    const line = statusText(handle)
    expect(line).toContain('糊弄倾向：1 个信号')
    expect(line).toContain('低召回高精度')
    expect(line).toContain('不是检测器')
    expect(line).toContain('连续 3 轮没有新增证据')
    expect(handle.health()[MODULE_ID]?.metrics?.gamingSignals).toBe(1)
    handle.dispose()
  })

  it('同一条未闭合结论跨回合反复核对：状态面报出回合数与次数（可核对的事实）', async () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    await verifyToolOf(handle)?.execute({ claim: '甲的结论' })
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 2 })
    await verifyToolOf(handle)?.execute({ claim: '甲的结论' })
    const line = statusText(handle)
    expect(line).toContain('跨 2 个回合被核对 2 次')
    expect(line).toContain('仍未过形式核对')
    // 补上可核对来源后不再算信号（待办不是历史）
    await verifyToolOf(handle)?.execute({
      claim: '甲的结论',
      evidence: 'modules/reasoning/gaming.ts:1',
      falsifier: '看不到这条事实就说明不成立',
    })
    expect(statusText(handle)).toContain('糊弄倾向：无信号')
    handle.dispose()
  })

  it('观察面**不进任何注入路径**：同一批状态下 context() 里没有这些字样', () => {
    const { handle } = start()
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    expect(statusText(handle)).toContain('糊弄倾向：1 个信号')
    const text = contributionOf(handle).context!({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    expect(text).not.toContain('糊弄倾向')
    expect(text).not.toContain('未测量')
    handle.dispose()
  })

  it('状态面不出现结论性措辞（"检测到作弊"这类）：禁用词只作用于**这一行观察面**', () => {
    const { handle } = start()
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    // 只取这一行：状态面别处的"（检测到循环）"是**结构事实**的客观说法（Loop 的既有措辞），
    // 与"对糊弄倾向下结论"是两回事——禁用词表管的是后者。
    const line = statusText(handle).split('\n').find(text => text.startsWith('糊弄倾向：')) ?? ''
    expect(line).not.toBe('')
    for (const banned of GAMING_BANNED_WORDS) {
      expect(line.includes(banned), `观察面出现禁用词"${banned}"：${line}`).toBe(false)
    }
    handle.dispose()
  })
})

describe('配置类型（编译期契约）', () => {
  it('ReasoningConfig 的两个字段都是必填（缺省由 schema 补）', () => {
    const config: ReasoningConfig = { defaultDepth: 'deep', residentHintChars: 120 }
    expect(Object.keys(config).sort()).toEqual(['defaultDepth', 'residentHintChars'])
  })
})
