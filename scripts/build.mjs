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
 * **为什么写入必须原子**：9 个 manifest 的 `main` 是**同一次换代的九个分片**。
 * 校验写在写入循环内部时，中途抛出会留下"前 k 个包指 g(N+1)、其余仍指 gN"的
 * 混合代数，且根 `lib-gen` 下两代并存——下一次重启宿主会按包各自解析，
 * 同一进程里加载**两份内核实例**（两份服务总线、两份模块级状态），
 * 而 `omb_status` 只报得出其中一份的代数，另一份静默。
 * 所以本脚本现在是"全量只读校验 → 一次性提交（失败整批回滚）"两段：
 * 见 `planComponentPackages` / `commitFiles`。
 *
 * **常量真源**：产物根、代数文件路径、代数目录形状一律来自
 * `kernel/buildInfo.ts`（该文件是唯一真源，见其头部说明）。
 * 本脚本**不再**自带 `'lib-gen'` 字面量——改 `BUILD_ROOT` 常量，
 * 这里连 tsc 的 `--outDir` 一起跟着变。
 *
 * 用法：`node scripts/build.mjs`
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 唯一真源。为什么写 `.ts` 而不是 `.js`：源码树里**只有** `buildInfo.ts`（没有编译副本，
// `lib-gen/` 不入库），`.js` 说明符在这里解析不到；Node ≥22.18 默认开启类型擦除，
// 该文件是纯可擦除语法（interface + 常量 + 函数），脚本可以直接 import。
import { BUILD_ROOT, GENERATION_FILE, OUT_DIR_PATTERN, outDirFor } from '../kernel/buildInfo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 产物根（绝对路径）。 */
const BUILD_ROOT_PATH = join(ROOT, BUILD_ROOT)
const STAGE = join(BUILD_ROOT_PATH, '.stage')
/** 代数文件（绝对路径）。 */
const GENERATION_FILE_PATH = join(ROOT, GENERATION_FILE)
const PATCH_FILE = join(ROOT, 'cordis.patch.yml')
const PACKAGES_ROOT = join(ROOT, 'packages')
const ROOT_MANIFEST = join(ROOT, 'package.json')

/**
 * 本次构建的开始时刻（毫秒）。
 *
 * 用途见 `assertFresh`：产物 mtime 恒等于构建时刻（`cpSync` 默认不保留时间戳），
 * 所以"产物比源码旧"这条判据要改成**源码 vs 构建开始时刻**才有意义。
 */
const BUILD_STARTED_AT = Date.now()

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
 * 源码文件清单（相对该源码目录的 posix 路径）。
 *
 * `.d.ts` 不产出 `.js`（它是环境声明），必须排除，否则陈旧检测会永远误报。
 */
function listSourceFiles(dir) {
  const found = []
  const walk = (current, prefix) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name), `${prefix}${entry.name}/`)
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push(`${prefix}${entry.name}`)
      }
    }
  }
  walk(dir, '')
  return found
}

/** 源码相对路径 → tsc 会产出的产物相对路径。 */
function emittedPathOf(relativeSource) {
  return relativeSource.endsWith('.tsx')
    ? `${relativeSource.slice(0, -4)}.jsx`
    : `${relativeSource.slice(0, -3)}.js`
}

/**
 * 陈旧检测：产物必须真的是**本次源码**的产物，缺文件就**明确报错**。
 *
 * 为什么必须做这一步：我把源码改了却忘了重建，结果装到宿主后跑的是旧产物，
 * 于是"功能没生效"被误判成代码问题——实际只是没构建。
 * 这类误判在"改一版装一版"的循环里极易发生，所以要让它响亮地失败。
 *
 * **为什么不再只比 mtime**：`cpSync` 默认 `preserveTimestamps: false`，产物 mtime
 * 恒等于构建那一刻，于是 `newestSource > newestArtifact` 只在"源码 mtime 位于未来"
 * 时才成立——**在它声称要防的那个失败模式下恒不触发**（tsconfig 的 include/exclude
 * 漏了刚改的文件时，产物是**变少**而不是变旧）。现在两条判据都真的会响：
 *
 *   ① 逐文件核对：`SOURCE_DIRS` 下每个 `.ts` 都要在产物里有同名 `.js`，
 *      缺失时把**具体文件名**列出来——这才是"漏 include/exclude"的准确症状。
 *   ② 源码 mtime 与**构建开始时刻**比：晚于它 = tsc 编译的是旧快照
 *      （构建过程中还有人在写源码），必须重跑。
 */
function assertFresh(outDirPath) {
  const missing = []
  for (const dir of SOURCE_DIRS) {
    for (const relative of listSourceFiles(join(ROOT, dir))) {
      if (!existsSync(join(outDirPath, dir, emittedPathOf(relative)))) missing.push(`${dir}/${relative}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[build] 有 ${missing.length} 个源文件没有对应产物——tsconfig.build.json 的 include/exclude 漏了它们：\n  `
      + `${missing.join('\n  ')}\n`
      + '（这类缺陷装到宿主后表现为"某个模块/函数凭空消失"，且构建本身是绿的。）',
    )
  }

  const newestSource = Math.max(0, ...SOURCE_DIRS.map(dir => newestMtime(join(ROOT, dir), '.ts')))
  if (newestSource > BUILD_STARTED_AT) {
    const lag = Math.round((newestSource - BUILD_STARTED_AT) / 1000)
    throw new Error(
      `[build] 有源码在本次构建开始后约 ${lag} 秒被改动——tsc 编译的是旧快照。`
      + '重新跑一次构建（构建期间不要改源码）。',
    )
  }

  const newestArtifact = newestMtime(outDirPath, '.js')
  if (newestArtifact === 0) throw new Error(`[build] ${outDirPath} 里没有 .js 产物`)
  return { newestSource, newestArtifact }
}

function readGeneration() {
  if (!existsSync(GENERATION_FILE_PATH)) return { generation: 0, outDir: '' }
  try {
    const parsed = JSON.parse(readFileSync(GENERATION_FILE_PATH, 'utf8'))
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
  const outDir = outDirFor(generation)
  // 代数目录的形状由 buildInfo 定义；这里先断言一次，避免 BUILD_ROOT/outDirFor
  // 与清理逻辑（GENERATION_DIR）各说各话时静默产出畸形目录。
  if (!OUT_DIR_PATTERN.test(outDir)) {
    throw new Error(
      `[build] 代数目录 ${outDir} 不符合 kernel/buildInfo.ts 的 OUT_DIR_PATTERN（${String(OUT_DIR_PATTERN)}）`
      + '——检查 BUILD_ROOT 与 outDirFor 是否一致。',
    )
  }
  const target = join(ROOT, outDir)

  // 0) **全量只读校验**：在任何写入与编译之前，先把"行名 ↔ 显示表 ↔ 组件包 ↔ 根依赖"
  //    四方对齐查一遍。此处的失败不会在磁盘上留下任何痕迹（连 tsc 都还没跑）。
  const entries = readComponentDisplay()
  assertPatchRows(entries)
  const { files: plannedFiles } = planComponentPackages(entries, generation)

  // 1) 编译到产物根（tsc 的 outDir 由 BUILD_ROOT 真源显式给出，不再读 tsconfig 里的字面量）
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })
  process.stdout.write(`[build] tsc → ${outDir}\n`)
  // 直接跑 tsc 的入口脚本：Windows 上 `npx` 是 .cmd，不设 shell 会 ENOENT
  const tscEntry = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [
    tscEntry,
    '-p', 'tsconfig.build.json',
    '--outDir', BUILD_ROOT_PATH,
    '--tsBuildInfoFile', join(BUILD_ROOT_PATH, '.tsbuildinfo'),
  ], {
    cwd: ROOT,
    stdio: 'inherit',
  })

  // tsc 会把产物写到 <BUILD_ROOT>/{kernel,modules,dsh,packages}；移进本次代数目录
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  /** 本次构建是否已经发布指针（manifest + 代数文件）。没发布就得把半成品的产物目录删掉。 */
  let published = false
  try {
    for (const dir of COMPILED_DIRS) {
      const from = join(BUILD_ROOT_PATH, dir)
      if (!existsSync(from)) throw new Error(`[build] 缺少编译产物 ${dir}/——tsc 没产出？`)
      cpSync(from, join(target, dir), { recursive: true })
      rmSync(from, { recursive: true, force: true })
    }
    rmSync(join(BUILD_ROOT_PATH, '.tsbuildinfo'), { force: true })
    rmSync(STAGE, { recursive: true, force: true })

    // 2) 陈旧检测：产物必须真的是本次源码的产物
    const freshness = assertFresh(target)

    // 3) 编译产物核对（只读）：这一条必须在 tsc 之后——它查的是 tsc 的产出
    assertCompiledEntries(entries, generation)

    // 4) 一次性提交：locale + 本代转发 + 9 个 manifest + 代数文件，写失败整批回滚
    commitFiles([
      ...plannedFiles,
      {
        path: GENERATION_FILE_PATH,
        content: `${JSON.stringify(
          { outDir, generation, builtAt: new Date().toISOString(), ...freshness },
          null,
          2,
        )}\n`,
      },
    ])
    published = true

    // 5) 提交之后才清理：指针已经在磁盘上一致地指向本代，此时删旧代/旧转发是安全的
    pruneStaleShims(entries, generation)
    pruneOldGenerations(generation)
  } catch (error) {
    // 没发布指针 = 磁盘上不该留下任何这一代的痕迹；产物目录也一并撤掉，
    // 免得"根 lib-gen 下两代并存"再次出现（它是同一进程加载两份内核实例的入口）。
    if (!published) rmSync(target, { recursive: true, force: true })
    throw error
  }

  process.stdout.write(`[build] 第 ${generation} 代就绪：${outDir}（${entries.length} 个组件包已指向本代）\n`)
  process.stdout.write(
  '[build] 重新安装插件即可加载本代代码（组件包入口 URL 已变，不受 ESM 缓存影响）\n'
  // 这条不是客套：实测踩过——`main` 已指向新代，但宿主仍报旧代，
  // 因为**行的 name 没变**，宿主按包名解析后命中 Node 的模块缓存，
  // 不会因为 `main` 变了就重新 import。症状是 `omb_status` 的「构建」代数
  // 比 `build-generation.json` 旧，而功能看起来正常——最难查的一类。
  + '[build] 注意：宿主进程若已在运行，行名（@omb/<组件>）没变，模块可能仍被缓存。\n'
  + '        请重启 dsh web 后核对 omb_status 的「构建」代数与本代一致。\n',
)
}

/**
 * 从 `kernel/display.ts` 解析出组件显示元数据。
 *
 * 为什么读源码文本而**不 import**：这里要的是这张表**本身**——顺序、逐字文案、
 * 缺省 `kind`。它是给人看的字面量表，正则该够用；而解析漏了不会静默：
 * `entries.length === 0` 会抛，下面还会与 `cordis.patch.yml` 的行 id 交叉校验。
 * （纯常量的那种模块是可以直接 import 的，见文件头对 `kernel/buildInfo.ts` 的做法。）
 */
function readComponentDisplay() {
  const source = readFileSync(join(ROOT, 'kernel', 'display.ts'), 'utf8')
  const entries = []
  const block = /\{\s*rowId:\s*'([^']+)',\s*packageName:\s*'([^']+)',\s*zh:\s*'([^']*)',\s*en:\s*'([^']*)',\s*zhDescription:\s*'((?:[^'\\]|\\.)*)',\s*enDescription:\s*'((?:[^'\\]|\\.)*)',\s*(?:kind:\s*'([^']+)',\s*)?\}/g
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
      // 缺省按 module：老条目没写 kind 时不该静默变形
      kind: match[7] ?? 'module',
    })
  }
  if (entries.length === 0) {
    throw new Error('[build] 未能从 kernel/display.ts 解析出组件显示元数据——检查那里的字面量格式')
  }
  return entries
}

/**
 * 第一趟：**只读**校验每个组件包，并在内存里算出本次要写的全部文件内容。
 *
 * 校验项（全部通过才会进第二趟；任何一条失败都发生在磁盘被改动之前）：
 *   - `packages/<目录>/package.json` 存在，且 `name` 与显示表一致
 *   - `packages/<目录>/index.ts` 存在
 *   - 根 `package.json` 的 `dependencies` 里有 `workspace:*`
 *   （"`lib-gen/g<N>/packages/<目录>/index.js` 存在"依赖 tsc 产出，
 *     只能在编译之后查——见 `assertCompiledEntries`。）
 *
 * 产出三样文件的**内容**（不落盘）：locale 的 `{en,zh}.json`、本代入口转发、
 * 刷过 `main`/`exports` 的 manifest。落盘由 `commitFiles` 一次性完成。
 *
 * 为什么 locale 也由这里生成：插件页的标题与说明，**唯一真源是 `kernel/display.ts`**
 * （`readPluginMeta` 取 `<包名>/locale/zh.json` 的 `meta.title`/`meta.description`），
 * 所以只在这里生成，不要在 locale 文件里手改。
 */
function planComponentPackages(entries, generation) {
  const pointer = `./${outDirFor(generation)}/index.js`
  const rootManifest = readJson(ROOT_MANIFEST)
  const rootDeps = rootManifest.dependencies ?? {}
  const missingDeps = []
  const files = []

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

    // 三条**会失败**的核对里最后一条：根包 dependencies 必须挂着它们
    // （profile 只装装配包时，`@omb/<组件>` 正是经装配包自己的 `node_modules`
    // 解析到的——少了依赖就解析不到，8 行全 failed to import）。
    if (rootDeps[entry.packageName] !== 'workspace:*') missingDeps.push(entry.packageName)

    const localeDir = join(pkgDir, 'locale')
    files.push(
      {
        path: join(localeDir, 'en.json'),
        content: `${JSON.stringify({ meta: { title: entry.en, description: entry.enDescription } }, null, 2)}\n`,
      },
      {
        path: join(localeDir, 'zh.json'),
        content: `${JSON.stringify({ meta: { title: entry.zh, description: entry.zhDescription } }, null, 2)}\n`,
      },
      {
        // 本代入口转发。**必须在包内**：exports 目标不得逃出包目录；
        // 相对路径按"包目录/lib-gen/g<N>/index.js"起算，四层上一级到仓库根。
        path: join(pkgDir, 'lib-gen', `g${generation}`, 'index.js'),
        content: `// 生成文件（scripts/build.mjs）——不要手改，改动会在下次构建被覆盖。\n`
          + `export * from '../../../../${outDirFor(generation)}/packages/${entry.dir}/index.js'\n`
          + `export { default } from '../../../../${outDirFor(generation)}/packages/${entry.dir}/index.js'\n`,
      },
      {
        path: manifestPath,
        content: `${JSON.stringify(
          { ...manifest, main: pointer, exports: { ...manifest.exports, '.': pointer } },
          null,
          2,
        )}\n`,
      },
    )
  }

  if (missingDeps.length > 0) {
    throw new Error(
      `[build] 根 package.json 的 dependencies 缺少这些组件包（写 "workspace:*"）：\n  ${missingDeps.join('\n  ')}\n`
      + 'profile 只装装配包时，行名 `@omb/<组件>` 正是经装配包自己的 node_modules 解析到的；缺了就是 8 行解析失败。',
    )
  }
  return { files }
}

/**
 * 第三趟的只读核对：每个组件包在**本次代数目录**里都有编译产物。
 *
 * 单独一个函数是因为它必须在 tsc 之后才能查——但同样在**任何写入之前**。
 */function assertCompiledEntries(entries, generation) {
  for (const entry of entries) {
    const compiledEntry = join('packages', entry.dir, 'index.js')
    if (!existsSync(join(ROOT, outDirFor(generation), compiledEntry))) {
      throw new Error(`[build] 组件包 ${entry.packageName} 没有编译产物 ${compiledEntry}——检查 tsconfig.build.json 的 include`)
    }
  }
}

/**
 * 一次性提交：按顺序写文件；**任何一步失败就把已写的全部还原**再抛出。
 *
 * 回滚日志记两样东西：每个被覆盖/新建的文件（连同写之前的字节），
 * 以及本次新建的目录（`packages/<目录>/lib-gen/g<N>/`——失败时必须删掉，
 * 否则会留下指向不存在产物的空转发目录）。
 * 回滚自身的异常一律吞掉：它不能掩盖原始错误。
 */
function commitFiles(files) {
  const journal = { files: [], dirs: [] }
  const seenDirs = new Set()

  const rememberDir = dir => {
    if (seenDirs.has(dir)) return
    seenDirs.add(dir)
    journal.dirs.push({ path: dir, existed: existsSync(dir) })
  }

  try {
    for (const file of files) {
      const dir = dirname(file.path)
      rememberDir(dir)
      mkdirSync(dir, { recursive: true })
      journal.files.push({
        path: file.path,
        before: existsSync(file.path) ? readFileSync(file.path, 'utf8') : null,
      })
      writeFileSync(file.path, file.content)
    }
  } catch (error) {
    for (const file of [...journal.files].reverse()) {
      try {
        if (file.before === null) rmSync(file.path, { force: true })
        else writeFileSync(file.path, file.before)
      } catch {
        // 回滚失败不能掩盖原始错误：原始错误才是根因
      }
    }
    for (const dir of [...journal.dirs].reverse()) {
      if (dir.existed) continue
      try {
        rmSync(dir.path, { recursive: true, force: true })
      } catch {
        // 同上
      }
    }
    throw error
  }
}

/** 清掉每个组件包里更早的代数转发目录（只删自己生成的 `g<数字>`）。 */
function pruneStaleShims(entries, generation) {
  for (const entry of entries) {
    const shimRoot = join(PACKAGES_ROOT, entry.dir, 'lib-gen')
    if (!existsSync(shimRoot)) continue
    for (const item of readdirSync(shimRoot, { withFileTypes: true })) {
      if (!item.isDirectory() || !GENERATION_DIR.test(item.name)) continue
      if (item.name === `g${generation}`) continue
      rmSync(join(shimRoot, item.name), { recursive: true, force: true })
    }
  }
}

/** 清掉产物根下更早的代数目录（**只删自己生成的 g<数字>**，不碰别的东西）。 */
function pruneOldGenerations(generation) {
  for (const entry of readdirSync(BUILD_ROOT_PATH, { withFileTypes: true })) {
    if (!entry.isDirectory() || !GENERATION_DIR.test(entry.name)) continue
    if (entry.name === `g${generation}`) continue
    rmSync(join(BUILD_ROOT_PATH, entry.name), { recursive: true, force: true })
  }
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
  // 几条都踩过的坑，改这个正则前先读：
  // - **不能写成 `omb-[\w-]+`**：预设行是 `preset-omb`，不以 `omb-` 开头，
  //   会被静默漏掉——护栏看不见它就等于没有护栏。
  // - **必须限定缩进（这里 4 空格）**：预设的 `config.plugins:` 子项形状完全相同
  //   （`- id: persona` + `name: '...'`），放宽就会出现"行 persona 在显示表里
  //   没有对应组件"这种把配置项当插件行的误报。
  // 所以：只按顶层缩进 + `id + name: '裸包名'` 的形状抓，随后用显示表核对。
  const rows = [...yaml.matchAll(/^ {4}-\s*id:\s*([\w-]+)\s*\n\s*name:\s*'([^']+)'/gm)]
    .map(match => [match[1], match[2]])
  if (rows.length === 0) throw new Error('[build] cordis.patch.yml 里没有可识别的行')

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
    // **`@omb/` 之外的行是宿主包**（如预设行指向 `@deepseek-ai/dsh-agent-preset`）：
    // 它们的元数据由宿主提供，不归我们管，所以只核对"我们自己那些包都有行"。
    // 曾经为了给预设行加中文名而把它包成 `@omb/preset-omb`，结果那一行一直
    // `pending`（宿主包在运行期才解析得到），**用可用性换显示名不值得**，已回退。
    if (!name.startsWith('@omb/')) continue
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
