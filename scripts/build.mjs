/**
 * 构建到"新的一代"产物目录，并把**每个组件包**的入口指过去。
 *
 * **为什么构建要换代**：DSH 的插件行能免重启动态增删，但**模块代码走 Node 标准
 * ESM 按 URL 缓存**（宿主源码：`resolver.ts:128` "existing modules and Node caches
 * remain intact"）。同一个路径重新安装 → 跑的还是**旧模块实例**，
 * 于是"激活失败"之类的报错完全不能反映当前源码——**极易误判**。
 *
 * 每次构建写一个新代数目录（`lib-gen/g1` → `g2` → …），URL 必然变化，
 * 加载的必然是本次构建的代码。构建后打印代数，运行期可经 `omb_status` 核对。
 *
 * **为什么还要刷新各组件包的 package.json**：`cordis.patch.yml` 的行名现在是
 * **裸顶层包名**（`@omb/<组件>`，见该文件顶部说明），代数号不能出现在行名里。
 * 于是换代由每条组件包入口承担：
 *
 * ```
 * packages/<组件>/lib-gen/g<N>/index.js   ← 生成的一层薄转发（URL 里带代数）
 *   ↓ export * / export { default }
 * lib-gen/g<N>/packages/<组件>/index.js   ← tsc 产物（实现全在 root 的 lib-gen/g<N>/）
 * ```
 *
 * 组件包的 `main`/`exports` 由本脚本刷新指向 `./lib-gen/g<N>/index.js`。
 * 为什么转发文件必须**落在包内**：Node 的 `exports` 目标不得逃出包目录
 * （越界目标报 `ERR_INVALID_PACKAGE_TARGET`），而 `main` 里写 `..` 在
 * **符号链接安装**下会被按未 realpath 的包目录拼接，指向 profile 里的不存在路径
 * （两种情况都实测过）。落在包内则每一跳都能沿符号链接找到真实文件。
 *
 * 用法：`node scripts/build.mjs`
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE = join(ROOT, 'lib-gen', '.stage')
const BUILD_ROOT = join(ROOT, 'lib-gen')
const GENERATION_FILE = join(ROOT, 'build-generation.json')
const PATCH_FILE = join(ROOT, 'cordis.patch.yml')
const PACKAGES_ROOT = join(ROOT, 'packages')
const ROOT_MANIFEST = join(ROOT, 'package.json')

/** tsc 产出的顶层目录（构建后整体移进本次代数目录）。 */
const COMPILED_DIRS = ['kernel', 'modules', 'dsh', 'packages']

/** 源码目录（.ts）——用于陈旧检测。 */
const SOURCE_DIRS = ['kernel', 'modules', 'dsh', 'packages']

/** 允许被清理的旧代目录名：只匹配我们自己生成的 `g<数字>`，绝不误删别的目录。 */
const GENERATION_DIR = /^g\d+$/

/** 裸顶层包名：`@scope/name` 或 `name`，不含子路径、不含查询串。 */
const BARE_PACKAGE_NAME = /^(?:@[^/@\s]+\/[^/@\s]+|[^@/\s][^/\s]*)$/

/** 递归找目录下最新的文件 mtime（毫秒）；目录为空返回 0。 */
function newestMtime(dir, extension) {
  let newest = 0
  const walk = current => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith(extension)) {
        try {
          const { mtimeMs } = statSync(full)
          if (mtimeMs > newest) newest = mtimeMs
        } catch {
          // 读不到就跳过，不让诊断本身失败
        }
      }
    }
  }
  walk(dir)
  return newest
}

/**
 * 陈旧检测：产物比源码旧就**明确报错**。
 *
 * 为什么必须做这一步：我把源码改了却忘了重建，结果装到宿主后跑的是旧产物，
 * 于是"功能没生效"被误判成代码问题——实际只是没构建。
 * 这类误判在"改一版装一版"的循环里极易发生，所以要让它响亮地失败。
 */
function assertFresh(outDirPath) {
  const newestSource = Math.max(
    ...SOURCE_DIRS.map(dir => newestMtime(join(ROOT, dir), '.ts')),
  )
  const newestArtifact = newestMtime(outDirPath, '.js')
  if (newestArtifact === 0) throw new Error(`[build] ${outDirPath} 里没有 .js 产物`)
  if (newestSource > newestArtifact) {
    const lag = Math.round((newestSource - newestArtifact) / 1000)
    throw new Error(
      `[build] 产物比源码旧 ${lag} 秒——tsc 没产出最新代码。`
      + `请检查 tsconfig.build.json 的 include/exclude 是否漏了刚改的文件。`,
    )
  }
  return { newestSource, newestArtifact }
}

function readGeneration() {
  if (!existsSync(GENERATION_FILE)) return { generation: 0, outDir: '' }
  try {
    const parsed = JSON.parse(readFileSync(GENERATION_FILE, 'utf8'))
    return {
      generation: typeof parsed.generation === 'number' ? parsed.generation : 0,
      outDir: typeof parsed.outDir === 'string' ? parsed.outDir : '',
    }
  } catch {
    return { generation: 0, outDir: '' }
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function main() {
  const previous = readGeneration()
  const generation = previous.generation + 1
  const outDir = `lib-gen/g${generation}`

  // 1) 编译到暂存目录（tsc 的 outDir 是 lib-gen，之后整体改名到 g<N>）
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })
  process.stdout.write(`[build] tsc → ${outDir}\n`)
  // 直接跑 tsc 的入口脚本：Windows 上 `npx` 是 .cmd，不设 shell 会 ENOENT
  const tscEntry = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [tscEntry, '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  })

  // tsc 会把产物写到 lib-gen/{kernel,modules,dsh,packages}；移进本次代数目录
  const target = join(BUILD_ROOT, `g${generation}`)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const dir of COMPILED_DIRS) {
    const from = join(BUILD_ROOT, dir)
    if (!existsSync(from)) throw new Error(`[build] 缺少编译产物 ${dir}/——tsc 没产出？`)
    cpSync(from, join(target, dir), { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  rmSync(join(BUILD_ROOT, '.tsbuildinfo'), { force: true })
  rmSync(STAGE, { recursive: true, force: true })

  // 2) 陈旧检测：产物必须比源码新
  const freshness = assertFresh(target)

  // 3) 先**只读校验**再写：patch 里出现坏行名（相对路径 / 子路径 / ?v=）时
  //    立刻失败，且此时还没动过任何组件包的 package.json——
  //    否则会留下"package.json 指向 g<N+1>、代数文件还写着 g<N>"的半成品。
  const entries = readComponentDisplay()
  assertPatchRows(entries)

  // 4) 刷新每个组件包：locale 文件 + 本代入口转发 + main/exports 指向本代
  writeComponentPackages(entries, generation)

  // 5) 写代数文件（运行期经它核对"现在跑的是哪一代"）
  writeFileSync(
    GENERATION_FILE,
    `${JSON.stringify(
      { outDir, generation, builtAt: new Date().toISOString(), ...freshness },
      null,
      2,
    )}\n`,
  )

  // 6) 清掉更早的代数目录（**只删自己生成的 g<数字>**，不碰别的东西）
  for (const entry of readdirSync(BUILD_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !GENERATION_DIR.test(entry.name)) continue
    if (entry.name === `g${generation}`) continue
    rmSync(join(BUILD_ROOT, entry.name), { recursive: true, force: true })
  }

  process.stdout.write(`[build] 第 ${generation} 代就绪：${outDir}（${entries.length} 个组件包已指向本代）\n`)
  process.stdout.write('[build] 重新安装插件即可加载本代代码（组件包入口 URL 已变，不受 ESM 缓存影响）\n')
}

/**
 * 从 `kernel/display.ts` 解析出组件显示元数据。
 *
 * 直接读源码而不用 `import`：那是 `.ts`，Node 不能直接加载；而为它加构建步骤
 * 只为了拿 8 条显示名，代价不成比例。格式固定（我们自己写的），正则够用，
 * 且解析结果会与 `cordis.patch.yml` 的行 id 交叉校验——解析漏了会立刻报错。
 */
function readComponentDisplay() {
  const source = readFileSync(join(ROOT, 'kernel', 'display.ts'), 'utf8')
  const entries = []
  const block = /\{\s*rowId:\s*'([^']+)',\s*packageName:\s*'([^']+)',\s*zh:\s*'([^']*)',\s*en:\s*'([^']*)',\s*zhDescription:\s*'((?:[^'\\]|\\.)*)',\s*enDescription:\s*'((?:[^'\\]|\\.)*)',\s*\}/g
  for (const match of source.matchAll(block)) {
    entries.push({
      rowId: match[1],
      packageName: match[2],
      // 目录名 = 包名去掉 scope（与 kernel/display.ts 的 componentDirOf 同一规则）
      dir: match[2].replace(/^@[^/]+\//, ''),
      zh: match[3],
      en: match[4],
      zhDescription: match[5].replace(/\\'/g, "'"),
      enDescription: match[6].replace(/\\'/g, "'"),
    })
  }
  if (entries.length === 0) {
    throw new Error('[build] 未能从 kernel/display.ts 解析出组件显示元数据——检查那里的字面量格式')
  }
  return entries
}

/**
 * 刷新每个组件包的三样东西：
 *
 * 1. `locale/{en,zh}.json` —— 插件页的标题与说明。**唯一真源是 `kernel/display.ts`**
 *    （`readPluginMeta` 取 `<包名>/locale/zh.json` 的 `meta.title`/`meta.description`），
 *    所以只在这里生成，不要在 locale 文件里手改。
 * 2. `lib-gen/g<N>/index.js` —— 本代的一层薄转发（URL 带代数 = 绕过 ESM 缓存）。
 * 3. `package.json` 的 `main` 与 `exports['.']` 指向 2 的转发文件。
 *
 * 同时做三条**会失败**的核对，把"静默失效"挡在构建期：
 * 组件包目录/入口存在、包名与显示表一致、根包 dependencies 里挂着它们
 * （profile 只装装配包时，`@omb/<组件>` 正是经装配包自己的 `node_modules`
 * 解析到的——少了依赖就解析不到，8 行全 failed to import）。
 */
function writeComponentPackages(entries, generation) {
  const pointer = `./lib-gen/g${generation}/index.js`
  const rootManifest = readJson(ROOT_MANIFEST)
  const rootDeps = rootManifest.dependencies ?? {}
  const missingDeps = []

  for (const entry of entries) {
    const pkgDir = join(PACKAGES_ROOT, entry.dir)
    const manifestPath = join(pkgDir, 'package.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`[build] 缺少组件包 ${entry.packageName}（${manifestPath}）——行名与 packages/ 必须一一对应`)
    }
    const manifest = readJson(manifestPath)
    if (manifest.name !== entry.packageName) {
      throw new Error(
        `[build] ${manifestPath} 的 name 是 ${String(manifest.name)}，`
        + `而 kernel/display.ts 里 ${entry.rowId} 的 packageName 是 ${entry.packageName}`,
      )
    }
    const sourceEntry = join(pkgDir, 'index.ts')
    if (!existsSync(sourceEntry)) throw new Error(`[build] 组件包 ${entry.packageName} 缺入口 ${sourceEntry}`)
    const compiledEntry = join('packages', entry.dir, 'index.js')
    if (!existsSync(join(BUILD_ROOT, `g${generation}`, compiledEntry))) {
      throw new Error(`[build] 组件包 ${entry.packageName} 没有编译产物 ${compiledEntry}——检查 tsconfig.build.json 的 include`)
    }

    // 1) 插件页的标题与说明
    const localeDir = join(pkgDir, 'locale')
    mkdirSync(localeDir, { recursive: true })
    writeFileSync(
      join(localeDir, 'en.json'),
      `${JSON.stringify({ meta: { title: entry.en, description: entry.enDescription } }, null, 2)}\n`,
    )
    writeFileSync(
      join(localeDir, 'zh.json'),
      `${JSON.stringify({ meta: { title: entry.zh, description: entry.zhDescription } }, null, 2)}\n`,
    )

    // 2) 本代入口转发。**必须在包内**：exports 目标不得逃出包目录；
    //    相对路径按"包目录/lib-gen/g<N>/index.js"起算，四层上一级到仓库根。
    const shimDir = join(pkgDir, 'lib-gen', `g${generation}`)
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(
      join(shimDir, 'index.js'),
      `// 生成文件（scripts/build.mjs）——不要手改，改动会在下次构建被覆盖。\n`
      + `export * from '../../../../lib-gen/g${generation}/packages/${entry.dir}/index.js'\n`
      + `export { default } from '../../../../lib-gen/g${generation}/packages/${entry.dir}/index.js'\n`,
    )

    // 3) main / exports 指向本代
    manifest.main = pointer
    const exports = { ...manifest.exports, '.': pointer }
    manifest.exports = exports
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    // 清掉本包里更早的代数目录
    const shimRoot = join(pkgDir, 'lib-gen')
    for (const item of readdirSync(shimRoot, { withFileTypes: true })) {
      if (!item.isDirectory() || !GENERATION_DIR.test(item.name)) continue
      if (item.name === `g${generation}`) continue
      rmSync(join(shimRoot, item.name), { recursive: true, force: true })
    }

    if (rootDeps[entry.packageName] !== 'workspace:*') missingDeps.push(entry.packageName)
  }

  if (missingDeps.length > 0) {
    throw new Error(
      `[build] 根 package.json 的 dependencies 缺少这些组件包（写 "workspace:*"）：\n  ${missingDeps.join('\n  ')}\n`
      + 'profile 只装装配包时，行名 `@omb/<组件>` 正是经装配包自己的 node_modules 解析到的；缺了就是 8 行解析失败。',
    )
  }
  return entries
}

/**
 * 核对 `cordis.patch.yml` 的每一行 OMB 行名。
 *
 * 这是本设计最容易回退的地方（历史上回过退：相对路径能跑但没中文名，
 * 裸包名 + 子路径有中文名但跑不起来都被试过），所以让构建**响亮地失败**：
 * 行名必须是裸顶层包名、且在显示表里、且每个组件都有一行。
 */
function assertPatchRows(entries) {
  const yaml = readFileSync(PATCH_FILE, 'utf8')
  const rows = [...yaml.matchAll(/- id:\s*(omb-[\w-]+)\s*\n\s*name:\s*'([^']+)'/g)]
    .map(match => [match[1], match[2]])
  if (rows.length === 0) throw new Error('[build] cordis.patch.yml 里没有可识别的 OMB 行')

  const known = new Map(entries.map(entry => [entry.packageName, entry.rowId]))
  const declared = new Map()
  for (const [id, name] of rows) {
    if (name.includes('?v=')) throw new Error(`[build] 行 ${id} 的 name 带了 ?v= —— 宿主会把它当文件名字面量：${name}`)
    if (!BARE_PACKAGE_NAME.test(name)) {
      throw new Error(
        `[build] 行 ${id} 的 name「${name}」不是裸顶层包名。`
        + '相对路径的行拿不到本地化元数据，"裸包名 + 子路径"宿主解析不了（见 cordis.patch.yml 顶部说明）。',
      )
    }
    if (!known.has(name)) throw new Error(`[build] 行 ${id} 的 name「${name}」在 kernel/display.ts 里没有对应组件`)
    if (declared.has(name)) throw new Error(`[build] 行 ${id} 与 ${declared.get(name)} 指向同一个包 ${name}`)
    declared.set(name, id)
  }
  for (const entry of entries) {
    if (!declared.has(entry.packageName)) {
      throw new Error(`[build] 组件 ${entry.rowId}（${entry.packageName}）在 cordis.patch.yml 里没有行——插件页看不到这个开关`)
    }
  }

  // 装配包自己的 node_modules 就是行名的解析落点：缺了 symlink 会静默解析失败。
  const unresolved = entries.filter(entry => !existsSync(join(ROOT, 'node_modules', entry.packageName, 'package.json')))
  if (unresolved.length > 0) {
    process.stdout.write(
      `[build] 提醒：node_modules 里还没有 ${unresolved.map(e => e.packageName).join('、')}`
      + ' ——跑一次 pnpm install（否则 profile 里这 8 行会解析失败）\n',
    )
  }
}

main()
