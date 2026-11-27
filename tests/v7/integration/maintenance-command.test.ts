import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresDb, type PostgresConfig } from '../../../packages/v7/src/adapters/postgres/db.js'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { OUTBOX_NOTIFY_CHANNEL, PostgresOutboxNotifier } from '../../../packages/v7/src/adapters/postgres/outbox.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { AttributeWriter } from '../../../packages/v7/src/adapters/postgres/writer.js'
import { DefaultCommandBus, type CommandMeta } from '../../../packages/v7/src/app/commands/index.js'
import type { RawAttributeValue, WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'

/**
 * 独立测试库：不读写 omb_v7_test / 生产库（本套件要装临时 deferred 触发器证明回滚语义）。
 * 覆盖 Task 7b：writer 同事务 NOTIFY、重复命令不重复通知、事务回滚不通知，
 * 以及 maintenance.renameAttribute 收编到 AttributeWriter 后的同事务一致性。
 */
const DATABASE_URL = process.env.OMB_INTEGRATION_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_integration'

/** 触发器伪装成“提交期失败”，不依赖真实进程崩溃也不改动迁移。 */
const COMMIT_GUARD_FUNCTION = 'omb.integration_commit_guard'
const COMMIT_GUARD_TRIGGER = 'integration_commit_guard'

function meta(overrides: Partial<CommandMeta> = {}): CommandMeta {
  return {
    commandId: randomUUID(),
    actor: { id: 'test', kind: 'system' },
    origin: 'test',
    correlationId: randomUUID(),
    ...overrides,
  }
}

function memory(id: string | undefined, title: string, attrs: Record<string, RawAttributeValue> = {}): WriteEntityInput {
  return {
    ...(id === undefined ? {} : { id }),
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, ...attrs },
  }
}

/**
 * 独立 LISTEN 连接：断言 channel 与 payload（event_id）。`PostgresOutboxNotifier`
 * 只暴露“被唤醒”，拿不到载荷，这里用更原始的连接补齐证据。
 */
class OutboxProbe {
  private readonly client: pg.Client
  private readonly payloads: string[] = []
  private listening = false

  constructor(config: PostgresConfig) {
    this.client = new pg.Client({
      connectionString: config.connectionString,
      application_name: 'omb-v7-test-outbox-probe',
      connectionTimeoutMillis: 5_000,
    })
  }

  async listen(): Promise<void> {
    await this.client.connect()
    this.client.on('notification', message => {
      if (message.channel !== OUTBOX_NOTIFY_CHANNEL) return
      this.payloads.push(message.payload ?? '')
    })
    await this.client.query(`listen ${OUTBOX_NOTIFY_CHANNEL}`)
    this.listening = true
  }

  reset(): void {
    this.payloads.length = 0
  }

  received(): readonly string[] {
    return [...this.payloads]
  }

  async close(): Promise<void> {
    if (!this.listening) return
    this.listening = false
    await this.client.end().catch(() => {})
  }
}

/** 有上界的条件轮询：25ms 只是重试间隔，不是用睡眠当同步/断言（test-sleep 已显式豁免）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待条件超时')
    await new Promise<void>(resolve => {
      // check:ignore-next-line test-sleep
      setTimeout(resolve, 25)
    })
  }
}

/**
 * 在 omb.outbox 上装 DEFERRABLE INITIALLY DEFERRED 约束触发器：目标 stream 的 outbox 行
 * 插入本身成功，事务 COMMIT 时才抛异常。生产库不装；只在本测试库临时创建并在测试后删除。
 */
async function installCommitGuard(db: PostgresDb, streamId: string): Promise<void> {
  const literal = streamId.replaceAll("'", "''")
  await db.query(`
    create or replace function ${COMMIT_GUARD_FUNCTION}() returns trigger
    language plpgsql as $guard$
    begin
      if new.payload->>'streamId' = '${literal}' then
        raise exception 'forced commit failure: %', new.payload->>'streamId';
      end if;
      return new;
    end
    $guard$;
    drop trigger if exists ${COMMIT_GUARD_TRIGGER} on omb.outbox;
    create constraint trigger ${COMMIT_GUARD_TRIGGER}
      after insert on omb.outbox
      deferrable initially deferred
      for each row execute function ${COMMIT_GUARD_FUNCTION}();
  `)
}

async function cleanupCommitGuard(db: PostgresDb): Promise<void> {
  await db.query(`drop trigger if exists ${COMMIT_GUARD_TRIGGER} on omb.outbox`)
  await db.query(`drop function if exists ${COMMIT_GUARD_FUNCTION}()`)
}

describe('writer outbox NOTIFY 与 maintenance rename 收编（真实 PostgreSQL）', () => {
  let store: PostgresStore
  let writer: AttributeWriter
  let bus: DefaultCommandBus
  let probe: OutboxProbe

  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    store = new PostgresStore(DATABASE_URL)
    writer = new AttributeWriter(store.db)
    bus = new DefaultCommandBus({ store, writer })
    probe = new OutboxProbe({ connectionString: DATABASE_URL })
    await probe.listen()
  })

  beforeEach(async () => {
    await truncateAll(DATABASE_URL)
    probe.reset()
  })

  afterEach(async () => {
    await cleanupCommitGuard(store.db)
  })

  afterAll(async () => {
    await cleanupCommitGuard(store.db).catch(() => {})
    await probe.close()
    await store.close()
  })

  async function createMemory(
    title: string,
    attrs: Record<string, RawAttributeValue> = {},
    id?: string,
  ): Promise<string> {
    const result = await bus.execute({ type: 'CreateEntity', input: memory(id, title, attrs) }, meta())
    if (!result.ok) throw new Error(`创建失败：${result.error.message}`)
    const created = result.value.events[0]?.streamId
    if (created === undefined) throw new Error('创建没有返回事件')
    return created
  }

  async function count(table: string, where?: string, params: readonly unknown[] = []): Promise<number> {
    const result = await store.db.query<{ count: string }>(
      `select count(*)::text as count from ${table}${where === undefined ? '' : ` where ${where}`}`,
      params,
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  it('给定 writer 命令提交当监听 omb_outbox 则收到一次以 event_id 为载荷的通知', async () => {
    const notifier = new PostgresOutboxNotifier({ connectionString: DATABASE_URL })
    let woken = 0
    const unsubscribe = notifier.subscribe(() => {
      woken += 1
    })
    try {
      await notifier.ready()
      const result = await bus.execute({ type: 'CreateEntity', input: memory(undefined, '通知送达') }, meta())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const eventId = result.value.events[0]?.id
      expect(eventId).toBeTruthy()
      await waitFor(() => probe.received().length === 1 && woken > 0)
      // 载荷就是 audit_log.id（DomainEvent.id），relay 不需要猜 outbox 主键。
      expect(probe.received()).toEqual([eventId])
      const outbox = await store.db.query<{ event_id: string; topic: string }>(
        'select event_id::text, topic from omb.outbox',
      )
      expect(outbox.rows).toEqual([{ event_id: eventId, topic: 'EntityCreated' }])
    } finally {
      unsubscribe()
      await notifier.close()
    }
  })

  it('给定重复 commandId 串行重放当再次提交则只通知一次且 outbox 不重复入队', async () => {
    const command = meta()
    const input = memory(undefined, '重复命令只通知一次')
    const first = await bus.execute({ type: 'CreateEntity', input }, command)
    const replay = await bus.execute({ type: 'CreateEntity', input }, command)
    expect(first.ok).toBe(true)
    expect(replay.ok).toBe(true)
    if (!first.ok || !replay.ok) return
    // 正向对照：第二条不同命令的提交必须送达，证明“只有一条”不是监听没连上。
    const second = await bus.execute({ type: 'CreateEntity', input: memory(undefined, '第二条命令') }, meta())
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const firstEventId = first.value.events[0]?.id
    const secondEventId = second.value.events[0]?.id
    await waitFor(() => probe.received().length === 2)
    expect(probe.received()).toEqual([firstEventId, secondEventId])
    expect(await count('omb.audit_log')).toBe(2)
    expect(await count('omb.outbox')).toBe(2)
  })

  it('给定 writer 事务在提交时失败当回滚则不留业务行/审计/outbox 且不发送通知', async () => {
    const marker = 'mem_018f2a00-0000-7000-8000-0000000000c1'
    await installCommitGuard(store.db, marker)
    const failed = await bus.execute({ type: 'CreateEntity', input: memory(marker, '提交失败') }, meta())
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.message).toContain('forced commit failure')
    for (const table of ['omb.entity', 'omb.attribute', 'omb.entity_view', 'omb.audit_log', 'omb.outbox']) {
      expect(await count(table)).toBe(0)
    }

    // 撤掉触发器后做正向对照：唯一到达的通知属于成功事务，失败事务的提示没有泄漏。
    await cleanupCommitGuard(store.db)
    const succeeded = await bus.execute({ type: 'CreateEntity', input: memory(undefined, '回滚后的成功') }, meta())
    expect(succeeded.ok).toBe(true)
    if (!succeeded.ok) return
    const eventId = succeeded.value.events[0]?.id
    await waitFor(() => probe.received().length === 1)
    expect(probe.received()).toEqual([eventId])
    expect(await count('omb.outbox')).toBe(1)
  })

  it('给定 maintenance.renameAttribute 当归并则返回受影响 id 且属性/视图/引用/审计/outbox 同事务一致', async () => {
    const target = await createMemory('引用目标', { 主题: '蓝' })
    const source = await createMemory('引用来源', {
      项目名: '甲',
      peer: { $dynamic: { kind: 'ref', entityId: target, attr: '主题' } },
    })
    const other = await createMemory('别名目标', { 项目名: '乙' })
    const maintenance = new PostgresMaintenance(store.db)

    const affected = await maintenance.renameAttribute('项目名', 'project_name')
    expect(affected).toEqual([source, other].sort())
    for (const id of [source, other]) {
      const entity = await store.db.query<{ revision: string }>('select revision from omb.entity where id = $1', [id])
      expect(Number(entity.rows[0]?.revision)).toBe(2)
      const names = await store.db.query<{ name: string }>(
        'select name from omb.attribute where entity_id = $1 order by name',
        [id],
      )
      expect(names.rows.map(row => row.name)).toContain('project_name')
      expect(names.rows.map(row => row.name)).not.toContain('项目名')
      const view = await store.db.query<{ attrs: Record<string, unknown>; attr_names: string[]; revision: string }>(
        'select attrs, attr_names, revision from omb.entity_view where entity_id = $1',
        [id],
      )
      expect(view.rows[0]?.attrs).toHaveProperty('project_name')
      expect(view.rows[0]?.attr_names).toContain('project_name')
      expect(view.rows[0]?.attr_names).not.toContain('项目名')
      expect(Number(view.rows[0]?.revision)).toBe(2)
    }

    // 引用源属性改名后，同一事务重建 reference 的 source_attr_name（旧直写路径不会更新它）。
    expect(await maintenance.renameAttribute('peer', 'linked')).toEqual([source])
    const references = await store.db.query<{ source_attr_name: string; target_attr_name: string }>(
      'select source_attr_name, target_attr_name from omb.reference where source_entity_id = $1',
      [source],
    )
    expect(references.rows).toEqual([{ source_attr_name: 'linked', target_attr_name: '主题' }])

    // 审计标签沿用 attr-alias，事件/outbox 走 AttributeRenamed，两者同一事务。
    const audit = await store.db.query<{ id: string; action: string; event_type: string; actor: string; command_id: string | null }>(
      "select id::text, action, event_type, actor, command_id from omb.audit_log where action = 'attr-alias'",
    )
    expect(audit.rows).toHaveLength(2)
    expect(audit.rows.every(row => row.event_type === 'AttributeRenamed')).toBe(true)
    expect(audit.rows.every(row => row.actor === 'job:attr-alias')).toBe(true)
    expect(audit.rows.every(row => row.command_id !== null)).toBe(true)
    const outbox = await store.db.query<{ event_id: string; topic: string; payload: Record<string, unknown> }>(
      "select event_id::text, topic, payload from omb.outbox where topic = 'AttributeRenamed' order by id",
    )
    expect(outbox.rows).toHaveLength(2)
    expect(new Set(outbox.rows.map(row => row.event_id))).toEqual(new Set(audit.rows.map(row => row.id)))
    const renamedPayload = outbox.rows[1]?.payload['payload'] as Record<string, unknown>
    expect(renamedPayload).toMatchObject({ from: 'peer', to: 'linked', reason: 'attr-alias' })
  })

  it('给定错误触发键属性当 maintenance 归并则触发键在事务内按属性行重建', async () => {
    const id = await createMemory('触发键重建', { error: 'E42' })
    const before = await store.db.query<{ kind: string; key: string }>(
      'select kind, key from omb.trigger_key where entity_id = $1 order by kind, key',
      [id],
    )
    expect(before.rows).toContainEqual({ kind: 'error', key: 'E42' })

    const maintenance = new PostgresMaintenance(store.db)
    expect(await maintenance.renameAttribute('error', 'failureNote')).toEqual([id])
    const after = await store.db.query<{ kind: string; key: string }>(
      'select kind, key from omb.trigger_key where entity_id = $1 order by kind, key',
      [id],
    )
    expect(after.rows).not.toContainEqual({ kind: 'error', key: 'E42' })
    const view = await store.db.query<{ attr_names: string[] }>(
      'select attr_names from omb.entity_view where entity_id = $1',
      [id],
    )
    expect(view.rows[0]?.attr_names).toContain('failureNote')
    expect(view.rows[0]?.attr_names).not.toContain('error')
  })

  it('给定必填属性名当 maintenance 归并则返回空且不写审计/outbox/版本', async () => {
    const id = await createMemory('必填属性保护', { note: 'keep' })
    const maintenance = new PostgresMaintenance(store.db)
    await expect(maintenance.renameAttribute('title', 'titel')).resolves.toEqual([])
    expect(await count("omb.audit_log", "action = 'attr-alias'")).toBe(0)
    expect(await count("omb.outbox", "topic = 'AttributeRenamed'")).toBe(0)
    const entity = await store.db.query<{ revision: string }>('select revision from omb.entity where id = $1', [id])
    expect(Number(entity.rows[0]?.revision)).toBe(1)
    const names = await store.db.query<{ name: string }>('select name from omb.attribute where entity_id = $1', [id])
    expect(names.rows.map(row => row.name)).toContain('title')
  })

  it('给定维护归并在提交时失败当回滚则属性/视图/审计/outbox 全不变且不发送通知', async () => {
    const first = await createMemory('归并回滚一', { 项目名: '甲' })
    const second = await createMemory('归并回滚二', { 项目名: '乙' })
    const maintenance = new PostgresMaintenance(store.db)
    await installCommitGuard(store.db, 'attr:项目名->project_name')

    await expect(maintenance.renameAttribute('项目名', 'project_name'))
      .rejects.toThrow('forced commit failure')

    for (const id of [first, second]) {
      const entity = await store.db.query<{ revision: string }>('select revision from omb.entity where id = $1', [id])
      expect(Number(entity.rows[0]?.revision)).toBe(1)
      const names = await store.db.query<{ name: string }>('select name from omb.attribute where entity_id = $1', [id])
      expect(names.rows.map(row => row.name)).toContain('项目名')
      expect(names.rows.map(row => row.name)).not.toContain('project_name')
      const view = await store.db.query<{ attrs: Record<string, unknown> }>(
        'select attrs from omb.entity_view where entity_id = $1',
        [id],
      )
      expect(view.rows[0]?.attrs).toHaveProperty('项目名')
    }
    expect(await count('omb.audit_log')).toBe(2)
    expect(await count("omb.audit_log", "action = 'attr-alias'")).toBe(0)
    expect(await count("omb.outbox", "topic = 'EntityCreated'")).toBe(2)
    expect(await count("omb.outbox", "topic = 'AttributeRenamed'")).toBe(0)

    await cleanupCommitGuard(store.db)
    probe.reset()
    const succeeded = await bus.execute({ type: 'CreateEntity', input: memory(undefined, '回滚后的成功') }, meta())
    expect(succeeded.ok).toBe(true)
    if (!succeeded.ok) return
    const eventId = succeeded.value.events[0]?.id
    await waitFor(() => probe.received().length === 1)
    expect(probe.received()).toEqual([eventId])
  })
})
