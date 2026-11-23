import type { JsonValue } from './json.js'
import type { OmbError } from './errors.js'

export const ENTITY_KINDS = ['memory', 'state', 'chain', 'state_version'] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

export const CATEGORIES = ['fact', 'clue', 'event'] as const
export type Category = (typeof CATEGORIES)[number]
export const CATEGORY_LABELS: Record<Category, string> = {
  fact: '事实',
  clue: '线索',
  event: '事件',
}

export const STATE_STATUSES = ['completed', 'in_progress', 'waiting', 'blocked', 'not_started', 'discarded'] as const
export type StateStatus = (typeof STATE_STATUSES)[number]
export const STATUS_LABELS: Record<StateStatus, string> = {
  completed: '已完成',
  in_progress: '进行中',
  waiting: '等待中',
  blocked: '阻塞中',
  not_started: '未开启',
  discarded: '已丢弃',
}

export type Scope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectKey: string }

export function scopeKey(scope: Scope): string {
  return scope.kind === 'global' ? '' : scope.projectKey
}

export function isGlobalScope(scope: Scope): boolean {
  return scope.kind === 'global'
}

export interface RefSpec {
  readonly kind: 'ref'
  readonly entityId: string
  readonly attr?: string
  readonly fallback?: JsonValue
}

export interface TemplateSpec {
  readonly kind: 'template'
  readonly template: string
  readonly refs?: readonly { readonly entityId: string; readonly attr?: string; readonly as?: string }[]
}

export interface FileSpec {
  readonly kind: 'file'
  readonly path: string
  readonly extract?:
    | { readonly kind: 'text' }
    | { readonly kind: 'json'; readonly pointer?: string }
    | { readonly kind: 'regex'; readonly source: string; readonly flags?: string; readonly group?: number }
}

export interface RegexSpec {
  readonly kind: 'regex'
  readonly source: string
  readonly flags?: string
  readonly input: RefSpec | { readonly kind: 'literal'; readonly value: string }
  readonly group?: number
}

export interface CodeSpec {
  readonly kind: 'code'
  readonly source: string
  readonly timeoutMs?: number
  readonly memoryMb?: number
}

export interface TaskSpec {
  readonly kind: 'task'
  readonly source: 'subagent' | 'team' | 'job'
  readonly id: string
  readonly field?: string
}

export interface UrlSpec {
  readonly kind: 'url'
  readonly url: string
  readonly jsonPath?: string
  readonly allowlist?: readonly string[]
}

export type DynamicSpec = RefSpec | TemplateSpec | FileSpec | RegexSpec | CodeSpec | TaskSpec | UrlSpec

export interface StaticAttributeValue {
  readonly kind: 'static'
  readonly value: JsonValue
}

export interface DynamicAttributeValue {
  readonly kind: 'dynamic'
  readonly spec: DynamicSpec
  readonly cachedValue?: JsonValue
  readonly cachedAt?: string
  readonly staleAfterMs?: number
  readonly lastError?: string
}

export type AttributeValue = StaticAttributeValue | DynamicAttributeValue

export interface Attribute {
  readonly name: string
  readonly ordinal: number
  readonly value: AttributeValue
  readonly required: boolean
  readonly confidence?: number
  readonly source: string
}

export interface Entity {
  readonly id: string
  readonly kind: EntityKind
  readonly revision: number
  readonly origin: string
  readonly confidence?: number
  readonly pinned: boolean
  readonly salience: number
  readonly accessCount: number
  readonly adoptionCount: number
  readonly lastAccessedAt?: string
  readonly archivedAt?: string
  readonly archiveReason?: string
  readonly versionOf?: string
  readonly isCurrent: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly historyCount?: number
  readonly attributes: readonly Attribute[]
}

/** 属性输入：普通 JSON 是静态值；`{ $dynamic: spec }` 是动态值。 */
export type RawAttributeValue = JsonValue | { readonly $dynamic: DynamicSpec }

export interface WriteBase {
  readonly id?: string
  readonly scope: Scope
  readonly attrs?: Readonly<Record<string, RawAttributeValue>>
  readonly origin?: string
  readonly confidence?: number
  readonly pinned?: boolean
}

export interface WriteMemory extends WriteBase {
  readonly kind: 'memory'
  readonly category: Category
}

export interface WriteState extends WriteBase {
  readonly kind: 'state'
  readonly title: string
  readonly status: StateStatus
  readonly time: string
}

export interface WriteChain extends WriteBase {
  readonly kind: 'chain'
  readonly title: string
  readonly group: readonly string[]
}

export type WriteEntityInput = WriteMemory | WriteState | WriteChain

export interface PatchEntityInput {
  readonly id: string
  readonly expectedRevision?: number
  readonly attrs?: Readonly<Record<string, RawAttributeValue | null>>
  readonly title?: string
  readonly status?: StateStatus
  readonly time?: string
  readonly category?: Category
  readonly group?: readonly string[]
  readonly pinned?: boolean
  readonly confidence?: number
  /** 本次写入来源；缺省保留实体已有 origin，避免后台修改把 model 误标成 job 或反之。 */
  readonly origin?: string
}

export interface StateVersion {
  readonly id: string
  readonly stateId: string
  readonly revision: number
  readonly status: StateStatus
  readonly title: string
  readonly time: string
  readonly attributes: readonly Attribute[]
  readonly archivedAt?: string
  readonly createdAt: string
}

export interface ValidationIssue {
  readonly field: string
  readonly message: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] }

export function validationError(errors: readonly ValidationIssue[]): OmbError {
  return {
    code: 'invalid-input',
    message: errors.map(issue => `${issue.field}: ${issue.message}`).join('；'),
    details: errors,
  }
}

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value)
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

export function isStateStatus(value: unknown): value is StateStatus {
  return typeof value === 'string' && (STATE_STATUSES as readonly string[]).includes(value)
}

export function getAttribute(entity: Entity, name: string): Attribute | undefined {
  return entity.attributes.find(attribute => attribute.name === name)
}

/** 读取属性当前值：静态直接返回；动态返回缓存值（没有缓存则 undefined）。 */
export function attributeValue(entity: Entity, name: string): JsonValue | undefined {
  const attribute = getAttribute(entity, name)
  if (attribute === undefined) return undefined
  return attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
}

export function requiredAttribute(entity: Entity, name: string): Attribute {
  const attribute = getAttribute(entity, name)
  if (attribute === undefined || !attribute.required) {
    throw new Error(`实体 ${entity.id} 缺少必填属性 ${name}`)
  }
  return attribute
}

export function statusOf(entity: Entity): StateStatus | undefined {
  const value = attributeValue(entity, 'status')
  return typeof value === 'string' && isStateStatus(value) ? value : undefined
}

export function titleOf(entity: Entity): string | undefined {
  const value = attributeValue(entity, 'title')
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function categoryOf(entity: Entity): Category | undefined {
  const value = attributeValue(entity, 'category')
  return typeof value === 'string' && isCategory(value) ? value : undefined
}

export function scopeOf(entity: Entity): Scope {
  const value = attributeValue(entity, 'scope')
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>
    if (record['kind'] === 'project' && typeof record['projectKey'] === 'string') {
      return { kind: 'project', projectKey: record['projectKey'] }
    }
  }
  return { kind: 'global' }
}

export function isArchived(entity: Entity): boolean {
  return entity.archivedAt !== undefined
}

export function isRetrievable(entity: Entity): boolean {
  return entity.isCurrent && entity.archivedAt === undefined
}
