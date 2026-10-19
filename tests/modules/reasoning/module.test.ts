/**
 * `omb-reasoning` 模块注册（v4 技能化后）。
 *
 * 用**真实微内核**（`createKernel`）+ 一个 `omb-kernel` 占位注册，覆盖：
 * 目录/服务面（工具与 methods 服务必须消失）、常驻提示 ≤80、注入恒 0（无信号时）、
 * 循环检测（callId/代际/迟滞）、状态诚实（采样 vs 现读）、会话 LRU、热插拔。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import type { ModuleRegistration, PromptContribution } from '../../../kernel/abi/index.js'
import { MODULE_CATALOG, RESIDENT_HINT_MAX, SERVICES, toolsServiceFor } from '../../../kernel/abi/index.js'
import { EXIT_SEGMENT_MAX } from '../../../modules/reasoning/hints.js'
import { LOOP_HINT_MAX, LOOP_HYSTERESIS_STEPS } from '../../../modules/reasoning/loop.js'
import { RESIDENT_HINT, RESIDENT_HINT_MAX_CHARS } from '../../../modules/reasoning/methods.js'
import type { ReasoningLoopService } from '../../../modules/reasoning/index.js'
import {
  DEFAULT_REASONING_CONFIG,
  MAX_TRACKED_SESSIONS,
  MODULE_ID,
  createReasoningModule,
  reasoningConfigSchema,
} from '../../../modules/reasoning/index.js'

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

function statusText(handle: ReturnType<typeof createKernel>): string {
  return handle.status().join('\n')
}

type Band = 'relaxed' | 'moderate' | 'tight'
type Depth = 'quick' | 'standard' | 'deep'

describe('目录与服务面：工具面清空、methods 服务消失', () => {
  it('目录登记：工具为空、能力只剩循环检测', () => {
    expect(entry).toBeDefined()
    expect(entry!.tools).toEqual([])
    expect(entry!.capabilities).toEqual(['reasoning.loop-detect'])
    const registration = createReasoningModule()
    expect(registration.manifest.id).toBe(MODULE_ID)
    expect(registration.manifest.requires).toEqual(entry!.requires)
    expect([...registration.manifest.capabilities].sort()).toEqual([...entry!.capabilities].sort())
  })

  it('启动后只剩 prompt + loop 两个服务；tools / methods 都必须是 undefined', () => {
    const { handle, blocked } = start()
    expect(blocked).toEqual([])
    expect(contributionOf(handle)).toBeDefined()
    expect(loopOf(handle).signal('没人用过的会话')).toBeNull()
    expect(handle.kernel.service(toolsServiceFor(MODULE_ID)), 'v4 不应再注册 tools:omb-reasoning').toBeUndefined()
    expect(handle.kernel.service(SERVICES.reasoningMethods), 'v4 不应再 provide reasoning:methods').toBeUndefined()
    handle.dispose()
  })

  it('不再提供任何工具名（omb_method/omb_focus/omb_verify 都不存在）', () => {
    const { handle } = start()
    const tools = handle.kernel.service<readonly { name: string }[]>(toolsServiceFor(MODULE_ID))
    expect(tools ?? []).toEqual([])
    for (const name of ['omb_method', 'omb_focus', 'omb_verify']) {
      expect(entry!.tools, `目录仍声明 ${name}`).not.toContain(name)
    }
    handle.dispose()
  })

  it('状态面登记了，且健康行说的是 v4 的现实', () => {
    const { handle } = start()
    expect(handle.statusNames()).toContain('思维链质量（omb-reasoning）')
    const detail = handle.health()[MODULE_ID]?.detail ?? ''
    expect(detail).toContain('skills（omb-depth 等）')
    expect(detail).toContain(`常驻提示 ${RESIDENT_HINT.length}/${RESIDENT_HINT_MAX_CHARS} 字符`)
    // v4 删除的面不许再出现在健康行
    for (const banned of ['规则卡 8 张', '验证', '推理预算映射', '尚未核对过结论']) {
      expect(detail.includes(banned), `健康行仍出现"${banned}"：${detail}`).toBe(false)
    }
    handle.dispose()
  })
})

describe('configSchema：只剩常驻预算，旧字段被剥离', () => {
  it('parse(undefined) / parse({}) 都得到完整缺省配置', () => {
    expect(reasoningConfigSchema.parse(undefined)).toEqual(DEFAULT_REASONING_CONFIG)
    expect(reasoningConfigSchema.parse({})).toEqual(DEFAULT_REASONING_CONFIG)
    expect(DEFAULT_REASONING_CONFIG).toEqual({ residentHintChars: RESIDENT_HINT_MAX_CHARS })
  })

  it('旧配置键（defaultDepth / effortMapping）不报错，只是不生效（zod strip）', () => {
    const parsed = reasoningConfigSchema.parse({ defaultDepth: 'deep', effortMapping: false, residentHintChars: 60 })
    expect(parsed).toEqual({ residentHintChars: 60 })
  })

  it('非法取值抛异常（不静默接受）', () => {
    expect(() => reasoningConfigSchema.parse({ residentHintChars: 0 })).toThrow()
    expect(() => reasoningConfigSchema.parse({ residentHintChars: '80' })).toThrow()
  })

  it('配置超过 80 时在启动瞬间降级，并在状态面写明收敛', () => {
    const { handle, registration } = start({ residentHintChars: 500 })
    const health = handle.health()[MODULE_ID]
    expect(health?.state).toBe('degraded')
    expect(health?.detail).toContain('residentHintChars=500')
    expect(health?.detail).toContain(`已收敛到 ${RESIDENT_HINT_MAX_CHARS}`)
    expect(contributionOf(handle).resident!.length).toBeLessThanOrEqual(RESIDENT_HINT_MAX_CHARS)
    handle.dispose()
    void registration
  })
})

describe('常驻提示：一句入口（≤80）', () => {
  it('与 methods.ts 的整句一致，且 ≤80 / ≤宿主共享预算', () => {
    const { handle } = start()
    const resident = contributionOf(handle).resident ?? ''
    expect(resident).toBe(RESIDENT_HINT)
    expect(resident.length).toBeLessThanOrEqual(RESIDENT_HINT_MAX_CHARS)
    expect(resident.length).toBeLessThanOrEqual(RESIDENT_HINT_MAX)
    expect(resident).toContain('omb-depth')
    expect(resident).toContain('skills')
    for (const banned of ['omb_method', 'omb_focus', 'omb_verify']) {
      expect(resident.includes(banned), `常驻提示仍提到 ${banned}`).toBe(false)
    }
    handle.dispose()
  })

  it('逐字节稳定（同进程两次取用相同）', () => {
    const { handle } = start()
    expect(contributionOf(handle).resident).toBe(contributionOf(handle).resident)
    handle.dispose()
  })
})

describe('注入：没有信号时恒为 0（不随档位/压力）', () => {
  const render = (handle: ReturnType<typeof createKernel>, depth: Depth, band: Band): string =>
    contributionOf(handle).context!({ sessionId: 's', depth, band })

  it('三档 × 三压力全部是空串（v4 删除了控制读数/卡片/紧档索引）', () => {
    const { handle } = start()
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      for (const band of ['relaxed', 'moderate', 'tight'] as const) {
        expect(render(handle, depth, band), `${depth}/${band} 不应注入`).toBe('')
      }
    }
    handle.dispose()
  })

  it('空注入时状态面如实说"空"，且不再出现已删除的面', () => {
    const { handle } = start()
    render(handle, 'deep', 'relaxed')
    const text = statusText(handle)
    expect(text).toContain('上次注入：空')
    expect(text).toContain('渲染时压力 relaxed')
    expect(text).toContain('现读')
    for (const banned of ['请求 R', '规则卡', '验证', '控制读数', '卡片']) {
      expect(text.includes(banned), `状态面仍出现"${banned}"`).toBe(false)
    }
    handle.dispose()
  })

  it('显式档位（/omb-depth 写内核）不改变注入，只进状态面', () => {
    const { handle } = start()
    handle.kernel.emit('focus/changed', { sessionId: 's', depth: 'deep', reason: '用户命令 /omb-depth' })
    expect(render(handle, 'deep', 'relaxed')).toBe('')
    expect(statusText(handle)).toContain('深度 deep')
    expect(statusText(handle)).toContain('/omb-depth')
    handle.dispose()
  })
})

describe('循环检测：callId 配对 / 代际分区 / 迟滞', () => {
  type EvidencePayload = {
    sessionId: string
    actionHash: string
    evidenceHash: string
    at: number
    callId?: string
    tool?: string
    generation?: number
  }
  const emit = (handle: ReturnType<typeof createKernel>, payload: EvidencePayload): void => {
    handle.kernel.emit('evidence/observed', payload)
  }
  const render = (handle: ReturnType<typeof createKernel>): string =>
    contributionOf(handle).context!({ sessionId: 's', depth: 'standard', band: 'relaxed' })

  it('并发调用：call 先成批到、result 乱序到，仍按 callId 各自配对（不误报循环）', () => {
    const { handle } = start()
    emit(handle, { sessionId: 's', actionHash: 'call-A', evidenceHash: '', at: 1, callId: 'c1', tool: 'read' })
    emit(handle, { sessionId: 's', actionHash: 'call-B', evidenceHash: '', at: 2, callId: 'c2', tool: 'grep' })
    emit(handle, { sessionId: 's', actionHash: '', evidenceHash: 'res-B', at: 3, callId: 'c2', tool: 'grep' })
    emit(handle, { sessionId: 's', actionHash: '', evidenceHash: 'res-A', at: 4, callId: 'c1', tool: 'read' })
    const window = loopOf(handle).window('s')
    expect(window).toHaveLength(2)
    expect(window[0]).toMatchObject({ actionHash: 'call-A', callId: 'c1', evidenceHash: 'res-A' })
    expect(window[1]).toMatchObject({ actionHash: 'call-B', callId: 'c2', evidenceHash: 'res-B' })
    expect(loopOf(handle).signal('s')).toBeNull()
    expect(render(handle)).toBe('')
    handle.dispose()
  })

  it('surface 代际变化（压缩/替换）：旧窗口整段丢弃，压缩后不沿用', () => {
    const { handle } = start()
    for (const action of ['a', 'b', 'c']) {
      emit(handle, { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1, generation: 0 })
    }
    expect(loopOf(handle).signal('s')?.kind).toBe('no-new-evidence')
    emit(handle, { sessionId: 's', actionHash: 'x', evidenceHash: 'new', at: 2, generation: 1 })
    expect(loopOf(handle).window('s')).toHaveLength(1)
    expect(loopOf(handle).signal('s')).toBeNull()
    expect(render(handle)).toBe('')
    handle.dispose()
  })

  it('无进展信号：注入一行循环提示 + 出口段；每段 ≤120，循环提示 ≤80', () => {
    const { handle } = start()
    for (const action of ['a', 'b', 'c']) {
      emit(handle, { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    expect(loopOf(handle).signal('s')?.kind).toBe('no-new-evidence')
    const text = render(handle)
    expect(text).toContain('（检测到循环）')
    expect(text).toContain('三个合法出口')
    const segments = text.split('\n')
    expect(segments.length).toBe(2)
    for (const segment of segments) {
      expect(segment.length, `注入段过长：${segment}`).toBeLessThanOrEqual(120)
    }
    expect(segments[0]!.length).toBeLessThanOrEqual(LOOP_HINT_MAX + 8)
    expect(segments[1]!.length).toBeLessThanOrEqual(EXIT_SEGMENT_MAX)
    // 台账：状态面报得出真的进了什么
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderChars).toBe(text.length)
    expect(handle.health()[MODULE_ID]?.metrics?.lastRenderExitChars).toBeGreaterThan(0)
    expect(statusText(handle)).toContain('循环提示+出口段')
    expect(statusText(handle)).toMatch(/出口段 [1-9]\d* 字符/)
    handle.dispose()
  })

  it('repeat-action：提示里带工具名（有则带），且不叠出口段', () => {
    const { handle } = start()
    emit(handle, { sessionId: 's', actionHash: 'A', evidenceHash: 'e', at: 1, tool: 'read' })
    emit(handle, { sessionId: 's', actionHash: 'A', evidenceHash: 'e', at: 2, tool: 'read' })
    expect(loopOf(handle).signal('s')?.kind).toBe('repeat-action')
    const text = render(handle)
    expect(text).toContain('（read）')
    expect(text).toContain('刚做过')
    expect(text).not.toContain('三个合法出口')
    expect(text.split('\n')).toHaveLength(1)
    expect(text.length).toBeLessThanOrEqual(120)
    handle.dispose()
  })

  it('注入迟滞：信号持续时只在首次注入；越过冷却 tick 才重报', () => {
    const { handle } = start()
    handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
    for (const action of ['a', 'b', 'c']) {
      emit(handle, { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    const renderNext = (): string => {
      handle.kernel.emit('turn/start', { sessionId: 's', turn: 1 })
      return render(handle)
    }
    expect(renderNext()).toContain('（检测到循环）')
    for (let index = 0; index < LOOP_HYSTERESIS_STEPS - 1; index += 1) {
      expect(renderNext()).toBe('')
    }
    expect(renderNext()).toContain('（检测到循环）')
    handle.dispose()
  })
})

describe('状态诚实：采样 vs 现读；失败留声', () => {
  it('测量可用时同屏写"渲染时压力/采样/现读"，数值来自 kernel.pressure', () => {
    const handle = createKernel({
      measure: () => ({
        totalTokens: 500,
        fillRatio: 0.5,
        band: 'relaxed',
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        nodes: [],
      }),
    })
    expect(handle.start([KERNEL_STUB, createReasoningModule()])).toEqual([])
    contributionOf(handle).context!({ sessionId: 's', depth: 'standard', band: 'moderate' })
    const status = statusText(handle)
    expect(status).toContain('渲染时压力 moderate')
    expect(status).toContain('采样 500/1000')
    expect(status).toContain('现读 moderate 500/1000')
    expect(status).toMatch(/采样于 \d{4}-\d{2}-\d{2}T/)
    handle.dispose()
  })

  it('未测量时明说"未测量"，不把 0 当读数', () => {
    const { handle } = start()
    contributionOf(handle).context!({ sessionId: 's', depth: 'deep', band: 'relaxed' })
    expect(statusText(handle)).toContain('现读 未测量（总 0）')
    handle.dispose()
  })

  it('还没渲染过时如实说"尚无"', () => {
    const { handle } = start()
    expect(statusText(handle)).toContain('上次注入：尚无')
    handle.dispose()
  })

  it('渲染抛异常：不外抛，但失败次数与原因进状态面与健康面', () => {
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
    expect(health?.metrics?.renderFailures).toBe(2)
    handle.dispose()
  })
})

describe('会话状态：reset 只清窗口 / LRU 上界', () => {
  it('reset 只清循环窗口与迟滞，不碰显式档位', () => {
    const { handle } = start()
    handle.kernel.emit('focus/changed', { sessionId: 's', depth: 'quick', reason: '用户命令 /omb-depth' })
    for (const action of ['a', 'b', 'c']) {
      handle.kernel.emit('evidence/observed', { sessionId: 's', actionHash: action, evidenceHash: 'same', at: 1 })
    }
    expect(loopOf(handle).window('s')).toHaveLength(3)
    loopOf(handle).reset('s')
    expect(loopOf(handle).window('s')).toEqual([])
    expect(loopOf(handle).signal('s')).toBeNull()
    expect(statusText(handle)).toContain('深度 quick')
    handle.dispose()
  })

  it('会话表 LRU 上界：超过 128 个会话淘汰最久未活动的那个', () => {
    const { handle } = start()
    for (let index = 0; index < MAX_TRACKED_SESSIONS + 5; index += 1) {
      handle.kernel.emit('evidence/observed', {
        sessionId: `s${index}`,
        actionHash: 'a',
        evidenceHash: 'e',
        at: 1,
      })
    }
    expect(handle.health()[MODULE_ID]?.metrics?.trackedSessions).toBe(MAX_TRACKED_SESSIONS)
    expect(loopOf(handle).window('s0')).toEqual([])
    expect(loopOf(handle).window(`s${MAX_TRACKED_SESSIONS + 4}`)).toHaveLength(1)
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
    expect(kernel.service(SERVICES.reasoningLoop)).toBeUndefined()
    expect(kernel.service(toolsServiceFor(MODULE_ID))).toBeUndefined()
    expect(handle.statusNames()).not.toContain('思维链质量（omb-reasoning）')
    expect(() => handle.dispose()).not.toThrow()
  })

  it('两个实例互不干扰（窗口不共享）', () => {
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
