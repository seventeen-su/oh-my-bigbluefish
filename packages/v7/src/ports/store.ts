import type {
  Category,
  Entity,
  EntityKind,
  PatchEntityInput,
  Scope,
  StateStatus,
  StateVersion,
} from '../domain/entity.js'
import type { DependencyAttributeRef, DependencyStaleMark } from '../domain/dependency.js'
import type { EvidenceInput } from '../domain/evidence.js'
import type { JsonValue } from '../domain/json.js'
import type { Expansion, Link, LinkInput } from '../domain/link.js'
import type { ProjectIdentity } from '../domain/project-identity.js'
import type { NormalizedWrite } from '../domain/validation.js'
import type {
  ChannelHit,
  EntitySummary,
  StateBoardSpec,
  TextSearchSpec,
  TimeSearchSpec,
  TriggerSearchSpec,
  VectorSearchSpec,
} from './search.js'
import type {
  ArtifactInput,
  ArtifactRecord,
  AuditEntry,
  AuditRecord,
  RecallEventInput,
  ResidentTraceInput,
  RollbackResult,
  StoreStats,
  UsageEvidenceInput,
  UsageEvidenceLevel,
  UsageExposureInput,
} from './observability.js'

/**
 * 写路径端口：`Store` 是 entity/attribute/view/link/chain/audit/outbox 的读入口，
 * 写方法全部委托 `AttributeWriter`（ADR-0007）。
 *
 * 检索通道在 `search.ts`，观测/审计记录在 `observability.ts`；
 * 本文件只保留写命令的入参与结果形状，调用方按需组合，不再面对一个 26 导出的宽契约。
 */

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
  /**
   * 没有产生新实体时的复用原因：
   * - `command`：同一 commandId 已执行过（工具调用重试）；
   * - `content`：同 scope/category/关键属性/时间的内容已存在（新证据已并入原实体）。
   */
  readonly deduped?: 'command' | 'content'
}

export interface PatchResult {
  readonly entity: Entity
  readonly history?: StateVersion
  /** 同一 commandId 已执行过时返回首次结果，不重复 bump revision。 */
  readonly deduped?: 'command'
}

/**
 * 写命令的可选幂等/证据参数（`Store.write/patch` 用）：
 * - `commandId`：工具调用/重试的稳定幂等键；缺省合成一次性 UUID；
 * - `evidence`：本次写入的来源证据；写事务内落证据账本，内容去重时并入原实体。
 */
export interface WriteOptions {
  readonly commandId?: string
  readonly correlationId?: string
  readonly evidence?: readonly EvidenceInput[]
  readonly actor?: string
  readonly source?: string
}

export interface ReadOptions {
  readonly includeArchived?: boolean
  readonly includeHistory?: boolean
}

export interface LinkResult {
  readonly link: Link
  readonly created: boolean
}

/**
 * 一次写入的执行上下文（乐观锁之外的身份信息）。
 *
 * - `actor`：真正执行写入的实体（user/model/job:extract/system:refresh），写进
 *   `audit_log.actor`/`actor_kind`；
 * - `source`：授权/来源（user/model/job:extract/system:refresh），写进 `audit_log.source`，
 *   与实体自身的 `origin` 分开：后台刷新可以 actor=system、source=system:refresh，而
 *   `entity.origin` 仍保留为 `job`（检索先验据此降权）。
 *
 * `expectedRevision` 不在这里：更新必须显式带在 `PatchEntityInput` 上，适配器对缺失直接
 * 拒绝，不提供“默认无条件覆盖”的兼容路径。
 */
export interface WriteContext {
  readonly actor?: string
  readonly source?: string
}

export interface Store {
  write(input: NormalizedWrite, derived: DerivedWrite, options?: WriteOptions): Promise<WriteResult>
  get(id: string, options?: ReadOptions): Promise<Entity | undefined>
  /** `patch.expectedRevision` 必填；缺失由适配器拒绝（invalid-input）。 */
  patch(input: NormalizedWrite, patch: PatchEntityInput, derived: DerivedWrite, options?: WriteOptions): Promise<PatchResult>
  /**
   * 归档。`expectedRevision` 用于自动归档/遗忘的 CAS：调用方用选择时读到的版本，
   * 新更新先提交时归档失败而不是把新状态归档。缺省只用于人工显式归档。
   */
  archive(id: string, reason: string, actor: string, expectedRevision?: number): Promise<void>
  unarchive(id: string, reason: string, actor: string, expectedRevision?: number): Promise<void>
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
  /** 正文变化后先删旧向量，避免重建完成前检索到过期语义。 */
  deleteEmbedding(entityId: string): Promise<void>
  setAttributeCache(
    entityId: string,
    name: string,
    ordinal: number,
    value: JsonValue | undefined,
    cachedAt: string,
    error?: string,
  ): Promise<void>
  /**
   * 依赖失效标记：上游实体 write/patch/archive 时在同一事务里落 `omb.dynamic_stale`，
   * 动态属性读取必须消费它（不能只看 `stale_after_ms`）。空数组表示没有待刷新依赖。
   */
  dependencyMarks(entityId: string): Promise<readonly DependencyStaleMark[]>
  /** 某个依赖标记刷新成功后清除；`attrs` 省略表示清掉该实体全部标记。 */
  clearDependencyMarks(entityId: string, attrs?: readonly DependencyAttributeRef[]): Promise<void>
  rebuildView(id: string): Promise<void>
  recordRecall(events: readonly RecallEventInput[]): Promise<void>
  /** T1 真正投递后把该 trace 的候选从 injected=false 置为 true（不提前记账）。 */
  markRecallInjected?(traceId: string): Promise<void>
  /** 记录一次 T0 常驻构建（预算、段落、裁剪），不参与 adopted 统计。 */
  recordResidentTrace(trace: ResidentTraceInput): Promise<void>
  /** 检索命中即记一次访问；旧 fake 可不实现。 */
  markAccessed?(ids: readonly string[]): Promise<void>
  /** 按静态属性值查活跃实体；后台收敛（goalId/taskId/自动分组键）使用。 */
  findByAttribute?(name: string, value: JsonValue, kind?: EntityKind): Promise<string | undefined>
  /**
   * 记录一次曝光：同一 `(entityId, sessionId, taskId)` 只创建一个使用机会，
   * 重复曝光只增加机会内的 exposures 计数；不增加任何显著度。
   */
  recordExposure(input: UsageExposureInput): Promise<void>
  /**
   * 记录一条引用/使用/验证/证伪证据。机会级状态只升级一次；指标按机会计数，
   * 因此同一任务里多次引用/验证不会重复累计成功次数。
   */
  recordUsage(level: UsageEvidenceLevel, input: UsageEvidenceInput): Promise<void>
  /**
   * 旧口径：字符串命中直接记 adopted。仅为历史调用方/数据播种保留，
   * 插件采用链不再调用；重排与遗忘也不读它。
   */
  markAdopted(traceId: string, entityId: string, kind: string): Promise<void>
  listAudit(limit: number, targetId?: string): Promise<AuditRecord[]>
  /**
   * 追加一条运维审计（自动刷新/遗忘的 skipped/conflict）。不改业务行、不 bump revision；
   * 可选：内存 fake 或只读场景可以不实现，调用方必须允许“审计降级但业务不失败”。
   */
  recordAudit?(entry: AuditEntry): Promise<number>
  rollback(auditId: number, actor: string): Promise<RollbackResult>
  recordArtifact(input: ArtifactInput): Promise<void>
  listArtifacts(limit: number, options?: { readonly id?: string }): Promise<ArtifactRecord[]>
  markArtifactProcessed(id: string): Promise<void>
  /**
   * 登记项目身份映射（旧 fake 可不实现）。每个 workspace 一行：legacy_keys 取并集，
   * 让迁移前的旧 projectKey（路径）仍能被新 projectId 命中。
   */
  recordProjectIdentity?(identity: ProjectIdentity): Promise<void>
  /**
   * 按 projectId 取最近工作区的路径锚点。`projectId` 不是路径，动态文件属性的
   * path-guard 需要它（后台 refresh 没有调用方传入 projectRoot）。旧 fake 可不实现。
   */
  projectRootOf?(projectId: string): Promise<string | undefined>
  stats(): Promise<StoreStats>
}
