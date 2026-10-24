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
  ControllerAdminEdit,
  ControllerAdminPort,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStatusFilter,
  SessionCatalogPort,
  StoreStats,
  TaggedStore,
} from '../../kernel/abi/index.js'
import { OMB_VERSION } from '../../kernel/version.js'
import { asConfirmStore, asRecordScanner, type ConfirmAuditEntry } from './store.js'
import { findRelatedRecords, type RelatedRecord } from './link.js'
import { stageLabel, stageOfMemory, type LifecycleStage } from './lifecycle.js'
import { contentHashOf, newMemoryId } from './remember.js'
import { isPrivacyMode, type PrivacyMode } from './privacy/modes.js'
import type { PrivacyActionName, PrivacyAdminPort, UiPrivacyView } from './privacy/contract.js'

/** 侧边栏单次列表上限（超出由前端分页/缩小搜索）。 */
export const UI_LIST_MAX = 50
/** 概览里每个库展示的候选上限。 */
export const UI_CANDIDATE_MAX = 20

export type UiScope = 'user' | 'project' | 'all'
export type UiStatus = 'active' | 'stale' | 'superseded' | 'candidate' | 'all'

export interface UiListQuery {
  readonly scope?: UiScope
  readonly status?: UiStatus
  readonly kind?: MemoryKind
  readonly q?: string
  readonly tags?: readonly string[]
  readonly limit?: number
  /** 分页偏移（v4.18）：第 N 页 = offset N×limit；由前端“上一页/下一页”驱动。 */
  readonly offset?: number
}

/** 手动新建（v4.18）：用户自己的写入，`assertedBy='user'`、`sourceRef='ui:manual'`。 */
export interface UiMemoryCreateInput {
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly text: string
  readonly tags?: readonly string[]
}

/** 手动编辑（v4.18）：只允许活跃记录；保留 id/observedAt/sourceRef/assertedBy/useCount。 */
export interface UiMemoryUpdateInput {
  readonly id: string
  readonly text?: string
  readonly kind?: MemoryKind
  readonly tags?: readonly string[]
}

/** 手动标记：确认（复用 /omb-confirm）/ 标失效 / 复活。 */
export type UiMemoryMark = 'confirm' | 'obsolete' | 'revive'

/** 项目页的一行会话（v4.18）。归档会话保留在列表里（灰色），但不可读。 */
export interface UiSessionItem {
  readonly id: string
  readonly title: string | null
  readonly cwd: string
  readonly root: string | null
  readonly preset: string | null
  readonly archived: boolean
  readonly active: boolean
  /** `kernel.focus(sessionId)`；拿不到为 null。 */
  readonly depth: string | null
  readonly privacy: {
    readonly mode: 'normal' | 'read-only' | 'sealed'
    readonly origin: string
    readonly inheritedFrom: string | null
  } | null
  readonly createdAt: number
}

export interface UiSessionList {
  readonly available: boolean
  readonly reason?: string
  readonly items: readonly UiSessionItem[]
}

export interface UiPersonalEntry {
  readonly axis: string
  readonly axisLabel: string
  readonly key: string
  readonly value: string
  readonly provenance: 'declared' | 'inferred'
  readonly evidence: readonly string[]
  readonly updated: number
}

export interface UiPersonalView {
  readonly available: boolean
  readonly reason?: string
  readonly status?: {
    readonly available: boolean
    readonly detail: string
    readonly declared: number
    readonly inferred: number
    readonly conflicts: number
    readonly capabilityAxis: 'off' | 'on-session-only'
  }
  readonly entries: readonly UiPersonalEntry[]
  readonly conflicts: readonly {
    readonly axis: string
    readonly axisLabel: string
    readonly key: string
    readonly values: readonly {
      readonly value: string
      readonly provenance: 'declared' | 'inferred'
      readonly updated: number
    }[]
  }[]
  /** `renderDeclared(12, sessionId)` 的文本。 */
  readonly text: string
}

/** 控制器设置页的只读视图（v4.19.0）。 */
export interface UiControllerView {
  readonly available: boolean
  readonly reason?: string
  readonly sessionId?: string
  readonly phase?: 'idle' | 'candidate-pending' | 'tracking-tasks' | 'mixed'
  readonly tasks: readonly {
    readonly text: string
    readonly at: number
    readonly expiresAt: number
  }[]
  readonly candidates: readonly {
    readonly id: string
    readonly text: string
    readonly kind: string
    readonly scope: string
    readonly at: number
    readonly reason: string
  }[]
  readonly lastEventAt?: number | null
}

/** 控制器手动编辑的五个动作（与 `ControllerAdminEdit.kind` 同一取值域）。 */
export type UiControllerAction =
  | 'add-task'
  | 'remove-task'
  | 'clear-tasks'
  | 'remove-candidate'
  | 'clear-candidates'

export interface UiControllerActInput {
  readonly action: UiControllerAction
  readonly sessionId?: string
  readonly text?: string
}

/** 个人画像写入动作（v4.19.0）：能力轴被排除（它只在会话内存，不落盘）。 */
export type UiPersonalEditInput =
  | {
      readonly action: 'declare'
      readonly axis: string
      readonly key: string
      readonly value: string
      readonly evidence?: readonly string[]
    }
  | {
      readonly action: 'retract'
      readonly axis: string
      readonly key: string
    }

export interface UiStoreView {
  readonly scope: MemoryScope
  readonly projectScope: string | null
  readonly stats: StoreStats
  readonly active: number
  readonly candidates: number
  /** v4.16.0：活跃/候选计数只覆盖最近 `SCAN_MAX` 行（库更大时不得冒充全量）。 */
  readonly scanLimited: boolean
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
  /** 当前活跃会话的状态机读数（v4.15.4）：会话/空闲/目标/工作区切换。 */
  readonly situation?: {
    readonly sessionId?: string
    readonly state?: string
    readonly tier?: string
    readonly turn?: number
    readonly idleMs?: number | null
    readonly lastTurnEndReason?: string | null
    readonly interrupted?: boolean
    readonly unresolved?: boolean
    readonly goals?: { readonly open: number; readonly total: number }
    readonly todos?: { readonly open: number; readonly total: number }
    readonly workspace?: {
      readonly root?: string
      readonly switches?: number
      readonly previousRoot?: string | null
      readonly since?: number
    }
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
  /** 项目画像（v4.15.2）：给 sessionId 时按该会话（归档会话不可读）。 */
  profile(sessionId?: string): Promise<UiProfile>
  /**
   * 手动新建一条记忆（v4.18）。project 作用域必须有当前会话；文本 1..4000、
   * 标签 ≤8×≤24；写入后查回验证。隐私拒绝原样返回文本。
   */
  createMemory(input: UiMemoryCreateInput): Promise<UiActionResult>
  /** 手动编辑（只允许活跃记录）；写后查回验证。 */
  updateMemory(input: UiMemoryUpdateInput): Promise<UiActionResult>
  /** 手动删除（结构化探测 store 的 `forget`；删后查回不存在）。 */
  deleteMemory(id: string): Promise<UiActionResult>
  /** 手动标记：confirm 复用 `/omb-confirm`；obsolete 写 validTo；revive 只清 validTo。 */
  markMemory(id: string, mark: UiMemoryMark): Promise<UiActionResult>
  /** 项目页：只列 `agentPreset === 'omb'` 的会话；目录不可用如实说明。 */
  sessions(): Promise<UiSessionList>
  /** 个人画像页：读 `SERVICES.profile`；缺失/异常如实降级。 */
  personal(): Promise<UiPersonalView>
  /**
   * 控制器设置页（v4.19.0）：读某会话的任务约束/候选/阶段。缺省用当前会话；
   * 无管理端口/无会话 → available:false（不猜）。
   */
  controller(sessionId?: string): Promise<UiControllerView>
  /** 控制器手动编辑（v4.19.0）：add/remove task、clear tasks、remove/clear candidates。 */
  controllerAct(input: UiControllerActInput): Promise<UiActionResult>
  /** 个人画像写入（v4.19.0）：declare / retract；能力轴被拒绝（只存在会话内存）。 */
  personalAct(input: UiPersonalEditInput): Promise<UiActionResult>
  /**
   * 会话隐私页的完整视图（v4.17）。未接线/异常 → 返回**完整形状**的降级视图，
   * 不抛到 HTTP 层（页面要能显示"未接线"而不是白屏）。
   */
  privacy(): Promise<UiPrivacyView>
  /**
   * 会话隐私页的用户动作（v4.17）。只接受白名单动作；写操作只来自 HTTP POST，
   * 模型工具没有隐私入口。参数非法 → `{ok:false}`，不猜。
   */
  privacyAct(input: {
    readonly action: PrivacyActionName
    readonly sessionId?: string
    readonly mode?: PrivacyMode
  }): Promise<UiActionResult>
}

export interface UiServiceDeps {
  readonly stores: {
    status(): { readonly ready: boolean; readonly detail: string; readonly openProjects: readonly string[]; readonly maxOpenProjects: number }
    snapshot(): { readonly user: { readonly stores: readonly TaggedStore[] } | undefined; readonly projects: readonly { readonly projectScope: string | null; readonly stores: readonly TaggedStore[] }[] }
    /**
     * 按会话取**过隐私闸门**的库套件（v4.18 手动写入用）。缺失 = 退回快照库
     * （归属未知：读可以、写会被拒——拒绝原因原样返回给页面）。
     */
    forSession?(sessionId: string): Promise<{
      readonly projectScope: string | null
      readonly stores: readonly TaggedStore[]
      store(scope: MemoryScope): TaggedStore['store'] | undefined
    } | undefined>
  }
  /** 当前会话 id（页面写操作的归属）；缺省回退 `privacy.current`。 */
  readonly currentSession?: () => string | null
  /** 会话目录（项目页）；缺失 → `sessions()` 返回 available:false。 */
  readonly sessionCatalog?: SessionCatalogPort
  /** 会话目录的补充读数（由 memory/index 闭包从内核服务解析）。 */
  readonly sessionRuntime?: { list(): readonly { readonly sessionId: string; readonly observations: number }[] }
  readonly rootOf?: (cwd: string) => string | null
  readonly focusOf?: (sessionId: string) => string | null
  /** 个人画像视图装配（经 `SERVICES.profile`）；缺省 = 未接线。 */
  readonly personal?: () => Promise<UiPersonalView>
  /** 按会话读项目画像（memory/index 闭包解析 catalog → projectRoot → profile）；缺省 = 未接线。 */
  readonly profileForSession?: (sessionId: string) => Promise<UiProfile>
  /** 控制器管理端口（v4.19.0；由 memory/index 把 capture 的读写包成服务）；缺省 = 未接线。 */
  readonly controllerAdmin?: ControllerAdminPort
  /**
   * 个人画像写入（v4.19.0；memory/index 闭包调 `SERVICES.profile.declare/retract`）。
   * 允许同步或异步结果：profile 服务是异步的，provider 可以 await 后再返回。
   */
  readonly personalEdit?: (
    input: UiPersonalEditInput,
  ) => UiActionResult | Promise<UiActionResult>
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
  /** 会话隐私管理（v4.17）：`current` 取当前会话 id，`admin` 是 installPrivacy 的管理端口。 */
  readonly privacy?: {
    readonly current: () => string | null
    readonly admin: PrivacyAdminPort
  }
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
  if (status === 'candidate') {
    return uiRecordStatus(record) === 'active'
      && record.assertedBy === 'model'
      && (record.kind === 'semantic' || record.kind === 'procedural')
  }
  return uiRecordStatus(record) === status
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

/** 分页偏移：负值/非数字按 0；上限防止一次扫太多行（页面跳转由 limit 控制）。 */
function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(4000, Math.max(0, Math.floor(value)))
}

/** 手动写入的硬边界（v4.18 §2.2）。 */
const UI_TEXT_MAX = 4000
const UI_TAGS_MAX = 8
const UI_TAG_CHARS_MAX = 24

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeUiText(raw: unknown): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { ok: false, text: '未执行：正文不能为空。' }
  if (text.length > UI_TEXT_MAX) return { ok: false, text: `未执行：正文最多 ${UI_TEXT_MAX} 个字符。` }
  return { ok: true, text }
}

function normalizeUiTags(raw: unknown): { readonly ok: true; readonly tags: readonly string[] } | { readonly ok: false; readonly text: string } {
  if (raw === undefined) return { ok: true, tags: [] }
  if (!Array.isArray(raw)) return { ok: false, text: '未执行：标签必须是字符串数组。' }
  const tags: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, text: '未执行：标签必须是字符串数组。' }
    const tag = item.trim()
    if (tag.length === 0) continue
    if (tag.length > UI_TAG_CHARS_MAX) return { ok: false, text: `未执行：单个标签最多 ${UI_TAG_CHARS_MAX} 个字符。` }
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > UI_TAGS_MAX) return { ok: false, text: `未执行：标签最多 ${UI_TAGS_MAX} 个。` }
  return { ok: true, tags }
}

function isActiveRecord(record: Pick<MemoryRecord, 'validTo' | 'supersededBy'>): boolean {
  return record.validTo === null && record.supersededBy === null
}

/** 有界扫描（`listRecentRecords` 没有状态/类型过滤；在 JS 里裁剪，但先限总量）。 */
const SCAN_MAX = 500

/** 设置页允许的隐私动作白名单（与 `POST /privacy` 同步）。 */
const PRIVACY_ACTIONS: readonly PrivacyActionName[] = ['set', 'clear', 'clear-inactive', 'trust']
/**
 * 会话 id 的长度上限（v4.17）。设置页允许手填会话 id；不设上限时 4KB 请求体
 * 可以把任意长字符串写进隐私状态文件。宿主会话 id 远小于这个值。
 */
const MAX_PRIVACY_SESSION_ID = 200

/**
 * 完整形状的隐私降级视图（v4.17）。
 *
 * 为什么字段一个都不能少：前端按 `available` 渲染提示，但其余字段仍会被读取；
 * 少一个键就会在浏览器里变成 `undefined`，页面把"未接线"画成"0 条设置"。
 */
function emptyPrivacyView(reason: string, commandState = '未接线'): UiPrivacyView {
  return {
    available: false,
    reason,
    baseline: { mode: 'normal', origin: 'default', detail: reason },
    current: null,
    sessions: [],
    restricted: null,
    durable: { path: null, ok: false, detail: '未知', savedAt: null },
    commands: { privacy: '/omb-privacy', clean: '/omb-privacy-clean', state: commandState },
    stats: {
      decisions: 0,
      readDenials: 0,
      writeDenials: 0,
      unattributedWriteDenials: 0,
      lastDeniedSession: null,
      lastDeniedReason: null,
    },
  }
}

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
  const scanRecent = async (ref: StoreRef, limit: number): Promise<readonly MemoryRecord[]> => {
    const scanner = asRecordScanner(ref.store)
    if (scanner === undefined) return []
    try {
      return await scanner.listRecentRecords({ limit })
    } catch {
      return []
    }
  }

  const search = async (ref: StoreRef, query: UiListQuery, limit: number): Promise<readonly MemoryRecord[]> => {
    const text = (query.q ?? '').trim()
    if (text.length === 0) return scanRecent(ref, limit)
    // 'candidate' 不是检索状态过滤（它由 assertedBy/kind 复合判定）；词法层按 active 查。
    const lexicalStatus: MemoryStatusFilter = query.status === 'candidate' ? 'active' : query.status ?? 'active'
    const base = {
      text,
      scope: ref.store.scope,
      ...(query.kind === undefined ? {} : { kinds: [query.kind] as readonly MemoryKind[] }),
      status: lexicalStatus,
      ...(query.tags === undefined || query.tags.length === 0 ? {} : { tags: query.tags }),
      limit,
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
    const offset = clampOffset(query.offset)
    // 多取 1 条判断“下一页还有没有”；状态/候选过滤在 JS 侧，额外留 32 条余量。
    const searchLimit = offset + limit + 33
    const refs = collectStores(deps, scope)
    const gathered: { record: MemoryRecord; projectScope: string | null }[] = []
    for (const ref of refs) {
      const records = await search(ref, query, searchLimit)
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
    const page = gathered.slice(offset, offset + limit)
    const items = page.map(entry => toUiListItem(entry.record, entry.projectScope))
    return { items, total: gathered.length, truncated: gathered.length > offset + limit }
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
        const scannedRows = await scanRecent({ projectScope: set.projectScope, store: tagged.store }, SCAN_MAX)
        for (const record of scannedRows) {
          if (uiRecordStatus(record) === 'active') {
            active += 1
            if (record.assertedBy === 'model' && (record.kind === 'semantic' || record.kind === 'procedural')) {
              candidates += 1
            }
          }
        }
        totalActive += active
        totalCandidates += candidates
        stores.push({
          scope: tagged.store.scope,
          projectScope: set.projectScope,
          stats,
          active,
          candidates,
          scanLimited: stats.rows > scannedRows.length,
        })
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
    // v4.16.0：先按候选判据过滤**再**截断。旧实现先 list 再 filter，
    // 当库里有大量已确认/事件条目时会漏掉排在后面的候选（分页语义错了）。
    const effective = clampLimit(limit, 20, UI_LIST_MAX)
    const gathered: { record: MemoryRecord; projectScope: string | null }[] = []
    for (const ref of collectStores(deps, 'all')) {
      const scanned = await scanRecent(ref, SCAN_MAX)
      for (const record of scanned) {
        if (uiRecordStatus(record) !== 'active') continue
        if (record.assertedBy !== 'model') continue
        if (record.kind !== 'semantic' && record.kind !== 'procedural') continue
        gathered.push({ record, projectScope: ref.projectScope })
      }
    }
    gathered.sort((left, right) =>
      right.record.observedAt - left.record.observedAt || left.record.id.localeCompare(right.record.id))
    const items = gathered.slice(0, effective).map(entry => toUiListItem(entry.record, entry.projectScope))
    return { items, total: gathered.length, truncated: gathered.length > effective }
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

  // ── v4.18 手动写入的库访问：有会话走隐私闸门，无会话退回快照库 ──────
  const currentSessionId = (): string | null => {
    try {
      const id = deps.currentSession?.() ?? deps.privacy?.current?.() ?? null
      return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null
    } catch {
      return null
    }
  }

  const sessionRefs = async (): Promise<readonly StoreRef[] | undefined> => {
    const sessionId = currentSessionId()
    if (sessionId === null || deps.stores.forSession === undefined) return undefined
    try {
      const set = await deps.stores.forSession(sessionId)
      if (set === undefined) return undefined
      return set.stores.map(tagged => ({
        projectScope: tagged.scope === 'project' ? set.projectScope : null,
        store: tagged.store,
      }))
    } catch {
      return undefined
    }
  }

  const accessRefs = async (): Promise<readonly StoreRef[]> =>
    (await sessionRefs()) ?? collectStores(deps, 'all')

  const findAccessibleRef = async (
    id: string,
  ): Promise<{ readonly ref: StoreRef; readonly record: MemoryRecord } | undefined> => {
    for (const ref of await accessRefs()) {
      try {
        const record = await ref.store.get(id)
        if (record !== undefined) return { ref, record }
      } catch {
        // 单个库读取被隐私拒绝/故障不拦另一个库
      }
    }
    return undefined
  }

  const storeForScope = async (scope: MemoryScope): Promise<StoreRef | undefined> =>
    (await accessRefs()).find(ref => ref.store.scope === scope)

  async function createMemory(input: UiMemoryCreateInput): Promise<UiActionResult> {
    const clock = deps.clock
    if (clock === undefined) return { ok: false, text: '未执行：时钟未接线（新建需要时间戳）。' }
    if (input.scope !== 'user' && input.scope !== 'project') {
      return { ok: false, text: `未执行：未知作用域 ${String(input.scope)}。` }
    }
    if (input.kind !== 'semantic' && input.kind !== 'procedural' && input.kind !== 'episodic') {
      return { ok: false, text: `未执行：未知记忆类型 ${String(input.kind)}。` }
    }
    const textCheck = normalizeUiText(input.text)
    if (!textCheck.ok) return { ok: false, text: textCheck.text }
    const tagsCheck = normalizeUiTags(input.tags)
    if (!tagsCheck.ok) return { ok: false, text: tagsCheck.text }
    if (input.scope === 'project' && currentSessionId() === null) {
      return { ok: false, text: '未执行：项目作用域需要当前会话（拿不到会话归属，不猜项目库）。' }
    }
    const ref = await storeForScope(input.scope)
    if (ref === undefined) {
      return { ok: false, text: `未执行：${input.scope === 'user' ? '用户库' : '项目库'}不可用（未打开或未接线）。` }
    }
    const hash = contentHashOf(textCheck.text)
    const id = newMemoryId(clock, hash)
    const now = clock.now()
    const record: MemoryRecord = {
      id,
      scope: input.scope,
      kind: input.kind,
      text: textCheck.text,
      contentHash: hash,
      sourceRef: 'ui:manual',
      assertedBy: 'user',
      observedAt: now,
      validTo: null,
      supersededBy: null,
      lastUsedAt: now,
      useCount: 0,
      project: input.scope === 'project' ? ref.projectScope ?? null : null,
      tags: tagsCheck.tags,
    }
    try {
      await ref.store.put(record)
    } catch (error) {
      return { ok: false, text: `新建失败：${errorMessageOf(error)}` }
    }
    try {
      const back = await ref.store.get(id)
      if (back === undefined || back.text !== textCheck.text) {
        return { ok: false, text: '新建后查回失败：记录未确认写入，请重试。' }
      }
    } catch (error) {
      return { ok: false, text: `新建后查回失败（已隔离）：${errorMessageOf(error)}` }
    }
    deps.activity?.('write', `ui:create ${id}`)
    return { ok: true, text: `已新建记忆 ${id}（${input.scope}/${input.kind}）。` }
  }

  async function updateMemory(input: UiMemoryUpdateInput): Promise<UiActionResult> {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (id.length === 0) return { ok: false, text: '未执行：id 不能为空。' }
    const hasText = input.text !== undefined
    const hasKind = input.kind !== undefined
    const hasTags = input.tags !== undefined
    if (!hasText && !hasKind && !hasTags) return { ok: false, text: '未执行：没有要修改的字段。' }
    let nextText: string | undefined
    if (hasText) {
      const textCheck = normalizeUiText(input.text)
      if (!textCheck.ok) return { ok: false, text: textCheck.text }
      nextText = textCheck.text
    }
    if (hasKind && input.kind !== 'semantic' && input.kind !== 'procedural' && input.kind !== 'episodic') {
      return { ok: false, text: `未执行：未知记忆类型 ${String(input.kind)}。` }
    }
    let nextTags: readonly string[] | undefined
    if (hasTags) {
      const tagsCheck = normalizeUiTags(input.tags)
      if (!tagsCheck.ok) return { ok: false, text: tagsCheck.text }
      nextTags = tagsCheck.tags
    }
    const found = await findAccessibleRef(id)
    if (found === undefined) return { ok: false, text: `未执行：找不到这条记忆（id=${id}；用户库/项目库都查过，或隐私拒绝）。` }
    if (!isActiveRecord(found.record)) {
      return { ok: false, text: '未执行：只能编辑活跃记录（已失效/被取代的条目不可改）。' }
    }
    const next: MemoryRecord = {
      ...found.record,
      ...(nextText === undefined ? {} : { text: nextText }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(nextTags === undefined ? {} : { tags: nextTags }),
      ...(nextText === undefined || nextText === found.record.text ? {} : { contentHash: contentHashOf(nextText) }),
    }
    try {
      await found.ref.store.put(next)
    } catch (error) {
      return { ok: false, text: `保存失败：${errorMessageOf(error)}` }
    }
    try {
      const back = await found.ref.store.get(id)
      const expectedText = nextText ?? found.record.text
      if (back === undefined || back.text !== expectedText) {
        return { ok: false, text: '保存后查回失败：内容未确认，请重试。' }
      }
    } catch (error) {
      return { ok: false, text: `保存后查回失败（已隔离）：${errorMessageOf(error)}` }
    }
    deps.activity?.('write', `ui:update ${id}`)
    return { ok: true, text: `已保存记忆 ${id}。` }
  }

  async function deleteMemory(id: string): Promise<UiActionResult> {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (trimmed.length === 0) return { ok: false, text: '未执行：id 不能为空。' }
    const found = await findAccessibleRef(trimmed)
    if (found === undefined) return { ok: false, text: `未执行：找不到这条记忆（id=${trimmed}；用户库/项目库都查过，或隐私拒绝）。` }
    const forget = (found.ref.store as { forget?(ids: readonly string[]): Promise<number> }).forget
    if (typeof forget !== 'function') {
      return { ok: false, text: '未执行：当前库不支持删除（forget 不可用），没有改动任何数据。' }
    }
    try {
      await forget.call(found.ref.store, [trimmed])
    } catch (error) {
      return { ok: false, text: `删除失败：${errorMessageOf(error)}` }
    }
    let back: MemoryRecord | undefined
    try {
      back = await found.ref.store.get(trimmed)
    } catch {
      back = undefined
    }
    if (back !== undefined) return { ok: false, text: '删除后查回仍存在：未确认删除，请重试。' }
    deps.activity?.('write', `ui:delete ${trimmed}`)
    return { ok: true, text: `已删除记忆 ${trimmed}（不可撤销）。` }
  }

  async function markMemory(id: string, mark: UiMemoryMark): Promise<UiActionResult> {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (trimmed.length === 0) return { ok: false, text: '未执行：id 不能为空。' }
    if (mark !== 'confirm' && mark !== 'obsolete' && mark !== 'revive') {
      return { ok: false, text: `未执行：未知标记动作 ${String(mark)}。` }
    }
    if (mark === 'confirm') {
      const confirm = deps.confirm
      if (confirm === undefined) return { ok: false, text: '确认功能未启用（config.confirmCommand=false）。' }
      try {
        return await confirm({ action: 'confirm', id: trimmed, sessionId: currentSessionId() })
      } catch (error) {
        return { ok: false, text: `确认失败（已隔离）：${errorMessageOf(error)}` }
      }
    }
    const clock = deps.clock
    if (clock === undefined) return { ok: false, text: '未执行：时钟未接线（标记需要时间戳）。' }
    const found = await findAccessibleRef(trimmed)
    if (found === undefined) return { ok: false, text: `未执行：找不到这条记忆（id=${trimmed}；用户库/项目库都查过，或隐私拒绝）。` }
    const record = found.record
    if (mark === 'obsolete') {
      if (!isActiveRecord(record)) return { ok: false, text: '未执行：该条目已经失效或被取代，无需再次标记。' }
      const next: MemoryRecord = { ...record, validTo: Math.max(clock.now(), record.observedAt) }
      try {
        await found.ref.store.put(next)
      } catch (error) {
        return { ok: false, text: `标记失效失败：${errorMessageOf(error)}` }
      }
      try {
        const back = await found.ref.store.get(trimmed)
        if (back === undefined || back.validTo === null) {
          return { ok: false, text: '标记失效后查回失败：状态未确认，请重试。' }
        }
      } catch (error) {
        return { ok: false, text: `标记失效后查回失败（已隔离）：${errorMessageOf(error)}` }
      }
      deps.activity?.('write', `ui:obsolete ${trimmed}`)
      return { ok: true, text: `已把 ${trimmed} 标为失效（正文与来源保留，可追溯）。` }
    }
    // revive：只对未被取代的记录清 validTo
    if (record.supersededBy !== null) {
      return { ok: false, text: '未执行：被其他条目取代的记录不能复活（请新建一条或在库层面处理）。' }
    }
    if (record.validTo === null) return { ok: true, text: `记忆 ${trimmed} 本来就是活跃的，无需复活。` }
    const revived: MemoryRecord = { ...record, validTo: null }
    try {
      await found.ref.store.put(revived)
    } catch (error) {
      return { ok: false, text: `复活失败：${errorMessageOf(error)}` }
    }
    try {
      const back = await found.ref.store.get(trimmed)
      if (back === undefined || back.validTo !== null) {
        return { ok: false, text: '复活后查回失败：状态未确认，请重试。' }
      }
    } catch (error) {
      return { ok: false, text: `复活后查回失败（已隔离）：${errorMessageOf(error)}` }
    }
    deps.activity?.('write', `ui:revive ${trimmed}`)
    return { ok: true, text: `已复活记忆 ${trimmed}。` }
  }

  async function sessions(): Promise<UiSessionList> {
    const catalog = deps.sessionCatalog
    if (catalog === undefined) {
      return { available: false, reason: '会话目录未接线（宿主 sessionCatalog 服务不可用）', items: [] }
    }
    try {
      const listing = await catalog.list()
      if (!listing.available) {
        return { available: false, reason: listing.reason ?? '会话目录不可用（宿主未提供原因）', items: [] }
      }
      const activeIds = new Set(
        (deps.sessionRuntime?.list() ?? [])
          .filter(runtime => runtime.observations > 0)
          .map(runtime => runtime.sessionId),
      )
      const items: UiSessionItem[] = []
      for (const entry of listing.items) {
        if (entry.agentPreset !== 'omb') continue
        let root: string | null = null
        if (deps.rootOf !== undefined && entry.cwd.length > 0) {
          try {
            root = deps.rootOf(entry.cwd)
          } catch {
            root = null
          }
        }
        let depth: string | null = null
        try {
          depth = deps.focusOf?.(entry.id) ?? null
        } catch {
          depth = null
        }
        let privacy: UiSessionItem['privacy'] = null
        try {
          const mode = deps.privacy?.admin.modeOf(entry.id)
          privacy = mode === undefined
            ? null
            : { mode: mode.mode, origin: mode.origin, inheritedFrom: mode.inheritedFrom }
        } catch {
          privacy = null
        }
        items.push({
          id: entry.id,
          title: entry.title,
          cwd: entry.cwd,
          root,
          preset: entry.agentPreset,
          archived: entry.archived,
          active: activeIds.has(entry.id),
          depth,
          privacy,
          createdAt: entry.createdAt,
        })
      }
      return { available: true, items }
    } catch (error) {
      return { available: false, reason: `会话目录读取失败（已隔离）：${errorMessageOf(error)}`, items: [] }
    }
  }

  async function personal(): Promise<UiPersonalView> {
    const provider = deps.personal
    if (provider === undefined) {
      return {
        available: false,
        reason: '未接线：用户画像服务不可用（omb-profile 未挂载）',
        entries: [],
        conflicts: [],
        text: '',
      }
    }
    try {
      return await provider()
    } catch (error) {
      return {
        available: false,
        reason: `个人画像读取失败（已隔离）：${errorMessageOf(error)}`,
        entries: [],
        conflicts: [],
        text: '',
      }
    }
  }

  async function controller(sessionId?: string): Promise<UiControllerView> {
    const admin = deps.controllerAdmin
    if (admin === undefined) {
      return {
        available: false,
        reason: '未接线：记忆控制器管理端口不可用（capture 未装配）',
        tasks: [],
        candidates: [],
      }
    }
    const requested = typeof sessionId === 'string' ? sessionId.trim() : ''
    const id = requested.length > 0 ? requested : currentSessionId()
    if (id === null || id.length === 0) {
      return { available: false, reason: '无会话归属：拿不到当前会话 id（不猜）', tasks: [], candidates: [] }
    }
    try {
      const state = admin.state(id)
      return {
        available: true,
        sessionId: id,
        phase: state.phase,
        tasks: state.tasks.map(task => ({ text: task.text, at: task.at, expiresAt: task.expiresAt })),
        candidates: state.candidates.map(candidate => ({
          id: candidate.id,
          text: candidate.text,
          kind: candidate.kind,
          scope: candidate.scope,
          at: candidate.at,
          reason: candidate.reason,
        })),
        lastEventAt: state.lastEventAt,
      }
    } catch (error) {
      return {
        available: false,
        reason: `控制器状态读取失败（已隔离）：${errorMessageOf(error)}`,
        tasks: [],
        candidates: [],
      }
    }
  }

  async function controllerAct(input: UiControllerActInput): Promise<UiActionResult> {
    const action = input?.action
    if (action !== 'add-task' && action !== 'remove-task' && action !== 'clear-tasks'
      && action !== 'remove-candidate' && action !== 'clear-candidates') {
      return { ok: false, text: `未执行：未知控制器动作 ${String(action)}。` }
    }
    const id = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (id.length === 0) return { ok: false, text: '未执行：控制器编辑需要 sessionId。' }
    if (id.length > 200) return { ok: false, text: '未执行：sessionId 最多 200 个字符。' }
    const admin = deps.controllerAdmin
    if (admin === undefined) return { ok: false, text: '未执行：记忆控制器管理未接线（capture 未装配）。' }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if ((action === 'add-task' || action === 'remove-task' || action === 'remove-candidate') && text.length === 0) {
      return { ok: false, text: '未执行：该动作需要 text。' }
    }
    if (action === 'add-task' && text.length > 200) {
      return { ok: false, text: '未执行：任务文本最多 200 个字符。' }
    }
    let edit: ControllerAdminEdit
    if (action === 'clear-tasks') edit = { kind: 'clear-tasks' }
    else if (action === 'clear-candidates') edit = { kind: 'clear-candidates' }
    else edit = { kind: action, text }
    try {
      const before = admin.state(id)
      const after = admin.edit(id, edit)
      const changed = action === 'clear-tasks'
        ? before.tasks.length !== after.tasks.length
        : action === 'clear-candidates'
          ? before.candidates.length !== after.candidates.length
          : before.tasks.length !== after.tasks.length || before.candidates.length !== after.candidates.length
      if (!changed) return { ok: true, text: `未找到可改动项（重复或不存在），会话 ${id} 的控制器状态未变。` }
      return {
        ok: true,
        text: `已更新会话 ${id} 的控制器：任务 ${after.tasks.length} 条、候选 ${after.candidates.length} 条。`,
      }
    } catch (error) {
      return { ok: false, text: `控制器编辑失败（已隔离）：${errorMessageOf(error)}` }
    }
  }

  async function personalAct(input: UiPersonalEditInput): Promise<UiActionResult> {
    const action = input?.action
    if (action !== 'declare' && action !== 'retract') {
      return { ok: false, text: `未执行：未知个人画像动作 ${String(action)}。` }
    }
    const axis = typeof input.axis === 'string' ? input.axis.trim() : ''
    if (axis.length === 0) return { ok: false, text: '未执行：需要 axis。' }
    if (axis !== 'stable' && axis !== 'intent' && axis !== 'collaboration') {
      return { ok: false, text: '未执行：axis 只能是 stable、intent 或 collaboration（能力轴只在会话内存，不可编辑）。' }
    }
    const key = typeof input.key === 'string' ? input.key.trim() : ''
    if (key.length === 0) return { ok: false, text: '未执行：需要 key。' }
    if (key.length > 200) return { ok: false, text: '未执行：key 最多 200 个字符。' }
    let normalized: UiPersonalEditInput
    if (action === 'retract') {
      normalized = { action: 'retract', axis, key }
    } else {
      const value = typeof input.value === 'string' ? input.value.trim() : ''
      if (value.length === 0) return { ok: false, text: '未执行：需要 value。' }
      if (value.length > 2000) return { ok: false, text: '未执行：value 最多 2000 个字符。' }
      const rawEvidence = input.evidence
      if (rawEvidence !== undefined && (!Array.isArray(rawEvidence) || rawEvidence.some(item => typeof item !== 'string'))) {
        return { ok: false, text: '未执行：evidence 必须是字符串数组。' }
      }
      normalized = {
        action: 'declare',
        axis,
        key,
        value,
        ...(rawEvidence === undefined ? {} : { evidence: rawEvidence }),
      }
    }
    const provider = deps.personalEdit
    if (provider === undefined) return { ok: false, text: '未执行：个人画像写入未接线（SERVICES.profile 未挂载或未提供 declare/retract）。' }
    try {
      const result = await provider(normalized)
      return { ok: result.ok, text: result.text }
    } catch (error) {
      return { ok: false, text: `个人画像写入失败（已隔离）：${errorMessageOf(error)}` }
    }
  }

  return {
    overview, list, candidates, detail, act, resolve, runtime, profile, privacy, privacyAct,
    createMemory, updateMemory, deleteMemory, markMemory, sessions, personal,
    controller, controllerAct, personalAct,
  }

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

  async function profile(sessionId?: string): Promise<UiProfile> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id.length > 0) {
      const bySession = deps.profileForSession
      if (bySession === undefined) {
        return { available: false, reason: '未接线：按会话画像不可用（memory/index 未提供 profileForSession）' }
      }
      try {
        return await bySession(id)
      } catch (error) {
        return { available: false, reason: `画像读取失败（已隔离）：${errorMessageOf(error)}` }
      }
    }
    if (deps.profile === undefined) {
      return { available: false, reason: '未接线：项目画像服务不可用（dsh/project-profile 未挂载）' }
    }
    try {
      return await deps.profile()
    } catch (error) {
      return { available: false, reason: `画像读取失败（已隔离）：${errorMessageOf(error)}` }
    }
  }

  async function privacy(): Promise<UiPrivacyView> {
    const wired = deps.privacy
    if (wired === undefined) return emptyPrivacyView('未接线：隐私管理服务不可用（installPrivacy 未执行）')
    try {
      return wired.admin.view(wired.current())
    } catch (error) {
      return emptyPrivacyView(
        `隐私视图读取失败（已隔离）：${error instanceof Error ? error.message : String(error)}`,
        '读取失败',
      )
    }
  }

  async function privacyAct(input: {
    readonly action: PrivacyActionName
    readonly sessionId?: string
    readonly mode?: PrivacyMode
  }): Promise<UiActionResult> {
    const action = input?.action
    if (!PRIVACY_ACTIONS.includes(action)) {
      return { ok: false, text: `未执行：未知隐私动作 ${String(action)}。` }
    }
    const wired = deps.privacy
    if (wired === undefined) {
      return { ok: false, text: '未执行：隐私管理服务未接线（installPrivacy 未执行）。' }
    }
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    const sessionIdTooLong = sessionId.length > MAX_PRIVACY_SESSION_ID
    try {
      if (action === 'set') {
        if (sessionId.length === 0) return { ok: false, text: '未执行：设置模式需要 sessionId。' }
        if (sessionIdTooLong) return { ok: false, text: `未执行：sessionId 超过 ${MAX_PRIVACY_SESSION_ID} 字符（疑似不是会话 id）。` }
        if (input.mode === undefined || !isPrivacyMode(input.mode)) {
          return { ok: false, text: '未执行：mode 必须是 normal / read-only / sealed。' }
        }
        return wired.admin.setMode(sessionId, input.mode)
      }
      if (action === 'clear') {
        if (sessionId.length === 0) return { ok: false, text: '未执行：清除设置需要 sessionId。' }
        if (sessionIdTooLong) return { ok: false, text: `未执行：sessionId 超过 ${MAX_PRIVACY_SESSION_ID} 字符（疑似不是会话 id）。` }
        return wired.admin.clear(sessionId)
      }
      if (action === 'clear-inactive') return wired.admin.clearInactive()
      return wired.admin.trust()
    } catch (error) {
      return { ok: false, text: `执行失败（已隔离）：${error instanceof Error ? error.message : String(error)}` }
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
