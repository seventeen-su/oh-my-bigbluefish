/**
 * 中文 bigram 预切 + 英文/数字词。
 *
 * 写入时把同一份 token 存进 search_text，检索时用同样的规则生成查询词；
 * 这样 PostgreSQL 的 `simple` 全文配置不需要中文分词器。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export function normalizeText(input: string): string {
  return input.normalize('NFKC').trim().toLowerCase()
}

/** 把一段文本切成：CJK 单字 + 相邻 bigram + 非 CJK 词。 */
export function tokenize(input: string, maxTokens = 512): string[] {
  const text = normalizeText(input)
  if (text.length === 0) return []
  const tokens: string[] = []
  let latin: string[] = []

  const flushLatin = () => {
    if (latin.length > 0) {
      tokens.push(latin.join(''))
      latin = []
    }
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (CJK.test(ch)) {
      flushLatin()
      tokens.push(ch)
      const next = text[i + 1]
      if (next !== undefined && CJK.test(next)) tokens.push(ch + next)
      continue
    }
    if (/\s/.test(ch)) {
      flushLatin()
      continue
    }
    if (/[\p{L}\p{N}]/u.test(ch)) {
      latin.push(ch)
      continue
    }
    flushLatin()
  }
  flushLatin()

  const unique: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.length === 0 || seen.has(token)) continue
    seen.add(token)
    unique.push(token)
    if (unique.length >= maxTokens) break
  }
  return unique
}

export function searchText(input: string, maxTokens = 2048): string {
  return tokenize(input, maxTokens).join(' ')
}

/** 粗略 token 估算：中文按 1.5 字/token，英文按 4 字符/token。 */
export function estimateTokens(input: string): number {
  if (input.length === 0) return 0
  let cjk = 0
  for (const ch of input) if (CJK.test(ch)) cjk += 1
  const other = Math.max(0, input.length - cjk)
  return Math.ceil(cjk / 1.5 + other / 4)
}

/** 从文本中抽取路径/标识符/错误码，供 T1 触发查询。 */
export function extractQuerySignals(input: string): {
  paths: string[]
  identifiers: string[]
  errorCodes: string[]
} {
  const paths = [...input.matchAll(/(?:[A-Za-z]:\\[^\s"'`]+|\/(?:[\w.-]+\/)+[\w.-]+)/g)]
    .map(match => match[0])
    .slice(0, 12)
  const identifiers = [...input.matchAll(/\b[A-Za-z_][A-Za-z0-9_.-]{2,}\b/g)]
    .map(match => match[0])
    .filter(value => !/^(the|and|for|with|this|that|from|into)$/i.test(value))
    .slice(0, 24)
  const errorCodes = [...input.matchAll(/\b(?:E[A-Z0-9_]{3,}|[A-Z]+_[A-Z0-9_]{3,}|[45]\d{2})\b/g)]
    .map(match => match[0])
    .slice(0, 12)
  return { paths, identifiers, errorCodes }
}
