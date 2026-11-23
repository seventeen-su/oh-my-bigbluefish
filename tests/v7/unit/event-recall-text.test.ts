import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../../../packages/v7/src/domain/text.js'
import type { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import type { RecallHit, RecallResult } from '../../../packages/v7/src/retrieval/types.js'
import { buildEventRecallText, type RecallNotice } from '../../../packages/v7/src/recall/resident.js'

const CONTEXT = { sessionId: 'session-event', cwd: '/workspace', projectKey: '/workspace' }
const HEADER = '[OMB 事件召回]'

function stateHit(overrides: Partial<RecallHit> = {}): RecallHit {
  return {
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
    ...overrides,
  }
}

function resultWith(hits: readonly RecallHit[]): RecallResult {
  return {
    traceId: 'trc_event',
    configVersion: 'test',
    scenario: 'tool-before',
    query: '工具报错处理',
    hits,
    channelErrors: [],
    channels: [],
    expansion: { seeds: hits.length, expanded: 0, chains: 0 },
    warnings: [],
  }
}

function engineWith(hits: readonly RecallHit[]): RecallEngine {
  return {
    async recall() {
      return resultWith(hits)
    },
  } as unknown as RecallEngine
}

describe('T1 事件召回文本', () => {
  it('给定 2000 字标题且预算不足当构建事件召回文本则截断内容而不是只留 header', async () => {
    const engine = engineWith([stateHit({ title: '长'.repeat(2000) })])

    const text = await buildEventRecallText(engine, CONTEXT, '工具报错处理', 'tool-before', 60)

    expect(text).not.toBe('')
    expect(text).not.toBe(HEADER)
    expect(text).toContain(HEADER)
    expect(text).toContain('相关：')
    expect(estimateTokens(text)).toBeLessThanOrEqual(60)
    // 截断保留可辨识前缀并带省略号；原文整段不能进入上下文。
    expect(text).not.toContain('长'.repeat(2000))
    expect(text.endsWith('…')).toBe(true)
  })

  it('给定 2000 字标题当构建事件召回文本则单条标题按约 100 字封顶', async () => {
    const engine = engineWith([stateHit({ title: '长'.repeat(2000) })])

    const text = await buildEventRecallText(engine, CONTEXT, '工具报错处理', 'tool-before', 400)

    expect(text).toContain(HEADER)
    expect(text).not.toContain('长'.repeat(2000))
    expect(text).not.toContain('长'.repeat(101))
    expect(text).toContain('长'.repeat(100))
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
  })

  it('给定 6 条含重复 entityId 与空标题命中当构建事件召回文本则最多 3 条且预算内', async () => {
    const longTitle = '长标题甲'.repeat(60)
    const first = stateHit({ entityId: 'st_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: longTitle })
    const second = stateHit({ entityId: 'st_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: '标题乙' })
    const duplicate = stateHit({ entityId: first.entityId, title: '标题甲重复' })
    const empty = stateHit({ entityId: 'st_cccccccccccccccccccccccccccccccc', title: '', snippet: '' })
    const fourth = stateHit({ entityId: 'st_dddddddddddddddddddddddddddddddd', title: '标题丁' })
    const fifth = stateHit({ entityId: 'st_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', title: '标题戊' })
    const engine = engineWith([first, second, duplicate, empty, fourth, fifth])

    const text = await buildEventRecallText(engine, CONTEXT, '工具报错处理', 'tool-before', 400)

    expect((text.match(/（st_/g) ?? []).length).toBe(3)
    expect(text.split(first.entityId).length - 1).toBe(1)
    expect(text).not.toContain(duplicate.title ?? '')
    expect(text).not.toContain(empty.entityId)
    expect(text).not.toContain(fifth.entityId)
    expect(text).toContain(fourth.entityId)
    expect(text).toContain('长标题甲'.repeat(25))
    expect(text).not.toContain('长标题甲'.repeat(26))
    expect(text).toContain('…')
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
  })

  it('给定命中被条数或预算截断当登记召回则只包含最终文本可见的实体', async () => {
    const hits = Array.from({ length: 6 }, (_, index) => stateHit({
      entityId: `st_${String(index).padStart(32, '0')}`,
      title: `命中${index}`,
    }))
    const notices: RecallNotice[] = []
    const engine = engineWith(hits)

    const text = await buildEventRecallText(
      engine,
      CONTEXT,
      '工具报错处理',
      'tool-before',
      400,
      notice => notices.push(notice),
    )

    expect(notices).toHaveLength(1)
    expect(notices[0]?.hits.length).toBeLessThanOrEqual(3)
    for (const hit of notices[0]?.hits ?? []) {
      expect(text).toContain(hit.id)
    }
    expect(notices[0]?.hits.some(hit => hit.id === hits[5]?.entityId)).toBe(false)
  })

  it('给定预算只够 header 当构建事件召回文本则返回空串而不是 header', async () => {
    const engine = engineWith([stateHit()])

    const text = await buildEventRecallText(engine, CONTEXT, '工具报错处理', 'tool-before', 6)

    expect(text).toBe('')
  })

  it('给定预算连 header 都放不下当构建事件召回文本则返回空串', async () => {
    const engine = engineWith([stateHit()])

    const text = await buildEventRecallText(engine, CONTEXT, '工具报错处理', 'tool-before', 1)

    expect(text).toBe('')
  })

  it('给定短标题在预算内当构建事件召回文本则保留 header 与命中内容', async () => {
    const engine = engineWith([stateHit({ title: '工具报错处理方法' })])

    const text = await buildEventRecallText(engine, CONTEXT, '工具报错处理', 'tool-before', 400)

    expect(text).toContain(HEADER)
    expect(text).toContain('相关：')
    expect(text).toContain('工具报错处理方法')
    expect(text).toContain('st_0123456789abcdef0123456789abcdef')
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
  })
})
