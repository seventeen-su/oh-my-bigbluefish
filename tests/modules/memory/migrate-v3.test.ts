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
import { nodeSqlite, columnNames, userVersion } from './helpers.js'

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
    expect(userVersion(db)).toBe(3)
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
})
