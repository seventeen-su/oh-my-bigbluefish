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
  input: { method?: string; url: string; origin?: string; host?: string },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { host: input.host ?? '127.0.0.1:3080' }
  if (input.origin !== undefined) headers.origin = input.origin
  const req = { method: input.method ?? 'GET', url: input.url, headers } as unknown as IncomingMessage
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

    const missing = await request(route as Captured, { url: '/omb/api/detail?id=nope' })
    expect(missing.status).toBe(404)

    dispose()
    expect(fake.captured()).toBeUndefined()
  })

  it('只读：POST 405；跨源 403；未知端点 404', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured
    expect((await request(route, { method: 'POST', url: '/omb/api/list' })).status).toBe(405)
    expect((await request(route, { url: '/omb/api/overview', origin: 'https://evil.example' })).status).toBe(403)
    expect((await request(route, { url: '/omb/api/nope' })).status).toBe(404)
    const badId = await request(route, { url: '/omb/api/detail' })
    expect(badId.status).toBe(400)
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
