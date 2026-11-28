import { describe, expect, it } from 'vitest'
import { populateEmbedding } from '../../../packages/v7/src/app/embedding.js'
import { RememberService } from '../../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import type { Attribute, Entity, PatchEntityInput, StateStatus, WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { NormalizedWrite } from '../../../packages/v7/src/domain/validation.js'
import { OmbFailure, conflict } from '../../../packages/v7/src/domain/errors.js'
import type { JsonValue } from '../../../packages/v7/src/domain/json.js'
import type { JobOptions, JobQueue, Logger } from '../../../packages/v7/src/ports/jobs.js'
import type { DerivedWrite, PatchResult, ReadOptions, WriteResult } from '../../../packages/v7/src/ports/store.js'
import { FakeClock, FakeEmbedder, FakeStore } from './retrieval/fake.js'

const FIXED_AT = '2026-11-22T00:00:00.000Z'
const MEMORY_ID = 'mem_12345678-1234-4123-8123-123456789abc'
const STATE_ID = 'st_12345678-1234-4123-8123-123456789abc'
const OLD_BODY = '旧正文：生产连接池泄漏导致 ECONNRESET'
const NEW_BODY = '新正文：连接池已修复，改为重试并延长超时'

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function attr(ordinal: number, name: string, value: JsonValue, required = false): Attribute {
  return { name, ordinal, value: { kind: 'static', value }, required, source: 'test' }
}

function memoryEntity(id: string, body: string, options: { readonly pinned?: boolean } = {}): Entity {
  return {
    id,
    kind: 'memory',
    revision: 1,
    origin: 'user',
    pinned: options.pinned ?? false,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    lifecycle: 'active',
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    attributes: [
      attr(0, 'scope', { kind: 'global' }, true),
      attr(1, 'category', 'fact', true),
      attr(2, 'title', '连接池排障记录'),
      attr(3, 'body', body),
    ],
  }
}

function stateEntity(id: string, status: StateStatus): Entity {
  return {
    id,
    kind: 'state',
    revision: 1,
    origin: 'user',
    pinned: false,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    lifecycle: 'active',
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    attributes: [
      attr(0, 'scope', { kind: 'global' }, true),
      attr(1, 'title', '排障进度', true),
      attr(2, 'status', status, true),
      attr(3, 'time', FIXED_AT, true),
      attr(4, 'body', '连接池排障进行中'),
    ],
  }
}

/** 记录失效/入队顺序，证明「先失效旧向量，再入队重建」。 */
class FakeWritePath {
  readonly events: string[] = []
  readonly enqueued: { readonly name: string; readonly payload: unknown; readonly options?: JobOptions }[] = []
  enqueueError?: Error
  readonly invalidated: string[] = []
}

class RecordingQueue implements JobQueue {
  constructor(private readonly path: FakeWritePath) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async enqueue(name: string, payload: unknown, options?: JobOptions): Promise<string | null> {
    if (this.path.enqueueError !== undefined) throw this.path.enqueueError
    this.path.events.push('enqueue')
    this.path.enqueued.push({ name, payload, ...(options === undefined ? {} : { options }) })
    return `job-${this.path.enqueued.length}`
  }

  async work(_name: string, _handler: (payload: unknown) => Promise<void>): Promise<void> {
    throw new Error('unit fake 不注册 handler')
  }

  handlerFailures(): { readonly count: number; readonly recent: [] } {
    return { count: 0, recent: [] }
  }

  async finalFailures(): Promise<{ readonly count: number; readonly recent: [] }> {
    return { count: 0, recent: [] }
  }
}

class EmbeddingFakeStore extends FakeStore {
  readonly embeddingUpserts: { readonly entityId: string; readonly model: string; readonly dims: number; readonly embedding: readonly number[] }[] = []

  override async upsertEmbedding(entityId: string, model: string, dims: number, embedding: readonly number[]): Promise<void> {
    this.embeddingUpserts.push({ entityId, model, dims, embedding: [...embedding] })
  }
}

class UpdateFakeStore extends EmbeddingFakeStore {
  patchResult?: PatchResult
  patchError?: Error
  /** 模拟 patch 成功后读取权威属性行失败。 */
  refreshReadError?: Error
  readonly patches: { readonly input: NormalizedWrite; readonly patch: PatchEntityInput }[] = []

  override async get(id: string, options?: ReadOptions): Promise<Entity | undefined> {
    if (options?.includeArchived === true && this.refreshReadError !== undefined) throw this.refreshReadError
    return super.get(id, options)
  }

  override async patch(input: NormalizedWrite, patch: PatchEntityInput, _derived: DerivedWrite): Promise<PatchResult> {
    this.patches.push({ input, patch })
    if (this.patchError !== undefined) throw this.patchError
    if (this.patchResult === undefined) throw new Error('测试未设置 patchResult')
    this.entitiesById.set(input.id, this.patchResult.entity)
    return this.patchResult
  }
}

class WriteFakeStore extends EmbeddingFakeStore {
  writeResult?: WriteResult

  override async write(_input: NormalizedWrite, _derived: DerivedWrite): Promise<WriteResult> {
    if (this.writeResult === undefined) throw new Error('测试未设置 writeResult')
    return this.writeResult
  }
}

function updateService(
  store: UpdateFakeStore,
  path: FakeWritePath,
  options: { readonly embedder?: FakeEmbedder; readonly jobs?: boolean; readonly invalidateError?: Error } = {},
): UpdateService {
  const queue = options.jobs === false ? undefined : new RecordingQueue(path)
  return new UpdateService({
    store,
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    ...(queue === undefined ? {} : { jobs: queue }),
    clock: new FakeClock(),
    logger: NOOP_LOGGER,
    invalidateEmbedding: async entityId => {
      path.events.push('invalidate')
      if (options.invalidateError !== undefined) throw options.invalidateError
      path.invalidated.push(entityId)
    },
  })
}

describe('UpdateService 嵌入失效与重建', () => {
  it('给定正文属性变化当更新则先失效旧向量再入队重建', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    const before = memoryEntity(MEMORY_ID, OLD_BODY)
    store.entitiesById.set(MEMORY_ID, before)
    store.patchResult = { entity: { ...before, revision: 2, attributes: before.attributes.map(item => item.name === 'body' ? attr(item.ordinal, 'body', NEW_BODY) : item) } }
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, attrs: { body: NEW_BODY } })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : undefined).toBe('queued')
    // 顺序必须是先删旧向量、再入队，否则重建完成前 vector 通道仍在用旧文本的向量。
    expect(path.events).toEqual(['invalidate', 'enqueue'])
    expect(path.invalidated).toEqual([MEMORY_ID])
    expect(path.enqueued).toHaveLength(1)
    const job = path.enqueued[0]
    expect(job?.name).toBe('omb.embed')
    expect(job?.options?.singletonKey).toBe(`embed:${MEMORY_ID}`)
    expect(job?.options?.retryLimit).toBe(3)
    expect(job?.payload).toMatchObject({ entityId: MEMORY_ID })
    const text = (job?.payload as { text?: string } | undefined)?.text ?? ''
    expect(text).toContain(NEW_BODY)
    expect(text).not.toContain(OLD_BODY)
  })

  it('给定正文未变当更新则不入队也不失效', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    const before = memoryEntity(MEMORY_ID, OLD_BODY)
    store.entitiesById.set(MEMORY_ID, before)
    store.patchResult = { entity: { ...before, revision: 2 } }
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, attrs: { body: OLD_BODY } })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : 'expected-none').toBeUndefined()
    expect(path.events).toEqual([])
    expect(path.enqueued).toHaveLength(0)
  })

  it('给定只改 pinned 当更新则不入队也不失效', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    const before = memoryEntity(MEMORY_ID, OLD_BODY)
    store.entitiesById.set(MEMORY_ID, before)
    store.patchResult = { entity: { ...before, revision: 2, pinned: true } }
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, pinned: true })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : 'expected-none').toBeUndefined()
    expect(path.events).toEqual([])
  })

  it('给定状态机只改 status 与 time 当更新则不入队（流程元数据不算正文）', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    const before = stateEntity(STATE_ID, 'in_progress')
    store.entitiesById.set(STATE_ID, before)
    // status/time 都变了：searchText 会变，但正文没有变，不能触发嵌入失效。
    store.patchResult = {
      entity: {
        ...before,
        revision: 2,
        attributes: before.attributes.map(item => item.name === 'status'
          ? attr(item.ordinal, 'status', 'blocked', true)
          : item.name === 'time'
            ? attr(item.ordinal, 'time', '2026-11-23T08:00:00.000Z', true)
            : item),
      },
    }
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: STATE_ID, expectedRevision: 1, status: 'blocked', time: '2026-11-23T08:00:00.000Z' })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : 'expected-none').toBeUndefined()
    expect(path.events).toEqual([])
  })

  it('给定 update 失败当更新则不入队也不失效旧向量', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    store.entitiesById.set(MEMORY_ID, memoryEntity(MEMORY_ID, OLD_BODY))
    store.patchError = new OmbFailure(conflict('实体版本已变化'))
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, attrs: { body: NEW_BODY } })

    expect(result.ok).toBe(false)
    expect(path.events).toEqual([])
    expect(path.enqueued).toHaveLength(0)
  })

  it('给定入队失败当更新则降级同步嵌入并写回向量', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    const before = memoryEntity(MEMORY_ID, OLD_BODY)
    store.entitiesById.set(MEMORY_ID, before)
    store.patchResult = { entity: { ...before, revision: 2, attributes: before.attributes.map(item => item.name === 'body' ? attr(item.ordinal, 'body', NEW_BODY) : item) } }
    path.enqueueError = new Error('queue down')
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, attrs: { body: NEW_BODY } })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : undefined).toBe('done')
    expect(embedder.embedCalls).toHaveLength(1)
    expect(embedder.embedCalls[0]?.[0]).toContain(NEW_BODY)
    expect(store.embeddingUpserts).toHaveLength(1)
    expect(store.embeddingUpserts[0]).toMatchObject({ entityId: MEMORY_ID, model: embedder.model, dims: embedder.dims })
  })

  it('给定正文变化且嵌入器不可用当更新则先删旧向量再返回 unavailable', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    embedder.availableResult = false
    const before = memoryEntity(MEMORY_ID, OLD_BODY)
    store.entitiesById.set(MEMORY_ID, before)
    store.patchResult = { entity: { ...before, revision: 2, attributes: before.attributes.map(item => item.name === 'body' ? attr(item.ordinal, 'body', NEW_BODY) : item) } }
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, attrs: { body: NEW_BODY } })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : undefined).toBe('unavailable')
    // 正文已经变化、当前正文又产不出向量：旧向量必须先失效，否则 vector 通道继续召回旧语义。
    expect(path.events).toEqual(['invalidate'])
    expect(path.invalidated).toEqual([MEMORY_ID])
    // 不伪造新向量：不入队、不同步 upsert、不调用 embed()。
    expect(path.enqueued).toHaveLength(0)
    expect(store.embeddingUpserts).toHaveLength(0)
    expect(embedder.embedCalls).toHaveLength(0)
  })

  it('给定正文变化且嵌入器不可用当旧向量删除失败则更新仍成功返回 unavailable', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    embedder.availableResult = false
    const before = memoryEntity(MEMORY_ID, OLD_BODY)
    store.entitiesById.set(MEMORY_ID, before)
    store.patchResult = { entity: { ...before, revision: 2, attributes: before.attributes.map(item => item.name === 'body' ? attr(item.ordinal, 'body', NEW_BODY) : item) } }
    const service = updateService(store, path, { embedder, invalidateError: new Error('db blip') })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, attrs: { body: NEW_BODY } })

    // 删除失败只降级：更新已经落库，不能因此把 update 改判成失败。
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : undefined).toBe('unavailable')
    expect(path.events).toEqual(['invalidate'])
    expect(path.invalidated).toEqual([])
    expect(path.enqueued).toHaveLength(0)
    expect(store.embeddingUpserts).toHaveLength(0)
  })

  it('给定刷新阶段读取失败当更新仍返回成功且不留下任务', async () => {
    const store = new UpdateFakeStore()
    const path = new FakeWritePath()
    const embedder = new FakeEmbedder()
    const before = memoryEntity(MEMORY_ID, OLD_BODY)
    store.entitiesById.set(MEMORY_ID, before)
    store.patchResult = { entity: { ...before, revision: 2, attributes: before.attributes.map(item => item.name === 'body' ? attr(item.ordinal, 'body', NEW_BODY) : item) } }
    store.refreshReadError = new Error('db blip')
    const service = updateService(store, path, { embedder })

    const result = await service.update({ id: MEMORY_ID, expectedRevision: 1, attrs: { body: NEW_BODY } })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : 'expected-none').toBeUndefined()
    expect(path.events).toEqual([])
  })
})

describe('populateEmbedding 空文本边界', () => {
  it('给定文本为空当刷新嵌入则只失效旧向量且返回 unavailable', async () => {
    const store = new EmbeddingFakeStore()
    const embedder = new FakeEmbedder()
    const invalidated: string[] = []

    const status = await populateEmbedding(
      { store, embedder, logger: NOOP_LOGGER },
      MEMORY_ID,
      '   ',
      { invalidate: async entityId => { invalidated.push(entityId) } },
    )

    expect(status).toBe('unavailable')
    expect(invalidated).toEqual([MEMORY_ID])
    expect(embedder.embedCalls).toHaveLength(0)
    expect(store.embeddingUpserts).toHaveLength(0)
  })
})

describe('RememberService 嵌入路径（抽公共逻辑后的回归）', () => {
  function rememberService(store: WriteFakeStore, path: FakeWritePath, jobs: boolean): RememberService {
    return new RememberService({
      store,
      embedder: new FakeEmbedder(),
      ...(jobs ? { jobs: new RecordingQueue(path) } : {}),
      clock: new FakeClock(),
      logger: NOOP_LOGGER,
    })
  }

  it('给定有队列当 remember 则仍入队 omb.embed 并返回 queued', async () => {
    const store = new WriteFakeStore()
    const path = new FakeWritePath()
    const entity = memoryEntity(MEMORY_ID, NEW_BODY)
    store.writeResult = { entity, similarAttributes: [], similarEntities: [], archivedMatches: [] }
    const input: WriteEntityInput = {
      kind: 'memory',
      id: MEMORY_ID,
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { body: NEW_BODY },
    }

    const result = await rememberService(store, path, true).remember(input)

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : undefined).toBe('queued')
    expect(path.enqueued).toHaveLength(1)
    expect(path.enqueued[0]?.name).toBe('omb.embed')
    expect(path.enqueued[0]?.options?.singletonKey).toBe(`embed:${MEMORY_ID}`)
    expect((path.enqueued[0]?.payload as { text?: string } | undefined)?.text).toContain(NEW_BODY)
  })

  it('给定没有队列当 remember 则仍同步嵌入并写回向量', async () => {
    const store = new WriteFakeStore()
    const path = new FakeWritePath()
    const entity = memoryEntity(MEMORY_ID, NEW_BODY)
    store.writeResult = { entity, similarAttributes: [], similarEntities: [], archivedMatches: [] }
    const input: WriteEntityInput = {
      kind: 'memory',
      id: MEMORY_ID,
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { body: NEW_BODY },
    }

    const result = await rememberService(store, path, false).remember(input)

    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.embedding : undefined).toBe('done')
    expect(store.embeddingUpserts).toHaveLength(1)
    expect(store.embeddingUpserts[0]?.entityId).toBe(MEMORY_ID)
  })
})
