/**
 * 会话时空状态机的结构化快照（`SERVICES.sessionState = 'omb:session-state'`）。
 *
 * 由 `dsh/state-machine.ts` 的 `SessionSituation` 实现、经内核服务提供；
 * 模块层只依赖本文件的**结构最小面**（AGENTS.md 不变量 1：模块不得 import 宿主）。
 * 字段与 `dsh/state-machine.ts:172-226` 逐字对应；新增字段先加这里再改实现。
 */
export type SessionSituationState = 'active' | 'idle' | 'stale' | 'recovering'

export interface SessionSituationEpoch {
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
  readonly externalChanges?: number
  readonly instructions?: string | null
}

export interface SessionSituationRead {
  readonly path: string
  readonly status: 'same' | 'changed' | 'unknown'
  readonly hash: string | null
}

export interface SessionSituationSideEffects {
  readonly blindWrites: number
  readonly staleWrites: number
  readonly denies: number
  readonly gaveUps: number
  readonly unverifiable: number
  readonly shellWrites: number
  readonly shellUnknown: number
  readonly shellInferred: number
  readonly otherSessionWrites: number
}

export interface SessionSituationView {
  readonly sessionId: string
  readonly cwd: string | null
  readonly state: SessionSituationState
  readonly tier: string
  readonly turn: number
  readonly step: number
  readonly lastEventAt: number | null
  readonly idleMs: number | null
  readonly lastTurnEndReason: string | null
  readonly interrupted: boolean
  readonly unresolved: boolean
  readonly goals: { readonly open: number; readonly total: number }
  readonly todos: { readonly open: number; readonly total: number }
  readonly epoch: SessionSituationEpoch | null
  readonly reads: {
    readonly count: number
    readonly changed: number
    readonly unknown: number
    readonly entries: readonly SessionSituationRead[]
  }
  readonly sideEffects: SessionSituationSideEffects
  readonly workspace?: {
    readonly root: string
    readonly cwd: string
    readonly since: number
    readonly switches: number
    readonly previousRoot: string | null
  }
}

/** `SERVICES.sessionState` 的最小读面。 */
export interface SessionStatePort {
  /** 未知会话返回 undefined（**不创建**）；同步、只读、绝不抛。 */
  situation?(sessionId: string): SessionSituationView | undefined
}
