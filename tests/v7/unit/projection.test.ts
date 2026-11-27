import { describe, expect, it } from 'vitest'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Scope } from '../../../packages/v7/src/domain/entity.js'
import type { ProjectionToken } from '../../../packages/v7/src/app/commands/types.js'
import {
  PROJECTION_NAMES,
  ProjectionReadApi,
  ProjectionWorker,
  type BoardItem,
  type BoardQuery,
  type BoardReader,
  type ClaimedProjectionTask,
  type ProjectionEnqueueInput,
  type ProjectionEnqueueResult,
  type ProjectionLag,
  type ProjectionName,
  type ProjectionOutcome,
  type ProjectionProjector,
  type ProjectionTask,
  type ProjectionTaskState,
  type ProjectionTaskStore,
  type ProjectionWakeSource,
  type ProjectionWatermark,
} from '../../../packages/v7/src/app/projections/index.js'

/**
 * 投影 worker / read-your-writes 的纯逻辑证据（不依赖 PostgreSQL）。
 *
 * 队列的 SQL 语义（SKIP LOCKED、租约、索引）由 integration/projection.test.ts 用真实 PG 证明；
 * 这里用内存假 store 验证**编排逻辑**：按 projection 分批、失败隔离/退避/死信、
 * stop 归还、启动恢复、水位只在成功后推进、token 等待/回退/stale。
 */

const EPOCH = new Date('2026-01-01T00:00:00.000Z')

interface FakeRow {
  entityId: string
  projection: ProjectionName
  revision: number
  status: 'pending' | 'claimed' | 'done' | 'dead'
  attempts: number
  availableAt: number
}

/**
 * 内存队列：镜像 ProjectionTaskStore 的语义（lease = availableAt、attempts CAS、水位单调）。
 * 时间由测试注入，避免真实时钟/睡眠。
 */
class FakeProjectionStore implements ProjectionTaskStore {
  readonly rows = new Map<string, FakeRow>()
  readonly watermarkRows = new Map<ProjectionName, ProjectionWatermark>()
  taskStateChecks = 0
  onTaskStateCheck: ((checks: number) => void) | undefined

  constructor(private readonly now: () => Date) {}

  async enqueue(input: ProjectionEnqueueInput): Promise<ProjectionEnqueueResult> {
    const key = rowKey(input.entityId, input.projection)
    const existing = this.rows.get(key)
    if (existing !== undefined && existing.revision >= input.revision) {
      return {
        entityId: input.entityId,
        projection: input.projection,
        revision: existing.revision,
        status: existing.status,
        changed: false,
      }
    }
    const row: FakeRow = {
      entityId: input.entityId,
      projection: input.projection,
      revision: input.revision,
      status: 'pending',
      attempts: 0,
      availableAt: input.availableAt?.getTime() ?? this.now().getTime(),
    }
    this.rows.set(key, row)
    return {
      entityId: input.entityId,
      projection: input.projection,
      revision: input.revision,
      status: 'pending',
      changed: true,
    }
  }

  async claim(options: {
    projection: ProjectionName
    limit: number
    leaseMs: number
  }): Promise<readonly ClaimedProjectionTask[]> {
    const now = this.now().getTime()
    const due = [...this.rows.values()]
      .filter(row => row.projection === options.projection
        && (row.status === 'pending' || row.status === 'claimed')
        && row.availableAt <= now)
      .sort((left, right) => left.availableAt - right.availableAt || left.entityId.localeCompare(right.entityId))
      .slice(0, options.limit)
    return due.map(row => {
      row.status = 'claimed'
      row.availableAt = now + options.leaseMs
      return {
        entityId: row.entityId,
        projection: row.projection,
        revision: row.revision,
        attempts: row.attempts,
        availableAt: new Date(row.availableAt).toISOString(),
      }
    })
  }

  async complete(task: ClaimedProjectionTask): Promise<boolean> {
    const row = this.rows.get(rowKey(task.entityId, task.projection))
    if (row === undefined || row.status !== 'claimed' || row.attempts !== task.attempts) return false
    row.status = 'done'
    row.availableAt = this.now().getTime()
    return true
  }

  async fail(input: {
    task: ClaimedProjectionTask
    error: string
    dead?: boolean
    retryAt?: Date
  }): Promise<boolean> {
    const row = this.rows.get(rowKey(input.task.entityId, input.task.projection))
    if (row === undefined || row.status !== 'claimed' || row.attempts !== input.task.attempts) return false
    row.attempts += 1
    if (input.dead === true) {
      row.status = 'dead'
    } else {
      row.status = 'pending'
      row.availableAt = input.retryAt?.getTime() ?? this.now().getTime()
    }
    return true
  }

  async release(task: ClaimedProjectionTask): Promise<boolean> {
    const row = this.rows.get(rowKey(task.entityId, task.projection))
    if (row === undefined || row.status !== 'claimed' || row.attempts !== task.attempts) return false
    row.status = 'pending'
    row.availableAt = this.now().getTime()
    return true
  }

  async advanceWatermark(projection: ProjectionName, watermark: string): Promise<boolean> {
    const existing = this.watermarkRows.get(projection)
    if (existing !== undefined && Date.parse(existing.watermark) >= Date.parse(watermark)) return false
    this.watermarkRows.set(projection, {
      projection,
      watermark,
      updatedAt: this.now().toISOString(),
    })
    return true
  }

  async watermark(projection: ProjectionName): Promise<ProjectionWatermark | undefined> {
    return this.watermarkRows.get(projection)
  }

  async watermarks(): Promise<readonly ProjectionWatermark[]> {
    return [...this.watermarkRows.values()]
  }

  async lag(): Promise<readonly ProjectionLag[]> {
    const now = this.now().getTime()
    return PROJECTION_NAMES.map(projection => {
      const rows = [...this.rows.values()].filter(row => row.projection === projection)
      const watermark = this.watermarkRows.get(projection)
      const dueRows = rows.filter(row => (row.status === 'pending' || row.status === 'claimed') && row.availableAt <= now)
      return {
        projection,
        pending: rows.filter(row => row.status === 'pending').length,
        claimed: rows.filter(row => row.status === 'claimed').length,
        dead: rows.filter(row => row.status === 'dead').length,
        due: dueRows.length,
        oldestDueAgeMs: dueRows.length === 0
          ? 0
          : now - Math.min(...dueRows.map(row => row.availableAt)),
        ...(watermark === undefined
          ? {}
          : {
              watermark: watermark.watermark,
              watermarkAgeMs: Math.max(0, now - Date.parse(watermark.watermark)),
              updatedAt: watermark.updatedAt,
            }),
      }
    })
  }

  async taskState(entityId: string, projection: ProjectionName): Promise<ProjectionTaskState | undefined> {
    this.taskStateChecks += 1
    const row = this.rows.get(rowKey(entityId, projection))
    const state = row === undefined ? undefined : { status: row.status, revision: row.revision }
    this.onTaskStateCheck?.(this.taskStateChecks)
    return state
  }

  setRow(entityId: string, projection: ProjectionName, patch: Partial<FakeRow>): void {
    const row = this.rows.get(rowKey(entityId, projection))
    if (row === undefined) throw new Error('没有该任务行')
    Object.assign(row, patch)
  }
}

class FakeWake implements ProjectionWakeSource {
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  fire(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeBoards implements BoardReader {
  readonly readRows: BoardItem[] = []
  readonly rowByEntity = new Map<string, BoardItem>()
  readonly derivedRows: BoardItem[] = []
  boardReads = 0
  deriveCalls = 0

  async readBoard(_query: BoardQuery): Promise<readonly BoardItem[]> {
    this.boardReads += 1
    return this.readRows
  }

  async readBoardRow(_kind: 'preference' | 'state', entityId: string): Promise<BoardItem | undefined> {
    return this.rowByEntity.get(entityId)
  }

  async deriveFromWriteModel(_query: BoardQuery): Promise<readonly BoardItem[]> {
    this.deriveCalls += 1
    return this.derivedRows
  }
}

function rowKey(entityId: string, projection: ProjectionName): string {
  return `${entityId}\u0000${projection}`
}

function clockOf(now: () => Date): Clock {
  return { now, iso: () => now().toISOString() }
}

function memoryItem(entityId: string, revision: number, title = '偏好：先写测试'): BoardItem {
  return {
    entityId,
    title,
    summary: '正文',
    salience: 0.9,
    revision,
    updatedAt: nowIso(),
  }
}

function nowIso(): string {
  return EPOCH.toISOString()
}

function token(entityId: string, revision: number): ProjectionToken {
  return { entityId, revision, watermark: String(revision) }
}

interface RecordedCall {
  readonly projection: ProjectionName
  readonly entityId: string
}

function workerOf(
  store: ProjectionTaskStore,
  now: () => Date,
  projectors: readonly ProjectionProjector[],
  options: { batchSize?: number; leaseMs?: number; retry?: { maxAttempts: number; baseDelayMs: number; factor: number; maxDelayMs: number } } = {},
): ProjectionWorker {
  return new ProjectionWorker(
    { store, projectors, clock: clockOf(now) },
    { batchSize: options.batchSize ?? 10, leaseMs: options.leaseMs ?? 5_000, ...(options.retry !== undefined ? { retry: options.retry } : {}) },
  )
}

function projectorOf(
  projection: ProjectionName,
  run: (task: ProjectionTask) => ProjectionOutcome | Promise<ProjectionOutcome>,
): ProjectionProjector {
  return { projection, project: async task => run(task) }
}

describe('ProjectionWorker 编排（内存 append-only fake store）', () => {
  it('给定两个投影各有到期任务当 tick 则按 projection 分别 claim 并各自推进水位', async () => {
    const now = EPOCH
    const store = new FakeProjectionStore(() => now)
    await store.enqueue({ entityId: 'mem_a', projection: 'preference_board', revision: 1 })
    await store.enqueue({ entityId: 'mem_b', projection: 'preference_board', revision: 2 })
    await store.enqueue({ entityId: 'st_a', projection: 'state_board', revision: 3 })
    const calls: RecordedCall[] = []
    const worker = workerOf(store, () => now, [
      projectorOf('preference_board', task => {
        calls.push({ projection: task.projection, entityId: task.entityId })
        return { sourceUpdatedAt: task.entityId === 'mem_a' ? '2026-01-01T00:00:01.000Z' : '2026-01-01T00:00:02.000Z' }
      }),
      projectorOf('state_board', task => {
        calls.push({ projection: task.projection, entityId: task.entityId })
        return { sourceUpdatedAt: '2026-01-01T00:00:03.000Z' }
      }),
    ])

    const summary = await worker.tick()
    expect(summary).toMatchObject({ claimed: 3, projected: 3, retried: 0, dead: 0 })
    // 同一 projection 内按 claim 顺序；不同投影分批 claim。
    expect(calls).toEqual([
      { projection: 'preference_board', entityId: 'mem_a' },
      { projection: 'preference_board', entityId: 'mem_b' },
      { projection: 'state_board', entityId: 'st_a' },
    ])
    expect((await store.watermark('preference_board'))?.watermark).toBe('2026-01-01T00:00:02.000Z')
    expect((await store.watermark('state_board'))?.watermark).toBe('2026-01-01T00:00:03.000Z')
    expect([...store.rows.values()].every(row => row.status === 'done')).toBe(true)
  })

  it('给定一个投影抛错当 tick 则另一个仍完成、失败任务退避且该投影水位不推进', async () => {
    const now = EPOCH
    const store = new FakeProjectionStore(() => now)
    await store.enqueue({ entityId: 'mem_good', projection: 'preference_board', revision: 1 })
    await store.enqueue({ entityId: 'mem_bad', projection: 'preference_board', revision: 1 })
    await store.enqueue({ entityId: 'st_a', projection: 'state_board', revision: 1 })
    const worker = workerOf(
      store,
      () => now,
      [
        projectorOf('preference_board', task => {
          if (task.entityId === 'mem_bad') throw new Error('投影失败：源行不可用')
          return { sourceUpdatedAt: '2026-01-01T00:00:05.000Z' }
        }),
        projectorOf('state_board', () => ({ sourceUpdatedAt: '2026-01-01T00:00:06.000Z' })),
      ],
      { retry: { maxAttempts: 5, baseDelayMs: 250, factor: 4, maxDelayMs: 60_000 } },
    )

    const summary = await worker.tick()
    expect(summary).toMatchObject({ claimed: 3, projected: 2, retried: 1, dead: 0 })
    expect((await store.taskState('mem_bad', 'preference_board'))).toMatchObject({ status: 'pending', revision: 1 })
    const badRow = store.rows.get(rowKey('mem_bad', 'preference_board'))
    expect(badRow?.attempts).toBe(1)
    // 第一次退避 250ms，从注入时钟算起。
    expect(badRow?.availableAt).toBe(EPOCH.getTime() + 250)
    // 只有成功的源时间能推进水位；失败任务的源时间绝不写水位。
    expect((await store.watermark('preference_board'))?.watermark).toBe('2026-01-01T00:00:05.000Z')
    expect((await store.watermark('state_board'))?.watermark).toBe('2026-01-01T00:00:06.000Z')
    await expect(worker.stats()).resolves.toMatchObject({ projected: 2, retried: 1 })
  })

  it('给定失败达到上限当 tick 则任务进入死信且未推进水位', async () => {
    let now = EPOCH
    const store = new FakeProjectionStore(() => now)
    await store.enqueue({ entityId: 'mem_bad', projection: 'preference_board', revision: 1 })
    const worker = workerOf(store, () => now, [
      projectorOf('preference_board', () => {
        throw new Error('boom')
      }),
    ], { retry: { maxAttempts: 2, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 } })

    expect(await worker.tick()).toMatchObject({ claimed: 1, projected: 0, retried: 1, dead: 0 })
    expect((await store.taskState('mem_bad', 'preference_board'))?.status).toBe('pending')
    now = new Date(EPOCH.getTime() + 100)
    expect(await worker.tick()).toMatchObject({ claimed: 1, retried: 0, dead: 1 })
    expect((await store.taskState('mem_bad', 'preference_board'))?.status).toBe('dead')
    expect(await store.watermark('preference_board')).toBeUndefined()
    expect(await worker.tick()).toMatchObject({ claimed: 0 })
  })

  it('给定 stop 时批内仍有任务当停止则未投影任务归还 pending、已完成任务保持 done', async () => {
    const now = EPOCH
    const store = new FakeProjectionStore(() => now)
    for (const entityId of ['mem_a', 'mem_b', 'mem_c']) {
      await store.enqueue({ entityId, projection: 'preference_board', revision: 1 })
    }
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    let runs = 0
    const worker = workerOf(store, () => now, [
      projectorOf('preference_board', async () => {
        runs += 1
        if (runs === 1) {
          entered()
          await gate
        }
        return {}
      }),
    ], { batchSize: 10 })

    const tick = worker.tick()
    await started
    const stopping = worker.stop()
    release()
    const summary = await tick
    await stopping
    expect(summary).toMatchObject({ claimed: 3, projected: 1, released: 2 })
    const statuses = [...store.rows.values()].map(row => row.status).sort()
    expect(statuses).toEqual(['done', 'pending', 'pending'])

    const resumed = workerOf(store, () => now, [projectorOf('preference_board', () => ({}))])
    await expect(resumed.drain()).resolves.toMatchObject({ projected: 2 })
    expect([...store.rows.values()].every(row => row.status === 'done')).toBe(true)
  })

  it('给定重复注册同一投影当构造 worker 则抛错', () => {
    const store = new FakeProjectionStore(() => EPOCH)
    expect(() => workerOf(store, () => EPOCH, [
      projectorOf('preference_board', () => ({})),
      projectorOf('preference_board', () => ({})),
    ])).toThrow(/注册了多个 projector/)
  })

  it('给定崩溃遗留 claimed 行且租约已过当 recover 则计数并可在新 worker 上完成投影', async () => {
    let now = EPOCH
    const store = new FakeProjectionStore(() => now)
    await store.enqueue({ entityId: 'mem_a', projection: 'preference_board', revision: 1 })
    // 模拟第一个 worker claim 后崩溃：行是 claimed、租约已过期。
    await store.claim({ projection: 'preference_board', limit: 10, leaseMs: 1 })
    now = new Date(EPOCH.getTime() + 1)
    const restarted = workerOf(store, () => now, [projectorOf('preference_board', () => ({}))])
    await expect(restarted.recover()).resolves.toBe(1)
    await restarted.drain()
    expect(await store.taskState('mem_a', 'preference_board')).toMatchObject({ status: 'done' })
  })
})

describe('ProjectionReadApi read-your-writes（内存 fake store/boards）', () => {
  const globalScope: Scope = { kind: 'global' }

  function readApi(store: ProjectionTaskStore, boards: BoardReader, wake: ProjectionWakeSource): ProjectionReadApi {
    return new ProjectionReadApi({ store, boards, clock: clockOf(() => EPOCH), wake })
  }

  it('给定任务已 done 覆盖 token 当读看板则直接返回读模型且不等待', async () => {
    const store = new FakeProjectionStore(() => EPOCH)
    await store.enqueue({ entityId: 'mem_a', projection: 'preference_board', revision: 2 })
    store.setRow('mem_a', 'preference_board', { status: 'done' })
    const boards = new FakeBoards()
    boards.readRows.push(memoryItem('mem_a', 2))
    const api = readApi(store, boards, new FakeWake())

    const snapshot = await api.boards('preference', globalScope, { token: token('mem_a', 2), timeoutMs: 5_000 })
    expect(snapshot).toMatchObject({ source: 'read-model', stale: false, revision: 2, waitedMs: 0 })
    expect(snapshot.items.map(item => item.entityId)).toEqual(['mem_a'])
    expect(boards.deriveCalls).toBe(0)
    await api.close()
  })

  it('给定读模型行 revision 已覆盖 token 当没有任务行则不等待', async () => {
    const store = new FakeProjectionStore(() => EPOCH)
    const boards = new FakeBoards()
    boards.readRows.push(memoryItem('mem_a', 3))
    boards.rowByEntity.set('mem_a', memoryItem('mem_a', 3))
    const api = readApi(store, boards, new FakeWake())

    const snapshot = await api.boards('preference', globalScope, { token: token('mem_a', 2), timeoutMs: 5_000 })
    expect(snapshot).toMatchObject({ source: 'read-model', stale: false, revision: 3 })
    expect(boards.deriveCalls).toBe(0)
    await api.close()
  })

  it('给定等待期间 worker 完成并 NOTIFY 当读看板则立刻返回读模型', async () => {
    const store = new FakeProjectionStore(() => EPOCH)
    await store.enqueue({ entityId: 'mem_a', projection: 'preference_board', revision: 2 })
    const boards = new FakeBoards()
    boards.readRows.push(memoryItem('mem_a', 2))
    const wake = new FakeWake()
    // 第一次 taskState 仍返回 pending（等待已注册），随后 worker 完成并发 NOTIFY；
    // 第二次 taskState 返回 done，读直接成功，不依赖真实时间。
    store.onTaskStateCheck = checks => {
      if (checks !== 1) return
      store.setRow('mem_a', 'preference_board', { status: 'done' })
      wake.fire()
    }
    const api = readApi(store, boards, wake)

    const snapshot = await api.boards('preference', globalScope, { token: token('mem_a', 2), timeoutMs: 5_000 })
    expect(snapshot).toMatchObject({ source: 'read-model', stale: false, revision: 2 })
    expect(store.taskStateChecks).toBeGreaterThanOrEqual(2)
    expect(boards.deriveCalls).toBe(0)
    await api.close()
  })

  it('给定 token 未被投影覆盖当超时则标志 stale 并把缺失的 token 一起返回', async () => {
    const store = new FakeProjectionStore(() => EPOCH)
    await store.enqueue({ entityId: 'mem_a', projection: 'preference_board', revision: 4 })
    const boards = new FakeBoards()
    const api = readApi(store, boards, new FakeWake())

    const snapshot = await api.boards('preference', globalScope, {
      token: token('mem_a', 4),
      timeoutMs: 0,
      onTimeout: 'stale',
    })
    expect(snapshot).toMatchObject({ source: 'read-model', stale: true, revision: 0 })
    expect(snapshot.token?.revision).toBe(4)
    expect(snapshot.lag.pending).toBe(1)
    await api.close()
  })

  it('给定 token 未被投影覆盖当默认超时则回退写模型且不标 stale', async () => {
    const store = new FakeProjectionStore(() => EPOCH)
    await store.enqueue({ entityId: 'mem_a', projection: 'preference_board', revision: 4 })
    const boards = new FakeBoards()
    boards.derivedRows.push(memoryItem('mem_a', 4, '偏好：写模型回退'))
    const api = readApi(store, boards, new FakeWake())

    const snapshot = await api.boards('preference', globalScope, { token: token('mem_a', 4), timeoutMs: 0 })
    expect(snapshot).toMatchObject({ source: 'write-model', stale: false, revision: 4 })
    expect(snapshot.items[0]?.title).toBe('偏好：写模型回退')
    expect(boards.deriveCalls).toBe(1)
    await api.close()
  })

  it('给定 token 等待超时当 awaitToken 则返回 stale 而不假装追上', async () => {
    const store = new FakeProjectionStore(() => EPOCH)
    await store.enqueue({ entityId: 'mem_a', projection: 'state_board', revision: 2 })
    const api = readApi(store, new FakeBoards(), new FakeWake())
    await expect(api.awaitToken(token('mem_a', 2), { kind: 'state', timeoutMs: 0 })).resolves.toMatchObject({
      ok: false,
      stale: true,
      revision: 0,
      projection: 'state_board',
    })
    await api.close()
  })

  it('给定 token 不存在的实体当任务 done 之后仍判定追上且不残留等待', async () => {
    const store = new FakeProjectionStore(() => EPOCH)
    await store.enqueue({ entityId: 'mem_gone', projection: 'preference_board', revision: 6 })
    store.setRow('mem_gone', 'preference_board', { status: 'done' })
    const boards = new FakeBoards()
    const api = readApi(store, boards, new FakeWake())
    const outcome = await api.awaitToken(token('mem_gone', 6), { kind: 'preference', timeoutMs: 0 })
    expect(outcome).toMatchObject({ ok: true, stale: false, revision: 6 })
    // lag 里没有 pending；读模型为空也不影响“已投影”的判定。
    expect(await api.lag()).toHaveLength(PROJECTION_NAMES.length)
    await api.close()
  })
})
