/**
 * T1 会话态与注入账本：全部按 sessionId 键控，session/disposed 与插件卸载时清理（RET-13/RUN-05）。
 *
 * 这里只保存「本进程里一次会话的短期状态」和注入证据（receipt 落 `omb.resident_trace`）；
 * 召回判定在 `t1.ts`（纯函数），装配点在 `hooks.ts`，检索在 retrieval/recall 层。
 * 不轮询、不落新表：receipt 复用现有 `resident_trace.sections`（JSONB），不改 schema。
 */
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import type { InjectionReceipt } from '../../packages/v7/src/prompt/assembler.js'
import type { RecallNotice } from '../../packages/v7/src/recall/resident.js'
import type { RecallScenario } from '../../packages/v7/src/retrieval/types.js'
import type { RecallInjection } from '../../packages/v7/src/app/recall.js'
import { messageOf } from './messages.js'
import { T1ContentWindow, type StepPosition } from './t1.js'

const SESSION_STATE_LIMIT = 256

/** 会话级 Map 的 LRU 上限：长会话/多会话运行时不能无限增长（RET-13）。 */
export function rememberSessionState<T>(map: Map<string, T>, sessionId: string, value: T): void {
  map.delete(sessionId)
  map.set(sessionId, value)
  while (map.size > SESSION_STATE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * 一次等待采用的注入：hits 必须来自这次注入的（T1）receipt，而不是检索候选全集。
 * T0 的偏好/状态命中没有逐实体 receipt（常驻段是整段块），由 recall 层按 receipt
 * 的 kept/隔离先过滤；T1 在 adoptPending 里再按 receipt 复核一次。
 */
export interface PendingInjection {
  readonly sessionId: string
  readonly traceId: string
  readonly hits: readonly { readonly id: string; readonly title?: string }[]
  readonly receipt?: InjectionReceipt
}

/** tools/pre-execute 预取的 T1：文本真正挂到结果上时，用它携带的 notice 登记 receipt 与采用等待。 */
export interface PrefetchedT1 {
  readonly text: string
  readonly notice?: RecallNotice
}

export interface T1Session {
  /** 一次注入的采用等待集合（按 sessionId 分组）。 */
  readonly pendingRecall: Map<string, PendingInjection[]>
  /** T1 由 session/event 触发；pre-step 消费后清空，避免重复注入。 */
  readonly pendingT1: Map<string, { readonly scenario: RecallScenario; readonly query: string }>
  /** tools/post-execute 已经即时注入的 T1 文本；下一次 pre-step 直接复用，避免同一次工具结果重复召回。 */
  readonly immediateT1: Map<string, string>
  /** tools/pre-execute 在派发前启动的召回；post-execute 有结果后优先复用，避免重复查库。 */
  readonly prefetchedT1: Map<string, { readonly sessionId: string; readonly promise: Promise<PrefetchedT1> }>
  /** 最近一次 pre-step 的 turn/step：post-execute 没有步号，只能沿用它判断「本步是否已投递 T1」。 */
  readonly currentStep: Map<string, { readonly turn: number; readonly step: number; readonly key: string }>
  /** 已经消费过 T1 的步键（pre-step 或工具结果）。 */
  readonly t1Step: Map<string, string>
  /** T0 常驻段缓存（按 turn 失效）。 */
  readonly residentCache: Map<string, { readonly turn: number | undefined; readonly text: string }>
  /** 已投递 T1 的跨 step 内容指纹（session+query+result，不含 turn/step）。 */
  readonly lastT1: Map<string, string>
  /** 同一段注入文本在 90 步/7 轮窗口内不重复注入；压缩事件会清空重计。 */
  isDuplicateT1Content(sessionId: string, text: string, position?: StepPosition): boolean
  rememberT1Content(sessionId: string, text: string, position?: StepPosition): void
  clearT1Content(sessionId: string): void
  /** RecallService 的注入回调：只进采用等待集合，不写 receipt（T2 由 engine 自己写）。 */
  rememberPendingRecall(injection: RecallInjection): void
  /** 记录一次注入：receipt 落库，命中进采用等待集合。 */
  rememberInjection(sessionId: string, notice: RecallNotice): void
  /** T0 实际注入的偏好/状态写 recall_event，落库成功后再登记采用等待。 */
  recordResidentHits(
    sessionId: string,
    turn: number | undefined,
    traceId: string,
    query: string,
    hits: readonly { readonly id: string; readonly title?: string }[],
  ): void
  /** 文本里出现的已注入命中记为 adopted（只认这次注入的 receipt kept 且未被隔离）。 */
  adoptPending(sessionId: string, text: string, kind: 'text' | 'tool'): void
  /** 清掉一个 session 的全部会话态（不清 system prompt，那是 hooks 的职责）。 */
  clear(sessionId: string): void
  /** 卸载时清空全部 Map，避免热重载时旧缓存跨实例存活。 */
  dispose(): void
}

export function createT1Session(deps: { readonly store: PostgresStore; readonly logger: Logger }): T1Session {
  const { store, logger } = deps
  const pendingRecall = new Map<string, PendingInjection[]>()
  const pendingT1 = new Map<string, { readonly scenario: RecallScenario; readonly query: string }>()
  const immediateT1 = new Map<string, string>()
  const prefetchedT1 = new Map<string, { readonly sessionId: string; readonly promise: Promise<PrefetchedT1> }>()
  const currentStep = new Map<string, { readonly turn: number; readonly step: number; readonly key: string }>()
  const t1Step = new Map<string, string>()
  const residentCache = new Map<string, { readonly turn: number | undefined; readonly text: string }>()
  const lastT1 = new Map<string, string>()
  const contentWindow = new T1ContentWindow()

  function rememberPendingRecall(injection: RecallInjection): void {
    const list = pendingRecall.get(injection.sessionId) ?? []
    list.push(injection)
    pendingRecall.set(injection.sessionId, list)
  }

  /**
   * 记录一次注入：T1 的 receipt 落 `omb.resident_trace` 作为注入证据（与 recall_event
   * 共享 traceId）；hits 只进采用等待集合。
   *
   * 为什么仍写 resident_trace：schema 里没有独立的 injection_receipt 表，本任务不允许改
   * 迁移；resident_trace 是现有唯一的注入证据表，`sections` 是 JSONB，可放 receipt 而
   * 不动表结构。T1 行不带 session_id：T0 的“该 session 最新 trace”查询按 session 取最新
   * 一行，T1 receipt 若带 session 会把它顶成 T0 证据；按 trace_id 查 T1 receipt 即可。
   */
  function persistInjectionReceipt(notice: RecallNotice): void {
    const receipt = notice.receipt
    if (receipt === undefined) return
    void store.recordResidentTrace({
      traceId: notice.traceId,
      budgetTokens: Math.max(1, receipt.budgetTokens),
      usedTokens: Math.max(0, receipt.usedTokens),
      text: notice.text ?? '',
      sections: [{
        name: 'injection-receipt',
        tokens: receipt.usedTokens,
        kept: receipt.injected,
        text: JSON.stringify(receipt),
        entityIds: receipt.keptIds,
      }],
      droppedSections: [],
    }).catch(error => {
      logger.warn('T1 注入 receipt 写入失败', messageOf(error))
    })
  }

  function rememberInjection(sessionId: string, notice: RecallNotice): void {
    // receipt 与“有没有可采用的命中”无关：隔离块不进hits，但这次的隔离证据必须可查。
    persistInjectionReceipt(notice)
    if (notice.hits.length === 0) return
    const list = pendingRecall.get(sessionId) ?? []
    list.push({
      sessionId,
      traceId: notice.traceId,
      hits: notice.hits,
      ...(notice.receipt === undefined ? {} : { receipt: notice.receipt }),
    })
    pendingRecall.set(sessionId, list)
  }

  /**
   * T0 实际注入的偏好/状态写 recall_event（injected=true），落库成功后再登记采用等待。
   *
   * 读模型路径没有 engine 的 recall_event；不补写就会让 T0 注入在账本里消失，
   * 采用率分母失真。回退路径的偏好仍走这里（与旧行为一致），状态由 engine 自己写。
   */
  function recordResidentHits(
    sessionId: string,
    turn: number | undefined,
    traceId: string,
    query: string,
    hits: readonly { readonly id: string; readonly title?: string }[],
  ): void {
    if (hits.length === 0) return
    void store.recordRecall(hits.map((hit, index) => ({
      traceId,
      sessionId,
      ...(turn === undefined ? {} : { turnId: String(turn) }),
      query,
      trigger: 't0',
      entityId: hit.id,
      channel: 'resident',
      rank: index + 1,
      injected: true,
    }))).then(() => {
      // 只有 recall_event 已落库后才登记采用等待，避免 adopted 更新不到行。
      rememberInjection(sessionId, { traceId, hits })
    }).catch(error => {
      logger.warn('T0 常驻 recall_event 写入失败', messageOf(error))
    })
  }

  function adoptPending(sessionId: string, text: string, kind: 'text' | 'tool'): void {
    const pending = pendingRecall.get(sessionId)
    if (pending === undefined || pending.length === 0 || text.length === 0) return
    const adopted = new Map<string, { traceId: string; id: string }>()
    for (const injection of pending) {
      const kept = injection.receipt === undefined ? undefined : new Set(injection.receipt.keptIds)
      const quarantined = injection.receipt === undefined ? undefined : new Set(injection.receipt.quarantinedIds)
      for (const hit of injection.hits) {
        // adoption 只认这次注入的 receipt：没进 kept 或原文被隔离的命中不算采用。
        if (kept !== undefined && !kept.has(hit.id)) continue
        if (quarantined !== undefined && quarantined.has(hit.id)) continue
        const matched = text.includes(hit.id)
          || (hit.title !== undefined && hit.title.length >= 4 && text.includes(hit.title))
        if (matched) adopted.set(`${injection.traceId}\u0000${hit.id}`, { traceId: injection.traceId, id: hit.id })
      }
    }
    pendingRecall.delete(sessionId)
    void Promise.all([...adopted.values()].map(item => store.markAdopted(item.traceId, item.id, kind))).catch(() => {})
  }

  function clear(sessionId: string): void {
    pendingRecall.delete(sessionId)
    pendingT1.delete(sessionId)
    immediateT1.delete(sessionId)
    residentCache.delete(sessionId)
    lastT1.delete(sessionId)
    contentWindow.clear(sessionId)
    currentStep.delete(sessionId)
    t1Step.delete(sessionId)
    for (const [callId, entry] of prefetchedT1) {
      if (entry.sessionId === sessionId) prefetchedT1.delete(callId)
    }
  }

  function dispose(): void {
    pendingRecall.clear()
    pendingT1.clear()
    immediateT1.clear()
    prefetchedT1.clear()
    residentCache.clear()
    lastT1.clear()
    contentWindow.clearAll()
    currentStep.clear()
    t1Step.clear()
  }

  return {
    pendingRecall,
    pendingT1,
    immediateT1,
    prefetchedT1,
    currentStep,
    t1Step,
    residentCache,
    lastT1,
    isDuplicateT1Content: (sessionId, text, position) => contentWindow.isDuplicate(sessionId, text, position),
    rememberT1Content: (sessionId, text, position) => contentWindow.remember(sessionId, text, position),
    clearT1Content: sessionId => contentWindow.clear(sessionId),
    rememberPendingRecall,
    rememberInjection,
    recordResidentHits,
    adoptPending,
    clear,
    dispose,
  }
}
