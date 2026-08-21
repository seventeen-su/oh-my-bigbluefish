// layer 2：Loop Integration 三钩子（T8.26.3-8.26.5）的纯函数助手与守卫记录。
// 职责：
//   - 降级记录（守卫式接入，计划 §2 应对策略 2：接口缺失/运行时缺失 → 记录降级，不崩）
//   - T8.26.3：投影序列化（ContextProjection → systemPrompt.context 文本）+ 会话 → CognitiveRequest 合成
//   - T8.26.4：DSH session/tools 事件 → OMB M3 事件映射（确定性 id，双路径幂等）
//   - T8.26.5：turn 收尾惰性路径辅助
// 纯函数/无副作用（除降级日志为模块级诊断记录——生产可转发到 logger/Self Model，测试可清空）。
// 层 DAG（CONVENTIONS §4）：runtime(2) → kernel(2)/runtime(2)/node 内置 满足"import 目标层 ≤ 源层"。
import { createHash } from 'node:crypto';
import type { ContextProjection } from '../kernel/schemas/a.js';
import type { Event } from '../kernel/schemas/m.js';
import type { GovernorDecision } from './governor.js';
import type { CognitiveRequest, PromptWorkingState } from './assembly.js';

// ---- 降级记录（守卫式接入的可见日志；测试经 clearDegradations/degradationLog 断言） ----

export interface DegradationRecord {
  hook: string;
  reason: string;
  at: string;
}

const degradations: DegradationRecord[] = [];

/** 记录一次守卫降级（接口缺失/运行时缺失/求值失败）；不抛 */
export function recordDegradation(hook: string, reason: string): void {
  degradations.push({ hook, reason, at: new Date().toISOString() });
}

/** 当前降级日志（只读视图） */
export function degradationLog(): readonly DegradationRecord[] {
  return degradations;
}

/** 清空降级日志（测试 beforeEach 使用；生产调用方为日志转发方） */
export function clearDegradations(): void {
  degradations.length = 0;
}

// ---- T8.26.3：投影序列化与会话请求合成 ----

/**
 * ContextProjection → systemPrompt.context 文本（最小充分投影，Planning View；A3 sections 串联）。
 * 空 sections → 空串（DSH PromptContext 语义：空文本不贡献）。
 */
export function projectionToText(projection: ContextProjection): string {
  if (projection.sections.length === 0) {
    return '';
  }
  const body = projection.sections.map((s) => s.content).join('\n');
  return `认知投影（OMB v2，${projection.type}，${projection.total_tokens} tokens）\n${body}`;
}

/** 会话 → CognitiveRequest 合成（T8.26.3 §3.1 输入）：goal 来自 DSH 会话事件（最近人类 user/message） */
export function buildRequestFromSession(
  sessionId: string,
  goal: string,
): CognitiveRequest {
  return {
    session_id: sessionId,
    goal,
    success_criteria: [],
    working_state: {
      goal,
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: [],
      next_best_action: '',
      environment: process.platform,
    },
  };
}

/**
 * 从 DSH 会话事件提取最近人类 user/message 的文本（goal 来源）。
 * 只认 source.kind === 'user' 的直接人类输入（排除插件注入/子代理消息）；无 → ''。
 */
export function lastUserMessageText(events: ReadonlyArray<{ type?: string; data?: unknown }> | undefined): string {
  if (events === undefined) {
    return '';
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'user/message') {
      continue;
    }
    const data = (e.data ?? {}) as { source?: { kind?: unknown }; content?: unknown };
    if (data.source?.kind !== 'user') {
      continue;
    }
    const content = Array.isArray(data.content) ? (data.content as Array<{ type?: string; text?: string }>) : [];
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        return block.text;
      }
    }
  }
  return '';
}

// ---- 确定性事件 id（双路径幂等：session/event 与 tools/result 对同一工具结果产出同一 id） ----

/** DSH 派生 M3 事件 id：`dsh:evt:<sha256>`（可变对象 id 不得为 sha256:<...> 前缀——irBase refine，故用 dsh: 前缀） */
export function dshEventId(parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
  return `dsh:evt:${hash}`;
}

/** 派生事件的时间戳（DSH epoch ms → ISO；缺省 now） */
export function dshTimestamp(time: number | undefined): string {
  return new Date(time === undefined ? Date.now() : time).toISOString();
}

/** DSH 派生 M3 事件的最小工厂（provenance 标记 source=dsh/loop-hooks） */
export function makeDshEvent(
  type: Event['type'],
  sessionId: string,
  snapshotHash: string,
  payload: Record<string, unknown>,
  dshType: string,
  time: number | undefined,
  id: string,
): Event {
  const ts = dshTimestamp(time);
  return {
    ir_version: '2.0',
    id,
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'dsh/loop-hooks',
      event: dshType,
      actor: 'omb-v2',
      environment: { os: process.platform, node: process.version, dsh_version: '0.8.0', project: 'omb-v2' },
      runtime_snapshot: snapshotHash,
      timestamp: ts,
      transformation_chain: ['dsh:' + dshType, 'observeEvent'],
      verification: 'dsh-schema',
    },
    refs: [],
    type,
    session_id: sessionId,
    runtime_snapshot: snapshotHash,
    parent_event: null,
    payload,
    timestamp: ts,
  };
}

/** 降级决策（T8.26.5 无 prepareTurn 记录时的收尾决策：Stop 为合法 Governor 决策并集值） */
export function fallbackFinalizeDecision(snapshotHash: string): GovernorDecision {
  return {
    decision: 'Stop',
    reason: 'turn 收尾：无 prepareTurn 记录（钩子未求值/运行时缺失）——仅记录收尾事实，不虚构认知决策',
    budget_allocation: { depth: 0, breadth: 0, tools: 0, retrieval: 0, branches: 0, context: 0 },
    expected_gain: 0,
    snapshot: snapshotHash,
  };
}

/** PromptWorkingState 空工作区（T8.26.5 无 prepareTurn 记录时的收尾输入） */
export function fallbackWorkingState(goal: string): PromptWorkingState {
  return {
    goal,
    confirmed_facts: [],
    active_hypotheses: [],
    contradictions: [],
    open_questions: [],
    evidence_gaps: [],
    next_best_action: '',
    environment: process.platform,
  };
}

// ---- T8.26.4：DSH 事件 → OMB M3 事件映射（机械事实映射；确定性 id 双路径幂等） ----

/** DSH session 事件的最小形状（真实类型见 @deepseek-ai/dsh-session SessionEvent：{ type, data, seq, time }） */
export interface DshSessionEventLike {
  type?: string;
  data?: unknown;
  seq?: number;
  time?: number;
}

/** 会话追踪状态（mapper 的纯状态：turn/同 turn 用户指令 claim/最近 goal） */
export interface SessionTraceState {
  /** 最近观察到的 DSH turn（-1 = 未开始） */
  turn: number;
  /** 当前 turn 内已映射的用户指令 claim（id + 文本；同 turn 冲突检测） */
  turnClaims: Array<{ id: string; text: string }>;
  /** 最近人类 user/message 文本（goal 携带，供 T8.26.3 请求合成） */
  lastGoal: string;
}

export function initialTraceState(): SessionTraceState {
  return { turn: -1, turnClaims: [], lastGoal: '' };
}

export interface MapSessionEventResult {
  events: Event[];
  state: SessionTraceState;
}

/** 从 content blocks 提取首个 text 块文本（DSH ContentBlock 最小面） */
function firstTextBlock(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return block.text;
    }
  }
  return '';
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * DSH session 事件 → OMB M3 事件（机械映射，无语义抽取）：
 *   user/message（人类 source.kind==='user'）→ session/start {goal} + claim/update（用户指令入 claim 表，
 *     三值 unresolved）；同一 turn 内连续两条不同文本的用户指令 → contradiction/found（§5.2 矛盾不迫使判 false；
 *     最小启发式：冲突 = 同 turn 指令分歧，诚实标注）
 *   tool/call → tool/call {call_id,name,arguments,turn,step}；tool/result → tool/result（id 由 callId 确定性派生）
 *   turn/start → 仅更新 turn 追踪（无内容事实可记：用户尚未发言；turn 生命周期语义由 user/message 的
 *     session/start 与 T8.26.5 收尾承载）；assistant/message 等 → 不映射（语义抽取为下游任务，诚实边界）
 * 未识别/缺关键字段 → 空（不抛，事件不采集，事实源以 DSH 日志为权威）。
 */
export function mapSessionEvent(
  sessionId: string,
  dsh: DshSessionEventLike,
  snapshotHash: string,
  state: SessionTraceState,
): MapSessionEventResult {
  const type = dsh?.type;
  const time = typeof dsh?.time === 'number' ? dsh.time : undefined;
  const data = (dsh?.data ?? {}) as Record<string, unknown>;

  if (type === 'turn/start') {
    const turn = typeof data.turn === 'number' ? data.turn : state.turn;
    return {
      events: [],
      state: { ...state, turn, turnClaims: turn !== state.turn ? [] : state.turnClaims },
    };
  }

  if (type === 'user/message') {
    const source = data.source as { kind?: unknown } | undefined;
    if (source?.kind !== 'user') {
      return { events: [], state }; // 只映射直接人类输入（排除插件注入/子代理消息）
    }
    const text = firstTextBlock(data.content);
    if (text.length === 0) {
      return { events: [], state }; // 空文本无事实可记
    }
    const msgId = asString(data.id) || `msg-${String(time ?? Date.now())}`;
    const claimId = `u:${msgId}`;
    const events: Event[] = [
      makeDshEvent(
        'session/start',
        sessionId,
        snapshotHash,
        { goal: text },
        type,
        time,
        dshEventId([sessionId, 'session/start', claimId]),
      ),
      makeDshEvent(
        'claim/update',
        sessionId,
        snapshotHash,
        { claim_id: claimId, text, epistemic: 'unresolved' },
        type,
        time,
        dshEventId([sessionId, 'claim/update', claimId]),
      ),
    ];
    const prev = state.turnClaims[state.turnClaims.length - 1];
    if (prev !== undefined && prev.text !== text) {
      // 同 turn 指令分歧 → 矛盾（未解析；§5.2 矛盾不迫使判 false）
      events.push(
        makeDshEvent(
          'contradiction/found',
          sessionId,
          snapshotHash,
          {
            contradiction_id: dshEventId(['contradiction', sessionId, prev.id, claimId]),
            left_claim: prev.id,
            right_claim: claimId,
          },
          type,
          time,
          dshEventId([sessionId, 'contradiction/found', prev.id, claimId]),
        ),
      );
    }
    return {
      events,
      state: { ...state, lastGoal: text, turnClaims: [...state.turnClaims, { id: claimId, text }] },
    };
  }

  if (type === 'tool/call') {
    const callId = asString(data.callId);
    if (callId.length === 0) {
      return { events: [], state };
    }
    return {
      events: [
        makeDshEvent(
          'tool/call',
          sessionId,
          snapshotHash,
          {
            call_id: callId,
            name: asString(data.name),
            arguments: asString(data.arguments),
            turn: typeof data.turn === 'number' ? data.turn : 0,
            step: typeof data.step === 'number' ? data.step : 0,
          },
          type,
          time,
          dshEventId([sessionId, 'tool/call', callId]),
        ),
      ],
      state,
    };
  }

  if (type === 'tool/result') {
    const message = data.message as { source?: { callId?: unknown }; content?: unknown } | undefined;
    const callId = asString(message?.source?.callId);
    if (callId.length === 0) {
      return { events: [], state };
    }
    const blocks = Array.isArray(message?.content) ? (message?.content as Array<{ isError?: unknown }>) : [];
    const blockError = blocks.some((b) => b?.isError === true);
    const isError = blockError || data.error !== undefined;
    return {
      events: [
        makeDshEvent(
          'tool/result',
          sessionId,
          snapshotHash,
          {
            call_id: callId,
            turn: typeof data.turn === 'number' ? data.turn : 0,
            step: typeof data.step === 'number' ? data.step : 0,
            is_error: isError,
            error: data.error ?? null,
          },
          type,
          time,
          dshEventId([sessionId, 'tool/result', callId]),
        ),
      ],
      state,
    };
  }

  return { events: [], state };
}

/**
 * tools/result（live）→ OMB tool/result 事件。
 * id 与 session 路径 tool/result 同源（sessionId+callId）→ 双路径观察同一工具结果幂等（只入链一次）。
 * exec 无 turn/step（DSH ToolExecution 最小面：callId/name/arguments/agent）——live 信号零延迟，
 * 耐久事实以 session/event 的 tool/result 为准。
 */
export function mapLiveToolResult(
  sessionId: string,
  exec: unknown,
  result: unknown,
  snapshotHash: string,
): Event {
  const e = (exec ?? {}) as { callId?: unknown; name?: unknown };
  const r = (result ?? {}) as { isError?: unknown; error?: { info?: unknown } };
  const callId = asString(e.callId);
  const isError = r.isError === true;
  const errorInfo =
    isError && r.error !== undefined && r.error !== null && typeof r.error === 'object'
      ? r.error.info ?? { name: 'tool-error', code: 'TOOL_ERROR' }
      : null;
  return makeDshEvent(
    'tool/result',
    sessionId,
    snapshotHash,
    {
      call_id: callId,
      name: asString(e.name),
      turn: 0,
      step: 0,
      is_error: isError,
      error: errorInfo,
    },
    'tools/result',
    undefined,
    dshEventId([sessionId, 'tool/result', callId]),
  );
}
