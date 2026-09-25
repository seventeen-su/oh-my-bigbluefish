/**
 * 模块注册表：依赖拓扑排序 + 生命周期 + 环检测。
 *
 * 内核不实现任何模块；它只保证：
 * ① `requires` 全部存在 ② 无环 ③ 依赖先于被依赖者启动
 * ④ 缺失依赖 → 该模块 `failed` 并写明原因，**不抛到会话**
 */
import type { ModuleHealth, ModuleRegistration } from './abi/index.js'

export interface ResolvedModule {
  readonly id: string
  readonly registration: ModuleRegistration<unknown>
}

export interface RegistryPlan {
  /** 可启动的模块，已按依赖拓扑排序。 */
  readonly ordered: readonly ResolvedModule[]
  /** 因缺失依赖或成环而无法启动的模块，附原因。 */
  readonly blocked: readonly { readonly id: string; readonly reason: string }[]
}

/**
 * 解析注册集合。纯函数，无副作用——便于对依赖图单独测试。
 * @param modules 待解析的模块（顺序无关，依赖关系决定启动顺序）。
 */
export function planModules(modules: readonly ModuleRegistration<unknown>[]): RegistryPlan {
  const byId = new Map<string, ModuleRegistration<unknown>>()
  const blocked: { id: string; reason: string }[] = []

  for (const m of modules) {
    const id = m.manifest.id
    if (byId.has(id)) {
      blocked.push({ id, reason: `模块 id 重复：${id}` })
      continue
    }
    byId.set(id, m)
  }

  const ordered: ResolvedModule[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()

  const visit = (id: string, chain: readonly string[]): void => {
    if (done.has(id)) return
    if (visiting.has(id)) {
      blocked.push({ id, reason: `依赖成环：${[...chain, id].join(' → ')}` })
      return
    }
    const m = byId.get(id)
    if (m === undefined) return // 由调用方负责报告缺失依赖
    visiting.add(id)
    for (const dep of m.manifest.requires) {
      if (!byId.has(dep)) {
        blocked.push({ id, reason: `缺少必需依赖：${dep}` })
        continue
      }
      visit(dep, [...chain, id])
    }
    visiting.delete(id)
    if (!done.has(id)) {
      done.add(id)
      ordered.push({ id, registration: m })
    }
  }

  for (const id of byId.keys()) visit(id, [])

  const blockedIds = new Set(blocked.map(b => b.id))
  return { ordered: ordered.filter(m => !blockedIds.has(m.id)), blocked }
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
