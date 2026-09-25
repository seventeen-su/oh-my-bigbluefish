/**
 * 用户画像的纯逻辑：条目模型 · 冲突消解 · 文档编解码。
 *
 * 依据（规划 §5.8 用户画像 / §4.3 R8 冲突只呈现 / 决策 D4）：
 *
 * ① **只存显式陈述 + 用户可编辑**的内容；推断条目是低等级来源，不是"另一票"。
 * ② **显式与推断不是权重差别，而是来源等级差别**——权重会被聚合投票压过去，
 *    等级不会被压过去。因此这里的规则是结构性的，而不是打分：
 *    - 同键已有显式声明时，推断**进不来**（`inferred-blocked-by-declared`）；
 *    - 新的显式声明把同键的旧推断**整个替换**，不做加权平均（`declared-overrides-inferred`）。
 * ③ **冲突只呈现不裁决**（R8）：同键同等级的两个不同取值**都保留**，
 *    由 `listConflicts()` 检出、`renderConflicts()` 呈现。用户会自相矛盾，
 *    静默选一个是更坏的行为——所以这里没有"选一个"的分支。
 * ④ 能力轴（D4）的条目在这里可以构造、可以参与冲突消解，但**永不落盘**：
 *    落盘边界在 `storage.ts`（结构性拒绝），会话内驻留在 `capability.ts`。
 *    理由：错误成本不对称（高估用户会产生自信的错误帮助）；能力估计在心理测量学里
 *    成熟，但在智能体记忆里**未被迁移、未被评估**；"生活/陪伴"场景里给用户能力打分明确有害。
 *
 * 本文件零 I/O、零依赖、无时钟：所有函数都是纯函数，可在零 mock 下测试。
 */

/** 画像轴。`capability` 是唯一**永不落盘**的轴（D4）。 */
export type ProfileAxis = 'stable' | 'capability' | 'intent' | 'collaboration'

export const PROFILE_AXES: readonly ProfileAxis[] = ['stable', 'capability', 'intent', 'collaboration']

/** 来源等级。**等级不是权重**：等级不会被聚合投票压过去（§5.8）。 */
export type ProfileProvenance = 'declared' | 'inferred'

export const PROFILE_PROVENANCES: readonly ProfileProvenance[] = ['declared', 'inferred']

export interface ProfileEntry {
  readonly axis: ProfileAxis
  readonly key: string
  /** 取值逐字保留（§5.2 逐字优先于抽取）：不改写用户原话，也不做结构化抽取。 */
  readonly value: string
  readonly provenance: ProfileProvenance
  /** 证据引用（会话/轮次/文件/命令）。可核对，代替未校准的标量置信度。 */
  readonly evidence: readonly string[]
  readonly updated: number
}

/** 一次冲突消解的结果。`outcome` 让"被拒绝"也是可审计的，而不是静默丢弃。 */
export type ProfileOutcome =
  | 'added'
  | 'merged'
  | 'conflict'
  | 'declared-overrides-inferred'
  | 'inferred-blocked-by-declared'

export interface ProfileResolution {
  readonly entries: readonly ProfileEntry[]
  readonly outcome: ProfileOutcome
}

/** 一组未裁决的冲突：同轴同键、取值互相矛盾。 */
export interface ProfileConflict {
  readonly axis: ProfileAxis
  readonly key: string
  /** 互相矛盾的取值，按 updated 降序（最近看到的先呈现）；同一取值只留最近一条。 */
  readonly values: readonly ProfileEntry[]
}

const AXIS_LABELS: Readonly<Record<ProfileAxis, string>> = {
  stable: '稳定偏好',
  capability: '能力（仅当前会话）',
  intent: '当前意图',
  collaboration: '协作方式',
}

export function axisLabel(axis: ProfileAxis): string {
  return AXIS_LABELS[axis]
}

/** 同轴同键 = 同一个"槽位"。 */
export function sameKey(a: ProfileEntry, b: ProfileEntry): boolean {
  return a.axis === b.axis && a.key.trim() === b.key.trim()
}

function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function unionEvidence(a: readonly string[], b: readonly string[]): readonly string[] {
  return dedupe([...a, ...b])
}

/** 规范化：key 去空白；value **逐字保留**；evidence 去重去空；updated 非法时归零。 */
export function normalizeEntry(entry: ProfileEntry): ProfileEntry {
  return {
    axis: entry.axis,
    key: entry.key.trim(),
    value: entry.value,
    provenance: entry.provenance,
    evidence: dedupe(entry.evidence),
    updated: Number.isFinite(entry.updated) ? entry.updated : 0,
  }
}

/** 同键同值的合并：只并证据与时间，不产生第二条。 */
function mergeInto(base: ProfileEntry, incoming: ProfileEntry): ProfileEntry {
  return {
    ...base,
    evidence: unionEvidence(base.evidence, incoming.evidence),
    updated: Math.max(base.updated, incoming.updated),
  }
}

/**
 * 把一条新条目并入既有条目集合。
 *
 * 规则（顺序即优先级，全部是结构性的而非加权的）：
 * 1. 同键没有既有条目 → 新增
 * 2. 新条目是推断、同键已有显式 → **拒绝**（推断结构上无法覆盖显式）
 * 3. 新条目是显式、同键存在推断 → 旧推断整条移除，显式进入
 *    （旧显式与新显式异值则两条都留 → 冲突）
 * 4. 同等级：同值合并；异值 → 冲突，两条都保留（R8：只呈现不裁决）
 */
export function applyEntry(incoming: ProfileEntry, existing: readonly ProfileEntry[]): ProfileResolution {
  const entry = normalizeEntry(incoming)
  const peers = existing.filter(e => sameKey(e, entry))

  if (peers.length === 0) {
    return { entries: [...existing, entry], outcome: 'added' }
  }

  const declaredPeers = peers.filter(e => e.provenance === 'declared')

  // 等级边界①：推断无法覆盖任何显式声明。不是"权重更低"，是"进不来"。
  if (entry.provenance === 'inferred' && declaredPeers.length > 0) {
    return { entries: existing, outcome: 'inferred-blocked-by-declared' }
  }

  // 等级边界②：新的显式声明把同键的旧推断整个替换掉——推断不是"另一票"。
  if (entry.provenance === 'declared' && declaredPeers.length < peers.length) {
    const kept = existing.filter(e => !(sameKey(e, entry) && e.provenance === 'inferred'))
    const twin = kept.find(
      e => sameKey(e, entry) && e.provenance === 'declared' && e.value === entry.value,
    )
    const entries =
      twin === undefined
        ? [...kept, entry]
        : kept.map(e => (e === twin ? mergeInto(twin, entry) : e))
    return { entries, outcome: 'declared-overrides-inferred' }
  }

  // 同等级：同值合并；异值 = 未裁决冲突（两条都留）。
  const twin = existing.find(
    e => sameKey(e, entry) && e.provenance === entry.provenance && e.value === entry.value,
  )
  if (twin !== undefined) {
    return { entries: existing.map(e => (e === twin ? mergeInto(twin, entry) : e)), outcome: 'merged' }
  }
  return { entries: [...existing, entry], outcome: 'conflict' }
}

/**
 * 冲突消解（任务要求的签名）。
 *
 * 返回值中**同一 (axis,key) 出现两条及以上不同取值 = 未裁决冲突**——
 * 这就是"标记"，调用方必须呈现（`renderConflicts`）而不是自己挑一个。
 */
export function resolveConflict(
  incoming: ProfileEntry,
  existing: readonly ProfileEntry[],
): readonly ProfileEntry[] {
  return applyEntry(incoming, existing).entries
}

/** 检出全部未裁决冲突。按 axis/key 稳定排序，供逐字节稳定的呈现。 */
export function listConflicts(entries: readonly ProfileEntry[]): readonly ProfileConflict[] {
  const groups = new Map<string, { axis: ProfileAxis; key: string; items: ProfileEntry[] }>()
  for (const entry of entries) {
    const key = `${entry.axis}\u0000${entry.key.trim()}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { axis: entry.axis, key: entry.key.trim(), items: [entry] })
    } else {
      group.items.push(entry)
    }
  }

  const conflicts: ProfileConflict[] = []
  for (const group of groups.values()) {
    const byValue = new Map<string, ProfileEntry>()
    for (const item of group.items) {
      const previous = byValue.get(item.value)
      if (previous === undefined || item.updated > previous.updated) byValue.set(item.value, item)
    }
    if (byValue.size < 2) continue
    conflicts.push({
      axis: group.axis,
      key: group.key,
      values: [...byValue.values()].sort(
        (a, b) => b.updated - a.updated || a.value.localeCompare(b.value),
      ),
    })
  }
  conflicts.sort((a, b) => a.axis.localeCompare(b.axis) || a.key.localeCompare(b.key))
  return conflicts
}

/**
 * 把冲突渲染成给用户看的文本（R8：把冲突摆出来）。
 * 无冲突时返回空串——调用方据此决定不占用任何上下文。
 */
export function renderConflicts(conflicts: readonly ProfileConflict[]): string {
  if (conflicts.length === 0) return ''
  const lines: string[] = ['【信息冲突：只呈现，不替你选择】以下说法互相矛盾，请确认哪一个成立：']
  for (const conflict of conflicts) {
    lines.push(`· ${axisLabel(conflict.axis)}「${conflict.key}」有 ${conflict.values.length} 种说法：`)
    conflict.values.forEach((value, index) => {
      lines.push(`  ${index + 1}) ${value.value}`)
    })
  }
  return lines.join('\n')
}

/**
 * 渲染显式条目（会话稳定内容）。
 *
 * **是否注入由上下文层裁决**（§6.7），这里只提供渲染；
 * 能力轴一律排除——它只在会话内存，且不该被当作事实呈现（D4）。
 */
export function renderDeclared(entries: readonly ProfileEntry[], limit = 5): string {
  const declared = entries.filter(e => e.provenance === 'declared' && e.axis !== 'capability')
  if (declared.length === 0 || limit <= 0) return ''
  const shown = declared.slice(0, limit)
  const lines = [`【用户显式声明（共 ${declared.length} 条，列前 ${shown.length} 条）】`]
  for (const entry of shown) {
    lines.push(`· ${axisLabel(entry.axis)}「${entry.key}」= ${entry.value}`)
  }
  return lines.join('\n')
}

/** 画像文档版本。不认识的版本**拒绝解析**，不猜结构。 */
export const PROFILE_DOC_VERSION = 1

export interface ProfileDocument {
  readonly version: number
  readonly entries: readonly ProfileEntry[]
}

function compareEntries(a: ProfileEntry, b: ProfileEntry): number {
  return (
    a.axis.localeCompare(b.axis) ||
    a.key.localeCompare(b.key) ||
    a.provenance.localeCompare(b.provenance) ||
    a.updated - b.updated ||
    a.value.localeCompare(b.value)
  )
}

/**
 * 序列化为文档文本。**顺序无关、逐字节确定**：
 * 这样"内容没变"可以用字符串相等判断，从而跳过无意义写入（也避免 WAL 增长）。
 */
export function serializeDocument(entries: readonly ProfileEntry[]): string {
  const sorted = entries.map(normalizeEntry).sort(compareEntries)
  return JSON.stringify({ version: PROFILE_DOC_VERSION, entries: sorted })
}

export interface ProfileDecodeResult {
  readonly entries: readonly ProfileEntry[]
  /** 被丢弃的非法条目数（不静默：调用方据此如实上报）。 */
  readonly dropped: number
  /** 可读的失败原因；成功时为 null。**绝不抛异常。** */
  readonly error: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseEntry(value: unknown): ProfileEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const axis = raw['axis']
  const key = raw['key']
  const text = raw['value']
  const provenance = raw['provenance']
  if (typeof axis !== 'string' || !PROFILE_AXES.includes(axis as ProfileAxis)) return undefined
  if (typeof key !== 'string' || key.trim().length === 0) return undefined
  if (typeof text !== 'string') return undefined
  if (typeof provenance !== 'string' || !PROFILE_PROVENANCES.includes(provenance as ProfileProvenance)) {
    return undefined
  }
  const rawEvidence = raw['evidence']
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.filter((item): item is string => typeof item === 'string')
    : []
  const rawUpdated = raw['updated']
  const updated = typeof rawUpdated === 'number' && Number.isFinite(rawUpdated) ? rawUpdated : 0
  return normalizeEntry({
    axis: axis as ProfileAxis,
    key,
    value: text,
    provenance: provenance as ProfileProvenance,
    evidence,
    updated,
  })
}

/** 解析文档文本。任何损坏都降级为可读错误 + 已解析出的合法条目，**绝不抛异常**。 */
export function decodeDocument(text: string): ProfileDecodeResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { entries: [], dropped: 0, error: `不是合法 JSON：${messageOf(error)}` }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { entries: [], dropped: 0, error: '顶层不是对象' }
  }
  const document = raw as { version?: unknown; entries?: unknown }
  if (document.version !== PROFILE_DOC_VERSION) {
    return {
      entries: [],
      dropped: 0,
      error: `不认识的画像文档版本：${String(document.version)}（本实现只认 v${PROFILE_DOC_VERSION}）`,
    }
  }
  if (!Array.isArray(document.entries)) {
    return { entries: [], dropped: 0, error: 'entries 不是数组' }
  }
  const entries: ProfileEntry[] = []
  let dropped = 0
  for (const item of document.entries) {
    const parsed = parseEntry(item)
    if (parsed === undefined) dropped += 1
    else entries.push(parsed)
  }
  return { entries, dropped, error: null }
}

/** FNV-1a 32 位。用于内容哈希（去重与"内容是否变化"判断），不用于安全。 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
