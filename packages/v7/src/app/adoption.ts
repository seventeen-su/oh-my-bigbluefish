import type {
  AdoptionReceiptDisposition,
  AdoptionReceiptHit,
  AdoptionReceiptHitInput,
  AdoptionReceiptInput,
  ResidentTraceInput,
  ResidentTraceSection,
} from '../ports/observability.js'

/**
 * 采用证据的纯判定层：把一次注入的 receipt 归一化成逐实体处置。
 *
 * 首选来源是 `InjectionReceipt.entities`（T0/T1 逐实体 receipt）：
 * - `state='kept'`：实体原文真的进入注入文本，计入 Retrieved、可参与采用；
 * - `state='quarantined'`：只注入了隔离说明，不能进入 Retrieved/引用/验证；
 * - **没有条目的实体就是未展示**（预算丢弃/截断不可见/块没进），不写任何行。
 *
 * 兼容旧 receipt（没有 `entities`）：T1 退回块级 keptIds/quarantinedIds/droppedIds，
 * T0 退回 sections 的 kept/quarantined/entityIds。这条路径只用于升级前的历史数据。
 *
 * 本模块只依赖 ports 的类型，不读宿主、不查库，可单测。
 */

/** 逐实体 receipt 的状态；没有第三态，未展示的实体直接没有条目。 */
export type ReceiptEntityState = 'kept' | 'quarantined'

/** 与 `prompt/assembler.ts` 的 `EntityReceipt` 结构兼容的窄类型（不 import recall 层）。 */
export interface ReceiptEntity {
  readonly entityId: string
  readonly state: ReceiptEntityState
  readonly section?: string
  readonly blockId?: string
  readonly title?: string
  readonly updatedAt?: string
}

/**
 * 读取 receipt JSON 里的 `entities`。
 *
 * 返回 `undefined` 表示旧 receipt 没有这个字段（调用方退回块级 fallback）；返回 `[]`
 * 表示字段存在但本次没有可记账实体。同一实体只保留一条，`kept` 优先；防御性地丢弃
 * 非法条目，绝不把未知 state 当成 kept。
 */
export function entityReceiptsOf(value: unknown): ReceiptEntity[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entities = (value as Record<string, unknown>)['entities']
  if (entities === undefined) return undefined
  if (!Array.isArray(entities)) return []
  const byId = new Map<string, ReceiptEntity>()
  for (const item of entities) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const entityId = typeof record['entityId'] === 'string' ? record['entityId'].trim() : ''
    if (entityId.length === 0) continue
    const rawState = record['state']
    if (rawState !== 'kept' && rawState !== 'quarantined') continue
    const state: ReceiptEntityState = rawState
    const previous = byId.get(entityId)
    // kept 优先；同状态保留先出现的条目。
    if (previous !== undefined && (previous.state === 'kept' || state === 'quarantined')) continue
    byId.set(entityId, {
      entityId,
      state,
      ...(typeof record['section'] === 'string' && record['section'].length > 0
        ? { section: record['section'] }
        : {}),
      ...(typeof record['blockId'] === 'string' && record['blockId'].length > 0
        ? { blockId: record['blockId'] }
        : {}),
      ...(typeof record['title'] === 'string' && record['title'].trim().length > 0
        ? { title: record['title'] }
        : {}),
      ...(typeof record['updatedAt'] === 'string' && record['updatedAt'].length > 0
        ? { updatedAt: record['updatedAt'] }
        : {}),
    })
  }
  return [...byId.values()]
}

/**
 * `entities` → 采用 receipt 的字段：kept/quarantined 逐实体记账，未展示不记。
 * `hits` 只用于带标题/更新时间与稳定排序，不改变处置。
 */
export function adoptionFieldsFromEntities(entities: readonly ReceiptEntity[]): {
  readonly keptIds: readonly string[]
  readonly quarantinedIds: readonly string[]
  readonly droppedIds: readonly string[]
  readonly hits: readonly AdoptionReceiptHitInput[]
} {
  const kept = entities.filter(entity => entity.state === 'kept')
  const quarantined = entities.filter(entity => entity.state === 'quarantined')
  return {
    keptIds: kept.map(entity => entity.entityId),
    quarantinedIds: quarantined.map(entity => entity.entityId),
    droppedIds: [],
    hits: [...kept, ...quarantined].map((entity, index) => ({
      entityId: entity.entityId,
      ...(entity.title === undefined ? {} : { title: entity.title }),
      ...(entity.updatedAt === undefined ? {} : { updatedAt: entity.updatedAt }),
      rank: index + 1,
    })),
  }
}

function trimmedIds(ids: readonly string[] | undefined): string[] {
  if (ids === undefined) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * 一次 receipt 的逐实体处置。
 *
 * 输出顺序：`hits` 中出现的实体按入参顺序在前（保证调用方的候选顺序稳定），
 * 其余只出现在 kept/quarantined/dropped 集合里的实体按集合顺序追加。
 */
export function adoptionReceiptHits(input: AdoptionReceiptInput): AdoptionReceiptHit[] {
  const quarantined = new Set(trimmedIds(input.quarantinedIds))
  const dropped = new Set(trimmedIds(input.droppedIds))
  const kept = new Set(trimmedIds(input.keptIds))
  const hits: readonly AdoptionReceiptHitInput[] = input.hits ?? []
  const entities: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (id.length === 0 || seen.has(id)) return
    seen.add(id)
    entities.push(id)
  }
  for (const hit of hits) push(hit.entityId.trim())
  for (const id of kept) push(id)
  for (const id of quarantined) push(id)
  for (const id of dropped) push(id)

  const meta = new Map<string, AdoptionReceiptHitInput>()
  for (const hit of hits) {
    const id = hit.entityId.trim()
    if (id.length === 0 || meta.has(id)) continue
    meta.set(id, hit)
  }

  return entities.map(entityId => {
    const hit = meta.get(entityId)
    // quarantined 优先：keptIds 里的隔离块不是可用内容；显式 dropped 覆盖 hits 的默认 kept。
    const disposition: AdoptionReceiptDisposition = quarantined.has(entityId)
      ? 'quarantined'
      : dropped.has(entityId)
        ? 'dropped'
        : kept.has(entityId) || hit !== undefined
          ? 'kept'
          : 'dropped'
    return {
      entityId,
      disposition,
      ...(hit?.title === undefined ? {} : { title: hit.title }),
      ...(hit?.updatedAt === undefined ? {} : { updatedAt: hit.updatedAt }),
      ...(hit?.rank === undefined ? {} : { rank: hit.rank }),
    }
  })
}

/** 只有 kept 的命中可以被登记为使用机会/引用候选。 */
export function receiptKeptHits(input: AdoptionReceiptInput): AdoptionReceiptHit[] {
  return adoptionReceiptHits(input).filter(hit => hit.disposition === 'kept')
}

interface EmbeddedInjectionReceipt {
  readonly injected?: boolean
  readonly budgetTokens?: number
  readonly usedTokens?: number
  readonly textHash?: string
  readonly keptIds: readonly string[]
  readonly quarantinedIds: readonly string[]
  readonly droppedIds: readonly string[]
  /** 新契约字段；`undefined` 表示旧 receipt（没有逐实体证据）。 */
  readonly entities?: readonly ReceiptEntity[]
}

function parseEmbeddedReceipt(text: string | undefined): EmbeddedInjectionReceipt | undefined {
  if (text === undefined || !text.trimStart().startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const ids = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const entities = entityReceiptsOf(record)
  return {
    ...(typeof record['injected'] === 'boolean' ? { injected: record['injected'] } : {}),
    ...(typeof record['budgetTokens'] === 'number' ? { budgetTokens: record['budgetTokens'] } : {}),
    ...(typeof record['usedTokens'] === 'number' ? { usedTokens: record['usedTokens'] } : {}),
    ...(typeof record['textHash'] === 'string' ? { textHash: record['textHash'] } : {}),
    keptIds: ids(record['keptIds']),
    quarantinedIds: ids(record['quarantinedIds']),
    droppedIds: ids(record['droppedIds']),
    ...(entities === undefined ? {} : { entities }),
  }
}

/** trace sections 在运行时可能带装配器附加字段（source/fallbackReason/quarantined）。 */
function sectionFlag(section: ResidentTraceSection, name: 'quarantined' | 'truncated'): boolean {
  const value = (section as unknown as Record<string, unknown>)[name]
  return value === true
}

/** T0 里不承载“注入命中”的 section：头、索引、静态提示、以及重复的 receipt 汇总。 */
const NON_HIT_SECTIONS = new Set(['header', 'index', 'tool-hint', 'injection-receipt'])

/**
 * 从已落库的 T0/T1 trace 反推 receipt。
 *
 * 唯一权威来源是 `injection-receipt` section 的 JSON `entities`（T0/T1 共用）：
 * kept 记账、quarantined 只留审计、没有条目的实体不记。旧 receipt（升级前写入）
 * 没有 `entities`，才退回块级 keptIds/quarantinedIds/droppedIds（T1）或 sections
 * 的 kept/quarantined/entityIds（T0）。
 */
export function adoptionReceiptFromResidentTrace(trace: ResidentTraceInput): AdoptionReceiptInput {
  const sections = trace.sections
  const first = sections[0]
  const receiptSection = sections.find(section => section.name === 'injection-receipt')
  const embedded = receiptSection === undefined ? undefined : parseEmbeddedReceipt(receiptSection.text)
  const t1Trace = sections.length === 1 && first?.name === 'injection-receipt'
  const common = {
    traceId: trace.traceId,
    ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
    ...(trace.turnId === undefined ? {} : { turnId: trace.turnId }),
    budgetTokens: embedded?.budgetTokens ?? trace.budgetTokens,
    usedTokens: embedded?.usedTokens ?? trace.usedTokens,
    injected: embedded?.injected ?? receiptSection?.kept ?? first?.kept ?? false,
    ...(embedded?.textHash === undefined ? {} : { textHash: embedded.textHash }),
    text: trace.text,
    source: 'resident-trace' as const,
  }

  // 新契约：逐实体 evidence 是唯一来源；未展示实体没有条目，不写 dropped。
  if (embedded?.entities !== undefined) {
    return {
      ...common,
      kind: t1Trace ? 't1' : 't0',
      ...adoptionFieldsFromEntities(embedded.entities),
    }
  }

  // --- 旧 receipt fallback（升级前已落库的数据）--------------------------------
  if (t1Trace && first !== undefined) {
    return {
      ...common,
      kind: 't1',
      keptIds: embedded?.keptIds ?? first.entityIds,
      quarantinedIds: embedded?.quarantinedIds ?? [],
      droppedIds: embedded?.droppedIds ?? [],
    }
  }

  // rank 越大越“可见”：kept > quarantined > dropped。
  const rank = new Map<string, number>()
  const mark = (entityId: string, value: number): void => {
    const id = entityId.trim()
    if (id.length === 0) return
    const previous = rank.get(id) ?? 0
    if (value > previous) rank.set(id, value)
  }
  for (const section of sections) {
    if (NON_HIT_SECTIONS.has(section.name) || section.entityIds.length === 0) continue
    const value = sectionFlag(section, 'quarantined') ? 2 : section.kept ? 3 : 1
    for (const entityId of section.entityIds) mark(entityId, value)
  }
  const kept: string[] = []
  const quarantined: string[] = []
  const dropped: string[] = []
  for (const [entityId, value] of rank) {
    if (value === 3) kept.push(entityId)
    else if (value === 2) quarantined.push(entityId)
    else dropped.push(entityId)
  }
  return {
    ...common,
    kind: 't0',
    injected: kept.length > 0,
    keptIds: kept,
    quarantinedIds: quarantined,
    droppedIds: dropped,
  }
}
