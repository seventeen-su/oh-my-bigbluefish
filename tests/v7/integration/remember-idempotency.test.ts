import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { EvidenceInput } from '../../../packages/v7/src/domain/evidence.js'
import { RememberService } from '../../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import { prepareDatabase, resetDatabase, store } from './helpers.js'

/**
 * 两层幂等的真实 PG 证据：
 * 1. 稳定 commandId（工具调用重试）→ audit_log.command_id 唯一，重复提交返回首次结果；
 * 2. 内容幂等 → 同 scope/category/关键属性/时间复用原实体，新证据并入 evidence 集；
 *    不同时间/不同 scope 的相似事实照常并存。
 */

const NOW = '2026-11-29T00:00:00.000Z'
const clock = { now: () => new Date(NOW), iso: () => NOW }

function memory(overrides: Partial<WriteEntityInput> = {}): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'project', projectKey: 'D:/Project/omb' },
    attrs: { title: 'Postgres 配置', body: '连接串走 127.0.0.1:5432' },
    ...overrides,
  } as WriteEntityInput
}

function sessionEvidence(sessionId: string): EvidenceInput[] {
  return [{
    sourceType: 'session',
    sourceId: `session:${sessionId}`,
    observedAt: NOW,
    subjectKey: `session:${sessionId}`,
    confidence: 0.6,
  }]
}

let db: PostgresStore
let remember: RememberService
let update: UpdateService

beforeAll(async () => {
  await prepareDatabase()
  db = store()
  remember = new RememberService({ store: db, clock })
  update = new UpdateService({ store: db, clock })
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await db.close()
})

async function count(table: string): Promise<number> {
  const rows = await db.db.query<{ count: string }>(`select count(*)::text as count from ${table}`)
  return Number(rows.rows[0]?.count ?? 0)
}

describe('omb_remember 的稳定 commandId（第一层幂等）', () => {
  it('同一 commandId 重试只写一条实体/审计/outbox，第二次返回首次结果', async () => {
    const first = await remember.remember(memory(), { commandId: 'tool:omb_remember:s:c1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await remember.remember(memory(), { commandId: 'tool:omb_remember:s:c1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return

    expect(second.value.deduped).toBe('command')
    expect(second.value.entity.id).toBe(first.value.entity.id)
    expect(second.value.entity.revision).toBe(1)
    expect(await count('omb.entity')).toBe(1)
    expect(await count('omb.outbox')).toBe(1)
    const audits = await db.db.query<{ count: string }>(
      "select count(*)::text as count from omb.audit_log where command_id = 'tool:omb_remember:s:c1'",
    )
    expect(Number(audits.rows[0]?.count)).toBe(1)
  })

  it('同一 commandId 并发重试也只有一个事务生效（advisory lock + 唯一索引）', async () => {
    const commandId = 'tool:omb_remember:s:race'
    const results = await Promise.all([
      remember.remember(memory(), { commandId }),
      remember.remember(memory(), { commandId }),
    ])
    expect(results.every(result => result.ok)).toBe(true)
    expect(await count('omb.entity')).toBe(1)
    expect(await count('omb.audit_log')).toBe(1)
  })

  it('omb_update 的稳定 commandId 重试不重复 bump revision', async () => {
    const written = await remember.remember(memory(), { commandId: 'create-1' })
    if (!written.ok) throw new Error('写入失败')
    const id = written.value.entity.id
    const patch = { id, expectedRevision: 1, attrs: { body: '连接串走 10.0.0.1:5432' }, origin: 'model' as const }
    const first = await update.update(patch, { commandId: 'tool:omb_update:s:u1' })
    const retry = await update.update(patch, { commandId: 'tool:omb_update:s:u1' })
    expect(first.ok && retry.ok).toBe(true)
    if (!first.ok || !retry.ok) return
    expect(first.value.entity.revision).toBe(2)
    expect(retry.value.deduped).toBe('command')
    expect(retry.value.entity.revision).toBe(2)
    expect(await count('omb.audit_log')).toBe(2)
  })
})

describe('内容幂等（第二层）：复用原实体并并入证据', () => {
  it('不同调用写入完全相同内容 → 同一实体、revision 不变、证据集 +1、写 EvidenceAdded 事件', async () => {
    const first = await remember.remember(memory(), {
      commandId: 'call-1',
      evidence: sessionEvidence('session-a'),
    })
    const second = await remember.remember(memory(), {
      commandId: 'call-2',
      evidence: sessionEvidence('session-b'),
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.value.deduped).toBe('content')
    expect(second.value.entity.id).toBe(first.value.entity.id)
    expect(second.value.entity.revision).toBe(1)
    expect(await count('omb.entity')).toBe(1)
    const evidence = await db.db.query<{ source_id: string; subject_key: string }>(
      'select source_id, subject_key from omb.evidence order by source_id',
    )
    expect(evidence.rows.map(row => row.source_id)).toEqual(['session:session-a', 'session:session-b'])
    const topics = await db.db.query<{ topic: string }>('select topic from omb.outbox order by id')
    expect(topics.rows.map(row => row.topic)).toEqual(['EntityCreated', 'EvidenceAdded'])
  })

  it('相似但不同时间的事实允许并存（显式 observedAt 参与指纹）', async () => {
    const first = await remember.remember(memory({
      attrs: { title: '部署结果', body: '部署完成', observedAt: '2026-11-28T00:00:00.000Z' },
    }), { commandId: 't1' })
    const second = await remember.remember(memory({
      attrs: { title: '部署结果', body: '部署完成', observedAt: '2026-11-29T00:00:00.000Z' },
    }), { commandId: 't2' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.deduped).toBeUndefined()
    expect(second.value.entity.id).not.toBe(first.value.entity.id)
    expect(await count('omb.entity')).toBe(2)
  })

  it('不同 scope 不误合并：同内容在两个项目里是两条事实', async () => {
    const first = await remember.remember(memory({ scope: { kind: 'project', projectKey: 'D:/A' } }), { commandId: 's1' })
    const second = await remember.remember(memory({ scope: { kind: 'project', projectKey: 'D:/B' } }), { commandId: 's2' })
    const global = await remember.remember(memory({ scope: { kind: 'global' } }), { commandId: 's3' })
    expect(first.ok && second.ok && global.ok).toBe(true)
    if (!first.ok || !second.ok || !global.ok) return
    expect(new Set([first.value.entity.id, second.value.entity.id, global.value.entity.id]).size).toBe(3)
    expect(await count('omb.entity')).toBe(3)
  })

  it('不同 category 不误合并（fact 与 clue 是不同语义层）', async () => {
    const fact = await remember.remember(memory(), { commandId: 'c1' })
    const clue = await remember.remember(memory({ category: 'clue' }), { commandId: 'c2' })
    expect(fact.ok && clue.ok).toBe(true)
    if (!fact.ok || !clue.ok) return
    expect(clue.value.entity.id).not.toBe(fact.value.entity.id)
    expect(await count('omb.entity')).toBe(2)
  })

  it('归档后同内容可以重新成为新实体（遗忘之后重新记住不被旧行挡住）', async () => {
    const first = await remember.remember(memory(), { commandId: 'a1' })
    if (!first.ok) throw new Error('写入失败')
    await db.archive(first.value.entity.id, 'test', 'test')
    const second = await remember.remember(memory(), { commandId: 'a2' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.entity.id).not.toBe(first.value.entity.id)
    expect(await count('omb.entity')).toBe(2)
    const active = await db.db.query<{ count: string }>(
      'select count(*)::text as count from omb.entity where archived_at is null',
    )
    expect(Number(active.rows[0]?.count)).toBe(1)
  })

  it('并发写同一新内容只产生一个实体（content advisory lock 串行化）', async () => {
    const results = await Promise.all([
      remember.remember(memory(), { commandId: 'race-1' }),
      remember.remember(memory(), { commandId: 'race-2' }),
      remember.remember(memory(), { commandId: 'race-3' }),
    ])
    expect(results.every(result => result.ok)).toBe(true)
    expect(await count('omb.entity')).toBe(1)
    if (!results.every(result => result.ok)) return
    const ids = new Set(results.map(result => (result as { value: { entity: { id: string } } }).value.entity.id))
    expect(ids.size).toBe(1)
  })
})
