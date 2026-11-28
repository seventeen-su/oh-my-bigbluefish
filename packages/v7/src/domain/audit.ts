import type { Entity, Scope } from './entity.js'
import { scopeOf } from './entity-access.js'
import type { JsonValue } from './json.js'
import type { ProjectIdentity } from './project-identity.js'

/**
 * 审计 actor/source 的规范模型与越权判定（OMB 7.2.4）。
 *
 * 威胁模型：`omb_*` 工具的参数来自模型，是**不可信输入**；审计里的 actor/source
 * 只能由宿主执行上下文（session、project identity）或服务端派生，不能由工具参数
 * 自称。actor 决定写入者信任分与冲突差异里的 `actor`，伪造 actor 等于伪造权限，
 * 所以这里把「谁、以什么来源、对哪个作用域」做成可机械验证的纯函数：
 *
 * - `actor`：实际发起动作的身份（`user` / `assistant` / `tool` / `job` / `system`）；
 *   `model` 与 `external` 是 7.1 及以前的历史别名，读旧行时继续识别，新工具写入
 *   一律用 `assistant` / `tool`；
 * - `source`：授权/调用来源（`tool:omb_admin`、`job:forget`、`system:refresh`），
 *   与实体内容来源 `entity.origin` 分开，后台刷新不会篡改实体出处；
 * - `tenant`：当前会话的项目作用域（projectId + 旧路径别名）。项目实体只能被
 *   同项目会话操作；global 实体按全局共享语义允许；作用域无法证明时拒绝（fail-closed）。
 *
 * 本模块只做纯判定，不读库、不写审计；DB 读取在 adapters/postgres/writer-audit.ts，
 * 审计落库由调用方在同一事务或 `recordAudit` 里完成。
 */

/**
 * 审计 actor 类别。
 *
 * `model`/`external` 保留给 7.1 历史行与后台摄取：`model` 与 `assistant` 语义相同
 * （模型/助手动作），`external` 表示外部来源内容，不能由工具参数声明。
 */
export const AUDIT_ACTOR_KINDS = [
  'user',
  'assistant',
  'model',
  'tool',
  'job',
  'system',
  'external',
] as const

export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number]

/** `actor` 列上限：审计列是 text，但 actor id 会被日志/工具结果引用，必须有界。 */
const ACTOR_ID_MAX = 160
/** session id 拼接进 actor id，控制字符不能带进审计/日志文本。 */
const UNSAFE_ACTOR_CHARS = /[^\w.:@+-]+/gu

export interface AuditActor {
  readonly id: string
  readonly kind: AuditActorKind
}

/** 把任意字符串规范化为可写审计的 actor id；空值落到 `unknown`，不让空 actor 通过。 */
export function sanitizeActorId(value: string, fallback = 'unknown'): string {
  const normalized = value.trim().replace(UNSAFE_ACTOR_CHARS, '-').replace(/^-+|-+$/gu, '')
  const bounded = normalized.length > ACTOR_ID_MAX ? normalized.slice(0, ACTOR_ID_MAX) : normalized
  return bounded.length > 0 ? bounded : fallback
}

/**
 * actor/来源字符串 → actor 类别。
 *
 * 未知来源按 `model` 处理（与 7.1 一致）：内容自称 `system` 但不在已知命名空间时
 * 不能靠字符串提权。`assistant`/`tool` 是 7.2.4 起的显式类别。
 */
export function auditActorKindOf(value: string | undefined): AuditActorKind {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'user' || normalized.startsWith('user:') || normalized.startsWith('user/')) return 'user'
  if (normalized === 'assistant' || normalized.startsWith('assistant:') || normalized.startsWith('assistant/')) {
    return 'assistant'
  }
  if (normalized === 'tool' || normalized.startsWith('tool:') || normalized.startsWith('tool/')) return 'tool'
  if (normalized === 'job' || normalized.startsWith('job:') || normalized.startsWith('job/')) return 'job'
  if (normalized === 'system' || normalized.startsWith('system:') || normalized.startsWith('system/')) return 'system'
  if (normalized === 'external' || normalized.startsWith('external:')) return 'external'
  if (normalized === 'model' || normalized.startsWith('model:') || normalized.startsWith('model/')) return 'model'
  return 'model'
}

/**
 * 当前会话可信的作用域边界。
 *
 * `aliases` 包含稳定 `projectId` 与迁移前写进 `scope.project_key` 的旧路径键：
 * 升级前写入的项目实体仍然要能被同项目会话操作，否则收紧权限会把历史数据锁死。
 */
export interface AuditTenant {
  readonly projectKey: string
  readonly aliases: readonly string[]
}

interface TenantInput {
  readonly projectKey?: string
  /** 组合根解析出的稳定项目身份；旧调用/测试没有 identity 时只用 projectKey。 */
  readonly projectIdentity?: Pick<ProjectIdentity, 'projectId' | 'legacyProjectKeys'>
}

/**
 * 从宿主上下文派生租户边界；缺 projectKey 时返回 undefined（只能操作 global 实体）。
 * 同仓库不同 worktree/分支得到同一个 projectId，因此仍共享同一租户。
 */
export function auditTenantOf(input: TenantInput): AuditTenant | undefined {
  const canonical = (input.projectKey ?? input.projectIdentity?.projectId ?? '').trim()
  if (canonical.length === 0) return undefined
  const aliases = new Set<string>([canonical])
  for (const key of input.projectIdentity?.legacyProjectKeys ?? []) {
    const normalized = key.trim()
    if (normalized.length > 0) aliases.add(normalized)
  }
  return { projectKey: canonical, aliases: [...aliases].sort() }
}

/** 审计身份：actor + 授权来源 + 会话/租户；工具路径由宿主上下文派生。 */
export interface AuditPrincipal {
  readonly actor: AuditActor
  readonly source: string
  readonly sessionId: string
  readonly tenant?: AuditTenant
}

/** 服务端需要知道「哪些操作被允许」时的显式授权参数。 */
export interface AuditAuthorization {
  /** 写进 `audit_log.source` 的调用来源，如 `tool:omb_admin`。 */
  readonly source?: string
  /** 调用方租户；提供时回滚在适配器层也会做越权校验。 */
  readonly tenant?: AuditTenant
}

/** 一条实体作用域事实；`scope` 缺失表示无法证明归属（fail-closed）。 */
export interface EntityScopeFact {
  readonly id: string
  readonly scope?: Scope
}

export function entityScopeFact(entity: Entity): EntityScopeFact {
  return { id: entity.id, scope: scopeOf(entity) }
}

/** 越权拒绝原因；进审计 `after.reason` 与错误 details，便于计数与排查。 */
export type AuditDenyReason =
  | 'cross-project'
  | 'unknown-tenant'
  | 'unknown-target'
  | 'denied-audit'
  | 'unverifiable-target'

export type AuditAccessDecision =
  | { readonly allowed: true }
  | {
    readonly allowed: false
    readonly reason: AuditDenyReason
    readonly message: string
    readonly targetIds: readonly string[]
  }

const ALLOWED: AuditAccessDecision = { allowed: true }

function deny(reason: AuditDenyReason, message: string, targetIds: readonly string[]): AuditAccessDecision {
  return { allowed: false, reason, message, targetIds }
}

/**
 * 单个作用域是否落在租户内：
 * - global 是共享知识，所有会话可读可写（写入仍留 actor/source 审计）；
 * - project 必须命中稳定 projectId 或其旧路径别名；
 * - 缺租户时只能全局，项目实体一律拒绝（不知道调用方是谁就不能猜）。
 */
export function scopeAccessOf(scope: Scope, tenant: AuditTenant | undefined): 'global' | 'tenant' | 'foreign' {
  if (scope.kind === 'global') return 'global'
  if (tenant === undefined) return 'foreign'
  return tenant.aliases.includes(scope.projectKey) ? 'tenant' : 'foreign'
}

/**
 * 一组实体是否都可被当前租户操作。
 *
 * 空集合视为允许（没有目标就没有越权对象）；调用方仍应只在真的需要实体授权时
 * 传入目标 id，不能把“没有目标”当成“检查通过”的默认路径。
 */
export function entityAccessDecision(
  tenant: AuditTenant | undefined,
  targets: readonly EntityScopeFact[],
): AuditAccessDecision {
  const foreign: string[] = []
  const unknown: string[] = []
  for (const target of targets) {
    if (target.scope === undefined) {
      unknown.push(target.id)
      continue
    }
    if (scopeAccessOf(target.scope, tenant) === 'foreign') foreign.push(target.id)
  }
  if (foreign.length > 0) {
    const scope = tenant === undefined ? '当前会话未解析出项目作用域' : `当前会话项目 ${tenant.projectKey}`
    return deny(
      tenant === undefined ? 'unknown-tenant' : 'cross-project',
      `越权操作被拒绝：${foreign.join(', ')} 不在${scope}的作用域内`,
      foreign,
    )
  }
  if (unknown.length > 0) {
    return deny(
      'unknown-target',
      `越权操作被拒绝：无法证明目标实体 ${unknown.join(', ')} 的归属作用域`,
      unknown,
    )
  }
  return ALLOWED
}

/** 回滚权限判定需要的最小审计事实；由 writer-audit 从 audit_log 读出。 */
export interface AuditRollbackFacts {
  readonly id: number
  readonly action: string
  readonly actor: string
  readonly actorKind?: string | null
  readonly source?: string | null
  readonly targetIds: readonly string[]
}

/**
 * 回滚是否允许。
 *
 * 与普通写入的区别：回滚的目标不是“当前实体”，而是**审计当时的目标集合**，因此
 * 必须用审计行的 target_ids 重新证明租户边界；任一条目标落在项目外、或目标无法
 * 解析，就拒绝。`denied` 行是越权拒绝事实，本身不可回滚（避免用回滚抹掉拒绝证据）。
 *
 * `tenant` 由工具路径/适配器层传入；缺省时按 `entityAccessDecision` 的 fail-closed
 * 语义处理（项目实体拒绝、global 仍可），不会因为“没解析出项目”就放行。
 * 旧测试/后台入口在适配器层不提供 tenant，此时适配器不调用本函数，语义保持旧行为。
 */
export function rollbackAccessDecision(input: {
  readonly facts: AuditRollbackFacts
  readonly targets: readonly EntityScopeFact[]
  readonly tenant: AuditTenant | undefined
}): AuditAccessDecision {
  if (input.facts.action === 'denied') {
    return deny('denied-audit', '越权拒绝记录不可回滚（会抹掉拒绝证据）', [...input.facts.targetIds])
  }
  if (input.facts.targetIds.length === 0) {
    return deny('unverifiable-target', '越权回滚被拒绝：审计没有可验证的目标实体', [])
  }
  const scoped = new Map(input.targets.map(target => [target.id, target.scope]))
  const facts: EntityScopeFact[] = input.facts.targetIds.map(id => ({ id, scope: scoped.get(id) }))
  return entityAccessDecision(input.tenant, facts)
}

/** 审计里用于回溯授权的来源前缀；工具来源必须是 `tool:*`，后台是 `job:*`/`system:*`。 */
export function isToolSource(source: string | null | undefined): boolean {
  return (source ?? '').trim().toLowerCase().startsWith('tool:')
}

/** 越权拒绝审计行的固定 action；计数用 `action='denied'`，不参与业务回滚。 */
export const AUDIT_DENIED_ACTION = 'denied'

/** 越权拒绝审计的 `after` 载荷（不含被拒绝写入的正文）。 */
export interface AuditDeniedPayload {
  readonly operation: string
  readonly reason: AuditDenyReason | string
  readonly sessionId?: string
  readonly tenantProjectKey?: string
  /** 工具参数里自称的 actor/source；只保留短字符串，便于识别伪造手法。 */
  readonly claimed?: string
  readonly detail?: JsonValue
}
