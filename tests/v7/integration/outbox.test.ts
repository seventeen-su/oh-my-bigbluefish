import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OutboxRelay, type OutboxRelayOptions } from '../../../packages/v7/src/app/outbox/relay.js'
import { ReactionRegistry } from '../../../packages/v7/src/app/outbox/registry.js'
import type { OutboxWakeSource } from '../../../packages/v7/src/app/outbox/events.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import {
  OUTBOX_CLAIM_SQL,
  PostgresOutboxNotifier,
  PostgresOutboxStore,
} from '../../../packages/v7/src/adapters/postgres/outbox.js'

/** 独立测试库：不读写 omb_v7_test / 生产库，迁移 008 的 outbox 表由本套件自己建。 */
const DATABASE_URL = process.env.OMB_OUTBOX_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_outbox'

const clock: Clock = { now: () => new Date(), iso: () => new Date().toISOString() }

let db: PostgresDb
let store: PostgresOutboxStore

interface RowSnapshot {
  id: number
  event_id: string
  status: string
  attempts: number
  available_at: Date
  created_at: Date
  last_error: string | null
}

interface ExplainRow {
  'QUERY PLAN': unknown
}

interface PlanNode {
  node: string
  relation?: string
  index?: string
}

async function rows(): Promise<RowSnapshot[]> {
  const result = await db.query<RowSnapshot>(
    `select id::int as id, event_id, status, attempts, available_at, created_at, last_error
     from omb.outbox order by id`,
  )
  return result.rows
}

async function onlyRow(): Promise<RowSnapshot> {
  const all = await rows()
  expect(all).toHaveLength(1)
  const row = all[0]
  if (row === undefined) throw new Error('没有 outbox 行')
  return row
}

async function insertAudit(action = 'outbox-test'): Promise<number> {
  const result = await db.query<{ id: string }>(
    "insert into omb.audit_log (actor, action) values ('test', $1) returning id",
    [action],
  )
  const row = result.rows[0]
  if (row === undefined) throw new Error('没有拿到 audit_log.id')
  return Number(row.id)
}

async function appendEvent(topic: string, payload: JsonValue = {}): Promise<{ id: number; eventId: number }> {
  const eventId = await insertAudit()
  const appended = await store.append({ eventId, topic, payload })
  return { id: appended.id, eventId }
}

/** 直接写 outbox 行，不发 NOTIFY：模拟“唤醒提示丢了”的旧 pending。 */
async function rawPending(eventId: number, ageMs: number, topic = 'probe'): Promise<void> {
  await db.query(
    `insert into omb.outbox (event_id, topic, payload, created_at)
     values ($1, $2, '{}'::jsonb, now() - ($3::int * interval '1 millisecond'))`,
    [eventId, topic, ageMs],
  )
}

function relayOf(
  registry: ReactionRegistry,
  wake?: OutboxWakeSource,
  options: OutboxRelayOptions = {},
): OutboxRelay {
  return new OutboxRelay(
    { store, registry, clock, wake },
    { leaseMs: 5_000, batchSize: 25, ...options },
  )
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待条件超时')
    await new Promise<void>(resolve => {
      // 有上界的条件轮询：25ms 只是重试间隔，不是用睡眠当同步/断言（test-sleep 已显式豁免）。
      // check:ignore-next-line test-sleep
      setTimeout(resolve, 25)
    })
  }
}

function collectPlanNodes(plan: unknown, nodes: PlanNode[] = []): PlanNode[] {
  if (Array.isArray(plan)) {
    for (const item of plan) collectPlanNodes(item, nodes)
    return nodes
  }
  if (typeof plan !== 'object' || plan === null) return nodes
  const record = plan as Record<string, unknown>
  if (typeof record['Node Type'] === 'string') {
    nodes.push({
      node: record['Node Type'],
      ...(typeof record['Relation Name'] === 'string' ? { relation: record['Relation Name'] } : {}),
      ...(typeof record['Index Name'] === 'string' ? { index: record['Index Name'] } : {}),
    })
  }
  if (Array.isArray(record['Plans'])) collectPlanNodes(record['Plans'], nodes)
  if (record['Plan'] !== undefined) collectPlanNodes(record['Plan'], nodes)
  return nodes
}

describe('outbox PostgreSQL 适配器', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    db = new PostgresDb({ connectionString: DATABASE_URL })
    store = new PostgresOutboxStore(db)
  })

  beforeEach(async () => {
    await truncateAll(DATABASE_URL)
  })

  afterAll(async () => {
    await db.close()
  })

  it('给定同一 eventId 重复 append 当 claim 则只有一行，complete 后不再被领取', async () => {
    const eventId = await insertAudit()
    const first = await store.append({ eventId, topic: 'probe', payload: { a: 1 } })
    const second = await store.append({ eventId, topic: 'probe', payload: { a: 2 } })
    expect(first.inserted).toBe(true)
    expect(second).toEqual({ id: first.id, inserted: false })

    const claimed = await store.claim({ limit: 10, leaseMs: 5_000 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ id: first.id, eventId, topic: 'probe', attempts: 0, payload: { a: 1 } })
    expect(await store.complete(first.id, 0)).toBe(true)
    expect(await store.complete(first.id, 0)).toBe(false)
    expect(await store.claim({ limit: 10, leaseMs: 5_000 })).toHaveLength(0)
    expect(await store.stats()).toEqual({ pending: 0, claimed: 0, oldestAgeMs: 0 })
  })

  it('给定 writer 事务回滚当 append 则 outbox 随事务一起回滚', async () => {
    const eventId = await insertAudit()
    await expect(db.transaction(async client => {
      const appended = await store.append({ eventId, topic: 'probe', payload: { ok: true } }, client)
      expect(appended.inserted).toBe(true)
      throw new Error('writer rollback')
    })).rejects.toThrow('writer rollback')
    expect(await rows()).toHaveLength(0)
  })

  it('给定 6 条到期事件当 8 个 worker 并发 claim 则每条只被领取一次', async () => {
    for (let index = 0; index < 6; index += 1) await appendEvent('probe', { index })
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claim({ limit: 2, leaseMs: 5_000 })),
    )
    const ids = claims.flat().map(event => event.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
    const claimed = await db.query<{ count: number }>(
      "select count(*)::int as count from omb.outbox where status = 'claimed'",
    )
    expect(claimed.rows[0]?.count).toBe(6)
  })

  it('给定到期行被其它事务锁住当 claim 则立即跳过而不是阻塞等待', async () => {
    for (let index = 0; index < 3; index += 1) await appendEvent('probe', { index })
    const client = await db.pool.connect()
    try {
      await client.query('begin')
      await client.query("select id from omb.outbox where status = 'pending' for update")
      const startedAt = Date.now()
      const claimed = await store.claim({ limit: 10, leaseMs: 5_000 })
      const elapsed = Date.now() - startedAt
      expect(claimed).toHaveLength(0)
      expect(elapsed).toBeLessThan(2_000)
      await client.query('commit')
    } finally {
      await client.query('rollback').catch(() => {})
      client.release()
    }
    expect(await store.claim({ limit: 10, leaseMs: 5_000 })).toHaveLength(3)
  })

  it('给定 reaction 持续抛错当多次 tick 则 attempts 递增、退避拉长并最终死信', async () => {
    await appendEvent('flaky')
    const registry = new ReactionRegistry()
    registry.register('flaky', {
      name: 'always-fail',
      run: () => {
        throw new Error('boom')
      },
    })
    const relay = relayOf(registry, undefined, {
      retry: { maxAttempts: 3, baseDelayMs: 200, factor: 2, maxDelayMs: 1_000 },
    })

    const first = await relay.tick()
    expect(first).toMatchObject({ claimed: 1, retried: 1, dead: 0 })
    const rowAfterFirst = await onlyRow()
    expect(rowAfterFirst).toMatchObject({ status: 'pending', attempts: 1 })
    expect(rowAfterFirst.last_error).toContain('boom')
    const delayFirst = rowAfterFirst.available_at.getTime() - Date.now()
    expect(delayFirst).toBeGreaterThan(150)
    expect(await store.claim({ limit: 5, leaseMs: 5_000 })).toHaveLength(0)

    await db.query("update omb.outbox set available_at = now() - interval '1 second'")
    const second = await relay.tick()
    expect(second).toMatchObject({ claimed: 1, retried: 1, dead: 0 })
    const rowAfterSecond = await onlyRow()
    expect(rowAfterSecond.attempts).toBe(2)
    const delaySecond = rowAfterSecond.available_at.getTime() - Date.now()
    expect(delaySecond).toBeGreaterThan(delayFirst)

    await db.query("update omb.outbox set available_at = now() - interval '1 second'")
    const third = await relay.tick()
    expect(third).toMatchObject({ claimed: 1, dead: 1, retried: 0 })
    expect(await onlyRow()).toMatchObject({ status: 'dead', attempts: 3 })
    expect(await store.claim({ limit: 5, leaseMs: 5_000 })).toHaveLength(0)
    expect((await relay.stats()).lastError).toContain('boom')
  })

  it('给定旧 pending 与在途 claimed 当 stats 则 lag 只算到期未投递的行', async () => {
    const old = await appendEvent('probe')
    await db.query("update omb.outbox set created_at = now() - interval '5 seconds' where id = $1", [old.id])
    const inFlight = await appendEvent('probe')
    await db.query("update omb.outbox set available_at = now() - interval '2 seconds' where id = $1", [inFlight.id])

    const taken = await store.claim({ limit: 1, leaseMs: 5_000 })
    expect(taken.map(event => event.id)).toEqual([inFlight.id])

    const stats = await store.stats()
    expect(stats).toMatchObject({ pending: 1, claimed: 1 })
    expect(stats.oldestAgeMs).toBeGreaterThanOrEqual(4_000)
    expect(stats.oldestAgeMs).toBeLessThan(30_000)
  })

  it('给定租约到期当另一个 worker claim 则重领同一行且 attempts 不变', async () => {
    const appended = await appendEvent('probe')
    const first = await store.claim({ limit: 1, leaseMs: 200 })
    expect(first.map(event => event.id)).toEqual([appended.id])
    expect(await store.claim({ limit: 1, leaseMs: 200 })).toHaveLength(0)

    // 模拟原 worker 崩溃：租约到期，行仍是 claimed。
    await db.query("update omb.outbox set available_at = now() - interval '1 second' where id = $1", [appended.id])
    const reclaimed = await store.claim({ limit: 1, leaseMs: 5_000 })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.attempts).toBe(0)
    const id = reclaimed[0]?.id ?? 0
    expect(await store.complete(id, 0)).toBe(true)
  })

  it('给定 attempts 已变化当旧 worker 用旧 attempts complete 则 CAS 失败', async () => {
    const appended = await appendEvent('probe')
    expect(await store.claim({ limit: 1, leaseMs: 5_000 })).toHaveLength(1)
    // 第一次失败（attempts=0→1），退避到期后重新 claim：行仍是 claimed，但 attempts 已经是 1。
    expect(await store.fail({
      id: appended.id,
      expectedAttempts: 0,
      error: 'first failure',
      retryAt: new Date(Date.now() - 1_000),
    })).toBe(true)
    const retaken = await store.claim({ limit: 1, leaseMs: 5_000 })
    expect(retaken).toHaveLength(1)
    expect(retaken[0]?.attempts).toBe(1)
    // 旧 worker 手里还是 attempts=0，不能把新 worker 领取的行标记完成。
    expect(await store.complete(appended.id, 0)).toBe(false)
    expect(await store.complete(appended.id, 1)).toBe(true)
    expect(await onlyRow()).toMatchObject({ status: 'done', attempts: 1 })
  })

  it('给定已注册 reaction 当 tick 则派发一次并标记 done', async () => {
    const appended = await appendEvent('probe', { hello: '世界' })
    const seen: Array<{ eventId: number; payload: JsonValue; attempt: number }> = []
    const registry = new ReactionRegistry()
    registry.register('probe', {
      name: 'record',
      run: (event, ctx) => {
        seen.push({ eventId: event.eventId, payload: event.payload, attempt: ctx.attempt })
      },
    })
    const relay = relayOf(registry)
    const summary = await relay.tick()
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 })
    expect(seen).toEqual([{ eventId: appended.eventId, payload: { hello: '世界' }, attempt: 1 }])
    expect(await onlyRow()).toMatchObject({ status: 'done', attempts: 0 })
    expect(await relay.tick()).toMatchObject({ claimed: 0 })
    expect(await relay.stats()).toMatchObject({ delivered: 1, pending: 0, claimed: 0 })
  })

  it('给定未注册 topic 当 tick 则进入死信且错误里带 topic', async () => {
    await appendEvent('missing')
    const relay = relayOf(new ReactionRegistry())
    await expect(relay.tick()).resolves.toMatchObject({ claimed: 1, dead: 1, delivered: 0 })
    const row = await onlyRow()
    expect(row).toMatchObject({ status: 'dead', attempts: 1 })
    expect(row.last_error).toContain('missing')
  })

  it('给定 relay 空闲当 append 提交的 NOTIFY 送达则自动派发', async () => {
    const notifier = new PostgresOutboxNotifier({ connectionString: DATABASE_URL })
    const seen: number[] = []
    const registry = new ReactionRegistry()
    registry.register('probe', {
      name: 'record',
      run: event => {
        seen.push(event.eventId)
      },
    })
    const relay = relayOf(registry, notifier)
    try {
      await notifier.ready()
      relay.start()
      await relay.whenIdle()
      const appended = await appendEvent('probe', { via: 'notify' })
      await waitFor(() => seen.length === 1)
      expect(seen).toEqual([appended.eventId])
      await waitFor(async () => {
        const stats = await store.stats()
        return stats.pending === 0 && stats.claimed === 0
      })
      expect(await onlyRow()).toMatchObject({ status: 'done' })
    } finally {
      await relay.stop()
      await notifier.close()
    }
  })

  it('给定 append 在未提交事务里当事务未提交则不投递 NOTIFY，提交后才送达', async () => {
    const notifier = new PostgresOutboxNotifier({ connectionString: DATABASE_URL })
    let received = 0
    const unsubscribe = notifier.subscribe(() => {
      received += 1
    })
    try {
      await notifier.ready()
      const eventId = await insertAudit()
      await db.transaction(async client => {
        await store.append({ eventId, topic: 'probe', payload: {} }, client)
        expect(received).toBe(0)
      })
      await waitFor(() => received > 0)
    } finally {
      unsubscribe()
      await notifier.close()
    }
  })

  it('给定批内 reaction 阻塞当 stop 则未派发行归还 pending、已派发行完成，重启后继续', async () => {
    for (let index = 0; index < 3; index += 1) await appendEvent('block')
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    let runs = 0
    const registry = new ReactionRegistry()
    registry.register('block', {
      name: 'block-first',
      run: async () => {
        runs += 1
        if (runs === 1) {
          entered()
          await gate
        }
      },
    })
    const relay = relayOf(registry, undefined, { batchSize: 10 })
    const tick = relay.tick()
    await started
    const stopping = relay.stop()
    release()
    const summary = await tick
    await stopping
    expect(summary).toMatchObject({ claimed: 3, delivered: 1, released: 2 })
    expect((await rows()).map(row => row.status)).toEqual(['done', 'pending', 'pending'])

    const resumed = relayOf(registry)
    await expect(resumed.drain()).resolves.toMatchObject({ delivered: 2 })
    expect((await rows()).every(row => row.status === 'done')).toBe(true)
  })

  it('给定丢失 NOTIFY 的旧 pending 当 reconcile 则兜底并投递，新 pending 不计入', async () => {
    const seen: number[] = []
    const registry = new ReactionRegistry()
    registry.register('probe', {
      name: 'record',
      run: event => {
        seen.push(event.eventId)
      },
    })
    const relay = relayOf(registry, undefined, { reconcileGraceMs: 30_000 })
    relay.start()
    try {
      await relay.whenIdle()
      const staleEventId = await insertAudit()
      await rawPending(staleEventId, 60_000)
      const freshEventId = await insertAudit()
      await rawPending(freshEventId, 0)
      await expect(relay.reconcile()).resolves.toBe(1)
      await relay.whenIdle()
      const expected = [staleEventId, freshEventId].sort((left, right) => left - right)
      expect(seen.sort((left, right) => left - right)).toEqual(expected)
      expect((await rows()).every(row => row.status === 'done')).toBe(true)
      await expect(relay.reconcile()).resolves.toBe(0)
    } finally {
      await relay.stop()
    }
  })

  it('给定大量历史行当 EXPLAIN claim SQL 则使用 outbox_due 部分索引而不是全表扫描', async () => {
    await db.query(`
      with events as (
        insert into omb.audit_log (actor, action)
        select 'test', 'bulk' from generate_series(1, 3000)
        returning id
      ), inserted as (
        insert into omb.outbox (event_id, topic, payload, status, available_at)
        select id, 'bulk', '{}'::jsonb, 'done', now() from events
        returning id
      )
      select count(*)::int as count from inserted
    `)
    for (let index = 0; index < 5; index += 1) await appendEvent('probe', { index })
    await db.query('analyze omb.outbox')

    const explained = await db.query<ExplainRow>(
      `explain (format json) ${OUTBOX_CLAIM_SQL}`,
      [25, 30_000],
    )
    const nodes = collectPlanNodes(explained.rows[0]?.['QUERY PLAN'])
    expect(nodes.some(node => node.index === 'outbox_due')).toBe(true)
    expect(nodes.some(node => node.node === 'Seq Scan' && node.relation === 'outbox')).toBe(false)
    // outbox 上的每个扫描节点都必须是索引扫描（Update 节点本身没有 Index Name，不算扫描）。
    expect(
      nodes
        .filter(node => node.relation === 'outbox' && node.node.includes('Scan'))
        .every(node => node.index !== undefined),
    ).toBe(true)

    expect(await store.claim({ limit: 25, leaseMs: 5_000 })).toHaveLength(5)
  })
})
