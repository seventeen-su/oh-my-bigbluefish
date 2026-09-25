/**
 * `omb_recall` / `omb_forget` 工具定义（规划 §5.4 检索、§5.6 写入与整合、§5.3 删除语义）。
 *
 * **模块不能注册工具**（只有 `dsh/` 能接触宿主），所以这里只**声明**两个工具，
 * 由 `dsh/` 在 `omb-memory` 打开时经 `ToolFactory` 注册；模块关掉 → 工具消失。
 *
 * 三条硬约束：
 * ① `execute` **绝不抛异常**：服务缺失、参数非法、库故障一律返回 `ToolOutcome` 的错误分支
 * ② `omb_forget` 走端口的 `forget(ids)`——那是**唯一的硬删除路径**（隐私/保留策略）；
 *    常规"衰减"绝不走它（衰减是重排先验，不是改数据）
 * ③ 召回结果**逐字 + 溯源**：消费者免费获得 `sourceRef` 与 `observedAt`，输出因此可审计
 */
import type {
  Clock,
  MemoryKind,
  MemoryScope,
  PressureBand,
  ToolDefinition,
  ToolFactory,
  ToolInputSchema,
  ToolOutcome,
} from '../../kernel/abi/index.js'
import type { TaggedStore } from '../../kernel/abi/index.js'
import { MEMORY_KINDS, MEMORY_SCOPES } from '../../kernel/abi/index.js'
import type { RetrievePorts, RetrieveQuery, RetrieveResult } from './retrieve.js'
import { isoUtc, retrieve } from './retrieve.js'

export const RECALL_TOOL = 'omb_recall'
export const FORGET_TOOL = 'omb_forget'
/** 一次 `omb_forget` 允许的 id 上限（隐私擦除应当分批、可审计）。 */
export const MAX_FORGET_IDS = 500

/** 参数 schema：`parse` + 给模型看的 `jsonSchema`（模型看不到我们的校验器）。 */
interface ToolParameters extends ToolInputSchema {
  readonly jsonSchema: Record<string, unknown>
}

const RECALL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要回忆什么（自然语言或关键词；中文可直接写）' },
    limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回几条，默认 5' },
    scope: { type: 'string', enum: [...MEMORY_SCOPES], description: '偏好哪个库（仅影响排序与配额，不用于过滤）' },
    kinds: {
      type: 'array',
      items: { type: 'string', enum: [...MEMORY_KINDS] },
      description: '限定记忆类型；省略 = 不限',
    },
    rerank: { type: 'boolean', description: '是否启用廉价重排（默认关闭）' },
  },
  required: ['query'],
  additionalProperties: false,
}

const FORGET_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ids: {
      type: 'array',
      items: { type: 'string' },
      description: '要**硬删除**的记忆 id（用户显式要求遗忘时才用；不可撤销）',
    },
    id: { type: 'string', description: '单条写法的便捷形式，等价于 ids: [id]' },
  },
  additionalProperties: false,
}

export interface RecallArgs {
  readonly query: string
  readonly limit?: number
  readonly scope?: MemoryScope
  readonly kinds?: readonly MemoryKind[]
  readonly rerank?: boolean
}

export interface ForgetArgs {
  readonly ids: readonly string[]
}

export type ArgsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/** `omb_recall` 参数校验。**不抛**。 */
export function parseRecallArgs(input: unknown): ArgsResult<RecallArgs> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '参数必须是对象：{ query, limit?, scope?, kinds?, rerank? }' }
  }
  const raw = input as { query?: unknown; limit?: unknown; scope?: unknown; kinds?: unknown; rerank?: unknown }
  if (typeof raw.query !== 'string' || raw.query.trim().length === 0) {
    return { ok: false, error: 'query 必须是非空字符串' }
  }
  const value: { query: string; limit?: number; scope?: MemoryScope; kinds?: readonly MemoryKind[]; rerank?: boolean } = {
    query: raw.query,
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 20) {
      return { ok: false, error: `limit 必须是 1~20 的整数，收到 ${JSON.stringify(raw.limit)}` }
    }
    value.limit = raw.limit
  }
  if (raw.scope !== undefined) {
    if (typeof raw.scope !== 'string' || !(MEMORY_SCOPES as readonly string[]).includes(raw.scope)) {
      return { ok: false, error: `scope 只能是 ${MEMORY_SCOPES.join(' / ')}` }
    }
    value.scope = raw.scope as MemoryScope
  }
  if (raw.kinds !== undefined) {
    if (!Array.isArray(raw.kinds) || raw.kinds.length === 0) {
      return { ok: false, error: 'kinds 必须是非空数组；省略即不限' }
    }
    const kinds: MemoryKind[] = []
    for (const kind of raw.kinds) {
      if (typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
        return { ok: false, error: `未知的记忆类型 ${JSON.stringify(kind)}；可选：${MEMORY_KINDS.join(' / ')}` }
      }
      if (!kinds.includes(kind as MemoryKind)) kinds.push(kind as MemoryKind)
    }
    value.kinds = kinds
  }
  if (raw.rerank !== undefined) {
    if (typeof raw.rerank !== 'boolean') return { ok: false, error: 'rerank 必须是布尔值' }
    value.rerank = raw.rerank
  }
  return { ok: true, value }
}

/** `omb_forget` 参数校验。**不抛**。 */
export function parseForgetArgs(input: unknown): ArgsResult<ForgetArgs> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '参数必须是对象：{ ids: [...] }（或 { id }）' }
  }
  const raw = input as { ids?: unknown; id?: unknown }
  const picked: string[] = []
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    if (!picked.includes(trimmed)) picked.push(trimmed)
  }
  if (raw.ids !== undefined) {
    if (!Array.isArray(raw.ids)) return { ok: false, error: 'ids 必须是字符串数组' }
    for (const value of raw.ids) {
      if (typeof value !== 'string') return { ok: false, error: 'ids 里必须都是字符串' }
      push(value)
    }
  }
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string') return { ok: false, error: 'id 必须是字符串' }
    push(raw.id)
  }
  if (picked.length === 0) {
    return { ok: false, error: '必须给出要删除的 id（ids 数组或单个 id）——本工具不做"整库擦除"' }
  }
  if (picked.length > MAX_FORGET_IDS) {
    return { ok: false, error: `一次最多删除 ${MAX_FORGET_IDS} 条，收到 ${picked.length} 条；请分批` }
  }
  return { ok: true, value: { ids: picked } }
}

export interface MemoryToolDeps {
  /**
   * 解析当前可用的库。未就绪返回 undefined（**不抛**）——
   * 库可能尚未打开（`apply` 同步、开库异步），工具必须能降级（热插拔契约）。
   */
  readonly resolveStores: () => readonly TaggedStore[] | undefined
  /**
   * 时钟。**必填**：模块层不读墙钟，一律由 `dsh/` 传 `kernel.clock`
   * （团队约定；`retrieve`/`consolidate` 因此保持纯函数）。
   */
  readonly clock: Clock
  /** 检索端口（嵌入器/第二通道）。缺省只用注入的时钟 + 纯词法。 */
  readonly ports?: () => RetrievePorts | undefined
  /**
   * 当前上下文压力档位（软信号）。由 `dsh/` 提供宿主读数；
   * 只在 `tight` 时参与门控（可被 `mode: always` 覆盖）。
   */
  readonly pressureBand?: () => PressureBand | undefined
}

export interface ForgetOutcome {
  readonly deleted: number
  readonly perScope: readonly { readonly scope: MemoryScope; readonly deleted: number }[]
  readonly missing: readonly string[]
  readonly degraded: readonly string[]
}

/**
 * 硬删除：先按库定位归属（每库一次批量 `getMany`），再逐库 `forget`。
 *
 * 为什么先定位：隐私擦除要给出**可审计的回执**（删了几条、哪些没找到），
 * 而不是"调了两次删除、返回两个数字"。
 */
export async function forgetRecords(
  stores: readonly TaggedStore[],
  ids: readonly string[],
): Promise<ArgsResult<ForgetOutcome>> {
  if (stores.length === 0) {
    return { ok: false, error: '记忆服务未就绪（没有可查的库）' }
  }
  const degraded: string[] = []
  const ordered = [...stores].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'user' ? -1 : 1
    return 0
  })
  const owners = new Map<string, MemoryScope>()
  await Promise.all(
    ordered.map(async tagged => {
      try {
        const found = await tagged.store.getMany(ids)
        for (const record of found) if (!owners.has(record.id)) owners.set(record.id, record.scope)
      } catch (err) {
        degraded.push(`库 ${tagged.scope} 定位失败（${messageOf(err)}）`)
      }
    }),
  )
  const missing = ids.filter(id => !owners.has(id))
  const perScope: { scope: MemoryScope; deleted: number }[] = []
  let deleted = 0
  for (const tagged of ordered) {
    const owned = ids.filter(id => owners.get(id) === tagged.scope)
    if (owned.length === 0) continue
    try {
      const removed = await tagged.store.forget(owned)
      deleted += removed
      perScope.push({ scope: tagged.scope, deleted: removed })
    } catch (err) {
      degraded.push(`库 ${tagged.scope} 删除失败（${messageOf(err)}）`)
    }
  }
  return { ok: true, value: { deleted, perScope, missing, degraded } }
}

/** `omb_recall` 工具定义。 */
export function createRecallTool(deps: MemoryToolDeps): ToolDefinition {
  const parameters: ToolParameters = {
    jsonSchema: RECALL_JSON_SCHEMA,
    parse(input: unknown): unknown {
      const parsed = parseRecallArgs(input)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.value
    },
  }
  return {
    name: RECALL_TOOL,
    description:
      '从记忆库召回与当前任务相关的既往结论/偏好/经验。**逐字返回**并附带溯源 ' +
      '（sourceRef 与 observedAt），便于你判断证据新旧与来源。返回空结果也是正常结论 ' +
      '（说明"不需要记忆"或确实没有相关记忆），不是错误。**已被推翻的条目不作为有效结论注入**；' +
      '若本次存在这类候选，回执会列出它们的 id——那是历史痕迹，需要追溯时用 omb_relate。' +
      '需要多跳关联（这条结论被谁取代、还有哪些冲突）时也用 omb_relate。',
    parameters,
    async execute(args: unknown): Promise<ToolOutcome> {
      const parsed = parseRecallArgs(args)
      if (!parsed.ok) return { kind: 'error', text: `${RECALL_TOOL} 参数非法：${parsed.error}` }
      const resolved = resolveStores(deps)
      if (!resolved.ok) return { kind: 'error', text: `${RECALL_TOOL} 不可用：${resolved.error}` }
      const ports = resolvePorts(deps)
      const band = readPressureBand(deps)
      const result = await retrieve(resolved.stores, toRetrieveQuery(parsed.value, band), ports)
      return { kind: 'text', text: renderRecall(result) }
    },
  }
}

/** `omb_forget` 工具定义（隐私擦除；**唯一的硬删除路径**）。 */
export function createForgetTool(deps: MemoryToolDeps): ToolDefinition {
  const parameters: ToolParameters = {
    jsonSchema: FORGET_JSON_SCHEMA,
    parse(input: unknown): unknown {
      const parsed = parseForgetArgs(input)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.value
    },
  }
  return {
    name: FORGET_TOOL,
    description:
      '按 id **硬删除**记忆（不可撤销）。只在用户显式要求遗忘、或保留策略清理过期记录时使用；' +
      '常规的"记忆衰减"由离线整合负责，不需要调用本工具。整库擦除请由用户直接操作库文件。',
    parameters,
    async execute(args: unknown): Promise<ToolOutcome> {
      const parsed = parseForgetArgs(args)
      if (!parsed.ok) return { kind: 'error', text: `${FORGET_TOOL} 参数非法：${parsed.error}` }
      const resolved = resolveStores(deps)
      if (!resolved.ok) return { kind: 'error', text: `${FORGET_TOOL} 不可用：${resolved.error}` }
      const outcome = await forgetRecords(resolved.stores, parsed.value.ids)
      if (!outcome.ok) return { kind: 'error', text: `${FORGET_TOOL} 失败：${outcome.error}` }
      return { kind: 'text', text: renderForget(parsed.value.ids, outcome.value) }
    },
  }
}

/** 两个工具一起给（`omb-memory` 打开时注册）。 */
export function createMemoryTools(deps: MemoryToolDeps): readonly ToolDefinition[] {
  return [createRecallTool(deps), createForgetTool(deps)]
}

/** `ToolFactory` 契约：由 `dsh/` 在正确作用域调用。 */
export const memoryToolFactory: ToolFactory<MemoryToolDeps> = { create: createMemoryTools }

/** 召回结果的可读渲染：逐字文本 + 溯源 + 审计位。 */
export function renderRecall(result: RetrieveResult): string {
  const lines: string[] = [`记忆召回（${RECALL_TOOL}）：${result.note}`]
  for (const item of result.items) {
    const channels = item.ranks.map(r => `${r.channel}#${r.rank}`).join('+')
    lines.push(
      `[${item.rank + 1}] id=${item.id} · ${item.scope}/${item.kind} · observedAt=${formatTime(item.observedAt)}` +
        ` · score=${item.score.toFixed(4)} · 通道 ${channels} · sourceRef=${item.sourceRef}` +
        validityMark(item.supersededBy, item.validTo),
    )
    lines.push(`  ${item.text}`)
  }
  if (result.items.length === 0) {
    lines.push('（没有可注入的记忆：请基于当前上下文作答，不要编造记忆内容。）')
  } else {
    lines.push('（以上为逐字原文；需要多跳关联时用 omb_relate。）')
  }
  // "被取代"不能只体现在计数上：给出 id，后续会话才能追到那条历史痕迹。
  if (result.stats.supersededSkipped > 0) {
    const ids = result.stats.supersededSkippedIds
    const listed = ids.length === 0 ? '（id 列表已达上限，未列出）' : ids.join('、')
    const more = result.stats.supersededSkipped > ids.length ? ` 等 ${result.stats.supersededSkipped} 条` : ''
    lines.push(
      `⚠️ 另有 ${result.stats.supersededSkipped} 条相关记忆**已被推翻**、未作为有效结论注入：${listed}${more}。` +
        '这是历史痕迹（"曾经相信过什么"），不是当前结论；要核对用 omb_relate <id> depth=1 types=["supersedes"]。',
    )
  }
  if (result.degraded.length > 0) lines.push(`降级：${result.degraded.join('；')}`)
  return lines.join('\n')
}

/**
 * 单条的有效性标注。
 *
 * 已失效的条目通常**根本不会**被注入（`retrieve` 会排除 `validTo` 非空的候选），
 * 这里仍然显式标注：通道实现或未来的放宽一旦让它漏进来，
 * 读到的人必须立刻知道"这条已被推翻"，而不是把它当成有效结论。
 */
function validityMark(supersededBy: string | null, validTo: number | null): string {
  if (supersededBy !== null) {
    return ` · ⚠️已被 ${supersededBy} 取代（本条不是有效结论）`
  }
  if (validTo !== null) return ` · ⚠️已失效（validTo=${formatTime(validTo)}）`
  return ''
}

/** 删除回执：删了几条、哪些没找到、磁盘是否清干净。 */
export function renderForget(ids: readonly string[], outcome: ForgetOutcome): string {
  const parts = outcome.perScope.map(entry => `${entry.scope} ${entry.deleted}`).join(' / ')
  const lines = [
    `已删除 ${outcome.deleted} 条记忆${parts.length > 0 ? `（${parts}）` : ''}。`,
    // **措辞按实测改过**：原文案写"硬删除…不再可召回"，而逐字节扫描发现
    // 被删文本以明文留在 `<库>.db-wal` 里（`secure_delete=0` + 未 checkpoint）。
    // 现在 `forget` 会截断 WAL，所以这句话才立得住——但立的依据是**做了截断**，
    // 不是"DELETE 语句看起来像硬删除"。
    '这条路径不可撤销；被删内容与其溯源不再可召回，且已把 WAL 截断以清除磁盘明文残留。',
  ]
  if (outcome.missing.length > 0) {
    lines.push(`未找到 ${outcome.missing.length} 条（可能已被删除，或 id 拼错）：${outcome.missing.join(', ')}`)
  }
  if (outcome.degraded.length > 0) lines.push(`降级：${outcome.degraded.join('；')}`)
  lines.push(`请求 ${ids.length} 条，实际删除 ${outcome.deleted} 条。`)
  return lines.join('\n')
}

// ---------- 内部工具 ----------

function resolveStores(
  deps: MemoryToolDeps,
): { readonly ok: true; readonly stores: readonly TaggedStore[] } | { readonly ok: false; readonly error: string } {
  let stores: readonly TaggedStore[] | undefined
  try {
    stores = deps.resolveStores()
  } catch (err) {
    return { ok: false, error: `无法解析记忆库（${messageOf(err)}）` }
  }
  if (stores === undefined || stores.length === 0) {
    return { ok: false, error: '记忆服务未就绪（omb-memory 未挂载，或库尚未打开）' }
  }
  return { ok: true, stores }
}

/** 工具参数 → 检索请求（工具面用 `query`，检索面用 `text`；这里是唯一的映射点）。 */
function toRetrieveQuery(args: RecallArgs, band: PressureBand | undefined): RetrieveQuery {
  return {
    text: args.query,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
    ...(args.rerank !== undefined ? { rerank: args.rerank } : {}),
    ...(band !== undefined ? { pressureBand: band } : {}),
  }
}

function resolvePorts(deps: MemoryToolDeps): RetrievePorts {
  try {
    const ports = deps.ports?.()
    if (ports !== undefined) return ports
  } catch {
    // 端口解析失败 → 退化为**注入的时钟** + 纯词法（仍然完整可用）
  }
  return { clock: deps.clock }
}

/** 读宿主压力档位（软信号）；读数失败/缺失 → undefined（不参与门控）。 */
function readPressureBand(deps: MemoryToolDeps): PressureBand | undefined {
  try {
    return deps.pressureBand?.()
  } catch {
    return undefined
  }
}

function formatTime(epochMs: number): string {
  return isoUtc(epochMs)
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

/** 供状态面/测试读取：本模块声明的工具名。 */
export const MEMORY_TOOL_NAMES: readonly string[] = [RECALL_TOOL, FORGET_TOOL]
