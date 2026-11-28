import { describe, expect, it } from 'vitest'
import type { ChannelHit } from '../../../../packages/v7/src/ports/search.js'
import { DEFAULT_RETRIEVAL_CONFIG, createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import { collectSeeds } from '../../../../packages/v7/src/retrieval/expand.js'
import { applyExpansions, fuseStageOne } from '../../../../packages/v7/src/retrieval/fuse.js'
import { gateCandidates } from '../../../../packages/v7/src/retrieval/gate.js'
import type { StageOneChannel } from '../../../../packages/v7/src/retrieval/types.js'
import { FIXED_NOW, FakeStore, expansion, hit, makeEngine, summary } from './fake.js'

const MANUAL_WEIGHTS = DEFAULT_RETRIEVAL_CONFIG.scenarios.manual.weights
const RRF_K = DEFAULT_RETRIEVAL_CONFIG.rrfK

function hitsOf(
  ...entries: readonly (readonly [StageOneChannel, readonly ChannelHit[]])[]
): ReadonlyMap<StageOneChannel, readonly ChannelHit[]> {
  return new Map(entries)
}

function fuse(hits: ReadonlyMap<StageOneChannel, readonly ChannelHit[]>, config = DEFAULT_RETRIEVAL_CONFIG) {
  return [...fuseStageOne(hits, config.scenarios.manual.weights, config.rrfK).values()]
}

describe('融合层门控：绝对 RRF 下限不再承担相关性过滤（RET-07 回归）', () => {
  it('给定单通道末位 state_board 当门控则旧的 0.001818 情形不再默认通过', () => {
    const weak = hit('mem_weak', 50, 0.9, 'state_board')
    const strong = hit('mem_strong', 1, 0.5, 'fulltext')
    const candidates = fuse(hitsOf(['state_board', [weak]], ['fulltext', [strong]]))
    const weakFused = candidates.find(candidate => candidate.entityId === 'mem_weak')?.fused ?? 0

    // 先证明这正是旧规则的漏洞：融合分高于旧的绝对下限 0.0015。
    expect(weakFused).toBeCloseTo(0.2 / (60 + 50), 12)
    expect(weakFused).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.fusedFloor)

    const outcome = gateCandidates(candidates, DEFAULT_RETRIEVAL_CONFIG)

    expect(outcome.passed.map(candidate => candidate.entityId)).toEqual(['mem_strong'])
    expect(outcome.belowFused).toBe(0)
    expect(outcome.belowConsensus).toBe(1)
    expect(outcome.belowRelative).toBe(0)
    expect(outcome.rejected).toHaveLength(1)
    expect(outcome.rejected[0]).toMatchObject({
      entityId: 'mem_weak',
      code: 'no-consensus',
      channels: 1,
      rank: 50,
    })
    // 参照分是本轮最高融合分：相对比例只有 11%，两条规则都会拒绝它。
    expect(outcome.floors.reference).toBeCloseTo(1 / 61, 12)
    expect(weakFused / (outcome.floors.reference ?? 1)).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.fusionGate.relativeFloor)
  })

  it('给定同样的 state_board 命中但在通道第 3 名当门控则作为精确单通道命中保留', () => {
    const precise = hit('mem_precise', 3, 0.9, 'state_board')
    const strong = hit('mem_strong', 1, 0.5, 'fulltext')
    const outcome = gateCandidates(
      fuse(hitsOf(['state_board', [precise]], ['fulltext', [strong]])),
      DEFAULT_RETRIEVAL_CONFIG,
    )

    // 融合分只有参照的 19%（低于 relativeFloor），但名次 ≤ singleChannelRank，不能误杀。
    const preciseFused = 0.2 / (60 + 3)
    expect(preciseFused / (1 / 61)).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.fusionGate.relativeFloor)
    expect(outcome.passed.map(candidate => candidate.entityId)).toEqual(['mem_strong', 'mem_precise'])
    expect(outcome.rejected).toEqual([])
  })

  it('给定两个通道都在深名次当门控则通道共识让候选通过（不是只看单通道名次）', () => {
    const outcome = gateCandidates(
      fuse(hitsOf(
        ['fulltext', [hit('mem_multi', 40, 0.5, 'fulltext')]],
        ['vector', [hit('mem_multi', 40, 0.8, 'vector')]],
      )),
      DEFAULT_RETRIEVAL_CONFIG,
    )

    expect(outcome.passed.map(candidate => candidate.entityId)).toEqual(['mem_multi'])
    expect(outcome.belowConsensus).toBe(0)
    expect(outcome.belowRelative).toBe(0)
  })

  it('给定两通道但融合分只有参照的 27% 当门控则被相对门控淘汰并带比例证据', () => {
    const candidates = fuse(hitsOf(
      ['fulltext', [hit('mem_top', 1, 0.5, 'fulltext')]],
      ['vector', [hit('mem_top', 1, 0.8, 'vector')]],
      ['state_board', [hit('mem_tail', 20, 0.9, 'state_board')]],
      ['single_char', [hit('mem_tail', 20, 0.9, 'single_char')]],
    ))

    const outcome = gateCandidates(candidates, DEFAULT_RETRIEVAL_CONFIG)

    expect(outcome.passed.map(candidate => candidate.entityId)).toEqual(['mem_top'])
    expect(outcome.belowRelative).toBe(1)
    expect(outcome.rejected[0]).toMatchObject({
      entityId: 'mem_tail',
      code: 'below-relative',
      channels: 2,
      rank: 20,
      floor: DEFAULT_RETRIEVAL_CONFIG.fusionGate.relativeFloor,
    })
    expect(outcome.rejected[0]?.ratio ?? 1).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.fusionGate.relativeFloor)
    expect(outcome.rejected[0]?.reference).toBeCloseTo(candidates.find(c => c.entityId === 'mem_top')?.fused ?? 0, 12)
  })

  it('给定图扩展候选当门控则只看来源种子名次：种子精确的 1/2 跳保留，深种子的扩展拒绝', () => {
    const config = DEFAULT_RETRIEVAL_CONFIG
    const stageOne = hitsOf(['fulltext', [
      hit('mem_seed', 1, 0.8, 'fulltext'),
      hit('mem_deep', 20, 0.5, 'fulltext'),
    ]])
    const candidates = fuseStageOne(stageOne, MANUAL_WEIGHTS, RRF_K)
    applyExpansions(
      candidates,
      [
        expansion({ entityId: 'mem_hop1', fromId: 'mem_seed', hop: 1, score: 0.5, viaLinkId: 'lnk_1' }),
        expansion({ entityId: 'mem_hop2', fromId: 'mem_seed', hop: 2, score: 0.25, viaLinkId: 'lnk_2' }),
        expansion({ entityId: 'mem_weak', fromId: 'mem_deep', hop: 1, score: 0.5, viaLinkId: 'lnk_3' }),
      ],
      collectSeeds(stageOne, config),
      new Map(),
      MANUAL_WEIGHTS,
      config,
    )

    const outcome = gateCandidates([...candidates.values()], config)
    const passedIds = outcome.passed.map(candidate => candidate.entityId)

    // 1 跳和 2 跳都来自 rank 1 的精确种子：保留（跳数只影响衰减，不影响门控）。
    expect(passedIds).toContain('mem_hop1')
    expect(passedIds).toContain('mem_hop2')
    // 深种子（rank 20）的单通道扩展既没有通道共识也没有排名共识。
    expect(passedIds).not.toContain('mem_weak')
    expect(outcome.rejected.map(entry => entry.entityId)).toContain('mem_weak')
    expect(outcome.rejected.find(entry => entry.entityId === 'mem_weak')).toMatchObject({
      code: 'no-consensus',
      channels: 1,
      rank: 20,
    })
  })

  it('给定场景级校准当门控则用场景阈值而不是全局阈值', () => {
    const candidates = fuse(hitsOf(['state_board', [hit('mem_board', 8, 0.9, 'state_board')]]))

    expect(gateCandidates(candidates, createRetrievalConfig()).passed).toHaveLength(0)

    const sessionStart = createRetrievalConfig()
    expect(sessionStart.scenarios['session-start'].gate?.singleChannelRank).toBe(10)
    // 引擎/计划按场景取门控；这里直接用场景门控构造配置，模拟计划里的快照。
    const scenarioConfig = {
      ...sessionStart,
      fusionGate: sessionStart.scenarios['session-start'].gate ?? sessionStart.fusionGate,
    }
    expect(gateCandidates(candidates, scenarioConfig).passed.map(candidate => candidate.entityId)).toEqual(['mem_board'])
  })

  it('给定全局门控覆盖当创建配置则未校准场景跟随全局、校准场景保留自己的差分', () => {
    const config = createRetrievalConfig({ fusionGate: { relativeFloor: 0.5 } })

    expect(config.fusionGate).toEqual({ relativeFloor: 0.5, minChannels: 2, singleChannelRank: 5 })
    expect(config.scenarios.manual.gate).toEqual({ relativeFloor: 0.5, minChannels: 2, singleChannelRank: 5 })
    expect(config.scenarios['session-start'].gate).toEqual({ relativeFloor: 0.5, minChannels: 2, singleChannelRank: 10 })
  })
})

describe('门控原因在引擎层可见', () => {
  it('给定只有一个弱单通道候选当召回则返回 below-threshold 并逐条给出 no-consensus 理由', async () => {
    const store = new FakeStore()
    store.channelHits.state_board = [hit('mem_weak', 50, 0.9, 'state_board')]
    store.summariesById.set('mem_weak', summary({ id: 'mem_weak' }))

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits).toHaveLength(0)
    expect(result.emptyReason?.code).toBe('below-threshold')
    expect(result.emptyReason?.details).toEqual({ belowRaw: 0, belowFused: 0, belowConsensus: 1 })
    expect(result.emptyReason?.message).toContain('whyNot：no-consensus entity=mem_weak channels=1 rank=50 minChannels=2')
  })

  it('给定有命中也有淘汰当召回则 warning 同时报出四类门控计数', async () => {
    const store = new FakeStore()
    store.channelHits.fulltext = [hit('mem_strong', 1, 0.5, 'fulltext')]
    store.channelHits.state_board = [
      hit('mem_weak', 50, 0.9, 'state_board'),
      hit('mem_precise', 2, 0.9, 'state_board'),
    ]
    for (const id of ['mem_strong', 'mem_weak', 'mem_precise']) store.summariesById.set(id, summary({ id }))

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW })

    expect(result.hits.map(entry => entry.entityId)).toEqual(['mem_strong', 'mem_precise'])
    expect(result.warnings.some(warning => warning.includes('belowRaw=0')
      && warning.includes('belowRelative=0')
      && warning.includes('noConsensus=1'))).toBe(true)
  })
})
