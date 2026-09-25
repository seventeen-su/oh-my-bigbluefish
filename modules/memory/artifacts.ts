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
const INDEX_REUSE_WINDOW = 64

interface IndexCache {
  readonly files: ReadonlySet<string>
  /** 上次构建索引时的核验序号。 */
  readonly at: number
}

const caches = new Map<string, IndexCache>()
let verificationCount = 0

/** 测试用：清掉缓存，避免上一个用例的索引影响下一个。 */
export function clearArtifactIndexCache(): void {
  caches.clear()
  verificationCount = 0
}

function indexOf(cwd: string, tick: number): ReadonlySet<string> | undefined {
  const cached = caches.get(cwd)
  if (cached !== undefined && tick - cached.at < INDEX_REUSE_WINDOW) return cached.files
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const files = new Set(out.split('\n').map(line => line.trim()).filter(line => line.length > 0))
    if (files.size === 0) return undefined
    caches.set(cwd, { files, at: tick })
    return files
  } catch {
    // 不是 git 仓库 / git 不在 / 超时：一律"核验不了"
    return undefined
  }
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
