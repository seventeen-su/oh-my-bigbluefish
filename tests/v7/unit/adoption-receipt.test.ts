import { describe, expect, it } from 'vitest'
import {
  adoptionReceiptHits,
  adoptionReceiptFromResidentTrace,
  receiptKeptHits,
} from '../../../packages/v7/src/app/adoption.js'
import { receiptVisibleHits } from '../../../plugin/v7/adoption-evidence.js'
import type { ResidentTraceInput } from '../../../packages/v7/src/ports/observability.js'

const KEPT = 'mem_11111111-1111-4111-8111-111111111111'
const POISON = 'mem_22222222-2222-4222-8222-222222222222'
const DROPPED = 'mem_33333333-3333-4333-8333-333333333333'
const INDEX = 'mem_44444444-4444-4444-8444-444444444444'

function dispositions(input: Parameters<typeof adoptionReceiptHits>[0]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const hit of adoptionReceiptHits(input)) result[hit.entityId] = hit.disposition
  return result
}

describe('receipt → 逐实体处置（纯函数）', () => {
  it('quarantined 优先于 kept；显式 dropped 覆盖 hits 的默认 kept', () => {
    expect(dispositions({
      traceId: 'trc_1',
      kind: 't1',
      injected: true,
      keptIds: [KEPT, POISON],
      quarantinedIds: [POISON],
      droppedIds: [DROPPED],
      hits: [
        { entityId: KEPT, title: '正常' },
        { entityId: POISON, title: '隔离' },
        { entityId: DROPPED, title: '未展示' },
      ],
    })).toEqual({ [KEPT]: 'kept', [POISON]: 'quarantined', [DROPPED]: 'dropped' })
  })

  it('未出现在任何集合里的 hits 按 kept；keptIds 里的实体没有 hits 也算 kept', () => {
    const result = dispositions({
      traceId: 'trc_2',
      kind: 't0',
      injected: true,
      keptIds: [INDEX],
      hits: [{ entityId: KEPT, title: 'T0 可见偏好' }],
    })
    expect(result).toEqual({ [KEPT]: 'kept', [INDEX]: 'kept' })
    expect(receiptKeptHits({
      traceId: 'trc_2',
      kind: 't0',
      injected: true,
      keptIds: [INDEX],
      hits: [{ entityId: KEPT, title: 'T0 可见偏好' }],
    }).map(hit => hit.entityId).sort()).toEqual([INDEX, KEPT].sort())
  })
})

describe('resident_trace → receipt（现有 JSONB 约定）', () => {
  it('T0 按 section 的 kept/quarantined 与 entityIds 派生；索引/头/收据段不伪造命中', () => {
    const trace: ResidentTraceInput = {
      traceId: 'trc_t0',
      sessionId: 'session-1',
      turnId: '1',
      budgetTokens: 300,
      usedTokens: 100,
      text: '[OMB 常驻]',
      sections: [
        { name: 'header', tokens: 5, kept: true, text: '头', entityIds: [] },
        { name: 'preferences', tokens: 20, kept: true, text: '偏好', entityIds: [KEPT] },
        {
          name: 'states',
          tokens: 20,
          kept: true,
          text: '状态',
          entityIds: [POISON],
          ...({ quarantined: true } as object),
        },
        { name: 'index', tokens: 10, kept: true, text: '索引', entityIds: [INDEX] },
        { name: 'injection-receipt', tokens: 10, kept: true, text: '{"keptIds":[]}', entityIds: [KEPT, INDEX] },
      ],
      droppedSections: [],
    }
    const receipt = adoptionReceiptFromResidentTrace(trace)
    expect(receipt).toMatchObject({ traceId: 'trc_t0', kind: 't0', sessionId: 'session-1', injected: true })
    expect(receipt.keptIds).toEqual([KEPT])
    expect(receipt.quarantinedIds).toEqual([POISON])
    expect(receipt.droppedIds).toEqual([])
  })

  it('T1 单 injection-receipt section 解析 JSON 的 kept/quarantined', () => {
    const receipt = adoptionReceiptFromResidentTrace({
      traceId: 'trc_t1',
      budgetTokens: 400,
      usedTokens: 80,
      text: '[OMB 事件召回]',
      sections: [{
        name: 'injection-receipt',
        tokens: 80,
        kept: true,
        entityIds: [KEPT, POISON],
        text: JSON.stringify({
          injected: true,
          budgetTokens: 400,
          usedTokens: 80,
          textHash: 'hash',
          keptIds: [KEPT, POISON],
          quarantinedIds: [POISON],
          droppedIds: [DROPPED],
        }),
      }],
      droppedSections: [],
    })
    expect(receipt).toMatchObject({ kind: 't1', injected: true, textHash: 'hash', budgetTokens: 400 })
    expect(receipt.keptIds).toEqual([KEPT, POISON])
    expect(receipt.quarantinedIds).toEqual([POISON])
    expect(receipt.droppedIds).toEqual([DROPPED])
  })
})

describe('receipt 可见性：采用候选只来自 kept 且未隔离', () => {
  const hits = [
    { id: KEPT, title: '正常' },
    { id: POISON, title: '隔离' },
    { id: DROPPED, title: '未展示' },
  ]

  it('有 receipt 时取 kept 且未隔离的交集', () => {
    expect(receiptVisibleHits(hits, {
      keptIds: [KEPT, POISON],
      quarantinedIds: [POISON],
    }).map(hit => hit.id)).toEqual([KEPT])
  })

  it('没有 receipt 时退回调用点给出的可见 hits（T0 notice）', () => {
    expect(receiptVisibleHits(hits, undefined).map(hit => hit.id)).toEqual([KEPT, POISON, DROPPED])
  })
})
