import { describe, expect, it } from 'vitest'
import {
  QuickJsSandbox,
  SANDBOX_DEFAULT_CPU_MS,
  SANDBOX_DEFAULT_MEMORY_MB,
  SANDBOX_OUTPUT_BYTES,
} from '../../../../packages/v7/src/adapters/quickjs/index.js'
import type { JsonValue } from '../../../../packages/v7/src/domain/json.js'
import { expectOmbError } from './helpers.js'

const NOW = '2026-11-22T00:00:00.000Z'
const sandbox = new QuickJsSandbox()

function input(attrs: JsonValue = {}, refs: JsonValue = {}): JsonValue {
  return { attrs, refs, now: NOW }
}

describe('QuickJsSandbox 限额与隔离', () => {
  it('固定默认预算：CPU 100ms、内存 16MB、输出 32KB', () => {
    expect(SANDBOX_DEFAULT_CPU_MS).toBe(100)
    expect(SANDBOX_DEFAULT_MEMORY_MB).toBe(16)
    expect(SANDBOX_OUTPUT_BYTES).toBe(32768)
  })

  it('给定单表达式当求值则返回 JSON 值并记录耗时', async () => {
    const result = await sandbox.run('attrs.n * 2', input({ n: 21 }))
    expect(result.value).toBe(42)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('给定对象字面量当求值则返回对象（不退化成 block）', async () => {
    const result = await sandbox.run('({ a: 1, b: [2, 3] })', input())
    expect(result.value).toEqual({ a: 1, b: [2, 3] })
  })

  it('给定表达式带结尾分号则按表达式求值', async () => {
    const result = await sandbox.run('attrs.n * 2;', input({ n: 4 }))
    expect(result.value).toBe(8)
  })

  it('给定语句块当显式 return 则返回对象', async () => {
    const result = await sandbox.run('const total = attrs.a + attrs.b; return { total }', input({ a: 2, b: 3 }))
    expect(result.value).toEqual({ total: 5 })
  })

  it('给定语句块没有 return 则报 sandbox-error 并说明原因', async () => {
    await expectOmbError(sandbox.run('const total = 1 + 1', input()), 'sandbox-error', /输出不是 JSON/)
  })

  it('给定函数作为输出则报 sandbox-error（不是 JSON）', async () => {
    await expectOmbError(sandbox.run('(() => 1)', input()), 'sandbox-error', /输出不是 JSON/)
  })

  it('给定输出超过 32KB 则报 sandbox-error', async () => {
    await expectOmbError(sandbox.run('"x".repeat(40000)', input()), 'sandbox-error', /超过 32768 字节/)
  })

  it('给定多字节字符输出超过 32KB 字节则按字节而非字符数拒绝', async () => {
    await expectOmbError(sandbox.run('"🐟".repeat(9000)', input()), 'sandbox-error', /超过 32768 字节/)
  })

  it('给定死循环当使用默认 CPU 限制则中断为 sandbox-timeout', async () => {
    await expectOmbError(sandbox.run('while (true) {}', input()), 'sandbox-timeout', /100ms/)
  })

  it('给定死循环当显式 timeoutMs 则按显式上限中断', async () => {
    await expectOmbError(sandbox.run('for (;;) {}', input(), { timeoutMs: 20 }), 'sandbox-timeout', /20ms/)
  })

  it('给定显式 throw 则报 sandbox-error 并保留原始消息', async () => {
    await expectOmbError(sandbox.run('throw new Error("boom")', input()), 'sandbox-error', /boom/)
  })

  it('给定未预加载的 ctx.ref 则报 sandbox-error 说明未预加载', async () => {
    await expectOmbError(sandbox.run('ctx.ref("mem_a", "x")', input()), 'sandbox-error', /未预加载/)
  })

  it('给定预加载 refs 则 ctx.ref 只查表返回纯数据', async () => {
    const refs: JsonValue = { mem_a: { x: 10, y: 20 } }
    const result = await sandbox.run('ctx.ref("mem_a", "x") + ctx.ref("mem_a", "y")', input({}, refs))
    expect(result.value).toBe(30)
  })

  it('沙箱只注入 now 等纯数据，不暴露宿主对象', async () => {
    const result = await sandbox.run(
      `({
        now: now,
        process: typeof process,
        require: typeof require,
        console: typeof console,
        fetch: typeof fetch,
        buffer: typeof Buffer,
        timer: typeof setTimeout,
        date: typeof Date,
        json: typeof json,
        text: typeof text,
        math: typeof math
      })`,
      input(),
    )
    expect(result.value).toEqual({
      now: NOW,
      process: 'undefined',
      require: 'undefined',
      console: 'undefined',
      fetch: 'undefined',
      buffer: 'undefined',
      timer: 'undefined',
      date: 'undefined',
      json: 'object',
      text: 'object',
      math: 'object',
    })
  })

  it('给定 import() 则明确拒绝（沙箱没有模块加载器）', async () => {
    await expectOmbError(sandbox.run('import("node:fs")', input()), 'sandbox-error', /禁止使用 import/)
  })

  it('给定字符串里出现 import( 文本则不算模块导入（代码文本分析场景）', async () => {
    const result = await sandbox.run('"import(" + "x"', input())
    expect(result.value).toBe('import(x')
  })

  it('给定 async 代码则 sandbox-error，且沙箱被污染后仍能继续求值', async () => {
    await expectOmbError(sandbox.run('(async () => 1)()', input()), 'sandbox-error', /Promise\/async/)
    const after = await sandbox.run('({ ok: true })', input())
    expect(after.value).toEqual({ ok: true })
  })

  it('给定超内存代码则按显式内存上限终止', async () => {
    await expectOmbError(
      sandbox.run('const list = []; for (let i = 0; i < 100000; i += 1) list.push(new Array(100).fill(i))', input(), {
        memoryMb: 1,
      }),
      'sandbox-error',
      /1MB 内存上限/,
    )
  })

  it('给定非对象输入则报 invalid-input', async () => {
    await expectOmbError(sandbox.run('1 + 1', null), 'invalid-input', /JSON 对象/)
  })

  it('给定空白代码则报 invalid-input', async () => {
    await expectOmbError(sandbox.run('   ', input()), 'invalid-input', /不能为空/)
  })
})
