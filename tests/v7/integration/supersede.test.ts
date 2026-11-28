import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { boardDerivationSql } from '../../../packages/v7/src/adapters/postgres/projection.js'
import { newId } from '../../../packages/v7/src/domain/ids.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { tokenize } from '../../../packages/v7/src/domain/text.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import { RecallService } from '../../../packages/v7/src/app/recall.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const FIXED_NOW = '2026-11-29T00:00:00.000Z'
/**
 * 取代/证伪生效时间必须落在实体创建之后（`valid_to >= valid_from`）。
 * 夹具实体由数据库 `now()` 创建，所以取一个晚于真实当前时刻的稳定偏移；
 * 断言一律用这个常量比较，不依赖运行时刻。
 */
const EFFECTIVE_AT = new Date(Date.now() + 60_000).toISOString()
const PROJECT = '<workspace>/omb-worktrees/supersede'

const clock: Clock = { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }

/** 召回只关心 SQL 通道；向量通道用不可用替身，避免依赖 ONNX 模型文件。 */
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

interface LifecycleRow {
  lifecycle: string
  superseded_by: string | null
  superseded_at: Date | string | null
  supersede_reason: string | null
  retracted_at: Date | string | null
  retracted_reason: string | null
  valid_from: Date | string | null
  valid_to: Date | string | null
  archived_at: Date | string | null
  revision: string | number
  access_count: number
}

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null
  return (value instanceof Date ? value.toISOString() : new Date(value).toISOString())
}

describe('生命周期取代（真实 PostgreSQL）', () => {
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
    await resetDatabase()
  })

  async function writeMemory(attrs: Record<string, unknown>): Promise<string> {
    const input: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: attrs as WriteEntityInput['attrs'],
    }
    const written = await db.write(normalized(input), derived(input))
    return written.entity.id
  }

  async function lifecycleOf(id: string): Promise<LifecycleRow> {
    const rows = await db.db.query<LifecycleRow>(
      `select lifecycle, superseded_by, superseded_at, supersede_reason, retracted_at, retracted_reason,
              valid_from, valid_to, archived_at, revision, access_count
         from omb.entity where id = $1`,
      [id],
    )
    const row = rows.rows[0]
    if (row === undefined) throw new Error(`实体不存在：${id}`)
    return row
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await db.db.query<{ count: string }>(
      'select count(*)::text as count from omb.audit_log where action = $1',
      [action],
    )
    return Number(rows.rows[0]?.count ?? 0)
  }

  function engine(): RecallEngine {
    return new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })
  }

  async function recallIds(query: string, extra: { includeSuperseded?: boolean } = {}): Promise<string[]> {
    const result = await engine().recall({ query, now: FIXED_NOW, ...extra })
    return result.hits.map(hit => hit.entityId)
  }

  it('给定旧事实被取代当普通召回则排除它，历史检索返回它并标记取代时间与取代者', async () => {
    const oldId = await writeMemory({
      title: '部署回滚连接池排障旧结论',
      body: '连接池被打满时直接重启进程；ECONNRESET 归因于连接泄漏。',
    })
    const newIdValue = await writeMemory({
      title: '部署回滚连接池排障新结论',
      body: '连接池被打满时先扩池并延长重试；ECONNRESET 归因于服务端提前关闭。',
    })
    const query = '部署回滚 连接池 ECONNRESET'
    expect(await recallIds(query)).toEqual(expect.arrayContaining([oldId, newIdValue]))

    const superseded = await db.supersede({
      oldId,
      newId: newIdValue,
      reason: '新排障结论替代旧归因',
      actor: 'user',
      effectiveAt: EFFECTIVE_AT,
    })
    expect(superseded).toMatchObject({ oldId, newId: newIdValue, alreadyApplied: false, created: false, effectiveAt: EFFECTIVE_AT })

    // 普通召回：旧事实退出；新事实照常。
    const current = await recallIds(query)
    expect(current).not.toContain(oldId)
    expect(current).toContain(newIdValue)
    // 通道层同样不返回旧事实（不是只靠引擎最后一层过滤）。
    const tokens = tokenize(query)
    const currentFulltext = await db.fulltext({ query, tokens, limit: 20 })
    expect(currentFulltext.map(hit => hit.entityId)).not.toContain(oldId)

    // 历史检索：旧事实可检索，并带取代时间/取代者/有效期。
    const historical = await engine().recall({ query, now: FIXED_NOW, includeSuperseded: true })
    const oldHit = historical.hits.find(hit => hit.entityId === oldId)
    expect(oldHit?.lifecycle).toBe('superseded')
    expect(oldHit?.supersededBy).toBe(newIdValue)
    expect(oldHit?.supersededAt).toBe(EFFECTIVE_AT)
    expect(oldHit?.validTo).toBe(EFFECTIVE_AT)
    expect(oldHit?.validFrom).toBeDefined()
    expect(oldHit?.why.some(reason => reason.includes('lifecycle:superseded'))).toBe(true)
    const historicalFulltext = await db.fulltext({ query, tokens, limit: 20, includeSuperseded: true })
    expect(historicalFulltext.map(hit => hit.entityId)).toContain(oldId)

    // 写模型与派生视图同事务可见：行状态、有效期、视图生命周期都变了。
    const row = await lifecycleOf(oldId)
    expect(row.lifecycle).toBe('superseded')
    expect(row.superseded_by).toBe(newIdValue)
    expect(isoOf(row.superseded_at)).toBe(EFFECTIVE_AT)
    expect(isoOf(row.valid_to)).toBe(EFFECTIVE_AT)
    expect(isoOf(row.valid_from)).not.toBeNull()
    expect(Number(row.revision)).toBe(2)
    const view = await db.db.query<{ lifecycle: string }>(
      'select lifecycle from omb.entity_view where entity_id = $1',
      [oldId],
    )
    expect(view.rows[0]?.lifecycle).toBe('superseded')
  })

  it('给定取代成功当查审计/反悔/outbox/看板投影则同一事务里都已更新', async () => {
    const oldId = await writeMemory({ title: '偏好：部署窗口', body: '部署窗口固定在周二', tags: ['偏好'] })
    const newIdValue = await writeMemory({ title: '偏好：部署窗口', body: '部署窗口改到周四' })
    expect((await db.preferenceSummaries(10)).map(item => item.id)).toContain(oldId)

    await db.supersede({ oldId, newId: newIdValue, reason: '窗口调整', actor: 'user', effectiveAt: EFFECTIVE_AT })

    const audits = await db.db.query<{
      id: string
      action: string
      target_ids: string[]
      inverse: Record<string, unknown>
      stream_id: string
      stream_version: string
    }>(
      `select id::text as id, action, target_ids, inverse, stream_id, stream_version
         from omb.audit_log where action = 'supersede'`,
    )
    expect(audits.rows).toHaveLength(1)
    const audit = audits.rows[0]
    expect(audit?.target_ids.sort()).toEqual([oldId, newIdValue].sort())
    expect(audit?.stream_id).toBe(oldId)
    expect(audit?.inverse).toMatchObject({
      action: 'unsupersede',
      oldId,
      newId: newIdValue,
      previousLifecycle: 'active',
    })

    const outbox = await db.db.query<{ topic: string; payload: { payload: Record<string, unknown> } }>(
      `select o.topic, o.payload from omb.outbox o where o.topic = 'EntitySuperseded'`,
    )
    expect(outbox.rows).toHaveLength(1)
    expect(outbox.rows[0]?.payload.payload).toMatchObject({ oldId, newId: newIdValue, effectiveAt: EFFECTIVE_AT })

    const task = await db.db.query<{ revision: string }>(
      `select revision::text as revision from omb.projection_task
        where entity_id = $1 and projection = 'preference_board'`,
      [oldId],
    )
    expect(Number(task.rows[0]?.revision)).toBe(2)

    // 看板派生 SQL 不再把旧条目算进看板（projector 会据此删除读模型行）。
    const derivedBoard = boardDerivationSql('preference', { entityId: oldId })
    const boardRows = await db.db.query(derivedBoard.text, derivedBoard.values)
    expect(boardRows.rowCount).toBe(0)
    expect((await db.preferenceSummaries(10)).map(item => item.id)).not.toContain(oldId)
  })

  it('给定取代事务失败当回查则旧实体仍 active，且没有链接/审计残留', async () => {
    const oldId = await writeMemory({ title: '失败回滚旧事实', body: '旧方案 A' })

    // 新实体不存在：事务内 notFound，整笔回滚。
    await expect(db.supersede({
      oldId,
      newId: newId('memory'),
      reason: '不存在的新事实',
      actor: 'user',
    })).rejects.toThrow(/不存在/)

    expect((await lifecycleOf(oldId)).lifecycle).toBe('active')
    const links = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.link where relation = 'supersedes'`,
    )
    expect(links.rows[0]?.count).toBe('0')
    expect(await auditCount('supersede')).toBe(0)

    // 事务内创建新实体失败（同 id 已存在，PK 冲突）：链接/审计/旧实体都不落库。
    const archivedId = await writeMemory({ title: '占位实体', body: '会被归档' })
    await db.archive(archivedId, 'test', 'test')
    await expect(db.supersede({
      oldId,
      newId: archivedId,
      reason: '同 id 创建会撞主键',
      actor: 'user',
      create: { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '新事实' } },
    })).rejects.toThrow()
    expect((await lifecycleOf(oldId)).lifecycle).toBe('active')
    const after = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.link where relation = 'supersedes'`,
    )
    expect(after.rows[0]?.count).toBe('0')
    expect(await auditCount('supersede')).toBe(0)
  })

  it('给定重复取代当再次提交则幂等，换成第三个取代者则冲突', async () => {
    const oldId = await writeMemory({ title: '重复取代旧事实', body: '旧方案' })
    const newIdValue = await writeMemory({ title: '重复取代新事实', body: '新方案' })
    const thirdId = await writeMemory({ title: '第三方案', body: '另一个新方案' })

    const first = await db.supersede({ oldId, newId: newIdValue, reason: '第一次', actor: 'user' })
    const revisionAfterFirst = Number((await lifecycleOf(oldId)).revision)
    const again = await db.supersede({ oldId, newId: newIdValue, reason: '重复', actor: 'user' })

    expect(again.alreadyApplied).toBe(true)
    expect(again.newId).toBe(newIdValue)
    expect(await auditCount('supersede')).toBe(1)
    expect(Number((await lifecycleOf(oldId)).revision)).toBe(revisionAfterFirst)

    await expect(db.supersede({ oldId, newId: thirdId, reason: '换人', actor: 'user' }))
      .rejects.toThrow(/已被另一条记忆取代/)
    expect((await lifecycleOf(oldId)).superseded_by).toBe(newIdValue)
    expect(await auditCount('supersede')).toBe(1)
    expect(first.linkId).not.toBe('')

    await expect(db.supersede({ oldId: newIdValue, newId: newIdValue, reason: '自己', actor: 'user' }))
      .rejects.toThrow(/自己/)
  })

  it('给定反向取代会成环当提交则拒绝，且两边生命周期不变', async () => {
    const a = await writeMemory({ title: '环检测 A', body: 'A' })
    const b = await writeMemory({ title: '环检测 B', body: 'B' })
    await db.supersede({ oldId: a, newId: b, reason: 'A→B', actor: 'user' })

    await expect(db.supersede({ oldId: b, newId: a, reason: 'B→A 成环', actor: 'user' }))
      .rejects.toThrow(/环/)
    expect((await lifecycleOf(a)).lifecycle).toBe('superseded')
    expect((await lifecycleOf(b)).lifecycle).toBe('active')
    expect(await auditCount('supersede')).toBe(1)
  })

  it('给定证伪当提交则与取代区分：retracted 可历史检索，且两种状态不能互相覆盖', async () => {
    const refutedId = await writeMemory({ title: '被证伪的实验结论', body: '缓存命中率 95%' })
    const wrongId = await writeMemory({ title: '错误的部署结论', body: '旧部署结论' })

    const retracted = await db.retract({
      id: refutedId,
      reason: '复测只有 60%',
      actor: 'user',
      effectiveAt: EFFECTIVE_AT,
    })
    expect(retracted).toMatchObject({ id: refutedId, alreadyApplied: false, effectiveAt: EFFECTIVE_AT })

    const row = await lifecycleOf(refutedId)
    expect(row.lifecycle).toBe('retracted')
    expect(isoOf(row.retracted_at)).toBe(EFFECTIVE_AT)
    expect(isoOf(row.valid_to)).toBe(EFFECTIVE_AT)
    expect(row.superseded_by).toBeNull()

    const query = '缓存命中率 复测'
    expect(await recallIds(query)).not.toContain(refutedId)
    const historical = await engine().recall({ query, now: FIXED_NOW, includeSuperseded: true })
    const hit = historical.hits.find(item => item.entityId === refutedId)
    expect(hit?.lifecycle).toBe('retracted')
    expect(hit?.retractedAt).toBe(EFFECTIVE_AT)
    expect(hit?.supersededAt).toBeUndefined()

    // 证伪与取代不能互相覆盖。
    const replacementId = await writeMemory({ title: '复测后结论', body: '缓存命中率 60%' })
    await expect(db.supersede({ oldId: refutedId, newId: replacementId, reason: '取代被证伪项', actor: 'user' }))
      .rejects.toThrow(/证伪/)
    expect((await lifecycleOf(refutedId)).lifecycle).toBe('retracted')

    await db.supersede({ oldId: wrongId, newId: replacementId, reason: '正常取代', actor: 'user' })
    await expect(db.retract({ id: wrongId, reason: '证伪已取代项', actor: 'user' }))
      .rejects.toThrow(/已被取代/)
    expect((await lifecycleOf(wrongId)).lifecycle).toBe('superseded')

    // 重复证伪幂等；审计只有一条。
    expect((await db.retract({ id: refutedId, reason: '再次', actor: 'user' })).alreadyApplied).toBe(true)
    expect(await auditCount('retract')).toBe(1)
  })

  it('给定归档与取代并存当取消归档则生命周期仍是 superseded，普通召回依旧排除', async () => {
    const oldId = await writeMemory({ title: '并存归档旧事实', body: '旧' })
    const newIdValue = await writeMemory({ title: '并存归档新事实', body: '新' })
    await db.supersede({ oldId, newId: newIdValue, reason: '先取代', actor: 'user' })

    await db.archive(oldId, 'manual', 'test')
    const archived = await lifecycleOf(oldId)
    expect(archived.archived_at).not.toBeNull()
    expect(archived.lifecycle).toBe('superseded')

    await db.unarchive(oldId, 'manual', 'test')
    const unarchived = await lifecycleOf(oldId)
    expect(unarchived.archived_at).toBeNull()
    expect(unarchived.lifecycle).toBe('superseded')
    expect(await recallIds('并存归档')).not.toContain(oldId)

    // 纯归档（未被取代）生命周期是 archived，取消归档回到 active。
    const plainId = await writeMemory({ title: '纯归档条目', body: '仅归档' })
    await db.archive(plainId, 'manual', 'test')
    expect((await lifecycleOf(plainId)).lifecycle).toBe('archived')
    await db.unarchive(plainId, 'manual', 'test')
    expect((await lifecycleOf(plainId)).lifecycle).toBe('active')
  })

  it('给定同事务创建新事实当取代则新实体/链接/审计一起落库，失败一起回滚', async () => {
    const oldId = await writeMemory({ title: '同事务创建旧事实', body: '旧内容' })
    const newIdValue = newId('memory')
    const result = await db.supersede({
      oldId,
      newId: newIdValue,
      reason: '新结论 + 同事务创建',
      actor: 'user',
      effectiveAt: EFFECTIVE_AT,
      create: {
        kind: 'memory',
        category: 'fact',
        scope: { kind: 'global' },
        attrs: { title: '同事务创建新事实', body: '新内容' },
      },
    })

    expect(result.created).toBe(true)
    expect(result.newId).toBe(newIdValue)
    expect((await lifecycleOf(oldId)).lifecycle).toBe('superseded')
    expect((await lifecycleOf(newIdValue)).lifecycle).toBe('active')
    const created = await db.get(newIdValue)
    expect(created?.attributes.find(item => item.name === 'title')?.value).toMatchObject({ value: '同事务创建新事实' })

    // 创建事件与取代事件都要落 outbox：嵌入消费者靠 EntityCreated 给新事实建向量。
    const createdEvents = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.outbox
        where topic = 'EntityCreated' and payload->'payload'->>'entityId' = $1`,
      [newIdValue],
    )
    expect(createdEvents.rows[0]?.count).toBe('1')
    const supersedeEvents = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.outbox where topic = 'EntitySuperseded'`,
    )
    expect(supersedeEvents.rows[0]?.count).toBe('1')
  })

  it('给定回滚取代审计当回查则旧事实恢复当前有效、取代链接归档、新事实保留', async () => {
    const oldId = await writeMemory({ title: '回滚取代旧事实', body: '旧结论' })
    const newIdValue = await writeMemory({ title: '回滚取代新事实', body: '新结论' })
    const result = await db.supersede({ oldId, newId: newIdValue, reason: '可回滚', actor: 'user', effectiveAt: EFFECTIVE_AT })
    expect(result.auditId).toBeGreaterThan(0)

    const rollback = await db.rollback(result.auditId, 'test')
    expect(rollback.applied).toContain(`unsupersede:${oldId}`)

    const restored = await lifecycleOf(oldId)
    expect(restored.lifecycle).toBe('active')
    expect(restored.superseded_by).toBeNull()
    expect(isoOf(restored.superseded_at)).toBeNull()
    expect(isoOf(restored.valid_to)).toBeNull()
    expect(await recallIds('回滚取代')).toContain(oldId)
    expect((await lifecycleOf(newIdValue)).lifecycle).toBe('active')

    const link = await db.db.query<{ archived_at: Date | string | null }>(
      'select archived_at from omb.link where id = $1',
      [result.linkId],
    )
    expect(link.rows[0]?.archived_at).not.toBeNull()
    await expect(db.rollback(result.auditId, 'test')).rejects.toThrow(/已回滚/)
  })

  it('给定旧事实有高采用率当被取代后，历史检索不再叠加采用率先验，也不给它记访问', async () => {
    const oldId = await writeMemory({ title: '高采用率旧事实', body: '旧结论' })
    const newIdValue = await writeMemory({ title: '新高采用率事实', body: '新结论' })
    await db.db.query(
      'update omb.entity set adoption_count = 9, access_count = 10 where id = $1',
      [oldId],
    )
    await db.supersede({ oldId, newId: newIdValue, reason: '新结论', actor: 'user', effectiveAt: EFFECTIVE_AT })

    const result = await engine().recall({ query: '高采用率', now: FIXED_NOW, includeSuperseded: true })
    const oldHit = result.hits.find(hit => hit.entityId === oldId)
    expect(oldHit?.lifecycle).toBe('superseded')
    expect(oldHit?.why.some(reason => reason.includes('adoption'))).toBe(false)

    // 历史召回不给旧事实记访问；访问/采用计数保持原值，继续影响的是历史统计而不是当前重排。
    const row = await lifecycleOf(oldId)
    expect(row.access_count).toBe(10)
    const defaultRecall = await recallIds('高采用率')
    expect(defaultRecall).not.toContain(oldId)
  })

  it('给定显式时间窗当走 RecallService 则默认放开历史事实，并写明已被取代', async () => {
    const oldId = await writeMemory({ title: '时间窗历史事实', body: '迁移前使用 SQLite' })
    const newIdValue = await writeMemory({ title: '时间窗当前事实', body: '迁移后使用 PostgreSQL' })
    await db.supersede({ oldId, newId: newIdValue, reason: '数据库迁移', actor: 'user', effectiveAt: EFFECTIVE_AT })

    const service = new RecallService(engine())
    const context = { sessionId: 'session-supersede', cwd: PROJECT, projectKey: PROJECT }

    const current = await service.recall({ query: '迁移 使用' }, context)
    expect(current.ok).toBe(true)
    if (current.ok) {
      expect(current.value).toContain(newIdValue)
      expect(current.value).not.toContain(oldId)
    }

    const historical = await service.recall({
      query: '迁移 使用',
      timeFrom: '2026-01-01T00:00:00.000Z',
      timeTo: '2026-12-01T00:00:00.000Z',
    }, context)
    expect(historical.ok).toBe(true)
    if (historical.ok) {
      expect(historical.value).toContain(oldId)
      expect(historical.value).toContain('生命周期：已被取代')
      expect(historical.value).toContain('历史证据，不是当前有效')
    }
  })

  it('给定被取代的同一内容又被重新断言当写入则新建当前实体，不把新证据并入历史条目', async () => {
    const oldId = await writeMemory({ title: '连接池默认值', body: '默认 20 个连接' })
    const newerId = await writeMemory({ title: '连接池默认值（调大）', body: '默认 40 个连接' })
    await db.supersede({ oldId, newId: newerId, reason: '容量调整', actor: 'user', effectiveAt: EFFECTIVE_AT })
    expect((await lifecycleOf(oldId)).lifecycle).toBe('superseded')

    // 同内容重新断言：内容幂等只复用 active 行，历史条目不能把新写入降级成“历史证据”。
    const rewrittenId = await writeMemory({ title: '连接池默认值', body: '默认 20 个连接' })
    expect(rewrittenId).not.toBe(oldId)
    expect((await lifecycleOf(oldId)).lifecycle).toBe('superseded')
    const rewritten = await lifecycleOf(rewrittenId)
    expect(rewritten.lifecycle).toBe('active')
    expect(rewritten.superseded_by).toBeNull()
    // 当前召回只看到新的当前事实；旧事实仍只在历史检索里。
    const current = await recallIds('连接池默认值')
    expect(current).toContain(rewrittenId)
    expect(current).not.toContain(oldId)
    expect(await recallIds('连接池默认值', { includeSuperseded: true })).toContain(oldId)
  })

  it('给定 017 迁移当查 schema 则字段/约束/索引齐全，且 SQL 可重复执行', async () => {
    const columns = await db.db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'omb' and table_name in ('entity','entity_view')
          and column_name in ('lifecycle','superseded_by','superseded_at','supersede_reason',
                              'retracted_at','retracted_reason','valid_from','valid_to')`,
    )
    const entityColumns = columns.rows.filter(row => row.table_name === 'entity').map(row => row.column_name)
    expect(entityColumns).toEqual(expect.arrayContaining([
      'lifecycle', 'superseded_by', 'superseded_at', 'supersede_reason',
      'retracted_at', 'retracted_reason', 'valid_from', 'valid_to',
    ]))
    expect(columns.rows.some(row => row.table_name === 'entity_view' && row.column_name === 'lifecycle')).toBe(true)

    const constraints = await db.db.query<{ conname: string }>(
      `select conname from pg_constraint where conname in (
         'entity_lifecycle_check','entity_superseded_fields_check','entity_retracted_fields_check',
         'entity_supersede_link_check','entity_supersede_not_self_check','entity_valid_range_check',
         'entity_view_lifecycle_check')`,
    )
    expect(constraints.rows).toHaveLength(7)
    const indexes = await db.db.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'omb' and indexname = 'entity_view_active_current'`,
    )
    expect(indexes.rows).toHaveLength(1)

    // 迁移 runner 记录 017；重复执行 SQL 不报错（全部语句幂等）。
    const applied = await db.db.query<{ name: string }>(
      `select name from omb.schema_migrations where name = '017_supersession.sql'`,
    )
    expect(applied.rows).toHaveLength(1)
    const sql = readFileSync(new URL('../../../packages/v7/src/adapters/postgres/migrations/017_supersession.sql', import.meta.url), 'utf8')
    await db.db.transaction(async client => {
      await client.query(sql)
    })
  })
})
