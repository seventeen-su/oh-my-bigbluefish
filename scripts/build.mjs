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

main()
