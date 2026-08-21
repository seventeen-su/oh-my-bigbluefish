// layer 2：T8.26.2 三能力拆分的纯函数助手（LOC 预算拆分：assembly.ts 保持 ≤400，超限拆分记录）。
// 职责：ContextCompiler 投影构建（§6.1）、Experience 候选（PCR，C11）、S3→Prompt 工作状态映射、
//       M3 事件构造（Model-visible ⟺ logged 的统一事件面）。全部纯函数：无 I/O、无随机、无时间依赖
//       （IRBase 时间戳为固定/入参值；真实时间由调用层注入）。
// 层 DAG（CONVENTIONS §4）：runtime(2) → kernel(2)/memory(2)/runtime(2) 均满足"import 目标层 ≤ 源层"。
import { makeMutableId } from '../kernel/schemas/base.js';
import type { ContextProjection } from '../kernel/schemas/a.js';
import { ExperienceSchema, type Experience } from '../kernel/schemas/c.js';
import type { Event } from '../kernel/schemas/m.js';
import type { State } from '../kernel/schemas/s.js';
import type { PolicyBundle } from '../kernel/policy-loader.js';
import type { RankedMemory } from '../memory/retrieve.js';
import { compile } from './renderer.js';
import type { GovernorDecision } from './governor.js';
import type { PromptWorkingState } from './prompt.js';

/** token 估算（与 renderer 内部同口径：字符/4；精确计费为 §17 参数标定项） */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** S2 State.working（S3）→ PromptWorkingState（S3 视图子集；environment 为 Fingerprint → 取 os 展示值） */
export function toPromptWorkingState(state: State): PromptWorkingState {
  const ws = state.working;
  return {
    goal: ws.goal,
    confirmed_facts: [...ws.confirmed_facts],
    active_hypotheses: [...ws.active_hypotheses],
    contradictions: [...ws.contradictions],
    open_questions: [...ws.open_questions],
    evidence_gaps: [...ws.evidence_gaps],
    next_best_action: ws.next_best_action,
    environment: ws.environment.os,
  };
}

/** ContextCompiler 投影构建（§3.1 step 5）：Working State（verbatim）+ 检索结果（memory 候选）→ ContextProjection */
export function buildContextProjection(
  policy: PolicyBundle,
  task: { goal: string; success_criteria: string[] },
  working_state: PromptWorkingState,
  items: RankedMemory[],
): ContextProjection {
  return compile({
    task_contract: { goal: task.goal, success_criteria: task.success_criteria },
    working_state,
    candidates: items.map((r) => ({
      id: r.memory.id,
      kind: 'memory',
      content: r.memory.payload,
      tokens: estimateTokens(r.memory.payload),
      view: 'planning',
      info_value: r.value,
      source_ref: r.memory.id,
    })),
    budget_tokens: policy.budget.context_budget_tokens,
    policy: policy.context,
  });
}

/**
 * Experience 候选生成（§3.3 step 2，PCR：context/action/result）：Governor 决策 → C11 Experience 候选。
 * schema 校验失败 → null（候选无效降级）；admission（落记忆）为下游管线职责（本任务只生成候选）。
 */
export function buildExperienceCandidate(
  session_id: string,
  decision: GovernorDecision,
  working_state: PromptWorkingState,
): Experience | null {
  const ts = new Date().toISOString();
  const candidate: Experience = {
    ir_version: '2.0',
    id: makeMutableId('exp'),
    schema: 'omb/C11',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'runtime/assembly',
      event: 'decision/made',
      actor: 'omb-v2',
      environment: { os: process.platform, node: process.version, dsh_version: '0.8.0', project: 'omb-v2' },
      runtime_snapshot: decision.snapshot,
      timestamp: ts,
      transformation_chain: ['finalizeTurn', 'experience-candidate'],
      verification: 'c11-schema',
    },
    refs: [],
    context: working_state.goal,
    action: decision.decision,
    result: decision.reason,
    relations: { requires: [], excludes: [], fallback: [], causes: [], supersedes: [] },
  };
  const parsed = ExperienceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** M3 事件构造（三能力共用；transformation_chain 标识能力来源） */
export function makeRuntimeEvent(
  type: Event['type'],
  sessionId: string,
  snapshotHash: string,
  payload: Record<string, unknown>,
  chain: string[],
): Event {
  const ts = new Date().toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'runtime/assembly',
      event: type,
      actor: 'omb-v2',
      environment: { os: process.platform, node: process.version, dsh_version: '0.8.0', project: 'omb-v2' },
      runtime_snapshot: snapshotHash,
      timestamp: ts,
      transformation_chain: chain,
      verification: 'assembly-chain',
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
