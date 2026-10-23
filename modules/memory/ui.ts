/**
 * 记忆管理侧边栏的数据面（v4.15.0）。
 *
 * 为什么放在记忆模块里而不是新增一个模块行：UI 只是**只读视图**，数据源就是
 * `StoresService` 与库端口；多一行只会多一个插件页开关，却没有任何独立资源。
 * 因此这里只提供 `omb:ui` 服务，**不注册模型工具、不注入提示、不影响热路径**。
 *
 * 边界：
 * - 只读（`list`/`detail`/`overview`），不写库；手动确认仍走用户命令 `/omb-confirm`；
 * - 隐私：这是**用户自己打开的页面**，不是模型上下文；sealed 模式下模型读不到，
 *   但用户仍能看自己的库（服务在用户服务器上、与模型工具是两条通道）——文档写清；
 * - 全部有界：单次 `limit ≤ 50`、跨库最多 64 条候选、详情审计最多 20 条；
 * - 不返回任何密钥/正文以外的内部列（contentHash/sourceRef 可给，用于溯源）。
 */
import type {
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStatusFilter,
  StoreStats,
  TaggedStore,
} from '../../kernel/abi/index.js'
import { OMB_VERSION } from '../../kernel/version.js'
import { asConfirmStore, asRecordScanner, type ConfirmAuditEntry } from './store.js'
import { findRelatedRecords, type RelatedRecord } from './link.js'
import { stageLabel, stageOfMemory, type LifecycleStage } from './lifecycle.js'

/** 侧边栏单次列表上限（超出由前端分页/缩小搜索）。 */
export const UI_LIST_MAX = 50
/** 概览里每个库展示的候选上限。 */
export const UI_CANDIDATE_MAX = 20

export type UiScope = 'user' | 'project' | 'all'
export type UiStatus = 'active' | 'stale' | 'superseded' | 'all'

export interface UiListQuery {
  readonly scope?: UiScope
  readonly status?: UiStatus
  readonly kind?: MemoryKind
  readonly q?: string
  readonly tags?: readonly string[]
  readonly limit?: number
}

export interface UiStoreView {
  readonly scope: MemoryScope
  readonly projectScope: string | null
  readonly stats: StoreStats
  readonly active: number
  readonly candidates: number
}

export interface UiOverview {
  readonly ready: boolean
  readonly detail: string
  readonly openProjects: readonly string[]
  readonly maxOpenProjects: number
  readonly stores: readonly UiStoreView[]
  readonly totalActive: number
  readonly totalCandidates: number
}

export interface UiListItem {
  readonly id: string
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly text: string
  readonly tags: readonly string[]
  readonly assertedBy: string
  readonly stage: LifecycleStage
  readonly stageLabel: string
  readonly observedAt: number
  readonly validTo: number | null
  readonly supersededBy: string | null
  readonly sourceRef: string
  readonly project: string | null
  readonly projectScope: string | null
}

export interface UiListResult {
  readonly items: readonly UiListItem[]
  readonly total: number
  readonly truncated: boolean
}

export interface UiDetail {
  readonly record: UiListItem
  readonly audit: readonly ConfirmAuditEntry[]
  readonly auditAvailable: boolean
  readonly related: readonly RelatedRecord[]
}

export type UiConfirmAction = 'confirm' | 'undo'
/** 手动冲突裁决动作（v4.15.3）：related 只建普通关联；supersede 标"被取代"（非破坏）。 */
export type UiResolveAction = 'relate' | 'supersede'

export interface UiActionResult {
  readonly ok: boolean
  readonly text: string
}

export interface UiResolveInput {
  readonly action: UiResolveAction
  /** 取代方 / 关联起点（必须活跃）。 */
  readonly fromId: string
  /** 被取代方 / 关联终点（必须活跃）。 */
  readonly toId: string
}

/** 运行时读数（v4.15.2）：来自各模块自己的台账，不是"被观测对象自报"。 */
export interface UiRuntime {
  readonly version: string
  readonly stores: {
    readonly ready: boolean
    readonly detail: string
    readonly openProjects: readonly string[]
    readonly maxOpenProjects: number
  }
  readonly privacy?: {
    readonly allowRead: boolean
    readonly allowWrite: boolean
    readonly reason: string
  }
  readonly activity?: {
    readonly total: number
    readonly errors: number
    readonly byKind: Readonly<Record<string, number>>
    readonly recent: readonly { readonly kind: string; readonly detail: string; readonly at: number }[]
  }
  readonly controller?: {
    readonly mode: string
    readonly events: number
    readonly persist: number
    readonly persisted: number
    readonly verifyFailed: number
    readonly failures: Readonly<Record<string, number>>
    readonly duplicateActions: number
  }
  readonly capture?: {
    readonly preferences: number
    readonly failed: number
    readonly proactiveCues: number
    readonly cueFollowUps: number
  }
}

/** 项目画像（v4.15.2）：只读、有界，复用 `SERVICES.projectProfile`。 */
export interface UiProfile {
  readonly available: boolean
  readonly reason?: string
  readonly root?: string
  readonly cwdRel?: string
  readonly branch?: string | null
  readonly head?: string | null
  readonly text?: string
  readonly structure?: {
    readonly topDirs: readonly { readonly name: string; readonly files: number }[]
    readonly sources: readonly { readonly dir: string; readonly files: number; readonly lines: number; readonly tests: number }[]
    readonly files: readonly { readonly path: string; readonly lines: number; readonly symbols: number; readonly imports: number }[]
  }
  readonly evidence?: string
}

export interface UiService {
  overview(): Promise<UiOverview>
  list(query?: UiListQuery): Promise<UiListResult>
  candidates(limit?: number): Promise<UiListResult>
  detail(id: string): Promise<UiDetail | undefined>
  /**
   * 用户动作：确认候选 / 撤销确认（v4.15.1）。
   *
   * 与 `/omb-confirm` **同一实现**（`createConfirmAction`）；UI 不写库、不复制判据。
   */
  act(id: string, action: UiConfirmAction, sessionId?: string | null): Promise<UiActionResult>
  /**
   * 手动冲突裁决（v4.15.3）：建 related 边，或把 `toId` 标为"被 `fromId` 取代"。
   *
   * 语义与 `omb_remember(supersedes=…)` 一致：`validTo + supersededBy + supersedes 边`，
   * **非破坏**（旧条目仍在库里、历史可查）；要求两条都活跃且同作用域，失败如实拒绝。
   */
  resolve(input: UiResolveInput): Promise<UiActionResult>
  /** 运行时读数（v4.15.2）；缺省 = 未接线，返回最小事实。 */
  runtime(): Promise<UiRuntime>
  /** 项目画像（v4.15.2）；缺省/未知 → 如实说明原因。 */
  profile(): Promise<UiProfile>
}

export interface UiServiceDeps {
  readonly stores: {
    status(): { readonly ready: boolean; readonly detail: string; readonly openProjects: readonly string[]; readonly maxOpenProjects: number }
    snapshot(): { readonly user: { readonly stores: readonly TaggedStore[] } | undefined; readonly projects: readonly { readonly projectScope: string | null; readonly stores: readonly TaggedStore[] }[] }
  }
  /** 确认动作（`createConfirmAction(confirmDeps)`）；缺省 = 功能未启用，动作如实拒绝。 */
  readonly confirm?: (input: {
    readonly action: UiConfirmAction
    readonly id: string
    readonly sessionId?: string | null
  }) => Promise<UiActionResult>
  /** 运行时读数装配（内存核里闭包读台账）；缺省只报版本与库状态。 */
  readonly runtime?: () => Promise<Omit<UiRuntime, 'version' | 'stores'>>
  /** 项目画像装配（经 `SERVICES.projectProfile`）；缺省 = 未接线。 */
  readonly profile?: () => Promise<UiProfile>
  /** 时钟（裁决动作需要时间）；缺省 = 写动作如实拒绝。 */
  readonly clock?: { now(): number }
  /** 活动日志口（裁决动作记账；不含正文）。 */
  readonly activity?: (kind: 'write', detail: string) => void
}

/** 状态判据（与检索侧的 `statusClause` 同一语义，前端不需要知道 SQL）。 */
export function uiRecordStatus(record: Pick<MemoryRecord, 'validTo' | 'supersededBy'>): 'active' | 'stale' | 'superseded' {
  if (record.supersededBy !== null) return 'superseded'
  if (record.validTo !== null) return 'stale'
  return 'active'
}

/** 记录 → 列表 DTO（逐字正文；不做摘要）。 */
export function toUiListItem(record: MemoryRecord, projectScope: string | null): UiListItem {
  const stage = stageOfMemory({ kind: record.kind, assertedBy: record.assertedBy })
  return {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    text: record.text,
    tags: record.tags ?? [],
    assertedBy: record.assertedBy,
    stage,
    stageLabel: stageLabel(stage),
    observedAt: record.observedAt,
    validTo: record.validTo,
    supersededBy: record.supersededBy,
    sourceRef: record.sourceRef,
    project: record.project,
    projectScope,
  }
}

function matchesStatus(record: MemoryRecord, status: UiStatus): boolean {
  if (status === 'all') return true
  return uiRecordStatus(record) === status
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

/** 有界扫描（`listRecentRecords` 没有状态/类型过滤；在 JS 里裁剪，但先限总量）。 */
const SCAN_MAX = 500

interface StoreRef {
  readonly projectScope: string | null
  readonly store: TaggedStore['store']
}

function collectStores(deps: UiServiceDeps, scope: UiScope): readonly StoreRef[] {
  const snapshot = deps.stores.snapshot()
  const refs: StoreRef[] = []
  if (scope === 'user' || scope === 'all') {
    for (const tagged of snapshot.user?.stores ?? []) refs.push({ projectScope: null, store: tagged.store })
  }
  if (scope === 'project' || scope === 'all') {
    for (const set of snapshot.projects) {
      for (const tagged of set.stores) refs.push({ projectScope: set.projectScope, store: tagged.store })
    }
  }
  return refs
}

/**
 * 造数据服务。
 *
 * 每个方法都只读、失败返回空/如实降级（**不抛到 HTTP 层**——页面要能显示"库未就绪"）。
 */
export function createUiService(deps: UiServiceDeps): UiService {
  const scanRecent = async (ref: StoreRef): Promise<readonly MemoryRecord[]> => {
    const scanner = asRecordScanner(ref.store)
    if (scanner === undefined) return []
    try {
      return await scanner.listRecentRecords({ limit: SCAN_MAX })
    } catch {
      return []
    }
  }

  const search = async (ref: StoreRef, query: UiListQuery): Promise<readonly MemoryRecord[]> => {
    const text = (query.q ?? '').trim()
    if (text.length === 0) return scanRecent(ref)
    const status: MemoryStatusFilter = query.status ?? 'active'
    const base = {
      text,
      scope: ref.store.scope,
      ...(query.kind === undefined ? {} : { kinds: [query.kind] as readonly MemoryKind[] }),
      status,
      ...(query.tags === undefined || query.tags.length === 0 ? {} : { tags: query.tags }),
      limit: UI_LIST_MAX,
    }
    try {
      let hits = await ref.store.searchLexical(base)
      if (hits.length === 0 && typeof ref.store.searchFuzzy === 'function') {
        hits = await ref.store.searchFuzzy(base)
      }
      if (hits.length === 0) return []
      const records = await ref.store.getMany(hits.map(hit => hit.id))
      const byId = new Map(records.map(record => [record.id, record]))
      return hits.map(hit => byId.get(hit.id)).filter((record): record is MemoryRecord => record !== undefined)
    } catch {
      return []
    }
  }

  const list = async (query: UiListQuery = {}): Promise<UiListResult> => {
    const scope = query.scope ?? 'all'
    const status = query.status ?? 'active'
    const limit = clampLimit(query.limit, 20, UI_LIST_MAX)
    const refs = collectStores(deps, scope)
    const gathered: { record: MemoryRecord; projectScope: string | null }[] = []
    for (const ref of refs) {
      const records = await search(ref, query)
      for (const record of records) {
        if (!matchesStatus(record, status)) continue
        if (query.kind !== undefined && record.kind !== query.kind) continue
        if (query.tags !== undefined && query.tags.length > 0) {
          const tags = record.tags ?? []
          if (!query.tags.every(tag => tags.includes(tag))) continue
        }
        gathered.push({ record, projectScope: ref.projectScope })
      }
    }
    gathered.sort((left, right) =>
      right.record.observedAt - left.record.observedAt || left.record.id.localeCompare(right.record.id))
    const items = gathered.slice(0, limit).map(entry => toUiListItem(entry.record, entry.projectScope))
    return { items, total: gathered.length, truncated: gathered.length > limit }
  }

  const overview = async (): Promise<UiOverview> => {
    const status = deps.stores.status()
    const snapshot = deps.stores.snapshot()
    const stores: UiStoreView[] = []
    let totalActive = 0
    let totalCandidates = 0
    const pushSet = async (set: { readonly projectScope: string | null; readonly stores: readonly TaggedStore[] }): Promise<void> => {
      for (const tagged of set.stores) {
        let stats: StoreStats
        try {
          stats = await tagged.store.stats()
        } catch {
          stats = { scope: tagged.store.scope, rows: 0, schemaVersion: 0, vectors: null }
        }
        let active = 0
        let candidates = 0
        for (const record of await scanRecent({ projectScope: set.projectScope, store: tagged.store })) {
          if (uiRecordStatus(record) === 'active') {
            active += 1
            if (record.assertedBy === 'model' && (record.kind === 'semantic' || record.kind === 'procedural')) {
              candidates += 1
            }
          }
        }
        totalActive += active
        totalCandidates += candidates
        stores.push({ scope: tagged.store.scope, projectScope: set.projectScope, stats, active, candidates })
      }
    }
    if (snapshot.user !== undefined) await pushSet({ projectScope: null, stores: snapshot.user.stores })
    for (const set of snapshot.projects) await pushSet(set)
    return {
      ready: status.ready,
      detail: status.detail,
      openProjects: [...status.openProjects],
      maxOpenProjects: status.maxOpenProjects,
      stores,
      totalActive,
      totalCandidates,
    }
  }

  const candidates = async (limit?: number): Promise<UiListResult> => {
    const result = await list({ scope: 'all', status: 'active', limit: clampLimit(limit, 20, UI_LIST_MAX) })
    const items = result.items.filter(item =>
      item.assertedBy === 'model' && (item.kind === 'semantic' || item.kind === 'procedural'))
    return { items, total: items.length, truncated: result.truncated }
  }

  const detail = async (id: string): Promise<UiDetail | undefined> => {
    const refs = collectStores(deps, 'all')
    for (const ref of refs) {
      let record: MemoryRecord | undefined
      try {
        record = await ref.store.get(id)
      } catch {
        record = undefined
      }
      if (record === undefined) continue
      let audit: readonly ConfirmAuditEntry[] = []
      let auditAvailable = true
      try {
        const api = asConfirmStore(ref.store)
        if (api === undefined) auditAvailable = false
        else audit = await api.confirmLog(id, 20)
      } catch {
        audit = []
        auditAvailable = false
      }
      let related: readonly RelatedRecord[] = []
      try {
        related = await findRelatedRecords(ref.store, record)
      } catch {
        related = []
      }
      return { record: toUiListItem(record, ref.projectScope), audit, auditAvailable, related }
    }
    return undefined
  }

  const findRef = async (id: string): Promise<{ readonly ref: StoreRef; readonly record: MemoryRecord } | undefined> => {
    for (const ref of collectStores(deps, 'all')) {
      try {
        const record = await ref.store.get(id)
        if (record !== undefined) return { ref, record }
      } catch {
        // 单库失败不拦：另一个库可能还有这条
      }
    }
    return undefined
  }

  return { overview, list, candidates, detail, act, resolve, runtime, profile }

  async function resolve(input: UiResolveInput): Promise<UiActionResult> {
    const { action } = input
    if (action !== 'relate' && action !== 'supersede') {
      return { ok: false, text: `未执行：未知动作 ${String(action)}。` }
    }
    const fromId = typeof input.fromId === 'string' ? input.fromId.trim() : ''
    const toId = typeof input.toId === 'string' ? input.toId.trim() : ''
    if (fromId.length === 0 || toId.length === 0) return { ok: false, text: '未执行：fromId/toId 不能为空。' }
    if (fromId === toId) return { ok: false, text: '未执行：两条 id 相同（不能指向自己）。' }
    const clock = deps.clock
    if (clock === undefined) return { ok: false, text: '未执行：时钟未接线（裁决动作需要时间戳）。' }
    const newer = await findRef(fromId)
    const older = await findRef(toId)
    if (newer === undefined || older === undefined) {
      return {
        ok: false,
        text: `未执行：${newer === undefined ? `找不到 fromId=${fromId}` : `找不到 toId=${toId}`}（用户库/项目库都查过）。`,
      }
    }
    if (newer.ref.store.scope !== older.ref.store.scope) {
      return { ok: false, text: '未执行：两条不在同一作用域（用户库 / 项目库），裁决不跨库。' }
    }
    if (newer.ref.store !== older.ref.store) {
      return { ok: false, text: '未执行：两条属于不同的项目库（跨工作区），裁决不跨库。' }
    }
    const active = (record: MemoryRecord): boolean => record.validTo === null && record.supersededBy === null
    const now = clock.now()
    const store = newer.ref.store

    if (action === 'relate') {
      if (!active(newer.record) || !active(older.record)) {
        return { ok: false, text: '未执行：关联要求两条都活跃（已失效/被取代的条目不参与）。' }
      }
      try {
        await store.upsertEdge({ fromId, toId, type: 'related', createdAt: now })
      } catch (error) {
        return { ok: false, text: `建立关联失败（已隔离）：${error instanceof Error ? error.message : String(error)}` }
      }
      deps.activity?.('write', `ui:relate ${fromId}→${toId}`)
      return { ok: true, text: `已建立关联：${fromId} → ${toId}（related 边；不改任何正文/状态）。` }
    }

    // supersede：fromId（新）取代 toId（旧）
    if (!active(newer.record)) return { ok: false, text: '未执行：取代方必须活跃（已失效/被取代的条目不能再取代别人）。' }
    if (!active(older.record)) {
      return {
        ok: false,
        text: `未执行：被取代条目已处于非活跃状态（${older.record.supersededBy === null ? '已失效' : `已被 ${older.record.supersededBy} 取代`}）。`,
      }
    }
    const marked: MemoryRecord = {
      ...older.record,
      validTo: Math.max(now, older.record.observedAt),
      supersededBy: newer.record.id,
    }
    try {
      await store.put(marked)
    } catch (error) {
      return { ok: false, text: `标注旧条目失败（已隔离，未改动任何数据）：${error instanceof Error ? error.message : String(error)}` }
    }
    let verified: MemoryRecord | undefined
    try {
      verified = (await store.getMany([older.record.id]))[0]
    } catch {
      verified = undefined
    }
    if (verified === undefined || verified.supersededBy !== newer.record.id) {
      return { ok: false, text: `标注后查回失败（id=${older.record.id}）：状态未确认，请重试或检查库。` }
    }
    let edgeError: string | undefined
    try {
      await store.upsertEdge({ fromId: newer.record.id, toId: older.record.id, type: 'supersedes', createdAt: now })
    } catch (error) {
      edgeError = error instanceof Error ? error.message : String(error)
    }
    deps.activity?.('write', `ui:supersede ${fromId}→${toId}`)
    const lines = [
      `已标注：${older.record.id} 被 ${newer.record.id} 取代（validTo + supersededBy；非破坏，旧条目仍在库里）。`,
      edgeError === undefined
        ? 'supersedes 边已建立（omb_relate 可追溯这一跳）。'
        : `⚠ supersedes 边未建成：${edgeError}（状态已生效，只是 omb_relate 追不到这一跳）。`,
    ]
    return { ok: true, text: lines.join('\n') }
  }

  async function runtime(): Promise<UiRuntime> {
    const base: UiRuntime = { version: OMB_VERSION, stores: deps.stores.status() }
    if (deps.runtime === undefined) return base
    try {
      return { ...base, ...(await deps.runtime()) }
    } catch {
      return base
    }
  }

  async function profile(): Promise<UiProfile> {
    if (deps.profile === undefined) {
      return { available: false, reason: '未接线：项目画像服务不可用（dsh/project-profile 未挂载）' }
    }
    try {
      return await deps.profile()
    } catch (error) {
      return { available: false, reason: `画像读取失败（已隔离）：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async function act(id: string, action: UiConfirmAction, sessionId?: string | null): Promise<UiActionResult> {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (trimmed.length === 0) return { ok: false, text: '未执行：id 不能为空。' }
    if (action !== 'confirm' && action !== 'undo') return { ok: false, text: `未执行：未知动作 ${String(action)}。` }
    const confirm = deps.confirm
    if (confirm === undefined) return { ok: false, text: '确认功能未启用（config.confirmCommand=false）。' }
    try {
      return await confirm({ action, id: trimmed, sessionId: sessionId ?? null })
    } catch (error) {
      return { ok: false, text: `执行失败（已隔离）：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
