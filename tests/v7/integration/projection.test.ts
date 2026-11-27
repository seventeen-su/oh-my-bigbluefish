import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { PatchEntityInput, Scope, StateStatus, WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { AttributeWriter } from '../../../packages/v7/src/adapters/postgres/writer.js'
import {
  DefaultCommandBus,
  type CommandExecution,
  type CommandMeta,
} from '../../../packages/v7/src/app/commands/index.js'
import {
  ProjectionReadApi,
  ProjectionWorker,
  type BoardItem,
  type ProjectionProjector,
  type ProjectionTask,
  type ProjectionTickSummary,
} from '../../../packages/v7/src/app/projections/index.js'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import {
  createBoardProjectors,
  createBoardReader,
  PostgresProjectionNotifier,
  PostgresProjectionTaskStore,
  PREFERENCE_BOARD_READ_SQL,
  PROJECTION_CLAIM_SQL,
} from '../../../packages/v7/src/adapters/postgres/projection.js'

/**
 * 投影 worker / 看板读模型 / read-your-writes 的真实 PostgreSQL 证据
 * （PLAN Task 10、ARCHITECTURE-PLAN §4.4/§5.2/§5.3、ADR-0008）。
 *
 * 覆盖：preference/state 从属性行派生、幂等 upsert、归档/状态离开后清理、按 projection 批量
 * claim（`SKIP LOCKED` 并发不重复）、失败退避/死信、启动恢复重领、水位只在成功后推进且单调、
 * lag、NOTIFY 驱动、token 等待/回退写模型/stale、事务内 enqueue 回滚、EXPLAIN 走 due/scope 索引。
 *
 * 使用独立库 `omb_v7_test_projection`（env 可覆盖），不碰 omb_v7_test / 生产库。
 */
const DATABASE_URL = process.env.OMB_PROJECTION_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_projection'

const clock: Clock = { now: () => new Date(), iso: () => new Date().toISOString() }
const GLOBAL: Scope = { kind: 'global' }

let db: PostgresDb
let store: PostgresStore
let bus: DefaultCommandBus
let tasks: PostgresProjectionTaskStore
let boards: ReturnType<typeof createBoardReader>

interface TaskDbRow extends Record<string, unknown> {
  status: string
  attempts: number
  revision: string
  available_at: Date
}

interface ExplainRow {
  'QUERY PLAN': unknown
}

interface PlanNode {
  node: string
  relation?: string
  index?: string
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

function preferenceMemory(title: string, body: string): WriteEntityInput {
  return memory(title, { body, tags: ['偏好'] })
}

function stateInput(
  title: string,
  status: StateStatus,
  projectKey: string,
  time = '2026-01-02T03:04:05.000Z',
): WriteEntityInput {
  return { kind: 'state', scope: { kind: 'project', projectKey }, title, status, time }
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

function workerOf(
  projectors: readonly ProjectionProjector[] = createBoardProjectors(db),
  options: { batchSize?: number; leaseMs?: number; retry?: { maxAttempts: number; baseDelayMs: number; factor: number; maxDelayMs: number } } = {},
): ProjectionWorker {
  return new ProjectionWorker(
    { store: tasks, projectors, clock },
    { batchSize: 25, leaseMs: 5_000, ...options },
  )
}

function readApiOf(wake?: { subscribe(listener: () => void): () => void }): ProjectionReadApi {
  return new ProjectionReadApi({ store: tasks, boards, clock, ...(wake === undefined ? {} : { wake }) })
}

async function dbTask(entityId: string, projection = 'preference_board'): Promise<TaskDbRow | undefined> {
  const result = await db.query<TaskDbRow>(
    `select status, attempts, revision::text, available_at
       from omb.projection_task where entity_id = $1 and projection = $2`,
    [entityId, projection],
  )
  return result.rows[0]
}

async function countRows(table: 'projection_task' | 'preference_board' | 'state_board' | 'projection_watermark'): Promise<number> {
  const result = await db.query<{ count: number }>(`select count(*)::int as count from omb.${table}`)
  return result.rows[0]?.count ?? 0
}

async function boardRows(kind: 'preference' | 'state', scope: Scope, limit = 20): Promise<readonly BoardItem[]> {
  return boards.readBoard({
    kind,
    scope,
    limit,
    ...(scope.kind === 'project' ? { projectKey: scope.projectKey } : {}),
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待条件超时')
    await new Promise<void>(resolve => {
      // 有上界的条件轮询：25ms 只是重试间隔，不是用睡眠当同步/断言（test-sleep 已显式豁免）。
      // check:ignore-next-line test-sleep
      setTimeout(resolve, 25)
    })
  }
}

function collectPlanNodes(plan: unknown, nodes: PlanNode[] = []): PlanNode[] {
  if (Array.isArray(plan)) {
    for (const item of plan) collectPlanNodes(item, nodes)
    return nodes
  }
  if (typeof plan !== 'object' || plan === null) return nodes
  const record = plan as Record<string, unknown>
  if (typeof record['Node Type'] === 'string') {
    nodes.push({
      node: record['Node Type'],
      ...(typeof record['Relation Name'] === 'string' ? { relation: record['Relation Name'] } : {}),
      ...(typeof record['Index Name'] === 'string' ? { index: record['Index Name'] } : {}),
    })
  }
  if (Array.isArray(record['Plans'])) collectPlanNodes(record['Plans'], nodes)
  if (record['Plan'] !== undefined) collectPlanNodes(record['Plan'], nodes)
  return nodes
}

/** 记录每条被真正投影的任务名，用于证明并发 worker 不重复。 */
function countingProjectors(seen: string[]): readonly ProjectionProjector[] {
  return createBoardProjectors(db).map(projector => ({
    projection: projector.projection,
    project: async (task: ProjectionTask) => {
      seen.push(`${task.projection}:${task.entityId}`)
      return projector.project(task)
    },
  }))
}

describe('投影 worker / boards（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    db = new PostgresDb({ connectionString: DATABASE_URL })
    store = new PostgresStore(DATABASE_URL)
    bus = new DefaultCommandBus({ store, writer: new AttributeWriter(store.db) })
    tasks = new PostgresProjectionTaskStore(db)
    boards = createBoardReader(db)
  })

  beforeEach(async () => {
    await truncateAll(DATABASE_URL)
    // projection_watermark 没有 FK，truncateAll 不会带到；其余表由 entity 级联清空。
    await db.query(
      `truncate table omb.projection_watermark, omb.projection_task, omb.preference_board,
                      omb.state_board, omb.adoption_stat, omb.co_recall_pair, omb.similar_cache
         restart identity cascade`,
    )
  })

  afterAll(async () => {
    await db.close()
    await store.close()
  })

  it('给定偏好记忆当创建并入队则看板按属性派生、重复投影不产生第二行、patch 后 revision 前进', async () => {
    expect(await tasks.watermark('preference_board')).toBeUndefined()
    const { id, revision } = await createPreference()
    expect(revision).toBe(1)

    const enqueued = await tasks.enqueue({ entityId: id, projection: 'preference_board', revision })
    // writer 已在同一写事务里入队这一版：显式重复入队不产生新工作（幂等命令重放走这条路）。
    expect(enqueued).toMatchObject({ revision: 1, status: 'pending', changed: false })
    expect(await tasks.watermark('preference_board')).toBeUndefined()

    const worker = workerOf()
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 1, dead: 0 })
    const [item] = await boardRows('preference', GLOBAL)
    expect(item).toMatchObject({
      entityId: id,
      title: '偏好：提交前先写测试',
      revision: 1,
      salience: 0.5,
    })
    expect(item?.summary).toContain('先写会红的断言')
    // 水位 = 最近成功投影的源行 updated_at；board 行原样保存它。
    expect((await tasks.watermark('preference_board'))?.watermark).toBe(item?.updatedAt)
    expect(await dbTask(id)).toMatchObject({ status: 'done', attempts: 0, revision: '1' })

    // 幂等：同 revision 重复入队不产生新工作，重复投影不新增行。
    await expect(tasks.enqueue({ entityId: id, projection: 'preference_board', revision })).resolves.toMatchObject({
      changed: false,
      revision: 1,
    })
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 0 })
    expect(await countRows('preference_board')).toBe(1)

    // 强制同一 revision 再投影一次：内容不变时 upsert 不重写行（xmin 不变）。
    const xminBefore = (await db.query<{ xmin: string }>(
      'select xmin::text as xmin from omb.preference_board where entity_id = $1',
      [id],
    )).rows[0]?.xmin
    await db.query(
      "update omb.projection_task set status = 'pending', available_at = now() where entity_id = $1 and projection = 'preference_board'",
      [id],
    )
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    const xminAfter = (await db.query<{ xmin: string }>(
      'select xmin::text as xmin from omb.preference_board where entity_id = $1',
      [id],
    )).rows[0]?.xmin
    expect(xminAfter).toBe(xminBefore)

    // patch 产生 revision 2：入队 → 投影后看板行 revision/摘要一起前进。
    const revision2 = await patchEntity({ id, expectedRevision: 1, attrs: { body: '更新后的正文' } })
    expect(revision2).toBe(2)
    await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: revision2 })
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    const [updated] = await boardRows('preference', GLOBAL)
    expect(updated).toMatchObject({ entityId: id, revision: 2 })
    expect(updated?.summary).toContain('更新后的正文')
    expect(await countRows('preference_board')).toBe(1)
  })

  it('给定非偏好/项目偏好记忆当投影则看板为空，归档后已有行被清理', async () => {
    const plain = await create(memory('普通记忆', { body: '没有偏好标签' }))
    const projectPreference = await create({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: 'D:/proj/x' },
      attrs: { title: '项目偏好', body: '项目内偏好不是 T0 全局偏好', tags: ['偏好'] },
    })
    const worker = workerOf()
    for (const created of [plain, projectPreference]) {
      if (!created.result.ok) throw new Error('不可达')
      const token = created.result.value.projectionToken
      await tasks.enqueue({ entityId: created.id, projection: 'preference_board', revision: token.revision })
    }
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 2, projected: 2 })
    expect(await boardRows('preference', GLOBAL)).toEqual([])
    expect(await countRows('preference_board')).toBe(0)
    expect((await tasks.watermark('preference_board'))?.watermark).toBeDefined()

    const archived = await createPreference('偏好：会被归档', '归档后不留残行')
    await tasks.enqueue({ entityId: archived.id, projection: 'preference_board', revision: archived.revision })
    await worker.tick()
    expect((await boardRows('preference', GLOBAL)).map(item => item.entityId)).toEqual([archived.id])

    const archiveRevision = await archiveEntity(archived.id)
    await tasks.enqueue({ entityId: archived.id, projection: 'preference_board', revision: archiveRevision })
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    // 归档后读模型不残留；任务仍标记 done（read-your-writes 判定用 done+revision）。
    expect(await boardRows('preference', GLOBAL)).toEqual([])
    expect(await countRows('preference_board')).toBe(0)
    expect(await dbTask(archived.id)).toMatchObject({ status: 'done', revision: String(archiveRevision) })
  })

  it('给定状态记忆当投影则状态看板带项目/状态/时间，patch 与离开三类状态后同步/清理', async () => {
    const projectA: Scope = { kind: 'project', projectKey: 'D:/proj/a' }
    const projectB: Scope = { kind: 'project', projectKey: 'D:/proj/b' }
    const a = await create(stateInput('实现投影 worker', 'in_progress', 'D:/proj/a'))
    const worker = workerOf()
    if (!a.result.ok) throw new Error('不可达')
    const tokenA = a.result.value.projectionToken
    await tasks.enqueue({ entityId: a.id, projection: 'state_board', revision: tokenA.revision })
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 1 })

    const [rowA] = await boardRows('state', projectA)
    expect(rowA).toMatchObject({
      entityId: a.id,
      title: '实现投影 worker',
      status: 'in_progress',
      projectKey: 'D:/proj/a',
      eventTime: '2026-01-02T03:04:05.000Z',
      revision: 1,
    })
    expect(await boardRows('state', projectB)).toEqual([])
    expect((await tasks.watermark('state_board'))?.watermark).toBe(rowA?.updatedAt)

    const b = await create(stateInput('另一个项目的状态', 'waiting', 'D:/proj/b'))
    if (!b.result.ok) throw new Error('不可达')
    await tasks.enqueue({ entityId: b.id, projection: 'state_board', revision: b.result.value.projectionToken.revision })
    await worker.tick()
    expect((await boardRows('state', projectA)).map(item => item.entityId)).toEqual([a.id])
    expect((await boardRows('state', projectB)).map(item => item.entityId)).toEqual([b.id])

    // read-your-writes：token 已被投影覆盖，读状态看板直接走读模型。
    const api = readApiOf()
    const snapshot = await api.boards('state', projectA, {
      token: { entityId: a.id, revision: 1, watermark: '1' },
      timeoutMs: 2_000,
    })
    expect(snapshot).toMatchObject({ source: 'read-model', stale: false })
    expect(snapshot.items.map(item => item.entityId)).toEqual([a.id])
    await api.close()

    const revision2 = await patchEntity({ id: a.id, expectedRevision: 1, status: 'blocked' })
    await tasks.enqueue({ entityId: a.id, projection: 'state_board', revision: revision2 })
    await worker.tick()
    expect(await boardRows('state', projectA)).toMatchObject([{ entityId: a.id, status: 'blocked', revision: 2 }])

    // 离开 in_progress/blocked/waiting（改为 completed）后看板行必须删除。
    const revision3 = await patchEntity({ id: a.id, expectedRevision: 2, status: 'completed' })
    await tasks.enqueue({ entityId: a.id, projection: 'state_board', revision: revision3 })
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    expect(await boardRows('state', projectA)).toEqual([])
    expect(await dbTask(a.id, 'state_board')).toMatchObject({ status: 'done', revision: '3' })
  })

  it('给定崩溃遗留的 claimed 任务当租约到期则新 worker 重领并完成（启动恢复）', async () => {
    const { id } = await createPreference()
    await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 })
    const claimed = await tasks.claim({ projection: 'preference_board', limit: 10, leaseMs: 60_000 })
    expect(claimed.map(task => task.entityId)).toEqual([id])
    // 租约内不可重领。
    expect(await tasks.claim({ projection: 'preference_board', limit: 10, leaseMs: 60_000 })).toEqual([])
    const worker = workerOf()
    await expect(worker.recover()).resolves.toBe(0)

    // 模拟崩溃后租约到期（不改租约实现，直接推进可领时间）。
    await db.query("update omb.projection_task set available_at = now() - interval '1 second' where entity_id = $1", [id])
    await expect(worker.recover()).resolves.toBe(1)
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    expect(await dbTask(id)).toMatchObject({ status: 'done' })
    expect((await boardRows('preference', GLOBAL)).map(item => item.entityId)).toEqual([id])
  })

  it('给定到期任务被其它事务锁住当 claim 则立即跳过而不是阻塞等待（SKIP LOCKED）', async () => {
    const { id } = await createPreference('偏好：被锁住的任务', '另一个 worker 正在处理')
    await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 })
    const client = await db.pool.connect()
    try {
      await client.query('begin')
      // 模拟另一个 worker 的事务已经锁住这条到期行但尚未提交。
      await client.query('select entity_id from omb.projection_task where entity_id = $1 for update', [id])
      const startedAt = Date.now()
      const claimed = await tasks.claim({ projection: 'preference_board', limit: 10, leaseMs: 5_000 })
      const elapsed = Date.now() - startedAt
      expect(claimed).toEqual([])
      expect(elapsed).toBeLessThan(2_000)
      await client.query('commit')
    } finally {
      await client.query('rollback').catch(() => {})
      client.release()
    }
    expect(await tasks.claim({ projection: 'preference_board', limit: 10, leaseMs: 5_000 })).toHaveLength(1)
  })

  it('给定 6 条投影任务当 8 次 claim 与 2 个 worker 并发则每条只被领取/投影一次', async () => {
    const ids: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const { id } = await createPreference(`偏好：并发 ${index}`, `正文 ${index}`)
      ids.push(id)
      await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 })
    }

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => tasks.claim({ projection: 'preference_board', limit: 2, leaseMs: 5_000 })),
    )
    const claimedIds = claims.flat().map(task => task.entityId)
    expect(claimedIds).toHaveLength(6)
    expect(new Set(claimedIds).size).toBe(6)

    // 归还后再用两个 worker 并发投影：每个实体只被投影一次。
    await db.query("update omb.projection_task set status = 'pending', claimed_at = null, available_at = now()")
    const seen: string[] = []
    const left = workerOf(countingProjectors(seen))
    const right = workerOf(countingProjectors(seen))
    const summaries: ProjectionTickSummary[] = await Promise.all([left.tick(), right.tick()])
    const summary = summaries.reduce(
      (sum, item) => ({
        claimed: sum.claimed + item.claimed,
        projected: sum.projected + item.projected,
        lost: sum.lost + item.lost,
      }),
      { claimed: 0, projected: 0, lost: 0 },
    )
    expect(summary).toEqual({ claimed: 6, projected: 6, lost: 0 })
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
    expect((await db.query<{ count: number }>("select count(*)::int as count from omb.projection_task where status = 'done'")).rows[0]?.count).toBe(6)
    expect(await countRows('preference_board')).toBe(6)
  })

  it('给定投影器持续抛错当多次 tick 则退避、死信、水位不推进，且不影响其它任务', async () => {
    const { id: badId } = await createPreference('偏好：失败任务', '投影会抛错')
    await tasks.enqueue({ entityId: badId, projection: 'preference_board', revision: 1 })
    const failing: readonly ProjectionProjector[] = [
      {
        projection: 'preference_board',
        project: async () => {
          throw new Error('源行暂时不可读：模拟投影失败')
        },
      },
      ...createBoardProjectors(db).filter(projector => projector.projection === 'state_board'),
    ]
    const worker = workerOf(failing, {
      retry: { maxAttempts: 2, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 },
    })

    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 0, retried: 1, dead: 0 })
    const retried = await dbTask(badId)
    expect(retried).toMatchObject({ status: 'pending', attempts: 1 })
    expect((retried?.available_at.getTime() ?? 0) - Date.now()).toBeGreaterThan(50)
    expect(await tasks.watermark('preference_board')).toBeUndefined()

    await db.query("update omb.projection_task set available_at = now() - interval '1 second' where entity_id = $1", [badId])
    await expect(worker.tick()).resolves.toMatchObject({ claimed: 1, projected: 0, dead: 1, retried: 0 })
    expect(await dbTask(badId)).toMatchObject({ status: 'dead', attempts: 2 })
    expect(await tasks.watermark('preference_board')).toBeUndefined()
    expect(await tasks.claim({ projection: 'preference_board', limit: 10, leaseMs: 5_000 })).toEqual([])

    // 死信不影响新任务；死信本身不会被再次领取。
    const { id: goodId } = await createPreference('偏好：正常任务', '正常投影')
    await tasks.enqueue({ entityId: goodId, projection: 'preference_board', revision: 1 })
    const healthy = workerOf()
    await expect(healthy.tick()).resolves.toMatchObject({ claimed: 1, projected: 1 })
    expect((await boardRows('preference', GLOBAL)).map(item => item.entityId)).toEqual([goodId])
    expect(await dbTask(badId)).toMatchObject({ status: 'dead' })
    const lag = (await tasks.lag()).find(item => item.projection === 'preference_board')
    expect(lag).toMatchObject({ dead: 1, pending: 0, due: 0 })
    // 失败原因留在 worker 指标里，omb_status 能看见，而不是只写进任务行。
    expect((await worker.stats()).lastError).toContain('模拟投影失败')
  })

  it('给定 NOTIFY 驱动当读 token 等待且 worker 完成投影则立即返回读模型', async () => {
    const notifier = new PostgresProjectionNotifier({ connectionString: DATABASE_URL })
    const worker = new ProjectionWorker(
      { store: tasks, projectors: createBoardProjectors(db), clock, wake: notifier },
      { batchSize: 10, leaseMs: 5_000 },
    )
    const api = readApiOf(notifier)
    try {
      await notifier.ready()
      const { id } = await createPreference('偏好：NOTIFY 唤醒', '等待者靠 NOTIFY 恢复')
      await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 })

      // 先起读（同步注册等待），再启动 worker：完成投影 → NOTIFY → 读立即成功。
      const pendingRead = api.boards('preference', GLOBAL, {
        token: { entityId: id, revision: 1, watermark: '1' },
        timeoutMs: 10_000,
      })
      worker.start()
      const snapshot = await pendingRead
      expect(snapshot).toMatchObject({ source: 'read-model', stale: false, revision: 1 })
      expect(snapshot.items.map(item => item.entityId)).toEqual([id])
      expect(await dbTask(id)).toMatchObject({ status: 'done' })
      await waitFor(async () => (await countRows('projection_task')) === 1)
    } finally {
      await worker.stop()
      await api.close()
      await notifier.close()
    }
  })

  it('给定 token 尚未被投影当读看板超时则回退写模型或显式 stale，投影完成后转读模型', async () => {
    const { id } = await createPreference('偏好：回退写模型', '旧正文')
    const worker = workerOf()
    await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 })
    await worker.tick()
    const revision2 = await patchEntity({ id, expectedRevision: 1, attrs: { body: '新正文' } })
    await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: revision2 })
    const api = readApiOf()
    try {
      const token = { entityId: id, revision: revision2, watermark: '2' }
      const fallback = await api.boards('preference', GLOBAL, { token, timeoutMs: 50 })
      expect(fallback).toMatchObject({ source: 'write-model', stale: false, revision: 2 })
      expect(fallback.items[0]?.summary).toContain('新正文')
      expect(fallback.lag.pending).toBe(1)
      expect(fallback.waitedMs).toBeGreaterThanOrEqual(40)

      const stale = await api.boards('preference', GLOBAL, { token, timeoutMs: 50, onTimeout: 'stale' })
      expect(stale).toMatchObject({ source: 'read-model', stale: true, revision: 1 })
      expect(stale.token?.revision).toBe(2)
      expect(stale.revision).toBeLessThan(stale.token?.revision ?? 0)
      expect(stale.items[0]?.summary).toContain('旧正文')

      await worker.tick()
      const fresh = await api.boards('preference', GLOBAL, { token, timeoutMs: 2_000 })
      expect(fresh).toMatchObject({ source: 'read-model', stale: false, revision: 2 })
      expect(fresh.items[0]?.summary).toContain('新正文')
    } finally {
      await api.close()
    }

    // 状态看板同样能从写模型回退（token 未投影）。
    const state = await create(stateInput('状态回退', 'blocked', 'D:/proj/fallback'))
    if (!state.result.ok) throw new Error('不可达')
    const stateToken = state.result.value.projectionToken
    await tasks.enqueue({ entityId: state.id, projection: 'state_board', revision: stateToken.revision })
    const stateApi = readApiOf()
    try {
      const snapshot = await stateApi.boards('state', { kind: 'project', projectKey: 'D:/proj/fallback' }, {
        token: stateToken,
        timeoutMs: 50,
      })
      expect(snapshot).toMatchObject({ source: 'write-model', stale: false })
      expect(snapshot.items[0]).toMatchObject({ entityId: state.id, status: 'blocked', projectKey: 'D:/proj/fallback' })
    } finally {
      await stateApi.close()
    }
  })

  it('给定积压/死信/成功后当查询 lag 则 pending/due/dead/水位年龄与 5 个投影形状稳定', async () => {
    const first = await createPreference('偏好：lag-1', 'a')
    const second = await createPreference('偏好：lag-2', 'b')
    await tasks.enqueue({ entityId: first.id, projection: 'preference_board', revision: 1 })
    await tasks.enqueue({ entityId: second.id, projection: 'preference_board', revision: 1 })
    await db.query("update omb.projection_task set available_at = now() - interval '5 seconds' where entity_id = $1", [first.id])

    let lag = (await tasks.lag()).find(item => item.projection === 'preference_board')
    expect(lag).toMatchObject({ pending: 2, claimed: 0, dead: 0, due: 2 })
    expect(lag?.oldestDueAgeMs).toBeGreaterThanOrEqual(4_000)
    expect(lag?.watermark).toBeUndefined()

    const worker = workerOf()
    await worker.tick()
    lag = (await tasks.lag()).find(item => item.projection === 'preference_board')
    expect(lag).toMatchObject({ pending: 0, due: 0, dead: 0 })
    expect(lag?.watermark).toBeDefined()
    expect(lag?.watermarkAgeMs).toBeGreaterThanOrEqual(0)

    // 死信计入 dead，不再进入 due（不会被 worker 领取）。
    await db.query("update omb.projection_task set status = 'dead' where entity_id = $1", [second.id])
    lag = (await tasks.lag()).find(item => item.projection === 'preference_board')
    expect(lag).toMatchObject({ pending: 0, claimed: 0, dead: 1, due: 0 })

    const api = readApiOf()
    try {
      const all = await api.lag()
      expect(all.map(item => item.projection)).toEqual([
        'preference_board',
        'state_board',
        'adoption_stat',
        'co_recall_pair',
        'similar_cache',
      ])
    } finally {
      await api.close()
    }
  })

  it('给定已有水位当推进更旧或相等的水位则不回退（单调）', async () => {
    await expect(tasks.advanceWatermark('preference_board', '2026-01-01T00:00:02.000Z')).resolves.toBe(true)
    await expect(tasks.advanceWatermark('preference_board', '2026-01-01T00:00:01.000Z')).resolves.toBe(false)
    await expect(tasks.advanceWatermark('preference_board', '2026-01-01T00:00:02.000Z')).resolves.toBe(false)
    expect((await tasks.watermark('preference_board'))?.watermark).toBe('2026-01-01T00:00:02.000Z')
    await expect(tasks.advanceWatermark('preference_board', '2026-01-01T00:00:03.000Z')).resolves.toBe(true)
    expect((await tasks.watermarks()).map(item => item.projection)).toEqual(['preference_board'])
    // 非时间水位会被拒绝而不是写坏水位列。
    await expect(tasks.advanceWatermark('preference_board', 'not-a-time')).rejects.toThrow(/水位/)
  })

  it('给定 enqueue 在写事务里但当事务回滚则不留下任务与唤醒', async () => {
    const { id } = await createPreference()
    // writer 创建事务已入队 revision 1；清掉它，单独验证“显式事务里 enqueue 后回滚”的场景。
    await db.query('delete from omb.projection_task where entity_id = $1', [id])
    await expect(db.transaction(async client => {
      const appended = await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 }, client)
      expect(appended.changed).toBe(true)
      throw new Error('writer rollback')
    })).rejects.toThrow('writer rollback')
    expect(await countRows('projection_task')).toBe(0)
    expect(await tasks.watermark('preference_board')).toBeUndefined()
    await expect(tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 })).resolves.toMatchObject({
      changed: true,
    })
  })

  it('给定大量已完成任务当 EXPLAIN claim SQL 则使用 projection_task_due 部分索引而不是全表扫描', async () => {
    await db.query(`
      insert into omb.entity (id, kind, revision)
      select 'mem_bulk_' || g, 'memory', 1 from generate_series(1, 3000) g
    `)
    await db.query(`
      insert into omb.projection_task (entity_id, projection, revision, status)
      select id, 'preference_board', 1, 'done' from omb.entity where id like 'mem_bulk_%'
    `)
    for (let index = 0; index < 5; index += 1) {
      const { id } = await createPreference(`偏好：explain-${index}`, `正文 ${index}`)
      await tasks.enqueue({ entityId: id, projection: 'preference_board', revision: 1 })
    }
    await db.query('analyze omb.projection_task')

    const explained = await db.query<ExplainRow>(
      `explain (format json) ${PROJECTION_CLAIM_SQL}`,
      ['preference_board', 25, 30_000],
    )
    const nodes = collectPlanNodes(explained.rows[0]?.['QUERY PLAN'])
    expect(nodes.some(node => node.index === 'projection_task_due')).toBe(true)
    expect(nodes.some(node => node.node === 'Seq Scan' && node.relation === 'projection_task')).toBe(false)
    expect(
      nodes
        .filter(node => node.relation === 'projection_task' && node.node.includes('Scan'))
        .every(node => node.index !== undefined),
    ).toBe(true)
    expect(await tasks.claim({ projection: 'preference_board', limit: 25, leaseMs: 5_000 })).toHaveLength(5)
  })

  it('给定大量看板行当 EXPLAIN 偏好读看板则使用 preference_board_scope 索引', async () => {
    await db.query(`
      insert into omb.entity (id, kind, revision)
      select 'mem_bulk_' || g, 'memory', 1 from generate_series(1, 3000) g
    `)
    await db.query(`
      insert into omb.preference_board (entity_id, scope, title, summary, salience, revision, updated_at)
      select id, 'global', '批量偏好', '批量摘要', ((row_number() over (order by id)) % 97)::real / 97, 1, now()
        from omb.entity where id like 'mem_bulk_%'
    `)
    await db.query('analyze omb.preference_board')

    const explained = await db.query<ExplainRow>(
      `explain (format json) ${PREFERENCE_BOARD_READ_SQL}`,
      ['global', 20],
    )
    const nodes = collectPlanNodes(explained.rows[0]?.['QUERY PLAN'])
    expect(nodes.some(node => node.index === 'preference_board_scope')).toBe(true)
    expect(nodes.some(node => node.node === 'Seq Scan' && node.relation === 'preference_board')).toBe(false)
    expect(await boardRows('preference', GLOBAL, 20)).toHaveLength(20)
  })
})
