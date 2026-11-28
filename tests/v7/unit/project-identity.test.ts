/**
 * 稳定项目身份（projectId/workspaceId/repositoryId/branchId）的回归锚点。
 *
 * 纯函数部分覆盖 remote 规范化与身份拼装；解析器部分用**真实临时 git 仓库**覆盖
 * 用户实际会遇到的分裂场景：移动磁盘、worktree、复制目录、rename、非 Git、嵌套仓库、
 * 子模块、detached HEAD。断言的是调用者能观察到的身份，不是 git 命令次数以外的实现细节。
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeGitRemoteUrl, type ProjectIdentity } from '../../../packages/v7/src/domain/project-identity.js'
import {
  buildProjectIdentity,
  createProjectIdentityResolver,
  type GitCommandRunner,
} from '../../../packages/v7/src/adapters/git/identity.js'
import { resolveToolContext } from '../../../packages/v7/src/adapters/dsh/tools.js'

const execGit = promisify(execFile)

/** 真实 git：固定提交者身份，避免依赖本机 git config。 */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execGit(
    'git',
    ['-C', cwd, '-c', 'user.email=omb-test@example.invalid', '-c', 'user.name=omb-test', ...args],
    { windowsHide: true, timeout: 15_000 },
  )
  return stdout.trim()
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(path, ['init', '-b', 'main', '--quiet'])
  await git(path, ['commit', '--allow-empty', '-m', 'init', '--quiet'])
}

async function resolveOf(path: string, sessionId = 'session-a'): Promise<ProjectIdentity> {
  const identity = await createProjectIdentityResolver().resolve(path, sessionId)
  if (identity === undefined) throw new Error(`没有解析出身份：${path}`)
  return identity
}

describe('git remote 规范化', () => {
  it('给定 scp 写法当规范化则得到 host/路径', () => {
    expect(normalizeGitRemoteUrl('git@github.com:Org/Repo.git')).toBe('github.com/Org/Repo')
  })

  it('给定 ssh 带端口与 https 带凭据当规范化则得到同一个 locator', () => {
    expect(normalizeGitRemoteUrl('ssh://git@GitHub.com:2222/Org/Repo')).toBe('github.com/Org/Repo')
    expect(normalizeGitRemoteUrl('https://user:pass@github.com/Org/Repo.git/')).toBe('github.com/Org/Repo')
    expect(normalizeGitRemoteUrl('git://github.com/Org/Repo')).toBe('github.com/Org/Repo')
  })

  it('给定本地路径/file URL remote 当规范化则统一为 local: 形式并小写盘符', () => {
    expect(normalizeGitRemoteUrl('D:\\src\\repo.git')).toBe('local:d:/src/repo')
    expect(normalizeGitRemoteUrl('file:///D:/src/repo')).toBe('local:d:/src/repo')
    expect(normalizeGitRemoteUrl('../sibling/repo')).toBe('local:../sibling/repo')
  })

  it('给定 POSIX 绝对路径与 UNC remote 当规范化则保留根前缀，不与相对路径混淆', () => {
    expect(normalizeGitRemoteUrl('/srv/git/repo.git')).toBe('local:/srv/git/repo')
    expect(normalizeGitRemoteUrl('\\\\server\\share\\repo')).toBe('local://server/share/repo')
  })

  it('给定空串或无法识别的写法当规范化则返回 undefined（让调用方退回 common dir 指纹）', () => {
    expect(normalizeGitRemoteUrl('   ')).toBeUndefined()
    expect(normalizeGitRemoteUrl('://weird')).toBeUndefined()
  })
})

describe('身份拼装（纯函数）', () => {
  const gitFacts = {
    cwd: 'D:\\work\\repo',
    realCwd: 'D:\\work\\repo',
    branchId: 'main',
    git: {
      root: 'D:/work/repo',
      realRoot: 'D:\\work\\repo',
      commonDir: 'D:\\work\\repo\\.git',
      remoteUrl: 'git@github.com:Org/Repo.git',
    },
  }

  it('给定有 remote 的仓库当拼装则 projectId/repositoryId 是规范化 remote，路径只作锚点', () => {
    const identity = buildProjectIdentity(gitFacts)

    expect(identity.projectId).toBe('git-remote:github.com/Org/Repo')
    expect(identity.repositoryId).toBe('git-remote:github.com/Org/Repo')
    expect(identity.branchId).toBe('main')
    expect(identity.source).toBe('git-remote')
    expect(identity.projectRoot).toBe('D:\\work\\repo')
    expect(identity.legacyProjectKeys).toEqual(['D:/work/repo', 'D:\\work\\repo'])
  })

  it('给定无 remote 的仓库当拼装则 projectId 是 common dir 指纹，与工作树路径无关', () => {
    const identity = buildProjectIdentity({
      cwd: 'D:\\work\\wt',
      realCwd: 'D:\\work\\wt',
      git: { root: 'D:/work/wt', realRoot: 'D:\\work\\wt', commonDir: 'D:/work/repo.git' },
    })

    expect(identity.projectId).toMatch(/^git-common:[0-9a-f]{16}$/u)
    expect(identity.repositoryId).toBe(identity.projectId)
    expect(identity.source).toBe('git-common')
  })

  it('给定非 Git 目录当拼装则 projectId 就是 workspace 身份，没有仓库/分支', () => {
    const identity = buildProjectIdentity({ cwd: 'D:\\notes', realCwd: 'D:\\notes' })

    expect(identity.projectId).toMatch(/^workspace:[0-9a-f]{16}$/u)
    expect(identity.workspaceId).toBe(identity.projectId)
    expect(identity.repositoryId).toBeUndefined()
    expect(identity.branchId).toBeUndefined()
    expect(identity.source).toBe('workspace')
    expect(identity.legacyProjectKeys).toEqual(['D:\\notes'])
  })
})

describe('身份解析（真实 git 仓库）', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'omb-identity-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('给定子目录 cwd 当解析则提升到仓库根（同一 projectId/workspaceId）', async () => {
    const repo = join(root, 'repo')
    await initRepo(repo)
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:Org/Repo.git'])
    const subdir = join(repo, 'packages', 'v7')
    await mkdir(subdir, { recursive: true })

    const atRoot = await resolveOf(repo)
    const atSubdir = await resolveOf(subdir)

    expect(atSubdir.projectId).toBe('git-remote:github.com/Org/Repo')
    expect(atSubdir.projectId).toBe(atRoot.projectId)
    expect(atSubdir.workspaceId).toBe(atRoot.workspaceId)
    expect(atSubdir.projectRoot).toBe(await realpath(repo))
    expect(atSubdir.branchId).toBe('main')
  })

  it('给定 git worktree 当解析则 projectId 相同、workspaceId 不同、branchId 是 worktree 分支', async () => {
    const repo = join(root, 'repo')
    await initRepo(repo)
    await git(repo, ['remote', 'add', 'origin', 'https://github.com/Org/Repo.git'])
    const worktree = join(root, 'repo-feat')
    await git(repo, ['worktree', 'add', '-b', 'feat/identity', worktree, '--quiet'])

    const mainIdentity = await resolveOf(repo, 'session-main')
    const worktreeIdentity = await resolveOf(worktree, 'session-worktree')

    expect(worktreeIdentity.projectId).toBe(mainIdentity.projectId)
    expect(worktreeIdentity.workspaceId).not.toBe(mainIdentity.workspaceId)
    expect(worktreeIdentity.branchId).toBe('feat/identity')
    expect(mainIdentity.branchId).toBe('main')
  })

  it('给定复制目录且同一 remote 当解析则 projectId 相同、workspaceId 不同', async () => {
    const repo = join(root, 'repo')
    await initRepo(repo)
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:Org/Repo.git'])
    const copy = join(root, 'repo-copy')
    await cp(repo, copy, { recursive: true })

    const original = await resolveOf(repo)
    const duplicated = await resolveOf(copy)

    expect(duplicated.projectId).toBe(original.projectId)
    expect(duplicated.workspaceId).not.toBe(original.workspaceId)
  })

  it('给定目录改名当解析则 projectId 不变（workspaceId 跟随新路径）', async () => {
    const before = join(root, 'before-name')
    await initRepo(before)
    await git(before, ['remote', 'add', 'origin', 'git@github.com:Org/Repo.git'])
    const beforeIdentity = await resolveOf(before)
    const renamed = join(root, 'after-name')
    await rename(before, renamed)

    const moved = await resolveOf(renamed)
    expect(moved.projectId).toBe(beforeIdentity.projectId)
    expect(moved.projectId).toBe('git-remote:github.com/Org/Repo')
    expect(moved.workspaceId).not.toBe(beforeIdentity.workspaceId)
  })

  it('给定无 remote 的仓库与其 worktree 当解析则 projectId 相同（共享 common dir）', async () => {
    const repo = join(root, 'local-only')
    await initRepo(repo)
    const worktree = join(root, 'local-only-wt')
    await git(repo, ['worktree', 'add', '-b', 'wt-branch', worktree, '--quiet'])

    const mainIdentity = await resolveOf(repo, 'session-main')
    const worktreeIdentity = await resolveOf(worktree, 'session-wt')

    expect(mainIdentity.projectId).toMatch(/^git-common:/u)
    expect(worktreeIdentity.projectId).toBe(mainIdentity.projectId)
    expect(worktreeIdentity.workspaceId).not.toBe(mainIdentity.workspaceId)
  })

  it('给定无 remote 仓库的副本当解析则 projectId 不同（没有跨副本锚点，已知边界）', async () => {
    const repo = join(root, 'local-only')
    await initRepo(repo)
    const copy = join(root, 'local-only-copy')
    await cp(repo, copy, { recursive: true })

    const original = await resolveOf(repo)
    const duplicated = await resolveOf(copy)

    expect(original.projectId).toMatch(/^git-common:/u)
    expect(duplicated.projectId).not.toBe(original.projectId)
  })

  it('给定非 Git 目录当解析则 projectId 等于该目录的 workspace 身份', async () => {
    const dir = join(root, 'plain-notes')
    await mkdir(dir, { recursive: true })

    const identity = await resolveOf(dir)

    expect(identity.projectId).toMatch(/^workspace:[0-9a-f]{16}$/u)
    expect(identity.workspaceId).toBe(identity.projectId)
    expect(identity.repositoryId).toBeUndefined()
    expect(identity.branchId).toBeUndefined()
    expect(identity.projectRoot).toBe(await realpath(dir))
    await mkdir(join(root, 'other-notes'), { recursive: true })
    expect((await resolveOf(join(root, 'other-notes'))).projectId).not.toBe(identity.projectId)
  })

  it('给定嵌套仓库当解析则使用最近的仓库，不吞并父仓库', async () => {
    const parent = join(root, 'parent')
    await initRepo(parent)
    await git(parent, ['remote', 'add', 'origin', 'git@github.com:Org/Parent.git'])
    const nested = join(parent, 'vendor', 'nested')
    await initRepo(nested)

    const parentIdentity = await resolveOf(parent)
    const nestedIdentity = await resolveOf(nested)

    expect(parentIdentity.projectId).toBe('git-remote:github.com/Org/Parent')
    expect(nestedIdentity.projectId).toMatch(/^git-common:/u)
    expect(nestedIdentity.projectId).not.toBe(parentIdentity.projectId)
    expect(nestedIdentity.projectRoot).toBe(await realpath(nested))
  })

  it('给定子模块当解析则使用子模块自身仓库身份，projectRoot 是子模块根', async () => {
    const source = join(root, 'sub-source')
    await initRepo(source)
    await writeFile(join(source, 'readme.md'), 'submodule fixture\n')
    await git(source, ['add', 'readme.md'])
    await git(source, ['commit', '-m', 'add readme', '--quiet'])

    const parent = join(root, 'parent-with-sub')
    await initRepo(parent)
    await git(parent, ['remote', 'add', 'origin', 'git@github.com:Org/Parent.git'])
    const sourceUrl = (await realpath(source)).replaceAll('\\', '/')
    await git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', sourceUrl, 'sub'])

    const parentIdentity = await resolveOf(parent)
    const submodule = join(parent, 'sub')
    const submoduleIdentity = await resolveOf(submodule)

    expect(parentIdentity.projectId).toBe('git-remote:github.com/Org/Parent')
    expect(submoduleIdentity.projectId).not.toBe(parentIdentity.projectId)
    expect(submoduleIdentity.projectRoot).toBe(await realpath(submodule))
    expect(submoduleIdentity.repositoryId).toBe(submoduleIdentity.projectId)
  })

  it('给定 detached HEAD 当解析则 branchId 是 detached:<commit>', async () => {
    const repo = join(root, 'detached')
    await initRepo(repo)
    const head = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['checkout', '--detach', '--quiet'])

    const identity = await resolveOf(repo)

    expect(identity.branchId).toBe(`detached:${head}`)
  })

  it('给定 git 不可用当解析则退化为 workspace 身份且不抛', async () => {
    const runner: GitCommandRunner = () => Promise.reject(new Error('git 不可用'))
    const resolver = createProjectIdentityResolver({ runGit: runner })

    const identity = await resolver.resolve(join(root, 'no-git'), 'session-a')

    expect(identity?.source).toBe('workspace')
    expect(identity?.projectId).toMatch(/^workspace:/u)
  })

  it('给定同一 cwd 重复解析当命中缓存则不再执行 git；新会话只重读分支', async () => {
    const repo = join(root, 'cached')
    await initRepo(repo)
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:Org/Repo.git'])
    const calls: string[][] = []
    const runner: GitCommandRunner = (cwd, args) => {
      calls.push([...args])
      return (async () => {
        const { stdout } = await execGit(
          'git',
          ['-C', cwd, '-c', 'user.email=omb-test@example.invalid', '-c', 'user.name=omb-test', ...args],
          { windowsHide: true, timeout: 15_000 },
        )
        return stdout
      })()
    }
    const resolver = createProjectIdentityResolver({ runGit: runner })

    await resolver.resolve(repo, 'session-a')
    const afterFirst = calls.length
    await resolver.resolve(repo, 'session-a')
    expect(calls.length).toBe(afterFirst)

    await resolver.resolve(repo, 'session-b')
    expect(calls.length).toBe(afterFirst + 1)
    expect(calls.at(-1)).toContain('symbolic-ref')
  })
})

describe('工具上下文身份接线', () => {
  it('给定 cwd 在 git 仓库里当解析工具上下文则 projectKey 是 projectId 且带路径锚点', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omb-identity-ctx-'))
    try {
      const repo = join(root, 'repo')
      await initRepo(repo)
      await git(repo, ['remote', 'add', 'origin', 'git@github.com:Org/Repo.git'])
      const exec = { agent: { name: 'lead', session: { id: 'session-ctx', header: { cwd: repo } } } }

      const context = await resolveToolContext(exec, { identity: createProjectIdentityResolver() })

      expect(context?.sessionId).toBe('session-ctx')
      expect(context?.agentPath).toBe('lead')
      expect(context?.projectKey).toBe('git-remote:github.com/Org/Repo')
      expect(context?.projectIdentity?.projectRoot).toBe(await realpath(repo))
      expect(context?.projectIdentity?.branchId).toBe('main')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('给定会话没有 cwd 当解析工具上下文则没有 projectKey/identity（不编造项目）', async () => {
    const context = await resolveToolContext({ agent: { session: { id: 'session-no-cwd' } } })

    expect(context).toEqual({ sessionId: 'session-no-cwd' })
  })
})
