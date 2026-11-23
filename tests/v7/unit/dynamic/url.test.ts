import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import type { FetchInitLike, FetchLike, FetchResponseLike, UrlFetchPolicy } from '../../../../packages/v7/src/adapters/dynamic/url-policy.js'
import { FakeContext, expectOmbError } from './helpers.js'

interface FetchCall {
  readonly input: string
  readonly init: FetchInitLike | undefined
}

function stubFetch(body: string, status = 200): { calls: FetchCall[]; fetchImpl: FetchLike } {
  const calls: FetchCall[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init })
    const response: FetchResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }
    return response
  }
  return { calls, fetchImpl }
}

function policy(overrides: Partial<UrlFetchPolicy> & { fetch: FetchLike }): UrlFetchPolicy {
  return { enabled: true, allowlist: ['api.example.com'], ...overrides }
}

describe('url 动态值', () => {
  it('给定宿主未配置 url 策略则默认拒绝', async () => {
    const resolver = new DefaultDynamicResolver()
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'unsupported',
      /默认关闭/,
    )
  })

  it('给定策略未启用则拒绝且不发请求', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ enabled: false, fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'unsupported',
    )
    expect(calls).toEqual([])
  })

  it('给定 allowlist 为空则拒绝', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ allowlist: [], fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'unsupported',
      /allowlist/,
    )
    expect(calls).toEqual([])
  })

  it('给定主机不在 allowlist 则拒绝且不发请求', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ allowlist: ['other.example.com'], fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /宿主 allowlist/,
    )
    expect(calls).toEqual([])
  })

  it('给定 allowlist 命中则 fetch 并返回文本，禁重定向', async () => {
    const { calls, fetchImpl } = stubFetch('hello url')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    const value = await resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1/items' }, new FakeContext())
    expect(value).toBe('hello url')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe('https://api.example.com/v1/items')
    expect(calls[0]?.init?.redirect).toBe('error')
  })

  it('给定属性 allowlist 不命中则拒绝（宿主 allowlist 通过也不放行）', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve(
        { kind: 'url', url: 'https://api.example.com/v1', allowlist: ['cdn.example.com'] },
        new FakeContext(),
      ),
      'invalid-input',
      /属性 allowlist/,
    )
    expect(calls).toEqual([])
  })

  it('给定属性 allowlist 命中则放行', async () => {
    const { calls, fetchImpl } = stubFetch('ok')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    const value = await resolver.resolve(
      { kind: 'url', url: 'https://api.example.com/v1', allowlist: ['api.example.com'] },
      new FakeContext(),
    )
    expect(value).toBe('ok')
    expect(calls).toHaveLength(1)
  })

  it('给定 URL 前缀 allowlist 则按路径边界匹配', async () => {
    const { calls, fetchImpl } = stubFetch('v1 body')
    const resolver = new DefaultDynamicResolver({ url: policy({ allowlist: ['https://api.example.com/v1'], fetch: fetchImpl }) })
    const context = new FakeContext()
    expect(await resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1/items' }, context)).toBe('v1 body')
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v2/items' }, context),
      'invalid-input',
      /宿主 allowlist/,
    )
    expect(calls).toHaveLength(1)
  })

  it('给定通配子域 allowlist 则只匹配子域不匹配 apex', async () => {
    const { calls, fetchImpl } = stubFetch('wild')
    const resolver = new DefaultDynamicResolver({ url: policy({ allowlist: ['*.example.com'], fetch: fetchImpl }) })
    const context = new FakeContext()
    expect(await resolver.resolve({ kind: 'url', url: 'https://api.example.com/x' }, context)).toBe('wild')
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://example.com/x' }, context),
      'invalid-input',
      /宿主 allowlist/,
    )
    expect(calls).toHaveLength(1)
  })

  it('给定 jsonPath 点号路径则从响应 JSON 取值', async () => {
    const { fetchImpl } = stubFetch('{"data":{"items":[1,2]}}')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    const value = await resolver.resolve(
      { kind: 'url', url: 'https://api.example.com/v1', jsonPath: 'data.items[1]' },
      new FakeContext(),
    )
    expect(value).toBe(2)
  })

  it('给定 jsonPath RFC6901 指针则从响应 JSON 取值', async () => {
    const { fetchImpl } = stubFetch('{"data":{"items":[1,2]}}')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    const value = await resolver.resolve(
      { kind: 'url', url: 'https://api.example.com/v1', jsonPath: '/data/items/0' },
      new FakeContext(),
    )
    expect(value).toBe(1)
  })

  it('给定 jsonPath 未命中则报 not-found', async () => {
    const { fetchImpl } = stubFetch('{"data":{}}')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1', jsonPath: 'data.items' }, new FakeContext()),
      'not-found',
      /JSON 路径未命中/,
    )
  })

  it('给定 jsonPath 但响应不是 JSON 则报 invalid-input', async () => {
    const { fetchImpl } = stubFetch('not json')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1', jsonPath: 'a' }, new FakeContext()),
      'invalid-input',
      /不是合法 JSON/,
    )
  })

  it('给定环回地址则默认拒绝且不发请求', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ allowlist: ['127.0.0.1'], fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'http://127.0.0.1:8080/x' }, new FakeContext()),
      'invalid-input',
      /环回|私网/,
    )
    expect(calls).toEqual([])
  })

  it('给定显式允许私网则放行', async () => {
    const { calls, fetchImpl } = stubFetch('local')
    const resolver = new DefaultDynamicResolver({
      url: policy({ allowlist: ['127.0.0.1'], allowPrivateAddresses: true, fetch: fetchImpl }),
    })
    const value = await resolver.resolve({ kind: 'url', url: 'http://127.0.0.1:8080/x' }, new FakeContext())
    expect(value).toBe('local')
    expect(calls).toHaveLength(1)
  })

  it('给定上游 404 则报 not-found', async () => {
    const { fetchImpl } = stubFetch('missing', 404)
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'not-found',
      /404/,
    )
  })

  it('给定 fetch 抛错则报 internal', async () => {
    const fetchImpl: FetchLike = async () => Promise.reject(new Error('network down'))
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'internal',
      /请求失败/,
    )
  })

  it('给定响应超过字节上限则报 invalid-input', async () => {
    const { fetchImpl } = stubFetch('0123456789')
    const resolver = new DefaultDynamicResolver({ url: policy({ maxBytes: 4, fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /字节上限/,
    )
  })

  it('给定上下文信号已取消则按取消失败', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl: FetchLike = async (_input, init) => {
      if (init?.signal?.aborted === true) throw new Error('aborted')
      return { ok: true, status: 200, text: async () => 'never' }
    }
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve(
        { kind: 'url', url: 'https://api.example.com/v1' },
        new FakeContext({ signal: controller.signal }),
      ),
      'internal',
      /超时或被取消/,
    )
  })

  it('给定非 http(s) 协议则拒绝', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'ftp://api.example.com/x' }, new FakeContext()),
      'invalid-input',
      /只允许 http/,
    )
    expect(calls).toEqual([])
  })

  it('给定 URL 字符串非法则报 invalid-input', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'not a url' }, new FakeContext()),
      'invalid-input',
      /合法 URL/,
    )
    expect(calls).toEqual([])
  })

  it('给定 URL 里带账号密码则拒绝（凭据不应写入属性）', async () => {
    const { calls, fetchImpl } = stubFetch('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ fetch: fetchImpl }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://user:pass@api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /不能携带账号或密码/,
    )
    expect(calls).toEqual([])
  })
})
