import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import type { Store } from '../../../packages/v7/src/ports/store.js'
import { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const FIXED_NOW = '2026-11-22T00:00:00.000Z'

const clock: Clock = { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }

/** 只关心 recall_event / channel error 的写入面；向量天然不可用，避免依赖 ONNX。 */
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

describe('召回事件写入与 co-recall 归因（RET-08 / RET-14，真实 PostgreSQL）', () => {
  let db: PostgresStore

  beforeAll(async () => {
    await prepareDatabase()
    db = store()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await db?.close()
  })

  async function writeMemory(title: string): Promise<string> {
    const input: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title, body: '批量召回事件测试' },
    }
    const written = await db.write(normalized(input), derived(input))
    return written.entity.id
  }

  it('给定同一 trace 多通道多实体当写 recall_event 则逐行保留通道，但不直接写 adoption', async () => {
    const a = await writeMemory('co-recall 甲')
    const b = await writeMemory('co-recall 乙')
    const channels = ['fulltext', 'vector', 'state_board']
    await db.recordRecall([
      ...channels.map((channel, index) => ({
        traceId: 'trc_batch_1', sessionId: 's1', turnId: 't1', query: 'q',
        entityId: a, channel, rank: index + 1, rawScore: 0.5, fusedScore: 0.02, injected: true,
      })),
      ...channels.map((channel, index) => ({
        traceId: 'trc_batch_1', sessionId: 's1', turnId: 't1', query: 'q',
        entityId: b, channel, rank: index + 1, rawScore: 0.5, fusedScore: 0.02, injected: true,
      })),
    ])

    const rows = await db.db.query<{
      entity_id: string
      channel: string
      injected: boolean
      injected_at: string | null
      retrieved_counted: boolean
    }>(
      `select entity_id, channel, injected, injected_at, retrieved_counted
         from omb.recall_event where trace_id = 'trc_batch_1' order by entity_id, channel`,
    )
    expect(rows.rows).toHaveLength(6)
    expect(rows.rows.every(row => row.injected && row.injected_at !== null)).toBe(true)

    // 只写事件审计；adoption 只能由注入 receipt（019）派生，不能由 recall_event 伪造。
    const metric = await db.db.query<{ entity_id: string }>('select entity_id from omb.adoption_metric')
    expect(metric.rows).toHaveLength(0)
  })

  it('给定两条 trace 且每条都多通道当 coRecallPairs 则按 trace 去重，不按通道行放大', async () => {
    const a = await writeMemory('共同召回甲')
    const b = await writeMemory('共同召回乙')
    for (const trace of ['trc_co_1', 'trc_co_2']) {
      await db.recordRecall(['fulltext', 'vector', 'state_board'].flatMap((channel, index) => [
        {
          traceId: trace, sessionId: 's-co', entityId: a, channel,
          rank: index + 1, injected: true,
        },
        {
          traceId: trace, sessionId: 's-co', entityId: b, channel,
          rank: index + 1, injected: true,
        },
      ]))
      await db.markAdopted(trace, a, 'text')
      await db.markAdopted(trace, b, 'text')
    }

    const maintenance = new PostgresMaintenance(db.db)
    const pairs = await maintenance.coRecallPairs(10)

    const [left, right] = [a, b].sort()
    // 每条 trace 3×3=9 行组合、两条 trace 共 18；真实共同召回次数只能是 2。
    expect(pairs).toEqual([{ a: left, b: right, count: 2 }])
  })

  it('给定通道失败当召回则 channel error 写进 omb.recall_channel_error，trace 可对齐 recall_event', async () => {
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'fulltext') {
          return async (): Promise<never> => {
            throw new Error('fulltext channel down')
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    }) as Store

    const engine = new RecallEngine({ store: failing, embedder: new NoVectorEmbedder(), clock })
    const result = await engine.recall({ query: '通道失败审计', now: FIXED_NOW, sessionId: 'session-error' })

    // fulltext 是唯一能命中这条中文记忆的通道；它失败后结果为空，但失败证据必须落库。
    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('no-stage-one-hits')
    expect(result.channelErrors.map(error => error.channel)).toContain('fulltext')

    const rows = await db.db.query<{
      trace_id: string
      session_id: string | null
      query: string | null
      channel: string
      code: string
      message: string
      retryable: boolean
    }>(
      'select trace_id, session_id, query, channel, code, message, retryable from omb.recall_channel_error',
    )
    expect(rows.rows).toEqual([
      expect.objectContaining({
        trace_id: result.traceId,
        session_id: 'session-error',
        query: '通道失败审计',
        channel: 'fulltext',
        code: 'internal',
        message: 'fulltext channel down',
        retryable: false,
      }),
    ])
  })

  it('给定事务级 statement_timeout 当语句超时则服务端取消并归还连接，后续查询仍可用', async () => {
    const outcome = await db.db.transactionWithin(50, client => client.query('select pg_sleep(2)'))
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as { code?: string }).code).toBe('57014')

    const alive = await db.db.query<{ ok: number }>('select 1 as ok')
    expect(alive.rows[0]?.ok).toBe(1)
  })
})

