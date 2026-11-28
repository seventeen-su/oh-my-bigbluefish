import { describe, expect, it } from 'vitest'
import type { ChannelHit } from '../../../../packages/v7/src/ports/search.js'
import { DEFAULT_RETRIEVAL_CONFIG, createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import { explainEmpty, explainFiltered, explainHit, explainWhyNot } from '../../../../packages/v7/src/retrieval/explain.js'
import { collectSeeds } from '../../../../packages/v7/src/retrieval/expand.js'
import { applyExpansions, fuseStageOne } from '../../../../packages/v7/src/retrieval/fuse.js'
import { gateCandidates } from '../../../../packages/v7/src/retrieval/gate.js'
import type {
  ChannelReport,
  ChannelStatus,
  StageOneChannel,
} from '../../../../packages/v7/src/retrieval/types.js'
import { expansion, hit } from './fake.js'

const MANUAL_WEIGHTS = DEFAULT_RETRIEVAL_CONFIG.scenarios.manual.weights
const DEFAULT_RRF_K = DEFAULT_RETRIEVAL_CONFIG.rrfK

function hitsOf(
  ...entries: readonly (readonly [StageOneChannel, readonly ChannelHit[]])[]
): ReadonlyMap<StageOneChannel, readonly ChannelHit[]> {
  return new Map(entries)
}

function reports(
  ...entries: readonly (readonly [StageOneChannel, ChannelStatus])[]
): ChannelReport[] {
  return entries.map(([channel, status]) => ({ channel, status, hitCount: status === 'ok' ? 1 : 0 }))
}

const EMPTY_REPORTS = reports(
  ['trigger', 'empty'],
  ['fulltext', 'empty'],
  ['single_char', 'skipped'],
  ['vector', 'empty'],
  ['time', 'empty'],
  ['state_board', 'empty'],
)

const FAILED_REPORTS = reports(
  ['trigger', 'failed'],
  ['fulltext', 'failed'],
  ['single_char', 'skipped'],
  ['vector', 'failed'],
  ['time', 'failed'],
  ['state_board', 'failed'],
)

const EMPTY_GATE = gateCandidates([], DEFAULT_RETRIEVAL_CONFIG)

describe('融合：加权 RRF 与每通道贡献', () => {
  it('给定默认配置当融合则 RRF k=60 且单通道第一名贡献为 weight/(60+rank)', () => {
    expect(DEFAULT_RRF_K).toBe(60)

    const fused = fuseStageOne(
      hitsOf(['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]]),
      MANUAL_WEIGHTS,
      DEFAULT_RRF_K,
    )

    // manual.fulltext=1：1/(60+1)。
    expect(fused.get('mem_a')?.fused).toBeCloseTo(1 / 61, 12)
    expect(fused.get('mem_a')?.contributionByChannel.get('fulltext')).toBeCloseTo(1 / 61, 12)
  })

  it('给定场景权重不同当同一触发命中融合则 tool-before 得分按 1.4 加权而 manual 按 0.4', () => {
    const hits = hitsOf(['trigger', [hit('mem_b', 1, 1, 'trigger')]])

    const manual = fuseStageOne(hits, MANUAL_WEIGHTS, DEFAULT_RRF_K).get('mem_b')
    const toolBefore = fuseStageOne(
      hits,
      DEFAULT_RETRIEVAL_CONFIG.scenarios['tool-before'].weights,
      DEFAULT_RRF_K,
    ).get('mem_b')

    expect(manual?.fused).toBeCloseTo(0.4 / 61, 12)
    expect(toolBefore?.fused).toBeCloseTo(1.4 / 61, 12)
    expect((toolBefore?.fused ?? 0) / (manual?.fused ?? 1)).toBeCloseTo(3.5, 12)
  })

  it('给定同一实体命中两通道当融合则每通道贡献分别记录且求和等于融合分', () => {
    const fused = fuseStageOne(
      hitsOf(
        ['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]],
        ['vector', [hit('mem_a', 2, 0.8, 'vector')]],
      ),
      MANUAL_WEIGHTS,
      DEFAULT_RRF_K,
    )
    const candidate = fused.get('mem_a')

    expect(candidate?.contributionByChannel.get('fulltext')).toBeCloseTo(1 / 61, 12)
    expect(candidate?.contributionByChannel.get('vector')).toBeCloseTo(1 / 62, 12)
    expect(candidate?.rankByChannel.get('vector')).toBe(2)
    const contributionSum = [...(candidate?.contributionByChannel.values() ?? [])]
      .reduce((sum, value) => sum + value, 0)
    expect(contributionSum).toBeCloseTo(candidate?.fused ?? 0, 12)
  })

  it('给定一跳扩展当融合则 links 贡献来自 links 权重×衰减且原始分是种子分×衰减', () => {
    const config = createRetrievalConfig({ scenarios: { manual: { weights: { links: 1 } } } })
    const weights = config.scenarios.manual.weights
    const stageOne = hitsOf(['fulltext', [hit('mem_a', 1, 0.8, 'fulltext')]])
    const candidates = fuseStageOne(stageOne, weights, config.rrfK)

    applyExpansions(
      candidates,
      [expansion({ entityId: 'mem_b', fromId: 'mem_a', hop: 1, score: 0.5 })],
      collectSeeds(stageOne, config),
      new Map(),
      weights,
      config,
    )

    const candidate = candidates.get('mem_b')
    expect(candidate?.rawByChannel.get('links')).toBeCloseTo(0.4, 12)
    expect(candidate?.contributionByChannel.get('links')).toBeCloseTo(0.5 / 61, 12)
    expect(candidate?.link?.seedId).toBe('mem_a')
    expect(candidate?.link?.hop).toBe(1)
  })
})

describe('门控：原始分/融合分下限与 below 统计', () => {
  it('给定原始分低于通道下限当门控则整条候选淘汰并记录差额通道', () => {
    const config = createRetrievalConfig({ channelFloors: { fulltext: 0.2 } })
    const candidates = [...fuseStageOne(
      hitsOf(['fulltext', [hit('mem_a', 1, 0.1, 'fulltext')]]),
      MANUAL_WEIGHTS,
      config.rrfK,
    ).values()]

    const outcome = gateCandidates(candidates, config)

    expect(outcome.passed).toHaveLength(0)
    expect(outcome.belowRaw).toBe(1)
    expect(outcome.belowFused).toBe(0)
    expect(outcome.rejected).toHaveLength(1)
    expect(outcome.rejected[0]).toMatchObject({
      entityId: 'mem_a',
      code: 'below-raw',
      channel: 'fulltext',
      rawScore: 0.1,
      floor: 0.2,
    })
    expect(outcome.rejected[0]?.fused).toBeCloseTo(1 / 61, 12)
    expect(outcome.floors.channel.fulltext).toBe(0.2)
    expect(outcome.floors.fused).toBe(config.fusedFloor)
  })

  it('给定原始分达标但融合分低于 fusedFloor 当门控则记为 below-fused 并带上融合分下限', () => {
    const config = createRetrievalConfig({ channelFloors: { fulltext: 0 }, fusedFloor: 0.02 })
    const candidates = [...fuseStageOne(
      hitsOf(['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]]),
      MANUAL_WEIGHTS,
      config.rrfK,
    ).values()]

    const outcome = gateCandidates(candidates, config)

    expect(outcome.passed).toHaveLength(0)
    expect(outcome.belowRaw).toBe(0)
    expect(outcome.belowFused).toBe(1)
    expect(outcome.rejected[0]).toMatchObject({ code: 'below-fused', floor: 0.02 })
    expect(outcome.rejected[0]?.fused).toBeCloseTo(1 / 61, 12)
  })

  it('给定通道下限覆盖当门控则只淘汰低于该通道下限的候选且统计随之变化', () => {
    const fused = fuseStageOne(
      hitsOf(
        ['fulltext', [hit('mem_a', 1, 0.15, 'fulltext')]],
        ['vector', [hit('mem_b', 1, 0.8, 'vector')]],
      ),
      MANUAL_WEIGHTS,
      60,
    )
    const candidates = [...fused.values()]

    const defaults = gateCandidates(candidates, DEFAULT_RETRIEVAL_CONFIG)
    expect(defaults.passed.map(candidate => candidate.entityId)).toEqual(['mem_a', 'mem_b'])
    expect(defaults.belowRaw).toBe(0)
    expect(defaults.belowFused).toBe(0)

    const strictVector = gateCandidates(candidates, createRetrievalConfig({ channelFloors: { vector: 0.9 } }))
    expect(strictVector.passed.map(candidate => candidate.entityId)).toEqual(['mem_a'])
    expect(strictVector.belowRaw).toBe(1)
    expect(strictVector.rejected[0]).toMatchObject({
      entityId: 'mem_b',
      code: 'below-raw',
      channel: 'vector',
      rawScore: 0.8,
      floor: 0.9,
    })
  })
})

describe('结果解释 why', () => {
  it('给定单通道命中当解释则 why 含通道名次/原始分/贡献/融合分/先验/最终分', () => {
    const candidate = fuseStageOne(
      hitsOf(['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]]),
      MANUAL_WEIGHTS,
      DEFAULT_RRF_K,
    ).get('mem_a')
    if (candidate === undefined) throw new Error('候选缺失：测试夹具不成立')

    const why = explainHit({
      candidate,
      prior: { factor: 1.05, reasons: ['prior:category:fact=×1.0500'] },
      score: (1 / 61) * 1.05,
    })

    expect(why).toEqual([
      'channel:fulltext#1 raw=0.5000 contribution=0.0164',
      'rrf=0.0164',
      'prior:category:fact=×1.0500',
      'score=0.0172',
    ])
  })

  it('给定图扩展命中当解释则 why 带链接通道贡献与种子/跳数/衰减证据', () => {
    const config = createRetrievalConfig({ scenarios: { manual: { weights: { links: 1 } } } })
    const weights = config.scenarios.manual.weights
    const stageOne = hitsOf(['fulltext', [hit('mem_a', 1, 0.8, 'fulltext')]])
    const candidates = fuseStageOne(stageOne, weights, config.rrfK)
    applyExpansions(
      candidates,
      [expansion({ entityId: 'mem_b', fromId: 'mem_a', hop: 1, score: 0.5, viaLinkId: 'lnk_1' })],
      collectSeeds(stageOne, config),
      new Map(),
      weights,
      config,
    )
    const candidate = candidates.get('mem_b')
    if (candidate === undefined) throw new Error('候选缺失：测试夹具不成立')

    const why = explainHit({ candidate, prior: { factor: 1, reasons: [] }, score: candidate.fused })

    expect(why).toContain('channel:links raw=0.4000 contribution=0.0082')
    expect(why).toContain('link:hop1 seed=mem_a decay=0.5000 via=lnk_1')
    expect(why).toContain('rrf=0.0082')
    expect(why).toContain('score=0.0082')
  })
})

describe('空结果解释 whyNot', () => {
  it('给定空查询当解释则 whyNot 标为 empty-query', () => {
    const whyNot = explainWhyNot({
      query: '   ',
      stageOneHitCount: 0,
      reports: EMPTY_REPORTS,
      gate: EMPTY_GATE,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(whyNot).toEqual([{ code: 'empty-query', message: 'empty-query 归一化后查询为空' }])
  })

  it('给定六通道零命中当解释则 whyNot 列出每通道状态', () => {
    const whyNot = explainWhyNot({
      query: 'find the bug',
      stageOneHitCount: 0,
      reports: EMPTY_REPORTS,
      gate: EMPTY_GATE,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(whyNot).toHaveLength(1)
    expect(whyNot[0]?.code).toBe('no-stage-one-hits')
    expect(whyNot[0]?.message).toBe(
      'no-stage-one-hits channels=trigger:empty,fulltext:empty,single_char:skipped,vector:empty,time:empty,state_board:empty',
    )
  })

  it('给定被尝试的通道全部失败当解释则 whyNot 标为 all-channels-failed 并列出通道', () => {
    const whyNot = explainWhyNot({
      query: 'err',
      stageOneHitCount: 0,
      reports: FAILED_REPORTS,
      gate: EMPTY_GATE,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(whyNot).toEqual([
      {
        code: 'all-channels-failed',
        message: 'all-channels-failed channels=trigger:failed,fulltext:failed,vector:failed,time:failed,state_board:failed：没有可用通道，不代表库里没有相关内容',
      },
    ])
  })

  it('给定失败与不可用混合但没有通道完成当解释则仍标 all-channels-failed（不误报无命中）', () => {
    const whyNot = explainWhyNot({
      query: 'err',
      stageOneHitCount: 0,
      reports: reports(
        ['trigger', 'failed'],
        ['fulltext', 'failed'],
        ['single_char', 'skipped'],
        ['vector', 'unavailable'],
        ['time', 'failed'],
        ['state_board', 'failed'],
      ),
      gate: EMPTY_GATE,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(whyNot).toHaveLength(1)
    expect(whyNot[0]?.code).toBe('all-channels-failed')
    expect(whyNot[0]?.message).toContain('vector:unavailable')
  })

  it('给定有通道完成但零命中、其余失败当解释则标 no-stage-one-hits 而不是全部失败', () => {
    const whyNot = explainWhyNot({
      query: 'err',
      stageOneHitCount: 0,
      reports: reports(
        ['trigger', 'failed'],
        ['fulltext', 'empty'],
        ['single_char', 'skipped'],
        ['vector', 'unavailable'],
        ['time', 'failed'],
        ['state_board', 'empty'],
      ),
      gate: EMPTY_GATE,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(whyNot[0]?.code).toBe('no-stage-one-hits')
    expect(whyNot[0]?.message).toBe(
      'no-stage-one-hits channels=trigger:failed,fulltext:empty,single_char:skipped,vector:unavailable,time:failed,state_board:empty',
    )
  })

  it('给定候选被双门控淘汰当解释则 whyNot 逐条给出通道/原始分/融合分与下限', () => {
    const config = createRetrievalConfig({ channelFloors: { fulltext: 0.2 }, fusedFloor: 0.02 })
    const candidates = [
      ...fuseStageOne(
        hitsOf(
          ['fulltext', [hit('mem_a', 1, 0.1, 'fulltext')]],
          ['vector', [hit('mem_b', 1, 0.8, 'vector')]],
        ),
        MANUAL_WEIGHTS,
        config.rrfK,
      ).values(),
    ]
    const gate = gateCandidates(candidates, config)
    expect(gate.belowRaw).toBe(1)
    expect(gate.belowFused).toBe(1)

    const whyNot = explainWhyNot({
      query: 'needle',
      stageOneHitCount: 2,
      reports: reports(['trigger', 'ok'], ['fulltext', 'ok'], ['single_char', 'skipped'], ['vector', 'ok'], ['time', 'empty'], ['state_board', 'empty']),
      gate,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(whyNot.map(entry => entry.code)).toEqual(['below-raw', 'below-fused'])
    expect(whyNot[0]?.message).toBe('below-raw entity=mem_a channel=fulltext raw=0.1000 floor=0.2000')
    expect(whyNot[1]?.message).toBe('below-fused entity=mem_b fused=0.0164 floor=0.0200')
  })

  it('给定候选通过门控但被归档过滤当解释则 whyNot 标为 filtered-archived', () => {
    const gate = gateCandidates(
      [...fuseStageOne(
        hitsOf(['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]]),
        MANUAL_WEIGHTS,
        DEFAULT_RRF_K,
      ).values()],
      DEFAULT_RETRIEVAL_CONFIG,
    )
    expect(gate.passed).toHaveLength(1)

    const whyNot = explainWhyNot({
      query: 'needle',
      stageOneHitCount: 1,
      reports: EMPTY_REPORTS,
      gate,
      filteredOut: 1,
      summariesFailed: false,
      filteredReasons: [explainFiltered('archived', 'mem_a')],
    })

    expect(whyNot).toEqual([{ code: 'filtered-archived', message: 'filtered-archived entity=mem_a' }])
  })

  it('给定摘要读取失败当解释则 whyNot 标为 summaries-failed', () => {
    const gate = gateCandidates(
      [...fuseStageOne(
        hitsOf(['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]]),
        MANUAL_WEIGHTS,
        DEFAULT_RRF_K,
      ).values()],
      DEFAULT_RETRIEVAL_CONFIG,
    )

    const whyNot = explainWhyNot({
      query: 'needle',
      stageOneHitCount: 1,
      reports: EMPTY_REPORTS,
      gate,
      filteredOut: 0,
      summariesFailed: true,
      filteredReasons: [],
    })

    expect(whyNot).toEqual([
      { code: 'summaries-failed', message: 'summaries-failed 实体摘要读取失败，候选无法解释' },
    ])
  })

  it('给定带事实的过滤当解释则 whyNot 行带 kind/status 期望值', () => {
    expect(explainFiltered('kind', 'mem_a', 'kind=chain expected=memory')).toEqual({
      code: 'filtered-kind',
      message: 'filtered-kind entity=mem_a kind=chain expected=memory',
    })
    expect(explainFiltered('status', 'mem_b', 'status=done expected=blocked')).toEqual({
      code: 'filtered-status',
      message: 'filtered-status entity=mem_b status=done expected=blocked',
    })
  })
})

describe('空结果装配 explainEmpty', () => {
  it('给定门控全部淘汰当装配则 code/details 保持原形状且 message 追加 whyNot', () => {
    const config = createRetrievalConfig({ channelFloors: { fulltext: 0.2 } })
    const gate = gateCandidates(
      [...fuseStageOne(
        hitsOf(['fulltext', [hit('mem_a', 1, 0.1, 'fulltext')]]),
        MANUAL_WEIGHTS,
        config.rrfK,
      ).values()],
      config,
    )

    const reason = explainEmpty({
      query: 'needle',
      stageOneHitCount: 1,
      reports: reports(['trigger', 'empty'], ['fulltext', 'ok'], ['single_char', 'skipped'], ['vector', 'empty'], ['time', 'empty'], ['state_board', 'empty']),
      gate,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(reason.code).toBe('below-threshold')
    expect(reason.details).toEqual({ belowRaw: 1, belowFused: 0 })
    expect(reason.message).toContain('whyNot：below-raw entity=mem_a channel=fulltext raw=0.1000 floor=0.2000')
  })

  it('给定归档过滤满额当装配则 details 只保留计数而 whyNot 说明过滤类别', () => {
    const gate = gateCandidates(
      [...fuseStageOne(
        hitsOf(['fulltext', [hit('mem_a', 1, 0.5, 'fulltext')]]),
        MANUAL_WEIGHTS,
        60,
      ).values()],
      DEFAULT_RETRIEVAL_CONFIG,
    )

    const reason = explainEmpty({
      query: 'needle',
      stageOneHitCount: 1,
      reports: reports(['trigger', 'empty'], ['fulltext', 'ok'], ['single_char', 'skipped'], ['vector', 'empty'], ['time', 'empty'], ['state_board', 'empty']),
      gate,
      filteredOut: 1,
      summariesFailed: false,
      filteredReasons: [explainFiltered('archived', 'mem_a')],
    })

    expect(reason.code).toBe('filtered-out')
    expect(reason.details).toEqual({ filteredOut: 1 })
    expect(reason.message).toContain('whyNot：filtered-archived entity=mem_a')
  })

  it('给定 whyNot 超过展开上限当装配则 message 只展开五条并带总数', () => {
    const hits = Array.from({ length: 8 }, (_, index) => hit(`mem_${index + 1}`, index + 1, 0.01, 'fulltext'))
    const gate = gateCandidates(
      [...fuseStageOne(hitsOf(['fulltext', hits]), MANUAL_WEIGHTS, 60).values()],
      DEFAULT_RETRIEVAL_CONFIG,
    )
    expect(gate.belowRaw).toBe(8)

    const reason = explainEmpty({
      query: 'needle',
      stageOneHitCount: 8,
      reports: reports(['trigger', 'empty'], ['fulltext', 'ok'], ['single_char', 'skipped'], ['vector', 'empty'], ['time', 'empty'], ['state_board', 'empty']),
      gate,
      filteredOut: 0,
      summariesFailed: false,
      filteredReasons: [],
    })

    expect(reason.message.match(/entity=mem_/g) ?? []).toHaveLength(5)
    expect(reason.message).toContain('；…共 8 条')
  })
})
