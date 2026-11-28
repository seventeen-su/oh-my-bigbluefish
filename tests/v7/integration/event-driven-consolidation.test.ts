import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'
import { RememberService } from '../../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import type { JobQueue } from '../../../packages/v7/src/ports/jobs.js'
import type { MaintenanceQueries } from '../../../packages/v7/src/ports/maintenance.js'
import { registerConsolidationJobs } from '../../../packages/v7/src/jobs/schedule.js'
import type { ConsolidationDeps } from '../../../packages/v7/src/jobs/consolidate.js'
import {
  createAttributeRenameReaction,
  createConsolidationReaction,
  createEvidenceAddedReaction,
} from '../../../plugin/v7/reactions.js'
import type { ReactionContext } from '../../../packages/v7/src/app/outbox/index.js'
import { prepareDatabase, resetDatabase, store } from './helpers.js'

/**
 * 事件驱动链路（真实 PostgreSQL + 队列替身）：
 * - EntityCreated/EntityPatched → 定向 dedupe/conflict/reference-rot/clue-promote；
 * - AttributeRenamed → 逐实体定向 reference-rot；
 * - EvidenceAdded → 定向 clue-promote；
 * - 带 entityId 的 pg-boss 载荷只运行定向 handler，不调用“最近 N 条”全量兜底查询。
 */

const NOW = '2026-11-29T00:00:00.000Z'
const clock = { now: () => new Date(NOW), iso: () => NOW }
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

interface Enqueued {
  readonly name: string
  readonly payload: JsonValue
  readonly options: unknown
}

function queueWith(sink: Enqueued[]): JobQueue {
  return {
    start: async () => {},
    stop: async () => {},
    enqueue: async (name: string, payload: unknown, options?: unknown) => {
      sink.push({ name, payload: payload as JsonValue, options })
      return null
    },
    work: async () => {},
    handlerFailures: () => ({ count: 0, recent: [] }),
    finalFailures: async () => ({ count: 0, recent: [] }),
  }
}

function eventContext(topic: string): ReactionContext {
  return { id: 1, eventId: 1, topic, attempt: 1, now: new Date(NOW) }
}

/** outbox 载荷是完整 DomainEvent：payload.payload.entityId。 */
function eventPayload(entityId: string): JsonValue {
  return { payload: { entityId, revision: 1 }, streamId: entityId } as JsonValue
}

function memory(attrs: Record<string, unknown>): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'project', projectKey: 'D:/Project/omb' },
    attrs,
  } as WriteEntityInput
}

let db: PostgresStore

beforeAll(async () => {
  await prepareDatabase()
  db = store()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await db.close()
})

describe('outbox reaction 触发的定向巩固', () => {
  it('EntityCreated（memory）只入队定向 dedupe/conflict；线索追加 clue-promote', async () => {
    const sink: Enqueued[] = []
    const remember = new RememberService({ store: db, clock })
    const fact = await remember.remember(memory({ title: '普通事实', body: '内容' }), { commandId: 'e1' })
    const clueInput = { ...memory({ title: '线索', body: '内容' }), category: 'clue' } as WriteEntityInput
    const clue = await remember.remember(clueInput, { commandId: 'e2' })
    if (!fact.ok) throw new Error(`事实写入失败：${fact.error.code} ${fact.error.message}`)
    if (!clue.ok) throw new Error(`线索写入失败：${clue.error.code} ${clue.error.message}`)

    const reaction = createConsolidationReaction({ store: db, queue: queueWith(sink), logger })
    await reaction.run({
      id: 1,
      eventId: 1,
      topic: 'EntityCreated',
      attempts: 0,
      payload: eventPayload(fact.value.entity.id),
      availableAt: NOW,
      createdAt: NOW,
    }, eventContext('EntityCreated'))

    expect(sink.map(item => item.name)).toEqual(['omb.dedupe', 'omb.conflict'])
    expect(sink[0]?.payload).toMatchObject({ entityId: fact.value.entity.id, trigger: 'entity-event' })
    expect(sink[0]?.options).toMatchObject({ singletonKey: `dedupe:${fact.value.entity.id}` })

    sink.length = 0
    await reaction.run({
      id: 2,
      eventId: 2,
      topic: 'EntityCreated',
      attempts: 0,
      payload: eventPayload(clue.value.entity.id),
      availableAt: NOW,
      createdAt: NOW,
    }, eventContext('EntityCreated'))
    expect(sink.map(item => item.name)).toEqual(['omb.dedupe', 'omb.conflict', 'omb.clue-promote'])
  })

  it('EntityPatched 额外入队定向 reference-rot（targetEntityId = 被改实体）', async () => {
    const sink: Enqueued[] = []
    const remember = new RememberService({ store: db, clock })
    const written = await remember.remember(memory({ title: '被更新实体', body: '内容' }), { commandId: 'p1' })
    if (!written.ok) throw new Error('写入失败')
    const reaction = createConsolidationReaction({ store: db, queue: queueWith(sink), logger })
    await reaction.run({
      id: 3,
      eventId: 3,
      topic: 'EntityPatched',
      attempts: 0,
      payload: eventPayload(written.value.entity.id),
      availableAt: NOW,
      createdAt: NOW,
    }, eventContext('EntityPatched'))
    expect(sink.map(item => item.name)).toEqual(['omb.dedupe', 'omb.conflict', 'omb.reference-rot'])
    expect(sink[2]?.payload).toMatchObject({ entityId: written.value.entity.id, targetEntityId: written.value.entity.id })
  })

  it('AttributeRenamed 对每个受影响实体逐个入队 reference-rot；缺 entityIds 明确抛错', async () => {
    const sink: Enqueued[] = []
    const reaction = createAttributeRenameReaction({ queue: queueWith(sink) })
    await reaction.run({
      id: 4,
      eventId: 4,
      topic: 'AttributeRenamed',
      attempts: 0,
      payload: { payload: { entityIds: ['mem_a', 'mem_b'] }, streamId: 'attr:x->y' } as JsonValue,
      availableAt: NOW,
      createdAt: NOW,
    }, eventContext('AttributeRenamed'))
    expect(sink.map(item => (item.payload as Record<string, JsonValue>)['entityId'])).toEqual(['mem_a', 'mem_b'])
    expect(sink.every(item => item.name === 'omb.reference-rot')).toBe(true)
    await expect(reaction.run({
      id: 5,
      eventId: 5,
      topic: 'AttributeRenamed',
      attempts: 0,
      payload: { payload: {} } as JsonValue,
      availableAt: NOW,
      createdAt: NOW,
    }, eventContext('AttributeRenamed'))).rejects.toThrow('entityIds')
  })

  it('EvidenceAdded 入队定向 clue-promote', async () => {
    const sink: Enqueued[] = []
    const reaction = createEvidenceAddedReaction({ queue: queueWith(sink) })
    await reaction.run({
      id: 6,
      eventId: 6,
      topic: 'EvidenceAdded',
      attempts: 0,
      payload: eventPayload('mem_018f2a00-0000-7000-8000-000000000001'),
      availableAt: NOW,
      createdAt: NOW,
    }, eventContext('EvidenceAdded'))
    expect(sink.map(item => item.name)).toEqual(['omb.clue-promote'])
    expect(sink[0]?.options).toMatchObject({ singletonKey: 'clue-promote:mem_018f2a00-0000-7000-8000-000000000001' })
  })
})

describe('定向 handler 不靠周期全量扫描', () => {
  /** 全量兜底查询一旦被调用就失败：用于证明带 entityId 的载荷走的是定向路径。 */
  function targetedDeps(): ConsolidationDeps {
    const queries = new PostgresMaintenance(db.db) as unknown as MaintenanceQueries & { recent: (limit: number) => Promise<never> }
    queries.recent = async () => { throw new Error('不应调用 recent（周期兜底）') }
    return {
      store: db,
      queries,
      updateService: new UpdateService({ store: db, clock }),
      clock,
      logger,
    }
  }

  it('registerConsolidationJobs 按载荷分流：带 entityId 走定向 dedupe，不带才跑最近 N 条兜底', async () => {
    const handlers = new Map<string, (payload: unknown) => Promise<void>>()
    const queue: JobQueue = {
      ...queueWith([]),
      work: async (name: string, handler: (payload: unknown) => Promise<void>) => {
        handlers.set(name, handler)
      },
    }
    await registerConsolidationJobs(queue, targetedDeps())
    const dedupe = handlers.get('omb.dedupe')
    expect(dedupe).toBeDefined()
    if (dedupe === undefined) return

    // 定向：实体不存在时直接返回 0，不触碰 recent。
    await expect(dedupe({ trigger: 'entity-event', entityId: 'mem_018f2a00-0000-7000-8000-000000000001' })).resolves.toBeUndefined()
    // 周期兜底：无 entityId，走 handleDedupe → queries.recent。
    await expect(dedupe({})).rejects.toThrow('不应调用 recent')
  })

  it('定向 dedupe 只处理目标实体并真的合并（不扫描其它候选）', async () => {
    const remember = new RememberService({ store: db, clock })
    const first = await remember.remember(memory({ title: 'Postgres 配置', body: '连接串与迁移说明' }), { commandId: 'd1' })
    const second = await remember.remember(memory({ title: 'Postgres 配置', body: '连接串与迁移说明。' }), { commandId: 'd2' })
    if (!first.ok || !second.ok) throw new Error('写入失败')
    expect(second.value.entity.id).not.toBe(first.value.entity.id)

    const { handleDedupeFor } = await import('../../../packages/v7/src/jobs/consolidate.js')
    const result = await handleDedupeFor(targetedDeps(), second.value.entity.id)
    expect(result.merged).toBe(1)
    // canonical 是较早的实体，较新的 duplicate 被归档。
    expect(await db.get(first.value.entity.id)).toBeDefined()
    expect(await db.get(second.value.entity.id)).toBeUndefined()
    const active = await db.db.query<{ count: string }>(
      'select count(*)::text as count from omb.entity where archived_at is null',
    )
    expect(Number(active.rows[0]?.count)).toBe(1)
  })
})
