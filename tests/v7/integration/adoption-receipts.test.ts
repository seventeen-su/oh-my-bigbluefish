import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { ResidentTraceInput } from '../../../packages/v7/src/ports/observability.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { prepareDatabase, resetDatabase, store, normalized, derived } from './helpers.js'

const SESSION = 'session-adoption-receipts'
const TASK = 'team:receipt-task'
const OTHER_TASK = 'team:receipt-other'

async function seedMemory(title: string): Promise<string> {
  const input: WriteEntityInput = {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body: 'receipt 采用测试' },
  }
  const db = store()
  const written = await db.write(normalized(input), derived(input))
  await db.close()
  return written.entity.id
}

async function metricOf(
  db: PostgresStore,
  entityId: string,
): Promise<{ retrieved_count: string; opportunities: string; referenced_count: string; validated_count: string } | undefined> {
  const result = await db.db.query<{
    retrieved_count: string
    opportunities: string
    referenced_count: string
    validated_count: string
  }>(
    `select retrieved_count::text, opportunities::text, referenced_count::text, validated_count::text
       from omb.adoption_metric where entity_id = $1`,
    [entityId],
  )
  return result.rows[0]
}

/** 按实体 id 取处置，避免依赖 UUID 排序。 */
async function hitDispositions(
  db: PostgresStore,
  traceId: string,
): Promise<Record<string, string>> {
  const result = await db.db.query<{ entity_id: string; disposition: string }>(
    'select entity_id, disposition from omb.adoption_receipt_hit where trace_id = $1',
    [traceId],
  )
  const dispositions: Record<string, string> = {}
  for (const row of result.rows) dispositions[row.entity_id] = row.disposition
  return dispositions
}

async function receiptRow(
  db: PostgresStore,
  traceId: string,
): Promise<{ trace_id: string; kind: string; session_id: string | null; injected: boolean } | undefined> {
  const result = await db.db.query<{ trace_id: string; kind: string; session_id: string | null; injected: boolean }>(
    'select trace_id, kind, session_id, injected from omb.adoption_receipt where trace_id = $1',
    [traceId],
  )
  return result.rows[0]
}

/** 当前 resident_trace 的 section 形状；T0 额外字段 quarantined 由装配器写入。 */
function section(
  name: string,
  kept: boolean,
  entityIds: readonly string[],
  extra: { readonly quarantined?: boolean } = {},
): ResidentTraceInput['sections'][number] {
  return {
    name,
    tokens: 10,
    kept,
    text: `${name}:${entityIds.join(',')}`,
    entityIds,
    ...extra,
  }
}

describe('采用证据只从 receipt 派生（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('伪造 recall_event / markRecallInjected 不增加 Retrieved、机会或采用层级', async () => {
    const id = await seedMemory('伪造事件不应增加采用')
    const db = store()
    // 旧旁路：直接写 injected=true 的 recall_event，再调用 markRecallInjected。
    await db.recordRecall([
      { traceId: 'trc_forged', entityId: id, channel: 'fulltext', rank: 1, injected: true },
      { traceId: 'trc_forged', entityId: id, channel: 'vector', rank: 2, injected: true },
    ])
    await db.markRecallInjected('trc_forged')
    // 直接调用机会/证据 API 也没有 receipt 支撑：一律忽略。
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_forged' })
    await db.recordUsage('reference', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_forged',
      kind: 'title', source: 'assistant-text',
    })
    await db.recordUsage('validation', {
      entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_forged',
      kind: 'user-confirmation', source: 'user-message',
    })
    // 旧兼容入口同样需要 receipt：没有 kept 行就是无操作。
    await db.markAdopted('trc_forged', id, 'legacy')
    expect(await receiptRow(db, 'trc_forged')).toBeUndefined()
    expect(await metricOf(db, id)).toBeUndefined()
    const exposure = await db.db.query('select 1 from omb.usage_opportunity where entity_id = $1', [id])
    expect(exposure.rowCount).toBe(0)
    const entity = await db.get(id)
    expect(entity?.adoptionCount).toBe(0)
    // recall_event 仍然是可查的事件级审计，只是不再驱动 adoption。
    const audit = await db.db.query<{ injected: boolean; adopted_at: string | null }>(
      'select injected, adopted_at from omb.recall_event where trace_id = $1 limit 1',
      ['trc_forged'],
    )
    expect(audit.rows[0]?.injected).toBe(true)
    expect(audit.rows[0]?.adopted_at).toBeNull()
    await db.close()
  })

  it('T0 resident_trace 的 kept/quarantined/dropped 落 receipt；隔离与未展示不升采用', async () => {
    const keptId = await seedMemory('T0 正常偏好')
    const poisonId = await seedMemory('T0 投毒偏好')
    const droppedId = await seedMemory('T0 预算裁掉偏好')
    const db = store()
    const trace: ResidentTraceInput = {
      traceId: 'trc_t0_receipt',
      sessionId: SESSION,
      turnId: '1',
      budgetTokens: 300,
      usedTokens: 100,
      text: '[OMB 常驻]\n偏好：T0 正常偏好',
      sections: [
        section('header', true, []),
        section('preferences', true, [keptId]),
        section('states', true, [poisonId], { quarantined: true }),
        // 预算裁掉的整段：命中未展示，只能留 dropped 审计。
        section('preferences', false, [droppedId]),
        { name: 'injection-receipt', tokens: 10, kept: true, text: '{"keptIds":[]}', entityIds: [keptId] },
      ],
      droppedSections: ['preferences'],
    }
    await db.recordResidentTrace(trace)

    const receipt = await receiptRow(db, trace.traceId)
    expect(receipt).toMatchObject({ kind: 't0', session_id: SESSION, injected: true })
    expect(await hitDispositions(db, trace.traceId)).toEqual({
      [keptId]: 'kept',
      [poisonId]: 'quarantined',
      [droppedId]: 'dropped',
    })
    // Retrieval 只数 kept；隔离/未展示不留计数。
    expect((await metricOf(db, keptId))?.retrieved_count).toBe('1')
    expect(await metricOf(db, poisonId)).toBeUndefined()
    expect(await metricOf(db, droppedId)).toBeUndefined()

    // 正常命中可登记机会与引用；隔离/未展示被读取门禁挡住。
    await db.recordExposure({ entityId: keptId, sessionId: SESSION, taskId: TASK, traceId: trace.traceId })
    await db.recordUsage('reference', {
      entityId: keptId, sessionId: SESSION, taskId: TASK, traceId: trace.traceId,
      kind: 'title', source: 'assistant-text',
    })
    await db.recordExposure({ entityId: poisonId, sessionId: SESSION, taskId: TASK, traceId: trace.traceId })
    await db.recordUsage('validation', {
      entityId: poisonId, sessionId: SESSION, taskId: TASK, traceId: trace.traceId,
      kind: 'user-confirmation', source: 'user-message',
    })
    await db.recordExposure({ entityId: droppedId, sessionId: SESSION, taskId: TASK, traceId: trace.traceId })
    expect(await metricOf(db, keptId)).toMatchObject({
      retrieved_count: '1', opportunities: '1', referenced_count: '1', validated_count: '0',
    })
    expect(await metricOf(db, poisonId)).toBeUndefined()
    expect(await metricOf(db, droppedId)).toBeUndefined()
    await db.close()
  })

  it('T1 receipt 的 quarantined/dropped 命中不能登记机会或升级；kept 才能', async () => {
    const keptId = await seedMemory('T1 正常命中')
    const poisonId = await seedMemory('T1 隔离命中')
    const droppedId = await seedMemory('T1 未展示命中')
    const db = store()
    const traceId = 'trc_t1_receipt'
    await db.recordAdoptionReceipt({
      traceId,
      kind: 't1',
      sessionId: SESSION,
      taskId: TASK,
      injected: true,
      keptIds: [keptId, poisonId],
      quarantinedIds: [poisonId],
      droppedIds: [droppedId],
      hits: [
        { entityId: keptId, title: 'T1 正常命中' },
        { entityId: poisonId, title: 'T1 隔离命中' },
        { entityId: droppedId, title: 'T1 未展示命中' },
      ],
    })
    const receipt = await receiptRow(db, traceId)
    expect(receipt).toMatchObject({ kind: 't1', session_id: SESSION, injected: true })
    expect(await hitDispositions(db, traceId)).toEqual({
      [keptId]: 'kept',
      [poisonId]: 'quarantined',
      [droppedId]: 'dropped',
    })
    expect((await metricOf(db, keptId))?.retrieved_count).toBe('1')
    expect(await metricOf(db, poisonId)).toBeUndefined()
    expect(await metricOf(db, droppedId)).toBeUndefined()

    // 模型复述隔离命中的标题/ID：没有 kept receipt，引用/验证都不写。
    await db.recordUsage('reference', {
      entityId: poisonId, sessionId: SESSION, taskId: TASK, traceId,
      kind: 'entity-id', source: 'assistant-text',
    })
    await db.recordUsage('validation', {
      entityId: poisonId, sessionId: SESSION, taskId: TASK, traceId,
      kind: 'user-confirmation', source: 'user-message',
    })
    await db.recordExposure({ entityId: poisonId, sessionId: SESSION, taskId: TASK, traceId })
    await db.recordExposure({ entityId: droppedId, sessionId: SESSION, taskId: TASK, traceId })
    expect(await metricOf(db, poisonId)).toBeUndefined()
    expect(await metricOf(db, droppedId)).toBeUndefined()
    const opportunities = await db.db.query(
      'select entity_id from omb.usage_opportunity where entity_id = any($1::text[])',
      [[poisonId, droppedId]],
    )
    expect(opportunities.rowCount).toBe(0)

    // kept 命中正常记账；同一 receipt 重复写入仍只算一次 Retrieved。
    await db.recordExposure({ entityId: keptId, sessionId: SESSION, taskId: TASK, traceId })
    await db.recordUsage('validation', {
      entityId: keptId, sessionId: SESSION, taskId: TASK, traceId,
      kind: 'user-confirmation', source: 'user-message',
    })
    await db.recordAdoptionReceipt({
      traceId,
      kind: 't1',
      sessionId: SESSION,
      taskId: TASK,
      injected: true,
      keptIds: [keptId, poisonId],
      quarantinedIds: [poisonId],
      droppedIds: [droppedId],
    })
    expect(await metricOf(db, keptId)).toMatchObject({
      retrieved_count: '1', opportunities: '1', referenced_count: '1', validated_count: '1',
    })
    // 换 session 的同 trace 调用不能借 receipt 记账。
    await db.recordUsage('validation', {
      entityId: keptId, sessionId: 'session-other', taskId: TASK, traceId,
      kind: 'user-confirmation', source: 'user-message',
    })
    expect((await metricOf(db, keptId))?.validated_count).toBe('1')
    await db.close()
  })

  it('机会按 (entity, session, task) 去重；同一 receipt 只登记一次 exposures', async () => {
    const id = await seedMemory('机会去重测试')
    const db = store()
    const receipt = (traceId: string, taskId: string): Promise<unknown> => db.recordAdoptionReceipt({
      traceId,
      kind: 't1',
      sessionId: SESSION,
      taskId,
      injected: true,
      keptIds: [id],
      hits: [{ entityId: id, title: '机会去重测试' }],
    })
    await receipt('trc_dedupe_1', TASK)
    await receipt('trc_dedupe_1', TASK)
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_dedupe_1' })
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_dedupe_1' })
    expect(await metricOf(db, id)).toMatchObject({ retrieved_count: '1', opportunities: '1' })
    let opportunity = await db.db.query<{ exposures: number; task_id: string }>(
      'select exposures, task_id from omb.usage_opportunity where entity_id = $1',
      [id],
    )
    expect(opportunity.rows).toEqual([{ exposures: 1, task_id: TASK }])

    // 第二次注入（新 receipt）仍折叠到同一机会，只增加 exposures 与 Retrieved。
    await receipt('trc_dedupe_2', TASK)
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: TASK, traceId: 'trc_dedupe_2' })
    expect(await metricOf(db, id)).toMatchObject({ retrieved_count: '2', opportunities: '1' })
    opportunity = await db.db.query<{ exposures: number; task_id: string }>(
      'select exposures, task_id from omb.usage_opportunity where entity_id = $1',
      [id],
    )
    expect(opportunity.rows).toEqual([{ exposures: 2, task_id: TASK }])

    // 用属于 TASK 的 receipt 去登记另一个任务的机会：任务边界不匹配，拒绝。
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: OTHER_TASK, traceId: 'trc_dedupe_2' })
    expect(await metricOf(db, id)).toMatchObject({ opportunities: '1' })

    // 真正的另一个任务 receipt 才产生新机会。
    await receipt('trc_dedupe_3', OTHER_TASK)
    await db.recordExposure({ entityId: id, sessionId: SESSION, taskId: OTHER_TASK, traceId: 'trc_dedupe_3' })
    expect(await metricOf(db, id)).toMatchObject({ retrieved_count: '3', opportunities: '2' })
    await db.close()
  })

  it('T1 resident_trace 的 InjectionReceipt JSON 也能派生 kept/quarantined', async () => {
    const keptId = await seedMemory('JSONB 正常命中')
    const poisonId = await seedMemory('JSONB 隔离命中')
    const db = store()
    const trace: ResidentTraceInput = {
      traceId: 'trc_t1_jsonb',
      sessionId: SESSION,
      budgetTokens: 400,
      usedTokens: 80,
      text: '[OMB 事件召回]',
      sections: [{
        name: 'injection-receipt',
        tokens: 80,
        kept: true,
        text: JSON.stringify({
          injected: true,
          budgetTokens: 400,
          usedTokens: 80,
          textHash: 'hash',
          keptIds: [keptId, poisonId],
          quarantinedIds: [poisonId],
          droppedIds: [],
        }),
        entityIds: [keptId, poisonId],
      }],
      droppedSections: [],
    }
    await db.recordResidentTrace(trace)
    expect(await receiptRow(db, trace.traceId)).toMatchObject({ kind: 't1', session_id: SESSION })
    expect(await hitDispositions(db, trace.traceId)).toEqual({
      [keptId]: 'kept',
      [poisonId]: 'quarantined',
    })
    expect((await metricOf(db, keptId))?.retrieved_count).toBe('1')
    expect(await metricOf(db, poisonId)).toBeUndefined()
    await db.close()
  })

  it('019 能从旧 resident_trace 回填 receipt，并按 kept 重算 Retrieved（清掉可伪造计数）', async () => {
    const t0Kept = await seedMemory('回填 T0 正常')
    const t0Poison = await seedMemory('回填 T0 隔离')
    const t1Kept = await seedMemory('回填 T1 正常')
    const t1Poison = await seedMemory('回填 T1 隔离')
    const db = store()
    // 旧库只有 resident_trace、没有 019 的 receipt 表；这里直接写表模拟历史数据。
    await db.db.query(
      `insert into omb.resident_trace (
         trace_id, session_id, budget_tokens, used_tokens, text, sections, dropped_sections
       ) values ($1,$2,$3,$4,$5,$6::jsonb,'{}')`,
      [
        'trc_backfill_t0', SESSION, 300, 100, '[OMB 常驻]',
        JSON.stringify([
          { name: 'header', tokens: 5, kept: true, text: '[OMB 常驻]', entityIds: [] },
          { name: 'preferences', tokens: 20, kept: true, text: '偏好', entityIds: [t0Kept] },
          { name: 'states', tokens: 20, kept: true, text: '状态', entityIds: [t0Poison], quarantined: true },
        ]),
      ],
    )
    await db.db.query(
      `insert into omb.resident_trace (
         trace_id, session_id, budget_tokens, used_tokens, text, sections, dropped_sections
       ) values ($1,null,$2,$3,$4,$5::jsonb,'{}')`,
      [
        'trc_backfill_t1', 400, 80, '[OMB 事件召回]',
        JSON.stringify([{
          name: 'injection-receipt',
          tokens: 80,
          kept: true,
          entityIds: [t1Kept, t1Poison],
          text: JSON.stringify({
            injected: true,
            keptIds: [t1Kept, t1Poison],
            quarantinedIds: [t1Poison],
            droppedIds: [],
          }),
        }]),
      ],
    )
    // 旧口径计数（可能来自伪造的 injected recall_event）。
    await db.db.query(
      `insert into omb.adoption_metric (entity_id, retrieved_count, last_retrieved_at)
       values ($1, 99, now())`,
      [t0Kept],
    )
    const sql = readFileSync(
      new URL('../../../packages/v7/src/adapters/postgres/migrations/019_adoption_receipts.sql', import.meta.url),
      'utf8',
    )
    // 迁移文件本身幂等；重放等价于从旧库升级到 019。
    await db.db.query(sql)
    expect(await hitDispositions(db, 'trc_backfill_t0')).toEqual({
      [t0Kept]: 'kept',
      [t0Poison]: 'quarantined',
    })
    expect(await hitDispositions(db, 'trc_backfill_t1')).toEqual({
      [t1Kept]: 'kept',
      [t1Poison]: 'quarantined',
    })
    expect((await metricOf(db, t0Kept))?.retrieved_count).toBe('1')
    expect((await metricOf(db, t1Kept))?.retrieved_count).toBe('1')
    expect(await metricOf(db, t0Poison)).toBeUndefined()
    expect(await metricOf(db, t1Poison)).toBeUndefined()
    await db.close()
  })
})
