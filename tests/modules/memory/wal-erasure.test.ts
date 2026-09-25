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
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

/**
 * 目录下**所有**文件里这段字节出现几次。
 *
 * 为什么不只扫 WAL：只扫 WAL 会漏掉"明文随 checkpoint 进主库空闲页"这一半——
 * 上一轮的妥协方案正是栽在这里（测试全绿而磁盘上明文仍在）。
 */
function countAllFiles(dir: string, needle: string): number {
  let total = 0
  for (const name of readdirSync(dir)) {
    total += countBytes(join(dir, name), needle)
  }
  return total
}

describe('隐私擦除：磁盘上不许留下明文（否则"硬删除"只是措辞）', () => {
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

  it('写入后在磁盘上有明文；forget 之后**整个目录**都没有', async () => {
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

    // 基线：明文确实存在（否则这条测试没有意义）
    expect(countAllFiles(dir, mark), '写入后明文应当存在于磁盘某处').toBeGreaterThan(0)

    const removed = await store.forget(['p1'])
    expect(removed).toBe(1)

    // 判据：**整个目录**里明文出现 0 次。这才是"物理抹除"。
    // 依据是两件事同时成立：连接开着 `secure_delete=ON`（删除当场覆写释放区），
    // 且 `forget` 末尾做了 checkpoint + VACUUM（清掉 WAL 与既有空闲页）。
    expect(countAllFiles(dir, mark), 'forget 后磁盘上不该还有明文').toBe(0)

    // 逻辑层同样干净（两个层面都要成立）
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }
    expect(rows.n).toBe(0)
    db.close()
    await store.close()
  })

  it('VACUUM 清掉"加固之前"就删除的明文（secure_delete 管不到那些）', () => {
    // **这条测的是最容易漏的一半**：`secure_delete` 只在**删除当下**生效。
    // 加固之前删掉的行，字节已经躺在主库空闲页里，再开 pragma 也覆写不到。
    // 只有 VACUUM（重建整库文件）能清掉。
    //
    // 没有这条用例时，"只做 checkpoint"那种妥协方案会让测试全绿，
    // 而磁盘上明文仍在——那正是被实测抓到的地方。
    const mark = 'ZZLEGACYFREELIST7H3Q8W'
    const legacyPath = join(dir, 'legacy.db')

    // 模拟加固之前的库：`secure_delete=OFF` 下写入并删除
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec('PRAGMA journal_mode = WAL')
    legacy.exec('PRAGMA secure_delete = OFF')
    legacy.exec('CREATE TABLE memory (id TEXT PRIMARY KEY, text TEXT NOT NULL)')
    legacy.prepare('INSERT INTO memory (id, text) VALUES (?, ?)').run('old1', `旧行 ${mark} 内容`)
    legacy.prepare('DELETE FROM memory WHERE id = ?').run('old1')
    legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    legacy.close()

    // 基线：明文确实还在（否则这条用例没有意义）
    expect(countAllFiles(dir, mark), '基线：加固前删除的明文应当仍在磁盘上').toBeGreaterThan(0)

    // 按修复后的方式清理
    const fixed = new DatabaseSync(legacyPath)
    fixed.exec('PRAGMA secure_delete = ON')
    fixed.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    fixed.exec('VACUUM')
    fixed.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    fixed.close()

    expect(countAllFiles(dir, mark), 'VACUUM 之后不该还有明文').toBe(0)
  })
})
