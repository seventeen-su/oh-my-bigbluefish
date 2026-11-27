import type {
  Attribute,
  AttributeValue,
  Category,
  Entity,
  EntityKind,
  StateStatus,
} from '../../domain/entity.js'
import { isCategory, isStateStatus } from '../../domain/entity.js'
import type { JsonValue } from '../../domain/json.js'
import { isPlainObject } from '../../domain/json.js'
import { searchText as tokenizeForSearch } from '../../domain/text.js'
import { deriveSearchText, shouldAutoArchive, type NormalizedWrite } from '../../domain/validation.js'
import type { DerivedWrite } from '../../ports/store.js'
import { iso } from './db.js'

export interface EntityRow {
  id: string
  kind: EntityKind
  revision: string | number
  origin: string
  confidence: number | null
  pinned: boolean
  salience: number
  access_count: number
  adoption_count: number
  last_accessed_at: Date | string | null
  archived_at: Date | string | null
  archive_reason: string | null
  version_of: string | null
  is_current: boolean
  created_at: Date | string
  updated_at: Date | string
}

export interface AttributeRow {
  entity_id: string
  name: string
  ordinal: number
  value_kind: 'static' | 'dynamic'
  value: JsonValue | null
  expr: JsonValue | null
  cached_value: JsonValue | null
  cached_at: Date | string | null
  stale_after_ms: number | null
  last_error: string | null
  is_required: boolean
  confidence: number | null
  source: string
}

export interface ViewRow {
  entity_id: string
  kind: EntityKind
  category: Category | null
  scope: 'global' | 'project'
  project_key: string
  title: string | null
  status: StateStatus | null
  event_time: Date | string | null
  attrs: Record<string, JsonValue>
  attr_names: string[]
  search_text: string
  snippet: string
  chars: string[]
  triggers: string[]
  is_current: boolean
  archived_at: Date | string | null
  revision: string | number
  confidence: number | null
  pinned: boolean
  salience: number
  access_count: number
  adoption_count: number
  updated_at: Date | string
}

export interface ViewValues {
  entityId: string
  kind: EntityKind
  category: Category | null
  scope: 'global' | 'project'
  projectKey: string
  title: string | null
  status: StateStatus | null
  eventTime: string | null
  attrs: Record<string, JsonValue>
  attrNames: string[]
  searchText: string
  snippet: string
  chars: string[]
  triggers: string[]
  isCurrent: boolean
  archivedAt: string | null
  revision: number
  confidence: number | null
  pinned: boolean
  salience: number
  accessCount: number
  adoptionCount: number
  updatedAt: string
}

export function mapAttribute(row: AttributeRow): Attribute {
  const value: AttributeValue =
    row.value_kind === 'static'
      ? { kind: 'static', value: row.value as JsonValue }
      : {
          kind: 'dynamic',
          spec: row.expr as never,
          ...(row.cached_value !== null ? { cachedValue: row.cached_value } : {}),
          ...(iso(row.cached_at) !== undefined ? { cachedAt: iso(row.cached_at) as string } : {}),
          ...(row.stale_after_ms !== null ? { staleAfterMs: row.stale_after_ms } : {}),
          ...(row.last_error !== null ? { lastError: row.last_error } : {}),
        }
  return {
    name: row.name,
    ordinal: row.ordinal,
    value,
    required: row.is_required,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    source: row.source,
  }
}

export function mapEntity(row: EntityRow, attributes: readonly Attribute[], historyCount?: number): Entity {
  return {
    id: row.id,
    kind: row.kind,
    revision: Number(row.revision),
    origin: row.origin,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    pinned: row.pinned,
    salience: row.salience,
    accessCount: row.access_count,
    adoptionCount: row.adoption_count,
    ...(iso(row.last_accessed_at) !== undefined ? { lastAccessedAt: iso(row.last_accessed_at) as string } : {}),
    ...(iso(row.archived_at) !== undefined ? { archivedAt: iso(row.archived_at) as string } : {}),
    ...(row.archive_reason !== null ? { archiveReason: row.archive_reason } : {}),
    ...(row.version_of !== null ? { versionOf: row.version_of } : {}),
    isCurrent: row.is_current,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    ...(historyCount !== undefined ? { historyCount } : {}),
    attributes,
  }
}

function attributeValue(attributes: readonly Attribute[], name: string): JsonValue | undefined {
  const attribute = attributes.find(item => item.name === name)
  if (attribute === undefined) return undefined
  return attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
}

function previewOf(attributes: readonly Attribute[], title: string | null): string {
  const parts: string[] = []
  if (title !== null) parts.push(title)
  for (const attribute of attributes) {
    if (attribute.name === 'id' || attribute.name === 'scope' || attribute.name === 'group') continue
    const value = attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
    if (value === undefined) continue
    collectPreview(value, parts)
    if (parts.join(' ').length >= 240) break
  }
  return parts.join(' ').slice(0, 240)
}

function charSet(text: string): string[] {
  const seen = new Set<string>()
  for (const ch of text.normalize('NFKC')) {
    if (/\s/.test(ch)) continue
    seen.add(ch)
    if (seen.size >= 4096) break
  }
  return [...seen]
}

function collectPreview(value: JsonValue, out: string[], depth = 0): void {
  if (depth > 6 || out.join(' ').length >= 240) return
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value.trim())
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPreview(item, out, depth + 1)
    return
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectPreview(item as JsonValue, out, depth + 1)
  }
}

/**
 * 状态机 completed/discarded 自动归档时间；从属性行读取 status，其余实体返回 null。
 *
 * 写入路径需要在插入 attribute 之前就拿到 entity.archived_at（外键顺序），
 * 视图重建则通常由调用方显式传 archivedAt；两条路径共用这一条规则。
 */
export function autoArchivedAt(kind: EntityKind, attributes: readonly Attribute[], now: string): string | null {
  if (kind !== 'state') return null
  const status = attributeValue(attributes, 'status')
  return typeof status === 'string' && isStateStatus(status) && shouldAutoArchive(status) ? now : null
}

export function buildViewValues(
  input: NormalizedWrite,
  derived: DerivedWrite,
  options: {
    now: string
    /**
     * 派生源：同一事务内读回的属性行。缺省用写入入参（纯函数单测），
     * 事务路径必须传属性行，否则动态 cachedValue 进不了 search_text/chars/snippet。
     */
    attributes?: readonly Attribute[]
    isCurrent?: boolean
    revision?: number
    archivedAt?: string | null
    kindOverride?: EntityKind
  },
): ViewValues {
  const scope = input.scope
  const projectKey = scope.kind === 'global' ? '' : scope.projectKey
  const attributes = options.attributes ?? input.attributes
  const kind = options.kindOverride ?? input.kind
  const categoryValue = attributeValue(attributes, 'category')
  const statusValue = attributeValue(attributes, 'status')
  const timeValue = attributeValue(attributes, 'time')
  const titleValue = attributeValue(attributes, 'title')
  const category = typeof categoryValue === 'string' && isCategory(categoryValue) ? categoryValue : null
  const status = typeof statusValue === 'string' && isStateStatus(statusValue) ? statusValue : null
  const eventTime = typeof timeValue === 'string' && Number.isFinite(Date.parse(timeValue))
    ? new Date(timeValue).toISOString()
    : null
  const title = typeof titleValue === 'string' && titleValue.trim().length > 0 ? titleValue.trim() : null

  const attrs: Record<string, JsonValue> = {}
  const attrNames: string[] = []
  for (const attribute of attributes) {
    if (attribute.required) continue
    attrNames.push(attribute.name)
    if (attribute.value.kind === 'static') {
      attrs[attribute.name] = attribute.value.value
    } else if (attribute.value.cachedValue !== undefined) {
      attrs[attribute.name] = attribute.value.cachedValue
    }
  }

  // 自动归档是状态机的规则；记忆/思维链即使带同名自定义属性也不能被误归档。
  const archivedAt = options.archivedAt !== undefined ? options.archivedAt : autoArchivedAt(kind, attributes, options.now)
  const derivedText = deriveSearchText(attributes)
  const preview = previewOf(attributes, title)

  return {
    entityId: input.id,
    kind,
    category,
    scope: scope.kind,
    projectKey,
    title,
    status,
    eventTime,
    attrs,
    attrNames,
    searchText: tokenizeForSearch(derivedText),
    snippet: preview,
    chars: charSet(`${preview} ${derivedText}`),
    triggers: derived.triggers.map(trigger => `${trigger.kind}:${trigger.key}`),
    isCurrent: options.isCurrent ?? true,
    archivedAt,
    revision: options.revision ?? 1,
    confidence: input.confidence ?? null,
    pinned: input.pinned,
    salience: 0.5,
    accessCount: 0,
    adoptionCount: 0,
    updatedAt: options.now,
  }
}
