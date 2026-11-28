/**
 * 引用依赖失效的领域形状（不依赖 IO）。
 *
 * 一条依赖边表示 **source 依赖 target**：target 的属性/正文/归档变化会让 source 的
 * 动态属性缓存失效。箭头方向因此与「失效传播方向」相反：
 *   - 引用边：source 动态属性里的 ref/template/code 指向 target；
 *   - link 边：source = link.from_id，target = link.to_id（无向链接额外补反向边）。
 *
 * 只标记**直接依赖**是 O(入边) 的；级联沿入边继续走，最大深度由
 * `DEFAULT_MAX_DEPENDENCY_DEPTH` 控制，超过深度的下一层仍会被标记为
 * `cascade-depth-exceeded`（避免静默使用旧值），但不再继续遍历。
 */

export type DependencyOrigin = 'reference' | 'link'

/** 写事务里触发失效的操作；写进 stale 原因，便于运维定位。 */
export type DependencyOperation = 'patch' | 'archive' | 'unarchive'

/** 动态属性的精确定位：同名属性可有多个 ordinal。 */
export interface DependencyAttributeRef {
  readonly name: string
  readonly ordinal: number
}

/** 一条依赖边：`source` 的某个动态属性（或全部动态属性）依赖 `target`。 */
export interface DependencyEdge {
  readonly sourceEntityId: string
  /** 空串表示 link 边：source 的全部动态属性都依赖 target。 */
  readonly sourceAttrName: string
  readonly sourceOrdinal: number
  readonly targetEntityId: string
  readonly targetAttrName: string
  readonly origin: DependencyOrigin
  /** link 的 relation；引用边为空串。 */
  readonly relation: string
}

/** 待刷新的一条依赖失效标记（`omb.dynamic_stale` 的一行）。 */
export interface DependencyStaleMark {
  readonly entityId: string
  readonly attrName: string
  readonly ordinal: number
  /** 0 = 直接依赖；越大越远。 */
  readonly depth: number
  readonly reason: string
  readonly rootEntityId: string
  readonly operation: DependencyOperation
  readonly markedAt: string
}

/** 默认最大级联深度（直接依赖为 0）。可用调用参数覆盖，但必须是常量级的小整数。 */
export const DEFAULT_MAX_DEPENDENCY_DEPTH = 4

/** 超过最大深度的下一层仍标记，但原因里带这个后缀并停止遍历。 */
export const DEPENDENCY_TRUNCATED = 'cascade-depth-exceeded'

export function dependencyMarkKey(entityId: string, attrName: string, ordinal: number): string {
  return `${entityId}\u0000${attrName}\u0000${ordinal}`
}

export function dependencyStaleReason(operation: DependencyOperation, rootEntityId: string): string {
  return `dependency:${operation}:${rootEntityId}`
}

export function dependencyTruncatedReason(operation: DependencyOperation, rootEntityId: string): string {
  return `${dependencyStaleReason(operation, rootEntityId)}:${DEPENDENCY_TRUNCATED}`
}

export function isTruncatedMark(mark: DependencyStaleMark): boolean {
  return mark.reason.endsWith(`:${DEPENDENCY_TRUNCATED}`)
}
