import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { PatchEntityInput, Scope, StateStatus, WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import {
  DefaultCommandBus,
  type CommandExecution,
  type CommandMeta,
} from '../../../packages/v7/src/app/commands/index.js'
import {
  ProjectionWorker,
  type ProjectionEnqueueInput,
  type ProjectionEnqueueResult,
  type ProjectionName,
  type ProjectionTransaction,
} from '../../../packages/v7/src/app/projections/index.js'
import { AttributeWriter } from '../../../packages/v7/src/adapters/postgres/writer.js'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import {
  createBoardProjectors,
  createBoardReader,
  PostgresProjectionTaskStore,
} from '../../../packages/v7/src/adapters/postgres/projection.js'

/**
 * writer 同事务入队 + plugin 之外的最小 worker 接线证据（PLAN Task 10 剩余步骤、ARCHITECTURE-PLAN §4.4）。
 *
 * 覆盖：真实 PG 下写事务内 `projection_task` upsert（revision 正确、与 entity/audit/outbox 同事务）、
 * enqueue 之后/本身失败都回滚、重复 commandId 不重复入队、只对 preference/state 需要的实体入队、
 * patch 进入/离开看板、归档/取消归档、RenameAttribute 重新判定、worker 投影与幂等。
 *
 * 使用独立库 `omb_v7_test_wiring`（env 可覆盖），不碰 omb_v7_test / 生产库。
 */
const DATABASE_URL = process.env.OMB_WIRING_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_wiring'

const clock: Clock = { now: () => new Date(), iso: () => new Date().toISOString() }
const GLOBAL: Scope = { kind: 'global' }

let store: PostgresStore
let db: PostgresDb
let writer: AttributeWriter
let bus: DefaultCommandBus
let tasks: PostgresProjectionTaskStore
let boards: ReturnType<typeof createBoardReader>

interface TaskRow {
  projection: string
  revision: string
  status: string
  attempts: number
}

interface Snapshot {
  entity: number
  attributes: number
  views: number
  audit: number
  outbox: number
  tasks: number
}

function meta(): CommandMeta {
  return {
    commandId: randomUUID(),
    actor: { id: 'test', kind: 'system' },
    origin: 'test',
    correlationId: randomUUID(),
  }
}

function memory(title: string, attrs: Record<string, unknown> = {}): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title, body: `正文-${title}`, ...attrs },
  }
}

function preferenceMemory(title: string, body = '先写会红的断言'): WriteEntityInput {
  return memory(title, { body, tags: ['偏好'] })
}

function stateInput(title: string, status: StateStatus, projectKey = 'D:/proj/a'): WriteEntityInput {
  return { kind: 'state', scope: { kind: 'project', projectKey }, title, status, time: '2026-01-02T03:04:05.000Z' }
}

async function create(input: WriteEntityInput): Promise<{ id: string; result: CommandExecution }> {
  const result = await bus.execute({ type: 'CreateEntity', input }, meta())
  if (!result.ok) throw new Error(`创建失败：${result.error.message}`)
  const id = result.value.events[0]?.streamId
  if (id === undefined) throw new Error('创建没有返回事件')
  return { id, result }
}

async function createPreference(title = '偏好：提交前先写测试', body = '先写会红的断言'): Promise<{ id: string; revision: number }> {
  const created = await create(preferenceMemory(title, body))
  if (!created.result.ok) throw new Error('不可达：创建已成功')
  return { id: created.id, revision: created.result.value.projectionToken.revision }
}

async function patchEntity(input: PatchEntityInput): Promise<number> {
  const result = await bus.execute({ type: 'PatchEntity', input }, meta())
  if (!result.ok) throw new Error(`patch 失败：${result.error.message}`)
  return result.value.projectionToken.revision
}

async function archiveEntity(id: string): Promise<number> {
  const result = await bus.execute({ type: 'ArchiveEntity', id, reason: '测试归档' }, meta())
  if (!result.ok) throw new Error(`归档失败：${result.error.message}`)
  return result.value.projectionToken.revision
}

async function unarchiveEntity(id: string): Promise<number> {
  const result = await bus.execute({ type: 'UnarchiveEntity', id, reason: '测试恢复' }, meta())
  if (!result.ok) throw new Error(`取消归档失败：${result.error.message}`)
  return result.value.projectionToken.revision
}

function workerOf(): ProjectionWorker {
  return new ProjectionWorker(
    { store: tasks, projectors: createBoardProjectors(db), clock },
    { batchSize: 25, leaseMs: 5_000 },
  )
}

async function taskOf(entityId: string, projection: ProjectionName): Promise<TaskRow | undefined> {
  const result = await db.query<TaskRow>(
    `select projection, revision::text as revision, status, attempts
       from omb.projection_task where entity_id = $1 and projection = $2`,
    [entityId, projection],
  )
  return result.rows[0]
}

async function countRows(table: 'projection_task' | 'preference_board' | 'state_board'): Promise<number> {
  const result = await db.query<{ count: number }>(`select count(*)::int as count from omb.${table}`)
  return result.rows[0]?.count ?? 0
}

async function snapshot(): Promise<Snapshot> {
  const result = await db.query<Record<keyof Snapshot, number>>(
    `select
       (select count(*) from omb.entity)::int as entity,
       (select count(*) from omb.attribute)::int as attributes,
       (select count(*) from omb.entity_view)::int as views,
       (select count(*) from omb.audit_log)::int as audit,
       (select count(*) from omb.outbox)::int as outbox,
       (select count(*) from omb.projection_task)::int as tasks`,
  )
  const row = result.rows[0]
  return {
    entity: Number(row?.entity ?? 0),
    attributes: Number(row?.attributes ?? 0),
    views: Number(row?.views ?? 0),
    audit: Number(row?.audit ?? 0),
    outbox: Number(row?.outbox ?? 0),
    tasks: Number(row?.tasks ?? 0),
  }
}

/** 注入失败：真实写入 task 行后抛错，用来证明 enqueue 与业务写在同一事务、失败一起回滚。 */
class FailingEnqueueStore extends PostgresProjectionTaskStore {
  override async enqueue(
    input: ProjectionEnqueueInput,
    tx?: ProjectionTransaction,
  ): Promise<ProjectionEnqueueResult> {
    await super.enqueue(input, tx)
    throw new Error('注入的 projection enqueue 失败')
  }
}

describe('投影接线：writer 同事务入队（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    store = new PostgresStore(DATABASE_URL)
    db = store.db
    writer = new AttributeWriter(db)
    bus = new DefaultCommandBus({ store, writer })
    tasks = new PostgresProjectionTaskStore(db)
    boards = createBoardReader(db)
  })

  beforeEach(async () => {
    await truncateAll(DATABASE_URL)
    // projection_watermark 没有 FK，truncateAll 不会带到；其余投影表随 entity 级联清空。
    await db.query(
      `truncate table omb.projection_watermark, omb.projection_task, omb.preference_board,
                      omb.state_board, omb.adoption_stat, omb.co_recall_pair, omb.similar_cache
         restart identity cascade`,
    )
  })

  afterAll(async () => {
    await truncateAll(DATABASE_URL)
    await store.close()
  })

  it('给定全局偏好记忆当创建则在写事务内入队 preference_board，revision 与提交后实体一致', async () => {
    const { id, revision } = await createPreference()
    expect(revision).toBe(1)
    expect(await taskOf(id, 'preference_board')).toEqual({
      projection: 'preference_board',
      revision: '1',
      status: 'pending',
      attempts: 0,
    })
    // 同一次提交里 entity/audit/outbox 都存在：入队不是提交后的旁路写。
    const committed = await db.query<{ entity: number; audit: number; outbox: number }>(
      `select
         (select count(*) from omb.entity where id = $1)::int as entity,
         (select count(*) from omb.audit_log where stream_id = $1)::int as audit,
         (select count(*) from omb.outbox o join omb.audit_log a on a.id = o.event_id where a.stream_id = $1)::int as outbox`,
      [id],
    )
    expect(committed.rows[0]).toEqual({ entity: 1, audit: 1, outbox: 1 })
  })

  it('给定非偏好/项目内偏好记忆当创建则不产生投影任务（避免无意义任务）', async () => {
    const plain = await create(memory('普通全局记忆', { body: '没有偏好标签' }))
    const projectPreference = await create({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: 'D:/proj/x' },
      attrs: { title: '项目偏好', body: '项目内偏好不进全局看板', tags: ['偏好'] },
    })
    expect(await taskOf(plain.id, 'preference_board')).toBeUndefined()
    expect(await taskOf(projectPreference.id, 'preference_board')).toBeUndefined()
    expect(await countRows('projection_task')).toBe(0)
  })

  it('给定状态机当创建则只对看板三类状态入队，completed 自动归档不入队', async () => {
    const active = await create(stateInput('进行中状态', 'in_progress'))
    expect(await taskOf(active.id, 'state_board')).toMatchObject({ revision: '1', status: 'pending', attempts: 0 })
    for (const status of ['completed', 'not_started'] as const) {
      const inactive = await create(stateInput(`状态-${status}`, status))
      expect(await taskOf(inactive.id, 'state_board')).toBeUndefined()
    }
  })

  it('给定入队后的偏好记忆当 worker drain 则读模型/水位/任务一起前进且重复 tick 不重复投影', async () => {
    const { id, revision } = await createPreference()
    const worker = workerOf()
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 1, projected: 1, dead: 0 })

    const row = await db.query<{ entity_id: string; title: string; revision: string; updated_at: Date | string }>(
      'select entity_id, title, revision::text as revision, updated_at from omb.preference_board where entity_id = $1',
      [id],
    )
    expect(row.rows[0]).toMatchObject({ entity_id: id, title: '偏好：提交前先写测试', revision: '1' })
    const watermark = await tasks.watermark('preference_board')
    expect(watermark?.watermark).toBe(new Date(row.rows[0]!.updated_at).toISOString())
    expect(await taskOf(id, 'preference_board')).toMatchObject({ status: 'done', revision: String(revision) })

    await expect(worker.tick()).resolves.toMatchObject({ claimed: 0 })
    expect(await countRows('preference_board')).toBe(1)
  })

  it('给定普通全局记忆当补丁加偏好标签则按提交后 revision 入队并被投影', async () => {
    const plain = await create(memory('后来变成偏好', { body: '初始没有标签' }))
    expect(await tasks.taskState(plain.id, 'preference_board')).toBeUndefined()

    const revision = await patchEntity({ id: plain.id, expectedRevision: 1, attrs: { tags: ['偏好'] } })
    expect(revision).toBe(2)
    expect(await taskOf(plain.id, 'preference_board')).toMatchObject({ revision: '2', status: 'pending' })

    await expect(workerOf().drain()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    const items = await boards.readBoard({ kind: 'preference', scope: GLOBAL, limit: 20 })
    expect(items.map(item => item.entityId)).toContain(plain.id)
  })

  it('给定偏好记忆当补丁去掉偏好标签则入队新 revision，worker 据此删除已有看板行', async () => {
    const { id } = await createPreference()
    const worker = workerOf()
    await worker.drain()
    expect(await countRows('preference_board')).toBe(1)

    const revision = await patchEntity({ id, expectedRevision: 1, attrs: { tags: null } })
    expect(revision).toBe(2)
    expect(await taskOf(id, 'preference_board')).toMatchObject({ revision: '2', status: 'pending' })
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    expect(await countRows('preference_board')).toBe(0)
  })

  it('给定已投影的偏好记忆当归档/取消归档则各自入队，worker 删除与恢复读模型行', async () => {
    const { id } = await createPreference()
    const worker = workerOf()
    await worker.drain()
    expect(await countRows('preference_board')).toBe(1)

    const archivedRevision = await archiveEntity(id)
    expect(archivedRevision).toBe(2)
    expect(await taskOf(id, 'preference_board')).toMatchObject({ revision: '2', status: 'pending' })
    await worker.drain()
    expect(await countRows('preference_board')).toBe(0)

    const restoredRevision = await unarchiveEntity(id)
    expect(restoredRevision).toBe(3)
    expect(await taskOf(id, 'preference_board')).toMatchObject({ revision: '3', status: 'pending' })
    await worker.drain()
    expect(await countRows('preference_board')).toBe(1)
  })

  it('给定同一 commandId 重放当创建与补丁则只产生一条任务且 revision 不前进', async () => {
    const command = meta()
    const input = preferenceMemory('幂等投影偏好')
    const first = await bus.execute({ type: 'CreateEntity', input }, command)
    const second = await bus.execute({ type: 'CreateEntity', input }, command)
    expect(first.ok && second.ok).toBe(true)
    const id = first.ok ? first.value.events[0]?.streamId : undefined
    expect(id).toBeDefined()
    expect(await countRows('projection_task')).toBe(1)
    expect(await taskOf(id as string, 'preference_board')).toMatchObject({ revision: '1', status: 'pending' })

    const patchCommand = meta()
    const patch = { id: id as string, expectedRevision: 1, attrs: { body: '改过的正文' } }
    const firstPatch = await bus.execute({ type: 'PatchEntity', input: patch }, patchCommand)
    const replayPatch = await bus.execute({ type: 'PatchEntity', input: patch }, patchCommand)
    expect(firstPatch.ok && replayPatch.ok).toBe(true)
    expect(await countRows('projection_task')).toBe(1)
    expect(await taskOf(id as string, 'preference_board')).toMatchObject({ revision: '2' })
    const entity = await db.query<{ revision: string }>('select revision from omb.entity where id = $1', [id])
    expect(Number(entity.rows[0]?.revision)).toBe(2)
  })

  it('给定 enqueue 之后的事件写入撞 stream 版本唯一索引当事务失败则投影任务与业务写一起回滚', async () => {
    const { id } = await createPreference()
    const worker = workerOf()
    await worker.drain()
    // 预置同 stream 版本 2 的审计行：patch 事务先入队 rev2、再写 rev2 事件时撞唯一索引失败。
    await db.query(
      `insert into omb.audit_log (actor, action, target_ids, stream_id, stream_version)
       values ('test', 'seed', array[$1]::text[], $1, 2)`,
      [id],
    )
    const before = await snapshot()

    const result = await bus.execute(
      { type: 'PatchEntity', input: { id, expectedRevision: 1, attrs: { body: '不该落库的正文' } } },
      meta(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('conflict')
    expect(await snapshot()).toEqual(before)
    expect(await taskOf(id, 'preference_board')).toMatchObject({ status: 'done', revision: '1' })
    const body = await db.query<{ value: string }>(
      "select value from omb.attribute where entity_id = $1 and name = 'body'",
      [id],
    )
    expect(body.rows[0]?.value).not.toBe('不该落库的正文')
  })

  it('给定投影入队本身抛错当创建失败则实体/审计/outbox/投影任务全部回滚', async () => {
    const failingWriter = new AttributeWriter(db, { projectionTasks: new FailingEnqueueStore(db) })
    const failingBus = new DefaultCommandBus({ store, writer: failingWriter })
    const result = await failingBus.execute({ type: 'CreateEntity', input: preferenceMemory('入队失败的偏好') }, meta())
    expect(result.ok).toBe(false)
    expect(await snapshot()).toEqual({ entity: 0, attributes: 0, views: 0, audit: 0, outbox: 0, tasks: 0 })
  })

  it('给定改名涉及看板属性当 RenameAttribute 则受影响实体重新入队，不相关改名不入队', async () => {
    const { id } = await createPreference()
    const unrelated = await create(memory('不相关改名目标', { 项目名: '甲' }))
    const worker = workerOf()
    await worker.drain()

    const unrelatedRename = await bus.execute(
      { type: 'RenameAttribute', from: '项目名', to: 'project_name', reason: '规范化' },
      meta(),
    )
    expect(unrelatedRename.ok).toBe(true)
    expect(await tasks.taskState(unrelated.id, 'preference_board')).toBeUndefined()

    // `tags` 参与偏好谓词：改名后必须重新判定（普通实体也要入队，因为可能离开/进入看板）。
    const relevantRename = await bus.execute({ type: 'RenameAttribute', from: 'tags', to: '标签', reason: '本地化' }, meta())
    expect(relevantRename.ok).toBe(true)
    expect(await taskOf(id, 'preference_board')).toMatchObject({ revision: '2', status: 'pending' })
  })
})
