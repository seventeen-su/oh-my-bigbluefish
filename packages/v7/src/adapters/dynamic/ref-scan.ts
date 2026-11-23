export interface CodeRef {
  readonly entityId: string
  readonly attr?: string
}

/**
 * 预扫描动态代码里的 `ctx.ref("entityId", "attr")` / `ref("entityId")` 字面量调用。
 *
 * 动态代码在沙箱里执行，宿主不能把 `DynamicContext` 函数传进去；
 * 因此这里先静态扫出所有字面量引用，由解析器预加载成纯 JSON，
 * 沙箱里的 `ctx.ref` 只是对这份数据的查表。
 * 变量参数（`ctx.ref(id)`）扫不出来，运行时会得到明确的"未预加载"错误。
 */
export function scanCodeRefs(source: string): CodeRef[] {
  const pattern = /(?:\bctx\s*\.\s*ref|\bref)\s*\(/g
  const refs: CodeRef[] = []
  const seen = new Set<string>()
  for (;;) {
    const match = pattern.exec(source)
    if (match === null) break
    const parsed = readCallArguments(source, pattern.lastIndex)
    if (parsed === undefined) continue
    const key = `${parsed.entityId}\u0000${parsed.attr ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(parsed)
  }
  return refs
}

function readCallArguments(source: string, start: number): CodeRef | undefined {
  let index = skipWhitespace(source, start)
  const firstQuote = source[index]
  if (firstQuote !== '"' && firstQuote !== "'") return undefined
  const first = readStringLiteral(source, index)
  if (first === undefined) return undefined
  index = skipWhitespace(source, first.end)
  if (source[index] === ')') return { entityId: first.value }
  if (source[index] !== ',') return undefined
  index = skipWhitespace(source, index + 1)
  const secondQuote = source[index]
  if (secondQuote === '"' || secondQuote === "'") {
    const second = readStringLiteral(source, index)
    if (second === undefined) return undefined
    index = skipWhitespace(source, second.end)
    if (source[index] !== ')') return undefined
    return { entityId: first.value, attr: second.value }
  }
  return undefined
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (index < source.length && /\s/.test(source[index] as string)) index += 1
  return index
}

function readStringLiteral(source: string, start: number): { value: string; end: number } | undefined {
  const quote = source[start]
  let index = start + 1
  let value = ''
  while (index < source.length) {
    const char = source[index] as string
    if (char === '\\') {
      const escaped = source[index + 1]
      if (escaped === undefined) return undefined
      if (escaped === 'n') value += '\n'
      else if (escaped === 't') value += '\t'
      else if (escaped === 'r') value += '\r'
      else value += escaped
      index += 2
      continue
    }
    if (char === quote) return { value, end: index + 1 }
    value += char
    index += 1
  }
  return undefined
}
