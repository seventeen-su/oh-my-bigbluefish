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

/** 把 JSON 拆成可检索的纯文本片段；不改变原值。 */
export function flattenText(value: JsonValue, out: string[] = [], depth = 0): string[] {
  if (depth > 16) return out
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value)
    return out
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenText(item, out, depth + 1)
    return out
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$dynamic') continue
      out.push(key)
      flattenText(item as JsonValue, out, depth + 1)
    }
  }
  return out
}

export function jsonSize(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}
