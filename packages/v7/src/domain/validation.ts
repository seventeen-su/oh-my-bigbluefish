import {
  CATEGORIES,
  CATEGORY_LABELS,
  STATE_STATUSES,
  STATUS_LABELS,
  isCategory,
  isStateStatus,
  type Attribute,
  type Category,
  type DynamicSpec,
  type RawAttributeValue,
  type Scope,
  type StateStatus,
  type ValidationIssue,
  type ValidationResult,
  type WriteEntityInput,
  scopeKey,
} from './entity.js'
import { isJsonValue, isNonEmptyJson, isPlainObject, jsonSize, type JsonValue } from './json.js'
import { isId, newId } from './ids.js'

export const MAX_ATTRIBUTES = 128
export const MAX_ATTRIBUTE_NAME = 120
export const MAX_ATTRIBUTE_BYTES = 256 * 1024
export const MAX_TOTAL_ATTRIBUTE_BYTES = 1024 * 1024
export const MAX_TITLE = 500
export const MAX_CODE_BYTES = 32 * 1024
export const MAX_TEMPLATE_BYTES = 16 * 1024

export const REQUIRED_NAMES = ['id', 'category', 'scope', 'title', 'status', 'time', 'group'] as const

export interface NormalizedWrite {
  readonly id: string
  readonly kind: 'memory' | 'state' | 'chain'
  readonly scope: Scope
  readonly origin: string
  readonly confidence?: number
  readonly pinned: boolean
  readonly attributes: readonly Attribute[]
  readonly group?: readonly string[]
}

export interface NormalizedPatch {
  readonly id: string
  readonly expectedRevision?: number
  readonly properties: Readonly<Record<string, RawAttributeValue | null>>
  readonly pinned?: boolean
  readonly confidence?: number
}

function issue(field: string, message: string): ValidationIssue {
  return { field, message }
}

function normalizeScope(input: unknown): Scope | undefined {
  if (!isPlainObject(input)) return undefined
  if (input['kind'] === 'global' && Object.keys(input).length === 1) return { kind: 'global' }
  if (input['kind'] === 'project' && typeof input['projectKey'] === 'string' && input['projectKey'].trim().length > 0) {
    return { kind: 'project', projectKey: input['projectKey'].trim() }
  }
  return undefined
}

function normalizeTime(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.trim().length === 0) return undefined
  const millis = Date.parse(input)
  if (!Number.isFinite(millis)) return undefined
  return new Date(millis).toISOString()
}

function normalizeTitle(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const title = input.trim()
  if (title.length === 0 || title.length > MAX_TITLE) return undefined
  return title
}

function normalizeGroup(input: unknown, selfId: string): string[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined
  const unique: string[] = []
  for (const item of input) {
    if (typeof item !== 'string' || !isId(item)) return undefined
    if (item === selfId) return undefined
    if (!unique.includes(item)) unique.push(item)
  }
  return unique.length > 0 ? unique : undefined
}

export function normalizeDynamicSpec(spec: unknown, path: string, errors: ValidationIssue[], depth = 0): DynamicSpec | undefined {
  if (depth > 8) {
    errors.push(issue(path, '动态值嵌套超过 8 层'))
    return undefined
  }
  if (!isPlainObject(spec)) {
    errors.push(issue(path, '动态值必须是对象'))
    return undefined
  }
  const kind = spec['kind']
  if (kind === 'ref') {
    if (typeof spec['entityId'] !== 'string' || !isId(spec['entityId'])) {
      errors.push(issue(`${path}.entityId`, '必须是合法实体 id'))
      return undefined
    }
    if (spec['attr'] !== undefined && (typeof spec['attr'] !== 'string' || spec['attr'].trim().length === 0)) {
      errors.push(issue(`${path}.attr`, '必须是非空字符串'))
      return undefined
    }
    if (spec['fallback'] !== undefined && !isJsonValue(spec['fallback'])) {
      errors.push(issue(`${path}.fallback`, '必须是 JSON 值'))
      return undefined
    }
    return {
      kind: 'ref',
      entityId: spec['entityId'],
      ...(typeof spec['attr'] === 'string' ? { attr: spec['attr'] } : {}),
      ...(spec['fallback'] !== undefined ? { fallback: spec['fallback'] as JsonValue } : {}),
    }
  }
  if (kind === 'template') {
    if (typeof spec['template'] !== 'string' || new TextEncoder().encode(spec['template']).length > MAX_TEMPLATE_BYTES) {
      errors.push(issue(`${path}.template`, `模板必须是不超过 ${MAX_TEMPLATE_BYTES} 字节的字符串`))
      return undefined
    }
    if (spec['refs'] !== undefined) {
      if (!Array.isArray(spec['refs'])) {
        errors.push(issue(`${path}.refs`, '必须是数组'))
        return undefined
      }
      for (const [index, ref] of spec['refs'].entries()) {
        if (!isPlainObject(ref) || typeof ref['entityId'] !== 'string' || !isId(ref['entityId'])) {
          errors.push(issue(`${path}.refs[${index}].entityId`, '必须是合法实体 id'))
          return undefined
        }
      }
    }
    return {
      kind: 'template',
      template: spec['template'],
      ...(Array.isArray(spec['refs'])
        ? {
            refs: spec['refs'].map(ref => {
              const record = ref as Record<string, unknown>
              return {
                entityId: record['entityId'] as string,
                ...(typeof record['attr'] === 'string' ? { attr: record['attr'] } : {}),
                ...(typeof record['as'] === 'string' ? { as: record['as'] } : {}),
              }
            }),
          }
        : {}),
    }
  }
  if (kind === 'file') {
    if (typeof spec['path'] !== 'string' || spec['path'].trim().length === 0) {
      errors.push(issue(`${path}.path`, '必须是非空路径'))
      return undefined
    }
    const extract = spec['extract']
    if (extract !== undefined && !isPlainObject(extract)) {
      errors.push(issue(`${path}.extract`, '必须是对象'))
      return undefined
    }
    if (isPlainObject(extract) && extract['kind'] === 'regex') {
      if (typeof extract['source'] !== 'string' || extract['source'].length === 0) {
        errors.push(issue(`${path}.extract.source`, '正则不能为空'))
        return undefined
      }
    }
    return {
      kind: 'file',
      path: spec['path'],
      ...(isPlainObject(extract) ? { extract: extract as never } : {}),
    }
  }
  if (kind === 'regex') {
    if (typeof spec['source'] !== 'string' || spec['source'].length === 0) {
      errors.push(issue(`${path}.source`, '正则不能为空'))
      return undefined
    }
    try {
      new RegExp(spec['source'], typeof spec['flags'] === 'string' ? spec['flags'] : undefined)
    } catch (error) {
      errors.push(issue(`${path}.source`, `正则非法：${error instanceof Error ? error.message : String(error)}`))
      return undefined
    }
    const input = spec['input']
    if (isPlainObject(input) && input['kind'] === 'literal' && typeof input['value'] === 'string') {
      return {
        kind: 'regex',
        source: spec['source'],
        ...(typeof spec['flags'] === 'string' ? { flags: spec['flags'] } : {}),
        ...(typeof spec['group'] === 'number' ? { group: spec['group'] } : {}),
        input: { kind: 'literal', value: input['value'] },
      }
    }
    if (isPlainObject(input)) {
      const ref = normalizeDynamicSpec({ ...input, kind: 'ref' }, `${path}.input`, errors, depth + 1)
      if (ref?.kind !== 'ref') return undefined
      return {
        kind: 'regex',
        source: spec['source'],
        ...(typeof spec['flags'] === 'string' ? { flags: spec['flags'] } : {}),
        ...(typeof spec['group'] === 'number' ? { group: spec['group'] } : {}),
        input: ref,
      }
    }
    errors.push(issue(`${path}.input`, '必须是 ref 或 literal'))
    return undefined
  }
  if (kind === 'code') {
    if (typeof spec['source'] !== 'string' || spec['source'].trim().length === 0) {
      errors.push(issue(`${path}.source`, '代码不能为空'))
      return undefined
    }
    if (new TextEncoder().encode(spec['source']).length > MAX_CODE_BYTES) {
      errors.push(issue(`${path}.source`, `代码不能超过 ${MAX_CODE_BYTES} 字节`))
      return undefined
    }
    return {
      kind: 'code',
      source: spec['source'],
      ...(typeof spec['timeoutMs'] === 'number' ? { timeoutMs: Math.max(1, Math.min(1000, spec['timeoutMs'])) } : {}),
      ...(typeof spec['memoryMb'] === 'number' ? { memoryMb: Math.max(1, Math.min(64, spec['memoryMb'])) } : {}),
    }
  }
  if (kind === 'task') {
    if (spec['source'] !== 'subagent' && spec['source'] !== 'team' && spec['source'] !== 'job') {
      errors.push(issue(`${path}.source`, '必须是 subagent/team/job'))
      return undefined
    }
    if (typeof spec['id'] !== 'string' || spec['id'].trim().length === 0) {
      errors.push(issue(`${path}.id`, '必须是非空 id'))
      return undefined
    }
    return {
      kind: 'task',
      source: spec['source'],
      id: spec['id'],
      ...(typeof spec['field'] === 'string' ? { field: spec['field'] } : {}),
    }
  }
  if (kind === 'url') {
    if (typeof spec['url'] !== 'string' || !/^https?:\/\//i.test(spec['url'])) {
      errors.push(issue(`${path}.url`, '必须是 http(s) URL'))
      return undefined
    }
    return {
      kind: 'url',
      url: spec['url'],
      ...(typeof spec['jsonPath'] === 'string' ? { jsonPath: spec['jsonPath'] } : {}),
      ...(Array.isArray(spec['allowlist']) && spec['allowlist'].every(item => typeof item === 'string')
        ? { allowlist: spec['allowlist'] as string[] }
        : {}),
    }
  }
  errors.push(issue(`${path}.kind`, '未知动态值类型'))
  return undefined
}

export function normalizeRawValue(raw: RawAttributeValue, path: string, errors: ValidationIssue[]): Attribute['value'] | undefined {
  if (isPlainObject(raw) && '$dynamic' in raw) {
    if (Object.keys(raw).length !== 1) {
      errors.push(issue(path, '$dynamic 必须是对象里唯一的键'))
      return undefined
    }
    const spec = normalizeDynamicSpec(raw['$dynamic'], `${path}.$dynamic`, errors)
    return spec === undefined ? undefined : { kind: 'dynamic', spec }
  }
  if (!isJsonValue(raw)) {
    errors.push(issue(path, '值必须是 JSON'))
    return undefined
  }
  if (jsonSize(raw) > MAX_ATTRIBUTE_BYTES) {
    errors.push(issue(path, `值超过 ${MAX_ATTRIBUTE_BYTES} 字节`))
    return undefined
  }
  return { kind: 'static', value: raw }
}

function requiredAttributes(input: WriteEntityInput, id: string): Array<{ name: string; value: JsonValue }> {
  const base = [
    { name: 'id', value: id },
    { name: 'scope', value: input.scope as unknown as JsonValue },
  ]
  if (input.kind === 'memory') {
    return [...base, { name: 'category', value: input.category }]
  }
  if (input.kind === 'state') {
    return [
      ...base,
      { name: 'title', value: input.title },
      { name: 'status', value: input.status },
      { name: 'time', value: input.time },
    ]
  }
  return [
    ...base,
    { name: 'title', value: input.title },
    { name: 'group', value: input.group as unknown as JsonValue },
  ]
}

function validateScope(input: unknown, errors: ValidationIssue[]): Scope | undefined {
  const scope = normalizeScope(input)
  if (scope === undefined) {
    errors.push(issue('scope', '必须是 { kind: "global" } 或 { kind: "project", projectKey: "..." }'))
    return undefined
  }
  if (scope.kind === 'project' && scopeKey(scope).length > 1024) {
    errors.push(issue('scope.projectKey', '项目路径过长'))
    return undefined
  }
  return scope
}

export function normalizeWrite(input: WriteEntityInput, generatedId?: string): ValidationResult<NormalizedWrite> {
  const errors: ValidationIssue[] = []
  const kind = input.kind
  const scope = validateScope(input.scope, errors)
  if (scope === undefined) return { ok: false, errors }

  let id = input.id ?? generatedId
  if (id === undefined) id = newId(kind === 'memory' ? 'memory' : kind === 'state' ? 'state' : 'chain')
  if (!isId(id)) errors.push(issue('id', '不是合法的 OMB id'))
  const prefix = kind === 'memory' ? 'mem_' : kind === 'state' ? 'st_' : 'ch_'
  if (!id.startsWith(prefix)) errors.push(issue('id', `id 前缀必须是 ${prefix}`))

  let title: string | undefined
  let status: StateStatus | undefined
  let time: string | undefined
  let group: string[] | undefined

  if (kind === 'memory') {
    if (!isCategory(input.category)) errors.push(issue('category', `必须是 ${CATEGORIES.join('/')}`))
  } else if (kind === 'state') {
    title = normalizeTitle(input.title)
    if (title === undefined) errors.push(issue('title', `必须是 1-${MAX_TITLE} 字符`))
    if (!isStateStatus(input.status)) errors.push(issue('status', `必须是 ${STATE_STATUSES.join('/')}`))
    else status = input.status
    time = normalizeTime(input.time)
    if (time === undefined) errors.push(issue('time', '必须是可解析的时间'))
  } else {
    title = normalizeTitle(input.title)
    if (title === undefined) errors.push(issue('title', `必须是 1-${MAX_TITLE} 字符`))
    group = normalizeGroup(input.group, id)
    if (group === undefined) errors.push(issue('group', '必须是非空、去重、合法的实体 id 列表，且不能包含自己'))
  }

  if (input.confidence !== undefined && (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1)) {
    errors.push(issue('confidence', '必须在 0 到 1 之间'))
  }
  if (input.origin !== undefined && (typeof input.origin !== 'string' || input.origin.trim().length === 0)) {
    errors.push(issue('origin', '必须是非空字符串'))
  }

  const requiredValues = requiredAttributes({ ...input, scope, ...(title !== undefined ? { title } : {}), ...(status !== undefined ? { status } : {}), ...(time !== undefined ? { time } : {}) } as WriteEntityInput, id)
  const attributes: Attribute[] = requiredValues.map((item, index) => ({
    name: item.name,
    ordinal: index,
    value: { kind: 'static', value: item.value },
    required: true,
    source: input.origin ?? 'model',
  }))

  const optional = input.attrs ?? {}
  const optionalNames = Object.keys(optional)
  if (optionalNames.length > MAX_ATTRIBUTES) errors.push(issue('attrs', `最多 ${MAX_ATTRIBUTES} 个可选属性`))
  let totalBytes = 0
  let nonEmpty = 0
  let nextOrdinal = attributes.length
  const reserved = kind === 'memory'
    ? new Set(['id', 'category', 'scope'])
    : kind === 'state'
      ? new Set(['id', 'scope', 'title', 'status', 'time'])
      : new Set(['id', 'scope', 'title', 'group'])

  for (const name of optionalNames.sort()) {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_ATTRIBUTE_NAME) {
      errors.push(issue(`attrs.${name}`, `属性名必须是 1-${MAX_ATTRIBUTE_NAME} 字符`))
      continue
    }
    if (reserved.has(trimmed)) {
      errors.push(issue(`attrs.${name}`, '必填属性请用顶层字段，不要在 attrs 里重复'))
      continue
    }
    if (trimmed.startsWith('$')) {
      errors.push(issue(`attrs.${name}`, '属性名不能以 $ 开头'))
      continue
    }
    const value = normalizeRawValue(optional[name] as RawAttributeValue, `attrs.${name}`, errors)
    if (value === undefined) continue
    if (value.kind === 'static') {
      if (isNonEmptyJson(value.value)) nonEmpty += 1
      totalBytes += jsonSize(value.value)
    } else {
      nonEmpty += 1
      totalBytes += new TextEncoder().encode(JSON.stringify(value.spec)).length
    }
    attributes.push({
      name: trimmed,
      ordinal: nextOrdinal,
      value,
      required: false,
      source: input.origin ?? 'model',
    })
    nextOrdinal += 1
  }

  if (totalBytes > MAX_TOTAL_ATTRIBUTE_BYTES) errors.push(issue('attrs', `属性总量超过 ${MAX_TOTAL_ATTRIBUTE_BYTES} 字节`))
  if (kind === 'memory' && nonEmpty === 0) errors.push(issue('attrs', '记忆至少需要一个非空可选属性'))

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      id,
      kind,
      scope,
      origin: input.origin ?? 'model',
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      pinned: input.pinned ?? false,
      attributes,
      ...(group !== undefined ? { group } : {}),
    },
  }
}

/** 状态是已完成/已丢弃时自动归档；其余状态不自动归档。 */
export function shouldAutoArchive(status: StateStatus): boolean {
  return status === 'completed' || status === 'discarded'
}

export function labelForStatus(status: StateStatus): string {
  return STATUS_LABELS[status]
}

export function labelForCategory(category: Category): string {
  return CATEGORY_LABELS[category]
}

/** 从属性值派生全文检索文本；排除 id/scope/group 等噪声。 */
export function deriveSearchText(attributes: readonly Attribute[]): string {
  const parts: string[] = []
  for (const attribute of attributes) {
    if (attribute.name === 'id' || attribute.name === 'scope' || attribute.name === 'group') continue
    const value = attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
    if (value === undefined) continue
    if (attribute.name === 'category' && typeof value === 'string' && isCategory(value)) {
      parts.push(value, CATEGORY_LABELS[value])
      continue
    }
    if (attribute.name === 'status' && typeof value === 'string' && isStateStatus(value)) {
      parts.push(value, STATUS_LABELS[value])
      continue
    }
    collectStrings(value, parts)
  }
  return parts.join(' ').slice(0, 20_000)
}

function collectStrings(value: JsonValue, out: string[], depth = 0): void {
  if (depth > 12) return
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$dynamic') continue
      collectStrings(item as JsonValue, out, depth + 1)
    }
  }
}

const PATH_PATTERN = /(?:[A-Za-z]:\\[^\s"'`]+|\/(?:[\w.-]+\/)+[\w.-]+)/g

/** 写入时派生触发键：路径/工具/错误/实体/正则。 */
export interface DerivedReference {
  readonly sourceAttrName: string
  readonly sourceOrdinal: number
  readonly targetEntityId: string
  readonly targetAttrName?: string
  readonly kind: 'ref' | 'template' | 'code'
}

/** 从动态值 spec 中静态提取引用；运行时解析仍由 DynamicResolver 负责。 */
export function deriveReferences(attributes: readonly Attribute[]): DerivedReference[] {
  const result: DerivedReference[] = []
  const seen = new Set<string>()
  const add = (attr: Attribute, targetEntityId: string, targetAttrName: string | undefined, kind: 'ref' | 'template' | 'code'): void => {
    const key = `${attr.name}:${attr.ordinal}:${targetEntityId}:${targetAttrName ?? ''}:${kind}`
    if (seen.has(key)) return
    seen.add(key)
    result.push({
      sourceAttrName: attr.name,
      sourceOrdinal: attr.ordinal,
      targetEntityId,
      ...(targetAttrName !== undefined ? { targetAttrName } : {}),
      kind,
    })
  }
  const scan = (attr: Attribute, spec: DynamicSpec): void => {
    if (spec.kind === 'ref') {
      add(attr, spec.entityId, spec.attr, 'ref')
      return
    }
    if (spec.kind === 'template') {
      for (const ref of spec.refs ?? []) add(attr, ref.entityId, ref.attr, 'template')
      return
    }
    if (spec.kind === 'regex') {
      if (spec.input.kind === 'ref') add(attr, spec.input.entityId, spec.input.attr, 'ref')
      return
    }
    if (spec.kind === 'code') {
      for (const match of spec.source.matchAll(/\bref\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?\s*\)/g)) {
        const id = match[1]
        if (id !== undefined && isId(id)) add(attr, id, match[2], 'code')
      }
    }
  }
  for (const attribute of attributes) {
    if (attribute.value.kind === 'dynamic') scan(attribute, attribute.value.spec)
  }
  return result
}

/**
 * 正则触发键的存储编码。`trigger_key.key` 是文本列，flags 必须随 source 一起落库：
 * - 无 flags 时 key 就是 source（兼容既有行，保持可读）；
 * - 有 flags 时存两元素 JSON 数组，避免 source 里出现分隔符时无法还原。
 * 正则只在应用层执行，由 store 用 `decodeRegexTriggerKey` 还原后编译（SPEC §7.1）。
 */
export interface RegexTriggerKey {
  readonly source: string
  readonly flags?: string
}

const REGEX_KEY_ENCODED_PREFIX = '["'

export function encodeRegexTriggerKey(source: string, flags?: string): string {
  return flags === undefined || flags.length === 0 ? source : JSON.stringify([source, flags])
}

export function decodeRegexTriggerKey(key: string): RegexTriggerKey {
  if (!key.startsWith(REGEX_KEY_ENCODED_PREFIX)) return { source: key }
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    // 旧格式：整串就是 source（例如以 `["` 开头的字符类正则）。
    return { source: key }
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return { source: key }
  const [source, flags] = parsed as unknown[]
  if (typeof source !== 'string' || source.length === 0 || typeof flags !== 'string') return { source: key }
  return flags.length === 0 ? { source } : { source, flags }
}

export function deriveTriggers(attributes: readonly Attribute[]): Array<{ kind: 'path' | 'regex' | 'tool' | 'error' | 'entity' | 'text'; key: string; weight: number }> {
  const result: Array<{ kind: 'path' | 'regex' | 'tool' | 'error' | 'entity' | 'text'; key: string; weight: number }> = []
  const seen = new Set<string>()
  const push = (kind: 'path' | 'regex' | 'tool' | 'error' | 'entity' | 'text', key: string, weight: number) => {
    const normalized = key.trim()
    if (normalized.length === 0) return
    const id = `${kind}:${normalized}`
    if (seen.has(id)) return
    seen.add(id)
    result.push({ kind, key: normalized, weight })
  }

  for (const attribute of attributes) {
    // 动态 spec 的 regex/entity 触发键来自 spec 本身，写入时动态属性还没有 cachedValue；
    // 必须在按值判空之前派生，否则 trigger_key 永远为空（CORE-02）。
    if (attribute.value.kind === 'dynamic') {
      if (attribute.value.spec.kind === 'regex') {
        push('regex', encodeRegexTriggerKey(attribute.value.spec.source, attribute.value.spec.flags), 1.2)
      }
      if (attribute.value.spec.kind === 'ref') push('entity', attribute.value.spec.entityId, 1)
    }
    const value = attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
    if (value === undefined) continue
    if (attribute.name === 'triggers' || attribute.name === 'trigger') {
      if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') push('text', item, 1)
      if (typeof value === 'string') push('text', value, 1)
    }
    if (typeof value === 'string') {
      for (const match of value.matchAll(PATH_PATTERN)) push('path', match[0], 1.3)
      if (attribute.name === 'tool' || attribute.name === 'tools') push('tool', value, 1.4)
      if (attribute.name === 'error' || attribute.name === 'errorCode' || attribute.name === 'errorSignature') push('error', value, 1.5)
      if ((attribute.name === 'entity' || attribute.name === 'entityId' || attribute.name === 'ref') && isId(value)) push('entity', value, 1.1)
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string') continue
        if (attribute.name === 'tools') push('tool', item, 1.4)
        if (attribute.name === 'entities') push('entity', item, 1.1)
      }
    }
  }
  // ref/template/code/regex-input 的引用目标统一落 entity 键；与 deriveReferences 同源，
  // 避免触发通道只认识 `ref` 一种动态引用。
  for (const reference of deriveReferences(attributes)) push('entity', reference.targetEntityId, 1)
  return result
}
