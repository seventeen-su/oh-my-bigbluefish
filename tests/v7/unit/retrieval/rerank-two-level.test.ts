import { describe, expect, it } from 'vitest'
import { createRetrievalConfig } from '../../../../packages/v7/src/retrieval/config.js'
import { FIXED_NOW, FakeStore, entity, hit, makeEngine, summary } from './fake.js'

const COUNT = 30

/** 30 个候选：每个都有 fulltext + vector 两个通道（一致性门控会全部放行），融合分严格递减。 */
function seedThirty(store: FakeStore, options: { readonly withFeatures: boolean } = { withFeatures: true }): string[] {
  const ids = Array.from({ length: COUNT }, (_, index) => `mem_${String(index + 1).padStart(2, '0')}`)
  store.channelHits.fulltext = ids.map((id, index) => hit(id, index + 1, 0.5, 'fulltext'))
  store.channelHits.vector = ids.map((id, index) => hit(id, index + 1, 0.8, 'vector'))
  for (const id of ids) {
    store.summariesById.set(id, summary({ id, category: 'fact' }))
    if (options.withFeatures) {
      store.entitiesById.set(id, entity({
        id,
        pinned: true,
        confidence: 1,
        accessCount: 10,
        adoptionCount: 10,
        origin: 'user',
      }))
    }
  }
  return ids
}

function fusedOf(index: number): number {
  // fulltext 与 vector 在 manual 场景权重都是 1：两个通道同名次 → 2/(60+rank)。
  return 2 / (60 + index + 1)
}

describe('两级重排：先全量摘要初排，再批量富化精排（RET-06 回归）', () => {
  it('给定 limit=30 与默认富化窗口 24 当精排则第 25/30 名不被截断位置压低', async () => {
    const store = new FakeStore()
    const ids = seedThirty(store)

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, limit: 30 })

    expect(result.hits).toHaveLength(COUNT)
    expect(result.hits.map(entry => entry.entityId)).toEqual(ids)

    const first = result.hits[0]
    const hit25 = result.hits[24]
    const hit30 = result.hits[29]
    // 所有实体特征相同 → 精排乘数相同，分数比必须只由融合分比决定。
    expect((hit25?.score ?? 0) / (first?.score ?? 1)).toBeCloseTo(fusedOf(24) / fusedOf(0), 9)
    expect((hit30?.score ?? 0) / (first?.score ?? 1)).toBeCloseTo(fusedOf(29) / fusedOf(0), 9)
    // 第 25 名确实拿到了实体级富化（旧实现只富化前 24 名，这里会缺 pinned 等乘数）。
    expect(hit25?.why.some(line => line.startsWith('prior:pinned='))).toBe(true)
    expect(hit30?.why.some(line => line.startsWith('prior:confidence:'))).toBe(true)
  })

  it('给定 30 个候选当精排则富化只打一次批量查询，不再逐条读实体', async () => {
    const store = new FakeStore()
    seedThirty(store)

    await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, limit: 30 })

    expect(store.priorFeaturesCalls).toHaveLength(1)
    expect(store.priorFeaturesCalls[0]).toHaveLength(COUNT)
    // 旧实现是 enrichIds.map(store.get) 的 N+1；现在一次批量查询，实体单读为 0。
    expect(store.getCalls).toEqual([])
    // 摘要也只读一次（精排不额外发查询、不轮询）。
    expect(store.summaryCalls).toHaveLength(1)
  })

  it('给定 limit 小于富化窗口当精排则窗口取 max(rerankEnrichTopK, limit)，不因 limit 变小而少富化', async () => {
    const store = new FakeStore()
    seedThirty(store)

    await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, limit: 10 })

    expect(store.priorFeaturesCalls[0]).toHaveLength(24)
  })

  it('给定汇总先验与富化先验当对比则窗口内外候选与同一套中性策略一致', async () => {
    const store = new FakeStore()
    const ids = seedThirty(store, { withFeatures: false })

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, limit: 30 })

    // 没有任何实体富化数据：全部候选按摘要级中性先验排序，分数比 = 融合分比。
    const first = result.hits[0]
    for (const [index, entry] of result.hits.entries()) {
      expect(entry.entityId).toBe(ids[index])
      expect(entry.score / (first?.score ?? 1)).toBeCloseTo(fusedOf(index) / fusedOf(0), 9)
      expect(entry.why.some(line => line.startsWith('prior:pinned='))).toBe(false)
    }
  })

  it('给定批量富化抛错当精排则全部候选退回中性先验并留 warning，结果仍返回', async () => {
    const store = new FakeStore()
    const ids = seedThirty(store)
    store.priorFeaturesError = new Error('feature boom')

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, limit: 30 })

    expect(result.hits.map(entry => entry.entityId)).toEqual(ids)
    expect(result.warnings.some(warning => warning.includes('批量富化失败') && warning.includes('feature boom'))).toBe(true)
    const first = result.hits[0]
    for (const [index, entry] of result.hits.entries()) {
      expect(entry.score / (first?.score ?? 1)).toBeCloseTo(fusedOf(index) / fusedOf(0), 9)
    }
  })

  it('给定富化只返回部分候选当精排则缺数据的候选按中性处理并报出数量', async () => {
    const store = new FakeStore()
    const ids = seedThirty(store)
    // 只有前 10 个实体有富化数据，其余 20 个按中性处理（不因位置被额外惩罚）。
    for (const [index, id] of ids.entries()) {
      if (index >= 10) store.entitiesById.delete(id)
    }

    const result = await makeEngine(store).recall({ query: 'needle', now: FIXED_NOW, limit: 30 })

    expect(result.warnings.some(warning => warning.includes('批量富化只返回 10/30'))).toBe(true)
    const neutral = result.hits[29]
    const neutralFactor = (neutral?.score ?? 0) / (neutral?.fusedScore ?? 1)
    // 中性 = category fact × recency（updatedAt 等于 now）：1.05 × 1.1。
    expect(neutralFactor).toBeCloseTo(1.05 * 1.1, 9)
    expect(neutral?.why.some(line => line.startsWith('prior:pinned='))).toBe(false)
  })

  it('给定存储未实现批量富化当召回两次则退化为中性并只提示一次', async () => {
    const store = new FakeStore()
    seedThirty(store)
    // 遮蔽原型方法：模拟只实现 summaries 的旧 Store。
    Object.defineProperty(store, 'priorFeatures', { value: undefined, configurable: true })
    const engine = makeEngine(store)

    const first = await engine.recall({ query: 'needle', now: FIXED_NOW, limit: 30 })
    const second = await engine.recall({ query: 'needle', now: FIXED_NOW, limit: 30 })

    expect(first.hits).toHaveLength(COUNT)
    expect(first.warnings.filter(warning => warning.includes('存储未实现批量富化读取'))).toHaveLength(1)
    expect(second.warnings.some(warning => warning.includes('存储未实现批量富化读取'))).toBe(false)
    expect((second.hits[0]?.score ?? 0) / (second.hits[29]?.score ?? 1)).toBeCloseTo(fusedOf(0) / fusedOf(29), 9)
  })

  it('给定窗口配置不同当召回则窗口随 rerankEnrichTopK 走（可审计的配置项）', async () => {
    const store = new FakeStore()
    seedThirty(store)

    await makeEngine(store, createRetrievalConfig({ rerankEnrichTopK: 5 })).recall({ query: 'needle', now: FIXED_NOW, limit: 30 })

    // 窗口 = max(5, 30)：仍然覆盖全部返回结果。
    expect(store.priorFeaturesCalls[0]).toHaveLength(COUNT)
  })
})
