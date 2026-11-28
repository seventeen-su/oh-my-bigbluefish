import type { Entity, EntityKind, StateVersion } from '../../../../packages/v7/src/domain/entity.js'
import type { DependencyAttributeRef, DependencyStaleMark } from '../../../../packages/v7/src/domain/dependency.js'
import { attributeValue } from '../../../../packages/v7/src/domain/entity-access.js'
import type { JsonValue } from '../../../../packages/v7/src/domain/json.js'
import type { Expansion, LinkInput } from '../../../../packages/v7/src/domain/link.js'
import type { NormalizedWrite } from '../../../../packages/v7/src/domain/validation.js'
import type { Clock } from '../../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../../packages/v7/src/ports/embedding.js'
import type {
  DerivedWrite,
  LinkResult,
  PatchResult,
  ReadOptions,
  Store,
  WriteResult,
} from '../../../../packages/v7/src/ports/store.js'
import type {
  ArtifactInput,
  ArtifactRecord,
  AuditRecord,
  RecallEventInput,
  ResidentTraceInput,
  RollbackResult,
  UsageEvidenceInput,
  UsageEvidenceLevel,
  UsageExposureInput,
} from '../../../../packages/v7/src/ports/observability.js'
import type {
  ChannelHit,
  EntityPriorFeatures,
  EntitySummary,
  StateBoardSpec,
  TextSearchSpec,
  TimeSearchSpec,
  TriggerSearchSpec,
  VectorSearchSpec,
} from '../../../../packages/v7/src/ports/search.js'
import type { PatchEntityInput } from '../../../../packages/v7/src/domain/entity.js'
import type {
  RetractInput,
  RetractResult,
  SupersedeInput,
  SupersedeResult,
} from '../../../../packages/v7/src/domain/lifecycle.js'
import type { StageOneChannel } from '../../../../packages/v7/src/retrieval/types.js'
import { RecallEngine } from '../../../../packages/v7/src/retrieval/engine.js'
import type { RetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'

export const FIXED_NOW = '2026-11-22T00:00:00.000Z'

export function hit(entityId: string, rank: number, rawScore: number, channel: StageOneChannel): ChannelHit {
  return { entityId, rank, rawScore, channel }
}

export function summary(overrides: Partial<EntitySummary> & { id: string }): EntitySummary {
  return {
    kind: 'memory',
    snippet: '',
    scope: { kind: 'global' },
    archived: false,
    isCurrent: true,
    lifecycle: 'active',
    updatedAt: FIXED_NOW,
    historyCount: 0,
    ...overrides,
  }
}

export interface FakeEntityInput {
  readonly id: string
  readonly kind?: EntityKind
  readonly title?: string
  readonly group?: readonly string[]
  readonly tags?: readonly string[]
  readonly confidence?: number
  readonly origin?: string
  readonly pinned?: boolean
  readonly accessCount?: number
  readonly adoptionCount?: number
  readonly utilityConfidence?: number
  readonly refutationRate?: number
}

export function entity(input: FakeEntityInput): Entity {
  const attributes: Entity['attributes'][number][] = []
  const push = (name: string, value: JsonValue): void => {
    attributes.push({
      name,
      ordinal: attributes.length,
      value: { kind: 'static', value },
      required: false,
      source: 'fake',
    })
  }
  if (input.title !== undefined) push('title', input.title)
  if (input.group !== undefined) push('group', [...input.group])
  if (input.tags !== undefined) push('标签', [...input.tags])
  return {
    id: input.id,
    kind: input.kind ?? 'memory',
    revision: 1,
    origin: input.origin ?? 'user',
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    pinned: input.pinned ?? false,
    salience: 0,
    accessCount: input.accessCount ?? 0,
    adoptionCount: input.adoptionCount ?? 0,
    ...(input.utilityConfidence === undefined ? {} : { utilityConfidence: input.utilityConfidence }),
    ...(input.refutationRate === undefined ? {} : { refutationRate: input.refutationRate }),
    isCurrent: true,
    lifecycle: 'active',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    attributes,
  }
}

/**
 * 实体 → 精排富化特征：与 `PostgresStore.priorFeatures` 的字段语义一致
 * （标签从 `标签`/`tags`/`tag` 属性拍平），让单元测试能覆盖精排而不必连库。
 */
export function featuresOf(item: Entity): EntityPriorFeatures {
  const tags: string[] = []
  for (const name of ['标签', 'tags', 'tag']) {
    const value = attributeValue(item, name)
    if (typeof value === 'string' && value.trim().length > 0) tags.push(value)
    if (Array.isArray(value)) tags.push(...value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))
    if (tags.length > 0) break
  }
  return {
    entityId: item.id,
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    pinned: item.pinned,
    origin: item.origin,
    accessCount: item.accessCount,
    adoptionCount: item.adoptionCount,
    ...(tags.length === 0 ? {} : { tags }),
  }
}

export function expansion(input: {
  readonly entityId: string
  readonly fromId: string
  readonly hop?: number
  readonly score?: number
  readonly viaLinkId?: string
  readonly relation?: string
  readonly chainId?: string
}): Expansion {
  return {
    entityId: input.entityId,
    hop: input.hop ?? 1,
    score: input.score ?? 0.5,
    viaLinkId: input.viaLinkId ?? `link-${input.entityId}`,
    fromId: input.fromId,
    relation: input.relation ?? 'related',
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
  }
}

/** 内存假 Store：只实现检索引擎用到的读取面，写入面显式抛错防止误用。 */
export class FakeStore implements Store {
  readonly channelHits: Record<StageOneChannel, ChannelHit[]> = {
    trigger: [],
    fulltext: [],
    single_char: [],
    vector: [],
    time: [],
    state_board: [],
  }

  readonly failures: Partial<Record<StageOneChannel, Error>> = {}
  readonly calls = {
    trigger: [] as TriggerSearchSpec[],
    fulltext: [] as TextSearchSpec[],
    single_char: [] as TextSearchSpec[],
    vector: [] as VectorSearchSpec[],
    time: [] as TimeSearchSpec[],
    state_board: [] as StateBoardSpec[],
  }

  expansions: Expansion[] = []
  expandError?: Error
  readonly expandCalls: { seeds: readonly string[]; hops: 1 | 2 }[] = []

  readonly summariesById = new Map<string, EntitySummary>()
  summariesError?: Error
  readonly summaryCalls: string[][] = []

  /** 精排富化：优先用显式夹具，其次从 `entitiesById` 推导；每次调用记录 ids 便于断言“只打一次”。 */
  readonly priorFeaturesById = new Map<string, EntityPriorFeatures>()
  readonly priorFeaturesCalls: string[][] = []
  priorFeaturesError?: Error

  readonly entitiesById = new Map<string, Entity>()
  readonly entityErrors = new Map<string, Error>()
  readonly getCalls: string[] = []

  readonly recallEvents: RecallEventInput[] = []
  recallError?: Error

  readonly artifacts: ArtifactRecord[] = []
  readonly processedArtifacts = new Set<string>()

  private maybeThrow(channel: StageOneChannel): void {
    const failure = this.failures[channel]
    if (failure !== undefined) throw failure
  }

  async get(id: string, _options?: ReadOptions): Promise<Entity | undefined> {
    this.getCalls.push(id)
    const failure = this.entityErrors.get(id)
    if (failure !== undefined) throw failure
    return this.entitiesById.get(id)
  }

  async expand(seeds: readonly string[], hops: 1 | 2, _options?: { includeArchived?: boolean }): Promise<Expansion[]> {
    this.expandCalls.push({ seeds: [...seeds], hops })
    if (this.expandError !== undefined) throw this.expandError
    return this.expansions
  }

  async fulltext(spec: TextSearchSpec): Promise<ChannelHit[]> {
    this.calls.fulltext.push(spec)
    this.maybeThrow('fulltext')
    return this.channelHits.fulltext
  }

  async triggers(spec: TriggerSearchSpec): Promise<ChannelHit[]> {
    this.calls.trigger.push(spec)
    this.maybeThrow('trigger')
    return this.channelHits.trigger
  }

  async singleChar(spec: TextSearchSpec): Promise<ChannelHit[]> {
    this.calls.single_char.push(spec)
    this.maybeThrow('single_char')
    return this.channelHits.single_char
  }

  async vector(spec: VectorSearchSpec): Promise<ChannelHit[]> {
    this.calls.vector.push(spec)
    this.maybeThrow('vector')
    return this.channelHits.vector
  }

  async time(spec: TimeSearchSpec): Promise<ChannelHit[]> {
    this.calls.time.push(spec)
    this.maybeThrow('time')
    return this.channelHits.time
  }

  async stateBoard(spec: StateBoardSpec): Promise<ChannelHit[]> {
    this.calls.state_board.push(spec)
    this.maybeThrow('state_board')
    return this.channelHits.state_board
  }

  async summaries(ids: readonly string[]): Promise<EntitySummary[]> {
    this.summaryCalls.push([...ids])
    if (this.summariesError !== undefined) throw this.summariesError
    return ids.flatMap(id => {
      const found = this.summariesById.get(id)
      return found === undefined ? [] : [found]
    })
  }

  async priorFeatures(ids: readonly string[]): Promise<EntityPriorFeatures[]> {
    this.priorFeaturesCalls.push([...ids])
    if (this.priorFeaturesError !== undefined) throw this.priorFeaturesError
    return ids.flatMap(id => {
      const explicit = this.priorFeaturesById.get(id)
      if (explicit !== undefined) return [explicit]
      const entity = this.entitiesById.get(id)
      return entity === undefined ? [] : [featuresOf(entity)]
    })
  }

  async recordRecall(events: readonly RecallEventInput[]): Promise<void> {
    if (this.recallError !== undefined) throw this.recallError
    this.recallEvents.push(...events)
  }

  async recordResidentTrace(_trace: ResidentTraceInput): Promise<void> {
    throw new Error('fake store 未实现 recordResidentTrace')
  }

  async rebuildView(_id: string): Promise<void> {
    throw new Error('fake store 未实现 rebuildView')
  }

  async upsertEmbedding(
    _entityId: string,
    _model: string,
    _dims: number,
    _embedding: readonly number[],
  ): Promise<void> {
    throw new Error('fake store 未实现 upsertEmbedding')
  }

  async deleteEmbedding(_entityId: string): Promise<void> {
    throw new Error('fake store 未实现 deleteEmbedding')
  }

  async setAttributeCache(
    _entityId: string,
    _name: string,
    _ordinal: number,
    _value: JsonValue | undefined,
    _cachedAt: string,
    _error?: string,
  ): Promise<void> {
    throw new Error('fake store 未实现 setAttributeCache')
  }

  async dependencyMarks(_entityId: string): Promise<readonly DependencyStaleMark[]> {
    return []
  }

  async clearDependencyMarks(_entityId: string, _attrs?: readonly DependencyAttributeRef[]): Promise<void> {
    // 默认假存储没有依赖标记；需要消费语义的测试用专门的内存实现。
  }

  async recordArtifact(input: ArtifactInput): Promise<void> {
    this.artifacts.push({
      id: input.id,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      kind: input.kind,
      content: input.content,
      source: input.source ?? 'fake',
      metadata: input.metadata ?? null,
      createdAt: FIXED_NOW,
    })
  }

  async listArtifacts(limit: number): Promise<ArtifactRecord[]> {
    return this.artifacts.slice(0, Math.max(1, limit))
  }

  async markArtifactProcessed(id: string): Promise<void> {
    this.processedArtifacts.add(id)
  }

  async write(_input: NormalizedWrite, _derived: DerivedWrite): Promise<WriteResult> {
    throw new Error('fake store 未实现 write')
  }

  async patch(_input: NormalizedWrite, _patch: PatchEntityInput, _derived: DerivedWrite): Promise<PatchResult> {
    throw new Error('fake store 未实现 patch')
  }

  async archive(_id: string, _reason: string, _actor: string): Promise<void> {
    throw new Error('fake store 未实现 archive')
  }

  async unarchive(_id: string, _reason: string, _actor: string): Promise<void> {
    throw new Error('fake store 未实现 unarchive')
  }

  async supersede(_input: SupersedeInput): Promise<SupersedeResult> {
    throw new Error('fake store 未实现 supersede')
  }

  async retract(_input: RetractInput): Promise<RetractResult> {
    throw new Error('fake store 未实现 retract')
  }

  async link(_input: LinkInput): Promise<LinkResult> {
    throw new Error('fake store 未实现 link')
  }

  async unlink(_id: string, _actor: string): Promise<void> {
    throw new Error('fake store 未实现 unlink')
  }

  async history(_stateId: string, _limit: number): Promise<StateVersion[]> {
    throw new Error('fake store 未实现 history')
  }

  async markAdopted(_traceId: string, _entityId: string, _kind: string): Promise<void> {
    throw new Error('fake store 未实现 markAdopted')
  }

  readonly exposures: UsageExposureInput[] = []
  readonly usage: { level: UsageEvidenceLevel; input: UsageEvidenceInput }[] = []

  async recordExposure(input: UsageExposureInput): Promise<void> {
    this.exposures.push(input)
  }

  async recordUsage(level: UsageEvidenceLevel, input: UsageEvidenceInput): Promise<void> {
    this.usage.push({ level, input })
  }

  async listAudit(_limit: number, _targetId?: string): Promise<AuditRecord[]> {
    throw new Error('fake store 未实现 listAudit')
  }

  async rollback(_auditId: number, _actor: string): Promise<RollbackResult> {
    throw new Error('fake store 未实现 rollback')
  }

  async stats(): Promise<{
    memory: number
    state: number
    chain: number
    archived: number
    attrNames: readonly string[]
  }> {
    throw new Error('fake store 未实现 stats')
  }
}

export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embedder'
  readonly dims = 512
  availableResult = true
  availableError?: Error
  embedError?: Error
  readonly embedCalls: string[][] = []

  async available(): Promise<boolean> {
    if (this.availableError !== undefined) throw this.availableError
    return this.availableResult
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.embedCalls.push([...texts])
    if (this.embedError !== undefined) throw this.embedError
    return texts.map(() => new Array<number>(512).fill(0.1))
  }
}

export class FakeClock implements Clock {
  readonly fixed: string

  constructor(fixed: string = FIXED_NOW) {
    this.fixed = fixed
  }

  now(): Date {
    return new Date(this.fixed)
  }

  iso(): string {
    return this.fixed
  }
}

export function makeEngine(
  store: FakeStore,
  config?: RetrievalConfig,
  embedder: FakeEmbedder = new FakeEmbedder(),
): RecallEngine {
  return new RecallEngine({ store, embedder, clock: new FakeClock(), config })
}
