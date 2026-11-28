import type { AttributeValue, RawAttributeValue } from './dynamic-spec.js'
import type { EntityLifecycle } from './lifecycle.js'

/**
 * 实体聚合的稳定契约：kind/category/status 词表、scope、属性与实体形状、写入输入。
 *
 * 动态值 spec 在 `dynamic-spec.ts`，从属性读值的访问器在 `entity-access.ts`，
 * 校验结果在 `validation-result.ts`：本文件只放「一条实体是什么」。
 */

export type EntityKind = 'memory' | 'state' | 'chain' | 'state_version'

export const CATEGORIES = ['fact', 'clue', 'event'] as const
export type Category = (typeof CATEGORIES)[number]
export const CATEGORY_LABELS: Record<Category, string> = {
  fact: '事实',
  clue: '线索',
  event: '事件',
}

export const STATE_STATUSES = ['completed', 'in_progress', 'waiting', 'blocked', 'not_started', 'discarded'] as const
export type StateStatus = (typeof STATE_STATUSES)[number]
export const STATUS_LABELS: Record<StateStatus, string> = {
  completed: '已完成',
  in_progress: '进行中',
  waiting: '等待中',
  blocked: '阻塞中',
  not_started: '未开启',
  discarded: '已丢弃',
}

export type Scope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectKey: string }

export interface Attribute {
  readonly name: string
  readonly ordinal: number
  readonly value: AttributeValue
  readonly required: boolean
  readonly confidence?: number
  readonly source: string
}

export interface Entity {
  readonly id: string
  readonly kind: EntityKind
  readonly revision: number
  readonly origin: string
  readonly confidence?: number
  readonly pinned: boolean
  readonly salience: number
  readonly accessCount: number
  /**
   * 旧口径采用计数（字符串命中即 adopted）。只为兼容读保留；
   * 重排/遗忘不再使用，新逻辑读 `utilityConfidence` / `refutationRate`。
   */
  readonly adoptionCount: number
  /**
   * 使用机会的 Beta-Binomial 平滑效用置信度（0–1，不是 adoptionRate）。
   * 只由 store 读路径按 adoption_metric 的计数计算；无使用机会时缺省。
   */
  readonly utilityConfidence?: number
  /** 被用户否定/证伪的机会占比（0–1）；>0 时才进入负向先验。 */
  readonly refutationRate?: number
  readonly lastAccessedAt?: string
  readonly archivedAt?: string
  readonly archiveReason?: string
  /**
   * 内容真值状态（active/superseded/retracted/archived）。与 `archivedAt` 语义分开：
   * 归档只影响可见性/保留，取代与证伪是内容生命周期；`validFrom`/`validTo` 是有效期。
   */
  readonly lifecycle: EntityLifecycle
  /** 当前取代者（旧事实被它取代）；只有 `lifecycle='superseded'` 时存在。 */
  readonly supersededBy?: string
  readonly supersededAt?: string
  readonly supersedeReason?: string
  /** 被证伪的时间与原因；只有 `lifecycle='retracted'` 时存在。 */
  readonly retractedAt?: string
  readonly retractedReason?: string
  /** 有效期起点（创建时写入；回填旧数据为 created_at）。 */
  readonly validFrom?: string
  /** 有效期终点（取代/证伪生效时间）；仍在生效时缺省。 */
  readonly validTo?: string
  readonly versionOf?: string
  readonly isCurrent: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly historyCount?: number
  readonly attributes: readonly Attribute[]
}

interface WriteBase {
  readonly id?: string
  readonly scope: Scope
  readonly attrs?: Readonly<Record<string, RawAttributeValue>>
  readonly origin?: string
  readonly confidence?: number
  readonly pinned?: boolean
}

interface WriteMemory extends WriteBase {
  readonly kind: 'memory'
  readonly category: Category
}

interface WriteState extends WriteBase {
  readonly kind: 'state'
  readonly title: string
  readonly status: StateStatus
  readonly time: string
}

interface WriteChain extends WriteBase {
  readonly kind: 'chain'
  readonly title: string
  readonly group: readonly string[]
}

export type WriteEntityInput = WriteMemory | WriteState | WriteChain

export interface PatchEntityInput {
  readonly id: string
  readonly expectedRevision?: number
  readonly attrs?: Readonly<Record<string, RawAttributeValue | null>>
  readonly title?: string
  readonly status?: StateStatus
  readonly time?: string
  readonly category?: Category
  readonly group?: readonly string[]
  readonly pinned?: boolean
  readonly confidence?: number
  /** 本次写入来源；缺省保留实体已有 origin，避免后台修改把 model 误标成 job 或反之。 */
  readonly origin?: string
}

export interface StateVersion {
  readonly id: string
  readonly stateId: string
  readonly revision: number
  readonly status: StateStatus
  readonly title: string
  readonly time: string
  readonly attributes: readonly Attribute[]
  readonly archivedAt?: string
  readonly createdAt: string
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

export function isStateStatus(value: unknown): value is StateStatus {
  return typeof value === 'string' && (STATE_STATUSES as readonly string[]).includes(value)
}
