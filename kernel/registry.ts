/**
 * 模块注册表：依赖拓扑排序 + 生命周期 + 环检测。
 *
 * 内核不实现任何模块；它只保证：
 * ① `requires` 全部存在 ② 无环 ③ 依赖先于被依赖者启动
 * ④ 缺失依赖 → 该模块 `failed` 并写明原因，**不抛到会话**
 *
 * **环必须整组阻断，且阻断要传递**（原实现的两个后果，已由 `tests/kernel/registry.test.ts` 钉住）：
 * - 只阻断 DFS 恰好撞到的那一个节点 → 同一个强连通分量里的其余模块照常启动；
 * - 环外**依赖环内**的模块照常启动 → 它依赖一个永远不会启动的模块。
 *
 * 因此这里用 **Tarjan 强连通分量 + 传递阻断**，并且全程以**排序后的 id** 为迭代顺序：
 * 同一张图打乱输入顺序，`blocked`/`ordered` 逐位相同（旧实现依赖 `byId` 插入顺序）。
 */
import type { ModuleHealth, ModuleRegistration } from './abi/index.js'

export interface ResolvedModule {
  readonly id: string
  readonly registration: ModuleRegistration<unknown>
}

export interface BlockedModule {
  readonly id: string
  readonly reason: string
  /** 传递阻断时**经由**哪个被阻断的依赖（诊断用；直接原因没有这个字段）。 */
  readonly blockedBy?: string
}

export interface RegistryPlan {
  /** 可启动的模块，已按依赖拓扑排序（确定性：同层按 id ASCII 升序）。 */
  readonly ordered: readonly ResolvedModule[]
  /** 因缺失依赖、成环或传递阻断而无法启动的模块，附原因（按 id 升序）。 */
  readonly blocked: readonly BlockedModule[]
}

/** ASCII 安全比较（不用 `localeCompare`：它的结果依赖 locale）。 */
function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 直接原因（非传递）。`short` 供下游引用时使用。 */
interface PrimaryReason {
  readonly text: string
  readonly short: string
}

/**
 * 解析注册集合。纯函数，无副作用——便于对依赖图单独测试。
 * @param modules 待解析的模块（**顺序无关**，依赖关系决定启动顺序）。
 */
export function planModules(modules: readonly ModuleRegistration<unknown>[]): RegistryPlan {
  const byId = new Map<string, ModuleRegistration<unknown>>()
  for (const m of modules) {
    const id = m.manifest.id
    // id 重复：保留先出现者，并把该 id 整体阻断（与旧语义一致）
    if (!byId.has(id)) byId.set(id, m)
  }
  const duplicateIds = new Set<string>()
  for (const m of modules) {
    const id = m.manifest.id
    if (byId.get(id) !== m) duplicateIds.add(id)
  }

  // 规范顺序：一切迭代都从排序后的 id 出发 → 与输入顺序无关
  const ids = [...byId.keys()].sort(compareText)

  const adj = new Map<string, readonly string[]>()
  const missingBy = new Map<string, readonly string[]>()
  for (const id of ids) {
    const requires = byId.get(id)?.manifest.requires ?? []
    const deps: string[] = []
    const missing: string[] = []
    for (const dep of requires) {
      if (!byId.has(dep)) {
        if (!missing.includes(dep)) missing.push(dep)
        continue
      }
      if (!deps.includes(dep)) deps.push(dep)
    }
    adj.set(id, deps.sort(compareText))
    if (missing.length > 0) missingBy.set(id, missing.sort(compareText))
  }

  // ① 强连通分量：整个 SCC（含自环）一起阻断
  const componentOf = stronglyConnected(ids, adj)
  const componentMembers = new Map<number, string[]>()
  for (const id of ids) {
    const component = componentOf.get(id)
    if (component === undefined) continue
    const bucket = componentMembers.get(component)
    if (bucket === undefined) componentMembers.set(component, [id])
    else bucket.push(id)
  }

  const primary = new Map<string, PrimaryReason>()
  const noteMissing = (id: string, text: string): string =>
    missingBy.has(id) ? `${text}（另有缺失依赖：${(missingBy.get(id) ?? []).join('、')}）` : text

  for (const [, members] of componentMembers) {
    const selfLoop = members.length === 1 && (adj.get(members[0] ?? '') ?? []).includes(members[0] ?? '')
    if (members.length < 2 && !selfLoop) continue
    const memberSet = new Set(members)
    const cycle = findCyclePath(members[0] ?? '', adj, memberSet)
    const text = noteMissing(members[0] ?? '', `依赖成环：${cycle.join(' → ')}`)
    for (const member of members) primary.set(member, { text, short: '依赖成环' })
  }
  for (const id of ids) {
    if (primary.has(id)) continue
    if (duplicateIds.has(id)) {
      primary.set(id, { text: `模块 id 重复：${id}`, short: `模块 id 重复：${id}` })
      continue
    }
    const missing = missingBy.get(id)
    if (missing !== undefined && missing.length > 0) {
      primary.set(id, {
        text: `缺少必需依赖：${missing.join('、')}`,
        short: `缺少必需依赖 ${missing.join('、')}`,
      })
    }
  }

  // ② 传递阻断：依赖链上出现被阻断者 → 自己也阻断。
  //    取"最小的被阻断依赖"作为经由点（`adj` 已排序）→ 与迭代顺序无关。
  const via = new Map<string, string>()
  const isBlocked = (id: string): boolean => primary.has(id) || via.has(id)
  for (let changed = true; changed; ) {
    changed = false
    for (const id of ids) {
      if (isBlocked(id)) continue
      const blocker = (adj.get(id) ?? []).find(dep => isBlocked(dep))
      if (blocker === undefined) continue
      via.set(id, blocker)
      changed = true
    }
  }

  const rootOf = (id: string): string => {
    const seen = new Set<string>([id])
    let cursor = id
    for (;;) {
      const next = via.get(cursor)
      if (next === undefined || seen.has(next)) return cursor
      seen.add(next)
      cursor = next
    }
  }

  const blocked: BlockedModule[] = []
  const blockedSet = new Set<string>()
  for (const id of ids) {
    const own = primary.get(id)
    if (own !== undefined) {
      blockedSet.add(id)
      blocked.push({ id, reason: own.text })
      continue
    }
    const through = via.get(id)
    if (through === undefined) continue
    blockedSet.add(id)
    const root = rootOf(id)
    const short = primary.get(root)?.short ?? '依赖链上游被阻断'
    blocked.push({
      id,
      reason: `依赖 ${through}，而 ${through} 因${short}无法启动`,
      blockedBy: through,
    })
  }

  // ③ 拓扑序（Kahn，就绪集按 id 升序取最小）→ 确定性且与输入顺序无关
  const ordered: ResolvedModule[] = []
  const emitted = new Set<string>()
  const remaining = new Set(ids.filter(id => !blockedSet.has(id)))
  for (;;) {
    const ready = [...remaining]
      .filter(id => (adj.get(id) ?? []).every(dep => emitted.has(dep) || !byId.has(dep)))
      .sort(compareText)
    const next = ready[0]
    if (next === undefined) break
    const registration = byId.get(next)
    if (registration !== undefined) ordered.push({ id: next, registration })
    emitted.add(next)
    remaining.delete(next)
  }
  // 防御：环已被阻断，理论上不会剩下未就绪者；真剩下了也如实报告，不静默丢弃
  for (const id of [...remaining].sort(compareText)) {
    blocked.push({ id, reason: '依赖链未能就绪（内核内部不一致）' })
  }

  return { ordered, blocked }
}

/**
 * Tarjan 强连通分量（迭代版，避免递归深度）。
 *
 * @returns id → 分量号。同分量 ⇒ 互相可达 ⇒ 一起阻断。
 */
function stronglyConnected(
  ids: readonly string[],
  adj: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, number> {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const componentOf = new Map<string, number>()
  let counter = 0
  let component = 0

  for (const root of ids) {
    if (index.has(root)) continue
    const frames: { node: string; index: number }[] = [{ node: root, index: 0 }]
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      if (frame === undefined) break
      const node = frame.node
      if (frame.index === 0) {
        index.set(node, counter)
        low.set(node, counter)
        counter += 1
        stack.push(node)
        onStack.add(node)
      }
      const deps = adj.get(node) ?? []
      if (frame.index < deps.length) {
        const next = deps[frame.index]
        frame.index += 1
        if (next === undefined) continue
        if (!index.has(next)) {
          frames.push({ node: next, index: 0 })
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0))
        }
        continue
      }
      frames.pop()
      const parent = frames[frames.length - 1]
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(node) ?? 0))
      }
      if (low.get(node) === index.get(node)) {
        for (;;) {
          const member = stack.pop()
          if (member === undefined) break
          onStack.delete(member)
          componentOf.set(member, component)
          if (member === node) break
        }
        component += 1
      }
    }
  }
  return componentOf
}

/**
 * 在 SCC 内找一条**具体的**环路径（起点取分量内最小 id，按排序后的邻接走）。
 *
 * 理由里给出 `a → b → a` 而不是"某处有环"，是因为"成环"这条诊断最终要能指导改哪一行。
 * 有步数预算：病态图上退化为"分量成员列表 + 回到起点"，仍如实说明是环。
 */
function findCyclePath(
  start: string,
  adj: ReadonlyMap<string, readonly string[]>,
  members: ReadonlySet<string>,
): readonly string[] {
  const sorted = [...members].sort(compareText)
  const path: string[] = [start]
  const visited = new Set<string>([start])
  const frames: { node: string; index: number }[] = [{ node: start, index: 0 }]
  let budget = 10_000
  while (frames.length > 0 && budget > 0) {
    budget -= 1
    const frame = frames[frames.length - 1]
    if (frame === undefined) break
    const deps = adj.get(frame.node) ?? []
    if (frame.index >= deps.length) {
      frames.pop()
      path.pop()
      visited.delete(frame.node)
      continue
    }
    const next = deps[frame.index]
    frame.index += 1
    if (next === undefined || !members.has(next)) continue
    if (next === start) return [...path, start]
    if (visited.has(next)) continue
    visited.add(next)
    path.push(next)
    frames.push({ node: next, index: 0 })
  }
  return [...sorted, start]
}

/** 会话内的深度档位表。 */
export class FocusTable {
  readonly #depth = new Map<string, { depth: string; reason: string; setAt: number }>()

  set(session: string, depth: string, reason: string, now: number): void {
    this.#depth.set(session, { depth, reason, setAt: now })
  }

  get(session: string): { depth: string; reason: string; setAt: number } | undefined {
    return this.#depth.get(session)
  }

  clear(session: string): void {
    this.#depth.delete(session)
  }
}

/** 默认健康值：模块未上报时的占位（state ok、detail 明确说明是占位）。 */
export function unreportedHealth(id: string): ModuleHealth {
  return { state: 'ok', detail: `模块 ${id} 未上报健康；按缺省视为正常` }
}
