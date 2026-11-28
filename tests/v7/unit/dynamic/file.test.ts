import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_FILE_BYTES,
  DefaultDynamicResolver,
} from '../../../../packages/v7/src/adapters/dynamic/index.js'
import { resolveFilePath } from '../../../../packages/v7/src/adapters/dynamic/file.js'
import { FakeContext, expectOmbError } from './helpers.js'

let ROOT = ''
const files = new Map<string, string>()

async function put(relative: string, content: string): Promise<string> {
  const absolute = path.resolve(ROOT, relative)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content, 'utf8')
  files.set(absolute, content)
  return absolute
}

function context(overrides: { root?: string; signal?: AbortSignal } = {}): FakeContext {
  return new FakeContext({
    ...(overrides.root === undefined ? { projectRoot: ROOT } : { projectRoot: overrides.root }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    files: Object.fromEntries(files),
  })
}

beforeAll(async () => {
  ROOT = await mkdtemp(path.join(os.tmpdir(), 'omb-v7-file-'))
  await put('a.txt', 'plain')
  await put('notes/a.txt', 'hello\nworld')
  await put('data.json', '{"a":{"b":[10,20]}}')
  await put('bad.json', '{oops')
  await put('log.txt', 'INFO ok\nERROR: disk full')
  await put('big.txt', '0123456789')
  await mkdir(path.resolve(ROOT, 'folder'), { recursive: true })
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('file 动态值', () => {
  it('给定 text 提取则返回文件全文，且只读项目根内的解析路径', async () => {
    const ctx = context()
    const value = await new DefaultDynamicResolver().resolve({ kind: 'file', path: 'notes/a.txt' }, ctx)
    expect(value).toBe('hello\nworld')
    expect(ctx.readFileCalls).toEqual([path.resolve(ROOT, 'notes/a.txt')])
  })

  it('给定未写 extract 则默认按 text 处理', async () => {
    const value = await new DefaultDynamicResolver().resolve({ kind: 'file', path: 'a.txt' }, context())
    expect(value).toBe('plain')
  })

  it('给定 json 提取且带 RFC6901 指针则返回指针处值', async () => {
    const value = await new DefaultDynamicResolver().resolve(
      { kind: 'file', path: 'data.json', extract: { kind: 'json', pointer: '/a/b/1' } },
      context(),
    )
    expect(value).toBe(20)
  })

  it('给定 json 提取且带点号路径则返回该值', async () => {
    const value = await new DefaultDynamicResolver().resolve(
      { kind: 'file', path: 'data.json', extract: { kind: 'json', pointer: 'a.b[0]' } },
      context(),
    )
    expect(value).toBe(10)
  })

  it('给定 json 提取不带指针则返回整个文档', async () => {
    const value = await new DefaultDynamicResolver().resolve(
      { kind: 'file', path: 'data.json', extract: { kind: 'json' } },
      context(),
    )
    expect(value).toEqual({ a: { b: [10, 20] } })
  })

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 JSON 指针未命中则报 not-found', async () => {
    await expectOmbError(
      new DefaultDynamicResolver().resolve(
        { kind: 'file', path: 'data.json', extract: { kind: 'json', pointer: '/b' } },
        context(),
      ),
      'not-found',
      /JSON 路径未命中/,
    )
  })

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定文件不是合法 JSON 则报 invalid-input', async () => {
    await expectOmbError(
      new DefaultDynamicResolver().resolve({ kind: 'file', path: 'bad.json', extract: { kind: 'json' } }, context()),
      'invalid-input',
      /不是合法 JSON/,
    )
  })

  it('给定 regex 提取且指定捕获组则返回捕获内容', async () => {
    const value = await new DefaultDynamicResolver().resolve(
      {
        kind: 'file',
        path: 'log.txt',
        extract: { kind: 'regex', source: 'ERROR: (\\w+)', group: 1, flags: 'i' },
      },
      context(),
    )
    expect(value).toBe('disk')
  })

  it('给定 regex 提取未命中则返回 undefined', async () => {
    const value = await new DefaultDynamicResolver().resolve(
      { kind: 'file', path: 'log.txt', extract: { kind: 'regex', source: 'WARN: (.+)' } },
      context(),
    )
    expect(value).toBeUndefined()
  })

  it('给定 realpath 解析后越过 projectRoot 的符号链接则拒绝且不读文件', async () => {
    const projectRoot = path.resolve(ROOT, 'project')
    const outside = path.resolve(ROOT, '..', 'outside', 'secret.txt')
    const guarded = new DefaultDynamicResolver({
      realpath: async value => (value === projectRoot ? value : outside),
    })
    const ctx = new FakeContext({
      projectRoot,
      files: { [outside]: 'secret' },
    })
    await expectOmbError(guarded.resolve({ kind: 'file', path: 'link.txt' }, ctx), 'invalid-input', /符号链接/)
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定 realpath 解析后仍在根内的符号链接则允许读取目标', async () => {
    const guarded = new DefaultDynamicResolver({
      realpath: async value => (value === ROOT ? ROOT : path.resolve(ROOT, 'notes/a.txt')),
    })
    const value = await guarded.resolve({ kind: 'file', path: 'link.txt' }, context())
    expect(value).toBe('hello\nworld')
  })

  it('给定相对 .. 越界路径则拒绝且不读文件', async () => {
    const ctx = context()
    await expectOmbError(
      new DefaultDynamicResolver().resolve({ kind: 'file', path: '../secret.txt' }, ctx),
      'invalid-input',
      /位于项目根内/,
    )
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定绝对路径越界则拒绝且不读文件', async () => {
    const ctx = context()
    await expectOmbError(
      new DefaultDynamicResolver().resolve({ kind: 'file', path: path.resolve(ROOT, '..', 'secret.txt') }, ctx),
      'invalid-input',
      /位于项目根内/,
    )
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定项目根的兄弟目录（同前缀）则拒绝', async () => {
    const ctx = context()
    await expectOmbError(
      new DefaultDynamicResolver().resolve({ kind: 'file', path: path.resolve(`${ROOT}-other`, 'secret.txt') }, ctx),
      'invalid-input',
      /位于项目根内/,
    )
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定多级 .. 穿越则拒绝', async () => {
    const ctx = context()
    await expectOmbError(
      new DefaultDynamicResolver().resolve({ kind: 'file', path: 'notes/../../secret.txt' }, ctx),
      'invalid-input',
      /位于项目根内/,
    )
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定项目根内的绝对路径则允许读取', async () => {
    const value = await new DefaultDynamicResolver().resolve(
      { kind: 'file', path: path.resolve(ROOT, 'notes/a.txt') },
      context(),
    )
    expect(value).toBe('hello\nworld')
  })

  it('给定包含 NUL 的路径则拒绝且不读文件', async () => {
    const ctx = context()
    await expectOmbError(
      new DefaultDynamicResolver().resolve({ kind: 'file', path: 'notes/a\0.txt' }, ctx),
      'invalid-input',
      /NUL/,
    )
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定上下文没有 projectRoot 则拒绝读取', async () => {
    const ctx = new FakeContext({ files: Object.fromEntries(files) })
    await expectOmbError(new DefaultDynamicResolver().resolve({ kind: 'file', path: 'a.txt' }, ctx), 'invalid-input', /projectRoot/)
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定文件不存在则报 not-found（stat 预检阶段）', async () => {
    const ctx = context()
    await expectOmbError(new DefaultDynamicResolver().resolve({ kind: 'file', path: 'missing.txt' }, ctx), 'not-found', /文件不存在/)
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定文件超过字节上限则在读取前由 stat 拒绝', async () => {
    const ctx = context()
    const small = new DefaultDynamicResolver({ maxFileBytes: 4 })
    await expectOmbError(small.resolve({ kind: 'file', path: 'big.txt' }, ctx), 'invalid-input', /字节上限/)
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定目标是目录则在读取前拒绝', async () => {
    const ctx = context()
    await expectOmbError(
      new DefaultDynamicResolver().resolve({ kind: 'file', path: 'folder' }, ctx),
      'invalid-input',
      /不是普通文件/,
    )
    expect(ctx.readFileCalls).toEqual([])
  })

  it('给定 stat 报告符号链接则拒绝且不读文件', async () => {
    const ctx = context()
    const resolver = new DefaultDynamicResolver({
      statFile: async () => ({ size: 1, isFile: () => true, isSymbolicLink: () => true }),
    })
    await expectOmbError(resolver.resolve({ kind: 'file', path: 'a.txt' }, ctx), 'invalid-input', /符号链接/)
    expect(ctx.readFileCalls).toEqual([])
  })

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 stat 报告的大小未变但实际读到的内容超限则读取后仍拒绝', async () => {
    const resolver = new DefaultDynamicResolver({
      maxFileBytes: 4,
      statFile: async () => ({ size: 1, isFile: () => true, isSymbolicLink: () => false }),
    })
    await expectOmbError(resolver.resolve({ kind: 'file', path: 'big.txt' }, context()), 'invalid-input', /字节上限/)
  })

  it('给定默认文件上限则与 domain 单属性上限一致', () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(256 * 1024)
  })
})

describe('file 路径闸门（纯函数）', () => {
  async function rejected(candidate: string, message: RegExp): Promise<void> {
    await expectOmbError(
      Promise.resolve().then(() => resolveFilePath(ROOT, candidate)),
      'invalid-input',
      message,
    )
  }

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 UNC 网络路径当解析则拒绝', async () => {
    await rejected('\\\\server\\share\\secret.txt', /UNC/)
    await rejected('//server/share/secret.txt', /UNC/)
  })

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 Windows 设备路径当解析则拒绝', async () => {
    await rejected('\\\\?\\C:\\Windows\\System32\\config\\SAM', /设备/)
    await rejected('\\\\.\\PhysicalDrive0', /设备/)
  })

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定盘符相对路径当解析则拒绝', async () => {
    await rejected('C:relative.txt', /盘符/)
  })

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 Windows 保留设备名当解析则拒绝', async () => {
    for (const candidate of ['CON', 'nul.txt', 'notes/AUX', 'com1.log', 'LPT9 ']) {
      await rejected(candidate, /保留设备名/)
    }
  })

  // 断言在 expectOmbError / rejected（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定空路径与 NUL 当解析则拒绝', async () => {
    await rejected('   ', /不能为空/)
    await rejected('a\0b', /NUL/)
  })

  it('给定根内的普通相对路径当解析则返回绝对路径', () => {
    expect(resolveFilePath(ROOT, 'notes/a.txt')).toBe(path.resolve(ROOT, 'notes/a.txt'))
  })
})
