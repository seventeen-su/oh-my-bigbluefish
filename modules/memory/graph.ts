/**
 * 关联扩展（多跳，按需）——规划 §5.5 + §2 D3。
 *
 * **形态是刻意的**：三种类型化边（`supersedes` / `conflicts_with` / `derived_from`）
 * 已经是一张图，只是很小且带类型；图谱收益集中在**多跳类查询**（少数），
 * 所以做成**按需拉取**，而不是默认检索路径的一部分。
 *
 * 明确不做（§5.5 + D3 的被否决项）：
 * - **不做实体/关系抽取流水线**：抽取有损（Fidelity Before Structure）
 * - **不做自动图扩展**：那会把少数场景的成本摊到所有查询上
 * - `omb-memory-graph` 模块关闭 → 本工具不注册，模型看不到它
 *
 * 分层约束：只依赖 `kernel/abi`。工具定义由 `dsh/` 侧注册（模块不能接触宿主）。
 */
import type {
  Edge,
  EdgeType,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  ToolDefinition,
  ToolFactory,
  ToolInputSchema,
  ToolOutcome,
} from '../../kernel/abi/index.js'
import type { TaggedStore } from '../../kernel/abi/index.js'
import { EDGE_TYPES } from '../../kernel/abi/index.js'
import { isoUtc } from './retrieve.js'

export const RELATE_TOOL = 'omb_relate'
/** 多跳深度上限（规划 §5.5：`depth?: 1|2`）。 */
export const MAX_DEPTH = 2
/** 默认节点上限：这是**上下文保护**，不是语义限制。 */
export const DEFAULT_MAX_NODES = 20
/** 默认边上限。 */
export const DEFAULT_MAX_EDGES = 60

/** 边的三种类型的语义（写进工具的 `why`，让模型知道它拿到的是什么）。 */
export const EDGE_LEGEND: Readonly<Record<EdgeType, string>> = {
  supersedes: '时序更正：指向的记录已被新证据取代（非破坏性，历史仍可回答）',
  conflicts_with: '未裁决的矛盾：两条都保留，不由系统静默选一个',
  derived_from: '派生来源：这条结论是从哪条观察/工件推出来的',
}

export interface RelateRequest {
  readonly id: string
  readonly depth: 1 | 2
  readonly types: readonly EdgeType[]
}

export type RelateArgsResult =
  | { readonly ok: true; readonly value: RelateRequest }
  | { readonly ok: false; readonly error: string }

/**
 * 参数校验。**不抛**——工具执行体绝不抛异常（热插拔要求）。
 */
export function parseRelateArgs(input: unknown): RelateArgsResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '参数必须是对象：{ id, depth?, types? }' }
  }
  const raw = input as { id?: unknown; depth?: unknown; types?: unknown }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return { ok: false, error: 'id 必须是非空字符串（记忆 id，可从 omb_recall 的溯源里拿到）' }
  }
  let depth: 1 | 2 = 1
  if (raw.depth !== undefined) {
    if (raw.depth !== 1 && raw.depth !== 2) {
      return { ok: false, error: `depth 只能是 1 或 2，收到 ${JSON.stringify(raw.depth)}` }
    }
    depth = raw.depth
  }
  let types: readonly EdgeType[] = EDGE_TYPES
  if (raw.types !== undefined) {
    if (!Array.isArray(raw.types)) {
      return { ok: false, error: 'types 必须是数组，例如 ["supersedes","conflicts_with"]' }
    }
    if (raw.types.length === 0) {
      return { ok: false, error: 'types 不能是空数组；省略即三种边全要' }
    }
    const picked: EdgeType[] = []
    for (const value of raw.types) {
      if (typeof value !== 'string' || !(EDGE_TYPES as readonly string[]).includes(value)) {
        return { ok: false, error: `未知的边类型 ${JSON.stringify(value)}；可选：${EDGE_TYPES.join(' / ')}` }
      }
      if (!picked.includes(value as EdgeType)) picked.push(value as EdgeType)
    }
    types = picked
  }
  return { ok: true, value: { id: raw.id.trim(), depth, types } }
}

export interface WalkLimits {
  readonly maxNodes?: number
  readonly maxEdges?: number
}

export interface WalkPlan {
  /** 按 (hop asc, id asc) 的确定性顺序；含起点（hop 0）。 */
  readonly hops: readonly { readonly id: string; readonly hop: number }[]
  readonly edges: readonly Edge[]
  readonly truncated: boolean
}

/**
 * 多跳规划（**纯函数**）：在给定边集上做类型化的无向 BFS。
 *
 * 为什么不用存储侧的返回顺序：`walkGraph` 的 level-batch 查询只保证集合，
 * 不保证顺序；顺序必须由规划层用 ASCII 比较钉死（确定性）。
 * 两个上限（节点/边）是**上下文保护**，触顶即停并如实报告 `truncated`。
 */
export function planWalk(
  startId: string,
  edges: readonly Edge[],
  depth: number,
  types: readonly EdgeType[],
  limits: WalkLimits = {},
): WalkPlan {
  const maxNodes = normalizeLimit(limits.maxNodes, DEFAULT_MAX_NODES)
  const maxEdges = normalizeLimit(limits.maxEdges, DEFAULT_MAX_EDGES)
  const allowed = new Set<EdgeType>(types)
  const boundedDepth = Math.max(0, Math.min(MAX_DEPTH, Math.floor(depth)))

  // 邻接表：两个方向都跟（store 侧 `walkGraph` 即无向语义）。
  const adjacency = new Map<string, Edge[]>()
  for (const edge of edges) {
    if (!allowed.has(edge.type)) continue
    if (edge.fromId === edge.toId) continue // 自环对遍历无语义
    push(adjacency, edge.fromId, edge)
    push(adjacency, edge.toId, edge)
  }
  for (const list of adjacency.values()) {
    list.sort(
      (a, b) =>
        asciiCompare(a.fromId, b.fromId) ||
        asciiCompare(a.toId, b.toId) ||
        asciiCompare(a.type, b.type),
    )
  }

  const hops: { id: string; hop: number }[] = [{ id: startId, hop: 0 }]
  const visited = new Set<string>([startId])
  const usedEdges: Edge[] = []
  const usedEdgeKeys = new Set<string>()
  let truncated = false
  let frontier: string[] = [startId]

  for (let hop = 1; hop <= boundedDepth; hop += 1) {
    const next: string[] = []
    for (const node of frontier) {
      for (const edge of adjacency.get(node) ?? []) {
        const key = edgeKey(edge)
        if (!usedEdgeKeys.has(key)) {
          if (usedEdges.length >= maxEdges) {
            truncated = true
            continue
          }
          usedEdgeKeys.add(key)
          usedEdges.push(edge)
        }
        const other = edge.fromId === node ? edge.toId : edge.fromId
        if (visited.has(other)) continue
        if (hops.length >= maxNodes) {
          truncated = true
          continue
        }
        visited.add(other)
        hops.push({ id: other, hop })
        next.push(other)
      }
    }
    frontier = next
    if (hops.length >= maxNodes) {
      truncated = true
      break
    }
  }
  hops.sort((a, b) => a.hop - b.hop || asciiCompare(a.id, b.id))
  usedEdges.sort(
    (a, b) => asciiCompare(a.fromId, b.fromId) || asciiCompare(a.toId, b.toId) || asciiCompare(a.type, b.type),
  )
  return { hops, edges: usedEdges, truncated }
}

export interface RelateNode {
  readonly id: string
  /** 到起点的跳数（起点自身为 0）。 */
  readonly hop: number
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  /** 逐字原文。 */
  readonly text: string
  readonly sourceRef: string
  readonly observedAt: number
  readonly validTo: number | null
  readonly supersededBy: string | null
}

export interface RelateResult {
  readonly startId: string
  readonly depth: number
  readonly types: readonly EdgeType[]
  readonly nodes: readonly RelateNode[]
  readonly edges: readonly Edge[]
  /** 为什么是这些节点/边——审计与给模型看的解释。 */
  readonly why: string
  readonly truncated: boolean
  readonly degraded: readonly string[]
}

export type RelateOutcome =
  | { readonly ok: true; readonly result: RelateResult }
  | { readonly ok: false; readonly error: string }

/**
 * 多跳遍历。**服务缺失/库失败一律降级为可读原因，不抛。**
 *
 * 扇出与检索主路径一致：每个库都问（绝不因一库有结果就跳过另一库）。
 */
export async function walkGraph(
  stores: readonly TaggedStore[],
  request: RelateRequest,
  limits: WalkLimits = {},
): Promise<RelateOutcome> {
  if (stores.length === 0) {
    return { ok: false, error: '记忆服务未就绪（没有可查的库）——omb_relate 需要 omb-memory 已挂载' }
  }
  const degraded: string[] = []
  const ordered = orderStores(stores)

  // ① 起点记录：每库一次批量取（禁止 N+1）。
  const recordById = new Map<string, MemoryRecord>()
  await Promise.all(
    ordered.map(async tagged => {
      try {
        const found = await tagged.store.getMany([request.id])
        for (const record of found) if (!recordById.has(record.id)) recordById.set(record.id, record)
      } catch (err) {
        degraded.push(`库 ${tagged.scope} 取起点失败（${messageOf(err)}）`)
      }
    }),
  )
  const start = recordById.get(request.id)
  if (start === undefined) {
    return { ok: false, error: `未找到记忆 ${request.id}（可能 id 拼错、已被隐私擦除，或不在任何已打开的库里）` }
  }

  // ② 每库的多跳遍历（类型化，无向）。
  const allEdges: Edge[] = []
  const edgeKeys = new Set<string>()
  await Promise.all(
    ordered.map(async tagged => {
      try {
        const walk = await tagged.store.walkGraph({
          fromId: request.id,
          depth: request.depth,
          types: request.types,
        })
        for (const record of walk.nodes) if (!recordById.has(record.id)) recordById.set(record.id, record)
        for (const edge of walk.edges) {
          const key = edgeKey(edge)
          if (edgeKeys.has(key)) continue
          edgeKeys.add(key)
          allEdges.push(edge)
        }
      } catch (err) {
        degraded.push(`库 ${tagged.scope} 图遍历失败（${messageOf(err)}）`)
      }
    }),
  )

  // ③ 规划层做确定性排序与上限控制。
  const plan = planWalk(request.id, allEdges, request.depth, request.types, limits)

  // ④ 缺失正文的节点补一次批量取（每库一次；仍然禁止 N+1）。
  const missing = plan.hops.filter(h => !recordById.has(h.id)).map(h => h.id)
  if (missing.length > 0) {
    await Promise.all(
      ordered.map(async tagged => {
        try {
          const found = await tagged.store.getMany(missing)
          for (const record of found) if (!recordById.has(record.id)) recordById.set(record.id, record)
        } catch (err) {
          degraded.push(`库 ${tagged.scope} 补取关联正文失败（${messageOf(err)}）`)
        }
      }),
    )
  }

  const nodes: RelateNode[] = []
  for (const hop of plan.hops) {
    const record = recordById.get(hop.id)
    if (record === undefined) continue
    nodes.push({
      id: record.id,
      hop: hop.hop,
      scope: record.scope,
      kind: record.kind,
      text: record.text,
      sourceRef: record.sourceRef,
      observedAt: record.observedAt,
      validTo: record.validTo,
      supersededBy: record.supersededBy,
    })
  }
  const missingNodes = plan.hops.length - nodes.length
  if (missingNodes > 0) {
    degraded.push(`有 ${missingNodes} 个关联节点没有正文（可能已被隐私擦除）：已从结果里剔除`)
  }

  return {
    ok: true,
    result: {
      startId: request.id,
      depth: request.depth,
      types: request.types,
      nodes,
      edges: plan.edges,
      why: explain(request, nodes, plan, degraded),
      truncated: plan.truncated,
      degraded,
    },
  }
}

/** `why`：多跳的**可读解释**，顺便让模型知道三种边各自意味着什么。 */
export function explain(
  request: RelateRequest,
  nodes: readonly RelateNode[],
  plan: WalkPlan,
  degraded: readonly string[],
): string {
  const byType = countBy(plan.edges.map(e => e.type))
  const typeText = request.types.map(t => `${t}=${byType[t] ?? 0}`).join(' / ')
  const hopText = countBy(nodes.map(n => String(n.hop)))
  const hopSummary = [...Object.entries(hopText)]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([hop, count]) => `hop${hop}:${count}`)
    .join(' ')
  const lines = [
    `从 ${request.id} 出发，沿类型化边无向遍历 depth=${request.depth}，边类型 ${request.types.join(' / ')}。`,
    `命中 ${nodes.length} 个节点、${plan.edges.length} 条边（${typeText}）；${hopSummary}。`,
  ]
  for (const type of request.types) lines.push(`- ${type}：${EDGE_LEGEND[type]}`)
  if (plan.truncated) lines.push('已达到节点/边上限：结果被截断（继续追踪需要缩小 types 或 depth）。')
  if (degraded.length > 0) lines.push(`降级：${degraded.join('；')}`)
  return lines.join('\n')
}

/** 工具面渲染：逐字文本 + 溯源（与检索主路径同样的可审计性）。 */
export function renderRelate(result: RelateResult): string {
  const lines: string[] = [
    `关联扩展（omb_relate）：起点 ${result.startId}，depth=${result.depth}，types=[${result.types.join(', ')}]`,
    `节点 ${result.nodes.length} / 边 ${result.edges.length}${result.truncated ? '（已截断）' : ''}`,
  ]
  for (const node of result.nodes) {
    lines.push(
      `- [hop ${node.hop}] ${node.id} · ${node.scope}/${node.kind} · observedAt=${formatTime(node.observedAt)} · sourceRef=${node.sourceRef}` +
        (node.validTo !== null ? ` · ⚠️已被取代（supersededBy=${node.supersededBy ?? '未知'}）` : ''),
    )
    lines.push(`  ${node.text}`)
  }
  for (const edge of result.edges) {
    lines.push(`- ${edge.type}: ${edge.fromId} → ${edge.toId}`)
  }
  lines.push(result.why)
  return lines.join('\n')
}

export interface RelateToolDeps {
  /**
   * 解析当前可用的库。未就绪返回 undefined（不抛）——
   * 宿主/项目库可能尚未打开，工具必须能降级（热插拔契约）。
   */
  readonly resolveStores: () => readonly TaggedStore[] | undefined
  readonly limits?: WalkLimits
}

/** 参数 schema：`parse`（校验）+ `jsonSchema`（**模型看不到我们的校验器**，必须附原生 JSON Schema）。 */
interface ToolParameters extends ToolInputSchema {
  readonly jsonSchema: Record<string, unknown>
}

const RELATE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '记忆 id（可从 omb_recall 的溯源行里拿到）' },
    depth: { type: 'integer', enum: [1, 2], description: '跳数；默认 1，2 = 两跳' },
    types: {
      type: 'array',
      items: { type: 'string', enum: [...EDGE_TYPES] },
      description: '要跟的边类型；省略 = 三种全要',
    },
  },
  required: ['id'],
  additionalProperties: false,
}

/**
 * `omb_relate` 工具定义。**由 `dsh/` 注册**（模块不接触宿主）。
 *
 * 参数：`{ id, depth?: 1|2, types? }` → 返回 `{ nodes, edges, why }` 的可读文本。
 */
export function createRelateTool(deps: RelateToolDeps): ToolDefinition {
  const parameters: ToolParameters = {
    jsonSchema: RELATE_JSON_SCHEMA,
    parse(input: unknown): unknown {
      const parsed = parseRelateArgs(input)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.value
    },
  }
  return {
    name: RELATE_TOOL,
    description:
      '按需拉取与某条记忆**多跳相关**的其他记忆（类型化边：supersedes 时序更正 / ' +
      'conflicts_with 未裁决矛盾 / derived_from 派生来源）。默认检索路径不含图扩展——' +
      '只有当你确实需要"这条结论是被谁取代的""还有哪些观察与它冲突"时才调用。' +
      '参数：{ id, depth?: 1|2, types?: ["supersedes","conflicts_with","derived_from"] }。',
    parameters,
    async execute(args: unknown): Promise<ToolOutcome> {
      const parsed = parseRelateArgs(args)
      if (!parsed.ok) return { kind: 'error', text: `omb_relate 参数非法：${parsed.error}` }
      let stores: readonly TaggedStore[] | undefined
      try {
        stores = deps.resolveStores()
      } catch (err) {
        return { kind: 'error', text: `omb_relate 无法解析记忆库：${messageOf(err)}` }
      }
      if (stores === undefined || stores.length === 0) {
        return {
          kind: 'error',
          text: 'omb_relate 不可用：记忆服务未就绪（omb-memory-graph 需要 omb-memory 已挂载，或库尚未打开）。本轮请基于已有信息作答。',        }
      }
      const outcome = await walkGraph(stores, parsed.value, deps.limits ?? {})
      if (!outcome.ok) return { kind: 'error', text: `omb_relate 失败：${outcome.error}` }
      return { kind: 'text', text: renderRelate(outcome.result) }
    },
  }
}

/** 工具工厂（`ToolFactory` 契约：由 `dsh/` 在正确作用域调用）。 */
export function createRelateTools(deps: RelateToolDeps): readonly ToolDefinition[] {
  return [createRelateTool(deps)]
}

export const relateToolFactory: ToolFactory<RelateToolDeps> = { create: createRelateTools }

// ---------- 内部工具 ----------

function edgeKey(edge: Edge): string {
  return `${edge.fromId}=>${edge.toId}#${edge.type}`
}

function push(map: Map<string, Edge[]>, key: string, edge: Edge): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [edge])
  else list.push(edge)
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/** 库的确定序：作用域优先级 → 原序（同一输入永远同一结果）。 */
function orderStores(stores: readonly TaggedStore[]): readonly TaggedStore[] {
  return stores
    .map((store, index) => ({ store, index }))
    .sort((a, b) => {
      if (a.store.scope !== b.store.scope) return a.store.scope === 'user' ? -1 : 1
      return a.index - b.index
    })
    .map(entry => entry.store)
}

/** ID 的 ASCII 安全比较（**不用 `localeCompare`**）。 */
function asciiCompare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function formatTime(epochMs: number): string {
  return isoUtc(epochMs)
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}
