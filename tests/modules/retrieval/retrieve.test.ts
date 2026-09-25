/**
 * 检索主路径测试（规划 §5.4 七阶段）。
 *
 * 四个反例中的三个在这里：
 * ① 同一条记忆在不同候选池大小下分数稳定（RRF 池无关性）
 * ② 窄库的平庸命中不遮蔽宽库更好的命中（扇出绝不短路）
 * ③ 融合只消费排名，不做跨通道分数算术
 */
import { describe, expect, it } from 'vitest'
import type { RetrievalChannel } from '../../../modules/memory/retrieve.js'
import {
  DEFAULT_RRF_K,
  asciiCompare,
  fuseByRank,
  gateRetrieval,
  isoUtc,
  rankHits,
  retrieve,
  selectWithQuota,
} from '../../../modules/memory/retrieve.js'
import { clockAt, countingEmbedder, fakeStore, fixedEmbedder, hits, makeRecord, tagged, vectorChannelOf } from './fakes.js'

const CLOCK = clockAt(10_000_000)

describe('① RRF 池无关性：候选池大小不改变同一条记忆的分数', () => {
  it('同一排名在不同池大小下得到完全相同的分（旧实现按池大小归一 → 会漂移）', async () => {
    const records = [
      makeRecord({ id: 'a', text: 'alpha' }),
      makeRecord({ id: 'b', text: 'beta' }),
      makeRecord({ id: 'c', text: 'gamma' }),
      ...Array.from({ length: 47 }, (_, i) => makeRecord({ id: `fill-${i}`, text: `filler ${i}` })),
    ]
    let pool = hits(['a', 'b', 'c'], 300)
    const store = fakeStore({ scope: 'user', records, search: () => pool })
    const ports = { clock: CLOCK }

    const small = await retrieve([tagged(store)], { text: 'alpha', limit: 5 }, ports)
    pool = hits(['a', 'b', 'c', ...records.slice(3).map(r => r.id)], 300)
    const large = await retrieve([tagged(store)], { text: 'alpha', limit: 5 }, ports)

    const scoreOf = (result: typeof small, id: string): number => {
      const item = result.items.find(i => i.id === id)
      expect(item, `${id} 应在结果里`).toBeDefined()
      return item?.score ?? -1
    }
    for (const id of ['a', 'b', 'c']) {
      expect(scoreOf(large, id), `${id} 的分数随池大小漂移了`).toBe(scoreOf(small, id))
    }
    // 精确值：只有一个词法通道，rank 1/2/3 → 1/(k+1)、1/(k+2)、1/(k+3)
    expect(scoreOf(small, 'a')).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
    expect(scoreOf(small, 'b')).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 12)
    expect(scoreOf(small, 'c')).toBeCloseTo(1 / (DEFAULT_RRF_K + 3), 12)
    expect(large.stats.candidatesFused).toBeGreaterThan(small.stats.candidatesFused)
  })

  it('k 可配置：k=10 时分母变成 11（k=60 只是惯例，不是承重设计）', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'a', text: 'alpha' })],
      search: () => hits(['a'], 5),
    })
    const result = await retrieve([tagged(store)], { text: 'alpha', rrfK: 10, limit: 1 }, { clock: CLOCK })
    expect(result.items[0]?.score).toBeCloseTo(1 / 11, 12)
    expect(result.stats.rrfK).toBe(10)
  })
})

describe('② 扇出绝不短路：窄库的平庸命中不能遮蔽宽库更好的命中', () => {
  it('两个库都被查询，且宽库（更好）的命中出现在结果里', async () => {
    const project = fakeStore({
      scope: 'project',
      records: [makeRecord({ id: 'narrow-poor', scope: 'project', text: '契约 边界 细节' })],
    })
    const user = fakeStore({
      scope: 'user',
      records: [
        makeRecord({ id: 'wide-best', text: '契约 边界 结论' }),
        makeRecord({ id: 'wide-second', text: '契约 边界 备注' }),
      ],
    })

    const result = await retrieve([tagged(project), tagged(user)], { text: '契约 边界', limit: 3 }, { clock: CLOCK })

    // 「首个非空即停」的旧实现只会查一个库——这里两个库都必须被查
    expect(project.calls.searchLexical).toBe(1)
    expect(user.calls.searchLexical).toBe(1)
    const ids = result.items.map(i => i.id)
    expect(ids).toContain('wide-best')
    expect(ids).toContain('narrow-poor')
    expect(result.items[0]?.id).toBe('wide-best')
  })

  it('一个库被第二通道灌满时，另一个库仍被每库配额保进结果（防饿死）', async () => {
    const project = fakeStore({
      scope: 'project',
      records: Array.from({ length: 4 }, (_, i) => makeRecord({ id: `p${i}`, scope: 'project', text: '契约 边界' })),
    })
    const user = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'u0', text: '契约 边界' }), makeRecord({ id: 'u1', text: '契约 边界' })],
    })
    // 向量通道只覆盖了项目库（例如用户库尚未编码）→ 项目库候选两通道命中，分数翻倍
    const vector: RetrievalChannel = {
      name: 'vector',
      search: query =>
        Promise.resolve(
          query.scope === 'project'
            ? hits(['p0', 'p1', 'p2', 'p3'], 90, 'vector')
            : [],
        ),
    }
    const result = await retrieve(
      [tagged(project), tagged(user)],
      { text: '契约 边界', limit: 4 },
      { clock: CLOCK, channels: [vector] },
    )
    const ids = result.items.map(i => i.id)
    expect(ids).toContain('u0')
    expect(ids).toContain('u1')
    expect(result.stats.perStore.map(s => s.selected).reduce((a, b) => a + b, 0)).toBe(4)
  })

  it('库的传入顺序不影响结果（确定性）', async () => {
    const project = fakeStore({
      scope: 'project',
      records: [makeRecord({ id: 'p1', scope: 'project', text: '契约 边界' })],
    })
    const user = fakeStore({ scope: 'user', records: [makeRecord({ id: 'u1', text: '契约 边界' })] })
    const forward = await retrieve([tagged(project), tagged(user)], { text: '契约', limit: 2 }, { clock: CLOCK })
    const backward = await retrieve([tagged(user), tagged(project)], { text: '契约', limit: 2 }, { clock: CLOCK })
    expect(backward.items.map(i => i.id)).toEqual(forward.items.map(i => i.id))
  })

  it('单库抛异常：降级不抛，另一库照常返回', async () => {
    const broken = fakeStore({ scope: 'user', failSearch: '库文件损坏' })
    const healthy = fakeStore({
      scope: 'project',
      records: [makeRecord({ id: 'ok-1', scope: 'project', text: '契约 边界' })],
    })
    const result = await retrieve([tagged(broken), tagged(healthy)], { text: '契约', limit: 2 }, { clock: CLOCK })
    expect(result.items.map(i => i.id)).toEqual(['ok-1'])
    expect(result.degraded.join('\n')).toContain('库文件损坏')
  })
})

describe('③ 融合只消费排名：禁止跨通道分数算术', () => {
  it('rankHits 完全无视通道原始分', () => {
    const a = rankHits([
      { id: 'x', score: 1e9, channel: 'lexical' },
      { id: 'y', score: -5, channel: 'lexical' },
    ])
    const b = rankHits([
      { id: 'x', score: 0.0001, channel: 'lexical' },
      { id: 'y', score: 0.0002, channel: 'lexical' },
    ])
    expect(a).toEqual(b)
    expect(a).toEqual([
      { id: 'x', rank: 1 },
      { id: 'y', rank: 2 },
    ])
  })

  it('原始分极高但排名更差者，输给两通道都靠前者（旧实现会把它加出来）', () => {
    const fused = fuseByRank(
      [
        {
          channel: 'lexical',
          scope: 'user',
          hits: [
            { id: 'raw-huge', rank: 1 }, // 原始 bm25 分 9999，但只在词法通道出现
            { id: 'both', rank: 2 },
          ],
        },
        { channel: 'vector', scope: 'user', hits: [{ id: 'both', rank: 1 }] },
      ],
      DEFAULT_RRF_K,
    )
    expect(fused.map(c => c.id)).toEqual(['both', 'raw-huge'])
    expect(fused.find(c => c.id === 'both')?.score).toBeCloseTo(1 / 62 + 1 / 61, 12)
    expect(fused.find(c => c.id === 'raw-huge')?.score).toBeCloseTo(1 / 61, 12)
  })

  it('分数 = Σ 1/(k+rank)，不含任何通道原始分', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'a', text: 'alpha' }), makeRecord({ id: 'b', text: 'beta' })],
      search: () => [
        { id: 'a', score: 999_999, channel: 'lexical' },
        { id: 'b', score: 0.5, channel: 'lexical' },
      ],
    })
    const vector: RetrievalChannel = {
      name: 'vector',
      search: () => Promise.resolve([{ id: 'b', score: -12, channel: 'vector' }]),
    }
    const result = await retrieve(
      [tagged(store)],
      { text: 'alpha', limit: 2 },
      { clock: CLOCK, channels: [vector] },
    )
    const b = result.items.find(i => i.id === 'b')
    const a = result.items.find(i => i.id === 'a')
    expect(b?.score).toBeCloseTo(1 / 62 + 1 / 61, 12)
    expect(a?.score).toBeCloseTo(1 / 61, 12)
    expect(b?.ranks).toEqual([
      { channel: 'lexical', scope: 'user', rank: 2 },
      { channel: 'vector', scope: 'user', rank: 1 },
    ])
    expect([...result.stats.channelsUsed].sort()).toEqual(['lexical', 'vector'])
  })

  it('第二通道缺省 / 嵌入器故障时，纯词法路径完整可用', async () => {
    const store = fakeStore({ scope: 'user', records: [makeRecord({ id: 'a', text: 'alpha' })] })
    const pure = await retrieve([tagged(store)], { text: 'alpha', limit: 1 }, { clock: CLOCK })
    expect(pure.items.map(i => i.id)).toEqual(['a'])
    expect(pure.degraded).toEqual([])

    const failing = {
      id: 'bad',
      dimensions: 4,
      revision: 'r1',
      embed: () => Promise.reject(new Error('onnxruntime-node 未安装')),
    }
    const degraded = await retrieve(
      [tagged(store)],
      { text: 'alpha', limit: 1 },
      {
        clock: CLOCK,
        embedder: failing,
        channels: [{ name: 'vector', search: () => Promise.resolve([]) }],
      },
    )
    expect(degraded.items.map(i => i.id)).toEqual(['a'])
    expect(degraded.degraded.join('\n')).toContain('退化为纯词法')
  })
})

describe('阶段① 门控：不需要记忆是一等结果，不是错误', () => {
  it('空查询：跳过且零 I/O', async () => {
    const store = fakeStore({ scope: 'user', records: [makeRecord({ id: 'a', text: 'alpha' })] })
    const result = await retrieve([tagged(store)], { text: '   ' }, { clock: CLOCK })
    expect(result.items).toEqual([])
    expect(result.gate).toMatchObject({ retrieve: false, reason: 'empty-query' })
    expect(store.calls.searchLexical).toBe(0)
    expect(store.calls.getMany).toBe(0)
    expect(result.note).toContain('不是错误')
  })

  it('mode=never / 无库 / kinds 空集 / tight 压力 都有可读原因', () => {
    const store = fakeStore({ scope: 'user' })
    const stores = [tagged(store)]
    expect(gateRetrieval(stores, { text: 'a', mode: 'never' }).reason).toBe('explicit-never')
    expect(gateRetrieval([], { text: 'a' }).reason).toBe('no-stores')
    expect(gateRetrieval(stores, { text: 'a', kinds: [] }).reason).toBe('no-kinds')
    expect(gateRetrieval(stores, { text: 'a', pressureBand: 'tight' }).reason).toBe('pressure-tight')
    expect(gateRetrieval(stores, { text: 'a', pressureBand: 'tight', mode: 'always' }).retrieve).toBe(true)
    expect(gateRetrieval(stores, { text: 'a' }).retrieve).toBe(true)
  })

  it('tight 压力只是软信号：可显式关闭该门控', async () => {
    const store = fakeStore({ scope: 'user', records: [makeRecord({ id: 'a', text: 'alpha' })] })
    const result = await retrieve(
      [tagged(store)],
      { text: 'alpha', pressureBand: 'tight', skipOnTightPressure: false },
      { clock: CLOCK },
    )
    expect(result.items.map(i => i.id)).toEqual(['a'])
  })
})

describe('阶段⑤⑥⑦ 配额、上限、水合与溯源', () => {
  it('水合只走每库一次 getMany（禁止 N+1），且从不调 get', async () => {
    const records = Array.from({ length: 12 }, (_, i) => makeRecord({ id: `m${i}`, text: `契约 ${i}` }))
    const store = fakeStore({ scope: 'user', records })
    const result = await retrieve([tagged(store)], { text: '契约', limit: 5 }, { clock: CLOCK })
    expect(result.items.length).toBe(5)
    expect(store.calls.getMany).toBe(1)
    expect(store.calls.get).toBe(0)
    expect(store.getManyCalls[0]?.length).toBe(12)
  })

  it('硬候选上限：每通道取 5 条进融合，融合后被硬截到 2 条', async () => {
    const records = Array.from({ length: 5 }, (_, i) => makeRecord({ id: `m${i}`, text: `契约 ${i}` }))
    const store = fakeStore({ scope: 'user', records })
    const result = await retrieve(
      [tagged(store)],
      { text: '契约', limit: 5, maxCandidates: 2, poolLimit: 5 },
      { clock: CLOCK },
    )
    expect(result.stats.candidatesFused).toBe(5)
    expect(result.stats.candidatesCapped).toBe(2)
    expect(result.items.length).toBe(2)
  })

  it('逐字返回：文本、sourceRef、observedAt 原样带出', async () => {
    const record = makeRecord({
      id: 'trace-1',
      text: '不要把 build 目录写进仓库（逐字原文，未抽取）',
      sourceRef: 'session:s1#turn:7',
      observedAt: 1_700_000_000_000,
      assertedBy: 'user',
      project: 'oh-my-bigbluefish',
    })
    const store = fakeStore({ scope: 'user', records: [record] })
    const result = await retrieve([tagged(store)], { text: 'build', limit: 1 }, { clock: CLOCK })
    expect(result.items[0]).toMatchObject({
      id: 'trace-1',
      text: record.text,
      sourceRef: 'session:s1#turn:7',
      observedAt: 1_700_000_000_000,
      assertedBy: 'user',
      project: 'oh-my-bigbluefish',
      rank: 0,
    })
  })

  it('确定性总序用 ASCII 比较而非 localeCompare', () => {
    // localeCompare('a','B') < 0（a 在前）；ASCII 是 'B'(66) < 'a'(97)
    expect(asciiCompare('B', 'a')).toBeLessThan(0)
    expect('a'.localeCompare('B')).toBeLessThan(0)
  })

  it('时间格式化是纯算术：与 new Date(ms).toISOString() 逐字节一致', () => {
    // 模块层禁止 new Date（omb/no-direct-clock）；这里用差分测试证明等价性
    for (const ms of [
      0,
      1,
      999,
      1_000,
      1_699_100_000_000,
      1_700_000_000_000,
      2_000_000_000_000,
      253_402_300_799_999, // 9999-12-31T23:59:59.999Z
    ]) {
      expect(isoUtc(ms), `ms=${ms}`).toBe(new Date(ms).toISOString())
    }
  })

  it('同分时按作用域优先级排序（与输入顺序无关）', async () => {
    const left = fakeStore({ scope: 'user', records: [makeRecord({ id: 'a', text: 'x' })], search: () => hits(['a']) })
    const right = fakeStore({
      scope: 'project',
      records: [makeRecord({ id: 'B', scope: 'project', text: 'x' })],
      search: () => hits(['B']),
    })
    // 两条都是各自库的 rank1 → 同分；作用域优先级 user 在前
    const tie = await retrieve([tagged(left), tagged(right)], { text: 'x', limit: 2, scope: 'user' }, { clock: CLOCK })
    expect(tie.items.map(i => i.id)).toEqual(['a', 'B'])
    expect(tie.items[0]?.score).toBeCloseTo(tie.items[1]?.score ?? -1, 12)
  })

  it('每库配额函数：第一遍保证弱库有位置，第二遍补齐不留空位', () => {
    const ordered = [
      { id: 'p1', scope: 'project' as const },
      { id: 'p2', scope: 'project' as const },
      { id: 'p3', scope: 'project' as const },
      { id: 'u1', scope: 'user' as const },
    ]
    expect(selectWithQuota(ordered, 3, 1).map(c => c.id)).toEqual(['p1', 'u1', 'p2'])
    expect(selectWithQuota(ordered, 4, 1).map(c => c.id)).toEqual(['p1', 'u1', 'p2', 'p3'])
    expect(selectWithQuota(ordered, 2, 5).map(c => c.id)).toEqual(['p1', 'p2'])
    expect(selectWithQuota(ordered, 0, 5)).toEqual([])
  })
})

describe('阶段⑥ 可选廉价重排', () => {
  it('重排只重排已有候选；默认关闭，开启后排序先验可翻动相邻位次', async () => {
    const now = 1_700_000_000_000
    const records = [
      makeRecord({ id: 'stale', text: '契约 边界', observedAt: now - 400 * 24 * 3600 * 1000, useCount: 0 }),
      makeRecord({ id: 'fresh', text: '契约 边界', observedAt: now, useCount: 10, assertedBy: 'user' }),
    ]
    const store = fakeStore({
      scope: 'user',
      records,
      search: () => hits(['stale', 'fresh']),
    })
    const plain = await retrieve([tagged(store)], { text: '契约', limit: 2 }, { clock: clockAt(now) })
    const reranked = await retrieve([tagged(store)], { text: '契约', limit: 2, rerank: true }, { clock: clockAt(now) })
    expect(plain.stats.reranked).toBe(false)
    expect(plain.items.map(i => i.id)).toEqual(['stale', 'fresh'])
    expect(reranked.stats.reranked).toBe(true)
    expect(new Set(reranked.items.map(i => i.id))).toEqual(new Set(plain.items.map(i => i.id)))
    expect(reranked.items[0]?.id).toBe('fresh')
  })
})

describe('保留来源（omb-doc:）：结构化状态不是经验，不参与召回排名', () => {
  it('画像记录即使词法命中也不注入；真正的经验候选照常返回', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [
        makeRecord({ id: 'profile', text: '用户偏好：中文回复，术语保留英文', sourceRef: 'omb-doc:profile', observedAt: 9_999 }),
        makeRecord({ id: 'trace', text: '用户要求：中文回复，术语保留英文', sourceRef: 'session:s1#turn:3' }),
      ],
      // 画像记录相关度更高（排在前面），仍必须被排除
      search: () => hits(['profile', 'trace'], 100),
    })
    const result = await retrieve([tagged(store)], { text: '中文回复', limit: 5 }, { clock: CLOCK })
    expect(result.items.map(i => i.id)).toEqual(['trace'])
    expect(result.stats.reservedSkipped).toBe(1)
  })

  it('保留来源不占用候选上限的位次（水合在截断之前）', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [
        makeRecord({ id: 'profile', text: '画像：中文', sourceRef: 'omb-doc:profile' }),
        makeRecord({ id: 'trace-1', text: '经验一：中文' }),
        makeRecord({ id: 'trace-2', text: '经验二：中文' }),
      ],
      search: () => hits(['profile', 'trace-1', 'trace-2'], 100),
    })
    const result = await retrieve(
      [tagged(store)],
      { text: '中文', limit: 5, maxCandidates: 2, poolLimit: 3 },
      { clock: CLOCK },
    )
    expect(result.items.map(i => i.id)).toEqual(['trace-1', 'trace-2'])
    expect(result.stats.candidatesCapped).toBe(2)
  })
})

describe('端口注入的可选第二通道', () => {
  it('每个库都被每个通道查询一次；嵌入器只调用一次', async () => {
    const store = fakeStore({ scope: 'user', records: [makeRecord({ id: 'a', text: 'alpha' })] })
    const embedder = countingEmbedder()
    let searched = 0
    const channel: RetrievalChannel = {
      name: 'vector',
      search: () => {
        searched += 1
        return Promise.resolve([{ id: 'a', score: 1, channel: 'vector' }])
      },
    }
    await retrieve([tagged(store)], { text: 'alpha', limit: 1 }, { clock: CLOCK, embedder, channels: [channel] })
    expect(searched).toBe(1)
    expect(embedder.calls).toBe(1)
  })

  it('通道抛异常：降级为纯词法，不抛', async () => {
    const store = fakeStore({ scope: 'user', records: [makeRecord({ id: 'a', text: 'alpha' })] })
    const channel: RetrievalChannel = {
      name: 'vector',
      search: () => Promise.reject(new Error('向量表维度不匹配')),
    }
    const result = await retrieve([tagged(store)], { text: 'alpha', limit: 1 }, { clock: CLOCK, channels: [channel] })
    expect(result.items.map(i => i.id)).toEqual(['a'])
    expect(result.degraded.join('\n')).toContain('维度不匹配')
  })
})

describe('向量通道接缝：通道只适配，归属过滤与存取在端口 searchVector', () => {
  const embedder = fixedEmbedder([1, 0, 0, 0], 'bge-small-zh-v1.5', 'rev-2026')
  const attribution = { modelId: 'bge-small-zh-v1.5', dim: 4, revision: 'rev-2026' }

  function vectorStore(): ReturnType<typeof fakeStore> {
    return fakeStore({
      scope: 'user',
      records: [
        makeRecord({ id: 'v-best', text: '契约边界语义相关' }),
        makeRecord({ id: 'v-poor', text: '完全无关的闲聊' }),
        makeRecord({ id: 'v-lexical-only', text: '契约边界词法命中' }),
      ],
      search: () => hits(['v-best', 'v-lexical-only'], 50),
      vectors: [
        { id: 'v-best', attribution, vector: Float32Array.from([0.99, 0.1, 0, 0]) },
        { id: 'v-poor', attribution, vector: Float32Array.from([0.05, 0.99, 0, 0]) },
        // 归属不符的向量：必须被排除（宁可少召回也不要跨空间比距离）
        { id: 'v-lexical-only', attribution: { ...attribution, modelId: '别的模型' }, vector: Float32Array.from([1, 0, 0, 0]) },
      ],
    })
  }

  it('查询向量交给端口，命中进入 RRF；低于标定下限的被丢弃', async () => {
    const store = vectorStore()
    const result = await retrieve(
      [tagged(store)],
      { text: '契约 边界', limit: 5 },
      { clock: CLOCK, embedder, channels: [vectorChannelOf(embedder, { minScore: 0.375 })] },
    )
    const ids = result.items.map(i => i.id)
    expect(ids).toContain('v-best')
    expect(ids).toContain('v-lexical-only')
    expect(ids).not.toContain('v-poor') // 余弦 0.05 < 0.375：显式下限把它挡掉
    expect(store.calls.searchVector).toBe(1)
    expect(store.vectorQueries[0]?.limit).toBe(20) // poolLimit 默认 = maxCandidates
    expect(store.vectorQueries[0]?.expect).toEqual(attribution)
    // 两通道都命中 → 分数是两段 1/(k+rank) 之和；单通道命中只有一段
    expect(result.items.find(i => i.id === 'v-best')?.score).toBeCloseTo(1 / 61 + 1 / 61, 12)
    expect(result.items.find(i => i.id === 'v-lexical-only')?.score).toBeCloseTo(1 / 62, 12)
    expect(result.items.find(i => i.id === 'v-best')?.channels).toEqual(['lexical', 'vector'])
  })

  it('标定下限缺省时稠密余弦会灌满候选池——这正是必须显式传下限的理由', async () => {
    const store = vectorStore()
    const filled = await retrieve(
      [tagged(store)],
      { text: '契约 边界', limit: 5 },
      { clock: CLOCK, embedder, channels: [vectorChannelOf(embedder)] },
    )
    expect(filled.items.map(i => i.id)).toContain('v-poor')

    const floored = await retrieve(
      [tagged(store)],
      { text: '契约 边界', limit: 5 },
      { clock: CLOCK, embedder, channels: [vectorChannelOf(embedder, { minScore: 0.375 })] },
    )
    expect(floored.items.map(i => i.id)).not.toContain('v-poor')
  })

  it('向量通道故障：纯词法结果照常返回，降级可见', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'v-lexical-only', text: '契约边界' })],
      search: () => hits(['v-lexical-only']),
      failVector: '向量表维度不匹配',
    })
    const result = await retrieve(
      [tagged(store)],
      { text: '契约', limit: 3 },
      { clock: CLOCK, embedder, channels: [vectorChannelOf(embedder)] },
    )
    expect(result.items.map(i => i.id)).toEqual(['v-lexical-only'])
    expect(result.degraded.join('\n')).toContain('维度不匹配')
  })
})
