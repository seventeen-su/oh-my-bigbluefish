import { describe, expect, it } from 'vitest'
import type { EntitySummary } from '../../../packages/v7/src/ports/store.js'
import type { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import type { RecallHit, RecallResult } from '../../../packages/v7/src/retrieval/types.js'
import { buildResident } from '../../../packages/v7/src/recall/resident.js'

const stateHit: RecallHit = {
  entityId: 'st_0123456789abcdef0123456789abcdef',
  kind: 'state',
  title: '状态标题',
  snippet: '进行中',
  status: 'in_progress',
  scope: { kind: 'project', projectKey: '/workspace' },
  updatedAt: '2026-11-23T00:00:00.000Z',
  score: 1,
  fusedScore: 0.02,
  why: ['test'],
  channels: ['state_board'],
  rawScores: { state_board: 1 },
  chainSiblings: [],
  historyCount: 0,
}

function stateResult(): RecallResult {
  return {
    traceId: 'trc_state',
    configVersion: 'test',
    scenario: 'session-start',
    query: '当前项目 进行中 阻塞中',
    hits: [stateHit],
    channelErrors: [],
    channels: [],
    expansion: { seeds: 1, expanded: 0, chains: 0 },
    warnings: [],
  }
}

const preference: EntitySummary = {
  id: 'mem_0123456789abcdef0123456789abcdef',
  kind: 'memory',
  title: '偏好标题'.repeat(20),
  category: 'fact',
  scope: { kind: 'global' },
  snippet: '偏好摘要'.repeat(20),
  archived: false,
  isCurrent: true,
  updatedAt: '2026-11-23T00:00:00.000Z',
  historyCount: 0,
}

describe('T0 常驻 trace', () => {
  it('给定预算不足当构建常驻文本则按优先级保留整行并记录裁剪', async () => {
    const engine = {
      async recall() {
        return stateResult()
      },
    } as unknown as RecallEngine
    const built = await buildResident(
      engine,
      { sessionId: 'session-trace', cwd: '/workspace', projectKey: '/workspace' },
      55,
      async () => ({
        memory: 1,
        state: 1,
        chain: 0,
        archived: 0,
        attrNames: ['title', 'body'],
        categories: { fact: 1, clue: 0, event: 0 },
        scopes: { global: 1, project: 0 },
        recentStates: [{ id: stateHit.entityId, title: '状态标题', status: 'in_progress' }],
      }),
      undefined,
      async () => [preference],
    )

    expect(built.trace.sessionId).toBe('session-trace')
    expect(built.trace.budgetTokens).toBe(55)
    expect(built.trace.usedTokens).toBeLessThanOrEqual(55)
    expect(built.text).toContain('状态标题')
    expect(built.text).not.toContain(preference.title ?? '')

    const preferences = built.trace.sections.find(section => section.name === 'preferences')
    const states = built.trace.sections.find(section => section.name === 'states')
    expect(preferences?.kept).toBe(false)
    expect(states?.kept).toBe(true)
    expect(states?.entityIds).toContain(stateHit.entityId)
    expect(built.preferenceHits).toEqual([])
    expect(built.trace.droppedSections).toContain('preferences')
    expect(built.trace.sections.every(section => section.tokens === 0 || section.text.length > 0)).toBe(true)
  })

  it('给定预算充足当构建常驻文本则保留三段内容且 trace 完整', async () => {
    const engine = {
      async recall() {
        return stateResult()
      },
    } as unknown as RecallEngine
    const built = await buildResident(
      engine,
      { sessionId: 'session-trace-full', cwd: '/workspace', projectKey: '/workspace' },
      600,
      async () => ({
        memory: 3,
        state: 2,
        chain: 1,
        archived: 1,
        attrNames: ['title', 'body', 'tags'],
        categories: { fact: 2, clue: 1, event: 0 },
        scopes: { global: 2, project: 1 },
        recentStates: [{ id: stateHit.entityId, title: '状态标题', status: 'in_progress' }],
      }),
      undefined,
      async () => [{ ...preference, title: '偏好实际标题', snippet: '偏好实际摘要' }],
    )

    expect(built.text).toContain('[OMB 常驻]')
    expect(built.text).toContain('偏好实际标题')
    expect(built.text).toContain('状态标题')
    expect(built.text).toContain('常用属性')
    expect(built.trace.droppedSections).toEqual([])
    expect(built.trace.usedTokens).toBeGreaterThan(0)
    expect(built.preferenceHits).toEqual([{ id: preference.id, title: '偏好实际标题' }])
    expect(built.trace.sections.filter(section => section.kept)).toHaveLength(built.trace.sections.length)
  })
})