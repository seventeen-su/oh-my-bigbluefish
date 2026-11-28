import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { AttributeWriter } from '../../../packages/v7/src/adapters/postgres/writer.js'
import {
  DefaultCommandBus,
  type CommandExecution,
  type CommandMeta,
} from '../../../packages/v7/src/app/commands/index.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { derived, normalized, prepareDatabase, resetDatabase, store, TEST_DATABASE_URL } from './helpers.js'

/**
 * CommandBus / AttributeWriter 的真实 PostgreSQL 证据（ARCHITECTURE-PLAN §4.1/§4.2、ADR-0007）。
 *
 * 覆盖：单事务写审计+outbox、CAS 冲突返回 currentRevision、commandId 幂等（串行/并发）、
 * 失败回滚无脏行、不同实体并发成功、旧 Store 路径委托不变、批量写语句数与属性数无关。
 */

/** 统计写事务里实际发出的语句：用来证明属性/注册表写入是单条多值语句，不是逐属性 N+1。 */
class CountingDb extends PostgresDb {
  readonly statements: string[] = []

  override async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return super.transaction(async client => {
      const counting = {
        query: (text: unknown, values?: unknown[]) => {
          this.statements.push(typeof text === 'string' ? text : JSON.stringify(text))
          return client.query(text as never, values as never)
        },
      } as unknown as PoolClient
      return work(counting)
    })
  }
}

async function countWriteStatements(input: WriteEntityInput): Promise<string[]> {
  const counted = new CountingDb({ connectionString: TEST_DATABASE_URL })
  try {
    const writer = new AttributeWriter(counted)
    const result = await writer.execute({ type: 'CreateEntity', input: normalized(input) }, meta())
    expect(result.revision).toBe(1)
    return counted.statements
  } finally {
    await counted.close()
  }
}

function meta(overrides: Partial<CommandMeta> = {}): CommandMeta {
  return {
    commandId: randomUUID(),
    actor: { id: 'test', kind: 'system' },
    origin: 'test',
    correlationId: randomUUID(),
    ...overrides,
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

function chain(group: readonly string[], title = '回滚链'): WriteEntityInput {
  return { kind: 'chain', scope: { kind: 'global' }, title, group: [...group] }
}

/** 实体写状态的完整快照：用于证明失败事务没有留下任何脏行。 */
async function snapshot(conn: ReturnType<typeof store>): Promise<{
  entity: number
  attributes: number
  views: number
  links: number
  chainMembers: number
  audit: number
  outbox: number
}> {
  const row = await conn.db.query<{
    entity: string
    attributes: string
    views: string
    links: string
    chain_members: string
    audit: string
    outbox: string
  }>(
    `select
       (select count(*) from omb.entity)::text as entity,
       (select count(*) from omb.attribute)::text as attributes,
       (select count(*) from omb.entity_view)::text as views,
       (select count(*) from omb.link)::text as links,
       (select count(*) from omb.chain_member)::text as chain_members,
       (select count(*) from omb.audit_log)::text as audit,
       (select count(*) from omb.outbox)::text as outbox`,
  )
  const values = row.rows[0]!
  return {
    entity: Number(values.entity),
    attributes: Number(values.attributes),
    views: Number(values.views),
    links: Number(values.links),
    chainMembers: Number(values.chain_members),
    audit: Number(values.audit),
    outbox: Number(values.outbox),
  }
}

describe('AttributeWriter / CommandBus（真实 PostgreSQL）', () => {
  let db: ReturnType<typeof store>
  let writer: AttributeWriter
  let bus: DefaultCommandBus

  beforeAll(async () => {
    await prepareDatabase()
    db = store()
    writer = new AttributeWriter(db.db)
    bus = new DefaultCommandBus({ store: db, writer })
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await resetDatabase()
    await db.close()
  })

  async function createMemory(title: string, attrs: Record<string, unknown> = {}): Promise<{ id: string; result: CommandExecution }> {
    const result = await bus.execute({ type: 'CreateEntity', input: memory(title, `正文-${title}`, attrs) }, meta())
    if (!result.ok) throw new Error(`创建失败：${result.error.message}`)
    const id = result.value.events[0]?.streamId
    if (id === undefined) throw new Error('创建没有返回事件')
    return { id, result }
  }

  it('给定 CreateEntity 命令当执行则同事务写属性/视图/审计/outbox 且事件可 JSON 序列化', async () => {
    const command = meta()
    const result = await bus.execute(
      { type: 'CreateEntity', input: memory('命令创建', '属性行派生视图') },
      command,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value
    expect(value.revision).toBe(1)
    expect(value.events).toHaveLength(1)
    const event = value.events[0]!
    expect(event.type).toBe('EntityCreated')
    expect(event.streamVersion).toBe(1)
    expect(event.actor).toEqual(command.actor)
    expect(event.origin).toBe('test')
    expect(event.occurredAt).toBeTruthy()
    // payload 必须是纯 JSON：序列化后与原值完全一致。
    expect(JSON.parse(JSON.stringify(event.payload))).toEqual(event.payload)
    const entityId = event.streamId
    expect(value.projectionToken.entityId).toBe(entityId)
    expect(value.projectionToken.watermark).toBe(event.id)

    const entity = await db.db.query<{ revision: string; origin: string }>(
      'select revision, origin from omb.entity where id = $1',
      [entityId],
    )
    expect(Number(entity.rows[0]?.revision)).toBe(1)
    const view = await db.db.query<{ search_text: string; attrs: Record<string, unknown> }>(
      'select search_text, attrs from omb.entity_view where entity_id = $1',
      [entityId],
    )
    // search_text 是分词结果（CJK bigram 以空格分隔），按词面断言而不是连续子串。
    expect(view.rows[0]?.search_text).toContain('属性')
    expect(view.rows[0]?.search_text).toContain('派生')
    expect(view.rows[0]?.attrs['body']).toBe('属性行派生视图')

    const audit = await db.db.query<{
      id: string
      event_type: string
      command_id: string
      stream_id: string
      stream_version: string
      actor_kind: string
      correlation_id: string
      inverse: unknown
    }>(
      `select id::text, event_type, command_id, stream_id, stream_version::text, actor_kind, correlation_id, inverse
       from omb.audit_log where command_id = $1`,
      [command.commandId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({
      event_type: 'EntityCreated',
      command_id: command.commandId,
      stream_id: entityId,
      stream_version: '1',
      actor_kind: 'system',
      correlation_id: command.correlationId,
    })
    const outbox = await db.db.query<{ event_id: string; topic: string; payload: Record<string, unknown> }>(
      'select event_id::text, topic, payload from omb.outbox where event_id = $1',
      [audit.rows[0]!.id],
    )
    expect(outbox.rows).toHaveLength(1)
    expect(outbox.rows[0]?.topic).toBe('EntityCreated')
    expect(outbox.rows[0]?.payload['id']).toBe(audit.rows[0]!.id)
    expect(outbox.rows[0]?.payload['streamId']).toBe(entityId)
    // 写事务内不做相似查询/嵌入：两张异步表都为空。
    expect((await db.db.query('select 1 from omb.embedding')).rowCount).toBe(0)
    expect((await db.db.query('select 1 from omb.similar_cache')).rowCount).toBe(0)
  })

  it('给定 40 个属性当 CreateEntity 则写事务语句数与 2 个属性时完全相同（单条多值写，无逐属性 N+1）', async () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 40; i += 1) many[`field_${i}`] = `值 ${i}`
    const longStatements = await countWriteStatements(memory('批量语句多', '正文', many))
    const shortStatements = await countWriteStatements(memory('批量语句少', '正文', { note: '一' }))
    expect(longStatements).toHaveLength(shortStatements.length)
    // 属性与注册表各一条 insert；不能出现按属性重复的 insert。
    const attributeInserts = longStatements.filter(sql => sql.includes('insert into omb.attribute'))
    const registryInsert = longStatements.filter(sql => sql.includes('insert into omb.attr_registry'))
    expect(attributeInserts).toHaveLength(1)
    expect(registryInsert).toHaveLength(1)
    // 写事务内不得跑相似查询：相似建议在提交后由 Store.write 的只读查询给出（ADR-0013）。
    expect(longStatements.some(sql => /to_tsquery|similarity\(/i.test(sql))).toBe(false)
  })

  it('给定多属性含触发键与动态引用当写入则属性/注册表/触发键/引用/视图一次落库', async () => {
    const target = await createMemory('批量引用目标')
    const attrs: Record<string, unknown> = {}
    for (let i = 0; i < 30; i += 1) attrs[`field_${i}`] = `值 ${i}`
    attrs['tool'] = 'bash'
    attrs['error'] = 'E_BATCH_001'
    attrs['path'] = 'C:\\work\\batch\\file.ts'
    attrs['mirror'] = { $dynamic: { kind: 'ref', entityId: target.id, attr: 'title' } }
    attrs['twin'] = { $dynamic: { kind: 'ref', entityId: target.id } }
    const command = meta()
    const result = await bus.execute({ type: 'CreateEntity', input: memory('批量落库', '批量正文', attrs) }, command)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = result.value.events[0]!.streamId

    const rows = await attributeRows(db, id)
    // 3 个必填 + title/body + 30 field_* + tool/error/path/mirror/twin。
    expect(rows).toHaveLength(3 + 2 + 30 + 5)

    const registry = await db.db.query<{ name: string; usage_count: string }>(
      "select name, usage_count::text from omb.attr_registry where name like 'field\\_%' order by name",
    )
    expect(registry.rows).toHaveLength(30)
    expect(registry.rows.every(row => Number(row.usage_count) === 1)).toBe(true)

    const triggers = await db.db.query<{ kind: string; key: string }>(
      'select kind, key from omb.trigger_key where entity_id = $1 order by kind, key',
      [id],
    )
    expect(triggers.rows).toEqual(expect.arrayContaining([
      { kind: 'tool', key: 'bash' },
      { kind: 'error', key: 'E_BATCH_001' },
      { kind: 'path', key: 'C:\\work\\batch\\file.ts' },
      { kind: 'entity', key: target.id },
    ]))

    const references = await db.db.query<{ source_attr_name: string; target_entity_id: string; kind: string }>(
      'select source_attr_name, target_entity_id, kind from omb.reference where source_entity_id = $1 order by source_attr_name',
      [id],
    )
    expect(references.rows).toEqual([
      { source_attr_name: 'mirror', target_entity_id: target.id, kind: 'ref' },
      { source_attr_name: 'twin', target_entity_id: target.id, kind: 'ref' },
    ])

    const view = await db.db.query<{ search_text: string; attrs: Record<string, unknown> }>(
      'select search_text, attrs from omb.entity_view where entity_id = $1',
      [id],
    )
    expect(view.rows[0]?.search_text).toContain('批量')
    expect(view.rows[0]?.attrs['field_29']).toBe('值 29')
    expect(rows.map(row => row.name)).toContain('mirror')
    expect(await count('omb.audit_log', 'command_id = $1', [command.commandId])).toBe(1)
    expect(await count(
      'omb.outbox',
      'event_id in (select id from omb.audit_log where command_id = $1)',
      [command.commandId],
    )).toBe(1)
  })

  it('给定同名可选属性两次写入当批量 upsert 注册表则 usage_count 累加且 last_seen 更新', async () => {
    await createMemory('注册一', { note: '甲' })
    await createMemory('注册二', { note: '乙' })
    const registry = await db.db.query<{ usage_count: string; value_kind: string; last_seen: Date | string }>(
      "select usage_count::text, value_kind, last_seen from omb.attr_registry where name = 'note'",
    )
    expect(registry.rows).toHaveLength(1)
    expect(Number(registry.rows[0]?.usage_count)).toBe(2)
    expect(registry.rows[0]?.value_kind).toBe('static')
    expect(registry.rows[0]?.last_seen).toBeTruthy()
  })

  it('给定动态属性缓存当补丁 spec 不变则保留缓存、spec 变化则丢弃', async () => {
    const target = await createMemory('缓存目标')
    const input: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '缓存来源',
        mirror: { $dynamic: { kind: 'ref', entityId: target.id, attr: 'title' } },
        other: '保留',
      },
    }
    const written = await db.write(normalized(input), derived(input))
    const ordinal = written.entity.attributes.find(attribute => attribute.name === 'mirror')?.ordinal ?? 0
    const cachedAt = new Date().toISOString()
    await db.setAttributeCache(written.entity.id, 'mirror', ordinal, '目标标题', cachedAt)

    const same: WriteEntityInput = { ...input, id: written.entity.id }
    await db.patch(normalized(same), { id: written.entity.id, expectedRevision: 1 }, derived(same))
    const preserved = (await db.get(written.entity.id))?.attributes.find(attribute => attribute.name === 'mirror')?.value
    expect(preserved?.kind).toBe('dynamic')
    expect(preserved?.kind === 'dynamic' ? preserved.cachedValue : undefined).toBe('目标标题')
    expect(preserved?.kind === 'dynamic' ? preserved.cachedAt : undefined).toBe(cachedAt)

    const changed: WriteEntityInput = {
      ...input,
      id: written.entity.id,
      attrs: {
        title: '缓存来源',
        mirror: { $dynamic: { kind: 'ref', entityId: target.id, attr: 'body' } },
        other: '保留',
      },
    }
    await db.patch(normalized(changed), { id: written.entity.id, expectedRevision: 2 }, derived(changed))
    const dropped = (await db.get(written.entity.id))?.attributes.find(attribute => attribute.name === 'mirror')?.value
    expect(dropped?.kind).toBe('dynamic')
    expect(dropped?.kind === 'dynamic' ? dropped.cachedValue : undefined).toBeUndefined()
  })

  it('给定 PatchEntity 命令当 expectedRevision 匹配则版本 +1、视图重派生、审计/outbox 各一条', async () => {
    const created = await createMemory('补丁目标', { note: '旧' })
    const command = meta()
    const result = await bus.execute(
      { type: 'PatchEntity', input: { id: created.id, expectedRevision: 1, attrs: { note: '新', extra: 'x' } } },
      command,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.revision).toBe(2)
    expect(result.value.events[0]?.type).toBe('EntityPatched')
    expect(result.value.events[0]?.streamVersion).toBe(2)
    const view = await db.db.query<{ search_text: string; attrs: Record<string, unknown> }>(
      'select search_text, attrs from omb.entity_view where entity_id = $1',
      [created.id],
    )
    expect(view.rows[0]?.attrs['note']).toBe('新')
    expect(view.rows[0]?.attrs['extra']).toBe('x')
    expect(view.rows[0]?.search_text).toContain('新')
    const audit = await db.db.query<{ event_type: string; stream_version: string; command_id: string }>(
      'select event_type, stream_version::text, command_id from omb.audit_log where command_id = $1',
      [command.commandId],
    )
    expect(audit.rows[0]).toMatchObject({ event_type: 'EntityPatched', stream_version: '2', command_id: command.commandId })
    expect(await count('omb.outbox')).toBe(2)
  })

  it('给定同实体两条并发补丁当 expectedRevision 相同则一条成功、一条冲突且 currentRevision 正确', async () => {
    const created = await createMemory('并发冲突')
    const firstCommand = meta()
    const secondCommand = meta()
    const first = bus.execute(
      { type: 'PatchEntity', input: { id: created.id, expectedRevision: 1, attrs: { note: 'A' } } },
      firstCommand,
    )
    const second = bus.execute(
      { type: 'PatchEntity', input: { id: created.id, expectedRevision: 1, attrs: { note: 'B' } } },
      secondCommand,
    )
    const results = await Promise.all([first, second])
    const succeeded = results.filter(item => item.ok)
    const conflicted = results.filter(item => !item.ok)
    expect(succeeded).toHaveLength(1)
    expect(conflicted).toHaveLength(1)
    const conflict = conflicted[0]!
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('conflict')
      expect(conflict.error.currentRevision).toBe(2)
    }
    const entity = await db.db.query<{ revision: string }>('select revision from omb.entity where id = $1', [created.id])
    expect(Number(entity.rows[0]?.revision)).toBe(2)
    // 只有成功的那条命令写了审计/outbox，冲突命令没有半写。
    expect(await count('omb.audit_log', "action = 'patch'")).toBe(1)
    expect(await count('omb.outbox', "topic = 'EntityPatched'")).toBe(1)
  })

  it('给定不同实体并发创建当同时执行则全部成功且各自一条事件', async () => {
    const commands = Array.from({ length: 6 }, (_, index) => ({
      command: meta(),
      input: memory(`并发实体-${index}`),
    }))
    const results = await Promise.all(
      commands.map(item => bus.execute({ type: 'CreateEntity', input: item.input }, item.command)),
    )
    expect(results.every(item => item.ok)).toBe(true)
    expect(await count('omb.entity')).toBe(6)
    expect(await count('omb.entity_view')).toBe(6)
    expect(await count('omb.audit_log')).toBe(6)
    expect(await count('omb.outbox')).toBe(6)
    const revisions = new Set(
      results.flatMap(item => item.ok ? [item.value.revision] : []),
    )
    expect(revisions).toEqual(new Set([1]))
  })

  it('给定重复 commandId 串行提交当再次执行则返回首次结果且不重复写', async () => {
    const command = meta()
    const input = memory('幂等串行')
    const first = await bus.execute({ type: 'CreateEntity', input }, command)
    const second = await bus.execute({ type: 'CreateEntity', input }, command)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.events).toEqual(first.value.events)
    expect(second.value.revision).toBe(first.value.revision)
    expect(second.value.projectionToken).toEqual(first.value.projectionToken)
    expect(await count('omb.entity')).toBe(1)
    expect(await count('omb.audit_log', 'command_id = $1', [command.commandId])).toBe(1)
    expect(await count('omb.outbox')).toBe(1)
  })

  it('给定重复 commandId 并发提交当同时执行则仍只生效一次', async () => {
    const command = meta()
    const input = memory('幂等并发')
    const [first, second] = await Promise.all([
      bus.execute({ type: 'CreateEntity', input }, command),
      bus.execute({ type: 'CreateEntity', input }, command),
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.events[0]?.id).toBe(first.value.events[0]?.id)
    expect(await count('omb.entity')).toBe(1)
    expect(await count('omb.audit_log')).toBe(1)
    expect(await count('omb.outbox')).toBe(1)
  })

  it('给定思维链补丁含不存在成员当写入则失败且无 entity/attribute/view/audit/outbox 脏行', async () => {
    const left = await createMemory('链成员左')
    const chainCreated = await bus.execute(
      { type: 'CreateEntity', input: chain([left.id]) },
      meta(),
    )
    expect(chainCreated.ok).toBe(true)
    if (!chainCreated.ok) return
    const chainId = chainCreated.value.events[0]!.streamId
    const before = await snapshot(db)
    const beforeAttributes = await attributeRows(db, chainId)
    const beforeView = await viewRow(db, chainId)
    const command = meta()
    const result = await bus.execute(
      {
        type: 'PatchEntity',
        input: { id: chainId, expectedRevision: 1, group: [left.id, `mem_${randomUUID()}`] },
      },
      command,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not-found')
    expect(await snapshot(db)).toEqual(before)
    expect(await attributeRows(db, chainId)).toEqual(beforeAttributes)
    expect(await viewRow(db, chainId)).toEqual(beforeView)
    expect(await count('omb.audit_log', 'command_id = $1', [command.commandId])).toBe(0)
    const entity = await db.db.query<{ revision: string }>('select revision from omb.entity where id = $1', [chainId])
    expect(Number(entity.rows[0]?.revision)).toBe(1)
  })

  it('给定 CreateEntity 含不存在链成员当失败则实体与事件都不落库', async () => {
    const left = await createMemory('已有成员')
    const before = await snapshot(db)
    const command = meta()
    const result = await bus.execute(
      { type: 'CreateEntity', input: chain([left.id, `mem_${randomUUID()}`]) },
      command,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not-found')
    expect(await snapshot(db)).toEqual(before)
    expect(await count('omb.audit_log', 'command_id = $1', [command.commandId])).toBe(0)
  })

  it('给定过期 expectedRevision 当补丁则冲突不半写且 currentRevision 是当前版本', async () => {
    const created = await createMemory('冲突不半写', { note: '旧' })
    const before = await snapshot(db)
    const beforeAttributes = await attributeRows(db, created.id)
    const result = await bus.execute(
      { type: 'PatchEntity', input: { id: created.id, expectedRevision: 99, attrs: { note: '不该写' } } },
      meta(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('conflict')
      expect(result.error.currentRevision).toBe(1)
    }
    expect(await snapshot(db)).toEqual(before)
    expect(await attributeRows(db, created.id)).toEqual(beforeAttributes)
  })

  it('给定归档/取消归档命令当执行则版本前进、视图同步，并能用首次结果重放', async () => {
    const created = await createMemory('归档目标')
    const archiveCommand = meta({ expectedRevision: 1 })
    const archived = await bus.execute(
      { type: 'ArchiveEntity', id: created.id, reason: 'cleanup' },
      archiveCommand,
    )
    expect(archived.ok).toBe(true)
    if (!archived.ok) return
    expect(archived.value.revision).toBe(2)
    expect(archived.value.events[0]?.type).toBe('EntityArchived')
    const archivedRow = await db.db.query<{ archived_at: string | null; revision: string; archive_reason: string | null }>(
      'select archived_at, revision, archive_reason from omb.entity where id = $1',
      [created.id],
    )
    expect(archivedRow.rows[0]?.archived_at).not.toBeNull()
    expect(archivedRow.rows[0]?.archive_reason).toBe('cleanup')
    expect(Number(archivedRow.rows[0]?.revision)).toBe(2)
    const archivedView = await db.db.query<{ archived_at: string | null }>(
      'select archived_at from omb.entity_view where entity_id = $1',
      [created.id],
    )
    expect(archivedView.rows[0]?.archived_at).not.toBeNull()
    expect(await db.get(created.id)).toBeUndefined()

    // 同一 commandId 重放：返回首次结果，不再改库。
    const replay = await bus.execute(
      { type: 'ArchiveEntity', id: created.id, reason: 'cleanup' },
      archiveCommand,
    )
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.value.events).toEqual(archived.value.events)
    expect(await count('omb.audit_log', "event_type = 'EntityArchived'")).toBe(1)

    const unarchiveCommand = meta({ expectedRevision: 2 })
    const unarchived = await bus.execute(
      { type: 'UnarchiveEntity', id: created.id, reason: 'restore' },
      unarchiveCommand,
    )
    expect(unarchived.ok).toBe(true)
    if (unarchived.ok) {
      expect(unarchived.value.revision).toBe(3)
      expect(unarchived.value.events[0]?.type).toBe('EntityUnarchived')
    }
    expect((await db.get(created.id))?.archivedAt).toBeUndefined()

    const stale = await bus.execute(
      { type: 'ArchiveEntity', id: created.id, reason: 'again' },
      meta({ expectedRevision: 2 }),
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.error.code).toBe('conflict')
      expect(stale.error.currentRevision).toBe(3)
    }
    expect((await db.get(created.id))?.archivedAt).toBeUndefined()
  })

  it('给定链接/取消链接命令当执行则写 link 与事件，重复链接不产生第二条事件', async () => {
    const left = await createMemory('链接左')
    const right = await createMemory('链接右')
    const linkCommand = meta()
    const linked = await bus.execute(
      { type: 'Link', input: { fromId: left.id, toId: right.id, relation: 'related_to' } },
      linkCommand,
    )
    expect(linked.ok).toBe(true)
    if (!linked.ok) return
    expect(linked.value.events[0]?.type).toBe('LinkCreated')
    const linkRow = await db.db.query<{ id: string; archived_at: string | null }>(
      'select id, archived_at from omb.link where from_id = $1 and to_id = $2 and relation = $3',
      [left.id, right.id, 'related_to'],
    )
    expect(linkRow.rows).toHaveLength(1)
    expect(linkRow.rows[0]?.archived_at).toBeNull()
    const linkId = linkRow.rows[0]!.id
    const audit = await db.db.query<{ stream_id: string; command_id: string }>(
      'select stream_id, command_id from omb.audit_log where command_id = $1',
      [linkCommand.commandId],
    )
    expect(audit.rows[0]).toMatchObject({ stream_id: linkId, command_id: linkCommand.commandId })

    // 旧路径重复链接：created=false，不再写审计/outbox。
    const legacyDuplicate = await db.link({ fromId: left.id, toId: right.id, relation: 'related_to' })
    expect(legacyDuplicate.created).toBe(false)
    expect(await count('omb.audit_log', "action = 'link'")).toBe(1)

    const unlinked = await bus.execute({ type: 'Unlink', linkId }, meta())
    expect(unlinked.ok).toBe(true)
    if (unlinked.ok) expect(unlinked.value.events[0]?.type).toBe('LinkUnlinked')
    const archivedLink = await db.db.query<{ archived_at: string | null }>('select archived_at from omb.link where id = $1', [linkId])
    expect(archivedLink.rows[0]?.archived_at).not.toBeNull()

    // 回滚 unlink（restore_link）后再次 unlink：link stream 版本必须继续 +1，不能复用旧版本撞唯一索引。
    const unlinkAudit = await db.db.query<{ id: string }>("select id::text from omb.audit_log where action = 'unlink' order by id desc limit 1")
    await db.rollback(Number(unlinkAudit.rows[0]?.id), 'test')
    const relinked = await db.db.query<{ archived_at: string | null }>('select archived_at from omb.link where id = $1', [linkId])
    expect(relinked.rows[0]?.archived_at).toBeNull()
    const unlinkedAgain = await bus.execute({ type: 'Unlink', linkId }, meta())
    expect(unlinkedAgain.ok).toBe(true)
    if (unlinkedAgain.ok) {
      expect(unlinkedAgain.value.events[0]?.type).toBe('LinkUnlinked')
      expect(unlinkedAgain.value.revision).toBe(3)
    }
    expect(await count('omb.audit_log', "action = 'unlink'")).toBe(2)

    const missing = await bus.execute({ type: 'Unlink', linkId: `lnk_${randomUUID()}` }, meta())
    expect(missing.ok).toBe(true)
    if (missing.ok) {
      expect(missing.value.events).toEqual([])
      expect(missing.value.revision).toBe(0)
    }
  })

  it('给定 RenameAttribute 命令当执行则属性行/注册表/视图同事务改名并可审计回滚', async () => {
    const first = await createMemory('改名一', { 项目名: '甲' })
    const second = await createMemory('改名二', { 项目名: '乙' })
    const command = meta()
    const renamed = await bus.execute(
      { type: 'RenameAttribute', from: '项目名', to: 'project_name', reason: '规范化' },
      command,
    )
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) return
    expect(renamed.value.events[0]?.type).toBe('AttributeRenamed')
    const payload = renamed.value.events[0]?.payload as Record<string, unknown>
    expect(payload['from']).toBe('项目名')
    expect(payload['to']).toBe('project_name')
    expect(new Set(payload['entityIds'] as string[])).toEqual(new Set([first.id, second.id]))
    for (const id of [first.id, second.id]) {
      const entity = await db.db.query<{ revision: string }>('select revision from omb.entity where id = $1', [id])
      expect(Number(entity.rows[0]?.revision)).toBe(2)
      const names = (await attributeRows(db, id)).map(row => row.name)
      expect(names).toContain('project_name')
      expect(names).not.toContain('项目名')
      const view = await db.db.query<{ attrs: Record<string, unknown>; search_text: string }>(
        'select attrs, search_text from omb.entity_view where entity_id = $1',
        [id],
      )
      expect(view.rows[0]?.attrs).toHaveProperty('project_name')
      expect(view.rows[0]?.attrs).not.toHaveProperty('项目名')
      expect(view.rows[0]?.search_text).toContain(id === first.id ? '甲' : '乙')
    }
    const registry = await db.db.query<{ name: string; aliases: string[] }>(
      "select name, aliases from omb.attr_registry where name in ('项目名', 'project_name') order by name",
    )
    expect(registry.rows).toHaveLength(1)
    expect(registry.rows[0]?.name).toBe('project_name')
    expect(registry.rows[0]?.aliases).toContain('项目名')
    expect(await count('omb.audit_log', "action = 'rename-attr'")).toBe(1)

    const auditId = Number(
      (await db.db.query<{ id: string }>("select id::text from omb.audit_log where action = 'rename-attr'")).rows[0]?.id,
    )
    const rolledBack = await db.rollback(auditId, 'test')
    expect(rolledBack.applied).toContain(`restore_attr_rows:${first.id}`)
    for (const id of [first.id, second.id]) {
      expect((await attributeRows(db, id)).map(row => row.name)).toContain('项目名')
    }

    const missing = await bus.execute(
      { type: 'RenameAttribute', from: '不存在的属性', to: 'whatever', reason: 'noop' },
      meta(),
    )
    expect(missing.ok).toBe(true)
    if (missing.ok) {
      expect(missing.value.events).toEqual([])
      expect(missing.value.revision).toBe(0)
    }
  })

  it('给定旧 Store.write/patch/archive 路径当调用则返回值不变且同样写事件/outbox', async () => {
    const input = memory('旧路径', '旧正文')
    const written = await db.write(normalized(input), derived(input))
    expect(written.entity.revision).toBe(1)
    expect(written.similarAttributes).toBeInstanceOf(Array)
    expect(written.similarEntities).toBeInstanceOf(Array)
    expect(written.archivedMatches).toBeInstanceOf(Array)
    const writeAudit = await db.db.query<{ command_id: string | null; event_type: string }>(
      "select command_id, event_type from omb.audit_log where action = 'write'",
    )
    expect(writeAudit.rows[0]?.command_id).toBeTruthy()
    expect(writeAudit.rows[0]?.event_type).toBe('EntityCreated')
    expect(await count('omb.outbox', "topic = 'EntityCreated'")).toBe(1)

    const nextInput: WriteEntityInput = { ...input, id: written.entity.id, attrs: { title: '旧路径', body: '新正文' } }
    const patched = await db.patch(
      normalized(nextInput),
      { id: written.entity.id, expectedRevision: 1 },
      derived(nextInput),
    )
    expect(patched.entity.revision).toBe(2)
    expect(patched.history).toBeUndefined()
    expect(await count('omb.outbox', "topic = 'EntityPatched'")).toBe(1)

    await db.archive(written.entity.id, '旧路径归档', 'job:forget')
    const archived = await db.db.query<{ revision: string; archived_at: string | null }>(
      'select revision, archived_at from omb.entity where id = $1',
      [written.entity.id],
    )
    expect(Number(archived.rows[0]?.revision)).toBe(3)
    expect(archived.rows[0]?.archived_at).not.toBeNull()
    expect(await db.get(written.entity.id)).toBeUndefined()
    expect((await db.get(written.entity.id, { includeArchived: true }))?.archiveReason).toBe('旧路径归档')
  })

  it('给定 commandId 当按 command_id 精确查找则使用 audit_log_command_unique 部分索引', async () => {
    await createMemory('索引探针')
    const plan = await db.db.transaction(async client => {
      await client.query('set local enable_seqscan = off')
      const result = await client.query<{ 'QUERY PLAN': string }>(
        "explain select 1 from omb.audit_log where command_id = 'probe'",
      )
      return result.rows.map(row => row['QUERY PLAN']).join('\n')
    })
    expect(plan).toContain('audit_log_command_unique')
  })
})

async function count(
  table: string,
  where?: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const db = store()
  try {
    const result = await db.db.query<{ count: string }>(
      `select count(*)::text as count from ${table}${where === undefined ? '' : ` where ${where}`}`,
      params,
    )
    return Number(result.rows[0]?.count ?? 0)
  } finally {
    await db.close()
  }
}

async function attributeRows(
  db: ReturnType<typeof store>,
  entityId: string,
): Promise<Array<{ name: string; ordinal: number; value_kind: string; value: unknown }>> {
  const result = await db.db.query<{ name: string; ordinal: number; value_kind: string; value: unknown }>(
    'select name, ordinal, value_kind, value from omb.attribute where entity_id = $1 order by name, ordinal',
    [entityId],
  )
  return result.rows
}

async function viewRow(
  db: ReturnType<typeof store>,
  entityId: string,
): Promise<{ search_text: string; attrs: unknown } | undefined> {
  const result = await db.db.query<{ search_text: string; attrs: unknown }>(
    'select search_text, attrs from omb.entity_view where entity_id = $1',
    [entityId],
  )
  return result.rows[0]
}
