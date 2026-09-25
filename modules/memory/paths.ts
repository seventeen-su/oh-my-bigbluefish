/**
 * 双库路径解析。**纯函数**（除显式的目录创建），可零 mock 测试。
 *
 * 布局（规划 §5.3）：
 * ```
 * $DSH_HOME/.omb/memory/knowledge.db      ← 跨项目
 * <cwd>/.omb/memory/session.db            ← 跨会话（本项目）
 * ```
 *
 * 为什么是这个布局：
 * - 用户库独立成物理工件，使「删除关于我的一切」是一次文件操作，而不是一个可能出错的查询
 * - 项目库锚在会话的 cwd，记忆随项目走；换项目自动隔离，无需映射表
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 双库所在目录名。 */
export const DATA_DIR_NAME = '.omb'
export const MEMORY_DIR_NAME = 'memory'
export const USER_DB_FILE = 'knowledge.db'
export const PROJECT_DB_FILE = 'session.db'

/**
 * 解析 DSH 主目录。
 *
 * 顺序与宿主一致（`packages/util/home-paths/src/index.ts:87-91`）：
 * 显式配置 → `$DSH_HOME` → `~/.dsh`。空串视为未设置（不把 home 解析到当前目录）。
 */
export function resolveDshHome(options: {
  readonly configured?: string
  readonly env?: Record<string, string | undefined>
  readonly homedir: string
}): string {
  const configured = options.configured
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(expandHome(configured, options.homedir))
  }
  const fromEnv = options.env?.['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return resolve(expandHome(fromEnv, options.homedir))
  }
  return join(options.homedir, '.dsh')
}

/** 展开 `~` / `~/` / `~\` 前缀。 */
export function expandHome(path: string, homedir: string): string {
  if (path === '~') return homedir
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir, path.slice(2))
  return path
}

export interface MemoryPaths {
  /** 跨项目库的绝对路径。 */
  readonly userDbPath: string
  /** 该 cwd 的跨会话库绝对路径。 */
  readonly projectDbPath: string
  readonly userDir: string
  readonly projectDir: string
}

/**
 * 计算两库路径。**不创建任何目录**——创建由 `ensureMemoryDirs` 单独负责，
 * 这样纯路径计算可以在测试里零副作用地断言。
 *
 * @param cwd 会话的工作目录；非绝对路径会被拒绝（拒绝静默采用进程 cwd）。
 */
export function memoryPaths(options: {
  readonly dshHome: string
  readonly cwd: string
}): MemoryPaths {
  if (!isAbsolute(options.cwd)) {
    throw new Error(`OMB：项目库路径需要绝对 cwd，收到 "${options.cwd}"（拒绝静默采用进程 cwd）`)
  }
  const userDir = join(options.dshHome, DATA_DIR_NAME, MEMORY_DIR_NAME)
  const projectDir = join(options.cwd, DATA_DIR_NAME, MEMORY_DIR_NAME)
  return {
    userDir,
    projectDir,
    userDbPath: join(userDir, USER_DB_FILE),
    projectDbPath: join(projectDir, PROJECT_DB_FILE),
  }
}

/** 目录里放一份说明，让"这是什么、属于谁、怎么删"不依赖提问。 */
function readme(title: string, body: readonly string[]): string {
  return [`# ${title}`, '', ...body, ''].join('\n')
}

const USER_README = readme('OMB 跨项目记忆', [
  '本目录由 OMB v3 插件创建与维护。',
  '',
  '- `knowledge.db`：跨项目记忆（长期结论、显式偏好、约束）。',
  '- 删除本目录即清除全部跨项目记忆——这是一个文件操作，不需要查询。',
  '- 本目录位于 DSH 主目录下，不随项目迁移。',
])

const PROJECT_README = readme('OMB 跨会话记忆', [
  '本目录由 OMB v3 插件创建与维护。',
  '',
  '- `session.db`：本项目内跨会话的记忆（情境记录、经验、项目相关结论）。',
  '- 记忆随项目走：换项目会自动落到该项目的 `.omb/memory/`。',
  '- 若不希望本目录被版本控制跟踪，请把 `.omb/` 加入 `.gitignore`。',
])

/**
 * 创建两个目录（幂等）并写入说明文件。
 * @returns 实际新建的目录（已存在的不计入），供诊断输出。
 */
export function ensureMemoryDirs(paths: MemoryPaths): readonly string[] {
  const created: string[] = []
  for (const [dir, content] of [
    [paths.userDir, USER_README],
    [paths.projectDir, PROJECT_README],
  ] as const) {
    try {
      mkdirSync(dir, { recursive: true })
      created.push(dir)
    } catch (error) {
      // 目录创建失败不应让插件加载失败；原因由调用方记入健康面
      throw new Error(`OMB：无法创建记忆目录 ${dir}——${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      // 仅在缺失时写，避免每次启动都覆盖用户可能改过的说明
      writeFileSync(join(dir, 'README.md'), content, { flag: 'wx' })
    } catch {
      // 已存在（EEXIST）或不可写 → 都不影响功能
    }
  }
  return created
}

/**
 * 规范化 cwd 作为项目库身份。
 *
 * 用 `resolve` 而非 `realpath`：`realpath` 要求路径已存在，
 * 而会话 cwd 在极端情形下可能尚未建立；规范化只做绝对化与分隔符统一。
 */
export function projectIdentity(cwd: string): string {
  return resolve(cwd)
}
