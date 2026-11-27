import type { Entity, EntityKind, RawAttributeValue, StateStatus, WriteEntityInput } from '../domain/entity.js'
import { attributeValue, scopeOf } from '../domain/entity.js'
import type { JsonValue } from '../domain/json.js'
import { isPlainObject } from '../domain/json.js'
import { tokenize } from '../domain/text.js'
import { normalizeWrite, deriveReferences, deriveSearchText, deriveTriggers } from '../domain/validation.js'
import type { Clock } from '../ports/clock.js'
import type { JobQueue, Logger } from '../ports/jobs.js'
import type { MaintenanceQueries } from '../ports/maintenance.js'
import type { SimilarEntity, Store, WriteResult } from '../ports/store.js'
import { UpdateService } from '../app/update.js'
import type { TimerHandler, TimerScheduleInput, TimerTask } from '../app/workflow/index.js'
import type { DynamicService } from '../app/dynamic.js'
import type { Embedder } from '../ports/embedding.js'

export interface ConsolidationDeps {
  readonly store: Store
  readonly queries: MaintenanceQueries
  readonly updateService: UpdateService
  readonly clock: Clock
  readonly logger?: Logger
  /** 有动态属性时注册 omb.refresh；测试/无动态属性时可省。 */
  readonly dynamic?: DynamicService
  /** 有嵌入器时注册 omb.embed-sweep，补齐历史/抽取实体的向量。 */
  readonly embedder?: Embedder
}

const TITLE_MAX = 80
/** 自动思维链标题上限（REQUIREMENTS §5 的组标题由系统生成，不超过 120 字符）。 */
const CHAIN_TITLE_MAX = 120
/** 自动成组至少需要两个相似成员；候选自己不算。 */
const AUTO_GROUP_MIN = 2
/** 思维链成员只允许记忆、状态机与状态历史；链不能嵌套链。 */
const GROUPABLE_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['memory', 'state', 'state_version'])

function redact(text: string, max = 4_000): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function mapStatus(value: unknown): StateStatus {
  if (value === 'completed' || value === 'done') return 'completed'
  if (value === 'blocked') return 'blocked'
  if (value === 'waiting' || value === 'pending') return 'waiting'
  if (value === 'discarded' || value === 'cancelled') return 'discarded'
  if (value === 'not_started' || value === 'todo') return 'not_started'
  return 'in_progress'
}

function numbersOf(text: string): string[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map(match => match[0]).sort()
}

function hasNegation(text: string): boolean {
  return /(?:不|没|无|未|禁止|不要|不能|不可|从不|never|not|no)\b/i.test(text)
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function combinedText(entity: Entity, fallback = ''): string {
  const title = attributeValue(entity, 'title')
  const body = attributeValue(entity, 'body')
  return [typeof title === 'string' ? title : '', typeof body === 'string' ? body : '', fallback].filter(Boolean).join('\n')
}

function optionalAttrs(entity: Entity): Record<string, RawAttributeValue> {
  const attrs: Record<string, RawAttributeValue> = {}
  for (const attribute of entity.attributes) {
    if (attribute.required) continue
    attrs[attribute.name] = attribute.value.kind === 'static'
      ? attribute.value.value
      : { $dynamic: attribute.value.spec }
  }
  return attrs
}

async function writeCandidate(store: Store, input: WriteEntityInput): Promise<WriteResult | undefined> {
  const normalized = normalizeWrite(input)
  if (!normalized.ok) return undefined
  const derived = {
    searchText: deriveSearchText(normalized.value.attributes),
    triggers: deriveTriggers(normalized.value.attributes),
    references: deriveReferences(normalized.value.attributes),
  }
  return await store.write(normalized.value, derived)
}

async function linkSimilar(deps: ConsolidationDeps, sourceId: string, similar: WriteResult['similarEntities']): Promise<number> {
  let linked = 0
  for (const item of similar.slice(0, 2)) {
    if (item.id === sourceId || item.archived) continue
    try {
      const result = await deps.store.link({
        fromId: sourceId,
        toId: item.id,
        relation: 'related_to',
        strength: Math.max(0, Math.min(1, item.score)),
        source: 'job',
        origin: 'job',
      })
      if (result.created) linked += 1
    } catch (error) {
      deps.logger?.warn(`抽取后补链失败：${sourceId} -> ${item.id}`, error)
    }
  }
  return linked
}

function groupableMembers(sourceId: string, similar: readonly SimilarEntity[]): SimilarEntity[] {
  const seen = new Set<string>([sourceId])
  const members: SimilarEntity[] = []
  for (const item of similar) {
    if (seen.has(item.id) || item.archived) continue
    if (!GROUPABLE_KINDS.has(item.kind)) continue
    seen.add(item.id)
    members.push(item)
  }
  return members
}

/**
 * 抽取候选写入/更新后，若与至少两个活跃记忆/状态机相似，就补一条自动思维链。
 *
 * 与 link-suggest 分工：这里只用抽取时拿到的相似实体成组，不读共同召回统计；
 * autoGroupKey 统一带 `extract:` 前缀，避免和 link-suggest 的成员组键互相压制。
 * 组是候选中心的：候选 + 相似成员；重复处理同一候选时靠 autoGroupKey 短路。
 */
async function autoGroupSimilar(deps: ConsolidationDeps, source: Entity, similar: readonly SimilarEntity[]): Promise<boolean> {
  if (source.archivedAt !== undefined) return false
  const members = groupableMembers(source.id, similar)
  if (members.length < AUTO_GROUP_MIN) return false
  // 以候选为中心的组键：同一个候选重复抽取（写入后又被更新）不会建第二条自动链。
  const key = `extract:candidate:${source.id}`
  try {
    if ((await deps.store.findByAttribute?.('autoGroupKey', key, 'chain')) !== undefined) return false
    const ids = [source.id, ...members.map(item => item.id)]
    const summaryById = new Map((await deps.store.summaries(ids)).map(item => [item.id, item]))
    const labels = members.slice(0, 2).map(item => {
      const summary = summaryById.get(item.id)
      const label = summary?.title ?? item.title
      if (label !== undefined && label.trim().length > 0) return label.trim()
      return (summary?.snippet ?? '').slice(0, 20)
    }).filter(label => label.length > 0)
    const title = `自动分组：${labels.join(' / ') || `${ids.length} 条抽取相似`}`.slice(0, CHAIN_TITLE_MAX)
    const candidate: WriteEntityInput = {
      kind: 'chain',
      scope: { kind: 'global' },
      title,
      group: ids,
      origin: 'job',
      attrs: { autoGroupKey: key, source: 'extract' },
    }
    // chain 的写入审计由 store.write 记账（actor=origin=job），不另造 action。
    if (await writeCandidate(deps.store, candidate) !== undefined) return true
    deps.logger?.warn(`抽取后自动成组被校验拒绝：${source.id}`)
    return false
  } catch (error) {
    deps.logger?.warn(`抽取后自动成组失败：${source.id}`, error)
    return false
  }
}

/** patch 不返回相似实体快照，用全文近邻取同类活跃实体补出成员。 */
async function similarAfterUpdate(deps: ConsolidationDeps, source: Entity): Promise<SimilarEntity[]> {
  if (source.kind !== 'memory' && source.kind !== 'state') return []
  // 全文查询是 AND 语义，标题比“标题+正文”更可能命中同主题的其它实体。
  const title = attributeValue(source, 'title')
  const text = typeof title === 'string' && title.trim().length > 0 ? title : combinedText(source)
  if (text.trim().length === 0) return []
  const hits = await deps.store.fulltext({ query: text, tokens: tokenize(text, 32), limit: 5, kind: source.kind })
  const similar: SimilarEntity[] = []
  for (const hit of hits) {
    if (hit.entityId === source.id) continue
    const other = await deps.store.get(hit.entityId)
    if (other === undefined || other.archivedAt !== undefined || !GROUPABLE_KINDS.has(other.kind)) continue
    const title = attributeValue(other, 'title')
    similar.push({
      id: other.id,
      kind: other.kind,
      ...(typeof title === 'string' && title.trim().length > 0 ? { title } : {}),
      scope: scopeOf(other),
      archived: false,
      score: hit.rawScore,
      reason: 'text-overlap',
    })
  }
  return similar
}

async function autoGroupAfterUpdate(deps: ConsolidationDeps, source: Entity): Promise<boolean> {
  try {
    return await autoGroupSimilar(deps, source, await similarAfterUpdate(deps, source))
  } catch (error) {
    deps.logger?.warn(`更新后自动成组失败：${source.id}`, error)
    return false
  }
}

function projectKeyOf(payload: Record<string, unknown>, metadata: JsonValue): string | undefined {
  // 事件 metadata 的 projectKey 已在捕获时统一成 git root；直接 payload 里的
  // cwd 可能只是子目录，优先级必须低于它。
  if (isPlainObject(metadata)) {
    const fromMetadata = stringField(metadata, 'projectKey')
    if (fromMetadata !== undefined) return fromMetadata
  }
  const direct = stringField(payload, 'projectKey') ?? stringField(payload, 'cwd')
  if (direct !== undefined) return direct
  if (isPlainObject(metadata)) {
    return stringField(metadata, 'cwd')
  }
  return undefined
}

function candidateFromArtifact(artifact: { id: string; source: string; kind: string; content: string; metadata: JsonValue }, now: string): WriteEntityInput | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(artifact.content)
  } catch {
    return undefined
  }
  if (!isPlainObject(payload)) return undefined
  const projectKey = projectKeyOf(payload, artifact.metadata)
  if (artifact.kind.startsWith('goal/')) {
    const goal = isPlainObject(payload['goal']) ? payload['goal'] : payload
    const objective = stringField(goal, 'objective') ?? stringField(payload, 'objective')
    if (objective === undefined || projectKey === undefined) return undefined
    return {
      kind: 'state',
      scope: { kind: 'project', projectKey },
      title: `目标：${redact(objective, TITLE_MAX)}`,
      status: 'in_progress',
      time: now,
      attrs: {
        body: objective,
        source: 'dsh-goal',
        artifactId: artifact.id,
        ...(stringField(payload, 'goalId') !== undefined
          ? { goalId: stringField(payload, 'goalId') as string }
          : stringField(goal, 'id') !== undefined
            ? { goalId: stringField(goal, 'id') as string }
            : {}),
      },
    }
  }
  if (artifact.kind.startsWith('team/') || artifact.kind.startsWith('task/')) {
    const task = isPlainObject(payload['task']) ? payload['task'] : payload
    const title = stringField(task, 'title') ?? stringField(task, 'name')
    const description = stringField(task, 'description') ?? stringField(task, 'body') ?? title
    if (title === undefined || description === undefined || projectKey === undefined) return undefined
    return {
      kind: 'state',
      scope: { kind: 'project', projectKey },
      title: `任务：${redact(title, TITLE_MAX)}`,
      status: mapStatus(task['status']),
      time: now,
      attrs: {
        body: description,
        source: 'dsh-task',
        artifactId: artifact.id,
        ...(stringField(task, 'id') !== undefined
          ? { taskId: stringField(task, 'id') as string }
          : stringField(payload, 'taskId') !== undefined
            ? { taskId: stringField(payload, 'taskId') as string }
            : {}),
      },
    }
  }
  if (artifact.kind.startsWith('subagent/') || artifact.kind.startsWith('job/')) {
    const report = payload['lastAssistantMessage'] ?? payload['result'] ?? payload['content']
    const text = typeof report === 'string' ? report : report === undefined ? '' : JSON.stringify(report)
    if (text.trim().length === 0 || projectKey === undefined) return undefined
    return {
      kind: 'memory',
      category: 'clue',
      scope: { kind: 'project', projectKey },
      attrs: { title: '子代理报告', body: redact(text), source: artifact.kind, artifactId: artifact.id },
    }
  }
  return undefined
}

export async function handleExtract(deps: ConsolidationDeps, limit = 20): Promise<{ written: number; skipped: number; grouped: number }> {
  const artifacts = await deps.store.listArtifacts(limit)
  let written = 0
  let skipped = 0
  let grouped = 0
  const now = deps.clock.iso()
  for (const artifact of artifacts) {
    const candidate = candidateFromArtifact(artifact, now)
    if (candidate === undefined) {
      skipped += 1
      await deps.store.markArtifactProcessed(artifact.id)
      continue
    }
    try {
      const attrs = candidate.attrs ?? {}
      const goalId = typeof attrs.goalId === 'string' ? attrs.goalId : undefined
      const taskId = typeof attrs.taskId === 'string' ? attrs.taskId : undefined
      const convergeName = goalId !== undefined ? 'goalId' : taskId !== undefined ? 'taskId' : undefined
      const convergeValue = goalId ?? taskId
      const existing = convergeName !== undefined && convergeValue !== undefined
        ? await deps.store.findByAttribute?.(convergeName, convergeValue, 'state')
        : undefined
      if (existing !== undefined) {
        const existingEntity = await deps.store.get(existing, { includeArchived: false })
        if (existingEntity === undefined) {
          skipped += 1
          continue
        }
        const patch = candidate.kind === 'state'
          ? {
              id: existing,
              expectedRevision: existingEntity.revision,
              title: candidate.title,
              status: candidate.status,
              time: candidate.time,
              attrs,
              origin: 'job',
            }
          : { id: existing, expectedRevision: existingEntity.revision, attrs, origin: 'job' }
        const patched = await deps.updateService.update(patch)
        if (patched.ok) {
          written += 1
          if (await autoGroupAfterUpdate(deps, patched.value.entity)) grouped += 1
        } else skipped += 1
      } else {
        const writtenResult = await writeCandidate(deps.store, candidate)
        if (writtenResult === undefined) skipped += 1
        else {
          written += 1
          await linkSimilar(deps, writtenResult.entity.id, writtenResult.similarEntities)
          if (await autoGroupSimilar(deps, writtenResult.entity, writtenResult.similarEntities)) grouped += 1
        }
      }
    } catch (error) {
      skipped += 1
      // 写失败不能标记 processed：让队列重试，否则候选会永久丢失。
      deps.logger?.warn(`抽取候选写入失败：${artifact.id}`, error)
      throw error
    }
    await deps.store.markArtifactProcessed(artifact.id)
  }
  // 抽取完成后再跑冲突检测；共同召回成组仍由 link-suggest 继续补。
  await handleConflict(deps)
  return { written, skipped, grouped }
}

function attributeOverlap(left: Entity, right: Entity): boolean {
  const leftAttrs = optionalAttrs(left)
  const rightAttrs = optionalAttrs(right)
  const leftNames = Object.keys(leftAttrs)
  const rightNames = Object.keys(rightAttrs)
  if (leftNames.length === 0 || rightNames.length === 0) return false
  const shared = leftNames.filter(name => Object.hasOwn(rightAttrs, name))
  const ratio = shared.length / Math.min(leftNames.length, rightNames.length)
  if (ratio < 0.6 || shared.length < 2) return false
  let same = 0
  for (const name of shared) {
    if (JSON.stringify(leftAttrs[name]) === JSON.stringify(rightAttrs[name])) same += 1
  }
  return same >= 2
}

export async function handleDedupe(deps: ConsolidationDeps, limit = 30): Promise<{ merged: number }> {
  const recent = await deps.queries.recent(limit)
  const memories = recent.filter(item => item.kind === 'memory' && !item.pinned)
  let merged = 0
  for (const item of memories) {
    const entity = await deps.store.get(item.id)
    if (entity === undefined || entity.archivedAt !== undefined) continue
    const text = combinedText(entity, item.snippet)
    const tokens = tokenize(text, 32)
    if (tokens.length < 3) continue
    const hits = await deps.store.fulltext({ query: text, tokens, limit: 5, kind: 'memory' })
    const candidates = new Map(hits.map(hit => [hit.entityId, { hit, vector: false }]))
    if (deps.embedder !== undefined) {
      try {
        const vectors = await deps.embedder.embed([text])
        const embedding = vectors[0]
        if (embedding !== undefined) {
          const vectorHits = await deps.store.vector({ embedding, kind: 'memory', limit: 5 })
          for (const hit of vectorHits) {
            if (hit.rawScore < 0.9) continue
            candidates.set(hit.entityId, { hit, vector: true })
          }
        }
      } catch (error) {
        deps.logger?.warn('dedupe 向量近邻失败，退回全文/属性判断', error)
      }
    }
    for (const { hit, vector } of candidates.values()) {
      if (hit.entityId === item.id) continue
      const other = await deps.store.get(hit.entityId)
      if (other === undefined || other.archivedAt !== undefined) continue
      const otherText = combinedText(other)
      const textSimilar = jaccard(tokens, tokenize(otherText, 32)) >= 0.82
      if (!textSimilar && !vector && !attributeOverlap(entity, other)) continue
      if (numbersOf(text).join(',') !== numbersOf(otherText).join(',')) continue
      const canonical = entity.createdAt <= other.createdAt ? entity : other
      const duplicate = canonical.id === entity.id ? other : entity
      const mergedAttrs = { ...optionalAttrs(duplicate), ...optionalAttrs(canonical) }
      const patched = await deps.updateService.update({
        id: canonical.id,
        expectedRevision: canonical.revision,
        attrs: mergedAttrs,
        origin: 'job',
      })
      if (!patched.ok) continue
      await deps.store.link({ fromId: duplicate.id, toId: canonical.id, relation: 'merged_into', source: 'job', origin: 'job' })
      await deps.store.link({ fromId: canonical.id, toId: duplicate.id, relation: 'merged_from', source: 'job', origin: 'job' })
      await deps.store.archive(duplicate.id, 'merged', 'job:dedupe')
      merged += 1
      break
    }
  }
  return { merged }
}

function conflictingAttributes(left: Entity, right: Entity): boolean {
  const values = new Map<string, JsonValue>()
  for (const attribute of left.attributes) {
    if (attribute.required || attribute.value.kind !== 'static') continue
    if (typeof attribute.value.value === 'string' || typeof attribute.value.value === 'number') {
      values.set(attribute.name, attribute.value.value)
    }
  }
  for (const attribute of right.attributes) {
    if (attribute.required || attribute.value.kind !== 'static') continue
    const previous = values.get(attribute.name)
    if (previous === undefined) continue
    const next = attribute.value.value
    if (typeof previous !== 'string' && typeof previous !== 'number') continue
    if (typeof next !== 'string' && typeof next !== 'number') continue
    if (String(previous) === String(next)) continue
    if (numbersOf(String(previous)).join(',') !== numbersOf(String(next)).join(',')) return true
    if (hasNegation(String(previous)) !== hasNegation(String(next))) return true
  }
  return false
}

export async function handleConflict(deps: ConsolidationDeps, limit = 30): Promise<{ linked: number }> {
  const recent = await deps.queries.recent(limit)
  const facts = recent.filter(item => item.kind === 'memory')
  let linked = 0
  for (const item of facts) {
    const entity = await deps.store.get(item.id)
    if (entity === undefined) continue
    const title = attributeValue(entity, 'title')
    const text = typeof title === 'string' && title.trim().length > 0 ? title : combinedText(entity, item.snippet)
    const hits = await deps.store.fulltext({ query: text, tokens: tokenize(text, 32), limit: 5, kind: 'memory', category: 'fact' })
    for (const hit of hits) {
      if (hit.entityId === item.id) continue
      if (await deps.queries.conflictSuppressed(item.id, hit.entityId)) continue
      const other = await deps.store.get(hit.entityId)
      if (other === undefined) continue
      if (!conflictingAttributes(entity, other)) continue
      const result = await deps.store.link({
        fromId: item.id,
        toId: other.id,
        relation: 'possible_conflict',
        directed: false,
        source: 'job',
        origin: 'job',
      })
      if (result.created) linked += 1
    }
  }
  return { linked }
}

function clueEvidence(entity: Entity): { sessions: Set<string>; confirmed: boolean; verified: boolean } {
  const evidence = attributeValue(entity, 'evidence')
  const sessions = new Set<string>()
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (typeof item === 'string' && item.startsWith('session:')) sessions.add(item.slice('session:'.length))
      else if (isPlainObject(item) && typeof item['sessionId'] === 'string') sessions.add(item['sessionId'])
    }
  }
  return {
    sessions,
    confirmed: attributeValue(entity, 'userConfirmed') === true || attributeValue(entity, 'assertedBy') === 'user',
    verified: attributeValue(entity, 'verified') === true,
  }
}

export async function handleCluePromote(deps: ConsolidationDeps, limit = 30): Promise<{ promoted: number }> {
  // 线索转事实前必须先跑引用腐化，避免把已失效引用固化。
  await handleReferenceRot(deps)
  const recent = await deps.queries.recent(limit)
  const clues = recent.filter(item => item.kind === 'memory' && item.category === 'clue')
  let promoted = 0
  for (const item of clues) {
    const entity = await deps.store.get(item.id)
    if (entity === undefined) continue
    const evidence = clueEvidence(entity)
    if (!evidence.confirmed && !evidence.verified && evidence.sessions.size < 2) continue
    const result = await deps.updateService.update({
      id: entity.id,
      expectedRevision: entity.revision,
      category: 'fact',
      attrs: { promotedFrom: 'clue', promotedAt: deps.clock.iso() },
      origin: 'job',
    })
    if (result.ok) promoted += 1
  }
  return { promoted }
}

export async function handleLinkSuggest(deps: ConsolidationDeps, limit = 50): Promise<{ linked: number; grouped: number }> {
  const pairs = await deps.queries.coRecallPairs(limit)
  let linked = 0
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const current = parent.get(id)
    if (current === undefined || current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string): void => {
    const left = find(a)
    const right = find(b)
    if (left !== right) parent.set(right, left)
  }
  for (const pair of pairs) {
    if (pair.count < 2) continue
    const result = await deps.store.link({
      fromId: pair.a,
      toId: pair.b,
      relation: 'co_recalled',
      directed: false,
      strength: Math.min(1, pair.count / 5),
      source: 'job',
      origin: 'job',
    })
    if (result.created) linked += 1
    if (!parent.has(pair.a)) parent.set(pair.a, pair.a)
    if (!parent.has(pair.b)) parent.set(pair.b, pair.b)
    union(pair.a, pair.b)
  }

  const groups = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const root = find(id)
    const members = groups.get(root) ?? []
    members.push(id)
    groups.set(root, members)
  }
  let grouped = 0
  for (const members of groups.values()) {
    if (members.length < 3) continue
    const ids = [...members].sort()
    const key = ids.join('|')
    const existing = await deps.store.findByAttribute?.('autoGroupKey', key, 'chain')
    if (existing !== undefined) continue
    const summaries = await deps.store.summaries(ids)
    const labels = summaries.slice(0, 2).map(item => item.title ?? item.snippet.slice(0, 20)).filter(Boolean)
    const title = `自动分组：${labels.join(' / ') || `${ids.length} 条共同召回`}`.slice(0, 120)
    const candidate: WriteEntityInput = {
      kind: 'chain',
      scope: { kind: 'global' },
      title,
      group: ids,
      origin: 'job',
      attrs: { autoGroupKey: key, source: 'link-suggest' },
    }
    if (await writeCandidate(deps.store, candidate) !== undefined) grouped += 1
  }
  return { linked, grouped }
}

export async function handleForget(deps: ConsolidationDeps, limit = 30, threshold = 0.35): Promise<{ archived: number }> {
  const items = await deps.queries.forgettable(limit, threshold)
  let archived = 0
  for (const item of items) {
    // 显著度只用于选择与审计，不再单独写一个无审计的 salience 更新；回滚 archive 即完整恢复。
    await deps.store.archive(item.id, `forgetting:${item.salience.toFixed(3)}`, 'job:forget')
    archived += 1
  }
  return { archived }
}

export async function handleEmbedSweep(deps: ConsolidationDeps, limit = 20): Promise<{ embedded: number }> {
  if (deps.embedder === undefined) return { embedded: 0 }
  const ids = await deps.queries.missingEmbeddings(limit)
  let embedded = 0
  for (const id of ids) {
    try {
      const entity = await deps.store.get(id, { includeArchived: true })
      if (entity === undefined) continue
      const text = deriveSearchText(entity.attributes)
      if (text.trim().length === 0) continue
      const vectors = await deps.embedder.embed([text])
      const vector = vectors[0]
      if (vector === undefined) continue
      await deps.store.upsertEmbedding(id, deps.embedder.model, deps.embedder.dims, vector)
      embedded += 1
    } catch (error) {
      deps.logger?.warn(`补齐向量失败：${id}`, error)
    }
  }
  return { embedded }
}

const STATUS_VALUES = new Set<StateStatus>(['completed', 'in_progress', 'waiting', 'blocked', 'not_started', 'discarded'])

/** 状态机可通过可选动态属性 statusRule 自动推进状态（regex/code 等求值后必须是六态之一）。 */
function statusRuleOf(entity: Entity): StateStatus | undefined {
  const value = attributeValue(entity, 'statusRule')
  return typeof value === 'string' && STATUS_VALUES.has(value as StateStatus) ? value as StateStatus : undefined
}

export async function handleRefresh(deps: ConsolidationDeps, limit = 20): Promise<{ refreshed: number; statusUpdated: number }> {
  if (deps.dynamic === undefined) return { refreshed: 0, statusUpdated: 0 }
  const ids = await deps.queries.staleDynamic(limit)
  let refreshed = 0
  let statusUpdated = 0
  for (const id of ids) {
    try {
      const entity = await deps.dynamic.refreshById(id, { force: true, max: 4 })
      if (entity === undefined) continue
      refreshed += 1
      if (entity.kind !== 'state') continue
      const next = statusRuleOf(entity)
      if (next === undefined || next === attributeValue(entity, 'status')) continue
      const updated = await deps.updateService.update({
        id,
        expectedRevision: entity.revision,
        status: next,
        origin: 'job',
      })
      if (updated.ok) statusUpdated += 1
    } catch (error) {
      deps.logger?.warn(`动态属性刷新失败：${id}`, error)
    }
  }
  return { refreshed, statusUpdated }
}

export async function handleAttrAlias(deps: ConsolidationDeps, limit = 10): Promise<{ renamed: number }> {
  const candidates = await deps.queries.attrAliasCandidates(limit)
  let renamed = 0
  for (const candidate of candidates) {
    const from = candidate.usage >= 3 ? candidate.alias : candidate.name
    const to = from === candidate.alias ? candidate.name : candidate.alias
    if (from === to) continue
    const affected = await deps.queries.renameAttribute(from, to)
    for (const id of affected) await deps.store.rebuildView(id)
    renamed += affected.length
  }
  return { renamed }
}

export async function handleReferenceRot(deps: ConsolidationDeps, limit = 50): Promise<{ marked: number }> {
  const broken = await deps.queries.brokenReferences(limit)
  const now = deps.clock.iso()
  let marked = 0
  for (const reference of broken) {
    await deps.store.setAttributeCache(
      reference.sourceId,
      reference.sourceAttr,
      reference.sourceOrdinal,
      undefined,
      now,
      `reference-rot: ${reference.targetId}#${reference.targetAttr}`,
    )
    marked += 1
  }
  return { marked }
}

const CONSOLIDATION_JOBS = [
  'omb.extract',
  'omb.reference-rot',
  'omb.clue-promote',
  'omb.dedupe',
  'omb.conflict',
  'omb.link-suggest',
  'omb.forget',
  'omb.attr-alias',
  'omb.refresh',
  'omb.embed-sweep',
] as const

type ConsolidationJobName = (typeof CONSOLIDATION_JOBS)[number]

/**
 * 巩固任务的 durable schedule（ADR-0011）。
 *
 * 调度只落三样东西：稳定的 `dedupeKey`、`due_at` 网格、以及“到期把哪个任务入队”。
 * 重试/死信由 pg-boss 负责；到期只入队一次。对外只暴露一个窄接口
 * `createConsolidationScheduler`，排期/续期/触发标记都是模块内部细节。
 */
const CONSOLIDATION_TIMER_TOPIC = 'omb.consolidation'
const CONSOLIDATION_INTERVAL_MS = 10 * 60 * 1000
/** timer 入队时写入的触发标记：只有调度驱动的执行才续期。 */
const CONSOLIDATION_TRIGGER = 'omb.consolidation'

interface ConsolidationSchedule {
  readonly job: ConsolidationJobName
  readonly dedupeKey: string
  readonly intervalMs: number
}

const CONSOLIDATION_SCHEDULES: readonly ConsolidationSchedule[] = CONSOLIDATION_JOBS.map(job => ({
  job,
  dedupeKey: `consolidation:${job}`,
  intervalMs: CONSOLIDATION_INTERVAL_MS,
}))

/** 组合根注入的 timer 能力（不 import pg、不认识表结构）。 */
interface ConsolidationTimerPort {
  /** 同 dedupeKey 是重排期（覆盖 due_at），不是新增行。 */
  schedule(input: TimerScheduleInput): Promise<unknown>
  /** 已有 pending/claimed timer 的 dedupeKey 集合（一次查询）。 */
  armed(keys: readonly string[]): Promise<ReadonlySet<string>>
}

interface ConsolidationScheduleResult {
  /** 本次真正补排的任务；空数组表示全部已 armed（幂等重入）。 */
  readonly scheduled: readonly string[]
  /** 已有 pending/claimed 行、本次没有改动的任务数。 */
  readonly armed: number
}

/** 巩固调度的窄接口：调用方只需要“排期/续期/一个 timer handler”。 */
interface ConsolidationScheduler {
  /** 全部任务的调度描述（dedupeKey/周期）；调用方可以按已注册 handler 过滤。 */
  readonly schedules: readonly ConsolidationSchedule[]
  /**
   * 启动/断链恢复的幂等排期：
   * - 已有 pending/claimed 行（armed）完全不动：不把 due_at 往后推，崩溃期间到期的
   *   timer 保持逾期、恢复后立刻执行（at-least-once），也不会产生第二行；
   * - 没有行（首次启动、或链路断了）才补一条**立即到期**的 timer，等价旧 loop 的启动
   *   首轮，但只有一行且到期即入队一次。
   */
  ensure(jobs?: readonly string[]): Promise<ConsolidationScheduleResult>
  /** 调度驱动的任务执行完：把下一期排到网格点（同 dedupeKey 覆盖，行数恒定）。 */
  rearm(job: string): Promise<void>
  /** 到期只把对应任务入队 pg-boss 一次；重试/死信交给 pg-boss。 */
  readonly timerHandler: TimerHandler
}

interface ConsolidationSchedulerDeps {
  readonly timers: ConsolidationTimerPort
  readonly queue: JobQueue
  readonly clock: Clock
  readonly logger?: Logger
}

function scheduleOf(job: string): ConsolidationSchedule {
  const schedule = CONSOLIDATION_SCHEDULES.find(item => item.job === job)
  if (schedule === undefined) throw new Error(`没有注册巩固任务：${job}`)
  return schedule
}

/**
 * 下一次到期：严格晚于 `now` 的 interval 网格点。
 *
 * 用网格而不是 `now + interval`：同一个 `now` 算出的 due_at 确定，重启/重复 rearm
 * 不会让下一期漂移；`+1ms` 保证永远在未来，避免“到期即再到期”的自激循环。
 */
function nextDue(now: Date, intervalMs: number): Date {
  const interval = Math.max(1, Math.trunc(intervalMs))
  return new Date(Math.ceil((now.getTime() + 1) / interval) * interval)
}

function timerInput(schedule: ConsolidationSchedule, dueAt: Date): TimerScheduleInput {
  return {
    topic: CONSOLIDATION_TIMER_TOPIC,
    payload: { job: schedule.job },
    dueAt,
    dedupeKey: schedule.dedupeKey,
  }
}

/** timer 载荷里的任务名；不合法时抛错让 timer 退避/死信，而不是静默空转。 */
function jobOfPayload(payload: JsonValue): ConsolidationJobName {
  const job = isPlainObject(payload) ? payload['job'] : undefined
  if (typeof job === 'string' && (CONSOLIDATION_JOBS as readonly string[]).includes(job)) {
    return job as ConsolidationJobName
  }
  throw new Error(`omb.consolidation timer 载荷非法：${JSON.stringify(payload)}`)
}

/** 该 pg-boss 任务是不是 consolidation timer 到期入队的（只有它执行完才续期）。 */
function isTriggered(payload: unknown): boolean {
  return isPlainObject(payload) && payload['trigger'] === CONSOLIDATION_TRIGGER
}

/**
 * 构造巩固任务调度器（组合根调用一次）。
 *
 * timer 只负责“到点入队一次”；续期跟着**调度驱动**的任务真实执行走，所以删除 loop 后
 * 调度仍然连续。被 outbox reaction 或人工提前入队的同名任务不续期——它没有“这一期结束”
 * 的语义，也不能在 timer 已被 claim 的瞬间把行重排成 pending（会破坏 complete 的 CAS）。
 */
export function createConsolidationScheduler(deps: ConsolidationSchedulerDeps): ConsolidationScheduler {
  const schedules = CONSOLIDATION_SCHEDULES
  return {
    schedules,
    async ensure(jobs) {
      const selected = jobs === undefined ? schedules : schedules.filter(schedule => jobs.includes(schedule.job))
      const armedKeys = await deps.timers.armed(selected.map(schedule => schedule.dedupeKey))
      const scheduled: string[] = []
      for (const schedule of selected) {
        if (armedKeys.has(schedule.dedupeKey)) continue
        await deps.timers.schedule(timerInput(schedule, deps.clock.now()))
        scheduled.push(schedule.job)
      }
      return { scheduled, armed: selected.length - scheduled.length }
    },
    async rearm(job) {
      const schedule = scheduleOf(job)
      await deps.timers.schedule(timerInput(schedule, nextDue(deps.clock.now(), schedule.intervalMs)))
    },
    timerHandler: {
      topic: CONSOLIDATION_TIMER_TOPIC,
      async run(task: TimerTask): Promise<void> {
        const job = jobOfPayload(task.payload)
        const intervalMs = scheduleOf(job).intervalMs
        const bucket = Math.floor(deps.clock.now().getTime() / intervalMs)
        await deps.queue.enqueue(job, { trigger: CONSOLIDATION_TRIGGER, job }, {
          singletonKey: `${job}:${bucket}`,
          retryLimit: 3,
        })
      },
    },
  }
}

interface ConsolidationJobOptions {
  /** 有 scheduler 时，调度驱动的任务执行完把下一期排进 timer；缺省只注册 handler。 */
  readonly scheduler?: ConsolidationScheduler
}

/**
 * 注册巩固任务的 pg-boss handler，返回真实注册成功的任务名。
 *
 * 传了 `scheduler` 时，只有**调度驱动**的任务（载荷带触发标记）执行完才在 finally 里
 * rearm 下一期；rearm 失败只记日志，不影响本次任务结果。
 */
export async function registerConsolidationJobs(
  queue: JobQueue,
  deps: ConsolidationDeps,
  options: ConsolidationJobOptions = {},
): Promise<readonly string[]> {
  const registered: string[] = []
  const work = async (job: ConsolidationJobName, run: () => Promise<void>): Promise<void> => {
    await queue.work(job, async payload => {
      try {
        await run()
      } finally {
        if (isTriggered(payload) && options.scheduler !== undefined) {
          try {
            await options.scheduler.rearm(job)
          } catch (error) {
            deps.logger?.warn(`巩固任务续期失败：${job}`, error)
          }
        }
      }
    })
    registered.push(job)
  }
  await work('omb.extract', () => handleExtract(deps).then(() => undefined))
  await work('omb.dedupe', () => handleDedupe(deps).then(() => undefined))
  await work('omb.conflict', () => handleConflict(deps).then(() => undefined))
  await work('omb.clue-promote', () => handleCluePromote(deps).then(() => undefined))
  await work('omb.link-suggest', () => handleLinkSuggest(deps).then(() => undefined))
  await work('omb.forget', () => handleForget(deps).then(() => undefined))
  await work('omb.attr-alias', () => handleAttrAlias(deps).then(() => undefined))
  await work('omb.reference-rot', () => handleReferenceRot(deps).then(() => undefined))
  if (deps.dynamic !== undefined) {
    await work('omb.refresh', () => handleRefresh(deps).then(() => undefined))
  }
  if (deps.embedder !== undefined) {
    await work('omb.embed-sweep', () => handleEmbedSweep(deps).then(() => undefined))
  }
  return registered
}
