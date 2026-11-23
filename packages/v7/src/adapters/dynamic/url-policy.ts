import { fail, invalid, OmbFailure } from '../../domain/errors.js'
import type { UrlSpec } from '../../domain/entity.js'

/** 只依赖用到的 fetch 子集，避免把 DOM lib 拖进 v7 的类型面。 */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export interface FetchInitLike {
  readonly redirect?: 'error' | 'follow' | 'manual'
  readonly signal?: AbortSignal
}

export type FetchLike = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>

/** url 动态值的宿主闸门：默认关闭，必须显式启用并提供 allowlist。 */
export interface UrlFetchPolicy {
  readonly enabled: boolean
  readonly allowlist: readonly string[]
  /** 仅开发/测试显式打开时才允许环回与私网地址；默认拒绝。 */
  readonly allowPrivateAddresses?: boolean
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly fetch?: FetchLike
}

export const DEFAULT_URL_TIMEOUT_MS = 5000
export const DEFAULT_URL_MAX_BYTES = 256 * 1024

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
  if (host.length === 0) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true
  const ipv4 = parseIpv4(host)
  if (ipv4 !== undefined) return isPrivateIpv4(ipv4)
  if (host.includes(':')) return isPrivateIpv6(host)
  return false
}

function parseIpv4(host: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  if (match === null) return undefined
  const octets = match.slice(1).map(part => Number(part))
  if (octets.some(octet => octet > 255)) return undefined
  return octets as [number, number, number, number]
}

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true
  if (a === 192 && b === 2) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51) return true
  if (a === 203 && b === 0) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return true
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('ff')) return true
  if (normalized.startsWith('64:ff9b')) return true
  return false
}

/**
 * allowlist 支持三种写法（大小写不敏感）：
 * - `api.github.com`：主机精确匹配（不含端口，任何端口都算命中）；
 * - `*.example.com`：只匹配子域（不含 apex）；
 * - `https://api.github.com/v3`：协议+主机（含端口）相等，路径按 `/` 边界前缀匹配。
 */
export function matchesAllowlist(url: URL, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    if (matchesPattern(url, raw)) return true
  }
  return false
}

function matchesPattern(url: URL, rawPattern: string): boolean {
  const pattern = rawPattern.trim()
  if (pattern.length === 0) return false
  if (pattern.includes('://')) {
    let base: URL
    try {
      base = new URL(pattern)
    } catch {
      return false
    }
    if (base.protocol !== url.protocol) return false
    if (base.host.toLowerCase() !== url.host.toLowerCase()) return false
    if (base.pathname === '/' || base.pathname === '') return true
    if (url.pathname === base.pathname) return true
    const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
    return url.pathname.startsWith(prefix)
  }
  const lowered = pattern.toLowerCase()
  if (lowered.startsWith('*.')) {
    const suffix = lowered.slice(2)
    if (suffix.length === 0) return false
    return url.hostname.toLowerCase().endsWith(`.${suffix}`)
  }
  if (lowered.startsWith('*')) return false
  if (lowered.includes(':')) return url.host.toLowerCase() === lowered
  return url.hostname.toLowerCase() === lowered
}

/**
 * 把 UrlSpec 解析成可请求的 URL：默认关闭 → unsupported；
 * 宿主 allowlist 与属性 allowlist（若给）都命中才放行；环回/私网默认拒绝。
 */
export function assertUrlAllowed(spec: UrlSpec, policy: UrlFetchPolicy | undefined): URL {
  if (policy === undefined || policy.enabled !== true) {
    throw fail({ code: 'unsupported', message: 'url 动态值默认关闭：需要宿主显式启用并配置 allowlist' })
  }
  if (policy.allowlist.length === 0) {
    throw fail({ code: 'unsupported', message: 'url 动态值需要宿主配置 allowlist 才能读取' })
  }
  let url: URL
  try {
    url = new URL(spec.url)
  } catch {
    throw fail(invalid(`url 不是合法 URL：${spec.url}`))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail(invalid(`url 只允许 http(s)：${spec.url}`))
  }
  if (url.username !== '' || url.password !== '') {
    throw fail(invalid('url 不能携带账号或密码（凭据不应写入属性）'))
  }
  if (!matchesAllowlist(url, policy.allowlist)) {
    throw fail(invalid(`url 不在宿主 allowlist 内：${url.origin}${url.pathname}`))
  }
  if (spec.allowlist !== undefined && spec.allowlist.length > 0 && !matchesAllowlist(url, spec.allowlist)) {
    throw fail(invalid(`url 不在属性 allowlist 内：${url.origin}${url.pathname}`))
  }
  if (isBlockedHost(url.hostname) && policy.allowPrivateAddresses !== true) {
    throw fail(invalid(`url 指向环回/私网地址，已拒绝：${url.hostname}`))
  }
  return url
}

/** 取回 url 文本正文：禁重定向、带超时与外部取消、按字节上限截断失败。 */
export async function fetchUrlText(url: URL, policy: UrlFetchPolicy, signal?: AbortSignal): Promise<string> {
  const fetchImpl = policy.fetch ?? defaultFetch
  const timeoutMs = policy.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS
  const maxBytes = policy.maxBytes ?? DEFAULT_URL_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetchImpl(url.toString(), { redirect: 'error', signal: controller.signal })
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) {
        throw fail({ code: 'not-found', message: `url 返回 ${response.status}：${url.toString()}` })
      }
      throw fail({ code: 'internal', message: `url 返回 ${response.status}：${url.toString()}` })
    }
    const text = await response.text()
    if (new TextEncoder().encode(text).length > maxBytes) {
      throw fail(invalid(`url 响应超过 ${maxBytes} 字节上限：${url.toString()}`))
    }
    return text
  } catch (error) {
    if (error instanceof OmbFailure) throw error
    if (controller.signal.aborted) {
      throw fail({ code: 'internal', message: `url 请求超时或被取消：${url.toString()}` })
    }
    throw fail({ code: 'internal', message: `url 请求失败：${error instanceof Error ? error.message : String(error)}` })
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function defaultFetch(input: string, init?: FetchInitLike): Promise<FetchResponseLike> {
  const host = globalThis as unknown as { fetch?: FetchLike }
  if (typeof host.fetch !== 'function') return Promise.reject(new Error('宿主没有全局 fetch'))
  return host.fetch(input, init)
}
