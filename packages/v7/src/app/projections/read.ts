import type { Scope } from '../../domain/entity.js'
import type { Clock } from '../../ports/clock.js'
import type { ProjectionToken } from '../commands/types.js'
import type { ProjectionTaskStore } from './tasks.js'
import type {
  BoardItem,
  BoardKind,
  BoardSnapshot,
  ProjectionLag,
  ProjectionName,
} from './types.js'
import type { ProjectionWakeSource } from './contracts.js'
import { PROJECTION_NAMES, projectionOfBoard } from './types.js'

/**
 * 看板读模型 + read-your-writes（ARCHITECTURE-PLAN §4.4、CONCURRENCY §4.4）。
 *
 * 读纪律：
 * - 不带 token：直接读读模型（T0 常驻注入的快路径）。
 * - 带 token：等到“该实体该投影已经处理到 token.revision”再读读模型；判据是
 *   任务行 `done`（revision 已覆盖）或读模型行 revision 已覆盖。等待由 NOTIFY 唤醒，
 *   并有硬 deadline——**绝不静默返回旧行**。
 * - 超时后二选一：默认回退到写模型（entity/attribute 现算，数据是新的，`source:'write-model'`）；
 *   或显式要求 `stale`，返回读模型旧行并标 `stale:true` + 缺失的 revision，让调用方决定。
 */
export interface BoardQuery {
  readonly kind: BoardKind
  readonly scope: Scope
  readonly projectKey?: string
  readonly limit: number
}

/**
 * T0 常驻层的一次性取数：偏好看板 + 状态看板各一条 SQL。
 *
 * 与 `boards()` 的区别：不带 lag 查询、不等 token、不按 onTimeout 回退。T0 的读预算
 * 是 ≤5 条 SQL（用读模型时 ≤2 条），lag/token 等待与回退决策留给调用方
 * （`recall/resident.ts` 的 buildResident 决定回退并写 trace）。
 */
export interface ResidentBoardPairQuery {
  readonly projectKey?: string
  readonly preferenceLimit?: number
  readonly stateLimit?: number
}

/** 两块看板的行；`state` 在调用方没有 projectKey 时为空（状态板只按项目读）。 */
export interface ResidentBoardPair {
  readonly preference: readonly BoardItem[]
  readonly state: readonly BoardItem[]
}

export interface BoardReader {
  readBoard(query: BoardQuery): Promise<readonly BoardItem[]>
  readBoardRow(kind: BoardKind, entityId: string): Promise<BoardItem | undefined>
  /** 超时回退：与投影同一套派生 SQL，直接读 entity/attribute。 */
  deriveFromWriteModel(query: BoardQuery & { readonly entityId?: string }): Promise<readonly BoardItem[]>
}

export interface ProjectionReadDeps {
  readonly store: ProjectionTaskStore
  readonly boards: BoardReader
  readonly clock: Clock
  /** NOTIFY/LISTEN；只用于缩短等 token 的延迟，丢了也会在 deadline 时正确回退。 */
  readonly wake?: ProjectionWakeSource
}

export type ProjectionReadFallback = 'write-model' | 'stale'

export interface ProjectionReadOptions {
  /** 写命令返回的 token；给定时先等对应投影追上这一版。 */
  readonly token?: ProjectionToken
  /** 等 token 的上限；默认 1000ms，0 表示只做一次检查。 */
  readonly timeoutMs?: number
  /** 超时策略，默认 'write-model'：回退写模型；'stale'：返回旧读模型并标 stale。 */
  readonly onTimeout?: ProjectionReadFallback
  readonly limit?: number
}

export interface ReadTokenOutcome {
  readonly ok: boolean
  readonly stale: boolean
  readonly waitedMs: number
  readonly revision: number
  readonly projection: ProjectionName
  readonly token: ProjectionToken
}

const DEFAULT_READ_TIMEOUT_MS = 1_000
const MAX_READ_TIMEOUT_MS = 30_000
const MAX_BOARD_LIMIT = 100

export class ProjectionReadApi {
  private unsubscribe: (() => void) | undefined
  private readonly waiters = new Set<() => void>()

  constructor(private readonly deps: ProjectionReadDeps) {}

  /**
   * 读看板。带 token 时优先等投影；超时按 `onTimeout` 回退或标 stale。
   *
   * 回退到写模型的意义：队列可能还在退避/积压，但读调用方刚写完就要看到自己的数据，
   * 这时从 `entity/attribute` 现算比等投影更快，也不违反“不静默旧读”。
   */
  async boards(kind: BoardKind, scope: Scope, options: ProjectionReadOptions = {}): Promise<BoardSnapshot> {
    const limit = clamp(options.limit ?? 20, 1, MAX_BOARD_LIMIT)
    const query: BoardQuery = {
      kind,
      scope,
      limit,
      ...(scope.kind === 'project' ? { projectKey: scope.projectKey } : {}),
    }
    const projection = projectionOfBoard(kind)
    const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS, 0, MAX_READ_TIMEOUT_MS)
    const startedAt = this.deps.clock.now().getTime()

    if (options.token !== undefined) {
      const outcome = await this.waitForToken(options.token, kind, timeoutMs)
      if (!outcome.ok) {
        const lag = await this.lagOf(projection)
        const token = options.token
        if (options.onTimeout === 'stale') {
          const items = await this.deps.boards.readBoard(query)
          return this.snapshot(kind, projection, scope, items, 'read-model', true, lag, outcome.waitedMs, token)
        }
        try {
          const items = await this.deps.boards.deriveFromWriteModel(query)
          return this.snapshot(kind, projection, scope, items, 'write-model', false, lag, outcome.waitedMs, token)
        } catch {
          // 写模型回退也失败时，唯一诚实的选项是返回标了 stale 的读模型行。
          const items = await this.deps.boards.readBoard(query)
          return this.snapshot(kind, projection, scope, items, 'read-model', true, lag, outcome.waitedMs, token)
        }
      }
    }

    const items = await this.deps.boards.readBoard(query)
    const lag = await this.lagOf(projection)
    const waitedMs = this.deps.clock.now().getTime() - startedAt
    return this.snapshot(kind, projection, scope, items, 'read-model', false, lag, waitedMs, options.token)
  }

  /**
   * T0 常驻层专用：一次读偏好/状态两块看板，每块恰好一条 SQL，不查 lag、不等 token。
   *
   * 空结果/读取失败不在这里判断（也不静默）——调用方拿到异常或空行后自行决定
   * 回退写模型并把来源写进 trace；这样一来 RYOW（read-your-writes）的等待语义
   * 不会被 T0 误用成"每 turn 多查一次 lag"。
   *
   * `ProjectionReadApi` 结构性满足 `recall/resident.ts` 的 `ResidentBoardsReader`
   * （消费方定义的窄端口，不必 import 本模块的完整类型）。
   */
  async readResidentBoards(query: ResidentBoardPairQuery = {}): Promise<ResidentBoardPair> {
    const preferenceLimit = clamp(query.preferenceLimit ?? 5, 1, MAX_BOARD_LIMIT)
    const stateLimit = clamp(query.stateLimit ?? 5, 1, MAX_BOARD_LIMIT)
    const preference = this.deps.boards.readBoard({
      kind: 'preference',
      scope: { kind: 'global' },
      limit: preferenceLimit,
    })
    // 没有项目键就没有"当前项目状态"可读：不发第二条无谓查询。
    const state = query.projectKey === undefined
      ? Promise.resolve<readonly BoardItem[]>([])
      : this.deps.boards.readBoard({
          kind: 'state',
          scope: { kind: 'project', projectKey: query.projectKey },
          limit: stateLimit,
        })
    const [preferenceItems, stateItems] = await Promise.all([preference, state])
    return { preference: preferenceItems, state: stateItems }
  }

  /**
   * 只等 token，不读看板：供调用方在别处读、或只需要“投影是否追上”的判定。
   * 超时返回 `ok:false, stale:true`——这时读模型的行是已知落后的。
   */
  async awaitToken(
    token: ProjectionToken,
    options: { readonly kind: BoardKind; readonly timeoutMs?: number },
  ): Promise<ReadTokenOutcome> {
    const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS, 0, MAX_READ_TIMEOUT_MS)
    return this.waitForToken(token, options.kind, timeoutMs)
  }

  /** 全部投影的 lag；供 omb_status/T2 结构化响应。 */
  async lag(): Promise<readonly ProjectionLag[]> {
    const rows = await this.deps.store.lag()
    return PROJECTION_NAMES.map(name => rows.find(item => item.projection === name) ?? emptyLag(name))
  }

  async close(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.resolveWaiters()
  }

  private async waitForToken(token: ProjectionToken, kind: BoardKind, timeoutMs: number): Promise<ReadTokenOutcome> {
    const projection = projectionOfBoard(kind)
    const startedAt = this.deps.clock.now().getTime()
    const deadline = startedAt + timeoutMs
    this.ensureSubscribed()
    for (;;) {
      const remaining = deadline - this.deps.clock.now().getTime()
      if (remaining <= 0) {
        // deadline 前最后再查一次：任务恰好在等待窗口末尾完成时不该被判 stale。
        const revision = await this.tokenProgress(token, projection)
        return {
          ok: revision > 0,
          stale: revision === 0,
          waitedMs: this.deps.clock.now().getTime() - startedAt,
          revision,
          projection,
          token,
        }
      }
      const waker = this.beginWait(remaining)
      try {
        const revision = await this.tokenProgress(token, projection)
        if (revision > 0) {
          return {
            ok: true,
            stale: false,
            waitedMs: this.deps.clock.now().getTime() - startedAt,
            revision,
            projection,
            token,
          }
        }
        await waker.promise
      } finally {
        waker.cancel()
      }
    }
  }

  /**
   * 返回已覆盖 token 的 revision（>0 表示追上），0 表示还没到这一版。
   * 任务行 done 优先（即使看板行已被删除，例如归档/不再满足条件也算处理完）。
   */
  private async tokenProgress(token: ProjectionToken, projection: ProjectionName): Promise<number> {
    const state = await this.deps.store.taskState(token.entityId, projection)
    if (state !== undefined && state.status === 'done' && state.revision >= token.revision) return state.revision
    const kind = boardKindOf(projection)
    if (kind === undefined) return 0
    const row = await this.deps.boards.readBoardRow(kind, token.entityId)
    return row !== undefined && row.revision >= token.revision ? row.revision : 0
  }

  private beginWait(remainingMs: number): { promise: Promise<void>; cancel: () => void } {
    let finish = (): void => {}
    const promise = new Promise<void>(resolve => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(listener)
        resolve()
      }
      const timer = setTimeout(settle, Math.max(0, remainingMs))
      const listener = (): void => settle()
      this.waiters.add(listener)
      finish = listener
    })
    return { promise, cancel: () => finish() }
  }

  private resolveWaiters(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resolve of waiters) resolve()
  }

  private ensureSubscribed(): void {
    if (this.unsubscribe !== undefined || this.deps.wake === undefined) return
    try {
      this.unsubscribe = this.deps.wake.subscribe(() => this.resolveWaiters())
    } catch {
      this.unsubscribe = undefined
    }
  }

  private async lagOf(projection: ProjectionName): Promise<ProjectionLag> {
    const rows = await this.deps.store.lag()
    return rows.find(item => item.projection === projection) ?? emptyLag(projection)
  }

  private snapshot(
    kind: BoardKind,
    projection: ProjectionName,
    scope: Scope,
    items: readonly BoardItem[],
    source: 'read-model' | 'write-model',
    stale: boolean,
    lag: ProjectionLag,
    waitedMs: number,
    token: ProjectionToken | undefined,
  ): BoardSnapshot {
    const revision = items.reduce((max, item) => Math.max(max, item.revision), 0)
    return {
      kind,
      projection,
      items,
      source,
      stale,
      revision,
      lag,
      waitedMs,
      ...(lag.watermark !== undefined ? { watermark: lag.watermark } : {}),
      ...(token !== undefined ? { token } : {}),
    }
  }
}

function boardKindOf(projection: ProjectionName): BoardKind | undefined {
  if (projection === 'preference_board') return 'preference'
  if (projection === 'state_board') return 'state'
  return undefined
}

function emptyLag(projection: ProjectionName): ProjectionLag {
  return { projection, pending: 0, claimed: 0, dead: 0, due: 0, oldestDueAgeMs: 0 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
