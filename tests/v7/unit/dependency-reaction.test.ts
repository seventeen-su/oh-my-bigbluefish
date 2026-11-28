import { describe, expect, it } from 'vitest'
import {
  createRefreshReaction,
  dependencyInvalidationOf,
} from '../../../plugin/v7/reactions.js'
import { dependencyRefreshKey } from '../../../packages/v7/src/app/dependency.js'
import type { Entity } from '../../../packages/v7/src/domain/entity.js'
import type { JobQueue } from '../../../packages/v7/src/ports/jobs.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'

/**
 * outbox → 定向依赖刷新的纯逻辑：
 * - 只有写事务真的落了依赖标记（payload.dependency.marked > 0）才入队；
 * - 同一 root 用稳定 singletonKey 去重；归档 topic 不刷新实体自身，只刷新依赖方。
 * 真实 relay/队列行为由 PG 集成测试覆盖；这里不 sleep、不轮询。
 */

const ROOT = 'mem_root'

function payloadOf(options: {
  topic?: string
  dependency?: Record<string, unknown>
  entityId?: string
} = {}): Record<string, unknown> {
  return {
    streamId: options.entityId ?? ROOT,
    payload: {
      entityId: options.entityId ?? ROOT,
      ...(options.dependency !== undefined ? { dependency: options.dependency } : {}),
    },
    topic: options.topic ?? 'EntityPatched',
  }
}

function entityWith(dynamic: boolean): Entity {
  return {
    id: ROOT,
    kind: 'memory',
    revision: 2,
    origin: 'model',
    pinned: false,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    lifecycle: 'active',
    createdAt: '2026-11-29T00:00:00.000Z',
    updatedAt: '2026-11-29T00:00:00.000Z',
    attributes: dynamic
      ? [{
          name: 'mirror',
          ordinal: 0,
          required: false,
          source: 'model',
          value: { kind: 'dynamic', spec: { kind: 'ref', entityId: 'mem_other' } },
        }]
      : [],
  }
}

interface Enqueued {
  name: string
  payload: unknown
  singletonKey?: string
}

function reactionHarness(entity: Entity): { enqueued: Enqueued[]; reaction: ReturnType<typeof createRefreshReaction> } {
  const enqueued: Enqueued[] = []
  const queue = {
    async enqueue(name: string, payload: unknown, options?: { readonly singletonKey?: string }) {
      enqueued.push({ name, payload, ...(options?.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}) })
      return 'job-1'
    },
  } as unknown as JobQueue
  const store = {
    async get(id: string) {
      return id === entity.id ? entity : undefined
    },
  } as unknown as PostgresStore
  const reaction = createRefreshReaction({
    store,
    queue,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  return { enqueued, reaction }
}

describe('依赖失效 outbox reaction', () => {
  it('给定没有 dependency 摘要当解析则返回 undefined（不产生刷新任务）', () => {
    expect(dependencyInvalidationOf(payloadOf() as never)).toBeUndefined()
    expect(dependencyInvalidationOf(payloadOf({ dependency: { marked: 0 } }) as never)).toBeUndefined()
  })

  it('给定 dependency.marked>0 当解析则只认实体事件里的 root 和计数', () => {
    expect(dependencyInvalidationOf(payloadOf({ dependency: { marked: 3, direct: 1 } }) as never)).toEqual({
      rootEntityId: ROOT,
      marked: 3,
    })
    // 没有 entityId/streamId 的损坏事件不能猜 root。
    expect(dependencyInvalidationOf({ payload: { payload: { dependency: { marked: 1 } } } } as never)).toBeUndefined()
  })

  it('给定 EntityPatched 同时有动态属性与依赖标记当 reaction 则入队自身刷新 + 定向依赖刷新', async () => {
    const { enqueued, reaction } = reactionHarness(entityWith(true))
    await reaction.run(
      {
        id: 1,
        eventId: 1,
        topic: 'EntityPatched',
        payload: payloadOf({ dependency: { marked: 2 } }) as never,
        attempts: 0,
        createdAt: '2026-11-29T00:00:00.000Z',
        availableAt: '2026-11-29T00:00:00.000Z',
      },
      { id: 1, eventId: 1, topic: 'EntityPatched', attempt: 1, now: new Date() },
    )

    expect(enqueued).toEqual([
      { name: 'omb.refresh', payload: { entityId: ROOT }, singletonKey: 'refresh:event' },
      {
        name: 'omb.refresh',
        payload: { dependencyRoot: ROOT },
        singletonKey: dependencyRefreshKey(ROOT),
      },
    ])
    // 同一 root 的 storm 用同一个 key：队列只保留一个待跑任务。
    expect(dependencyRefreshKey(ROOT)).toBe(`refresh:dependency:${ROOT}`)
  })

  it('给定 EntityArchived 带依赖标记当 reaction 则只入队定向依赖刷新（不刷新已归档实体自身）', async () => {
    const { enqueued, reaction } = reactionHarness(entityWith(true))
    await reaction.run(
      {
        id: 2,
        eventId: 2,
        topic: 'EntityArchived',
        payload: payloadOf({ dependency: { marked: 1 } }) as never,
        attempts: 0,
        createdAt: '2026-11-29T00:00:00.000Z',
        availableAt: '2026-11-29T00:00:00.000Z',
      },
      { id: 2, eventId: 2, topic: 'EntityArchived', attempt: 1, now: new Date() },
    )

    expect(enqueued).toEqual([{
      name: 'omb.refresh',
      payload: { dependencyRoot: ROOT },
      singletonKey: dependencyRefreshKey(ROOT),
    }])
  })

  it('给定没有动态属性但当有依赖标记当 reaction 仍入队定向刷新', async () => {
    const { enqueued, reaction } = reactionHarness(entityWith(false))
    await reaction.run(
      {
        id: 3,
        eventId: 3,
        topic: 'EntityPatched',
        payload: payloadOf({ dependency: { marked: 1 } }) as never,
        attempts: 0,
        createdAt: '2026-11-29T00:00:00.000Z',
        availableAt: '2026-11-29T00:00:00.000Z',
      },
      { id: 3, eventId: 3, topic: 'EntityPatched', attempt: 1, now: new Date() },
    )

    expect(enqueued).toEqual([{
      name: 'omb.refresh',
      payload: { dependencyRoot: ROOT },
      singletonKey: dependencyRefreshKey(ROOT),
    }])
  })
})
