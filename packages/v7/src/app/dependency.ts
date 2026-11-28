import type {
  DependencyAttributeRef,
  DependencyEdge,
  DependencyOperation,
  DependencyStaleMark,
} from '../domain/dependency.js'
import {
  DEFAULT_MAX_DEPENDENCY_DEPTH,
  dependencyMarkKey,
  dependencyStaleReason,
  dependencyTruncatedReason,
  isTruncatedMark,
} from '../domain/dependency.js'
import type { Clock } from '../ports/clock.js'
import type { DependencyGraph } from '../ports/dependency.js'

/**
 * 引用依赖失效传播（app 层）：写事务里调用，只沿 `target_entity_id` 入边做有界 BFS。
 *
 * 规则：
 * 1. 直接依赖 depth=0；每沿一条入边 +1，超过 `maxDepth` 的下一层只标记、不再展开，
 *    原因带 `cascade-depth-exceeded`（不允许留下“旧值可用且无标记”的静默状态）。
 * 2. 标记按 `(entityId, attrName, ordinal)` 去重；同一条边/同名属性被多条路径命中只落一行。
 * 3. 没有动态属性的 source 不会产生标记，也不会继续作为下一层入口：它的值没有变化。
 * 4. 环（A↔B）由 visited 集合截断，不靠深度兜底。
 */
export interface DependencyInvalidationOptions {
  readonly rootEntityId: string
  readonly operation: DependencyOperation
  /** 覆盖默认最大深度；0 表示只标记直接依赖。 */
  readonly maxDepth?: number
}

export interface DependencyInvalidationResult {
  readonly direct: number
  readonly cascaded: number
  readonly truncated: number
  readonly total: number
  readonly maxDepth: number
  /** 被标记的实体（去重、排序）；事件 reaction 只用 root，不依赖这个列表。 */
  readonly markedEntityIds: readonly string[]
}

/** 依赖刷新任务的 pg-boss 幂等键：同一 root 的多次更新合并成一个待跑任务。 */
export function dependencyRefreshKey(rootEntityId: string): string {
  return `refresh:dependency:${rootEntityId}`
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isFinite(depth)) return DEFAULT_MAX_DEPENDENCY_DEPTH
  return Math.max(0, Math.min(32, Math.trunc(depth)))
}

function uniqueSources(edges: readonly DependencyEdge[], visited: ReadonlySet<string>): string[] {
  const sources = new Set<string>()
  for (const edge of edges) {
    if (visited.has(edge.sourceEntityId)) continue
    sources.add(edge.sourceEntityId)
  }
  return [...sources].sort()
}

export class DependencyInvalidator {
  constructor(
    private readonly graph: DependencyGraph,
    private readonly clock: Clock,
  ) {}

  async invalidate(options: DependencyInvalidationOptions): Promise<DependencyInvalidationResult> {
    const maxDepth = normalizeDepth(options.maxDepth)
    const markedAt = this.clock.iso()
    const planned = new Map<string, DependencyStaleMark>()
    const visited = new Set<string>([options.rootEntityId])
    let frontier: readonly string[] = [options.rootEntityId]
    let depth = 0

    while (frontier.length > 0) {
      const edges = await this.graph.edgesTargeting(frontier)
      const sources = uniqueSources(edges, visited)
      if (sources.length === 0) break
      const attributes = await this.graph.dynamicAttributesOf(sources)
      const markedSources = planLevel(planned, {
        edges,
        attributes,
        sources,
        depth,
        operation: options.operation,
        rootEntityId: options.rootEntityId,
        markedAt,
        truncated: false,
      })
      for (const source of sources) visited.add(source)
      // 没有动态属性的 source 没有缓存可失效，也没有必要继续沿它的入边展开。
      if (markedSources.length === 0) break
      if (depth >= maxDepth) {
        const beyondEdges = await this.graph.edgesTargeting(markedSources)
        const beyondSources = uniqueSources(beyondEdges, visited)
        if (beyondSources.length > 0) {
          const beyondAttributes = await this.graph.dynamicAttributesOf(beyondSources)
          planLevel(planned, {
            edges: beyondEdges,
            attributes: beyondAttributes,
            sources: beyondSources,
            depth: depth + 1,
            operation: options.operation,
            rootEntityId: options.rootEntityId,
            markedAt,
            truncated: true,
          })
        }
        break
      }
      frontier = markedSources
      depth += 1
    }

    const marks = [...planned.values()]
    if (marks.length > 0) await this.graph.markStale(marks)
    let direct = 0
    let cascaded = 0
    let truncated = 0
    const entityIds = new Set<string>()
    for (const mark of marks) {
      entityIds.add(mark.entityId)
      if (isTruncatedMark(mark)) truncated += 1
      else if (mark.depth === 0) direct += 1
      else cascaded += 1
    }
    return {
      direct,
      cascaded,
      truncated,
      total: marks.length,
      maxDepth,
      markedEntityIds: [...entityIds].sort(),
    }
  }
}

interface LevelInput {
  readonly edges: readonly DependencyEdge[]
  readonly attributes: ReadonlyMap<string, readonly DependencyAttributeRef[]>
  readonly sources: readonly string[]
  readonly depth: number
  readonly operation: DependencyOperation
  readonly rootEntityId: string
  readonly markedAt: string
  readonly truncated: boolean
}

/**
 * 计划一层的标记：reference 边只标记 spec 指向的具体属性；link 边标记 source 的全部
 * 动态属性。返回真正产生标记的 source（下一层只从这里继续）。
 */
function planLevel(
  planned: Map<string, DependencyStaleMark>,
  input: LevelInput,
): string[] {
  const sourceSet = new Set(input.sources)
  const marked = new Set<string>()
  const reason = input.truncated
    ? dependencyTruncatedReason(input.operation, input.rootEntityId)
    : dependencyStaleReason(input.operation, input.rootEntityId)
  for (const edge of input.edges) {
    if (!sourceSet.has(edge.sourceEntityId)) continue
    const declared = input.attributes.get(edge.sourceEntityId) ?? []
    const candidates = edge.sourceAttrName.length === 0
      ? declared
      : declared.filter(attribute => attribute.name === edge.sourceAttrName && attribute.ordinal === edge.sourceOrdinal)
    for (const attribute of candidates) {
      const key = dependencyMarkKey(edge.sourceEntityId, attribute.name, attribute.ordinal)
      if (planned.has(key)) continue
      planned.set(key, {
        entityId: edge.sourceEntityId,
        attrName: attribute.name,
        ordinal: attribute.ordinal,
        depth: input.depth,
        reason,
        rootEntityId: input.rootEntityId,
        operation: input.operation,
        markedAt: input.markedAt,
      })
      marked.add(edge.sourceEntityId)
    }
  }
  return [...marked].sort()
}
