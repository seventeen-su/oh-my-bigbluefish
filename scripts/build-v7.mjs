#!/usr/bin/env node
/**
 * OMB v7 服务端构建：单入口 ESM → lib-gen/v7-g<N>/plugin/v7/index.js。
 * 运行期依赖（pg / pg-boss / quickjs）保持 external，由包依赖安装；
 * 只内联 v7 源码与 zod。
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_GEN = join(ROOT, 'lib-gen')
const GENERATION_FILE = join(LIB_GEN, 'v7-build-generation.json')
const MANIFEST = join(ROOT, 'package.json')
const ENTRY = 'plugin/v7/index.ts'
const ARTIFACT = 'plugin/v7/index.js'
const PATCH = 'cordis.patch.v7.yml'
const EXPORT_KEY = './v7'
const MAX_BYTES = 2 * 1024 * 1024
const ALLOWED_EXTERNAL = [
  /^node:/,
  /^@deepseek-ai\//,
  /^pg$/,
  /^pg-boss$/,
  /^quickjs-emscripten$/,
  /^@jitl\//,
  /^onnxruntime-node$/,
]

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, text, 'utf8')
  try {
    renameSync(temp, file)
  } catch {
    rmSync(temp, { force: true })
    writeFileSync(file, text, 'utf8')
  }
}

function parseArgs(argv) {
  const out = { check: false, json: false }
  for (const arg of argv) {
    if (arg === '--check') out.check = true
    else if (arg === '--json') out.json = true
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

async function compile(version, outDir) {
  const outfile = `${outDir}/${ARTIFACT}`
  const result = await build({
    entryPoints: [ENTRY],
    absWorkingDir: ROOT,
    outfile,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    metafile: true,
    external: ['node:*', '@deepseek-ai/*', 'pg', 'pg-boss', 'quickjs-emscripten', '@jitl/*', 'onnxruntime-node'],
    banner: {
      js: `/*! oh-my-bigbluefish v${version} — OMB v7 服务端产物（scripts/build-v7.mjs 生成，勿手改）。入口 ${ENTRY} */`,
    },
  })
  const output = result.outputFiles?.find(file => file.path === outfile) ?? result.outputFiles?.[0]
  if (output === undefined) throw new Error('esbuild 没有产出 JS')
  const text = output.text
  const record = result.metafile?.outputs?.[outfile] ?? Object.values(result.metafile?.outputs ?? {})[0]
  const imports = (record?.imports ?? []).map(item => item.path)
  return { text, bytes: Buffer.byteLength(text, 'utf8'), imports, inputs: Object.keys(result.metafile?.inputs ?? {}).length, sha256: sha256(text) }
}

function validate(built) {
  const problems = []
  for (const source of built.imports) {
    if (!ALLOWED_EXTERNAL.some(pattern => pattern.test(source))) {
      problems.push(`外部依赖不在白名单：${source}`)
    }
  }
  const hasDefault = /export\s*\{[^}]*\bas default\b[^}]*\}/.test(built.text) || /export\s+default\b/.test(built.text)
  if (!hasDefault) problems.push('产物缺少 default apply 导出')
  if (!/export\s*\{[^}]*\bapply\b[^}]*\}/.test(built.text)) problems.push('产物缺少具名 apply 导出')
  if (!built.text.includes('OMB v7 服务端产物')) problems.push('产物缺少构建 banner')
  if (built.bytes > MAX_BYTES) problems.push(`产物 ${built.bytes} bytes 超过上限 ${MAX_BYTES}`)
  return problems
}

function generationRecord() {
  const raw = readJson(GENERATION_FILE)
  return {
    generation: typeof raw?.generation === 'number' && raw.generation > 0 ? Math.floor(raw.generation) : 0,
    outDir: typeof raw?.outDir === 'string' ? raw.outDir : undefined,
  }
}

function checkPointer(manifest, record) {
  const problems = []
  const pointer = manifest?.exports?.[EXPORT_KEY]
  if (typeof pointer !== 'string' || !/^\.\/lib-gen\/v7-g[1-9][0-9]*\/plugin\/v7\/index\.js$/.test(pointer)) {
    problems.push(`package.json exports["${EXPORT_KEY}"] 未指向 v7 产物`)
  }
  if (!Array.isArray(manifest?.files) || !manifest.files.includes(PATCH)) {
    problems.push(`package.json files 缺少 ${PATCH}`)
  }
  if (record.generation > 0 && typeof pointer === 'string') {
    const expected = `./lib-gen/${record.outDir}/${ARTIFACT}`
    if (pointer !== expected) problems.push(`exports 指针与代数文件不一致：${pointer} != ${expected}`)
    if (!existsSync(join(ROOT, pointer.slice(2)))) problems.push(`exports 指向的产物不存在：${pointer}`)
  }
  return problems
}

function publish({ built, version, manifestText, record }) {
  const manifest = JSON.parse(manifestText)
  const generation = record.generation + 1
  const outDir = `v7-g${generation}`
  const exportPath = `./lib-gen/${outDir}/${ARTIFACT}`
  const target = join(LIB_GEN, outDir)
  const stage = join(LIB_GEN, `.v7-stage-${process.pid}`)
  const next = {
    ...manifest,
    main: exportPath,
    exports: { ...(manifest.exports ?? {}), [EXPORT_KEY]: exportPath },
    files: [...new Set([...(Array.isArray(manifest.files) ? manifest.files : []), PATCH])],
  }
  try {
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(join(stage, 'plugin', 'v7'), { recursive: true })
    writeFileSync(join(stage, ARTIFACT), built.text, 'utf8')
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(stage, target)
    writeJsonAtomic(GENERATION_FILE, {
      generation,
      outDir,
      entry: ENTRY,
      artifact: ARTIFACT,
      bytes: built.bytes,
      sha256: built.sha256,
      version,
      node: process.version,
      builtAt: new Date().toISOString(),
    })
    writeJsonAtomic(MANIFEST, next)
    const verify = readJson(MANIFEST)
    if (verify?.exports?.[EXPORT_KEY] !== exportPath) throw new Error('package.json 回读不一致')
    if (!existsSync(join(target, ARTIFACT))) throw new Error('产物回读失败')
  } catch (error) {
    writeFileSync(MANIFEST, manifestText, 'utf8')
    rmSync(stage, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    throw error
  }
  const removed = []
  for (const entry of readdirSync(LIB_GEN, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const stale = (/^v7-g[1-9][0-9]*$/.test(entry.name) && entry.name !== outDir) || /^\.v7-stage-[0-9]+$/.test(entry.name)
    if (!stale) continue
    try {
      rmSync(join(LIB_GEN, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch (error) {
      process.stderr.write(`[build:v7] 旧代删除失败 ${entry.name}: ${messageOf(error)}\n`)
    }
  }
  return { generation, outDir, exportPath, artifactPath: join(target, ARTIFACT), removed }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifestText = readFileSync(MANIFEST, 'utf8')
  const manifest = JSON.parse(manifestText)
  const version = typeof manifest.version === 'string' ? manifest.version : '7.0.0'
  const record = generationRecord()
  const outDir = `v7-g${record.generation + 1}`
  const built = await compile(version, outDir)
  const problems = validate(built)
  if (options.check) {
    const pointerProblems = checkPointer(manifest, record)
    const all = [...problems, ...pointerProblems]
    const summary = { ok: all.length === 0, bytes: built.bytes, inputs: built.inputs, externals: [...new Set(built.imports)], problems: all }
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`)
    else {
      for (const problem of all) process.stderr.write(`[build:v7] 问题：${problem}\n`)
      process.stdout.write(`[build:v7] check ${all.length === 0 ? 'PASS' : 'FAIL'} bytes=${built.bytes} inputs=${built.inputs}\n`)
    }
    if (all.length > 0) process.exitCode = 1
    return
  }
  if (problems.length > 0) throw new Error(problems.join('；'))
  const published = publish({ built, version, manifestText, record })
  const summary = {
    ok: true,
    generation: published.generation,
    outDir: published.outDir,
    exportsPointer: published.exportPath,
    artifactPath: published.artifactPath,
    bytes: built.bytes,
    inputs: built.inputs,
    sha256: built.sha256,
    externals: [...new Set(built.imports)],
    removed: published.removed,
  }
  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`)
  else {
    process.stdout.write(`[build:v7] OK generation=${published.generation} bytes=${built.bytes} inputs=${built.inputs}\n`)
    process.stdout.write(`[build:v7] exports["${EXPORT_KEY}"] → ${published.exportPath}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`[build:v7] 失败：${messageOf(error)}\n`)
  process.exitCode = 1
})
