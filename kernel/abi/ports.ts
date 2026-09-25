/**
 * 内核端口（port）。纯类型，运行时零耦合。
 *
 * 模块只依赖这些接口；`modules/*` 的实现由 `dsh/` 注入。
 * 因此 `kernel/` 与 `modules/` 都不需要 import `@deepseek-ai/*`，
 * 也不需要 mock 宿主即可测试。
 */
import type { AssertedBy, EdgeType, MemoryKind, MemoryScope, PressureBand } from './kinds.js'

/** 一条记忆。字段依据见规划 §5.2——每个字段都为某个决策服务。 */
export interface MemoryRecord {
  readonly id: string
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  /** 逐字原文。**不做抽取式结构化**：受控消融显示逐字块胜过有损的 artifact 抽取。 */
  readonly text: string
  /** 内容哈希：O(1) 精确去重，也是廉价的"回响检测"（同哈希 = 同源）。 */
  readonly contentHash: string
  /** 非空来源引用（会话/轮次/文件/命令）。投毒防御与证据独立的必要条件。 */
  readonly sourceRef: string
  readonly assertedBy: AssertedBy
  /** 事件时间（不是写入时间）。 */
  readonly observedAt: number
  /** 失效时间；**在检测到矛盾之前永远为 null**——没有东西知道事实何时停止为真。 */
  readonly validTo: number | null
  /** 被哪条记忆取代；非破坏性更正，使"我当时相信什么"可回答。 */
  readonly supersededBy: string | null
  readonly lastUsedAt: number
  readonly useCount: number
  /** 来源项目；跨项目库中作为溯源保留，**不作为检索过滤条件**。 */
  readonly project: string | null
}

/** 一条边。 */
export interface Edge {
  readonly fromId: string
  readonly toId: string
  readonly type: EdgeType
  readonly createdAt: number
}

/** 检索命中的一条，带分数与来源通道（供融合与审计）。 */
export interface ScoredHit {
  readonly id: string
  /** 通道原始分。**不同通道的分不可比较**——融合只允许按排名（RRF）。 */
  readonly score: number
  readonly channel: 'lexical' | 'vector' | 'graph'
}

/** 词法检索请求。 */
export interface LexicalQuery {
  readonly text: string
  readonly scope: MemoryScope
  readonly kinds?: readonly MemoryKind[]
  readonly limit: number
}

/** 图谱遍历请求。 */
export interface GraphQuery {
  readonly fromId: string
  readonly depth: number
  readonly types?: readonly EdgeType[]
}

/** 图谱遍历结果。 */
export interface GraphWalk {
  readonly nodes: readonly MemoryRecord[]
  readonly edges: readonly Edge[]
}

/** 存储统计（状态面与自调使用）。 */
export interface StoreStats {
  readonly scope: MemoryScope
  readonly rows: number
  readonly schemaVersion: number
  /** 向量行数与维度；无向量通道时为 null。 */
  readonly vectors: { readonly rows: number; readonly dim: number; readonly modelId: string } | null
}

/**
 * 单个存储库的端口。`kernel/` 的实现方（`modules/memory`）只依赖这个接口，
 * 因此双库 = 两个实现实例，检索逻辑接收 `readonly TaggedStore[]`。
 */
export interface MemoryStore {
  readonly scope: MemoryScope
  put(record: MemoryRecord): Promise<void>
  get(id: string): Promise<MemoryRecord | undefined>
  /** **必须批量**——禁止 N+1（旧实现每 id 一次 SELECT）。 */
  getMany(ids: readonly string[]): Promise<readonly MemoryRecord[]>
  searchLexical(query: LexicalQuery): Promise<readonly ScoredHit[]>
  upsertEdge(edge: Edge): Promise<void>
  walkGraph(query: GraphQuery): Promise<GraphWalk>
  /**
   * 显式删除。
   *
   * **这是唯一的硬删除路径**，只用于两种情形：
   * ① 用户显式遗忘（隐私）② 保留策略清理过期记录。
   *
   * 常规的"衰减"**不走这里**——衰减是重新计算排序先验，不是改数据
   * （见规划 §5.6）。误用会让"我当时相信什么"无法回答。
   * @returns 实际删除的行数。
   */
  forget(ids: readonly string[]): Promise<number>
  /** 单库事务。实现方保证 `BEGIN IMMEDIATE` + 串行化。 */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  stats(): Promise<StoreStats>
  close(): Promise<void>
}

/** 嵌入器端口。`id` 与 `dimensions` 是向量的归属标签，必须随向量一起持久化。 */
export interface Embedder {
  /** 稳定标识，如 `hash-bow-256` / `bge-small-zh-v1.5-512`。 */
  readonly id: string
  readonly dimensions: number
  /** 模型修订号；换模型时用于判定哪些向量已陈旧。 */
  readonly revision: string
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>
}

export interface Clock {
  now(): number
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
}

/** 宿主度量桥返回的上下文压力。**软信号，不是上限。** */
export interface ContextPressure {
  readonly totalTokens: number
  /** 已用 / 该路由可用窗口；宿主未声明窗口时为 null。 */
  readonly fillRatio: number | null
  readonly band: PressureBand
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** 逐节点 token 价格：知道上下文里每一块花了多少，供裁决 "值不值"。 */
  readonly nodes: readonly ContextNodeCost[]
}

export interface ContextNodeCost {
  readonly name: string
  readonly tokens: number
}

/** 推理深度状态（由 `omb_focus` 设置，按会话保存）。 */
export interface FocusState {
  readonly depth: import('./kinds.js').FocusDepth
  /** 设定理由，供审计。 */
  readonly reason: string
  readonly setAt: number
}
