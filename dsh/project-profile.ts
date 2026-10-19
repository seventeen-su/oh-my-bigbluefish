/**
 * 项目画像：给"工作区级记忆"一份**确定性、可复算**的项目理解（v4.1 §3.2）。
 *
 * ## 为什么需要
 *
 * 用户实测痛点：每个新会话都要重新读一遍仓库（README、package.json、目录、
 * git 历史），这些读取既花 token 也花时间；OMB 记忆却只存零散结论。
 * 项目画像把"这个仓库是什么、怎么跑、最近在做什么"固化成一段短文本，
 * 由 `omb_project` 按需读取——**不占常驻预算，不改变系统提示前缀**。
 *
 * ## v4.1 的分层
 *
 * 画像构建在 **git 项目根**（由 `SERVICES.projectRoot` 解析）：同一个仓库从子
 * 目录会话调用时，结构层与根会话**同源**，只有 `cwdRel` 不同（"我在哪"）。
 * 文本 `text` 与结构化字段 `identity/structure/history/gates` **同一批读取渲染**
 * ——读者不必怀疑"文本说的和结构说的是两回事"。
 *
 * ## 边界
 *
 * - **只读**：不写仓库、不改 git、不执行项目脚本。
 * - **确定性**：同一份文件/git 状态产出同一段文本（顺序固定），便于缓存与 diff。
 * - **有界**：源码目录扫描最多 `PROJECT_SCAN_MAX_FILES` 个文件，跳过依赖/生成物目录。
 * - **不在热路径**：`read()` 命中缓存直接返回；`refresh()` 才重扫。
 * - **绝不抛**：任何读失败都退化为"缺失该段"，而不是让工具调用失败。
 *
 * @module omb/dsh/project-profile
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { Clock } from '../kernel/abi/index.js'

/** 画像身份层（L0）：项目名/版本 + git 身份。 */
export interface ProjectProfileIdentity {
  readonly name?: string
  readonly version?: string
  readonly branch?: string
  readonly head?: string
  readonly headAt?: number
}

/** 一个顶层目录及其（有界扫描到的）文件数。 */
export interface ProjectProfileTopDir {
  readonly name: string
  readonly files: number
}

/** 一个源码目录的规模统计。 */
export interface ProjectProfileSource {
  readonly dir: string
  readonly files: number
  readonly lines: number
  readonly tests: number
  /** v4.2：该目录下识别到的导出符号总数（正则，尽力而为；不是语言服务）。 */
  readonly exports?: number
  /** v4.2：出现频次最高的导出符号名（≤6 个，确定性排序）。 */
  readonly symbols?: readonly string[]
}

/** 一份仓库文档的标题。 */
export interface ProjectProfileDoc {
  readonly path: string
  readonly title: string
}

/** v4.3：一条跨顶层目录的相对导入边（from → to，含出现次数）。 */
export interface ProjectProfileImport {
  readonly from: string
  readonly to: string
  readonly count: number
}

/** v4.4：文件级导入边（相对仓库根的文件路径）。 */
export interface ProjectProfileFileImport {
  readonly from: string
  readonly to: string
  readonly count: number
}

/** v4.4：近似调用边（文件 A 调用文件 B 的导出符号 `symbol`）。 */
export interface ProjectProfileCall {
  readonly caller: string
  readonly callee: string
  readonly symbol: string
  readonly count: number
}

/** 画像结构层（L1）：目录、源码规模、入口、文档、导入/调用图。 */
export interface ProjectProfileStructure {
  readonly topDirs?: readonly ProjectProfileTopDir[]
  readonly sources?: readonly ProjectProfileSource[]
  readonly entries?: readonly string[]
  readonly docs?: readonly ProjectProfileDoc[]
  /** v4.3：相对导入构成的顶层目录有向边。 */
  readonly imports?: readonly ProjectProfileImport[]
  /** v4.4：文件级导入边（只统计仓库内可解析目标，跨文件）。 */
  readonly fileImports?: readonly ProjectProfileFileImport[]
  /** v4.4：近似调用边（导入的导出符号在调用点出现 `name(`）。 */
  readonly calls?: readonly ProjectProfileCall[]
  /** v4.4：tsconfig 里识别到的路径别名（`@/* → src/*` 形式，最多 4 条）。 */
  readonly aliases?: readonly string[]
}

/** 一条提交（短 hash + 主题 + 作者时间）。 */
export interface ProjectProfileCommit {
  readonly hash: string
  readonly subject: string
  readonly at: number
}

/** 画像历史层：最近提交与未提交改动数。 */
export interface ProjectProfileHistory {
  readonly commits?: readonly ProjectProfileCommit[]
  readonly dirty?: number
}

/** 一条构建/测试命令（来自 package.json scripts）。 */
export interface ProjectProfileGate {
  readonly name: string
  readonly command: string
}

/**
 * 一段项目画像。`text` 已按固定顺序渲染，可直接交给模型；
 * 结构化字段与 `text` **同源**（同一批读取）。
 */
export interface ProjectProfile {
  readonly text: string
  readonly generatedAt: number
  /** git 短 HEAD；非 git 目录为 undefined。 */
  readonly gitHead?: string
  /** git 项目根（非 git / 解析失败 = 规范化 cwd）。 */
  readonly root?: string
  /** 本次 cwd 相对 root 的路径（分隔符统一为 `/`；根目录为 `''`）。 */
  readonly cwdRel?: string
  readonly identity?: ProjectProfileIdentity
  readonly structure?: ProjectProfileStructure
  readonly history?: ProjectProfileHistory
  readonly gates?: readonly ProjectProfileGate[]
}

/** 规格里的名字（`docs/v4.1-spacetime.md` §3.2）；与本文件的 `ProjectProfile` 同义。 */
export type ProjectProfileView = ProjectProfile

/** 供记忆模块调用的只读端口。 */
export interface ProjectProfilePort {
  /** 读缓存；过期或没有缓存时同步构建一次（失败返回 undefined）。 */
  read(cwd: string): ProjectProfile | undefined
  /** 强制重建（异步签名便于未来换成异步 I/O；当前为同步实现）。 */
  refresh(cwd: string): Promise<ProjectProfile | undefined>
}

/** 默认缓存时长：10 分钟。项目结构不会每秒变化。 */
export const PROJECT_PROFILE_TTL_MS = 10 * 60 * 1000
/** 缓存上界：会话/工作区数量有限，上界防长跑进程无限增长。 */
export const PROJECT_PROFILE_MAX_ENTRIES = 32
/** 画像正文上限（避免把 README 全文搬进来）。 */
export const PROFILE_TEXT_MAX = 1400
/** 源码目录扫描的文件上限（有界扫描，防大仓库拖垮工具调用）。 */
export const PROJECT_SCAN_MAX_FILES = 2000
/** 顶层目录展示上限。 */
const TOP_DIR_MAX = 16
/** 源码目录展示上限。 */
const SOURCE_DIR_MAX = 8
/** 入口文件展示上限。 */
const ENTRY_MAX = 8
/** 文档标题上限。 */
const DOC_MAX = 8
/** 单文件行数统计上限：超过就不读（仍计入文件数）。 */
const LINE_COUNT_MAX_BYTES = 512 * 1024

/** 构建配置。 */
export interface ProjectProfileOptions {
  readonly clock: Clock
  readonly ttlMs?: number
  /**
   * 项目根解析（通常是 `SERVICES.projectRoot` 的端口）。
   * 缺省 = `cwd` 本身；注入的实现**绝不抛**（本文件另有一层 try/catch）。
   */
  readonly rootOf?: (cwd: string) => string
  /** 扫描文件上限；缺省 `PROJECT_SCAN_MAX_FILES`。 */
  readonly maxFiles?: number
}

interface CacheEntry {
  readonly profile: ProjectProfile
  readonly expiresAt: number
}

/** 扫描时跳过的目录：依赖、版本库、生成物、缓存。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'lib-gen', 'dist', 'build', 'coverage', '.omb',
  '.next', '.turbo', 'out', 'target', '.venv', '__pycache__', '.pnpm-store',
  '.cache', '.idea', '.vscode', '.mypy_cache', '.pytest_cache',
])

/** 视为"源码"的扩展名。 */
const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'hpp',
  'swift', 'rb', 'php', 'sh', 'lua',
])

/** 安全执行一个只读命令；失败/超时/无输出返回 undefined。 */
function runGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const text = out.trim()
    return text.length === 0 ? undefined : text
  } catch {
    return undefined
  }
}

/** 读 JSON 文件；失败返回 undefined。 */
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** 从 README 里取标题 + 第一段（最多 300 字符）。 */
function readmeBrief(root: string): string | undefined {
  for (const name of ['README.zh.md', 'README.md', 'README.zh-CN.md', 'readme.md']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    try {
      const text = readFileSync(path, 'utf8')
      const lines = text.split(/\r?\n/)
      const title = lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim()
      const paragraph = lines
        .filter(line => line.trim().length > 0 && !line.startsWith('#'))
        .slice(0, 3)
        .join(' ')
        .slice(0, 300)
      const brief = [title, paragraph].filter(part => typeof part === 'string' && part.length > 0).join(' — ')
      if (brief.length > 0) return brief
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined
}

/** 相对路径统一成 `/` 分隔（确定性：同一仓库在 Windows/Posix 上同形）。 */
function toPosixRelative(from: string, to: string): string {
  try {
    const rel = relative(from, to)
    if (rel.length === 0) return ''
    return rel.split(sep).join('/')
  } catch {
    return ''
  }
}

/** 一条文件路径是否像测试文件。 */
function looksLikeTest(relativePath: string): boolean {
  const lower = relativePath.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true
  if (/(^|\/)(tests?|__tests__)\//.test(lower)) return true
  return /^test_/.test(base)
}

/** 数行数、抽取导出符号、相对/别名导入与调用点（有界：只读小文件）。 */
function analyzeSource(path: string): {
  readonly lines: number
  readonly symbols: readonly string[]
  readonly imports: readonly string[]
  readonly importCalls: readonly { readonly specifier: string; readonly name: string }[]
} {
  try {
    // 先看尺寸再读：超大文件（生成物/数据）连读都不读，避免一次画像拖垮工具调用。
    if (statSync(path).size > LINE_COUNT_MAX_BYTES) {
      return { lines: 0, symbols: [], imports: [], importCalls: [] }
    }
    const buffer = readFileSync(path)
    if (buffer.length === 0) return { lines: 0, symbols: [], imports: [], importCalls: [] }
    const text = buffer.toString('utf8')
    let lines = 0
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) lines += 1
    }
    if (!text.endsWith('\n')) lines += 1
    const extension = extname(path).toLowerCase()
    const details = extractImportDetails(text, extension)
    return {
      lines,
      symbols: extractSymbols(text, extension),
      imports: details.map(detail => detail.specifier),
      importCalls: details.flatMap(detail =>
        detail.calls.map(name => ({ specifier: detail.specifier, name }))),
    }
  } catch {
    return { lines: 0, symbols: [], imports: [], importCalls: [] }
  }
}

/**
 * 抽取导入细节（v4.4）：说明符 + 命名导入的本地名 + 其中"被当函数调用"的名字。
 *
 * `calls` 用 `\bname\s*\(` 近似判断调用点（不是类型系统）；只用于给"谁调谁"
 * 一张低置信度概览，不当作语义事实。
 */
export function extractImportDetails(
  text: string,
  extension: string,
): readonly {
  readonly specifier: string
  readonly names: readonly string[]
  readonly calls: readonly string[]
}[] {
  if (typeof text !== 'string' || text.length === 0) return []
  if (!['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py'].includes(extension)) return []
  const bySpecifier = new Map<string, Set<string>>()
  const add = (specifier: string, names: readonly string[]): void => {
    const set = bySpecifier.get(specifier) ?? new Set<string>()
    for (const name of names) if (name.length > 0) set.add(name)
    bySpecifier.set(specifier, set)
  }
  if (extension === '.py') {
    for (const match of text.matchAll(/^\s*from\s+(\.+[\w.]*)\s+import\s+([^\n]+)/gm)) {
      const names = (match[2] ?? '').split(',').map(part => part.trim().split(/\s+as\s+/)[0] ?? '')
      add(match[1] ?? '', names)
    }
  } else {
    // `import { a, b as c } from 'x'`
    for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
      const names = (match[1] ?? '').split(',').map(part => part.trim().split(/\s+as\s+/)[0] ?? '')
      add(match[2] ?? '', names)
    }
    // `import def from 'x'`（含 `import type def`）
    for (const match of text.matchAll(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
      add(match[2] ?? '', [match[1] ?? ''])
    }
    // `require('x')`
    for (const match of text.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(match[1] ?? '', [])
  }
  const result: { specifier: string; names: readonly string[]; calls: readonly string[] }[] = []
  for (const [specifier, names] of bySpecifier) {
    const calls = [...names].filter(name => new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(text))
    result.push({ specifier, names: [...names], calls })
  }
  return result.sort((a, b) => a.specifier.localeCompare(b.specifier))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 抽取**相对导入**的说明符（v4.3，确定性正则）。
 *
 * 只收 `./`/`../` 开头（仓库内边）；外部包与路径别名（`@/…`）不猜。
 * TS/JS：`import … from '…'`、`export … from '…'`、`require('…')`、动态 `import('…')`。
 * Python：`from .x import …`。Go/Rust 的模块路径不是文件相对路径，跳过。
 */
export function extractRelativeImports(text: string, extension: string): readonly string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const found = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value === undefined) return
    const clean = value.trim()
    if (clean.startsWith('./') || clean.startsWith('../')) found.add(clean)
  }
  if (extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts'
    || extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
    for (const match of text.matchAll(/(?:from|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g)) add(match[1])
  } else if (extension === '.py') {
    for (const match of text.matchAll(/^\s*from\s+(\.+[\w.]*)\s+import\b/gm)) add(match[1])
  }
  return [...found].sort()
}

/**
 * 抽取导出符号名（v4.2，确定性正则，**不是语言服务**）。
 *
 * 覆盖 TS/JS 的 `export function/class/const/interface/type/enum`、Python
 * `def/class`、Go `func/type`、Rust `pub fn/struct/enum/trait/mod`。
 * 名字按出现次数排序、同频按字母序；只用于"这个目录主要导出什么"的概览。
 */
export function extractSymbols(text: string, extension: string): readonly string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const names: string[] = []
  const add = (value: string | undefined): void => {
    if (value === undefined) return
    const clean = value.trim()
    if (clean.length >= 2 && clean.length <= 48) names.push(clean)
  }
  if (extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts'
    || extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
    for (const match of text.matchAll(
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    )) add(match[1])
  } else if (extension === '.py') {
    for (const match of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) add(match[1])
  } else if (extension === '.go') {
    for (const match of text.matchAll(/^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/gm)) add(match[1])
  } else if (extension === '.rs') {
    for (const match of text.matchAll(/\bpub\s+(?:fn|struct|enum|trait|mod|const|static)\s+([A-Za-z_]\w*)/g)) add(match[1])
  }
  if (names.length === 0) return []
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name]) => name)
}

/** 一个顶层目录下的源码统计累加器。 */
interface SourceBucket {
  files: number
  lines: number
  tests: number
  exports: number
  symbols: Map<string, number>
}

interface ScanResult {
  readonly topDirs: ProjectProfileTopDir[]
  readonly sources: ProjectProfileSource[]
  /** v4.3：跨顶层目录的相对导入边（最多 `IMPORT_EDGE_MAX` 条）。 */
  readonly imports: ProjectProfileImport[]
  /** v4.4：文件级导入边（最多 `FILE_EDGE_MAX` 条）。 */
  readonly fileImports: ProjectProfileFileImport[]
  /** v4.4：近似调用边（最多 `CALL_EDGE_MAX` 条）。 */
  readonly calls: ProjectProfileCall[]
  /** v4.4：tsconfig 路径别名（展示用，最多 4 条）。 */
  readonly aliases: readonly string[]
  /** 是否因为文件上限而截断（状态面/文本不假装"这就是全部"）。 */
  readonly truncated: boolean
}

/** v4.3：导入边展示上限（够看"模块怎么依赖"，不追求完整图）。 */
const IMPORT_EDGE_MAX = 12
/** v4.4：文件级导入边上限。 */
const FILE_EDGE_MAX = 12
/** v4.4：近似调用边上限。 */
const CALL_EDGE_MAX = 12

interface AliasRule {
  readonly prefix: string
  readonly suffix: string
  readonly targets: readonly string[]
}

interface AliasConfig {
  readonly baseUrl: string
  readonly rules: readonly AliasRule[]
  readonly display: readonly string[]
}

/** 读 tsconfig/jsconfig 的 `baseUrl` + `paths`（v4.4；JSON 解析失败就当作没有别名）。 */
function readAliasConfig(root: string): AliasConfig {
  for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json']) {
    const value = readJson(join(root, name))
    const compiler = value?.['compilerOptions']
    const options = typeof compiler === 'object' && compiler !== null ? compiler as Record<string, unknown> : undefined
    if (options === undefined) continue
    const baseUrlRaw = typeof options['baseUrl'] === 'string' ? options['baseUrl'] : undefined
    const baseUrl = baseUrlRaw === undefined ? root : resolve(root, baseUrlRaw)
    const pathsRaw = options['paths']
    const rules: AliasRule[] = []
    if (typeof pathsRaw === 'object' && pathsRaw !== null && !Array.isArray(pathsRaw)) {
      for (const [pattern, targetsRaw] of Object.entries(pathsRaw as Record<string, unknown>)) {
        if (!Array.isArray(targetsRaw)) continue
        const targets = targetsRaw.filter((target): target is string => typeof target === 'string')
        if (targets.length === 0) continue
        if (pattern.endsWith('*')) rules.push({ prefix: pattern.slice(0, -1), suffix: '', targets })
        else rules.push({ prefix: pattern, suffix: '\u0000', targets })
      }
    }
    const display = rules.slice(0, 4).map(rule =>
      `${rule.prefix}${rule.suffix === '\u0000' ? '' : '*'} → ${rule.targets.join(',')}`)
    return { baseUrl, rules, display }
  }
  return { baseUrl: root, rules: [], display: [] }
}

/**
 * 把一个导入说明符解析成仓库内文件（v4.4：相对路径 + tsconfig 别名 + baseUrl）。
 *
 * 依次尝试：原路径（带扩展名时）、常见扩展名、`index.<ext>`；只有**仓库内**
 * 且真实存在的文件才算边。解析不到就跳过——不执行打包器插件、不猜包导出映射。
 */
function resolveImportTarget(
  root: string,
  fromFile: string,
  specifier: string,
  alias: AliasConfig,
): string | undefined {
  const bases: string[] = []
  if (specifier.startsWith('.')) {
    bases.push(resolve(dirname(fromFile), specifier))
  } else {
    for (const rule of alias.rules) {
      if (rule.suffix === '\u0000') {
        if (specifier !== rule.prefix) continue
        for (const target of rule.targets) bases.push(resolve(alias.baseUrl, target))
      } else if (specifier.startsWith(rule.prefix)) {
        const star = specifier.slice(rule.prefix.length)
        for (const target of rule.targets) bases.push(resolve(alias.baseUrl, target.replace(/\*/g, star)))
      }
    }
    if (bases.length === 0) bases.push(resolve(alias.baseUrl, specifier))
  }
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']
  const candidates: string[] = []
  for (const base of bases) {
    if (extname(base).length > 0) candidates.push(base)
    for (const extension of extensions) candidates.push(`${base}${extension}`)
    for (const extension of extensions) candidates.push(join(base, `index${extension}`))
  }
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue
      const rel = relative(root, candidate)
      if (rel.length === 0 || rel.startsWith('..') || resolve(root, rel) !== resolve(candidate)) continue
      return rel.split(sep).join('/')
    } catch {
      // 候选不存在：继续
    }
  }
  return undefined
}

/**
 * 有界扫描：只读目录与文件尺寸，按固定顺序遍历，达到文件上限即停。
 *
 * 顺序 = 顶层目录字典序 → 目录内名称字典序 → 深度优先。预算耗尽时**停止**
 * （而不是跳过某些目录），所以同一棵树在任意预算下都产出同一前缀。
 */
function scanTree(root: string, maxFiles: number, alias: AliasConfig): ScanResult {
  const topDirs: ProjectProfileTopDir[] = []
  const sourceBuckets = new Map<string, SourceBucket>()
  const importEdges = new Map<string, number>()
  const fileEdges = new Map<string, number>()
  const callEdges = new Map<string, number>()
  const fileExports = new Map<string, ReadonlySet<string>>()
  const scanned: {
    readonly topName: string
    readonly relativePath: string
    readonly absolutePath: string
    readonly imports: readonly string[]
    readonly importCalls: readonly { readonly specifier: string; readonly name: string }[]
  }[] = []
  let fileCount = 0
  let budget = maxFiles
  let truncated = false

  let topNames: string[] = []
  try {
    topNames = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch {
    return { topDirs: [], sources: [], imports: [], fileImports: [], calls: [], aliases: alias.display, truncated: false }
  }

  /** 记一个源码文件的规模/导出/导入（非源码扩展名直接跳过）。 */
  const record = (topName: string, extension: string, absolutePath: string, relativePath: string): void => {
    if (!SOURCE_EXTENSIONS.has(extension)) return
    const bucket = sourceBuckets.get(topName)
      ?? { files: 0, lines: 0, tests: 0, exports: 0, symbols: new Map<string, number>() }
    bucket.files += 1
    if (looksLikeTest(relativePath)) bucket.tests += 1
    const analyzed = analyzeSource(absolutePath)
    bucket.lines += analyzed.lines
    bucket.exports += analyzed.symbols.length
    for (const name of analyzed.symbols) bucket.symbols.set(name, (bucket.symbols.get(name) ?? 0) + 1)
    fileExports.set(relativePath, new Set(analyzed.symbols))
    scanned.push({
      topName,
      relativePath,
      absolutePath,
      imports: analyzed.imports,
      importCalls: analyzed.importCalls,
    })
    sourceBuckets.set(topName, bucket)
  }

  const walk = (topName: string, dir: string, prefix: string, depth: number): void => {
    if (budget <= 0 || depth > 12) {
      if (budget <= 0) truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of sorted) {
      if (budget <= 0) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(topName, join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = `${prefix}${entry.name}`
      const extension = extname(entry.name).replace(/^\./, '').toLowerCase()
      const absolutePath = join(dir, entry.name)
      fileCount += 1
      budget -= 1
      record(topName, extension, absolutePath, relativePath)
    }
  }

  for (const topName of topNames) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const before = fileCount
    walk(topName, join(root, topName), `${topName}/`, 1)
    topDirs.push({ name: topName, files: fileCount - before })
  }

  // v4.4：扫描完成后再解析边（此时 `fileExports` 已覆盖全部被扫文件）。
  for (const file of scanned) {
    for (const specifier of file.imports) {
      const target = resolveImportTarget(root, file.absolutePath, specifier, alias)
      if (target === undefined || target === file.relativePath) continue
      putEdge(fileEdges, file.relativePath, target)
      const to = target.split('/')[0]
      if (to === undefined || to.length === 0 || to === file.topName) continue
      putEdge(importEdges, file.topName, to)
    }
    for (const call of file.importCalls) {
      const target = resolveImportTarget(root, file.absolutePath, call.specifier, alias)
      if (target === undefined || !(fileExports.get(target)?.has(call.name) ?? false)) continue
      const key = `${file.relativePath}\u0000${target}\u0000${call.name}`
      callEdges.set(key, (callEdges.get(key) ?? 0) + 1)
    }
  }

  const sources = [...sourceBuckets.entries()]
    .map(([dir, bucket]) => ({
      dir,
      files: bucket.files,
      lines: bucket.lines,
      tests: bucket.tests,
      exports: bucket.exports,
      symbols: [...bucket.symbols.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([name]) => name),
    }))
    .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
    .slice(0, SOURCE_DIR_MAX)

  const imports = [...importEdges.entries()]
    .map(([key, count]) => {
      const split = key.indexOf('\u0000')
      return { from: key.slice(0, split), to: key.slice(split + 1), count }
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, IMPORT_EDGE_MAX)

  const fileImports = [...fileEdges.entries()]
    .map(([key, count]) => {
      const split = key.indexOf('\u0000')
      return { from: key.slice(0, split), to: key.slice(split + 1), count }
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, FILE_EDGE_MAX)

  const calls = [...callEdges.entries()]
    .map(([key, count]) => {
      const [caller, callee, symbol] = key.split('\u0000')
      return { caller: caller ?? '', callee: callee ?? '', symbol: symbol ?? '', count }
    })
    .sort((a, b) => b.count - a.count || a.caller.localeCompare(b.caller) || a.callee.localeCompare(b.callee))
    .slice(0, CALL_EDGE_MAX)

  return {
    topDirs: topDirs.slice(0, TOP_DIR_MAX),
    sources,
    imports,
    fileImports,
    calls,
    aliases: alias.display,
    truncated,
  }
}

/** 有向边计数（`from\0to`）。 */
function putEdge(map: Map<string, number>, from: string, to: string): void {
  const key = `${from}\u0000${to}`
  map.set(key, (map.get(key) ?? 0) + 1)
}

/** 入口文件候选（固定顺序；只保留存在的）。 */
function entryCandidates(root: string, pkg: Record<string, unknown> | undefined): string[] {
  const candidates = new Set<string>([
    'package.json',
    'tsconfig.json',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'README.zh.md',
    'index.ts',
    'index.js',
    'main.ts',
    'src/index.ts',
    'src/main.ts',
  ])
  const main = pkg?.['main']
  if (typeof main === 'string') candidates.add(main.replace(/^\.\//, ''))
  const bin = pkg?.['bin']
  if (typeof bin === 'string') candidates.add(bin.replace(/^\.\//, ''))
  else if (typeof bin === 'object' && bin !== null) {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === 'string') candidates.add(value.replace(/^\.\//, ''))
    }
  }
  const result: string[] = []
  for (const relativePath of candidates) {
    if (result.length >= ENTRY_MAX) break
    if (relativePath.length === 0 || relativePath.includes('..')) continue
    if (existsSync(join(root, relativePath))) result.push(relativePath.split(sep).join('/'))
  }
  return result
}

/** `docs/*.md` 的标题（最多 8 条）。 */
function docTitles(root: string): ProjectProfileDoc[] {
  const docsDir = join(root, 'docs')
  try {
    if (!statSync(docsDir).isDirectory()) return []
  } catch {
    return []
  }
  let names: string[] = []
  try {
    names = readdirSync(docsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
  const result: ProjectProfileDoc[] = []
  for (const name of names.slice(0, DOC_MAX)) {
    let title = basename(name, extname(name))
    try {
      const text = readFileSync(join(docsDir, name), 'utf8')
      const heading = text.split(/\r?\n/).find(line => /^#\s+/.test(line))
      if (heading !== undefined) title = heading.replace(/^#\s+/, '').trim()
    } catch {
      // 读不到就用文件名当标题
    }
    result.push({ path: `docs/${name}`, title })
  }
  return result
}

/** 解析 git 身份与历史（一条命令拿提交，另外两条拿分支/脏文件）。 */
function readGit(root: string): {
  branch?: string
  head?: string
  headAt?: number
  commits?: readonly ProjectProfileCommit[]
  dirty?: number
} {
  const branch = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const log = runGit(root, ['log', '-5', '--pretty=format:%h%x09%s%x09%ct'])
  const status = runGit(root, ['status', '--porcelain'])
  const commits: ProjectProfileCommit[] = []
  if (log !== undefined) {
    for (const line of log.split(/\r?\n/)) {
      const [hash, subject, at] = line.split('\t')
      if (hash === undefined || subject === undefined) continue
      const timestamp = Number(at)
      commits.push({ hash, subject, at: Number.isFinite(timestamp) ? timestamp * 1000 : 0 })
    }
  }
  const head = commits[0]?.hash
  const headAt = commits[0]?.at === 0 ? undefined : commits[0]?.at
  const dirty = status === undefined ? undefined : status.split(/\r?\n/).filter(Boolean).length
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(head === undefined ? {} : { head }),
    ...(headAt === undefined ? {} : { headAt }),
    ...(commits.length === 0 ? {} : { commits: commits.slice(0, 5) }),
    ...(dirty === undefined ? {} : { dirty }),
  }
}

/** 从 package.json 取命令门（测试/构建/检查），固定顺序。 */
function readGates(pkg: Record<string, unknown> | undefined): readonly ProjectProfileGate[] {
  const scripts = typeof pkg?.['scripts'] === 'object' && pkg?.['scripts'] !== null
    ? pkg['scripts'] as Record<string, unknown>
    : {}
  return Object.keys(scripts)
    .sort()
    .filter(key => /test|build|lint|typecheck|verify|check/i.test(key))
    .slice(0, 8)
    .map(key => ({ name: key, command: String(scripts[key]) }))
}

/** 把结构化字段渲染成固定顺序的短文本（与结构同源）。 */
function renderText(input: {
  root: string
  cwdRel: string
  identity: ProjectProfileIdentity
  structure: ProjectProfileStructure
  history: ProjectProfileHistory
  gates: readonly ProjectProfileGate[]
  description?: string
  readme?: string
  scanTruncated?: boolean
  scanLimit?: number
}): string {
  const { root, cwdRel, identity, structure, history, gates } = input
  const lines: string[] = []
  const version = identity.version === undefined ? '' : ` v${identity.version}`
  const description = input.description === undefined || input.description.length === 0
    ? ''
    : ` — ${input.description.slice(0, 120)}`
  lines.push(`项目：${identity.name ?? basename(root)}${version}${description}`)
  lines.push(`项目根：${root}（cwd 相对：${cwdRel.length === 0 ? '仓库根' : cwdRel}）`)

  const stack: string[] = []
  if (existsSync(join(root, 'package.json'))) stack.push('package.json')
  if (existsSync(join(root, 'tsconfig.json'))) stack.push('TypeScript')
  if (existsSync(join(root, 'pnpm-lock.yaml'))) stack.push('pnpm')
  else if (existsSync(join(root, 'package-lock.json'))) stack.push('npm')
  else if (existsSync(join(root, 'yarn.lock'))) stack.push('yarn')
  if (stack.length > 0) lines.push(`栈：${stack.join('；')}`)

  if (structure.topDirs !== undefined && structure.topDirs.length > 0) {
    lines.push(`顶层目录：${structure.topDirs.map(dir => `${dir.name}(${dir.files})`).join('、')}`)
  }
  if (structure.sources !== undefined && structure.sources.length > 0) {
    lines.push(
      `源码：${structure.sources
        .map(source => `${source.dir}（${source.files} 文件 / ${source.lines} 行 / ${source.tests} 测试）`)
        .join('、')}`,
    )
  }
  if (input.scanTruncated === true) {
    const limit = input.scanLimit ?? PROJECT_SCAN_MAX_FILES
    lines.push(`（结构扫描已达上限 ${limit} 文件：以上只是前 ${limit} 个文件内的统计）`)
  }
  if (structure.entries !== undefined && structure.entries.length > 0) {
    lines.push(`入口：${structure.entries.join('、')}`)
  }
  if (structure.docs !== undefined && structure.docs.length > 0) {
    lines.push(`文档：${structure.docs.map(doc => `${doc.path}「${doc.title}」`).join('、')}`)
  }
  if (gates.length > 0) {
    lines.push(`命令：${gates.map(gate => `${gate.name}=${gate.command}`).join('；')}`)
  }

  const gitBits: string[] = []
  if (identity.branch !== undefined) gitBits.push(`分支 ${identity.branch}`)
  if (identity.head !== undefined) gitBits.push(`HEAD ${identity.head}`)
  if (history.dirty !== undefined) gitBits.push(`未提交改动 ${history.dirty} 处`)
  if (gitBits.length > 0) lines.push(`Git：${gitBits.join('；')}`)
  if (history.commits !== undefined && history.commits.length > 0) {
    lines.push(`最近提交：${history.commits.slice(0, 5).map(commit => `${commit.hash} ${commit.subject}`).join(' / ')}`)
  }
  if (input.readme !== undefined) lines.push(`README：${input.readme}`)

  const body = lines.join('\n')
  const footer = '\n（由 OMB 本地构建；如需最新请 refresh）'
  if (body.length === 0) return ''
  // 硬上限：含尾注一起 ≤ `PROFILE_TEXT_MAX`（规格 §3.2 的 1400 是**整段文本**的上限）。
  if (body.length + footer.length <= PROFILE_TEXT_MAX) return body + footer
  return body.slice(0, PROFILE_TEXT_MAX)
}

/** 构建一份画像。任何单段失败只丢该段。 */
function buildProfile(cwd: string, now: number, rootOf: (cwd: string) => string, maxFiles: number): ProjectProfile | undefined {
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return undefined
  } catch {
    return undefined
  }

  // 项目根解析失败 = 用规范化 cwd（"没有项目根"不是"这里没有项目"）。
  let root = cwd
  try {
    const resolved = rootOf(cwd)
    if (typeof resolved === 'string' && resolved.length > 0) root = resolved
  } catch {
    root = cwd
  }
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) root = cwd
  } catch {
    root = cwd
  }
  const cwdRel = toPosixRelative(root, cwd)

  const pkg = readJson(join(root, 'package.json'))
  const name = typeof pkg?.['name'] === 'string' ? pkg['name'] : basename(root)
  const version = typeof pkg?.['version'] === 'string' ? pkg['version'] : undefined
  const description = typeof pkg?.['description'] === 'string' ? pkg['description'] : undefined

  const alias = readAliasConfig(root)
  const scan = scanTree(root, maxFiles, alias)
  const docs = docTitles(root)
  const entries = entryCandidates(root, pkg)
  const gates = readGates(pkg)
  const git = readGit(root)

  const identity: ProjectProfileIdentity = {
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    ...(git.branch === undefined ? {} : { branch: git.branch }),
    ...(git.head === undefined ? {} : { head: git.head }),
    ...(git.headAt === undefined ? {} : { headAt: git.headAt }),
  }
  const structure: ProjectProfileStructure = {
    ...(scan.topDirs.length === 0 ? {} : { topDirs: scan.topDirs }),
    ...(scan.sources.length === 0 ? {} : { sources: scan.sources }),
    ...(entries.length === 0 ? {} : { entries }),
    ...(docs.length === 0 ? {} : { docs }),
    ...(scan.imports.length === 0 ? {} : { imports: scan.imports }),
    ...(scan.fileImports.length === 0 ? {} : { fileImports: scan.fileImports }),
    ...(scan.calls.length === 0 ? {} : { calls: scan.calls }),
    ...(scan.aliases.length === 0 ? {} : { aliases: scan.aliases }),
  }
  const history: ProjectProfileHistory = {
    ...(git.commits === undefined ? {} : { commits: git.commits }),
    ...(git.dirty === undefined ? {} : { dirty: git.dirty }),
  }
  const readme = readmeBrief(root)

  const text = renderText({
    root,
    cwdRel,
    identity,
    structure,
    history,
    gates,
    ...(description === undefined ? {} : { description }),
    ...(readme === undefined ? {} : { readme }),
    ...(scan.truncated ? { scanTruncated: true, scanLimit: maxFiles } : {}),
  })
  if (text.length === 0) return undefined

  return {
    text,
    generatedAt: now,
    ...(git.head === undefined ? {} : { gitHead: git.head }),
    root,
    cwdRel,
    identity,
    structure,
    history,
    gates,
  }
}

/** 正整数上限；非法值退回默认。 */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/**
 * 创建项目画像端口。
 *
 * @param options - 时钟、TTL、项目根解析器与扫描上限（测试可注入短 TTL/固定时钟）。
 * @returns 端口与幂等 disposer；dispose 只清缓存。
 */
export function createProjectProfile(options: ProjectProfileOptions): {
  readonly port: ProjectProfilePort
  readonly dispose: () => void
} {
  const ttl = positiveInt(options.ttlMs, PROJECT_PROFILE_TTL_MS)
  const maxFiles = positiveInt(options.maxFiles, PROJECT_SCAN_MAX_FILES)
  const rootOf = options.rootOf ?? ((cwd: string) => resolve(cwd))
  const cache = new Map<string, CacheEntry>()
  let disposed = false

  /** 构建并写缓存（read 与 refresh 共用）。 */
  const buildCached = (cwd: string): ProjectProfile | undefined => {
    const now = options.clock.now()
    const profile = buildProfile(cwd, now, rootOf, maxFiles)
    if (profile === undefined) return undefined
    cache.delete(cwd)
    cache.set(cwd, { profile, expiresAt: now + ttl })
    // 会话/工作区数量有限，但缓存仍设上界，防长跑进程无限增长。
    while (cache.size > PROJECT_PROFILE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return profile
  }

  const port: ProjectProfilePort = {
    read: cwd => {
      if (disposed) return undefined
      const cached = cache.get(cwd)
      const now = options.clock.now()
      if (cached !== undefined && cached.expiresAt > now) return cached.profile
      return buildCached(cwd)
    },
    refresh: async cwd => {
      if (disposed) return undefined
      cache.delete(cwd)
      return buildCached(cwd)
    },
  }

  return {
    port,
    dispose: () => {
      disposed = true
      cache.clear()
    },
  }
}
