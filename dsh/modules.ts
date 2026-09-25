/**
 * 模块发现与装配。
 *
 * 设计要点：
 * - **模块入口属于模块自己**（`modules/<name>/index.ts` 或 `module.ts`），
 *   不在 `dsh/` 下复制一层"入口文件"。
 * - **宿主按行加载的是组件包入口**（`@omb/<组件>` → `packages/<组件>/index.ts`），
 *   它只做 re-export + `export default toHostPlugin(...)`，实现仍在本目录的模块里。
 * - **发现靠一份静态导入清单**（`moduleEntries.ts`），按**结构**判定模块形状：
 *   队友实际用了 `artifactModule` / `profileModule` / `reasoningRegistration` /
 *   `vectorModule` 等多种导出命名，按名字白名单会不断漏。
 * - 为什么不是 `import.meta.glob`：那是 Vite 专有构造，**`tsc` 不会转换它**，
 *   编译产物里会留下 `import.meta.glob(...)`，而插件的运行环境是宿主 Node 进程，
 *   结果就是 `TypeError: import.meta.glob is not a function`——插件根本装不上。
 * - 为什么不运行期扫目录：动态 `import()` 是异步的，而宿主要求所有注册在
 *   `apply` **返回前**完成（热插拔 H-2：挂载审计只查一次，事后注册会触发
 *   进程级失败告警）。静态导入同时满足"编译后是普通 import"与"apply 前完成"。
 * - **代价**：新增模块要在 `moduleEntries.ts` 加一行。为防漏加，
 *   `tests/dsh/modules.test.ts` 会扫描 `cordis.patch.yml` 并要求每个模块入口
 *   都在清单中——漏加会变成一条失败的测试，而不是一个静默缺席的功能。
 */
import type { ModuleRegistration } from '../kernel/abi/index.js'

/** 模块入口的候选文件名。按目录名发现，与模块 id 无耦合。 */
export const ENTRY_FILES = ['index', 'module'] as const

export interface LoadModulesResult {
  readonly modules: readonly ModuleRegistration<unknown>[]
  /** 发现但无法识别的入口，附可读原因。 */
  readonly failures: readonly { readonly path: string; readonly reason: string }[]
  /**
   * 非致命但**应当可见**的情形。
   *
   * 目前装的是"同一入口同时导出具名注册项与 `default` 包装器"——这是本仓库的
   * **正常形态**（`default` 供宿主按行加载，具名项供内核原生路径装配），
   * 所以不是失败；但"挑选规则决定了行为"这件事必须可见，否则同一份代码在
   * 不同运行时下表现不同而无人察觉（Node ESM 字典序 vs Vite 源码顺序，踩过）。
   */
  readonly warnings: readonly string[]
}

/**
 * 从模块命名空间里挑出符合 `ModuleRegistration` 形状的导出。
 *
 * 判据是**结构**而非导出名：队友实际用了
 * `artifactModule` / `profileModule` / `reasoningRegistration` /
 * `vectorModule` 等多种命名，按名字白名单会不断漏。
 *
 * **两个必须处理的真实情形**（都踩过）：
 * 1. 有些模块同时导出"裸 manifest"与"完整注册项"（如 `vectorManifest` 与
 *    `vectorModule`，**同一个 id**）。裸 manifest 能通过 `isRegistration`
 *    （它有 `manifest.id` 且 `manifest.configSchema.parse` 是函数），
 *    于是会被当成一个模块收下，再因 id 重复把真正的注册项挤掉。
 *    → 用 `hasApply` 区分，并在**同一 id 下优先保留可运行的那个**。
 * 2. zod 的 `configSchema` 自身也有 `parse`，所以"有 parse 就是模块"不成立。
 */
export function pickRegistrations(namespace: unknown): readonly ModuleRegistration<unknown>[] {
  if (typeof namespace !== 'object' || namespace === null) return []
  const byId = new Map<string, Candidate>()

  for (const [key, value] of Object.entries(namespace as Record<string, unknown>)) {
    if (!isRegistrationShape(value)) continue
    const id = (value as ModuleRegistration<unknown>).manifest.id
    const hasApply = typeof (value as { apply?: unknown }).apply === 'function'
    const existing = byId.get(id)
    // 挑选优先级（三条都必要，各自对应一次真实故障）：
    // ① 可运行的注册项优先于"裸清单"（vector.ts 同时导出 vectorManifest 与 vectorModule）
    // ② **具名导出优先于 `default`**：`default` 按约定是宿主插件包装器
    //    （`toHostPlugin`），它只在"第一参是宿主 ctx"时能工作；而本函数的消费者
    //    （`mount`/`start`）走内核原生路径，必须拿具名注册项。
    //    这条踩得很深：Node ESM 的命名空间键是**字典序**，`default` 排在
    //    `registration`/`vectorModule` 等之前 ⇒ 5 个模块被选中包装器后**静默失效**；
    //    而 vitest（Vite 按源码顺序建键，`default` 在最后）下**不复现**，
    //    于是 773 个测试全绿地掩盖了它。
    // ③ 两条都不满足时保留先到的（顺序稳定，便于诊断）
    const better = existing === undefined
      || (hasApply && !existing.hasApply)
      || (key !== DEFAULT_EXPORT_KEY && existing.key === DEFAULT_EXPORT_KEY)
    if (better) byId.set(id, { registration: value as ModuleRegistration<unknown>, hasApply, key })
  }

  return [...byId.values()]
    .sort((a, b) => {
      const left = a.registration.manifest.id
      const right = b.registration.manifest.id
      return left < right ? -1 : left > right ? 1 : 0
    })
    .map(entry => entry.registration)
}

/** ESM 默认导出的键名。它在命名空间里总是存在，且字典序靠前。 */
const DEFAULT_EXPORT_KEY = 'default'

/**
 * 取**唯一**同名注册项——组件包入口（`packages/<组件>/index.ts`）用。
 *
 * 组件包入口只做两件转发：把真正的注册项 re-export 出去（内核原生装配路径用），
 * 并把 `toHostPlugin(registration)` 作为 `default`（宿主逐行加载时读的就是它）。
 *
 * 这里把"入口里恰好有一个目标 id 的注册项"变成一条**会抛的判据**：组件的
 * `manifest.id` 与行 id 不一致时，装配期就响亮失败，而不是加载出一个
 * "看起来正常、实际没有任何能力"的空壳——本项目在这上面吃过两次亏
 * （`default` 包装器被当成模块、`vectorManifest` 挤掉 `vectorModule`）。
 *
 * @param namespace - 组件包的模块实现命名空间（`import * as` 的结果）。
 * @param id - 该组件的模块 id（取自模块自己导出的常量，不在这里硬编码）。
 * @throws 当同名注册项不是恰好一个时。
 */
export function registrationFor(namespace: unknown, id: string): ModuleRegistration<unknown> {
  const matches = pickRegistrations(namespace).filter(entry => entry.manifest.id === id)
  if (matches.length !== 1) {
    const keys = typeof namespace === 'object' && namespace !== null
      ? Object.keys(namespace as Record<string, unknown>).join('、')
      : String(namespace)
    throw new Error(
      `组件入口应恰好导出一个 id 为 ${id} 的注册项，实际 ${matches.length} 个（导出：${keys}）`,
    )
  }
  return matches[0] as ModuleRegistration<unknown>
}

/** 该命名空间是否导出了 default。 */
export function hasDefaultExport(namespace: unknown): boolean {
  if (typeof namespace !== 'object' || namespace === null) return false
  return (namespace as Record<string, unknown>)[DEFAULT_EXPORT_KEY] !== undefined
}

/**
 * 找出「同一 id 有多个可运行注册项」的歧义。
 *
 * 用途：把"行为由枚举顺序决定"这件事变成一条可见告警。它不是错误
 * （挑选规则是确定的），但**必须可见**——否则同一份代码在不同运行时下
 * 表现不同而无人察觉。
 */
export function ambiguousIds(namespace: unknown): readonly string[] {
  if (typeof namespace !== 'object' || namespace === null) return []
  const count = new Map<string, number>()
  for (const value of Object.values(namespace as Record<string, unknown>)) {
    if (!isRegistrationShape(value)) continue
    const id = (value as ModuleRegistration<unknown>).manifest.id
    count.set(id, (count.get(id) ?? 0) + 1)
  }
  return [...count.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort()
}

interface Candidate {
  readonly registration: ModuleRegistration<unknown>
  readonly hasApply: boolean
  readonly key: string
}

/** 形状判定：有 `manifest.id`、有 `configSchema.parse`、有 `apply`。 */
function isRegistrationShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as {
    manifest?: { id?: unknown; configSchema?: { parse?: unknown } }
    apply?: unknown
  }
  return typeof candidate.manifest?.id === 'string'
    && typeof candidate.manifest.configSchema?.parse === 'function'
    && typeof candidate.apply === 'function'
}

/**
 * 判断一个入口路径是不是"模块入口"。
 *
 * 规则：`modules/<name>/<file>` 或 `<name>/<file>`——即**模块目录下的直接文件**。
 * 子目录里的文件（`modules/memory/foo/bar`）不是入口。
 *
 * **不再要求文件名必须是 `index`/`module`**：这个假设是错的且已经咬过一次——
 * `modules/memory/vector.ts` 是合法的模块入口（它有 `manifest` 与 `apply`），
 * 却因为文件名不叫 index/module 被静默跳过，于是 `omb-memory-vector` 行
 * 永远装配不上。判据应当是**形状**（`pickRegistrations` 能认出注册项），
 * 而不是文件名。
 */
export function isModuleEntry(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(p => p.length > 0)
  const withoutRoot = parts[0] === 'modules' ? parts.slice(1) : parts
  // 恰好 `<模块目录>/<文件>` 两段；末段去掉扩展名后须非空
  return withoutRoot.length === 2 && (withoutRoot[1] ?? '').replace(/\.(ts|js)$/, '').length > 0
}

/**
 * 从「入口路径 → 已加载命名空间」的映射装配模块。
 *
 * **同步纯函数**：异步加载由调用方在 `apply` **之前**完成
 * （见 `moduleEntries.ts` 的顶层静态 import），因此这里没有 await，
 * 也就不存在"apply 返回后异步注册"的风险。
 *
 * **歧义会被记成失败**：一个入口导出多个同 id 的可运行注册项时（例如同时有
 * `default` 包装器与具名注册项），挑选规则决定行为——把这件事**说出来**，
 * 而不是让它靠枚举顺序静默决定。实测就吃过这个亏（Node ESM 字典序 vs
 * Vite 源码顺序，导致同一份代码在 tsx 下失效、在 vitest 下正常）。
 */
export function loadModulesSync(entries: ReadonlyMap<string, unknown>): LoadModulesResult {
  const modules: ModuleRegistration<unknown>[] = []
  const failures: { path: string; reason: string }[] = []
  const warnings: string[] = []
  const seenIds = new Set<string>()

  for (const [path, namespace] of entries) {
    if (!isModuleEntry(path)) continue
    const picked = pickRegistrations(namespace)
    // 一个入口同时有具名注册项与 default 包装器时，挑选规则决定了用哪个。
    // 记录**选了哪个**——这是排查"模块静默失效"时唯一有用的信息。
    if (picked.length > 0 && hasDefaultExport(namespace)) {
      warnings.push(
        `${path}：同时导出具名注册项与 default 包装器，已选具名项`
        + `（${picked.map(r => r.manifest.id).join('、')}）——内核原生路径必须用具名项`,
      )
    }
    if (picked.length === 0) {
      failures.push({ path, reason: '入口未导出 ModuleRegistration 形状的对象' })
      continue
    }
    for (const registration of picked) {
      const id = registration.manifest.id
      if (seenIds.has(id)) {
        failures.push({ path, reason: `模块 id 重复：${id}` })
        continue
      }
      seenIds.add(id)
      modules.push(registration)
    }
  }

  // 顺序稳定（按 id 排序），使启动顺序与文件系统枚举顺序无关。
  // 比较器三态必须完整（相等返回 0）：返回 1 违反排序契约，
  // V8 的 TimSort 会据此产生未定义行为——实测会**静默丢元素**。
  modules.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0))
  return { modules, failures, warnings }
}
