import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../packages/v7/src/adapters/dynamic/index.js'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import { DynamicService, type DynamicRefreshOptions } from '../../../packages/v7/src/app/dynamic.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import type { Entity, PatchEntityInput, StateStatus, WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { RawAttributeValue } from '../../../packages/v7/src/domain/dynamic-spec.js'
import { attributeValue } from '../../../packages/v7/src/domain/entity-access.js'
import { OmbFailure } from '../../../packages/v7/src/domain/errors.js'
import type { RevisionConflictDetails } from '../../../packages/v7/src/domain/conflict.js'
import { handleRefresh, runForget } from '../../../packages/v7/src/jobs/consolidate.js'
import type { ConsolidationDeps } from '../../../packages/v7/src/jobs/consolidate.js'
import type { Forgettable } from '../../../packages/v7/src/ports/maintenance.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

/**
 * 状态机并发（真实 PostgreSQL）：防的不只是两个 AI，而是「AI 读到 rev10、用户手改出
 * rev11、AI 拿旧 rev 覆盖用户」。
 *
 * 覆盖：旧 revision 写被拒 + 完整冲突差异、缺失 expectedRevision 拒绝、自动刷新遇到
 * 人工更高 revision 跳过并留审计、完成/遗忘归档与更新竞争只有一方成功、历史/当前/审计
 * 同事务失败全回滚。测试不使用 sleep / 轮询重试：竞态用一次 Promise.all 或显式事务顺序
 * 制造，失败后由调用方重新读取（不是后台重试）。
 */

const CLOCK = { now: (): Date => new Date(), iso: (): string => new Date().toISOString() }
const TIME = '2026-11-29T00:00:00.000Z'

type Conn = ReturnType<typeof store>

function stateInput(title: string, status: StateStatus, attrs: Record<string, RawAttributeValue> = {}): WriteEntityInput {
  return { kind: 'state', scope: { kind: 'global' }, title, status, time: TIME, attrs }
}

function memoryInput(title: string, body: string): WriteEntityInput {
  return { kind: 'memory', category: 'event', scope: { kind: 'global' }, attrs: { title, body } }
}

async function write(conn: Conn, input: WriteEntityInput) {
  return conn.write(normalized(input), derived(input))
}

async function revisionOf(conn: Conn, id: string): Promise<number> {
  const rows = await conn.db.query<{ revision: string }>('select revision from omb.entity where id = $1', [id])
  return Number(rows.rows[0]?.revision)
}

async function countOf(conn: Conn, sql: string): Promise<number> {
  const rows = await conn.db.query<{ count: string }>(sql)
  return Number(rows.rows[0]?.count ?? 0)
}

/** 显式捕获同步/异步失败，保留 OmbFailure 的 error 载荷（不用 rejects 断言丢失 details）。 */
async function capture(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
    return undefined
  } catch (error) {
    return error
  }
}

/** 用一次显式查询判断“这期自动刷新该处理谁”，避免依赖真实 stale 缓存的时间片。 */
class ForcedStaleQueries extends PostgresMaintenance {
  constructor(db: PostgresDb, private readonly ids: readonly string[]) {
    super(db)
  }

  override async staleDynamic(): Promise<string[]> {
    return [...this.ids]
  }
}

describe('状态机并发（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('给定 AI 只读到旧 revision 当用户已写入新 revision 则拒绝覆盖并返回完整冲突差异', async () => {
    const db = store()
    const state = await write(db, stateInput('并发标题', 'in_progress'))
    const id = state.entity.id
    const service = new UpdateService({ store: db })
    // AI 的读：rev1。用户随后以 rev1 为基线写入 rev2（模拟用户手改/另一条入口）。
    const aiRead = await db.get(id)
    expect(aiRead?.revision).toBe(1)
    const user = await service.update(
      { id, expectedRevision: aiRead!.revision, title: '用户改的标题', status: 'blocked' },
      { actor: 'user', source: 'user' },
    )
    expect(user.ok).toBe(true)

    const ai = await service.update(
      { id, expectedRevision: aiRead!.revision, title: 'AI 覆盖', status: 'completed' },
      { actor: 'model', source: 'model' },
    )
    expect(ai.ok).toBe(false)
    if (ai.ok) return
    expect(ai.error.code).toBe('conflict')
    const details = ai.error.details as RevisionConflictDetails
    expect(details).toMatchObject({
      entityId: id,
      expectedRevision: 1,
      currentRevision: 2,
      currentStatus: 'blocked',
      currentTitle: '用户改的标题',
      currentTime: TIME,
      actor: { id: 'model', kind: 'model' },
      source: 'model',
    })
    expect(details.conflictingFields).toEqual(expect.arrayContaining([
      { field: 'title', incoming: 'AI 覆盖', current: '用户改的标题' },
      { field: 'status', incoming: 'completed', current: 'blocked' },
    ]))
    expect(details.conflictingFieldCount).toBe(2)
    // 冲突不是“只报一句冲突”：错误文本也要能定位。
    expect(ai.error.message).toContain('期望 1，当前 2')
    expect(ai.error.message).toContain('blocked')

    // 用户的新状态没有被旧 revision 覆盖，也没有被旧 patch 自动归档。
    const after = await db.get(id, { includeArchived: true })
    expect(attributeValue(after!, 'title')).toBe('用户改的标题')
    expect(attributeValue(after!, 'status')).toBe('blocked')
    expect(after?.revision).toBe(2)
    expect(after?.archivedAt).toBeUndefined()
    // 冲突尝试不写历史、不写审计、不写 outbox。
    expect(await db.history(id, 10)).toHaveLength(1)
    const audits = await db.listAudit(20, id)
    expect(audits.filter(item => item.action === 'patch')).toHaveLength(1)
    expect(audits.find(item => item.action === 'patch')).toMatchObject({
      actor: 'user',
      actorKind: 'user',
      source: 'user',
    })
    expect(await countOf(db, "select count(*)::text as count from omb.outbox where topic = 'EntityPatched'")).toBe(1)
    await db.close()
  })

  it('给定更新未携带 expectedRevision 当走 service/store 则拒绝且不落任何行', async () => {
    const db = store()
    const state = await write(db, stateInput('缺版本', 'in_progress'))
    const id = state.entity.id
    const service = new UpdateService({ store: db })

    const viaService = await service.update({ id, attrs: { body: '不该写' } } as PatchEntityInput)
    expect(viaService.ok).toBe(false)
    if (!viaService.ok) {
      expect(viaService.error.code).toBe('invalid-input')
      expect(viaService.error.message).toContain('expectedRevision')
    }

    const next: WriteEntityInput = { ...stateInput('缺版本', 'blocked'), id, attrs: { body: '不该写' } }
    const failure = await capture(() => db.patch(normalized(next), { id, attrs: { body: '不该写' } }, derived(next)))
    expect(failure).toBeInstanceOf(OmbFailure)
    expect((failure as OmbFailure).error.code).toBe('invalid-input')
    expect((failure as OmbFailure).error.message).toContain('expectedRevision')

    const after = await db.get(id)
    expect(after?.revision).toBe(1)
    expect(after?.attributes.some(item => item.name === 'body')).toBe(false)
    expect(await countOf(db, "select count(*)::text as count from omb.audit_log where action = 'patch'")).toBe(0)
    expect(await db.history(id, 10)).toHaveLength(0)
    await db.close()
  })

  it('给定自动刷新读到旧 revision 当用户已推进状态则跳过覆盖并写 skipped 审计', async () => {
    const db = store()
    const id = (await write(db, stateInput('动态状态', 'in_progress', {
      body: '由 statusRule 自动推进',
      statusRule: { $dynamic: { kind: 'regex', source: 'completed', input: { kind: 'literal', value: 'completed' } } },
    }))).entity.id
    const clock = CLOCK
    const dynamic = new DynamicService({ store: db, resolver: new DefaultDynamicResolver(), clock })
    let raced = false
    // 模拟：自动刷新先读到 rev1，用户随后写入 rev2；刷新仍拿 rev1 去更新。
    const racing: { refreshById(id: string, options?: DynamicRefreshOptions): Promise<Entity | undefined> } = {
      async refreshById(entityId, options) {
        const refreshed = await dynamic.refreshById(entityId, options)
        if (refreshed === undefined || raced) return refreshed
        raced = true
        const user = await new UpdateService({ store: db }).update(
          { id: entityId, expectedRevision: refreshed.revision, title: '用户手改标题', status: 'blocked' },
          { actor: 'user', source: 'user' },
        )
        if (!user.ok) throw new Error(`测试用户写入失败：${user.error.message}`)
        // 返回旧 revision 的实体，模拟“AI 的读已经过期”。
        return refreshed
      },
    }
    const deps: ConsolidationDeps = {
      store: db,
      queries: new ForcedStaleQueries(db.db, [id]),
      updateService: new UpdateService({ store: db }),
      clock,
      dynamic: racing,
    }

    const first = await handleRefresh(deps)
    expect(first).toMatchObject({ refreshed: 1, statusUpdated: 0, skipped: 1 })
    const afterSkip = await db.get(id, { includeArchived: true })
    expect(attributeValue(afterSkip!, 'status')).toBe('blocked')
    expect(attributeValue(afterSkip!, 'title')).toBe('用户手改标题')
    expect(afterSkip?.revision).toBe(2)
    expect(afterSkip?.archivedAt).toBeUndefined()

    const skipped = await db.db.query<{
      actor: string
      actor_kind: string | null
      source: string | null
      before: Record<string, unknown> | null
      after: Record<string, unknown> | null
    }>(
      `select actor, actor_kind, source, before, after
         from omb.audit_log where action = 'auto-status-skipped'`,
    )
    expect(skipped.rows).toHaveLength(1)
    expect(skipped.rows[0]).toMatchObject({
      actor: 'system:refresh',
      actor_kind: 'system',
      source: 'system:refresh',
    })
    expect(skipped.rows[0]?.before).toMatchObject({ expectedRevision: 1, currentRevision: 2, currentStatus: 'blocked' })
    expect(skipped.rows[0]?.after).toMatchObject({ skipped: true, attemptedStatus: 'completed' })
    // 自动刷新不重试轮询：下一次运行重新读 rev2，条件更新成功并正常自动归档。
    const second = await handleRefresh(deps)
    expect(second).toMatchObject({ refreshed: 1, statusUpdated: 1, skipped: 0 })
    const afterRetry = await db.get(id, { includeArchived: true })
    expect(attributeValue(afterRetry!, 'status')).toBe('completed')
    expect(afterRetry?.revision).toBe(3)
    expect(afterRetry?.archivedAt).toBeDefined()
    const applied = await db.db.query<{ actor: string; actor_kind: string | null; source: string | null }>(
      `select actor, actor_kind, source from omb.audit_log where action = 'patch' order by id desc limit 1`,
    )
    expect(applied.rows[0]).toMatchObject({ actor: 'system:refresh', actor_kind: 'system', source: 'system:refresh' })
    await db.close()
  })

  it('给定遗忘任务读到旧 revision 当用户刚更新则归档 CAS 失败且不归档新状态', async () => {
    const db = store()
    const old = await write(db, memoryInput('很久以前的日志', '无关紧要'))
    const id = old.entity.id
    const read = await db.get(id)
    expect(read?.revision).toBe(1)
    const userNext: WriteEntityInput = { ...memoryInput('很久以前的日志', '用户刚更新的正文'), id }
    const user = await db.patch(
      normalized(userNext),
      { id, expectedRevision: 1, attrs: { body: '用户刚更新的正文' } },
      derived(userNext),
      { actor: 'user', source: 'user' },
    )
    expect(user.entity.revision).toBe(2)
    const stale: Forgettable = {
      id,
      salience: 0.1,
      category: 'event',
      pinned: false,
      updatedAt: read!.updatedAt,
      revision: read!.revision,
    }

    const result = await runForget({
      store: db,
      queries: { forgettable: async () => [stale] },
      clock: CLOCK,
    })
    expect(result).toMatchObject({ archived: 0, skipped: 1 })
    const after = await db.get(id, { includeArchived: true })
    expect(after?.revision).toBe(2)
    expect(after?.archivedAt).toBeUndefined()
    expect(attributeValue(after!, 'body')).toBe('用户刚更新的正文')
    const skipped = await db.db.query<{
      actor: string
      actor_kind: string | null
      source: string | null
      before: Record<string, unknown> | null
      after: Record<string, unknown> | null
    }>(
      `select actor, actor_kind, source, before, after
         from omb.audit_log where action = 'auto-forget-skipped'`,
    )
    expect(skipped.rows).toHaveLength(1)
    expect(skipped.rows[0]).toMatchObject({ actor: 'job:forget', actor_kind: 'job', source: 'job:forget' })
    expect(skipped.rows[0]?.before).toMatchObject({ expectedRevision: 1, currentRevision: 2 })
    expect(skipped.rows[0]?.after).toMatchObject({ skipped: true, reason: 'forgetting:0.100' })
    await db.close()
  })

  it('给定用户更新与归档同时提交当 revision 相同则条件更新只允许一方成功', async () => {
    const db = store()
    const state = await write(db, stateInput('归档竞争', 'in_progress'))
    const id = state.entity.id
    const service = new UpdateService({ store: db })
    const [patched, archived] = await Promise.all([
      service.update({ id, expectedRevision: 1, status: 'blocked', attrs: { body: '用户更新' } }, { actor: 'user', source: 'user' }),
      db.archive(id, 'forgetting:0.100', 'job:forget', 1).then(() => true, () => false),
    ])
    const successes = (patched.ok ? 1 : 0) + (archived ? 1 : 0)
    expect(successes).toBe(1)
    const after = await db.get(id, { includeArchived: true })
    expect(after?.revision).toBe(2)
    if (patched.ok) {
      expect(archived).toBe(false)
      expect(after?.archivedAt).toBeUndefined()
      expect(attributeValue(after!, 'status')).toBe('blocked')
    } else {
      expect(archived).toBe(true)
      expect(after?.archivedAt).toBeDefined()
      // 输的一方需要重新读取再决定（不是后台重试）：归档后更新返回可恢复错误。
      expect(['archived', 'not-found', 'conflict']).toContain(patched.error.code)
    }
    await db.close()
  })

  it('给定状态机补丁在审计写入时失败则历史、当前状态与审计同事务全部回滚', async () => {
    const db = store()
    const state = await write(db, stateInput('事务边界', 'in_progress', { body: '旧正文' }))
    const id = state.entity.id
    const service = new UpdateService({ store: db })
    const historyBefore = await db.history(id, 10)
    const auditsBefore = await countOf(db, 'select count(*)::text as count from omb.audit_log')
    const outboxBefore = await countOf(db, 'select count(*)::text as count from omb.outbox')
    // 预置同 stream 版本 2 的审计行：patch 的 rev2 事件将撞 audit_log_stream_version_unique，
    // 此时 state_version 快照、entity_view/entity 更新都已经在同一事务里执行过。
    await db.db.query(
      `insert into omb.audit_log (actor, action, target_ids, stream_id, stream_version)
       values ('seed', 'seed', array[$1]::text[], $1, 2)`,
      [id],
    )
    const auditsAfterSeed = await countOf(db, 'select count(*)::text as count from omb.audit_log')

    const result = await service.update({ id, expectedRevision: 1, status: 'blocked', attrs: { body: '新正文' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('conflict')
    expect(await revisionOf(db, id)).toBe(1)
    expect(await db.history(id, 10)).toEqual(historyBefore)
    expect(await countOf(db, `select count(*)::text as count from omb.entity where kind = 'state_version'`))
      .toBe(historyBefore.length)
    const view = await db.db.query<{ attrs: Record<string, unknown>; archived_at: string | null }>(
      'select attrs, archived_at from omb.entity_view where entity_id = $1',
      [id],
    )
    expect(view.rows[0]?.attrs['body']).toBe('旧正文')
    expect(view.rows[0]?.archived_at).toBeNull()
    expect(await countOf(db, 'select count(*)::text as count from omb.audit_log')).toBe(auditsAfterSeed)
    expect(await countOf(db, 'select count(*)::text as count from omb.outbox')).toBe(outboxBefore)
    expect(auditsAfterSeed).toBe(auditsBefore + 1)
    await db.close()
  })
})
