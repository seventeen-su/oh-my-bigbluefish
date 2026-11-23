import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver, resolveRawValue } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import type { JsonValue } from '../../../../packages/v7/src/domain/json.js'
import { FakeContext, expectOmbError } from './helpers.js'

const resolver = new DefaultDynamicResolver()

describe('静态值与动态值', () => {
  it('给定静态 JSON 当解析则原样返回且不访问上下文', async () => {
    const context = new FakeContext({ attributes: { mem_a: { x: 'unused' } } })
    const raw: JsonValue = { tag: 'a', items: [1, 'x', null, true] }
    const value = await resolveRawValue(raw, context, resolver)
    expect(value).toEqual(raw)
    expect(context.attributeCalls).toHaveLength(0)
  })

  it('给定静态 null 与 undefined 当解析则分别原样返回', async () => {
    const context = new FakeContext()
    expect(await resolveRawValue(null, context, resolver)).toBeNull()
    expect(await resolveRawValue(undefined, context, resolver)).toBeUndefined()
  })

  it('给定 $dynamic ref 当解析则经上下文取属性值', async () => {
    const context = new FakeContext({ attributes: { mem_a: { summary: 'hello' } } })
    const raw: JsonValue = { $dynamic: { kind: 'ref', entityId: 'mem_a', attr: 'summary' } }
    const value = await resolveRawValue(raw, context, resolver)
    expect(value).toBe('hello')
    expect(context.attributeCalls).toEqual([{ entityId: 'mem_a', attr: 'summary' }])
  })

  it('给定 $dynamic 带额外键则报 invalid-input', async () => {
    const context = new FakeContext()
    const raw: JsonValue = { $dynamic: { kind: 'ref', entityId: 'mem_a', attr: 'x' }, extra: 1 }
    await expectOmbError(resolveRawValue(raw, context, resolver), 'invalid-input', /唯一的键/)
  })

  it('给定非 JSON 原始值则报 invalid-input', async () => {
    const context = new FakeContext()
    const raw = (() => 1) as unknown as JsonValue
    await expectOmbError(resolveRawValue(raw, context, resolver), 'invalid-input', /必须是 JSON/)
  })
})
