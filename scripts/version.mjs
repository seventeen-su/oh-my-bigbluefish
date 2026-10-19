#!/usr/bin/env node
/**
 * 版本号：`x1.x2.x3`（x1 革命式大版本 / x2 单个功能更新 / x3 该版单个修复）。
 * 单一真源：`version-manifest.json` 的 `version` 字段；features/subfeatures 仅统计展示。
 * `--write` 写回 package.json 与 kernel/version.ts；默认 `--check` 校验漂移。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'version-manifest.json')
const PACKAGE_DIRS = ['.', 'packages/artifact', 'packages/kernel', 'packages/memory', 'packages/memory-vector', 'packages/notify', 'packages/profile', 'packages/reasoning']
const VERSION_FILE = join(ROOT, 'kernel', 'version.ts')

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

function computeVersion(manifest) {
  const version = manifest.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version-manifest: version 必须是 x1.x2.x3')
  const features = manifest.features
  if (!Array.isArray(features) || features.length === 0) throw new Error('version-manifest: features 不能为空')
  let subfeatures = 0
  for (const feature of features) {
    if (!Array.isArray(feature.subfeatures)) throw new Error(`version-manifest: ${feature.id}.subfeatures 必须是数组`)
    subfeatures += feature.subfeatures.length
  }
  return { version, features: features.length, subfeatures }
}

function check() {
  const { version, features, subfeatures } = computeVersion(readJson(MANIFEST))
  const problems = []
  for (const dir of PACKAGE_DIRS) {
    const actual = readJson(join(ROOT, dir, 'package.json')).version
    if (actual !== version) problems.push(`${dir}/package.json: ${actual} ≠ ${version}`)
  }
  let source = ''
  try { source = readFileSync(VERSION_FILE, 'utf8') } catch { problems.push('kernel/version.ts 不存在') }
  if (!source.includes(`'${version}'`)) problems.push(`kernel/version.ts 未包含 '${version}'`)
  if (problems.length) {
    console.error(`[version] 版本漂移（${version}；${features} 功能 / ${subfeatures} 小功能）：`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`[version] 一致：${version}（${features} 功能 / ${subfeatures} 小功能）`)
}

function write() {
  const { version, features, subfeatures } = computeVersion(readJson(MANIFEST))
  for (const dir of PACKAGE_DIRS) {
    const path = join(ROOT, dir, 'package.json')
    const manifest = readJson(path)
    manifest.version = version
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  writeFileSync(VERSION_FILE, `// 生成文件（scripts/version.mjs）——不要手改；改 version-manifest.json 后运行 node scripts/version.mjs --write\nexport const OMB_VERSION = '${version}'\nexport const OMB_VERSION_FEATURES = ${features}\nexport const OMB_VERSION_SUBFEATURES = ${subfeatures}\n`)
  console.log(`[version] 已写入 ${version}（${features} 功能 / ${subfeatures} 小功能）`)
}

const argv = process.argv.slice(2)
if (argv.includes('--write')) write()
else check()