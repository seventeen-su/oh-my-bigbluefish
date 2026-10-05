/**
 * 本地解析验证：**逐行**核对 `cordis.patch.yml` 的行名能不能被解析出来，
 * 以及插件页会显示什么中文名——不需要真的装进 profile。
 *
 * 为什么需要它：安装验证（`plugin_manager install_bundle`）要动 profile，
 * 而"行名解析不了"是本设计最容易回退的地方（相对路径有中文名但解析不了、
 * 裸包名 + 子路径解析不了、`?v=` 当文件名找——三种都实测踩过）。
 * 本脚本把宿主解析器的那套判据在本机复刻一遍，**不碰 profile、不启动宿主**：
 *
 * 0. 扫**全部**顶层行（含预设行 `preset-omb`，它不以 `omb-` 开头——见 `readRows`），
 *    逐行核对"行名是不是裸顶层包名"这三种已知坏写法。
 *    这一步就是本脚本存在的理由：`cordis.patch.yml` 里**任何一行**写回退，
 *    装到宿主后都表现为"解析不了 / 没有中文名"，而在此之前没人会发现。
 *    非 `@omb/` 的行是宿主包（模拟 profile 不提供），只核对形状、不核对解析。
 * 1. 造一个模拟 profile：`<临时目录>/node_modules/@omb/plugin` → 本仓库（目录联接）。
 *    真实安装就是这种形状（`link:` 装出来的符号链接）。
 * 2. 用补丁文件所在的路径作 parent，走 `createRequire(parent).resolve.paths(name)`，
 *    再按宿主 `profile-resolution/resolver.ts:468-505` 的判据挑出候选：
 *    只认**位于 profile 之内**、且 `<searchPath>/<包名>` 是目录的那一条。
 * 3. 解析入口并**真的 import 一次**——"failed to import" 是实测过的失败模式，
 *    只解析不加载会漏掉它。
 * 4. 解析 `<包名>/locale/zh.json` 与 `package.json`，打印 `meta.title` /
 *    `meta.description`：这正是插件页那一列显示的东西（`readPluginMeta`，
 *    `packages/boot/app-boot/src/package-meta.ts:148`）。
 *
 * 用法：
 *   node scripts/check-resolution.mjs                # 用临时目录模拟 profile
 *   node scripts/check-resolution.mjs --profile <dir> # 核对一个真实 profile 目录
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = join(ROOT, 'cordis.patch.yml')

/** 从补丁里取「行 id → 行名」，并顺手挡住三种已知的坏写法。 */
function readRows() {
  const yaml = readFileSync(PATCH, 'utf8')
  // 正则与 `scripts/build.mjs` 的 assertPatchRows **逐字同源**，两条都不能省：
  // - **不能写成 `omb-[\w-]+`**（这里原来是这么写的）：预设行是 `preset-omb`，
  //   不以 `omb-` 开头 → 会被静默漏掉，而漏掉的那一行正是"行名写法最容易回退"的那条。
  //   这个脚本是唯一能离线核对行名解析的护栏，护栏看不见它就等于没有护栏。
  // - **必须限定缩进（这里 4 空格）**：预设的 `config.plugins:` 子项形状完全相同
  //   （`- id: persona` + `name: '...'`），放宽会把配置项当成插件行。
  const rows = [...yaml.matchAll(/^ {4}-\s*id:\s*([\w-]+)\s*\n\s*name:\s*'([^']+)'/gm)]
    .map(match => ({ id: match[1], name: match[2] }))
  if (rows.length === 0) throw new Error('cordis.patch.yml 里没有可识别的行')
  for (const row of rows) {
    if (row.name.includes('?v=')) throw new Error(`行 ${row.id} 的 name 带了 ?v=：${row.name}（宿主会当文件名字面量去找）`)
    if (row.name.startsWith('.')) throw new Error(`行 ${row.id} 的 name 是相对路径：${row.name}（拿不到本地化元数据）`)
    const parts = row.name.split('/')
    if (parts.length !== 2) throw new Error(`行 ${row.id} 的 name 不是裸顶层包名：${row.name}`)
  }
  return rows
}

/** 一个能用的 profile 目录：优先用 `--profile`，否则造一个临时模拟目录。 */
function prepareProfile() {
  const index = process.argv.indexOf('--profile')
  if (index !== -1) {
    const dir = process.argv[index + 1]
    if (dir === undefined) throw new Error('--profile 后面要给一个目录')
    const profile = resolve(dir)
    if (!existsSync(join(profile, 'node_modules', '@omb', 'plugin'))) {
      throw new Error(`${profile} 里没有 node_modules/@omb/plugin——这个目录还没装 OMB`)
    }
    return { profile, cleanup: () => {} }
  }
  const profile = join(tmpdir(), `omb-resolution-check-${process.pid}`)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(join(profile, 'node_modules', '@omb'), { recursive: true })
  // 目录联接：Windows 上不需要管理员权限，路径语义与真实安装的符号链接一致
  symlinkSync(ROOT, join(profile, 'node_modules', '@omb', 'plugin'), 'junction')
  return { profile, cleanup: () => rmSync(profile, { recursive: true, force: true }) }
}

/**
 * 复刻宿主解析器的候选判据（`resolver.ts` 的 `routeScoped`）：
 * 只认位于 layer（profile）之内的 search path，且 `<searchPath>/<包名>` 是目录。
 * `statSync` 跟随符号链接——真实安装装出来的是链接，不是真实目录。
 */
function hostCandidate(parent, name, profile) {
  const searchPaths = createRequire(parent).resolve.paths(name) ?? []
  const localPrefix = profile.endsWith(sep) ? profile : profile + sep
  const considered = []
  for (const searchPath of searchPaths) {
    if (!searchPath.startsWith(localPrefix)) break
    const candidate = join(searchPath, name)
    considered.push(candidate)
    let isDirectory = false
    try {
      isDirectory = statSync(candidate).isDirectory()
    } catch {
      isDirectory = false
    }
    if (isDirectory) return { winner: candidate, considered }
  }
  return { winner: undefined, considered }
}

async function main() {
  const rows = readRows()
  /** 我们自己那些行（`@omb/*`）：解析、加载、中文名三样都要核对。 */
  const ours = rows.filter(row => row.name.startsWith('@omb/'))
  const { profile, cleanup } = prepareProfile()
  const parent = join(profile, 'node_modules', '@omb', 'plugin', 'cordis.patch.yml')
  const require = createRequire(parent)
  const failures = []

  process.stdout.write(`[check] 仓库：${ROOT}\n[check] 模拟 profile：${profile}\n[check] 解析起点（父路径）：${parent}\n\n`)

  for (const row of rows) {
    const { winner, considered } = hostCandidate(parent, row.name, profile)
    const label = `${row.id.padEnd(18)} ${row.name}`
    // **`@omb/` 之外的行是宿主包**（当前只有预设行指向 `@deepseek-ai/dsh-agent-preset`）：
    // 它由真实 profile 提供，模拟 profile 里当然解析不到。但**行名形状仍然要查**——
    // 这条行正是历史上最容易写回退的一条，正则的 `omb-` 前缀曾把它整个挡在护栏之外。
    // 所以：形状已经由 readRows 查过；解析得到就照常核对，"解析不到"只对宿主包免责。
    const ours = row.name.startsWith('@omb/')
    if (winner === undefined) {
      const why = `宿主判据下没有候选——profile 里解析不到这个包（候选都被否决：${considered.join('、') || '（无）'}）`
      if (ours) {
        failures.push(`${label}：${why}`)
        process.stdout.write(`✗ ${label}\n    ${why}\n`)
      } else {
        process.stdout.write(`○ ${label}\n    宿主包：模拟 profile 不提供它，跳过解析（行名形状已核对）\n`)
      }
      continue
    }
    try {
      const entry = require.resolve(row.name)
      const locale = JSON.parse(readFileSync(require.resolve(`${row.name}/locale/zh.json`), 'utf8'))
      const manifestPath = require.resolve(`${row.name}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      // “failed to import” 是实测过的失败模式：只解析不加载会漏掉它
      const namespace = await import(pathToFileURL(entry).href)
      const plugin = namespace.default
      const kind = row.id === 'omb-kernel'
        ? (typeof plugin === 'function' ? 'apply 函数' : `意外形状 ${typeof plugin}`)
        : (plugin?.manifest?.id === row.id ? `宿主插件 ${plugin.manifest.id}` : `意外形状 ${JSON.stringify(plugin?.manifest?.id)}`)
      const bad = row.id !== 'omb-kernel' && plugin?.manifest?.id !== row.id
      if (bad) failures.push(`${label}：default 不是本组件的宿主插件（${kind}）`)
      process.stdout.write(
        `✓ ${label}\n`
        + `    候选胜出：${winner.replace(profile, '<profile>')}\n`
        + `    入口：${entry.replace(ROOT, '<repo>')}\n`
        + `    清单：${manifest.name}@${manifest.version}（${manifestPath.replace(ROOT, '<repo>')}）\n`
        + `    加载：${kind}\n`
        + `    插件页显示：${locale.meta?.title} —— ${locale.meta?.description}\n`,
      )
    } catch (error) {
      failures.push(`${label}：${error instanceof Error ? error.message : String(error)}`)
      process.stdout.write(`✗ ${label}\n    ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  cleanup()
  if (failures.length > 0) {
    process.stdout.write(`\n[check] ${failures.length} 行没通过：\n  ${failures.join('\n  ')}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `\n[check] ${ours.length} 个 OMB 行全部可解析、可加载，且都有中文名`
    + `（另有 ${rows.length - ours.length} 个宿主行只核对了行名形状）\n`,
  )
}

await main()
