import type { Category, EntityKind, StateStatus } from '../domain/entity.js'
import type { EvidenceRecord } from '../domain/evidence.js'
import type { JsonValue } from '../domain/json.js'
import type { DependencyStaleTarget } from './dependency.js'

export interface RecentEntity {
  readonly id: string
  readonly kind: EntityKind
  readonly category?: Category
  readonly status?: StateStatus
  readonly title?: string
  readonly snippet: string
  readonly attrs: Record<string, JsonValue>
  readonly origin: string
  readonly confidence?: number
  readonly pinned: boolean
  readonly salience: number
  readonly adoptionCount: number
  readonly accessCount: number
  readonly updatedAt: string
}

export interface CoRecallPair {
  readonly a: string
  readonly b: string
  readonly count: number
}

export interface Forgettable {
  readonly id: string
  readonly salience: number
  readonly category?: Category
  readonly pinned: boolean
  readonly updatedAt: string
  /** 选择时的 revision：归档必须用它做 CAS，不能把之后的新状态归档。 */
  readonly revision: number
}

export interface AttrAliasCandidate {
  readonly name: string
  readonly alias: string
  readonly similarity: number
  readonly usage: number
}

export interface BrokenReference {
  readonly sourceId: string
  readonly sourceAttr: string
  readonly sourceOrdinal: number
  readonly targetId: string
  readonly targetAttr: string
  readonly kind: string
}

/** 实体当前内容指纹 + 证据账本；晋升只统计 `contentHash` 相同的证据。 */
export interface EntityEvidence {
  readonly contentHash?: string
  readonly evidence: readonly EvidenceRecord[]
}

export interface MaintenanceQueries {
  staleDynamic(limit: number): Promise<string[]>
  /** 某次写入（root）的依赖失效目标：直接依赖优先、陈旧优先、最近访问优先。 */
  dependencyTargets(rootEntityId: string, limit: number): Promise<readonly DependencyStaleTarget[]>
  missingEmbeddings(limit: number): Promise<string[]>
  recent(limit: number): Promise<RecentEntity[]>
  coRecallPairs(limit: number): Promise<CoRecallPair[]>
  forgettable(limit: number, threshold: number): Promise<Forgettable[]>
  attrAliasCandidates(limit: number): Promise<AttrAliasCandidate[]>
  brokenReferences(limit: number): Promise<BrokenReference[]>
  /** 事件驱动的定向引用腐化：只查指向该实体属性的引用（target = 被改实体）。 */
  brokenReferencesForTarget(entityId: string, limit: number): Promise<BrokenReference[]>
  /** 线索晋升前先检查它自己的动态引用是否已腐化（source = 线索实体）。 */
  brokenReferencesForSource(entityId: string, limit: number): Promise<BrokenReference[]>
  conflictSuppressed(a: string, b: string): Promise<boolean>
  renameAttribute(from: string, to: string): Promise<string[]>
  /** 实体证据账本（含当前 content_key）；线索晋升/审计使用。 */
  evidenceFor(entityId: string): Promise<EntityEvidence>
}
