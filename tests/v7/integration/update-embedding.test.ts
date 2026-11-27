import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HASH_MODEL, HashEmbedder, hashEmbed } from '../../../packages/v7/src/adapters/embedding/index.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { deriveSearchText } from '../../../packages/v7/src/domain/validation.js'
import { handleEmbedJob } from '../../../packages/v7/src/jobs/embed.js'
import type { JobOptions, JobQueue, Logger } from '../../../packages/v7/src/ports/jobs.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const OLD_TITLE = '生产连接池排障记录'
const OLD_BODY = '旧正文：生产连接池泄漏导致 ECONNRESET，重启连接池后恢复'
const NEW_TITLE = '生产连接池排障记录（已修复）'
const NEW_BODY = '新正文：连接池泄漏已修复，改为重试并延长超时'
const FIXED_AT = '2026-11-22T00:00:00.000Z'
const FIXED_CLOCK = { now: () => new Date(FIXED_AT), iso: () => FIXED_AT }

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

interface Enqueued {
  readonly name: string
  readonly payload: unknown
  readonly options?: JobOptions
}

/** 真实 PostgreSQL + 内存队列：队列载荷由真实 `handleEmbedJob` 消费，不依赖 pg-boss 轮询。 */
class RecordingQueue implements JobQueue {
  readonly enqueued: Enqueued[] = []
  enqueueError?: Error

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async enqueue(name: string, payload: unknown, options?: JobOptions): Promise<string | null> {
    if (this.enqueueError !== undefined) throw this.enqueueError
    this.enqueued.push({ name, payload, ...(options === undefined ? {} : { options }) })
    return `job-${this.enqueued.length}`
  }

  async work(_name: string, _handler: (payload: unknown) => Promise<void>): Promise<void> {
    throw new Error('测试由 handleEmbedJob 直接消费载荷，不注册 pg-boss worker')
  }

  handlerFailures(): { readonly count: number; readonly recent: [] } {
    return { count: 0, recent: [] }
  }

  async finalFailures(): Promise<{ readonly count: number; readonly recent: [] }> {
    return { count: 0, recent: [] }
  }
}

function vec(values: readonly number[]): string {
  return `[${values.join(',')}]`
}

describe('update 后嵌入失效与重建（真实 PostgreSQL）', () => {
  let db: PostgresStore
  let embedder: HashEmbedder
  let queue: RecordingQueue
  let service: UpdateService

  beforeAll(async () => {
    await prepareDatabase()
    db = store()
    embedder = new HashEmbedder()
  })

  beforeEach(async () => {
    await resetDatabase()
    queue = new RecordingQueue()
    service = new UpdateService({
      store: db,
      embedder,
      jobs: queue,
      clock: FIXED_CLOCK,
      logger: NOOP_LOGGER,
      // migrations 没有 stale 列（001_init.sql:183-189）：失效 = 删除旧向量行，让 vector 通道
      // 在重建任务完成前拿不到旧文本的向量；重建由 omb.embed 任务完成。
      invalidateEmbedding: async entityId => {
        await db.db.query('delete from omb.embedding where entity_id = $1', [entityId])
      },
    })
  })

  afterAll(async () => {
    await db?.close()
    await resetDatabase()
  })

  async function writeMemory(attrs: { readonly title: string; readonly body: string }): Promise<string> {
    const input: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: attrs.title, body: attrs.body },
    }
    const written = await db.write(normalized(input), derived(input))
    return written.entity.id
  }

  async function embeddingCount(entityId: string): Promise<number> {
    const rows = await db.db.query<{ count: string }>(
      'select count(*)::text as count from omb.embedding where entity_id = $1',
      [entityId],
    )
    return Number(rows.rows[0]?.count ?? '0')
  }

  async function embeddingModel(entityId: string): Promise<string | undefined> {
    const rows = await db.db.query<{ model: string }>(
      'select model from omb.embedding where entity_id = $1',
      [entityId],
    )
    return rows.rows[0]?.model
  }

  async function similarityTo(entityId: string, vector: readonly number[]): Promise<number | undefined> {
    const rows = await db.db.query<{ sim: number | string }>(
      'select 1 - (embedding <=> $2::vector) as sim from omb.embedding where entity_id = $1',
      [entityId, vec(vector)],
    )
    const sim = rows.rows[0]?.sim
    return sim === undefined ? undefined : Number(sim)
  }

  it('给定正文变化当 update 则删除旧向量、入队重建，消费后 vector 通道改用新向量', async () => {
    const id = await writeMemory({ title: OLD_TITLE, body: OLD_BODY })
    const before = await db.get(id)
    expect(before).toBeDefined()
    const oldText = deriveSearchText(before?.attributes ?? [])
    const oldVector = hashEmbed(oldText)
    await db.upsertEmbedding(id, embedder.model, embedder.dims, oldVector)
    expect(await embeddingCount(id)).toBe(1)
    expect((await db.vector({ embedding: oldVector, limit: 10 })).map(hit => hit.entityId)).toContain(id)

    const result = await service.update({ id, attrs: { title: NEW_TITLE, body: NEW_BODY } })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : undefined).toBe('queued')
    // 旧向量行已删除：任务还没消费时 vector 通道不该再拿旧向量召回该实体。
    expect(await embeddingCount(id)).toBe(0)
    expect((await db.vector({ embedding: oldVector, limit: 10 })).map(hit => hit.entityId)).not.toContain(id)
    expect(queue.enqueued).toHaveLength(1)
    const job = queue.enqueued[0]
    expect(job?.name).toBe('omb.embed')
    expect(job?.options?.singletonKey).toBe(`embed:${id}`)
    const payload = job?.payload as { entityId?: string; text?: string } | undefined
    expect(payload?.entityId).toBe(id)
    expect(payload?.text).toContain(NEW_BODY)

    // 队列载荷可被真实 handler 消费：向量按最新正文重建。
    await handleEmbedJob(job?.payload, { store: db, embedder })
    const fresh = await db.get(id)
    expect(fresh).toBeDefined()
    const newText = deriveSearchText(fresh?.attributes ?? [])
    const newVector = hashEmbed(newText)
    expect(await embeddingCount(id)).toBe(1)
    expect(await embeddingModel(id)).toBe(HASH_MODEL)
    expect(await similarityTo(id, newVector)).toBeGreaterThan(0.999)
    expect(await similarityTo(id, oldVector)).toBeLessThan(0.999)
    const newHits = await db.vector({ embedding: newVector, limit: 10 })
    expect(newHits.find(hit => hit.entityId === id)?.rawScore).toBeGreaterThan(0.999)
  })

  it('给定正文未变当 update 则不重复入队且旧向量保留', async () => {
    const id = await writeMemory({ title: OLD_TITLE, body: OLD_BODY })
    const before = await db.get(id)
    const oldVector = hashEmbed(deriveSearchText(before?.attributes ?? []))
    await db.upsertEmbedding(id, embedder.model, embedder.dims, oldVector)

    const result = await service.update({ id, attrs: { title: OLD_TITLE, body: OLD_BODY } })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : 'expected-none').toBeUndefined()
    expect(queue.enqueued).toHaveLength(0)
    expect(await embeddingCount(id)).toBe(1)
    expect(await similarityTo(id, oldVector)).toBeGreaterThan(0.999)
  })

  it('给定状态机只改 status 当 update 则不入队且旧向量保留', async () => {
    const stateInput: WriteEntityInput = {
      kind: 'state',
      scope: { kind: 'global' },
      title: '排障进度',
      status: 'in_progress',
      time: '2026-11-22T00:00:00.000Z',
      attrs: { body: '连接池排障进行中' },
    }
    const written = await db.write(normalized(stateInput), derived(stateInput))
    const id = written.entity.id
    const before = await db.get(id)
    const oldVector = hashEmbed(deriveSearchText(before?.attributes ?? []))
    await db.upsertEmbedding(id, embedder.model, embedder.dims, oldVector)

    const result = await service.update({ id, status: 'blocked', time: '2026-11-23T08:00:00.000Z' })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : 'expected-none').toBeUndefined()
    expect(queue.enqueued).toHaveLength(0)
    expect(await embeddingCount(id)).toBe(1)
    expect(await similarityTo(id, oldVector)).toBeGreaterThan(0.999)
  })

  it('给定 update 失败当更新则不入队也不改动旧向量', async () => {
    const id = await writeMemory({ title: OLD_TITLE, body: OLD_BODY })
    const before = await db.get(id)
    const oldVector = hashEmbed(deriveSearchText(before?.attributes ?? []))
    await db.upsertEmbedding(id, embedder.model, embedder.dims, oldVector)

    const result = await service.update({ id, expectedRevision: 99, attrs: { body: NEW_BODY } })

    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error.code).toBe('conflict')
    expect(queue.enqueued).toHaveLength(0)
    expect(await embeddingCount(id)).toBe(1)
    expect(await similarityTo(id, oldVector)).toBeGreaterThan(0.999)
    const unchanged = await db.get(id)
    expect(deriveSearchText(unchanged?.attributes ?? [])).toBe(deriveSearchText(before?.attributes ?? []))
  })
})
