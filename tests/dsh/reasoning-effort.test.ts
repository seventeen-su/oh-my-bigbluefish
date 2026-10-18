/**
 * `/omb-depth` 与真实 effort 映射的行为测试。
 *
 * 这正是审计 S-01 指出的"纯函数 100% 绿、生产零生效"的缺口：
 * 必须断言**请求头真的被改写**，而不是只测 `effortForDepth`。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../kernel/index.js'
import { registerDepthCommand } from '../../dsh/depth-command.js'
import { effortForDepth, wireReasoningEffort } from '../../dsh/reasoning-effort.js'

interface RegisterShape {
  definitionId: string
  name: string
  input?: { hint: string }
  handler: (invocation: { rawInput?: unknown; agent?: unknown }) => unknown
}

function fakeCommands(): { commands: { register(def: RegisterShape): () => void }; last(): RegisterShape | undefined } {
  let captured: RegisterShape | undefined
  return {
    commands: {
      register(def: RegisterShape) {
        captured = def
        return () => {}
      },
    },
    last: () => captured,
  }
}

describe('/omb-depth 命令', () => {
  it('注册命令并写入内核 focus（quick/deep/standard）', () => {
    const handle = createKernel()
    const fake = fakeCommands()
    const dispose = registerDepthCommand({
      ctx: { get: name => name === 'commands' ? fake.commands : undefined },
      kernel: handle.kernel,
      logger: handle.kernel.logger,
    })
    const def = fake.last()
    expect(def?.name).toBe('omb-depth')
    expect(def?.input?.hint).toContain('quick')

    expect(def?.handler({ rawInput: 'quick', agent: { id: 's1' } })).toMatchObject({ kind: 'success' })
    expect(handle.kernel.focus('s1')).toBe('quick')
    def?.handler({ rawInput: 'deep', agent: { id: 's1' } })
    expect(handle.kernel.focus('s1')).toBe('deep')
    def?.handler({ rawInput: 'standard', agent: { id: 's1' } })
    expect(handle.kernel.focus('s1')).toBe('standard')
    expect(def?.handler({ rawInput: 'bogus', agent: { id: 's1' } })).toMatchObject({ kind: 'error' })
    dispose()
    handle.dispose()
  })

  it('拿不到会话时拒绝改档，而不是拿别的会话顶替', () => {
    const handle = createKernel()
    const fake = fakeCommands()
    registerDepthCommand({
      ctx: { get: name => name === 'commands' ? fake.commands : undefined },
      kernel: handle.kernel,
      logger: handle.kernel.logger,
    })
    expect(fake.last()?.handler({ rawInput: 'deep' })).toMatchObject({ kind: 'error' })
    handle.dispose()
  })
})

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
