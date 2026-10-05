/**
 * 工件存在性核验——准入判据里"可由具体工件复现"的**权威答案来源**。
 *
 * ## 为什么需要它
 *
 * 判据自己做不了这件事：它是纯函数，碰不了文件系统。而只做形态匹配的后果实测过——
 * 编造的 `does-not-exist-9f3a.json` 与真实文件名拿到同一个准入结论，字段却叫
 * `reproducible-artifact`。**名不副实的闸门等于没有闸门。**
 *
 * ## 为什么用 git 索引而不是文件系统遍历
 *
 * 判据匹配到的往往是**裸文件名**（正文里写 `modules/memory/remember.ts`，
 * 正则只捕获 `remember.ts`），而它相对基准目录的位置是未知的：
 *
 * - 直接拼 `<cwd>/remember.ts` → 不存在
 * - 从 cwd 逐级**向上**找 → 永远找不到（文件在仓库**内部**）
 * - 从 cwd 递归**向下**找 → 要遍历整棵树，还得自己排除 `node_modules`
 *
 * `git ls-files` 一次给出仓库里全部受管路径，既是**权威**（git 自己维护的索引），
 * 又便宜（实测本仓库 167 条）。裸名用**后缀匹配**解析，`path/to/x.ts` 用精确匹配。
 *
 * ## 降级
 *
 * 不是 git 仓库、或 git 不可执行时返回 `undefined`（=核验不了）。
 * 调用方对 `undefined` 按**保守**处理：不算依据。宁可让用户补一个可核验的引用，
 * 也不要收下一条引用不存在工件的事实。
 *
 * **降级本身也是读数**：负结果（核验不了）与正结果一样进缓存，窗口内只 spawn 一次；
 * 原因经 `artifactVerificationDegradeReason()` 暴露给健康面——否则宿主每写一条
 * 含文件名的记忆就静默卡一次，而状态面只会说"这条不算依据"。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** git 超时：核验不能拖慢写入。超时即"核验不了"。 */
const GIT_TIMEOUT_MS = 4_000

/**
 * 索引缓存。
 *
 * **用单调计数器做失效，不取墙钟**：模块层不许直接读时钟
 * （`omb/no-direct-clock`——时间必须由 `dsh/` 注入，否则测试不可控）。
 * 核验只是"文件在不在"的判断，用"最近 N 次核验内复用"就够了，
 * 不需要精确的秒级 TTL。
 */
export const INDEX_REUSE_WINDOW = 64

/** 空的索引：表示"这个 cwd 核验不了"（见 `IndexCache.unavailable`）。 */
const EMPTY_INDEX: ReadonlySet<string> = new Set()

interface IndexCache {
  readonly files: ReadonlySet<string>
  /** 上次构建索引时的核验序号。 */
  readonly at: number
  /**
   * `null` = 索引可用；非 null = 这个 cwd **核验不了**，值是原因。
   *
   * 为什么负结果也要缓存：非 git 工作目录（或 git 不在 PATH）下 `git ls-files`
   * 每次都会失败——不缓存就变成"每写一条含文件名的记忆，同步 spawn 一次子进程并等它失败"
   * （Windows 每次进程创建几十毫秒，最坏撞 4 秒超时，期间整个宿主进程停住）。
   */
  readonly unavailable: string | null
}

const caches = new Map<string, IndexCache>()
let verificationCount = 0

/**
 * 最近一次核验为什么"核验不了"（`null` = 最近一次拿到了可用索引）。
 *
 * 降级必须可见（硬不变量）：失败被吞成 `undefined` 之后，状态面上只剩
 * "这条不算依据"这一个后果，没人知道是**核验不了**还是**文件不存在**。
 */
let lastUnavailableReason: string | null = null

/** 供健康面读取的只读访问器（模块层不导出可变状态）。 */
export function artifactVerificationDegradeReason(): string | null {
  return lastUnavailableReason
}

/** 测试用：清掉缓存，避免上一个用例的索引影响下一个。 */
export function clearArtifactIndexCache(): void {
  caches.clear()
  verificationCount = 0
  lastUnavailableReason = null
}

/** 把 `execFileSync` 的失败翻译成可读原因（降级必须给原因，不能只是一片沉默）。 */
function unavailableReasonOf(error: unknown): string {
  const failure = error as { code?: unknown; status?: unknown; signal?: unknown; message?: unknown } | null
  const code = typeof failure?.code === 'string' ? failure.code : undefined
  if (code === 'ENOENT') return 'git 不可执行（PATH 里找不到 git）'
  if (code === 'ETIMEDOUT' || failure?.signal === 'SIGTERM') return `git ls-files 超时（>${GIT_TIMEOUT_MS}ms）`
  const status = typeof failure?.status === 'number' ? failure.status : undefined
  const message = typeof failure?.message === 'string' ? failure.message : String(error)
  if (status === undefined) return `git ls-files 失败：${message}`
  if (status === 128) return '不是 git 仓库（git ls-files 退出码 128）'
  return `git ls-files 退出码 ${status}：${message}`
}

function indexOf(cwd: string, tick: number): ReadonlySet<string> | undefined {
  const cached = caches.get(cwd)
  if (cached !== undefined && tick - cached.at < INDEX_REUSE_WINDOW) {
    lastUnavailableReason = cached.unavailable
    // 负结果复用：窗口内**一次都不再 spawn**（这正是"卡一下"消失的地方）
    return cached.unavailable === null ? cached.files : undefined
  }
  let files: ReadonlySet<string>
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    files = new Set(out.split('\n').map(line => line.trim()).filter(line => line.length > 0))
  } catch (error) {
    // 不是 git 仓库 / git 不在 / 超时：一律"核验不了"，**但记住这个结论与原因**
    const reason = unavailableReasonOf(error)
    caches.set(cwd, { files: EMPTY_INDEX, at: tick, unavailable: reason })
    lastUnavailableReason = reason
    return undefined
  }
  if (files.size === 0) {
    // 空索引（仓库里没有受管文件，或输出为空）：同样核验不了 —— 也缓存
    const reason = 'git 索引为空（该目录下没有受管文件）'
    caches.set(cwd, { files: EMPTY_INDEX, at: tick, unavailable: reason })
    lastUnavailableReason = reason
    return undefined
  }
  caches.set(cwd, { files, at: tick, unavailable: null })
  lastUnavailableReason = null
  return files
}

/**
 * 核验一个候选工件是否真实存在。
 *
 * @param candidate 判据捕获到的串（可能是裸文件名、相对路径、绝对路径）
 * @param cwd 会话工作目录（用户眼里的"当前目录"）；**不是**宿主进程的 cwd
 * @returns `true` 存在 / `false` 不存在 / `undefined` 核验不了
 */
export function verifyArtifactExists(candidate: string, cwd: string | null): boolean | undefined {
  try {
    const bare = candidate.trim()
    if (bare.length === 0) return undefined

    // 绝对路径：直接问文件系统，不需要索引
    if (isAbsolute(bare)) {
      try {
        return existsSync(bare) && statSync(bare).isFile()
      } catch {
        return false
      }
    }

    // 相对路径：先精确匹配索引，再后缀匹配（裸名的常见形态）
    const base = cwd !== null && cwd.length > 0 && existsSync(cwd) ? cwd : process.cwd()
    verificationCount += 1
    const index = indexOf(base, verificationCount)
    if (index === undefined) return undefined
    return indexHas(index, bare)
  } catch {
    // 核验不了 ≠ 核验通过
    return undefined
  }
}

/**
 * 索引里有没有这个路径。
 *
 * 先精确匹配；不中再用**后缀匹配**——判据捕获到的常常是裸文件名
 * （正文写 `modules/memory/remember.ts`），而 `git ls-files` 给的是完整相对路径。
 *
 * 后缀匹配要求前面是 `/`，所以 `remember.ts` 能命中 `modules/memory/remember.ts`，
 * 而 `not-remember.ts` 不会。
 */
function indexHas(index: ReadonlySet<string>, bare: string): boolean {
  if (index.has(bare)) return true
  const suffix = `/${bare}`
  for (const file of index) {
    if (file.endsWith(suffix)) return true
  }
  return false
}
