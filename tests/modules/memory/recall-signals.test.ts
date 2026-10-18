/**
 * 3.7 Wave 2 / 审计 P3：召回回执里的"相关度"必须真的可读。
 *
 * 背景（产品审计实测）：RRF 融合分只有 `1/(k+rank)` 的两种取值（1 通道 0.0164 /
 * 2 通道 0.0328），旧回执把它写成 `score=`，模型会当成"相关度"；实际它只说
 * "这条由几个通道命中"。修法：`融合分` 明确标注仅排序 + 每通道**原始分信号**。
 */
import { describe, expect, it } from 'vitest'
import type { RetrieveResult } from '../../../modules/memory/retrieve.js'
import { retrieve } from '../../../modules/memory/retrieve.js'
import { renderRecall } from '../../../modules/memory/recall.js'
import { clockAt, fakeStore, makeRecord, tagged } from '../retrieval/fakes.js'

const CLOCK = clockAt(1_700_000_000_000)

function item(overrides: Partial<RetrieveResult['items'][number]>): RetrieveResult['items'][number] {
  return {
    rank: 0,
    id: 'm1',
    text: '结论',
    sourceRef: 'session:s1#1',
    observedAt: 1_700_000_000_000,
    scope: 'user',
    kind: 'semantic',
    assertedBy: 'user',
    project: null,
    validTo: null,
    supersededBy: null,
    score: 0.0164,
    channels: ['lexical'],
    ranks: [{ channel: 'lexical', scope: 'user', rank: 1 }],
    signals: {},
    ...overrides,
  }
}

function resultOf(items: readonly RetrieveResult['items'][number][]): RetrieveResult {
  return {
    items,
    gate: { retrieve: true, reason: 'ok', detail: '门控通过' },
    degraded: [],
    stats: {
      storesQueried: 1,
      channelsUsed: ['lexical'],
      candidatesFused: items.length,
      candidatesCapped: items.length,
      dropped: 0,
      reservedSkipped: 0,
      expiredSkipped: 0,
      supersededSkipped: 0,
      supersededSkippedIds: [],
      perStore: [{ scope: 'user', candidates: items.length, selected: items.length }],
      rrfK: 60,
      reranked: false,
      lexicalFloor: 0.5,
      lexicalFloorMode: 'fixed',
      lexicalFloorDropped: 0,
      relatedExpanded: 0,
    },
    now: 1_700_000_000_000,
    note: '已查询 1 个库、1 个通道，注入 1 条（逐字 + 溯源）',
  }
}

describe('召回相关度信号（3.7 Wave 2 / P3）', () => {
  it('融合分不再标成 score；两条同分条目靠原始信号区分相关度', () => {
    const rendered = renderRecall(
      resultOf([
        item({ id: 'relevant', signals: { lexical: 3.2, vector: 0.62 } }),
        item({ id: 'irrelevant', signals: { lexical: 0.9 } }),
      ]),
    )
    // 融合分只有两种取值，展示时必须写明"仅排序"
    expect(rendered).toContain('融合分 0.0164（仅排序，不是相关度）')
    expect(rendered).not.toContain('score=')
    // 真正的相关度信号：通道原始分（词法 -bm25 / 向量余弦）
    expect(rendered).toContain('信号 词法 3.20 / 向量 0.62')
    expect(rendered).toContain('信号 词法 0.90')
    expect(rendered).toContain('通道 lexical#1')
  })

  it('没有原始分时标"未测"，不编造相关度', () => {
    const rendered = renderRecall(resultOf([item({ signals: {} })]))
    expect(rendered).toContain('信号 未测')
  })

  it('retrieve 真的把通道原始分带进 item.signals（词法/向量各一）', async () => {
    const records = [
      makeRecord({ id: 'a', text: '端口 8080' }),
      makeRecord({ id: 'b', text: '契约 边界' }),
    ]
    const store = fakeStore({
      scope: 'user',
      records,
      search: () => [
        { id: 'a', score: 3.4, channel: 'lexical' },
        { id: 'b', score: 0.8, channel: 'lexical' },
      ],
    })
    const vector = {
      name: 'vector' as const,
      search: () => Promise.resolve([{ id: 'a', score: 0.71, channel: 'vector' as const }]),
    }
    const result = await retrieve([tagged(store)], { text: '端口', limit: 2, lexicalFloor: 0 }, { clock: CLOCK, channels: [vector] })
    const a = result.items.find(entry => entry.id === 'a')
    const b = result.items.find(entry => entry.id === 'b')
    expect(a?.signals.lexical).toBe(3.4)
    expect(a?.signals.vector).toBe(0.71)
    expect(b?.signals.lexical).toBe(0.8)
    expect(b?.signals.vector).toBeUndefined()
  })
})
