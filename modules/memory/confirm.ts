/**
 * `/omb-confirm`：候选记忆的**用户**确认入口与撤销入口（v4.8.0 起；v4.9.0 加撤销/审计/分页）。
 *
 * ## 为什么必须存在
 *
 * `lifecycle.ts` 的规则是"写入时是什么证据，就停在对应的阶段；想升级只能由用户
 * 显式确认"。控制器自动写入的非显式长期偏好停在**候选**（`semantic + assertedBy:model`），
 * 需要用户确认才能变成"已确认"。确认改变的是证据等级，只有**用户**有权做，
 * 所以这里只注册斜杠命令，模型工具面一个字都不加（与 `/omb-privacy`、`/omb-feedback` 同原则）。
 *
 * ## 为什么要能撤销
 *
 * 用户会改主意。但撤销不能靠"看起来像候选"去猜——用户显式 `omb_remember` 的条目也是
 * `assertedBy:user`，误撤会把用户真正说过的话降级。因此 v5 增加只增审计表
 * `memory_confirm`：**只有最后一次动作是 `confirm` 的条目才允许 undo**。
 * 没有审计面 / 没有确认记录 → 一律拒绝（fail-closed）。
 *
 * ## 语法
 *
 * ```text
 * /omb-confirm                列出候选（每库最近 50 条里筛，最多显示 5 条）
 * /omb-confirm list [offset]  同上，从第 offset 条开始显示（分页）
 * /omb-confirm <记忆id>        确认为"已确认"
 * /omb-confirm undo <记忆id>   撤销一次经本命令做的确认
 * ```
 *
 * ## 语义（只改证据归属）
 *
 * - 确认：`assertedBy` 从 `model` 改为 `user`；正文/id/来源/时间/计数一律不改；
 * - 撤销：`assertedBy` 从 `user` 改为 `model`；同样不改其它字段；
 * - 两个动作都追加审计行，写回后**查回验证**；
 * - 只接受真正的候选（事件、已失效、已被取代、已是 user 的一律拒绝并说明）。
 *
 * 隐私：sealed 不读；read-only 与归属未知不写。
 */
import type { Kernel, MemoryRecord, MemoryStore, TaggedStore } from '../../kernel/abi/index.js'
import type { CommandInvocationLike, CommandResultLike } from './privacy/command.js'
import { sessionOfInvocation } from './privacy/command.js'
import { asConfirmStore, asRecordScanner, type ConfirmAuditEntry } from './store.js'
import { stageLabel, stageOfMemory } from './lifecycle.js'
import { isoUtc } from './retrieve.js'
import { findRelatedRecords, type RelatedRecord } from './link.js'

export const CONFIRM_COMMAND_NAME = 'omb-confirm'
export const CONFIRM_COMMAND_ID = 'omb-memory/confirm'

/** 列表默认最多显示几条候选。 */
export const CONFIRM_LIST_LIMIT = 5
/** 每库扫描最近多少条记录（有界：确认列表不该按库大小付代价）。 */
export const CONFIRM_SCAN_LIMIT = 50
/** 单次批量撤销的条数上限（爆炸半径限制；逐条报告）。 */
export const MAX_BATCH_UNDO = 10
/** 候选超过多少天未确认时，列表里给出 stale 建议（只是建议，不自动处理）。 */
export const CANDIDATE_STALE_DAYS = 30

export const CONFIRM_USAGE =
  '用法：/omb-confirm [list [offset] | log <记忆id> | <记忆id> | undo <记忆id>...]'
  + '（不带参数 = 列出候选；带 id = 确认为"已确认"；log = 看确认审计；'
  + `undo 支持一次撤 ${MAX_BATCH_UNDO} 条以内。确认/撤销只改证据归属，不改正文与来源；模型没有这个入口）`

export type ConfirmRequest =
  | { readonly kind: 'list'; readonly offset: number }
  | { readonly kind: 'promote'; readonly id: string }
  | { readonly kind: 'undo'; readonly ids: readonly string[] }
  | { readonly kind: 'log'; readonly id: string }

export type ConfirmParseResult =
  | { readonly ok: true; readonly request: ConfirmRequest }
  | { readonly ok: false; readonly error: string }

/** 解析命令参数。**不抛**；纯函数。 */
export function parseConfirmArgs(raw: string): ConfirmParseResult {
  const tokens = (typeof raw === 'string' ? raw : '').trim().split(/\s+/).filter(token => token.length > 0)
  if (tokens.length === 0) return { ok: true, request: { kind: 'list', offset: 0 } }

  const head = tokens[0] as string
  if (head === 'list') {
    if (tokens.length === 1) return { ok: true, request: { kind: 'list', offset: 0 } }
    if (tokens.length > 2) return { ok: false, error: `多余的参数：${tokens.slice(2).join(' ')}。${CONFIRM_USAGE}` }
    const rawOffset = tokens[1] as string
    const offset = Number(rawOffset)
    if (!Number.isInteger(offset) || offset < 0) {
      return { ok: false, error: `offset 必须是非负整数：${JSON.stringify(rawOffset)}。${CONFIRM_USAGE}` }
    }
    return { ok: true, request: { kind: 'list', offset } }
  }
  if (head === 'undo') {
    if (tokens.length === 1) return { ok: false, error: `undo 需要记忆 id。${CONFIRM_USAGE}` }
    const ids = tokens.slice(1)
    if (ids.length > MAX_BATCH_UNDO) {
      return { ok: false, error: `一次最多撤 ${MAX_BATCH_UNDO} 条（收到 ${ids.length} 条）：请分批。${CONFIRM_USAGE}` }
    }
    if (ids.some(id => id.length === 0)) return { ok: false, error: `undo 的 id 不能为空。${CONFIRM_USAGE}` }
    return { ok: true, request: { kind: 'undo', ids } }
  }
  if (head === 'log') {
    if (tokens.length === 1) return { ok: false, error: `log 需要记忆 id。${CONFIRM_USAGE}` }
    if (tokens.length > 2) return { ok: false, error: `多余的参数：${tokens.slice(2).join(' ')}。${CONFIRM_USAGE}` }
    return { ok: true, request: { kind: 'log', id: tokens[1] as string } }
  }
  if (tokens.length > 1) {
    return { ok: false, error: `多余的参数：${tokens.slice(1).join(' ')}。${CONFIRM_USAGE}` }
  }
  return { ok: true, request: { kind: 'promote', id: head } }
}

/**
 * 这条记录是不是可确认的候选。
 *
 * 判据与 `lifecycle.ts` 的推导必须一致：`semantic`/`procedural` + `assertedBy:model`
 * 才是候选；`episodic` 是事件（没有"确认"语义）。
 */
export function isConfirmableCandidate(record: MemoryRecord): boolean {
  if (record.validTo !== null || record.supersededBy !== null) return false
  if (record.assertedBy !== 'model') return false
  return record.kind === 'semantic' || record.kind === 'procedural'
}

export type PromoteDecision =
  | { readonly ok: true; readonly record: MemoryRecord }
  | { readonly ok: false; readonly reason: string }

/**
 * 候选 → 已确认的**纯变换**：只改 `assertedBy`，其余字段逐字保留。
 *
 * 保留 `lastUsedAt`/`useCount`/`validTo` 是有意的：确认不是"重新观察到事实"，
 * 它不刷新时间、也不重置使用计数（否则确认会顺手改变排序与保留策略）。
 */
export function promoteCandidateRecord(record: MemoryRecord): PromoteDecision {
  if (record.kind === 'episodic') return { ok: false, reason: '事件条目没有"确认"语义（它记录的是发生过什么）' }
  if (record.validTo !== null) return { ok: false, reason: '该条目已失效（validTo 非空）：先 revive 再确认' }
  if (record.supersededBy !== null) return { ok: false, reason: '该条目已被取代：确认不会让它重新生效' }
  if (record.assertedBy === 'user') return { ok: false, reason: '该条目已经是"已确认"，无需重复确认' }
  if (record.assertedBy !== 'model') {
    return { ok: false, reason: `该条目的证据归属是 ${record.assertedBy}，不是候选（只有 model 推断的条目可确认）` }
  }
  return { ok: true, record: { ...record, assertedBy: 'user' } }
}

export type UndoDecision =
  | { readonly ok: true; readonly record: MemoryRecord }
  | { readonly ok: false; readonly reason: string }

/**
 * 已确认 → 候选的**纯变换**（撤销）。
 *
 * 调用方必须**先**证明审计日志的最后一次动作是 `confirm`——本函数只做形态检查：
 * 记录当前必须是 `user` 且仍活跃。没有审计证明就撤销会误伤用户显式写入的条目。
 */
export function undoConfirmedRecord(record: MemoryRecord): UndoDecision {
  if (record.kind === 'episodic') return { ok: false, reason: '事件条目没有"撤销确认"语义' }
  if (record.validTo !== null) return { ok: false, reason: '该条目已失效：撤销确认不会改变它的可注入状态' }
  if (record.supersededBy !== null) return { ok: false, reason: '该条目已被取代：撤销确认不会让它重新生效' }
  if (record.assertedBy !== 'user') {
    return { ok: false, reason: `该条目的证据归属是 ${record.assertedBy}，不是"已确认"，没有可撤销的确认` }
  }
  return { ok: true, record: { ...record, assertedBy: 'model' } }
}

/** 一条候选（列表项）。 */
export interface ConfirmListItem {
  readonly record: MemoryRecord
}

/** 候选扫描结果（有界：每库最近 `CONFIRM_SCAN_LIMIT` 条里筛）。 */
export interface CandidateScan {
  readonly items: readonly ConfirmListItem[]
  /** 扫描范围内候选**总数**（不是全库总数）。 */
  readonly total: number
}

/**
 * 扫描各库的最近记录，筛出候选（未失效、未被取代、semantic/procedural + model）。
 *
 * 只扫 `CONFIRM_SCAN_LIMIT` 条/库：确认列表是人工操作，不值得按库大小付代价；
 * `total` 是扫描范围内的候选数（回执里如实写"最近 N 条里"）。
 */
export async function listCandidates(
  stores: readonly TaggedStore[],
  limit: number,
  offset = 0,
): Promise<CandidateScan> {
  const candidates: ConfirmListItem[] = []
  const seen = new Set<string>()
  for (const tagged of stores) {
    const scanner = asRecordScanner(tagged.store)
    if (scanner === undefined) continue
    let records: readonly MemoryRecord[]
    try {
      records = await scanner.listRecentRecords({ limit: CONFIRM_SCAN_LIMIT })
    } catch {
      continue
    }
    for (const record of records) {
      if (seen.has(record.id)) continue
      if (!isConfirmableCandidate(record)) continue
      seen.add(record.id)
      candidates.push({ record })
    }
  }
  const sorted = candidates.sort((a, b) => b.record.observedAt - a.record.observedAt)
  const start = Math.max(0, offset)
  return { items: sorted.slice(start, start + Math.max(0, limit)), total: sorted.length }
}

function excerpt(text: string, max = 100): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 候选列表回执（纯函数；给了 `now` 才显示年龄与 stale 建议）。 */
export function renderCandidateList(scan: CandidateScan, offset = 0, now?: number): string {
  if (scan.total === 0) {
    return '没有待确认的候选记忆（当前可见库的最近记录里没有 semantic/procedural + model 的活跃条目）。'
  }
  const start = Math.max(0, offset) + 1
  const end = Math.max(0, offset) + scan.items.length
  const lines = [`待确认候选：最近记录里共 ${scan.total} 条，显示第 ${start}–${end} 条。`]
  for (const { record } of scan.items) {
    const stage = stageOfMemory({ kind: record.kind, assertedBy: record.assertedBy })
    const ageDays = now === undefined ? null : Math.max(0, Math.floor((now - record.observedAt) / DAY_MS))
    const ageText = ageDays === null ? '' : ` · 已存在 ${ageDays} 天`
    const stale = ageDays !== null && ageDays >= CANDIDATE_STALE_DAYS
      ? `（超过 ${CANDIDATE_STALE_DAYS} 天未确认：确认它，或用 /omb-feedback ${record.id} stale 归档）`
      : ''
    lines.push(
      `- ${record.id} · ${record.scope}/${record.kind} · 阶段 ${stageLabel(stage)}`
      + ` · observedAt=${isoUtc(record.observedAt)}${ageText}${stale} · ${excerpt(record.text)}`,
    )
  }
  if (end < scan.total) {
    lines.push(`还有 ${scan.total - end} 条未显示：/omb-confirm list ${end}`)
  }
  lines.push('确认：/omb-confirm <记忆id>（确认后阶段变为"已确认"，正文与来源不变）')
  return lines.join('\n')
}

/** 确认审计回执（纯函数）：逐条列出动作、时间、会话与当前状态。 */
export function renderAuditLog(
  record: MemoryRecord,
  entries: readonly ConfirmAuditEntry[],
  lastAction: ConfirmAuditEntry | undefined,
): string {
  const stage = stageOfMemory({ kind: record.kind, assertedBy: record.assertedBy })
  const lines = [`记忆 ${record.id}（${record.scope}/${record.kind} · 阶段 ${stageLabel(stage)}）`]
  if (entries.length === 0) {
    lines.push('确认审计：无记录（这条不是经 /omb-confirm 确认的）。')
  } else {
    lines.push('确认审计（倒序，只增不改）：')
    for (const entry of entries) {
      lines.push(`- ${isoUtc(entry.at)} · ${entry.action}${entry.sessionId === null ? '' : `（会话 ${entry.sessionId}）`}`)
    }
    lines.push(
      lastAction === undefined
        ? '当前状态：未知（审计读取出错）'
        : `当前状态：${lastAction.action === 'confirm' ? '已确认（经本命令）' : '候选（已撤销）'}`,
    )
  }
  lines.push(`撤销：/omb-confirm undo ${record.id}`)
  return lines.join('\n')
}

function relatedLines(related: readonly RelatedRecord[]): readonly string[] {
  if (related.length === 0) return []
  const lexical = related.filter(item => item.via === 'lexical').length
  const vector = related.filter(item => item.via === 'vector').length
  const channels: string[] = []
  if (lexical > 0) channels.push('共享实体键')
  if (vector > 0) channels.push('语义相近')
  const lines = [`可能相关的既有结论（${channels.join(' / ')}；只提示，未改库）：`]
  for (const item of related) {
    const stage = stageOfMemory({ kind: item.record.kind, assertedBy: item.record.assertedBy })
    const via = item.via === 'vector' ? '语义' : '词法'
    lines.push(
      `- id=${item.record.id} · ${item.record.scope}/${item.record.kind} · 阶段 ${stageLabel(stage)} · ${via} · ${excerpt(item.record.text, 80)}`,
    )
  }
  lines.push('若本条与其中某条矛盾，请先用 /omb-feedback 或 omb_remember(supersedes) 处理旧条目。')
  return lines
}

/** 确认回执（纯函数）。 */
export function renderConfirmResult(input: {
  readonly record: MemoryRecord
  readonly related?: readonly RelatedRecord[]
  /** 审计写入失败时的可读原因（确认已生效，但撤销入口会失效）。 */
  readonly auditWarning?: string
}): string {
  const { record } = input
  const stage = stageOfMemory({ kind: record.kind, assertedBy: record.assertedBy })
  const lines = [
    `已确认：id=${record.id}（${record.scope}/${record.kind}）`,
    `阶段：候选 → ${stageLabel(stage)}；证据归属 model → user（正文、来源、id、observedAt 均未改）。`,
    `原文：${excerpt(record.text, 240)}`,
    `撤销：/omb-confirm undo ${record.id}`,
  ]
  lines.push(...relatedLines(input.related ?? []))
  if (input.auditWarning !== undefined) lines.push(`⚠ 审计写入失败：${input.auditWarning}（确认已生效，但本条无法撤销）`)
  return lines.join('\n')
}

/** 撤销回执（纯函数）。 */
export function renderUndoResult(input: { readonly record: MemoryRecord; readonly lastConfirmedAt: number | null }): string {
  const lines = [
    `已撤销确认：id=${input.record.id}（${input.record.scope}/${input.record.kind}）`,
    '阶段：已确认 → 候选；证据归属 user → model（正文、来源、id、observedAt 均未改）。',
  ]
  if (input.lastConfirmedAt !== null) lines.push(`本次撤销对应 ${isoUtc(input.lastConfirmedAt)} 的确认；撤销也写了审计行。`)
  return lines.join('\n')
}

/** 命令执行依赖（由 `modules/memory/index.ts` 装配）。 */
export interface ConfirmDeps {
  readonly clock: { now(): number }
  readonly resolveStores: (sessionId: string | undefined) => readonly TaggedStore[] | undefined
  readonly privacy?: () => {
    decide(sessionId: string): { readonly allowRead: boolean; readonly allowWrite: boolean }
    decideUnattributed(): { readonly allowRead: boolean; readonly allowWrite: boolean }
  } | undefined
  readonly logger?: { info(message: string): void; warn(message: string): void }
  /**
   * v4.9.1：相关条目查找端口（词法 + 语义由装配层合并）。
   * 缺省退回词法 `findRelatedRecords`（单测/旧装配）。
   */
  readonly findRelated?: (store: MemoryStore, record: MemoryRecord) => Promise<readonly RelatedRecord[]>
  /** 观测口（健康面按动作计数；绝不改变命令结果）。 */
  readonly onConfirm?: (info: {
    readonly action: 'list' | 'log' | 'promote' | 'undo'
    readonly changed: boolean
    readonly reason: string
    /** 本动作实际影响的条数（批量撤销 > 1；其它动作缺省 1）。 */
    readonly count?: number
    readonly sessionId: string | null
  }) => void
}

/** 宿主 commands 服务的最小结构面（与 `feedback.ts` 同一形状）。 */
interface CommandsLike {
  register(definition: {
    readonly definitionId: string
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): unknown
}

export interface ConfirmInstallation {
  readonly commandState: () => string
  dispose(): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 跨库按 id 找记录（返回记录与所属库；找不到 undefined）。 */
async function findRecord(
  stores: readonly TaggedStore[],
  id: string,
): Promise<{ readonly store: TaggedStore; readonly record: MemoryRecord } | undefined> {
  for (const tagged of stores) {
    try {
      const found = await tagged.store.getMany([id])
      const record = found.find(candidate => candidate.id === id)
      if (record !== undefined) return { store: tagged, record }
    } catch {
      // 单库失败不拦：另一个库可能还有这条
    }
  }
  return undefined
}

/** 读最后一次确认动作（没有审计面 → null = 无法证明，fail-closed）。 */
async function readLastAction(store: TaggedStore, id: string): Promise<ConfirmAuditEntry | null | undefined> {
  const api = asConfirmStore(store.store)
  if (api === undefined) return undefined
  try {
    const log = await api.confirmLog(id, 1)
    return log[0] ?? null
  } catch {
    return undefined
  }
}

/**
 * 执行一次确认命令（解析 → 隐私 → 定位 → 变换 → 写回 → 查回验证 → 审计 → 回执）。
 *
 * 绝不抛；任何失败都返回可读错误。
 */
export async function runConfirmCommand(
  raw: string,
  sessionId: string | null,
  deps: ConfirmDeps,
): Promise<CommandResultLike> {
  try {
    const parsed = parseConfirmArgs(raw)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }

    // ① 隐私闸门：sealed 不读；read-only / 归属未知不写。
    let decision: { allowRead: boolean; allowWrite: boolean } = { allowRead: true, allowWrite: true }
    try {
      const gate = deps.privacy?.()
      if (gate !== undefined) {
        decision = sessionId === null ? gate.decideUnattributed() : gate.decide(sessionId)
      }
    } catch {
      decision = { allowRead: false, allowWrite: false }
    }
    if (!decision.allowRead) {
      return { kind: 'error', text: '当前会话处于 sealed（禁读禁写）隐私模式：确认命令不读取记忆库，也不改动任何条目。' }
    }
    if (parsed.request.kind !== 'list' && !decision.allowWrite) {
      return {
        kind: 'error',
        text: '当前会话处于 read-only/未知归属：确认/撤销会改库，已拒绝（确认不能放宽隐私）。用 /omb-privacy normal 解除写限制后再试。',
      }
    }

    const stores = deps.resolveStores(sessionId ?? undefined)
    if (stores === undefined || stores.length === 0) {
      return { kind: 'error', text: '记忆服务未就绪：没有可查的库（omb-memory 未挂载或项目库尚未打开）。' }
    }

    if (parsed.request.kind === 'list') {
      const scan = await listCandidates(stores, CONFIRM_LIST_LIMIT, parsed.request.offset)
      try {
        deps.onConfirm?.({ action: 'list', changed: false, reason: `listed=${scan.items.length}/${scan.total}`, sessionId })
      } catch {
        // 观测口失败不影响命令结果
      }
      return { kind: 'success', text: renderCandidateList(scan, parsed.request.offset, deps.clock.now()) }
    }

    if (parsed.request.kind === 'log') {
      const found = await findRecord(stores, parsed.request.id)
      if (found === undefined) {
        return { kind: 'error', text: `未知 id：${parsed.request.id}。用户库/项目库都没有这条记忆（不会按"最近一条"猜）。` }
      }
      const api = asConfirmStore(found.store.store)
      if (api === undefined) {
        return { kind: 'error', text: '未查询：该库没有确认审计面（旧实现），无法列出审计。' }
      }
      let entries: readonly ConfirmAuditEntry[] = []
      let last: ConfirmAuditEntry | undefined
      let readError: string | undefined
      try {
        entries = await api.confirmLog(found.record.id, 20)
        last = entries[0]
      } catch (error) {
        readError = messageOf(error)
      }
      try {
        deps.onConfirm?.({ action: 'log', changed: false, reason: entries.length === 0 ? 'empty' : `entries=${entries.length}`, sessionId })
      } catch {
        // 观测口失败不影响命令结果
      }
      if (readError !== undefined) {
        return { kind: 'error', text: `审计读取失败（已隔离，未改动任何数据）：${readError}` }
      }
      return { kind: 'success', text: renderAuditLog(found.record, entries, last) }
    }

    const at = deps.clock.now()
    if (parsed.request.kind === 'undo') {
      return await runUndoBatch(parsed.request.ids, stores, sessionId, at, deps)
    }

    const found = await findRecord(stores, parsed.request.id)
    if (found === undefined) {
      return { kind: 'error', text: `未知 id：${parsed.request.id}。用户库/项目库都没有这条记忆（不会按"最近一条"猜）。` }
    }
    return await runPromote(found, parsed.request.id, sessionId, at, deps)
  } catch (error) {
    deps.logger?.warn(`OMB 确认命令失败（已隔离）：${messageOf(error)}`)
    return { kind: 'error', text: `确认命令执行失败（已隔离，未改动任何数据）：${messageOf(error)}` }
  }
}

async function runPromote(
  found: { readonly store: TaggedStore; readonly record: MemoryRecord },
  id: string,
  sessionId: string | null,
  at: number,
  deps: ConfirmDeps,
): Promise<CommandResultLike> {
  const promoted = promoteCandidateRecord(found.record)
  if (!promoted.ok) {
    try {
      deps.onConfirm?.({ action: 'promote', changed: false, reason: promoted.reason, sessionId })
    } catch {
      // 观测口失败不影响命令结果
    }
    const hint = found.record.assertedBy === 'user'
      ? `（若这是经本命令确认的条目，用 /omb-confirm undo ${id} 撤销。）`
      : ''
    return { kind: 'error', text: `未确认：${promoted.reason}${hint}。${CONFIRM_USAGE}` }
  }

  try {
    await found.store.store.put(promoted.record)
  } catch (error) {
    deps.logger?.warn(`OMB 确认：写回失败（${id}）——${messageOf(error)}`)
    return { kind: 'error', text: `确认写入失败（已隔离，未改动任何数据）：${messageOf(error)}` }
  }

  // ② 查回验证：确认是"改库"动作，必须证明它真的落库了。
  let stored: MemoryRecord | undefined
  try {
    stored = (await found.store.store.getMany([promoted.record.id]))[0]
  } catch {
    stored = undefined
  }
  if (stored === undefined || stored.assertedBy !== 'user' || stored.contentHash !== promoted.record.contentHash) {
    return {
      kind: 'error',
      text: `确认写入后查回失败（id=${promoted.record.id}）：结论未变更可信度，请重试或检查库状态。`,
    }
  }

  // ③ 审计（确认已生效；审计失败不能让回执说"没确认"，必须如实说"无法撤销"）。
  let auditWarning: string | undefined
  try {
    const api = asConfirmStore(found.store.store)
    if (api === undefined) auditWarning = '该库没有确认审计面（旧实现），本条无法撤销'
    else await api.recordConfirm({ memoryId: stored.id, action: 'confirm', sessionId, at })
  } catch (error) {
    auditWarning = messageOf(error)
  }

  let related: readonly RelatedRecord[] = []
  try {
    related = deps.findRelated !== undefined
      ? await deps.findRelated(found.store.store, stored)
      : await findRelatedRecords(found.store.store, stored)
  } catch {
    related = []
  }

  try {
    deps.onConfirm?.({ action: 'promote', changed: true, reason: 'confirmed', sessionId })
  } catch {
    // 观测口失败不影响命令结果
  }
  deps.logger?.info(`OMB 确认：${sessionId ?? '未知会话'} ${stored.id} 候选 → 已确认`)
  return {
    kind: 'success',
    text: renderConfirmResult({
      record: stored,
      ...(related.length === 0 ? {} : { related }),
      ...(auditWarning === undefined ? {} : { auditWarning }),
    }),
  }
}

/**
 * 撤销一条（内部；不触发观测口，批量与单条由调用方汇总）。
 * 返回 `ok` 与已经渲染好的回执行（失败时是可读原因）。
 */
async function runUndo(
  found: { readonly store: TaggedStore; readonly record: MemoryRecord },
  id: string,
  sessionId: string | null,
  at: number,
  deps: ConfirmDeps,
): Promise<{ readonly ok: boolean; readonly text: string }> {
  const undone = undoConfirmedRecord(found.record)
  if (!undone.ok) return { ok: false, text: `未撤销：${undone.reason}。` }

  const last = await readLastAction(found.store, id)
  if (last === undefined) {
    return { ok: false, text: '未撤销：该库没有确认审计面（旧实现），无法证明这条是经 /omb-confirm 确认的。' }
  }
  if (last === null || last.action !== 'confirm') {
    return {
      ok: false,
      text: '未撤销：没有找到该条的 /omb-confirm 确认记录。它可能是用户显式 omb_remember 写入的——撤销会误伤用户原话，已拒绝。',
    }
  }

  try {
    await found.store.store.put(undone.record)
  } catch (error) {
    deps.logger?.warn(`OMB 确认：撤销写回失败（${id}）——${messageOf(error)}`)
    return { ok: false, text: `撤销写入失败（已隔离，未改动任何数据）：${messageOf(error)}` }
  }

  let stored: MemoryRecord | undefined
  try {
    stored = (await found.store.store.getMany([id]))[0]
  } catch {
    stored = undefined
  }
  if (stored === undefined || stored.assertedBy !== 'model' || stored.contentHash !== undone.record.contentHash) {
    return { ok: false, text: `撤销写入后查回失败（id=${id}）：结论未变更，请重试或检查库状态。` }
  }

  let auditWarning: string | undefined
  try {
    const api = asConfirmStore(found.store.store)
    if (api === undefined) auditWarning = '该库没有确认审计面（旧实现）'
    else await api.recordConfirm({ memoryId: stored.id, action: 'undo', sessionId, at })
  } catch (error) {
    auditWarning = messageOf(error)
  }

  deps.logger?.info(`OMB 确认：${sessionId ?? '未知会话'} ${stored.id} 已确认 → 候选（撤销）`)
  const text = renderUndoResult({ record: stored, lastConfirmedAt: last.at })
  return {
    ok: true,
    text: auditWarning === undefined ? text : `${text}\n⚠ 撤销审计写入失败：${auditWarning}`,
  }
}

/** 批量撤销：逐条执行、逐条报告；一条失败不影响其它条。 */
async function runUndoBatch(
  ids: readonly string[],
  stores: readonly TaggedStore[],
  sessionId: string | null,
  at: number,
  deps: ConfirmDeps,
): Promise<CommandResultLike> {
  const results: { readonly id: string; readonly ok: boolean; readonly text: string }[] = []
  for (const id of ids) {
    const found = await findRecord(stores, id)
    if (found === undefined) {
      results.push({ id, ok: false, text: `未知 id：${id}（用户库/项目库都没有这条记忆）` })
      continue
    }
    try {
      const result = await runUndo(found, id, sessionId, at, deps)
      results.push({ id, ok: result.ok, text: result.text })
    } catch (error) {
      results.push({ id, ok: false, text: `撤销失败（已隔离）：${messageOf(error)}` })
    }
  }
  const okCount = results.filter(result => result.ok).length
  try {
    deps.onConfirm?.({
      action: 'undo',
      changed: okCount > 0,
      count: okCount,
      reason: `undone=${okCount}/${ids.length}`,
      sessionId,
    })
  } catch {
    // 观测口失败不影响命令结果
  }
  const lines = [`批量撤销：成功 ${okCount} / 共 ${ids.length} 条。`]
  for (const result of results) {
    // 单条回执可能多行；批量里压成一行，用 `：` 连接第一行与其余要点
    const compact = result.text.split('\n').filter(line => line.trim().length > 0).join(' ｜ ')
    lines.push(`- ${result.ok ? '✅' : '❌'} ${result.id}：${compact}`)
  }
  return { kind: okCount > 0 ? 'success' : 'error', text: lines.join('\n') }
}

/**
 * 供**用户界面**（侧边栏）复用的确认/撤销动作（v4.15.1）。
 *
 * 与 `/omb-confirm` **同一份实现**：查库、候选形态校验、写回、查回验证、审计、
 * 相关条目、观测口都走 `runPromote` / `runUndo`。UI 不复制任何写逻辑。
 *
 * 边界：`sessionId` 是 UI 传入的宿主会话（用于审计），没有会话时写 `null`；
 * 动作仍是**用户动作**（浏览器点击），不是模型工具入口。
 */
export function createConfirmAction(deps: ConfirmDeps): (input: {
  readonly action: 'confirm' | 'undo'
  readonly id: string
  readonly sessionId?: string | null
}) => Promise<{ readonly ok: boolean; readonly text: string }> {
  return async (input) => {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (id.length === 0) return { ok: false, text: '未执行：id 不能为空。' }
    const sessionId = input.sessionId ?? null
    let stores: readonly TaggedStore[] | undefined
    try {
      stores = deps.resolveStores(sessionId ?? undefined)
    } catch (error) {
      return { ok: false, text: `未执行：解析记忆库失败（${messageOf(error)}）。` }
    }
    if (stores === undefined || stores.length === 0) {
      return { ok: false, text: '记忆服务未就绪：没有可查的库（omb-memory 未挂载或项目库尚未打开）。' }
    }
    const found = await findRecord(stores, id)
    if (found === undefined) {
      return { ok: false, text: `未知 id：${id}。用户库/项目库都没有这条记忆（不会按"最近一条"猜）。` }
    }
    const at = deps.clock.now()
    if (input.action === 'confirm') {
      const result = await runPromote(found, id, sessionId, at, deps)
      return { ok: result.kind === 'success', text: result.text }
    }
    return await runUndo(found, id, sessionId, at, deps)
  }
}

/**
 * 装配 `/omb-confirm`（通过宿主 `commands` 服务；不可用则如实记录原因）。
 */
export function installConfirm(kernel: Kernel, deps: ConfirmDeps): ConfirmInstallation {
  const disposers: (() => void)[] = []
  let commandState = '（尚未尝试注册）'
  try {
    const commands = kernel.service<CommandsLike>('commands')
    if (commands === undefined || typeof commands.register !== 'function') {
      commandState = '**未注册**：宿主 commands 服务不可用（行缺 inject: commands？）'
      deps.logger?.warn('OMB 确认：宿主 commands 服务不可用——/omb-confirm 在界面里不可用（记忆功能不受影响）。')
    } else {
      const returned = commands.register({
        definitionId: CONFIRM_COMMAND_ID,
        name: CONFIRM_COMMAND_NAME,
        description: '确认候选记忆，可撤销',
        input: { hint: '[list [offset] | log 记忆id | 记忆id | undo 记忆id...]' },
        handler: (invocation: CommandInvocationLike): Promise<CommandResultLike> => {
          const session = sessionOfInvocation(invocation)
          const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
          return runConfirmCommand(raw, session.sessionId, deps)
        },
      })
      if (typeof returned === 'function') disposers.push(returned as () => void)
      commandState = `已注册（宿主返回 ${typeof returned}）`
    }
  } catch (error) {
    commandState = `**未注册**：注册抛错——${messageOf(error)}`
    deps.logger?.warn(`OMB 确认：命令注册失败（已隔离）——${messageOf(error)}`)
  }
  return {
    commandState: () => commandState,
    dispose(): void {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 幂等、不抛
        }
      }
      disposers.length = 0
    },
  }
}
