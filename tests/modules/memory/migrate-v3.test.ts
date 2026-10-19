/**
 * 3.7 Wave 2 §4：schema v3 —— `edge.type` CHECK 增加 `related`（表重建，数据不丢）。
 *
 * 判据：
 * ① v2 库里的边在 v3 迁移后**一条不少**；
 * ② 迁移后能插入 `related` 边（旧 CHECK 会拒绝——这正是要重建表的原因）；
 * ③ 未知类型仍被 CHECK 拒绝（枚举没有变成"什么都收"）。
 */
import { describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS, latestVersion, migrate } from '../../../modules/memory/migrate.js'
import { nodeSqlite, columnNames, tableNames, userVersion } from './helpers.js'

function v2Db() {
  const db = nodeSqlite(':memory:')
  migrate(db, { steps: SCHEMA_MIGRATIONS.filter(step => step.version <= 2) })
  expect(userVersion(db)).toBe(2)
  db.prepare(
    'INSERT INTO edge (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)',
  ).run('a', 'b', 'supersedes', 1)
  return db
}

describe('v3：edge.related（3.7 Wave 2）', () => {
  it('v2 → v3：旧边保留、结构仍是四列、版本推进', () => {
    const db = v2Db()
    const outcome = migrate(db)
    expect(outcome.from).toBe(2)
    expect(outcome.to).toBe(latestVersion(SCHEMA_MIGRATIONS))
    expect(userVersion(db)).toBe(latestVersion(SCHEMA_MIGRATIONS))
    expect(columnNames(db, 'edge')).toEqual(['from_id', 'to_id', 'type', 'created_at'])

    const rows = db.prepare('SELECT from_id, to_id, type FROM edge').all()
    expect(rows).toEqual([{ from_id: 'a', to_id: 'b', type: 'supersedes' }])
  })

  it('迁移后可写 related；未知类型仍被拒', () => {
    const db = v2Db()
    migrate(db)
    expect(() =>
      db.prepare('INSERT INTO edge (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)').run('b', 'c', 'related', 2),
    ).not.toThrow()
    expect(() =>
      db.prepare('INSERT INTO edge (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)').run('c', 'd', 'nonsense', 3),
    ).toThrow()
    const types = db.prepare('SELECT type, count(*) AS n FROM edge GROUP BY type ORDER BY type').all()
    expect(types).toEqual([
      { type: 'related', n: 1 },
      { type: 'supersedes', n: 1 },
    ])
  })

  it('v4：效用账本/反馈审计/阈值状态三张表存在且结构正确（纯加法，不动 memory 行）', () => {
    const db = v2Db()
    db.prepare(
      'INSERT INTO memory (id, scope, kind, text, content_hash, source_ref, asserted_by, observed_at, last_used_at, payload_fts) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('m1', 'user', 'semantic', '旧结论', 'h', 'session:s1#1', 'model', 1, 1, '旧 结论')
    migrate(db)
    const tables = tableNames(db)
    expect(tables).toEqual(expect.arrayContaining(['memory_utility', 'memory_feedback', 'memory_meta']))
    expect(columnNames(db, 'memory_utility')).toEqual([
      'memory_id', 'exposed', 'used', 'useful', 'wrong', 'stale', 'noise', 'last_at',
      'pending_wrong_at', 'pending_wrong_session', 'archived_at', 'archive_reason',
    ])
    expect(columnNames(db, 'memory_feedback')).toEqual(['id', 'memory_id', 'action', 'session_id', 'at', 'detail'])
    expect(db.prepare('SELECT meta.value AS v FROM memory_meta meta WHERE meta.key = ?').get('lexical.floor.q')).toEqual({
      v: '0.5',
    })
    // 旧记忆没有账本行（"从未曝光"由读取侧按基率处理，不伪造 0 计数）
    expect(db.prepare('SELECT count(*) AS n FROM memory_utility').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT text FROM memory WHERE id = ?').get('m1')).toEqual({ text: '旧结论' })
  })
})
