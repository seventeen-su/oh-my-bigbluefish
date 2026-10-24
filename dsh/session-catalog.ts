/**
 * 会话目录端口（v4.18.0）：「项目」页要列出**宿主里真实存在**的会话。
 *
 * ## 为什么这一层必须存在
 *
 * 会话持久化（`sessionPersistence`）、活会话注册表（`sessions`）、标题投影
 * （`sessionTitle`）与 durable 归档集合（`workspaceRegistry`）都是**宿主服务**；
 * `modules/` 不得 import 宿主包（AGENTS.md 不变量 1）。所以由 `dsh/` 把它们收敛成
 * 一个结构最小面，经 `SERVICES.sessionCatalog` 交给模块层。
 *
 * ## 三条硬约束
 *
 * 1. **本文件不 import 任何 `@deepseek-ai/*`**：本仓库解析不到它们，顶层 import
 *    会让插件加载直接失败（与 `dsh/host.ts` 顶部同一条理由）。
 * 2. **`list()` 绝不抛**：面板拿不到目录时必须是"如实不可用 + 原因"，不能是异常，
 *    更不能返回空列表冒充"没有会话"（AGENTS.md 不变量 3）。
 * 3. **每次 `list()` 现读服务表**，不在安装时快照：宿主服务可能晚于本插件就绪，
 *    也可能被中途开关（`dsh/plugin.ts` 里 `workspaceChanges: () => readService(...)`
 *    是同一条口径——快照下来的服务会永久缺失）。
 *
 * ## 不做的事
 *
 * 不读会话正文、不打开事件日志、不碰隐私闸门：目录只给 id / 标题 / cwd / 创建时间 /
 * preset / 归档 / 是否活着。归档会话**保留在列表里**（UI 要灰显并标注），是否可读由
 * 上层决定。
 *
 * @module omb/dsh/session-catalog
 */
import type {
  SessionCatalogEntry,
  SessionCatalogListing,
  SessionCatalogPort,
} from '../kernel/abi/index.js'
import { readService, type HostContextLike } from './host.js'

/** 目录条数上限（契约 §3：不一次把几万个会话搬进面板）。 */
const MAX_ITEMS = 200

/* ── 宿主形状的结构最小面（字段全可选：旧日志缺 agentPreset，异常头可能缺更多）── */

/** 会话头的最小面（`SessionHeader` 在宿主侧是只读快照）。 */
interface HostSessionHeaderLike {
  readonly id?: unknown
  readonly cwd?: unknown
  readonly createdAt?: unknown
  readonly agentPreset?: unknown
}

/** `sessionPersistence.list()` 的元素：`{ header, formatStatus? }`。 */
interface PersistenceSnapshotLike {
  readonly header?: HostSessionHeaderLike
}

/** 持久化服务（`list()` 在宿主实现里是 Promise）。 */
interface SessionPersistenceLike {
  list?(options?: unknown): unknown
}

/** 活会话（`sessions.list()` 的元素）：`Session` 对象，标题投影要的是对象本身。 */
interface LiveSessionLike {
  readonly id?: unknown
  readonly header?: HostSessionHeaderLike
}

/** 活会话注册表。 */
interface SessionsLike {
  list?(): unknown
}

/** 标题投影服务：只对**活会话**调用。 */
interface SessionTitleLike {
  get?(session: unknown): unknown
}

/** 工作区注册表：归档集合是 getter。 */
interface WorkspaceRegistryLike {
  readonly archivedSessionIds?: unknown
}

/** 安装结果：端口 + 幂等 disposer。 */
export interface SessionCatalogInstallation {
  readonly port: SessionCatalogPort
  dispose(): void
}

/** 合并期的可变中间态（`archived` 最后一步按归档集合算，不在中途定死）。 */
interface MergedEntry {
  readonly id: string
  title: string | null
  cwd: string
  createdAt: number
  agentPreset: string | null
  live: boolean
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 创建时间缺失/畸形时给 0（而不是 NaN）：排序仍稳定，UI 不至于显示 NaN。 */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '<不可渲染的错误>'
  }
}

function unavailable(reason: string): SessionCatalogListing {
  return Object.freeze({ available: false, reason, items: Object.freeze([]) })
}

/**
 * 在服务表里取**带某方法**的对象。
 *
 * 宿主的服务发布形态不唯一：`sessions` 既有"服务对象"形态，也有"工厂函数"形态
 * （`ctx.get(name)` 直接返回函数）。两种都收；形状不符一律 undefined，绝不抛。
 */
function withMethod<T>(raw: unknown, method: string): T | undefined {
  const hasMethod = (candidate: unknown): boolean =>
    candidate !== null
    && (typeof candidate === 'object' || typeof candidate === 'function')
    && typeof (candidate as Record<string, unknown>)[method] === 'function'
  if (hasMethod(raw)) return raw as T
  if (typeof raw === 'function') {
    try {
      const produced = (raw as () => unknown)()
      if (hasMethod(produced)) return produced as T
    } catch {
      // 工厂自己抛错 → 该服务不可用（不向调用方传播）
      return undefined
    }
  }
  return undefined
}

/** 调一次 `list`，把同步抛错折成 undefined。 */
function callList(fn: (() => unknown) | undefined, owner: unknown): unknown {
  if (typeof fn !== 'function') return undefined
  try {
    return fn.call(owner)
  } catch {
    return undefined
  }
}

/** thenable 一律 await；同步值原样返回。两种宿主动词都接受（Promise / 数组）。 */
async function settle(value: unknown): Promise<unknown> {
  if (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
  ) {
    try {
      return await (value as PromiseLike<unknown>)
    } catch {
      // 列表读取失败 → 当作"这一路没有数据"，由调用方决定可用性
      return undefined
    }
  }
  return value
}

/**
 * 读 durable 归档集合。
 *
 * 形态是 `workspaceRegistry.archivedSessionIds` 的 getter（宿主侧声明为
 * `readonly SessionId[]`）；`SessionId` 在运行期就是字符串。getter 抛错、字段缺失、
 * 元素畸形都退化为"没有归档"——**只影响灰显，不影响可用性**。
 */
function archivedSet(raw: unknown): ReadonlySet<string> {
  let resolved: unknown = raw
  if (typeof resolved === 'function') {
    try {
      resolved = (resolved as () => unknown)()
    } catch {
      return new Set()
    }
  }
  if (resolved === null || typeof resolved !== 'object') return new Set()
  let value: unknown
  try {
    value = (resolved as WorkspaceRegistryLike).archivedSessionIds
  } catch {
    return new Set()
  }
  if (typeof value === 'function') {
    try {
      value = (value as () => unknown)()
    } catch {
      return new Set()
    }
  }
  if (!Array.isArray(value)) return new Set()
  const out = new Set<string>()
  for (const item of value) {
    const id = typeof item === 'string'
      ? item
      : typeof item === 'number' ? String(item) : undefined
    if (id !== undefined && id.length > 0) out.add(id)
  }
  return out
}

/**
 * 取一个活会话的标题。
 *
 * **只对活会话调用**：`sessionTitle.get(session)` 要的是 `Session` 对象，
 * 拿 id 或 header 调是错的。取不到 / 抛错 / 空串 一律 null（页面不拿 cwd 冒充标题）。
 */
function titleOf(titles: SessionTitleLike | undefined, session: unknown): string | null {
  if (titles === undefined || typeof titles.get !== 'function') return null
  try {
    const snapshot = titles.get(session) as { readonly title?: unknown } | null | undefined
    if (snapshot === null || snapshot === undefined) return null
    return textOf(snapshot.title) ?? null
  } catch {
    return null
  }
}

/** 排序：未归档在前；同组 createdAt 降序；再按 id 定序（同毫秒时结果确定）。 */
function compareEntries(left: SessionCatalogEntry, right: SessionCatalogEntry): number {
  if (left.archived !== right.archived) return left.archived ? 1 : -1
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** 一次真实读取：解析服务 → 合并两路 → 排序截断。任何异常由外层折成不可用。 */
async function collect(ctx: HostContextLike): Promise<SessionCatalogListing> {
  const persistence = withMethod<SessionPersistenceLike>(readService(ctx, 'sessionPersistence'), 'list')
  const liveService = withMethod<SessionsLike>(readService(ctx, 'sessions'), 'list')
  if (persistence === undefined && liveService === undefined) {
    return unavailable('宿主会话服务不可用（sessionPersistence/sessions 都缺失）')
  }
  const titles = withMethod<SessionTitleLike>(readService(ctx, 'sessionTitle'), 'get')
  const archived = archivedSet(readService(ctx, 'workspaceRegistry'))
  const merged = new Map<string, MergedEntry>()

  if (persistence !== undefined) {
    const rows = await settle(callList(persistence.list, persistence))
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const header = (row as PersistenceSnapshotLike | null | undefined)?.header
        const id = textOf(header?.id)
        if (id === undefined) continue
        merged.set(id, {
          id,
          title: null,
          cwd: textOf(header?.cwd) ?? '',
          createdAt: numberOrZero(header?.createdAt),
          agentPreset: textOf(header?.agentPreset) ?? null,
          live: false,
        })
      }
    }
  }

  if (liveService !== undefined) {
    const sessions = await settle(callList(liveService.list, liveService))
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        const live = session as LiveSessionLike | null | undefined
        const id = textOf(live?.id) ?? textOf(live?.header?.id)
        if (id === undefined) continue
        const title = titleOf(titles, session)
        const existing = merged.get(id)
        if (existing === undefined) {
          // 本进程内新建、还没落盘的会话也要出现在目录里（否则「项目」页会漏活的）
          merged.set(id, {
            id,
            title,
            cwd: textOf(live?.header?.cwd) ?? '',
            createdAt: numberOrZero(live?.header?.createdAt),
            agentPreset: textOf(live?.header?.agentPreset) ?? null,
            live: true,
          })
          continue
        }
        // 去重后活会话**补**两件事：标题，以及旧日志缺的 agentPreset（不覆盖已有字段）
        existing.live = true
        if (title !== null) existing.title = title
        if (existing.cwd.length === 0) existing.cwd = textOf(live?.header?.cwd) ?? ''
        if (existing.createdAt === 0) existing.createdAt = numberOrZero(live?.header?.createdAt)
        if (existing.agentPreset === null) existing.agentPreset = textOf(live?.header?.agentPreset) ?? null
      }
    }
  }

  const items: SessionCatalogEntry[] = []
  for (const entry of merged.values()) {
    items.push(Object.freeze({
      id: entry.id,
      title: entry.title,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      agentPreset: entry.agentPreset,
      archived: archived.has(entry.id),
      live: entry.live,
    }))
  }
  items.sort(compareEntries)

  // 降级口径：**可用但不完整**时必须写明"哪一路缺了"，否则面板会把"只有活会话"
  // 读成"历史会话一条都没有"（这正是状态面要避免的那种谎）。
  const reason = persistence === undefined
    ? '仅活会话可用：宿主未提供 sessionPersistence（历史会话不在目录里）'
    : liveService === undefined
      ? '仅持久化会话可用：宿主未提供 sessions（活会话与标题不可用）'
      : undefined
  return Object.freeze({
    available: true,
    ...reason === undefined ? {} : { reason },
    items: Object.freeze(items.slice(0, MAX_ITEMS)),
  })
}

/**
 * 安装会话目录端口。
 *
 * @param ctx 宿主上下文（只经 `readService` 读服务，不读其他属性——Cordis Guard 会抛）。
 * @returns `{ port, dispose }`：`port` 交给 `kernel.provide(SERVICES.sessionCatalog, …)`，
 *          `dispose` 收进 `dsh/plugin.ts` 的清理链。`dispose` 幂等且绝不抛。
 */
export function installSessionCatalog(ctx: HostContextLike): SessionCatalogInstallation {
  let disposed = false
  const list = async (): Promise<SessionCatalogListing> => {
    if (disposed) return unavailable('会话目录已卸载（插件已关闭）')
    try {
      return await collect(ctx)
    } catch (error) {
      // 兜底：`collect` 内部已逐步 try/catch，这里防的是未来改动的漏网异常
      return unavailable(`会话目录读取失败：${describeError(error)}`)
    }
  }
  return {
    port: Object.freeze({ list }),
    dispose(): void {
      disposed = true
    },
  }
}
