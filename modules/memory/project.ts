/**
 * `omb_project`：**分层时空快照**（v4.1 §3.4；L0–L5 六层）。
 *
 * ## 为什么需要它
 *
 * 用户抱怨"AI 不理解这个项目、每次都要重新摸"。v4.0 的 `omb_project` 只给
 * 一段画像文本 + 项目记忆 top 3，回答不了"这个会话现在在哪、离上次过了多久、
 * 有没有外部改动、还有哪些没做完"。v4.1 把四个各自正确的组件（画像 / 状态机 /
 * 记忆库 / 项目根）接到**同一套坐标**上：空间（项目根→目录→文件）、时间
 * （提交→epoch→回合→空闲）、状态（印记/守卫/目标），一次调用给出 L0–L5。
 *
 * ## 边界
 *
 * - **只读**：画像构建、项目根解析、situation 都在 `dsh/`（模块不碰文件系统/子进程），
 *   本模块只通过**结构化最小接口**读；服务缺席一律降级成可读文字，**不抛**。
 * - **隐私先于读取**：`sealed`（或隐私判定本身失败）→ **不读画像、不读记忆**，
 *   直接返回一句原因。隐私不能只落在库边界——画像不经过库。
 * - **无会话归属**：只能画像，不读记忆（记忆按会话归属取库）；L3 写"无会话归属"。
 * - **未测量 ≠ 0**：缺服务/缺快照写"未接线/状态未知/暂无"，不写 0、不写绿。
 * - **确定性**：固定层序、固定分隔符；同一输入产出同一文本（记忆与状态变化除外）。
 *
 * ## 长度
 *
 * 总长 ≤ `MAX_SNAPSHOT_CHARS`（2400）。超限时按固定顺序压缩各层正文
 * （先压最长的层，每次至少缩 10%，保底 24 字符），最后才硬截断——
 * 同一输入得到同一截断结果。
 */
import type {
  Clock,
  EdgeType,
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  ToolDefinition,
  ToolInputSchema,
  ToolOutcome,
} from '../../kernel/abi/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { isoUtc } from './retrieve.js'
import { stageLabel, stageOfMemory } from './lifecycle.js'

/** 工具名（目录白名单之外的新工具：3.7 Wave 2 经用户批准，工具面 10 → 11）。 */
export const PROJECT_TOOL = 'omb_project'

/** 画像端口服务名（唯一真源：`SERVICES.projectProfile`）。 */
export const PROJECT_PROFILE_SERVICE = SERVICES.projectProfile
/** 项目根服务名（v4.1 §3.1；由 `dsh/project-root.ts` provide）。 */
export const PROJECT_ROOT_SERVICE = SERVICES.projectRoot

/** 画像文本上限（兼容旧消费者；六层快照另受 `MAX_SNAPSHOT_CHARS` 约束）。 */
export const MAX_PROFILE_CHARS = 1600
/** 六层快照总长上限（v4.1 §2）。 */
export const MAX_SNAPSHOT_CHARS = 2400
/** 单条项目记忆展示上限。 */
export const MAX_MEMORY_CHARS = 200
/** 项目记忆取前几条（v4.1 §2 L4）。 */
export const PROJECT_MEMORY_TOP = 3
/** 固定查询：不依赖模型猜词，只要项目里存过经验/约定就有机会命中。 */
export const PROJECT_MEMORY_QUERY = '项目 约定 结论 经验 进度 决策'
/** 近期记忆判据（"项目记忆近况"用）。 */
export const RECENT_MEMORY_MS = 7 * 24 * 60 * 60 * 1000

// ────────────────────────────────────────────────────────────────────────────
// 结构化视图（与 `dsh/project-profile.ts` / `dsh/state-machine.ts` 同形；
// 模块层**不 import 宿主**，只按形状投影）
// ────────────────────────────────────────────────────────────────────────────

export interface ProjectProfileIdentity {
  readonly name?: string
  readonly version?: string
  readonly branch?: string
  readonly head?: string
  readonly headAt?: number
}

export interface ProjectProfileTopDir {
  readonly name: string
  readonly files: number
}

export interface ProjectProfileSource {
  readonly dir: string
  readonly files: number
  readonly lines: number
  readonly tests: number
  /** v4.2：导出符号总数与代表符号（来自画像的正则扫描，不是语言服务）。 */
  readonly exports?: number
  readonly symbols?: readonly string[]
}

export interface ProjectProfileDoc {
  readonly path: string
  readonly title: string
}

/** v4.3：跨顶层目录的相对导入边。 */
export interface ProjectProfileImport {
  readonly from: string
  readonly to: string
  readonly count: number
}

/** v4.4：文件级导入边。 */
export interface ProjectProfileFileImport {
  readonly from: string
  readonly to: string
  readonly count: number
}

/** v4.4：近似调用边（A 调用 B 的导出符号 `symbol`）。 */
export interface ProjectProfileCall {
  readonly caller: string
  readonly callee: string
  readonly symbol: string
  readonly count: number
}

export interface ProjectProfileStructure {
  readonly topDirs?: readonly ProjectProfileTopDir[]
  readonly sources?: readonly ProjectProfileSource[]
  readonly entries?: readonly string[]
  readonly docs?: readonly ProjectProfileDoc[]
  readonly imports?: readonly ProjectProfileImport[]
  /** v4.4：文件级导入边（最多 12 条）。 */
  readonly fileImports?: readonly ProjectProfileFileImport[]
  /** v4.4：近似调用边（最多 12 条；正则近似，不是类型系统）。 */
  readonly calls?: readonly ProjectProfileCall[]
  /** v4.4：tsconfig 路径别名（展示用）。 */
  readonly aliases?: readonly string[]
}

export interface ProjectProfileCommit {
  readonly hash: string
  readonly subject: string
  readonly at: number
}

export interface ProjectProfileHistory {
  readonly commits?: readonly ProjectProfileCommit[]
  readonly dirty?: number
}

export interface ProjectProfileGate {
  readonly name: string
  readonly command: string
}

/**
 * 项目运行证据（v4.5.3 审查第 5 点；由 `dsh/project-evidence.ts` provide）。
 *
 * 与静态画像的区别：画像说"项目长什么样"，证据说"最近一次测试过没过"。
 */
export interface ProjectEvidenceView {
  readonly kind: string
  readonly command: string
  /** 命令退出状态；unknown = 结果文本里没有可解析的退出码（不是"通过"）。 */
  readonly commandOutcome: 'succeeded' | 'failed' | 'unknown'
  readonly exitCode?: number | null
  /** v4.9.3：命令里提到的文件（证据 → 文件映射；符号不解析）。 */
  readonly paths?: readonly string[]
  readonly at: number
  /** 同一命令紧邻的上一条失败、本次成功 → 只表示"失败后再次成功"。 */
  readonly recoveredFromFailure?: boolean
}

/** 画像视图（v4.1 §3.2：结构化字段与 `text` 同源）。 */
export interface ProjectProfileView {
  readonly text: string
  readonly generatedAt: number
  readonly gitHead?: string
  readonly root?: string
  readonly cwdRel?: string
  readonly identity?: ProjectProfileIdentity
  readonly structure?: ProjectProfileStructure
  readonly history?: ProjectProfileHistory
  readonly gates?: readonly ProjectProfileGate[]
}

/** 画像端口（Lead 在 `dsh/` 实现并 provide `SERVICES.projectProfile`）。 */
export interface ProjectProfilePort {
  read(cwd: string): ProjectProfileView | undefined
  refresh(cwd: string): Promise<ProjectProfileView | undefined>
}

/** `situation()` 的结构化事实（v4.1 §3.3；只读、同步）。 */
export interface SessionSituationView {
  readonly sessionId?: string
  readonly cwd?: string | null
  readonly state?: string
  readonly tier?: string
  readonly turn?: number
  readonly step?: number
  readonly lastEventAt?: number | null
  readonly idleMs?: number | null
  readonly lastTurnEndReason?: string | null
  readonly interrupted?: boolean
  readonly unresolved?: boolean
  readonly goals?: { readonly open: number; readonly total: number }
  readonly todos?: { readonly open: number; readonly total: number }
  /** `dsh` 的 epoch：`{ id, head, branch, dirtyCount, at, degraded, source, ... }`；容错读几个别名。 */
  readonly epoch?: {
    readonly id?: string
    readonly dirtyCount?: number
    readonly dirtyFiles?: number
    readonly externalChanges?: number
    readonly head?: string | null
    readonly branch?: string | null
    readonly degraded?: boolean
  } | null
  readonly reads?: {
    readonly count?: number
    readonly changed?: number
    readonly unknown?: number
  }
  readonly sideEffects?: {
    readonly blindWrites?: number
    readonly staleWrites?: number
    readonly denies?: number
    readonly gaveUps?: number
    readonly writeWarnings?: number
    readonly unverifiable?: number
    /** v4.2：shell 写路径数 / shell 未知写次数 / 其他会话写过的已读路径数。 */
    readonly shellWrites?: number
    readonly shellUnknown?: number
    readonly otherSessionWrites?: number
    /** v4.4：shell 未知写经 git status 差分推断出的写次数。 */
    readonly shellInferred?: number
  }
}

/** 工具依赖。新增三个依赖**全部可选**（缺省降级，不假装有数据）。 */
export interface ProjectToolDeps {
  readonly clock: Clock
  /**
   * 解析本会话的项目上下文。**没有会话/项目库未打开时返回 undefined**——
   * 不拿别的项目顶替（位置即权威，见规划 §5.3）。
   */
  readonly resolveProject: (
    sessionId?: string,
  ) => { readonly cwd?: string; readonly store?: MemoryStore } | undefined
  /** 画像服务（每次调用惰性解析：热插拔可能换实例/关闭）。 */
  readonly profile?: () => ProjectProfilePort | undefined
  /**
   * 项目运行证据（v4.5.3 审查第 5 点）：最近构建/测试/类型检查等结果。
   * 缺省 = 未接线（渲染明确写"证据未接线"，不冒充"没有失败"）。
   */
  readonly evidence?: (root: string) => readonly ProjectEvidenceView[] | undefined
  /** 会话/工作区状态（v4.1 §3.3；缺省 = 状态未知）。 */
  readonly situation?: (sessionId?: string) => SessionSituationView | undefined
  /** 隐私读许可（v4.1 §5）。缺省 = 可读（服务缺席）；抛错 = 判定失败 → 视为不可读。 */
  readonly privacyAllowsRead?: (sessionId: string) => boolean
  /** 项目根解析（v4.1 §3.1；缺省 = cwd 本身）。 */
  readonly projectRoot?: (cwd: string) => string
}

/** 参数 schema：`parse` + 给模型看的 `jsonSchema`。 */
interface ToolParameters extends ToolInputSchema {
  readonly jsonSchema: Record<string, unknown>
}

const PROJECT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    refresh: {
      type: 'boolean',
      description: '强制重建画像（默认 false：读缓存；重建可能较慢）',
    },
  },
  additionalProperties: false,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 相对时间：只用于"多久前生成/多久没写"，精度到分钟即可。 */
export function describeAge(now: number, at: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(at)) return '时间未知'
  const deltaMs = Math.max(0, now - at)
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 空闲间隔（只给事实，不给指令）。 */
function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d${restHours}h`
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boolOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function joinParts(parts: readonly string[]): string {
  return parts.filter(part => part.length > 0).join(' · ')
}

/** 文件路径压成末两段（`dsh/project-profile.ts`），避免 L1 被长路径撑爆。 */
function shortFile(path: string): string {
  const parts = path.split('/').filter(part => part.length > 0)
  return parts.slice(-2).join('/')
}

/** 层内容：标题固定，正文可压缩。 */
interface Layer {
  readonly index: number
  readonly title: string
  readonly body: string
}

/**
 * 六层渲染 + 总长约束（v4.1 §2）。
 *
 * 压缩顺序确定：反复缩短**当前最长**的正文（每次到少缩 10%、保底 24 字符），
 * 全部正文都到保底仍超限才硬截断。同一输入 → 同一输出。
 */
export function renderSnapshot(layers: readonly Layer[], maxChars: number = MAX_SNAPSHOT_CHARS): string {
  const prefixes = layers.map(layer => `L${layer.index} ${layer.title}：`)
  const bodies = layers.map(layer => layer.body)
  const total = (): number =>
    prefixes.reduce((sum, prefix, index) => sum + prefix.length + (bodies[index] ?? '').length, 0) +
    Math.max(0, layers.length - 1)
  let guard = 0
  while (total() > maxChars && guard < 64) {
    guard += 1
    let longest = 0
    for (let index = 1; index < bodies.length; index += 1) {
      if ((bodies[index] ?? '').length > (bodies[longest] ?? '').length) longest = index
    }
    const current = bodies[longest] ?? ''
    if (current.length <= 24) break
    const overflow = total() - maxChars
    const shrink = Math.max(overflow, Math.ceil(current.length * 0.1), 1)
    bodies[longest] = clip(current, Math.max(24, current.length - shrink))
  }
  let text = layers.map((layer, index) => `${prefixes[index] ?? ''}${bodies[index] ?? ''}`).join('\n')
  if (text.length > maxChars) text = clip(text, maxChars)
  return text
}

/** 六层顺序固定：L0 身份 / L1 结构 / L2 空间状态 / L3 时间 / L4 知识 / L5 意图。 */
const LAYER_TITLES: readonly string[] = ['身份', '结构', '空间状态', '时间', '知识', '意图']

/** 解析项目根（缺服务/失败/空串 → cwd；绝不让上游异常打断快照）。 */
function resolveRoot(deps: ProjectToolDeps, cwd: string): string {
  try {
    const root = deps.projectRoot?.(cwd)
    if (typeof root === 'string' && root.length > 0) return root
  } catch {
    // 解析失败：cwd 本身是诚实降级（画像也会用 cwd 作根）
  }
  return cwd
}

/** cwd 相对根的路径（统一 `/`；根目录为 `''`）。 */
function cwdRelative(root: string, cwd: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedCwd === normalizedRoot) return ''
  if (normalizedCwd.startsWith(`${normalizedRoot}/`)) return normalizedCwd.slice(normalizedRoot.length + 1)
  return normalizedCwd
}

/** L0 身份：name/version、git root、cwd 相对根、branch/head/headAt。 */
function renderIdentity(input: {
  readonly root: string | undefined
  readonly cwd: string | undefined
  readonly view: ProjectProfileView | undefined
  readonly now: number
  readonly profileMissingReason: string | undefined
}): string {
  const { root, cwd, view } = input
  const identity = view?.identity
  const parts: string[] = []
  if (root === undefined) {
    return `未接线（项目根与画像均不可用${input.profileMissingReason === undefined ? '' : `：${input.profileMissingReason}`}）`
  }
  const nameVersion = identity?.name === undefined
    ? '项目名未接线'
    : `${identity.name}${identity.version === undefined ? '' : ` v${identity.version}`}`
  parts.push(nameVersion)
  parts.push(`git root ${root}`)
  const relative = view?.cwdRel ?? (cwd === undefined ? undefined : cwdRelative(root, cwd))
  parts.push(`cwd 相对根 ${relative === undefined ? '未知' : relative === '' ? '.' : relative}`)
  if (identity?.branch !== undefined && identity.branch.length > 0) parts.push(`分支 ${identity.branch}`)
  const head = identity?.head ?? view?.gitHead
  if (head !== undefined && head.length > 0) {
    const headAt = identity?.headAt
    parts.push(`HEAD ${head.slice(0, 12)}${headAt === undefined ? '' : `（${describeAge(input.now, headAt)}）`}`)
  } else {
    parts.push('git 头未接线/非 git')
  }
  return joinParts(parts)
}

/** L1 结构：顶层目录、源码目录规模、入口、文档标题、构建命令。 */
function renderStructure(view: ProjectProfileView | undefined, missingReason: string | undefined): string {
  if (view === undefined) {
    return missingReason === undefined ? '画像不可用（不是空）' : `画像不可用（${missingReason}）`
  }
  const structure = view.structure
  const parts: string[] = []
  if (structure?.topDirs !== undefined && structure.topDirs.length > 0) {
    parts.push(`顶层 ${structure.topDirs.slice(0, 6).map(dir => `${dir.name}(${dir.files})`).join('、')}`)
  }
  if (structure?.sources !== undefined && structure.sources.length > 0) {
    parts.push(
      `源码 ${structure.sources
        .slice(0, 4)
        .map(source => `${source.dir}(${source.files} 文件/${source.lines} 行/${source.tests} 测试)`)
        .join('、')}`,
    )
    // v4.2 符号层：只给"每个目录主要导出什么"的短摘要，不做完整 repo-map。
    const withSymbols = structure.sources.filter(source => (source.symbols?.length ?? 0) > 0).slice(0, 2)
    if (withSymbols.length > 0) {
      parts.push(
        `符号 ${withSymbols
          .map(source => `${source.dir}:${(source.symbols ?? []).slice(0, 4).join('/')}`)
          .join('；')}`,
      )
    }
  }
  // v4.3 依赖层：跨顶层目录的相对导入边（不是完整调用图）。
  if (structure?.imports !== undefined && structure.imports.length > 0) {
    parts.push(
      `依赖 ${structure.imports
        .slice(0, 4)
        .map(edge => `${edge.from}→${edge.to}(${edge.count})`)
        .join('、')}`,
    )
  }
  // v4.4 别名/文件级依赖/近似调用（正则近似，明确不是类型系统）。
  if (structure?.aliases !== undefined && structure.aliases.length > 0) {
    parts.push(`别名 ${structure.aliases.slice(0, 2).join('；')}`)
  }
  if (structure?.fileImports !== undefined && structure.fileImports.length > 0) {
    parts.push(
      `文件依赖 ${structure.fileImports
        .slice(0, 3)
        .map(edge => `${shortFile(edge.from)}→${shortFile(edge.to)}(${edge.count})`)
        .join('、')}`,
    )
  }
  if (structure?.calls !== undefined && structure.calls.length > 0) {
    parts.push(
      `调用 ${structure.calls
        .slice(0, 3)
        .map(call => `${shortFile(call.caller)}→${shortFile(call.callee)}:${call.symbol}`)
        .join('、')}`,
    )
  }
  if (structure?.entries !== undefined && structure.entries.length > 0) {
    parts.push(`入口 ${structure.entries.slice(0, 4).join('、')}`)
  }
  if (structure?.docs !== undefined && structure.docs.length > 0) {
    parts.push(`文档 ${structure.docs.slice(0, 4).map(doc => doc.title).filter(title => title.length > 0).join('、')}`)
  }
  if (view.gates !== undefined && view.gates.length > 0) {
    parts.push(`构建 ${view.gates.slice(0, 4).map(gate => `${gate.name}:${gate.command}`).join('、')}`)
  }
  if (parts.length === 0) {
    // 结构化字段缺席但画像文本在：如实降级到文本（不是"结构为空"）
    const text = view.text.trim()
    return text.length === 0 ? '画像不可用（文本与结构段均为空）' : clip(text, MAX_PROFILE_CHARS)
  }
  if (view.history?.commits !== undefined && view.history.commits.length > 0) {
    const commit = view.history.commits[0]
    if (commit !== undefined) parts.push(`最近提交 ${commit.hash.slice(0, 8)} ${clip(commit.subject, 40)}`)
  }
  if (view.history?.dirty !== undefined) parts.push(`未提交 ${view.history.dirty}`)
  return joinParts(parts)
}

const EVIDENCE_KIND_LABEL: Readonly<Record<string, string>> = {
  test: '测试',
  build: '构建',
  typecheck: '类型',
  lint: 'Lint',
  verify: '验收',
  install: '安装',
}

/**
 * L1 的运行证据行（v4.5.3 第 5 点）。
 *
 * 三种说法必须分开：未接线 / 本进程暂无读数 / 有读数。前两者都不能写成
 * "0 条证据"——那会被读成"没有失败"。
 */
export function renderProjectEvidence(
  evidence: readonly ProjectEvidenceView[] | undefined,
  now: number,
): string {
  if (evidence === undefined) return '证据未接线（项目证据服务未注册——不是"没有运行证据"）'
  if (evidence.length === 0) return '本进程暂无构建/测试读数（不是"没跑过"）'
  const parts = evidence.slice(0, 3).map(entry => {
    const label = EVIDENCE_KIND_LABEL[entry.kind] ?? entry.kind
    const mark = entry.commandOutcome === 'succeeded'
      ? '✅'
      : entry.commandOutcome === 'failed'
        ? '❌'
        : '⚠️未知'
    const fix = entry.recoveredFromFailure === true ? '（失败后再次成功）' : ''
    const code = entry.exitCode === undefined || entry.exitCode === null ? '' : ` exit ${entry.exitCode}`
    // v4.9.3：证据 → 文件映射（命令被截断时仍能看见它覆盖了哪些文件）
    const files = entry.paths === undefined || entry.paths.length === 0
      ? ''
      : ` → ${entry.paths.slice(0, 2).map(path => clip(path, 36)).join('、')}${entry.paths.length > 2 ? ` 等 ${entry.paths.length} 个` : ''}`
    return `${label}${mark}${code} ${clip(entry.command, 28)}${fix} ${describeAge(now, entry.at)}${files}`
  })
  return `证据：${parts.join('；')}`
}

/** L2 空间状态：epoch、脏文件数、外部改动、读取印记、守卫计数。 */
function renderSpace(situation: SessionSituationView | undefined): string {
  if (situation === undefined) return '状态未知（会话状态机未接线或无快照）'
  const parts: string[] = []
  const epoch = situation.epoch
  if (epoch !== null && epoch !== undefined) {
    const id = typeof epoch.id === 'string' && epoch.id.length > 0 ? epoch.id : undefined
    parts.push(`epoch ${id === undefined ? '未命名' : id}`)
    const dirty = finiteNumber(epoch.dirtyCount) ?? finiteNumber(epoch.dirtyFiles)
    if (dirty !== undefined) parts.push(`脏文件 ${dirty}`)
    const external = finiteNumber(epoch.externalChanges)
    if (external !== undefined) parts.push(`外部改动 ${external}`)
    if (boolOf(epoch.degraded) === true) parts.push('epoch 降级')
  } else {
    parts.push('epoch 未知')
  }
  const reads = situation.reads
  if (reads !== undefined) {
    parts.push(
      `读取印记 ${finiteNumber(reads.count) ?? 0}（已变化 ${finiteNumber(reads.changed) ?? 0}/无法核验 ${finiteNumber(reads.unknown) ?? 0}）`,
    )
  }
  const sideEffects = situation.sideEffects
  if (sideEffects !== undefined) {
    parts.push(
      `守卫 拒写 ${finiteNumber(sideEffects.denies) ?? 0}/放弃 ${finiteNumber(sideEffects.gaveUps) ?? 0}` +
        `/盲写 ${finiteNumber(sideEffects.blindWrites) ?? 0}/无法核验 ${finiteNumber(sideEffects.unverifiable) ?? 0}`,
    )
    const shellWrites = finiteNumber(sideEffects.shellWrites) ?? 0
    const shellUnknown = finiteNumber(sideEffects.shellUnknown) ?? 0
    const shellInferred = finiteNumber(sideEffects.shellInferred) ?? 0
    const otherWrites = finiteNumber(sideEffects.otherSessionWrites) ?? 0
    if (shellWrites > 0 || shellUnknown > 0) {
      parts.push(`shell 写 ${shellWrites}/未知 ${shellUnknown}`)
    }
    if (shellInferred > 0) parts.push(`shell 推断写 ${shellInferred}`)
    if (otherWrites > 0) parts.push(`其他会话写 ${otherWrites}`)
  }
  return joinParts(parts)
}

/** L3 时间：回合/步、空闲档位与间隔、上次回合结束原因、是否中断。 */
function renderTime(situation: SessionSituationView | undefined, sessionId: string | undefined): string {
  if (sessionId === undefined) return '无会话归属'
  if (situation === undefined) return '无会话归属（状态机未接线）'
  const parts: string[] = []
  parts.push(`回合 ${finiteNumber(situation.turn) ?? 0}/步 ${finiteNumber(situation.step) ?? 0}`)
  const tier = typeof situation.tier === 'string' && situation.tier.length > 0 ? situation.tier : '未知'
  const idleMs = finiteNumber(situation.idleMs)
  parts.push(`空闲 ${tier}${idleMs === undefined ? '' : `（${formatGap(idleMs)}）`}`)
  if (situation.lastTurnEndReason !== undefined && situation.lastTurnEndReason !== null) {
    parts.push(`上次结束 ${situation.lastTurnEndReason}`)
  }
  parts.push(`中断 ${situation.interrupted === true ? '是' : '否'}`)
  return joinParts(parts)
}

/** L5 意图：开放目标/待办、未解决标记（缺服务时按"无待办"如实标注）。 */
function renderIntent(situation: SessionSituationView | undefined, sessionId: string | undefined): string {
  if (sessionId === undefined) return '0（无会话归属：无法统计）'
  if (situation === undefined) return '0（状态机未接线：无法统计）'
  const goals = situation.goals
  const todos = situation.todos
  return joinParts([
    `开放目标 ${finiteNumber(goals?.open) ?? 0}/${finiteNumber(goals?.total) ?? 0}`,
    `待办 ${finiteNumber(todos?.open) ?? 0}/${finiteNumber(todos?.total) ?? 0}`,
    `未解决 ${situation.unresolved === true ? '是' : '否'}`,
  ])
}

/** 一条项目记忆的摘要行（时间/类型/摘要；带 id 便于后续 relate/forget）。 */
function memoryLine(rank: number, record: MemoryRecord, now: number): string {
  const kind: MemoryKind = record.kind
  const stage = stageLabel(stageOfMemory({ kind: record.kind, assertedBy: record.assertedBy }))
  return `[${rank}] ${isoUtc(record.observedAt)}（${describeAge(now, record.observedAt)}） · ${kind}/${stage} · id=${record.id} · ${clip(record.text, MAX_MEMORY_CHARS)}`
}

/** 关联边计数（top 3 的 1-hop related；失败返回 undefined = 未统计，不写 0）。 */
async function countRelatedEdges(store: MemoryStore, ids: readonly string[]): Promise<number | undefined> {
  if (ids.length === 0) return undefined
  try {
    const edges = new Set<string>()
    for (const id of ids) {
      const walk = await store.walkGraph({ fromId: id, depth: 1, types: ['related' as EdgeType] })
      for (const edge of walk.edges) {
        if (edge.type !== 'related') continue
        edges.add(`${edge.fromId}>${edge.toId}`)
      }
    }
    return edges.size
  } catch {
    return undefined
  }
}

/** L4 知识：项目记忆 top 3 + 近况 + 关联边。 */
async function renderKnowledge(input: {
  readonly store: MemoryStore | undefined
  readonly sessionId: string | undefined
  readonly now: number
}): Promise<string> {
  if (input.sessionId === undefined) return '暂无记忆（无会话归属：不读项目记忆）'
  const store = input.store
  if (store === undefined) return '暂无记忆（项目库未打开）'
  try {
    const hits = await store.searchLexical({ text: PROJECT_MEMORY_QUERY, scope: 'project', limit: PROJECT_MEMORY_TOP })
    const records = await store.getMany(hits.map(hit => hit.id))
    const byId = new Map(records.map(record => [record.id, record]))
    const valid: MemoryRecord[] = []
    for (const hit of hits) {
      const record = byId.get(hit.id)
      if (record === undefined || record.validTo !== null) continue
      valid.push(record)
      if (valid.length >= PROJECT_MEMORY_TOP) break
    }
    if (valid.length === 0) return '暂无记忆（本项目还没有可用的项目记忆）'
    const now = input.now
    const parts = valid.map((record, index) => memoryLine(index + 1, record, now))
    const newest = Math.max(...valid.map(record => record.observedAt))
    const recent = now - newest <= RECENT_MEMORY_MS ? '近 7 天有更新' : `最近更新 ${describeAge(now, newest)}`
    parts.push(`近况：${recent}`)
    const edges = await countRelatedEdges(store, valid.map(record => record.id))
    parts.push(edges === undefined ? '关联边未统计' : `关联边 ${edges}`)
    return parts.join('；')
  } catch (error) {
    return `暂无记忆（读取失败，已隔离：${messageOf(error)}）`
  }
}

/** 造 `omb_project` 工具。**执行体绝不抛**（H-3）。 */
export function createProjectTool(deps: ProjectToolDeps): ToolDefinition {
  const parameters: ToolParameters = {
    jsonSchema: PROJECT_JSON_SCHEMA,
    parse(input: unknown): unknown {
      if (input === undefined || input === null) return {}
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象：{ refresh?: boolean }')
      const raw = input as { refresh?: unknown }
      if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') {
        throw new Error('refresh 必须是布尔值')
      }
      return raw.refresh === undefined ? {} : { refresh: raw.refresh }
    },
  }

  return {
    name: PROJECT_TOOL,
    description:
      '任务开始时先读项目的分层时空快照（L0–L5：身份/结构/空间状态/时间/知识/意图）：'
      + '项目根与 git 身份、目录与源码规模、epoch 与读取/守卫状态、会话回合与空闲、项目记忆 top 3、开放目标/待办。'
      + '总长 ≤2400 字符；缺失项会明确写"未接线/无会话归属/暂无"，不是 0。需要最新画像时传 refresh:true。',
    parameters,
    async execute(args: unknown, call?: { readonly sessionId?: string; readonly attribution?: string }): Promise<ToolOutcome> {
      try {
        if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
          const raw = args as { refresh?: unknown }
          if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') {
            return { kind: 'error', text: `${PROJECT_TOOL} 参数非法：refresh 必须是布尔值` }
          }
        } else if (args !== undefined && args !== null) {
          return { kind: 'error', text: `${PROJECT_TOOL} 参数非法：参数必须是对象 { refresh?: boolean }` }
        }
        const refresh = (args as { refresh?: boolean } | undefined)?.refresh === true
        const sessionId = call?.attribution === 'session' ? call.sessionId : undefined
        const now = deps.clock.now()
        const lines: string[] = []

        // ── 隐私先于任何读取（v4.1 §5）──────────────────────────────────
        if (sessionId !== undefined && deps.privacyAllowsRead !== undefined) {
          let allowed: boolean
          try {
            allowed = deps.privacyAllowsRead(sessionId)
          } catch {
            // 判定失败 = 不可读（fail-closed 只作用于本工具，库边界的 fail-closed 另有其道）
            allowed = false
          }
          if (!allowed) {
            return {
              kind: 'text',
              text:
                `${PROJECT_TOOL}：当前会话不可读（隐私模式 sealed，或隐私判定失败）——`
                + '没有读取项目画像与项目记忆。如需解除：用户执行 /omb-privacy normal。',
            }
          }
        }

        // ── 解析项目上下文（无会话归属时可能为空）────────────────────────
        let resolved: { readonly cwd?: string; readonly store?: MemoryStore } | undefined
        try {
          resolved = deps.resolveProject(sessionId)
        } catch {
          resolved = undefined
        }
        const cwd = resolved?.cwd
        const root = cwd === undefined ? undefined : resolveRoot(deps, cwd)
        const situation = (() => {
          if (sessionId === undefined || deps.situation === undefined) return undefined
          try {
            return deps.situation(sessionId)
          } catch {
            return undefined
          }
        })()

        // ── 画像（只在有 cwd 时读；sealed 已在上方拦截）──────────────────
        let view: ProjectProfileView | undefined
        let profileMissingReason: string | undefined
        const profile = (() => {
          try {
            return deps.profile?.()
          } catch {
            return undefined
          }
        })()
        if (cwd === undefined) {
          profileMissingReason = '没有会话归属，无法确定当前项目目录'
        } else if (profile === undefined) {
          profileMissingReason = `宿主未接线 ${PROJECT_PROFILE_SERVICE} 服务`
        } else {
          try {
            view = refresh ? await profile.refresh(cwd) : profile.read(cwd)
            if (view === undefined) {
              profileMissingReason = refresh ? '重建失败（宿主没有返回画像）' : '尚未生成（可用 refresh:true 生成）'
            }
          } catch (error) {
            profileMissingReason = `${refresh ? '重建' : '读取'}失败（已隔离：${messageOf(error)}）`
          }
        }

        /**
         * 运行证据（v4.5.3 第 5 点）：项目根为键，读最近构建/测试结果。
         * 没有根 / 没接线 → undefined，渲染时明确写"未接线"，不写"0 条=没有失败"。
         */
        let evidence: readonly ProjectEvidenceView[] | undefined
        if (root !== undefined && deps.evidence !== undefined) {
          try {
            evidence = deps.evidence(root)
          } catch {
            evidence = undefined
          }
        }

        const layers: Layer[] = [
          {
            index: 0,
            title: LAYER_TITLES[0] as string,
            body: renderIdentity({ root, cwd, view, now, profileMissingReason }),
          },
          {
            index: 1,
            title: LAYER_TITLES[1] as string,
            // 结构与运行证据并排：地图不是"只有边"，还要回答"最近一次过没过"。
            body: joinParts([renderStructure(view, profileMissingReason), renderProjectEvidence(evidence, now)]),
          },
          { index: 2, title: LAYER_TITLES[2] as string, body: renderSpace(situation) },
          { index: 3, title: LAYER_TITLES[3] as string, body: renderTime(situation, sessionId) },
          {
            index: 4,
            title: LAYER_TITLES[4] as string,
            body: await renderKnowledge({ store: resolved?.store, sessionId, now }),
          },
          { index: 5, title: LAYER_TITLES[5] as string, body: renderIntent(situation, sessionId) },
        ]
        lines.push(renderSnapshot(layers))
        return { kind: 'text', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `${PROJECT_TOOL} 执行失败：${messageOf(error)}` }
      }
    },
  }
}
