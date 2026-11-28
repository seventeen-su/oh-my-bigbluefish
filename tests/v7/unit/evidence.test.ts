import { describe, expect, it } from 'vitest'
import {
  evidenceIndependenceKey,
  legacyEvidenceStrings,
  normalizeEvidence,
  shouldPromoteClue,
  summarizeEvidence,
  type EvidenceRecord,
} from '../../../packages/v7/src/domain/evidence.js'
import { evidenceForWrite, fileSubjectsIn, verificationEvidence } from '../../../packages/v7/src/app/evidence.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'

const NOW = '2026-11-29T00:00:00.000Z'
const HASH = 'a'.repeat(64)

function record(overrides: Partial<EvidenceRecord>): EvidenceRecord {
  return {
    id: 'evd_018f2a00-0000-7000-8000-000000000001',
    entityId: 'mem_018f2a00-0000-7000-8000-000000000001',
    sourceType: 'session',
    sourceId: 'session:a',
    observedAt: NOW,
    contentHash: HASH,
    confidence: 0.6,
    verificationStatus: 'unverified',
    subjectKey: 'session:a',
    createdAt: NOW,
    ...overrides,
  }
}

function clue(attrs: Record<string, unknown>): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'clue',
    scope: { kind: 'project', projectKey: 'D:/Project/omb' },
    attrs,
  } as WriteEntityInput
}

describe('normalizeEvidence（边界归一化）', () => {
  it('非法来源/空白 sourceId/非法时间被丢弃或归一', () => {
    expect(normalizeEvidence({ sourceType: 'bogus' as never, sourceId: 'x', observedAt: NOW })).toBeUndefined()
    expect(normalizeEvidence({ sourceType: 'session', sourceId: '   ', observedAt: NOW })).toBeUndefined()
    expect(normalizeEvidence({ sourceType: 'session', sourceId: 'session:a', observedAt: 'not-a-time' })).toBeUndefined()
    const normalized = normalizeEvidence({
      sourceType: 'file',
      sourceId: 'file:docs/ARCHITECTURE.md',
      observedAt: NOW,
      confidence: 7,
      verificationStatus: 'bogus' as never,
      subjectKey: 'file:docs/ARCHITECTURE.md',
    })
    expect(normalized).toMatchObject({
      sourceType: 'file',
      confidence: 1,
      verificationStatus: 'unverified',
      subjectKey: 'file:docs/ARCHITECTURE.md',
    })
  })
})

describe('独立来源判定（不再只数 session:<id>）', () => {
  it('两个不同会话是两个独立来源；同一会话重复写入只算一份', () => {
    const twoSessions = summarizeEvidence([
      record({ sourceId: 'session:a', subjectKey: 'session:a' }),
      record({ sourceId: 'session:b', subjectKey: 'session:b' }),
    ])
    expect(twoSessions.independent).toBe(2)
    const sameSession = summarizeEvidence([
      record({ sourceId: 'session:a', subjectKey: 'session:a' }),
      record({ sourceId: 'session:a', subjectKey: 'session:a', observedAt: '2026-11-30T00:00:00.000Z' }),
    ])
    expect(sameSession.independent).toBe(1)
  })

  it('两个会话引用同一文件只算一份独立验证；不同文件才算两份', () => {
    const sameFile = summarizeEvidence([
      record({ sourceType: 'file', sourceId: 'file:docs/ARCHITECTURE.md', subjectKey: 'file:docs/ARCHITECTURE.md' }),
      record({ sourceType: 'file', sourceId: 'file:docs/ARCHITECTURE.md', subjectKey: 'file:docs/ARCHITECTURE.md' }),
    ])
    expect(sameFile.independent).toBe(1)
    const differentFiles = summarizeEvidence([
      record({ sourceType: 'file', sourceId: 'file:docs/ARCHITECTURE.md', subjectKey: 'file:docs/ARCHITECTURE.md' }),
      record({ sourceType: 'file', sourceId: 'file:docs/CONTRIBUTING.md', subjectKey: 'file:docs/CONTRIBUTING.md' }),
    ])
    expect(differentFiles.independent).toBe(2)
  })

  it('verification 不混入独立来源计数，按 verified/refuted 单独判定', () => {
    const refuted = summarizeEvidence([
      record({}),
      record({ sourceType: 'verification', sourceId: 'job:clue-promote:x', verificationStatus: 'refuted', subjectKey: '' }),
    ])
    expect(refuted.independent).toBe(1)
    expect(refuted.verified).toBe(false)
    expect(refuted.refuted).toBe(true)
    expect(shouldPromoteClue(refuted)).toBe(false)
    const verified = summarizeEvidence([
      record({ sourceType: 'verification', sourceId: 'job:clue-promote:x', verificationStatus: 'verified', subjectKey: '' }),
    ])
    expect(verified.independent).toBe(0)
    expect(shouldPromoteClue(verified)).toBe(true)
  })

  it('user 证据高置信视为用户确认；低置信不算', () => {
    expect(shouldPromoteClue(summarizeEvidence([
      record({ sourceType: 'user', sourceId: 'session:a', subjectKey: 'session:a', confidence: 0.9 }),
    ]))).toBe(true)
    expect(shouldPromoteClue(summarizeEvidence([
      record({ sourceType: 'user', sourceId: 'session:a', subjectKey: 'session:a', confidence: 0.5 }),
    ]))).toBe(false)
  })

  it('单会话重复三次也不晋升（旧 evidence 字符串不再算证据）', () => {
    const summary = summarizeEvidence([
      record({ sourceId: 'session:a', subjectKey: 'session:a' }),
      record({ sourceId: 'session:a', subjectKey: 'session:a', observedAt: '2026-11-29T01:00:00.000Z' }),
      record({ sourceId: 'session:a', subjectKey: 'session:a', observedAt: '2026-11-29T02:00:00.000Z' }),
    ])
    expect(summary.independent).toBe(1)
    expect(shouldPromoteClue(summary)).toBe(false)
    expect(legacyEvidenceStrings(['session:a', 'session:b', { sessionId: 'c' }])).toEqual([
      'session:a', 'session:b', 'session:c',
    ])
  })

  it('evidenceIndependenceKey：subjectKey 优先，否则 sourceType:sourceId', () => {
    expect(evidenceIndependenceKey({ sourceType: 'session', sourceId: 'session:a', subjectKey: 'file:x' })).toBe('subject:file:x')
    expect(evidenceIndependenceKey({ sourceType: 'session', sourceId: 'session:a' })).toBe('session:session:a')
  })
})

describe('证据生产者（system/tool/file/session）', () => {
  it('文件引用只产生 file 证据：同一文件的多个会话不会成为多份验证', () => {
    const input = clue({
      title: '接口超时结论',
      body: '按 docs/ARCHITECTURE.md 与 packages/v7/src/app/recall.ts 的说明，超时来自重试。',
    })
    const first = evidenceForWrite(input, { sessionId: 'session:a', tool: 'omb_remember', now: NOW })
    const second = evidenceForWrite(input, { sessionId: 'session:b', tool: 'omb_remember', now: NOW })
    expect(first.map(item => item.sourceType)).toEqual(['file', 'file'])
    expect(first.map(item => item.subjectKey)).toEqual(second.map(item => item.subjectKey))
    expect(new Set([...first, ...second].map(item => item.sourceId)).size).toBe(2)
  })

  it('没有文件时按会话写 session 证据；用户确认额外写 user 证据（同 subjectKey）', () => {
    const evidence = evidenceForWrite(clue({ title: '可能的原因是缓存', body: '观察到重复请求' }), {
      sessionId: 'session:a',
      tool: 'omb_remember',
      now: NOW,
    })
    expect(evidence.map(item => item.sourceType)).toEqual(['session'])
    const confirmed = evidenceForWrite(clue({ title: '可能的原因是缓存', body: '观察到重复请求', userConfirmed: true }), {
      sessionId: 'session:a',
      tool: 'omb_remember',
      now: NOW,
    })
    expect(confirmed.map(item => item.sourceType)).toEqual(['session', 'user'])
    expect(new Set(confirmed.map(item => item.subjectKey)).size).toBe(1)
  })

  it('没有会话时写 tool 证据；文内没有文件路径时不产生 file 证据', () => {
    const evidence = evidenceForWrite(clue({ title: '结论', body: '没有文件引用' }), { tool: 'omb_remember', now: NOW })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.sourceType).toBe('tool')
    expect(fileSubjectsIn('见 D:\\Project\\docs\\SPEC.md 与 src/app/recall.ts')).toEqual([
      'D:/Project/docs/SPEC.md',
      'src/app/recall.ts',
    ])
  })

  it('系统验证证据带 verified/refuted，不伪造独立来源', () => {
    expect(verificationEvidence({ entityId: 'mem_x', now: NOW, verified: true, detail: 'ok' })).toMatchObject({
      sourceType: 'verification',
      verificationStatus: 'verified',
    })
    expect(verificationEvidence({ entityId: 'mem_x', now: NOW, verified: false, detail: 'no' }).verificationStatus).toBe('refuted')
  })
})

