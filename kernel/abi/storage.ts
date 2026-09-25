/**
 * 存储契约。**由 `modules/memory/store.ts` 实现，其他模块只依赖本文件。**
 *
 * 冻结这个文件而不是让调用方直接依赖实现，有三个理由：
 * ① 并行施工时"文件接口"必须比"类型接口"更早冻结——否则集成必然对不上
 * ② 库句柄按**项目**区分，检索侧只接收 `readonly TaggedStore[]`，不知道有几个库
 * ③ 迁移框架、连接管理、WAL 策略都是实现细节，不该泄漏给检索逻辑
 */
import type { MemoryStore, MemoryScope } from './index.js'

/** 一个带标签的库句柄。标签只用于预算配额与确定性排序，**不用于过滤**。 */
export interface TaggedStore {
  readonly scope: MemoryScope
  readonly store: MemoryStore
}

/**
 * 一套已打开的库。
 *
 * **注意"一套"的含义随 cwd 而变**：用户库是进程级单例，
 * 项目库按会话的 cwd 区分（一个 DSH 进程可以同时服务多个项目的会话，
 * 见规划 §5.3 的路径解析）。因此 `projectScope` 是这个套件的身份。
 */
export interface StoreSet {
  /** 项目库对应的规范化 cwd；用户库专属套件为 null。 */
  readonly projectScope: string | null
  readonly stores: readonly TaggedStore[]
  /** 按作用域取库；不存在返回 undefined（不抛）。 */
  store(scope: MemoryScope): MemoryStore | undefined
  /** 迁移结果，供状态面如实显示。 */
  readonly migrated: readonly {
    readonly scope: MemoryScope
    readonly from: number
    readonly to: number
  }[]
  /** 关闭本套件的全部库（用户库由拥有者关闭）。**绝不抛异常**（热插拔 H-1）。 */
  close(): Promise<void>
}

/** `node:sqlite` 的最小结构接口。只声明用到的部分。 */
export interface SqliteLike {
  exec(sql: string): void
  prepare(sql: string): SqliteStatementLike
  close(): void
}

export interface SqliteStatementLike {
  run(...params: readonly unknown[]): { changes: number | bigint }
  get(...params: readonly unknown[]): unknown
  all(...params: readonly unknown[]): readonly unknown[]
}

/**
 * 宿主侧存储端口。**由 `dsh/` 提供，经内核服务注入**——
 * `modules/` 因此不必 import `node:sqlite`，也不需要知道 DSH_HOME 怎么解析。
 */
export interface StorageHostPort {
  /** 跨项目库的绝对路径。 */
  readonly userDbPath: string
  /** 宿主提供的 sqlite 打开函数。 */
  openDatabase(path: string): SqliteLike
  /** 库文件所在目录不存在时是否自动创建。 */
  readonly createDirs: boolean
  /**
   * 宿主异步资源（`node:sqlite`）的就绪等待。**可选**——给了就不必猜时序。
   *
   * 存在的理由：宿主侧的 sqlite 解析是**异步**的（动态 `import`），
   * 而模块的 `apply` 是同步的、读路径又是同步的 `peek()`（故意不在工具调用里做 I/O）。
   * 于是"第一次打开失败"就可能被固化成永久降级。
   * 有了它，模块可以先 `await` 就绪再开库；等待超时也只是继续尝试真开库，
   * 让错误在 `openDatabase` 处显形——**不把忙等伪装成修复**。
   */
  readonly whenReady?: () => Promise<void>
}

/**
 * 存储服务（内核服务名 `stores`）。
 *
 * **生命周期契约（热插拔 H-2）**：`apply` 里只能**同步** `provide` 这个对象，
 * 真正的打开是异步的；因此调用方一律经 `forSession` / `forProject` 拿 `StoreSet`，
 * 它们可能返回 undefined——**调用方必须能降级**，不得假设库一定就绪。
 */
export interface StoresService {
  /** 健康与就绪状态，供状态面显示（含未就绪原因）。 */
  status(): {
    readonly ready: boolean
    readonly detail: string
    readonly openProjects: readonly string[]
  }
  /**
   * 已打开的库套件快照。**不触发新打开**。
   *
   * 存在的理由：向量编码器手上只有 `memory/written` 的 `{id, scope, kind}`，
   * 而 `forSession`/`forProject` 都要它拿不到的键（会话 id / cwd）。
   * 没有这个枚举口，落盘侧只能靠猜——或者放弃编码。
   * 未就绪时 `user` 为 undefined、`projects` 为空（调用方如实降级，不抛）。
   */
  snapshot(): { readonly user: StoreSet | undefined; readonly projects: readonly StoreSet[] }
  /**
   * 取某会话所在项目的库。未就绪或打开失败返回 undefined（**不抛**）。
   * @param sessionId 宿主会话 id（用于把 cwd 映射到项目库）。
   */
  forSession(sessionId: string): Promise<StoreSet | undefined>
  /**
   * 取某 cwd 的项目库。规范化后作为身份；同一 cwd 复用同一套件。
   * @param cwd 项目工作目录。
   */
  forProject(cwd: string): Promise<StoreSet | undefined>
  /** 记下会话的 cwd（宿主在会话建立/切换时告知）。 */
  rememberCwd(sessionId: string, cwd: string): void
  /** 关闭全部库。**绝不抛异常**。 */
  close(): Promise<void>
}

/** 内核服务名。 */
export const STORES_SERVICE = 'stores'

/**
 * schema 版本。**每个库独立**。
 *
 * 迁移规则（实现方必须遵守）：
 * - 空库 → 升到最新
 * - `user_version` 大于本常量 → **拒绝打开**并抛出（不尝试"猜"结构）
 * - 迁移失败 → 回滚，版本不变，异常向上抛（**不吞**）
 */
export const SCHEMA_VERSION = 1
