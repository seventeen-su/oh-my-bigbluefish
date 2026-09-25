/**
 * 存储构造契约。**由 `modules/memory/store.ts` 实现，其他模块只依赖本文件。**
 *
 * 冻结这个文件而不是让调用方直接依赖实现，有三个理由：
 * ① 并行施工时"文件接口"必须比"类型接口"更早冻结——否则集成必然对不上
 * ② 双库 = 两个 `MemoryStore` 实例；检索侧只接收 `readonly TaggedStore[]`，不知道有几个库
 * ③ 迁移框架、连接管理、WAL 策略都是实现细节，不该泄漏给检索逻辑
 */
import type { Logger, MemoryStore, MemoryScope } from '../../kernel/abi/index.js'

/** 一个带标签的库句柄。标签只用于预算配额与确定性排序，不用于过滤。 */
export interface TaggedStore {
  readonly scope: MemoryScope
  readonly store: MemoryStore
}

/** 打开两个库的结果。 */
export interface StoreSet {
  readonly stores: readonly TaggedStore[]
  /** 按 scope 取库；不存在返回 undefined（不抛）。 */
  store(scope: MemoryScope): MemoryStore | undefined
  /** 迁移结果，供状态面如实显示（空库 → 最新版；未来版本 → 拒绝打开）。 */
  readonly migrated: readonly { readonly scope: MemoryScope; readonly from: number; readonly to: number }[]
  /** 关闭全部库。**绝不抛异常**（热插拔 H-1）。 */
  close(): Promise<void>
}

export interface OpenStoreSetOptions {
  /** 跨项目库的绝对路径。 */
  readonly userDbPath: string
  /** 跨会话库的绝对路径。 */
  readonly projectDbPath: string
  /**
   * 宿主提供的 sqlite 打开函数。
   *
   * `infra` 侧不直接 import `node:sqlite`——由 `dsh/` 注入，
   * 这样模块层可在测试里用内存库或 fake，且宿主换实现时不必改业务代码。
   */
  readonly openDatabase: (path: string) => SqliteLike
  readonly logger: Logger
  /** 库文件所在目录不存在时是否自动创建。 */
  readonly createDirs?: boolean
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

/** 打开并迁移两个库。 */
export type OpenStoreSet = (options: OpenStoreSetOptions) => Promise<StoreSet>

/**
 * schema 版本。**每个库独立**。
 *
 * 迁移规则（实现方必须遵守）：
 * - 空库 → 升到最新
 * - `user_version` 大于本常量 → **拒绝打开**并抛出（不尝试"猜"结构）
 * - 迁移失败 → 回滚，版本不变，异常向上抛（**不吞**）
 */
export const SCHEMA_VERSION = 1
