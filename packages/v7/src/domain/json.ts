/** 任意 JSON 值。属性值只允许这个范围，动态值 spec 另行建模。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1))
  if (isPlainObject(value)) return Object.values(value).every(item => isJsonValue(item, depth + 1))
  return false
}

/** 空字符串、空数组、空对象、null 都算空白；0/false 不算。 */
export function isNonEmptyJson(value: JsonValue): boolean {
  if (value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

export function jsonSize(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

/**
 * 规范 JSON 字符串：对象键递归排序、数组保持顺序。
 *
 * 用于比较“同一份配置/属性值是否变化”。`jsonb` 会按 key 长度重排对象键，
 * 不能依赖 `JSON.stringify` 的插入顺序（否则同 spec 在库内往返后被当成变化）。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 语义相等：按规范 JSON 比较（对象键顺序不敏感）。 */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}
