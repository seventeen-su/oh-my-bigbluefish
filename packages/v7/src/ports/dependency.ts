import type {
  DependencyAttributeRef,
  DependencyEdge,
  DependencyStaleMark,
} from '../domain/dependency.js'

/**
 * 依赖图的读写端口（app 层实现级联算法，adapter 只做按 target 的索引查询与批量标记）。
 *
 * `edgesTargeting` 必须走 `target_entity_id` 入边索引，**不能扫全表**；
 * `dynamicAttributesOf` 只按给定实体批量读属性行。
 */
export interface DependencyGraph {
  edgesTargeting(targetEntityIds: readonly string[]): Promise<readonly DependencyEdge[]>
  dynamicAttributesOf(entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly DependencyAttributeRef[]>>
  markStale(marks: readonly DependencyStaleMark[]): Promise<void>
}

/** 待刷新目标：按 depth（直接优先）、markedAt（陈旧优先）、最近访问排序后的实体。 */
export interface DependencyStaleTarget {
  readonly entityId: string
  readonly depth: number
  readonly markedAt: string
}
