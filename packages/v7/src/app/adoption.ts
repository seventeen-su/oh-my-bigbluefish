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
 * 规则（与 019_adoption_receipts.sql 对齐）：
 * - `quarantined` 优先于 `kept`：装配器的 keptIds 也包含“kept 但原文被隔离”的块，
 *   这类命中只看见了隔离说明，不能进入 Retrieved/引用/验证；
 * - 未列在三个集合里的命中：如果调用方在 `hits` 里显式给了（T0/T2 的可见命中），
 *   按 `kept` 处理；否则丢弃；
 * - quarantine/dropped 仍然写 receipt 行（审计“为什么没升”），但不产生使用机会。
 *
 * 本模块只依赖 ports 的类型，不读宿主、不查库，可单测。
 */

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
  return {
    ...(typeof record['injected'] === 'boolean' ? { injected: record['injected'] } : {}),
    ...(typeof record['budgetTokens'] === 'number' ? { budgetTokens: record['budgetTokens'] } : {}),
    ...(typeof record['usedTokens'] === 'number' ? { usedTokens: record['usedTokens'] } : {}),
    ...(typeof record['textHash'] === 'string' ? { textHash: record['textHash'] } : {}),
    keptIds: ids(record['keptIds']),
    quarantinedIds: ids(record['quarantinedIds']),
    droppedIds: ids(record['droppedIds']),
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
 * 这是现有 `resident_trace.sections` 约定的兼容路径：
 * - T1 行只有一个 `injection-receipt` section，text 是 `InjectionReceipt` JSON；
 * - T0 行按每个数据 section 的 kept/quarantined 与 entityIds 判定；
 *   同一实体被多个 section 命中时，只要有一处真的展示了原文就算 kept（quarantined 只在
 *   所有出现处都被隔离时才成立，dropped 只在完全没展示时成立）。
 */
export function adoptionReceiptFromResidentTrace(trace: ResidentTraceInput): AdoptionReceiptInput {
  const sections = trace.sections
  const first = sections[0]
  const t1 = sections.length === 1 && first?.name === 'injection-receipt'
  if (t1 && first !== undefined) {
    const embedded = parseEmbeddedReceipt(first.text)
    return {
      traceId: trace.traceId,
      kind: 't1',
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      ...(trace.turnId === undefined ? {} : { turnId: trace.turnId }),
      budgetTokens: trace.budgetTokens,
      usedTokens: trace.usedTokens,
      injected: embedded?.injected ?? first.kept,
      ...(embedded?.textHash === undefined ? {} : { textHash: embedded.textHash }),
      text: trace.text,
      keptIds: embedded?.keptIds ?? first.entityIds,
      quarantinedIds: embedded?.quarantinedIds ?? [],
      droppedIds: embedded?.droppedIds ?? [],
      source: 'resident-trace',
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
    traceId: trace.traceId,
    kind: 't0',
    ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
    ...(trace.turnId === undefined ? {} : { turnId: trace.turnId }),
    budgetTokens: trace.budgetTokens,
    usedTokens: trace.usedTokens,
    injected: kept.length > 0,
    text: trace.text,
    keptIds: kept,
    quarantinedIds: quarantined,
    droppedIds: dropped,
    source: 'resident-trace',
  }
}
