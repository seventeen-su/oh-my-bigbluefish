/**
 * 管理侧边栏宿主路由（v4.15.0）：只读 GET、同源保护、缺服务 503、注销可回收。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SERVICES, type Kernel } from '../../kernel/abi/index.js'
import { UI_ROUTE_PREFIX, installUiRoute } from '../../dsh/ui-route.js'

interface Captured {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function fakeWeb(handler: Captured | null): {
  webCtx: unknown
  disposed: boolean
  captured: () => Captured | undefined
} {
  let captured: Captured | undefined
  let disposed = false
  const webCtx = {
    webServer: {
      register(route: Captured): () => void {
        captured = route
        return () => {
          captured = undefined
          disposed = true
        }
      },
    },
    effect(fn: () => () => void): () => void {
      const dispose = fn()
      return () => {
        dispose()
        disposed = true
      }
    },
  }
  void handler
  return { webCtx, get disposed() { return disposed }, captured: () => captured }
}

function fakeKernel(ui: unknown): Kernel {
  return { service: (name: string) => (name === SERVICES.ui ? ui : undefined) } as unknown as Kernel
}

async function request(
  route: Captured,
  input: { method?: string; url: string; origin?: string; host?: string; body?: unknown; contentType?: string },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { host: input.host ?? '127.0.0.1:3080' }
  if (input.origin !== undefined) headers.origin = input.origin
  if (input.contentType !== undefined) headers['content-type'] = input.contentType
  const text = input.body === undefined ? '' : JSON.stringify(input.body)
  const req = {
    method: input.method ?? 'GET',
    url: input.url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text, 'utf8')
    },
  } as unknown as IncomingMessage
  let status = 0
  let payload = ''
  const res = {
    setHeader: () => res,
    end: (body: string) => {
      payload = body
    },
  } as unknown as ServerResponse
  Object.defineProperty(res, 'statusCode', {
    get: () => status,
    set: (value: number) => {
      status = value
    },
  })
  await route.handler(req, res)
  return { status, body: payload.length === 0 ? null : JSON.parse(payload) }
}

const UI = {
  overview: async () => ({ ready: true, detail: 'ok', openProjects: [], maxOpenProjects: 8, stores: [], totalActive: 2, totalCandidates: 0 }),
  list: async (query: unknown) => ({ items: [], total: 0, truncated: false, query }),
  candidates: async () => ({ items: [], total: 0, truncated: false }),
  detail: async (id: string) => (id === 'seen'
    ? { record: { id }, audit: [], auditAvailable: true, related: [] }
    : undefined),
  act: async (id: string, action: string) => (id === 'cand'
    ? { ok: true, text: `${action} 成功` }
    : { ok: false, text: `未确认：${id}` }),
  runtime: async () => ({ version: '4.15.2', stores: { ready: true, detail: 'ok', openProjects: [], maxOpenProjects: 8 } }),
  profile: async () => ({ available: false, reason: '测试未接线' }),
  resolve: async (input: { action: string; fromId: string; toId: string }) => (input.fromId === 'a' && input.toId === 'b'
    ? { ok: true, text: `${input.action} 成功` }
    : { ok: false, text: '未执行：测试拒绝' }),
  privacy: async () => ({
    available: true,
    baseline: { mode: 'normal', origin: 'default', detail: '默认 normal' },
    current: null,
    sessions: [],
    restricted: null,
    durable: { path: '/tmp/session-modes.json', ok: true, detail: '状态文件可读写', savedAt: null },
    commands: { privacy: '/omb-privacy', clean: '/omb-privacy-clean', state: '已注册' },
    stats: {
      decisions: 0, readDenials: 0, writeDenials: 0, unattributedWriteDenials: 0,
      lastDeniedSession: null, lastDeniedReason: null,
    },
  }),
  privacyAct: async (input: { action: string; sessionId?: string; mode?: string }) => (input.sessionId === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `${input.action} 成功` }),
}

describe('installUiRoute', () => {
  it('注册 prefix /omb/api，GET 概览/列表/详情都返回 JSON', async () => {
    const fake = fakeWeb(null)
    const dispose = installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured()
    expect(route?.kind).toBe('prefix')
    expect(route?.path).toBe(UI_ROUTE_PREFIX)

    const overview = await request(route as Captured, { url: '/omb/api/overview' })
    expect(overview.status).toBe(200)
    expect(overview.body).toMatchObject({ ready: true, totalActive: 2 })

    const list = await request(route as Captured, {
      url: '/omb/api/list?scope=user&status=stale&kind=semantic&q=8080&limit=5',
    })
    expect(list.status).toBe(200)
    expect(list.body).toMatchObject({ query: { scope: 'user', status: 'stale', kind: 'semantic', q: '8080', limit: 5 } })

    const detail = await request(route as Captured, { url: '/omb/api/detail?id=seen' })
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({ record: { id: 'seen' } })

    const runtime = await request(route as Captured, { url: '/omb/api/runtime' })
    expect(runtime.status).toBe(200)
    expect(runtime.body).toMatchObject({ version: '4.15.2' })
    const profile = await request(route as Captured, { url: '/omb/api/profile' })
    expect(profile.status).toBe(200)
    expect(profile.body).toMatchObject({ available: false })

    const missing = await request(route as Captured, { url: '/omb/api/detail?id=nope' })
    expect(missing.status).toBe(404)

    dispose()
    expect(fake.captured()).toBeUndefined()
  })

  it('只读：POST 405；跨源 403；未知端点 404', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured
    expect((await request(route, { method: 'POST', url: '/omb/api/list', body: {}, contentType: 'application/json' })).status).toBe(405)
    expect((await request(route, { url: '/omb/api/overview', origin: 'https://evil.example' })).status).toBe(403)
    expect((await request(route, { url: '/omb/api/nope' })).status).toBe(404)
    const badId = await request(route, { url: '/omb/api/detail' })
    expect(badId.status).toBe(400)
  })

  it('用户动作：POST /confirm 成功 200 / 拒绝 409 / 参数与编码校验', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured
    const ok = await request(route, {
      method: 'POST', url: '/omb/api/confirm', body: { id: 'cand', action: 'confirm' }, contentType: 'application/json',
    })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ ok: true })
    expect(String((ok.body as { text: string }).text)).toContain('confirm 成功')

    const refused = await request(route, {
      method: 'POST', url: '/omb/api/confirm', body: { id: 'nope', action: 'undo' }, contentType: 'application/json',
    })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ ok: false })

    const wrongType = await request(route, {
      method: 'POST', url: '/omb/api/confirm', body: { id: 'cand', action: 'confirm' }, contentType: 'text/plain',
    })
    expect(wrongType.status).toBe(415)
    const badAction = await request(route, {
      method: 'POST', url: '/omb/api/confirm', body: { id: 'cand', action: 'delete' }, contentType: 'application/json',
    })
    expect(badAction.status).toBe(400)
    const badBody = await request(route, {
      method: 'POST', url: '/omb/api/confirm', body: undefined, contentType: 'application/json',
    })
    expect(badBody.status).toBe(400)
  })

  it('用户动作：POST /resolve 建关联/取代 200 / 拒绝 409 / 参数校验 400', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured
    const ok = await request(route, {
      method: 'POST', url: '/omb/api/resolve', body: { action: 'supersede', fromId: 'a', toId: 'b' }, contentType: 'application/json',
    })
    expect(ok.status).toBe(200)
    expect(String((ok.body as { text: string }).text)).toContain('supersede')

    const refused = await request(route, {
      method: 'POST', url: '/omb/api/resolve', body: { action: 'relate', fromId: 'x', toId: 'b' }, contentType: 'application/json',
    })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ ok: false })

    const badAction = await request(route, {
      method: 'POST', url: '/omb/api/resolve', body: { action: 'delete', fromId: 'a', toId: 'b' }, contentType: 'application/json',
    })
    expect(badAction.status).toBe(400)
    const missing = await request(route, {
      method: 'POST', url: '/omb/api/resolve', body: { action: 'relate', fromId: 'a' }, contentType: 'application/json',
    })
    expect(missing.status).toBe(400)
  })

  it('会话隐私：GET /privacy 200；POST 四动作 200；参数校验 400；拒绝 409；其它 POST 405', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured

    const got = await request(route, { url: '/omb/api/privacy' })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ available: true, commands: { privacy: '/omb-privacy' } })

    const post = (body: unknown) => request(route, {
      method: 'POST', url: '/omb/api/privacy', body, contentType: 'application/json',
    })
    const set = await post({ action: 'set', sessionId: 's1', mode: 'sealed' })
    expect(set.status).toBe(200)
    expect(String((set.body as { text: string }).text)).toContain('set 成功')
    expect((await post({ action: 'clear', sessionId: 's1' })).status).toBe(200)
    expect((await post({ action: 'clear-inactive' })).status).toBe(200)
    expect((await post({ action: 'trust' })).status).toBe(200)

    const badAction = await post({ action: 'delete', sessionId: 's1' })
    expect(badAction.status).toBe(400)
    expect((badAction.body as { error: string }).error).toBe('action must be set, clear, clear-inactive, or trust')
    expect((await post({ action: 'set', sessionId: 's1' })).status).toBe(400)
    expect((await post({ action: 'set', sessionId: 's1', mode: 'deep' })).status).toBe(400)
    expect((await post({ action: 'set', mode: 'normal' })).status).toBe(400)
    expect((await post({ action: 'clear' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await post({ action: 'trust' })).body).toEqual({ ok: true, text: 'trust 成功' })

    const denied = await post({ action: 'clear', sessionId: 'denied' })
    expect(denied.status).toBe(409)
    expect(denied.body).toMatchObject({ ok: false })

    // 其它 POST 路径 405，文案必须点名 /privacy（新增写入口）
    const list = await request(route, {
      method: 'POST', url: '/omb/api/list', body: {}, contentType: 'application/json',
    })
    expect(list.status).toBe(405)
    expect(String((list.body as { error: string }).error)).toContain('/privacy')
  })

  it('会话隐私：写入口同样要 JSON + 同源（415/403），GET 也拒绝跨源', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured
    const plain = await request(route, {
      method: 'POST', url: '/omb/api/privacy', body: { action: 'trust' }, contentType: 'text/plain',
    })
    expect(plain.status).toBe(415)

    const crossPost = await request(route, {
      method: 'POST', url: '/omb/api/privacy', origin: 'http://evil.example', host: '127.0.0.1:3080',
      body: { action: 'trust' }, contentType: 'application/json',
    })
    expect(crossPost.status).toBe(403)

    const crossGet = await request(route, { url: '/omb/api/privacy', origin: 'http://evil.example' })
    expect(crossGet.status).toBe(403)
  })

  it('ui 服务缺席 → 503（不假装已就绪）', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(undefined))
    const route = fake.captured() as Captured
    expect((await request(route, { url: '/omb/api/overview' })).status).toBe(503)
  })

  it('没有 webServer 的宿主：空注销，不抛', () => {
    expect(() => installUiRoute({}, () => undefined)).not.toThrow()
    expect(installUiRoute({}, () => undefined)()).toBeUndefined()
  })
})
