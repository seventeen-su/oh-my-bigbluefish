import { describe, expect, it } from 'vitest'
import { DynamicService } from '../../../../packages/v7/src/app/dynamic.js'
import type { Attribute, Entity } from '../../../../packages/v7/src/domain/entity.js'
import type { DynamicSpec } from '../../../../packages/v7/src/domain/dynamic-spec.js'
import type { DependencyAttributeRef, DependencyStaleMark } from '../../../../packages/v7/src/domain/dependency.js'
import type { JsonValue } from '../../../../packages/v7/src/domain/json.js'
import type { DynamicContext, DynamicResolver } from '../../../../packages/v7/src/ports/dynamic.js'
import type { Store } from '../../../../packages/v7/src/ports/store.js'

/**
 * 动态属性读取侧的依赖失效语义（app 层）：
 * - 带标记的属性不看 TTL，立即按 depth/陈旧时间优先刷新；
 * - 刷新失败时返回的实体必须带 staleReason 且不暴露旧 cachedValue（不允许静默用旧值）；
 * - 成功刷新清除标记，失败保留标记等待重试。
 */

const NOW = '2026-11-29T00:00:00.000Z'
const clock = { now: () => new Date(NOW), iso: () => NOW }

function dynamicAttribute(
  name: string,
  spec: DynamicSpec,
  options: { ordinal?: number; cachedValue?: JsonValue; cachedAt?: string; lastError?: string } = {},
): Attribute {
  return {
    name,
    ordinal: options.ordinal ?? 0,
    required: false,
    source: 'model',
    value: {
      kind: 'dynamic',
      spec,
      ...(options.cachedValue !== undefined ? { cachedValue: options.cachedValue } : {}),
      ...(options.cachedAt !== undefined ? { cachedAt: options.cachedAt } : {}),
      ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
    },
  }
}

function entityOf(attributes: Attribute[]): Entity {
  return {
    id: 'mem_c',
    kind: 'memory',
    revision: 3,
    origin: 'model',
    pinned: false,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    isCurrent: true,
    lifecycle: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    attributes,
  }
}

function mark(
  attrName: string,
  options: { ordinal?: number; depth?: number; reason?: string } = {},
): DependencyStaleMark {
  return {
    entityId: 'mem_c',
    attrName,
    ordinal: options.ordinal ?? 0,
    depth: options.depth ?? 0,
    reason: options.reason ?? 'dependency:patch:mem_b',
    rootEntityId: 'mem_b',
    operation: 'patch',
    markedAt: NOW,
  }
}

class FakeDynamicStore {
  readonly cacheWrites: { name: string; ordinal: number; value: JsonValue | undefined; error?: string }[] = []
  readonly clears: { entityId: string; attrs?: readonly DependencyAttributeRef[] }[] = []
  private readonly marks = new Map<string, DependencyStaleMark[]>()

  constructor(public entity: Entity) {}

  setMark(value: DependencyStaleMark): void {
    const current = this.marks.get(value.entityId) ?? []
    current.push(value)
    this.marks.set(value.entityId, current)
  }

  marksOf(entityId: string): readonly DependencyStaleMark[] {
    return [...(this.marks.get(entityId) ?? [])]
  }

  async get(id: string): Promise<Entity | undefined> {
    if (id !== this.entity.id) return undefined
    return {
      ...this.entity,
      attributes: this.entity.attributes.map(attribute => ({
        ...attribute,
        value: { ...attribute.value },
      })),
    }
  }

  async setAttributeCache(
    _entityId: string,
    name: string,
    ordinal: number,
    value: JsonValue | undefined,
    cachedAt: string,
    error?: string,
  ): Promise<void> {
    this.cacheWrites.push({ name, ordinal, value, ...(error !== undefined ? { error } : {}) })
    const index = this.entity.attributes.findIndex(item => item.name === name && item.ordinal === ordinal)
    const attribute = index < 0 ? undefined : this.entity.attributes[index]
    if (attribute?.value.kind !== 'dynamic') return
    const base = { kind: 'dynamic' as const, spec: attribute.value.spec, cachedAt }
    // 与 Postgres setAttributeCache 的新语义保持一致：失败保留旧缓存，成功（包括 undefined）覆盖。
    const finalValue = error !== undefined
      ? {
          ...base,
          ...(attribute.value.cachedValue !== undefined ? { cachedValue: attribute.value.cachedValue } : {}),
          lastError: error,
        }
      : {
          ...base,
          ...(value !== undefined ? { cachedValue: value } : {}),
        }
    this.entity = {
      ...this.entity,
      attributes: this.entity.attributes.map((item, position) => (
        position === index ? { ...item, value: finalValue } : item
      )),
    }
  }

  async dependencyMarks(entityId: string): Promise<readonly DependencyStaleMark[]> {
    return this.marksOf(entityId)
  }

  async clearDependencyMarks(entityId: string, attrs?: readonly DependencyAttributeRef[]): Promise<void> {
    this.clears.push({ entityId, ...(attrs !== undefined ? { attrs } : {}) })
    if (attrs === undefined) {
      this.marks.delete(entityId)
      return
    }
    const remaining = this.marksOf(entityId).filter(item => !attrs.some(attr => attr.name === item.attrName && attr.ordinal === item.ordinal))
    this.marks.set(entityId, remaining)
  }
}

class RecordingResolver implements DynamicResolver {
  readonly specs: DynamicSpec[] = []

  constructor(private readonly resolveValue: (spec: DynamicSpec, context: DynamicContext) => Promise<JsonValue | undefined>) {}

  async resolve(spec: DynamicSpec, context: DynamicContext): Promise<JsonValue | undefined> {
    this.specs.push(spec)
    return this.resolveValue(spec, context)
  }
}

function service(store: FakeDynamicStore, resolver: DynamicResolver): DynamicService {
  return new DynamicService({
    store: store as unknown as Store,
    resolver,
    clock,
  })
}

describe('动态属性读取的依赖失效', () => {
  it('给定依赖标记当解析成功则立即刷新并清除标记', async () => {
    const store = new FakeDynamicStore(entityOf([
      dynamicAttribute('mirror', { kind: 'ref', entityId: 'mem_b', attr: 'title' }, { cachedValue: '旧值', cachedAt: NOW }),
    ]))
    store.setMark(mark('mirror'))
    const resolver = new RecordingResolver(async () => '新值')

    const refreshed = await service(store, resolver).refreshById('mem_c')

    expect(resolver.specs).toEqual([{ kind: 'ref', entityId: 'mem_b', attr: 'title' }])
    expect(store.cacheWrites[0]).toMatchObject({ name: 'mirror', value: '新值' })
    expect(store.clears).toEqual([{ entityId: 'mem_c', attrs: [{ name: 'mirror', ordinal: 0 }] }])
    const attribute = refreshed?.attributes.find(item => item.name === 'mirror')
    expect(attribute?.value.kind === 'dynamic' ? attribute.value.cachedValue : undefined).toBe('新值')
    expect(attribute?.value.kind === 'dynamic' ? attribute.value.staleReason : undefined).toBeUndefined()
  })

  it('给定依赖标记当解析失败则保留标记、不返回旧缓存并带 staleReason', async () => {
    const store = new FakeDynamicStore(entityOf([
      dynamicAttribute('mirror', { kind: 'ref', entityId: 'mem_b', attr: 'title' }, { cachedValue: '旧值', cachedAt: NOW }),
    ]))
    store.setMark(mark('mirror'))
    const resolver = new RecordingResolver(async () => {
      throw new Error('boom')
    })

    const refreshed = await service(store, resolver).refreshById('mem_c')

    expect(store.clears).toEqual([])
    expect(store.marksOf('mem_c')).toHaveLength(1)
    // 数据库仍保留旧缓存（失败不清旧值），但读取返回值不允许静默使用。
    const persisted = store.entity.attributes.find(item => item.name === 'mirror')
    expect(persisted?.value.kind === 'dynamic' ? persisted.value.cachedValue : undefined).toBe('旧值')
    const attribute = refreshed?.attributes.find(item => item.name === 'mirror')
    expect(attribute?.value.kind).toBe('dynamic')
    if (attribute?.value.kind !== 'dynamic') throw new Error('missing dynamic attribute')
    expect(attribute.value.cachedValue).toBeUndefined()
    expect(attribute.value.staleReason).toBe('dependency:patch:mem_b')
    expect(attribute.value.lastError).toContain('boom')
  })

  it('给定多属性不同深度当刷新上限为 1 则先刷新直接依赖，远端保持 stale', async () => {
    const store = new FakeDynamicStore(entityOf([
      dynamicAttribute('near', { kind: 'ref', entityId: 'mem_b', attr: 'a' }, { cachedValue: 'near-old', cachedAt: NOW }),
      dynamicAttribute('far', { kind: 'ref', entityId: 'mem_b', attr: 'b' }, { cachedValue: 'far-old', cachedAt: NOW }),
      dynamicAttribute('ttl', { kind: 'ref', entityId: 'mem_b', attr: 'c' }, {
        cachedValue: 'ttl-old',
        cachedAt: '2020-01-01T00:00:00.000Z',
      }),
    ]))
    store.setMark(mark('far', { depth: 1 }))
    store.setMark(mark('near', { depth: 0 }))
    const resolver = new RecordingResolver(async spec => (spec.kind === 'ref' ? spec.attr ?? '' : ''))

    const refreshed = await service(store, resolver).refreshById('mem_c', { max: 1 })

    expect(resolver.specs).toEqual([{ kind: 'ref', entityId: 'mem_b', attr: 'a' }])
    expect(store.clears).toEqual([{ entityId: 'mem_c', attrs: [{ name: 'near', ordinal: 0 }] }])
    const far = refreshed?.attributes.find(item => item.name === 'far')
    expect(far?.value.kind === 'dynamic' ? far.value.cachedValue : undefined).toBeUndefined()
    expect(far?.value.kind === 'dynamic' ? far.value.staleReason : undefined).toBe('dependency:patch:mem_b')
    const ttl = refreshed?.attributes.find(item => item.name === 'ttl')
    // 本轮 max 已用完：TTL 过期走现有惰性路径（下一轮再刷新），不伪造依赖 stale。
    expect(ttl?.value.kind === 'dynamic' ? ttl.value.cachedValue : undefined).toBe('ttl-old')
    expect(ttl?.value.kind === 'dynamic' ? ttl.value.staleReason : undefined).toBeUndefined()
  })

  it('给定依赖刷新解析为空当读取则清空旧缓存并清除标记（“没有值”也是新结果）', async () => {
    const store = new FakeDynamicStore(entityOf([
      dynamicAttribute('mirror', { kind: 'ref', entityId: 'mem_b', attr: 'gone' }, { cachedValue: '旧值', cachedAt: NOW }),
    ]))
    store.setMark(mark('mirror'))
    const resolver = new RecordingResolver(async () => undefined)

    const refreshed = await service(store, resolver).refreshById('mem_c')

    expect(store.clears).toEqual([{ entityId: 'mem_c', attrs: [{ name: 'mirror', ordinal: 0 }] }])
    expect(store.marksOf('mem_c')).toEqual([])
    const persisted = store.entity.attributes.find(item => item.name === 'mirror')
    expect(persisted?.value.kind === 'dynamic' ? persisted.value.cachedValue : undefined).toBeUndefined()
    const attribute = refreshed?.attributes.find(item => item.name === 'mirror')
    expect(attribute?.value.kind === 'dynamic' ? attribute.value.cachedValue : undefined).toBeUndefined()
    expect(attribute?.value.kind === 'dynamic' ? attribute.value.staleReason : undefined).toBeUndefined()
  })

  it('给定没有依赖标记且缓存新鲜当读取则保持现有惰性刷新行为', async () => {
    const store = new FakeDynamicStore(entityOf([
      dynamicAttribute('mirror', { kind: 'ref', entityId: 'mem_b', attr: 'title' }, { cachedValue: '缓存', cachedAt: NOW }),
    ]))
    const resolver = new RecordingResolver(async () => '不会调用')

    const refreshed = await service(store, resolver).refreshById('mem_c')

    expect(resolver.specs).toEqual([])
    expect(store.cacheWrites).toEqual([])
    expect(store.clears).toEqual([])
    const attribute = refreshed?.attributes.find(item => item.name === 'mirror')
    expect(attribute?.value.kind === 'dynamic' ? attribute.value.cachedValue : undefined).toBe('缓存')
  })
})
