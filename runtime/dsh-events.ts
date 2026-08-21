// layer 2：T8.26.4 DSH 事件 → OMB M3 事件映射（机械事实映射；确定性 id 双路径幂等）。
// LOC 预算拆分：从 runtime/loop-hooks.ts 拆出（411 → 本文件 + loop-hooks 减量，均 ≤400）。
// 映射规则（诚实边界，无语义抽取）：
//   user/message（人类 source.kind==='user'）→ session/start {goal} + claim/update（用户指令入 claim 表，
//     三值 unresolved）；同一 turn 内连续两条不同文本的用户指令 → contradiction/found（§5.2 矛盾不迫使判 false；
//     最小启发式：冲突 = 同 turn 指令分歧，诚实标注）
//   tool/call → tool/call {call_id,name,arguments,turn,step}；tool/result → tool/result（id 由 callId 确定性派生）
//   turn/start → 仅更新 turn 追踪（无内容事实可记：用户尚未发言；turn 生命周期语义由 user/message 的
//     session/start 与 T8.26.5 收尾承载）；assistant/message 等 → 不映射（语义抽取为下游任务，诚实边界）
// 未识别/缺关键字段 → 空（不抛，事件不采集，事实源以 DSH 日志为权威）。
// 层 DAG（CONVENTIONS §4）：runtime(2) → kernel(2)/runtime(2) 满足"import 目标层 ≤ 源层"。
import type { Event } from '../kernel/schemas/m.js';
import { dshEventId, makeDshEvent } from './loop-hooks.js';

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
