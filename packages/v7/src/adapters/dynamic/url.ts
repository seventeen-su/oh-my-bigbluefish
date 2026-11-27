import type { UrlSpec } from '../../domain/dynamic-spec.js'
import { fail, invalid, OmbFailure } from '../../domain/errors.js'
import {
  DEFAULT_EGRESS_MAX_BYTES,
  DEFAULT_EGRESS_TIMEOUT_MS,
  EgressBroker,
  type EgressResolve,
  type EgressTransport,
} from '../../security/egress.js'
import {
  isBlockedHostname,
  matchesAllowlist,
} from '../../security/egress-address.js'

/** 与 egress broker 共用默认值；保留旧导出名，宿主配置不需要改。 */
export const DEFAULT_URL_TIMEOUT_MS = DEFAULT_EGRESS_TIMEOUT_MS
export const DEFAULT_URL_MAX_BYTES = DEFAULT_EGRESS_MAX_BYTES

/** url 动态值的宿主闸门：默认关闭，必须显式启用并提供 allowlist。 */
export interface UrlFetchPolicy {
  readonly enabled: boolean
  readonly allowlist: readonly string[]
  /** 仅开发/测试显式打开时才允许环回与私网地址；默认拒绝。 */
  readonly allowPrivateAddresses?: boolean
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** DNS 解析钩子；缺省用 node:dns。测试注入桩。 */
  readonly resolve?: EgressResolve
  /** 出站传输层；缺省用 node:http(s) 直连已校验 IP。测试注入桩。 */
  readonly transport?: EgressTransport
}

/**
 * 把 UrlSpec 解析成可请求的 URL：默认关闭 → unsupported；
 * 宿主 allowlist 与属性 allowlist（若给）都命中才放行；环回/私网/保留名字默认拒绝。
 *
 * 这里只是**首层**：域名 allowlist 挡不住 DNS rebinding，最终判定在
 * `EgressBroker` 解析 DNS 后逐 IP 完成（见 security/egress.ts）。
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
  if (policy.allowPrivateAddresses !== true && isBlockedHostname(url.hostname)) {
    throw fail(invalid(`url 指向环回/私网地址，已拒绝：${url.hostname}`))
  }
  return url
}

/**
 * 取回 url 文本正文：DNS 后逐 IP 校验、固定 IP、禁重定向、流式字节上限、
 * 超时与外部取消。所有失败都是 OmbFailure，不抛宿主原始错误。
 */
export async function fetchUrlText(url: URL, policy: UrlFetchPolicy, signal?: AbortSignal): Promise<string> {
  const broker = new EgressBroker({
    allowlist: policy.allowlist,
    allowPrivateAddresses: policy.allowPrivateAddresses === true,
    timeoutMs: policy.timeoutMs,
    maxBytes: policy.maxBytes,
    resolve: policy.resolve,
    transport: policy.transport,
  })
  try {
    return await broker.fetchText(url, signal)
  } catch (error) {
    if (error instanceof OmbFailure) throw error
    throw fail({ code: 'internal', message: `url 请求失败：${error instanceof Error ? error.message : String(error)}` })
  }
}
