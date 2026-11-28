import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { attributeValue } from '../../../packages/v7/src/domain/entity-access.js'
import type { EvidenceInput } from '../../../packages/v7/src/domain/evidence.js'
import { RememberService } from '../../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import { evidenceForWrite } from '../../../packages/v7/src/app/evidence.js'
import { handleCluePromoteFor } from '../../../packages/v7/src/jobs/consolidate.js'
import type { ConsolidationDeps } from '../../../packages/v7/src/jobs/consolidate.js'
import { deriveSearchText, deriveTriggers, normalizeWrite } from '../../../packages/v7/src/domain/validation.js'
import { prepareDatabase, resetDatabase, store } from './helpers.js'

/**
 * 线索晋升的证据生产者/独立性判定（真实 PostgreSQL）：
 * - 证据来自 `omb.evidence`，不再信任 attributes.evidence 里的自我声明；
 * - 两个 session 引用同一文件只算一份独立验证；
 * - 晋升会写一条 system verification 证据，审计能回答“为什么转成事实”。
 */

const NOW = '2026-11-29T00:00:00.000Z'
const clock = { now: () => new Date(NOW), iso: () => NOW }

function clue(attrs: Record<string, unknown>): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'clue',
    scope: { kind: 'project', projectKey: 'D:/Project/omb' },
    attrs,
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
let deps: ConsolidationDeps

beforeAll(async () => {
  await prepareDatabase()
  db = store()
  remember = new RememberService({ store: db, clock })
  deps = {
    store: db,
    queries: new PostgresMaintenance(db.db),
    updateService: new UpdateService({ store: db, clock }),
    clock,
  }
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await db.close()
})

async function writeClue(attrs: Record<string, unknown>, commandId: string, evidence?: EvidenceInput[]) {
  const result = await remember.remember(clue(attrs), {
    commandId,
    ...(evidence !== undefined ? { evidence } : {}),
  })
  if (!result.ok) throw new Error(`线索写入失败：${result.error.message}`)
  return result.value
}

async function evidenceRows(entityId: string) {
  const rows = await db.db.query<{ source_type: string; source_id: string; verification_status: string }>(
    'select source_type, source_id, verification_status from omb.evidence where entity_id = $1 order by source_type, source_id',
    [entityId],
  )
  return rows.rows
}

describe('线索晋升必须有真实证据（Evidence 账本）', () => {
  it('两个独立会话确认同一线索 → 晋升为 fact，并写系统 verification 证据', async () => {
    const attrs = { title: '缓存击穿的原因', body: '观察同一请求重复回源' }
    const first = await writeClue(attrs, 'c1', sessionEvidence('session-a'))
    const second = await writeClue(attrs, 'c2', sessionEvidence('session-b'))
    // 内容幂等：同一线索只保留一个实体，证据来自两个会话。
    expect(second.entity.id).toBe(first.entity.id)
    expect(second.deduped).toBe('content')
    expect((await evidenceRows(first.entity.id)).map(row => row.source_id)).toEqual([
      'session:session-a', 'session:session-b',
    ])

    const result = await handleCluePromoteFor(deps, first.entity.id)
    expect(result.promoted).toBe(1)
    const loaded = await db.get(first.entity.id)
    expect(loaded).toBeDefined()
    expect(attributeValue(loaded!, 'category')).toBe('fact')
    const evidence = await evidenceRows(first.entity.id)
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'verification', verification_status: 'verified' }),
    ]))
  })

  it('两个会话引用同一文件只算一份独立验证 → 不晋升', async () => {
    const attrs = {
      title: '构建失败原因',
      body: '根据 docs/ARCHITECTURE.md 的预算表，失败原因是内存超限。',
    }
    // 用真实证据生产者：内容里出现文件路径时只产生 file 证据（同一文件同一 subjectKey）。
    const first = await writeClue(attrs, 'f1', evidenceForWrite(clue(attrs), { sessionId: 'session-a', tool: 'omb_remember', now: NOW }))
    const second = await writeClue(attrs, 'f2', evidenceForWrite(clue(attrs), { sessionId: 'session-b', tool: 'omb_remember', now: NOW }))
    expect(second.entity.id).toBe(first.entity.id)
    const evidence = await evidenceRows(first.entity.id)
    // 同一文件 sourceId/subjectKey 相同，唯一约束把两条证据吸收成一条。
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.source_type).toBe('file')

    const result = await handleCluePromoteFor(deps, first.entity.id)
    expect(result.promoted).toBe(0)
    expect(attributeValue((await db.get(first.entity.id))!, 'category')).toBe('clue')
  })

  it('旧 evidence 字符串（session:a/session:b）不再算证据：模型自证不晋升', async () => {
    const written = await writeClue({
      title: '候选结论',
      body: '可能是并发写导致',
      evidence: ['session:a', 'session:b', 'session:c'],
      verified: true,
      userConfirmed: true,
    }, 'legacy-1')
    const result = await handleCluePromoteFor(deps, written.entity.id)
    expect(result.promoted).toBe(0)
    expect(attributeValue((await db.get(written.entity.id))!, 'category')).toBe('clue')
  })

  it('用户确认证据（高置信 user）单独可以晋升', async () => {
    const written = await writeClue({
      title: '端口约定',
      body: '本机开发统一用 5432',
    }, 'user-1', [{
      sourceType: 'user',
      sourceId: 'session:user-session',
      observedAt: NOW,
      subjectKey: 'session:user-session',
      confidence: 0.9,
    }])
    const result = await handleCluePromoteFor(deps, written.entity.id)
    expect(result.promoted).toBe(1)
    expect(attributeValue((await db.get(written.entity.id))!, 'category')).toBe('fact')
  })

  it('有 refuted 系统验证时即使多来源也不晋升', async () => {
    const normalized = normalizeWrite(clue({ title: '待验证结论', body: '多来源但被系统反驳' }))
    if (!normalized.ok) throw new Error('输入非法')
    const written = await db.write(normalized.value, {
      searchText: deriveSearchText(normalized.value.attributes),
      triggers: deriveTriggers(normalized.value.attributes),
    }, {
      commandId: 'refuted-1',
      evidence: [
        ...sessionEvidence('session-a'),
        ...sessionEvidence('session-b'),
        {
          sourceType: 'verification',
          sourceId: 'job:clue-promote:test',
          observedAt: NOW,
          verificationStatus: 'refuted',
          confidence: 0.9,
        },
      ],
    })
    const result = await handleCluePromoteFor(deps, written.entity.id)
    expect(result.promoted).toBe(0)
    expect(attributeValue((await db.get(written.entity.id))!, 'category')).toBe('clue')
  })
})

