/**
 * 项目身份的纯契约：`projectId` / `workspaceId` / `repositoryId` / `branchId` 的语义，
 * 以及 git remote URL 的规范化规则。
 *
 * 为什么需要这层：
 * - 旧实现把 **git root 路径** 直接当 `projectKey`，于是移动磁盘、多个 worktree、
 *   复制成另一分支、目录重命名都会让同一逻辑项目分裂成多个 scope；
 *   子模块/嵌套仓库又可能被外层 root 吞并。
 * - 新实现把「逻辑项目」（projectId）与「具体工作区」（workspaceId）拆开：
 *   记忆按 projectId 共享，workspace/branch 只作为来源与排查信息。
 *
 * 这里只有类型与纯函数（domain 不碰 IO）：git 命令、realpath、指纹哈希在
 * `adapters/git/identity.ts` 里执行，解析出的事实再交给纯函数
 * `buildProjectIdentity` 决定身份。
 */

/** projectId 的推导来源；只用于解释/排查，不参与过滤。 */
export type ProjectIdentitySource = 'git-remote' | 'git-common' | 'workspace'

export interface ProjectIdentity {
  /**
   * 稳定项目身份（记忆共享单位）。
   *
   * - 有 remote 的 git 仓库：`git-remote:<规范化 remote>`，同一仓库的不同克隆/
   *   worktree/磁盘位置相同；
   * - 无 remote 的 git 仓库：`git-common:<common dir 指纹>`，同一仓库的 worktree
   *   共享 common dir，因此也相同；
   * - 非 Git 目录：`workspace:<realpath 指纹>`，与 workspaceId 相同（没有仓库可锚定）。
   */
  readonly projectId: string
  /**
   * 具体工作区身份：本 worktree / 本目录的规范路径指纹。
   * 同一仓库的不同 worktree、复制目录、改名后的目录都不同。
   */
  readonly workspaceId: string
  /**
   * Git 仓库身份。有 remote 时与 projectId 相同；无 remote 时是 common dir 指纹；
   * 非 Git 目录没有仓库身份，因此缺省。
   */
  readonly repositoryId?: string
  /**
   * 当前分支名；detached HEAD 为 `detached:<commit>`。
   * 同一仓库不同分支可区分，但**不参与 scope**：分支切换不应分裂记忆。
   */
  readonly branchId?: string
  /** projectId 的推导来源。 */
  readonly source: ProjectIdentitySource
  /**
   * 路径锚点：文件动态值的 path-guard 根。
   *
   * **不进入 scope**：projectId 不是路径，把 URL/指纹当路径会把动态文件属性误判越界。
   */
  readonly projectRoot: string
  /** 本工作区根的规范路径；`workspaceId` 的哈希输入。 */
  readonly workspaceRoot: string
  /**
   * 旧解析器可能写进 `scope.projectKey` 的键（git root 路径，非 git 时的 cwd）。
   *
   * 迁移后新写入使用 projectId，旧行仍是路径；检索用这份别名列表把旧数据
   * 仍然映射到同一个 projectId（见 `omb.project_identity.legacy_keys`）。
   */
  readonly legacyProjectKeys: readonly string[]
}

const PROTOCOL = /^[a-z][a-z0-9+.-]*:\/\//iu
const WINDOWS_DRIVE = /^[a-z]:[\\/]/iu
const UNC = /^[\\/]{2}[^\\/]/u
const RELATIVE = /^\.{1,2}[\\/]/u
const POSIX_ABSOLUTE = /^\//u
const SCP_LIKE = /^(?:[^@/\\:]+@)?([^:/\\]+):(.+)$/u
const GIT_SUFFIX = /\.git$/iu
const LEADING_SLASHES = /^\/+/u
const REPEATED_SLASHES = /\/{2,}/gu
const DRIVE_LETTER = /^([a-z]):/iu

function stripGitSuffix(value: string): string {
  let text = value
  while (text.endsWith('/')) text = text.slice(0, -1)
  if (GIT_SUFFIX.test(text)) text = text.slice(0, -'.git'.length)
  while (text.endsWith('/')) text = text.slice(0, -1)
  return text
}

function isLocalPath(value: string): boolean {
  return WINDOWS_DRIVE.test(value)
    || UNC.test(value)
    || RELATIVE.test(value)
    || POSIX_ABSOLUTE.test(value)
}

/**
 * 本地路径 remote 的规范化：统一分隔符、去掉 `.git` 与尾斜杠、盘符小写，
 * 并保留绝对路径的前导 `/` 与 UNC 的 `//`（`/srv/repo` 与 `srv/repo` 不是同一路径）。
 *
 * 输出带 `local:` 前缀，避免与 `host/path` 形式的远程 locator 混淆
 * （`D:\x` 与 `github.com/x` 是两类不同来源）。
 */
function normalizeLocalPath(value: string): string | undefined {
  const text = value.trim().replace(/\\/gu, '/')
  if (text.length === 0) return undefined
  const unc = text.startsWith('//')
  const absolute = !unc && text.startsWith('/')
  const body = stripGitSuffix(
    (unc ? text.slice(2) : text)
      .replace(LEADING_SLASHES, '')
      .replace(REPEATED_SLASHES, '/'),
  )
  if (body.length === 0) return undefined
  const normalized = body.replace(DRIVE_LETTER, (_match, letter: string) => `${letter.toLowerCase()}:`)
  if (unc) return `local://${normalized}`
  return `local:${absolute ? '/' : ''}${normalized}`
}

function fileUrlPath(value: string): string | undefined {
  try {
    const url = new URL(value)
    let pathname = decodeURIComponent(url.pathname)
    // `file:///D:/x` 在 Windows 上解析出 `/D:/x`：盘符前的斜杠不是路径的一部分。
    if (/^\/[a-z]:\//iu.test(pathname)) pathname = pathname.slice(1)
    if (url.host.length > 0) pathname = `//${url.host}${pathname}`
    return pathname
  } catch {
    return undefined
  }
}

/**
 * 把 git remote URL 规范化成与协议无关的 locator，例如：
 *
 * - `git@github.com:Org/Repo.git` → `github.com/Org/Repo`
 * - `ssh://git@GitHub.com:2222/Org/Repo` → `github.com/Org/Repo`
 * - `https://user:pass@github.com/Org/Repo.git` → `github.com/Org/Repo`
 * - `D:\src\repo.git` / `file:///D:/src/repo` → `local:d:/src/repo`
 *
 * 同一仓库通过 ssh / https / scp 三种写法声明 remote 时必须得到同一个 locator，
 * 否则 projectId 会因协议不同而分裂。host 统一小写；**路径大小写保持不变**：
 * 大小写不敏感托管平台之外的路径可能真的不同，不能为了合并而静默改大小写。
 *
 * 无法识别的写法返回 undefined：调用方退回 common dir 指纹（宁可稳定，不猜）。
 */
export function normalizeGitRemoteUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (PROTOCOL.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return undefined
    }
    if (url.protocol === 'file:') {
      const pathname = fileUrlPath(trimmed)
      return pathname === undefined ? undefined : normalizeLocalPath(pathname)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:' && url.protocol !== 'git:') {
      return undefined
    }
    const host = url.hostname.trim().toLowerCase()
    if (host.length === 0) return undefined
    const path = stripGitSuffix(url.pathname.replace(LEADING_SLASHES, ''))
    return path.length === 0 ? host : `${host}/${path}`
  }
  if (isLocalPath(trimmed)) return normalizeLocalPath(trimmed)
  const scp = SCP_LIKE.exec(trimmed)
  if (scp !== null) {
    const host = (scp[1] ?? '').trim().toLowerCase()
    const path = stripGitSuffix((scp[2] ?? '').replace(/^[\\/]+/u, '').replace(/\\/gu, '/'))
    if (host.length === 0 || path.length === 0) return undefined
    return `${host}/${path}`
  }
  return undefined
}

