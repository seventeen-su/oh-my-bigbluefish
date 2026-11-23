import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import { FakeContext, expectOmbError } from './helpers.js'

const resolver = new DefaultDynamicResolver()

describe('regex 动态值', () => {
  it('给定 literal 输入则返回首个匹配（默认 group 0）', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve(
      { kind: 'regex', source: '\\d+', input: { kind: 'literal', value: 'abc123def' } },
      context,
    )
    expect(value).toBe('123')
  })

  it('给定 group 则返回指定捕获组', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve(
      {
        kind: 'regex',
        source: '^(\\w+)-(\\d+)$',
        input: { kind: 'literal', value: 'build-42' },
        group: 2,
      },
      context,
    )
    expect(value).toBe('42')
  })

  it('给定 ref 输入则先解析引用再做匹配', async () => {
    const context = new FakeContext({ attributes: { mem_a: { version: 'v7' } } })
    const value = await resolver.resolve(
      {
        kind: 'regex',
        source: '^v(\\d+)$',
        input: { kind: 'ref', entityId: 'mem_a', attr: 'version' },
        group: 1,
      },
      context,
    )
    expect(value).toBe('7')
  })

  it('给定 ref 输入是数字则按 JSON 文本匹配', async () => {
    const context = new FakeContext({ attributes: { mem_a: { n: 2026 } } })
    const value = await resolver.resolve(
      { kind: 'regex', source: '20\\d\\d', input: { kind: 'ref', entityId: 'mem_a', attr: 'n' } },
      context,
    )
    expect(value).toBe('2026')
  })

  it('给定输入不匹配则返回 undefined', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve(
      { kind: 'regex', source: '^\\d+$', input: { kind: 'literal', value: 'abc' } },
      context,
    )
    expect(value).toBeUndefined()
  })

  it('给定 ref 缺失则返回 undefined 且不匹配', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve(
      { kind: 'regex', source: '.+', input: { kind: 'ref', entityId: 'mem_a', attr: 'missing' } },
      context,
    )
    expect(value).toBeUndefined()
  })

  it('给定捕获组越界则返回 undefined', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve(
      { kind: 'regex', source: 'a(b)', input: { kind: 'literal', value: 'ab' }, group: 5 },
      context,
    )
    expect(value).toBeUndefined()
  })

  it('给定非法正则则报 invalid-input', async () => {
    const context = new FakeContext()
    await expectOmbError(
      resolver.resolve({ kind: 'regex', source: '(', input: { kind: 'literal', value: 'x' } }, context),
      'invalid-input',
      /正则非法/,
    )
  })
})
