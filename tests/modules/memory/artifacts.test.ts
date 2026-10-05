/**
 * 工件核验的**代价**与**降级可见性**（M6）。
 *
 * 核心判据：同一个 cwd 在复用窗口内，`execFileSync` **最多被调用 1 次**——成功或失败都一样。
 *
 * 修复前为什么失败：`indexOf` 只有 `files.size > 0` 才写缓存；`files.size === 0` 与
 * `catch` 两条失败路径都直接 `return undefined`。于是非 git 工作目录（或 git 不在 PATH）下，
 * **每核验一次就同步 spawn 一次 `git ls-files` 并等它失败**——Windows 每次进程创建几十毫秒，
 * 最坏撞 4 秒超时，期间整个宿主进程（含 GUI 与其它会话）都停住；
 * 而失败被吞成 `undefined`，状态面/健康面零读数，没人知道卡在工件核验上。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `vi.hoisted` 而不是普通 `const`：`vi.mock` 会被提升到 import 之前，
 * 工厂函数在模块首次加载时就要求这个 `vi.fn()` 已初始化（否则 TDZ 报错）。
 */
const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync }))

import {
  INDEX_REUSE_WINDOW,
  artifactVerificationDegradeReason,
  clearArtifactIndexCache,
  verifyArtifactExists,
} from '../../../modules/memory/artifacts.js'

const TEMP_DIRS: string[] = []

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omb-artifacts-'))
  TEMP_DIRS.push(dir)
  return dir
}

/** `execFileSync` 的失败形状（`status` = 退出码；`code` = spawn 层错误）。 */
function throwGitError(options: { readonly status?: number; readonly code?: string }): never {
  const error = new Error('Command failed: git ls-files') as Error & { status?: number; code?: string }
  if (options.status !== undefined) error.status = options.status
  if (options.code !== undefined) error.code = options.code
  throw error
}

beforeEach(() => {
  execFileSync.mockReset()
  clearArtifactIndexCache()
})

describe('工件核验：git 索引的**负结果**也必须缓存', () => {
  it('非 git 目录（退出码 128）：同一 cwd 连核 10 次只 spawn 一次，每次都返回 undefined', () => {
    const cwd = tempDir()
    execFileSync.mockImplementation(() => throwGitError({ status: 128 }))

    for (let i = 0; i < 10; i += 1) {
      expect(verifyArtifactExists('modules/memory/remember.ts', cwd)).toBeUndefined()
    }
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(artifactVerificationDegradeReason()).toContain('不是 git 仓库')
  })

  it('git 不可执行（ENOENT）：同样只 spawn 一次，原因说得出是 PATH 的问题', () => {
    const cwd = tempDir()
    execFileSync.mockImplementation(() => throwGitError({ code: 'ENOENT' }))

    expect(verifyArtifactExists('a.ts', cwd)).toBeUndefined()
    expect(verifyArtifactExists('b.ts', cwd)).toBeUndefined()
    expect(verifyArtifactExists('c.ts', cwd)).toBeUndefined()
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(artifactVerificationDegradeReason()).toContain('git 不可执行')
  })

  it('超时（SIGTERM）：只有第一次真的等它，之后走缓存', () => {
    const cwd = tempDir()
    execFileSync.mockImplementation(() => throwGitError({ code: 'ETIMEDOUT' }))

    for (let i = 0; i < 5; i += 1) verifyArtifactExists('a.ts', cwd)
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(artifactVerificationDegradeReason()).toContain('超时')
  })

  it('空索引 ≠ 文件不存在：缓存空结果、返回 undefined，原因写明索引为空', () => {
    const cwd = tempDir()
    execFileSync.mockReturnValue('')

    for (let i = 0; i < 5; i += 1) expect(verifyArtifactExists('a.ts', cwd)).toBeUndefined()
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(artifactVerificationDegradeReason()).toContain('索引为空')
  })

  it('正对照：git 可用时也只 spawn 一次，精确/后缀/不存在的判定照旧，降级原因复位', () => {
    const cwd = tempDir()
    execFileSync.mockReturnValue('modules/memory/remember.ts\nsrc/b.ts\n')

    for (let i = 0; i < 10; i += 1) {
      expect(verifyArtifactExists('modules/memory/remember.ts', cwd)).toBe(true)
    }
    expect(verifyArtifactExists('remember.ts', cwd)).toBe(true) // 裸文件名 → 后缀匹配
    expect(verifyArtifactExists('not-remember.ts', cwd)).toBe(false) // 后缀匹配不许误命中
    expect(verifyArtifactExists('src/b.ts', cwd)).toBe(true)
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(artifactVerificationDegradeReason()).toBeNull()
  })

  it('作用域是**按 cwd** 的：两个目录各取一次索引；负结果不污染另一个目录', () => {
    const gitDir = tempDir()
    const plainDir = tempDir()
    execFileSync.mockImplementation((_file: string, _args: readonly string[], options: { cwd?: string }) =>
      options.cwd === gitDir ? 'x.ts\n' : throwGitError({ status: 128 }),
    )

    expect(verifyArtifactExists('x.ts', gitDir)).toBe(true)
    expect(verifyArtifactExists('x.ts', plainDir)).toBeUndefined()
    expect(verifyArtifactExists('x.ts', gitDir)).toBe(true)
    expect(verifyArtifactExists('x.ts', plainDir)).toBeUndefined()
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  it('负结果不是永久缓存：过了复用窗口会重新取一次索引', () => {
    const cwd = tempDir()
    execFileSync.mockReturnValue('')

    for (let i = 0; i < INDEX_REUSE_WINDOW; i += 1) verifyArtifactExists('a.ts', cwd)
    expect(execFileSync).toHaveBeenCalledTimes(1) // 窗口内一次都不再 spawn

    verifyArtifactExists('a.ts', cwd) // 第 65 次：越过窗口
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  it('绝对路径不问 git（核验不了与"不存在"仍然是两件事）', () => {
    const cwd = tempDir()
    const missing = join(cwd, '不存在.ts')
    expect(verifyArtifactExists(missing, cwd)).toBe(false)
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
