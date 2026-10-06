/**
 * 隐私状态的**持久化**（独立 JSON 文件，原子写）。
 *
 * ## 为什么是独立文件，而不是复用什么现成的库
 *
 * | 候选 | 否决理由 |
 * |---|---|
 * | 记忆库（`stores` 的用户库） | **"清空记忆"会顺带解除隐私**。用户按下"删除关于我的一切"时，隐私模式跟着回 normal——这是把最敏感的状态放进最容易被清空的地方 |
 * | 宿主会话日志（`session.v4.jsonl.zstd`） | 我们只能**观察**会话事件，没有写入口；伪造一条记录等于污染会话历史 |
 * | 进程内存 | 重启即失效——需求明说"不因 dsh 重启丢状态" |
 *
 * 独立工件还有一个副作用是好的：**它的损坏是可见的、可单独修复的**，
 * 不与记忆数据耦合。
 *
 * ## 原子写
 *
 * 先写同目录临时文件再 `rename`（同分区 rename 是原子的）。这样任何时刻磁盘上
 * 要么是旧文档、要么是新文档，**不会是半截 JSON**——半截 JSON 会触发 fail-closed，
 * 把一个写入中断升级成"所有会话按最严处理"。
 *
 * ## 路径解析顺序（与 `dsh/stores.ts` 一致，但模块不能 import `dsh/`）
 *
 * ① 显式配置 → ② 宿主存储端口 `userDbPath` 的上级（`<dshHome>/.omb/`）→
 * ③ `$DSH_HOME` → ④ `~/.dsh`。任何一步拿不到就退到下一步；
 * 全拿不到 → `path = null`（**降级为“无法持久化”并如实上报**，不假装成功）。
 *
 * 平台注意：本模块只做同步小文件 I/O（文档量级 ~1KB）。它不是热路径：
 * 读一次在 `apply`，写一次在命令执行时。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
// 相对深度比独立模块时多一层：本文件现在住在 `modules/memory/privacy/`（3.6 并入记忆库）。
import type { Logger } from '../../../kernel/abi/index.js'
import type { PrivacyDecodeResult, PrivacyDoc } from './codec.js'
import { decodeDoc, encodeDoc } from './codec.js'

/**
 * 宿主存储端口的服务名。
 *
 * **这里只能按名引用**：`modules/**` 不得 import `dsh/**`（ESLint 分层规则），
 * 而该常量定义在 `dsh/stores.ts:25`。两处必须一致——由
 * `tests/modules/privacy/durable.test.ts` 断言"名字写错时降级为可读原因"来兜住。
 */
export const STORAGE_HOST_SERVICE = 'omb.storage-host'

/** 状态目录名（与记忆库同级：`<dshHome>/.omb/privacy/`）。 */
export const PRIVACY_DIR_NAME = 'privacy'
export const PRIVACY_FILE_NAME = 'session-modes.json'

export interface StoragePortLike {
  readonly userDbPath?: unknown
}

export interface PrivacyPathDeps {
  /** 显式配置的绝对路径（配置项）。 */
  readonly configured?: string | null
  /** 惰性解析宿主存储端口。 */
  readonly port?: () => StoragePortLike | undefined
  /** 环境变量（测试注入）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 用户主目录（测试注入）。 */
  readonly home?: () => string
}

/**
 * 解析状态文件路径。
 *
 * @returns 绝对路径；一条线索都拿不到时返回 null（调用方据此报"无法持久化"）。
 */
export function resolvePrivacyPath(deps: PrivacyPathDeps = {}): string | null {
  const configured = deps.configured?.trim()
  if (configured !== undefined && configured.length > 0) return configured

  const userDbPath = deps.port?.()?.userDbPath
  if (typeof userDbPath === 'string' && userDbPath.trim().length > 0) {
    // `<dshHome>/.omb/memory/knowledge.db` → `<dshHome>/.omb` → `+ /privacy/...`
    const dataRoot = dirname(dirname(userDbPath))
    if (dataRoot.length > 0) return join(dataRoot, PRIVACY_DIR_NAME, PRIVACY_FILE_NAME)
  }

  const env = deps.env ?? (typeof process === 'undefined' ? {} : process.env)
  const fromEnv = env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return join(fromEnv.trim(), '.omb', PRIVACY_DIR_NAME, PRIVACY_FILE_NAME)
  }

  try {
    const home = (deps.home ?? homedir)()
    if (typeof home === 'string' && home.trim().length > 0) {
      return join(home.trim(), '.dsh', '.omb', PRIVACY_DIR_NAME, PRIVACY_FILE_NAME)
    }
  } catch {
    // 取不到主目录 → 无法持久化（调用方如实上报）
  }
  return null
}

export interface PrivacyDurableStore {
  /** 状态文件绝对路径；null = 无法持久化。 */
  readonly path: string | null
  /** 同步读取并解析（`apply` 里调用：**必须在第一个工具调用之前**，不留窗口）。 */
  load(now: number): PrivacyDecodeResult
  /** 原子写。**绝不抛**；失败返回可读原因。 */
  save(doc: PrivacyDoc): { readonly ok: boolean; readonly error: string | null }
}

let tempSeq = 0

export function createPrivacyDurable(deps: {
  readonly path: string | null
  readonly logger: Logger
}): PrivacyDurableStore {
  const { path, logger } = deps

  return {
    path,

    load(now: number): PrivacyDecodeResult {
      if (path === null) {
        // 路径都解析不出来：**不是"从未配置过"**，而是"不知道"→ 交给调用方按 fail-closed 处理。
        return {
          doc: { version: 1, failClosedAt: now, modes: {} },
          error: '无法解析隐私状态文件路径（宿主存储端口、$DSH_HOME、~/.dsh 都不可用）',
          degraded: true,
          exists: false,
        }
      }
      try {
        if (!existsSync(path)) return decodeDoc('', now, false)
        return decodeDoc(readFileSync(path, 'utf8'), now, true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          doc: { version: 1, failClosedAt: now, modes: {} },
          error: `读取隐私状态文件失败：${message}`,
          degraded: true,
          exists: true,
        }
      }
    },

    save(doc: PrivacyDoc): { readonly ok: boolean; readonly error: string | null } {
      if (path === null) {
        return { ok: false, error: '没有可用的隐私状态文件路径（无法持久化）' }
      }
      const directory = dirname(path)
      const temporary = `${path}.tmp-${process.pid}-${(tempSeq = (tempSeq + 1) % 100000)}`
      try {
        mkdirSync(directory, { recursive: true })
        writeFileSync(temporary, encodeDoc(doc), 'utf8')
        try {
          renameSync(temporary, path)
        } catch (error) {
          // Windows 上目标被占用时 rename 可能失败：删目标再试一次，仍失败就如实报错。
          try {
            rmSync(path, { force: true })
            renameSync(temporary, path)
          } catch {
            throw error
          }
        }
        return { ok: true, error: null }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 清掉可能残留的临时文件（失败也不影响结果，故不覆盖上面的错误）
        try {
          rmSync(temporary, { force: true })
        } catch {
          // 忽略：临时文件清理失败不改变"保存失败"这个事实
        }
        logger.warn(`OMB 隐私：写入状态文件失败——${message}`)
        return { ok: false, error: `写入隐私状态文件失败：${message}` }
      }
    },
  }
}
