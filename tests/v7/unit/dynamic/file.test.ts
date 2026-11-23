import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import { FakeContext, expectOmbError } from './helpers.js'

const ROOT = path.resolve(os.tmpdir(), 'omb-v7-dynamic-root')
const resolver = new DefaultDynamicResolver()

function absolute(relative: string): string {
  return path.resolve(ROOT, relative)
}

describe('file 动态值', () => {
  it('realpath 解析后越过 projectRoot 的符号链接被拒绝', async () => {
    const guarded = new DefaultDynamicResolver({
      realpath: async path => path === 'C:\\project' ? path : 'C:\\outside\\secret.txt',
    })
    const context = new FakeContext({
      projectRoot: 'C:\\project',
      files: { 'C:\\outside\\secret.txt': 'secret' },
    })
    await expectOmbError(
      guarded.resolve({ kind: 'file', path: 'link.txt' }, context),
      'invalid-input',
      /符号链接/,
    )
  })

  it('给定 text 提取则返回文件全文，且只读项目根内的解析路径', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('notes/a.txt')]: 'hello\nworld' } })
    const value = await resolver.resolve({ kind: 'file', path: 'notes/a.txt' }, context)
    expect(value).toBe('hello\nworld')
    expect(context.readFileCalls).toEqual([absolute('notes/a.txt')])
  })

  it('给定未写 extract 则默认按 text 处理', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('a.txt')]: 'plain' } })
    const value = await resolver.resolve({ kind: 'file', path: 'a.txt' }, context)
    expect(value).toBe('plain')
  })

  it('给定 json 提取且带 RFC6901 指针则返回指针处值', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('data.json')]: '{"a":{"b":[10,20]}}' } })
    const value = await resolver.resolve(
      { kind: 'file', path: 'data.json', extract: { kind: 'json', pointer: '/a/b/1' } },
      context,
    )
    expect(value).toBe(20)
  })

  it('给定 json 提取且带点号路径则返回该值', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('data.json')]: '{"a":{"b":[10,20]}}' } })
    const value = await resolver.resolve(
      { kind: 'file', path: 'data.json', extract: { kind: 'json', pointer: 'a.b[0]' } },
      context,
    )
    expect(value).toBe(10)
  })

  it('给定 json 提取不带指针则返回整个文档', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('data.json')]: '{"a":1}' } })
    const value = await resolver.resolve({ kind: 'file', path: 'data.json', extract: { kind: 'json' } }, context)
    expect(value).toEqual({ a: 1 })
  })

  it('给定 JSON 指针未命中则报 not-found', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('data.json')]: '{"a":1}' } })
    await expectOmbError(
      resolver.resolve({ kind: 'file', path: 'data.json', extract: { kind: 'json', pointer: '/b' } }, context),
      'not-found',
      /JSON 路径未命中/,
    )
  })

  it('给定文件不是合法 JSON 则报 invalid-input', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('bad.json')]: '{oops' } })
    await expectOmbError(
      resolver.resolve({ kind: 'file', path: 'bad.json', extract: { kind: 'json' } }, context),
      'invalid-input',
      /不是合法 JSON/,
    )
  })

  it('给定 regex 提取且指定捕获组则返回捕获内容', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('log.txt')]: 'INFO ok\nERROR: disk full' } })
    const value = await resolver.resolve(
      {
        kind: 'file',
        path: 'log.txt',
        extract: { kind: 'regex', source: 'ERROR: (\\w+)', group: 1, flags: 'i' },
      },
      context,
    )
    expect(value).toBe('disk')
  })

  it('给定 regex 提取未命中则返回 undefined', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('log.txt')]: 'nothing here' } })
    const value = await resolver.resolve(
      { kind: 'file', path: 'log.txt', extract: { kind: 'regex', source: 'ERROR: (.+)' } },
      context,
    )
    expect(value).toBeUndefined()
  })

  it('给定相对 .. 越界路径则拒绝且不读文件', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: {} })
    await expectOmbError(
      resolver.resolve({ kind: 'file', path: '../secret.txt' }, context),
      'invalid-input',
      /位于项目根内/,
    )
    expect(context.readFileCalls).toEqual([])
  })

  it('给定绝对路径越界则拒绝且不读文件', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: {} })
    await expectOmbError(
      resolver.resolve({ kind: 'file', path: path.resolve(ROOT, '..', 'secret.txt') }, context),
      'invalid-input',
      /位于项目根内/,
    )
    expect(context.readFileCalls).toEqual([])
  })

  it('给定项目根的兄弟目录（同前缀）则拒绝', async () => {
    const sibling = `${ROOT}-other`
    const context = new FakeContext({ projectRoot: ROOT, files: {} })
    await expectOmbError(
      resolver.resolve({ kind: 'file', path: path.resolve(sibling, 'secret.txt') }, context),
      'invalid-input',
      /位于项目根内/,
    )
    expect(context.readFileCalls).toEqual([])
  })

  it('给定多级 .. 穿越则拒绝', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: {} })
    await expectOmbError(
      resolver.resolve({ kind: 'file', path: 'notes/../../secret.txt' }, context),
      'invalid-input',
      /位于项目根内/,
    )
    expect(context.readFileCalls).toEqual([])
  })

  it('给定项目根内的绝对路径则允许读取', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('notes/a.txt')]: 'abs' } })
    const value = await resolver.resolve({ kind: 'file', path: absolute('notes/a.txt') }, context)
    expect(value).toBe('abs')
  })

  it('给定包含 NUL 的路径则拒绝且不读文件', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: {} })
    await expectOmbError(
      resolver.resolve({ kind: 'file', path: 'notes/a\0.txt' }, context),
      'invalid-input',
      /位于项目根内/,
    )
    expect(context.readFileCalls).toEqual([])
  })

  it('给定上下文没有 projectRoot 则拒绝读取', async () => {
    const context = new FakeContext({ files: { [absolute('a.txt')]: 'x' } })
    await expectOmbError(resolver.resolve({ kind: 'file', path: 'a.txt' }, context), 'invalid-input', /projectRoot/)
    expect(context.readFileCalls).toEqual([])
  })

  it('给定文件不存在则报 not-found', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: {} })
    await expectOmbError(resolver.resolve({ kind: 'file', path: 'missing.txt' }, context), 'not-found', /文件不存在/)
  })

  it('给定文件超过字节上限则报 invalid-input', async () => {
    const context = new FakeContext({ projectRoot: ROOT, files: { [absolute('big.txt')]: '0123456789' } })
    const small = new DefaultDynamicResolver({ maxFileBytes: 4 })
    await expectOmbError(small.resolve({ kind: 'file', path: 'big.txt' }, context), 'invalid-input', /字节上限/)
  })
})
