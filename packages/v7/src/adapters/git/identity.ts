import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import {
  normalizeGitRemoteUrl,
  type ProjectIdentity,
} from '../../domain/project-identity.js'

/**
 * Git 项目身份解析（适配器层：只有这里碰 git/文件系统）。
 *
 * 分工：
 * - `buildProjectIdentity` 是**纯函数**：输入已解析好的事实，输出 identity；
 *   不跑命令、不读盘，因此 worktree/复制/rename/子模块的语义都能用单测钉住；
 * - `createProjectIdentityResolver` 负责一次性的 git 事实读取与缓存：
 *   同一 cwd 只解析一次（`factsCache`），分支再按「仓库根 + session」解析一次
 *   （`branchCache`）。没有轮询、没有定时器：缓存在这里就是全部真相，
 *   新会话（或显式 `clear()`）才会重新看分支。
 *
 * 取「最近仓库」而不是最外层 root：命令以 cwd 为 `-C` 起点，git 自己会在父目录
 * 里找最近的 `.git`，所以子模块/嵌套仓库解析到自己的仓库根，不会被外层吞并。
 */

const GIT_TIMEOUT_MS = 3_000
const HASH_LENGTH = 16
const DEFAULT_MAX_ENTRIES = 256
const STDOUT_LIMIT = 1_000_000
/**
 * projectId 长度上界：存储与 `scope.projectKey` 校验都是 1024，留足余量。
 * 超长 remote（异常配置）改用 locator 的指纹，保持稳定且不撑爆作用域键。
 */
const MAX_PROJECT_ID_CHARS = 512

const execGit = promisify(execFile)

/** 可注入的 git 执行器：测试用真实 git，也可用替身模拟失败/输出。 */
export type GitCommandRunner = (cwd: string, args: readonly string[]) => Promise<string>

export interface GitRepositoryFacts {
  /** `rev-parse --show-toplevel` 的原始输出（旧 projectKey 的一种写法）。 */
  readonly root: string
  /** `root` 的 realpath（路径锚点）。 */
  readonly realRoot: string
  /** `--git-common-dir` 的规范绝对路径；worktree 之间共享。 */
  readonly commonDir: string
  /** 优先 `origin`，否则按名字排序的第一个 remote。 */
  readonly remoteUrl?: string
}

export interface ProjectFacts {
  /** DSH 提供的 cwd 原文（旧 resolver 在非 git 时把它当 projectKey）。 */
  readonly cwd: string
  /** cwd 的 realpath；非 git 项目的 projectId 基于它。 */
  readonly realCwd: string
  readonly branchId?: string
  readonly git?: GitRepositoryFacts
}

/**
 * 纯函数：由事实决定身份。
 *
 * - 有 remote：`git-remote:<规范化 remote>`，协议/凭据/端口差异被消除；
 *   同一仓库的不同克隆、worktree、磁盘位置得到同一个 projectId。
 * - 无 remote：`git-common:<common dir 指纹>`，worktree 共享 common dir，因此
 *   同一仓库的 worktree 也相同；复制到另一个目录会得到不同指纹（没有 remote
 *   就没有跨副本的稳定锚点，这是显式的已知边界）。
 * - 非 git：`workspace:<realpath 指纹>`，projectId 与 workspaceId 相同。
 */
export function buildProjectIdentity(facts: ProjectFacts): ProjectIdentity {
  const git = facts.git
  if (git === undefined) {
    const workspaceId = workspaceIdOf(facts.realCwd)
    return {
      projectId: workspaceId,
      workspaceId,
      source: 'workspace',
      projectRoot: facts.realCwd,
      workspaceRoot: facts.realCwd,
      legacyProjectKeys: uniqueKeys([facts.cwd, facts.realCwd]),
    }
  }
  const locator = git.remoteUrl === undefined ? undefined : normalizeGitRemoteUrl(git.remoteUrl)
  let projectId: string
  if (locator === undefined) {
    projectId = `git-common:${fingerprint(`git-common\u0000${git.commonDir}`)}`
  } else {
    const remoteId = `git-remote:${locator}`
    projectId = remoteId.length <= MAX_PROJECT_ID_CHARS
      ? remoteId
      : `git-remote-hash:${fingerprint(remoteId)}`
  }
  return {
    projectId,
    workspaceId: workspaceIdOf(git.realRoot),
    repositoryId: projectId,
    ...(facts.branchId === undefined ? {} : { branchId: facts.branchId }),
    source: locator === undefined ? 'git-common' : 'git-remote',
    projectRoot: git.realRoot,
    workspaceRoot: git.realRoot,
    legacyProjectKeys: uniqueKeys([git.root, git.realRoot]),
  }
}

export interface ProjectIdentityResolver {
  /**
   * 解析项目身份；任何失败都退化为 `undefined`，绝不抛（宿主边界）。
   *
   * `sessionId` 只用于分支缓存的粒度：同一 session 内分支视为不变，
   * 新 session 会重新读一次（不轮询）。缺省时按 cwd 缓存。
   */
  resolve(cwd: string | undefined, sessionId?: string): Promise<ProjectIdentity | undefined>
  /** 显式失效（卸载/测试用）。 */
  clear(): void
}

export interface ProjectIdentityResolverOptions {
  readonly runGit?: GitCommandRunner
  /** 两个缓存的上界，防止长进程里 cwd 无限增长。 */
  readonly maxEntries?: number
}

export function createProjectIdentityResolver(options: ProjectIdentityResolverOptions = {}): ProjectIdentityResolver {
  const run: GitCommandRunner = options.runGit ?? ((cwd, args) => runGit(cwd, args))
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES))
  const factsCache = new Map<string, Promise<{ readonly facts: ProjectFacts; readonly gitRoot?: string }>>()
  const branchCache = new Map<string, Promise<string | undefined>>()

  const resolve = async (cwd: string | undefined, sessionId?: string): Promise<ProjectIdentity | undefined> => {
    if (cwd === undefined || cwd.trim().length === 0) return undefined
    try {
      const base = await memoize(factsCache, cwd.trim(), () => readFacts(cwd.trim(), run), maxEntries)
      const gitRoot = base.gitRoot
      if (gitRoot === undefined) return buildProjectIdentity(base.facts)
      const branchKey = `${gitRoot}\u0000${sessionId ?? ''}`
      const branchId = await memoize(branchCache, branchKey, () => readBranch(gitRoot, run), maxEntries)
      return buildProjectIdentity({ ...base.facts, ...(branchId === undefined ? {} : { branchId }) })
    } catch {
      return undefined
    }
  }

  return {
    resolve,
    clear() {
      factsCache.clear()
      branchCache.clear()
    },
  }
}

let sharedResolver: ProjectIdentityResolver | undefined

/**
 * 进程级共享解析器：git 事实（仓库根/common dir/remote）在同一进程里不随插件实例变化，
 * 多个组合根实例（HMR/测试）复用同一份缓存，避免每个实例都重新跑 git。
 * 分支仍按「仓库根 + session」缓存，新会话会重新看一次，不需要轮询。
 */
export function projectIdentityResolver(): ProjectIdentityResolver {
  sharedResolver ??= createProjectIdentityResolver()
  return sharedResolver
}

/** 默认执行器：3s 超时、不弹窗；非零退出由 promisify 转成 reject。 */
async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execGit('git', ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: STDOUT_LIMIT,
  })
  return stdout
}

async function readFacts(cwd: string, run: GitCommandRunner): Promise<{ readonly facts: ProjectFacts; readonly gitRoot?: string }> {
  const realCwd = await safeRealpath(cwd)
  const git = await readGitRepository(cwd, run)
  return {
    facts: { cwd, realCwd, ...(git === undefined ? {} : { git }) },
    ...(git === undefined ? {} : { gitRoot: git.root }),
  }
}

async function readGitRepository(cwd: string, run: GitCommandRunner): Promise<GitRepositoryFacts | undefined> {
  let output: string
  try {
    // 一条命令同时拿两个事实：最近仓库根与共享 common dir。
    // 子模块/嵌套仓库在这里自然解析到「最近的」仓库，而不是最外层。
    output = await run(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  } catch {
    // 非 git 目录、git 不可用、bare 仓库（没有 worktree）都走非 git 退化。
    return undefined
  }
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0)
  const root = lines[0]
  const commonDir = lines[1]
  if (root === undefined || commonDir === undefined) return undefined
  const commonAbsolute = isAbsolute(commonDir) ? commonDir : resolvePath(cwd, commonDir)
  const remoteUrl = await readRemoteUrl(root, run)
  return {
    root,
    realRoot: await safeRealpath(root),
    commonDir: await safeRealpath(commonAbsolute),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  }
}

/**
 * `origin` 优先；没有 origin 时取名字排序后的第一个 remote，保证同一仓库在不同
 * 机器上选到同一个 remote（不依赖 config 文件里的行顺序）。
 */
async function readRemoteUrl(root: string, run: GitCommandRunner): Promise<string | undefined> {
  let output: string
  try {
    output = await run(root, ['config', '--get-regexp', '^remote\\..*\\.url$'])
  } catch {
    return undefined
  }
  const remotes = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = /^remote\.(.+)\.url\s+(.+)$/u.exec(line.trim())
    if (match === null) continue
    const name = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    if (name.length === 0 || value.length === 0 || remotes.has(name)) continue
    remotes.set(name, value)
  }
  const origin = remotes.get('origin')
  if (origin !== undefined) return origin
  const first = [...remotes.keys()].sort()[0]
  return first === undefined ? undefined : remotes.get(first)
}

/** 分支名；detached HEAD 退化为 `detached:<commit>`；unborn 分支仍返回分支名。 */
async function readBranch(root: string, run: GitCommandRunner): Promise<string | undefined> {
  try {
    const branch = (await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    if (branch.length > 0) return branch
  } catch {
    // detached HEAD 或空仓库：落到下面的 commit 探测。
  }
  try {
    const commit = (await run(root, ['rev-parse', 'HEAD'])).trim()
    return commit.length > 0 ? `detached:${commit}` : undefined
  } catch {
    return undefined
  }
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    // 目录可能已被删除（旧 session 的 cwd）：用词法绝对路径继续，不抛。
    return resolvePath(path)
  }
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH)
}

function workspaceIdOf(realRoot: string): string {
  return `workspace:${fingerprint(`workspace\u0000${realRoot}`)}`
}

function uniqueKeys(keys: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const key of keys) {
    const trimmed = key.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/** 单飞缓存：并发调用共享同一次解析；容量有界；失败项不缓存（下次重试）。 */
function memoize<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  load: () => Promise<V>,
  maxEntries: number,
): Promise<V> {
  const existing = cache.get(key)
  if (existing !== undefined) return existing
  const promise = load()
  cache.set(key, promise)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  void promise.catch(() => {
    cache.delete(key)
  })
  return promise
}
