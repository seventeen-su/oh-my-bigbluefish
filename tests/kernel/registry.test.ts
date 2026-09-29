/**
 * 依赖图规划测试（`planModules`）。
 *
 * 这里钉的是**环依赖的传递后果**（原实现在这几条上都是错的）：
 * ① 环内的模块必须**整组**阻断，不能只阻断 DFS 恰好撞到的那一个
 * ② 环外**依赖环内**的模块也必须阻断（否则"依赖一个已 blocked 的模块却启动了"）
 * ③ 结论必须与输入顺序无关——同一张图打乱顺序，`blocked`/`ordered` 逐位相同
 * ④ 不能误伤无环图
 */
import { describe, expect, it } from 'vitest'
import type { Kernel, ModuleRegistration } from '../../kernel/abi/index.js'
import { planModules } from '../../kernel/registry.js'

function mod(
  id: string,
  requires: readonly string[] = [],
  apply: (kernel: Kernel, config: unknown) => void | (() => void | Promise<void>) = () => {},
): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '1.0.0',
      requires,
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: 'test' }),
    },
    apply,
  }
}

function blockedIds(modules: readonly ModuleRegistration<unknown>[]): readonly string[] {
  return planModules(modules).blocked.map(b => b.id).sort()
}

function orderedIds(modules: readonly ModuleRegistration<unknown>[]): readonly string[] {
  return planModules(modules).ordered.map(m => m.id)
}

function permute<T>(items: readonly T[]): readonly (readonly T[])[] {
  if (items.length <= 1) return [items]
  const out: T[][] = []
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)]
    for (const tail of permute(rest)) out.push([item, ...tail])
  })
  return out
}

describe('planModules：环依赖（SCC 整组阻断 + 传递阻断）', () => {
  it('二节点环：两个都 blocked', () => {
    const plan = planModules([mod('a', ['b']), mod('b', ['a'])])
    expect(blockedIds([mod('a', ['b']), mod('b', ['a'])])).toEqual(['a', 'b'])
    expect(plan.ordered).toEqual([])
    for (const entry of plan.blocked) expect(entry.reason).toContain('依赖成环')
  })

  it('三节点环：三个都 blocked', () => {
    const graph = [mod('a', ['b']), mod('b', ['c']), mod('c', ['a'])]
    expect(blockedIds(graph)).toEqual(['a', 'b', 'c'])
    expect(orderedIds(graph)).toEqual([])
  })

  it('自环（a 依赖自己）也 blocked', () => {
    const graph = [mod('a', ['a']), mod('b')]
    expect(blockedIds(graph)).toEqual(['a'])
    expect(orderedIds(graph)).toEqual(['b'])
    expect(planModules(graph).blocked[0]?.reason).toContain('依赖成环')
  })

  it('环外依赖环内的模块也 blocked，且理由指明传递来源', () => {
    // c 依赖 a，a↔b 成环。旧实现在 byId 顺序为 c,a,b 时会把 c 启动。
    const graph = [mod('c', ['a']), mod('a', ['b']), mod('b', ['a'])]
    const plan = planModules(graph)
    expect(plan.ordered).toEqual([])
    expect(plan.blocked.map(b => b.id).sort()).toEqual(['a', 'b', 'c'])
    const c = plan.blocked.find(b => b.id === 'c')
    expect(c?.reason, '传递阻断的理由必须指明经由哪个模块').toContain('依赖 a')
    expect(c?.reason).toContain('无法启动')
  })

  it('传递链只阻断下游，不连坐无关模块', () => {
    const graph = [mod('x'), mod('a', ['b']), mod('b', ['a']), mod('c', ['b']), mod('d', ['c'])]
    const plan = planModules(graph)
    expect(plan.ordered.map(m => m.id)).toEqual(['x'])
    expect(plan.blocked.map(b => b.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    const d = plan.blocked.find(b => b.id === 'd')
    expect(d?.reason).toContain('依赖 c')
  })

  it('既有环又有缺失依赖：两类原因各自可读', () => {
    const graph = [mod('a', ['b']), mod('b', ['a']), mod('m', ['missing'])]
    const plan = planModules(graph)
    expect(plan.blocked.map(b => b.id).sort()).toEqual(['a', 'b', 'm'])
    expect(plan.blocked.find(b => b.id === 'm')?.reason).toBe('缺少必需依赖：missing')
    expect(plan.blocked.find(b => b.id === 'a')?.reason).toContain('依赖成环')
  })
})

describe('planModules：与输入顺序无关', () => {
  const graph = [
    mod('c', ['a']), // 环外依赖环内
    mod('a', ['b']), // 环
    mod('b', ['a']), // 环
    mod('z'), // 无关
  ]

  it('全部 24 种排列给出逐位相同的 blocked 与 ordered', () => {
    const expectedBlocked = ['a', 'b', 'c']
    const expectedOrdered = ['z']
    let checked = 0
    for (const order of permute(graph)) {
      const plan = planModules(order)
      expect(plan.blocked.map(b => b.id), `顺序 ${order.map(m => m.manifest.id).join(',')}`).toEqual(expectedBlocked)
      expect(plan.ordered.map(m => m.id)).toEqual(expectedOrdered)
      checked += 1
    }
    expect(checked).toBe(24)
  })

  it('无环图的拓扑序也与输入顺序无关', () => {
    const dag = [mod('d', ['b', 'c']), mod('b', ['a']), mod('c', ['a']), mod('a')]
    const orders = new Set(permute(dag).map(order => orderedIds(order).join(',')))
    // 确定性拓扑序：唯一解（a,b,c,d），不依赖输入顺序
    expect([...orders]).toEqual(['a,b,c,d'])
  })
})

describe('planModules：好图不被误伤', () => {
  it('链式依赖按拓扑序完整启动', () => {
    expect(orderedIds([mod('c', ['b']), mod('b', ['a']), mod('a')])).toEqual(['a', 'b', 'c'])
  })

  it('菱形依赖（d 依赖 b、c，二者都依赖 a）完整启动', () => {
    const graph = [mod('d', ['b', 'c']), mod('b', ['a']), mod('c', ['a']), mod('a')]
    expect(blockedIds(graph)).toEqual([])
    expect(orderedIds(graph)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('id 重复仍按原语义阻断该 id', () => {
    expect(planModules([mod('a'), mod('a')]).blocked).toEqual([{ id: 'a', reason: '模块 id 重复：a' }])
    expect(planModules([mod('a'), mod('a')]).ordered).toEqual([])
  })

  it('可选依赖缺失不算失败', () => {
    const m = mod('a')
    const withOptional: ModuleRegistration<unknown> = { ...m, manifest: { ...m.manifest, optional: ['nope'] } }
    expect(planModules([withOptional]).blocked).toEqual([])
  })
})
