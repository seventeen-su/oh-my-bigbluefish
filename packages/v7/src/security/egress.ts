import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import net from 'node:net'
import { fail, internal, invalid, notFound, OmbFailure } from '../domain/errors.js'
import {
  classifyAddress,
  isBlockedHostname,
  matchesAllowlist,
  normalizeHostname,
  type EgressAddress,
  type EgressFamily,
} from './egress-address.js'

/**
 * EgressBroker：url 动态值的出站闸门（Phase 4 Task 18）。
 *
 * 威胁模型：`UrlSpec.url` 来自用户属性，allowlist 命中的域名可能被入侵/被控
 * （例如 `*.nip.io` 这类解析到环回的公共后缀）。域名 allowlist 只是**首层**过滤，
 * 最终判定必须以 DNS 解析出的 IP 为准。
 *
 * 不变量：
 * - 逐 IP 校验：A/AAAA 全部解析结果都要过私网/环回/链路本地/保留段判定；
 *   任何一个 IP 被拒绝则整个请求拒绝（不能只连“看起来安全”的那一个）。
 * - 每跳重新解析：不做 DNS 缓存，避免 TTL=0 的 rebinding 用旧结果骗过校验。
 * - IP 固定：传给传输层的 `address` 是校验后的 IP，默认传输层用 `lookup` 钩子
 *   直接连这个 IP（不走二次 DNS），域名只用于 Host/SNI。
 * - 禁重定向：3xx、`redirected:true`、最终 URL 与请求 URL 不一致一律拒绝。
 * - 流式上限：边读边计字节，超过 maxBytes 立刻 abort 传输并失败，不先整体读入。
 * - 超时/取消：统一 AbortController，外部 signal 与超时都能打断 DNS/连接/读取。
 * - 所有失败都转成 OmbFailure，不把宿主/网络原始错误抛给调用方。
 */

/** 默认单次请求超时（毫秒）。 */
export const DEFAULT_EGRESS_TIMEOUT_MS = 5_000
/** 默认单次响应字节上限。 */
export const DEFAULT_EGRESS_MAX_BYTES = 256 * 1024
/** 域名解析结果条数上限；异常多的解析结果直接拒绝，避免无界连接候选。 */
const EGRESS_MAX_RESOLVED_ADDRESSES = 64

/** DNS 解析钩子；生产默认用 node:dns，测试注入桩。 */
export type EgressResolve = (hostname: string) => Promise<readonly EgressAddress[]>

export interface EgressRequest {
  /** 原始 URL（已通过 scheme/凭据/allowlist 首层校验）。 */
  readonly url: URL
  /** 已校验并固定下来的对端 IP；传输层必须连这个地址，不能再解析域名。 */
  readonly address: string
  readonly family: EgressFamily
  readonly signal: AbortSignal
  readonly headers: Readonly<Record<string, string>>
  readonly maxBytes: number
}

export interface EgressResponse {
  readonly status: number
  /** 响应体流；优先于 `text()`，用于流式计字节。 */
  readonly body?: AsyncIterable<Uint8Array | string>
  /** 没有 `body` 时的兜底取文本（仍会按字节上限拒绝）。 */
  readonly text?: () => Promise<string>
  /** 最终 URL；与请求 URL 不一致说明发生了重定向。 */
  readonly url?: string
  readonly redirected?: boolean
  readonly headers?: Readonly<Record<string, string | undefined>>
}

/** 出站传输层：只负责“连已校验 IP 并发出 GET”，不负责 DNS 与策略。 */
export interface EgressTransport {
  send(request: EgressRequest): Promise<EgressResponse>
}

export interface EgressPolicy {
  /** 域名/URL 前缀 allowlist；为空表示不放行任何 URL。 */
  readonly allowlist: readonly string[]
  /** 仅开发/测试显式打开时才允许环回与私网地址；生产必须为 false。 */
  readonly allowPrivateAddresses?: boolean
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly resolve?: EgressResolve
  readonly transport?: EgressTransport
}

class EgressAbortError extends Error {
  constructor() {
    super('egress aborted')
    this.name = 'EgressAbortError'
  }
}

export class EgressBroker {
  private readonly allowlist: readonly string[]
  private readonly allowPrivateAddresses: boolean
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly resolve: EgressResolve
  private readonly transport: EgressTransport

  constructor(policy: EgressPolicy) {
    this.allowlist = policy.allowlist
    this.allowPrivateAddresses = policy.allowPrivateAddresses === true
    this.timeoutMs = positiveOr(policy.timeoutMs, DEFAULT_EGRESS_TIMEOUT_MS)
    this.maxBytes = positiveOr(policy.maxBytes, DEFAULT_EGRESS_MAX_BYTES)
    this.resolve = policy.resolve ?? defaultResolve
    this.transport = policy.transport ?? createNodeEgressTransport()
  }

  /**
   * 取回 URL 文本正文。失败一律抛 OmbFailure；成功返回不超过 maxBytes 的字符串。
   */
  async fetchText(url: URL, signal?: AbortSignal): Promise<string> {
    assertRequestUrl(url)
    const host = normalizeHostname(url.hostname)
    if (host.length === 0) throw fail(invalid(`url 主机名非法：${url.toString()}`))
    if (this.allowlist.length === 0) {
      throw fail(invalid('url 动态值需要宿主配置 allowlist 才能读取'))
    }
    if (!matchesAllowlist(url, this.allowlist)) {
      throw fail(invalid(`url 不在宿主 allowlist 内：${url.origin}${url.pathname}`))
    }
    if (this.allowPrivateAddresses !== true && isBlockedHostname(host)) {
      throw fail(invalid(`url 指向环回/私网地址，已拒绝：${host}`))
    }

    const controller = new AbortController()
    const onExternalAbort = (): void => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) throw fail(invalid(`url 请求超时或被取消：${url.toString()}`))
      signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    let completed = false
    try {
      const pinned = await this.pinAddress(host, controller.signal)
      const response = await raceAbort(
        this.transport.send({
          url,
          address: pinned.address,
          family: pinned.family,
          signal: controller.signal,
          headers: { accept: 'text/plain, application/json;q=0.9, */*;q=0.8', 'accept-encoding': 'identity' },
          maxBytes: this.maxBytes,
        }),
        controller.signal,
      )
      assertNoRedirect(url, response)
      assertSuccessStatus(url, response.status)
      assertDeclaredLength(url, response.headers, this.maxBytes)
      const text = await readBoundedText(url, response, this.maxBytes, controller)
      completed = true
      return text
    } catch (error) {
      if (error instanceof OmbFailure) throw error
      if (error instanceof EgressAbortError || controller.signal.aborted) {
        throw fail(internal(`url 请求超时或被取消：${url.toString()}`))
      }
      throw fail(internal(`url 请求失败：${messageOf(error)}`))
    } finally {
      clearTimeout(timer)
      // 失败路径（重定向/状态码/超限/超时）都要断掉底层连接，避免未消费的响应体占着 socket。
      if (!completed) controller.abort()
      if (signal !== undefined) signal.removeEventListener('abort', onExternalAbort)
    }
  }

  /** 解析 + 逐 IP 校验；返回固定下来、传给传输层的地址。 */
  private async pinAddress(host: string, signal: AbortSignal): Promise<EgressAddress> {
    const literal = classifyAddress(host)
    const addresses = await raceAbort(
      literal !== undefined
        ? Promise.resolve<readonly EgressAddress[]>([{ address: literal.canonical, family: literal.family }])
        : this.resolve(host),
      signal,
    )
    if (addresses.length === 0) {
      throw fail(invalid(`url 无法解析到任何地址：${host}`))
    }
    if (addresses.length > EGRESS_MAX_RESOLVED_ADDRESSES) {
      throw fail(invalid(`url 解析结果过多（${addresses.length} 条），已拒绝：${host}`))
    }
    const validated: EgressAddress[] = []
    for (const candidate of addresses) {
      const classification = classifyAddress(candidate.address)
      if (classification === undefined) {
        throw fail(invalid(`DNS 返回的地址不是合法 IP：${candidate.address}（${host}）`))
      }
      if (classification.blocked !== undefined && this.allowPrivateAddresses !== true) {
        throw fail(
          invalid(
            `url 解析到环回/私网/保留地址，已拒绝：${candidate.address}（${host}，${classification.blocked}）`,
          ),
        )
      }
      validated.push({ address: classification.canonical, family: classification.family })
    }
    const pinned = validated[0]
    if (pinned === undefined) throw fail(invalid(`url 没有可用的解析地址：${host}`))
    return pinned
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertRequestUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail(invalid(`url 只允许 http(s)：${url.toString()}`))
  }
  if (url.username !== '' || url.password !== '') {
    throw fail(invalid('url 不能携带账号或密码（凭据不应写入属性）'))
  }
}

/** 3xx/redirected/最终 URL 变化一律视为重定向：不跟随，直接拒绝。 */
function assertNoRedirect(url: URL, response: EgressResponse): void {
  if (response.status >= 300 && response.status < 400) {
    throw fail(invalid(`url 返回重定向 ${response.status}，已拒绝跟随：${url.toString()}`))
  }
  if (response.redirected === true) {
    throw fail(invalid(`url 发生了重定向，已拒绝跟随：${url.toString()}`))
  }
  if (response.url !== undefined) {
    let finalUrl: URL
    try {
      finalUrl = new URL(response.url)
    } catch {
      throw fail(invalid(`url 最终地址非法，已拒绝：${response.url}`))
    }
    if (finalUrl.href !== url.href) {
      throw fail(invalid(`url 最终地址与请求不一致（可能被重定向），已拒绝：${response.url}`))
    }
  }
}

function assertSuccessStatus(url: URL, status: number): void {
  if (status >= 200 && status < 300) return
  if (status === 404 || status === 410) {
    throw fail(notFound(`url 返回 ${status}：${url.toString()}`))
  }
  throw fail(internal(`url 返回 ${status}：${url.toString()}`))
}

function assertDeclaredLength(
  url: URL,
  headers: Readonly<Record<string, string | undefined>> | undefined,
  maxBytes: number,
): void {
  const declared = headers?.['content-length']
  if (declared === undefined) return
  const size = Number(declared)
  if (!Number.isFinite(size) || size < 0) return
  if (size > maxBytes) {
    throw fail(invalid(`url 响应声明 ${size} 字节，超过 ${maxBytes} 字节上限：${url.toString()}`))
  }
}

/** 边读边计字节；超限立即 abort 传输并失败（不把整个响应读进内存）。 */
async function readBoundedText(
  url: URL,
  response: EgressResponse,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  if (response.body === undefined) {
    if (response.text === undefined) throw fail(internal(`url 响应没有可读正文：${url.toString()}`))
    const text = await raceAbort(response.text(), controller.signal)
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      controller.abort()
      throw fail(invalid(`url 响应超过 ${maxBytes} 字节上限：${url.toString()}`))
    }
    return text
  }
  const iterator = response.body[Symbol.asyncIterator]()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const parts: string[] = []
  let total = 0
  for (;;) {
    const next = await raceAbort(iterator.next(), controller.signal)
    if (next.done === true) break
    const chunk = next.value
    if (typeof chunk === 'string') {
      total += Buffer.byteLength(chunk, 'utf8')
      if (total > maxBytes) {
        controller.abort()
        closeQuietly(iterator)
        throw fail(invalid(`url 响应超过 ${maxBytes} 字节上限：${url.toString()}`))
      }
      parts.push(chunk)
      continue
    }
    total += chunk.byteLength
    if (total > maxBytes) {
      controller.abort()
      closeQuietly(iterator)
      throw fail(invalid(`url 响应超过 ${maxBytes} 字节上限：${url.toString()}`))
    }
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}

function closeQuietly(iterator: AsyncIterator<Uint8Array | string>): void {
  try {
    void iterator.return?.()
  } catch {
    // 关闭流失败不影响已经确定的超限结论。
  }
}

/**
 * 让 promise 与 abort 竞争：DNS/传输/读完都可能因超时或外部取消需要立刻返回，
 * 而不是等底层实现自觉响应 signal。
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new EgressAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new EgressAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function defaultResolve(hostname: string): Promise<readonly EgressAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map(record => ({ address: record.address, family: record.family === 6 ? 6 : 4 }))
}

/**
 * 默认传输层：node:http/https 直连已校验 IP。
 *
 * 关键点：`lookup` 钩子返回固定 IP，HTTP 客户端不会再做一次 DNS（域名只用于 Host 与
 * TLS SNI），所以校验过的 IP 就是实际连接的 IP。重定向不跟随（返回 3xx 由 broker 拒绝）。
 */
function createNodeEgressTransport(): EgressTransport {
  return {
    send: request => sendWithNode(request),
  }
}

function sendWithNode(request: EgressRequest): Promise<EgressResponse> {
  const isHttps = request.url.protocol === 'https:'
  const hostname = normalizeHostname(request.url.hostname)
  const port = request.url.port === '' ? undefined : Number(request.url.port)
  const headers: Record<string, string> = {
    host: request.url.host,
    accept: request.headers.accept ?? '*/*',
    'accept-encoding': request.headers['accept-encoding'] ?? 'identity',
  }
  const options: HttpsRequestOptions = {
    protocol: request.url.protocol,
    hostname,
    ...(port !== undefined ? { port } : {}),
    path: `${request.url.pathname}${request.url.search}`,
    method: 'GET',
    headers,
    signal: request.signal,
    agent: false,
    lookup: (_host, _options, callback) => {
      callback(null, request.address, request.family)
    },
  }
  if (isHttps && net.isIP(hostname) === 0) {
    // IP 直连时不能把 IP 当 SNI；域名必须保留 SNI 才能在证书校验中匹配。
    options.servername = hostname
  }
  return new Promise<EgressResponse>((resolve, reject) => {
    const send = isHttps ? httpsRequest : httpRequest
    const req = send(options, res => {
      resolve({
        status: res.statusCode ?? 0,
        headers: flattenHeaders(res.headers),
        body: res,
        url: request.url.href,
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') flat[name.toLowerCase()] = value
    else if (Array.isArray(value)) flat[name.toLowerCase()] = value.join(', ')
  }
  return flat
}
