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
 * 后果：改完代码重新安装，如果加载的路径没变，**跑的还是旧代码**，
 * 于是"激活失败"这类报错根本不能反映当前源码——**极易误判**。
 *
 * 修法：产物放进**带代数后缀**的目录（`lib-gen/g1`、`g2`…），
 * 每次构建换代 → URL 变 → 必然加载新模块。
 * `cordis.patch.yml` 的行名是裸包名（不含代数），换代由每个组件包
 * `package.json` 的 `main`/`exports` 指向 `lib-gen/g<N>/` 承担——
 * 见 `scripts/build.mjs`。
 *
 * 本文件是**唯一**的代数真源：`BUILD_ROOT` / `OUT_DIR_PATTERN` / `GENERATION_FILE` /
 * `outDirFor` 由 `scripts/build.mjs` 消费（它连 tsc 的 `--outDir` 都由 `BUILD_ROOT` 推出），
 * 运行期只经 `generationFromUrl`（自己的 URL 里就带代数）核对。
 *
 * **不要**在这里写"代数会随 `apply` 的返回值带出去"这类话：代码里从来没有这件事
 * （`apply` 的返回值是宿主插件的清单，代数只从 URL 或代数文件读）。
 * 曾经存在过这句假陈述，读到它的人会以为运行期读的是"返回值里的代数"而不再核对，
 * 而真正唯一的核对路径是下面的 `generationFromUrl` 与 `parseGeneration`。
 */

/**
 * 产物根目录（相对仓库根）。
 *
 * 改它必须**同时**满足两件事，否则 `scripts/build.mjs` 会当场报错而不是静默跑偏：
 *   ① `scripts/build.mjs` 用它推 tsc 的 `--outDir` 与代数目录；
 *   ② `OUT_DIR_PATTERN` 由它派生，于是目录形状自动跟着变。
 * 唯一的例外是 `tsconfig.build.json` 的 `outDir` 字面量——那条配置在构建时被
 * `--outDir` 覆盖，只对"手工直接跑 tsc"有意义。
 */
export const BUILD_ROOT = 'lib-gen'

/** 把常量里的正则元字符转义掉（目录名按字面量匹配，不做模式解释）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 产物目录名的形状：`<BUILD_ROOT>/g<代数>`。
 *
 * **由 `BUILD_ROOT` 派生**，不写死 `lib-gen`：写死会让"改 BUILD_ROOT"变成
 * 改一处、静默跑偏一处。`scripts/build.mjs` 在写任何文件之前断言它。
 */
export const OUT_DIR_PATTERN = new RegExp(`^${escapeRegExp(BUILD_ROOT)}/g\\d+$`)

/** 代数文件的路径（相对仓库根）。 */
export const GENERATION_FILE = 'build-generation.json'

/** 产物 URL 里的代数片段：`/<BUILD_ROOT>/g<代数>/`。同样由 `BUILD_ROOT` 派生。 */
const GENERATION_IN_URL = new RegExp(`/${escapeRegExp(BUILD_ROOT)}/g(\\d+)/`)

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
 * 产物布局固定为 `<…>/lib-gen/g<代数>/…`：实现是 `lib-gen/g<代数>/dsh/kernel.js`
 * 与 `lib-gen/g<代数>/packages/<组件>/index.js`；组件包里还有一层带代数的转发
 * （`packages/<组件>/lib-gen/g<代数>/index.js`）。三种 URL 都含 `/lib-gen/g<代数>/`，
 * 所以代数可以从**自己的 URL** 读出来——不必读文件、不会因文件缺失而失效。
 * 源码树里（`dsh/kernel.ts`）解析不到，返回 `undefined`，表示"非构建产物运行"。
 *
 * **用途**：`omb_status` 与健康面显示"当前第 N 代"，于是"宿主跑的到底是新代码还是
 * 缓存旧代码"变成一个可观测事实，而不是靠推断。这正是不重启部署下最容易误判的一点。
 */
export function generationFromUrl(url: string): number | undefined {
  const match = GENERATION_IN_URL.exec(url)
  if (match?.[1] === undefined) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : undefined
}
