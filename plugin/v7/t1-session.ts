/**
 * T1 会话态、注入账本与采用证据队列：全部按 sessionId 键控，
 * session/disposed 与插件卸载时清理（RET-13/RUN-05）。
 *
 * 采用证据模型（与 `013_adoption_metrics.sql` 对齐）：
 * - Exposure：注入/召回只创建“使用机会”，同一 (entity, session, task) 只算一个机会；
 * - Reference：模型文本明确提到记忆（弱证据）；
 * - Utilization：完整实体 ID 进入工具参数/命令（实际参与，按任务可追溯）；
 * - Validation：用户确认、验证工具（test/typecheck/build 等）通过、任务完成；
 * - Refutation：用户在同一句里否定/证伪该记忆（负向证据）。
 *
 * 所有写入都是事件驱动、按 session 串行化；没有轮询，也没有“看见字符串就 adopted”。
 * receipt 仍复用 `resident_trace.sections`（JSONB），不改这张表的职责。
 */
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import type { UsageEvidenceInput } from '../../packages/v7/src/ports/observability.js'
import type { InjectionReceipt } from '../../packages/v7/src/prompt/assembler.js'
import type { RecallNotice } from '../../packages/v7/src/recall/resident.js'
import type { RecallScenario } from '../../packages/v7/src/retrieval/types.js'
import type { RecallInjection } from '../../packages/v7/src/app/recall.js'
import { messageOf } from './messages.js'
import {
  findReferences,
  isVerificationTool,
  toolCallExplicitReferences,
  userConfirmationReferences,
  userRefutationReferences,
  type AdoptionHit,
  type ReferenceKind,
  type SessionEvidence,
  type TaskStatus,
} from './adoption-evidence.js'
import { T1ContentWindow, type StepPosition } from './t1.js'
import { MemoryCheckpointLedger, type MemoryPosition } from './memory-check.js'

const SESSION_STATE_LIMIT = 256
/** 每个会话保留最近 N 次注入的候选；更早的候选已被观察过，不必为引用无限保留。 */
const PENDING_INJECTION_LIMIT = 8
/** 最近被引用的命中；用户确认/任务完成可能发生在引用之后，保留窗口足够覆盖一轮。 */
const RECENT_REFERENCE_LIMIT = 32
/** tool/call → tool/result 的配对窗口；工具被取消时不会走到 result，靠上限回收。 */
const TOOL_CALL_LIMIT = 64
/** 没有 goal/team task 边界时，整个会话就是一个使用机会——保守且不会跨会话累计。 */
const SESSION_TASK = 'session'

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
 * 一次注入的引用候选：hits 必须来自这次注入的 receipt/实际注入列表，而不是检索候选全集。
 * `taskId` 是注入时的任务边界，用于把重复召回折叠到同一个使用机会。
 */
export interface PendingInjection {
  readonly sessionId: string
  readonly traceId: string
  readonly taskId: string
  readonly hits: readonly AdoptionHit[]
  readonly receipt?: InjectionReceipt
  readonly seq: number
}

/** tools/pre-execute 预取的 T1：文本真正挂到结果上时，用它携带的 notice 登记 receipt 与候选。 */
export interface PrefetchedT1 {
  readonly text: string
  readonly notice?: RecallNotice
}

interface Candidate {
  readonly traceId: string
  readonly taskId: string
  readonly hit: AdoptionHit
  readonly seq: number
}

/** 一条已经写进 recall_event/usage_opportunity 的引用；用于后续确认/任务完成再验证。 */
interface RecentReference {
  readonly traceId: string
  readonly taskId: string
  readonly hit: AdoptionHit
  readonly kind: ReferenceKind
  readonly source: string
  readonly seq: number
}

interface ToolCallReference {
  readonly traceId: string
  readonly taskId: string
  readonly hit: AdoptionHit
}

interface PendingToolCall {
  readonly toolName?: string
  readonly argumentsText: string
  readonly references: readonly ToolCallReference[]
}

export interface T1Session {
  /** 一次注入的引用候选集合（按 sessionId 分组）。 */
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
  isDuplicateT1Content(
    sessionId: string,
    text: string,
    position?: StepPosition,
    entityIds?: readonly string[],
  ): boolean
  rememberT1Content(
    sessionId: string,
    text: string,
    position?: StepPosition,
    entityIds?: readonly string[],
  ): void
  clearT1Content(sessionId: string): void
  /** 窗口内已展示的实体 id，T1 装配时过滤，避免换顺序/换子集重复出现。 */
  recentT1EntityIds(sessionId: string): ReadonlySet<string>
  /** RecallService 的注入回调：只进引用候选集合，并按当前任务登记 Exposure。 */
  rememberPendingRecall(injection: RecallInjection): void
  /** 记录一次注入：receipt 落库、登记 Exposure、命中进引用候选集合。 */
  rememberInjection(sessionId: string, notice: RecallNotice): void
  /** T0 实际注入的偏好/状态写 recall_event（injected=true），落库成功后再登记 Exposure/候选。 */
  recordResidentHits(
    sessionId: string,
    turn: number | undefined,
    traceId: string,
    query: string,
    hits: readonly AdoptionHit[],
  ): Promise<void>
  /**
   * 消费一条 session/event 证据：Reference/Utilization/Validation/Refutation 各按层级写证据。
   * 按 session 串行化，保证 tool/call 先于它的 tool/result 被处理。
   */
  ingestEvidence(sessionId: string, evidence: readonly SessionEvidence[]): Promise<void>
  /** 任务边界事件：active 切换当前任务，cleared 清空；同步更新，避免后续证据用旧任务。 */
  observeTaskState(sessionId: string, taskId: string | undefined, status: TaskStatus): void
  /** 等待某会话的 Exposure/证据写入完成；供测试与需要确定性的调用方使用，不是轮询。 */
  flushEvidence(sessionId: string): Promise<void>
  /** 观察真实用户消息：只有值得长期保存的 strong 信号进入检查点队列。 */
  observeUserMessage(sessionId: string, text: string, position?: MemoryPosition): void
  /** 本次 pre-step 要显示的检查点文本；空串表示不显示并应覆盖写空。 */
  renderMemoryCheckpoint(sessionId: string, position?: MemoryPosition): string
  /** 成功的 omb_remember/omb_update 销账。 */
  noteMemoryWrite(sessionId: string, position?: MemoryPosition): void
  /** 当前未记录信号数；`omb_status`/测试可读。 */
  memoryPendingCount(sessionId: string): number
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
  const memory = new MemoryCheckpointLedger()

  /** 引用/注入的全局单调序号：同一实体被多次注入/引用时，验证用最新一次。 */
  let sequence = 0
  const recentReferences = new Map<string, RecentReference[]>()
  const pendingToolCalls = new Map<string, PendingToolCall>()
  /** goal/team task 边界：没有时用 'session'，同一会话的任务内证据折叠到同一机会。 */
  const activeTask = new Map<string, string>()
  /** 每个 session 的证据写入串行链；事件之间不并发写，也不轮询。 */
  const evidenceQueues = new Map<string, Promise<void>>()
  /** Exposure 写入链：与证据写分离，但证据处理前会先等它，保证机会先存在。 */
  const exposureQueues = new Map<string, Promise<void>>()

  function currentTaskId(sessionId: string): string {
    return activeTask.get(sessionId) ?? SESSION_TASK
  }

  function rememberPending(sessionId: string, entry: PendingInjection): void {
    const list = pendingRecall.get(sessionId) ?? []
    list.push(entry)
    pendingRecall.set(sessionId, list.slice(-PENDING_INJECTION_LIMIT))
  }

  function rememberRecentReference(sessionId: string, entry: RecentReference): void {
    const list = recentReferences.get(sessionId) ?? []
    // 同一 trace+entity 的重复引用只保留最新一条（序号靠后），用于确认/任务完成时选最新。
    const filtered = list.filter(item => !(item.traceId === entry.traceId && item.hit.id === entry.hit.id))
    filtered.push(entry)
    recentReferences.set(sessionId, filtered.slice(-RECENT_REFERENCE_LIMIT))
  }

  /** 所有可被引用的命中（保留每条 trace）；用于事件级审计覆盖多次注入。 */
  function allCandidates(sessionId: string): readonly Candidate[] {
    const seen = new Set<string>()
    const list: Candidate[] = []
    const push = (candidate: Candidate): void => {
      const key = `${candidate.traceId}\u0000${candidate.hit.id}`
      if (seen.has(key)) return
      seen.add(key)
      list.push(candidate)
    }
    for (const injection of pendingRecall.get(sessionId) ?? []) {
      for (const hit of injection.hits) {
        push({ traceId: injection.traceId, taskId: injection.taskId, hit, seq: injection.seq })
      }
    }
    for (const reference of recentReferences.get(sessionId) ?? []) {
      push({
        traceId: reference.traceId,
        taskId: reference.taskId,
        hit: reference.hit,
        seq: reference.seq,
      })
    }
    return list.sort((left, right) => left.seq - right.seq)
  }

  /** 当前可被引用/验证的命中：按实体取最新一次（验证只落在最新机会上）。 */
  function candidates(sessionId: string): readonly Candidate[] {
    const byId = new Map<string, Candidate>()
    for (const candidate of allCandidates(sessionId)) {
      const previous = byId.get(candidate.hit.id)
      if (previous === undefined || candidate.seq >= previous.seq) byId.set(candidate.hit.id, candidate)
    }
    return [...byId.values()].sort((left, right) => left.seq - right.seq)
  }

  function toolCallKey(sessionId: string, callId: string): string {
    return `${sessionId}\u0000${callId}`
  }

  function rememberToolCall(sessionId: string, callId: string, entry: PendingToolCall): void {
    pendingToolCalls.set(toolCallKey(sessionId, callId), entry)
    while (pendingToolCalls.size > TOOL_CALL_LIMIT) {
      const oldest = pendingToolCalls.keys().next().value
      if (oldest === undefined) break
      pendingToolCalls.delete(oldest)
    }
  }

  function enqueue(
    queues: Map<string, Promise<void>>,
    sessionId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work).catch(error => {
      logger.warn('采用证据写入失败', messageOf(error))
    })
    queues.set(sessionId, next)
    void next.finally(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId)
    })
    return next
  }

  /** 登记 Exposure：重复调用只会增加机会内 exposures，不增加 opportunities。 */
  function scheduleExposure(sessionId: string, taskId: string, traceId: string, hits: readonly AdoptionHit[]): void {
    if (hits.length === 0) return
    void enqueue(exposureQueues, sessionId, async () => {
      for (const hit of hits) {
        await store.recordExposure({ entityId: hit.id, sessionId, taskId, traceId })
      }
    })
  }

  /** 写一条机会级证据；失败只记日志，不阻断后续事件。 */
  async function writeEvidence(
    sessionId: string,
    level: 'reference' | 'utilization' | 'validation' | 'refutation',
    candidate: Pick<Candidate, 'traceId' | 'taskId' | 'hit'>,
    input: Pick<UsageEvidenceInput, 'kind' | 'source' | 'evidence'>,
  ): Promise<void> {
    try {
      await store.recordUsage(level, {
        entityId: candidate.hit.id,
        sessionId,
        taskId: candidate.taskId,
        traceId: candidate.traceId,
        kind: input.kind,
        source: input.source,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      })
    } catch (error) {
      logger.warn('采用证据写入失败', messageOf(error))
    }
  }

  function evidenceOf(event: SessionEvidence): Readonly<Record<string, string | number | boolean>> {
    return {
      ...(event.eventType === undefined ? {} : { eventType: event.eventType }),
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.callId === undefined ? {} : { callId: event.callId }),
    }
  }

  async function beginVerification(
    sessionId: string,
    candidate: Pick<Candidate, 'traceId' | 'taskId' | 'hit'>,
    event: SessionEvidence,
    kind: 'goal-complete' | 'task-complete' | 'test-pass' | 'user-confirmation',
    source: string,
  ): Promise<void> {
    // 新鲜度复核：引用后实体被更新/归档就不能升 Validation（弱引用仍保留）。
    try {
      const entity = await store.get(candidate.hit.id)
      const stale = entity === undefined
        || (candidate.hit.updatedAt !== undefined && entity.updatedAt !== candidate.hit.updatedAt)
      if (stale) return
      await store.recordUsage('validation', {
        entityId: candidate.hit.id,
        sessionId,
        taskId: candidate.taskId,
        traceId: candidate.traceId,
        kind,
        source,
        evidence: evidenceOf(event),
      })
    } catch (error) {
      logger.warn('验证证据写入失败', messageOf(error))
    }
  }

  async function ingestText(sessionId: string, text: string, source: string): Promise<void> {
    const latest = candidates(sessionId)
    if (latest.length === 0) return
    const all = allCandidates(sessionId)
    const latestById = new Map(latest.map(item => [item.hit.id, item]))
    for (const reference of findReferences(text, latest.map(item => item.hit))) {
      // 同一实体可能被 T0/T1/T2 多次注入：每条注入 trace 都写事件级引用证据，
      // 但机会级指标只由 store 按 (entity, session, task) 计一次。
      for (const candidate of all.filter(item => item.hit.id === reference.hit.id)) {
        await writeEvidence(sessionId, 'reference', candidate, { kind: reference.kind, source })
      }
      const newest = latestById.get(reference.hit.id)
      if (newest === undefined) continue
      sequence += 1
      rememberRecentReference(sessionId, {
        traceId: newest.traceId,
        taskId: newest.taskId,
        hit: newest.hit,
        kind: reference.kind,
        source,
        seq: sequence,
      })
    }
  }

  async function ingestToolCall(sessionId: string, event: SessionEvidence): Promise<void> {
    // OMB 自己的工具参数不参与采用证据，避免“内部读写”自证。
    if (event.toolName?.startsWith('omb_') === true) return
    const pool = candidates(sessionId)
    if (pool.length === 0) return
    const all = allCandidates(sessionId)
    const latestById = new Map(pool.map(item => [item.hit.id, item]))
    const references: ToolCallReference[] = []
    for (const reference of toolCallExplicitReferences(event.text, pool.map(item => item.hit))) {
      const newest = latestById.get(reference.hit.id)
      if (newest === undefined) continue
      // 完整 ID 实际进入工具参数 = Utilization；每条注入 trace 都写事件级证据。
      for (const candidate of all.filter(item => item.hit.id === reference.hit.id)) {
        await writeEvidence(sessionId, 'utilization', candidate, { kind: 'entity-id', source: 'tool-call' })
      }
      references.push({ traceId: newest.traceId, taskId: newest.taskId, hit: newest.hit })
    }
    if (event.callId !== undefined && references.length > 0) {
      rememberToolCall(sessionId, event.callId, {
        ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
        argumentsText: event.text,
        references,
      })
    }
  }

  async function ingestToolResult(sessionId: string, event: SessionEvidence): Promise<void> {
    if (event.callId === undefined) return
    const key = toolCallKey(sessionId, event.callId)
    const pending = pendingToolCalls.get(key)
    pendingToolCalls.delete(key)
    // 工具失败/普通工具成功都不升 Validation；引用/使用证据已在 tool/call 时保留。
    if (pending === undefined || event.success !== true) return
    if (!isVerificationTool(pending.toolName, pending.argumentsText)) return
    for (const reference of pending.references) {
      await beginVerification(sessionId, reference, event, 'test-pass', 'tool-result')
    }
  }

  async function ingestUserMessage(sessionId: string, event: SessionEvidence): Promise<void> {
    const pool = candidates(sessionId)
    if (pool.length === 0) return
    const all = allCandidates(sessionId)
    const latestById = new Map(pool.map(item => [item.hit.id, item]))
    const refutations = userRefutationReferences(event.text, pool.map(item => item.hit))
    const refutedIds = new Set(refutations.map(reference => reference.hit.id))
    const confirmations = userConfirmationReferences(event.text, pool.map(item => item.hit))
      // 同一句既肯定又否定 → 不确定，宁可不升 Validation。
      .filter(reference => !refutedIds.has(reference.hit.id))
    for (const reference of confirmations) {
      const newest = latestById.get(reference.hit.id)
      if (newest === undefined) continue
      for (const candidate of all.filter(item => item.hit.id === reference.hit.id)) {
        await writeEvidence(sessionId, 'reference', candidate, { kind: reference.kind, source: 'user-message' })
      }
      await beginVerification(sessionId, newest, event, 'user-confirmation', 'user-message')
    }
    for (const reference of refutations) {
      const newest = latestById.get(reference.hit.id)
      if (newest === undefined) continue
      for (const candidate of all.filter(item => item.hit.id === reference.hit.id)) {
        await writeEvidence(sessionId, 'reference', candidate, { kind: reference.kind, source: 'user-message' })
      }
      // 负向证据不要求新鲜度：用户说它错了/过时了，本身就说明引用已失效。
      await store.recordUsage('refutation', {
        entityId: newest.hit.id,
        sessionId,
        taskId: newest.taskId,
        traceId: newest.traceId,
        kind: 'user-refutation',
        source: 'user-message',
        evidence: evidenceOf(event),
      }).catch(error => {
        logger.warn('证伪证据写入失败', messageOf(error))
      })
    }
  }

  async function ingestTaskCompleted(sessionId: string, event: SessionEvidence): Promise<void> {
    const kind = event.validationKind
    if (kind === undefined || event.taskId === undefined) return
    const pool = candidates(sessionId)
    if (pool.length === 0) return
    const all = allCandidates(sessionId)
    const latestById = new Map(pool.map(item => [item.hit.id, item]))
    for (const reference of findReferences(event.text, pool.map(item => item.hit))) {
      const newest = latestById.get(reference.hit.id)
      // 任务边界必须对得上：只验证“在同一任务里被使用的记忆”，避免跨任务误升级。
      if (newest === undefined || newest.taskId !== event.taskId) continue
      for (const candidate of all.filter(item => (
        item.hit.id === reference.hit.id && item.taskId === event.taskId
      ))) {
        await writeEvidence(sessionId, 'reference', candidate, { kind: reference.kind, source: 'task-event' })
      }
      await beginVerification(sessionId, newest, event, kind, event.eventType ?? 'task-event')
    }
  }

  async function ingest(sessionId: string, evidence: readonly SessionEvidence[]): Promise<void> {
    // 证据处理前先等本会话的 Exposure 写入：机会必须先存在，指标才按机会计数。
    const exposure = exposureQueues.get(sessionId)
    if (exposure !== undefined) await exposure
    for (const event of evidence) {
      if (event.kind === 'assistant-text') await ingestText(sessionId, event.text, 'assistant-text')
      else if (event.kind === 'tool-call') await ingestToolCall(sessionId, event)
      else if (event.kind === 'tool-result') await ingestToolResult(sessionId, event)
      else if (event.kind === 'user-message') await ingestUserMessage(sessionId, event)
      else if (event.kind === 'task-completed') await ingestTaskCompleted(sessionId, event)
    }
  }

  function rememberPendingRecall(injection: RecallInjection): void {
    sequence += 1
    const taskId = currentTaskId(injection.sessionId)
    rememberPending(injection.sessionId, {
      sessionId: injection.sessionId,
      traceId: injection.traceId,
      taskId,
      hits: injection.hits,
      seq: sequence,
    })
    scheduleExposure(injection.sessionId, taskId, injection.traceId, injection.hits)
  }

  /**
   * 记录一次注入：T1 的 receipt 落 `omb.resident_trace` 作为注入证据（与 recall_event
   * 共享 traceId）；hits 进引用候选，并按当前任务登记一次 Exposure。
   *
   * receipt 仍复用 resident_trace：schema 里没有独立的 injection_receipt 表；T1 行不带
   * session_id，避免把 T0 的“该 session 最新 trace”查询顶掉。
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
    // receipt 与“有没有可采用的命中”无关：隔离块不进 hits，但这次的隔离证据必须可查。
    persistInjectionReceipt(notice)
    if (notice.hits.length === 0) return
    sequence += 1
    const taskId = currentTaskId(sessionId)
    rememberPending(sessionId, {
      sessionId,
      traceId: notice.traceId,
      taskId,
      hits: notice.hits,
      ...(notice.receipt === undefined ? {} : { receipt: notice.receipt }),
      seq: sequence,
    })
    scheduleExposure(sessionId, taskId, notice.traceId, notice.hits)
  }

  /**
   * T0 实际注入的偏好/状态写 recall_event（injected=true），落库成功后再登记
   * Exposure/候选。等待落库是让下一步证据能看到这些候选，不是轮询。
   */
  async function recordResidentHits(
    sessionId: string,
    turn: number | undefined,
    traceId: string,
    query: string,
    hits: readonly AdoptionHit[],
  ): Promise<void> {
    if (hits.length === 0) return
    try {
      await store.recordRecall(hits.map((hit, index) => ({
        traceId,
        sessionId,
        ...(turn === undefined ? {} : { turnId: String(turn) }),
        query,
        trigger: 't0',
        entityId: hit.id,
        channel: 'resident',
        rank: index + 1,
        injected: true,
      })))
      rememberInjection(sessionId, { traceId, hits })
    } catch (error) {
      logger.warn('T0 常驻 recall_event 写入失败', messageOf(error))
    }
  }

  function observeTaskState(sessionId: string, taskId: string | undefined, status: TaskStatus): void {
    if (taskId === undefined || taskId.length === 0) return
    if (status === 'active') {
      activeTask.set(sessionId, taskId)
      return
    }
    // completed/cleared 之后回到“会话级”机会；已完成 task 的验证在事件里显式带 taskId。
    if (activeTask.get(sessionId) === taskId) activeTask.delete(sessionId)
  }

  async function flushEvidence(sessionId: string): Promise<void> {
    const exposure = exposureQueues.get(sessionId)
    if (exposure !== undefined) await exposure
    const evidence = evidenceQueues.get(sessionId)
    if (evidence !== undefined) await evidence
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
    recentReferences.delete(sessionId)
    evidenceQueues.delete(sessionId)
    exposureQueues.delete(sessionId)
    activeTask.delete(sessionId)
    for (const [callId, entry] of prefetchedT1) {
      if (entry.sessionId === sessionId) prefetchedT1.delete(callId)
    }
    for (const [key] of pendingToolCalls) {
      if (key.startsWith(`${sessionId}\u0000`)) pendingToolCalls.delete(key)
    }
    memory.clear(sessionId)
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
    recentReferences.clear()
    pendingToolCalls.clear()
    activeTask.clear()
    evidenceQueues.clear()
    exposureQueues.clear()
    memory.dispose()
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
    isDuplicateT1Content: (sessionId, text, position, entityIds) =>
      contentWindow.isDuplicate(sessionId, text, position, entityIds),
    rememberT1Content: (sessionId, text, position, entityIds) =>
      contentWindow.remember(sessionId, text, position, entityIds),
    clearT1Content: sessionId => contentWindow.clear(sessionId),
    recentT1EntityIds: sessionId => contentWindow.recentEntityIds(sessionId),
    rememberPendingRecall,
    rememberInjection,
    recordResidentHits,
    ingestEvidence: (sessionId, evidence) => {
      if (evidence.length === 0) return Promise.resolve()
      return enqueue(evidenceQueues, sessionId, () => ingest(sessionId, evidence))
    },
    observeTaskState,
    flushEvidence,
    observeUserMessage: (sessionId, text, position) => memory.observeUserMessage(sessionId, text, position ?? {}),
    renderMemoryCheckpoint: (sessionId, position) => memory.render(sessionId, position ?? {}),
    noteMemoryWrite: (sessionId, position) => memory.noteWrite(sessionId, position ?? {}),
    memoryPendingCount: sessionId => memory.pendingCount(sessionId),
    clear,
    dispose,
  }
}
