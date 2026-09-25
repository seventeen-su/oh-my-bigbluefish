/**
 * 注入裁决（规划 §6.7）：`(relevance * novelty) / max(cost, 1)`。
 *
 * **`novelty` 项必须有反例**：两条说同一件事的候选，第二条价值显著低于第一条。
 * 这是修掉"注入 5 条说同一件事的记忆"的关键。
 */
import { describe, expect, it } from 'vitest'
import type { FocusState } from '../../../kernel/abi/index.js'
import {
  DEFAULT_CANDIDATE_CONSIDER_LIMIT,
  type Candidate,
  marginalValue,
  maxSimilarity,
  measuredCost,
  relevanceTo,
  selectForInjection,
  similarity,
  withMeasuredCost,
} from '../../../modules/context/admission.js'

const focus = (depth: FocusState['depth'] = 'standard'): FocusState => ({ depth, reason: '', setAt: 0 })

const candidate = (over: Partial<Candidate> & { id: string }): Candidate => ({
  text: over.text ?? over.id,
  relevance: over.relevance ?? 1,
  tokens: over.tokens ?? 100,
  ...over,
})

describe('similarity / maxSimilarity', () => {
  it('相同文本为 1；完全无关为 0；空对空视为同一件事', () => {
    expect(similarity('用户偏好简洁回答', '用户偏好简洁回答')).toBe(1)
    expect(similarity('用户偏好简洁回答', 'zzz qqq')).toBe(0)
    expect(similarity('', '')).toBe(1)
    expect(similarity('', '有内容')).toBe(0)
  })

  it('中文按字符二元组：换字序/加虚词仍是高相似', () => {
    const score = similarity('用户偏好简洁回答', '用户偏好简洁的回答')
    expect(score).toBeGreaterThan(0.6)
    expect(score).toBeLessThan(1)
  })

  it('西文按词比较', () => {
    expect(similarity('user prefers concise answers', 'user prefers concise answers')).toBe(1)
    expect(similarity('user prefers concise answers', 'system uses sqlite fts5')).toBe(0)
  })

  it('maxSimilarity：同 id 直接判 1；空集合为 0', () => {
    const item = candidate({ id: 'a', text: '完全不同的文本' })
    expect(maxSimilarity(item, [])).toBe(0)
    expect(maxSimilarity(item, [candidate({ id: 'a', text: '另一段文字' })])).toBe(1)
    expect(maxSimilarity(item, [candidate({ id: 'b', text: '完全不同的文本' })])).toBe(1)
  })
})

describe('marginalValue：novelty 反例（核心）', () => {
  it('第一条与第二条说同一件事时，第二条价值显著低于第一条', () => {
    const first = candidate({ id: 'm1', text: '用户偏好简洁回答，不要长篇解释', relevance: 1, tokens: 50 })
    const second = candidate({ id: 'm2', text: '用户偏好简洁的回答，不要长篇解释', relevance: 1, tokens: 50 })

    const firstValue = marginalValue(first, [], focus())
    const secondValue = marginalValue(second, [first], focus())

    expect(firstValue).toBeGreaterThan(0)
    // 显著更低：第二条的相似度 >0.6 ⇒ 价值不到第一条的一半
    expect(secondValue).toBeLessThan(firstValue / 2)
  })

  it('完全相同的内容：novelty = 0 ⇒ 价值 0（不再重复注入）', () => {
    const first = candidate({ id: 'm1', text: '同一条记忆' })
    const duplicate = candidate({ id: 'm2', text: '同一条记忆' })
    expect(marginalValue(duplicate, [first], focus())).toBe(0)
  })

  it('不同主题的候选不受已有内容影响（novelty 保持 1）', () => {
    const present = [candidate({ id: 'm1', text: '用户偏好简洁回答', tokens: 50 })]
    const other = candidate({ id: 'm2', text: '项目用 node:sqlite 存记忆', relevance: 1, tokens: 50 })
    expect(marginalValue(other, present, focus())).toBeCloseTo(1 / 50, 6)
  })

  it('成本越高价值越低（分母是真实测量的 token 数）', () => {
    const cheap = candidate({ id: 'a', text: '内容甲', tokens: 10 })
    const pricey = candidate({ id: 'b', text: '内容乙', tokens: 1000 })
    expect(marginalValue(cheap, [], focus())).toBeGreaterThan(marginalValue(pricey, [], focus()))
  })

  it('成本为 0 / 缺失时按 1 计（不是除以 0）', () => {
    expect(marginalValue(candidate({ id: 'a', tokens: 0 }), [], focus())).toBe(1)
    expect(marginalValue(candidate({ id: 'a', tokens: Number.NaN }), [], focus())).toBe(1)
  })

  it('相关性越界收敛、NaN 视为 0', () => {
    expect(marginalValue(candidate({ id: 'a', relevance: 5, tokens: 1 }), [], focus())).toBe(1)
    expect(marginalValue(candidate({ id: 'a', relevance: Number.NaN }), [], focus())).toBe(0)
  })
})

describe('relevanceTo：深度适配（§4.6 反向接口）', () => {
  it('声明了 depths 的候选只在对应档位有价值', () => {
    const deepOnly = candidate({ id: 'card', relevance: 1, depths: ['deep'] })
    expect(relevanceTo(deepOnly, focus('deep'))).toBe(1)
    expect(relevanceTo(deepOnly, focus('standard'))).toBe(0)
    expect(marginalValue(deepOnly, [], focus('quick'))).toBe(0)
  })

  it('未声明 depths 的候选对所有档位有效', () => {
    const any = candidate({ id: 'memo', relevance: 0.8 })
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      expect(relevanceTo(any, focus(depth))).toBeCloseTo(0.8, 6)
    }
  })

  it('focus 缺失时对"有深度门槛"的候选保守取 0', () => {
    expect(relevanceTo(candidate({ id: 'x', depths: ['deep'] }), undefined)).toBe(0)
  })
})

describe('selectForInjection：贪心 + 一次考虑上限', () => {
  const duplicates = (count: number): readonly Candidate[] =>
    Array.from({ length: count }, (_, index) =>
      candidate({ id: `m${index}`, text: '用户偏好简洁回答，不要长篇解释', relevance: 1, tokens: 50 }),
    )

  it('五条说同一件事的记忆 + 只推一条 ⇒ 只进第一条（修掉浪费的主要来源）', () => {
    const chosen = selectForInjection(duplicates(5), [], focus(), { pushLimit: 1 })
    expect(chosen.length).toBe(1)
    expect(chosen[0]?.id).toBe('m0')
  })

  it('可推两条时，第二条选**不同主题**的候选而不是重复项', () => {
    const pool = [
      ...duplicates(3),
      candidate({ id: 'other', text: '项目用 node:sqlite 存记忆', relevance: 0.9, tokens: 50 }),
    ]
    const chosen = selectForInjection(pool, [], focus(), { pushLimit: 2 })
    expect(chosen.map(item => item.id)).toEqual(['m0', 'other'])
  })

  it('pushLimit = 0（宽松/紧张档）不推任何东西', () => {
    expect(selectForInjection(duplicates(3), [], focus(), { pushLimit: 0 })).toEqual([])
    expect(selectForInjection(duplicates(3), [], focus())).toEqual([])
  })

  it('considerLimit 是"一次最多考虑几个候选"，取相关性最高的前 N 个', () => {
    const pool = [
      candidate({ id: 'low', text: '低相关', relevance: 0.1, tokens: 10 }),
      candidate({ id: 'high', text: '高相关', relevance: 0.9, tokens: 100 }),
      candidate({ id: 'mid', text: '中相关', relevance: 0.5, tokens: 10 }),
    ]
    const chosen = selectForInjection(pool, [], focus(), { pushLimit: 1, considerLimit: 1 })
    expect(chosen.map(item => item.id)).toEqual(['high'])
    expect(DEFAULT_CANDIDATE_CONSIDER_LIMIT).toBe(12)
  })

  it('已在场的内容同样压制 novelty（去重针对整个上下文，不只针对本次选择）', () => {
    const present = [candidate({ id: 'already', text: '用户偏好简洁回答，不要长篇解释' })]
    const chosen = selectForInjection(duplicates(2), present, focus(), { pushLimit: 1 })
    expect(chosen).toEqual([])
  })

  it('深度不适配的候选不会被选中', () => {
    const pool = [candidate({ id: 'card', text: '规则卡', relevance: 1, depths: ['deep'] })]
    expect(selectForInjection(pool, [], focus('quick'), { pushLimit: 1 })).toEqual([])
    expect(selectForInjection(pool, [], focus('deep'), { pushLimit: 1 }).length).toBe(1)
  })

  it('畸形输入不抛', () => {
    expect(selectForInjection(null as never, [], focus(), { pushLimit: 1 })).toEqual([])
    expect(selectForInjection([null as never, undefined as never], [], focus(), { pushLimit: 1 })).toEqual([])
    expect(marginalValue(null as never, null as never, focus())).toBe(0)
    expect(maxSimilarity(null as never, null as never)).toBe(0)
  })
})

describe('真实测量的成本', () => {
  const nodes = [
    { name: 'omb_recall', tokens: 321 },
    { name: 'persona', tokens: 1200 },
  ]

  it('measuredCost：找到就返回真实 token 数，找不到返回 null（不估算）', () => {
    expect(measuredCost(nodes, 'omb_recall')).toBe(321)
    expect(measuredCost(nodes, '不存在的块')).toBeNull()
    expect(measuredCost(undefined, 'omb_recall')).toBeNull()
    expect(measuredCost([{ name: 'x', tokens: Number.NaN }], 'x')).toBeNull()
  })

  it('withMeasuredCost：用测量值覆盖候选自带成本；测量缺失时拒绝该候选', () => {
    const measured = withMeasuredCost(candidate({ id: 'omb_recall', tokens: 9999 }), nodes)
    expect(measured?.tokens).toBe(321)
    expect(withMeasuredCost(candidate({ id: '没有价格的块' }), nodes)).toBeNull()
  })
})
