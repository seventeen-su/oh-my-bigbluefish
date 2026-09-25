/**
 * 存储层测试（规划 §9 阶段 2.2 的门禁）。
 *
 * 用**真实 SQLite**（临时文件）：存储层的正确性一半在 SQL/触发器里，
 * mock 连接会把最有价值的部分（FTS 同步、CHECK、事务）测掉。
 *
 * 必须存在的断言（§11.2 / §9 阶段 2.1-2.2）：
 * - `getMany` 的**查询次数**（修掉旧的每 id 一次 SELECT）
 * - 中英混合的 FTS 命中
 * - 不可归属的向量被拒
 * - `valid_to` 语义
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryKind, MemoryRecord, MemoryScope, MemoryStore } from '../../../kernel/abi/index.js'
import {
  ScopeRoutingError,
  StoreClosedError,
  VectorAttributionError,
  asMemoryStore,
  asVectorStore,
  openMemoryStore,
  type SqliteMemoryStore,
} from '../../../modules/memory/store.js'
import {
  type CapturingLogger,
  type CountingSqlite,
  type TempWorkspace,
  type TestClock,
  capturingLogger,
  countingSqlite,
  delta,
  fixedClock,
  makeRecord,
  nodeSqlite,
  snapshotCounters,
  tempWorkspace,
  testPort,
} from './helpers.js'

interface Fixture {
  readonly store: SqliteMemoryStore
  readonly db: CountingSqlite
  readonly ws: TempWorkspace
  readonly logger: CapturingLogger
  readonly clock: TestClock
}

function fixtureOf(scope: MemoryScope = 'user'): Fixture {
  const ws = tempWorkspace()
  const logger = capturingLogger()
  const clock = fixedClock()
  const port = testPort(ws.dir)
  const dbPath = scope === 'user' ? port.userDbPath : join(ws.dir, 'proj', '.omb', 'memory', 'session.db')
  const store = openMemoryStore({ scope, dbPath, port, logger, clock })
  const db = port.databases[0]
  if (db === undefined) throw new Error('夹具未打开数据库')
  return { store, db, ws, logger, clock }
}

async function putAll(store: SqliteMemoryStore, records: readonly MemoryRecord[]): Promise<void> {
  for (const record of records) await store.put(record)
}

async function searchIds(
  store: SqliteMemoryStore,
  text: string,
  extra: Partial<{ kinds: readonly MemoryKind[]; limit: number }> = {},
): Promise<readonly string[]> {
  const hits = await store.searchLexical({
    text,
    scope: store.scope,
    limit: extra.limit ?? 10,
    ...(extra.kinds === undefined ? {} : { kinds: extra.kinds }),
  })
  return hits.map(hit => hit.id)
}

describe('MemoryStore：写入与读取', () => {
  it('put/get 往返保真：全部字段逐字返回（中文、null、溯源）', async () => {
    const { store, ws } = fixtureOf()
    const record = makeRecord({
      id: 'a',
      text: '用户说：回答请简洁，不要分点。',
      kind: 'semantic',
      assertedBy: 'user',
      contentHash: 'hash-a',
      sourceRef: 'session:s1#turn-3',
      observedAt: 1_000,
      validTo: null,
      supersededBy: null,
      lastUsedAt: 2_000,
      useCount: 7,
      project: 'demo',
    })
    await store.put(record)
    expect(await store.get('a')).toEqual(record)
    expect(await store.get('missing')).toBeUndefined()
    ws.cleanup()
  })

  it('同一 id 重复写入是幂等覆盖（不新增行），且 FTS 索引跟随更新', async () => {
    const { store, ws } = fixtureOf()
    await store.put(makeRecord({ id: 'a', text: '旧的记忆内容' }))
    await store.put(makeRecord({ id: 'a', text: '新的记忆内容' }))
    expect((await store.stats()).rows).toBe(1)
    expect(await store.get('a')).toMatchObject({ text: '新的记忆内容' })
    expect(await searchIds(store, '新的')).toEqual(['a'])
    expect(await searchIds(store, '旧的')).toEqual([])
    ws.cleanup()
  })

  it('缺失必要字段的写入被拒（空 sourceRef / 空 text / 非法枚举 / 负 useCount）', async () => {
    const { store, ws } = fixtureOf()
    await expect(store.put(makeRecord({ sourceRef: '' }))).rejects.toThrow(/source_ref|sourceRef/)
    await expect(store.put(makeRecord({ text: '' }))).rejects.toThrow(/text/)
    await expect(store.put(makeRecord({ kind: 'bogus' as MemoryKind }))).rejects.toThrow(/kind/)
    await expect(store.put(makeRecord({ useCount: -1 }))).rejects.toThrow(/useCount/)
    expect((await store.stats()).rows).toBe(0)
    ws.cleanup()
  })

  it('向错误的库写错 scope 直接拒绝，不静默接受', async () => {
    const { store, ws } = fixtureOf('project')
    await expect(store.put(makeRecord({ scope: 'user' }))).rejects.toBeInstanceOf(ScopeRoutingError)
    expect((await store.stats()).rows).toBe(0)
    ws.cleanup()
  })

  it('连接策略：busy_timeout=1000、WAL（写事务用 BEGIN IMMEDIATE）', () => {
    const { db, ws } = fixtureOf()
    const timeout = db.raw.prepare('PRAGMA busy_timeout').get() as { timeout?: number }
    expect(timeout.timeout).toBe(1000)
    const journal = db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode?: string }
    expect(journal.journal_mode).toBe('wal')
    ws.cleanup()
  })
})

describe('MemoryStore：getMany 必须批量（禁 N+1）', () => {
  it('N 个 id 只发一条 SELECT（旧实现每 id 一次）', async () => {
    const { store, db, ws } = fixtureOf()
    const records = Array.from({ length: 5 }, (_, index) => makeRecord({ id: `m${index}`, text: `记忆 ${index}` }))
    await putAll(store, records)

    const before = snapshotCounters(db.counters)
    const found = await store.getMany(records.map(record => record.id))
    const spent = delta(db.counters, before)

    expect(found.map(record => record.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(spent.all).toBe(1)
    expect(spent.prepare).toBe(1)
    expect(spent.get).toBe(0)
    ws.cleanup()
  })

  it('超过分块上限时按块查询（600 id → 2 条 SQL，而不是 600 条）', async () => {
    const { store, db, ws } = fixtureOf()
    const records = Array.from({ length: 600 }, (_, index) => makeRecord({ id: `b${index}`, text: `批量 ${index}` }))
    await putAll(store, records)

    const before = snapshotCounters(db.counters)
    const found = await store.getMany(records.map(record => record.id))
    const spent = delta(db.counters, before)

    expect(found).toHaveLength(600)
    expect(spent.all).toBe(2)
    ws.cleanup()
  })

  it('保持入参顺序、跳过缺失 id、空输入零查询', async () => {
    const { store, db, ws } = fixtureOf()
    await putAll(store, [makeRecord({ id: 'x' }), makeRecord({ id: 'y' })])

    const before = snapshotCounters(db.counters)
    expect((await store.getMany([])).length).toBe(0)
    expect(delta(db.counters, before).prepare).toBe(0)

    expect((await store.getMany(['y', 'missing', 'x', 'y'])).map(record => record.id)).toEqual(['y', 'x'])
    ws.cleanup()
  })
})

describe('MemoryStore：词法检索（FTS5 + JS 侧分词）', () => {
  it('中英混合语料：CJK 子串命中、英文大小写不敏感、混合文本双向命中', async () => {
    const { store, ws } = fixtureOf()
    await putAll(store, [
      makeRecord({ id: 'cjk', text: '长期记忆系统的设计要点' }),
      makeRecord({ id: 'en', text: 'Memory store uses SQLite FTS5' }),
      makeRecord({ id: 'mix', text: '用 SQLite 做 FTS5 检索' }),
      makeRecord({ id: 'other', text: '完全无关的内容' }),
    ])

    // 默认 unicode61 把连续 CJK 当一个 token，'记忆' 命中不了 '长期记忆系统'——JS 侧分词修掉这一点
    expect(await searchIds(store, '记忆')).toEqual(['cjk'])
    expect(await searchIds(store, '系统')).toEqual(['cjk'])
    expect(await searchIds(store, 'sqlite').then(ids => [...ids].sort())).toEqual(['en', 'mix'])
    expect(await searchIds(store, '检索')).toEqual(['mix'])
    expect(await searchIds(store, '不存在的词')).toEqual([])
    ws.cleanup()
  })

  it('同一通道内按相关度降序返回（排名即融合唯一允许的输入）', async () => {
    const { store, ws } = fixtureOf()
    await putAll(store, [
      makeRecord({ id: 'a', text: '记忆 记忆 记忆' }),
      makeRecord({ id: 'b', text: '记忆' }),
      makeRecord({ id: 'c', text: '无关' }),
    ])
    const hits = await store.searchLexical({ text: '记忆', scope: 'user', limit: 10 })
    expect(hits.map(hit => hit.id).sort()).toEqual(['a', 'b'])
    for (let index = 1; index < hits.length; index++) {
      expect(hits[index - 1]?.score).toBeGreaterThanOrEqual(hits[index]?.score ?? 0)
    }
    expect(hits.every(hit => hit.channel === 'lexical')).toBe(true)
    ws.cleanup()
  })

  it('kinds 过滤生效；非法 kind 被拒（不静默放宽召回）', async () => {
    const { store, ws } = fixtureOf()
    await putAll(store, [
      makeRecord({ id: 's', kind: 'semantic', text: '契约边界' }),
      makeRecord({ id: 'e', kind: 'episodic', text: '契约边界的现场记录' }),
    ])
    expect((await searchIds(store, '契约边界', { kinds: ['semantic'] })).slice().sort()).toEqual(['s'])
    expect(
      (await searchIds(store, '契约边界', { kinds: ['semantic', 'episodic'] })).slice().sort(),
    ).toEqual(['e', 's'])
    await expect(
      store.searchLexical({ text: '契约', scope: 'user', limit: 5, kinds: ['bogus' as MemoryKind] }),
    ).rejects.toThrow(/不在允许集合/)
    ws.cleanup()
  })

  it('空查询 / 纯空白不执行 MATCH（空表达式是语法错误）', async () => {
    const { store, db, ws } = fixtureOf()
    await store.put(makeRecord({ id: 'a', text: '有内容' }))
    const before = snapshotCounters(db.counters)
    expect(await searchIds(store, '')).toEqual([])
    expect(await searchIds(store, '   ')).toEqual([])
    expect(delta(db.counters, before).all).toBe(0)
    ws.cleanup()
  })

  it('FTS5 语法注入（未配对引号、保留字、通配符）不抛异常也不误命中', async () => {
    const { store, ws } = fixtureOf()
    await store.put(makeRecord({ id: 'a', text: '正常内容' }))
    expect(await searchIds(store, '"未配对')).toEqual([])
    expect(await searchIds(store, 'NEAR AND OR NOT *')).toEqual([])
    expect(await searchIds(store, 'a:b^c-d')).toEqual([])
    ws.cleanup()
  })

  it('scope 不匹配的查询返回空并记 warn（读错库不连坐整次召回）', async () => {
    const { store, logger, ws } = fixtureOf('user')
    await store.put(makeRecord({ id: 'a', text: '只有用户库里有' }))
    const hits = await store.searchLexical({ text: '用户库', scope: 'project', limit: 5 })
    expect(hits).toEqual([])
    expect(logger.warnings.join('\n')).toContain('scope=project')
    ws.cleanup()
  })

  it('limit=0 返回空且不查询', async () => {
    const { store, db, ws } = fixtureOf()
    await store.put(makeRecord({ id: 'a', text: '内容' }))
    const before = snapshotCounters(db.counters)
    expect(await store.searchLexical({ text: '内容', scope: 'user', limit: 0 })).toEqual([])
    expect(delta(db.counters, before).all).toBe(0)
    ws.cleanup()
  })
})

describe('MemoryStore：valid_to 语义（时序可回答）', () => {
  it('失效条目不被注入，但 get/getMany 仍返回（"我当时相信什么"必须可回答）', async () => {
    const { store, ws } = fixtureOf()
    await putAll(store, [
      makeRecord({ id: 'live', text: '端口是 3080' }),
      makeRecord({ id: 'dead', text: '端口是 8080', validTo: 1_700_000_500_000, supersededBy: 'live' }),
    ])

    expect(await searchIds(store, '端口')).toEqual(['live'])

    const dead = await store.get('dead')
    expect(dead?.validTo).toBe(1_700_000_500_000)
    expect(dead?.supersededBy).toBe('live')
    expect((await store.getMany(['dead', 'live'])).map(record => record.id)).toEqual(['dead', 'live'])
    ws.cleanup()
  })

  it('只写 superseded_by（未写 valid_to）同样不注入——两种失效标记都算失效', async () => {
    const { store, ws } = fixtureOf()
    await store.put(makeRecord({ id: 'stale', text: '过期结论', supersededBy: 'other' }))
    expect(await searchIds(store, '过期')).toEqual([])
    ws.cleanup()
  })

  it('valid_to 被写入后即生效：先可检索，重新 put 后不可检索', async () => {
    const { store, ws } = fixtureOf()
    const record = makeRecord({ id: 'r', text: '结论一' })
    await store.put(record)
    expect(await searchIds(store, '结论')).toEqual(['r'])
    await store.put({ ...record, validTo: 9_999, supersededBy: 'r2' })
    expect(await searchIds(store, '结论')).toEqual([])
    expect((await store.get('r'))?.validTo).toBe(9_999)
    ws.cleanup()
  })
})

describe('MemoryStore：边与图', () => {
  it('upsertEdge 幂等：同一三元组只有一行，created_at 取最新写入', async () => {
    const { store, db, ws } = fixtureOf()
    await store.upsertEdge({ fromId: 'a', toId: 'b', type: 'supersedes', createdAt: 1 })
    await store.upsertEdge({ fromId: 'a', toId: 'b', type: 'supersedes', createdAt: 2 })
    expect(db.raw.prepare('SELECT COUNT(*) AS c FROM edge').get()).toMatchObject({ c: 1 })
    const edge = db.raw.prepare('SELECT created_at FROM edge').get() as { created_at: number }
    expect(edge.created_at).toBe(2)
    ws.cleanup()
  })

  it('自环边与非法类型被拒', async () => {
    const { store, ws } = fixtureOf()
    await expect(store.upsertEdge({ fromId: 'a', toId: 'a', type: 'conflicts_with', createdAt: 1 })).rejects.toThrow(
      /from 与 to 相同/,
    )
    await expect(
      store.upsertEdge({ fromId: 'a', toId: 'b', type: 'weighted' as never, createdAt: 1 }),
    ).rejects.toThrow(/不在允许集合/)
    ws.cleanup()
  })

  it('walkGraph 无向多跳 + types 过滤 + depth 封顶，且逐层批量查询', async () => {
    const { store, db, ws } = fixtureOf()
    await putAll(store, [
      makeRecord({ id: 'a', text: '根' }),
      makeRecord({ id: 'b', text: '一' }),
      makeRecord({ id: 'c', text: '二' }),
      makeRecord({ id: 'd', text: '三' }),
    ])
    await store.upsertEdge({ fromId: 'b', toId: 'a', type: 'derived_from', createdAt: 1 })
    await store.upsertEdge({ fromId: 'c', toId: 'b', type: 'derived_from', createdAt: 2 })
    await store.upsertEdge({ fromId: 'd', toId: 'c', type: 'conflicts_with', createdAt: 3 })

    const one = await store.walkGraph({ fromId: 'a', depth: 1 })
    expect(one.nodes.map(node => node.id).sort()).toEqual(['a', 'b'])
    expect(one.edges).toHaveLength(1)

    const two = await store.walkGraph({ fromId: 'a', depth: 2 })
    expect(two.nodes.map(node => node.id).sort()).toEqual(['a', 'b', 'c'])

    const typed = await store.walkGraph({ fromId: 'a', depth: 3, types: ['derived_from'] })
    expect(typed.nodes.map(node => node.id).sort()).toEqual(['a', 'b', 'c'])

    // 逐层批量：3 跳最多 3 层 × 2 个方向 = 6 条边查询 + 1 条节点查询
    const before = snapshotCounters(db.counters)
    await store.walkGraph({ fromId: 'a', depth: 3 })
    expect(delta(db.counters, before).all).toBeLessThanOrEqual(7)

    // depth 封顶（规划 §5.5 只暴露 1|2）与 depth=0 的语义
    await expect(store.walkGraph({ fromId: 'a', depth: 0 })).resolves.toMatchObject({ edges: [] })
    ws.cleanup()
  })

  it('起点不存在时返回空图而不是抛', async () => {
    const { store, ws } = fixtureOf()
    const walk = await store.walkGraph({ fromId: 'nobody', depth: 2 })
    expect(walk).toEqual({ nodes: [], edges: [] })
    ws.cleanup()
  })
})

describe('MemoryStore：forget（唯一硬删除路径）', () => {
  it('删节点 + 同步清 FTS + 删边与向量，返回删除行数', async () => {
    const { store, db, ws } = fixtureOf()
    await putAll(store, [makeRecord({ id: 'keep', text: '保留' }), makeRecord({ id: 'drop', text: '删除我' })])
    await store.upsertEdge({ fromId: 'drop', toId: 'keep', type: 'derived_from', createdAt: 1 })
    await store.putEmbedding({
      memoryId: 'drop',
      modelId: 'hash-bow-256',
      dim: 4,
      revision: '1',
      vector: new Float32Array([1, 0, 0, 0]),
    })

    expect(await store.forget(['drop', 'missing'])).toBe(1)
    expect(await store.get('drop')).toBeUndefined()
    expect(await searchIds(store, '删除我')).toEqual([])
    expect(await store.countEmbeddings()).toBe(0)
    expect(db.raw.prepare('SELECT COUNT(*) AS c FROM edge').get()).toMatchObject({ c: 0 })
    expect((await store.stats()).rows).toBe(1)
    ws.cleanup()
  })

  it('空输入不做任何写入', async () => {
    const { store, db, ws } = fixtureOf()
    const before = snapshotCounters(db.counters)
    expect(await store.forget([])).toBe(0)
    expect(delta(db.counters, before).run).toBe(0)
    ws.cleanup()
  })
})

describe('MemoryStore：事务与串行化', () => {
  it('transaction 提交后可见；抛异常则回滚且异常向上抛（绝不吞）', async () => {
    const { store, ws } = fixtureOf()
    await store.transaction(async () => {
      await store.put(makeRecord({ id: 't1' }))
    })
    expect(await store.get('t1')).toBeDefined()

    await expect(
      store.transaction(async () => {
        await store.put(makeRecord({ id: 't2' }))
        throw new Error('业务失败')
      }),
    ).rejects.toThrow('业务失败')
    expect(await store.get('t2')).toBeUndefined()
    ws.cleanup()
  })

  it('事务内 put 并入当前事务（不死锁）', async () => {
    const { store, ws } = fixtureOf()
    await store.transaction(async () => {
      await store.put(makeRecord({ id: 'in-tx' }))
      await store.upsertEdge({ fromId: 'in-tx', toId: 'in-tx2', type: 'derived_from', createdAt: 1 })
    })
    expect(await store.get('in-tx')).toBeDefined()
    ws.cleanup()
  })

  it('嵌套 transaction 用 savepoint：内层回滚不影响外层', async () => {
    const { store, ws } = fixtureOf()
    await store.transaction(async () => {
      await store.put(makeRecord({ id: 'outer' }))
      await expect(
        store.transaction(async () => {
          await store.put(makeRecord({ id: 'inner' }))
          throw new Error('内层失败')
        }),
      ).rejects.toThrow('内层失败')
      await store.put(makeRecord({ id: 'outer2' }))
    })
    expect(await store.get('outer')).toBeDefined()
    expect(await store.get('outer2')).toBeDefined()
    expect(await store.get('inner')).toBeUndefined()
    ws.cleanup()
  })

  it('并发写入被串行化，全部落库', async () => {
    const { store, ws } = fixtureOf()
    await Promise.all(
      Array.from({ length: 25 }, (_, index) => store.put(makeRecord({ id: `c${index}`, text: `并发 ${index}` }))),
    )
    expect((await store.stats()).rows).toBe(25)
    expect((await store.getMany(Array.from({ length: 25 }, (_, index) => `c${index}`))).length).toBe(25)
    ws.cleanup()
  })
})

describe('MemoryStore：关闭', () => {
  it('close 幂等且绝不抛；关闭后的操作抛 StoreClosedError', async () => {
    const { store, ws } = fixtureOf()
    await store.put(makeRecord({ id: 'a' }))
    await expect(store.close()).resolves.toBeUndefined()
    await expect(store.close()).resolves.toBeUndefined()
    await expect(store.get('a')).rejects.toBeInstanceOf(StoreClosedError)
    await expect(store.put(makeRecord())).rejects.toBeInstanceOf(StoreClosedError)
    await expect(store.stats()).rejects.toBeInstanceOf(StoreClosedError)
    await expect(store.transaction(async () => 1)).rejects.toBeInstanceOf(StoreClosedError)
    ws.cleanup()
  })

  it('底层 close 抛异常时也不向外抛（H-1：dispose 绝不抛）', async () => {
    const ws = tempWorkspace()
    const logger = capturingLogger()
    const clock = fixedClock()
    let closeAttempts = 0
    const port = testPort(ws.dir, {
      openDatabase: path => {
        const real = countingSqlite(nodeSqlite(path))
        return {
          exec: sql => real.exec(sql),
          prepare: sql => real.prepare(sql),
          close: () => {
            closeAttempts++
            real.close()
            throw new Error('底层关闭失败')
          },
        }
      },
    })
    const store = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })

    await expect(store.close()).resolves.toBeUndefined()
    await expect(store.close()).resolves.toBeUndefined()
    expect(closeAttempts).toBe(1)
    expect(logger.warnings.join('\n')).toContain('底层关闭失败')
    ws.cleanup()
  })
})

describe('MemoryStore：可归属向量', () => {
  const vector = (overrides: Partial<Parameters<SqliteMemoryStore['putEmbedding']>[0]> = {}) => ({
    memoryId: 'm1',
    modelId: 'hash-bow-256',
    dim: 256,
    revision: '1',
    vector: new Float32Array(256),
    ...overrides,
  })

  it('首次写入声明 meta；模型或维度与 meta 不一致的向量被拒', async () => {
    const { store, ws } = fixtureOf()
    await store.putEmbedding(vector())
    expect(await store.embeddingMeta()).toEqual({ modelId: 'hash-bow-256', dim: 256, revision: '1' })

    await expect(
      store.putEmbedding(
        vector({ memoryId: 'm2', modelId: 'bge-small-zh-v1.5-512', dim: 512, vector: new Float32Array(512) }),
      ),
    ).rejects.toBeInstanceOf(VectorAttributionError)
    await expect(store.putEmbedding(vector({ memoryId: 'm3', dim: 128, vector: new Float32Array(128) }))).rejects.toBeInstanceOf(
      VectorAttributionError,
    )
    expect(await store.countEmbeddings()).toBe(1)
    ws.cleanup()
  })

  it('长度与维度不符 / NaN / 空 model_id / 空 revision 被拒', async () => {
    const { store, ws } = fixtureOf()
    await expect(store.putEmbedding(vector({ dim: 8 }))).rejects.toThrow(/长度 256 与声明维度 8 不一致/)
    await expect(store.putEmbedding(vector({ vector: new Float32Array(256).fill(Number.NaN) }))).rejects.toThrow(
      /NaN/,
    )
    await expect(store.putEmbedding(vector({ modelId: ' ' }))).rejects.toThrow(/model_id/)
    await expect(store.putEmbedding(vector({ revision: '' }))).rejects.toThrow(/revision/)
    await expect(store.putEmbedding(vector({ dim: 0, vector: new Float32Array(0) }))).rejects.toThrow(/维度非法/)
    expect(await store.countEmbeddings()).toBe(0)
    expect(await store.embeddingMeta()).toBeNull()
    ws.cleanup()
  })

  it('同模型不同 revision 允许写入（陈旧但可归属）；meta 不被陈旧写入改动', async () => {
    const { store, ws } = fixtureOf()
    await store.putEmbedding(vector({ memoryId: 'm1' }))
    await store.putEmbedding(vector({ memoryId: 'm2', revision: '2' }))

    expect(await store.countEmbeddings()).toBe(2)
    expect(await store.embeddingMeta()).toMatchObject({ revision: '1' })
    const stale = await store.listEmbeddings({ modelId: 'hash-bow-256', revision: '2' })
    expect(stale.map(item => item.memoryId)).toEqual(['m2'])
    ws.cleanup()
  })

  it('getEmbeddings 批量取回并还原 Float32Array', async () => {
    const { store, db, ws } = fixtureOf()
    const original = new Float32Array([0.5, -1, 0, 2])
    await store.putEmbedding(vector({ memoryId: 'm1', dim: 4, vector: original }))

    const before = snapshotCounters(db.counters)
    const found = await store.getEmbeddings(['m1', 'm1', 'missing'])
    const spent = delta(db.counters, before)

    expect(spent.all).toBe(1)
    expect(found).toHaveLength(1)
    expect(found[0]?.memoryId).toBe('m1')
    expect(found[0]?.vector).toBeInstanceOf(Float32Array)
    expect(Array.from(found[0]?.vector ?? [])).toEqual([0.5, -1, 0, 2])
    ws.cleanup()
  })

  it('切换嵌入器后旧向量可查询但不再匹配当前 meta', async () => {
    const { store, ws } = fixtureOf()
    await store.putEmbedding(vector({ memoryId: 'm1', dim: 4, vector: new Float32Array(4) }))
    await store.setEmbeddingMeta({ modelId: 'bge-small-zh-v1.5-512', dim: 512, revision: '1' })

    expect(await store.embeddingMeta()).toMatchObject({ modelId: 'bge-small-zh-v1.5-512' })
    const current = await store.listEmbeddings({ modelId: 'bge-small-zh-v1.5-512' })
    expect(current).toEqual([])
    expect(await store.countEmbeddings()).toBe(1)
    ws.cleanup()
  })
})

describe('MemoryStore：向量检索（searchVector）', () => {
  const attribution = { modelId: 'hash-bow-256', dim: 4, revision: '1' } as const

  /** 造一条记忆 + 一条向量。 */
  async function seed(
    store: SqliteMemoryStore,
    options: {
      readonly id: string
      readonly vec: readonly number[]
      readonly kind?: MemoryKind
      readonly modelId?: string
      readonly revision?: string
      readonly validTo?: number | null
    },
  ): Promise<void> {
    await store.put(
      makeRecord({
        id: options.id,
        kind: options.kind ?? 'semantic',
        text: `记忆 ${options.id}`,
        ...(options.validTo === undefined ? {} : { validTo: options.validTo }),
      }),
    )
    await store.putEmbedding({
      memoryId: options.id,
      modelId: options.modelId ?? attribution.modelId,
      dim: options.vec.length,
      revision: options.revision ?? attribution.revision,
      vector: Float32Array.from(options.vec),
    })
  }

  it('按余弦排序，只返回归属完全匹配的行（过滤在 SQL 里，不读全表）', async () => {
    const { store, db, ws } = fixtureOf()
    await seed(store, { id: 'exact', vec: [1, 0, 0, 0] })
    await seed(store, { id: 'orthogonal', vec: [0, 1, 0, 0] })
    // 同一模型但不同修订（换修订后残留的陈旧向量）——不许参与当前空间的比较
    await seed(store, { id: 'other-rev', vec: [1, 0, 0, 0], revision: '2' })
    // 换模型后残留的另一个向量空间：写入口会拒绝与 meta 不一致的向量，
    // 因此这里走真实序列（先 setEmbeddingMeta，再写新模型的向量）
    await store.setEmbeddingMeta({ modelId: 'other-model', dim: 4, revision: '1' })
    await store.put(makeRecord({ id: 'other-space', text: '别的空间' }))
    await store.putEmbedding({
      memoryId: 'other-space',
      modelId: 'other-model',
      dim: 4,
      revision: '1',
      vector: Float32Array.from([1, 0, 0, 0]),
    })

    const before = snapshotCounters(db.counters)
    const hits = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: attribution,
      limit: 10,
    })
    const spent = delta(db.counters, before)

    expect(hits.map(hit => hit.id)).toEqual(['exact', 'orthogonal'])
    expect(hits.every(hit => hit.channel === 'vector')).toBe(true)
    expect(hits[0]?.score).toBeCloseTo(1, 6)
    expect(hits[1]?.score).toBeCloseTo(0, 6)
    expect(spent.all).toBe(1) // 一条带归属过滤的查询，而不是"全表读进 JS"

    // 声明当前模型时，只拿到新空间的向量
    const current = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: { modelId: 'other-model', dim: 4, revision: '1' },
      limit: 10,
    })
    expect(current.map(hit => hit.id)).toEqual(['other-space'])
    ws.cleanup()
  })

  it('minScore 给了才截断；未给则不过滤（下限标定属调用方）', async () => {
    const { store, ws } = fixtureOf()
    await seed(store, { id: 'close', vec: [1, 0, 0, 0] })
    await seed(store, { id: 'far', vec: [0, 1, 0, 0] })

    const all = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: attribution,
      limit: 10,
    })
    expect(all).toHaveLength(2)

    const cut = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: attribution,
      limit: 10,
      minScore: 0.5,
    })
    expect(cut.map(hit => hit.id)).toEqual(['close'])
    ws.cleanup()
  })

  it('kinds 过滤、limit 生效；无匹配归属时返回空数组（不是错误）', async () => {
    const { store, ws } = fixtureOf()
    await seed(store, { id: 'sem', vec: [1, 0, 0, 0], kind: 'semantic' })
    await seed(store, { id: 'epi', vec: [1, 0, 0, 0], kind: 'episodic' })

    const semantic = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: attribution,
      limit: 10,
      kinds: ['semantic'],
    })
    expect(semantic.map(hit => hit.id)).toEqual(['sem'])

    const one = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: attribution,
      limit: 1,
    })
    expect(one).toHaveLength(1)

    const none = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: { modelId: 'nobody', dim: 4, revision: '1' },
      limit: 10,
    })
    expect(none).toEqual([])
    ws.cleanup()
  })

  it('失效记忆（valid_to / superseded_by）不参与向量召回——与词法通道一致', async () => {
    const { store, ws } = fixtureOf()
    await seed(store, { id: 'live', vec: [1, 0, 0, 0] })
    await seed(store, { id: 'dead', vec: [1, 0, 0, 0], validTo: 123 })

    const hits = await store.searchVector({
      embedding: Float32Array.from([1, 0, 0, 0]),
      expect: attribution,
      limit: 10,
    })
    expect(hits.map(hit => hit.id)).toEqual(['live'])
    // 溯源仍可回答"我当时相信什么"
    expect((await store.get('dead'))?.validTo).toBe(123)
    ws.cleanup()
  })

  it('归属标签不全或查询维度不符 → 明确拒绝（不静默返回空）', async () => {
    const { store, ws } = fixtureOf()
    await expect(
      store.searchVector({
        embedding: Float32Array.from([1, 0, 0, 0]),
        expect: { modelId: '', dim: 4, revision: '1' },
        limit: 5,
      }),
    ).rejects.toBeInstanceOf(VectorAttributionError)

    await expect(
      store.searchVector({
        embedding: Float32Array.from([1, 0]),
        expect: attribution,
        limit: 5,
      }),
    ).rejects.toThrow(/维度不符/)
    ws.cleanup()
  })
})

describe('MemoryStore：stats 与类型守卫', () => {
  it('stats 报作用域、行数、schema 版本；无向量时 vectors 为 null', async () => {
    const { store, ws } = fixtureOf('project')
    await putAll(store, [makeRecord({ scope: 'project', id: 'p1' }), makeRecord({ scope: 'project', id: 'p2' })])
    const stats = await store.stats()
    expect(stats).toEqual({ scope: 'project', rows: 2, schemaVersion: 1, vectors: null })
    ws.cleanup()
  })

  it('stats 在有向量时给出向量行数与当前模型/维度', async () => {
    const { store, ws } = fixtureOf()
    await store.putEmbedding({
      memoryId: 'm1',
      modelId: 'hash-bow-256',
      dim: 4,
      revision: '1',
      vector: new Float32Array(4),
    })
    expect((await store.stats()).vectors).toEqual({ rows: 1, dim: 4, modelId: 'hash-bow-256' })
    ws.cleanup()
  })

  it('asVectorStore / asMemoryStore 对非本实现返回 undefined（调用方据此降级）', () => {
    const foreign = {} as MemoryStore
    expect(asVectorStore(foreign)).toBeUndefined()
    expect(asMemoryStore(foreign)).toBeUndefined()
    const { store, ws } = fixtureOf()
    expect(asMemoryStore(store)?.dbPath).toContain('knowledge.db')
    expect(asVectorStore(store)).toBeDefined()
    ws.cleanup()
  })

  it('打开时就完成迁移：migrated 记录 0 → 最新', async () => {
    const { store, ws } = fixtureOf()
    expect(asMemoryStore(store)?.migrated).toEqual({ from: 0, to: 1 })
    ws.cleanup()
  })
})
