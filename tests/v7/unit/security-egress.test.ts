import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_EGRESS_MAX_BYTES,
  DEFAULT_EGRESS_TIMEOUT_MS,
  EgressBroker,
  classifyAddress,
  isBlockedAddress,
  isBlockedHostname,
  matchesAllowlist,
  normalizeHostname,
  type EgressAddress,
  type EgressFamily,
  type EgressPolicy,
  type EgressRequest,
  type EgressResponse,
  type EgressTransport,
} from '../../../packages/v7/src/security/egress.js'
import { expectOmbError } from './dynamic/helpers.js'

function addr(address: string, family: EgressFamily = 4): EgressAddress {
  return { address, family }
}

const PUBLIC_V4 = '93.184.216.34'
const PUBLIC_V6 = '2606:4700:4700::1111'

interface RecordedTransport {
  readonly calls: EgressRequest[]
  readonly transport: EgressTransport
}

function recordTransport(handler: (request: EgressRequest) => EgressResponse | Promise<EgressResponse>): RecordedTransport {
  const calls: EgressRequest[] = []
  return {
    calls,
    transport: {
      async send(request) {
        calls.push(request)
        return await handler(request)
      },
    },
  }
}

function textResponse(body: string, status = 200): EgressResponse {
  return { status, body: stringChunks([body]) }
}

async function* stringChunks(parts: readonly string[]): AsyncGenerator<string> {
  for (const part of parts) yield part
}

async function* countedChunks(
  count: number,
  size: number,
  counter: { value: number },
): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < count; index += 1) {
    counter.value += 1
    yield new Uint8Array(size).fill(0x61)
  }
}

function staticResolve(address: EgressAddress): EgressPolicy['resolve'] {
  return async () => [address]
}

describe('EgressBroker（URL 出站闸门）', () => {
  it('给定 allowlist 命中且解析到公网 IP 当取文本则返回正文且固定已校验 IP', async () => {
    const recorder = recordTransport(() => textResponse('hello egress'))
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    const text = await broker.fetchText(new URL('https://api.example.com/v1/items'))
    expect(text).toBe('hello egress')
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]?.address).toBe(PUBLIC_V4)
    expect(recorder.calls[0]?.family).toBe(4)
    expect(recorder.calls[0]?.url.href).toBe('https://api.example.com/v1/items')
    expect(recorder.calls[0]?.signal.aborted).toBe(false)
  })

  it('给定主机不在 allowlist 当取文本则拒绝且不解析 DNS、不发请求', async () => {
    let resolveCalls = 0
    const recorder = recordTransport(() => textResponse('never'))
    const broker = new EgressBroker({
      allowlist: ['other.example.com'],
      resolve: async () => {
        resolveCalls += 1
        return [addr(PUBLIC_V4)]
      },
      transport: recorder.transport,
    })
    await expectOmbError(broker.fetchText(new URL('https://api.example.com/v1')), 'invalid-input', /宿主 allowlist/)
    expect(resolveCalls).toBe(0)
    expect(recorder.calls).toEqual([])
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 allowlist 为空当取文本则拒绝', async () => {
    const broker = new EgressBroker({ allowlist: [], resolve: staticResolve(addr(PUBLIC_V4)) })
    await expectOmbError(broker.fetchText(new URL('https://api.example.com/v1')), 'invalid-input', /allowlist/)
  })

  it('给定 DNS 解析到环回地址当取文本则拒绝且不连接', async () => {
    const recorder = recordTransport(() => textResponse('never'))
    const broker = new EgressBroker({
      allowlist: ['rebind.example.com'],
      resolve: staticResolve(addr('127.0.0.1')),
      transport: recorder.transport,
    })
    await expectOmbError(broker.fetchText(new URL('https://rebind.example.com/x')), 'invalid-input', /环回|私网/)
    expect(recorder.calls).toEqual([])
  })

  it('给定 DNS 同时解析出公网与私网当取文本则整请求拒绝（不能只挑公网的那个）', async () => {
    const recorder = recordTransport(() => textResponse('never'))
    const broker = new EgressBroker({
      allowlist: ['rebind.example.com'],
      resolve: async () => [addr(PUBLIC_V4), addr('10.0.0.7')],
      transport: recorder.transport,
    })
    await expectOmbError(broker.fetchText(new URL('https://rebind.example.com/x')), 'invalid-input', /私网/)
    expect(recorder.calls).toEqual([])
  })

  it('给定同一主机第二次解析到私网（DNS rebinding）当再次取文本则第二次拒绝', async () => {
    let lookups = 0
    const recorder = recordTransport(() => textResponse('first ok'))
    const broker = new EgressBroker({
      allowlist: ['rebind.example.com'],
      resolve: async () => {
        lookups += 1
        return lookups === 1 ? [addr(PUBLIC_V4)] : [addr('169.254.169.254')]
      },
      transport: recorder.transport,
    })
    expect(await broker.fetchText(new URL('https://rebind.example.com/x'))).toBe('first ok')
    await expectOmbError(broker.fetchText(new URL('https://rebind.example.com/x')), 'invalid-input', /环回|私网/)
    expect(recorder.calls).toHaveLength(1)
  })

  it('给定尾点 localhost. 当取文本则在 DNS 前拒绝', async () => {
    const recorder = recordTransport(() => textResponse('never'))
    const broker = new EgressBroker({
      allowlist: ['localhost.'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    await expectOmbError(broker.fetchText(new URL('http://localhost./x')), 'invalid-input', /环回|私网/)
    expect(recorder.calls).toEqual([])
  })

  it('给定 allowlist 主机的尾点写法当命中则按规范化主机名解析并放行', async () => {
    const resolvedHosts: string[] = []
    const recorder = recordTransport(() => textResponse('tail dot ok'))
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: async host => {
        resolvedHosts.push(host)
        return [addr(PUBLIC_V4)]
      },
      transport: recorder.transport,
    })
    const text = await broker.fetchText(new URL('https://api.example.com./v1'))
    expect(text).toBe('tail dot ok')
    expect(resolvedHosts).toEqual(['api.example.com'])
    expect(recorder.calls[0]?.address).toBe(PUBLIC_V4)
  })

  it('给定十进制 IPv4 变体当取文本则在 DNS 前拒绝', async () => {
    const recorder = recordTransport(() => textResponse('never'))
    const broker = new EgressBroker({
      allowlist: ['127.0.0.1'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    await expectOmbError(broker.fetchText(new URL('http://2130706433/x')), 'invalid-input', /环回|私网/)
    expect(recorder.calls).toEqual([])
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定十六进制/八进制 IPv4 变体当取文本则在 DNS 前拒绝', async () => {
    const broker = new EgressBroker({ allowlist: ['127.0.0.1'], resolve: staticResolve(addr(PUBLIC_V4)) })
    await expectOmbError(broker.fetchText(new URL('http://0x7f.1/x')), 'invalid-input', /环回|私网/)
    const octal = new EgressBroker({ allowlist: ['127.0.0.1'], resolve: staticResolve(addr(PUBLIC_V4)) })
    await expectOmbError(octal.fetchText(new URL('http://0177.0.0.1/x')), 'invalid-input', /环回|私网/)
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定云元数据地址当取文本则拒绝', async () => {
    const broker = new EgressBroker({ allowlist: ['169.254.169.254'], resolve: staticResolve(addr(PUBLIC_V4)) })
    await expectOmbError(broker.fetchText(new URL('http://169.254.169.254/latest/meta-data')), 'invalid-input', /环回|私网/)
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定保留/文档网段当取文本则拒绝', async () => {
    for (const address of ['192.0.2.1', '203.0.113.9', '198.51.100.4']) {
      const broker = new EgressBroker({ allowlist: [address], resolve: staticResolve(addr(PUBLIC_V4)) })
      await expectOmbError(broker.fetchText(new URL(`http://${address}/x`)), 'invalid-input', /保留|环回|私网/)
    }
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定 IPv6 环回与 IPv4 映射环回当取文本则拒绝', async () => {
    const loopback = new EgressBroker({ allowlist: ['[::1]'], resolve: staticResolve(addr(PUBLIC_V4)) })
    await expectOmbError(loopback.fetchText(new URL('http://[::1]/x')), 'invalid-input', /环回|私网/)
    const mapped = new EgressBroker({
      allowlist: ['::ffff:7f00:1'],
      resolve: staticResolve(addr(PUBLIC_V4)),
    })
    await expectOmbError(mapped.fetchText(new URL('http://[::ffff:127.0.0.1]/x')), 'invalid-input', /环回|私网/)
  })

  it('给定公网 IPv6 allowlist 命中当取文本则固定 family=6 的地址', async () => {
    const recorder = recordTransport(() => textResponse('v6 ok'))
    const broker = new EgressBroker({
      allowlist: [`[${PUBLIC_V6}]`],
      resolve: staticResolve(addr(PUBLIC_V6, 6)),
      transport: recorder.transport,
    })
    expect(await broker.fetchText(new URL(`https://[${PUBLIC_V6}]/x`))).toBe('v6 ok')
    expect(recorder.calls[0]?.address).toBe('2606:4700:4700:0:0:0:0:1111')
    expect(recorder.calls[0]?.family).toBe(6)
  })

  it('给定 302 重定向当取文本则拒绝且不跟随', async () => {
    const recorder = recordTransport(() => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
      body: stringChunks(['moved']),
    }))
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    await expectOmbError(
      broker.fetchText(new URL('https://api.example.com/x')),
      'invalid-input',
      /重定向/,
    )
    expect(recorder.calls).toHaveLength(1)
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定响应标记 redirected 或最终 URL 变化当取文本则拒绝', async () => {
    const flagged = recordTransport(() => ({ status: 200, redirected: true, body: stringChunks(['x']) }))
    const first = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: flagged.transport,
    })
    await expectOmbError(first.fetchText(new URL('https://api.example.com/x')), 'invalid-input', /重定向/)

    const moved = recordTransport(() => ({
      status: 200,
      url: 'https://evil.example.com/x',
      body: stringChunks(['x']),
    }))
    const second = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: moved.transport,
    })
    await expectOmbError(second.fetchText(new URL('https://api.example.com/x')), 'invalid-input', /重定向|最终地址/)
  })

  it('给定响应流超过 maxBytes 当取文本则只读到超限处并失败', async () => {
    const counter = { value: 0 }
    const recorder = recordTransport(() => ({ status: 200, body: countedChunks(10, 100, counter) }))
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      maxBytes: 250,
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    await expectOmbError(broker.fetchText(new URL('https://api.example.com/x')), 'invalid-input', /字节上限/)
    expect(counter.value).toBe(3)
    expect(recorder.calls[0]?.signal.aborted).toBe(true)
  })

  it('给定 content-length 声明超过 maxBytes 当取文本则读取正文前拒绝', async () => {
    const counter = { value: 0 }
    const recorder = recordTransport(() => ({
      status: 200,
      headers: { 'content-length': '8192' },
      body: countedChunks(1, 1, counter),
    }))
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      maxBytes: 1024,
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    await expectOmbError(broker.fetchText(new URL('https://api.example.com/x')), 'invalid-input', /字节上限/)
    expect(counter.value).toBe(0)
  })

  it('给定传输层一直不返回当超时则报超时/取消并 abort 信号', async () => {
    const recorder = recordTransport(
      request =>
        new Promise<EgressResponse>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted by broker')), { once: true })
        }),
    )
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      timeoutMs: 20,
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    await expectOmbError(
      broker.fetchText(new URL('https://api.example.com/x')),
      'internal',
      /超时或被取消/,
    )
    expect(recorder.calls[0]?.signal.aborted).toBe(true)
  })

  it('给定外部信号已取消当取文本则不发起请求', async () => {
    const recorder = recordTransport(() => textResponse('never'))
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    const controller = new AbortController()
    controller.abort()
    await expectOmbError(
      broker.fetchText(new URL('https://api.example.com/x'), controller.signal),
      'invalid-input',
      /超时或被取消/,
    )
    expect(recorder.calls).toEqual([])
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定上游 404/500 当取文本则映射为 not-found/internal', async () => {
    const notFoundRecorder = recordTransport(() => textResponse('missing', 404))
    const missing = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: notFoundRecorder.transport,
    })
    await expectOmbError(missing.fetchText(new URL('https://api.example.com/x')), 'not-found', /404/)

    const brokenRecorder = recordTransport(() => textResponse('boom', 500))
    const broken = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: brokenRecorder.transport,
    })
    await expectOmbError(broken.fetchText(new URL('https://api.example.com/x')), 'internal', /500/)
  })

  it('给定传输层抛原始错误当取文本则包成 OmbFailure 而不是宿主异常', async () => {
    const recorder = recordTransport(() => {
      throw new Error('socket hang up')
    })
    const broker = new EgressBroker({
      allowlist: ['api.example.com'],
      resolve: staticResolve(addr(PUBLIC_V4)),
      transport: recorder.transport,
    })
    const failure = await expectOmbError(broker.fetchText(new URL('https://api.example.com/x')), 'internal', /请求失败/)
    expect(failure.message).toContain('socket hang up')
  })
})

describe('EgressBroker 地址/前缀判定', () => {
  it('给定十进制/十六进制/八进制/短写 IPv4 当判定则都识别为环回或私网', () => {
    for (const address of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '10.1', '192.168.1']) {
      expect(isBlockedAddress(address)).toBe(true)
    }
    expect(isBlockedAddress(PUBLIC_V4)).toBe(false)
  })

  it('给定 IPv4 链路本地/文档/组播/IPv4 映射 IPv6 当判定则都是不可出站', () => {
    for (const address of ['169.254.169.254', '192.0.2.1', '224.0.0.1', '255.255.255.255', '100.64.0.1']) {
      expect(isBlockedAddress(address)).toBe(true)
    }
    expect(classifyAddress('::ffff:169.254.169.254')?.blocked).toContain('IPv4 映射')
    expect(classifyAddress('::ffff:8.8.8.8')?.blocked).toBeUndefined()
    expect(classifyAddress(PUBLIC_V6)?.blocked).toBeUndefined()
  })

  it('给定 IPv6 ULA/链路本地/文档/6to4/NAT64 当判定则都不可出站', () => {
    for (const address of ['fd00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1', '64:ff9b::7f00:1']) {
      expect(isBlockedAddress(address)).toBe(true)
    }
  })

  it('给定尾点与内网名字当判定主机则都拒绝', () => {
    for (const host of ['localhost', 'localhost.', 'metadata.google.internal', 'intranet', '[::1]', '127.0.0.1.']) {
      expect(isBlockedHostname(host)).toBe(true)
    }
    expect(isBlockedHostname('api.example.com.')).toBe(false)
    expect(isBlockedHostname(PUBLIC_V4)).toBe(false)
  })

  it('给定尾点与方括号当规范化主机名则去掉', () => {
    expect(normalizeHostname('API.Example.COM.')).toBe('api.example.com')
    expect(normalizeHostname('[::1]')).toBe('::1')
    expect(normalizeHostname('api.example.com%2f.evil.com')).toBe('')
  })

  it('给定编码路径绕过前缀 allowlist 当匹配则拒绝', () => {
    const patterns = ['https://api.example.com/v1']
    expect(matchesAllowlist(new URL('https://api.example.com/v1/items'), patterns)).toBe(true)
    expect(matchesAllowlist(new URL('https://api.example.com/v1/..%2fprivate'), patterns)).toBe(false)
    expect(matchesAllowlist(new URL('https://api.example.com/v1/%2e%2e/private'), patterns)).toBe(false)
    expect(matchesAllowlist(new URL('https://api.example.com/v1/..%252fprivate'), patterns)).toBe(false)
    expect(matchesAllowlist(new URL('https://api.example.com/v2/items'), patterns)).toBe(false)
  })

  it('给定 allowlist 通配子域当匹配则只匹配子域且忽略尾点', () => {
    const patterns = ['*.example.com']
    expect(matchesAllowlist(new URL('https://api.example.com/x'), patterns)).toBe(true)
    expect(matchesAllowlist(new URL('https://api.example.com./x'), patterns)).toBe(true)
    expect(matchesAllowlist(new URL('https://example.com/x'), patterns)).toBe(false)
    expect(matchesAllowlist(new URL('https://evilexample.com/x'), patterns)).toBe(false)
  })

  it('给定默认常量当导出则与旧 url 策略预算一致', () => {
    expect(DEFAULT_EGRESS_TIMEOUT_MS).toBe(5_000)
    expect(DEFAULT_EGRESS_MAX_BYTES).toBe(256 * 1024)
  })
})

describe('默认 node 传输层（localhost 真连接）', () => {
  let server: http.Server
  let origin: string

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/hello') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('hello localhost')
        return
      }
      if (request.url === '/big') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(Buffer.alloc(8192, 0x61))
        return
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/hello' })
        response.end()
        return
      }
      response.writeHead(404)
      response.end('missing')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('给定显式允许私网当请求本地服务则经默认传输层返回正文', async () => {
    const broker = new EgressBroker({
      allowlist: ['127.0.0.1'],
      allowPrivateAddresses: true,
    })
    expect(await broker.fetchText(new URL(`${origin}/hello`))).toBe('hello localhost')
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定本地服务返回超限正文当取文本则流式超限失败', async () => {
    const broker = new EgressBroker({
      allowlist: ['127.0.0.1'],
      allowPrivateAddresses: true,
      maxBytes: 64,
    })
    await expectOmbError(broker.fetchText(new URL(`${origin}/big`)), 'invalid-input', /字节上限/)
  })

  // 断言在 expectOmbError（tests/v7/unit/dynamic/helpers.ts）里：校验 OmbFailure 类型/错误码/消息；静态扫描看不到 helper 内部断言。
  // check:ignore-next-line test-no-assert
  it('给定本地服务返回 302 当取文本则拒绝跟随', async () => {
    const broker = new EgressBroker({
      allowlist: ['127.0.0.1'],
      allowPrivateAddresses: true,
    })
    await expectOmbError(broker.fetchText(new URL(`${origin}/redirect`)), 'invalid-input', /重定向/)
  })
})
