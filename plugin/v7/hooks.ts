/**
 * 宿主钩子层：agent/pre-step（T0 常驻 + T1 事件注入）、tools/pre-execute（派发前预取）、
 * tools/post-execute（工具结果即时召回）、session/disposed（会话态清理），以及
 * session/event 的原始事件观察（adoption / T1 触发）。
 *
 * 本模块只做「何时召回、怎么装配」：会话态与 receipt 记账在 `t1-session.ts`，
 * 检索与预算在 retrieval/recall 层，宿主接线由 `wireHostHook` 记进 Supervisor。
 * 事件/工具钩子里的异常一律转日志或放行，绝不把异常抛回宿主。
 */
import { randomUUID } from 'node:crypto'
import { asRecord, sessionFromExec } from '../../packages/v7/src/adapters/dsh/host.js'
import type { HostContextLike, PromptSink, ToolContext } from '../../packages/v7/src/adapters/dsh/host.js'
import type { ProjectIdentity } from '../../packages/v7/src/domain/project-identity.js'
import { createEventCapture } from '../../packages/v7/src/adapters/dsh/events.js'
import type { EventCaptureHandle } from '../../packages/v7/src/adapters/dsh/events.js'
import type { PostgresStore } from '../../packages/v7/src/adapters/postgres/store.js'
import type { RecallEngine } from '../../packages/v7/src/retrieval/engine.js'
import type { RecallScenario } from '../../packages/v7/src/retrieval/types.js'
import type { ResidentBoardsOptions, RecallNotice } from '../../packages/v7/src/recall/resident.js'
import { buildEventRecallText, buildResident } from '../../packages/v7/src/recall/resident.js'
import { recallScenarioForQuery } from '../../packages/v7/src/app/recall.js'
import { extractQuerySignals } from '../../packages/v7/src/domain/text.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import type { JobQueue } from '../../packages/v7/src/ports/jobs.js'
import { wireHostHook, type Supervisor } from './supervisor.js'
import { appendT1Message, isEnterDecisionLike } from './t1-message.js'
import {
  hasStrongSignal,
  isRecallTriggerEvent,
  recallContentFingerprint,
  shouldRecallOnPreStep,
  shouldRecallToolResult,
  stepKeyOf,
  toolFailed,
} from './t1.js'
import {
  eventText,
  lastRoundsText,
  lastToolText,
  lastUserText,
  messageOf,
  toolResultText,
  withTimeout,
} from './messages.js'
import { evidenceFromSessionEvent } from './adoption-evidence.js'
import type { V7Config } from './config.js'
import { rememberSessionState, type PrefetchedT1, type T1Session } from './t1-session.js'

/**
 * 一次 pre-step 里 T1 的准备结果。
 *
 * 配额/指纹不在这里登记：只有 decision 明确 `enter`、T1 消息真的追加进本步，
 * 这次召回才算投递过；`reject` 的 step 不消费 T1。
 */
interface PreparedT1Injection {
  readonly sessionId: string
  /** 本轮要追加进 decision.messages 的 T1 文本；空串表示本步不注入。 */
  readonly text: string
  /** 工具结果已通过 additionalContexts 投递过 T1：本步只登记配额，不重复追加。 */
  readonly immediate: boolean
  /** 跨 step 内容指纹；只有真正投递/消费时才登记。 */
  readonly fingerprint: string | undefined
  readonly stepKey: string | undefined
  readonly turn?: number
  readonly step?: number
  /** 本次装配的 receipt/命中；只有文本真的追加进 decision.messages 时才登记采用。 */
  readonly notice?: RecallNotice
}

export interface HostHooksDeps {
  readonly ctx: HostContextLike | undefined
  readonly supervisor: Supervisor
  readonly logger: Logger
  readonly config: V7Config
  readonly store: PostgresStore
  /** 事件捕获后立即入队定向抽取；jobs=false/未启动时缺省，抽取退回周期兜底。 */
  readonly queue?: JobQueue
  readonly engine: RecallEngine
  readonly promptSink: PromptSink
  /** 主动记忆检查点通道；与 T0 分开，避免被“仅数据”头压成数据。 */
  readonly checkpointSink: PromptSink
  readonly session: T1Session
  /** T0 优先读投影看板；投影未启动时返回 undefined（回退写模型路径）。 */
  readonly boards: () => ResidentBoardsOptions | undefined
  /** 工具/pre-step 上下文解析（与事件捕获共用同一份身份缓存）。 */
  readonly resolveContext: (exec: unknown) => Promise<ToolContext | undefined>
  /** 事件捕获的项目身份（写 artifact.metadata，不改变捕获语义）。 */
  readonly resolveIdentity: (cwd: string, sessionId: string) => Promise<ProjectIdentity | undefined>
}

export interface HostHooksHandle {
  /** session/event 的原始事件捕获；卸载时由它自己的 disposer 关闭。 */
  readonly capture: EventCaptureHandle
  readonly offs: {
    readonly preStep: (() => void) | undefined
    readonly toolPreExecute: (() => void) | undefined
    readonly toolPostExecute: (() => void) | undefined
    readonly sessionDisposed: (() => void) | undefined
  }
}

export function createHostHooks(deps: HostHooksDeps): HostHooksHandle {
  const { ctx, supervisor, logger, config, store, engine, promptSink, checkpointSink, session } = deps

  /** 清掉一个 session 的全部 T0/T1 会话态，并清空它的 system prompt 文本。 */
  const clearSessionState = (sessionId: string): void => {
    session.clear(sessionId)
    promptSink.write(sessionId, '')
  }

  /**
   * session/event 的单一入口：先按事件形状归一化成采用证据，再处理 T1 触发/压缩。
   *
   * 返回 Promise 只为了让测试/组合根能在事件处理完后读取证据；宿主忽略返回值也不影响
   * 投递。这里不做“看到标题/ID 就 adopted”：引用由 adoption-evidence 判定，验证由
   * 独立的用户确认/工具成功/任务完成触发。
   */
  const observeEvent = (sessionId: string, type: string, data: unknown): void | Promise<void> => {
    const text = eventText(data)
    const evidence = evidenceFromSessionEvent(type, data)
    // 任务边界必须先同步生效：后续 Exposure/证据才能落到正确的 (session, task) 机会。
    for (const item of evidence) {
      if (item.kind === 'task-state') session.observeTaskState(sessionId, item.taskId, item.taskStatus ?? 'active')
      // 完成的任务不再作为后续 Exposure 的当前任务；验证本身由事件显式 taskId 定位。
      if (item.kind === 'task-completed') session.observeTaskState(sessionId, item.taskId, 'cleared')
    }
    const actionable = evidence.filter(item => item.kind !== 'task-state')
    const ingestion = actionable.length === 0 ? undefined : session.ingestEvidence(sessionId, actionable)
    if (type.startsWith('compaction/')) {
      session.residentCache.delete(sessionId)
      // 压缩后旧工具结果的 T1 已经过期；丢掉 immediateT1 与指纹，让待消费事件重新召回。
      session.immediateT1.delete(sessionId)
      session.lastT1.delete(sessionId)
      session.clearT1Content(sessionId)
      session.pendingT1.set(sessionId, { scenario: 'session-start', query: text.slice(0, 4_000) })
      return ingestion
    }
    if (isRecallTriggerEvent(type)) {
      session.residentCache.delete(sessionId)
      session.immediateT1.delete(sessionId)
      session.lastT1.delete(sessionId)
      // 只清待消费事件，不清内容窗口：task/team/subagent 事件在长任务里很频繁，
      // 若每次触发都清窗口，60–90 步内同一段 T1 会反复注入。只有 compaction/* 才重计。
      session.pendingT1.set(sessionId, { scenario: 'session-start', query: text.slice(0, 4_000) })
    }
    return ingestion
  }

  const capture = createEventCapture({
    ctx,
    store,
    logger,
    onEvent: observeEvent,
    resolveIdentity: deps.resolveIdentity,
    ...(deps.queue !== undefined ? { queue: deps.queue } : {}),
  })

  /** 在工具派发前启动 T1 召回；不阻塞 dispatch，结果由 post-execute 复用。 */
  const prefetchToolRecall = (exec: unknown, sessionId: string | undefined): void => {
    const record = asRecord(exec)
    const callId = typeof record?.['callId'] === 'string' ? record['callId'] : undefined
    const name = typeof record?.['name'] === 'string' ? record['name'] : ''
    if (callId === undefined || name.length === 0 || name.startsWith('omb_')) return
    const raw = [name, eventText(record?.['arguments'])].filter(part => part.length > 0).join('\n').slice(0, 8_000)
    if (raw.trim().length === 0) return
    // 只有路径/错误码/代码样式标识符才值得在派发前先查一次；普通成功工具不预取。
    if (!hasStrongSignal(raw)) return
    // 本步已经投递过 T1（pre-step 或前一个工具结果），不再为第二个工具预取。
    const position = sessionId === undefined ? undefined : session.currentStep.get(sessionId)
    if (sessionId !== undefined && position !== undefined && session.t1Step.get(sessionId) === position.key) return
    const query = (() => {
      const signals = extractQuerySignals(raw)
      return [raw, ...signals.paths, ...signals.errorCodes, ...signals.identifiers.slice(0, 8)].join(' ')
    })()
    const promise = (async (): Promise<PrefetchedT1> => {
      const context = await deps.resolveContext(exec)
      if (context === undefined) return { text: '' }
      let notice: RecallNotice | undefined
      const text = await buildEventRecallText(
        engine,
        context,
        query,
        'tool-before',
        400,
        captured => { notice = captured },
        session.recentT1EntityIds(context.sessionId),
      )
      // 预取可能被丢弃（报错时重新查、本步已有 T1、工具取消）：不在这里登记 receipt，
      // 只有 post-execute 真正把 text 挂到 additionalContexts 时才登记。
      return { text, ...(notice === undefined ? {} : { notice }) }
    })().catch(() => ({ text: '' }))
    // 工具被取消时不会走到 post-execute，限制缓存条目避免长期泄漏。
    if (session.prefetchedT1.size >= 64) {
      const oldest = session.prefetchedT1.keys().next().value
      if (oldest !== undefined) session.prefetchedT1.delete(oldest)
    }
    session.prefetchedT1.set(callId, { sessionId: sessionId ?? '', promise })
  }

  const preExecuteTool = async (exec: unknown, next?: () => unknown): Promise<unknown> => {
    const decision = typeof next === 'function' ? await next() : { kind: 'allow' }
    if (asRecord(decision)?.['kind'] === 'allow') prefetchToolRecall(exec, sessionFromExec(exec)?.sessionId)
    return decision
  }

  /**
   * T1 工具结果通道：tools/post-execute 允许把 additionalContexts 直接挂到本次结果，
   * 模型在下一步就看见，不必等 agent/pre-step。工具调用前没有等价的上下文通道
   * （pre-execute 只能 allow/deny/ask），所以「调用前」仍由上一次 pre-step 的主动召回
   * 覆盖；这里负责调用后的结果与报错。
   */
  const postExecuteTool = async (exec: unknown, result: unknown, next?: () => unknown): Promise<unknown> => {
    const decision = typeof next === 'function' ? await next() : { kind: 'accept' }
    const decisionRecord = asRecord(decision)
    if (decisionRecord === undefined) return decision
    try {
      const execRecord = asRecord(exec)
      const name = typeof execRecord?.['name'] === 'string' ? execRecord['name'] : ''
      const callId = typeof execRecord?.['callId'] === 'string' ? execRecord['callId'] : undefined
      const resultRecord = asRecord(result)
      // 成功的记忆写入在这里销账；即使下一步 pre-step 还没到，检查点也应尽快关闭。
      if ((name === 'omb_remember' || name === 'omb_update') && resultRecord?.['isError'] !== true) {
        const writtenSessionId = sessionFromExec(exec)?.sessionId
        if (writtenSessionId !== undefined) {
          session.noteMemoryWrite(writtenSessionId, session.currentStep.get(writtenSessionId) ?? {})
        }
      }
      // OMB 自己的工具结果不需要再被 OMB 召回，避免自激。
      if (name.length === 0 || name.startsWith('omb_')) return decision
      const context = await deps.resolveContext(exec)
      if (context === undefined) return decision
      const sessionId = context.sessionId
      const argumentsText = eventText(execRecord?.['arguments'])
      const resultText = toolResultText(result)
      const raw = [name, argumentsText, resultText].filter(part => part.length > 0).join('\n').slice(0, 8_000)
      if (raw.trim().length === 0) return decision
      const failed = toolFailed(resultRecord?.['isError'] === true, resultText)
      // 普通成功工具不召回：只有失败，或参数/结果带路径、错误码、代码样式标识符才进入 T1。
      if (!shouldRecallToolResult({ failed, argumentsText, resultText })) {
        if (callId !== undefined) session.prefetchedT1.delete(callId)
        return decision
      }
      const position = session.currentStep.get(sessionId)
      if (position !== undefined && session.t1Step.get(sessionId) === position.key) {
        // 本步的 T1 已由 pre-step 或前一个工具结果投递；第二个工具不再追加一段。
        if (callId !== undefined) session.prefetchedT1.delete(callId)
        return decision
      }
      const signals = extractQuerySignals(raw)
      const query = [raw, ...signals.paths, ...signals.errorCodes, ...signals.identifiers.slice(0, 8)].join(' ')
      // 跨 step 内容指纹：同一个工具结果重复出现时不重复注入；步内配额由 t1Step 负责。
      const fingerprint = recallContentFingerprint({ sessionId, query, result: resultText })
      if (session.lastT1.get(sessionId) === fingerprint) {
        if (callId !== undefined) session.prefetchedT1.delete(callId)
        return decision
      }
      const prefetched = callId === undefined ? undefined : session.prefetchedT1.get(callId)?.promise
      if (callId !== undefined) session.prefetchedT1.delete(callId)
      // 成功的工具优先复用派发前的召回；报错时结果里的错误码更有价值，重新查一次。
      const reused = !failed && prefetched !== undefined
        ? await withTimeout(prefetched, 500)
        : undefined
      let injected = reused?.text ?? ''
      let generatedNotice: RecallNotice | undefined
      if (injected.length === 0) {
        injected = await withTimeout(
          buildEventRecallText(
            engine,
            context,
            query,
            failed ? 'tool-error' : 'tool-before',
            400,
            notice => { generatedNotice = notice },
            session.recentT1EntityIds(sessionId),
          ),
          1_500,
        ) ?? ''
      }
      if (injected.length === 0) return decision
      const deliveredNotice = reused?.notice ?? generatedNotice
      // 90 步/7 轮窗口内同一段文本或基本同一批实体已投递过：不再重复追加，也不登记新的 receipt。
      if (session.isDuplicateT1Content(sessionId, injected, position, deliveredNotice?.receipt?.keptIds)) {
        if (callId !== undefined) session.prefetchedT1.delete(callId)
        return decision
      }
      if (deliveredNotice !== undefined) {
        session.rememberInjection(sessionId, deliveredNotice)
        // 文本真正挂到 additionalContexts 后才把 recall_event 标成 injected。
        await store.markRecallInjected?.(deliveredNotice.traceId)
        // 事件驱动地记录 Exposure；下一步证据到达时机会已经存在。
        await session.flushEvidence(sessionId)
      }
      // 只登记真正投递出去的 T1：下一轮 pre-step 认领它，本步配额同时记为已用。
      session.rememberT1Content(sessionId, injected, position, deliveredNotice?.receipt?.keptIds)
      rememberSessionState(session.immediateT1, sessionId, injected)
      rememberSessionState(session.lastT1, sessionId, fingerprint)
      if (position !== undefined) rememberSessionState(session.t1Step, sessionId, position.key)
      const additional = {
        id: `msg_omb_${randomUUID()}`,
        role: 'user',
        // DSH v4 只接受 producer-owned source：`kind:'plugin'` 已被明确拒绝。
        // 用迁移器给外部插件生成的规范 kind（plugin:<name>），不要带 plugin 字段。
        source: { kind: 'plugin:oh-my-bigbluefish/v7' },
        content: [{ type: 'text', text: injected }],
      }
      const existing = Array.isArray(decisionRecord['additionalContexts'])
        ? decisionRecord['additionalContexts']
        : []
      return { ...decisionRecord, additionalContexts: [...existing, additional] }
    } catch (error) {
      logger.warn('工具结果即时召回失败', messageOf(error))
      return decision
    }
  }

  /**
   * 汇总本步的 T1 准备结果（只计算 + 写 T0），不碰 decision：
   * - T0（常驻）仍写 `systemPrompt.context` provider（promptSink）；空 T0 也覆盖写空串（RUN-04）；
   * - T1（事件召回）不再写 promptSink：provider 是装配期快照，逐步骤高频 T1 会退化成
   *   整段重装配（docs/v7/review/RESEARCH.md §8 #2）。T1 的注入口是 pre-step 的
   *   `decision.messages`（packages/core/agent/src/runtime-types.ts:139-146）：追加一条
   *   producer-owned user message，宿主准入时落成 durable `user/message`
   *   （time-context 同款：packages/context/time-context/src/index.ts:199-242）。
   */
  const prepareT1Injection = async (payload: unknown): Promise<PreparedT1Injection | undefined> => {
    const context = await deps.resolveContext(payload)
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined
    if (context === undefined || record === undefined) return undefined
    const sessionId = context.sessionId
    const turn = typeof record['turn'] === 'number' ? record['turn'] : undefined
    const step = typeof record['step'] === 'number' ? record['step'] : undefined
    const stepKey = stepKeyOf({ turn, step })
    // post-execute 拿不到步号，只能沿用最近一次 pre-step 的 turn/step 判断本步配额。
    if (turn !== undefined && step !== undefined && stepKey !== undefined) {
      rememberSessionState(session.currentStep, sessionId, { turn, step, key: stepKey })
    }
    const userText = lastUserText(record['messages'])
    // 主动记忆：每次 pre-step 都看最后一条真实用户消息（同一文本在同 turn 只入队一次），
    // 再把检查点写到独立的 context 通道。空串也覆盖写，避免上一轮检查点残留。
    if (userText !== undefined) session.observeUserMessage(sessionId, userText, { turn, step })
    checkpointSink.write(sessionId, session.renderMemoryCheckpoint(sessionId, { turn, step }))
    const triggered = session.pendingT1.get(sessionId)
    if (triggered !== undefined) {
      session.pendingT1.delete(sessionId)
      // 压缩/子任务切换后常驻层必须重建，不能吃同一 turn 的旧文本。
      session.residentCache.delete(sessionId)
    }
    const cached = session.residentCache.get(sessionId)
    let resident = cached !== undefined && cached.turn === turn ? cached.text : ''
    if (resident.length === 0) {
      const built = await withTimeout(
        buildResident(
          engine,
          context,
          config.residentBudget,
          () => store.stats(),
          notice => session.rememberInjection(sessionId, notice),
          () => store.preferenceSummaries?.(5) ?? Promise.resolve([]),
          // T0 优先读投影看板（两块看板各一条 SQL + 一条新鲜度 SQL）；投影未启动
          // （DB 未就绪/启动失败）时保持旧的 engine/stats 路径，行为与没有读模型前一致。
          deps.boards(),
        ),
        1_500,
      )
      resident = built?.text ?? ''
      if (built !== undefined) {
        const trace = turn === undefined
          ? built.trace
          : { ...built.trace, turnId: String(turn) }
        // 回退不是静默降级：原因已写进 trace 的 section.fallbackReason；错误/超时再落日志。
        // “读模型为空”在首次回填前是正常状态，不当错误刷日志。
        const fallback = built.trace.sections.find(section => (
          section.fallbackReason !== undefined && section.fallbackReason !== 'read-model-empty'
        ))
        if (fallback?.fallbackReason !== undefined) {
          logger.warn(`T0 读模型回退写模型：${fallback.fallbackReason}`, { sessionId, turn })
        }
        // trace 是 T0 的预算/裁剪证据；写失败不能阻断本轮注入。
        void store.recordResidentTrace(trace).catch(error => {
          logger.warn('T0 常驻 trace 写入失败', messageOf(error))
        })
        // 偏好与（读模型路径的）状态都必须写 recall_event，后续才能记录引用/验证。
        // 等待落库再返回：这不是轮询，而是让“本次注入的候选”在下一步事件到达前已可查。
        await Promise.all([
          session.recordResidentHits(sessionId, turn, built.trace.traceId, 'T0 常驻偏好', built.preferenceHits),
          session.recordResidentHits(sessionId, turn, built.trace.traceId, 'T0 常驻状态', built.stateHits),
        ])
        // T0 的 Exposure 也是事件驱动写入；等它落库后本步才返回（不是轮询）。
        await session.flushEvidence(sessionId)
      }
      rememberSessionState(session.residentCache, sessionId, { turn, text: resident })
    }
    const toolText = lastToolText(record['messages'])
    const recentText = lastRoundsText(record['messages'], 2)
    const eventSource = [triggered?.query, recentText, userText, toolText]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
    // 跨 step 的内容指纹不含 turn/step：同一段事件源在下一步不能因步号变化重复召回。
    const contentFingerprint = recallContentFingerprint({ sessionId, query: eventSource })
    // 工具结果已通过 additionalContexts 投递过 T1：本步不再追加同一段文本。
    // 这里只读取、不删除：decision 被下层 reject 时这次投递没有发生，配额不能被白占。
    const pendingImmediate = session.immediateT1.get(sessionId)
    let injected = ''
    let fingerprint: string | undefined
    let notice: RecallNotice | undefined
    if (pendingImmediate !== undefined) {
      // 工具结果已经把这批内容送进上下文；下一步事件源不变时 pre-step 不再重复召回。
      if (eventSource.length > 0) fingerprint = contentFingerprint
    } else if (shouldRecallOnPreStep({ pending: triggered !== undefined, text: eventSource })) {
      const alreadyRecalled = stepKey !== undefined && session.t1Step.get(sessionId) === stepKey
      if (!alreadyRecalled && session.lastT1.get(sessionId) !== contentFingerprint) {
        const signals = extractQuerySignals(eventSource)
        const query = [eventSource, ...signals.paths, ...signals.errorCodes, ...signals.identifiers.slice(0, 8)].join(' ')
        const scenario: RecallScenario = triggered?.scenario
          ?? (userText !== undefined && recallScenarioForQuery(userText) === 'last-time'
            ? 'last-time'
            : toolFailed(false, eventSource)
              ? 'tool-error'
              : turn === 1 ? 'session-start' : 'manual')
        injected = await withTimeout(
          buildEventRecallText(
            engine,
            context,
            query,
            scenario,
            400,
            // 先捕获 notice：宿主 reject 的 step 不会追加消息，那时不该登记 receipt/采用等待。
            captured => { notice = captured },
            session.recentT1EntityIds(sessionId),
          ),
          1_500,
        ) ?? ''
        if (injected.length > 0
          && session.isDuplicateT1Content(sessionId, injected, { turn, step }, notice?.receipt?.keptIds)) {
          // 同一段内容在 90 步/7 轮内已经投递；不要因中间插入了别的召回而再次注入。
          injected = ''
          notice = undefined
          fingerprint = undefined
        } else if (injected.length > 0) {
          fingerprint = contentFingerprint
        }
      }
    }
    // T0 仍走 promptSink；RUN-04：本轮没有 T0 时也要覆盖写空串，清掉上一轮旧文本。
    promptSink.write(sessionId, resident)
    return {
      sessionId,
      text: injected,
      immediate: pendingImmediate !== undefined,
      fingerprint,
      stepKey,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(notice === undefined ? {} : { notice }),
    }
  }

  const preStep = async (payload: unknown, next: () => unknown): Promise<unknown> => {
    let prepared: PreparedT1Injection | undefined
    try {
      prepared = await prepareT1Injection(payload)
    } catch (error) {
      logger.warn('pre-step 注入失败', messageOf(error))
    }
    // next() 必须在 try 之外：其它 pre-step 监听器抛错要原样上抛，不能被 OMB 吞成放行。
    // 宿主契约要求 next 必传（DSH `packages/core/agent/src/runtime-types.ts:351`）。
    const decision = await next()
    if (!isEnterDecisionLike(decision)) return decision
    if (prepared === undefined) return decision
    if (prepared.immediate) {
      // 工具结果的即时注入已经送达：本步只消费一次配额，不再追加第二条 T1。
      session.immediateT1.delete(prepared.sessionId)
      if (prepared.stepKey !== undefined) rememberSessionState(session.t1Step, prepared.sessionId, prepared.stepKey)
      if (prepared.fingerprint !== undefined) rememberSessionState(session.lastT1, prepared.sessionId, prepared.fingerprint)
    } else if (prepared.text.length > 0) {
      // 只有真正追加进 decision.messages 的召回才占用本步配额与去重指纹；
      // receipt/采用等待也在这一刻登记（reject/未追加都不该留下“已注入”证据）。
      if (prepared.notice !== undefined) {
        session.rememberInjection(prepared.sessionId, prepared.notice)
        // 只有消息真的追加进 decision.messages 才把 recall_event 标成 injected。
        await store.markRecallInjected?.(prepared.notice.traceId)
        // 记录本步的 Exposure（机会聚合在 store 内完成，重复召回不会重复累计）。
        await session.flushEvidence(prepared.sessionId)
      }
      session.rememberT1Content(prepared.sessionId, prepared.text, {
        ...(prepared.turn === undefined ? {} : { turn: prepared.turn }),
        ...(prepared.step === undefined ? {} : { step: prepared.step }),
      }, prepared.notice?.receipt?.keptIds)
      if (prepared.stepKey !== undefined) rememberSessionState(session.t1Step, prepared.sessionId, prepared.stepKey)
      if (prepared.fingerprint !== undefined) rememberSessionState(session.lastT1, prepared.sessionId, prepared.fingerprint)
    }
    return appendT1Message(decision, prepared.text)
  }

  // 钩子 disposer 在接线处一次性取得；卸载时逐个调用，任一失败不阻断后续。
  const preStepOff = wireHostHook({ ctx, supervisor, name: 'agent/pre-step', handler: preStep }).off

  const toolPreExecuteOff = wireHostHook({
    ctx,
    supervisor,
    name: 'tools/pre-execute',
    handler: preExecuteTool,
  }).off

  const toolPostExecuteOff = wireHostHook({
    ctx,
    supervisor,
    name: 'tools/post-execute',
    handler: postExecuteTool,
  }).off

  // 会话结束必须清掉该 session 的 T0/T1 会话态与 system prompt 文本，
  // 否则长会话/多会话运行时会一直增长并看到已结束会话的旧记忆（RET-13/RUN-05）。
  const sessionDisposedOff = wireHostHook({
    ctx,
    supervisor,
    name: 'session/disposed',
    handler: ((disposed: unknown) => {
      const record = asRecord(disposed)
      const id = typeof record?.['id'] === 'string'
        ? record['id']
        : typeof record?.['sessionId'] === 'string'
          ? record['sessionId']
          : undefined
      if (id !== undefined && id.trim().length > 0) clearSessionState(id)
    }),
  }).off

  return {
    capture,
    offs: {
      preStep: preStepOff,
      toolPreExecute: toolPreExecuteOff,
      toolPostExecute: toolPostExecuteOff,
      sessionDisposed: sessionDisposedOff,
    },
  }
}
