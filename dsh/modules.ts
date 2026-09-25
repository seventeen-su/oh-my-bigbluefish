/**
 * 模块发现与装配。
 *
 * 设计要点：
 * - **模块入口属于模块自己**（`modules/<name>/index.ts` 或 `module.ts`），
 *   不在 `dsh/` 下复制一层"入口文件"。因此 `cordis.patch.yml` 的 `name`
 *   直接指向 `lib/modules/<name>/index.js`。
 * - **发现是自动的**：`import.meta.glob` 在构建时静态展开，新增模块
 *   **不需要改本文件**。这是"模块化"的真实检验——若每加一个模块都要改装配
 *   代码，那就不是模块化。
 * - **必须是同步的**（eager）：宿主挂载审计只查一次，`apply` 返回后异步注册
 *   会触发进程级失败告警（热插拔 H-2）。因此用 eager glob 而非异步 glob。
 * - 某个模块导入失败**不影响其余**：记入失败清单，由调用方记健康面。
 */
import type { ModuleRegistration } from '../kernel/abi/index.js'

/** 模块入口的候选文件名。按目录名发现，与模块 id 无耦合。 */
const ENTRY_FILES = ['index.ts', 'module.ts'] as const

export interface LoadModulesResult {
  readonly modules: readonly ModuleRegistration<unknown>[]
  /** 发现但无法识别的入口，附可读原因。 */
  readonly failures: readonly { readonly path: string; readonly reason: string }[]
}

/**
 * 从模块命名空间里挑出符合 `ModuleRegistration` 形状的导出。
 *
 * 判据是**结构**而非导出名：队友实际用了
 * `artifactModule` / `profileModule` / `reasoningRegistration` / `vectorModule`
 * 等多种命名，按名字白名单会不断漏。
 */
export function pickRegistrations(namespace: unknown): readonly ModuleRegistration<unknown>[] {
  if (typeof namespace !== 'object' || namespace === null) return []
  const found: ModuleRegistration<unknown>[] = []
  const seen = new Set<unknown>()
  for (const value of Object.values(namespace as Record<string, unknown>)) {
    if (!isRegistration(value)) continue
    if (seen.has(value)) continue // 工厂函数与其返回的常量可能指向同一对象
    seen.add(value)
    found.push(value)
  }
  return found
}

function isRegistration(value: unknown): value is ModuleRegistration<unknown> {
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
 * 发现全部模块入口。
 *
 * eager 意味着这些模块在插件加载时就被静态 import——这也顺带保证
 * "模块文件写坏了"会在加载时立刻暴露，而不是等到某个功能被调用时。
 */
const ENTRIES = import.meta.glob('../modules/*/{index,module}.ts', { eager: true }) as Record<string, unknown>

/** 只取顶层模块目录的入口（排除子目录里的同名文件）。 */
function isModuleEntry(path: string): boolean {
  const parts = path.replace('../modules/', '').split('/')
  if (parts.length !== 2) return false
  return (ENTRY_FILES as readonly string[]).includes(parts[1] ?? '')
}

export function loadModules(): LoadModulesResult {
  const modules: ModuleRegistration<unknown>[] = []
  const failures: { path: string; reason: string }[] = []
  const seenIds = new Set<string>()

  for (const [path, namespace] of Object.entries(ENTRIES)) {
    if (!isModuleEntry(path)) continue
    const picked = pickRegistrations(namespace)
    if (picked.length === 0) {
      failures.push({ path: path.replace('../', ''), reason: '入口未导出 ModuleRegistration 形状的对象' })
      continue
    }
    for (const registration of picked) {
      const id = registration.manifest.id
      if (seenIds.has(id)) {
        failures.push({ path: path.replace('../', ''), reason: `模块 id 重复：${id}` })
        continue
      }
      seenIds.add(id)
      modules.push(registration)
    }
  }

  // 顺序稳定（按 id 排序），使启动顺序与文件系统枚举顺序无关
  modules.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0))
  return { modules, failures }
}
