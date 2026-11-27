/**
 * 出站地址与 allowlist 的纯分类逻辑（EgressBroker 的首层/逐 IP 校验共用）。
 *
 * 这里没有 IO：主机名规范化、私网/环回/保留段判定、allowlist 匹配都是纯函数，
 * 传输层与 DNS/策略编排在 `egress.ts`。单测可以直接覆盖每一类地址而不起网络。
 */

export type EgressFamily = 4 | 6

export interface EgressAddress {
  readonly address: string
  readonly family: EgressFamily
}

export interface AddressClassification {
  readonly family: EgressFamily
  /** 规范化后的地址（IPv4 点分十进制；IPv6 展开十六进制）。 */
  readonly canonical: string
  /** 被拒绝的原因；缺省表示公网可用地址。 */
  readonly blocked?: string
}

/** 统一主机名：小写、去 IPv6 方括号、去末尾点、拒绝残留分隔符。 */
export function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  host = host.replace(/\.+$/u, '')
  if (host.includes('%') || host.includes('/') || host.includes('\\') || host.includes('\0')) return ''
  return host
}

/** 明显不能出站的主机名（字面 IP 由 classifyAddress 判定）。 */
export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (host.length === 0) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return true
  if (BLOCKED_HOST_NAMES.includes(host)) return true
  const classified = classifyAddress(host)
  if (classified !== undefined) return classified.blocked !== undefined
  // 单标签主机名（无点、无冒号）几乎都是内网名字：intranet、metadata、机器名。
  if (!host.includes('.') && !host.includes(':')) return true
  return false
}

const BLOCKED_HOST_SUFFIXES = [
  '.local',
  '.localdomain',
  '.internal',
  '.home.arpa',
  '.lan',
  '.intranet',
  '.corp',
] as const

const BLOCKED_HOST_NAMES: readonly string[] = [
  'metadata',
  'instance-data',
  'metadata.google.internal',
  'metadata.azure.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
]

/** 把地址字符串解析成 family + 规范化地址 + 拒绝原因；无法解析返回 undefined。 */
export function classifyAddress(value: string): AddressClassification | undefined {
  let text = value.trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (text.length === 0) return undefined
  if (text.includes(':')) {
    const groups = expandIpv6(text)
    if (groups === undefined) return undefined
    return classifyIpv6(groups)
  }
  const octets = parseIpv4Loose(text)
  if (octets === undefined) return undefined
  return classifyIpv4(octets)
}

/** 是否属于不可出站的地址（私网/环回/链路本地/保留等）；无法解析也视为不可出站。 */
export function isBlockedAddress(value: string): boolean {
  const classified = classifyAddress(value)
  return classified === undefined || classified.blocked !== undefined
}

function classifyIpv4(octets: readonly number[]): AddressClassification {
  const [a = -1, b = -1, c = -1, d = -1] = octets
  const canonical = `${a}.${b}.${c}.${d}`
  const blocked = blockedIpv4Reason(a, b, c, d)
  return blocked === undefined ? { family: 4, canonical } : { family: 4, canonical, blocked }
}

function blockedIpv4Reason(a: number, b: number, c: number, d: number): string | undefined {
  if (a === 0) return 'unspecified'
  if (a === 10) return 'private'
  if (a === 127) return 'loopback'
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade-nat'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 192 && b === 0 && c === 0) return 'reserved'
  if (a === 192 && b === 0 && c === 2) return 'documentation'
  if (a === 192 && b === 88 && c === 99) return 'reserved'
  if (a === 198 && b >= 18 && b <= 19) return 'benchmark'
  if (a === 198 && b === 51 && c === 100) return 'documentation'
  if (a === 203 && b === 0 && c === 113) return 'documentation'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'broadcast'
  return undefined
}

function classifyIpv6(groups: readonly number[]): AddressClassification {
  const g = groups
  const canonical = canonicalIpv6(g)
  if (g.every(group => group === 0)) return { family: 6, canonical, blocked: 'unspecified' }
  if (g.slice(0, 7).every(group => group === 0) && g[7] === 1) {
    return { family: 6, canonical, blocked: 'loopback' }
  }
  // IPv4 映射（::ffff:a.b.c.d）与已废弃的 IPv4 兼容（::a.b.c.d）都要按内嵌 IPv4 判定。
  if (g.slice(0, 5).every(group => group === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const high = g[6] ?? 0
    const low = g[7] ?? 0
    if (high !== 0 || low !== 0) {
      const embedded = classifyIpv4([high >>> 8, high & 0xff, low >>> 8, low & 0xff])
      if (embedded.blocked !== undefined) {
        return { family: 6, canonical, blocked: `IPv4 映射地址（${embedded.blocked}）` }
      }
      return { family: 6, canonical }
    }
  }
  const first = g[0] ?? 0
  if ((first & 0xfe00) === 0xfc00) return { family: 6, canonical, blocked: 'unique-local' }
  if ((first & 0xffc0) === 0xfe80) return { family: 6, canonical, blocked: 'link-local' }
  if ((first & 0xff00) === 0xff00) return { family: 6, canonical, blocked: 'multicast' }
  const second = g[1] ?? 0
  if (first === 0x2001 && second === 0x0db8) return { family: 6, canonical, blocked: 'documentation' }
  if (first === 0x2002) return { family: 6, canonical, blocked: '6to4' }
  if (first === 0x0064 && second === 0xff9b) return { family: 6, canonical, blocked: 'nat64' }
  if (first === 0x2001 && second === 0x0000) return { family: 6, canonical, blocked: 'teredo' }
  if ((first & 0xe000) === 0x2000) return { family: 6, canonical }
  return { family: 6, canonical, blocked: 'reserved' }
}

function canonicalIpv6(groups: readonly number[]): string {
  return groups.map(group => group.toString(16)).join(':')
}

function expandIpv6(value: string): number[] | undefined {
  let text = value
  // 末尾内嵌 IPv4（::ffff:127.0.0.1）先展开成两个 hex group。
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text)
  if (embedded !== null) {
    const head = embedded[1]
    const tail = embedded[2]
    if (head === undefined || tail === undefined) return undefined
    const octets = parseIpv4Loose(tail)
    if (octets === undefined || octets.length !== 4) return undefined
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0)
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
    text = `${head}${high.toString(16)}:${low.toString(16)}`
  }
  const doubleColon = text.indexOf('::')
  if (doubleColon >= 0 && doubleColon !== text.lastIndexOf('::')) return undefined
  const headText = doubleColon >= 0 ? text.slice(0, doubleColon) : text
  const tailText = doubleColon >= 0 ? text.slice(doubleColon + 2) : ''
  const head = splitIpv6Groups(headText)
  const tail = splitIpv6Groups(tailText)
  if (head === undefined || tail === undefined) return undefined
  if (doubleColon < 0) return head.length === 8 ? head : undefined
  const missing = 8 - head.length - tail.length
  if (missing < 1) return undefined
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

function splitIpv6Groups(text: string): number[] | undefined {
  if (text.length === 0) return []
  const parts = text.split(':')
  const groups: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined
    groups.push(Number.parseInt(part, 16))
  }
  return groups
}

/** 兼容 inet_aton 的 1–4 段写法（十进制/十六进制/八进制），返回四段十进制。 */
function parseIpv4Loose(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length === 0 || parts.length > 4) return undefined
  const numbers: number[] = []
  for (const part of parts) {
    if (!/^(?:0x[0-9a-f]+|\d+)$/u.test(part)) return undefined
    let numeric: number
    if (part.startsWith('0x')) {
      numeric = Number.parseInt(part.slice(2), 16)
    } else if (part.length > 1 && part.startsWith('0')) {
      numeric = /^[0-7]+$/u.test(part) ? Number.parseInt(part, 8) : Number.parseInt(part, 10)
    } else {
      numeric = Number.parseInt(part, 10)
    }
    if (!Number.isFinite(numeric) || numeric < 0) return undefined
    numbers.push(numeric)
  }
  const last = numbers[numbers.length - 1]
  if (last === undefined) return undefined
  if (numbers.length === 1) {
    if (last > 0xffffffff) return undefined
    return [(last >>> 24) & 0xff, (last >>> 16) & 0xff, (last >>> 8) & 0xff, last & 0xff]
  }
  for (let index = 0; index < numbers.length - 1; index += 1) {
    const part = numbers[index]
    if (part === undefined || part > 0xff) return undefined
  }
  const maxLast = numbers.length === 2 ? 0xffffff : numbers.length === 3 ? 0xffff : 0xff
  if (last > maxLast) return undefined
  if (numbers.length === 2) {
    const [a, b] = numbers as [number, number]
    return [a, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff]
  }
  if (numbers.length === 3) {
    const [a, b, c] = numbers as [number, number, number]
    return [a, b, (c >>> 8) & 0xff, c & 0xff]
  }
  return numbers
}

/**
 * allowlist 支持三种写法（大小写不敏感、忽略末尾点）：
 * - `api.github.com`：主机精确匹配（不含端口，任何端口都算命中）；
 * - `*.example.com`：只匹配子域（不含 apex）；
 * - `https://api.github.com/v3`：协议+主机（含端口）相等，路径按 `/` 边界前缀匹配。
 *
 * 路径比较前先做一次解码 + `.`/`..` 归一：`/v1/..%2fprivate` 会被归一成 `/private`，
 * 不能靠编码绕过 URL 前缀 allowlist。
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
    if (normalizeAuthority(base.host) !== normalizeAuthority(url.host)) return false
    const basePath = decodedPath(base.pathname)
    if (basePath === undefined) return false
    if (basePath === '/') return true
    const requestPath = decodedPath(url.pathname)
    if (requestPath === undefined) return false
    return requestPath === basePath || requestPath.startsWith(`${basePath}/`)
  }
  if (pattern.startsWith('*.')) {
    const suffix = normalizeHostname(pattern.slice(2))
    if (suffix.length === 0) return false
    const host = normalizeHostname(url.hostname)
    return host.length > suffix.length && host.endsWith(`.${suffix}`)
  }
  if (pattern.startsWith('*')) return false
  const expected = normalizeAuthority(pattern)
  if (expected.length === 0) return false
  // 只有 `host:port` 或 `[v6]:port` 才按 host（含端口）比较；纯 IPv6 里的冒号不是端口。
  if (/^(?:\[[^\]]+\]|[^:]+):\d+$/u.test(pattern)) return normalizeAuthority(url.host) === expected
  return normalizeHostname(url.hostname) === expected
}

/** 去 IPv6 方括号、去末尾点、小写；用于 host:port 与纯主机比较。 */
function normalizeAuthority(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[/gu, '')
    .replace(/\]/gu, '')
    .replace(/\.+$/u, '')
}

/** 解码 + 去掉 `.`/`..` 的路径归一；解码失败或越出根返回 undefined。 */
function decodedPath(pathname: string): string | undefined {
  let decoded = pathname
  // 多次解码：`%252f` 这类双重编码在代理/框架二次解码后会变成路径分隔符，
  // 单次解码后仍残留 `%` 就再解一次，直到稳定或超过上限。
  for (let round = 0; round < 3; round += 1) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      return undefined
    }
    if (!decoded.includes('%')) break
  }
  if (decoded.includes('\0')) return undefined
  const segments = decoded.replace(/\\/gu, '/').split('/')
  const stack: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return undefined
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return `/${stack.join('/')}`
}
