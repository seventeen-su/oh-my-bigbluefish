/**
 * 记忆管理侧边栏的**宿主 HTTP 路由**（v4.15.0）。
 *
 * 边界：
 * - 只挂在宿主 `webServer` 的 `/omb/api` 前缀上；没有 webServer（CLI/桌面载体）时
 *   本路由不注册，侧边栏自然不出现——不假装已经可用；
 * - **读**：GET 只调用 `omb:ui` 服务；**写**入口只有用户点击触发的
 *   `/confirm`、`/resolve`、`/privacy`（会话隐私设置）、`/memory`（手动新建/编辑/
 *   删除/标记，v4.18）。**没有模型工具入口**：模型不能通过这些端点放宽隐私或改记忆；
 * - 同源保护：浏览器跨站请求带的 `Origin` 与 `Host` 不一致时 403（GET 的简单请求本来就
 *   不发 Origin，所以这层只在异常情形生效；不是权限边界，真正的边界是本机回环监听）；
 * - 所有响应 `no-store`，JSON 编码，错误不泄漏内部异常文本（只给类别）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Kernel } from '../kernel/abi/index.js'
import { SERVICES } from '../kernel/abi/index.js'
import type { MemoryKind } from '../kernel/abi/index.js'
import type { UiListQuery, UiMemoryMark, UiScope, UiStatus, UiService } from '../modules/memory/ui.js'
import type { PrivacyMode } from '../modules/memory/privacy/modes.js'

/** 路由前缀（与 `cordis.patch.yml` 的组件行无关，纯宿主 URL 命名空间）。 */
export const UI_ROUTE_PREFIX = '/omb/api'

/** 允许的类型/状态取值（解析用；未知值忽略而不是 400——前端可以渐进增强）。 */
const KINDS: readonly MemoryKind[] = ['semantic', 'procedural', 'episodic']
const SCOPES: readonly UiScope[] = ['user', 'project', 'all']
const STATUSES: readonly UiStatus[] = ['active', 'stale', 'superseded', 'candidate', 'all']
const MARKS: readonly UiMemoryMark[] = ['confirm', 'obsolete', 'revive']

function parseListQuery(search: URLSearchParams): UiListQuery {
  const scope = search.get('scope') as UiScope | null
  const status = search.get('status') as UiStatus | null
  const kind = search.get('kind') as MemoryKind | null
  const limitRaw = search.get('limit')
  const offsetRaw = search.get('offset')
  const tagsRaw = search.get('tags')
  const tags = tagsRaw === null ? undefined : tagsRaw.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0)
  return {
    ...(scope !== null && SCOPES.includes(scope) ? { scope } : {}),
    ...(status !== null && STATUSES.includes(status) ? { status } : {}),
    ...(kind !== null && KINDS.includes(kind) ? { kind } : {}),
    ...(search.get('q') === null ? {} : { q: search.get('q') as string }),
    ...(tags === undefined || tags.length === 0 ? {} : { tags }),
    ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
    ...(offsetRaw === null ? {} : { offset: Number(offsetRaw) }),
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(body)
}

/** 同源判定：没有 Origin 视为同源（同源 GET 的常态）；有则必须与 Host 一致。 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin.length === 0) return true
  const host = req.headers.host
  if (host === undefined || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 请求体上限（确认动作只发 id + action；4KB 足够，超出拒绝）。 */
const MAX_BODY_BYTES = 4 * 1024

/** 读取 JSON 请求体；超限/非 JSON/解析失败返回 undefined（不抛）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text.length === 0) return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * 注册 UI 路由。
 *
 * @param webCtx 注入 `webServer` 之后的宿主作用域（Cordis context）。
 * @param kernelOf 每次请求现取内核（热插拔会换内核实例；缓存住会指向旧库）。
 * @returns 注销函数（幂等）；注册失败时返回空函数并由调用方留声。
 */
export function installUiRoute(
  webCtx: unknown,
  kernelOf: () => Kernel | undefined,
): () => void {
  const scope = webCtx as {
    readonly webServer?: { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
    readonly effect?: (fn: () => (() => void)) => () => void
  }
  const webServer = scope.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!sameOrigin(req)) {
        json(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      const kernel = kernelOf()
      const ui = kernel?.service<UiService>(SERVICES.ui)
      if (ui === undefined) {
        json(res, 503, { error: 'memory ui service unavailable' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(UI_ROUTE_PREFIX.length) || '/'
      if (req.method === 'POST') {
        // 写入口只有四个：用户点击的确认/撤销、冲突裁决、会话隐私设置、手动记忆编辑。
        // **没有模型工具调用它们**。
        if (path !== '/confirm' && path !== '/resolve' && path !== '/privacy' && path !== '/memory') {
          json(res, 405, { error: 'write endpoints are /confirm, /resolve, /privacy, and /memory' })
          return
        }
        const contentType = req.headers['content-type'] ?? ''
        if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
          json(res, 415, { error: 'content-type must be application/json' })
          return
        }
        const body = await readJsonBody(req)
        const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : undefined
        if (path === '/privacy') {
          const action = record?.['action']
          if (action !== 'set' && action !== 'clear' && action !== 'clear-inactive' && action !== 'trust') {
            json(res, 400, { error: 'action must be set, clear, clear-inactive, or trust' })
            return
          }
          let sessionId: string | undefined
          if (action === 'set' || action === 'clear') {
            const rawSessionId = record?.['sessionId']
            if (typeof rawSessionId !== 'string' || rawSessionId.trim().length === 0) {
              json(res, 400, { error: 'missing sessionId' })
              return
            }
            sessionId = rawSessionId.trim()
          }
          let mode: PrivacyMode | undefined
          if (action === 'set') {
            const rawMode = record?.['mode']
            if (rawMode !== 'normal' && rawMode !== 'read-only' && rawMode !== 'sealed') {
              json(res, 400, { error: 'mode must be normal, read-only, or sealed' })
              return
            }
            mode = rawMode
          }
          const outcome = await ui.privacyAct({
            action,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(mode === undefined ? {} : { mode }),
          })
          json(res, outcome.ok ? 200 : 409, { ok: outcome.ok, text: outcome.text })
          return
        }
        if (path === '/memory') {
          const action = record?.['action']
          if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'mark') {
            json(res, 400, { error: 'action 必须是 create、update、delete 或 mark' })
            return
          }
          const rawId = record?.['id']
          const id = typeof rawId === 'string' ? rawId.trim() : ''
          const requireId = (): boolean => {
            if (id.length > 0) return true
            json(res, 400, { error: '缺少 id' })
            return false
          }
          const rawTags = record?.['tags']
          if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some(tag => typeof tag !== 'string'))) {
            json(res, 400, { error: 'tags 必须是字符串数组' })
            return
          }
          const tags = Array.isArray(rawTags) ? rawTags as string[] : undefined
          if (action === 'create') {
            const scope = record?.['scope']
            const kind = record?.['kind']
            const text = record?.['text']
            if (scope !== 'user' && scope !== 'project') {
              json(res, 400, { error: 'scope 必须是 user 或 project' })
              return
            }
            if (typeof kind !== 'string' || !KINDS.includes(kind as MemoryKind)) {
              json(res, 400, { error: 'kind 必须是 semantic、procedural 或 episodic' })
              return
            }
            if (typeof text !== 'string') {
              json(res, 400, { error: '缺少 text' })
              return
            }
            const outcome = await ui.createMemory({
              scope,
              kind: kind as MemoryKind,
              text,
              ...(tags === undefined ? {} : { tags }),
            })
            json(res, outcome.ok ? 200 : 409, { ok: outcome.ok, text: outcome.text })
            return
          }
          if (!requireId()) return
          if (action === 'delete') {
            const outcome = await ui.deleteMemory(id)
            json(res, outcome.ok ? 200 : 409, { ok: outcome.ok, text: outcome.text })
            return
          }
          if (action === 'mark') {
            const mark = record?.['mark']
            if (typeof mark !== 'string' || !MARKS.includes(mark as UiMemoryMark)) {
              json(res, 400, { error: 'mark 必须是 confirm、obsolete 或 revive' })
              return
            }
            const outcome = await ui.markMemory(id, mark as UiMemoryMark)
            json(res, outcome.ok ? 200 : 409, { ok: outcome.ok, text: outcome.text })
            return
          }
          const text = record?.['text']
          const kind = record?.['kind']
          if (text !== undefined && typeof text !== 'string') {
            json(res, 400, { error: 'text 必须是字符串' })
            return
          }
          if (kind !== undefined && (typeof kind !== 'string' || !KINDS.includes(kind as MemoryKind))) {
            json(res, 400, { error: 'kind 必须是 semantic、procedural 或 episodic' })
            return
          }
          const outcome = await ui.updateMemory({
            id,
            ...(typeof text === 'string' ? { text } : {}),
            ...(typeof kind === 'string' ? { kind: kind as MemoryKind } : {}),
            ...(tags === undefined ? {} : { tags }),
          })
          json(res, outcome.ok ? 200 : 409, { ok: outcome.ok, text: outcome.text })
          return
        }
        if (path === '/resolve') {
          const action = record?.['action']
          const fromId = record?.['fromId']
          const toId = record?.['toId']
          if (action !== 'relate' && action !== 'supersede') {
            json(res, 400, { error: 'action must be relate or supersede' })
            return
          }
          if (typeof fromId !== 'string' || typeof toId !== 'string'
            || fromId.trim().length === 0 || toId.trim().length === 0) {
            json(res, 400, { error: 'missing fromId/toId' })
            return
          }
          const outcome = await ui.resolve({ action, fromId: fromId.trim(), toId: toId.trim() })
          json(res, outcome.ok ? 200 : 409, { ok: outcome.ok, text: outcome.text })
          return
        }
        const id = record?.['id']
        const action = record?.['action']
        if (typeof id !== 'string' || id.trim().length === 0) {
          json(res, 400, { error: 'missing id' })
          return
        }
        if (action !== 'confirm' && action !== 'undo') {
          json(res, 400, { error: 'action must be confirm or undo' })
          return
        }
        const outcome = await ui.act(id.trim(), action, null)
        json(res, outcome.ok ? 200 : 409, { ok: outcome.ok, text: outcome.text })
        return
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'read-only endpoint' })
        return
      }
      if (path === '/overview') {
        json(res, 200, await ui.overview())
        return
      }
      if (path === '/runtime') {
        json(res, 200, await ui.runtime())
        return
      }
      if (path === '/profile') {
        const sessionId = url.searchParams.get('sessionId')
        const trimmed = sessionId === null ? '' : sessionId.trim()
        json(res, 200, await ui.profile(trimmed.length > 0 ? trimmed : undefined))
        return
      }
      if (path === '/sessions') {
        json(res, 200, await ui.sessions())
        return
      }
      if (path === '/personal') {
        json(res, 200, await ui.personal())
        return
      }
      if (path === '/privacy') {
        json(res, 200, await ui.privacy())
        return
      }
      if (path === '/list') {
        json(res, 200, await ui.list(parseListQuery(url.searchParams)))
        return
      }
      if (path === '/candidates') {
        const limit = Number(url.searchParams.get('limit') ?? '')
        json(res, 200, await ui.candidates(Number.isFinite(limit) ? limit : undefined))
        return
      }
      if (path === '/detail') {
        const id = url.searchParams.get('id')
        if (id === null || id.trim().length === 0) {
          json(res, 400, { error: 'missing id' })
          return
        }
        const detail = await ui.detail(id.trim())
        if (detail === undefined) {
          json(res, 404, { error: 'memory not found' })
          return
        }
        json(res, 200, detail)
        return
      }
      json(res, 404, { error: 'unknown endpoint' })
    } catch (error) {
      json(res, 500, { error: 'internal error' })
      void error
    }
  }
  const route = { kind: 'prefix' as const, path: UI_ROUTE_PREFIX, handler }
  try {
    if (typeof scope.effect === 'function') return scope.effect(() => webServer.register(route))
    return webServer.register(route)
  } catch {
    return () => {}
  }
}
