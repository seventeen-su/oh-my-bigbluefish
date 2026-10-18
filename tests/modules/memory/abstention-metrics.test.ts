/**
 * 3.7-M4：弃权分档进入健康面 metrics。
 *
 * 旧账本只有 `abstentions` 总数；分档后健康面必须能回答
 * "这 3 次弃权里，几次是没有依据、几次是来源缺失/核对不过"。
 */
import { describe, expect, it } from 'vitest'
import type { ContextPressure, Kernel, ModuleHealth, ToolDefinition } from '../../../kernel/abi/index.js'
import { toolsServiceFor } from '../../../kernel/abi/index.js'
import { MODULE_ID, createMemoryRegistration, memoryConfigSchema } from '../../../modules/memory/index.js'
import { toolCallContext } from '../../../kernel/sessionRuntime.js'
import { capturingLogger, fixedClock } from './helpers.js'

interface FakeKernel {
  readonly kernel: Kernel
  readonly services: Map<string, unknown>
}

function fakeKernel(): FakeKernel {
  const services = new Map<string, unknown>()
  const pressure: ContextPressure = {
    totalTokens: 0,
    fillRatio: null,
    band: 'relaxed',
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    nodes: [],
  }
  const kernel: Kernel = {
    provide: <T,>(name: string, service: T) => {
      services.set(name, service)
      return () => {
        if (services.get(name) === service) services.delete(name)
      }
    },
    service: <T,>(name: string) => services.get(name) as T | undefined,
    services: () => [...services.keys()].sort(),
    emit: () => {},
    on: () => () => {},
    budget: () => undefined,
    report: (_health: ModuleHealth) => {},
    pressure: () => pressure,
    focus: () => 'standard',
    setFocus: () => {},
    logger: capturingLogger(),
    clock: fixedClock(),
  }
  return { kernel, services }
}

async function runRemember(services: Map<string, unknown>, text: string): Promise<void> {
  const tools = services.get(toolsServiceFor(MODULE_ID)) as readonly ToolDefinition[] | undefined
  expect(tools, 'apply 必须注册 tools:omb-memory').toBeDefined()
  const remember = tools?.find(tool => tool.name === 'omb_remember')
  expect(remember).toBeDefined()
  await remember?.execute(
    { text, kind: 'semantic' },
    toolCallContext({ sessionId: 's1', callId: 'call-1' }),
  )
}

describe('弃权分档进入健康面（3.7-M4）', () => {
  it('没有准入依据 → metrics.abstentions.no-ground；来源缺失 → metrics.abstentions.missing-source', async () => {
    const handle = fakeKernel()
    const registration = createMemoryRegistration()
    registration.apply(handle.kernel, memoryConfigSchema.parse({}))

    await runRemember(handle.services, '用户大概是个喜欢安静的人吧。') // 模糊印象 → no-ground
    // 没有会话归属时默认 sourceRef 生成不出来 → missing-source
    const tools = handle.services.get(toolsServiceFor(MODULE_ID)) as readonly ToolDefinition[]
    await tools.find(tool => tool.name === 'omb_remember')?.execute({ text: '一条没有来源的陈述。', kind: 'semantic' })

    const health = await registration.manifest.health()
    expect(health.metrics?.['abstentions']).toBe(2)
    expect(health.metrics?.['abstentions.no-ground']).toBe(1)
    expect(health.metrics?.['abstentions.missing-source']).toBe(1)
  })

  it('没有弃权时不出现分档键（不印假 0）', async () => {
    const handle = fakeKernel()
    const registration = createMemoryRegistration()
    registration.apply(handle.kernel, memoryConfigSchema.parse({}))
    const health = await registration.manifest.health()
    expect(health.metrics?.['abstentions']).toBe(0) // 总数是既有字段（0 是测到的 0）
    expect(health.metrics?.['abstentions.no-ground']).toBeUndefined()
  })
})
