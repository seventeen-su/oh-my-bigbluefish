import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
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
