import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import {
  AttributeWriter,
  auditChainHash,
  type AuditChainEntry,
} from '../../../packages/v7/src/adapters/postgres/writer.js'
import { DefaultCommandBus, type CommandMeta } from '../../../packages/v7/src/app/commands/index.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { OmbFailure } from '../../../packages/v7/src/domain/errors.js'
import { deriveSearchText, deriveTriggers, normalizeWrite } from '../../../packages/v7/src/domain/validation.js'
import type { DerivedWrite } from '../../../packages/v7/src/ports/store.js'

/**
 * 审计 hash chain + rollback CAS 的真实 PostgreSQL 证据（Phase 4 Task 19、ADR-0010）。
 *
 * 覆盖：
 * - 写入命令在 audit_log 里形成 prev_hash → hash 链（含 command/event/revision）；
 * - 篡改 after/hash 会在校验时被抓到；
 * - 并发写入不 fork、每条 prev_hash 唯一；
 * - 回滚快照类审计时版本已前进 → conflict（不半写）；同一条审计并发回滚只有一笔生效；
 * - 正常回滚（补丁/创建/改名）仍成功，且回滚自身也进链。
 */

const DATABASE_URL = process.env.OMB_AUDIT_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_audit'

interface ChainRow {
  id: string
  actor: string
  action: string
  target_ids: string[]
  before: unknown
  after: unknown
  inverse: unknown
  job_id: string | null
  command_id: string | null
  stream_id: string | null
  stream_version: string | null
  event_type: string | null
  revision: string | null
  correlation_id: string | null
  causation_id: string | null
  actor_kind: string | null
  prev_hash: string | null
  hash: string | null
}

interface ChainBreak {
  readonly id: string
  readonly reason: 'prev-hash' | 'hash' | 'missing-hash'
}

async function readChain(db: PostgresDb): Promise<ChainRow[]> {
  const rows = await db.query<ChainRow>(
    `select id, actor, action, target_ids, before, after, inverse, job_id,
            command_id, stream_id, stream_version::text, event_type, revision::text,
            correlation_id, causation_id, actor_kind, prev_hash, hash
     from omb.audit_log order by id asc`,
  )
  return rows.rows
}

function entryOf(row: ChainRow): AuditChainEntry {
  return {
    actor: row.actor,
    action: row.action,
    targetIds: row.target_ids,
    jobId: row.job_id,
    commandId: row.command_id,
    streamId: row.stream_id,
    streamVersion: row.stream_version === null ? null : Number(row.stream_version),
    eventType: row.event_type,
    revision: row.revision === null ? null : Number(row.revision),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    actorKind: row.actor_kind,
    ...(row.before === null ? {} : { before: row.before as AuditChainEntry['before'] }),
    ...(row.after === null ? {} : { after: row.after as AuditChainEntry['after'] }),
    ...(row.inverse === null ? {} : { inverse: row.inverse as AuditChainEntry['inverse'] }),
  }
}

/** 独立校验器：按 id 顺序复算每条 hash，并检查 prev_hash 指向上一行。 */
function verifyChain(rows: readonly ChainRow[]): ChainBreak | undefined {
  let previous: string | null = null
  for (const row of rows) {
    if (row.hash === null) return { id: row.id, reason: 'missing-hash' }
    if (row.prev_hash !== previous) return { id: row.id, reason: 'prev-hash' }
    if (auditChainHash(previous, entryOf(row)) !== row.hash) return { id: row.id, reason: 'hash' }
    previous = row.hash
  }
  return undefined
}

function meta(): CommandMeta {
  return {
    commandId: randomUUID(),
    actor: { id: 'test', kind: 'system' },
    origin: 'test',
    correlationId: randomUUID(),
  }
}

function memory(title: string, body = '正文', attrs: Record<string, unknown> = {}): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body, ...attrs },
  }
}

function normalized(input: WriteEntityInput) {
  const result = normalizeWrite(input)
  if (!result.ok) throw new Error(`测试输入非法：${JSON.stringify(result.errors)}`)
  return result.value
}

function derived(input: WriteEntityInput): DerivedWrite {
  const value = normalized(input)
  return { searchText: deriveSearchText(value.attributes), triggers: deriveTriggers(value.attributes) }
}

describe('审计 hash chain + rollback CAS（真实 PostgreSQL）', () => {
  let db: PostgresDb
  let store: PostgresStore
  let writer: AttributeWriter
  let bus: DefaultCommandBus

  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    db = new PostgresDb({ connectionString: DATABASE_URL })
    store = new PostgresStore(DATABASE_URL)
    writer = new AttributeWriter(db)
    bus = new DefaultCommandBus({ store, writer })
  })

  beforeEach(async () => {
    await truncateAll(DATABASE_URL)
  })

  afterAll(async () => {
    await truncateAll(DATABASE_URL).catch(() => {})
    await store.close()
    await db.close()
  })

  async function create(title: string, attrs: Record<string, unknown> = {}): Promise<string> {
    const input = memory(title, `正文-${title}`, attrs)
    const written = await store.write(normalized(input), derived(input))
    return written.entity.id
  }

  async function entityTitle(id: string): Promise<string | undefined> {
    const entity = await store.get(id)
    const attribute = entity?.attributes.find(item => item.name === 'title')
    return attribute?.value.kind === 'static' ? String(attribute.value.value) : undefined
  }

  async function auditIdOf(sql: string, values: readonly unknown[]): Promise<number> {
    const rows = await db.query<{ id: string }>(sql, values)
    const id = rows.rows[0]?.id
    if (id === undefined) throw new Error('没有找到预期审计行')
    return Number(id)
  }

  it('给定写入/补丁/归档/取消归档当复算审计链则逐行 hash 与 prev_hash 全部匹配', async () => {
    const id = await create('链头', { note: 'A' })
    const patched = memory('链头二', '正文-链头二', { note: 'B' })
    await store.patch({ ...normalized(patched), id }, { id, expectedRevision: 1 }, derived(patched))
    await store.archive(id, '测试归档', 'test')
    await store.unarchive(id, '测试取消归档', 'test')

    const rows = await readChain(db)
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every(row => row.hash !== null)).toBe(true)
    expect(rows[0]?.prev_hash).toBeNull()
    expect(verifyChain(rows)).toBeUndefined()
    for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]?.prev_hash).toBe(rows[index - 1]?.hash)
    }
    // command/event/revision 都在载荷里：改任一字段都会得到不同 hash。
    const last = rows[rows.length - 1] as ChainRow
    const base = entryOf(last)
    expect(auditChainHash(last.prev_hash, base)).toBe(last.hash)
    expect(auditChainHash(last.prev_hash, { ...base, commandId: 'other-command' })).not.toBe(last.hash)
    expect(auditChainHash(last.prev_hash, { ...base, eventType: 'EntityCreated' })).not.toBe(last.hash)
    expect(auditChainHash(last.prev_hash, { ...base, revision: 99 })).not.toBe(last.hash)
  })

  it('给定篡改审计行 after 或 hash 当复算链则精确报到被改的那一行', async () => {
    const id = await create('可篡改')
    const patched = memory('可篡改二')
    await store.patch({ ...normalized(patched), id }, { id, expectedRevision: 1 }, derived(patched))

    const rows = await readChain(db)
    expect(rows).toHaveLength(2)
    const tamperedId = rows[1]?.id as string
    await db.query(`update omb.audit_log set after = '{"tampered":true}'::jsonb where id = $1`, [tamperedId])
    expect(verifyChain(await readChain(db))).toEqual({ id: tamperedId, reason: 'hash' })

    await db.query(`update omb.audit_log set hash = repeat('0', 64) where id = $1`, [rows[0]?.id])
    const breaks = verifyChain(await readChain(db))
    expect(breaks).toEqual({ id: rows[0]?.id, reason: 'hash' })
  })

  it('给定并发写入当复算链则链不 fork 且每条 prev_hash 唯一', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => create(`并发-${index}`)))

    const rows = await readChain(db)
    expect(rows).toHaveLength(8)
    expect(verifyChain(rows)).toBeUndefined()
    const prevHashes = rows.map(row => row.prev_hash)
    expect(new Set(prevHashes).size).toBe(prevHashes.length)
    expect(prevHashes.filter(value => value === null)).toHaveLength(1)
    expect(rows.map(row => row.command_id).filter(value => value !== null)).toHaveLength(8)
  })

  it('给定补丁后版本已前进当回滚旧补丁则 conflict 且数据保持新版本', async () => {
    const id = await create('版本一')
    const first = memory('版本二')
    await store.patch({ ...normalized(first), id }, { id, expectedRevision: 1 }, derived(first))
    const second = memory('版本三')
    await store.patch({ ...normalized(second), id }, { id, expectedRevision: 2 }, derived(second))

    const staleAudit = await auditIdOf(
      `select id from omb.audit_log where event_type = 'EntityPatched' and stream_id = $1 order by id asc limit 1`,
      [id],
    )
    const error = await store.rollback(staleAudit, 'test').catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(OmbFailure)
    const failure = error as OmbFailure
    expect(failure.error.code).toBe('conflict')
    expect(failure.error.details).toMatchObject({ currentRevision: 3, expectedRevision: 2 })

    expect(await entityTitle(id)).toBe('版本三')
    const audit = await db.query<{ rolled_back_at: Date | null }>(
      'select rolled_back_at from omb.audit_log where id = $1',
      [staleAudit],
    )
    expect(audit.rows[0]?.rolled_back_at).toBeNull()
    const rollbackAudits = await db.query<{ count: string }>(
      "select count(*)::text as count from omb.audit_log where action = 'rollback'",
    )
    expect(rollbackAudits.rows[0]?.count).toBe('0')
    // 失败的回滚不得在链里留下半条记录。
    expect(verifyChain(await readChain(db))).toBeUndefined()
  })

  it('给定同一条审计并发回滚当执行两次则只有一笔生效、另一笔 conflict', async () => {
    const id = await create('并发回滚')
    const patched = memory('并发回滚二')
    await store.patch({ ...normalized(patched), id }, { id, expectedRevision: 1 }, derived(patched))
    const patchAudit = await auditIdOf(
      `select id from omb.audit_log where event_type = 'EntityPatched' and stream_id = $1 limit 1`,
      [id],
    )

    const settled = await Promise.allSettled([
      store.rollback(patchAudit, 'actor-a'),
      store.rollback(patchAudit, 'actor-b'),
    ])
    const fulfilled = settled.filter(item => item.status === 'fulfilled')
    const rejected = settled.filter(item => item.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const failure = (rejected[0] as PromiseRejectedResult).reason
    expect(failure).toBeInstanceOf(OmbFailure)
    expect((failure as OmbFailure).error.code).toBe('conflict')
    expect((failure as OmbFailure).error.message).toContain('已回滚')

    const rollbackRows = await db.query<{ count: string; actor: string }>(
      "select count(*)::text as count, min(actor) as actor from omb.audit_log where action = 'rollback'",
    )
    expect(rollbackRows.rows[0]?.count).toBe('1')
    expect(await entityTitle(id)).toBe('并发回滚')
    expect(verifyChain(await readChain(db))).toBeUndefined()
  })

  it('给定补丁后可正常回滚当回滚则属性恢复且回滚自身也进链', async () => {
    const id = await create('旧标题', { note: '旧' })
    const patched = memory('新标题', '正文-新标题', { note: '新' })
    await store.patch({ ...normalized(patched), id }, { id, expectedRevision: 1 }, derived(patched))

    const patchAudit = await auditIdOf(
      `select id from omb.audit_log where event_type = 'EntityPatched' and stream_id = $1 limit 1`,
      [id],
    )
    const result = await store.rollback(patchAudit, 'test')
    expect(result.applied).toContain(`restore:${id}`)
    expect(result.rollbackAuditId).toBeGreaterThan(result.auditId)
    expect(await entityTitle(id)).toBe('旧标题')

    const rows = await readChain(db)
    const rollbackRow = rows.find(row => Number(row.id) === result.rollbackAuditId)
    expect(rollbackRow?.action).toBe('rollback')
    expect(rollbackRow?.hash).not.toBeNull()
    expect(rollbackRow?.prev_hash).toBe(rows[rows.length - 2]?.hash)
    expect(verifyChain(rows)).toBeUndefined()

    // 创建审计仍然可以回滚（remove_written 是状态切换，不受快照 CAS 限制）。
    const createAudit = await auditIdOf(
      `select id from omb.audit_log where event_type = 'EntityCreated' and stream_id = $1 limit 1`,
      [id],
    )
    const removed = await store.rollback(createAudit, 'test')
    expect(removed.applied).toContain(`remove_written:${id}`)
    expect(await store.get(id)).toBeUndefined()
  })

  it('给定属性改名后又有新补丁当回滚改名则 conflict；无后续修改时回滚成功', async () => {
    const first = await create('改名实体一', { 项目名: '甲' })
    const second = await create('改名实体二', { 项目名: '乙' })
    const renamed = await bus.execute(
      { type: 'RenameAttribute', from: '项目名', to: 'project_name', reason: '规范化' },
      meta(),
    )
    expect(renamed.ok).toBe(true)

    const renameAudit = await auditIdOf(
      "select id from omb.audit_log where event_type = 'AttributeRenamed' limit 1",
      [],
    )
    // 改名之后又发生一次写入：改名审计的逐实体快照已经过期。
    const later = memory('改名实体二', '正文-改名实体二', { project_name: '乙2' })
    await store.patch({ ...normalized(later), id: second }, { id: second, expectedRevision: 2 }, derived(later))
    const stale = await store.rollback(renameAudit, 'test').catch((failure: unknown) => failure)
    expect(stale).toBeInstanceOf(OmbFailure)
    expect((stale as OmbFailure).error.code).toBe('conflict')
    expect((stale as OmbFailure).error.details).toMatchObject({ currentRevision: 3, expectedRevision: 2 })
    // 冲突不半写：被拒绝的改名回滚没有动任何实体属性。
    const untouched = await store.get(first)
    expect(untouched?.attributes.map(item => item.name)).toContain('project_name')
    expect((await store.get(second))?.attributes.map(item => item.name)).toContain('project_name')

    // 另一个实体没有后续写入：同一条件检查通过后仍能恢复旧属性行。
    await truncateAll(DATABASE_URL)
    const only = await create('唯一改名实体', { 项目名: '丙' })
    const renamedAgain = await bus.execute(
      { type: 'RenameAttribute', from: '项目名', to: 'project_name', reason: '规范化' },
      meta(),
    )
    expect(renamedAgain.ok).toBe(true)
    const auditId = await auditIdOf("select id from omb.audit_log where event_type = 'AttributeRenamed' limit 1", [])
    const restored = await store.rollback(auditId, 'test')
    expect(restored.applied).toContain(`restore_attr_rows:${only}`)
    const entity = await store.get(only)
    expect(entity?.attributes.map(item => item.name)).toContain('项目名')
    expect(entity?.attributes.map(item => item.name)).not.toContain('project_name')
    expect(verifyChain(await readChain(db))).toBeUndefined()
  })

  it('给定并发补丁竞争当只有一条成功则审计链仍完整且失败事务无审计行', async () => {
    const id = await create('竞争')
    const first = memory('竞争甲')
    const second = memory('竞争乙')
    const [left, right] = await Promise.all([
      store.patch({ ...normalized(first), id }, { id, expectedRevision: 1 }, derived(first)).then(
        () => 'ok' as const,
        error => (error instanceof OmbFailure ? error.error.code : 'other'),
      ),
      store.patch({ ...normalized(second), id }, { id, expectedRevision: 1 }, derived(second)).then(
        () => 'ok' as const,
        error => (error instanceof OmbFailure ? error.error.code : 'other'),
      ),
    ])
    expect([left, right].filter(value => value === 'ok')).toHaveLength(1)
    expect([left, right].filter(value => value === 'conflict')).toHaveLength(1)

    const patchAudits = await db.query<{ count: string }>(
      `select count(*)::text as count from omb.audit_log where event_type = 'EntityPatched' and stream_id = $1`,
      [id],
    )
    expect(patchAudits.rows[0]?.count).toBe('1')
    expect(verifyChain(await readChain(db))).toBeUndefined()
  })
})
