import type { StateStatus } from '../../domain/entity.js'
import type { ProjectionToken } from '../commands/types.js'

/**
 * 投影读模型的公共契约（ARCHITECTURE-PLAN §4.4/§5.2、ADR-0008）。
 *
 * 术语：
 * - **投影（projection）**：一个异步读模型，名字与 `008_v7_expand.sql` 的表名一致。
 * - **任务（projection_task）**：写事务内 upsert 的 `(entity_id, projection, revision)`；
 *   worker 按 projection 批量 claim，写读模型，成功后推进 `projection_watermark`。
 * - **水位（watermark）**：该投影**最近一次成功投影的源行 `updated_at`** 的最大值（单调不减）。
 *   它只用于观测 lag；read-your-writes 的精确判据是任务的 revision / 读模型行的 revision。
 *
 * 本模块只依赖 domain 与同层契约；SQL 与连接池在 adapters/postgres/projection.ts。
 */

export const PROJECTION_NAMES = [
  'preference_board',
  'state_board',
  'adoption_stat',
  'co_recall_pair',
  'similar_cache',
] as const

export type ProjectionName = (typeof PROJECTION_NAMES)[number]

/**
 * T0 读取的两种看板。对外用 'preference'/'state'（与 ARCH §4.4 `boards(scope, kind)` 一致），
 * 落表名是 `preference_board`/`state_board`。
 */
export type BoardKind = 'preference' | 'state'

const BOARD_PROJECTIONS: Readonly<Record<BoardKind, ProjectionName>> = {
  preference: 'preference_board',
  state: 'state_board',
}

export function projectionOfBoard(kind: BoardKind): ProjectionName {
  return BOARD_PROJECTIONS[kind]
}

export type ProjectionTaskStatus = 'pending' | 'claimed' | 'done' | 'dead'

/** 一条待投影任务：读模型只关心实体与它对应的写模型版本。 */
export interface ProjectionTask {
  readonly entityId: string
  readonly projection: ProjectionName
  readonly revision: number
}

/** 已 claim 的任务：`attempts` 用于 complete/fail 的 CAS，租约到期前重领不会重置它。 */
export interface ClaimedProjectionTask extends ProjectionTask {
  readonly attempts: number
  /** 本行下一次可被 claim 的时刻（租约内是租约到期时间，退避时是重试时间）。 */
  readonly availableAt: string
}

export interface ProjectionEnqueueInput {
  readonly entityId: string
  readonly projection: ProjectionName
  readonly revision: number
  /** 默认 `now()`；只有补投/测试需要显式指定。 */
  readonly availableAt?: Date
}

export interface ProjectionEnqueueResult {
  readonly entityId: string
  readonly projection: ProjectionName
  readonly revision: number
  readonly status: ProjectionTaskStatus
  /** false 表示同 revision 的任务已存在，没有产生新工作（写命令幂等重放会走这条路）。 */
  readonly changed: boolean
}

/** 任务行的当前状态；read-your-writes 用它判断“这一版已被投影过”。 */
export interface ProjectionTaskState {
  readonly status: ProjectionTaskStatus
  readonly revision: number
}

export interface ProjectionWatermark {
  readonly projection: ProjectionName
  readonly watermark: string
  readonly updatedAt: string
}

/**
 * 单个投影的 lag 快照。
 *
 * - `pending`/`claimed`/`dead`：队列里各状态的行数（与“是否到期”无关）。
 * - `due`：现在就可以被领取的行数（pending 到期 + 租约已过期的 claimed）。
 * - `oldestDueAgeMs`：最老到期行已经等了多久；只算到期未投影的行，在租约内的不算 lag。
 * - `watermark`/`watermarkAgeMs`：最近一次成功投影的源时间与它的年龄；没有成功过则缺省。
 */
export interface ProjectionLag {
  readonly projection: ProjectionName
  readonly pending: number
  readonly claimed: number
  readonly dead: number
  readonly due: number
  readonly oldestDueAgeMs: number
  readonly watermark?: string
  readonly watermarkAgeMs?: number
  readonly updatedAt?: string
}

/** 一次 worker 运行累计的计数，便于 omb_status 暴露“投影是否在动”。 */
export interface ProjectionTotals {
  readonly claimed: number
  readonly projected: number
  readonly retried: number
  readonly dead: number
  readonly released: number
  /** CAS 失败：租约已被其它 worker 接管，本 worker 没有写结果。 */
  readonly lost: number
  /** 投影成功但水位推进失败；读模型已是新值，只是观测指标落后。 */
  readonly watermarkErrors: number
}

export interface ProjectionStats extends ProjectionTotals {
  readonly byProjection: readonly ProjectionLag[]
  /** 最近一次投影/水位错误；成功不会清除它，便于 omb_status 暴露问题。 */
  readonly lastError?: string
}

/**
 * 一条读模型行的统一形状。preference 用 salience/summary，state 用 status/projectKey/eventTime；
 * 所有行都带 `revision`，read-your-writes 就靠它判断是否已覆盖 token。
 */
export interface BoardItem {
  readonly entityId: string
  readonly title?: string
  readonly summary?: string
  readonly salience?: number
  readonly status?: StateStatus
  readonly projectKey?: string
  readonly eventTime?: string
  readonly revision: number
  readonly updatedAt: string
}

/** 一次看板读取的结果；`source` 与 `stale` 必须显式回答“这份数据够不够新”。 */
export interface BoardSnapshot {
  readonly kind: BoardKind
  readonly projection: ProjectionName
  readonly items: readonly BoardItem[]
  /** read-model：读模型；write-model：超时后回退到的写模型（entity/attribute 现算）。 */
  readonly source: 'read-model' | 'write-model'
  /** true 表示返回的是**已知落后**读模型的行；禁止把它当最新数据静默使用。 */
  readonly stale: boolean
  /** 返回行里最大的 revision（0 表示空）。 */
  readonly revision: number
  readonly watermark?: string
  readonly lag: ProjectionLag
  /** 本次读取为等 token 花了多久。 */
  readonly waitedMs: number
  readonly token?: ProjectionToken
}

/** NOTIFY/LISTEN 之类只负责“叫醒”，不是队列本身。 */
export interface ProjectionWakeSource {
  subscribe(listener: () => void): () => void
}

export interface ProjectionLogger {
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}

/** 不透明事务句柄：app 只把它转交给适配器，不解释其类型。 */
export type ProjectionTransaction = unknown
