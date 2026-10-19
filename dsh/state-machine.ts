/**
 * 会话状态机（R10 核心版）：**对账**，不是替用户回滚。
 *
 * 设计规格：`docs/research/2026-10-18-state-machine.md`（最终版）
 * §3（宿主 `workspace-changes` 已在运行：520 事件 / 27 会话）、
 * §5（epoch：**优先宿主 tree id，零 subprocess**；L1 git 仅回退）、
 * §6（4 主状态 + 3 标记、持久化、守卫）、§9（≤120 字符状态行）、§12（验收）。
 *
 * ## 它回答什么
 *
 * 一次连续的认知需要四元组：**世界身份**（workspace epoch）、**我信过什么**
 * （read stamps / writeIntent）、**增量**（外部改动）、**时间**（lastEventAt + gap）。
 * 记忆库解决"跨会话知道什么"，本服务解决"这次是否还成立"——两者不互相替代。
 *
 * ## 数据源优先级（R10 §5.1，本文件的核心取舍）
 *
 * 1. **宿主事件 `workspace/changes` + `workspaceChanges.summary()`**（零 subprocess）：
 *    每个顶层回合结束时宿主公告一次；`summary.snapshot.before/after` 是一对
 *    git tree id（`workspace-changes/src/types.ts:38-40`），直接做 epoch 与 delta。
 *    局限（实测）：只在 turn 结束公告、只覆盖根会话、shell 副作用不可见。
 * 2. **自算 git**：仅当该会话从未见过宿主事件时才用；`git rev-parse HEAD` +
 *    `git status --porcelain=v2 -z`，按 `epochRefreshMs` 节流，2.5s 超时即降级。
 * 3. 都不可用 → `degraded`，状态行写"数据不确定"，绝不把"没测到"显示成 0。
 *
 * ## 契约（硬约束，测试逐条钉住）
 *
 * 1. **绝不抛异常**：任何失败只记 warn，返回安全值。
 * 2. **绝不阻塞/回滚**：不自动读文件、不恢复文件；守卫只按 R10 §6.5 的逃生门拒 edit。
 * 3. **只在真变化时产出一行**：`[OMB] <epoch> <事实…>` ≤120 字符；同摘要冷却
 *    `suppressTurns`；未变化时 `consumeNotice` 返回 null。
 * 4. **不注册 timer/watcher**：epoch 只在 `turn/start`/`turn/end` 刷新；gap 惰性计算。
 * 5. **有界**：会话 LRU 128、stamp 各 64、writeIntent 128、goal 8、持久化会话文件 100。
 * 6. **热路径零 LLM**：只消费宿主已提交事件，不做语义判断。
 *
 * ## 本轮明确未做（不假装已实现）
 *
 * - 文件符号级 repo-map、三方合并/补丁生成、shell 写文件追踪、子代理写集并入：
 *   不在本文件范围（v4.1 §8）。
 * - `writeIntent` 只归因到文件工具路径；shell 的写副作用仍是盲区。
 *
 * ## v4.1 资源级写守卫（`docs/v4.1-spacetime.md` §3.3/§4）
 *
 * 自 v4.1 起，守卫不再用"全局 epoch 变了"推断"读后被改"：
 * 每条读取印记带**内容哈希**（sha256 前 16，≤2MB），`guardEdit` 对 edit+write
 * 统一按 §4 判定表比对**当前文件哈希**。epoch 仍用于状态行/外部改动读数，
 * 但不再参与 deny。`wireEditGuard` 同时注册 `tools/post-execute`：成功写入后
 * 刷新印记哈希（自己的写不误伤自己），并把路径登记进 `writeIntent`（按回合清空）。
 * `situation()` 提供 L2/L3 结构化事实（只读、同步、≤16 条读取印记）。
 *
 * ## 接线
 *
 * `dsh/plugin.ts` 创建并 `provide('omb:session-state')`；`dsh/session.ts` 把原始
 * 宿主会话事件转交 `observe()`；通知行的唯一消费者是运行时上下文（尾部快照）。
 * 守卫由 `wireEditGuard()` 注册在 `tools/pre-execute` + `tools/post-execute`。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Clock, Logger } from '../kernel/abi/index.js'

/** 服务名。Lead 会在 `kernel/abi/catalog.ts` 加 `SERVICES.sessionState`；此前本常量是唯一真源。 */
export const SESSION_STATE_SERVICE = 'omb:session-state'

/** 空闲分级阈值（R10 §2.1：p50 4.2min、p90 36min、>1h 77 次、>24h 29 次）。 */
export const IDLE_AFTER_MS = 5 * 60 * 1000
export const STALE_AFTER_MS = 60 * 60 * 1000
export const DEEP_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** 同一 cwd 的 git epoch 缓存；自算回退时用。 */
export const EPOCH_TTL_MS = 2_000
/** 自算 git 的最低刷新间隔（宿主事件优先，因此这只在回退路径生效）。 */
export const EPOCH_REFRESH_MS = 30_000
/** 通知行硬上限（R10 §9.1）。 */
export const NOTICE_MAX_CHARS = 120
/** 同摘要至少隔多少回合才允许再次产出。 */
export const NOTICE_SUPPRESS_TURNS = 2
/** 有界性（R10 §6.4）。 */
export const MAX_SESSIONS = 128
export const MAX_STAMPS = 64
export const MAX_WRITE_INTENT = 128
export const MAX_GOALS = 8
export const MAX_EPOCH_CACHE = 16
export const MAX_SESSION_FILES = 100
/** 单文件上限 64KB（R10 §6.4）。 */
export const MAX_STATE_FILE_BYTES = 64 * 1024
/** "读取后太久才写"的判据（R10 §2.1：>20 step）。 */
export const STALE_WRITE_STEPS = 20
/** 同路径每回合最多 deny 次数；第 3 次放行（R10 §6.5 逃生门）。 */
export const MAX_DENIES_PER_PATH_PER_TURN = 2
/** 读取印记内容哈希的单文件上限（v4.1 §4）。 */
export const HASH_MAX_BYTES = 2 * 1024 * 1024
/** `situation()` 读取印记明细上限（v4.1 §3.3）。 */
export const MAX_SITUATION_ENTRIES = 16
/** 指令文件（`AGENTS.md`/`CLAUDE.md`）指纹的读取上限。 */
export const INSTRUCTION_MAX_BYTES = 256 * 1024
/** 每会话记录 shell 写路径的上限（有界；超出淘汰最旧）。 */
export const MAX_SHELL_WRITES = 32
/** 跨会话最近写路径表上限。 */
export const MAX_RECENT_WRITES = 256

const SCHEMA_VERSION = 1
const DEFAULT_READ_TOOLS: readonly string[] = ['read', 'read_file']
const DEFAULT_WRITE_TOOLS: readonly string[] = ['edit', 'write', 'edit_file', 'write_file', 'multi_edit']
/** shell 工具：v4.2 起从命令参数里**尽力**提取写路径（提取不到就记"未知写"）。 */
const DEFAULT_SHELL_TOOLS: readonly string[] = ['pwsh', 'powershell', 'bash', 'shell', 'terminal', 'cmd']
/** 指令文件：指纹进入 epoch，变化时在状态行提示"指令已变"。 */
const DEFAULT_INSTRUCTION_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md']
const CLOSED_PHASES: readonly string[] = ['complete', 'completed', 'done', 'closed', 'cancelled', 'canceled']
const INTERRUPT_REASONS: readonly string[] = ['aborted', 'error', 'interrupted', 'max-tokens', 'cancelled', 'canceled']

/** R10 §6.1：4 主状态。 */
export type SessionState = 'active' | 'idle' | 'stale' | 'recovering'
/** 空闲分级（时间维度）。 */
export type IdleTier = 'fresh' | 'idle' | 'stale' | 'deep-stale'
/** R10 §6.1：3 个可与主状态共存的标记。 */
export interface SessionFlags {
  /** git/宿主 tree id 都不可用，或守卫/持久化自身失败。 */
  readonly degraded: boolean
  /** 上次 `turn/end.reason` ∈ {aborted,error,interrupted,max-tokens}。 */
  readonly interrupted: boolean
  /** 存在未闭合目标（goal/todo）。 */
  readonly unresolved: boolean
}

/** 工作区身份。`source` 说明它是宿主 tree id 还是自算 git。 */
export interface WorkspaceEpoch {
  readonly id: string
  readonly head: string | null
  readonly branch: string | null
  readonly dirtyCount: number
  readonly digest: string | null
  readonly changedPaths: readonly string[]
  readonly at: number
  readonly degraded: boolean
  readonly reason: string | null
  readonly source: 'host' | 'git' | 'none'
  /** 宿主 tree id（`workspace/changes` 的 turn 起始/结束快照）。 */
  readonly treeBefore: string | null
  readonly treeAfter: string | null
  /**
   * 指令文件指纹（`AGENTS.md`/`CLAUDE.md` 的 sha256 前 12；v4.2）。
   * `null` = 没有指令文件/读不到。它**不参与** `id`（宿主 tree id 形状不变），
   * 只用于 `turn/start` 时判断"规则文件是否被改过"。
   */
  readonly instructions: string | null
}

/** 一条读取印记。`hash` 是读取当时的内容指纹（sha256 前 16）；守卫据此判断"读后被改"。 */
export interface ReadStamp {
  /** 调用方给的归一化路径（展示用）。 */
  readonly path: string
  /** 绝对路径（哈希与守卫使用）；cwd 未知且路径非绝对时退化为归一化路径。 */
  readonly absPath: string
  readonly at: number
  readonly step: number
  readonly epochId: string
  readonly via: 'fs'
  /** sha256 前 16；null = 目录/超限/读失败（`unknown`，不是"未变化"）。 */
  readonly hash: string | null
  readonly size: number | null
}

/** 内容哈希端口（测试注入，不造真实文件）。返回 null = 目录/超限/读失败。 */
export interface ContentHashResult {
  readonly hash: string
  readonly size: number
}
export type ContentHashPort = (absPath: string) => ContentHashResult | null

/** v4.1 §3.3：`situation()` 的结构化事实（L2 空间 + L3 时间；只读）。 */
export interface SessionSituation {
  readonly sessionId: string
  readonly cwd: string | null
  readonly state: SessionState
  readonly tier: IdleTier
  readonly turn: number
  readonly step: number
  readonly lastEventAt: number | null
  readonly idleMs: number | null
  readonly lastTurnEndReason: string | null
  readonly interrupted: boolean
  readonly unresolved: boolean
  readonly goals: { readonly open: number; readonly total: number }
  readonly todos: { readonly open: number; readonly total: number }
  readonly epoch: SessionStateSnapshot['epoch']
  readonly reads: {
    readonly count: number
    readonly changed: number
    readonly unknown: number
    /** 按 path 排序，最多 16 条（changed/unknown 计数只针对这批，全量哈希成本不可控）。 */
    readonly entries: readonly {
      readonly path: string
      readonly status: 'same' | 'changed' | 'unknown'
      readonly hash: string | null
    }[]
  }
  readonly sideEffects: {
    readonly blindWrites: number
    readonly staleWrites: number
    readonly denies: number
    readonly gaveUps: number
    readonly unverifiable: number
    /** v4.2：提取到路径的 shell 写次数（会话内累计）。 */
    readonly shellWrites: number
    /** v4.2：可能写文件但提取不到路径的 shell 次数（显式未知）。 */
    readonly shellUnknown: number
    /** v4.4：由 git status 差分推断出的 shell 写次数（近似归因）。 */
    readonly shellInferred: number
    /** v4.2：其他会话写过的、本会话读过且写时间晚于读取的路径数（子代理/并发会话）。 */
    readonly otherSessionWrites: number
  }
}

/** 一条写入印记（只用于归因与陈旧判定，不用于拦截）。 */
export interface WriteStamp {
  readonly path: string
  readonly at: number
  readonly step: number
  readonly tool: string
}

/** `consumeNotice` 的消费方（状态行注入）读取的事实。 */
export interface SessionStateSnapshot {
  readonly sessionId: string
  readonly state: SessionState
  readonly tier: IdleTier
  readonly flags: SessionFlags
  readonly lastEventAt: number | null
  readonly idleMs: number | null
  readonly turn: number
  readonly step: number
  readonly lastTurnEndReason: string | null
  readonly interruptedAtTurn: number | null
  readonly epoch: {
    readonly id: string
    readonly head: string | null
    readonly branch: string | null
    readonly dirtyCount: number
    readonly digest: string | null
    readonly at: number
    readonly degraded: boolean
    readonly source: 'host' | 'git' | 'none'
    readonly treeBefore: string | null
    readonly treeAfter: string | null
    /** 尚未报告的外部改动数（v4.1 L2 用；通知消费后会归零，不是历史累计）。 */
    readonly externalChanges?: number
    /** 指令文件指纹（v4.2）；null = 没有/读不到。 */
    readonly instructions?: string | null
  } | null
  readonly openGoals: number
  readonly openTodos: number
  readonly readStamps: number
  readonly writeIntent: number
  readonly blindWrites: number
  readonly staleWrites: number
  readonly guard: {
    readonly denies: number
    readonly gaveUps: number
    readonly writeWarnings: number
    /** 无法核验（无哈希/当前读不到/超限）的放行次数（v4.1 §4）。 */
    readonly unverifiable: number
  }
  readonly persistence: {
    readonly enabled: boolean
    readonly lastWriteAt: number | null
    readonly error: string | null
  }
  readonly pendingNotice: string | null
}

/** `observe()` 接受的事件：`dsh/session.ts` 原样转交宿主会话事件。 */
export interface SessionStateEvent {
  readonly sessionId: string
  /** 宿主事件类型：`turn/start` / `turn/end` / `step/start` / `step/end` / `tool/call` / `tool/result` /
   * `workspace/changes` / `goal/change` / `todo/write` / `user/message`… */
  readonly type: string
  readonly data?: unknown
  /** 会话事件序号（`workspaceChanges.summary(sessionId, seq)` 需要）。 */
  readonly seq?: number
  /** 观测时刻；缺省用注入时钟（测试传假时钟）。 */
  readonly at?: number
}

/** 宿主 `workspaceChanges` 服务的最小结构面（`dsh/` 从宿主 ctx 取）。 */
export interface WorkspaceChangesLike {
  summary(sessionId: string, seq: number): WorkspaceChangesSummaryLike | undefined
}

export interface WorkspaceChangesSummaryLike {
  readonly turn: number
  readonly cwd: string
  readonly files: readonly { readonly path: string; readonly display: string }[]
  readonly total: number
  readonly snapshot?: { readonly before: string; readonly after: string }
}

/** 服务面（`omb:session-state`）。模块只能经内核服务表拿它，不 import 本文件。 */
export interface SessionStateService {
  /** 喂一个宿主事件。绝不抛；未知类型只更新 lastEventAt。 */
  observe(event: SessionStateEvent): void
  /** 该会话的事实快照；未知会话返回 undefined（不是空对象）。 */
  snapshot(sessionId: string): SessionStateSnapshot | undefined
  /** 取走待注入状态行（取走即清空）；无新事实返回 null。 */
  consumeNotice(sessionId: string): string | null
  /** 当前 cwd 的工作区身份；都不可用时返回 degraded 对象，绝不抛。 */
  workspaceEpoch(cwd: string): WorkspaceEpoch
  /** 距该会话最后一次观测的毫秒数；未知会话返回 undefined。 */
  idleMs(sessionId: string): number | undefined
  /** 该会话的读取印记（按 path 稳定排序的副本）。 */
  readStamps(sessionId: string): readonly ReadStamp[]
  /** v4.1 §3.3：结构化 situation；只读、同步、绝不抛；未知会话返回 undefined。 */
  situation(sessionId: string): SessionSituation | undefined
}

/** 守卫判定（R10 §6.5）：`warn` = 放行但记账。 */
export interface EditGuardDecision {
  readonly kind: 'allow' | 'warn' | 'deny'
  /** deny 的模型可见原因（≤120 字符，事实句，不含命令式散文）。 */
  readonly reason: string | null
}

export interface GitResult {
  readonly ok: boolean
  readonly stdout: string
  readonly error?: string
}
export type GitRunner = (cwd: string, args: readonly string[]) => GitResult

/** 持久化文件系统端口（测试注入内存实现；生产用 node:fs 包装）。 */
export interface StateFs {
  readFileSync(file: string, encoding: 'utf8'): string
  writeFileSync(file: string, data: string): void
  renameSync(from: string, to: string): void
  mkdirSync(dir: string, options: { recursive: true }): void
  existsSync(path: string): boolean
  readdirSync(dir: string): string[]
  statSync(file: string): { readonly mtimeMs: number }
  unlinkSync(file: string): void
}

export interface SessionStateConfig {
  readonly idleAfterMs: number
  readonly staleAfterMs: number
  readonly deepStaleAfterMs: number
  readonly epochTtlMs: number
  readonly epochRefreshMs: number
  readonly noticeMaxChars: number
  readonly suppressTurns: number
  readonly maxSessions: number
  readonly maxStamps: number
  readonly staleWriteSteps: number
  readonly maxDeniesPerPathPerTurn: number
  readonly readTools: readonly string[]
  readonly writeTools: readonly string[]
  /** shell 工具名（v4.2：从命令里提取写路径；提取不到记 `shellUnknown`）。 */
  readonly shellTools: readonly string[]
  /** 指令文件（相对 cwd）；指纹变化时状态行提示"指令已变"。 */
  readonly instructionFiles: readonly string[]
  /**
   * 缺读取印记且目标已存在时的策略（v4.2）：
   * - `allow`（默认）：放行 + `blindWrites`（读可能发生在 shell 里，硬拦会误伤）；
   * - `deny`：拒绝一次，计 `denies`，逃生门仍生效（同路径同回合第 3 次放行）。
   */
  readonly blindWritePolicy: 'allow' | 'deny'
  /**
   * v4.4：shell 命令提取不到写路径（`unknown`）时，用命令前后 `git status` 差分
   * **推断**写集。默认开启；代价是每次未知写 shell 调两次 git（仅此类命令）。
   */
  readonly shellInferUnknown: boolean
  /** 是否落盘（R10 §6.4）；默认开启，测试可关。 */
  readonly persist: boolean
  /** 落盘节流：回合边界每几十秒一次，避免每步写文件。 */
  readonly persistMinIntervalMs: number
}

export const DEFAULT_SESSION_STATE_CONFIG: SessionStateConfig = {
  idleAfterMs: IDLE_AFTER_MS,
  staleAfterMs: STALE_AFTER_MS,
  deepStaleAfterMs: DEEP_STALE_AFTER_MS,
  epochTtlMs: EPOCH_TTL_MS,
  epochRefreshMs: EPOCH_REFRESH_MS,
  noticeMaxChars: NOTICE_MAX_CHARS,
  suppressTurns: NOTICE_SUPPRESS_TURNS,
  maxSessions: MAX_SESSIONS,
  maxStamps: MAX_STAMPS,
  staleWriteSteps: STALE_WRITE_STEPS,
  maxDeniesPerPathPerTurn: MAX_DENIES_PER_PATH_PER_TURN,
  readTools: DEFAULT_READ_TOOLS,
  writeTools: DEFAULT_WRITE_TOOLS,
  shellTools: DEFAULT_SHELL_TOOLS,
  instructionFiles: DEFAULT_INSTRUCTION_FILES,
  blindWritePolicy: 'allow',
  shellInferUnknown: true,
  persist: true,
  persistMinIntervalMs: 30_000,
}

export interface SessionStateOptions {
  readonly clock: Clock
  readonly logger?: Logger
  /** git 执行器（仅自算回退用）；缺省 `execFileSync`，2.5s 超时。测试注入假实现。 */
  readonly git?: GitRunner
  /** 宿主 `workspaceChanges` 服务；惰性读取（宿主服务可能晚于插件就绪）。 */
  readonly workspaceChanges?: () => WorkspaceChangesLike | undefined
  /** 会话 → cwd；缺省没有（epoch 恒为"无git"降级）。 */
  readonly cwdOf?: (sessionId: string) => string | undefined
  /** 状态目录（`<cwd>/.omb/state`）；缺省由 cwd 推导。返回 undefined = 不持久化。 */
  readonly stateDirOf?: (cwd: string) => string | undefined
  /** 持久化 fs；缺省 node:fs。 */
  readonly fs?: StateFs
  /** 内容哈希端口；缺省读真实文件（sha256 前 16，≤2MB）。测试注入避免造文件。 */
  readonly contentHash?: ContentHashPort
  /** 目标是否存在（无印记时区分"新建"与"盲写"）；缺省 node:fs.existsSync。 */
  readonly fileExists?: (absPath: string) => boolean
  /**
   * 指令文件指纹（v4.2）；缺省读 cwd 下 `instructionFiles` 并 sha256 前 12。
   * 测试注入以避免造真实文件。
   */
  readonly instructionDigest?: (cwd: string) => string | null
  /** v4.4：读取文件正文（冲突包用；默认读真实文件，单文件 ≤64KB）。 */
  readonly contentOf?: (absPath: string) => string | null
  /**
   * v4.4：写冲突材料（默认写 `<cwd>/.omb/conflicts/*.md` 并返回相对路径）。
   * 测试可注入以避免落盘。
   */
  readonly writeConflict?: (input: {
    readonly cwd: string
    readonly path: string
    readonly reason: string
    readonly base: string | null
    readonly current: string | null
  }) => string | undefined
  readonly config?: Partial<SessionStateConfig>
}

interface GoalEntry {
  readonly id: string
  readonly text: string
  readonly closed: boolean
}

interface SessionRecord {
  lastEventAt: number | null
  lastBoundaryAt: number | null
  turn: number
  step: number
  state: SessionState
  tier: IdleTier
  degraded: boolean
  interrupted: boolean
  interruptedAtTurn: number | null
  lastTurnEndReason: string | null
  epoch: WorkspaceEpoch | null
  epochAt: number
  hostTreeSeen: boolean
  /** 是否见过宿主 `turn/start`。见过之后 `step/start` 不再充当回合边界（否则守卫
   *  每步清零 deny 计数、回合号虚增——R10 §6.3 的回合预算会被打穿）。 */
  turnStartSeen: boolean
  treeAfter: string | null
  readStamps: Map<string, ReadStamp>
  writeStamps: Map<string, WriteStamp>
  writeIntent: Set<string>
  goals: Map<string, GoalEntry>
  todos: Map<string, string>
  blindWrites: number
  staleWrites: number
  unverifiable: number
  /** v4.2：从 shell 命令里提取到的写路径 → 发生时刻（有界 `MAX_SHELL_WRITES`）。 */
  shellWrites: Map<string, number>
  /** v4.2：本回合 shell 写路径（等 post-execute 成功后才并入 `writeIntent`）。 */
  shellIntentPending: Set<string>
  /** v4.2：可能写但提取不到路径的 shell 次数（"未知写"，不是 0）。 */
  shellUnknown: number
  /** 尚未进通知的 shell 写次数。 */
  unreportedShell: number
  /** 尚未进通知的 shell 未知写次数。 */
  unreportedShellUnknown: number
  /** v4.4：未知写 shell 调用前的脏文件基线（完成后与再次 status 差分）。 */
  shellBaseline: Set<string> | null
  /** v4.4：由 git status 差分推断出的 shell 写次数（近似归因）。 */
  shellInferred: number
  /** 尚未进通知的推断写次数。 */
  unreportedShellInferred: number
  /** 上次看到的指令文件指纹（v4.2；`null` = 尚无）。 */
  instructions: string | null
  /** 指令文件在两次回合之间变化（待通知）。 */
  unreportedInstructions: boolean
  /** v4.4：读取时保存的正文（冲突包 base；每会话最多 4 条 × 64KB）。 */
  readBases: Map<string, string>
  denyCounts: Map<string, number>
  denies: number
  gaveUps: number
  writeWarnings: number
  pendingNotice: string | null
  lastNoticeDigest: string | null
  lastNoticeTurn: number
  unreportedExternal: number
  lastTurnEndTurn: number | null
  persistence: { lastWriteAt: number | null; error: string | null }
  loaded: boolean
}

export interface SessionStateMachine {
  readonly port: SessionStateService
  /** v4.1 §4：edit+write 统一判定（内容哈希，不是全局 epoch）。 */
  guardEdit(sessionId: string, toolName: string, path: string): EditGuardDecision
  /** v4.1 §4：`tools/post-execute` 成功（isError===false）后刷新印记哈希 + 记 writeIntent。 */
  noteWriteResult(sessionId: string, toolName: string, path: string, ok: boolean): void
  /** v4.2：shell 工具 post-execute（成功时把提取到的 shell 写路径并入 writeIntent）。 */
  noteShellResult(sessionId: string, toolName: string, ok: boolean): void
  dispose(): void
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function sha256Short(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

/** 路径归一化：只统一分隔符与 `./` 前缀，不做 fs 解析。 */
export function normalizePath(raw: unknown): string | undefined {
  const text = nonEmpty(raw)
  if (text === undefined) return undefined
  return text.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/**
 * 把调用方路径解析成绝对路径（v4.1 §4：`resolve(cwd, path)`）。
 *
 * cwd 未知且路径不是绝对路径时返回 undefined——**不猜宿主进程 cwd**；
 * 此时读取印记的 hash 为 null（unverifiable），守卫因此不会误 deny。
 * Windows 大小写按实际路径比较，不做额外小写。
 */
export function absPathOf(cwd: string | null | undefined, path: string): string | undefined {
  const normalized = normalizePath(path)
  if (normalized === undefined) return undefined
  const base = nonEmpty(cwd)
  if (base !== undefined) {
    try {
      return resolve(base, normalized)
    } catch {
      return undefined
    }
  }
  return isAbsolute(normalized) ? normalized : undefined
}

/** 从工具参数里取路径：只认明确字段，不做猜测性解析。 */
export function pathOfArguments(data: unknown): string | undefined {
  const record = asRecord(data)
  if (record === undefined) return undefined
  let args: unknown = record['arguments']
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return undefined
    }
  }
  const argsRecord = asRecord(args)
  if (argsRecord === undefined) return undefined
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'file']) {
    const path = normalizePath(argsRecord[key])
    if (path !== undefined) return path
  }
  return undefined
}

/** 从 shell 工具参数里取命令串（`command`/`cmd`/`script`；参数可能是未解析 JSON）。 */
export function shellCommandOf(data: unknown): string {
  const record = asRecord(data)
  if (record === undefined) return ''
  const raw = record['arguments']
  let args: unknown = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (typeof args === 'string') return args
  const argsRecord = asRecord(args)
  if (argsRecord === undefined) return ''
  for (const key of ['command', 'cmd', 'script', 'input', 'code']) {
    const value = argsRecord[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return ''
}

/** 从 `git status --porcelain=v2 -z` 输出解析路径清单。解析失败返回空，不猜。 */
export function parsePorcelainV2Paths(stdout: string): readonly string[] {
  const tokens = stdout.split('\u0000')
  const paths: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token.length === 0) continue
    const kind = token[0]
    if (kind === '1') {
      const fields = token.split(' ')
      const path = normalizePath(fields.slice(8).join(' '))
      if (path !== undefined) paths.push(path)
    } else if (kind === '2') {
      const fields = token.split(' ')
      const path = normalizePath(fields.slice(9).join(' '))
      if (path !== undefined) paths.push(path)
      index += 1
    } else if (kind === 'u') {
      const fields = token.split(' ')
      const path = normalizePath(fields.slice(10).join(' '))
      if (path !== undefined) paths.push(path)
    } else if (kind === '?' || kind === '!') {
      const path = normalizePath(token.slice(2))
      if (path !== undefined) paths.push(path)
    }
  }
  return paths
}

function emptyEpoch(at: number, reason: string): WorkspaceEpoch {
  return {
    id: 'e00000000',
    head: null,
    branch: null,
    dirtyCount: 0,
    digest: null,
    changedPaths: [],
    at,
    degraded: true,
    reason,
    source: 'none',
    treeBefore: null,
    treeAfter: null,
    instructions: null,
  }
}

const defaultGit: GitRunner = (cwd, args) => {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2_500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, stdout: '', error: error instanceof Error ? error.message : String(error) }
  }
}

const defaultFs: StateFs = {
  readFileSync: (file, encoding) => readFileSync(file, encoding),
  writeFileSync: (file, data) => writeFileSync(file, data, { encoding: 'utf8' }),
  renameSync: (from, to) => renameSync(from, to),
  mkdirSync: (dir, options) => mkdirSync(dir, options),
  existsSync: path => existsSync(path),
  readdirSync: dir => readdirSync(dir),
  statSync: file => ({ mtimeMs: statSync(file).mtimeMs }),
  unlinkSync: file => unlinkSync(file),
}

/** 缺省内容哈希：真实文件、sha256 前 16、≤2MB；目录/超限/读失败 → null。 */
const defaultContentHash: ContentHashPort = absPath => {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > HASH_MAX_BYTES) return null
    const data = readFileSync(absPath)
    return { hash: createHash('sha256').update(data).digest('hex').slice(0, 16), size: stat.size }
  } catch {
    return null
  }
}

const defaultFileExists = (absPath: string): boolean => {
  try {
    return existsSync(absPath)
  } catch {
    return false
  }
}

/** v4.4：冲突包读取的正文上限（只给可核验材料，不复制整个大文件）。 */
const CONFLICT_TEXT_MAX_BYTES = 64 * 1024
/** 冲突材料保留上限。 */
const CONFLICT_FILE_MAX = 20

const defaultContentOf = (absPath: string): string | null => {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > CONFLICT_TEXT_MAX_BYTES) return null
    return readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
}

/** v4.4：写冲突材料（base/current 两段原文 + 事实说明；不自动合并）。 */
const defaultWriteConflict = (input: {
  readonly cwd: string
  readonly path: string
  readonly reason: string
  readonly base: string | null
  readonly current: string | null
}): string | undefined => {
  try {
    const dir = join(input.cwd, '.omb', 'conflicts')
    mkdirSync(dir, { recursive: true })
    const name = `${Date.now()}-${sha256Short(input.path, 8)}.md`
    const fence = (label: string, text: string | null): string =>
      text === null ? `## ${label}\n（未保存/不可读：无法给出 base 文本）\n` : `## ${label}\n\`\`\`text\n${text}\n\`\`\`\n`
    const content = [
      '# OMB 编辑冲突材料',
      '',
      `- 文件：${input.path}`,
      `- 原因：${input.reason}`,
      `- 生成：${new Date().toISOString()}`,
      '',
      fence('读取时（base）', input.base),
      fence('当前（current）', input.current),
      '这是**事实材料，不是自动合并结果**：OMB 没有覆盖文件，也没有生成补丁。',
      '处理：重新读取当前内容后决定编辑；如需三方合并，请用 git/编辑器手工裁决。',
      '',
    ].join('\n')
    writeFileSync(join(dir, name), content, 'utf8')
    // 有界：只保留最近 20 份
    try {
      const files = readdirSync(dir)
        .filter(file => file.endsWith('.md'))
        .map(file => ({ file, mtime: statSync(join(dir, file)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const old of files.slice(CONFLICT_FILE_MAX)) {
        try {
          unlinkSync(join(dir, old.file))
        } catch {
          // 清理失败不影响本次材料
        }
      }
    } catch {
      // 同上
    }
    return `.omb/conflicts/${name}`
  } catch {
    return undefined
  }
}

/**
 * 缺省指令文件指纹：读 cwd 下 `instructionFiles`，对"文件名 + 内容"做 sha256 前 12。
 * 单文件 ≤256KB；不存在/超限/读失败跳过；一个都读不到 → null（"没有指令文件"，不是空串）。
 */
function defaultInstructionDigest(files: readonly string[]): (cwd: string) => string | null {
  return cwd => {
    try {
      const parts: string[] = []
      for (const name of files) {
        try {
          const file = join(cwd, name)
          const stat = statSync(file)
          if (!stat.isFile() || stat.size > INSTRUCTION_MAX_BYTES) continue
          const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
          parts.push(`${name}:${hash}`)
        } catch {
          // 单个文件缺失/不可读：继续
        }
      }
      return parts.length === 0 ? null : sha256Short(parts.join('|'), 12)
    } catch {
      return null
    }
  }
}

/** shell 命令里"看起来会写文件"的模式（用于判断"提取不到路径的未知写"）。 */
const SHELL_MUTATION_PATTERN =
  /(?:\b(?:git\s+(?:apply|checkout|restore|clean)|(?:pnpm|npm|yarn)\s+(?:install|add|remove|up)|make|cmake|cargo\s+build|python\s+setup|sed\s+-i|tee|rm|del|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Content|Add-Content|Out-File|New-Item|truncate|chmod|chown)\b|>>?)/i

export interface ShellWriteExtraction {
  /** 从命令里提取到的写路径（原样字符串，未 resolve；去重、稳定排序）。 */
  readonly paths: readonly string[]
  /** 命令像写操作但没提取到任何明确路径（显式"未知写"）。 */
  readonly unknown: boolean
}

function cleanShellPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  let value = raw.trim()
  if (value.length === 0) return undefined
  value = value.replace(/^["']|["']$/g, '')
  value = value.replace(/[;,)]+$/, '')
  value = value.replace(/^\.\//, '')
  if (value.length === 0) return undefined
  if (/^(?:-|\d+>|&|\||;)/.test(value)) return undefined
  if (/^(?:\/dev\/null|NUL|\$null|nul)$/i.test(value)) return undefined
  if (/^[a-z]+:\/\//i.test(value)) return undefined
  return value
}

/**
 * 从 shell 命令串里**尽力**提取写路径（v4.2，确定性正则，不执行命令）。
 *
 * 覆盖：重定向（`>`/`>>`）、PowerShell 路径参数（`-Path/-LiteralPath/-Destination/-FilePath`）、
 * 常见 cmdlet 的首个位置参数、`sed -i` 的最后一个参数、`git checkout/restore` 的路径。
 * 提取不到但命令带写特征 → `unknown: true`；调用方据此显式计"未知写"，**不猜**。
 */
export function extractShellWritePaths(command: string): ShellWriteExtraction {
  const text = typeof command === 'string' ? command : ''
  if (text.length === 0) return { paths: [], unknown: false }
  const found = new Set<string>()
  const push = (value: string | undefined): void => {
    const clean = cleanShellPath(value)
    if (clean !== undefined) found.add(clean)
  }
  // 重定向：`> file` / `>> file`（排除 fd 复制 `2>&1` 与 `>>>`）
  for (const match of text.matchAll(/(?:^|[^>\d])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    push(match[1])
  }
  // PowerShell 显式路径参数
  for (const match of text.matchAll(/-(?:Path|LiteralPath|Destination|FilePath)\s+("[^"]+"|'[^']+'|[^\s;)]+)/gi)) {
    push(match[1])
  }
  // 常见 cmdlet 的首个位置参数（值以 - 开头的开关跳过）
  for (const match of text.matchAll(/\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item)\s+(?:-Force\s+)?("[^"]+"|'[^']+'|[^\s;)-]+)/gi)) {
    push(match[1])
  }
  // sed -i 的最后一个参数
  for (const match of text.matchAll(/\bsed\s+-i[^\s]*\s+(?:[^;|]+\s+)?("[^"]+"|'[^']+'|[^\s;|)]+)\s*(?:$|[;|])/gim)) {
    push(match[1])
  }
  // git checkout -- path / git restore path
  for (const match of text.matchAll(/\bgit\s+(?:checkout|restore)\b[^;&|]*?(?:--\s+)?("[^"]+"|'[^']+'|[\w./\\-]+)\s*(?:$|[;&|])/gim)) {
    push(match[1])
  }
  const paths = [...found].sort()
  return { paths, unknown: paths.length === 0 && SHELL_MUTATION_PATTERN.test(text) }
}

function tierOf(gapMs: number | undefined, config: SessionStateConfig): IdleTier {
  if (gapMs === undefined) return 'fresh'
  if (gapMs >= config.deepStaleAfterMs) return 'deep-stale'
  if (gapMs >= config.staleAfterMs) return 'stale'
  if (gapMs >= config.idleAfterMs) return 'idle'
  return 'fresh'
}

/** `26h14m` / `7m` / `2d3h`：只给事实，不给指令。 */
export function formatGap(gapMs: number): string {
  const minutes = Math.max(1, Math.floor(gapMs / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d${restHours}h`
}

interface NoticeFacts {
  readonly gapMs: number | undefined
  readonly headFrom: string | null
  readonly headTo: string | null
  readonly branch: string | null
  readonly externalChanges: number
  /** v4.2：指令文件（AGENTS.md/CLAUDE.md）在两次回合之间变化。 */
  readonly instructionsChanged: boolean
  /** v4.2：本回合提取到路径的 shell 写次数。 */
  readonly shellWrites: number
  /** v4.2：可能写但提取不到路径的 shell 次数。 */
  readonly shellUnknown: number
  /** v4.4：由 git status 差分推断出的 shell 写次数（近似归因）。 */
  readonly shellInferred: number
  readonly interruptedAtTurn: number | null
  readonly openGoals: number
  readonly deepStale: boolean
  readonly degraded: boolean
}

/**
 * 渲染一行状态通知：字段顺序固定 → 同一事实 → 同一字节串（可去重、可测试）。
 * 超长时从尾部丢字段，绝不做半个字符的截断。
 */
export function renderNotice(epochLabel: string, facts: NoticeFacts, maxChars: number): string {
  const parts: string[] = []
  if (facts.gapMs !== undefined) parts.push(`距上次 ${formatGap(facts.gapMs)}`)
  if (facts.headFrom !== null && facts.headTo !== null) {
    parts.push(`HEAD ${facts.headFrom.slice(0, 7)}→${facts.headTo.slice(0, 7)}`)
  }
  if (facts.branch !== null) parts.push(`分支 ${facts.branch.slice(0, 24)}`)
  if (facts.externalChanges > 0) parts.push(`外部改动 ${facts.externalChanges}`)
  if (facts.instructionsChanged) parts.push('指令已变')
  if (facts.shellWrites > 0) parts.push(`shell 写 ${facts.shellWrites}`)
  if (facts.shellUnknown > 0) parts.push(`shell 未知写 ${facts.shellUnknown}`)
  if (facts.shellInferred > 0) parts.push(`shell 推断写 ${facts.shellInferred}`)
  if (facts.interruptedAtTurn !== null) parts.push(`上次回合中断@${facts.interruptedAtTurn}`)
  if (facts.openGoals > 0) parts.push(`未闭合目标 ${facts.openGoals}`)
  if (facts.deepStale) parts.push('结论可能过期')
  if (facts.degraded) parts.push('数据不确定')
  const prefix = `[OMB] ${epochLabel}`
  let line = parts.length === 0 ? prefix : `${prefix} ${parts.join(' · ')}`
  while (line.length > maxChars && parts.length > 0) {
    parts.pop()
    line = parts.length === 0 ? prefix : `${prefix} ${parts.join(' · ')}`
  }
  return line.length > maxChars ? line.slice(0, maxChars) : line
}

/**
 * 造一个状态机。返回 `port`（服务面）、`guardEdit`（工具守卫）与 `dispose()`。
 * 所有公开方法都被 try/catch 包住——状态机不得成为会话的单点故障。
 */
export function createSessionStateMachine(options: SessionStateOptions): SessionStateMachine {
  const clock = options.clock
  const config: SessionStateConfig = { ...DEFAULT_SESSION_STATE_CONFIG, ...options.config }
  const git = options.git ?? defaultGit
  const fs = options.fs ?? defaultFs
  const contentHash = options.contentHash ?? defaultContentHash
  const fileExists = options.fileExists ?? defaultFileExists
  const instructionDigest = options.instructionDigest ?? defaultInstructionDigest(config.instructionFiles)
  const contentOf = options.contentOf ?? defaultContentOf
  const writeConflict = options.writeConflict ?? defaultWriteConflict
  const sessions = new Map<string, SessionRecord>()
  const epochCache = new Map<string, { readonly epoch: WorkspaceEpoch; readonly at: number }>()
  /**
   * v4.2 跨会话写表：`<cwd>\0<absPath>` → 最近写入者与时刻。
   *
   * 子代理与并发会话写同一工作区时，内容哈希已经能拦住"读后被改"的编辑；
   * 这张表补的是**归因可见性**（谁写的、本会话读过的文件里有多少被其他会话改过），
   * 以及"hash 未知时"的保守拒绝依据。有界，绝不无限增长。
   */
  const recentWrites = new Map<string, { readonly sessionId: string; readonly at: number }>()
  let disposed = false

  const warn = (where: string, error: unknown): void => {
    try {
      options.logger?.warn(
        `OMB 状态机：${where} 失败（已隔离）——${error instanceof Error ? error.message : String(error)}`,
      )
    } catch {
      // 日志失败不得影响会话
    }
  }

  /**
   * 读当前内容哈希。返回 `{ok:false}` = 端口自己抛异常（守卫按"内部异常 allow"处理），
   * `{ok:true,value:null}` = 读不到/目录/超限（守卫按 unverifiable 处理）——两者不可混。
   */
  const readCurrentHash = (
    absPath: string,
  ): { readonly ok: true; readonly value: ContentHashResult | null } | { readonly ok: false } => {
    try {
      return { ok: true, value: contentHash(absPath) ?? null }
    } catch (error) {
      warn('contentHash', error)
      return { ok: false }
    }
  }

  /** 登记一次工作区写入（跨会话归因用）。 */
  const noteRecentWrite = (sessionId: string, absPath: string, at: number): void => {
    const key = `${safeCwd(sessionId) ?? ''}\u0000${absPath}`
    recentWrites.delete(key)
    recentWrites.set(key, { sessionId, at })
    while (recentWrites.size > MAX_RECENT_WRITES) {
      const oldest = recentWrites.keys().next().value
      if (oldest === undefined) break
      recentWrites.delete(oldest)
    }
  }

  const sessionFile = (sessionId: string): string | undefined => {
    if (!config.persist) return undefined
    const cwd = safeCwd(sessionId)
    if (cwd === undefined) return undefined
    const dir = options.stateDirOf?.(cwd) ?? join(cwd, '.omb', 'state')
    return join(dir, 'sessions', `${sha256Short(sessionId, 8)}.json`)
  }
  const workspaceFile = (cwd: string): string => {
    const dir = options.stateDirOf?.(cwd) ?? join(cwd, '.omb', 'state')
    return join(dir, 'workspace.json')
  }

  const safeCwd = (sessionId: string): string | undefined => {
    try {
      return nonEmpty(options.cwdOf?.(sessionId))
    } catch {
      return undefined
    }
  }

  /** 原子写；超 64KB 直接放弃（有界优先）。返回错误文本。 */
  const persistFile = (file: string, payload: unknown): string | null => {
    try {
      const text = JSON.stringify(payload)
      if (Buffer.byteLength(text, 'utf8') > MAX_STATE_FILE_BYTES) return '状态文件超过 64KB，已跳过写入'
      fs.mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, file)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const persistWorkspace = (cwd: string, epoch: WorkspaceEpoch, at: number): void => {
    persistFile(workspaceFile(cwd), {
      schema: SCHEMA_VERSION,
      cwd,
      epoch,
      at,
    })
  }

  const loadRecord = (sessionId: string, record: SessionRecord): void => {
    if (!config.persist) return
    const file = sessionFile(sessionId)
    if (file === undefined || !fs.existsSync(file)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      if (parsed['schema'] !== SCHEMA_VERSION) return
      if (typeof parsed['sessionId'] === 'string' && parsed['sessionId'] !== sessionId) return
      record.lastEventAt = finiteNumber(parsed['lastEventAt']) ?? record.lastEventAt
      record.turn = Math.max(record.turn, finiteNumber(parsed['turn']) ?? 0)
      record.step = Math.max(record.step, finiteNumber(parsed['step']) ?? 0)
      const epoch = asRecord(parsed['epoch'])
      if (epoch !== undefined && typeof epoch['id'] === 'string') {
        record.epoch = {
          id: epoch['id'],
          head: nonEmpty(epoch['head']) ?? null,
          branch: nonEmpty(epoch['branch']) ?? null,
          dirtyCount: finiteNumber(epoch['dirtyCount']) ?? 0,
          digest: nonEmpty(epoch['digest']) ?? null,
          changedPaths: [],
          at: finiteNumber(epoch['at']) ?? 0,
          degraded: epoch['degraded'] === true,
          reason: null,
          source: epoch['source'] === 'host' ? 'host' : 'git',
          treeBefore: nonEmpty(epoch['treeBefore']) ?? null,
          treeAfter: nonEmpty(epoch['treeAfter']) ?? null,
          instructions: nonEmpty(epoch['instructions']) ?? null,
        }
        record.instructions = record.epoch.instructions
        record.treeAfter = record.epoch.treeAfter
        record.hostTreeSeen = record.epoch.source === 'host'
      }
      const stamps = Array.isArray(parsed['readStamps']) ? parsed['readStamps'] : []
      for (const item of stamps.slice(0, config.maxStamps)) {
        const stamp = asRecord(item)
        const path = normalizePath(stamp?.['path'])
        if (stamp === undefined || path === undefined) continue
        record.readStamps.set(path, {
          path,
          absPath: nonEmpty(stamp['absPath']) ?? path,
          at: finiteNumber(stamp['at']) ?? 0,
          step: finiteNumber(stamp['step']) ?? 0,
          epochId: nonEmpty(stamp['epochId']) ?? '',
          via: 'fs',
          hash: nonEmpty(stamp['hash']) ?? null,
          size: finiteNumber(stamp['size']) ?? null,
        })
      }
      const goals = Array.isArray(parsed['goals']) ? parsed['goals'] : []
      for (const item of goals.slice(0, MAX_GOALS)) {
        const goal = asRecord(item)
        const id = nonEmpty(goal?.['id'])
        if (goal === undefined || id === undefined) continue
        record.goals.set(id, {
          id,
          text: typeof goal['text'] === 'string' ? goal['text'] : '',
          closed: goal['closed'] === true,
        })
      }
      const todos = asRecord(parsed['todos']) ?? {}
      for (const [id, status] of Object.entries(todos)) {
        if (typeof status === 'string') record.todos.set(id, status)
      }
      record.lastNoticeDigest = nonEmpty(parsed['lastNoticeDigest']) ?? null
      record.lastNoticeTurn = finiteNumber(parsed['lastNoticeTurn']) ?? 0
    } catch {
      // 损坏/版本不识别 → 从空状态开始（状态是派生数据，丢可重建）
    }
  }

  const persistSession = (sessionId: string, record: SessionRecord, at: number): void => {
    if (!config.persist) return
    const file = sessionFile(sessionId)
    if (file === undefined) return
    if (record.persistence.lastWriteAt !== null && at - record.persistence.lastWriteAt < config.persistMinIntervalMs) return
    const payload = {
      schema: SCHEMA_VERSION,
      sessionId,
      lastEventAt: record.lastEventAt,
      turn: record.turn,
      step: record.step,
      epoch: record.epoch,
      goals: [...record.goals.values()].slice(0, MAX_GOALS),
      todos: Object.fromEntries(record.todos),
      readStamps: [...record.readStamps.values()].slice(0, config.maxStamps),
      lastNoticeDigest: record.lastNoticeDigest,
      lastNoticeTurn: record.lastNoticeTurn,
    }
    const error = persistFile(file, payload)
    record.persistence.lastWriteAt = at
    record.persistence.error = error
    const cwd = safeCwd(sessionId)
    if (cwd !== undefined && record.epoch !== null) persistWorkspace(cwd, record.epoch, at)
    if (error === null) pruneSessionFiles(dirname(file))
  }

  const pruneSessionFiles = (dir: string): void => {
    try {
      if (!fs.existsSync(dir)) return
      const files = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
      if (files.length <= MAX_SESSION_FILES) return
      const aged = files
        .map(name => ({ name, at: fs.statSync(join(dir, name)).mtimeMs }))
        .sort((left, right) => left.at - right.at)
      for (const entry of aged.slice(0, files.length - MAX_SESSION_FILES)) {
        fs.unlinkSync(join(dir, entry.name))
      }
    } catch {
      // 清理失败不影响状态
    }
  }

  const workspaceEpoch = (cwd: string): WorkspaceEpoch => {
    const at = clock.now()
    try {
      const path = nonEmpty(cwd)
      if (path === undefined) return emptyEpoch(at, '没有 cwd（宿主未告知）')
      const cached = epochCache.get(path)
      if (cached !== undefined && at - cached.at < config.epochTtlMs) return cached.epoch
      const headResult = git(path, ['rev-parse', 'HEAD'])
      const branchResult = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const statusResult = git(path, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'])
      const head = headResult.ok ? nonEmpty(headResult.stdout.trim()) ?? null : null
      const branchRaw = branchResult.ok ? nonEmpty(branchResult.stdout.trim()) ?? null : null
      const branch = branchRaw === 'HEAD' ? null : branchRaw
      if (!headResult.ok && !statusResult.ok) {
        const epoch = emptyEpoch(at, `git 不可用：${headResult.error ?? statusResult.error ?? '未知原因'}`)
        epochCache.set(path, { epoch, at })
        return epoch
      }
      const statusText = statusResult.ok ? statusResult.stdout : ''
      const changedPaths = parsePorcelainV2Paths(statusText)
      const digest = statusResult.ok ? sha256Short(statusText) : null
      const epoch: WorkspaceEpoch = {
        id: `e${sha256Short(`${head ?? ''}|${branch ?? ''}|${digest ?? ''}`, 8)}`,
        head,
        branch,
        dirtyCount: changedPaths.length,
        digest,
        changedPaths,
        at,
        degraded: !headResult.ok || !statusResult.ok,
        reason: !headResult.ok
          ? `git 不可用：${headResult.error ?? 'rev-parse 失败'}`
          : !statusResult.ok
            ? `git status 不可用：${statusResult.error ?? '未知原因'}`
            : null,
        source: 'git',
        treeBefore: null,
        treeAfter: null,
        instructions: instructionDigest(path),
      }
      epochCache.set(path, { epoch, at })
      while (epochCache.size > MAX_EPOCH_CACHE) {
        const oldest = epochCache.keys().next().value
        if (oldest === undefined) break
        epochCache.delete(oldest)
      }
      return epoch
    } catch (error) {
      warn('workspaceEpoch', error)
      return emptyEpoch(at, 'epoch 采集异常')
    }
  }

  /** 宿主 tree id → epoch（零 subprocess）。summary 无 snapshot 时返回 null。 */
  const epochFromSummary = (
    summary: WorkspaceChangesSummaryLike,
    at: number,
    instructions: string | null,
  ): WorkspaceEpoch | null => {
    const snapshot = summary.snapshot
    if (snapshot === undefined) return null
    const before = nonEmpty(snapshot.before)
    const after = nonEmpty(snapshot.after)
    if (before === undefined || after === undefined) return null
    const changedPaths = summary.files
      .map(file => normalizePath(file.path))
      .filter((path): path is string => path !== undefined)
    return {
      id: `e${sha256Short(after, 8)}`,
      head: after,
      branch: null,
      dirtyCount: summary.total,
      digest: sha256Short(`${before}|${after}`),
      changedPaths,
      at,
      degraded: false,
      reason: null,
      source: 'host',
      treeBefore: before,
      treeAfter: after,
      instructions,
    }
  }

  const touch = (sessionId: string): void => {
    const record = sessions.get(sessionId)
    if (record === undefined) return
    sessions.delete(sessionId)
    sessions.set(sessionId, record)
  }

  const recordOf = (sessionId: string): SessionRecord => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      touch(sessionId)
      return existing
    }
    const created: SessionRecord = {
      lastEventAt: null,
      lastBoundaryAt: null,
      turn: 0,
      step: 0,
      state: 'idle',
      tier: 'fresh',
      degraded: false,
      interrupted: false,
      interruptedAtTurn: null,
      lastTurnEndReason: null,
      epoch: null,
      epochAt: 0,
      hostTreeSeen: false,
      turnStartSeen: false,
      treeAfter: null,
      readStamps: new Map(),
      readBases: new Map(),
      writeStamps: new Map(),
      writeIntent: new Set(),
      goals: new Map(),
      todos: new Map(),
      blindWrites: 0,
      staleWrites: 0,
      unverifiable: 0,
      shellWrites: new Map(),
      shellIntentPending: new Set(),
      shellUnknown: 0,
      unreportedShell: 0,
      unreportedShellUnknown: 0,
      shellBaseline: null,
      shellInferred: 0,
      unreportedShellInferred: 0,
      instructions: null,
      unreportedInstructions: false,
      denyCounts: new Map(),
      denies: 0,
      gaveUps: 0,
      writeWarnings: 0,
      pendingNotice: null,
      lastNoticeDigest: null,
      lastNoticeTurn: 0,
      unreportedExternal: 0,
      lastTurnEndTurn: null,
      persistence: { lastWriteAt: null, error: null },
      loaded: false,
    }
    loadRecord(sessionId, created)
    created.loaded = true
    sessions.set(sessionId, created)
    while (sessions.size > config.maxSessions) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
    return created
  }

  const putBounded = <T>(map: Map<string, T>, key: string, value: T, max: number): void => {
    map.delete(key)
    map.set(key, value)
    while (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  const openGoalCount = (record: SessionRecord): number =>
    [...record.goals.values()].filter(goal => !goal.closed).length

  const openTodoCount = (record: SessionRecord): number =>
    [...record.todos.values()].filter(status => status === 'pending' || status === 'in_progress').length

  const unresolved = (record: SessionRecord): boolean => openGoalCount(record) + openTodoCount(record) > 0

  /** 取宿主的回合 workspace 摘要；任何失败都安静降级。 */
  const summaryOf = (sessionId: string, seq: number | undefined): WorkspaceChangesSummaryLike | undefined => {
    if (seq === undefined) return undefined
    try {
      return options.workspaceChanges?.()?.summary(sessionId, seq)
    } catch (error) {
      warn('workspaceChanges.summary', error)
      return undefined
    }
  }

  /** 在 `turn/end` 后刷新 epoch：宿主摘要优先（若有事件），否则节流 git。 */
  const refreshEpoch = (sessionId: string, record: SessionRecord, at: number): void => {
    const cwd = safeCwd(sessionId)
    if (record.hostTreeSeen) return
    if (cwd === undefined || at - record.epochAt < config.epochRefreshMs) return
    record.epoch = workspaceEpoch(cwd)
    record.epochAt = at
    record.degraded = record.epoch.degraded
  }

  const applyWorkspaceSummary = (sessionId: string, record: SessionRecord, seq: number | undefined, at: number): void => {
    const summary = summaryOf(sessionId, seq)
    if (summary === undefined) return
    const cwd = safeCwd(sessionId)
    const instructions = cwd === undefined ? null : instructionDigest(cwd)
    const epoch = epochFromSummary(summary, at, instructions)
    if (epoch === null) return
    // v4.2：指令文件指纹变化单独作为"规则已变"事实（不混进外部改动数）。
    if (record.instructions !== null && instructions !== null && record.instructions !== instructions) {
      record.unreportedInstructions = true
    }
    if (instructions !== null) record.instructions = instructions
    const previousAfter = record.epoch?.source === 'host' ? record.epoch.treeAfter : record.treeAfter
    const before = epoch.treeBefore
    // 外部改动：上一回合结束的 tree ≠ 本回合开始的 tree（回合之间被改），
    // 或本回合改动文件里没有本会话 edit/write 意图（回合内被改）。
    const betweenTurns = previousAfter !== null && before !== null && previousAfter !== before ? 1 : 0
    const duringTurn = epoch.changedPaths.filter(path => !record.writeIntent.has(path)).length
    const external = betweenTurns + duringTurn
    if (external > 0) record.unreportedExternal = Math.max(record.unreportedExternal, external)
    record.epoch = epoch
    record.epochAt = at
    record.hostTreeSeen = true
    record.degraded = false
    record.treeAfter = epoch.treeAfter
    if (cwd !== undefined) persistWorkspace(cwd, epoch, at)
  }

  const boundary = (sessionId: string, record: SessionRecord, at: number, data: unknown): void => {
    const dataRecord = asRecord(data)
    const payloadTurn = finiteNumber(dataRecord?.['turn'])
    const gapMs = record.lastEventAt === null ? undefined : Math.max(0, at - record.lastEventAt)
    const tier = tierOf(gapMs, config)
    const stepValue = finiteNumber(dataRecord?.['step'])
    record.turn = payloadTurn === undefined ? record.turn + 1 : Math.max(record.turn + 1, Math.floor(payloadTurn))
    record.step = stepValue === undefined ? record.step + 1 : Math.max(record.step, Math.floor(stepValue))
    record.lastBoundaryAt = at
    record.denyCounts.clear()
    // v4.1 §4：writeIntent 按**回合**归因，turn/start 边界清空（上一回合写过什么不再算本回合）。
    record.writeIntent.clear()

    const before = record.epoch
    if (!record.hostTreeSeen) refreshEpoch(sessionId, record, at)
    const current = record.epoch
    // v4.2：指令文件指纹变化（首次见到只记录，不报"变了"）。
    const currentInstructions = current?.instructions ?? null
    if (record.instructions === null) {
      record.instructions = currentInstructions
    } else if (currentInstructions !== null && currentInstructions !== record.instructions) {
      record.instructions = currentInstructions
      record.unreportedInstructions = true
    }
    const headChanged = before !== null && current !== null && before.source === 'git' && current.source === 'git'
      && before.head !== null && current.head !== null && before.head !== current.head
    const branchChanged = before !== null && current !== null && before.source === 'git' && current.source === 'git'
      && before.branch !== null && current.branch !== null && before.branch !== current.branch
    if (!record.hostTreeSeen && before !== null && current !== null && current.digest !== before.digest) {
      const external = current.changedPaths.filter(path => !record.writeIntent.has(path)).length
      if (external > 0 || headChanged || branchChanged) {
        record.unreportedExternal = Math.max(record.unreportedExternal, external > 0 ? external : 1)
      }
    }

    const openGoals = openGoalCount(record)
    const external = record.unreportedExternal
    const interruptedAt = record.interruptedAtTurn
    const hasChange = tier !== 'fresh' || headChanged || branchChanged || external > 0
      || interruptedAt !== null || record.unreportedInstructions
      || record.unreportedShell > 0 || record.unreportedShellUnknown > 0
      || record.unreportedShellInferred > 0
    const deep = tier === 'deep-stale'

    if (hasChange) {
      record.state = 'recovering'
      const label = current === null || current.source === 'none' ? '无git' : current.id
      const facts: NoticeFacts = {
        gapMs: tier === 'fresh' ? undefined : gapMs,
        headFrom: headChanged ? before?.head ?? null : null,
        headTo: headChanged ? current?.head ?? null : null,
        branch: branchChanged ? current?.branch ?? null : null,
        externalChanges: external,
        instructionsChanged: record.unreportedInstructions,
        shellWrites: record.unreportedShell,
        shellUnknown: record.unreportedShellUnknown,
        shellInferred: record.unreportedShellInferred,
        interruptedAtTurn: interruptedAt,
        openGoals,
        deepStale: deep,
        degraded: current === null || current.degraded || record.degraded,
      }
      const line = renderNotice(label, facts, config.noticeMaxChars)
      const digest = sha256Short(line, 16)
      if (!(record.lastNoticeDigest === digest && record.turn - record.lastNoticeTurn < config.suppressTurns)) {
        record.pendingNotice = line
        record.lastNoticeDigest = digest
        record.lastNoticeTurn = record.turn
      }
      // 已报告的事实不再触发下一次通知；新的变化会重新累积。
      record.unreportedExternal = 0
      record.unreportedInstructions = false
      record.unreportedShell = 0
      record.unreportedShellUnknown = 0
      record.unreportedShellInferred = 0
      record.interruptedAtTurn = null
      persistSession(sessionId, record, at)
    } else {
      record.state = 'active'
    }
    record.tier = tier
  }

  const toolCall = (sessionId: string, record: SessionRecord, at: number, data: unknown): void => {
    const dataRecord = asRecord(data)
    const name = nonEmpty(dataRecord?.['name'])?.toLowerCase()
    if (name === undefined) return
    // v4.2：shell 写可见性。先于 path 检查——shell 参数里通常没有 path 字段。
    if (config.shellTools.includes(name)) {
      const extraction = extractShellWritePaths(shellCommandOf(dataRecord))
      const cwd = safeCwd(sessionId)
      for (const raw of extraction.paths) {
        const absPath = absPathOf(cwd, raw)
        const key = absPath ?? raw
        record.shellWrites.delete(key)
        record.shellWrites.set(key, at)
        while (record.shellWrites.size > MAX_SHELL_WRITES) {
          const oldest = record.shellWrites.keys().next().value
          if (oldest === undefined) break
          record.shellWrites.delete(oldest)
        }
        record.shellIntentPending.add(key)
        if (absPath !== undefined) noteRecentWrite(sessionId, absPath, at)
      }
      record.unreportedShell += extraction.paths.length
      if (extraction.unknown) {
        record.shellUnknown += 1
        record.unreportedShellUnknown += 1
        // v4.4：未知写命令执行前记录脏文件基线，完成后差分为"推断写"。
        if (config.shellInferUnknown && cwd !== undefined) {
          record.shellBaseline = dirtyPathsOf(cwd) ?? null
        }
      }
      return
    }
    const path = pathOfArguments(dataRecord)
    if (path === undefined) return
    const absPath = absPathOf(safeCwd(sessionId), path)
    const key = absPath ?? path
    if (config.readTools.includes(name)) {
      // v4.1：读取时固化内容哈希；读不到/目录/超限 → hash null（情况 unknown，不是"未变化"）。
      const current = absPath === undefined ? { ok: true as const, value: null } : readCurrentHash(absPath)
      putBounded(record.readStamps, key, {
        path,
        absPath: absPath ?? path,
        at,
        step: record.step,
        epochId: record.epoch?.id ?? '',
        via: 'fs',
        hash: current.ok ? current.value?.hash ?? null : null,
        size: current.ok ? current.value?.size ?? null : null,
      }, config.maxStamps)
      // v4.4：保存读取时正文（最多 4 条），供守卫拒绝时生成冲突材料。
      if (absPath !== undefined) {
        const text = contentOf(absPath)
        if (typeof text === 'string') putBounded(record.readBases, key, text, 4)
      }
      return
    }
    if (!config.writeTools.includes(name)) return
    putBounded(record.writeStamps, key, { path, at, step: record.step, tool: name }, config.maxStamps)
    // **不在 tool/call 记 writeIntent / blindWrites**：前者是"尝试过"，后者由守卫在
    // pre-execute 按 §4 判定表计数（一次写attempt 只记一次）。
    const stamp = record.readStamps.get(key)
    if (stamp === undefined) return
    if (record.step - stamp.step > config.staleWriteSteps) record.staleWrites += 1
  }

  const goalChanged = (record: SessionRecord, data: unknown): void => {
    const recordData = asRecord(data)
    if (recordData === undefined) return
    const goals = recordData['goals']
    if (Array.isArray(goals)) {
      record.goals.clear()
      for (const item of goals.slice(0, MAX_GOALS)) {
        const goal = asRecord(item)
        if (goal === undefined) continue
        const id = nonEmpty(goal['id']) ?? nonEmpty(goal['objective']) ?? `goal-${record.goals.size + 1}`
        const text = (nonEmpty(goal['objective']) ?? nonEmpty(goal['text']) ?? '').slice(0, 80)
        const phase = nonEmpty(goal['phase'])?.toLowerCase() ?? ''
        record.goals.set(id, { id, text, closed: CLOSED_PHASES.includes(phase) })
      }
      return
    }
    const goal = asRecord(recordData['goal']) ?? recordData
    const id = nonEmpty(goal['id']) ?? nonEmpty(goal['objective']) ?? nonEmpty(recordData['id'])
    if (id === undefined) return
    const phase = (nonEmpty(goal['phase']) ?? nonEmpty(recordData['phase']) ?? '').toLowerCase()
    const text = (nonEmpty(goal['objective']) ?? nonEmpty(goal['text']) ?? '').slice(0, 80)
    const entry: GoalEntry = { id, text, closed: CLOSED_PHASES.includes(phase) }
    record.goals.delete(id)
    record.goals.set(id, entry)
    while (record.goals.size > MAX_GOALS) {
      const oldest = record.goals.keys().next().value
      if (oldest === undefined) break
      record.goals.delete(oldest)
    }
  }

  const todosChanged = (record: SessionRecord, data: unknown): void => {
    const list = asRecord(data)?.['todos']
    if (!Array.isArray(list)) return
    record.todos.clear()
    for (const item of list) {
      const todo = asRecord(item)
      if (todo === undefined) continue
      const id = nonEmpty(todo['id']) ?? nonEmpty(todo['content']) ?? `todo-${record.todos.size + 1}`
      const status = nonEmpty(todo['status'])?.toLowerCase() ?? 'pending'
      record.todos.set(id, status)
    }
  }

  const turnEnd = (sessionId: string, record: SessionRecord, at: number, data: unknown): void => {
    const dataRecord = asRecord(data)
    const reason = nonEmpty(dataRecord?.['reason']) ?? null
    record.lastTurnEndReason = reason
    record.lastTurnEndTurn = finiteNumber(dataRecord?.['turn']) ?? record.turn
    record.state = 'idle'
    if (reason !== null && INTERRUPT_REASONS.includes(reason.toLowerCase())) {
      record.interrupted = true
      record.interruptedAtTurn = record.lastTurnEndTurn
    } else {
      record.interrupted = false
    }
    // **不在 turn/end 刷新 epoch**：外部改动要留到下一次 `turn/start` 才与
    // 上一回合的 epoch 比较（先在 turn/end 覆盖基线，就等于把 delta 吃掉了）。
    persistSession(sessionId, record, at)
  }

  /** 查找某路径的读取印记：先按绝对路径 key，再按展示路径兜底（兼容旧持久化）。 */
  const findStamp = (record: SessionRecord, absPath: string | undefined, path: string): ReadStamp | undefined => {
    const key = absPath ?? path
    const direct = record.readStamps.get(key)
    if (direct !== undefined) return direct
    if (absPath !== undefined) {
      for (const stamp of record.readStamps.values()) {
        if (stamp.absPath === absPath) return stamp
      }
    }
    for (const stamp of record.readStamps.values()) {
      if (stamp.path === path) return stamp
    }
    return undefined
  }

  /** v4.4：`git status --porcelain=v2 -z` 的脏路径集合；git 不可用返回 undefined。 */
  const dirtyPathsOf = (cwd: string): Set<string> | undefined => {
    try {
      const result = git(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'])
      if (!result.ok) return undefined
      return new Set(parsePorcelainV2Paths(result.stdout))
    } catch (error) {
      warn('dirtyPaths', error)
      return undefined
    }
  }

  /** 读取之后是否有本会话的 shell 写（v4.2）。 */
  const shellWroteAfter = (record: SessionRecord, absPath: string | undefined, since: number): boolean => {
    if (absPath === undefined) return false
    const at = record.shellWrites.get(absPath)
    return at !== undefined && at > since
  }

  /** 读取之后是否有其他会话（子代理/并发会话）写过同一路径（v4.2）。 */
  const otherSessionWroteAfter = (
    sessionId: string,
    absPath: string | undefined,
    since: number,
  ): boolean => {
    if (absPath === undefined) return false
    const key = `${safeCwd(sessionId) ?? ''}\u0000${absPath}`
    const entry = recentWrites.get(key)
    return entry !== undefined && entry.sessionId !== sessionId && entry.at > since
  }

  /**
   * v4.1 §4 统一判定表（edit+write）：**内容哈希**，不是全局 epoch。
   *
   * v4.2 增补：盲写策略（`blindWritePolicy`）、shell 写后未重读、其他会话写后未重读。
   *
   * | 情况 | 判定 | 记账 |
   * |---|---|---|
   * | 无印记，目标不存在 | allow | — |
   * | 无印记，目标存在 | allow + blindWrites++（策略 deny 时 deny） | blindWrites |
   * | 印记 hash=null 且读后 shell/他人写过 | deny | denies |
   * | 印记 hash=null | allow | unverifiable++ |
   * | 当前读不到/超限 | allow | unverifiable++ |
   * | hash 相同 | allow | — |
   * | hash 不同 | deny（≤120 事实句） | denies++；同路径同回合第 3 次 allow+gaveUps++ |
   * | 内部异常 | allow | 日志（fail-open，不成为单点故障） |
   */
  const guardEdit = (sessionId: string, toolName: string, path: string): EditGuardDecision => {
    if (disposed) return { kind: 'allow', reason: null }
    try {
      const name = toolName.toLowerCase()
      if (!config.writeTools.includes(name)) return { kind: 'allow', reason: null }
      const record = sessions.get(nonEmpty(sessionId) ?? '')
      if (record === undefined) return { kind: 'allow', reason: null }
      const normalized = normalizePath(path)
      if (normalized === undefined) return { kind: 'allow', reason: null }
      const absPath = absPathOf(safeCwd(sessionId), normalized)
      const denyKey = absPath ?? normalized
      const stamp = findStamp(record, absPath, normalized)

      /** 统一 deny 记账（逃生门：同路径同回合第 3 次放行）。 */
      const denyWith = (reason: string): EditGuardDecision => {
        const denied = record.denyCounts.get(denyKey) ?? 0
        if (denied >= config.maxDeniesPerPathPerTurn) {
          record.gaveUps += 1
          return { kind: 'allow', reason: null }
        }
        record.denyCounts.set(denyKey, denied + 1)
        record.denies += 1
        return { kind: 'deny', reason: reason.length > 120 ? reason.slice(0, 120) : reason }
      }

      /**
       * v4.4：写冲突材料（base/current 原文 + 事实说明），返回相对路径。
       * 没有 cwd / 没有 base 文本 / 写失败 → undefined（拒绝本身照常）。
       */
      const conflictFor = (stampForBase: ReadStamp | undefined, reason: string): string | undefined => {
        const cwd = safeCwd(sessionId)
        if (cwd === undefined || absPath === undefined) return undefined
        const base = record.readBases.get(absPath) ?? record.readBases.get(normalized) ?? null
        const current = contentOf(absPath)
        return writeConflict({ cwd, path: normalized, reason, base, current })
      }

      // ① 无印记：新建 allow；覆盖既有文件按盲写策略（默认 allow + blindWrites）。
      if (stamp === undefined) {
        if (absPath === undefined || !fileExists(absPath)) return { kind: 'allow', reason: null }
        record.blindWrites += 1
        if (config.blindWritePolicy === 'deny') {
          return denyWith('该文件已存在但本会话没有可核验的读取印记；先读取再修改（盲写策略 deny）。')
        }
        return { kind: 'allow', reason: null }
      }
      // ② 读取时就没有哈希（目录/超限/读失败）：若有 shell/其他会话在其后写过，主动 deny。
      if (stamp.hash === null) {
        if (shellWroteAfter(record, absPath, stamp.at)) {
          const base = '读后 shell 写过，读取时无法核验内容；编辑未执行。'
          const conflict = conflictFor(stamp, base)
          return denyWith(conflict === undefined ? `${base}请重读后再编辑。` : `${base}冲突材料 ${conflict}`)
        }
        if (otherSessionWroteAfter(sessionId, absPath, stamp.at)) {
          const base = '读后被其他会话（含子代理）写过，无法核验内容；编辑未执行。'
          const conflict = conflictFor(stamp, base)
          return denyWith(conflict === undefined ? `${base}请重读后再编辑。` : `${base}冲突材料 ${conflict}`)
        }
        record.unverifiable += 1
        return { kind: 'allow', reason: null }
      }
      if (absPath === undefined) {
        record.unverifiable += 1
        return { kind: 'allow', reason: null }
      }
      // ③ 当前内容读不到/超限 → 无法核验；有 shell/他人写则 deny，否则放行并计数。
      const current = readCurrentHash(absPath)
      if (!current.ok) return { kind: 'allow', reason: null }
      if (current.value === null) {
        if (shellWroteAfter(record, absPath, stamp.at)) {
          const base = '读后 shell 写过，当前无法核验内容；编辑未执行。'
          const conflict = conflictFor(stamp, base)
          return denyWith(conflict === undefined ? `${base}请重读后再编辑。` : `${base}冲突材料 ${conflict}`)
        }
        record.unverifiable += 1
        return { kind: 'allow', reason: null }
      }
      // ④ 哈希相同 → 读后未变，放行。
      if (current.value.hash === stamp.hash) return { kind: 'allow', reason: null }
      // ⑤ 哈希不同（读后被改）→ deny；同路径同回合第 3 次放行并计 gaveUps。
      {
        const base = `读后内容已变化（${stamp.hash.slice(0, 8)}→${current.value.hash.slice(0, 8)}），编辑未执行。`
        const conflict = conflictFor(stamp, base)
        return denyWith(
          conflict === undefined ? `${base}重读后可再编辑。` : `${base}冲突材料 ${conflict}；重读后可再编辑。`,
        )
      }
    } catch (error) {
      warn('guardEdit', error)
      return { kind: 'allow', reason: null }
    }
  }

  /**
   * `tools/post-execute` 成功（`result.isError === false`）后：
   * ① 加入 writeIntent（归因"本会话确实写过"，按 turn/start 清空）；
   * ② 重算该文件哈希并刷新已有读取印记——**自己的写不误伤自己**。
   */
  const noteWriteResult = (sessionId: string, toolName: string, path: string, ok: boolean): void => {
    if (disposed || !ok) return
    try {
      const name = toolName.toLowerCase()
      if (!config.writeTools.includes(name)) return
      const record = sessions.get(nonEmpty(sessionId) ?? '')
      if (record === undefined) return
      const normalized = normalizePath(path)
      if (normalized === undefined) return
      record.writeIntent.add(normalized)
      while (record.writeIntent.size > MAX_WRITE_INTENT) {
        const oldest = record.writeIntent.values().next().value
        if (oldest === undefined) break
        record.writeIntent.delete(oldest)
      }
      const absPath = absPathOf(safeCwd(sessionId), normalized)
      if (absPath === undefined) return
      noteRecentWrite(sessionId, absPath, clock.now())
      const stamp = findStamp(record, absPath, normalized)
      if (stamp === undefined) return
      const current = readCurrentHash(absPath)
      if (!current.ok || current.value === null) return
      record.readStamps.set(absPath, {
        ...stamp,
        absPath,
        hash: current.value.hash,
        size: current.value.size,
      })
    } catch (error) {
      warn('noteWriteResult', error)
    }
  }

  /**
   * v4.2：shell 工具 post-execute。成功时把本回合提取到的 shell 写路径并入
   * `writeIntent`（归因"这台会话确实写过"）；失败不清空（写可能部分生效，
   * 下一次回合边界会清空）。
   */
  const noteShellResult = (sessionId: string, toolName: string, ok: boolean): void => {
    if (disposed) return
    try {
      const name = toolName.toLowerCase()
      if (!config.shellTools.includes(name)) return
      const record = sessions.get(nonEmpty(sessionId) ?? '')
      if (record === undefined) return
      if (ok) {
        for (const path of record.shellIntentPending) {
          record.writeIntent.add(path)
          while (record.writeIntent.size > MAX_WRITE_INTENT) {
            const oldest = record.writeIntent.values().next().value
            if (oldest === undefined) break
            record.writeIntent.delete(oldest)
          }
        }
        // v4.4：未知写 shell 成功 → 用命令前后 git status 差分推断写集（近似归因）。
        const cwd = safeCwd(sessionId)
        if (record.shellBaseline !== null && cwd !== undefined) {
          const after = dirtyPathsOf(cwd)
          if (after !== undefined) {
            const at = clock.now()
            for (const path of after) {
              if (record.shellBaseline.has(path)) continue
              const absPath = absPathOf(cwd, path)
              const key = absPath ?? path
              record.shellWrites.delete(key)
              record.shellWrites.set(key, at)
              while (record.shellWrites.size > MAX_SHELL_WRITES) {
                const oldest = record.shellWrites.keys().next().value
                if (oldest === undefined) break
                record.shellWrites.delete(oldest)
              }
              if (absPath !== undefined) noteRecentWrite(sessionId, absPath, at)
              record.shellInferred += 1
              record.unreportedShellInferred += 1
              record.shellIntentPending.add(key)
            }
          }
        }
      }
      record.shellBaseline = null
      record.shellIntentPending.clear()
    } catch (error) {
      warn('noteShellResult', error)
    }
  }

  const epochView = (record: SessionRecord): SessionStateSnapshot['epoch'] => record.epoch === null
    ? null
    : {
        id: record.epoch.id,
        head: record.epoch.head,
        branch: record.epoch.branch,
        dirtyCount: record.epoch.dirtyCount,
        digest: record.epoch.digest,
        at: record.epoch.at,
        degraded: record.epoch.degraded,
        source: record.epoch.source,
        treeBefore: record.epoch.treeBefore,
        treeAfter: record.epoch.treeAfter,
        externalChanges: record.unreportedExternal,
        instructions: record.epoch.instructions,
      }

  const port: SessionStateService = {
    observe(event: SessionStateEvent): void {
      if (disposed) return
      try {
        const sessionId = nonEmpty(event?.sessionId)
        if (sessionId === undefined) return
        const at = finiteNumber(event?.at) ?? clock.now()
        const record = recordOf(sessionId)
        const type = nonEmpty(event?.type) ?? ''
        const seq = finiteNumber(event?.seq)
        if (type === 'turn/start') {
          record.turnStartSeen = true
          boundary(sessionId, record, at, event.data)
        } else if (type === 'step/start') {
          // 宿主有 `turn/start` 时，step 只推进步号；没有时才把 step 当回合边界
          // （兼容旧宿主/夹具，同时不破坏"每回合最多 2 次 deny"的预算）。
          const stepValue = finiteNumber(asRecord(event.data)?.['step'])
          if (stepValue !== undefined) record.step = Math.max(record.step, Math.floor(stepValue))
          if (!record.turnStartSeen) boundary(sessionId, record, at, event.data)
        } else if (type === 'turn/end') {
          turnEnd(sessionId, record, at, event.data)
        } else if (type === 'step/end') {
          if (record.state === 'recovering') {
            record.state = 'active'
            record.tier = 'fresh'
          }
        } else if (type === 'tool/call') {
          toolCall(sessionId, record, at, event.data)
        } else if (type === 'tool/result') {
          const dataRecord = asRecord(event.data)
          const ok = dataRecord?.['ok'] !== false && dataRecord?.['isError'] !== true
          // 会话事件形状里可能带 name/arguments：成功写入也刷新印记（与 post-execute 同源，幂等）。
          const resultTool = nonEmpty(dataRecord?.['name'])
          const resultPath = pathOfArguments(dataRecord)
          if (ok && resultTool !== undefined && resultPath !== undefined) {
            noteWriteResult(sessionId, resultTool, resultPath, true)
          }
          if (ok && record.state === 'recovering') {
            record.state = 'active'
            record.tier = 'fresh'
          }
        } else if (type === 'workspace/changes') {
          applyWorkspaceSummary(sessionId, record, seq, at)
        } else if (type === 'goal/change') {
          goalChanged(record, event.data)
        } else if (type === 'todo/write') {
          todosChanged(record, event.data)
        }
        if (record.lastEventAt === null || at > record.lastEventAt) record.lastEventAt = at
      } catch (error) {
        warn('observe', error)
      }
    },

    snapshot(sessionId: string): SessionStateSnapshot | undefined {
      if (disposed) return undefined
      try {
        const record = sessions.get(nonEmpty(sessionId) ?? '')
        if (record === undefined) return undefined
        const idleMs = record.lastEventAt === null ? null : Math.max(0, clock.now() - record.lastEventAt)
        return {
          sessionId,
          state: record.state,
          tier: record.tier,
          flags: {
            degraded: record.degraded || (record.epoch?.degraded ?? false) || record.persistence.error !== null,
            interrupted: record.interrupted,
            unresolved: unresolved(record),
          },
          lastEventAt: record.lastEventAt,
          idleMs,
          turn: record.turn,
          step: record.step,
          lastTurnEndReason: record.lastTurnEndReason,
          interruptedAtTurn: record.interruptedAtTurn,
          epoch: epochView(record),
          openGoals: openGoalCount(record),
          openTodos: openTodoCount(record),
          readStamps: record.readStamps.size,
          writeIntent: record.writeIntent.size,
          blindWrites: record.blindWrites,
          staleWrites: record.staleWrites,
          guard: {
            denies: record.denies,
            gaveUps: record.gaveUps,
            writeWarnings: record.writeWarnings,
            unverifiable: record.unverifiable,
          },
          persistence: {
            enabled: config.persist,
            lastWriteAt: record.persistence.lastWriteAt,
            error: record.persistence.error,
          },
          pendingNotice: record.pendingNotice,
        }
      } catch (error) {
        warn('snapshot', error)
        return undefined
      }
    },

    consumeNotice(sessionId: string): string | null {
      if (disposed) return null
      try {
        const record = sessions.get(nonEmpty(sessionId) ?? '')
        if (record === undefined) return null
        const line = record.pendingNotice
        record.pendingNotice = null
        return line
      } catch (error) {
        warn('consumeNotice', error)
        return null
      }
    },

    workspaceEpoch(cwd: string): WorkspaceEpoch {
      if (disposed) return emptyEpoch(clock.now(), '状态机已注销')
      return workspaceEpoch(cwd)
    },

    idleMs(sessionId: string): number | undefined {
      if (disposed) return undefined
      try {
        const record = sessions.get(nonEmpty(sessionId) ?? '')
        if (record === undefined || record.lastEventAt === null) return undefined
        return Math.max(0, clock.now() - record.lastEventAt)
      } catch (error) {
        warn('idleMs', error)
        return undefined
      }
    },

    readStamps(sessionId: string): readonly ReadStamp[] {
      if (disposed) return []
      try {
        const record = sessions.get(nonEmpty(sessionId) ?? '')
        if (record === undefined) return []
        return [...record.readStamps.values()]
          .map(stamp => ({ ...stamp }))
          .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      } catch (error) {
        warn('readStamps', error)
        return []
      }
    },

    /** v4.1 §3.3：只读、同步、绝不抛；entries 按 path 排序且 ≤16。 */
    situation(sessionId: string): SessionSituation | undefined {
      if (disposed) return undefined
      try {
        const record = sessions.get(nonEmpty(sessionId) ?? '')
        if (record === undefined) return undefined
        const idleMs = record.lastEventAt === null ? null : Math.max(0, clock.now() - record.lastEventAt)
        const stamps = [...record.readStamps.values()]
          .map(stamp => ({ ...stamp }))
          .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        const scanned = stamps.slice(0, MAX_SITUATION_ENTRIES)
        const entries = scanned.map(stamp => {
          let status: 'same' | 'changed' | 'unknown'
          if (stamp.hash === null) {
            status = 'unknown'
          } else {
            const current = readCurrentHash(stamp.absPath)
            status = !current.ok || current.value === null
              ? 'unknown'
              : current.value.hash === stamp.hash
                ? 'same'
                : 'changed'
          }
          return { path: stamp.path, status, hash: stamp.hash }
        })
        const otherSessionWrites = stamps.reduce((count, stamp) => {
          const key = `${safeCwd(sessionId) ?? ''}\u0000${stamp.absPath}`
          const entry = recentWrites.get(key)
          return entry !== undefined && entry.sessionId !== sessionId && entry.at > stamp.at ? count + 1 : count
        }, 0)
        return {
          sessionId,
          cwd: safeCwd(sessionId) ?? null,
          state: record.state,
          tier: record.tier,
          turn: record.turn,
          step: record.step,
          lastEventAt: record.lastEventAt,
          idleMs,
          lastTurnEndReason: record.lastTurnEndReason,
          interrupted: record.interrupted,
          unresolved: unresolved(record),
          goals: { open: openGoalCount(record), total: record.goals.size },
          todos: { open: openTodoCount(record), total: record.todos.size },
          epoch: epochView(record),
          reads: {
            count: stamps.length,
            changed: entries.filter(entry => entry.status === 'changed').length,
            unknown: entries.filter(entry => entry.status === 'unknown').length,
            entries,
          },
          sideEffects: {
            blindWrites: record.blindWrites,
            staleWrites: record.staleWrites,
            denies: record.denies,
            gaveUps: record.gaveUps,
            unverifiable: record.unverifiable,
            shellWrites: record.shellWrites.size,
            shellUnknown: record.shellUnknown,
            shellInferred: record.shellInferred,
            otherSessionWrites,
          },
        }
      } catch (error) {
        warn('situation', error)
        return undefined
      }
    },
  }

  return {
    port,
    guardEdit,
    noteWriteResult,
    noteShellResult,
    dispose(): void {
      disposed = true
      sessions.clear()
      epochCache.clear()
      recentWrites.clear()
    },
  }
}

/** 宿主执行对象的最小结构面（守卫只需要会话/工具名/参数）。 */
interface HostContextLike {
  on?(event: string, fn: (...args: never[]) => unknown): unknown
}

/**
 * 把守卫接到宿主的 `tools/pre-execute` + `tools/post-execute`（v4.1 §4）。
 *
 * 契约：edit 与 write 用同一判定表；shell 永不 deny；守卫自身异常一律放行
 * （fail-open）。post-execute 只在 `result.isError === false` 时刷新印记并记
 * writeIntent——自己的写不误伤自己。
 * @returns 幂等 disposer；注册失败只记日志，绝不抛。
 */
export function wireEditGuard(options: {
  readonly ctx: HostContextLike
  readonly machine: SessionStateMachine
  readonly logger?: Logger
}): () => void {
  const { ctx, machine, logger } = options
  const offs: (() => void)[] = []
  const log = (message: string): void => {
    try {
      logger?.warn(message)
    } catch {
      // 日志失败不得影响工具
    }
  }
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

  if (typeof ctx.on !== 'function') return () => {}
  try {
    const preOff = ctx.on('tools/pre-execute', (async (exec: unknown, next: unknown) => {
      try {
        const record = asRecord(exec)
        const toolName = nonEmpty(record?.['name'])
        const sessionId = nonEmpty((record?.['agent'] as { session?: { id?: unknown } } | undefined)?.session?.id)
        const path = pathOfArguments(record)
        if (toolName !== undefined && sessionId !== undefined && path !== undefined) {
          const decision = machine.guardEdit(sessionId, toolName, path)
          if (decision.kind === 'deny') {
            return { kind: 'deny', reason: decision.reason ?? '文件内容在读取后已变化，编辑未执行' }
          }
        }
      } catch (error) {
        log(`OMB 状态机：守卫异常（已放行）——${errorText(error)}`)
      }
      if (typeof next !== 'function') return { kind: 'allow' }
      return (next as () => unknown)()
    }) as never)
    if (typeof preOff === 'function') offs.push(preOff as () => void)

    const postOff = ctx.on('tools/post-execute', (async (exec: unknown, result: unknown, next: unknown) => {
      try {
        const resultRecord = asRecord(result)
        const ok = resultRecord?.['isError'] === false
        const execRecord = asRecord(exec)
        const toolName = nonEmpty(execRecord?.['name'])
        const sessionId = nonEmpty(
          (execRecord?.['agent'] as { session?: { id?: unknown } } | undefined)?.session?.id,
        )
        const path = pathOfArguments(execRecord)
        if (toolName !== undefined && sessionId !== undefined) {
          if (path !== undefined) machine.noteWriteResult(sessionId, toolName, path, ok)
          // shell 没有 path 参数：按命令里提取到的路径归因；失败也会清空本回合 pending。
          machine.noteShellResult(sessionId, toolName, ok)
        }
      } catch (error) {
        log(`OMB 状态机：写后刷新异常（已隔离）——${errorText(error)}`)
      }
      if (typeof next !== 'function') return { kind: 'accept' }
      return (next as () => unknown)()
    }) as never)
    if (typeof postOff === 'function') offs.push(postOff as () => void)
  } catch (error) {
    log(`OMB 状态机：守卫注册失败（工具不受影响）——${errorText(error)}`)
  }

  return () => {
    for (const off of offs.reverse()) {
      try {
        off()
      } catch {
        // H-1：注销失败不得向上传播
      }
    }
    offs.length = 0
  }
}
