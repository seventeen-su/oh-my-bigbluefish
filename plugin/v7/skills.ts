/**
 * OMB v7 技能说明接线：把 `skills/omb-{memory,recall,state,consolidate}/SKILL.md`
 * 注册成 DSH 技能提供者。
 *
 * 为什么用 provider 而不是 `ctx.skills.register()`：四篇说明是随包分发的文件
 * （deploy 只复制 4 个目录），`register()` 要求加载期就给出完整 content；只有
 * provider 的 `list`/`get` 才能惰性读盘，满足「加载期不碰磁盘」。
 *
 * DSH 契约（DSH checkout 的 `packages/skill/skill/src/index.ts`）：
 * - `registerProvider(create)`：apply 期同步注册，create 返回 `{ name, list, get }`（:393）；
 * - `list(options)`：返回候选数组或 `{ candidates, complete }`；`complete=false`
 *   会让注册表跳过缓存、下次重新发现（:250-262、:543-549、:606-620）；
 * - `get(candidate, options)`：返回完整 `SkillDefinition`（含 content）或 `undefined`（:269）；
 * - 候选 `provider` 必须等于 provider.name，name 必须是 kebab-case（:24、:736-738）；
 * - 同名提供者在一个 layer 内只能注册一次，重复注册会抛错（:337-339）。
 *
 * 因此本模块：加载期只注册 provider；错误一律降级为日志/空目录，不抛给宿主；
 * 读盘失败不永久缓存（`complete=false` 让注册表下次重试）。
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import { asRecord, readService, type HostContextLike } from '../../packages/v7/src/adapters/dsh/host.js'

/** v7 功能说明的四个名字；顺序即目录名，也是本 provider 的注册面。 */
export const OMB_SKILL_NAMES = ['omb-memory', 'omb-recall', 'omb-state', 'omb-consolidate'] as const

/** 四个功能说明之一的名字。 */
export type OmbSkillName = (typeof OMB_SKILL_NAMES)[number]

/** 提供者名；候选的 `provider` 字段必须与它一致。 */
const PROVIDER_NAME = 'omb-v7'
const SOURCE = 'bundled'
/** 与 DSH `BUNDLED_SKILL_RANK` 一致：包内技能的常规排名。 */
const RANK = 600
/** 从模块位置向上找 `skills/` 的最大层数：源码 plugin/v7 距根 2 层，构建产物 lib-gen/v7-gN/plugin/v7 距根 4 层。 */
const MAX_ROOT_WALK = 6

export interface OmbSkillInvocation {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** DSH 候选的最小结构面；本包不依赖 @deepseek-ai/dsh-skill，只镜像契约。 */
export interface OmbSkillCandidate {
  readonly name: string
  readonly description: string
  readonly invocation: OmbSkillInvocation
  readonly source: string
  readonly provider: string
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string }
}

/** DSH 完整技能定义：候选去掉 rank/locator，加上正文。 */
export type OmbSkillDefinition = Omit<OmbSkillCandidate, 'rank' | 'locator'> & {
  readonly content: string
}

/** 注册期生命周期：中止信号与目录失效回调。 */
export interface OmbSkillProviderControl {
  readonly signal: AbortSignal
  invalidate(): void
}

/** provider 的 `list` 观察结果；`complete=false` 表示本次发现不应被缓存。 */
export interface OmbSkillProviderObservation {
  readonly candidates: readonly OmbSkillCandidate[]
  readonly complete: boolean
}

export interface OmbSkillProviderLike {
  readonly name: string
  list(options: { readonly signal?: AbortSignal | undefined }): Promise<OmbSkillProviderObservation>
  get(candidate: OmbSkillCandidate, options: { readonly signal?: AbortSignal | undefined }): Promise<OmbSkillDefinition | undefined>
}

/** `ctx.skills` 的最小结构面。 */
export interface OmbSkillsRegistryLike {
  registerProvider(create: (control: OmbSkillProviderControl) => OmbSkillProviderLike): () => void
}

/**
 * 注册所需的宿主上下文：`HostContextLike` 加上 cordis 服务属性。
 * 单独声明 `skills` 是为了让测试替身（只有 skills 字段）与类型有共同属性，
 * 同时保留运行期 `ctx.get('skills')` 的兜底。
 */
export interface SkillsHostContextLike extends HostContextLike {
  readonly skills?: unknown
}

export interface RegisterSkillsOptions {
  /** 覆盖技能根目录（测试或自定义部署用）；缺省从模块位置向上查找 `skills/`。 */
  readonly skillRoot?: string
}

interface SkillRead {
  readonly kind: 'loaded'
  readonly description: string
  readonly invocation: OmbSkillInvocation
  readonly content: string
}

interface SkillReadFailure {
  readonly kind: 'failed'
  readonly reason: string
  /**
   * 缺文件/无 frontmatter 这类失败在文件不变时不会自愈：目录仍算完整，只是少一条；
   * 其它 IO 失败（权限、EISDIR、锁）下次可能成功，目录必须标记为不完整以便重试。
   */
  readonly persistent: boolean
}

type SkillReadOutcome = SkillRead | SkillReadFailure

/** 从模块位置向上找包含 `skills/<第一个技能>/` 的根目录；找不到返回 undefined，绝不抛。 */
async function defaultSkillRoot(): Promise<string | undefined> {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < MAX_ROOT_WALK; depth += 1) {
    const candidate = join(directory, 'skills')
    if (await isDirectory(join(candidate, OMB_SKILL_NAMES[0]))) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** frontmatter 只支持本模块需要的单行标量；四篇说明都是这种形状。 */
function parseFrontmatter(raw: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (match?.[1] === undefined) return undefined
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair?.[1] === undefined) continue
    fields[pair[1]] = unquote(pair[2] ?? '')
  }
  return fields
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

function frontmatterBoolean(fields: Record<string, string>, name: string): boolean | undefined {
  const value = fields[name]
  if (value === undefined) return undefined
  const normalized = value.toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  return undefined
}

/** 解析一篇 SKILL.md；frontmatter 缺 description、name 与目录不一致或正文为空都算不可用。 */
function parseSkillDoc(raw: string, expectedName: OmbSkillName): SkillReadOutcome {
  const text = raw.replace(/^\uFEFF/, '')
  const fields = parseFrontmatter(text)
  if (fields === undefined) return { kind: 'failed', reason: '缺少 YAML frontmatter', persistent: true }
  const description = fields['description']?.trim()
  if (description === undefined || description.length === 0) {
    return { kind: 'failed', reason: 'frontmatter 缺少 description', persistent: true }
  }
  const declaredName = fields['name']?.trim()
  if (declaredName !== undefined && declaredName !== expectedName) {
    return { kind: 'failed', reason: `frontmatter name=${declaredName} 与目录 ${expectedName} 不一致`, persistent: true }
  }
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)
  const content = frontmatter === null ? text.trim() : text.slice(frontmatter[0].length).trim()
  if (content.length === 0) return { kind: 'failed', reason: '正文为空', persistent: true }
  return {
    kind: 'loaded',
    description,
    invocation: {
      modelInvocable: frontmatterBoolean(fields, 'disable-model-invocation') !== true,
      // 四篇说明都写 user-invocable: false：它们只给模型看，不挂在人类命令面上。
      userInvocable: frontmatterBoolean(fields, 'user-invocable') !== false,
    },
    content,
  }
}

function errorCodeOf(error: unknown): string | undefined {
  const record = asRecord(error)
  const code = record?.['code']
  return typeof code === 'string' ? code : undefined
}

/** ENOENT/ENOTDIR 在文件出现前不会自愈；其余 IO 错误（EACCES/EISDIR/EBUSY）下次仍可能成功。 */
function isPersistentReadFailure(error: unknown): boolean {
  const code = errorCodeOf(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '[unrenderable error]'
  }
}

/** 绝对路径统一用正斜杠，和 DSH 自己的 provider（skill-office）保持一致。 */
function posixPath(path: string): string {
  return path.split(sep).join('/')
}

export interface OmbSkillsProviderOptions {
  readonly control?: OmbSkillProviderControl
  readonly logger?: Logger
  readonly skillRoot?: string
}

/**
 * 四篇 OMB 功能说明的 provider。
 *
 * 加载期不读盘：`list`/`get` 被调用时才解析根目录并读 `SKILL.md`。缺文件只少一条
 * 候选；权限/目录等 IO 失败把观察标记为不完整，让注册表下一轮重试；读取/解析
 * 失败都不向宿主抛（唯一例外是调用方自己的 abort 取消，按注册表约定传播）。
 */
export class OmbSkillsProvider implements OmbSkillProviderLike {
  readonly name = PROVIDER_NAME
  private readonly control: OmbSkillProviderControl | undefined
  private readonly logger: Logger | undefined
  private readonly explicitRoot: string | undefined
  private readonly reportedFailures = new Map<string, string>()
  private resolvedRoot: string | undefined

  constructor(options: OmbSkillsProviderOptions = {}) {
    this.control = options.control
    this.logger = options.logger
    this.explicitRoot = options.skillRoot
  }

  async list(options: { readonly signal?: AbortSignal | undefined }): Promise<OmbSkillProviderObservation> {
    const root = await this.root()
    if (root === undefined) {
      this.reportFailure('root', '技能根目录未找到：随包 skills/ 可能没有复制到 profile')
      return { candidates: [], complete: false }
    }
    const candidates: OmbSkillCandidate[] = []
    let complete = true
    for (const name of OMB_SKILL_NAMES) {
      options.signal?.throwIfAborted()
      const read = await this.readSkill(root, name, options.signal)
      if (read.kind === 'loaded') {
        this.reportedFailures.delete(name)
        const file = posixPath(this.skillFile(root, name))
        candidates.push({
          name,
          description: read.description,
          invocation: read.invocation,
          source: SOURCE,
          provider: PROVIDER_NAME,
          rank: RANK,
          locator: file,
          path: file,
          resourceBase: { kind: 'directory', path: posixPath(join(root, name)) },
        })
      } else {
        this.reportFailure(name, read.reason)
        if (!read.persistent) complete = false
      }
    }
    return { candidates, complete }
  }

  async get(
    candidate: OmbSkillCandidate,
    options: { readonly signal?: AbortSignal | undefined },
  ): Promise<OmbSkillDefinition | undefined> {
    const name = this.nameOf(candidate.name)
    if (name === undefined) return undefined
    const root = await this.root()
    if (root === undefined) {
      this.reportFailure('root', '技能根目录未找到：随包 skills/ 可能没有复制到 profile')
      this.control?.invalidate()
      return undefined
    }
    const read = await this.readSkill(root, name, options.signal)
    if (read.kind === 'failed') {
      // 读失败时让目录缓存失效，下一次 list 重新发现；仍返回 undefined 而不是抛给宿主。
      this.reportFailure(name, read.reason)
      this.control?.invalidate()
      return undefined
    }
    this.reportedFailures.delete(name)
    return {
      name,
      description: read.description,
      invocation: read.invocation,
      source: SOURCE,
      provider: PROVIDER_NAME,
      path: posixPath(this.skillFile(root, name)),
      resourceBase: { kind: 'directory', path: posixPath(join(root, name)) },
      content: read.content,
    }
  }

  private nameOf(value: string): OmbSkillName | undefined {
    return (OMB_SKILL_NAMES as readonly string[]).includes(value) ? value as OmbSkillName : undefined
  }

  private skillFile(root: string, name: OmbSkillName): string {
    return join(root, name, 'SKILL.md')
  }

  /** 只缓存成功解析到的根目录；失败下次重新查找（部署/构建可能晚于首次读取）。 */
  private async root(): Promise<string | undefined> {
    if (this.explicitRoot !== undefined) return this.explicitRoot
    if (this.resolvedRoot !== undefined) return this.resolvedRoot
    const resolved = await defaultSkillRoot()
    if (resolved !== undefined) this.resolvedRoot = resolved
    return resolved
  }

  private async readSkill(
    root: string,
    name: OmbSkillName,
    signal: AbortSignal | undefined,
  ): Promise<SkillReadOutcome> {
    const path = this.skillFile(root, name)
    let raw: string
    try {
      raw = await readFile(path, { encoding: 'utf8', signal })
    } catch (error) {
      if (signal?.aborted === true) throw error
      return {
        kind: 'failed',
        reason: `${messageOf(error)}（${path}）`,
        persistent: isPersistentReadFailure(error),
      }
    }
    return parseSkillDoc(raw, name)
  }

  /** 同一条失败只记一次日志，避免每次 catalog 重读都刷屏。 */
  private reportFailure(key: string, reason: string): void {
    if (this.reportedFailures.get(key) === reason) return
    this.reportedFailures.set(key, reason)
    this.logger?.warn(`技能说明不可用：${key}`, reason)
  }
}

function readRegistry(ctx: SkillsHostContextLike | undefined): OmbSkillsRegistryLike | undefined {
  if (ctx === undefined) return undefined
  let candidate: unknown
  try {
    candidate = ctx.skills
  } catch {
    // 未声明 inject 的 cordis context 读取服务属性会抛；退回 ctx.get 再试一次。
    candidate = undefined
  }
  if (candidate === undefined) candidate = readService(ctx, 'skills')
  const record = asRecord(candidate)
  if (record === undefined || typeof record['registerProvider'] !== 'function') return undefined
  return candidate as OmbSkillsRegistryLike
}

/**
 * 注册四篇 OMB 功能说明的 provider。
 *
 * 必须由组合根在 `apply()` 里同步调用。宿主缺少 skills 服务、provider 重名、
 * 注册抛错时只记 warn 并返回空 disposer，绝不把异常抛回宿主。
 *
 * @param ctx - 宿主 context；`ctx.skills` 或 `ctx.get('skills')` 任一可用即可。
 * @param logger - OMB 日志端口；缺省静默。
 * @param options - 可选技能根目录覆盖（测试/自定义部署）。
 * @returns 注销该 provider 的同步 disposer；未注册时返回空函数。
 */
export function registerSkills(
  ctx: SkillsHostContextLike | undefined,
  logger?: Logger,
  options: RegisterSkillsOptions = {},
): () => void {
  const registry = readRegistry(ctx)
  if (registry === undefined) {
    logger?.warn('技能说明未注册：宿主没有可用的 skills 服务（cordis.patch.v7.yml 需要 inject skills）')
    return () => {}
  }
  try {
    const disposer = registry.registerProvider(control => new OmbSkillsProvider({
      control,
      ...(logger !== undefined ? { logger } : {}),
      ...(options.skillRoot !== undefined ? { skillRoot: options.skillRoot } : {}),
    }))
    return typeof disposer === 'function' ? disposer : () => {}
  } catch (error) {
    logger?.warn('技能说明未注册：registerProvider 失败', messageOf(error))
    return () => {}
  }
}
