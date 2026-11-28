import type { Entity, Scope } from '../domain/entity.js'
import { auditActorKindOf, type AuditActorKind } from '../domain/audit.js'
import { scopeOf, titleOf } from '../domain/entity-access.js'
import type { JsonValue } from '../domain/json.js'

/**
 * 信任分层 / 来源分类 / 注入风险 / 破坏性操作授权（Phase 4 Task 19，ADR-0010）。
 *
 * 威胁模型：检索到的记忆、会话工件、工具输出、外部网页一律是**不可信数据**。
 * 攻击者可以把 `忽略之前所有指令`、`system: ...`、边界标记或工具调用片段写进属性，
 * 等 T0/T1 注入时冒充系统指令。本模块只做两件可机械验证的事：
 *
 * 1. 给每段内容一个来源（memory/artifact/tool/external/system）、信任分与注入风险；
 *    信任分只由**写入者**（origin/actor）和**来源上限**决定，内容自己不能提高信任。
 * 2. 给破坏性操作（`truncateAll`）一个前置授权判定：库名必须是可抛弃的测试/基准库，
 *    生产环境无条件拒绝；显式 flag 只能用于非生产且不能绕过库名判定（只能收紧）。
 *
 * 本模块是纯函数：不读文件、不连数据库、不写日志，便于单测与复用。
 */

/** 内容来源类别。 */
export type ContextSource = 'memory' | 'artifact' | 'tool' | 'external' | 'system'

/**
 * 写入者类别（与 `AuditEntry.actor` / `entity.origin` 的命名空间一致）。
 *
 * 7.2.4 起工具写入的 actor 是 `assistant`、外部/工具内容来源是 `tool`；`model` 与
 * `external` 是 7.1 及以前的历史别名，继续按同分处理，避免旧记忆升级后信任跳变。
 */
type TrustActorKind = AuditActorKind

/** 注入风险等级；`high` 的块默认被隔离，原文不注入。 */
export type InjectionRisk = 'low' | 'medium' | 'high'

/** 默认写入者信任分（与 ARCHITECTURE-PLAN §4.8 一致）。 */
export const DEFAULT_TRUST_LEVELS: Readonly<Record<TrustActorKind, number>> = Object.freeze({
  user: 1,
  assistant: 0.8,
  model: 0.8,
  tool: 0.4,
  job: 0.6,
  external: 0.3,
  system: 1,
})

/**
 * 来源信任上限。写入者分再高也不能突破来源上限：
 * - 记忆本身由写入者决定（user/model/job），上限 1；
 * - 工件可能夹带外部网页/工具原文，上限 0.5；
 * - 工具输出可被被调资源污染，上限 0.4；
 * - 外部内容上限 0.3。
 */
export const DEFAULT_SOURCE_CAPS: Readonly<Record<ContextSource, number>> = Object.freeze({
  memory: 1,
  artifact: 0.5,
  tool: 0.4,
  external: 0.3,
  system: 1,
})

export interface Provenance {
  readonly source: ContextSource
  readonly actorKind: TrustActorKind
  /** 原始写入来源，如 `model`、`job:extract`、`external:web`。 */
  readonly origin: string
  /** 关联实体/工件 id（可追溯回源记录）。 */
  readonly entityIds?: readonly string[]
}

export interface TrustClassification {
  /** 0..1；越高越可信。内容本身不能提高它。 */
  readonly trust: number
  readonly provenance: Provenance
  readonly injectionRisk: InjectionRisk
  /** 风险分（0..1）；等级是它的分档，保留分数便于接收方按阈值再处理。 */
  readonly riskScore: number
  /** 命中的风险模式 id（可审计、可去重，不携带原文）。 */
  readonly riskReasons: readonly string[]
  readonly scope: Scope
}

interface TrustInput {
  /** 被分类的文本（属性值/工具输出/外部正文）。 */
  readonly text: string
  readonly source: ContextSource
  /** 写入者来源；缺省按来源推断（memory→model，external→external，system→system）。 */
  readonly origin?: string
  readonly entityIds?: readonly string[]
  readonly scope?: Scope
}

export interface TrustPolicy {
  readonly levels: Readonly<Record<TrustActorKind, number>>
  readonly sourceCaps: Readonly<Record<ContextSource, number>>
  classify(input: TrustInput): TrustClassification
  classifyEntity(entity: Entity, text?: string): TrustClassification
}

interface TrustPolicyOptions {
  readonly levels?: Readonly<Record<TrustActorKind, number>>
  readonly sourceCaps?: Readonly<Record<ContextSource, number>>
  /** 风险分 >= 该值为 high，默认 0.6。 */
  readonly highRiskThreshold?: number
  /** 风险分 >= 该值为 medium，默认 0.3。 */
  readonly mediumRiskThreshold?: number
}

/** 单条风险模式：`reason` 只描述类别，不携带内容，避免把攻击载荷再复制一份。 */
interface RiskPattern {
  readonly reason: string
  readonly weight: number
  readonly pattern: RegExp
}

/**
 * 注入/投毒模式表。
 *
 * 权重按「能不能直接改变行为」排序：覆盖指令、角色冒充、边界逃逸最危险；
 * 出现 URL 只是弱信号（很多正常记忆会带链接）。总分截断到 1。
 */
const RISK_PATTERNS: readonly RiskPattern[] = [
  {
    reason: 'instruction-override',
    weight: 0.45,
    pattern: /(?:ignore|disregard|forget|override)\b[^\n]{0,60}?\b(?:previous|prior|above|earlier|all)\b[^\n]{0,30}?\b(?:instruction|instructions|prompt|prompts|rules|messages|system)\b/i,
  },
  {
    reason: 'instruction-override',
    weight: 0.45,
    pattern: /(?:忽略|无视|忘记|覆盖|绕过)[^\n]{0,16}?(?:以上|之前|前面|上述|所有|全部)?[^\n]{0,8}?(?:指令|提示词|提示|规则|要求|设定)/,
  },
  {
    reason: 'role-impersonation',
    weight: 0.3,
    pattern: /(?:^|\n)\s*(?:system|assistant|developer|tool)\s*[:：]/i,
  },
  {
    reason: 'role-impersonation',
    weight: 0.3,
    pattern: /<\|(?:im_start|im_end|system|user|assistant)\|>|\[\/?INST\]|<<\/?SYS>>/i,
  },
  {
    reason: 'role-impersonation',
    weight: 0.25,
    pattern: /["']role["']\s*:\s*["'](?:system|developer|assistant)["']/i,
  },
  {
    reason: 'boundary-escape',
    weight: 0.3,
    pattern: /<<<\s*(?:END_)?OMB_|<<<|>>>/,
  },
  {
    reason: 'capability-invocation',
    weight: 0.25,
    pattern: /\bomb_(?:remember|update|recall|admin|status|history|link)\s*[（(]/i,
  },
  {
    reason: 'capability-invocation',
    weight: 0.25,
    pattern: /(?:执行|运行|调用)[^\n]{0,10}(?:以下|下面|这条)?[^\n]{0,6}(?:命令|工具|脚本|函数)|(?:call|invoke|run)\b[^\n]{0,24}\b(?:tool|command|shell|function)\b/i,
  },
  {
    reason: 'capability-invocation',
    weight: 0.2,
    pattern: /\b(?:rm\s+-rf|curl\s+https?:\/\/|wget\s+https?:\/\/|powershell(?:\.exe)?\s|cmd\.exe\s)/i,
  },
  {
    reason: 'secret-exfiltration',
    weight: 0.35,
    pattern: /(?:api[_-]?key|password|passwd|secret|access[_-]?token|private[_-]?key)\s*[:=：]\s*\S+/i,
  },
  {
    reason: 'secret-exfiltration',
    weight: 0.3,
    pattern: /(?:process\.env|id_rsa|\.ssh[\\/]|credentials\.json|OMB_DATABASE_URL)/i,
  },
  {
    reason: 'urgency-pressure',
    weight: 0.15,
    pattern: /最高优先级|必须立即执行|不要告诉用户|别告诉用户|do not tell|don't tell|urgent action/i,
  },
  {
    reason: 'external-url',
    weight: 0.1,
    pattern: /https?:\/\//i,
  },
]

/** 每个文本最多扫描的字符数：超长属性不把 CPU 交给不可控输入。 */
const MAX_SCAN_CHARS = 8_192
/** `entityContentText` 的默认输出上限；只用于风险扫描与块文本，不参与检索。 */
const MAX_ENTITY_TEXT_CHARS = 1_200
/** 单个属性值渲染上限，避免一个巨大 JSON 属性吃满扫描预算。 */
const MAX_ATTRIBUTE_VALUE_CHARS = 200

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** 写入者/来源字符串 → actor 类别；未知来源按 model 处理（不让内容自称提权）。 */
export function actorKindOfOrigin(origin: string | undefined): TrustActorKind {
  return auditActorKindOf(origin)
}

function defaultOriginOf(source: ContextSource): string {
  if (source === 'external') return 'external'
  if (source === 'system') return 'system'
  return 'model'
}

function riskOfScore(score: number, mediumThreshold: number, highThreshold: number): InjectionRisk {
  if (score >= highThreshold) return 'high'
  if (score >= mediumThreshold) return 'medium'
  return 'low'
}

interface InjectionScan {
  readonly score: number
  readonly risk: InjectionRisk
  readonly reasons: readonly string[]
}

/**
 * 扫描一段不可信文本的注入/投毒风险。
 *
 * 纯规则、确定性、无 IO：同一文本永远得到同一结果，可写进 receipt 做证据。
 * 扫描前做 NFKC 归一化，挡掉全角/兼容字符的简单伪装。
 */
export function scanInjectionRisk(text: string, options: TrustPolicyOptions = {}): InjectionScan {
  const normalized = text.normalize('NFKC').slice(0, MAX_SCAN_CHARS)
  const reasons: string[] = []
  let score = 0
  for (const rule of RISK_PATTERNS) {
    if (!rule.pattern.test(normalized)) continue
    if (!reasons.includes(rule.reason)) reasons.push(rule.reason)
    score += rule.weight
  }
  const bounded = clamp01(score)
  return {
    score: bounded,
    risk: riskOfScore(
      bounded,
      options.mediumRiskThreshold ?? 0.3,
      options.highRiskThreshold ?? 0.6,
    ),
    reasons,
  }
}

function renderJsonValue(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  try {
    const rendered = JSON.stringify(value)
    return rendered.length <= MAX_ATTRIBUTE_VALUE_CHARS
      ? rendered
      : `${rendered.slice(0, MAX_ATTRIBUTE_VALUE_CHARS)}…`
  } catch {
    return ''
  }
}

function renderAttributeValue(value: Entity['attributes'][number]['value']): string {
  if (value.kind === 'static') return renderJsonValue(value.value)
  // 动态值只渲染已缓存的真实值；缓存缺失时渲染 spec 会让人误以为它是内容。
  return renderJsonValue(value.cachedValue)
}

/**
 * 把实体压成用于风险扫描/上下文块的文本：标题 + 属性名=值。
 *
 * 刻意保留名字：`process.env` 之类的载荷可能在属性名或值里；只扫标题会漏。
 */
export function entityContentText(entity: Entity, limit = MAX_ENTITY_TEXT_CHARS): string {
  const parts: string[] = []
  const title = titleOf(entity)
  if (title !== undefined) parts.push(title)
  let used = title?.length ?? 0
  for (const attribute of entity.attributes) {
    if (used >= limit) break
    const rendered = renderAttributeValue(attribute.value)
    if (rendered.length === 0) continue
    const part = `${attribute.name}=${rendered}`
    parts.push(part)
    used += part.length + 1
  }
  const joined = parts.join(' ')
  return joined.length <= limit ? joined : `${joined.slice(0, limit)}…`
}

export function createTrustPolicy(options: TrustPolicyOptions = {}): TrustPolicy {
  const levels = options.levels ?? DEFAULT_TRUST_LEVELS
  const sourceCaps = options.sourceCaps ?? DEFAULT_SOURCE_CAPS
  const mediumThreshold = options.mediumRiskThreshold ?? 0.3
  const highThreshold = options.highRiskThreshold ?? 0.6
  const classify = (input: TrustInput): TrustClassification => {
    const origin = input.origin ?? defaultOriginOf(input.source)
    const actorKind = actorKindOfOrigin(origin)
    const level = clamp01(levels[actorKind])
    const cap = clamp01(sourceCaps[input.source])
    const scan = scanInjectionRisk(input.text, { mediumRiskThreshold: mediumThreshold, highRiskThreshold: highThreshold })
    return {
      // 取 min：内容不能靠自称来源把自己的信任抬到来源上限之上。
      trust: Math.min(level, cap),
      provenance: {
        source: input.source,
        actorKind,
        origin,
        ...(input.entityIds === undefined ? {} : { entityIds: input.entityIds }),
      },
      injectionRisk: scan.risk,
      riskScore: scan.score,
      riskReasons: scan.reasons,
      scope: input.scope ?? { kind: 'global' },
    }
  }
  return {
    levels,
    sourceCaps,
    classify,
    classifyEntity(entity, text) {
      return classify({
        text: text ?? entityContentText(entity),
        source: 'memory',
        origin: entity.origin,
        entityIds: [entity.id],
        scope: scopeOf(entity),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 破坏性操作授权（truncateAll 守卫）
// ---------------------------------------------------------------------------

/** 可抛弃数据库名：必须含独立的 `test`/`bench` 段（`omb_v7_test_writer`、`omb_v7_bench`）。 */
const DISPOSABLE_DATABASE_NAME = /(?:^|_)(?:test|bench)(?:_|$)/i

type DestructiveBlockReason =
  | 'invalid-connection'
  | 'database-not-disposable'
  | 'production-environment'
  | 'missing-destructive-flag'

interface DestructiveDecision {
  readonly allowed: boolean
  /** 解析出的库名；连接串非法时缺省。 */
  readonly databaseName?: string
  readonly reason?: DestructiveBlockReason
  readonly message?: string
}

interface DestructiveEnv {
  readonly NODE_ENV?: string | undefined
  readonly OMB_ALLOW_DESTRUCTIVE?: string | undefined
}

/** 从连接串解析库名；非法 URL/空库名返回 undefined。 */
export function databaseNameOf(connectionString: string): string | undefined {
  try {
    const parsed = new URL(connectionString)
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    return name.length === 0 ? undefined : name
  } catch {
    return undefined
  }
}

export function isDisposableDatabaseName(name: string): boolean {
  return DISPOSABLE_DATABASE_NAME.test(name)
}

/**
 * 破坏性操作（清库/truncate）是否允许。
 *
 * 三道门，只能收紧不能放宽：
 * 1. 库名必须含独立的 `test`/`bench` 段 —— `omb`、`omb_prod` 永远拒绝；
 * 2. `NODE_ENV=production` 无条件拒绝，`OMB_ALLOW_DESTRUCTIVE=1` 也救不回来；
 * 3. 非 vitest 场景（NODE_ENV 不是 `test`）必须显式 `OMB_ALLOW_DESTRUCTIVE=1`，
 *    避免 bench/脚本在误配的库上直接清库。
 */
export function destructiveAllowed(
  connectionString: string,
  env: DestructiveEnv = process.env,
): DestructiveDecision {
  const databaseName = databaseNameOf(connectionString)
  if (databaseName === undefined) {
    return {
      allowed: false,
      reason: 'invalid-connection',
      message: '拒绝破坏性操作：连接串缺少可识别的数据库名',
    }
  }
  if (!isDisposableDatabaseName(databaseName)) {
    return {
      allowed: false,
      databaseName,
      reason: 'database-not-disposable',
      message: `拒绝破坏性操作：数据库 ${databaseName} 不是可抛弃的测试/基准库（名称必须含 test/bench 段）`,
    }
  }
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase()
  if (nodeEnv === 'production') {
    return {
      allowed: false,
      databaseName,
      reason: 'production-environment',
      message: `拒绝破坏性操作：NODE_ENV=production 时禁止清库（数据库 ${databaseName}）`,
    }
  }
  const explicit = (env.OMB_ALLOW_DESTRUCTIVE ?? '').trim() === '1'
  if (!explicit && nodeEnv !== 'test') {
    return {
      allowed: false,
      databaseName,
      reason: 'missing-destructive-flag',
      message: `拒绝破坏性操作：数据库 ${databaseName} 需要 NODE_ENV=test 或 OMB_ALLOW_DESTRUCTIVE=1`,
    }
  }
  return { allowed: true, databaseName }
}

/** `truncateAll` 在建立连接之前调用：任何未授权路径都在碰数据库前失败。 */
export function assertDestructiveAllowed(connectionString: string, env: DestructiveEnv = process.env): string {
  const decision = destructiveAllowed(connectionString, env)
  if (!decision.allowed) {
    const error = new Error(decision.message ?? '拒绝破坏性操作')
    error.name = 'DestructiveOperationBlocked'
    throw error
  }
  return decision.databaseName as string
}
