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
  /**
   * 可选标签（v4.10.0）：用户/模型写入时打的结构化标记。
   * 检索可按标签过滤；旧条目没有标签时缺省（读库时归一为 `[]`）。
   */
  readonly tags?: readonly string[]
}

/** 记忆状态过滤（v4.10.0）：检索默认只看活跃条目，可显式放开。 */
export type MemoryStatusFilter = 'active' | 'stale' | 'superseded' | 'all'

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
  readonly channel: 'lexical' | 'vector' | 'graph' | 'fuzzy'
}

/** 词法检索请求。 */
export interface LexicalQuery {
  readonly text: string
  readonly scope: MemoryScope
  readonly kinds?: readonly MemoryKind[]
  /** 状态过滤；缺省 = 只看活跃（`valid_to` 与 `superseded_by` 均为空）。 */
  readonly status?: MemoryStatusFilter
  /** 标签过滤；多个标签是 **AND**（同一条要同时带这些标签）。 */
  readonly tags?: readonly string[]
  readonly limit: number
}

/** 子串回退检索（v4.10.0）：FTS 0 命中时用 `LIKE` 找部分匹配，有界、只读。 */
export interface FuzzyQuery {
  readonly text: string
  readonly scope: MemoryScope
  readonly kinds?: readonly MemoryKind[]
  readonly status?: MemoryStatusFilter
  readonly tags?: readonly string[]
  readonly limit: number
}

/** 向量的归属标签。三者齐备才允许参与距离计算。 */
export interface VectorAttribution {
  readonly modelId: string
  readonly dim: number
  readonly revision: string
}

/** 向量检索请求。 */
export interface VectorQuery {
  readonly embedding: Float32Array
  /** 期望归属；与库内不符的行被排除。 */
  readonly expect: VectorAttribution
  readonly kinds?: readonly MemoryKind[]
  /** 状态过滤；缺省 = 只看活跃。 */
  readonly status?: MemoryStatusFilter
  /** 标签过滤；多个标签是 AND。 */
  readonly tags?: readonly string[]
  readonly limit: number
  /** 低于该余弦值的候选被丢弃（由调用方按模型标定，见 `searchVector` 的说明）。 */
  readonly minScore?: number
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
  /**
   * 写入一条记忆。**按 `id` 是 upsert（覆盖写），不是 INSERT-only。**
   * 画像等"确定性 id 的单文档"依赖这个语义。
   */
  put(record: MemoryRecord): Promise<void>
  get(id: string): Promise<MemoryRecord | undefined>
  /** **必须批量**——禁止 N+1（旧实现每 id 一次 SELECT）。 */
  getMany(ids: readonly string[]): Promise<readonly MemoryRecord[]>
  searchLexical(query: LexicalQuery): Promise<readonly ScoredHit[]>
  /**
   * 子串回退检索（v4.10.0，**可选**）。
   *
   * 只在词法通道 0 命中时由检索侧调用：FTS 是 bigram 索引，写错一个字/拆词方式
   * 不同就会 0 命中；这里用 `LIKE` 做**有界**的部分匹配兜底。实现方必须：
   * 只读、限定 `limit`、遵守与词法通道相同的状态/类型/标签过滤。
   * 老实现没有这个方法时检索侧跳过（不假装支持）。
   */
  searchFuzzy?(query: FuzzyQuery): Promise<readonly ScoredHit[]>
  /**
   * 向量检索。
   *
   * **为什么在 `MemoryStore` 上而不是独立服务**：向量行就在这个库里，
   * 归属过滤（`modelId`/`dim`/`revision`）必须下推到 SQL——否则要先把整表
   * 读进 JS 再逐行比对，那正是旧实现"读全部向量再打分"的性能缺陷。
   *
   * 检索侧的 `RetrievalChannel`（见 `modules/memory/retrieve.ts`）只是本方法的适配层：
   * 它负责余弦与排名语义，本方法负责存取与归属过滤。
   *
   * @param query.embedding 查询向量（由 `Embedder` 算出，检索侧传入）。
   * @param query.expect 期望归属；与库内不符的行**不参与**（宁可少召回也不要跨空间比距离）。
   * @param query.minScore 提前截断阈值。稠密模型的余弦恒为正，因此"非正才丢"
   *   会让任何查询都返回满额候选池、把排序压平——检索侧应显式给出标定过的下限。
   */
  searchVector(query: VectorQuery): Promise<readonly ScoredHit[]>
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
