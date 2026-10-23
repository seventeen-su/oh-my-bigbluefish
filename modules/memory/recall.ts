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
import type { ToolCallContext } from '../../kernel/sessionRuntime.js'
import { MEMORY_KINDS, MEMORY_SCOPES } from '../../kernel/abi/index.js'
import type { RetrievePorts, RetrieveQuery, RetrieveResult } from './retrieve.js'
import { isoUtc, retrieve } from './retrieve.js'
import { stageLabel } from './lifecycle.js'
import { asUsageStore } from './store.js'

export const RECALL_TOOL = 'omb_recall'
export const FORGET_TOOL = 'omb_forget'
/** 一次 `omb_forget` 允许的 id 上限（隐私擦除应当分批、可审计）。 */
export const MAX_FORGET_IDS = 500

/**
 * 召回输出的详细度（3.7-M2）。
 *
 * - `snippet`（**默认**）：每条正文 ≤ `SNIPPET_CHARS_PER_ITEM`，整次输出按
 *   `SNIPPET_TOTAL_CHARS` 分配预算——实测旧行为（全文）单次 3,877 字符 ≈2.4–3.2K token；
 * - `full`：逐字全文（旧行为，保留一个版本供显式要求与回归对照）。
 */
export type RecallDetail = 'snippet' | 'full'

/** 检索门控模式（3.7-M2）：`always` 绕过 pressure-tight 软门控。 */
export type RecallMode = 'auto' | 'always'

/** snippet 模式：每条正文上限（字符）。 */
export const SNIPPET_CHARS_PER_ITEM = 240
/**
 * snippet 模式：整次输出的正文预算（字符，不含 note 与逐条 header）。
 *
 * 取 1,500 而不是 1,600：工具回执可能追加"归属未知"说明（~90 字符），
 * 留出余量后**整次工具输出**仍 ≤1,600（W1 验收口径）。
 */
export const SNIPPET_TOTAL_CHARS = 1500
/** 分配后每条正文的下限：再紧也留一句可读的片段，不返回空条目。 */
export const SNIPPET_MIN_CHARS = 60

/** 参数 schema：`parse` + 给模型看的 `jsonSchema`（模型看不到我们的校验器）。 */
interface ToolParameters extends ToolInputSchema {
  readonly jsonSchema: Record<string, unknown>
}

const RECALL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要回忆什么（自然语言/关键词）' },
    limit: { type: 'integer', minimum: 1, maximum: 20, description: '条数，默认 5' },
    scope: { type: 'string', enum: [...MEMORY_SCOPES], description: '偏好库（仅影响排序/配额）' },
    kinds: {
      type: 'array',
      items: { type: 'string', enum: [...MEMORY_KINDS] },
      description: '记忆类型，省略=不限',
    },
    status: {
      type: 'string',
      enum: ['active', 'stale', 'superseded', 'all'],
      description: '状态：active（默认，只看有效条目）/ stale / superseded / all',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '标签过滤（多个标签需同时具备）；省略=不限',
    },
    fuzzy: { type: 'boolean', description: '模糊回退：词法零命中时再用子串匹配，默认开' },
    rerank: { type: 'boolean', description: '启用廉价重排，默认关' },
    detail: {
      type: 'string',
      enum: ['snippet', 'full'],
      description: '输出详细度：snippet（默认，每条≤240字符）/ full（逐字全文）',
    },
    mode: {
      type: 'string',
      enum: ['auto', 'always'],
      description: 'auto（默认）：压力紧时跳过检索；always：即使压力紧也强制检索',
    },
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
      description: '要删除的记忆 id（不可撤销）',
    },
    id: { type: 'string', description: '单条便捷写法，等价 ids:[id]' },
  },
  additionalProperties: false,
}

export interface RecallArgs {
  readonly query: string
  readonly limit?: number
  readonly scope?: MemoryScope
  readonly kinds?: readonly MemoryKind[]
  /** v4.10.0：状态过滤（默认 active）。 */
  readonly status?: 'active' | 'stale' | 'superseded' | 'all'
  /** v4.10.0：标签过滤（AND）。 */
  readonly tags?: readonly string[]
  /** v4.10.0：模糊回退开关（默认 true）。 */
  readonly fuzzy?: boolean
  readonly rerank?: boolean
  readonly detail?: RecallDetail
  readonly mode?: RecallMode
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
    return { ok: false, error: '参数必须是对象：{ query, limit?, scope?, kinds?, rerank?, detail?, mode? }' }
  }
  const raw = input as {
    query?: unknown
    limit?: unknown
    scope?: unknown
    kinds?: unknown
    status?: unknown
    tags?: unknown
    fuzzy?: unknown
    rerank?: unknown
    detail?: unknown
    mode?: unknown
  }
  if (typeof raw.query !== 'string' || raw.query.trim().length === 0) {
    return { ok: false, error: 'query 必须是非空字符串' }
  }
  const value: {
    query: string
    limit?: number
    scope?: MemoryScope
    kinds?: readonly MemoryKind[]
    status?: 'active' | 'stale' | 'superseded' | 'all'
    tags?: readonly string[]
    fuzzy?: boolean
    rerank?: boolean
    detail?: RecallDetail
    mode?: RecallMode
  } = {
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
  if (raw.status !== undefined) {
    const allowed = ['active', 'stale', 'superseded', 'all'] as const
    if (typeof raw.status !== 'string' || !(allowed as readonly string[]).includes(raw.status)) {
      return { ok: false, error: `status 只能是 ${allowed.join(' / ')}` }
    }
    value.status = raw.status as typeof allowed[number]
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) return { ok: false, error: 'tags 必须是字符串数组' }
    const tags: string[] = []
    for (const tag of raw.tags) {
      if (typeof tag !== 'string' || tag.trim().length === 0) {
        return { ok: false, error: 'tags 里的每一项都必须是非空字符串' }
      }
      if (tag.length > 24) return { ok: false, error: `标签 ${JSON.stringify(tag)} 超过 24 字符` }
      if (!tags.includes(tag)) tags.push(tag)
    }
    if (tags.length > 8) return { ok: false, error: 'tags 最多 8 个' }
    value.tags = tags
  }
  if (raw.fuzzy !== undefined) {
    if (typeof raw.fuzzy !== 'boolean') return { ok: false, error: 'fuzzy 必须是布尔值' }
    value.fuzzy = raw.fuzzy
  }
  if (raw.rerank !== undefined) {
    if (typeof raw.rerank !== 'boolean') return { ok: false, error: 'rerank 必须是布尔值' }
    value.rerank = raw.rerank
  }
  if (raw.detail !== undefined) {
    if (raw.detail !== 'snippet' && raw.detail !== 'full') {
      return { ok: false, error: 'detail 只能是 snippet / full' }
    }
    value.detail = raw.detail
  }
  if (raw.mode !== undefined) {
    if (raw.mode !== 'auto' && raw.mode !== 'always') {
      return { ok: false, error: 'mode 只能是 auto / always' }
    }
    value.mode = raw.mode
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
   * 解析**某会话**可用的库。未就绪返回 undefined（**不抛**）——
   * 库可能尚未打开（`apply` 同步、开库异步），工具必须能降级（热插拔契约）。
   *
   * `sessionId` 来自**本次工具调用**的归属（`ToolCallContext.sessionId`）。
   * 缺省（`undefined`）= 归属未知 → 调用方只给用户库，并在回执里明说，
   * **不得**退化成"最近一个会话"的库（那是交错会话污染的来源）。
   */
  readonly resolveStores: (sessionId?: string) => readonly TaggedStore[] | undefined
  /**
   * 时钟。**必填**：模块层不读墙钟，一律由 `dsh/` 传 `kernel.clock`
   * （团队约定；`retrieve` 因此保持纯函数）。
   */
  readonly clock: Clock
  /** 检索端口（嵌入器/第二通道）。缺省只用注入的时钟 + 纯词法。 */
  readonly ports?: () => RetrievePorts | undefined
  /**
   * **某会话**的上下文压力档位（软信号）。由 `dsh/` 提供宿主读数；
   * 只在 `tight` 时参与门控（可被 `mode: always` 覆盖）。
   *
   * 没有会话 → `undefined`（不用别人的压力读数塑形本次检索）。
   */
  readonly pressureBand?: (sessionId?: string) => PressureBand | undefined
  /**
   * 使用计数（`use_count`/`last_used_at`）**没写成**时的上报口。
   *
   * 记账失败绝不改变召回结果，但**不许静默**：失败次数与原因要能进状态面，
   * 否则"这条记忆被用过几次"永远是个没有来源的数字（M5 的静默失效正是这么来的）。
   */
  readonly onUsageFailure?: (info: { readonly reason: string; readonly ids: readonly string[] }) => void
  /**
   * 缺省输出详细度（3.7-M2，来自模块配置 `recallDetail`）。
   *
   * 缺省 `snippet`：单次召回 3,877 → ≤1,600 字符的验收目标由它承担。
   * `full` 只保留给显式参数与回归对照。
   */
  readonly defaultDetail?: RecallDetail
  /**
   * 1-hop `related` 扩展开关（3.7 Wave 2，来自模块配置 `relatedExpansion`）。
   *
   * 缺省关闭：单测/旧装配保持"只返回直接命中"；生产由模块配置默认打开。
   */
  readonly expandRelated?: boolean
  /**
   * 自适应词法下限（3.7 Wave 2 / R9 C3，来自模块配置与校准器）。
   *
   * - `mode`：`relative`（默认，`max(top×0.35, Q_q)`）/ `fixed`（旧 0.5 回滚）；
   * - `quantile`：惰性读取校准器当前 q（每轮可能被在线校准改动；缺省 0.5）。
   */
  readonly lexicalFloorMode?: 'relative' | 'fixed'
  readonly lexicalFloorQuantile?: () => number
  /** 检索完成后的只读观测口（3.7 Wave 2：曝光/扩展读数）。绝不改变结果。 */
  readonly onRetrieved?: (result: RetrieveResult, sessionId?: string) => void
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

/**
 * 被注入的条目记一次"用过"（`use_count +1`、`last_used_at = now`）。
 *
 * 判据（M5）：
 * - **只有成功注入**才写：门控跳过（`gate.retrieve === false`）或零命中时**一个字节都不写**；
 * - 按 `item.scope` 落到对应的库（id 唯一、记录只在一个库里）；
 * - 记账失败**绝不改变召回结果**，但必须经 `onUsageFailure` 上报（不许静默）。
 *
 * 为什么放在工具执行体而不是 `retrieve()` 里：读路径有延迟预算，而这是一次额外的写；
 * 放在这里，`retrieve()` 保持纯读（`retrieve.test.ts` 的夹具也不用跟着改语义）。
 */
async function markInjectedAsUsed(
  deps: MemoryToolDeps,
  stores: readonly TaggedStore[],
  result: RetrieveResult,
): Promise<void> {
  /** 记账是一条**旁路**：它自己抛出去就变成了"召回失败"，那是本末倒置。 */
  const report = (reason: string, ids: readonly string[]): void => {
    try {
      deps.onUsageFailure?.({ reason, ids })
    } catch {
      // 上报口自己失败不得改变召回结果
    }
  }
  try {
    if (!result.gate.retrieve || result.items.length === 0) return
    // `result.now === null` = 检索端口没给出时钟读数；那时用工具自己的时钟（同一个 `kernel.clock`）。
    // 时钟**也可能抛**（宿主时钟未就绪）：那时整段记账跳过，只上报原因。
    let now: number
    try {
      now = result.now ?? deps.clock.now()
    } catch (error) {
      report(`时钟不可用（${messageOf(error)}）`, [])
      return
    }
    const byScope = new Map<MemoryScope, string[]>()
    for (const item of result.items) {
      const ids = byScope.get(item.scope)
      if (ids === undefined) byScope.set(item.scope, [item.id])
      else ids.push(item.id)
    }
    for (const tagged of stores) {
      const ids = byScope.get(tagged.scope)
      if (ids === undefined || ids.length === 0) continue
      const usage = asUsageStore(tagged.store)
      if (usage === undefined) continue // 不是本实现的库：跳过记账（不抛、不影响召回）
      try {
        await usage.markUsed(ids, now)
      } catch (error) {
        report(messageOf(error), ids)
      }
    }
  } catch (error) {
    report(messageOf(error), [])
  }
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
      // **触发条件放最前面**，因为它才是这个工具真正缺的那一句。
      // 原来只说"能召回什么"，没说"什么时候该来召回"——而模型的常驻上下文里
      // 没有任何地方提过记忆库（常驻提示只点名了推理类的三个工具）。
      // 放这里而不是新增一条常驻提示，理由见 `docs/context-budget.md`：
      // ① 常驻预算总共 120 字符，推理那条已占 104，新增段要么截断它、要么抬高全体成本；
      // ② 工具描述与能力**同处一个清单**，模型在考虑用哪些工具时正好读到它；
      // ③ 常驻提示必须逐字节稳定（否则整个前缀缓存失效），做成"按需出现"反而更贵。
      '当问题涉及"之前/上次、讨论/做过的、我的（偏好）、纠错"，或当前任务可能为过去某次工作的延续时，先查这里的跨会话既往结论再回答。'
      + '写新结论前先查重；纠正旧结论时先召回旧条目，再用 omb_remember(supersedes) 更正。'
      + '从记忆库召回相关的既往结论/偏好/经验，逐字返回并附溯源（sourceRef 与 observedAt），便于判断证据新旧。' +
      '已被推翻的条目不作为有效结论注入；若存在这类候选，回执会列出 id——那是历史痕迹，追溯用 omb_relate。' +
      '需要多跳关联（这条结论被谁取代、还有哪些冲突）时也用 omb_relate。',
    parameters,
    async execute(args: unknown, call?: ToolCallContext): Promise<ToolOutcome> {
      const parsed = parseRecallArgs(args)
      if (!parsed.ok) return { kind: 'error', text: `${RECALL_TOOL} 参数非法：${parsed.error}` }
      const sessionId = sessionOf(call)
      const resolved = resolveStores(deps, sessionId)
      if (!resolved.ok) return { kind: 'error', text: `${RECALL_TOOL} 不可用：${resolved.error}` }
      const ports = resolvePorts(deps)
      const band = readPressureBand(deps, sessionId)
      const result = await retrieve(resolved.stores, toRetrieveQuery(parsed.value, band, deps), ports)
      try {
        deps.onRetrieved?.(result, sessionId)
      } catch {
        // 观测口失败不得改变召回结果
      }
      // 记账在**结果已经成立之后**：它失败与否都不改变"检索到了什么"（也绝不抛）
      await markInjectedAsUsed(deps, resolved.stores, result)
      if (result.items.length === 0) {
        // **"跳过"与"没有"必须分开说**（3.7-M2）：旧文案把 pressure-tight 门控也写成
        // "未检索到相关记忆 / 没有可注入的记忆"——模型会据此回答"记忆里没有这件事"，
        // 而真相是"库根本没被查"。两者的行动含义相反。
        const parts: string[] = []
        if (!result.gate.retrieve) {
          parts.push(`本次未检索（门控：${result.gate.reason}）——${result.gate.detail}`)
          parts.push('这不是"没有相关记忆"：记忆库没有被查询')
          if (result.gate.reason === 'pressure-tight') {
            parts.push('需要时用 mode:"always" 强制检索')
          }
        } else {
          parts.push(`未检索到相关记忆（${result.note}）`)
        }
        if (result.degraded.length > 0) parts.push(`降级：${result.degraded.join('；')}`)
        parts.push('不要编造内容')
        return { kind: 'text', text: `${parts.join('；')}${unknownAttributionNote(call)}` }
      }
      const detail = parsed.value.detail ?? deps.defaultDetail ?? 'snippet'
      return { kind: 'text', text: renderRecall(result, detail) + unknownAttributionNote(call) }
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
      '按 id 硬删除记忆（不可撤销）。仅用于用户显式要求遗忘或清理过期记录；记忆衰减由离线整合负责。整库擦除由用户直接操作库文件。',
    parameters,
    async execute(args: unknown, call?: ToolCallContext): Promise<ToolOutcome> {
      const parsed = parseForgetArgs(args)
      if (!parsed.ok) return { kind: 'error', text: `${FORGET_TOOL} 参数非法：${parsed.error}` }
      const resolved = resolveStores(deps, sessionOf(call))
      if (!resolved.ok) return { kind: 'error', text: `${FORGET_TOOL} 不可用：${resolved.error}` }
      const outcome = await forgetRecords(resolved.stores, parsed.value.ids)
      if (!outcome.ok) return { kind: 'error', text: `${FORGET_TOOL} 失败：${outcome.error}` }
      return { kind: 'text', text: renderForget(parsed.value.ids, outcome.value) + unknownAttributionNote(call) }
    },
  }
}

/** 两个工具一起给（`omb-memory` 打开时注册）。 */
export function createMemoryTools(deps: MemoryToolDeps): readonly ToolDefinition[] {
  return [createRecallTool(deps), createForgetTool(deps)]
}

/** `ToolFactory` 契约：由 `dsh/` 在正确作用域调用。 */
export const memoryToolFactory: ToolFactory<MemoryToolDeps> = { create: createMemoryTools }

/**
 * 召回结果的可读渲染：逐字文本 + 溯源 + 审计位。
 *
 * `detail` 默认 `full`（保持既有调用方/测试行为不变）；**工具执行体**按模块配置
 * 传 `snippet`（3.7-M2 的默认）。snippet 只截正文，header（id/作用域/时间/通道/来源）
 * 一律保留——"这条从哪来、凭什么排第一"不能因为省 token 而丢。
 */
export function renderRecall(result: RetrieveResult, detail: RecallDetail = 'full'): string {
  const lines: string[] = [`记忆召回（${RECALL_TOOL}）：${result.note}`]
  const headers = result.items.map(itemHeader)
  const tails: string[] = []
  if (result.items.length === 0) {
    tails.push('（没有可注入的记忆：请基于当前上下文作答，不要编造记忆内容。）')
  } else if (detail === 'snippet') {
    tails.push(
      `（snippet 模式：每条正文 ≤${SNIPPET_CHARS_PER_ITEM} 字符、整次预算 ${SNIPPET_TOTAL_CHARS} 字符；` +
        '逐字全文用 detail:"full"。）',
    )
  } else {
    tails.push('（以上为逐字原文；需要多跳关联时用 omb_relate。）')
  }
  // "被取代"不能只体现在计数上：给出 id，后续会话才能追到那条历史痕迹。
  if (result.stats.supersededSkipped > 0) {
    const ids = result.stats.supersededSkippedIds
    const listed = ids.length === 0 ? '（id 列表已达上限，未列出）' : ids.join('、')
    const more = result.stats.supersededSkipped > ids.length ? ` 等 ${result.stats.supersededSkipped} 条` : ''
    tails.push(
      `⚠️ 另有 ${result.stats.supersededSkipped} 条相关记忆**已被推翻**、未作为有效结论注入：${listed}${more}。` +
        '这是历史痕迹（"曾经相信过什么"），不是当前结论；要核对用 omb_relate <id> depth=1 types=["supersedes"]。',
    )
  }
  if (result.degraded.length > 0) tails.push(`降级：${result.degraded.join('；')}`)

  if (detail === 'full') {
    for (let index = 0; index < result.items.length; index += 1) {
      lines.push(headers[index] ?? '')
      lines.push(`  ${result.items[index]?.text ?? ''}`)
    }
    lines.push(...tails)
    return lines.join('\n')
  }

  // snippet：先扣掉 header/note/尾部，再把剩余预算平均分给正文（每条 ≤240）。
  // 这样"整次 ≤ SNIPPET_TOTAL_CHARS"与"每条 ≤ SNIPPET_CHARS_PER_ITEM"同时成立；
  // 极端情况（limit=20、header 很长）允许低于预算下限时超总预算，但不会超单条上限。
  const fixed =
    (lines[0]?.length ?? 0) +
    1 +
    tails.reduce((sum, line) => sum + line.length + 1, 0) +
    headers.reduce((sum, header) => sum + header.length + 3, 0)
  const count = result.items.length
  const available = Math.max(0, SNIPPET_TOTAL_CHARS - fixed)
  const perItem = count === 0
    ? 0
    : Math.min(SNIPPET_CHARS_PER_ITEM, Math.max(SNIPPET_MIN_CHARS, Math.floor(available / count)))
  for (let index = 0; index < count; index += 1) {
    const text = result.items[index]?.text ?? ''
    const snippet = text.length <= perItem ? text : `${text.slice(0, Math.max(0, perItem - 1))}…`
    lines.push(headers[index] ?? '')
    lines.push(`  ${snippet}`)
  }
  lines.push(...tails)
  return lines.join('\n')
}

/** 单条 header：id/作用域/类型/时间/相关度信号/通道/来源 + 有效性标注。 */
function itemHeader(item: RetrieveResult['items'][number]): string {
  const channels = item.ranks.map(r => `${r.channel}#${r.rank}`).join('+')
  /**
   * 3.7 Wave 2 / 审计 P3：`score` 是 RRF 融合分，**只有 1/(k+rank) 的两种取值**
   * （1 通道 0.0164 / 2 通道 0.0328）。把它写成 `score=` 会被模型读成"相关度"。
   * 这里改成：`融合分`（明确标注仅排序）+ `信号`（通道原始分：词法 -bm25 / 向量余弦）。
   */
  const signals: string[] = []
  if (item.signals.lexical !== undefined) signals.push(`词法 ${item.signals.lexical.toFixed(2)}`)
  if (item.signals.vector !== undefined) signals.push(`向量 ${item.signals.vector.toFixed(2)}`)
  if (item.signals.fuzzy !== undefined) signals.push('模糊子串')
  if (item.channels.includes('graph')) signals.push('1-hop 关联（弱）')
  const signalText = signals.length === 0 ? '信号 未测' : `信号 ${signals.join(' / ')}`
  const tagsText = (item.tags ?? []).length === 0 ? '' : ` · 标签 ${(item.tags ?? []).join(',')}`
  return (
    `[${item.rank + 1}] id=${item.id} · ${item.scope}/${item.kind} · 阶段 ${stageLabel(item.lifecycle)} · observedAt=${formatTime(item.observedAt)}` +
    ` · 融合分 ${item.score.toFixed(4)}（仅排序，不是相关度） · ${signalText} · 通道 ${channels}` +
    tagsText +
    ` · sourceRef=${item.sourceRef}` +
    validityMark(item.supersededBy, item.validTo)
  )
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

/**
 * 本次调用的会话（**只在归属确定时**返回）。
 *
 * `attribution !== 'session'` → `undefined`：宁可让下游降级为"只查用户库"，
 * 也不拿"最近一个会话"顶替（那正是交错会话污染的来源）。
 */
function sessionOf(call: ToolCallContext | undefined): string | undefined {
  return call?.attribution === 'session' ? call.sessionId : undefined
}

/**
 * 归属未知时在回执里**明说**。
 *
 * 不写这一句，读者会以为"召回不到项目库记忆"是"那里没有记忆"；
 * 而真相可能是"这次调用没有会话归属，我们只查了用户库"。两者含义相反。
 */
function unknownAttributionNote(call: ToolCallContext | undefined): string {
  if (call?.attribution === 'session') return ''
  return (
    '\n（归属未知：本次调用没有会话身份，**只查了用户库**——项目库的记忆没有被检索。'
    + '要按项目召回，请在会话回合内调用。）'
  )
}

function resolveStores(
  deps: MemoryToolDeps,
  sessionId: string | undefined,
): { readonly ok: true; readonly stores: readonly TaggedStore[] } | { readonly ok: false; readonly error: string } {
  let stores: readonly TaggedStore[] | undefined
  try {
    stores = deps.resolveStores(sessionId)
  } catch (err) {
    return { ok: false, error: `无法解析记忆库（${messageOf(err)}）` }
  }
  if (stores === undefined || stores.length === 0) {
    return { ok: false, error: '记忆服务未就绪（omb-memory 未挂载，或库尚未打开）' }
  }
  return { ok: true, stores }
}

/** 工具参数 → 检索请求（工具面用 `query`，检索面用 `text`；这里是唯一的映射点）。 */
function toRetrieveQuery(
  args: RecallArgs,
  band: PressureBand | undefined,
  deps: MemoryToolDeps,
): RetrieveQuery {
  return {
    text: args.query,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(args.fuzzy !== undefined ? { fuzzy: args.fuzzy } : {}),
    ...(args.rerank !== undefined ? { rerank: args.rerank } : {}),
    // `auto` 不写字面量：门控默认行为就是 auto；`always` 是唯一需要穿透的档位。
    ...(args.mode === 'always' ? { mode: 'always' as const } : {}),
    ...(band !== undefined ? { pressureBand: band } : {}),
    ...(deps.expandRelated === true ? { expandRelated: true } : {}),
    ...(deps.lexicalFloorMode !== undefined ? { lexicalFloorMode: deps.lexicalFloorMode } : {}),
    ...(() => {
      if (deps.lexicalFloorQuantile === undefined) return {}
      try {
        const quantile = deps.lexicalFloorQuantile()
        return Number.isFinite(quantile) ? { lexicalFloorQuantile: quantile } : {}
      } catch {
        return {}
      }
    })(),
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

/** 读某会话的压力档位（软信号）；读数失败/缺失/无会话 → undefined（不参与门控）。 */
function readPressureBand(deps: MemoryToolDeps, sessionId: string | undefined): PressureBand | undefined {
  try {
    return deps.pressureBand?.(sessionId)
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
