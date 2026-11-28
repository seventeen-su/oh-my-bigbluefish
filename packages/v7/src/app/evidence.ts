import type { WriteEntityInput } from '../domain/entity.js'
import type { EvidenceInput } from '../domain/evidence.js'
import type { JsonValue } from '../domain/json.js'

/**
 * 证据生产者：把「谁在什么来源里观察到这条内容」翻译成独立 Evidence 记录。
 *
 * 生产规则（与 SPEC §9 一致，禁止模型自证）：
 * - 工具写入（omb_remember）：内容里出现文件路径时只写 file 证据（同一文件的多个 session
 *   引用会落到同一 subjectKey，不算多份独立验证）；否则写 session 证据，
 *   subjectKey 是 session:<id>，同一会话重复写入只算一份；
 * - 用户确认（origin=user 或 userConfirmed=true）：额外写 user 证据（高置信、同 subjectKey）；
 * - artifact 抽取：没有文件时写 session 证据（session/artifact 身份），有文件时只写 file 证据；
 * - 系统校验：verification 证据由晋升判断自己写（verified/refuted），不在这里产生。
 *
 * contentHash 由写事务按内容指纹补齐；这里只负责来源与主题，不让调用方传任意哈希。
 */

export interface EvidenceProducerContext {
  readonly sessionId?: string
  readonly callId?: string
  /** 产生证据的工具名，如 `omb_remember`。 */
  readonly tool?: string
  readonly origin?: string
  readonly now: string
}

/** 文件路径/文件名候选：绝对路径、带分隔符的相对路径、常见源码/文档扩展名。 */
const FILE_CANDIDATE = /(?:[A-Za-z]:[\\/][^\s"'`，。；、）)\]}>]+|\/(?:[^\s"'`，。；、）)\]}>]+\/)+[^\s"'`，。；、）)\]}>]+|(?:\.{0,2}[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|mjs|cjs|md|json|sql|yml|yaml|toml|py|go|rs|java|kt|sh|ps1|txt))\b/g

/** 从文本提取被引用的文件主题；规范化分隔符并去掉结尾标点，保证同一文件跨会话同一键。 */
export function fileSubjectsIn(text: string): string[] {
  const subjects = new Set<string>()
  for (const match of text.matchAll(FILE_CANDIDATE)) {
    const raw = match[0].replace(/[.,;:!?]+$/, '')
    if (raw.length === 0) continue
    const normalized = raw.replaceAll('\\', '/')
    if (normalized.length > 512) continue
    subjects.add(normalized)
  }
  return [...subjects].sort()
}

function stringAttributes(value: JsonValue | undefined, out: string[], depth = 0): void {
  if (depth > 8) return
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) stringAttributes(item, out, depth + 1)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) stringAttributes(item as JsonValue, out, depth + 1)
  }
}

/** 写入内容的可检索文本（用于识别证据主题）；标题/正文之外的自定义属性也参与。 */
export function evidenceTextOf(input: WriteEntityInput): string {
  const parts: string[] = []
  if (input.kind !== 'memory') parts.push(input.title)
  if (input.attrs !== undefined) {
    for (const [name, value] of Object.entries(input.attrs)) {
      if (name === 'evidence') continue
      stringAttributes(value as JsonValue, parts)
    }
  }
  return parts.join('\n')
}

function userAsserted(input: WriteEntityInput, context: EvidenceProducerContext): boolean {
  if (context.origin !== undefined && /^user(?:[:/]|$)/i.test(context.origin)) return true
  return input.attrs?.['userConfirmed'] === true || input.attrs?.['assertedBy'] === 'user'
}

/**
 * `omb_remember` 写入证据。
 *
 * 返回空数组表示“这次写入没有可独立验证的来源”：线索可以照常写入，但不会被晋升，
 * 直到有真实来源（session / 文件 / artifact）写入证据。
 */
export function evidenceForWrite(input: WriteEntityInput, context: EvidenceProducerContext): EvidenceInput[] {
  const now = context.now
  const sessionId = context.sessionId?.trim()
  const tool = context.tool ?? 'omb_remember'
  const files = fileSubjectsIn(evidenceTextOf(input))
  if (files.length > 0) {
    // 同一文件无论被多少个 session 引用，都是同一份物证：一条 file 证据足够。
    return files.map(path => ({
      sourceType: 'file' as const,
      sourceId: `file:${path}`,
      observedAt: now,
      subjectKey: `file:${path}`,
      confidence: 0.7,
      detail: sessionId === undefined || sessionId.length === 0 ? path : `session:${sessionId} 引用 ${path}`,
    }))
  }
  if (sessionId === undefined || sessionId.length === 0) {
    return [{
      sourceType: 'tool' as const,
      sourceId: `tool:${tool}`,
      observedAt: now,
      subjectKey: `tool:${tool}`,
      confidence: 0.5,
      detail: tool,
    }]
  }
  const subjectKey = `session:${sessionId}`
  const evidence: EvidenceInput[] = [{
    sourceType: 'session',
    sourceId: `session:${sessionId}`,
    observedAt: now,
    subjectKey,
    confidence: 0.6,
    detail: tool,
  }]
  if (userAsserted(input, context)) {
    evidence.push({
      sourceType: 'user',
      sourceId: `session:${sessionId}`,
      observedAt: now,
      subjectKey,
      confidence: 0.9,
      detail: `user-confirmed via ${tool}`,
    })
  }
  return evidence
}

/**
 * artifact 抽取证据：artifact 是 DSH 会话事件/报告的有限原文，属于 session 来源；
 * 引用文件时仍按文件主题计（否则两个 session 报告引用同一文件会被算成两份验证）。
 */
export function evidenceForArtifact(
  input: WriteEntityInput,
  artifact: { readonly id: string; readonly sessionId?: string; readonly kind: string },
  now: string,
): EvidenceInput[] {
  const files = fileSubjectsIn(evidenceTextOf(input))
  if (files.length > 0) {
    return files.map(path => ({
      sourceType: 'file' as const,
      sourceId: `file:${path}`,
      observedAt: now,
      subjectKey: `file:${path}`,
      confidence: 0.7,
      detail: `artifact:${artifact.id} 引用 ${path}`,
    }))
  }
  const sessionId = artifact.sessionId?.trim()
  const identity = sessionId !== undefined && sessionId.length > 0 ? `session:${sessionId}` : `artifact:${artifact.id}`
  return [{
    sourceType: 'session',
    sourceId: identity,
    observedAt: now,
    subjectKey: identity,
    confidence: 0.6,
    detail: `${artifact.kind} via ${artifact.id}`,
  }]
}

/** 系统验证证据：只在晋升判断真正做出结论时写入；调用方不能伪造 verified。 */
export function verificationEvidence(options: {
  readonly entityId: string
  readonly now: string
  readonly verified: boolean
  readonly detail: string
}): EvidenceInput {
  return {
    sourceType: 'verification',
    sourceId: `job:clue-promote:${options.entityId}`,
    observedAt: options.now,
    confidence: 0.9,
    verificationStatus: options.verified ? 'verified' : 'refuted',
    detail: options.detail,
  }
}
