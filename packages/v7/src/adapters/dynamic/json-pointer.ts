import { fail, invalid } from '../../domain/errors.js'
import { isPlainObject, type JsonValue } from '../../domain/json.js'

export type PointerResult = { readonly found: true; readonly value: JsonValue } | { readonly found: false }

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * RFC 6901 JSON Pointer 读取。
 * 空指针返回整个文档；不合法指针（不以 `/` 开头、数组下标非规范）返回 not-found，
 * 指针语法本身错误（不以 `/` 开头）抛 invalid-input。
 */
export function resolveJsonPointer(document: JsonValue, pointer: string): PointerResult {
  if (pointer === '') return { found: true, value: document }
  if (!pointer.startsWith('/')) {
    throw fail(invalid(`JSON Pointer 必须以 / 开头：${pointer}`))
  }
  let current: JsonValue = document
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = unescapeSegment(rawSegment)
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { found: false }
      const index = Number(segment)
      if (index >= current.length) return { found: false }
      current = current[index] as JsonValue
      continue
    }
    if (isPlainObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false }
      current = current[segment] as JsonValue
      continue
    }
    return { found: false }
  }
  return { found: true, value: current }
}

/**
 * 同时接受 RFC 6901 指针（`/data/items/0`）与点号路径（`data.items[0]`）。
 * 属性里的 jsonPath / file.extract.json.pointer 都用这一处解析，避免两套语义。
 */
export function resolveJsonPath(document: JsonValue, path: string): PointerResult {
  const trimmed = path.trim()
  if (trimmed === '') return { found: true, value: document }
  if (trimmed.startsWith('/')) return resolveJsonPointer(document, trimmed)
  const segments: string[] = []
  for (const part of trimmed.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/u.exec(part)
    if (match === null) return { found: false }
    const name = match[1] ?? ''
    if (name !== '') segments.push(name)
    const indexPart = match[2] ?? ''
    for (const index of indexPart.match(/\[(\d+)\]/gu) ?? []) {
      segments.push(index.slice(1, -1))
    }
  }
  if (segments.length === 0) return { found: true, value: document }
  const pointer = `/${segments.map(segment => segment.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
  return resolveJsonPointer(document, pointer)
}
