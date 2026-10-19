/**
 * 项目证据账本（v4.5.3 审查第 5 点）。
 *
 * ## 它补的是什么
 *
 * `dsh/project-profile.ts` 的项目画像回答"项目长什么样"：目录、导入、符号、
 * 构建命令——全是**静态结构**。它不回答"最近一次测试到底过没过"。
 *
 * 用户的原话是"项目地图需要与真实代码和测试结果闭环，而不是继续单纯增加图的边数"。
 * 本账本记录 `dsh/` **亲眼看到**的工具结果：命令、类别（build/test/typecheck/lint/
 * verify/install）、成功/失败、时间、项目根。`omb_project` 的 L1 把结构与这些
 * 运行证据并排显示。
 *
 * ## 边界（不声称是完整审计）
 *
 * - 只认 `tool/result/observed` 里带 `tool + args + ok` 的结果；参数缺失/结果未知
 *   一律跳过（`skipped` 计数），不猜。
 * - 只覆盖"命令行里能看出来"的构建/测试；编辑器内置任务、IDE 里跑的单测不在内。
 * - 有界：每项目最近 `MAX_PER_PROJECT` 条，最多 `MAX_PROJECTS` 个项目。
 * - 落盘到 `<projectRoot>/.omb/evidence.json`（可关）：证据跨进程可见，但仍是
 *   "本机这份工作区最近看到的运行结果"，不是完整 CI 审计。
 * - 命令里的凭据形态（`token=…` / `Bearer …`）先脱敏再落盘。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Clock } from '../kernel/abi/index.js'

export type ProjectEvidenceKind = 'test' | 'build' | 'typecheck' | 'lint' | 'verify' | 'install'

export interface ProjectEvidenceEntry {
  readonly kind: ProjectEvidenceKind
  readonly command: string
  readonly ok: boolean
  readonly at: number
  /**
   * v4.6.0：同一命令此前失败、这次成功 → 本次可视为"修复已验证"。
   * 只是**证据标记**，不自动把任何记忆/规则升级。
   */
  readonly verifiedFix?: boolean
}

export interface ProjectEvidenceRecord extends ProjectEvidenceEntry {
  readonly projectRoot: string
}

export interface ProjectEvidenceStats {
  readonly recorded: number
  readonly skipped: number
  readonly projects: number
  /** 落盘失败次数（0 = 真的没失败；失败时内存记录仍保留）。 */
  readonly persistFailures: number
}

export interface ProjectEvidencePort {
  /** 记一次工具结果；不是构建/测试类命令、或无法归属项目时跳过（不猜）。 */
  record(input: {
    readonly sessionId: string
    readonly tool?: string
    readonly args?: string
    readonly ok?: boolean
    readonly at: number
  }): void
  /** 某项目根的最近证据（新→旧）；没有记录返回空数组。 */
  snapshot(projectRoot: string): readonly ProjectEvidenceEntry[]
  stats(): ProjectEvidenceStats
}

export interface ProjectEvidenceOptions {
  readonly clock: Clock
  /** 会话 → 项目根；undefined = 无法归属（跳过，不写进别的项目）。 */
  readonly resolveRoot: (sessionId: string) => string | undefined
  readonly maxPerProject?: number
  readonly maxProjects?: number
  /** 是否落盘到 `<root>/.omb/evidence.json`（默认 true；测试可关）。 */
  readonly persist?: boolean
}

/** 每项目保留条数（够回答"最近一次过没过"）。 */
export const MAX_EVIDENCE_PER_PROJECT = 8
/** 最多记几个项目（防止长跑进程记住每个打开过的仓库）。 */
export const MAX_EVIDENCE_PROJECTS = 16
/** 单条命令的展示上限。 */
export const MAX_EVIDENCE_COMMAND_CHARS = 160

/** 命令行工具名（只有这些工具的 args 才可能是"命令"）。 */
const SHELL_TOOL_PATTERN = /(pwsh|powershell|bash|shell|zsh|sh|exec|run|command|terminal)/i

/** 类别判据：顺序即优先级（test > build > typecheck > lint > verify > install）。 */
const KIND_PATTERNS: readonly { readonly kind: ProjectEvidenceKind; readonly pattern: RegExp }[] = [
  { kind: 'test', pattern: /\b(?:pnpm|npm|yarn|bun|npx)\s+(?:run\s+)?(?:test|vitest)\b|\bvitest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/i },
  { kind: 'build', pattern: /\b(?:pnpm|npm|yarn|npx)\s+(?:run\s+)?build\b|\bnode\s+scripts\/build\.mjs\b|\bvite\s+build\b|\bgo\s+build\b|\bcargo\s+build\b/i },
  { kind: 'typecheck', pattern: /\btsc\b|\btsc\s+--noEmit\b|\btypecheck\b/i },
  { kind: 'lint', pattern: /\beslint\b|\blint\b/i },
  { kind: 'verify', pattern: /\bcheck-resolution\b|\bverify\b/i },
  { kind: 'install', pattern: /\b(?:pnpm|npm|yarn|bun)\s+(?:install|i)\b/i },
]

/** 从工具参数里抽命令；抽不到返回 undefined（不把 JSON 整段当命令）。 */
export function extractEvidenceCommand(args: string | undefined): string | undefined {
  if (typeof args !== 'string' || args.trim().length === 0) return undefined
  const text = args.trim()
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'string' && parsed.trim().length > 0) return parsed.trim()
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of ['command', 'cmd', 'script']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      }
    }
  } catch {
    // 不是 JSON：命令串本身（有些宿主把 args 直接给成命令行）
  }
  // `"command":"..."` 的未解析/半解析形态
  const match = /"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  if (match?.[1] !== undefined) {
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return match[1]
    }
  }
  return text.startsWith('{') || text.startsWith('[') ? undefined : text
}

export function classifyEvidenceCommand(command: string): ProjectEvidenceKind | null {
  for (const entry of KIND_PATTERNS) {
    if (entry.pattern.test(command)) return entry.kind
  }
  return null
}

const KIND_LABEL_SET: Readonly<Record<string, true>> = {
  test: true,
  build: true,
  typecheck: true,
  lint: true,
  verify: true,
  install: true,
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '')
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * 证据命令里的凭据脱敏（v4.6.0）。
 *
 * 证据要落盘，命令串可能带 `--token=…` / `Bearer …`。这里只处理**明显的**
 * 键值形态；不做通用 secret 扫描（那是记忆库 `secrets.ts` 的职责，dsh 层不复制
 * 那张模式表）。脱敏失败也不阻止记录——但绝不把原文直接写进 `.omb/evidence.json`。
 */
export function redactEvidenceCommand(command: string): string {
  return command
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1***')
    .replace(
      /((?:token|password|passwd|secret|api[_-]?key|authorization)\s*[=:]\s*)(?!Bearer\b|\*\*\*)([^\s"'`]+)/gi,
      '$1***',
    )
    .replace(
      /(\b(?:token|password|passwd|secret|api[_-]?key)\s+)(?!\*\*\*)([^\s"'`]+)/gi,
      '$1***',
    )
}

function evidenceFileOf(root: string): string {
  return join(root, '.omb', 'evidence.json')
}

/**
 * 造一个证据账本。`clock` 留作测试注入；真实记录用事件自带 `at`。
 *
 * 持久化：每个项目根一份 `.omb/evidence.json`（最多 8 条），进程重启后仍能回答
 * "上次失败的是哪条命令、修复后有没有再跑过"。落盘失败只计 `persistFailures`，
 * 不阻止内存记录（证据丢失可见，但不静默）。
 */
export function createProjectEvidence(options: ProjectEvidenceOptions): {
  readonly port: ProjectEvidencePort
  readonly dispose: () => void
} {
  const maxPerProject = options.maxPerProject ?? MAX_EVIDENCE_PER_PROJECT
  const maxProjects = options.maxProjects ?? MAX_EVIDENCE_PROJECTS
  const persist = options.persist !== false
  const projects = new Map<string, ProjectEvidenceRecord[]>()
  const loaded = new Set<string>()
  let recorded = 0
  let skipped = 0
  let persistFailures = 0

  const load = (root: string): ProjectEvidenceRecord[] => {
    const key = normalizeRoot(root)
    const existing = projects.get(key)
    if (existing !== undefined) return existing
    if (!persist || !existsSync(evidenceFileOf(root))) {
      const empty: ProjectEvidenceRecord[] = []
      projects.set(key, empty)
      loaded.add(key)
      return empty
    }
    try {
      const raw = JSON.parse(readFileSync(evidenceFileOf(root), 'utf8')) as {
        readonly entries?: readonly unknown[]
      }
      const list: ProjectEvidenceRecord[] = []
      for (const item of raw.entries ?? []) {
        if (item === null || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        if (typeof entry.kind !== 'string' || typeof entry.command !== 'string') continue
        if (typeof entry.ok !== 'boolean' || typeof entry.at !== 'number') continue
        if (!(entry.kind in KIND_LABEL_SET)) continue
        list.push({
          kind: entry.kind as ProjectEvidenceKind,
          command: entry.command.slice(0, MAX_EVIDENCE_COMMAND_CHARS),
          ok: entry.ok,
          at: entry.at,
          verifiedFix: entry.verifiedFix === true,
          projectRoot: root,
        })
        if (list.length >= maxPerProject) break
      }
      projects.set(key, list)
      loaded.add(key)
      return list
    } catch {
      persistFailures += 1
      const empty: ProjectEvidenceRecord[] = []
      projects.set(key, empty)
      loaded.add(key)
      return empty
    }
  }

  const save = (root: string, list: readonly ProjectEvidenceRecord[]): void => {
    if (!persist) return
    try {
      const file = evidenceFileOf(root)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({
        version: 1,
        entries: list.map(({ projectRoot: _projectRoot, ...entry }) => entry),
      }, null, 2))
    } catch {
      persistFailures += 1
    }
  }

  const record: ProjectEvidencePort['record'] = input => {
    try {
      if (input.ok === undefined) {
        skipped += 1
        return
      }
      if (input.tool === undefined || !SHELL_TOOL_PATTERN.test(input.tool)) {
        skipped += 1
        return
      }
      const command = extractEvidenceCommand(input.args)
      if (command === undefined || command.length === 0) {
        skipped += 1
        return
      }
      const kind = classifyEvidenceCommand(command)
      if (kind === null) {
        skipped += 1
        return
      }
      const root = options.resolveRoot(input.sessionId)
      if (root === undefined || root.length === 0) {
        skipped += 1
        return
      }
      const key = normalizeRoot(root)
      if (!projects.has(key) && projects.size >= maxProjects) {
        const oldest = projects.keys().next().value
        if (oldest !== undefined) projects.delete(oldest)
      }
      const list = load(root)
      const redacted = redactEvidenceCommand(command).slice(0, MAX_EVIDENCE_COMMAND_CHARS)
      const normalized = normalizeCommand(redacted)
      /**
       * 修复已验证：同一命令此前有失败、这次成功。只做标记，不改任何记忆层级。
       * 比对用**脱敏后的命令**，避免把凭据差异当成不同命令。
       */
      const verifiedFix = input.ok === true && list.some(entry =>
        !entry.ok && entry.kind === kind && normalizeCommand(entry.command) === normalized)
      const entry: ProjectEvidenceRecord = {
        kind,
        command: redacted,
        ok: input.ok === true,
        at: input.at,
        verifiedFix,
        projectRoot: root,
      }
      list.unshift(entry)
      while (list.length > maxPerProject) list.pop()
      // 刷新 LRU：最近有证据的项目排到末尾（超出 maxProjects 时淘汰最久未更新的）
      projects.delete(key)
      projects.set(key, list)
      recorded += 1
      save(root, list)
    } catch {
      skipped += 1
    }
  }

  return {
    port: {
      record,
      snapshot(projectRoot) {
        const list = load(projectRoot)
        return list.map(({ kind, command, ok, at, verifiedFix }) => ({
          kind,
          command,
          ok,
          at,
          ...(verifiedFix === true ? { verifiedFix: true } : {}),
        }))
      },
      stats: () => ({ recorded, skipped, projects: projects.size, persistFailures }),
    },
    dispose: () => {
      projects.clear()
      loaded.clear()
    },
  }
}
