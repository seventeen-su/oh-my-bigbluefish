import { describe, expect, it } from 'vitest'
import { DependencyInvalidator, dependencyRefreshKey } from '../../../../packages/v7/src/app/dependency.js'
import {
  DEFAULT_MAX_DEPENDENCY_DEPTH,
  type DependencyAttributeRef,
  type DependencyEdge,
  type DependencyStaleMark,
} from '../../../../packages/v7/src/domain/dependency.js'
import type { DependencyGraph } from '../../../../packages/v7/src/ports/dependency.js'

/**
 * 依赖失效传播（纯 app 层）：用内存假图验证拓扑、级联深度、去重与环。
 * 真实 SQL/事务行为在 `tests/v7/integration/dynamic-dependency.test.ts`。
 */

class FakeGraph implements DependencyGraph {
  readonly edges: DependencyEdge[] = []
  readonly attributes = new Map<string, readonly DependencyAttributeRef[]>()
  readonly marks: DependencyStaleMark[] = []
  readonly queriedTargets: string[][] = []

  async edgesTargeting(targetEntityIds: readonly string[]): Promise<readonly DependencyEdge[]> {
    this.queriedTargets.push([...targetEntityIds])
    return this.edges.filter(edge => targetEntityIds.includes(edge.targetEntityId))
  }

  async dynamicAttributesOf(entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly DependencyAttributeRef[]>> {
    const found = new Map<string, readonly DependencyAttributeRef[]>()
    for (const id of entityIds) {
      const attributes = this.attributes.get(id)
      if (attributes !== undefined) found.set(id, attributes)
    }
    return found
  }

  async markStale(marks: readonly DependencyStaleMark[]): Promise<void> {
    this.marks.push(...marks)
  }
}

const FIXED_TIME = '2026-11-29T00:00:00.000Z'
const clock = { now: () => new Date(FIXED_TIME), iso: () => FIXED_TIME }

function refEdge(source: string, target: string, attr = 'mirror', ordinal = 0): DependencyEdge {
  return {
    sourceEntityId: source,
    sourceAttrName: attr,
    sourceOrdinal: ordinal,
    targetEntityId: target,
    targetAttrName: 'title',
    origin: 'reference',
    relation: '',
  }
}

function linkEdge(source: string, target: string): DependencyEdge {
  return {
    sourceEntityId: source,
    sourceAttrName: '',
    sourceOrdinal: 0,
    targetEntityId: target,
    targetAttrName: '',
    origin: 'link',
    relation: 'related_to',
  }
}

function refAttr(name = 'mirror', ordinal = 0): DependencyAttributeRef {
  return { name, ordinal }
}

function invalidator(graph: FakeGraph): DependencyInvalidator {
  return new DependencyInvalidator(graph, clock)
}

function summaries(marks: readonly DependencyStaleMark[]): string[] {
  return marks
    .map(mark => `${mark.entityId}#${mark.attrName}:${mark.depth}:${mark.reason}`)
    .sort()
}

describe('依赖失效传播拓扑', () => {
  it('给定 B 被 C 与 X 依赖当更新 B 则只标记直接依赖（含 link 的全部动态属性）', async () => {
    const graph = new FakeGraph()
    graph.attributes.set('C', [refAttr('mirror')])
    graph.attributes.set('X', [refAttr('watch'), refAttr('extra', 1)])
    graph.edges.push(refEdge('C', 'B', 'mirror', 0))
    graph.edges.push(linkEdge('X', 'B'))

    const result = await invalidator(graph).invalidate({ rootEntityId: 'B', operation: 'patch' })

    expect(summaries(graph.marks)).toEqual([
      `C#mirror:0:dependency:patch:B`,
      `X#extra:0:dependency:patch:B`,
      `X#watch:0:dependency:patch:B`,
    ])
    expect(result).toMatchObject({ direct: 3, cascaded: 0, truncated: 0, total: 3, maxDepth: DEFAULT_MAX_DEPENDENCY_DEPTH })
    expect(result.markedEntityIds).toEqual(['C', 'X'])
    // B 的依赖方 A（B 引用 A）不在标记范围：失效只沿入边传播。
    expect(graph.marks.some(mark => mark.entityId === 'A')).toBe(false)
  })

  it('给定多跳引用链当更新根节点则按深度级联标记', async () => {
    const graph = new FakeGraph()
    graph.attributes.set('N1', [refAttr('mirror')])
    graph.attributes.set('N2', [refAttr('mirror')])
    graph.attributes.set('N3', [refAttr('mirror')])
    graph.edges.push(refEdge('N1', 'root'), refEdge('N2', 'N1'), refEdge('N3', 'N2'))

    const result = await invalidator(graph).invalidate({ rootEntityId: 'root', operation: 'patch', maxDepth: 4 })

    expect(summaries(graph.marks)).toEqual([
      'N1#mirror:0:dependency:patch:root',
      'N2#mirror:1:dependency:patch:root',
      'N3#mirror:2:dependency:patch:root',
    ])
    expect(result.cascaded).toBe(2)
    // 查询只围绕入边：每层一次，不扫全库。
    expect(graph.queriedTargets).toEqual([['root'], ['N1'], ['N2'], ['N3']])
  })

  it('给定超过最大深度当级联则在下一层标记 depth-limit 后停止', async () => {
    const graph = new FakeGraph()
    for (const id of ['N1', 'N2', 'N3', 'N4', 'N5']) graph.attributes.set(id, [refAttr('mirror')])
    graph.edges.push(
      refEdge('N1', 'root'),
      refEdge('N2', 'N1'),
      refEdge('N3', 'N2'),
      refEdge('N4', 'N3'),
      refEdge('N5', 'N4'),
    )

    const result = await invalidator(graph).invalidate({ rootEntityId: 'root', operation: 'patch', maxDepth: 2 })

    expect(summaries(graph.marks)).toEqual([
      'N1#mirror:0:dependency:patch:root',
      'N2#mirror:1:dependency:patch:root',
      'N3#mirror:2:dependency:patch:root',
      'N4#mirror:3:dependency:patch:root:cascade-depth-exceeded',
    ])
    expect(result).toMatchObject({ direct: 1, cascaded: 2, truncated: 1, total: 4, maxDepth: 2 })
    // 第 5 层不再被标记，也不再查询。
    expect(graph.marks.some(mark => mark.entityId === 'N5')).toBe(false)
    expect(graph.queriedTargets).not.toContainEqual(['N4'])
  })

  it('给定菱形依赖当同一属性被两条路径命中则只落一条标记', async () => {
    const graph = new FakeGraph()
    graph.attributes.set('A', [refAttr('mirror')])
    graph.attributes.set('B', [refAttr('mirror')])
    graph.attributes.set('D', [refAttr('mirror'), refAttr('mirror', 1)])
    graph.edges.push(
      refEdge('A', 'root'),
      refEdge('B', 'root'),
      refEdge('D', 'A'),
      refEdge('D', 'B', 'mirror', 1),
      refEdge('D', 'A'), // 完全重复的边也不能产生第二条标记
    )

    const result = await invalidator(graph).invalidate({ rootEntityId: 'root', operation: 'patch', maxDepth: 4 })

    expect(graph.marks.filter(mark => mark.entityId === 'D')).toHaveLength(2)
    expect(graph.marks.filter(mark => mark.entityId === 'D' && mark.depth === 1)).toHaveLength(2)
    expect(result.cascaded).toBe(2)
    expect(result.total).toBe(4)
  })

  it('给定引用环当传播则 visited 截断，不无限展开', async () => {
    const graph = new FakeGraph()
    graph.attributes.set('A', [refAttr('mirror')])
    graph.attributes.set('B', [refAttr('mirror')])
    graph.edges.push(refEdge('B', 'A'), refEdge('A', 'B'))

    const result = await invalidator(graph).invalidate({ rootEntityId: 'A', operation: 'patch' })

    expect(summaries(graph.marks)).toEqual(['B#mirror:0:dependency:patch:A'])
    expect(result.total).toBe(1)
    expect(graph.queriedTargets).toEqual([['A'], ['B']])
  })

  it('给定引用目标属性已不是动态属性当更新则跳过该属性且不继续级联', async () => {
    const graph = new FakeGraph()
    graph.attributes.set('A', [refAttr('other')])
    graph.attributes.set('B', [refAttr('mirror')])
    graph.edges.push(refEdge('A', 'root', 'gone'), refEdge('B', 'A'))

    const result = await invalidator(graph).invalidate({ rootEntityId: 'root', operation: 'patch' })

    expect(graph.marks).toEqual([])
    expect(result.total).toBe(0)
    // A 没有可失效缓存，它的下游 B 也不会被误标。
    expect(graph.queriedTargets).toEqual([['root']])
  })

  it('给定依赖边被删除当再次更新则不再标记原 source（删除边即解除依赖）', async () => {
    const graph = new FakeGraph()
    graph.attributes.set('A', [refAttr('mirror')])
    graph.edges.push(refEdge('A', 'root'))
    const first = await invalidator(graph).invalidate({ rootEntityId: 'root', operation: 'patch' })
    expect(first.total).toBe(1)

    graph.edges.length = 0
    const second = await invalidator(graph).invalidate({ rootEntityId: 'root', operation: 'patch' })
    expect(second.total).toBe(0)
    expect(graph.marks).toHaveLength(1)
  })

  it('给定 link 边与引用边并存当更新则按来源合并属性标记', async () => {
    const graph = new FakeGraph()
    graph.attributes.set('A', [refAttr('mirror'), refAttr('extra', 1)])
    graph.edges.push(linkEdge('A', 'root'), refEdge('A', 'root', 'mirror', 0))

    await invalidator(graph).invalidate({ rootEntityId: 'root', operation: 'archive' })

    expect(summaries(graph.marks)).toEqual([
      'A#extra:0:dependency:archive:root',
      'A#mirror:0:dependency:archive:root',
    ])
  })
})

describe('依赖刷新去重键', () => {
  it('给定 root 当生成幂等键则同一 root 稳定、不同 root 不冲突', () => {
    expect(dependencyRefreshKey('mem_b')).toBe('refresh:dependency:mem_b')
    expect(dependencyRefreshKey('mem_b')).toBe(dependencyRefreshKey('mem_b'))
    expect(dependencyRefreshKey('mem_c')).not.toBe(dependencyRefreshKey('mem_b'))
  })
})
