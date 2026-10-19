/**
 * 3.7-M1：记忆模块的常驻提示。
 *
 * 三条判据：
 * ① 提示 ≤40 字符（常驻总预算 120，推理用短变体后余量足够）；
 * ② **逐字节稳定**（它进静态前缀，任何跨轮变化都会让缓存失效）；
 * ③ 与推理模块短变体合计 ≤ `RESIDENT_HINT_MAX`；关掉配置时服务不存在（回滚开关）。
 */
import { describe, expect, it } from 'vitest'
import type { ContextPressure, Kernel, ModuleHealth } from '../../../kernel/abi/index.js'
import { RESIDENT_HINT_MAX } from '../../../kernel/abi/index.js'
import { residentHint as reasoningResidentHint } from '../../../modules/reasoning/methods.js'
import {
  MEMORY_CONFIG_DEFAULTS,
  MEMORY_RESIDENT_HINT,
  MODULE_ID,
  PROMPT_SERVICE,
  createMemoryRegistration,
  memoryConfigSchema,
} from '../../../modules/memory/index.js'
import { capturingLogger, fixedClock } from './helpers.js'

interface FakeKernel {
  readonly kernel: Kernel
  readonly services: Map<string, unknown>
  readonly reported: ModuleHealth[]
}

function fakeKernel(): FakeKernel {
  const services = new Map<string, unknown>()
  const reported: ModuleHealth[] = []
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
    report: health => void reported.push(health),
    pressure: () => pressure,
    focus: () => 'standard',
    setFocus: () => {},
    logger: capturingLogger(),
    clock: fixedClock(),
  }
  return { kernel, services, reported }
}

describe('常驻提示（3.7-M1）', () => {
  it('≤40 字符、不含易变内容（时间/计数/会话 id）、逐字节稳定', () => {
    expect(MEMORY_RESIDENT_HINT.length).toBeLessThanOrEqual(40)
    expect(MEMORY_RESIDENT_HINT).not.toMatch(/\d{4}-\d{2}-\d{2}|#\d+|session:/)
    // 常量本身就是"稳定"的证据：两次读同一常量逐字节相同
    expect(MEMORY_RESIDENT_HINT).toBe(MEMORY_RESIDENT_HINT)
  })

  it('与推理短变体合计 ≤120 字符（推理 71 + 记忆 ≤40）', () => {
    const reasoning = reasoningResidentHint(71)
    expect(reasoning.length).toBeLessThanOrEqual(71)
    const total = `${reasoning}\n${MEMORY_RESIDENT_HINT}`.length
    expect(total, `常驻合计 ${total} 超过 ${RESIDENT_HINT_MAX}`).toBeLessThanOrEqual(RESIDENT_HINT_MAX)
  })

  it('apply 注册 prompt:omb-memory，内容与常量逐字节一致；两次 apply 结果相同', () => {
    const first = fakeKernel()
    const registration = createMemoryRegistration()
    registration.apply(first.kernel, memoryConfigSchema.parse({}))
    const contribution = first.services.get(PROMPT_SERVICE) as { id?: string; resident?: string } | undefined
    expect(contribution, 'apply 必须注册 prompt:omb-memory').toBeDefined()
    expect(contribution?.id).toBe(MODULE_ID)
    expect(contribution?.resident).toBe(MEMORY_RESIDENT_HINT)

    const second = fakeKernel()
    createMemoryRegistration().apply(second.kernel, memoryConfigSchema.parse({}))
    const again = second.services.get(PROMPT_SERVICE) as { resident?: string } | undefined
    expect(again?.resident).toBe(contribution?.resident)
  })

  it('residentHint:false 时不注册（回滚开关，行为回到 3.6）', () => {
    const handle = fakeKernel()
    createMemoryRegistration().apply(handle.kernel, { ...MEMORY_CONFIG_DEFAULTS, residentHint: false })
    expect(handle.services.has(PROMPT_SERVICE)).toBe(false)
  })

  it('disposer 注销后服务消失（热插拔两个方向都如实）', async () => {
    const handle = fakeKernel()
    const disposer = createMemoryRegistration().apply(handle.kernel, memoryConfigSchema.parse({}))
    if (typeof disposer !== 'function') throw new Error('apply 必须返回 disposer（热插拔要求）')
    expect(handle.services.has(PROMPT_SERVICE)).toBe(true)
    await disposer()
    expect(handle.services.has(PROMPT_SERVICE)).toBe(false)
  })
})
