/**
 * 项目画像：给"工作区级记忆"一份**确定性、可复算**的项目理解。
 *
 * ## 为什么需要
 *
 * 用户实测痛点：每个新会话都要重新读一遍仓库（README、package.json、目录、
 * git 历史），这些读取既花 token 也花时间；OMB 记忆却只存零散结论。
 * 项目画像把"这个仓库是什么、怎么跑、最近在做什么"固化成一段短文本，
 * 由 `omb_project` 按需读取——**不占常驻预算，不改变系统提示前缀**。
 *
 * ## 边界
 *
 * - **只读**：不写仓库、不改 git、不执行项目脚本。
 * - **确定性**：同一份文件/git 状态产出同一段文本（顺序固定），便于缓存与 diff。
 * - **不在热路径**：`read()` 命中缓存直接返回；`refresh()` 才重扫。
 * - **绝不抛**：任何读失败都退化为"缺失该段"，而不是让工具调用失败。
 *
 * @module omb/dsh/project-profile
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Clock } from '../kernel/abi/index.js'

/** 一段项目画像。`text` 已按固定顺序渲染，可直接交给模型。 */
export interface ProjectProfile {
  readonly text: string
  readonly generatedAt: number
  /** git 短 HEAD；非 git 目录为 undefined。 */
  readonly gitHead?: string
}

/** 供记忆模块调用的只读端口。 */
export interface ProjectProfilePort {
  /** 读缓存；过期或没有缓存时同步构建一次（失败返回 undefined）。 */
  read(cwd: string): ProjectProfile | undefined
  /** 强制重建（异步签名便于未来换成异步 I/O；当前为同步实现）。 */
  refresh(cwd: string): Promise<ProjectProfile | undefined>
}

/** 默认缓存时长：10 分钟。项目结构不会每秒变化。 */
export const PROJECT_PROFILE_TTL_MS = 10 * 60 * 1000
/** 画像正文上限（避免把 README 全文搬进来）。 */
const PROFILE_TEXT_MAX = 1400

/** 构建配置。 */
export interface ProjectProfileOptions {
  readonly clock: Clock
  readonly ttlMs?: number
}

interface CacheEntry {
  readonly profile: ProjectProfile
  readonly expiresAt: number
}

/** 安全执行一个只读命令；失败/超时/无输出返回 undefined。 */
function runGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const text = out.trim()
    return text.length === 0 ? undefined : text
  } catch {
    return undefined
  }
}

/** 读 JSON 文件；失败返回 undefined。 */
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** 从 README 里取标题 + 第一段（最多 300 字符）。 */
function readmeBrief(cwd: string): string | undefined {
  for (const name of ['README.zh.md', 'README.md', 'README.zh-CN.md', 'readme.md']) {
    const path = join(cwd, name)
    if (!existsSync(path)) continue
    try {
      const text = readFileSync(path, 'utf8')
      const lines = text.split(/\r?\n/)
      const title = lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim()
      const paragraph = lines
        .filter(line => line.trim().length > 0 && !line.startsWith('#'))
        .slice(0, 3)
        .join(' ')
        .slice(0, 300)
      const brief = [title, paragraph].filter(part => typeof part === 'string' && part.length > 0).join(' — ')
      if (brief.length > 0) return brief
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined
}

/** 顶层条目（跳过生成物/依赖目录），固定排序。 */
function topEntries(cwd: string): string[] {
  const skip = new Set([
    'node_modules', '.git', 'dist', 'build', 'lib-gen', 'coverage', '.pnpm-store',
    '.next', '.turbo', 'out', 'target', '.venv', '__pycache__',
  ])
  try {
    return readdirSync(cwd)
      .filter(name => !skip.has(name))
      .filter(name => {
        try {
          return statSync(join(cwd, name)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
      .slice(0, 16)
  } catch {
    return []
  }
}

/** 语言/文件类型分布（优先 git index；非 git 目录退化为顶层统计）。 */
function languageSummary(cwd: string): string | undefined {
  let files: string[] = []
  const listed = runGit(cwd, ['ls-files'])
  if (listed !== undefined) {
    files = listed.split(/\r?\n/).filter(Boolean)
  } else {
    try {
      files = readdirSync(cwd).filter(name => {
        try {
          return statSync(join(cwd, name)).isFile()
        } catch {
          return false
        }
      })
    } catch {
      return undefined
    }
  }
  const counts = new Map<string, number>()
  for (const file of files) {
    const extension = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : ''
    if (extension.length === 0 || extension.length > 8) continue
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6)
  if (top.length === 0) return undefined
  return top.map(([extension, count]) => `${extension} ${count}`).join('、')
}

/** 构建一份画像。任何单段失败只丢该段。 */
function buildProfile(cwd: string, now: number): ProjectProfile | undefined {
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return undefined
  } catch {
    return undefined
  }

  const pkg = readJson(join(cwd, 'package.json'))
  const name = typeof pkg?.['name'] === 'string' ? pkg['name'] : basename(cwd)
  const version = typeof pkg?.['version'] === 'string' ? pkg['version'] : undefined
  const description = typeof pkg?.['description'] === 'string' ? pkg['description'] : undefined
  const scripts = typeof pkg?.['scripts'] === 'object' && pkg['scripts'] !== null
    ? pkg['scripts'] as Record<string, unknown>
    : {}
  const scriptNames = Object.keys(scripts).sort()
  const gates = scriptNames
    .filter(key => /test|build|lint|typecheck|verify|check/i.test(key))
    .slice(0, 8)
  const dependencies = typeof pkg?.['dependencies'] === 'object' && pkg['dependencies'] !== null
    ? Object.keys(pkg['dependencies'] as Record<string, unknown>).length
    : 0
  const devDependencies = typeof pkg?.['devDependencies'] === 'object' && pkg['devDependencies'] !== null
    ? Object.keys(pkg['devDependencies'] as Record<string, unknown>).length
    : 0

  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  const commits = runGit(cwd, ['log', '-5', '--pretty=format:%h %s'])
  const dirty = runGit(cwd, ['status', '--porcelain'])
  const languages = languageSummary(cwd)
  const entries = topEntries(cwd)
  const readme = readmeBrief(cwd)

  const lines: string[] = []
  lines.push(`项目：${name}${version === undefined ? '' : ` v${version}`}${description === undefined ? '' : ` — ${description}`}`)
  const stack: string[] = []
  if (pkg !== undefined) stack.push(`package.json（依赖 ${dependencies} / 开发依赖 ${devDependencies}）`)
  if (existsSync(join(cwd, 'tsconfig.json'))) stack.push('TypeScript')
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) stack.push('pnpm')
  else if (existsSync(join(cwd, 'package-lock.json'))) stack.push('npm')
  else if (existsSync(join(cwd, 'yarn.lock'))) stack.push('yarn')
  if (languages !== undefined) stack.push(languages)
  if (stack.length > 0) lines.push(`栈：${stack.join('；')}`)
  if (entries.length > 0) lines.push(`顶层目录：${entries.join('、')}`)
  if (gates.length > 0) {
    lines.push(`命令：${gates.map(key => `${key}=${String(scripts[key])}`).join('；')}`)
  } else if (scriptNames.length > 0) {
    lines.push(`命令（前 8 个）：${scriptNames.slice(0, 8).join('、')}`)
  }
  const gitBits: string[] = []
  if (branch !== undefined) gitBits.push(`分支 ${branch}`)
  if (head !== undefined) gitBits.push(`HEAD ${head}`)
  if (dirty !== undefined) gitBits.push(`未提交改动 ${dirty.split(/\r?\n/).filter(Boolean).length} 处`)
  if (commits !== undefined) gitBits.push(`最近提交：${commits.split(/\r?\n/).slice(0, 5).join(' / ')}`)
  if (gitBits.length > 0) lines.push(`Git：${gitBits.join('；')}`)
  if (readme !== undefined) lines.push(`README：${readme}`)

  let text = lines.join('\n').slice(0, PROFILE_TEXT_MAX)
  if (text.length === 0) return undefined
  if (text.length < PROFILE_TEXT_MAX) text += '\n（由 OMB 本地构建；如需最新请 refresh）'
  return { text, generatedAt: now, ...(head === undefined ? {} : { gitHead: head }) }
}

/**
 * 创建项目画像端口。
 *
 * @param options - 时钟与 TTL（测试可注入短 TTL/固定时钟）。
 * @returns 端口与幂等 disposer；dispose 只清缓存。
 */
export function createProjectProfile(options: ProjectProfileOptions): {
  readonly port: ProjectProfilePort
  readonly dispose: () => void
} {
  const ttl = options.ttlMs ?? PROJECT_PROFILE_TTL_MS
  const cache = new Map<string, CacheEntry>()
  let disposed = false

  /** 构建并写缓存（read 与 refresh 共用）。 */
  const buildCached = (cwd: string): ProjectProfile | undefined => {
    const now = options.clock.now()
    const profile = buildProfile(cwd, now)
    if (profile !== undefined) cache.set(cwd, { profile, expiresAt: now + ttl })
    // 会话/工作区数量有限，但缓存仍设上界，防长跑进程无限增长。
    while (cache.size > 32) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return profile
  }

  const port: ProjectProfilePort = {
    read: cwd => {
      if (disposed) return undefined
      const cached = cache.get(cwd)
      const now = options.clock.now()
      if (cached !== undefined && cached.expiresAt > now) return cached.profile
      return buildCached(cwd)
    },
    refresh: async cwd => {
      if (disposed) return undefined
      cache.delete(cwd)
      return buildCached(cwd)
    },
  }

  return {
    port,
    dispose: () => {
      disposed = true
      cache.clear()
    },
  }
}
