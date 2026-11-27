import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import type { UrlFetchPolicy } from '../../../../packages/v7/src/adapters/dynamic/url.js'
import type {
  EgressAddress,
  EgressRequest,
  EgressResponse,
  EgressTransport,
} from '../../../../packages/v7/src/security/egress.js'
import { FakeContext, expectOmbError } from './helpers.js'

const PUBLIC_V4 = '93.184.216.34'

interface StubTransport {
  readonly calls: EgressRequest[]
  readonly transport: EgressTransport
}

function stubTransport(body: string, status = 200): StubTransport {
  const calls: EgressRequest[] = []
  const transport: EgressTransport = {
    async send(request): Promise<EgressResponse> {
      calls.push(request)
      return { status, body: stringChunks([body]) }
    },
  }
  return { calls, transport }
}

async function* stringChunks(parts: readonly string[]): AsyncGenerator<string> {
  for (const part of parts) yield part
}

const RESOLVE_PUBLIC = async (): Promise<readonly EgressAddress[]> => [{ address: PUBLIC_V4, family: 4 }]

function policy(overrides: Partial<UrlFetchPolicy> = {}): UrlFetchPolicy {
  return {
    enabled: true,
    allowlist: ['api.example.com'],
    resolve: RESOLVE_PUBLIC,
    ...overrides,
  }
}

function resolverWith(overrides: Partial<UrlFetchPolicy> = {}): {
  resolver: DefaultDynamicResolver
  calls: EgressRequest[]
} {
  const stub = stubTransport('unused')
  const resolver = new DefaultDynamicResolver({ url: policy({ ...overrides, transport: overrides.transport ?? stub.transport }) })
  return { resolver, calls: stub.calls }
}

describe('url 动态值', () => {
  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定宿主未配置 url 策略则默认拒绝', async () => {
    const resolver = new DefaultDynamicResolver()
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'unsupported',
      /默认关闭/,
    )
  })

  it('给定策略未启用则拒绝且不发请求', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ enabled: false, transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'unsupported',
    )
    expect(stub.calls).toEqual([])
  })

  it('给定 allowlist 为空则拒绝', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ allowlist: [], transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'unsupported',
      /allowlist/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定主机不在 allowlist 则拒绝且不发请求', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({
      url: policy({ allowlist: ['other.example.com'], transport: stub.transport }),
    })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /宿主 allowlist/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定 allowlist 命中则经 broker 请求已校验 IP 并返回文本', async () => {
    const stub = stubTransport('hello url')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    const value = await resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1/items' }, new FakeContext())
    expect(value).toBe('hello url')
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url.href).toBe('https://api.example.com/v1/items')
    expect(stub.calls[0]?.address).toBe(PUBLIC_V4)
    expect(stub.calls[0]?.family).toBe(4)
  })

  it('给定上下文信号当请求则传进 broker 的 abort 信号', async () => {
    const stub = stubTransport('ok')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    const controller = new AbortController()
    await resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext({ signal: controller.signal }))
    expect(stub.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('给定属性 allowlist 不命中则拒绝（宿主 allowlist 通过也不放行）', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve(
        { kind: 'url', url: 'https://api.example.com/v1', allowlist: ['cdn.example.com'] },
        new FakeContext(),
      ),
      'invalid-input',
      /属性 allowlist/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定属性 allowlist 命中则放行', async () => {
    const stub = stubTransport('ok')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    const value = await resolver.resolve(
      { kind: 'url', url: 'https://api.example.com/v1', allowlist: ['api.example.com'] },
      new FakeContext(),
    )
    expect(value).toBe('ok')
    expect(stub.calls).toHaveLength(1)
  })

  it('给定 URL 前缀 allowlist 则按路径边界匹配，编码绕过被拒绝', async () => {
    const stub = stubTransport('v1 body')
    const resolver = new DefaultDynamicResolver({
      url: policy({ allowlist: ['https://api.example.com/v1'], transport: stub.transport }),
    })
    const context = new FakeContext()
    expect(await resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1/items' }, context)).toBe('v1 body')
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v2/items' }, context),
      'invalid-input',
      /宿主 allowlist/,
    )
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1/..%2fprivate' }, context),
      'invalid-input',
      /宿主 allowlist/,
    )
    expect(stub.calls).toHaveLength(1)
  })

  it('给定通配子域 allowlist 则只匹配子域不匹配 apex', async () => {
    const stub = stubTransport('wild')
    const resolver = new DefaultDynamicResolver({ url: policy({ allowlist: ['*.example.com'], transport: stub.transport }) })
    const context = new FakeContext()
    expect(await resolver.resolve({ kind: 'url', url: 'https://api.example.com/x' }, context)).toBe('wild')
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://example.com/x' }, context),
      'invalid-input',
      /宿主 allowlist/,
    )
    expect(stub.calls).toHaveLength(1)
  })

  it('给定 jsonPath 点号路径则从响应 JSON 取值', async () => {
    const stub = stubTransport('{"data":{"items":[1,2]}}')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    const value = await resolver.resolve(
      { kind: 'url', url: 'https://api.example.com/v1', jsonPath: 'data.items[1]' },
      new FakeContext(),
    )
    expect(value).toBe(2)
  })

  it('给定 jsonPath RFC6901 指针则从响应 JSON 取值', async () => {
    const stub = stubTransport('{"data":{"items":[1,2]}}')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    const value = await resolver.resolve(
      { kind: 'url', url: 'https://api.example.com/v1', jsonPath: '/data/items/0' },
      new FakeContext(),
    )
    expect(value).toBe(1)
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 jsonPath 未命中则报 not-found', async () => {
    const stub = stubTransport('{"data":{}}')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1', jsonPath: 'data.items' }, new FakeContext()),
      'not-found',
      /JSON 路径未命中/,
    )
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 jsonPath 但响应不是 JSON 则报 invalid-input', async () => {
    const stub = stubTransport('not json')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1', jsonPath: 'a' }, new FakeContext()),
      'invalid-input',
      /不是合法 JSON/,
    )
  })

  it('给定环回地址则默认拒绝且不发请求', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({
      url: policy({ allowlist: ['127.0.0.1'], transport: stub.transport }),
    })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'http://127.0.0.1:8080/x' }, new FakeContext()),
      'invalid-input',
      /环回|私网/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定域名解析到私网则拒绝且不连接（DNS rebinding）', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({
      url: policy({
        resolve: async () => [{ address: '10.0.0.9', family: 4 }],
        transport: stub.transport,
      }),
    })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /环回|私网/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定显式允许私网则放行', async () => {
    const stub = stubTransport('local')
    const resolver = new DefaultDynamicResolver({
      url: policy({ allowlist: ['127.0.0.1'], allowPrivateAddresses: true, transport: stub.transport }),
    })
    const value = await resolver.resolve({ kind: 'url', url: 'http://127.0.0.1:8080/x' }, new FakeContext())
    expect(value).toBe('local')
    expect(stub.calls).toHaveLength(1)
  })

  it('给定 302 重定向则拒绝且不跟随', async () => {
    const calls: EgressRequest[] = []
    const transport: EgressTransport = {
      async send(request) {
        calls.push(request)
        return { status: 302, headers: { location: 'http://169.254.169.254/' }, body: stringChunks(['moved']) }
      },
    }
    const resolver = new DefaultDynamicResolver({ url: policy({ transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /重定向/,
    )
    expect(calls).toHaveLength(1)
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定上游 404 则报 not-found', async () => {
    const stub = stubTransport('missing', 404)
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'not-found',
      /404/,
    )
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定传输层抛错则报 internal 而不是宿主异常', async () => {
    const transport: EgressTransport = {
      async send() {
        throw new Error('network down')
      },
    }
    const resolver = new DefaultDynamicResolver({ url: policy({ transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'internal',
      /请求失败/,
    )
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定响应超过字节上限则报 invalid-input', async () => {
    const stub = stubTransport('0123456789')
    const resolver = new DefaultDynamicResolver({ url: policy({ maxBytes: 4, transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /字节上限/,
    )
  })

  it('给定上下文信号已取消则按取消失败且不发请求', async () => {
    const stub = stubTransport('never')
    const controller = new AbortController()
    controller.abort()
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve(
        { kind: 'url', url: 'https://api.example.com/v1' },
        new FakeContext({ signal: controller.signal }),
      ),
      'invalid-input',
      /超时或被取消/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定非 http(s) 协议则拒绝', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'ftp://api.example.com/x' }, new FakeContext()),
      'invalid-input',
      /只允许 http/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定 URL 字符串非法则报 invalid-input', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'not a url' }, new FakeContext()),
      'invalid-input',
      /合法 URL/,
    )
    expect(stub.calls).toEqual([])
  })

  it('给定 URL 里带账号密码则拒绝（凭据不应写入属性）', async () => {
    const stub = stubTransport('never')
    const resolver = new DefaultDynamicResolver({ url: policy({ transport: stub.transport }) })
    await expectOmbError(
      resolver.resolve({ kind: 'url', url: 'https://user:pass@api.example.com/v1' }, new FakeContext()),
      'invalid-input',
      /不能携带账号或密码/,
    )
    expect(stub.calls).toEqual([])
  })
})

describe('url 动态值（resolverWith 辅助）', () => {
  it('给定 allowlist 主机带尾点则按规范化主机名命中', async () => {
    const { resolver, calls } = resolverWith()
    const value = await resolver.resolve({ kind: 'url', url: 'https://api.example.com./v1' }, new FakeContext())
    expect(value).toBe('unused')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.address).toBe(PUBLIC_V4)
  })
})
