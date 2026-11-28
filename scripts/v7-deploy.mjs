#!/usr/bin/env node
/**
 * 把当前 v7 构建产物复制到 DSH profile，并验证 bundle 能被 Node 解析。
 * 不使用 `dsh.bundle.patch` 以外的隐式接线；不自动重启宿主（重启会结束当前会话）。
 *
 * 用法：
 *   node scripts/v7-deploy.mjs            # dry-run，列出会改什么
 *   node scripts/v7-deploy.mjs --apply    # 复制 + 安装 profile 运行期依赖 + smoke import
 *
 * 运行中热写 profile 会触发 HMR recompose 并可能让插件工具失挂载，所以
 * `--apply` 默认先探测 DSH（127.0.0.1:3080，一次 TCP connect）并拒绝；只有
 * `--force` 或 `OMB_DEPLOY_ALLOW_RUNNING=1` 才放行。dry-run 不探测也不写盘。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describeDenied, ensureDeployAllowed } from './lib/deploy-guard.mjs'
import { pruneStaleSkills } from './lib/skill-cleanup.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env.OMB_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web')
const TARGET = join(PROFILE, 'node_modules', 'oh-my-bigbluefish')
const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
const RUNTIME_DEPS = {
  '@opentelemetry/api': '1.9.0',
  pg: '8.23.1',
  'pg-boss': '12.39.0',
  'quickjs-emscripten': '0.32.0',
}

function log(message) {
  process.stdout.write(`[v7:deploy] ${message}\n`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function currentBuild() {
  const manifest = readJson(join(ROOT, 'package.json'))
  const pointer = manifest.exports?.['./v7']
  if (typeof pointer !== 'string') throw new Error('package.json 没有 exports["./v7"]；先 pnpm v7:build')
  const absolute = join(ROOT, pointer.replace(/^\.\//, ''))
  if (!existsSync(absolute)) throw new Error(`v7 产物不存在：${absolute}`)
  return { pointer, absolute, generation: /v7-g(\d+)/.exec(pointer)?.[1] ?? 'unknown' }
}

function backup(path) {
  if (!existsSync(path)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${path}.bak-v7-${stamp}`
  cpSync(path, target, { recursive: true, force: true, dereference: false, verbatimSymlinks: true })
  log(`备份 ${path} → ${target}`)
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return false
  if (!APPLY) {
    log(`将复制 ${from} → ${to}`)
    return true
  }
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: source => !source.includes(`${join(from, 'node_modules')}`) && !source.includes(`${join(from, '.git')}`),
  })
  log(`复制 ${from} → ${to}`)
  return true
}

function ensureProfileDeps() {
  const manifestPath = join(PROFILE, 'package.json')
  const manifest = readJson(manifestPath)
  const dependencies = { ...(manifest.dependencies ?? {}) }
  let changed = false
  for (const [name, version] of Object.entries(RUNTIME_DEPS)) {
    if (dependencies[name] !== version) {
      dependencies[name] = version
      changed = true
    }
  }
  if (!changed) {
    log('profile 运行期依赖已存在')
    return
  }
  if (!APPLY) {
    log(`将写入 profile dependencies：${Object.keys(RUNTIME_DEPS).join(', ')}`)
    return
  }
  backup(manifestPath)
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`, 'utf8')
  // Windows 下 .cmd 不能被 spawn 直接执行；经 cmd /d /s /c 调用，命令与参数都是固定字面量，
  // 不使用 shell:true（避免 Node 的参数拼接告警与注入面）。
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm install --ignore-scripts'], {
      cwd: PROFILE,
      stdio: 'inherit',
      shell: false,
    })
    : spawnSync('pnpm', ['install', '--ignore-scripts'], { cwd: PROFILE, stdio: 'inherit', shell: false })
  if (result.status !== 0) throw new Error(`profile pnpm install 失败：${result.status ?? 'unknown'}`)
}

function smoke(build) {
  if (!APPLY) {
    log('dry-run：跳过 smoke import')
    return
  }
  const specifier = `file:///${join(TARGET, build.pointer.replace(/^\.\//, '')).replaceAll('\\', '/')}`
  const code = `import(${JSON.stringify(specifier)}).then(m=>{if(typeof m.apply!=='function'||typeof m.default!=='function'){throw new Error('bundle 缺少 apply/default')};console.log('SMOKE_OK')}).catch(e=>{console.error(e);process.exit(1)})`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: PROFILE,
    stdio: 'inherit',
    shell: false,
  })
  if (result.status !== 0) throw new Error(`bundle smoke 失败：${result.status ?? 'unknown'}`)
}

/** 只保留最近 3 代 v7-g*（当前 + 2 代回退），清掉更早的 g31/g32/g33 等旧代。 */
function pruneOldGenerations(currentGeneration) {
  const libGen = join(TARGET, 'lib-gen')
  if (!existsSync(libGen)) return
  const generations = readdirSync(libGen, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^v7-g\d+$/.test(entry.name))
    .map(entry => ({ name: entry.name, number: Number(/^v7-g(\d+)$/.exec(entry.name)[1]) }))
    .sort((a, b) => b.number - a.number)
  const keep = new Set(generations.slice(0, 3).map(item => item.name))
  for (const item of generations) {
    if (keep.has(item.name)) continue
    if (!APPLY) {
      log(`将删除旧代目录 ${item.name}`)
      continue
    }
    rmSync(join(libGen, item.name), { recursive: true, force: true })
    log(`删除旧代目录 ${item.name}`)
  }
  log(`保留 v7 代际：${[...keep].join(', ') || 'none'}（当前 ${currentGeneration}）`)
}

async function main() {
  const guard = await ensureDeployAllowed({ apply: APPLY, force: FORCE, env: process.env })
  if (!guard.allowed) {
    process.stderr.write(`[v7:deploy] ${describeDenied(guard)}\n`)
    process.exitCode = 1
    return
  }
  if (guard.reason === 'force' || guard.reason === 'env') {
    log(`警告：已通过 ${guard.reason === 'force' ? '--force' : 'OMB_DEPLOY_ALLOW_RUNNING=1'} 跳过运行中守卫；热写 profile 可能让插件工具失挂载。`)
  }
  if (guard.reason === 'dry-run') {
    log('dry-run：不探测 DSH 端口、不写 profile。')
  } else if (guard.reason === 'offline') {
    log(`DSH 未在 ${guard.host}:${guard.port} 监听，允许写 profile。`)
  }
  const build = currentBuild()
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} generation=${build.generation} target=${TARGET}`)
  ensureProfileDeps()

  const genDir = join(ROOT, 'lib-gen', `v7-g${build.generation}`)
  if (!existsSync(genDir)) throw new Error(`构建目录不存在：${genDir}`)
  copyIfExists(genDir, join(TARGET, 'lib-gen', `v7-g${build.generation}`))
  copyIfExists(
    join(ROOT, 'packages/v7/src/adapters/postgres/migrations'),
    join(TARGET, 'lib-gen', `v7-g${build.generation}`, 'plugin/v7/migrations'),
  )
  copyIfExists(join(ROOT, 'packages/v7'), join(TARGET, 'packages/v7'))
  copyIfExists(join(ROOT, 'plugin/v7'), join(TARGET, 'plugin/v7'))
  for (const skill of ['omb-memory', 'omb-recall', 'omb-state', 'omb-consolidate']) {
    copyIfExists(join(ROOT, 'skills', skill), join(TARGET, 'skills', skill))
  }
  // v7 只分发上面 4 个技能；v6 及更早的 8 张过程卡留在 profile 会让 DSH 继续注册旧技能，
  // 所以复制后清掉。只认精确目录名，未知目录/用户自建技能一律保留。
  pruneStaleSkills({ skillsDir: join(TARGET, 'skills'), apply: APPLY, log })
  copyIfExists(join(ROOT, 'models', 'bge-small-zh-v1.5'), join(TARGET, 'models', 'bge-small-zh-v1.5'))
  copyIfExists(join(ROOT, 'locale'), join(TARGET, 'locale'))
  copyIfExists(join(ROOT, 'README.md'), join(TARGET, 'README.md'))
  copyIfExists(join(ROOT, 'LICENSE'), join(TARGET, 'LICENSE'))
  copyIfExists(join(ROOT, 'COPYRIGHT'), join(TARGET, 'COPYRIGHT'))
  copyIfExists(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(TARGET, 'THIRD_PARTY_NOTICES.md'))
  copyIfExists(join(ROOT, 'cordis.patch.v7.yml'), join(TARGET, 'cordis.patch.v7.yml'))
  copyIfExists(join(ROOT, 'icon.svg'), join(TARGET, 'icon.svg'))
  copyIfExists(join(ROOT, 'package.json'), join(TARGET, 'package.json'))
  copyIfExists(join(ROOT, 'version-manifest.json'), join(TARGET, 'version-manifest.json'))
  pruneOldGenerations(build.generation)

  if (APPLY) {
    smoke(build)
    log('完成。DSH 仍需重启才能加载新插件行（会结束当前会话，请在需要时手动重启）。')
  } else {
    log('dry-run 完成；加 --apply 才会写 profile。')
  }
}

main().catch(error => {
  process.stderr.write(`[v7:deploy] 失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
