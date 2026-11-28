import { isPlainObject } from './json.js'

/**
 * Evidence：独立的证据数据结构（不是属性里的自由字符串）。
 *
 * 为什么需要独立模型：旧实现的线索晋升只数 `attributes.evidence` 里的 `session:<id>`，
 * 这些字符串没有系统写入者，两个引用同一文件的会话会被误当成两份独立验证。
 * 这里用 `sourceType` + `sourceId` + `subjectKey` 表达“谁、用什么来源、观察了什么”：
 *
 * - `sourceType`：user（用户确认）/ tool（工具调用观察）/ file（文件内容）/
 *   session（会话事件）/ verification（系统校验结论）；
 * - `sourceId`：来源稳定身份（session id、工具调用、文件路径、artifact id）；
 * - `subjectKey`：证据指向的独立主题（文件/URL/工单）；同主题的多个来源只算一份独立验证。
 *   两个 session 引用同一文件 → 两条证据同一 subjectKey → 独立来源计数只 +1；
 * - `contentHash`：被这一条证据支撑的内容指纹；线索晋升只统计当前内容哈希上的证据，
 *   内容改掉之后旧证据不再为新内容背书；
 * - `verificationStatus`：只有系统 verification 生产者会写 verified/refuted。
 */

export const EVIDENCE_SOURCE_TYPES = ['user', 'tool', 'file', 'session', 'verification'] as const
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number]

export const EVIDENCE_VERIFICATION_STATUSES = ['unverified', 'verified', 'refuted'] as const
export type EvidenceVerificationStatus = (typeof EVIDENCE_VERIFICATION_STATUSES)[number]

/** 待写入证据：`contentHash` 由写事务按内容指纹补齐，调用方通常不需要填。 */
export interface EvidenceInput {
  readonly sourceType: EvidenceSourceType
  readonly sourceId: string
  readonly observedAt: string
  readonly contentHash?: string
  readonly confidence?: number
  readonly verificationStatus?: EvidenceVerificationStatus
  /** 同一主题只算一份独立验证；空串表示按 sourceType:sourceId 计。 */
  readonly subjectKey?: string
  readonly detail?: string
}

export interface EvidenceRecord extends EvidenceInput {
  readonly id: string
  readonly entityId: string
  readonly contentHash: string
  readonly confidence: number
  readonly verificationStatus: EvidenceVerificationStatus
  readonly subjectKey: string
  readonly createdAt: string
}

const MAX_SOURCE_ID = 512
const MAX_SUBJECT_KEY = 512
const MAX_DETAIL = 2_000

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5
}

/** 边界归一化：非法/空白来源直接丢弃（返回 undefined），不把坏证据写进账本。 */
export function normalizeEvidence(input: EvidenceInput): EvidenceInput | undefined {
  if (!(EVIDENCE_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) return undefined
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
  if (sourceId.length === 0) return undefined
  const observed = typeof input.observedAt === 'string' ? Date.parse(input.observedAt) : Number.NaN
  if (!Number.isFinite(observed)) return undefined
  const subjectKey = typeof input.subjectKey === 'string' ? input.subjectKey.trim() : ''
  const detail = typeof input.detail === 'string' ? input.detail.trim() : ''
  return {
    sourceType: input.sourceType,
    sourceId: sourceId.slice(0, MAX_SOURCE_ID),
    observedAt: new Date(observed).toISOString(),
    ...(typeof input.contentHash === 'string' && input.contentHash.trim().length > 0
      ? { contentHash: input.contentHash.trim() }
      : {}),
    confidence: clampConfidence(input.confidence),
    verificationStatus: (EVIDENCE_VERIFICATION_STATUSES as readonly string[]).includes(input.verificationStatus ?? '')
      ? input.verificationStatus as EvidenceVerificationStatus
      : 'unverified',
    ...(subjectKey.length > 0 ? { subjectKey: subjectKey.slice(0, MAX_SUBJECT_KEY) } : {}),
    ...(detail.length > 0 ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
  }
}

/**
 * 独立来源判定键：subjectKey 优先（同主题多来源只算一份），否则 sourceType:sourceId。
 * verification 不参与“独立来源”计数：系统验证结论通过 verificationStatus 单独判定。
 */
export function evidenceIndependenceKey(record: Pick<EvidenceRecord | EvidenceInput, 'sourceType' | 'sourceId' | 'subjectKey'>): string {
  const subject = typeof record.subjectKey === 'string' ? record.subjectKey.trim() : ''
  return subject.length > 0 ? `subject:${subject}` : `${record.sourceType}:${record.sourceId.trim()}`
}

export interface EvidenceSummary {
  readonly total: number
  /** 独立来源数（不含 verification；同 subjectKey 只算 1）。 */
  readonly independent: number
  readonly userConfirmed: boolean
  readonly verified: boolean
  readonly refuted: boolean
  readonly sources: readonly string[]
}

/** 汇总证据：独立来源去重、用户确认、系统验证结论分开统计。 */
export function summarizeEvidence(records: readonly EvidenceRecord[]): EvidenceSummary {
  const subjects = new Set<string>()
  const sources = new Set<string>()
  let userConfirmed = false
  let verified = false
  let refuted = false
  for (const record of records) {
    if (record.sourceType === 'verification') {
      if (record.verificationStatus === 'verified') verified = true
      if (record.verificationStatus === 'refuted') refuted = true
      continue
    }
    subjects.add(evidenceIndependenceKey(record))
    sources.add(`${record.sourceType}:${record.sourceId}`)
    if (record.sourceType === 'user' && record.confidence >= 0.8) userConfirmed = true
  }
  return {
    total: records.length,
    independent: subjects.size,
    userConfirmed,
    verified,
    refuted,
    sources: [...sources].sort(),
  }
}

/**
 * 线索转事实的判定（保守）：
 * - 有 refuted 验证结论：不晋升；
 * - 系统 verified，或用户确认（user 来源 + 高置信），或 ≥2 个独立来源：晋升；
 * - 单来源（即使同一会话重复多次）永远不晋升——旧 `session:a` 重复三次不再算证据。
 */
export function shouldPromoteClue(summary: EvidenceSummary): boolean {
  if (summary.refuted) return false
  if (summary.verified) return true
  if (summary.userConfirmed) return true
  return summary.independent >= 2
}

/** 证据行映射（适配器只负责 SQL，形状定义留在 domain）。 */
export function isEvidenceSourceType(value: unknown): value is EvidenceSourceType {
  return typeof value === 'string' && (EVIDENCE_SOURCE_TYPES as readonly string[]).includes(value)
}

export function isEvidenceVerificationStatus(value: unknown): value is EvidenceVerificationStatus {
  return typeof value === 'string' && (EVIDENCE_VERIFICATION_STATUSES as readonly string[]).includes(value)
}

/** 从属性值里读旧式 evidence 字符串（只用于兼容展示，不再作为晋升依据）。 */
export function legacyEvidenceStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) result.push(item)
    else if (isPlainObject(item) && typeof item['sessionId'] === 'string') result.push(`session:${item['sessionId']}`)
  }
  return result
}
