/**
 * 关联扩展（多跳，按需）测试——规划 §5.5 + §2 D3。
 *
 * 重点钉死：
 * - 三种类型化边各自可遍历、可按 `types` 过滤
 * - depth 1 / 2 的多跳与**环安全**（A→B→A 不会无限展开）
 * - 确定性顺序（hop asc → id ASCII）、节点/边上限与 `truncated` 如实上报
 * - 工具执行体**绝不抛**：服务缺失、参数非法、库失败一律 `{kind:'error'}` 或降级
 */
import { describe, expect, it } from 'vitest'
import type { Edge } from '../../../kernel/abi/index.js'
import {
  DEFAULT_MAX_NODES,
  RELATE_TOOL,
  createRelateTool,
  parseRelateArgs,
  planWalk,
  renderRelate,
  walkGraph,
} from '../../../modules/memory/graph.js'
import { clockAt, fakeStore, hits, makeRecord, tagged } from './fakes.js'

const T0 = 1_700_000_000_000

function edge(fromId: string, toId: string, type: Edge['type'], createdAt = T0): Edge {
  return { fromId, toId, type, createdAt }
}

describe('planWalk（纯函数）：类型化多跳与确定性', () => {
  const edges: readonly Edge[] = [
    edge('a', 'b', 'supersedes'),
    edge('b', 'c', 'derived_from'),
    edge('c', 'd', 'conflicts_with'),
    edge('c', 'b', 'derived_from'), // 环：b ↔ c
    edge('e', 'f', 'supersedes'), // 与起点无关
  ]

  it('depth=1 只到一跳；depth=2 到两跳', () => {
    const one = planWalk('a', edges, 1, ['supersedes', 'conflicts_with', 'derived_from'])
    expect(one.hops.map(h => h.id)).toEqual(['a', 'b'])
    const two = planWalk('a', edges, 2, ['supersedes', 'conflicts_with', 'derived_from'])
    expect(two.hops.map(h => h.id)).toEqual(['a', 'b', 'c'])
    expect(two.hops.find(h => h.id === 'c')?.hop).toBe(2)
  })

  it('types 过滤：只要 supersedes 就切断了后续跳', () => {
    const only = planWalk('a', edges, 2, ['supersedes'])
    expect(only.hops.map(h => h.id)).toEqual(['a', 'b'])
    expect(only.edges.map(e => e.type)).toEqual(['supersedes'])
  })

  it('无向遍历 + 环安全：b↔c 不会无限展开，重复边被去重', () => {
    const plan = planWalk('c', edges, 2, ['derived_from', 'conflicts_with'])
    const ids = plan.hops.map(h => h.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['c', 'b', 'd'])
    expect(plan.edges.length).toBe(new Set(plan.edges.map(e => `${e.fromId}${e.toId}${e.type}`)).size)
    expect(plan.edges.length).toBe(3)
  })

  it('顺序确定：hop asc → id ASCII（与输入边序无关）', () => {
    const shuffled = [...edges].reverse()
    const a = planWalk('a', edges, 2, ['supersedes', 'conflicts_with', 'derived_from'])
    const b = planWalk('a', shuffled, 2, ['supersedes', 'conflicts_with', 'derived_from'])
    expect(b.hops).toEqual(a.hops)
    expect(b.edges).toEqual(a.edges)
  })

  it('节点上限：触顶即停并如实报告 truncated', () => {
    const fan: Edge[] = Array.from({ length: 30 }, (_, i) => edge('root', `n${i}`, 'derived_from'))
    const plan = planWalk('root', fan, 1, ['derived_from'], { maxNodes: 5 })
    expect(plan.hops.length).toBe(5)
    expect(plan.truncated).toBe(true)
    const wide = planWalk('root', fan, 1, ['derived_from'])
    expect(wide.hops.length).toBe(DEFAULT_MAX_NODES)
    expect(wide.truncated).toBe(true)
  })
})

describe('walkGraph：多库扇出 + 起点缺失 + 降级', () => {
  const records = [
    makeRecord({ id: 'a', text: '结论 A 被 B 取代', sourceRef: 'session:s1#t1' }),
    makeRecord({ id: 'b', text: '结论 B（用户显式更正）', sourceRef: 'session:s1#t5', assertedBy: 'user', observedAt: T0 + 100 }),
    makeRecord({ id: 'c', text: '由 B 派生的工程结论', sourceRef: 'session:s1#t9', observedAt: T0 + 200 }),
    makeRecord({ id: 'd', text: '与 C 冲突的观察', sourceRef: 'session:s2#t3', observedAt: T0 + 300 }),
  ]
  const edges = [
    edge('b', 'a', 'supersedes'),
    edge('c', 'b', 'derived_from'),
    edge('c', 'd', 'conflicts_with'),
  ]
  const userStore = fakeStore({ scope: 'user', records, edges })

  it('depth=2 拿到传递闭包，节点带逐字正文与溯源', async () => {
    const outcome = await walkGraph([tagged(userStore)], { id: 'a', depth: 2, types: ['supersedes', 'derived_from'] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.nodes.map(n => n.id)).toEqual(['a', 'b', 'c'])
    expect(outcome.result.nodes.map(n => n.hop)).toEqual([0, 1, 2])
    expect(outcome.result.edges.map(e => `${e.fromId}-${e.toId}`)).toEqual(['b-a', 'c-b'])
    expect(outcome.result.nodes[0]?.text).toBe('结论 A 被 B 取代')
    expect(outcome.result.nodes[0]?.sourceRef).toBe('session:s1#t1')
    expect(outcome.result.why).toContain('supersedes')
    expect(outcome.result.truncated).toBe(false)
  })

  it('types 过滤能拿到"未裁决的矛盾"这一类（conflicts_with）', async () => {
    const outcome = await walkGraph([tagged(userStore)], { id: 'd', depth: 1, types: ['conflicts_with'] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.nodes.map(n => n.id)).toEqual(['d', 'c'])
    expect(outcome.result.edges.map(e => e.type)).toEqual(['conflicts_with'])
  })

  it('起点不在任何库 → ok:false 的可读错误（不是异常）', async () => {
    const outcome = await walkGraph([tagged(userStore)], { id: '不存在', depth: 1, types: ['supersedes'] })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('未找到记忆')
  })

  it('两个库都问（绝不短路）；一库失败只降级', async () => {
    const broken = fakeStore({ scope: 'project', failWalk: '图表损坏' })
    const outcome = await walkGraph([tagged(broken), tagged(userStore)], {
      id: 'a',
      depth: 1,
      types: ['supersedes'],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.nodes.map(n => n.id)).toEqual(['a', 'b'])
    expect(outcome.result.degraded.join('\n')).toContain('图表损坏')
  })

  it('没有库 → ok:false（服务缺失不抛）', async () => {
    const outcome = await walkGraph([], { id: 'a', depth: 1, types: ['supersedes'] })
    expect(outcome.ok).toBe(false)
  })
})

describe('parseRelateArgs：参数校验零抛异常', () => {
  it('合法参数补默认值', () => {
    expect(parseRelateArgs({ id: 'x' })).toEqual({
      ok: true,
      value: { id: 'x', depth: 1, types: ['supersedes', 'conflicts_with', 'derived_from'] },
    })
    expect(parseRelateArgs({ id: ' x ', depth: 2, types: ['conflicts_with'] })).toEqual({
      ok: true,
      value: { id: 'x', depth: 2, types: ['conflicts_with'] },
    })
  })

  it('非法参数给可读原因（不抛）', () => {
    for (const bad of [null, 'x', 42, [], {}, { id: '' }, { id: 'x', depth: 3 }, { id: 'x', types: [] }, { id: 'x', types: ['nope'] }]) {
      const parsed = parseRelateArgs(bad)
      expect(parsed.ok, `${JSON.stringify(bad)} 应被拒绝`).toBe(false)
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(4)
    }
  })
})

describe('omb_relate 工具：执行体绝不抛异常（H-3）', () => {
  const store = fakeStore({
    scope: 'user',
    records: [makeRecord({ id: 'a', text: 'A' }), makeRecord({ id: 'b', text: 'B' })],
    edges: [edge('a', 'b', 'derived_from')],
  })

  it('工具名与参数 schema 符合 ToolDefinition 契约', () => {
    const tool = createRelateTool({ resolveStores: () => [tagged(store)] })
    expect(tool.name).toBe(RELATE_TOOL)
    expect(tool.description).toContain('supersedes')
    expect(() => tool.parameters.parse({ id: 'a' })).not.toThrow()
    expect(() => tool.parameters.parse({})).toThrow()
  })

  it('正常路径返回文本，含逐字正文与溯源', async () => {
    const tool = createRelateTool({ resolveStores: () => [tagged(store)] })
    const outcome = await tool.execute({ id: 'a', depth: 1, types: ['derived_from'] })
    expect(outcome.kind).toBe('text')
    if (outcome.kind !== 'text') return
    expect(outcome.text).toContain('omb_relate')
    expect(outcome.text).toContain('sourceRef=')
    expect(outcome.text).toContain('A')
  })

  it('参数非法 → kind:error，不抛', async () => {
    const tool = createRelateTool({ resolveStores: () => [tagged(store)] })
    const outcome = await tool.execute({ id: 123 })
    expect(outcome.kind).toBe('error')
  })

  it('服务缺失（resolveStores 返回 undefined）→ kind:error，不抛', async () => {
    const tool = createRelateTool({ resolveStores: () => undefined })
    const outcome = await tool.execute({ id: 'a' })
    expect(outcome).toMatchObject({ kind: 'error' })
    if (outcome.kind === 'error') expect(outcome.text).toContain('未就绪')
  })

  it('resolveStores 自己抛异常 → kind:error，不抛', async () => {
    const tool = createRelateTool({
      resolveStores: () => {
        throw new Error('内核服务表被清空')
      },
    })
    const outcome = await tool.execute({ id: 'a' })
    expect(outcome.kind).toBe('error')
  })

  it('库遍历全失败但起点存在 → 仍返回文本（降级可见）', async () => {
    const broken = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'a', text: 'A' })],
      failWalk: '图查询超时',
    })
    const tool = createRelateTool({ resolveStores: () => [tagged(broken)] })
    const outcome = await tool.execute({ id: 'a' })
    expect(outcome.kind).toBe('text')
    if (outcome.kind === 'text') expect(outcome.text).toContain('图查询超时')
  })
})

describe('renderRelate：可读且不丢溯源', () => {
  it('逐字正文、hop、边列表、why 都在', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [
        makeRecord({ id: 'a', text: '原文 A' }),
        makeRecord({ id: 'b', text: '原文 B', validTo: T0 + 5, supersededBy: 'a' }),
      ],
      edges: [edge('a', 'b', 'supersedes')],
    })
    const outcome = await walkGraph([tagged(store)], { id: 'a', depth: 1, types: ['supersedes'] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const text = renderRelate(outcome.result)
    expect(text).toContain('原文 A')
    expect(text).toContain('原文 B')
    expect(text).toContain('[hop 1]')
    expect(text).toContain('supersedes: a → b')
    expect(text).toContain('时序更正')
    expect(text).toContain('⚠️已被取代')
  })

  it('上限触顶时文本里能看到"已截断"', async () => {
    const records = [makeRecord({ id: 'root', text: 'R' })]
    const edges: Edge[] = []
    for (let i = 0; i < 8; i += 1) {
      records.push(makeRecord({ id: `n${i}`, text: `N${i}` }))
      edges.push(edge('root', `n${i}`, 'derived_from'))
    }
    const store = fakeStore({ scope: 'user', records, edges })
    const outcome = await walkGraph([tagged(store)], { id: 'root', depth: 1, types: ['derived_from'] }, { maxNodes: 3 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.truncated).toBe(true)
    expect(renderRelate(outcome.result)).toContain('已截断')
  })
})

describe('工具面与 fake 的接线健全性', () => {
  it('fake 的 walkGraph 与 planWalk 在无向语义上一致', async () => {
    const store = fakeStore({
      scope: 'user',
      records: [makeRecord({ id: 'a', text: 'A' }), makeRecord({ id: 'b', text: 'B' })],
      edges: [edge('a', 'b', 'derived_from')],
    })
    const walk = await store.walkGraph({ fromId: 'b', depth: 1, types: ['derived_from'] })
    expect(walk.nodes.map(n => n.id).sort()).toEqual(['a', 'b'])
    expect(walk.edges.length).toBe(1)
    expect(hits(['a']).length).toBe(1)
    expect(clockAt(T0).now()).toBe(T0)
  })
})
