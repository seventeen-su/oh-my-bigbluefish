/**
 * 3.7-M3：词法精度（下限过滤 + 短结论优先）。
 *
 * 两组判据：
 * ① `retrieve` 的后置下限：低分命中不进排名（可计数、可关闭）；
 * ② 真实 SQLite 的长度偏好：分数 = `-bm25 × N/(N+max(0,len−300))`（短结论优先）。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import {
  retrieve,
} from '../../../modules/memory/retrieve.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { ftsMatchExpr, tokenizeForFts } from '../../../modules/memory/text.js'
import { SHORT_ENTRY_CHARS, SHORT_ENTRY_GUARD_CHARS } from '../../../modules/memory/retrieve.js'
import { clockAt, fakeStore, makeRecord, tagged } from '../retrieval/fakes.js'
import { capturingLogger, fixedClock, makeRecord as sqliteRecord, tempWorkspace, testPort, type TestPort } from './helpers.js'

const CLOCK = clockAt(1_700_000_000_000)

describe('retrieve：词法分数下限（3.7-M3）', () => {
  const records = [
    makeRecord({ id: 'recap', text: '本会话回顾：改了 a.ts、b.ts、c.ts，总结完成。' }),
    makeRecord({ id: 'relevant', text: '端口固定为 8080。' }),
  ]

  it('缺省下限：低分（无关回顾）被丢弃，并计入 lexicalFloorDropped', async () => {
    const store = fakeStore({
      scope: 'user',
      records,
      search: () => [
        { id: 'recap', score: 0.2, channel: 'lexical' },
        { id: 'relevant', score: 1.2, channel: 'lexical' },
      ],
    })
    const result = await retrieve([tagged(store)], { text: '端口 回顾', limit: 5 }, { clock: CLOCK })
    expect(result.items.map(item => item.id)).toEqual(['relevant'])
    expect(result.stats.lexicalFloorMode).toBe('relative')
    expect(result.stats.lexicalFloor).toBeCloseTo(0.7, 12) // Q_0.5([0.2,1.2]) = 0.7
    expect(result.stats.lexicalFloorDropped).toBe(1)
  })

  it('lexicalFloor: 0 关闭过滤（回归对照），两条都回来', async () => {
    const store = fakeStore({
      scope: 'user',
      records,
      search: () => [
        { id: 'recap', score: 0.2, channel: 'lexical' },
        { id: 'relevant', score: 1.2, channel: 'lexical' },
      ],
    })
    const result = await retrieve([tagged(store)], { text: '端口', limit: 5, lexicalFloor: 0 }, { clock: CLOCK })
    expect(result.items.map(item => item.id).sort()).toEqual(['recap', 'relevant'])
    expect(result.stats.lexicalFloor).toBe(0)
    expect(result.stats.lexicalFloorDropped).toBe(0)
  })

  it('更高下限可配置：只留 top 命中', async () => {
    const store = fakeStore({
      scope: 'user',
      records,
      search: () => [
        { id: 'recap', score: 0.6, channel: 'lexical' },
        { id: 'relevant', score: 2.4, channel: 'lexical' },
      ],
    })
    const result = await retrieve([tagged(store)], { text: '端口', limit: 5, lexicalFloor: 1 }, { clock: CLOCK })
    expect(result.items.map(item => item.id)).toEqual(['relevant'])
    expect(result.stats.lexicalFloorDropped).toBe(1)
  })
})

describe('store.searchLexical：短结论优先的长度惩罚（3.7-M3）', () => {
  interface Fixture {
    readonly store: SqliteMemoryStore
    readonly port: TestPort
    cleanup(): Promise<void>
  }

  function fixture(): Fixture {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const logger = capturingLogger()
    const clock = fixedClock()
    const store = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })
    return {
      store,
      port,
      async cleanup(): Promise<void> {
        await store.close()
        ws.cleanup()
      },
    }
  }

  const short = sqliteRecord({
    id: 'short',
    text: '端口固定为 8080。',
    scope: 'user',
    kind: 'semantic',
  }) as MemoryRecord
  // 长回顾：同样命中"端口"两次，但 600+ 字符——正是实测里占首位的形状
  const long = sqliteRecord({
    id: 'long',
    text: '本会话回顾：端口配置核对完成，' + '端口'.repeat(2) + '。' + '填充内容。'.repeat(100),
    scope: 'user',
    kind: 'episodic',
  }) as MemoryRecord

  function rawBm25(port: TestPort, id: string): number {
    const expression = ftsMatchExpr(tokenizeForFts('端口'))
    const row = port.databases[0]?.raw
      .prepare(
        `SELECT -bm25(memory_fts) AS score
           FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
          WHERE memory_fts MATCH ? AND m.id = ?`,
      )
      .get(expression, id) as { score?: number } | undefined
    return Number(row?.score ?? 0)
  }

  it('分数严格等于 -bm25 × 长度偏好系数；短条目排在长回顾之前', async () => {
    const f = fixture()
    await f.store.put(short)
    await f.store.put(long)

    const hits = await f.store.searchLexical({ text: '端口', scope: 'user', limit: 5 })
    const byId = new Map(hits.map(hit => [hit.id, hit.score]))
    const shortScore = byId.get('short')
    const longScore = byId.get('long')
    expect(shortScore).toBeDefined()
    expect(longScore).toBeDefined()

    const numerator = SHORT_ENTRY_CHARS + SHORT_ENTRY_GUARD_CHARS
    const expectedShort = rawBm25(f.port, 'short') * numerator / (numerator + Math.max(0, short.text.length - SHORT_ENTRY_CHARS))
    const expectedLong = rawBm25(f.port, 'long') * numerator / (numerator + Math.max(0, long.text.length - SHORT_ENTRY_CHARS))
    expect(shortScore).toBeCloseTo(expectedShort, 6)
    expect(longScore).toBeCloseTo(expectedLong, 6)
    // 长度惩罚确实被施加：长条目的分数明显低于原始 bm25
    expect(longScore ?? 0).toBeLessThan(rawBm25(f.port, 'long'))

    expect(hits[0]?.id, '短结论应排在长回顾之前').toBe('short')
    await f.cleanup()
  })
})
