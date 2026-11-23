import type {
  Category,
  Entity,
  EntityKind,
  PatchEntityInput,
  Scope,
  StateStatus,
  StateVersion,
  WriteEntityInput,
} from '../domain/entity.js'
import type { JsonValue } from '../domain/json.js'
import type { Expansion, Link, LinkInput } from '../domain/link.js'
import type { NormalizedWrite } from '../domain/validation.js'

export interface ReferenceInput {
  readonly sourceAttrName: string
  readonly sourceOrdinal: number
  readonly targetEntityId: string
  readonly targetAttrName?: string
  readonly kind: 'ref' | 'template' | 'code'
}

export interface DerivedWrite {
  readonly searchText: string
  readonly triggers: readonly { readonly kind: string; readonly key: string; readonly weight: number }[]
  readonly references?: readonly ReferenceInput[]
}

export interface SimilarAttribute {
  readonly name: string
  readonly usageCount: number
  readonly similarity: number
}

export interface SimilarEntity {
  readonly id: string
  readonly kind: EntityKind
  readonly title?: string
  readonly category?: Category
  readonly status?: StateStatus
  readonly scope: Scope
  readonly archived: boolean
  readonly score: number
  readonly reason: string
}

export interface WriteResult {
  readonly entity: Entity
  readonly similarAttributes: readonly SimilarAttribute[]
  readonly similarEntities: readonly SimilarEntity[]
  readonly archivedMatches: readonly SimilarEntity[]
}

export interface PatchResult {
  readonly entity: Entity
  readonly history?: StateVersion
}

export interface ReadOptions {
  readonly includeArchived?: boolean
  readonly includeHistory?: boolean
}

export interface LinkResult {
  readonly link: Link
  readonly created: boolean
}

export interface SearchBase {
  readonly scope?: 'global' | 'project'
  readonly projectKey?: string
  readonly kind?: EntityKind
  readonly category?: Category
  readonly status?: readonly StateStatus[]
  readonly includeArchived?: boolean
  readonly includeHistory?: boolean
  readonly limit: number
}

export interface TextSearchSpec extends SearchBase {
  readonly query: string
  readonly tokens: readonly string[]
}

export interface TriggerSearchSpec extends SearchBase {
  readonly keys: readonly string[]
  readonly regexText?: string
}

export interface VectorSearchSpec extends SearchBase {
  readonly embedding: readonly number[]
}

export interface TimeSearchSpec extends SearchBase {
  readonly from: string
  readonly to: string
  readonly now: string
}

export interface StateBoardSpec extends SearchBase {
  readonly now: string
}

export interface ChannelHit {
  readonly entityId: string
  readonly rank: number
  readonly rawScore: number
  readonly channel: string
  readonly meta?: Record<string, JsonValue>
}

export interface EntitySummary {
  readonly id: string
  readonly kind: EntityKind
  readonly title?: string
  readonly category?: Category
  readonly status?: StateStatus
  readonly scope: Scope
  readonly snippet: string
  readonly archived: boolean
  readonly isCurrent: boolean
  /** 实体事件时间（ISO 8601）；只有带 time 属性的实体（状态机等）才有，缺省表示未知。 */
  readonly eventTime?: string
  readonly updatedAt: string
  readonly historyCount: number
  readonly score?: number
}

export interface RecallEventInput {
  readonly traceId: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly query?: string
  readonly trigger?: string
  readonly entityId: string
  readonly channel: string
  readonly rank: number
  readonly rawScore?: number
  readonly fusedScore?: number
  readonly injected: boolean
}

/** T0 常驻注入的一段候选；kept=false 表示因预算被裁掉。 */
export interface ResidentTraceSection {
  readonly name: string
  readonly tokens: number
  readonly kept: boolean
  readonly text: string
  readonly entityIds: readonly string[]
}

/** 一次 T0 常驻构建的完整 trace；用于证明注入预算与裁剪真实发生。 */
export interface ResidentTraceInput {
  readonly traceId: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly budgetTokens: number
  readonly usedTokens: number
  readonly text: string
  readonly sections: readonly ResidentTraceSection[]
  readonly droppedSections: readonly string[]
}

export interface AuditEntry {
  readonly actor: string
  readonly action: string
  readonly targetIds?: readonly string[]
  readonly before?: JsonValue
  readonly after?: JsonValue
  readonly inverse?: JsonValue
  readonly jobId?: string
}

export interface AuditRecord {
  readonly id: number
  readonly actor: string
  readonly action: string
  readonly targetIds: readonly string[]
  readonly inverse?: JsonValue
  readonly createdAt: string
  readonly rolledBackAt?: string
}

export interface RollbackResult {
  readonly auditId: number
  readonly rollbackAuditId: number
  readonly applied: readonly string[]
}

export interface ArtifactInput {
  readonly id: string
  readonly sessionId?: string
  readonly kind: string
  readonly content: string
  readonly source?: string
  readonly metadata?: JsonValue
}

export interface ArtifactRecord {
  readonly id: string
  readonly sessionId?: string
  readonly kind: string
  readonly content: string
  readonly source: string
  readonly metadata: JsonValue
  readonly createdAt: string
}

export interface StoreStats {
  readonly memory: number
  readonly state: number
  readonly chain: number
  readonly archived: number
  readonly attrNames: readonly string[]
  readonly categories?: Readonly<Record<'fact' | 'clue' | 'event', number>>
  readonly scopes?: Readonly<{ global: number; project: number }>
  readonly recentStates?: readonly { id: string; title?: string; status: string }[]
}

export interface Store {
  write(input: NormalizedWrite, derived: DerivedWrite): Promise<WriteResult>
  get(id: string, options?: ReadOptions): Promise<Entity | undefined>
  patch(input: NormalizedWrite, patch: PatchEntityInput, derived: DerivedWrite): Promise<PatchResult>
  archive(id: string, reason: string, actor: string): Promise<void>
  unarchive(id: string, reason: string, actor: string): Promise<void>
  link(input: LinkInput): Promise<LinkResult>
  unlink(id: string, actor: string): Promise<void>
  history(stateId: string, limit: number): Promise<StateVersion[]>
  expand(seeds: readonly string[], hops: 1 | 2, options?: { includeArchived?: boolean }): Promise<Expansion[]>
  fulltext(spec: TextSearchSpec): Promise<ChannelHit[]>
  triggers(spec: TriggerSearchSpec): Promise<ChannelHit[]>
  singleChar(spec: TextSearchSpec): Promise<ChannelHit[]>
  vector(spec: VectorSearchSpec): Promise<ChannelHit[]>
  time(spec: TimeSearchSpec): Promise<ChannelHit[]>
  stateBoard(spec: StateBoardSpec): Promise<ChannelHit[]>
  summaries(ids: readonly string[]): Promise<EntitySummary[]>
  /** T0 偏好：全局、标签=偏好、未归档，按显著度排序。 */
  preferenceSummaries?(limit: number): Promise<EntitySummary[]>
  upsertEmbedding(entityId: string, model: string, dims: number, embedding: readonly number[]): Promise<void>
  setAttributeCache(
    entityId: string,
    name: string,
    ordinal: number,
    value: JsonValue | undefined,
    cachedAt: string,
    error?: string,
  ): Promise<void>
  rebuildView(id: string): Promise<void>
  recordRecall(events: readonly RecallEventInput[]): Promise<void>
  /** 记录一次 T0 常驻构建（预算、段落、裁剪），不参与 adopted 统计。 */
  recordResidentTrace(trace: ResidentTraceInput): Promise<void>
  /** 检索命中即记一次访问；旧 fake 可不实现。 */
  markAccessed?(ids: readonly string[]): Promise<void>
  /** 按静态属性值查活跃实体；后台收敛（goalId/taskId/自动分组键）使用。 */
  findByAttribute?(name: string, value: JsonValue, kind?: EntityKind): Promise<string | undefined>
  markAdopted(traceId: string, entityId: string, kind: string): Promise<void>
  listAudit(limit: number, targetId?: string): Promise<AuditRecord[]>
  rollback(auditId: number, actor: string): Promise<RollbackResult>
  recordArtifact(input: ArtifactInput): Promise<void>
  listArtifacts(limit: number): Promise<ArtifactRecord[]>
  markArtifactProcessed(id: string): Promise<void>
  stats(): Promise<StoreStats>
}

export type StoreWriteInput = WriteEntityInput
