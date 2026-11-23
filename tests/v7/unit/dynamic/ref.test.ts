import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver, MAX_REFERENCE_DEPTH } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import type { DynamicSpec } from '../../../../packages/v7/src/domain/entity.js'
import type { JsonValue } from '../../../../packages/v7/src/domain/json.js'
import { FakeContext, expectOmbError } from './helpers.js'

const resolver = new DefaultDynamicResolver()

function nested(spec: DynamicSpec): JsonValue {
  return { $dynamic: spec } as unknown as JsonValue
}

describe('ref 动态值', () => {
  it('给定 ref 当属性存在则返回该属性值', async () => {
    const context = new FakeContext({ attributes: { mem_a: { summary: '结论' } } })
    const value = await resolver.resolve({ kind: 'ref', entityId: 'mem_a', attr: 'summary' }, context)
    expect(value).toBe('结论')
  })

  it('给定 ref 省略 attr 则取整个实体的属性集合', async () => {
    const context = new FakeContext({ attributes: { mem_a: { '': { summary: '结论', tag: ['x'] } } } })
    const value = await resolver.resolve({ kind: 'ref', entityId: 'mem_a' }, context)
    expect(value).toEqual({ summary: '结论', tag: ['x'] })
    expect(context.attributeCalls).toEqual([{ entityId: 'mem_a' }])
  })

  it('给定 ref 缺失且有 fallback 则返回 fallback', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve({ kind: 'ref', entityId: 'mem_a', attr: 'x', fallback: '默认' }, context)
    expect(value).toBe('默认')
  })

  it('给定 ref 缺失且无 fallback 则返回 undefined', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve({ kind: 'ref', entityId: 'mem_a', attr: 'x' }, context)
    expect(value).toBeUndefined()
  })

  it('给定属性值本身是动态 ref 则递归解析', async () => {
    const context = new FakeContext({
      attributes: {
        mem_a: { x: nested({ kind: 'ref', entityId: 'mem_b', attr: 'y' }) },
        mem_b: { y: 7 },
      },
    })
    const value = await resolver.resolve({ kind: 'ref', entityId: 'mem_a', attr: 'x' }, context)
    expect(value).toBe(7)
  })

  it('给定自引用则报 reference-cycle 且不挂死', async () => {
    const context = new FakeContext({
      attributes: { mem_a: { x: nested({ kind: 'ref', entityId: 'mem_a', attr: 'x' }) } },
    })
    await expectOmbError(
      resolver.resolve({ kind: 'ref', entityId: 'mem_a', attr: 'x' }, context),
      'reference-cycle',
      /循环引用/,
    )
  })

  it('给定两个实体互引则报 reference-cycle', async () => {
    const context = new FakeContext({
      attributes: {
        mem_a: { x: nested({ kind: 'ref', entityId: 'mem_b', attr: 'y' }) },
        mem_b: { y: nested({ kind: 'ref', entityId: 'mem_a', attr: 'x' }) },
      },
    })
    await expectOmbError(
      resolver.resolve({ kind: 'ref', entityId: 'mem_a', attr: 'x' }, context),
      'reference-cycle',
      /循环引用/,
    )
  })

  it('给定嵌套层级不超过 8 则正常返回', async () => {
    const context = chainContext(6)
    const value = await resolver.resolve({ kind: 'ref', entityId: 'mem_0', attr: 'x' }, context)
    expect(value).toBe('end')
  })

  it('给定嵌套超过 8 层则报 reference-cycle（深度上限）', async () => {
    const context = chainContext(MAX_REFERENCE_DEPTH + 2)
    await expectOmbError(
      resolver.resolve({ kind: 'ref', entityId: 'mem_0', attr: 'x' }, context),
      'reference-cycle',
      /深度超过 8 层/,
    )
  })

  it('给定上下文抛错则包成 OmbFailure', async () => {
    const context = new FakeContext()
    const failing = new Proxy(context, {
      get(target, property, receiver) {
        if (property === 'getAttribute') return async () => Promise.reject(new Error('db down'))
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    await expectOmbError(resolver.resolve({ kind: 'ref', entityId: 'mem_a', attr: 'x' }, failing), 'internal', /db down/)
  })
})

function chainContext(levels: number): FakeContext {
  const attributes: Record<string, Record<string, JsonValue | undefined>> = {}
  for (let index = 0; index < levels; index += 1) {
    attributes[`mem_${index}`] = { x: nested({ kind: 'ref', entityId: `mem_${index + 1}`, attr: 'x' }) }
  }
  attributes[`mem_${levels}`] = { x: 'end' }
  return new FakeContext({ attributes })
}
