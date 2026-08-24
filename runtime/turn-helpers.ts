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
import { contentHash } from '../memory/staging-policy.js';
import { compile, type CandidateItem, type ProcessSectionInput } from './renderer.js';
import { gatherContextCandidates, toCandidateItems, estimateInfoValue, type ContextCandidateSources } from './context-candidates.js';
import type { GovernorDecision, ProcessDecisionInfo } from './governor.js';
import type { PromptWorkingState } from './prompt.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';

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

/**
 * ContextCompiler 投影构建（§3.1 step 5）：Working State（verbatim）+ 检索结果（memory 候选）
 * +（R3）认知过程 section（Governor→Scheduler 调度结果）→ ContextProjection。
 * R7（候选来源扩展，§6.1 候选全集）：sources 提供 → 经 gatherContextCandidates 统一收集
 *   Memory/Evidence/Capability/Process/Artifact 候选（process 统一并入候选流——info_value 缺口匹配启发式
 *   动态估计，不再恒全源最高；evidence/capability/artifact 缺省无来源 → 无新增 section，
 *   既有调用零感知）；sources 缺省 → 旧调用面兼容：候选 = 仅 memory，process 走固定 section（R3 原语义）。
 * ΔInfoValue（S3，§17 首版承诺）：info_value 统一经 estimateInfoValue 缺口匹配启发式动态估计
 *   （memory 亦统一——r.value 为检索排序信号不直接作为投影价值；空闲期反馈修正留待 §17）。
 */
export async function buildContextProjection(
  policy: PolicyBundle,
  task: { goal: string; success_criteria: string[] },
  working_state: PromptWorkingState,
  items: RankedMemory[],
  process?: ProcessSectionInput | null,
  sources?: ContextCandidateSources & { session_id?: string },
): Promise<ContextProjection> {
  const memoryCandidates: CandidateItem[] = items.map((r) => ({
    id: r.memory.id,
    kind: 'memory',
    content: r.memory.payload,
    tokens: estimateTokens(r.memory.payload),
    view: 'planning',
    info_value: estimateInfoValue(r.memory.payload, working_state),
    source_ref: r.memory.id,
  }));
  if (sources === undefined) {
    // 旧调用面兼容（无候选来源）：候选 = 仅 memory；process 走 renderer 固定 section（R3 语义）
    return compile({
      task_contract: { goal: task.goal, success_criteria: task.success_criteria },
      working_state,
      process_section: process ?? undefined,
      candidates: memoryCandidates,
      budget_tokens: policy.budget.context_budget_tokens,
      policy: policy.context,
    });
  }
  // R7：候选统一入口——全来源收集（process 统一并入候选流；空来源 → 无新增 section）。
  // S3：memory 候选统一经 gather（estimateInfoValue 启发式）——sources 路径不再重复预置 memoryCandidates
  //   （原实现 sources 路径 memory 候选双份；S3 使 memory 可入选后重复会进入投影 → 一致性修正）。
  const gathered = await gatherContextCandidates({
    working_state,
    goal: task.goal,
    memory_items: items,
    runtime: sources,
    process: process ?? undefined,
    session_id: sources.session_id,
  });
  return compile({
    task_contract: { goal: task.goal, success_criteria: task.success_criteria },
    working_state,
    candidates: toCandidateItems(gathered),
    budget_tokens: policy.budget.context_budget_tokens,
    policy: policy.context,
  });
}

/**
 * R3：调度结果 → ContextProjection 过程 section 输入（纯映射）。无过程（kind=none/异常降级）→ null
 * ——投影不含「认知过程」section（降级不阻塞 prepareTurn 其余流程）。token 受控：renderer 侧紧凑渲染。
 */
export function toProcessSection(scheduled: ProcessDecisionInfo): ProcessSectionInput | null {
  if (scheduled.kind === 'none' || scheduled.process_id === null) {
    return null;
  }
  return {
    process_id: scheduled.process_id,
    name: scheduled.name ?? scheduled.process_id,
    steps: scheduled.steps,
    budget_tokens: scheduled.budget_tokens ?? 0,
    method: scheduled.method,
  };
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
      environment: { os: process.platform, node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
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

// ---- R4（P0）：Experience Admission 纯函数面（§5.2/§7.2：experience → staging 的最小适配） ----

/** Experience staging 行 priority（高于 decision/made 默认 7——经验记忆为学习核心写入；待标定 §17） */
export const EXPERIENCE_STAGE_PRIORITY = 8;

/** 每 finalizeTurn 最多 staging 的 Experience 条数（量级守卫；当前每 turn 仅产 1 候选——
 *  上限为批扩展预留；待标定 §17） */
export const MAX_EXPERIENCES_STAGED_PER_TURN = 5;

/** Experience（C11 PCR）→ 记忆 payload（可检索文本：context/action/result 拼装；规范化哈希 = 去重键） */
export function experienceStagePayload(experience: Experience): string {
  return `经验：${experience.context}；行动：${experience.action}；结果：${experience.result}`;
}

/** Experience → staging 幂等键（§11.3 event_id）：scope/kind/规范化 PCR 文本的内容哈希——相同经验
 * （同内容，时间戳不参与）重复 finalizeTurn → stage no-op（重复去重；admit 层 contentExists 同语义兜底） */
export function experienceStageKey(experience: Experience): string {
  return `exp:stage:${contentHash('Project', 'Episodic', experienceStagePayload(experience))}`;
}

/**
 * R4：Experience（C11 PCR）→ M3 staging 事件（§7.2 Event → staging 的适配：staging 面向 Event 而非
 * Experience——experience 转 Event（payload.memory 承载记忆候选）后走既有 stage/admit 路径）。
 * 准入规则（§7.2 纯代码；本函数为 experience 侧前置 gate）：
 *   - 来源（无来源不入）：provenance 缺失/空 source/空 event → null（不入 staging）——记忆须可溯源；
 *   - scope：固定 Project（经验记忆跨会话可检索；会话内细节留在事件链，P7 事实源）；
 *   - kind：Episodic（经验记忆维度；MemoryKindEnum 无 Experience——consolidate KIND_LINK_RULES 同款映射）；
 *   - prov_class：System-derived（系统确定性产出的 PCR 记录；信任序 1，稳定门槛 priority ≥ 2——
 *     EXPERIENCE_STAGE_PRIORITY=8 达标）；
 *   - 幂等键：experienceStageKey（内容哈希——重复经验 stage no-op）。
 * 无 I/O 纯函数；staging 写入与量级守卫在 assembly 侧（CognitiveRuntime.stageExperiences）。
 */
export function experienceToStageEvent(experience: Experience, sessionId: string, snapshotHash: string): Event | null {
  const prov = experience.provenance;
  if (
    prov === undefined ||
    typeof prov.source !== 'string' ||
    prov.source.length === 0 ||
    typeof prov.event !== 'string' ||
    prov.event.length === 0
  ) {
    return null; // 无来源 → 不入 staging
  }
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
      source: prov.source,
      event: experienceStageKey(experience),
      actor: prov.actor,
      environment: prov.environment,
      runtime_snapshot: snapshotHash,
      timestamp: ts,
      transformation_chain: [...prov.transformation_chain, 'experience-admission'],
      verification: 'r4-experience-admission',
    },
    refs: [],
    type: 'decision/made',
    session_id: sessionId,
    runtime_snapshot: snapshotHash,
    parent_event: null,
    payload: {
      memory: {
        scope: 'Project',
        kind: 'Episodic',
        prov_class: 'System-derived',
        payload: experienceStagePayload(experience),
        value_score: 0.5,
      },
    },
    timestamp: ts,
  };
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
      environment: { os: process.platform, node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
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
