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
  profile: async (sessionId?: string) => (sessionId === undefined
    ? { available: false, reason: '测试未接线' }
    : { available: true, root: `/root/${sessionId}` }),
  sessions: async () => ({
    available: true,
    items: [{
      id: 's1', title: '会话一', cwd: '/work/demo', root: '/work/demo', preset: 'omb',
      archived: false, active: true, depth: 'deep', parentId: null,
      privacy: { mode: 'sealed', origin: 'command', inheritedFrom: null }, createdAt: 1,
    }],
  }),
  personal: async () => ({
    available: true,
    status: { available: true, detail: 'ok', declared: 1, inferred: 0, conflicts: 0, capabilityAxis: 'off' },
    entries: [],
    conflicts: [],
    text: '个人画像文本',
  }),
  controller: async (sessionId?: string) => ({
    available: true,
    sessionId: sessionId ?? 's1',
    phase: 'tracking-tasks',
    tasks: [{ text: '别改测试', at: 1, expiresAt: 2 }],
    candidates: [],
    lastEventAt: null,
  }),
  controllerAct: async (input: { action: string; sessionId: string; text?: string }) => (input.sessionId === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `控制器 ${input.action} 成功` }),
  personalAct: async (input: { action: string; axis: string; key: string }) => (input.key === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `画像 ${input.action} 成功` }),
  machines: async () => ({
    available: true,
    groups: [{
      root: '/work/a',
      label: '/work/a',
      sessions: [{
        id: 's1', title: '一', cwd: '/work/a', archived: false, active: true,
        phase: 'mixed', tasks: [], candidates: [], lastEventAt: null, privacy: 'normal',
      }],
    }],
  }),
  feedbackAct: async (input: { id: string; action: string }) => (input.id === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `反馈 ${input.action} 成功` }),
  depthAct: async (input: { sessionId?: string; depth: string }) => (input.sessionId === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `深度 ${input.depth} 成功` }),
  createMemory: async (input: { scope: string; kind: string; text: string }) => (input.text === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `新建 ${input.scope}/${input.kind}` }),
  updateMemory: async (input: { id: string }) => (input.id === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `保存 ${input.id}` }),
  deleteMemory: async (id: string) => (id === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `删除 ${id}` }),
  markMemory: async (id: string, mark: string) => (id === 'denied'
    ? { ok: false, text: '拒绝：测试' }
    : { ok: true, text: `标记 ${mark} ${id}` }),
  sessionTitle: async (id: string) => ({ title: id === 'known' ? '真标题' : null }),
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
    commands: { privacy: '/omb-privacy', clean: '/omb-privacy-clean', state: '已删除（v4.20）' },
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
      url: '/omb/api/list?scope=user&status=stale&kind=semantic&q=8080&limit=5&offset=10',
    })
    expect(list.status).toBe(200)
    expect(list.body).toMatchObject({ query: { scope: 'user', status: 'stale', kind: 'semantic', q: '8080', limit: 5, offset: 10 } })

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

  it('项目页/个人画像/手动记忆：新 GET 与 POST /memory 四动作、参数校验、405 文案（v4.18）', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured

    const sessions = await request(route, { url: '/omb/api/sessions' })
    expect(sessions.status).toBe(200)
    expect(sessions.body).toMatchObject({ available: true, items: [{ id: 's1', privacy: { mode: 'sealed' }, parentId: null }] })

    const personal = await request(route, { url: '/omb/api/personal' })
    expect(personal.status).toBe(200)
    expect(personal.body).toMatchObject({ available: true, text: '个人画像文本' })

    const profileBySession = await request(route, { url: '/omb/api/profile?sessionId=s1' })
    expect(profileBySession.status).toBe(200)
    expect(profileBySession.body).toMatchObject({ available: true, root: '/root/s1' })
    const profileEmpty = await request(route, { url: '/omb/api/profile?sessionId=%20' })
    expect(profileEmpty.status).toBe(200)
    expect(profileEmpty.body).toMatchObject({ available: false })

    const listCandidate = await request(route, { url: '/omb/api/list?scope=user&status=candidate' })
    expect(listCandidate.status).toBe(200)
    expect(listCandidate.body).toMatchObject({ query: { status: 'candidate' } })

    const post = (body: unknown) => request(route, {
      method: 'POST', url: '/omb/api/memory', body, contentType: 'application/json',
    })
    const created = await post({ action: 'create', scope: 'user', kind: 'semantic', text: '手动内容', tags: ['a'] })
    expect(created.status).toBe(200)
    expect(String((created.body as { text: string }).text)).toContain('新建 user/semantic')
    expect((await post({ action: 'update', id: 'm1', text: '新内容' })).status).toBe(200)
    expect((await post({ action: 'delete', id: 'm1' })).status).toBe(200)
    expect((await post({ action: 'mark', id: 'm1', mark: 'obsolete' })).status).toBe(200)

    // 拒绝路径 409
    expect((await post({ action: 'delete', id: 'denied' })).status).toBe(409)
    expect((await post({ action: 'create', scope: 'user', kind: 'semantic', text: 'denied' })).status).toBe(409)

    // 参数校验 400
    expect((await post({ action: 'nope' })).status).toBe(400)
    expect((await post({ action: 'create', kind: 'semantic', text: 'x' })).status).toBe(400)
    expect((await post({ action: 'create', scope: 'user', kind: 'nope', text: 'x' })).status).toBe(400)
    expect((await post({ action: 'create', scope: 'user', kind: 'semantic' })).status).toBe(400)
    expect((await post({ action: 'create', scope: 'user', kind: 'semantic', text: 'x', tags: 'not-array' })).status).toBe(400)
    expect((await post({ action: 'update', text: '缺 id' })).status).toBe(400)
    expect((await post({ action: 'update', id: 'm1', kind: 'nope' })).status).toBe(400)
    expect((await post({ action: 'update', id: 'm1', text: 42 })).status).toBe(400)
    expect((await post({ action: 'delete' })).status).toBe(400)
    expect((await post({ action: 'mark', id: 'm1' })).status).toBe(400)
    expect((await post({ action: 'mark', id: 'm1', mark: 'nope' })).status).toBe(400)

    // 其它 POST 路径 405，文案点名 /memory
    const other = await request(route, {
      method: 'POST', url: '/omb/api/overview', body: {}, contentType: 'application/json',
    })
    expect(other.status).toBe(405)
    expect(String((other.body as { error: string }).error)).toContain('/memory')
  })

  it('控制器与个人画像写入口：GET /controller、POST /controller 五动作、POST /personal、校验与 405（v4.19）', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured

    const got = await request(route, { url: '/omb/api/controller?sessionId=s2' })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ available: true, sessionId: 's2', phase: 'tracking-tasks' })
    const gotDefault = await request(route, { url: '/omb/api/controller' })
    expect(gotDefault.status).toBe(200)
    expect(gotDefault.body).toMatchObject({ sessionId: 's1' })

    const post = (url: string, body: unknown) => request(route, {
      method: 'POST', url, body, contentType: 'application/json',
    })
    const add = await post('/omb/api/controller', { action: 'add-task', sessionId: 's1', text: '别改测试' })
    expect(add.status).toBe(200)
    expect(String((add.body as { text: string }).text)).toContain('add-task 成功')
    expect((await post('/omb/api/controller', { action: 'remove-task', sessionId: 's1', text: '别改测试' })).status).toBe(200)
    expect((await post('/omb/api/controller', { action: 'clear-tasks', sessionId: 's1' })).status).toBe(200)
    expect((await post('/omb/api/controller', { action: 'remove-candidate', sessionId: 's1', text: 'x' })).status).toBe(200)
    expect((await post('/omb/api/controller', { action: 'clear-candidates', sessionId: 's1' })).status).toBe(200)
    expect((await post('/omb/api/controller', { action: 'clear-tasks', sessionId: 'denied' })).status).toBe(409)

    // 控制器 400
    expect((await post('/omb/api/controller', { action: 'nope', sessionId: 's1' })).status).toBe(400)
    expect((await post('/omb/api/controller', { action: 'clear-tasks' })).status).toBe(400)
    expect((await post('/omb/api/controller', { action: 'clear-tasks', sessionId: 'x'.repeat(201) })).status).toBe(400)
    expect((await post('/omb/api/controller', { action: 'add-task', sessionId: 's1' })).status).toBe(400)
    expect((await post('/omb/api/controller', { action: 'add-task', sessionId: 's1', text: 'x'.repeat(201) })).status).toBe(400)
    expect((await post('/omb/api/controller', { action: 'add-task', sessionId: 's1', text: 42 })).status).toBe(400)

    // 个人画像 200 / 400 / 409
    const declared = await post('/omb/api/personal', {
      action: 'declare', axis: 'stable', key: 'pkg', value: 'pnpm', evidence: ['s1'],
    })
    expect(declared.status).toBe(200)
    expect(String((declared.body as { text: string }).text)).toContain('declare 成功')
    expect((await post('/omb/api/personal', { action: 'retract', axis: 'stable', key: 'pkg' })).status).toBe(200)
    expect((await post('/omb/api/personal', { action: 'retract', axis: 'stable', key: 'denied' })).status).toBe(409)
    expect((await post('/omb/api/personal', { action: 'nope', axis: 'stable', key: 'k' })).status).toBe(400)
    expect((await post('/omb/api/personal', { action: 'declare', axis: 'capability', key: 'k', value: 'v' })).status).toBe(400)
    expect((await post('/omb/api/personal', { action: 'declare', axis: 'nope', key: 'k', value: 'v' })).status).toBe(400)
    expect((await post('/omb/api/personal', { action: 'retract', axis: 'stable' })).status).toBe(400)
    expect((await post('/omb/api/personal', { action: 'declare', axis: 'stable', key: 'k' })).status).toBe(400)
    expect((await post('/omb/api/personal', { action: 'declare', axis: 'stable', key: 'k', value: 'x'.repeat(2001) })).status).toBe(400)
    expect((await post('/omb/api/personal', { action: 'declare', axis: 'stable', key: 'k', value: 'v', evidence: 'bad' })).status).toBe(400)

    // 其它 POST 405，文案点名两个新写入口
    const other = await post('/omb/api/overview', {})
    expect(other.status).toBe(405)
    const message = String((other.body as { error: string }).error)
    expect(message).toContain('/controller')
    expect(message).toContain('/personal')
  })

  it('所有状态机/反馈/深度：GET /machines、POST /feedback、POST /depth、校验与 405（v4.20）', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured

    const machines = await request(route, { url: '/omb/api/machines' })
    expect(machines.status).toBe(200)
    expect(machines.body).toMatchObject({ available: true, groups: [{ root: '/work/a', sessions: [{ id: 's1', phase: 'mixed' }] }] })

    const post = (url: string, body: unknown) => request(route, {
      method: 'POST', url, body, contentType: 'application/json',
    })
    const feedback = await post('/omb/api/feedback', { id: 'm1', action: 'useful' })
    expect(feedback.status).toBe(200)
    expect(String((feedback.body as { text: string }).text)).toContain('useful 成功')
    expect((await post('/omb/api/feedback', { id: 'denied', action: 'stale' })).status).toBe(409)
    expect((await post('/omb/api/feedback', { id: 'm1', action: 'nope' })).status).toBe(400)
    expect((await post('/omb/api/feedback', { action: 'useful' })).status).toBe(400)
    expect((await post('/omb/api/feedback', { id: 'x'.repeat(201), action: 'useful' })).status).toBe(400)
    expect((await post('/omb/api/feedback', { id: 42, action: 'useful' })).status).toBe(400)

    const depth = await post('/omb/api/depth', { sessionId: 's1', depth: 'deep' })
    expect(depth.status).toBe(200)
    expect(String((depth.body as { text: string }).text)).toContain('deep 成功')
    expect((await post('/omb/api/depth', { sessionId: 'denied', depth: 'quick' })).status).toBe(409)
    expect((await post('/omb/api/depth', { sessionId: 's1', depth: 'max' })).status).toBe(400)
    expect((await post('/omb/api/depth', { depth: 'quick' })).status).toBe(400)
    expect((await post('/omb/api/depth', { sessionId: 'x'.repeat(201), depth: 'quick' })).status).toBe(400)

    const other = await post('/omb/api/overview', {})
    expect(other.status).toBe(405)
    const message = String((other.body as { error: string }).error)
    expect(message).toContain('/feedback')
    expect(message).toContain('/depth')
  })

  it('会话标题：GET /session-title?id= 200；缺 id 400（v4.21）', async () => {
    const fake = fakeWeb(null)
    installUiRoute(fake.webCtx, () => fakeKernel(UI))
    const route = fake.captured() as Captured

    const known = await request(route, { url: '/omb/api/session-title?id=known' })
    expect(known.status).toBe(200)
    expect(known.body).toEqual({ title: '真标题' })
    const unknown = await request(route, { url: '/omb/api/session-title?id=missing' })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toEqual({ title: null })
    expect((await request(route, { url: '/omb/api/session-title' })).status).toBe(400)
    expect((await request(route, { url: '/omb/api/session-title?id=%20' })).status).toBe(400)
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
