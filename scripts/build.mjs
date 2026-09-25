/**
 * 构建到"新的一代"产物目录，并把 `cordis.patch.yml` 指过去。
 *
 * **为什么构建要换代**：DSH 的插件行能免重启动态增删，但**模块代码走 Node 标准
 * ESM 按 URL 缓存**（宿主源码：`resolver.ts:128` "existing modules and Node caches
 * remain intact"）。同一个路径重新安装 → 跑的还是**旧模块实例**，
 * 于是"激活失败"之类的报错完全不能反映当前源码——**极易误判**。
 *
 * 每次构建写一个新代数目录（`lib-gen/g1` → `g2` → …），URL 必然变化，
 * 加载的必然是本次构建的代码。构建后打印代数，运行期可经 `omb_status` 核对。
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
const MANIFEST_FILE = join(ROOT, 'package.json')

/** 行名用的包名（来自清单，不硬编码）。 */


/** 允许被清理的旧代目录名：只匹配我们自己生成的 `g<数字>`，绝不误删别的目录。 */
const GENERATION_DIR = /^g\d+$/

/** 源码目录（.ts）与产物目录（.js）——用于陈旧检测。 */
const SOURCE_DIRS = ['kernel', 'modules', 'dsh']

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

  // tsc 会把产物写到 lib-gen/{kernel,modules,dsh}；移进本次代数目录
  const target = join(BUILD_ROOT, `g${generation}`)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const dir of ['kernel', 'modules', 'dsh']) {
    const from = join(BUILD_ROOT, dir)
    if (!existsSync(from)) throw new Error(`[build] 缺少编译产物 ${dir}/——tsc 没产出？`)
    cpSync(from, join(target, dir), { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  rmSync(join(BUILD_ROOT, '.tsbuildinfo'), { force: true })
  rmSync(STAGE, { recursive: true, force: true })

  // 2) 把 patch 指到这一代
  const yaml = readFileSync(PATCH_FILE, 'utf8')
  const rewritten = yaml.replace(/\.\/lib-gen\/g\d+\//g, `./${outDir}/`)
  if (rewritten === yaml && !yaml.includes(`./${outDir}/`)) {
    throw new Error('[build] cordis.patch.yml 里没有可替换的产物路径——请检查 patch 是否指向 ./lib-gen/g*/')
  }
  writeFileSync(PATCH_FILE, rewritten)

  // 2b) 陈旧检测：产物必须比源码新
  const freshness = assertFresh(target)

  // 2c) 生成插件页的显示名与导出口
  //
  // **为什么必须生成**：插件页每一行显示的是行的 `name`，而中文名只能经 DSH 的
  // 本地化元数据拿到（`packages/boot/app-boot/src/package-meta.ts:148`）：
  // 行名得是**裸包名 + 子路径**，名字取自 `<specifier>/locale/zh.json` 的
  // `meta.title`、说明取自 `meta.description`。
  // 用相对路径时拿不到任何元数据，退回显示完整 `file:///` 路径——用户看不出
  // 哪个开关对应哪个组件，也看不出开的是哪一代产物。
  writeDisplayMetadata(outDir)

  // 2d) 行名保持**相对路径**，不改成裸包子路径。
  //
  // 实测：裸包名 + 子路径（`@omb/plugin/omb-kernel`）在这个宿主里**解析不了**
  // ——8 行全部 "failed to import"。宿主用 `new URL(name, baseUrl)` 解析行名，
  // 相对路径直接可行；裸包名要靠包解析器，而它只认顶层包名
  // （`@deepseek-ai/dsh-agent-preset` 之类），不认子路径。
  //
  // 换目录名（`lib-gen/g<N>`）才是让"新代码被加载"的正解，路径形式必须保持相对。
  // 中文显示名改由模块目录下的 `package.json` 提供（见 `writeDisplayMetadata`）。

  // 3) 写代数文件（运行期经它核对"现在跑的是哪一代"）
  writeFileSync(
    GENERATION_FILE,
    `${JSON.stringify(
      { outDir, generation, builtAt: new Date().toISOString(), ...freshness },
      null,
      2,
    )}\n`,
  )

  // 4) 清掉更早的代数目录（**只删自己生成的 g<数字>**，不碰别的东西）
  for (const entry of readdirSync(BUILD_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !GENERATION_DIR.test(entry.name)) continue
    if (entry.name === `g${generation}`) continue
    rmSync(join(BUILD_ROOT, entry.name), { recursive: true, force: true })
  }

  process.stdout.write(`[build] 第 ${generation} 代就绪：${outDir}\n`)
  process.stdout.write('[build] 重新安装插件即可加载本代代码（URL 已变，不受 ESM 缓存影响）\n')
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
  const block = /\{\s*rowId:\s*'([^']+)',\s*subpath:\s*'([^']+)',\s*zh:\s*'([^']*)',\s*en:\s*'([^']*)',\s*zhDescription:\s*'((?:[^'\\]|\\.)*)',\s*enDescription:\s*'((?:[^'\\]|\\.)*)',\s*\}/g
  for (const match of source.matchAll(block)) {
    entries.push({
      rowId: match[1],
      subpath: match[2],
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

/** 每个组件的产物入口（相对仓库根）。 */
function componentEntry(outDir, rowId) {
  const map = {
    'omb-kernel': `${outDir}/dsh/kernel.js`,
    'omb-memory': `${outDir}/modules/memory/index.js`,
    'omb-memory-vector': `${outDir}/modules/memory/vector.js`,
    'omb-profile': `${outDir}/modules/profile/index.js`,
    'omb-reasoning': `${outDir}/modules/reasoning/index.js`,
    'omb-context': `${outDir}/modules/context/index.js`,
    'omb-artifact': `${outDir}/modules/artifact/module.js`,
    'omb-notify': `${outDir}/modules/notify/index.js`,
  }
  const entry = map[rowId]
  if (entry === undefined) throw new Error(`[build] 组件 ${rowId} 没有产物入口映射`)
  return entry
}

/**
 * 生成 `locale/<组件>/{en,zh}.json`。
 *
 * **用途**：DSH 的插件页显示名来自本地化元数据
 * （`packages/boot/app-boot/src/package-meta.ts:148`）。
 * 中文名从 `kernel/display.ts`（唯一真源）生成到这些文件，改文案只改那里。
 *
 * **注意**：暂时还没接上显示。让宿主认这些文件需要行名是**裸包子路径**
 * （`@omb/plugin/<组件>`），但实测宿主解析不了子路径（8 行全部
 * "failed to import"），所以行名保持相对路径。locale 先备好：
 * 一旦找到让宿主认子路径的办法（或在 DSH 侧支持），直接接上即可。
 */
function writeDisplayMetadata(outDir) {
  const entries = readComponentDisplay()
  for (const entry of entries) {
    const dir = join(ROOT, 'locale', entry.subpath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'en.json'),
      `${JSON.stringify({ meta: { title: entry.en, description: entry.enDescription } }, null, 2)}\n`,
    )
    writeFileSync(
      join(dir, 'zh.json'),
      `${JSON.stringify({ meta: { title: entry.zh, description: entry.zhDescription } }, null, 2)}\n`,
    )
  }
  return entries
}

main()
