/**
 * 使用计数（`use_count` / `last_used_at`）的**生产者**（M5）。
 *
 * 判据：一次**成功注入**之后，被注入的那些行 `use_count +1`、`last_used_at = 本次 now`；
 * 门控跳过或零命中时**一个字节都不写**。
 *
 * 修复前为什么失败：全仓 `SET use_count` / `markUsed` / `touchRecord` 零命中，
 * 写入侧只写常量（`useCount: 0`、`lastUsedAt: now`），而消费者有三处——
 * `retrieve.ts` 的 `usage` 先验（权重 0.12）、`consolidate.ts` 的 usage 因子与
 * "回响塌缩累加 useCount"。于是那条先验恒等于 0（死分量）、"多久没被用过"恒等于
 * "多久前写的"，且**没有任何读数能看出来**：典型的静默失效。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryRecord, MemoryStore, TaggedStore } from '../../../kernel/abi/index.js'
import { createRecallTool } from '../../../modules/memory/recall.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { capturingLogger, fixedClock, makeRecord, tempWorkspace, testPort } from './helpers.js'

interface Fixture {
  readonly store: SqliteMemoryStore
  readonly tagged: readonly TaggedStore[]
  close(): Promise<void>
}

function fixture(): Fixture {
  const ws = tempWorkspace('omb-usage-')
  const port = testPort(ws.dir)
  const store = openMemoryStore({
    scope: 'user',
    dbPath: port.userDbPath,
    port,
    logger: capturingLogger(),
    clock: fixedClock(1_000),
  })
  return {
    store,
    tagged: [{ scope: 'user', store }],
    async close(): Promise<void> {
      await store.close()
      ws.cleanup()
    },
  }
}

const TEXT = '用户偏好：所有回复用中文，术语保留英文原文'
const QUERY = '所有回复用中文'

async function seed(fx: Fixture, overrides: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const record = makeRecord({ id: 'm1', text: TEXT, observedAt: 1_000, lastUsedAt: 1_000, ...overrides })
  await fx.store.put(record)
  return record
}

describe('markUsed：唯一的使用计数写入路径', () => {
  it('只改 use_count / last_used_at：正文、溯源、失效标注一字未动；未知 id 不计', async () => {
    const fx = fixture()
    const record = await seed(fx)

    expect(await fx.store.markUsed(['m1', 'm1', 'mem_不存在'], 42)).toBe(1) // 去重；未知 id 不算更新
    const after = await fx.store.get('m1')
    expect(after?.useCount).toBe(1)
    expect(after?.lastUsedAt).toBe(42)
    // 非破坏性：这些列不是"使用"，改了就是改写历史
    expect(after?.text).toBe(record.text)
    expect(after?.sourceRef).toBe(record.sourceRef)
    expect(after?.contentHash).toBe(record.contentHash)
    expect(after?.validTo).toBeNull()
    expect(after?.supersededBy).toBeNull()
    await fx.close()
  })

  it('空列表 / 全是不存在的 id → 零更新（不产生无意义的写）', async () => {
    const fx = fixture()
    await seed(fx)
    expect(await fx.store.markUsed([], 100)).toBe(0)
    expect(await fx.store.markUsed(['', 'mem_不存在'], 100)).toBe(0)
    expect((await fx.store.get('m1'))?.useCount).toBe(0)
    await fx.close()
  })

  it('时间不是整数 → 拒绝（不静默写入垃圾时间；回执/日志能看到原因）', async () => {
    const fx = fixture()
    await seed(fx)
    await expect(fx.store.markUsed(['m1'], 1.5)).rejects.toThrow('整数毫秒')
    expect((await fx.store.get('m1'))?.useCount).toBe(0)
    await fx.close()
  })
})

describe('omb_recall：成功注入才记账', () => {
  it('两次命中同一条 → use_count 2、last_used_at = 每次调用的 now', async () => {
    const fx = fixture()
    await seed(fx)
    const clock = fixedClock(5_000)
    const tool = createRecallTool({
      resolveStores: () => fx.tagged,
      clock,
      ports: () => ({ clock }),
    })

    const first = await tool.execute({ query: QUERY, rerank: true })
    expect(first.kind).toBe('text')
    expect((await fx.store.get('m1'))?.useCount).toBe(1)
    expect((await fx.store.get('m1'))?.lastUsedAt).toBe(5_000)

    clock.advance(2_000) // now = 7000
    await tool.execute({ query: QUERY, rerank: true })
    const after = await fx.store.get('m1')
    expect(after?.useCount).toBe(2)
    expect(after?.lastUsedAt).toBe(7_000)
    // 正文与溯源不受记账影响
    expect(after?.text).toBe(TEXT)
    await fx.close()
  })

  it('门控跳过（tight 压力）→ 一个字节都不写', async () => {
    const fx = fixture()
    await seed(fx)
    const clock = fixedClock(5_000)
    const tool = createRecallTool({
      resolveStores: () => fx.tagged,
      clock,
      ports: () => ({ clock }),
      pressureBand: () => 'tight',
    })

    const outcome = await tool.execute({ query: QUERY })
    expect(outcome.text).toContain('跳过检索')
    const after = await fx.store.get('m1')
    expect(after?.useCount).toBe(0)
    expect(after?.lastUsedAt).toBe(1_000) // 仍是写入时刻，没被当成"用过"
    await fx.close()
  })

  it('零命中 → 没有"被注入的行"，一个字节都不写', async () => {
    const fx = fixture()
    await seed(fx)
    const clock = fixedClock(5_000)
    const tool = createRecallTool({
      resolveStores: () => fx.tagged,
      clock,
      ports: () => ({ clock }),
    })

    await tool.execute({ query: 'zzzz-绝不匹配的词' })
    expect((await fx.store.get('m1'))?.useCount).toBe(0)
    await fx.close()
  })

  it('记账失败：回执照常（绝不抛、绝不改召回结果），但经 onUsageFailure 上报', async () => {
    const fx = fixture()
    await seed(fx)
    const failing = new Proxy(fx.store, {
      get(target, property, receiver): unknown {
        if (property === 'markUsed') {
          return async (): Promise<number> => {
            throw new Error('use_count 列只读')
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as MemoryStore
    const failures: { reason: string; ids: readonly string[] }[] = []
    const clock = fixedClock(5_000)
    const tool = createRecallTool({
      resolveStores: () => [{ scope: 'user', store: failing }],
      clock,
      ports: () => ({ clock }),
      onUsageFailure: info => void failures.push(info),
    })

    const outcome = await tool.execute({ query: QUERY })
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain(TEXT) // 召回结果一字未变
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toContain('use_count 列只读')
    expect(failures[0]?.ids).toEqual(['m1'])
    await fx.close()
  })
})
