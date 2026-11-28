import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import { prepareDatabase, resetDatabase, store, normalized, derived } from './helpers.js'

const SESSION = 'session-adoption-metrics'
const TASK = 'team:task-1'
const OTHER_TASK = 'team:task-2'

async function seedMemory(title: string): Promise<string> {
  const input: WriteEntityInput = {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body: '采用证据测试' },
  }
  const db = store()
  const written = await db.write(normalized(input), derived(input))
  await db.close()
  return written.entity.id
}

describe('采用证据：Exposure → Reference → Utilization → Validation（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('Retrieved 按 distinct trace/实体计一次：重复标记注入不重复累计', async () => {
    const id = await seedMemory('Retrieved 计数测试')
    const db = store()
    await db.recordRecall([
      { traceId: 'trc_r1', entityId: id, channel: 'fulltext', rank: 1, injected: true },
      { traceId: 'trc_r1', entityId: id, channel: 'vector', rank: 2, injected: true },
    ])
    await db.recordRecall([
      { traceId: 'trc_r2', entityId: id, channel: 'fulltext', rank: 1, injected: false },
    ])
    await db.markRecallInjected('trc_r2')
    await db.markRecallInjected('trc_r2')
    const metric = await db.db.query<{ retrieved_count: string }>(
      'select retrieved_count::text from omb.adoption_metric where entity_id = $1',
      [id],
    )
    expect(metric.rows[0]?.retrieved_count).toBe('2')
    await db.close()
  })

  it('同 session+task 的重复召回只创建一个使用机会，exposures 单独累加', async () => {
    const id = await seedMemory('重复召回只算一个机会')
    const db = store()
    const exists = await db.db.query('select id from omb.entity where id = $1', [id])
    expect(exists.rowCount, `seed entity ${id} 应存在`).toBe(1)
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_1' })
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_2' })
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_3' })

    const metric = await db.db.query<{ opportunities: string; retrieved_count: string }>(
      'select opportunities::text, retrieved_count::text from omb.adoption_metric where entity_id = $1',
      [id],
    )
    expect(metric.rows[0]).toMatchObject({ opportunities: '1', retrieved_count: '0' })
    const opportunity = await db.db.query<{ exposures: number; task_id: string }>(
      'select exposures, task_id from omb.usage_opportunity where entity_id = $1 and session_id = $2',
      [id, SESSION],
    )
    expect(opportunity.rows).toEqual([{ exposures: 3, task_id: TASK }])
    await db.close()
  })

  it('同一机会重复引用/使用/验证不会重复累计成功次数；换任务才新增机会', async () => {
    const id = await seedMemory('同任务重复证据只算一次')
    const db = store()
    const exists = await db.db.query('select id from omb.entity where id = $1', [id])
    expect(exists.rowCount, `seed entity ${id} 应存在`).toBe(1)
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_1' })
    for (let index = 0; index < 3; index += 1) {
      await db.recordUsage('reference', {
        entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_1',
        kind: 'title', source: 'assistant-text',
      })
      await db.recordUsage('utilization', {
        entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_1',
        kind: 'entity-id', source: 'tool-call',
      })
      await db.recordUsage('validation', {
        entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_1',
        kind: 'user-confirmation', source: 'user-message',
      })
    }
    const first = await db.db.query<{
      opportunities: string
      referenced_count: string
      utilized_count: string
      validated_count: string
    }>(
      `select opportunities::text, referenced_count::text, utilized_count::text, validated_count::text
         from omb.adoption_metric where entity_id = $1`,
      [id],
    )
    expect(first.rows[0]).toMatchObject({
      opportunities: '1',
      referenced_count: '1',
      utilized_count: '1',
      validated_count: '1',
    })

    // 同一实体在另一任务里被使用 = 一个新的独立机会，成功次数才会再加一。
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: OTHER_TASK, traceId: 'trc_2' })
    await db.recordUsage('validation', {
      entityId: id, sessionId: SESSION, taskId: OTHER_TASK, traceId: 'trc_2',
      kind: 'user-confirmation', source: 'user-message',
    })
    const second = await db.db.query<{ opportunities: string; validated_count: string }>(
      'select opportunities::text, validated_count::text from omb.adoption_metric where entity_id = $1',
      [id],
    )
    expect(second.rows[0]).toMatchObject({ opportunities: '2', validated_count: '2' })
    await db.close()
  })

  it('引用/使用/验证/证伪写事件级证据；标题引用不写 adopted', async () => {
    const id = await seedMemory('证据层级测试记忆')
    const db = store()
    await db.recordRecall([{
      traceId: 'trc_levels', entityId: id, channel: 'fulltext', rank: 1, injected: true,
    }])
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_levels' })
    await db.recordUsage('reference', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_levels',
      kind: 'title', source: 'assistant-text',
    })
    const referenced = await db.db.query<{
      referenced_at: string | null
      adopted_at: string | null
      validated_at: string | null
    }>(
      'select referenced_at, adopted_at, validated_at from omb.recall_event where trace_id = $1 and entity_id = $2',
      ['trc_levels', id],
    )
    expect(referenced.rows[0]?.referenced_at).not.toBeNull()
    expect(referenced.rows[0]?.adopted_at).toBeNull()
    expect(referenced.rows[0]?.validated_at).toBeNull()

    await db.recordUsage('utilization', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_levels',
      kind: 'entity-id', source: 'tool-call',
    })
    await db.recordUsage('validation', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_levels',
      kind: 'user-confirmation', source: 'user-message',
      evidence: { eventType: 'user/message' },
    })
    const validated = await db.db.query<{
      utilized_at: string | null
      validated_at: string | null
      adopted_at: string | null
      validation_source: string | null
    }>(
      `select utilized_at, validated_at, adopted_at, validation_source
         from omb.recall_event where trace_id = $1 and entity_id = $2`,
      ['trc_levels', id],
    )
    expect(validated.rows[0]?.utilized_at).not.toBeNull()
    expect(validated.rows[0]?.validated_at).not.toBeNull()
    expect(validated.rows[0]?.validation_source).toBe('user-message')
    // 兼容读：只有 Validation 才写旧 adopted_at。
    expect(validated.rows[0]?.adopted_at).not.toBeNull()
    await db.close()
  })

  it('用户证伪是负向证据：refutation 计数与低的 utility/refutation 信号', async () => {
    const id = await seedMemory('被证伪的旧结论')
    const db = store()
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_refute' })
    await db.recordUsage('validation', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_refute',
      kind: 'user-confirmation', source: 'user-message',
    })
    await db.recordUsage('refutation', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_refute',
      kind: 'user-refutation', source: 'user-message',
    })
    const metric = await db.db.query<{ validated_count: string; refuted_count: string }>(
      'select validated_count::text, refuted_count::text from omb.adoption_metric where entity_id = $1',
      [id],
    )
    expect(metric.rows[0]).toMatchObject({ validated_count: '1', refuted_count: '1' })
    const entity = await db.get(id)
    expect(entity?.utilityConfidence).toBeDefined()
    expect(entity?.refutationRate).toBe(1)
    // 强验证 + 强证伪：utilityConfidence 被证伪项抵消，但仍是有限值而非 1。
    expect(entity?.utilityConfidence ?? 1).toBeLessThan(0.5)
    await db.close()
  })

  it('小样本平滑：一次 Validation 不会得到高分，随机会积累才上升', async () => {
    const id = await seedMemory('小样本平滑测试')
    const db = store()
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_smooth' })
    await db.recordUsage('validation', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_smooth',
      kind: 'user-confirmation', source: 'user-message',
    })
    const one = await db.get(id)
    expect(one?.utilityConfidence).toBeGreaterThan(0)
    expect(one?.utilityConfidence ?? 1).toBeLessThanOrEqual(0.34)

    // 再积累 5 个“被验证的机会”：后验置信度应单调上升。
    for (let index = 0; index < 5; index += 1) {
      const task = `team:smooth-${index}`
      await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: task, traceId: `trc_smooth_${index}` })
      await db.recordUsage('validation', {
        entityId: id, sessionId: SESSION, taskId: task, traceId: `trc_smooth_${index}`,
        kind: 'user-confirmation', source: 'user-message',
      })
    }
    const six = await db.get(id)
    expect(six?.utilityConfidence ?? 0).toBeGreaterThan(one?.utilityConfidence ?? 0)
    expect(six?.utilityConfidence ?? 0).toBeLessThan(1)
    await db.close()
  })

  it('access_count 单独升高不改变遗忘显著度；使用证据才会提高', async () => {
    const neutral = await seedMemory('单纯访问不应更难忘')
    const accessed = await seedMemory('高访问但无使用证据')
    const evidenced = await seedMemory('有使用证据的记忆')
    const db = store()
    await db.db.query(
      `update omb.entity set access_count = 100000 where id = $1`,
      [accessed],
    )
    await db.recordExposure({ entityId: evidenced, sessionId: SESSION, taskId: TASK, traceId: 'trc_forget' })
    await db.recordUsage('validation', {
      entityId: evidenced, sessionId: SESSION, taskId: TASK, traceId: 'trc_forget',
      kind: 'user-confirmation', source: 'user-message',
    })
    // 统一老化：三者的时间/置信度/分类相同，只差使用证据与 access_count。
    await db.db.query(
      `update omb.entity set updated_at = now() - interval '120 days' where id = any($1::text[])`,
      [[neutral, accessed, evidenced]],
    )
    await db.db.query(
      `update omb.entity_view set updated_at = now() - interval '120 days' where entity_id = any($1::text[])`,
      [[neutral, accessed, evidenced]],
    )
    const maintenance = new PostgresMaintenance(db.db)
    const rows = await maintenance.forgettable(10, 1)
    const byId = new Map(rows.map(row => [row.id, row.salience]))
    expect(byId.get(neutral)).toBeCloseTo(byId.get(accessed) ?? -1, 6)
    expect(byId.get(evidenced) ?? 0).toBeGreaterThan(byId.get(neutral) ?? 0)
    await db.close()
  })
})
