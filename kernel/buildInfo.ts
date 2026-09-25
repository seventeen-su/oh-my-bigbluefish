/**
 * 构建产物目录与生成代数。
 *
 * **为什么需要"代数"**：DSH 的插件行可以免重启动态增删（fiber 重挂），
 * 但**模块代码走 Node 标准 ESM 按 URL 缓存**——同一个 URL 再次 import 拿到的是
 * **旧实例**。宿主源码对此有明确说明：
 *
 * - `app-boot/src/profile-resolution/service.ts:79`
 *   *"Linked roots may be removed without unloading modules or clearing Node caches."*
 * - `app-boot/src/profile-resolution/resolver.ts:128`
 *   *"existing modules and Node caches remain intact."*
 *
 * 后果：改完代码重新安装，如果 patch 里的路径没变，**跑的还是旧代码**，
 * 于是"激活失败"这类报错根本不能反映当前源码——**极易误判**。
 *
 * 修法：产物放进**带代数后缀**的目录（`lib-gen/g1`、`g2`…），
 * 每次构建换代 → URL 变 → 必然加载新模块。
 *
 * 本文件是**唯一**的代数来源：`scripts/build.mjs` 写它，
 * `dsh/plugin.ts` 读它并把代数带进 `apply` 的返回值上，供运行期核对。
 */

/** 产物根目录（相对仓库根）。 */
export const BUILD_ROOT = 'lib-gen'

/** 产物目录名的形状：`lib-gen/g<代数>`。 */
export const OUT_DIR_PATTERN = /^lib-gen\/g\d+$/

/** 代数文件的路径（相对仓库根）。 */
export const GENERATION_FILE = 'build-generation.json'

export interface BuildGeneration {
  /** 产物目录（相对仓库根），例如 `lib-gen/g3`。 */
  readonly outDir: string
  /** 代数，从 1 开始递增。 */
  readonly generation: number
  /** 构建时间（ISO）。 */
  readonly builtAt: string
}

/** 生成某代的目录名。代数不合法时按 1 处理（不抛——构建期不该因诊断信息失败）。 */
export function outDirFor(generation: number): string {
  const safe = Number.isFinite(generation) && generation > 0 ? Math.floor(generation) : 1
  return `${BUILD_ROOT}/g${safe}`
}

/** 解析代数文件内容；损坏或形状不符时返回 undefined（调用方如实降级）。 */
export function parseGeneration(raw: unknown): BuildGeneration | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as { outDir?: unknown; generation?: unknown; builtAt?: unknown }
  if (typeof value.outDir !== 'string' || value.outDir.length === 0) return undefined
  if (typeof value.generation !== 'number' || !Number.isFinite(value.generation)) return undefined
  return {
    outDir: value.outDir,
    generation: value.generation,
    builtAt: typeof value.builtAt === 'string' ? value.builtAt : 'unknown',
  }
}

/**
 * 从产物 URL 里解析出代数。
 *
 * 产物布局固定为 `<…>/lib-gen/g<代数>/dsh/kernel.js`，所以代数可以从**自己的 URL**
 * 读出来——不必读文件、不会因文件缺失而失效。源码树里（`dsh/kernel.ts`）解析不到，
 * 返回 `undefined`，表示"非构建产物运行"。
 *
 * **用途**：`omb_status` 与健康面显示"当前第 N 代"，于是"宿主跑的到底是新代码还是
 * 缓存旧代码"变成一个可观测事实，而不是靠推断。这正是不重启部署下最容易误判的一点。
 */
export function generationFromUrl(url: string): number | undefined {
  const match = /\/lib-gen\/g(\d+)\//.exec(url)
  if (match?.[1] === undefined) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : undefined
}
