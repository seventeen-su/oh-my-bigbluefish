import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { createRetrievalConfig } from '../../../packages/v7/src/retrieval/config.js'
import { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const FIXED_NOW = '2026-11-22T00:00:00.000Z'
const WINDOW = { from: '2026-11-15T00:00:00.000Z', to: FIXED_NOW }

class NoVectorEmbedder implements Embedder {
  readonly model = 'no-vector'
  readonly dims = 512

  async available(): Promise<boolean> {
    return false
  }

  async embed(): Promise<number[][]> {
    throw new Error('向量不可用时不应调用 embed')
  }
}

const clock: Clock = { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }

async function writeState(db: PostgresStore, title: string, time: string): Promise<string> {
  const input: WriteEntityInput = {
    kind: 'state',
    scope: { kind: 'global' },
    title,
    status: 'in_progress',
    time,
    attrs: { body: 'deploy runbook' },
  }
  const written = await db.write(normalized(input), derived(input))
  return written.entity.id
}

async function writeMemory(db: PostgresStore, title: string): Promise<string> {
  const input: WriteEntityInput = {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body: 'deploy checklist' },
  }
  const written = await db.write(normalized(input), derived(input))
  return written.entity.id
}

/**
 * `not_started` 状态既不进 state_board（看板只收 in_progress/blocked/waiting），
 * 也不像 completed/discarded 那样被自动归档，便于只验证 time 通道。
 */
async function writeStandaloneState(db: PostgresStore, title: string, time: string): Promise<string> {
  const input: WriteEntityInput = {
    kind: 'state',
    scope: { kind: 'global' },
    title,
    status: 'not_started',
    time,
    attrs: { body: 'timezone probe' },
  }
  const written = await db.write(normalized(input), derived(input))
  return written.entity.id
}

describe('T2 omb_recall 显式 timeWindow 全局收窄（真实 PostgreSQL）', () => {
  let db: PostgresStore

  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await db?.close()
  })

  it('给定实体摘要当读取则 eventTime 来自 entity_view.event_time，无时间属性的实体不给 eventTime', async () => {
    db = store()
    const oldId = await writeState(db, 'deploy old', '2026-10-01T00:00:00.000Z')
    const newId = await writeState(db, 'deploy new', '2026-11-20T00:00:00.000Z')
    const memId = await writeMemory(db, 'deploy memory')

    const byId = new Map((await db.summaries([oldId, newId, memId])).map(item => [item.id, item]))

    expect(byId.get(oldId)?.eventTime).toBe('2026-10-01T00:00:00.000Z')
    expect(byId.get(newId)?.eventTime).toBe('2026-11-20T00:00:00.000Z')
    expect(byId.get(memId)?.eventTime).toBeUndefined()
  })

  it('给定显式 timeWindow 当召回则窗外实体不进 hits，窗内实体与无 eventTime 实体保留', async () => {
    db = store()
    const oldId = await writeState(db, 'deploy old', '2026-10-01T00:00:00.000Z')
    const newId = await writeState(db, 'deploy new', '2026-11-20T00:00:00.000Z')
    const memId = await writeMemory(db, 'deploy memory')
    const engine = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })

    const result = await engine.recall({ query: 'deploy', now: FIXED_NOW, timeWindow: WINDOW })

    const ids = result.hits.map(entry => entry.entityId)
    expect(ids).toContain(newId)
    expect(ids).toContain(memId)
    expect(ids).not.toContain(oldId)
  })

  it('给定无 timeWindow 当召回则窗外实体照常返回', async () => {
    db = store()
    const oldId = await writeState(db, 'deploy old', '2026-10-01T00:00:00.000Z')
    const newId = await writeState(db, 'deploy new', '2026-11-20T00:00:00.000Z')
    const memId = await writeMemory(db, 'deploy memory')
    const engine = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })

    const result = await engine.recall({ query: 'deploy', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId).sort()).toEqual([oldId, newId, memId].sort())
  })
})

describe('时区日历日（真实 PostgreSQL）', () => {
  let db: PostgresStore

  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await db?.close()
  })

  it('给定 Asia/Shanghai 当查询“昨天”则时间通道从当地零点开始，UTC 日历日会漏掉的记录进窗', async () => {
    db = store()
    // 当地 2026-11-21 01:00（UTC 2026-11-20 17:00）：上海日历日的「昨天」，UTC 日历日看是前天。
    const localYesterday = await writeStandaloneState(db, 'local yesterday evening', '2026-11-20T17:00:00.000Z')
    // 当地 2026-11-20 18:00：上海日历日看是前天，不属于「昨天」。
    const beforeYesterday = await writeStandaloneState(db, 'local before yesterday', '2026-11-20T10:00:00.000Z')
    const now = '2026-11-22T00:30:00.000Z'

    const shanghai = new RecallEngine({
      store: db,
      embedder: new NoVectorEmbedder(),
      clock,
      config: createRetrievalConfig({ timezone: 'Asia/Shanghai' }),
    })
    const shanghaiResult = await shanghai.recall({ query: '昨天', now })
    const plan = shanghai.compilePlan({ query: '昨天', now })

    expect(plan.time).toMatchObject({ timezone: 'Asia/Shanghai', lookback: { from: '2026-11-20T16:00:00.000Z', to: now } })
    expect(shanghaiResult.hits.map(entry => entry.entityId)).toEqual([localYesterday])
    expect(shanghaiResult.hits.map(entry => entry.entityId)).not.toContain(beforeYesterday)

    // 同一份数据用 UTC 日历日：「昨天」从 2026-11-21T00:00Z 起，两条都在窗外。
    const utc = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })
    const utcResult = await utc.recall({ query: '昨天', now })
    expect(utcResult.hits).toHaveLength(0)
  })

  it('给定请求显式时区当召回则覆盖引擎配置的时区', async () => {
    db = store()
    const tokyoYesterday = await writeStandaloneState(db, 'tokyo yesterday', '2026-11-20T16:30:00.000Z')
    const now = '2026-11-22T00:30:00.000Z'

    const engine = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })
    // UTC 引擎的默认窗口从 2026-11-21T00:00Z 开始；显式 Asia/Tokyo 后从 2026-11-20T15:00Z 开始。
    expect((await engine.recall({ query: '昨天', now })).hits).toHaveLength(0)
    const tokyo = await engine.recall({ query: '昨天', now, timezone: 'Asia/Tokyo' })
    expect(tokyo.hits.map(entry => entry.entityId)).toEqual([tokyoYesterday])
  })
})
