/**
 * `tests/modules/memory/` 的共用夹具。
 *
 * 原则（规划 §11.1）：存储层用**真实 SQLite**（这里用 `node:sqlite` + 临时文件，
 * 或 `:memory:`），只有嵌入器允许注入。因此本文件不含任何 mock 数据库语义——
 * 计数只是包在真实连接外面的一层观察器。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Clock,
  Logger,
  MemoryRecord,
  MemoryScope,
  SqliteLike,
  SqliteStatementLike,
  StorageHostPort,
} from '../../../kernel/abi/index.js'

/** 逐语句计数：用来断言"批量而不是 N+1"。 */
export interface SqliteCounters {
  exec: number
  prepare: number
  get: number
  all: number
  run: number
  close: number
}

export interface CountingSqlite extends SqliteLike {
  readonly counters: SqliteCounters
  /** 底层连接；需要直接断言表结构时用。 */
  readonly raw: SqliteLike
}

/**
 * `node:sqlite` 的 `DatabaseSync` 结构上比 `SqliteLike` 更严格
 * （参数类型是 `SupportedValueType[]` 而不是 `readonly unknown[]`），
 * 因此在测试里显式转换一次：契约由生产代码遵守，夹具不该重复实现。
 */
export function nodeSqlite(path: string): SqliteLike {
  return new DatabaseSync(path) as unknown as SqliteLike
}

export function countingSqlite(real: SqliteLike): CountingSqlite {
  const counters: SqliteCounters = { exec: 0, prepare: 0, get: 0, all: 0, run: 0, close: 0 }
  return {
    counters,
    raw: real,
    exec(sql: string): void {
      counters.exec++
      real.exec(sql)
    },
    prepare(sql: string): SqliteStatementLike {
      counters.prepare++
      const statement = real.prepare(sql)
      return {
        run: (...params: readonly unknown[]) => {
          counters.run++
          return statement.run(...params)
        },
        get: (...params: readonly unknown[]) => {
          counters.get++
          return statement.get(...params)
        },
        all: (...params: readonly unknown[]) => {
          counters.all++
          return statement.all(...params)
        },
      }
    },
    close(): void {
      counters.close++
      real.close()
    },
  }
}

export interface TempWorkspace {
  readonly dir: string
  cleanup(): void
}

export function tempWorkspace(prefix = 'omb-memory-'): TempWorkspace {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup(): void {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 上偶发句柄未释放；临时目录残留不影响测试结论
      }
    },
  }
}

export interface TestPort extends StorageHostPort {
  /** 每次 `openDatabase` 的路径（用于断言"同一 cwd 只开一次"）。 */
  readonly opened: readonly string[]
  /** 每次打开得到的计数连接，顺序与 `opened` 一致。 */
  readonly databases: readonly CountingSqlite[]
}

export interface TestPortOptions {
  readonly createDirs?: boolean
  readonly userDbPath?: string
  /** 覆盖打开函数（例如让 close 抛异常来验证 H-1）。 */
  readonly openDatabase?: (path: string) => SqliteLike
}

/** 造一个宿主存储端口：真实 `node:sqlite` + 计数 + 记录打开过的路径。 */
export function testPort(dshHome: string, options: TestPortOptions = {}): TestPort {
  const opened: string[] = []
  const databases: CountingSqlite[] = []
  const open = (path: string): SqliteLike => {
    opened.push(path)
    const db = countingSqlite(nodeSqlite(path))
    databases.push(db)
    return db
  }
  return {
    userDbPath: options.userDbPath ?? join(dshHome, '.omb', 'memory', 'knowledge.db'),
    createDirs: options.createDirs ?? true,
    openDatabase: options.openDatabase ?? open,
    opened,
    databases,
  }
}

export interface CapturingLogger extends Logger {
  readonly warnings: readonly string[]
  readonly infos: readonly string[]
  readonly debugs: readonly string[]
}

export function capturingLogger(): CapturingLogger {
  const warnings: string[] = []
  const infos: string[] = []
  const debugs: string[] = []
  return {
    warnings,
    infos,
    debugs,
    debug: message => void debugs.push(message),
    info: message => void infos.push(message),
    warn: message => void warnings.push(message),
  }
}

export interface TestClock extends Clock {
  advance(ms: number): number
}

export function fixedClock(start = 1_700_000_000_000): TestClock {
  let current = start
  return {
    now: () => current,
    advance(ms: number): number {
      current += ms
      return current
    },
  }
}

let recordSeq = 0

/**
 * 造一条记录。字段用 `!== undefined` 判断而不是 `??`，
 * 这样"故意传非法值"的用例（空 id、空 sourceRef）不会被夹具悄悄修好。
 */
export function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  recordSeq++
  const text = overrides.text !== undefined ? overrides.text : `记忆内容 ${recordSeq}`
  return {
    id: overrides.id !== undefined ? overrides.id : `m-${recordSeq}`,
    scope: overrides.scope !== undefined ? overrides.scope : 'user',
    kind: overrides.kind !== undefined ? overrides.kind : 'semantic',
    text,
    contentHash: overrides.contentHash !== undefined ? overrides.contentHash : `hash-${recordSeq}`,
    sourceRef: overrides.sourceRef !== undefined ? overrides.sourceRef : `session:test#${recordSeq}`,
    assertedBy: overrides.assertedBy !== undefined ? overrides.assertedBy : 'user',
    observedAt: overrides.observedAt !== undefined ? overrides.observedAt : 1_700_000_000_000,
    validTo: overrides.validTo !== undefined ? overrides.validTo : null,
    supersededBy: overrides.supersededBy !== undefined ? overrides.supersededBy : null,
    lastUsedAt: overrides.lastUsedAt !== undefined ? overrides.lastUsedAt : 1_700_000_000_000,
    useCount: overrides.useCount !== undefined ? overrides.useCount : 0,
    project: overrides.project !== undefined ? overrides.project : null,
  }
}

/** 计数快照的差值。 */
export function delta(counters: SqliteCounters, before: SqliteCounters): SqliteCounters {
  return {
    exec: counters.exec - before.exec,
    prepare: counters.prepare - before.prepare,
    get: counters.get - before.get,
    all: counters.all - before.all,
    run: counters.run - before.run,
    close: counters.close - before.close,
  }
}

export function snapshotCounters(counters: SqliteCounters): SqliteCounters {
  return { ...counters }
}

/** 直接读表名，用于结构断言。 */
export function tableNames(db: SqliteLike): readonly string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
    .all()
    .map(row => String((row as { name: unknown }).name))
}

export function columnNames(db: SqliteLike, table: string): readonly string[] {
  return db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map(row => String((row as { name: unknown }).name))
}

export function userVersion(db: SqliteLike): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  return Number(row?.user_version ?? 0)
}

/** 供断言用的作用域标签。 */
export const BOTH_SCOPES: readonly MemoryScope[] = ['user', 'project']
