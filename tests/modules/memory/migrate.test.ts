/**
 * 迁移框架测试（规划 §9 阶段 2.1 的门禁）。
 *
 * 三条分支都必须有用例，且第三条要能证明**什么都没留下**：
 * ① 空库 → 升到最新 ② 未来版本 → 拒绝打开 ③ 中途失败 → 回滚且版本不变
 *
 * 另有 v2（`embedding.content_hash`）的**加法迁移**用例：旧库（v1）原地升级、
 * 历史行如实读成 NULL，且判定按"未知 → 需要重建"处理（见文件尾的 describe）。
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

/**
 * 本插件支持的**最高** schema 版本 = 步骤表最高版本。
 *
 * 为什么不写 `SCHEMA_VERSION`：那个常量在 `kernel/abi`（本轮不许碰），当前仍是 1，
 * 而库结构已经到 2 —— `store.ts` 的 `openMemoryStore` 因此显式传步骤表（理由见那里的注释）。
 * 断言"结构实际升到哪一版"必须用步骤表这个真源，否则测试会替一个过期的常量背书。
 */
const LATEST_SCHEMA = latestVersion(SCHEMA_MIGRATIONS)

/**
 * 跑到**最新结构**。
 *
 * 显式传步骤表：缺省时 `migrate()` 会做契约漂移自检（步骤表最高版本必须等于 ABI 的
 * `SCHEMA_VERSION`），而两者此刻**刻意不一致**（结构已 v2、ABI 仍是 1，`kernel/**` 由另一个
 * agent 在改）。生产侧 `openMemoryStore` 同样显式传（见那里的注释），所以这层测试与生产同路。
 */
function upToDate(db: SqliteLike): ReturnType<typeof migrate> {
  return migrate(db, { steps: SCHEMA_MIGRATIONS })
}

function memoryDb(): SqliteLike {
  return nodeSqlite(':memory:')
}

describe('迁移框架', () => {
  it('空库 → 升到最新：建表、写版本、meta 与 user_version 一致', () => {
    const db = memoryDb()
    const outcome = upToDate(db)

    expect(outcome.from).toBe(0)
    expect(outcome.to).toBe(LATEST_SCHEMA)
    expect(outcome.applied.map(step => step.version)).toEqual([1, 2])
    expect(readUserVersion(db)).toBe(LATEST_SCHEMA)

    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['memory', 'edge', 'embedding', 'meta', 'memory_fts']),
    )
    const meta = db.prepare('SELECT * FROM meta').all()
    expect(meta).toHaveLength(1)
    expect(meta[0]).toMatchObject({
      schema_version: LATEST_SCHEMA,
      embedding_model_id: null,
      embedding_dim: null,
      embedding_revision: null,
    })
  })

  it('已是最新 → 不再执行任何步骤（幂等）', () => {
    const db = memoryDb()
    upToDate(db)
    const again = upToDate(db)
    expect(again).toMatchObject({ from: LATEST_SCHEMA, to: LATEST_SCHEMA })
    expect(again.applied).toEqual([])
  })

  it('每个库独立版本号：迁移一个库不影响另一个', () => {
    const a = memoryDb()
    const b = memoryDb()
    upToDate(a)
    expect(readUserVersion(a)).toBe(LATEST_SCHEMA)
    expect(readUserVersion(b)).toBe(0)
    expect(tableNames(b)).not.toContain('memory')
  })

  it('未来版本 → 拒绝打开并抛出（不猜结构）', () => {
    const db = memoryDb()
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA + 1}`)

    let caught: unknown
    try {
      upToDate(db)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SchemaVersionAheadError)
    expect((caught as Error).message).toContain('拒绝打开')
    expect((caught as SchemaVersionAheadError).found).toBe(LATEST_SCHEMA + 1)

    // 拒绝必须是"原样不动"：版本不变、没有建任何表
    expect(userVersion(db)).toBe(LATEST_SCHEMA + 1)
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
    // 若 ABI 抬高 SCHEMA_VERSION 而没人加迁移步骤，`migrate()` 会立刻抛而不是静默停在旧结构。
    // 本轮加了 v2（`embedding.content_hash`）后，`kernel/abi` 的 `SCHEMA_VERSION`
    // 已同步抬到 2，**漂移自检重新生效**：两件事现在必须相等，
    // 且缺省步骤表路径必须能正常工作（不再需要 `openMemoryStore` 显式传表绕过）。
    expect(latestVersion(SCHEMA_MIGRATIONS)).toBe(2)
    expect(SCHEMA_VERSION).toBe(2)
    expect(LATEST_SCHEMA).toBe(SCHEMA_VERSION)

    // 缺省步骤表下**照常迁移**（自检通过）。这条同时钉住了"自检是活的"：
    // 上一轮表到 v2 而常量还是 1，缺省路径会抛"契约漂移"，正是它逼出了这次收口。
    expect(migrate(memoryDb()).to).toBe(LATEST_SCHEMA)
    // 显式传步骤表仍按设计照常迁移（那条路径**不做**漂移自检，是刻意的逃生门）
    expect(migrate(memoryDb(), { steps: SCHEMA_MIGRATIONS }).to).toBe(LATEST_SCHEMA)
    // **反向漂移没有可执行的用例了**：自检只在缺省路径上跑，而要让表比常量新
    // 就得显式传表——那正好绕过自检。上一轮之所以能测，是因为当时常量确实落后。
    // 与其留一条测不到的断言假装覆盖，不如把这件事说清楚（`SCHEMA_VERSION` 的注释里也写了）。
    expect(migrate(memoryDb(), { steps: SCHEMA_MIGRATIONS }).to).toBe(LATEST_SCHEMA)
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
    upToDate(db)
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

/**
 * v2：`embedding.content_hash` 的**加法迁移**。
 *
 * 这一层存在的理由（缺陷 B）：v1 的归属标签只说"谁来编码"，不说"编码的是哪份正文"。
 * 于是"正文被改写（`put` 同一 id）但嵌入器身份没变"时，旧向量不会被判定为陈旧，
 * 会一直拿着过时正文的向量参与检索——症状是"检索结果莫名其妙"，而不是报错。
 *
 * 下面的用例把三件必须成立的事钉住：
 * ① **旧库原地升级**（不重建库）：v1 的库打开后能继续用，历史行一条不少；
 * ② 历史行**如实读成 NULL**（未知），而不是被填上一个编出来的哈希；
 * ③ 因此它们被判为**待重建**（"未知"落在"需要重建"那一侧，不能落在"内容未变"那一侧）。
 */
describe('v2 迁移：embedding.content_hash（加法，旧库原地升级）', () => {
  /** 历史（v1）步骤：用它造一个"升级前"的库 */ 
  const v1Step = SCHEMA_MIGRATIONS.find(step => step.version === 1)

  /** 造一个 v1 的库：含一条记忆 + 一条它当年的向量（那时还没有 content_hash 列）。 */
  function legacyV1Db(): SqliteLike {
    if (v1Step === undefined) throw new Error('夹具需要 v1 步骤（迁移表被改坏了）')
    const db = memoryDb()
    v1Step.up(db)
    db.exec(`PRAGMA user_version = 1`)
    db.prepare(
      `INSERT INTO memory (id, scope, kind, text, content_hash, source_ref, asserted_by,
         observed_at, valid_to, superseded_by, last_used_at, use_count, project, payload_fts)
       VALUES ('m1', 'user', 'semantic', '长期记忆系统', 'hash-m1', 'session:t1', 'user',
         1, NULL, NULL, 1, 0, NULL, '长期 期记 记忆 记忆 系统')`,
    ).run()
    db.prepare(
      'INSERT INTO embedding (memory_id, model_id, dim, revision, vector) VALUES (?, ?, ?, ?, ?)',
    ).run('m1', 'hash-bow-256', 256, '1', new Uint8Array(1024))
    return db
  }

  /** 与 `store.ts` 的待重建谓词同一个 -- 判定：是否存在"当前身份且内容相符"的行。 */
  function stale(db: SqliteLike, modelId: string, dim: number, revision: string): readonly unknown[] {
    return db
      .prepare(
        `SELECT m.id AS id FROM memory m WHERE NOT EXISTS (
           SELECT 1 FROM embedding cur
            WHERE cur.memory_id = m.id AND cur.model_id = ? AND cur.dim = ? AND cur.revision = ?
              AND cur.content_hash IS NOT NULL AND cur.content_hash = m.content_hash)`,
      )
      .all(modelId, dim, revision)
  }

  it('旧库（v1）打开后原地升到 v2：历史行一条不少，新列可空且读成 NULL', () => {
    const db = legacyV1Db()
    const before = columnNames(db, 'embedding')
    expect(before).not.toContain('content_hash')

    const outcome = upToDate(db)
    expect(outcome.from).toBe(1)
    expect(outcome.to).toBe(LATEST_SCHEMA)
    expect(outcome.applied.map(step => step.name)).toEqual(['embedding-content-hash'])

    // ① 加法：新旧列并存，历史行仍在（没有重建库、没有丢数据）
    expect(columnNames(db, 'embedding')).toEqual([
      'memory_id',
      'model_id',
      'dim',
      'revision',
      'vector',
      'content_hash',
    ])
    const rows = db.prepare('SELECT memory_id, model_id, dim, revision, content_hash FROM embedding').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      memory_id: 'm1',
      model_id: 'hash-bow-256',
      content_hash: null, // ② 未知，绝不冒充"内容未变"
    })
    // 记忆本身也一字未动
    expect(db.prepare('SELECT text, content_hash FROM memory').get()).toMatchObject({
      text: '长期记忆系统',
      content_hash: 'hash-m1',
    })
  })

  it('历史行（content_hash 为 NULL）被判为待重建；补写当前哈希后待办清零', () => {
    const db = legacyV1Db()
    upToDate(db)

    // ③ 同身份的旧行也在待重建集合里：它的"内容是否已变"是未知 → 按需要重建处理
    expect(stale(db, 'hash-bow-256', 256, '1')).toHaveLength(1)

    // 重建（重新编码）之后这一行有了当前正文的哈希 → 不再欠账
    db.prepare(
      "UPDATE embedding SET content_hash = 'hash-m1' WHERE memory_id = 'm1' AND model_id = 'hash-bow-256'",
    ).run()
    expect(stale(db, 'hash-bow-256', 256, '1')).toHaveLength(0)
  })

  it('正文被改写后（同身份、同哈希列不变）立刻重新欠账——这正是 v1 看不见的那一类', () => {
    const db = legacyV1Db()
    upToDate(db)
    db.prepare("UPDATE embedding SET content_hash = 'hash-m1'").run()
    expect(stale(db, 'hash-bow-256', 256, '1')).toHaveLength(0)

    // 同一条记忆的正文被改写：`put` 会连同 `content_hash` 一起改（`INSERT_RECORD_SQL` 的 upsert）
    db.prepare("UPDATE memory SET text = '改写后的正文', content_hash = 'hash-m1-v2' WHERE id = 'm1'").run()
    expect(stale(db, 'hash-bow-256', 256, '1')).toHaveLength(1)
  })

  it('新库直接建到 v2：列存在、可写、可空（NULL 与有值是两件事）', () => {
    const db = memoryDb()
    upToDate(db)
    expect(columnNames(db, 'embedding')).toContain('content_hash')
    const insert = (memoryId: string, contentHash: string | null): void => {
      db.prepare(
        'INSERT INTO embedding (memory_id, model_id, dim, revision, vector, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(memoryId, 'hash-bow-256', 256, '1', new Uint8Array(4), contentHash)
    }
    expect(() => insert('m-null', null)).not.toThrow() // NULL = 未知（历史行/孤儿行的诚实表达）
    expect(() => insert('m-hash', 'h')).not.toThrow()
    expect(
      db.prepare("SELECT content_hash FROM embedding WHERE memory_id = 'm-null'").get(),
    ).toMatchObject({ content_hash: null })
    expect(
      db.prepare("SELECT content_hash FROM embedding WHERE memory_id = 'm-hash'").get(),
    ).toMatchObject({ content_hash: 'h' })
  })
})

function ftsCount(db: SqliteLike): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM memory_fts').get() as { c: number }
  return Number(row.c)
}
