// layer 2：Loop Integration 三钩子（T8.26.3-8.26.5）的纯函数助手与守卫记录。
// 职责：
//   - 降级记录（守卫式接入，计划 §2 应对策略 2：接口缺失/运行时缺失 → 记录降级，不崩）
//   - T8.26.3：投影序列化（ContextProjection → systemPrompt.context 文本）+ 会话 → CognitiveRequest 合成
//   - 确定性事件 id/时间戳/事件工厂（T8.26.4 双路径幂等的基础；映射规则在 runtime/dsh-events.ts）
//   - T8.26.5：turn 收尾惰性路径辅助（无 prepareTurn 记录时的降级决策/工作状态）
// 纯函数/无副作用（除降级日志为模块级诊断记录——生产可转发到 logger/Self Model，测试可清空）。
// 层 DAG（CONVENTIONS §4）：runtime(2) → kernel(2)/runtime(2)/node 内置 满足"import 目标层 ≤ 源层"。
import { createHash } from 'node:crypto';
import type { ContextProjection } from '../kernel/schemas/a.js';
import type { Event } from '../kernel/schemas/m.js';
import type { GovernorDecision } from './governor.js';
import type { CognitiveRequest } from './assembly.js';
import type { PromptWorkingState } from './prompt.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';

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
    const e = events[i]!;
    if (e.type !== 'user/message') {
      continue;
    }
    const data = (e.data ?? {}) as { source?: { kind?: unknown }; content?: unknown };
    if (data.source?.kind !== 'user') {
      continue;
    }
    const content = Array.isArray(data.content) ? (data.content as Array<{ type?: string; text?: string }>) : [];
    for (let j = 0; j < content.length; j++) {
      const block = content[j]!;
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
      environment: { os: process.platform, node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
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

