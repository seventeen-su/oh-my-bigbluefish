/**
 * 隐私擦除的**磁盘层**验证：`forget` 必须把 WAL 截断。
 *
 * ## 为什么需要这条
 *
 * 自检报告追问"硬删除是物理抹除还是只是逻辑不可召回"。逐字节扫过真实库，
 * 结论是**后者**——删掉一条记忆后：
 *
 * | 层 | 被删文本 |
 * | --- | --- |
 * | `memory` / `memory_fts` / `embedding` / `edge`（SQL） | 0 |
 * | **WAL 原始字节** | **6 处，全文可读** |
 *
 * 三个 PRAGMA 决定了它：`journal_mode=wal`（写入先进 WAL）、
 * `secure_delete=0`（删除不覆写字节）、`wal_autocheckpoint=1000`（远没到阈值）。
 *
 * `forget` 是**隐私擦除**路径，它的语义是"内容不再存在"，不是"查不到了"。
 * 所以删完必须 `PRAGMA wal_checkpoint(TRUNCATE)`。
 *
 * ## 判据
 *
 * 不在 SQL 层断言（那只能证明"查不到"），而是**扫文件字节**——
 * 这正是发现该缺陷的方法，也只有它能验证它。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openMemoryStore } from '../../../modules/memory/store.js'

/** 在被扫文件里数这段字节出现几次。 */
function countBytes(path: string, needle: string): number {
  try {
    const buf = readFileSync(path)
    const target = Buffer.from(needle, 'utf8')
    let count = 0
    let at = 0
    while ((at = buf.indexOf(target, at)) !== -1) {
      count += 1
      at += 1
    }
    return count
  } catch {
    return 0
  }
}

describe('隐私擦除：WAL 必须被截断（否则"硬删除"只是措辞）', () => {
  let dir = ''
  let dbPath = ''

  beforeEach(() => {
    dir = join(tmpdir(), `omb-wal-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    dbPath = join(dir, 'probe.db')
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言结论
    }
  })

  const logger = { warn: (): void => {}, info: (): void => {}, debug: (): void => {} }

  it('写入后在 WAL 里有明文；forget 之后 WAL 里不再有', async () => {
    const mark = 'ZZWALTRUNCATE5N8V3K'
    const port = { userDbPath: dbPath, createDirs: false, openDatabase: (p: string) => new DatabaseSync(p) }

    // 先建 schema：`put` 要求表已存在
    const boot = openMemoryStore({ scope: 'user', dbPath, port, logger, clock: { now: () => 1 } })
    await boot.close()

    const store = openMemoryStore({ scope: 'user', dbPath, port, logger, clock: { now: () => 1000 } })
    await store.put({
      id: 'p1',
      scope: 'user',
      kind: 'episodic',
      text: `探针 ${mark} 结束`,
      contentHash: 'aa',
      sourceRef: 'probe:wal',
      assertedBy: 'model',
      observedAt: 1,
      useCount: 0,
      validTo: null,
      supersededBy: null,
      lastUsedAt: 1,
      project: null,
    })

    // 基线：明文确实在 WAL 里（否则这条测试本身没有意义）
    expect(countBytes(`${dbPath}-wal`, mark), '写入后 WAL 里应当有明文').toBeGreaterThan(0)

    const removed = await store.forget(['p1'])
    expect(removed).toBe(1)

    // 判据：WAL 截断，明文不再留在一个可以直接 strings 捞出来的文件里
    expect(countBytes(`${dbPath}-wal`, mark), 'forget 后 WAL 里不该再有明文').toBe(0)

    // 逻辑层同样干净（两个层面都要成立）
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }
    expect(rows.n).toBe(0)
    db.close()
    await store.close()
  })
})
