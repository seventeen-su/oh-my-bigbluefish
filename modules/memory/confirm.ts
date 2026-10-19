/**
 * `/omb-confirm`：候选记忆的**用户**确认入口（v4.8.0）。
 *
 * ## 为什么必须存在
 *
 * `lifecycle.ts` 的规则是"写入时是什么证据，就停在对应的阶段；想升级只能由用户
 * 显式确认"。控制器自动写入的非显式长期偏好停在**候选**（`semantic + assertedBy:model`），
 * 但此前没有任何确认入口——候选只能靠"再显式说一遍"覆盖，库里因此长期堆着
 * 永远不会升级的条目。这不是"没有自动晋升"（那是对的），而是**缺了手动晋升**。
 *
 * ## 为什么是命令而不是工具
 *
 * 确认改变的是"证据等级"，只有**用户**有权把"系统推断"升格为"用户确认"。
 * 做成模型工具等于让模型自证（与 `/omb-privacy`、`/omb-feedback` 同一条原则），
 * 所以这里只注册斜杠命令，模型工具面一个字都不加。
 *
 * ## 语义（只做一件事）
 *
 * - 不带参数：列出当前会话可见库里的候选（最近 50 条里筛，最多显示 5 条）；
 * - `/omb-confirm <id>`：把该条 `assertedBy` 从 `model` 改为 `user`；
 * - **正文、id、contentHash、sourceRef、observedAt 一律不改**；不是删除/重写，是
 *   证据归属变更。确认后生命周期由"候选"变为"已确认"（或"经验"，procedural 时）。
 * - 只接受真正的候选：事件条目、已失效、已被取代、已是 `user` 的一律拒绝并说明。
 *
 * 隐私：sealed 不读；read-only 与归属未知不写（与 `/omb-feedback` 同一闸门）。
 */
import type { Kernel, MemoryRecord, TaggedStore } from '../../kernel/abi/index.js'
import type { CommandInvocationLike, CommandResultLike } from './privacy/command.js'
import { sessionOfInvocation } from './privacy/command.js'
import { asRecordScanner } from './store.js'
import { stageLabel, stageOfMemory } from './lifecycle.js'
import { isoUtc } from './retrieve.js'

export const CONFIRM_COMMAND_NAME = 'omb-confirm'
export const CONFIRM_COMMAND_ID = 'omb-memory/confirm'

export const CONFIRM_USAGE =
  '用法：/omb-confirm [记忆id]'
  + '（不带参数 = 列出候选；带 id = 确认该候选为"已确认"。'
  + '确认只改证据归属，不改正文与来源；模型没有这个入口）'

/** 列表最多显示几条候选。 */
export const CONFIRM_LIST_LIMIT = 5
/** 每库扫描最近多少条记录（有界：确认列表不该按库大小付代价）。 */
export const CONFIRM_SCAN_LIMIT = 50

export type ConfirmRequest =
  | { readonly kind: 'list' }
  | { readonly kind: 'promote'; readonly id: string }

export type ConfirmParseResult =
  | { readonly ok: true; readonly request: ConfirmRequest }
  | { readonly ok: false; readonly error: string }

/** 解析命令参数。**不抛**；纯函数。 */
export function parseConfirmArgs(raw: string): ConfirmParseResult {
  const tokens = (typeof raw === 'string' ? raw : '').trim().split(/\s+/).filter(token => token.length > 0)
  if (tokens.length === 0) return { ok: true, request: { kind: 'list' } }
  if (tokens.length > 1) {
    return { ok: false, error: `多余的参数：${tokens.slice(1).join(' ')}。${CONFIRM_USAGE}` }
  }
  return { ok: true, request: { kind: 'promote', id: tokens[0] as string } }
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

/** 一条候选（列表项）。 */
export interface ConfirmListItem {
  readonly record: MemoryRecord
}

/**
 * 扫描各库的最近记录，筛出候选（未失效、未被取代、semantic/procedural + model）。
 *
 * 只扫 `CONFIRM_SCAN_LIMIT` 条/库：确认列表是人工操作，不值得按库大小付代价；
 * 更早的候选可以用 `/omb-confirm <id>` 直接确认（id 从 recall 回执里拿）。
 */
export async function listCandidates(
  stores: readonly TaggedStore[],
  limit: number,
): Promise<readonly ConfirmListItem[]> {
  const items: ConfirmListItem[] = []
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
      items.push({ record })
    }
  }
  return items
    .sort((a, b) => b.record.observedAt - a.record.observedAt)
    .slice(0, limit)
}

function excerpt(text: string, max = 100): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** 候选列表回执（纯函数）。 */
export function renderCandidateList(items: readonly ConfirmListItem[]): string {
  if (items.length === 0) {
    return '没有待确认的候选记忆（当前可见库的最近记录里没有 semantic/procedural + model 的活跃条目）。'
  }
  const lines = [`待确认候选 ${items.length} 条（最多显示 ${CONFIRM_LIST_LIMIT} 条）：`]
  for (const { record } of items) {
    const stage = stageOfMemory({ kind: record.kind, assertedBy: record.assertedBy })
    lines.push(
      `- ${record.id} · ${record.scope}/${record.kind} · 阶段 ${stageLabel(stage)}`
      + ` · observedAt=${isoUtc(record.observedAt)} · ${excerpt(record.text)}`,
    )
  }
  lines.push('确认：/omb-confirm <记忆id>（确认后阶段变为"已确认"，正文与来源不变）')
  return lines.join('\n')
}

/** 确认回执（纯函数）。 */
export function renderConfirmResult(input: { readonly record: MemoryRecord }): string {
  const { record } = input
  const stage = stageOfMemory({ kind: record.kind, assertedBy: record.assertedBy })
  return [
    `已确认：id=${record.id}（${record.scope}/${record.kind}）`,
    `阶段：候选 → ${stageLabel(stage)}；证据归属 model → user（正文、来源、id、observedAt 均未改）。`,
    `原文：${excerpt(record.text, 240)}`,
  ].join('\n')
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
  /** 观测口（健康面按动作计数；绝不改变命令结果）。 */
  readonly onConfirm?: (info: {
    readonly action: 'list' | 'promote'
    readonly changed: boolean
    readonly reason: string
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

/**
 * 执行一次确认命令（解析 → 隐私 → 定位 → 变换 → 写回 → 查回验证 → 回执）。
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
    if (parsed.request.kind === 'promote' && !decision.allowWrite) {
      return {
        kind: 'error',
        text: '当前会话处于 read-only/未知归属：确认会改库，已拒绝（确认不能放宽隐私）。用 /omb-privacy normal 解除写限制后再试。',
      }
    }

    const stores = deps.resolveStores(sessionId ?? undefined)
    if (stores === undefined || stores.length === 0) {
      return { kind: 'error', text: '记忆服务未就绪：没有可查的库（omb-memory 未挂载或项目库尚未打开）。' }
    }

    if (parsed.request.kind === 'list') {
      const items = await listCandidates(stores, CONFIRM_LIST_LIMIT)
      try {
        deps.onConfirm?.({ action: 'list', changed: false, reason: `listed=${items.length}`, sessionId })
      } catch {
        // 观测口失败不影响命令结果
      }
      return { kind: 'success', text: renderCandidateList(items) }
    }

    const found = await findRecord(stores, parsed.request.id)
    if (found === undefined) {
      return { kind: 'error', text: `未知 id：${parsed.request.id}。用户库/项目库都没有这条记忆（不会按"最近一条"猜）。` }
    }
    const promoted = promoteCandidateRecord(found.record)
    if (!promoted.ok) {
      try {
        deps.onConfirm?.({ action: 'promote', changed: false, reason: promoted.reason, sessionId })
      } catch {
        // 观测口失败不影响命令结果
      }
      return { kind: 'error', text: `未确认：${promoted.reason}。${CONFIRM_USAGE}` }
    }

    try {
      await found.store.store.put(promoted.record)
    } catch (error) {
      deps.logger?.warn(`OMB 确认：写回失败（${parsed.request.id}）——${messageOf(error)}`)
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

    try {
      deps.onConfirm?.({ action: 'promote', changed: true, reason: 'confirmed', sessionId })
    } catch {
      // 观测口失败不影响命令结果
    }
    deps.logger?.info(`OMB 确认：${sessionId ?? '未知会话'} ${promoted.record.id} 候选 → 已确认`)
    return { kind: 'success', text: renderConfirmResult({ record: stored }) }
  } catch (error) {
    deps.logger?.warn(`OMB 确认命令失败（已隔离）：${messageOf(error)}`)
    return { kind: 'error', text: `确认命令执行失败（已隔离，未改动任何数据）：${messageOf(error)}` }
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
        description: '把候选记忆确认为已确认（用户显式动作；只改证据归属，不改正文与来源）',
        input: { hint: '[记忆id]（不带参数 = 列出候选）' },
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
      // 清空后重复 dispose 不会再次调用宿主的注销函数（"幂等"要真的幂等）
      disposers.length = 0
    },
  }
}
