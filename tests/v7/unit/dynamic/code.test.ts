import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import type { DynamicSpec } from '../../../../packages/v7/src/domain/entity.js'
import type { JsonValue } from '../../../../packages/v7/src/domain/json.js'
import type { CodeSandbox } from '../../../../packages/v7/src/ports/dynamic.js'
import { FakeContext, expectOmbError } from './helpers.js'

const NOW = '2026-11-22T00:00:00.000Z'
const resolver = new DefaultDynamicResolver()

describe('code 动态值', () => {
  it('给定注入替身沙箱则透传预加载 refs、now 与超时/内存选项', async () => {
    const calls: Array<{ source: string; input: JsonValue; options?: { timeoutMs?: number; memoryMb?: number } }> = []
    const fakeSandbox: CodeSandbox = {
      async run(source, input, options) {
        calls.push(options === undefined ? { source, input } : { source, input, options })
        return { value: 'from-sandbox', durationMs: 3 }
      },
    }
    const injected = new DefaultDynamicResolver({ sandbox: fakeSandbox })
    const context = new FakeContext({ now: NOW, attributes: { mem_a: { x: 21 } } })
    const value = await injected.resolve(
      { kind: 'code', source: 'ctx.ref("mem_a", "x") * 2', timeoutMs: 50, memoryMb: 8 },
      context,
    )
    expect(value).toBe('from-sandbox')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ refs: { mem_a: { x: 21 } }, attrs: {}, now: NOW })
    expect(calls[0]?.options).toEqual({ timeoutMs: 50, memoryMb: 8 })
  })

  it('给定预扫描 ref 与真实沙箱则正确求值', async () => {
    const context = new FakeContext({ now: NOW, attributes: { mem_a: { x: 21 } } })
    const value = await resolver.resolve({ kind: 'code', source: 'ctx.ref("mem_a", "x") * 2' }, context)
    expect(value).toBe(42)
  })

  it('给定语句块与 return 则在沙箱里返回对象', async () => {
    const context = new FakeContext({ now: NOW, attributes: { mem_a: { n: 3 } } })
    const value = await resolver.resolve(
      { kind: 'code', source: 'const n = ctx.ref("mem_a", "n"); return { n: n, double: n * 2 }' },
      context,
    )
    expect(value).toEqual({ n: 3, double: 6 })
  })

  it('给定死循环且显式 timeoutMs 则报 sandbox-timeout', async () => {
    await expectOmbError(
      resolver.resolve({ kind: 'code', source: 'while (true) {}', timeoutMs: 20 }, new FakeContext({ now: NOW })),
      'sandbox-timeout',
      /20ms/,
    )
  })

  it('给定死循环且无 timeoutMs 则按默认 100ms 中断', async () => {
    await expectOmbError(
      resolver.resolve({ kind: 'code', source: 'while (true) {}' }, new FakeContext({ now: NOW })),
      'sandbox-timeout',
      /100ms/,
    )
  })

  it('给定输出不是 JSON 则报 sandbox-error', async () => {
    await expectOmbError(
      resolver.resolve({ kind: 'code', source: '(() => 1)' }, new FakeContext({ now: NOW })),
      'sandbox-error',
      /输出不是 JSON/,
    )
  })

  it('给定代码抛错则报 sandbox-error 并保留消息', async () => {
    await expectOmbError(
      resolver.resolve({ kind: 'code', source: 'throw new Error("boom")' }, new FakeContext({ now: NOW })),
      'sandbox-error',
      /boom/,
    )
  })

  it('给定变量参数的 ctx.ref 则报未预加载（预扫描只支持字面量）', async () => {
    const context = new FakeContext({ now: NOW, attributes: { mem_a: { x: 1 } } })
    await expectOmbError(
      resolver.resolve({ kind: 'code', source: 'const id = "mem_a"; ctx.ref(id, "x")' }, context),
      'sandbox-error',
      /未预加载/,
    )
  })

  it('给定预加载引用又指回同一段代码则报 reference-cycle', async () => {
    const source = 'ctx.ref("mem_a", "x")'
    const nestedCode: JsonValue = { $dynamic: { kind: 'code', source } as unknown as DynamicSpec } as unknown as JsonValue
    const context = new FakeContext({ now: NOW, attributes: { mem_a: { x: nestedCode } } })
    await expectOmbError(resolver.resolve({ kind: 'code', source }, context), 'reference-cycle', /循环引用/)
  })

  it('沙箱代码看不到宿主上下文对象与网络/文件能力', async () => {
    const value = await resolver.resolve(
      {
        kind: 'code',
        source: `({
          context: typeof context,
          process: typeof process,
          require: typeof require,
          fetch: typeof fetch,
          console: typeof console
        })`,
      },
      new FakeContext({ now: NOW }),
    )
    expect(value).toEqual({
      context: 'undefined',
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      console: 'undefined',
    })
  })
})
