/**
 * 测试用 fake `MemoryStore` 端口（返回预设数据，**零 SQLite**）。
 *
 * 规划 §11.1：真实集成测试由 lead 在 e2e 层用临时 SQLite 做；
 * 检索逻辑本身只依赖端口，因此这里用 fake 就能把七个阶段与四个反例全部钉死。
 */
import { createHash } from 'node:crypto'
import type {
  Clock,
  Edge,
  EdgeType,
  Embedder,
  GraphQuery,
  GraphWalk,
  LexicalQuery,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  ScoredHit,
  StoreStats,
  VectorAttribution,
  VectorQuery,
} from '../../../kernel/abi/index.js'
import { SCHEMA_VERSION } from '../../../kernel/abi/index.js'
import type { TaggedStore } from '../../../kernel/abi/storage.js'
import type { RetrievalChannel } from '../../../modules/memory/retrieve.js'

export function contentHashOf(scope: MemoryScope, kind: MemoryKind, text: string): string {
  const normalized = `${scope}::${kind}::${text.trim().replace(/\s+/g, ' ')}`
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/** 造一条记忆；只写关心的字段，其余给确定性默认值。 */
export function makeRecord(overrides: Partial<MemoryRecord> & { readonly id: string }): MemoryRecord {
  const scope = overrides.scope ?? 'user'
  const kind = overrides.kind ?? 'semantic'
  const text = overrides.text ?? overrides.id
  return {
    id: overrides.id,
    scope,
    kind,
    text,
    contentHash: overrides.contentHash ?? contentHashOf(scope, kind, text),
    sourceRef: overrides.sourceRef ?? `session:${overrides.id}#t1`,
    assertedBy: overrides.assertedBy ?? 'model',
    observedAt: overrides.observedAt ?? 1_000,
    validTo: overrides.validTo ?? null,
    supersededBy: overrides.supersededBy ?? null,
    lastUsedAt: overrides.lastUsedAt ?? 0,
    useCount: overrides.useCount ?? 0,
    project: overrides.project ?? null,
  }
}

/** 简易双语分词（只服务 fake 的默认检索，不镜像 text.ts 的实现细节）。 */
function demoTokens(text: string): readonly string[] {
  return [...text.toLowerCase().matchAll(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu)].map(m => m[0])
}

export interface FakeStoreOptions {
  readonly scope: MemoryScope
  readonly records?: readonly MemoryRecord[]
  readonly edges?: readonly Edge[]
  /** 可归属向量（向量通道测试用）。 */
  readonly vectors?: readonly FakeVector[]
  /** 自定义词法检索；缺省按 token 重叠排序（并像真实实现一样排除已失效行）。 */
  readonly search?: (query: LexicalQuery) => readonly ScoredHit[]
  readonly failSearch?: string
  readonly failGetMany?: string
  readonly failWalk?: string
  readonly failForget?: string
  readonly failVector?: string
}

/** 一条可归属向量：三个归属标签必须齐备（规划 §5.7）。 */
export interface FakeVector {
  readonly id: string
  readonly attribution: VectorAttribution
  readonly vector: Float32Array
}

export interface FakeStoreCalls {
  searchLexical: number
  searchVector: number
  get: number
  getMany: number
  walkGraph: number
  forget: number
  put: number
  transaction: number
  stats: number
}

export interface FakeStore extends MemoryStore {
  readonly calls: FakeStoreCalls
  readonly searchQueries: readonly LexicalQuery[]
  readonly vectorQueries: readonly VectorQuery[]
  readonly getManyCalls: readonly (readonly string[])[]
  readonly getCalls: readonly string[]
  readonly forgetCalls: readonly (readonly string[])[]
  readonly putIds: readonly string[]
  putEdge(edge: Edge): void
}

/** 一个只读优先、可注入故障的假库。 */
export function fakeStore(options: FakeStoreOptions): FakeStore {
  const rows = new Map<string, MemoryRecord>()
  for (const record of options.records ?? []) rows.set(record.id, record)
  const edges: Edge[] = [...(options.edges ?? [])]
  const vectors: FakeVector[] = [...(options.vectors ?? [])]
  const calls: FakeStoreCalls = {
    searchLexical: 0,
    searchVector: 0,
    get: 0,
    getMany: 0,
    walkGraph: 0,
    forget: 0,
    put: 0,
    transaction: 0,
    stats: 0,
  }
  const searchQueries: LexicalQuery[] = []
  const vectorQueries: VectorQuery[] = []
  const getManyCalls: string[][] = []
  const getCalls: string[] = []
  const forgetCalls: string[][] = []
  const putIds: string[] = []

  const scope = options.scope
  const fail = (message: string | undefined): void => {
    if (message !== undefined) throw new Error(message)
  }

  const defaultSearch = (query: LexicalQuery): readonly ScoredHit[] => {
    const wanted = new Set(demoTokens(query.text))
    const scored: { id: string; score: number }[] = []
    for (const record of rows.values()) {
      if (record.scope !== query.scope) continue
      // 与真实契约一致：默认排除已失效（被取代）的行。
      if (record.validTo !== null) continue
      if (query.kinds !== undefined && !query.kinds.includes(record.kind)) continue
      let matched = 0
      for (const token of demoTokens(record.text)) if (wanted.has(token)) matched += 1
      if (matched > 0) scored.push({ id: record.id, score: matched })
    }
    scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.id < b.id ? -1 : 1))
    return scored.slice(0, query.limit).map(s => ({ id: s.id, score: s.score, channel: 'lexical' }))
  }

  const store: FakeStore = {
    scope,
    calls,
    searchQueries,
    vectorQueries,
    getManyCalls,
    getCalls,
    forgetCalls,
    putIds,
    putEdge(edge: Edge): void {
      edges.push(edge)
    },
    async put(record: MemoryRecord): Promise<void> {
      calls.put += 1
      putIds.push(record.id)
      rows.set(record.id, record)
    },
    async get(id: string): Promise<MemoryRecord | undefined> {
      calls.get += 1
      getCalls.push(id)
      return rows.get(id)
    },
    async getMany(ids: readonly string[]): Promise<readonly MemoryRecord[]> {
      calls.getMany += 1
      getManyCalls.push([...ids])
      fail(options.failGetMany)
      const out: MemoryRecord[] = []
      for (const id of ids) {
        const record = rows.get(id)
        if (record !== undefined) out.push(record)
      }
      return out
    },
    async searchLexical(query: LexicalQuery): Promise<readonly ScoredHit[]> {
      calls.searchLexical += 1
      searchQueries.push(query)
      fail(options.failSearch)
      return options.search !== undefined ? options.search(query) : defaultSearch(query)
    },
    async searchVector(query: VectorQuery): Promise<readonly ScoredHit[]> {
      calls.searchVector += 1
      vectorQueries.push(query)
      fail(options.failVector)
      const scored: ScoredHit[] = []
      for (const row of vectors) {
        // 归属必须三者齐备且一致（模拟 SQL 侧下推过滤）。
        if (row.attribution.modelId !== query.expect.modelId) continue
        if (row.attribution.dim !== query.expect.dim) continue
        if (row.attribution.revision !== query.expect.revision) continue
        const record = rows.get(row.id)
        if (record === undefined || record.validTo !== null) continue
        if (query.kinds !== undefined && !query.kinds.includes(record.kind)) continue
        const score = cosine(query.embedding, row.vector)
        if (query.minScore !== undefined && score < query.minScore) continue
        scored.push({ id: row.id, score, channel: 'vector' })
      }
      scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.id < b.id ? -1 : 1))
      return scored.slice(0, query.limit)
    },
    async upsertEdge(edge: Edge): Promise<void> {
      edges.push(edge)
    },
    async walkGraph(query: GraphQuery): Promise<GraphWalk> {
      calls.walkGraph += 1
      fail(options.failWalk)
      return walkEdges(query, edges, rows)
    },
    async forget(ids: readonly string[]): Promise<number> {
      calls.forget += 1
      forgetCalls.push([...ids])
      fail(options.failForget)
      let removed = 0
      for (const id of ids) if (rows.delete(id)) removed += 1
      return removed
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      calls.transaction += 1
      return fn()
    },
    async stats(): Promise<StoreStats> {
      calls.stats += 1
      return { scope, rows: rows.size, schemaVersion: SCHEMA_VERSION, vectors: null }
    },
    async close(): Promise<void> {
      // 无资源
    },
  }
  return store
}

/** 无向 BFS（与 store-dev 声明的 `walkGraph` 语义一致：两个方向都跟）。 */
function walkEdges(
  query: GraphQuery,
  edges: readonly Edge[],
  rows: ReadonlyMap<string, MemoryRecord>,
): GraphWalk {
  const allowed = new Set<EdgeType>(query.types ?? ['supersedes', 'conflicts_with', 'derived_from'])
  const depth = Math.max(0, Math.min(3, Math.floor(query.depth)))
  const visited = new Set<string>([query.fromId])
  const usedEdges: Edge[] = []
  const usedEdgeKeys = new Set<string>()
  let frontier: string[] = rows.has(query.fromId) ? [query.fromId] : []
  for (let hop = 1; hop <= depth; hop += 1) {
    const next: string[] = []
    for (const node of frontier) {
      for (const edge of edges) {
        if (!allowed.has(edge.type)) continue
        if (edge.fromId !== node && edge.toId !== node) continue
        const key = `${edge.fromId}::${edge.toId}::${edge.type}`
        if (!usedEdgeKeys.has(key)) {
          usedEdgeKeys.add(key)
          usedEdges.push(edge)
        }
        const other = edge.fromId === node ? edge.toId : edge.fromId
        if (visited.has(other)) continue
        visited.add(other)
        next.push(other)
      }
    }
    frontier = next
  }
  const nodes: MemoryRecord[] = []
  for (const id of visited) {
    const record = rows.get(id)
    if (record !== undefined) nodes.push(record)
  }
  return { nodes, edges: usedEdges }
}

export function tagged(store: MemoryStore, scope?: MemoryScope): TaggedStore {
  return { scope: scope ?? store.scope, store }
}

export function clockAt(now: number): Clock {
  return { now: () => now }
}

export function failingEmbedder(message = 'onnx 缺失'): Embedder {
  return {
    id: 'fake-failing',
    dimensions: 8,
    revision: 'r1',
    embed(): Promise<readonly Float32Array[]> {
      return Promise.reject(new Error(message))
    },
  }
}

/** 记录调用次数的嵌入器。 */
export function countingEmbedder(dim = 4): Embedder & { readonly calls: number } {
  const state = { calls: 0 }
  return {
    id: 'fake-bow',
    dimensions: dim,
    revision: 'r1',
    get calls(): number {
      return state.calls
    },
    embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
      state.calls += 1
      return Promise.resolve(
        texts.map(() => {
          const vector = new Float32Array(dim)
          for (let i = 0; i < dim; i += 1) vector[i] = 1 / dim
          return vector
        }),
      )
    },
  }
}

export function hits(
  ids: readonly string[],
  base = 100,
  channel: ScoredHit['channel'] = 'lexical',
): readonly ScoredHit[] {
  return ids.map((id, index) => ({ id, score: base - index, channel }))
}

/** 余弦相似度（零向量 → 0）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 固定向量的嵌入器（向量通道测试用）。 */
export function fixedEmbedder(vector: readonly number[], id = 'fake-fixed', revision = 'r1'): Embedder {
  const frozen = Float32Array.from(vector)
  return {
    id,
    dimensions: frozen.length,
    revision,
    embed: () => Promise.resolve([frozen]),
  }
}

/**
 * 第二通道的**测试替身**：形状与生产实现完全一致。
 *
 * 生产实例在 `modules/memory/vector.ts`（embed-dev 提供，持有嵌入器与标定常量）；
 * 这里只把嵌入器算出的查询向量交给端口 `searchVector` —— 归属过滤与存取在存储层，
 * 通道自己不读向量表（规划 §5.7 的分工：`RetrievalChannel` 是 `searchVector` 的适配层）。
 */
export function vectorChannelOf(
  embedder: Embedder,
  options: { readonly minScore?: number } = {},
): RetrievalChannel {
  return {
    name: 'vector',
    async search(query) {
      if (query.embedding === undefined) return []
      return query.store.store.searchVector({
        embedding: query.embedding,
        expect: { modelId: embedder.id, dim: embedder.dimensions, revision: embedder.revision },
        ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
        limit: query.limit,
        ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
      })
    },
  }
}
