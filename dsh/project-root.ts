/**
 * 项目根解析：**空间身份**的唯一来源（v4.1 §3.1）。
 *
 * ## 为什么需要独立服务
 *
 * 记忆库按 cwd 开项目库，同一个 git 仓库从子目录启动的会话会另起一个库
 * （`<subdir>/.omb/memory/`），项目记忆因此被切成两半。项目身份必须是
 * **git 仓库根**；模块层不能跑子进程，所以由 `dsh/` 解析、以同步只读端口
 * 供记忆库与项目画像在打开/构建前调用。
 *
 * ## 契约（`docs/v4.1-spacetime.md` §3.1）
 *
 * - `git -C <cwd> rev-parse --show-toplevel`，**同步**，2.5s 超时；
 * - 缓存 `cwd → root`，TTL 60s，上界 128；
 * - 失败返回**规范化 cwd 本身**（不抛）；非 git 目录同样返回规范化 cwd；
 * - `git` 可注入（测试不需要真仓库）。
 *
 * ## 绝不抛
 *
 * 这是记忆库与画像的**上游**：它一旦抛，两个下游都得各自写一条降级路径。
 * 因此所有内部失败（子进程缺失、超时、路径非法、注入的 runner 抛错）一律
 * 退化为"cwd 即根"，并把失败本身也缓存进 TTL——否则非 git 目录会在每次
 * 解析时重复付一次子进程开销。
 *
 * @module omb/dsh/project-root
 */
import { execFileSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { Clock } from '../kernel/abi/index.js'

/** `git rev-parse --show-toplevel` 的超时：与画像里既有的 git 调用同一口径。 */
export const PROJECT_ROOT_GIT_TIMEOUT_MS = 2500
/** 默认缓存时长：60 秒。目录变成仓库 / 仓库移动都是慢事件。 */
export const PROJECT_ROOT_TTL_MS = 60 * 1000
/** 默认缓存上界：会话/工作区数量有限，上界防长跑进程无限增长。 */
export const PROJECT_ROOT_MAX_ENTRIES = 128

/** 项目根解析端口（内核服务 `SERVICES.projectRoot` 的形状）。 */
export interface ProjectRootPort {
  /** 解析 cwd 所属的项目根；非 git / 失败 / 卸载后返回规范化 cwd。绝不抛。 */
  resolve(cwd: string): string
}

/** 一次只读 git 调用的结果。`ok=false` 表示不可用（不是"输出为空"）。 */
export interface GitRunResult {
  readonly ok: boolean
  readonly stdout: string
}

/** 可注入的 git 执行器：参数是**不含** `-C <cwd>` 的其余参数。 */
export type GitRunner = (cwd: string, args: readonly string[]) => GitRunResult

/** 构建选项。 */
export interface ProjectRootOptions {
  readonly clock: Clock
  /** 可注入的执行器（测试用假 git）；缺省走 `git` 子进程。 */
  readonly git?: GitRunner
  readonly ttlMs?: number
  readonly maxEntries?: number
}

interface CacheEntry {
  readonly root: string
  readonly expiresAt: number
}

/** 默认执行器：同步子进程，失败/超时/无输出都返回 `ok=false`。 */
const defaultGit: GitRunner = (cwd, args) => {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: PROJECT_ROOT_GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { ok: true, stdout: out.trim() }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/**
 * 规范化调用方给的 cwd。
 *
 * 空串/非字符串 → `''`（"没有 cwd"，不是当前进程目录——把 `''` 解析成
 * `process.cwd()` 会把别人的项目根冒充成本次会话的根）。
 */
function normalizeCwd(cwd: string): string {
  if (typeof cwd !== 'string') return ''
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return ''
  try {
    return resolve(trimmed)
  } catch {
    return trimmed
  }
}

/** 把一个正整数的上限收成安全值。 */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/**
 * 创建项目根解析器。
 *
 * @param options - 时钟、可选注入的 git、TTL 与缓存上界。
 * @returns `port`（只读同步解析端口）与幂等 `dispose`；dispose 清缓存后
 *          `resolve` 退化为"规范化 cwd"且**不再**启动子进程。
 */
export function createProjectRootResolver(options: ProjectRootOptions): {
  readonly port: ProjectRootPort
  readonly dispose: () => void
} {
  const ttl = positiveInt(options.ttlMs, PROJECT_ROOT_TTL_MS)
  const maxEntries = positiveInt(options.maxEntries, PROJECT_ROOT_MAX_ENTRIES)
  const runGit = options.git ?? defaultGit
  const cache = new Map<string, CacheEntry>()
  let disposed = false

  /** 问一次 git；任何异常（含注入 runner 抛错）都视为"不可用"。 */
  const askGit = (cwd: string): string | undefined => {
    try {
      const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
      if (!result.ok) return undefined
      const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
      if (stdout.length === 0) return undefined
      // `--show-toplevel` 承诺绝对路径；相对输出无法安全解释（会落到进程 cwd 上，
      // 把别人的项目根冒充成本次会话的根），一律放弃。
      if (!isAbsolute(stdout)) return undefined
      // git 在 Windows 上可能返回正斜杠；`resolve` 统一成原生分隔符。
      return resolve(stdout)
    } catch {
      return undefined
    }
  }

  /** 写缓存 + 上界淘汰（最旧优先；命中时会重插以近似 LRU）。 */
  const remember = (key: string, root: string, now: number): string => {
    cache.delete(key)
    cache.set(key, { root, expiresAt: now + ttl })
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return root
  }

  const port: ProjectRootPort = {
    resolve: cwd => {
      const key = normalizeCwd(cwd)
      if (key.length === 0) return ''
      if (disposed) return key
      const now = options.clock.now()
      const cached = cache.get(key)
      if (cached !== undefined && cached.expiresAt > now) {
        // 命中即重插：让 Map 的插入序近似最近使用序。
        cache.delete(key)
        cache.set(key, cached)
        return cached.root
      }
      const root = askGit(key) ?? key
      return remember(key, root, now)
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
