/**
 * 项目根解析端口的行为测试（v4.1 §3.1）。
 *
 * 四条契约：
 * ① git 成功 → 规范化项目根；非 git / 失败 / runner 抛错 → **规范化 cwd**，绝不抛；
 * ② 缓存：TTL 内不再启动子进程，过期后才重新问；上界按最旧淘汰；
 * ③ 空 cwd → `''`（"没有 cwd"，不是进程 cwd）；
 * ④ dispose 后不再跑 git，直接退化为规范化 cwd。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PROJECT_ROOT_TTL_MS,
  createProjectRootResolver,
  type GitRunner,
} from '../../dsh/project-root.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omb-project-root-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响断言
      }
    }
  }
})

/** 假 git：按 cwd 记录调用次数，返回固定 root（undefined = 非 git）。 */
function fakeGit(root: string | undefined, calls: Map<string, number>): GitRunner {
  return (cwd, args) => {
    calls.set(cwd, (calls.get(cwd) ?? 0) + 1)
    expect(args[0], '只应调用 rev-parse').toBe('rev-parse')
    expect(args).toContain('--show-toplevel')
    return root === undefined ? { ok: false, stdout: '' } : { ok: true, stdout: root }
  }
}

describe('项目根解析', () => {
  it('git 成功：子目录 cwd 解析到同一个项目根', () => {
    const root = tempDir()
    const sub = join(root, 'src', 'deep')
    const calls = new Map<string, number>()
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => 1_000 },
      git: fakeGit(root, calls),
    })
    expect(port.resolve(sub)).toBe(resolve(root))
    expect(port.resolve(join(root, 'src'))).toBe(resolve(root))
    dispose()
  })

  it('非 git 目录 / git 失败：返回规范化 cwd，绝不抛', () => {
    const dir = tempDir()
    const calls = new Map<string, number>()
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => 1 },
      git: fakeGit(undefined, calls),
    })
    expect(port.resolve(dir)).toBe(resolve(dir))
    expect(port.resolve(join(dir, 'nested'))).toBe(resolve(join(dir, 'nested')))
    dispose()
  })

  it('注入的 runner 自己抛错时也退化为 cwd', () => {
    const dir = tempDir()
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => 1 },
      git: () => {
        throw new Error('git exploded')
      },
    })
    expect(() => port.resolve(dir)).not.toThrow()
    expect(port.resolve(dir)).toBe(resolve(dir))
    dispose()
  })

  it('相对路径输出不被接受（不会把进程 cwd 当项目根）', () => {
    const dir = tempDir()
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => 1 },
      git: () => ({ ok: true, stdout: 'relative/repo' }),
    })
    expect(port.resolve(dir)).toBe(resolve(dir))
    dispose()
  })

  it('TTL 内命中缓存；过期后才再问 git', () => {
    const root = tempDir()
    const sub = join(root, 'a')
    const key = resolve(sub)
    const calls = new Map<string, number>()
    let now = 5_000
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => now },
      git: fakeGit(root, calls),
      ttlMs: 60_000,
    })
    expect(port.resolve(sub)).toBe(resolve(root))
    expect(calls.get(key)).toBe(1)
    now += 30_000
    expect(port.resolve(sub)).toBe(resolve(root))
    expect(calls.get(key), 'TTL 内不得重复调用 git').toBe(1)
    now += PROJECT_ROOT_TTL_MS
    expect(port.resolve(sub)).toBe(resolve(root))
    expect(calls.get(key), 'TTL 过期后必须重新解析').toBe(2)
    dispose()
  })

  it('缓存上界：超过 maxEntries 时最旧的条目被淘汰', () => {
    const rootA = resolve(tempDir())
    const rootB = resolve(tempDir())
    const rootC = resolve(tempDir())
    const calls = new Map<string, number>()
    const roots = new Set<string>([rootA, rootB, rootC])
    const git: GitRunner = cwd => {
      calls.set(cwd, (calls.get(cwd) ?? 0) + 1)
      return roots.has(cwd) ? { ok: true, stdout: cwd } : { ok: false, stdout: '' }
    }
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => 1 },
      git,
      maxEntries: 2,
    })
    port.resolve(rootA)
    port.resolve(rootB)
    port.resolve(rootC) // A 被淘汰
    expect(calls.get(rootA)).toBe(1)
    port.resolve(rootA)
    expect(calls.get(rootA), '被淘汰的条目必须重新解析').toBe(2)
    dispose()
  })

  it('空 cwd / 空白 cwd 返回空串，不解析进程 cwd', () => {
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => 1 },
      git: () => ({ ok: true, stdout: tempDir() }),
    })
    expect(port.resolve('')).toBe('')
    expect(port.resolve('   ')).toBe('')
    dispose()
  })

  it('dispose 后不再启动 git，且清空缓存', () => {
    const root = tempDir()
    const sub = join(root, 'x')
    const key = resolve(sub)
    const calls = new Map<string, number>()
    const { port, dispose } = createProjectRootResolver({
      clock: { now: () => 1 },
      git: fakeGit(root, calls),
    })
    expect(port.resolve(sub)).toBe(resolve(root))
    dispose()
    expect(port.resolve(sub)).toBe(key)
    expect(calls.get(key), 'dispose 后不得再调用 git').toBe(1)
  })
})
