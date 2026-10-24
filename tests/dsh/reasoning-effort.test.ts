/**
 * 真实 effort 映射的行为测试。
 *
 * v4.20.0 起 `/omb-depth` 命令已删除（深度由设置页 `POST /omb/api/depth`
 * 调 `kernel.setFocus` 提供）。这里直接写内核 focus 表，断言**请求头真的被改写**，
 * 仍覆盖审计 S-01 指出的"纯函数 100% 绿、生产零生效"的缺口。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../kernel/index.js'
import { effortForDepth, wireReasoningEffort } from '../../dsh/reasoning-effort.js'

describe('effort 映射', () => {
  it('只在显式 quick/deep 时改写 request 配置，standard 恢复继承', async () => {
    const handle = createKernel()
    let requestHandler: ((payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<unknown>) | undefined
    const ctx = {
      get: (name: string) => name === 'llm'
        ? { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } }) }
        : undefined,
      on: (event: string, fn: never) => {
        if (event === 'agent/request') requestHandler = fn as never
        return () => {}
      },
    }
    const dispose = wireReasoningEffort({ ctx, kernel: handle.kernel })
    handle.kernel.setFocus('s1', 'quick', 'test')
    const quick = await requestHandler?.(
      { agent: { id: 's1' } },
      async () => ({ provider: 'deepseek', model: 'm', temperature: 0.1 }),
    )
    expect(quick).toMatchObject({ reasoningEffort: 'low', provider: 'deepseek', model: 'm' })

    handle.kernel.setFocus('s1', 'deep', 'test')
    const deep = await requestHandler?.(
      { agent: { id: 's1' } },
      async () => ({ provider: 'deepseek', model: 'm', reasoningEffort: 'low' }),
    )
    expect(deep).toMatchObject({ reasoningEffort: 'max' })

    handle.kernel.setFocus('s1', 'standard', 'test')
    const standard = await requestHandler?.(
      { agent: { id: 's1' } },
      async () => ({ provider: 'deepseek', model: 'm', reasoningEffort: 'max' }),
    )
    expect(standard).not.toHaveProperty('reasoningEffort')

    const service = handle.kernel.service<{ last(id: string): { effort: string | null } | undefined }>('omb:effort-control')
    expect(service?.last('s1')?.effort).toBeNull()
    dispose()
    handle.dispose()
  })

  it('provider 不支持时不改请求头，并留下可读原因', async () => {
    const handle = createKernel()
    let requestHandler: ((payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<unknown>) | undefined
    const ctx = {
      get: (name: string) => name === 'llm'
        ? { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }) }
        : undefined,
      on: (event: string, fn: never) => {
        if (event === 'agent/request') requestHandler = fn as never
        return () => {}
      },
    }
    const dispose = wireReasoningEffort({ ctx, kernel: handle.kernel })
    handle.kernel.setFocus('s2', 'quick', 'test')
    const result = await requestHandler?.(
      { agent: { id: 's2' } },
      async () => ({ provider: 'other', model: 'x' }),
    )
    expect(result).not.toHaveProperty('reasoningEffort')
    const service = handle.kernel.service<{ last(id: string): { effort: string | null; reason: string | null } | undefined }>('omb:effort-control')
    expect(service?.last('s2')?.effort).toBeNull()
    expect(service?.last('s2')?.reason).toContain('不支持')
    dispose()
    handle.dispose()
  })

  it('纯映射只对 quick/deep 给出值', () => {
    expect(effortForDepth('quick')).toBe('low')
    expect(effortForDepth('deep')).toBe('max')
    expect(effortForDepth('standard')).toBeUndefined()
  })
})
