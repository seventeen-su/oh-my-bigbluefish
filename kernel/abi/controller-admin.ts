/**
 * 记忆控制器管理端口（v4.19.0）：**用户手动编辑**控制器状态机。
 *
 * 背景：控制器（`modules/memory/controller.ts`）的状态原本只由宿主事件推进；
 * 用户要求"状态机等也应当应用手动编辑"——任务约束与候选表要能在设置页里增删清。
 *
 * 边界：
 * - 这是**用户自己的设置页**的数据面的一部分。模型工具没有入口；写操作只来自
 *   `POST /omb/api/controller`（用户点击），不是模型路径；
 * - ABI **不能 import `modules/`**，所以这里定义一份结构化最小接口；模块内的
 *   `ControllerSessionState`（含 `transition`）结构上满足 `ControllerAdminState`
 *   （多的字段不参与契约）；
 * - `state/read` 只读、同步、绝不抛；`edit` 不创建不存在的会话（返回空状态），
 *   校验失败原样返回当前状态，绝不抛。
 */

/** 控制器阶段（与 `modules/memory/controller.ts` 的 `ControllerPhase` 同一取值域）。 */
export type ControllerAdminPhase = 'idle' | 'candidate-pending' | 'tracking-tasks' | 'mixed'

/** 一条任务约束（临时；TTL 由控制器模块决定）。 */
export interface ControllerAdminTask {
  readonly text: string
  readonly at: number
  readonly expiresAt: number
}

/** 一条候选（等待确认/写入；`reason` 是控制器给出的可读判据）。 */
export interface ControllerAdminCandidate {
  readonly id: string
  readonly text: string
  readonly kind: 'semantic' | 'procedural' | 'episodic'
  readonly scope: 'user' | 'project'
  readonly at: number
  readonly reason: string
}

/** 只读快照（不含内部的 `transition`；页面只需要阶段与两张表）。 */
export interface ControllerAdminState {
  readonly candidates: readonly ControllerAdminCandidate[]
  readonly tasks: readonly ControllerAdminTask[]
  readonly lastEventAt: number | null
  readonly phase: ControllerAdminPhase
}

/** 用户手动编辑动作（判别联合；文本校验由模块层做，失败返回原状态）。 */
export type ControllerAdminEdit =
  | { readonly kind: 'add-task'; readonly text: string }
  | { readonly kind: 'remove-task'; readonly text: string }
  | { readonly kind: 'clear-tasks' }
  | { readonly kind: 'remove-candidate'; readonly text: string }
  | { readonly kind: 'clear-candidates' }

/** 服务 `SERVICES.memoryControllerAdmin = 'omb:memory-controller-admin'`。 */
export interface ControllerAdminPort {
  /** 某会话的当前状态；不存在的会话返回 `EMPTY_CONTROLLER_STATE`（**不创建**）。 */
  state(sessionId: string): ControllerAdminState
  /** 应用一次用户编辑；不存在的会话返回空状态、不创建；绝不抛。 */
  edit(sessionId: string, edit: ControllerAdminEdit): ControllerAdminState
}
