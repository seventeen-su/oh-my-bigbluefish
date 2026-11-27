import type { ProjectionLag } from './types.js'

/**
 * 投影运行期契约：worker/read/tasks 与 PostgreSQL 适配器共享的观测形状与依赖注入面。
 *
 * - `ProjectionTotals`/`ProjectionStats`：一次 tick/一次状态查询的计数（omb_status 读它）；
 * - `ProjectionLogger`：worker 的可注入日志端口；
 * - `ProjectionWakeSource`：NOTIFY/LISTEN 只负责“叫醒”，不是队列本身；
 * - `ProjectionTransaction`：不透明事务句柄，app 只转交适配器、不解释类型。
 *
 * 任务/看板的数据形状在 `types.ts`，这里只放运行期共享面，避免一个文件同时承载两者。
 */

/** 一次 worker 运行累计的计数，便于 omb_status 暴露“投影是否在动”。 */
export interface ProjectionTotals {
  readonly claimed: number
  readonly projected: number
  readonly retried: number
  readonly dead: number
  readonly released: number
  /** CAS 失败：租约已被其它 worker 接管，本 worker 没有写结果。 */
  readonly lost: number
  /** 投影成功但水位推进失败：读模型已是新值，只是观测指标落后。 */
  readonly watermarkErrors: number
}

export interface ProjectionStats extends ProjectionTotals {
  readonly byProjection: readonly ProjectionLag[]
  /** 最近一次投影/水位错误；成功不会清除它，便于 omb_status 暴露问题。 */
  readonly lastError?: string
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
