import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import { FakeContext } from './helpers.js'

const resolver = new DefaultDynamicResolver()

describe('template 动态值', () => {
  it('给定 {{name}} 与 as 别名则替换成引用值', async () => {
    const context = new FakeContext({ attributes: { mem_a: { name: '大肥鱼' } } })
    const value = await resolver.resolve(
      { kind: 'template', template: '你好 {{who}}！', refs: [{ entityId: 'mem_a', attr: 'name', as: 'who' }] },
      context,
    )
    expect(value).toBe('你好 大肥鱼！')
  })

  it('给定没有 as 的 ref 则占位符用 entityId', async () => {
    const context = new FakeContext({ attributes: { mem_a: { name: 'v7' } } })
    const value = await resolver.resolve(
      { kind: 'template', template: '版本 {{mem_a}}', refs: [{ entityId: 'mem_a', attr: 'name' }] },
      context,
    )
    expect(value).toBe('版本 v7')
  })

  it('给定占位符没有对应 ref 则原样保留', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve({ kind: 'template', template: '保留 {{unknown}} 占位符' }, context)
    expect(value).toBe('保留 {{unknown}} 占位符')
  })

  it('给定 ref 取不到值则替换为空字符串', async () => {
    const context = new FakeContext()
    const value = await resolver.resolve(
      { kind: 'template', template: '值={{who}}', refs: [{ entityId: 'mem_a', attr: 'name', as: 'who' }] },
      context,
    )
    expect(value).toBe('值=')
  })

  it('给定非字符串引用值则按 JSON 文本替换', async () => {
    const context = new FakeContext({ attributes: { mem_a: { n: 42, obj: { a: 1 } } } })
    const value = await resolver.resolve(
      {
        kind: 'template',
        template: '{{n}}/{{obj}}',
        refs: [
          { entityId: 'mem_a', attr: 'n', as: 'n' },
          { entityId: 'mem_a', attr: 'obj', as: 'obj' },
        ],
      },
      context,
    )
    expect(value).toBe('42/{"a":1}')
  })

  it('给定占位符带空格则按 trim 后匹配', async () => {
    const context = new FakeContext({ attributes: { mem_a: { name: 'ok' } } })
    const value = await resolver.resolve(
      { kind: 'template', template: '[{{ who }}]', refs: [{ entityId: 'mem_a', attr: 'name', as: 'who' }] },
      context,
    )
    expect(value).toBe('[ok]')
  })
})
