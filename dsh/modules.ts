/**
 * 模块发现与装配。
 *
 * 设计要点：
 * - **模块入口属于模块自己**（`modules/<name>/index.ts` 或 `module.ts`），
 *   不在 `dsh/` 下复制一层"入口文件"。因此 `cordis.patch.yml` 的 `name`
 *   直接指向 `lib/modules/<name>/index.js`。
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
  const byId = new Map<string, { registration: ModuleRegistration<unknown>; hasApply: boolean }>()

  for (const value of Object.values(namespace as Record<string, unknown>)) {
    if (!isRegistrationShape(value)) continue
    const id = (value as ModuleRegistration<unknown>).manifest.id
    const hasApply = typeof (value as { apply?: unknown }).apply === 'function'
    const existing = byId.get(id)
    // 同一 id 下：可运行的注册项优先于只有清单的导出
    if (existing === undefined || (hasApply && !existing.hasApply)) {
      byId.set(id, { registration: value as ModuleRegistration<unknown>, hasApply })
    }
  }

  return [...byId.values()]
    .sort((a, b) => {
      const left = a.registration.manifest.id
      const right = b.registration.manifest.id
      return left < right ? -1 : left > right ? 1 : 0
    })
    .map(entry => entry.registration)
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
 */
export function loadModulesSync(entries: ReadonlyMap<string, unknown>): LoadModulesResult {
  const modules: ModuleRegistration<unknown>[] = []
  const failures: { path: string; reason: string }[] = []
  const seenIds = new Set<string>()

  for (const [path, namespace] of entries) {
    if (!isModuleEntry(path)) continue
    const picked = pickRegistrations(namespace)
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
  return { modules, failures }
}
