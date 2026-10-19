/**
 * 3.7 Wave 2 §4：`related` 边（自动连边 + 1-hop 召回扩展）。
 *
 * 判据：
 * ① 实体键抽取确定性；共享 <2 个键不连边（单键重合不算同一主题）；
 * ② 真实 SQLite：写入后连边成功，`walkGraph` 能走通；
 * ③ `retrieve({ expandRelated:true })` 把邻居补进来，分数 = 父条目 × 0.5，通道标 `graph`；
 * ④ 关闭扩展时结果与旧行为一致。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import { autoLinkRelated, extractEntityKeys, findRelatedRecords, keysAsQuery, sharedEntityKeys } from '../../../modules/memory/link.js'
import { retrieve } from '../../../modules/memory/retrieve.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { clockAt, fakeStore, hits, makeRecord, tagged } from '../retrieval/fakes.js'
import { fixedClock, tempWorkspace, testPort, type TempWorkspace } from './helpers.js'

const CLOCK = clockAt(1_700_000_000_000)

interface Fixture {
  readonly store: SqliteMemoryStore
  cleanup(): Promise<void>
}

function fixture(): Fixture {
  const ws: TempWorkspace = tempWorkspace('omb-link-')
  const clock = fixedClock()
  const port = testPort(ws.dir)
  const logger = { debug: () => {}, info: () => {}, warn: () => {} }
  const store = openMemoryStore({ scope: 'project', dbPath: join(ws.dir, 'proj', '.omb', 'memory', 'session.db'), port, logger, clock })
  return {
    store,
    async cleanup(): Promise<void> {
      await store.close()
      ws.cleanup()
    },
  }
}

function record(id: string, text: string): MemoryRecord {
  return {
    id,
    scope: 'project',
    kind: 'episodic',
    text,
    contentHash: `hash-${id}`,
    sourceRef: `session:s1#${id}`,
    assertedBy: 'execution',
    observedAt: 1_700_000_000_000,
    validTo: null,
    supersededBy: null,
    lastUsedAt: 1_700_000_000_000,
    useCount: 0,
    project: '/work/demo',
  }
}

async function edgesOf(store: SqliteMemoryStore, fromId: string) {
  return await store.walkGraph({ fromId, depth: 1, types: ['related'] })
}

describe('实体键与自动连边（3.7 Wave 2 §4）', () => {
  it('键抽取：路径/命令/项目名；共享键计算', () => {
    const keys = extractEntityKeys(
      '修改 modules/memory/store.ts 与 tests/modules/memory/store.test.ts，跑 pnpm test 验证',
      '/work/demo',
    )
    expect(keys).toContain('path:modules/memory/store.ts')
    expect(keys).toContain('path:tests/modules/memory/store.test.ts')
    expect(keys).toContain('cmd:pnpm test')
    expect(keys.length).toBeGreaterThanOrEqual(3)
    expect(sharedEntityKeys(['path:a.ts', 'cmd:pnpm test'], ['path:a.ts', 'cmd:pnpm test', 'path:b.ts'])).toEqual([
      'cmd:pnpm test',
      'path:a.ts',
    ])
    expect(keysAsQuery(keys)).toContain('modules/memory/store.ts')
  })

  it('真实库：共享 ≥2 键 → 连 related 边；单键重合不连', async () => {
    const f = fixture()
    const a = record('a', '修改 modules/memory/store.ts 与 tests/modules/memory/store.test.ts，跑 pnpm test 通过。')
    const b = record('b', '同一次改动继续：modules/memory/store.ts 与 tests/modules/memory/store.test.ts，pnpm test 全绿。')
    const c = record('c', '只提到 modules/memory/store.ts 与 docs/readme.md 的无关记录。')
    await f.store.put(a)
    await f.store.put(b)
    await f.store.put(c)

    const linked = await autoLinkRelated(f.store, b, { now: 1_700_000_000_000, projectName: '/work/demo' })
    expect(linked.linked.map(entry => entry.toId)).toContain('a')
    expect(linked.linked.find(entry => entry.toId === 'a')?.shared.length).toBeGreaterThanOrEqual(2)

    const onlyOne = await autoLinkRelated(f.store, c, { now: 1_700_000_000_000, projectName: '/work/demo' })
    expect(onlyOne.linked).toEqual([])
    expect(onlyOne.skipped).toBe('no-overlap')

    const walk = await edgesOf(f.store, 'b')
    expect(walk.edges.some(edge => edge.type === 'related' && edge.toId === 'a')).toBe(true)
    await f.cleanup()
  })

  it('召回 1-hop 扩展：邻居进入结果、分数减半、通道标 graph；关闭时不变', async () => {
    const f = fixture()
    const parent = record('parent', '结论：端口固定为 8080（见 modules/memory/store.ts 与 tests/a.test.ts，pnpm test 验证）。')
    const neighbor = record('neighbor', '补充：modules/memory/store.ts 与 tests/a.test.ts 的端口相关测试用 pnpm test 跑。')
    await f.store.put(parent)
    await f.store.put(neighbor)
    await autoLinkRelated(f.store, neighbor, { now: 1_700_000_000_000, projectName: '/work/demo' })

    const expanded = await retrieve([{ scope: 'project', store: f.store }], { text: '端口', limit: 1, expandRelated: true }, { clock: CLOCK })
    const ids = expanded.items.map(item => item.id)
    expect(ids).toContain('parent')
    expect(ids).toContain('neighbor')
    const neighborItem = expanded.items.find(item => item.id === 'neighbor')
    const parentItem = expanded.items.find(item => item.id === 'parent')
    expect(neighborItem?.channels).toEqual(['graph'])
    expect(neighborItem?.score).toBeCloseTo((parentItem?.score ?? 0) * 0.5, 12)
    expect(expanded.stats.relatedExpanded).toBe(1)

    const plain = await retrieve([{ scope: 'project', store: f.store }], { text: '端口', limit: 1 }, { clock: CLOCK })
    expect(plain.items.map(item => item.id)).toEqual(['parent'])
    expect(plain.stats.relatedExpanded).toBe(0)
    await f.cleanup()
  })

  it('fakeStore 也支持扩展（walkGraph 走测试替身）', async () => {
    const records = [
      makeRecord({ id: 'x', scope: 'project', text: '端口 8080' }),
      makeRecord({ id: 'y', scope: 'project', text: '端口 8081' }),
    ]
    const store = fakeStore({
      scope: 'project',
      records,
      search: () => hits(['x'], 100),
      edges: [{ fromId: 'x', toId: 'y', type: 'related', createdAt: 1 }],
    })
    const result = await retrieve([tagged(store)], { text: '端口', limit: 1, expandRelated: true }, { clock: CLOCK })
    expect(result.items.map(item => item.id)).toEqual(['x', 'y'])
    expect(result.stats.relatedExpanded).toBe(1)
  })
})

describe('findRelatedRecords：只读的相关/冲突提示（v4.9.0）', () => {
  it('共享 ≥2 实体键的活跃条目被返回；自身/失效/被取代/同内容被排除', async () => {
    const f = fixture()
    const old = record('old', 'pnpm test 在 modules/memory/store.ts 上失败过')
    await f.store.put(old)
    await f.store.put({ ...old, id: 'stale', validTo: 1 })
    await f.store.put({ ...record('gone', 'pnpm test modules/memory/store.ts 已取代'), supersededBy: 'old' })
    const fresh = record('fresh', 'pnpm test modules/memory/store.ts 现在已经通过')
    await f.store.put(fresh)
    await f.store.put({ ...record('same', 'pnpm test modules/memory/store.ts 同内容'), contentHash: fresh.contentHash })

    const related = await findRelatedRecords(f.store, fresh)
    expect(related.map(item => item.record.id)).toEqual(['old'])
    expect(related[0]?.shared).toEqual(expect.arrayContaining(['cmd:pnpm test', 'path:modules/memory/store.ts']))
    await f.cleanup()
  })

  it('不足 2 个共享键不返回（避免"都用同一个文件"就报冲突）', async () => {
    const f = fixture()
    await f.store.put(record('a', '修改 modules/memory/store.ts'))
    const b = record('b', '重写 modules/memory/store.ts 的缓存层')
    await f.store.put(b)
    // 两条只共享一个 path 键（键数不足 MIN_KEYS 时直接返回空）
    expect(await findRelatedRecords(f.store, b)).toEqual([])
    await f.cleanup()
  })
})
