/**
 * 宿主存储端口的构造与注入。
 *
 * 职责边界：
 * - `dsh/` 知道**宿主事实**：DSH 主目录在哪、`node:sqlite` 怎么开
 * - `modules/memory/` 知道**存储语义**：schema、迁移、FTS、连接策略
 *
 * 本文件只做三件事：解析路径、提供 `openDatabase`、把 `StorageHostPort`
 * 注入内核服务表（服务名 `STORAGE_HOST_SERVICE`），由 `omb-memory` 自己取用。
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Logger, SqliteLike, StorageHostPort } from '../kernel/abi/index.js'
import { DATA_DIR_NAME, MEMORY_DIR_NAME, PROJECT_DB_FILE, USER_DB_FILE, resolveDshHome } from '../modules/memory/paths.js'

/**
 * `StorageHostPort` 的服务名。
 *
 * 与 `modules/memory/index.ts` 的 `STORAGE_HOST_SERVICE` **必须一致**；
 * 这里重新声明而不是 import，是为了让 `dsh/` 不依赖某个模块的内部常量——
 * 代价是有一条契约测试钉住两者相等（`tests/dsh/stores.test.ts`）。
 */
export const STORAGE_HOST_SERVICE = 'omb.storage-host'

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteLike
}

/**
 * 解析 `node:sqlite`。
 *
 * 用 `createRequire().resolve` + 动态 import 而不是顶层 import：
 * 旧版本 Node 没有 `node:sqlite`，顶层 import 会让**整个插件加载失败**，
 * 而正确行为是退化成"存储不可用"并在状态面写明原因（诚实降级）。
 */
export function resolveSqlite(): SqliteModule | undefined {
  try {
    const require = createRequire(import.meta.url)
    require.resolve('node:sqlite')
    // resolve 成功说明该内建模块存在；实际取用交给调用方的 async 入口
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 同步打开一个库并设置并发策略。
 *
 * 策略来自规划 §12（风险 R8）：一库一连接、写超时 1s 快速失败而不是死等、
 * WAL 允许读写并行。旧实现在两个句柄上各设 5s `busy_timeout`，
 * 而 `busy_timeout` 是**同步等待**，会在争用时把事件循环卡住 5 秒。
 */
export function openSqliteSync(ctor: SqliteModule, path: string): SqliteLike {
  const db = new ctor.DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 1000')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export interface StorageHostOptions {
  readonly configuredDshHome?: string
  readonly env?: Record<string, string | undefined>
  readonly homedirPath?: string
  readonly logger: Logger
  /** 注入 `node:sqlite`（测试用；缺省异步解析真实模块）。 */
  readonly sqlite?: SqliteModule
}

export interface StorageHost {
  /** 构造好的端口。`openDatabase` 在 sqlite 未就绪时抛出可读错误。 */
  readonly port: StorageHostPort
  readonly userDbPath: string
  readonly projectDbPath: (cwd: string) => string
  /**
   * 异步解析 `node:sqlite`。
   * @returns 解析成功返回 null；失败返回可读原因（调用方记入状态面）。
   */
  ensureSqlite(): Promise<string | null>
}

/** 计算该 cwd 的项目库路径。与 `modules/memory/paths.ts` 同一套常量，不重复拼字面量。 */
export function projectDbPathOf(cwd: string): string {
  return join(cwd, DATA_DIR_NAME, MEMORY_DIR_NAME, PROJECT_DB_FILE)
}

export function createStorageHost(options: StorageHostOptions): StorageHost {
  const dshHome = resolveDshHome({
    ...(options.configuredDshHome === undefined ? {} : { configured: options.configuredDshHome }),
    env: options.env ?? process.env,
    homedir: options.homedirPath ?? homedir(),
  })
  const userDbPath = join(dshHome, DATA_DIR_NAME, MEMORY_DIR_NAME, USER_DB_FILE)

  let ctor: SqliteModule | undefined = options.sqlite
  let resolutionFailure: string | undefined

  const port: StorageHostPort = {
    userDbPath,
    createDirs: true,
    openDatabase(path: string): SqliteLike {
      const ready = ctor
      if (ready === undefined) {
        throw new Error(
          `OMB：sqlite 不可用（${resolutionFailure ?? '尚未解析'}）——记忆库无法打开，其余功能不受影响`,
        )
      }
      // 库文件所在目录由我们负责创建
      try {
        mkdirSync(dirname(path), { recursive: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`OMB：无法创建记忆目录 ${dirname(path)}——${message}`)
      }
      return openSqliteSync(ready, path)
    },
  }

  return {
    port,
    userDbPath,
    projectDbPath: projectDbPathOf,
    async ensureSqlite(): Promise<string | null> {
      if (ctor !== undefined) return null
      try {
        const loaded = (await import(/* @vite-ignore */ 'node:sqlite')) as unknown as SqliteModule
        if (typeof loaded?.DatabaseSync !== 'function') {
          resolutionFailure = 'node:sqlite 存在但没有 DatabaseSync 导出'
          return resolutionFailure
        }
        ctor = loaded
        return null
      } catch (error) {
        resolutionFailure = error instanceof Error ? error.message : String(error)
        options.logger.warn(`OMB：node:sqlite 不可用——${resolutionFailure}`)
        return resolutionFailure
      }
    },
  }
}
