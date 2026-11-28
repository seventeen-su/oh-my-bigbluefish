import { describe, expect, it } from 'vitest'
import { RecallService, formatRecall, recallScenarioForQuery } from '../../../packages/v7/src/app/recall.js'
import type { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import type { RecallHit, RecallRequest, RecallResult } from '../../../packages/v7/src/retrieval/types.js'

function engineWithCapture(): { engine: RecallEngine; requests: RecallRequest[] } {
  const requests: RecallRequest[] = []
  const engine = {
    async recall(request: RecallRequest): Promise<RecallResult> {
      requests.push(request)
      return {
        traceId: 'trc_test',
        configVersion: 'test',
        scenario: request.scenario ?? 'manual',
        query: request.query,
        hits: [],
        channelErrors: [],
        channels: [],
        expansion: { seeds: 0, expanded: 0, chains: 0 },
        warnings: [],
      }
    },
  } as unknown as RecallEngine
  return { engine, requests }
}

describe('RecallService 场景选择', () => {
  it('用户提到上次/之前时使用 last-time 场景', async () => {
    const { engine, requests } = engineWithCapture()
    const result = await new RecallService(engine).recall(
      { query: '上次那个决定是什么' },
      { sessionId: 'session-1', cwd: '/workspace', projectKey: '/workspace' },
    )
    expect(result.ok).toBe(true)
    expect(requests[0]?.scenario).toBe('last-time')
  })

  it('普通查询保持 manual 场景', async () => {
    const { engine, requests } = engineWithCapture()
    await new RecallService(engine).recall(
      { query: '当前项目状态' },
      { sessionId: 'session-1', cwd: '/workspace', projectKey: '/workspace' },
    )
    expect(requests[0]?.scenario).toBe('manual')
  })

  it('场景检测覆盖中文与英文触发词', () => {
    expect(recallScenarioForQuery('之前讨论的方案')).toBe('last-time')
    expect(recallScenarioForQuery('what did we decide previously')).toBe('last-time')
    expect(recallScenarioForQuery('实现当前接口')).toBe('manual')
  })

  it('T2 输出全部 limit 命中而不是固定截断到 8 条', () => {
    const hits: RecallHit[] = Array.from({ length: 12 }, (_, index) => ({
      entityId: `mem_${String(index).padStart(4, '0')}`,
      kind: 'memory',
      title: `命中 ${index + 1}`,
      snippet: 'snippet',
      category: 'fact',
      scope: { kind: 'global' },
      updatedAt: '2026-11-23T00:00:00.000Z',
      score: 1,
      fusedScore: 0.02,
      why: ['test'],
      channels: ['fulltext'],
      rawScores: { fulltext: 0.1 },
      chainSiblings: [],
      historyCount: 0,
      lifecycle: 'active',
    }))
    const text = formatRecall({
      traceId: 'trc_test',
      configVersion: 'test',
      scenario: 'manual',
      query: 'query',
      hits,
      channelErrors: [],
      channels: [],
      expansion: { seeds: 0, expanded: 0, chains: 0 },
      warnings: [],
    })
    expect(text).toContain('12. [fact] 命中 12')
  })
})
