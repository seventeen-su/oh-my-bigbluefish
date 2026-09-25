/**
 * 迁移框架测试（规划 §9 阶段 2.1 的门禁）。
 *
 * 三条分支都必须有用例，且第三条要能证明**什么都没留下**：
 * ① 空库 → 升到最新 ② 未来版本 → 拒绝打开 ③ 中途失败 → 回滚且版本不变
 */
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../../../kernel/abi/index.js'
import type { SqliteLike } from '../../../kernel/abi/index.js'
import {
  SCHEMA_MIGRATIONS,
  SchemaVersionAheadError,
  latestVersion,
  migrate,
  readUserVersion,
} from '../../../modules/memory/migrate.js'
import { capturingLogger, columnNames, nodeSqlite, tableNames, userVersion } from './helpers.js'

function memoryDb(): SqliteLike {
  return nodeSqlite(':memory:')
}

describe('迁移框架', () => {
  it('空库 → 升到最新：建表、写版本、meta 与 user_version 一致', () => {
    const db = memoryDb()
    const outcome = migrate(db)

    expect(outcome.from).toBe(0)
    expect(outcome.to).toBe(SCHEMA_VERSION)
    expect(outcome.applied.map(step => step.version)).toEqual([1])
    expect(readUserVersion(db)).toBe(SCHEMA_VERSION)

    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['memory', 'edge', 'embedding', 'meta', 'memory_fts']),
    )
    const meta = db.prepare('SELECT * FROM meta').all()
    expect(meta).toHaveLength(1)
    expect(meta[0]).toMatchObject({
      schema_version: SCHEMA_VERSION,
      embedding_model_id: null,
      embedding_dim: null,
      embedding_revision: null,
    })
  })

  it('已是最新 → 不再执行任何步骤（幂等）', () => {
    const db = memoryDb()
    migrate(db)
    const again = migrate(db)
    expect(again).toMatchObject({ from: SCHEMA_VERSION, to: SCHEMA_VERSION })
    expect(again.applied).toEqual([])
  })

  it('每个库独立版本号：迁移一个库不影响另一个', () => {
    const a = memoryDb()
    const b = memoryDb()
    migrate(a)
    expect(readUserVersion(a)).toBe(SCHEMA_VERSION)
    expect(readUserVersion(b)).toBe(0)
    expect(tableNames(b)).not.toContain('memory')
  })

  it('未来版本 → 拒绝打开并抛出（不猜结构）', () => {
    const db = memoryDb()
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)

    let caught: unknown
    try {
      migrate(db)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SchemaVersionAheadError)
    expect((caught as Error).message).toContain('拒绝打开')
    expect((caught as SchemaVersionAheadError).found).toBe(SCHEMA_VERSION + 1)

    // 拒绝必须是"原样不动"：版本不变、没有建任何表
    expect(userVersion(db)).toBe(SCHEMA_VERSION + 1)
    expect(tableNames(db)).not.toContain('memory')
  })

  it('中途失败 → 回滚且版本不变、异常向上抛', () => {
    const db = memoryDb()
    const logger = capturingLogger()
    const steps = [
      { version: 1, name: 'ok', up: (target: SqliteLike) => target.exec('CREATE TABLE a (x TEXT)') },
      {
        version: 2,
        name: 'boom',
        up: () => {
          throw new Error('故意失败')
        },
      },
    ]

    expect(() => migrate(db, { steps, logger })).toThrow('故意失败')
    // 整次升级原子：前一步的产物也不得留下——否则就是"半迁移"状态
    expect(readUserVersion(db)).toBe(0)
    expect(tableNames(db)).not.toContain('a')
  })

  it('回滚失败也不吞掉原始异常', () => {
    const db = memoryDb()
    let closed = false
    const hostile: SqliteLike = {
      exec(sql: string): void {
        if (sql === 'ROLLBACK') throw new Error('回滚也失败了')
        if (closed) throw new Error('已关闭')
        db.exec(sql)
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => {
        closed = true
      },
    }
    const steps = [
      {
        version: 1,
        name: 'boom',
        up: () => {
          throw new Error('原始异常')
        },
      },
    ]
    expect(() => migrate(hostile, { steps })).toThrow('原始异常')
  })

  it('迁移表最高版本与 SCHEMA_VERSION 一致（契约漂移自检）', () => {
    // 若 ABI 抬高 SCHEMA_VERSION 而没人加迁移步骤，`migrate()` 会立刻抛而不是静默停在旧结构
    expect(latestVersion(SCHEMA_MIGRATIONS)).toBe(SCHEMA_VERSION)
  })

  it('步骤版本非递增 → 立刻抛（编程错误，不是数据问题）', () => {
    const db = memoryDb()
    const steps = [
      { version: 2, name: 'second', up: () => {} },
      { version: 1, name: 'first', up: () => {} },
    ]
    expect(() => migrate(db, { steps })).toThrow(/严格递增/)
    expect(readUserVersion(db)).toBe(0)
  })

  it('步骤版本非法（0 / 小数）→ 拒绝执行', () => {
    expect(() => migrate(memoryDb(), { steps: [{ version: 0, name: 'zero', up: () => {} }] })).toThrow(
      /必须是 ≥1 的整数/,
    )
    expect(() =>
      migrate(memoryDb(), { steps: [{ version: 1.5, name: 'half', up: () => {} }] }),
    ).toThrow(/必须是 ≥1 的整数/)
  })
})

describe('v1 结构（规划 §5.2 的字段依据）', () => {
  function migrated(): SqliteLike {
    const db = memoryDb()
    migrate(db)
    return db
  }

  it('edge 表没有 weight 列，只有四种字段', () => {
    expect(columnNames(migrated(), 'edge')).toEqual(['from_id', 'to_id', 'type', 'created_at'])
  })

  it('memory 表字段齐全（含 source_ref/asserted_by/valid_to/content_hash）', () => {
    expect(columnNames(migrated(), 'memory')).toEqual([
      'id',
      'scope',
      'kind',
      'text',
      'content_hash',
      'source_ref',
      'asserted_by',
      'observed_at',
      'valid_to',
      'superseded_by',
      'last_used_at',
      'use_count',
      'project',
      'payload_fts',
    ])
  })

  it('source_ref 非空是结构性约束：空串写不进去', () => {
    const db = migrated()
    const insert = (sourceRef: string): void => {
      db.prepare(
        `INSERT INTO memory (id, scope, kind, text, content_hash, source_ref, asserted_by,
           observed_at, valid_to, superseded_by, last_used_at, use_count, project, payload_fts)
         VALUES ('x', 'user', 'semantic', 't', 'h', ?, 'user', 1, NULL, NULL, 1, 0, NULL, 'payload')`,
      ).run(sourceRef)
    }
    expect(() => insert('')).toThrow()
    expect(() => insert('session:1#turn-2')).not.toThrow()
  })

  it('embedding 的 CHECK(dim > 0) 与归属标签非空：不可归属的向量在结构层就被拒', () => {
    const db = migrated()
    const insert = (modelId: string, dim: number, revision: string): void => {
      db.prepare(
        'INSERT INTO embedding (memory_id, model_id, dim, revision, vector) VALUES (?, ?, ?, ?, ?)',
      ).run('m1', modelId, dim, revision, new Uint8Array(4))
    }
    expect(() => insert('hash-bow-256', 0, '1')).toThrow()
    expect(() => insert('', 256, '1')).toThrow()
    expect(() => insert('hash-bow-256', 256, '')).toThrow()
    expect(() => insert('hash-bow-256', 256, '1')).not.toThrow()
  })

  it('meta 表只允许一行（结构性单例，不靠约定）', () => {
    const db = migrated()
    expect(() =>
      db.prepare("INSERT INTO meta (schema_version, embedding_model_id) VALUES (1, 'x')").run(),
    ).toThrow(/只允许一行/)
  })

  it('FTS 索引与节点表由触发器同步：删除节点后索引行同步消失', () => {
    const db = migrated()
    const insert = (id: string): void => {
      db.prepare(
        `INSERT INTO memory (id, scope, kind, text, content_hash, source_ref, asserted_by,
           observed_at, valid_to, superseded_by, last_used_at, use_count, project, payload_fts)
         VALUES (?, 'user', 'semantic', 't', 'h', 'src', 'user', 1, NULL, NULL, 1, 0, NULL, '长期 期记 记忆')`,
      ).run(id)
    }
    insert('a')
    insert('b')
    expect(ftsCount(db)).toBe(2)
    db.prepare("DELETE FROM memory WHERE id = 'a'").run()
    expect(ftsCount(db)).toBe(1)
  })
})

function ftsCount(db: SqliteLike): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM memory_fts').get() as { c: number }
  return Number(row.c)
}
