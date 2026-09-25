/**
 * 离线整合测试——规划 §5.6。
 *
 * 反例 ④ 在这里：**回响检测**——同源的三条痕迹塌缩为一条且 `useCount` 累加，
 * 而 `independentSources` 仍是 1（这才是防「相关性痕迹导致的假晋升」的判据）。
 *
 * 另外钉死：哈希分块（**不是 all-pairs**）、合并次数硬上限 200 超限即停、
 * 衰减只重排先验（不删行）、`supersedes` 只在来源等级够时发。
 */
import { describe, expect, it } from 'vitest'
import type { Edge, MemoryRecord } from '../../../kernel/abi/index.js'
import {
  DEFAULT_MERGE_LIMIT,
  blockingKeys,
  coreTokens,
  decayPrior,
  detectLexicalContradictions,
  isIndependentlyEvidenced,
  isNegated,
  jaccard,
  planConsolidation,
  promotionCandidates,
  shingles,
  sourceChain,
} from '../../../modules/memory/consolidate.js'
import { makeRecord } from './fakes.js'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

function edge(fromId: string, toId: string, type: Edge['type']): Edge {
  return { fromId, toId, type, createdAt: NOW }
}

describe('④ 回响检测：同源 N 条痕迹塌缩为一条并累加 useCount', () => {
  it('同 contentHash 的三条痕迹 → 一条，useCount 累加，独立来源仍是 1', () => {
    const text = '用户要求：不要自动提交 git'
    const traces: MemoryRecord[] = [
      makeRecord({ id: 't1', text, sourceRef: 'session:s1#turn:3', useCount: 2, assertedBy: 'user' }),
      makeRecord({ id: 't2', text, sourceRef: 'session:s1#turn:9', useCount: 1, assertedBy: 'model' }),
      makeRecord({ id: 't3', text, sourceRef: 'session:s1#turn:12', useCount: 4, assertedBy: 'model' }),
    ]
    const plan = planConsolidation({ records: traces }, { now: NOW })

    expect(plan.merges.length).toBe(1)
    const merge = plan.merges[0]
    expect(merge?.reason).toBe('exact-duplicate')
    expect(merge?.traces).toBe(3)
    expect(merge?.useCount).toBe(7) // 2 + 1 + 4：回响不产生新证据，但使用次数照实累加
    expect(merge?.absorbedIds).toEqual(['t2', 't3'])
    expect(merge?.keepId).toBe('t1') // user 断言 > model
    // 关键：三条痕迹同属一条 sourceRef 链 → **独立来源只有 1**
    expect(merge?.independentSources).toBe(1)
    expect(isIndependentlyEvidenced(merge!)).toBe(false)
    expect(promotionCandidates(plan)).toEqual([])
    // 塌缩用非破坏性的 validTo + supersededBy，不删行
    expect(plan.supersessions.map(s => s.id)).toEqual(['t2', 't3'])
    expect(plan.supersessions.every(s => s.supersededBy === 't1' && s.reason === 'merge')).toBe(true)
    expect(plan.erasures).toEqual([])
  })

  it('同链、措辞略有不同（近重复）→ 回响；different 链 → 近重复但不是回响', () => {
    const echo = planConsolidation(
      {
        records: [
          makeRecord({ id: 'e1', text: '构建产物不要提交到仓库里', sourceRef: 'session:s1#turn:1', useCount: 1 }),
          makeRecord({ id: 'e2', text: '构建产物不要提交到仓库中', sourceRef: 'session:s1#turn:7', useCount: 1 }),
        ],
      },
      { now: NOW },
    )
    expect(echo.merges[0]?.reason).toBe('echo-same-source')
    expect(echo.merges[0]?.independentSources).toBe(1)
    expect(echo.merges[0]?.useCount).toBe(2)

    // 两条独立会话里各自观察到同一结论 → 近重复，**两个独立来源**（够格谈晋升）
    const independent = planConsolidation(
      {
        records: [
          makeRecord({ id: 'i1', text: '构建产物不要提交到仓库里', sourceRef: 'session:s1#turn:1' }),
          makeRecord({ id: 'i2', text: '构建产物不要提交到仓库中', sourceRef: 'session:s2#turn:4' }),
        ],
      },
      { now: NOW },
    )
    expect(independent.merges[0]?.independentSources).toBe(2)
    expect(isIndependentlyEvidenced(independent.merges[0]!)).toBe(true)
    expect(promotionCandidates(independent)).toEqual([independent.merges[0]?.keepId])
  })

  it('同 sourceRef（同一次观察被写了两遍）即使内容不同也塌缩', () => {
    const plan = planConsolidation(
      {
        records: [
          makeRecord({ id: 'r1', text: '第一条观察：接口返回 429', sourceRef: 'session:s1#turn:1' }),
          makeRecord({ id: 'r2', text: '重试后仍然 429，限流未恢复', sourceRef: 'session:s1#turn:1' }),
        ],
      },
      { now: NOW },
    )
    expect(plan.merges.length).toBe(1)
    expect(plan.merges[0]?.reason).toBe('echo-same-source')
    expect(plan.merges[0]?.traces).toBe(2)
  })

  it('同一条链里的**不同事实**不塌缩（刻意的收窄：同链 ∧ 内容相近）', () => {
    const plan = planConsolidation(
      {
        records: [
          makeRecord({ id: 'd1', text: '项目用 pnpm 而不是 npm', sourceRef: 'session:s1#turn:1' }),
          makeRecord({ id: 'd2', text: '部署走 GitHub Actions 的 release 工作流', sourceRef: 'session:s1#turn:8' }),
          makeRecord({ id: 'd3', text: '用户偏好中文回复，术语保留英文原文', sourceRef: 'session:s1#turn:15' }),
        ],
      },
      { now: NOW },
    )
    expect(plan.merges).toEqual([])
    expect(plan.supersessions).toEqual([])
  })

  it('跨作用域的相同内容不合并（位置即权威，跨库不能合并）', () => {
    const plan = planConsolidation(
      {
        records: [
          makeRecord({ id: 'u1', text: '同一句话', scope: 'user' }),
          makeRecord({ id: 'p1', text: '同一句话', scope: 'project' }),
        ],
      },
      { now: NOW },
    )
    expect(plan.merges).toEqual([])
  })
})

describe('哈希分块：结构上不是 all-pairs', () => {
  it('300 条互不相似的记录：候选对比较次数远小于 n²/2', () => {
    const records = Array.from({ length: 300 }, (_, i) =>
      makeRecord({
        id: `n${i}`,
        text: `主题${i} 的唯一结论 observation-${i} keyword-${i * 13}`,
        sourceRef: `session:s${i}#turn:1`,
      }),
    )
    const plan = planConsolidation({ records }, { now: NOW })
    const allPairs = (300 * 299) / 2
    expect(plan.merges).toEqual([])
    expect(plan.stats.pairComparisons).toBeLessThan(300)
    expect(plan.stats.pairComparisons).toBeLessThan(allPairs / 100)
  })

  it('分块键把相似内容聚到一起：相似文本共享键，无关文本不共享', () => {
    const a = blockingKeys(shingles('构建产物不要提交到仓库里'))
    const b = blockingKeys(shingles('构建产物不要提交到仓库中'))
    const c = blockingKeys(shingles('完全无关的一条记忆：周三下午要开评审会'))
    const share = (x: readonly string[], y: readonly string[]): boolean => x.some(k => y.includes(k))
    expect(share(a, b)).toBe(true)
    expect(share(a, c)).toBe(false)
    expect(share(b, c)).toBe(false)
    expect(a.length).toBe(3)
  })

  it('候选对上限触顶即停并如实报告（第二道保险）', () => {
    // 病理语料：60 条几乎一样的记录 → 分块退化成一个稠密桶。
    // 上限就是为这种情形准备的：触顶即停，并如实报告只验证了前 N 对。
    const records = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ id: `m${i}`, text: `构建产物不要提交到仓库里 unique-marker-${i}`, sourceRef: `session:s${i}#turn:1` }),
    )
    const plan = planConsolidation({ records }, { now: NOW, maxPairComparisons: 10 })
    expect(plan.stats.pairComparisons).toBeLessThanOrEqual(10)
    expect(plan.notes.join('\n')).toContain('候选对比较达到上限')
    expect(plan.stats.candidatePairs).toBeGreaterThanOrEqual(plan.stats.pairComparisons)
  })
})

describe('合并次数硬上限：默认 200，超限即停', () => {
  it('300 组重复 → 只合并 200 组并置 truncated', () => {
    // 每组两条完全相同的痕迹；组间用唯一的拉丁 token 隔开（否则语料本身就在互相似）。
    const records: MemoryRecord[] = []
    for (let i = 0; i < 300; i += 1) {
      const text = `group-${i}-alpha group-${i}-beta group-${i}-gamma duplicate-marker`
      records.push(makeRecord({ id: `dup-${String(i).padStart(3, '0')}-a`, text }))
      records.push(makeRecord({ id: `dup-${String(i).padStart(3, '0')}-b`, text }))
    }
    const plan = planConsolidation({ records }, { now: NOW })
    expect(plan.merges.length).toBe(DEFAULT_MERGE_LIMIT)
    expect(plan.truncated).toBe(true)
    expect(plan.notes.join('\n')).toContain('达到合并上限 200')
    expect(plan.stats.mergedRecords).toBe(200)
  })

  it('上限可下调：mergeLimit=3', () => {
    const records: MemoryRecord[] = []
    for (let i = 0; i < 10; i += 1) {
      records.push(makeRecord({ id: `x${i}`, text: `内容 ${i}` }))
      records.push(makeRecord({ id: `y${i}`, text: `内容 ${i}` }))
    }
    const plan = planConsolidation({ records }, { now: NOW, mergeLimit: 3 })
    expect(plan.merges.length).toBe(3)
    expect(plan.truncated).toBe(true)
  })
})

describe('矛盾：发 conflicts_with；来源等级够才 supersedes', () => {
  it('user 断言的新条目取代 model 断言的旧条目（validTo 被设上）', () => {
    const records = [
      makeRecord({ id: 'old', text: '这个接口不支持批量写入（第一次实现时的限制）', observedAt: NOW - 10 * DAY, assertedBy: 'model' }),
      makeRecord({ id: 'new', text: '实测批量写入可用：1000 条压测全部成功，旧限制结论已过期', observedAt: NOW - DAY, assertedBy: 'user' }),
    ]
    const plan = planConsolidation({ records, contradictions: [{ aId: 'old', bId: 'new' }] }, { now: NOW })
    expect(plan.edges.map(e => `${e.type}:${e.fromId}->${e.toId}`)).toEqual([
      'conflicts_with:new->old',
      'supersedes:new->old',
    ])
    const supersession = plan.supersessions.find(s => s.id === 'old')
    expect(supersession).toMatchObject({ supersededBy: 'new', reason: 'contradiction' })
    expect(supersession?.validTo).toBe(NOW - DAY)
  })

  it('肯定/否定的近重复对**不塌缩**：矛盾优先于合并（否则等于静默裁决）', () => {
    const records = [
      makeRecord({ id: 's1', text: '构建产物要提交到仓库里', observedAt: NOW - 5 * DAY, assertedBy: 'model' }),
      makeRecord({ id: 's2', text: '构建产物不要提交到仓库里', observedAt: NOW - DAY, assertedBy: 'user' }),
    ]
    const plan = planConsolidation({ records }, { now: NOW })
    expect(plan.merges).toEqual([]) // 词法上近重复，但极性相反 → 绝不合并
    expect(plan.edges.map(e => `${e.type}:${e.fromId}->${e.toId}`)).toEqual([
      'conflicts_with:s1->s2',
      'supersedes:s2->s1',
    ])
    expect(plan.supersessions.map(s => `${s.id}<-${s.supersededBy}:${s.reason}`)).toEqual(['s1<-s2:contradiction'])
  })

  it('model 断言的新条目**不能**取代 user 断言的旧条目（等级不可被推断覆盖）', () => {
    const records = [
      makeRecord({ id: 'user-said', text: '我要求所有回复用中文', observedAt: NOW - 20 * DAY, assertedBy: 'user' }),
      makeRecord({ id: 'model-guess', text: '用户可能更喜欢英文回复', observedAt: NOW, assertedBy: 'model' }),
    ]
    const plan = planConsolidation({ records, contradictions: [{ aId: 'user-said', bId: 'model-guess' }] }, { now: NOW })
    expect(plan.edges.map(e => e.type)).toEqual(['conflicts_with'])
    expect(plan.supersessions).toEqual([])
  })

  it('execute 断言可以取代 model；已失效的行不再被二次取代', () => {
    const records = [
      makeRecord({ id: 'a', text: '超时是 30 秒', observedAt: NOW - 5 * DAY, assertedBy: 'model' }),
      makeRecord({ id: 'b', text: '实测超时是 60 秒', observedAt: NOW - DAY, assertedBy: 'execution' }),
      makeRecord({ id: 'c', text: '超时是 30 秒（旧结论）', observedAt: NOW - 6 * DAY, assertedBy: 'model', validTo: NOW - 5 * DAY, supersededBy: 'a' }),
    ]
    const plan = planConsolidation(
      {
        records,
        contradictions: [
          { aId: 'a', bId: 'b' },
          { aId: 'b', bId: 'c' },
        ],
      },
      { now: NOW },
    )
    expect(plan.supersessions.map(s => `${s.id}<-${s.supersededBy}`)).toEqual(['a<-b'])
    // 已有的 conflicts_with 不重复发
    const existing: Edge[] = [edge('a', 'b', 'conflicts_with')]
    const again = planConsolidation({ records, edges: existing, contradictions: [{ aId: 'a', bId: 'b' }] }, { now: NOW })
    expect(again.edges.filter(e => e.type === 'conflicts_with')).toEqual([])
    expect(again.edges.map(e => e.type)).toEqual(['supersedes'])
  })

  it('内置廉价检测：核心 token 重叠且否定极性相反才发信号', () => {
    const records = [
      makeRecord({ id: 's1', text: '构建产物要提交到仓库里' }),
      makeRecord({ id: 's2', text: '构建产物不要提交到仓库里' }),
      makeRecord({ id: 's3', text: '周三下午两点开评审会' }),
    ]
    const signals = detectLexicalContradictions(records)
    expect(signals.map(s => `${s.aId}-${s.bId}`)).toEqual(['s1-s2'])
    expect(isNegated('构建产物不要提交到仓库里')).toBe(true)
    expect(isNegated('构建产物要提交到仓库里')).toBe(false)
    expect(isNegated('不要不提交')).toBe(false) // 双重否定 → 极性回到肯定
  })
})

describe('衰减：只重排先验，不衰减行', () => {
  it('decayPrior 随时间单调下降、随 useCount 上升；计划里没有任何删除', () => {
    const fresh = makeRecord({ id: 'fresh', observedAt: NOW, useCount: 0 })
    const old = makeRecord({ id: 'old', observedAt: NOW - 90 * DAY, useCount: 0 })
    const used = makeRecord({ id: 'used', observedAt: NOW - 90 * DAY, useCount: 20 })
    expect(decayPrior(fresh, NOW)).toBeGreaterThan(decayPrior(old, NOW))
    expect(decayPrior(used, NOW)).toBeGreaterThan(decayPrior(old, NOW))

    const plan = planConsolidation({ records: [fresh, old, used] }, { now: NOW })
    expect(plan.decay.length).toBe(3) // 每条都在排序先验里
    expect(plan.decay[0]?.id).toBe('fresh')
    expect(plan.merges).toEqual([])
    expect(plan.erasures).toEqual([])
    expect(plan.notes.join('\n')).toContain('不修改任何行')
    // 计划里不存在任何"删除"字段：唯一删除路径是显式隐私擦除
    const planWithErasure = planConsolidation(
      { records: [fresh, old] },
      { now: NOW, erasureIds: ['old', '不存在'] },
    )
    expect(planWithErasure.erasures).toEqual(['old'])
  })
})

describe('纯原语与确定性', () => {
  it('sourceChain / jaccard / shingles 语义', () => {
    expect(sourceChain('session:s1#turn:3')).toBe('session:s1')
    expect(sourceChain('session:s1')).toBe('session:s1')
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
    expect(jaccard(new Set(), new Set())).toBe(0)
    expect(shingles('长期记忆系统')).toEqual(['长期', '期记', '记忆', '忆系', '系统'])
  })

  it('相同输入永远得到相同计划（顺序无关）', () => {
    const records = [
      makeRecord({ id: 'a1', text: '同样的内容' }),
      makeRecord({ id: 'a2', text: '同样的内容' }),
      makeRecord({ id: 'b1', text: '另一条独立结论' }),
    ]
    const first = planConsolidation({ records }, { now: NOW })
    const second = planConsolidation({ records: [...records].reverse() }, { now: NOW })
    expect(second.merges).toEqual(first.merges)
    expect(second.supersessions).toEqual(first.supersessions)
    expect(second.decay.map(d => d.id)).toEqual(first.decay.map(d => d.id))
  })

  it('空输入是合法的：计划为空，不是错误', () => {
    const plan = planConsolidation({ records: [] }, { now: NOW })
    expect(plan.merges).toEqual([])
    expect(plan.edges).toEqual([])
    expect(plan.decay).toEqual([])
    expect(plan.stats.records).toBe(0)
  })

  it('coreTokens 丢掉否定标记与单字，保留实词', () => {
    const tokens = [...coreTokens('不要提交构建产物')]
    expect(tokens).not.toContain('不要')
    expect(tokens).toContain('构建')
  })
})
