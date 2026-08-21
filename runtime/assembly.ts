// layer 2：认知系统装配（组合根，架构 §12.2 运行形态 / T8.3 装配进插件生命周期）。
// T8.26.2：三能力拆分（Loop Integration 专项 §3）——prepareTurn（turn 开始：快照/工作状态/决策/检索/
// 投影编译/注入）+ observeEvent（运行中：事件入链 + 归约）+ finalizeTurn（收尾：decision/made +
// Experience 候选 + 信号聚合 + checkpoint + maintenance）；handleRequest = 三者组合（行为不变）。
// 纯函数助手在 runtime/turn-helpers.ts（LOC 预算拆分，本文件 ≤400）。
//
// 层 DAG（CONVENTIONS §4）：runtime(2) → supervisor(1)/memory(2)/kernel(2) 均满足
// "import 目标层 ≤ 源层"（eslint no-cross-layer-import 同款语义，tests/m0/dag-lint.test.ts 钉住）。
// 策略/过程为"机制即数据"（P3）：懒加载（首次请求），改 YAML 即生效。
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeMutableId } from '../kernel/schemas/base.js';
import type { ContextProjection } from '../kernel/schemas/a.js';
import { EventSchema, type Event, type Checkpoint } from '../kernel/schemas/m.js';
import type { State } from '../kernel/schemas/s.js';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import { loadPolicy, loadProcesses, type PolicyBundle, type ProcessDef } from '../kernel/policy-loader.js';
import { EventStore } from '../supervisor/event-store.js';
import { latest as latestCheckpoint, restore as restoreCheckpoint, save as saveCheckpoint } from '../supervisor/checkpoint.js';
import { MaintenanceScheduler, type MaintenanceDebt } from '../supervisor/maintenance.js';
import { reduce, type Projections, type ReducedState, type UtilityCounts } from '../supervisor/state-reducer.js';
import { RetrievalBackend } from '../memory/backend-retrieval.js';
import { retrieve, type RankedMemory } from '../memory/retrieve.js';
import { assessApplicability, type WorkingState } from './generator-ops.js';
import { decide, type GovernorDecision, type GovernorInput } from './governor.js';
import { buildPrompt, type BuiltPrompt, type PromptWorkingState } from './prompt.js';
import { buildContextProjection, buildExperienceCandidate, makeRuntimeEvent, toPromptWorkingState } from './turn-helpers.js';
import type { Experience } from '../kernel/schemas/c.js';

/** 仓库根（本文件在 <preset>/runtime/ → 上一级即 preset 根） */
const HERE = fileURLToPath(new URL('..', import.meta.url));

export interface CognitiveAssemblyOptions {
  /** 用户态目录（缺省 workspace/.omb，架构 §3；memory.db/events.db 落此） */
  root?: string;
  memoryDb?: string;
  eventDb?: string;
  policyDir?: string;
  processesDir?: string;
  /** Governor 输入 state_snapshot（缺省 'rs:assembly'） */
  snapshotHash?: string;
  /** T8.12：ModelAdapter（DSH 模型调用适配器）——组合根经 deps 注入；未注入 → 缺省受限（纯规则阶梯） */
  modelAdapter?: ModelAdapter;
  /** T8.26.2：checkpoint 目录（finalizeTurn 保存 / prepareTurn 恢复；缺省不接） */
  checkpointDir?: string;
  /** T8.26.2：维护调度器（finalizeTurn 信号聚合入队；缺省不接） */
  maintenance?: MaintenanceScheduler;
}

/** 请求（最小链输入）：会话事实 + 任务契约 + 工作状态 */
export interface CognitiveRequest {
  session_id: string;
  goal: string;
  success_criteria: string[];
  constraints?: string[];
  working_state: PromptWorkingState;
  environment?: string;
  /** 证据充分性覆盖（缺省：缺口=[goal] → 查决策表而非短路 Stop） */
  evidence_sufficiency?: { covered_success_conditions: string[]; critical_gaps: string[]; score: number };
}

/** 请求处理结果（决策 + 检索 + prompt + 入链事件数） */
export interface CognitiveResponse {
  decision: GovernorDecision;
  retrieval: { items: RankedMemory[]; channel_used: string };
  prompt: BuiltPrompt;
  events_appended: number;
}

/** prepareTurn 结果（T8.26.2 §3.1）：快照 + 工作状态 + 决策 + 检索 + 投影 + 入链事件数 */
export interface PreparedTurn {
  snapshot: string;
  working_state: PromptWorkingState;
  decision: GovernorDecision;
  retrieval: { items: RankedMemory[]; channel_used: string };
  projection: ContextProjection;
  events_appended: number;
}

/** prepareTurn 选项：上下文注入接收器（T8.26.3：DSH systemPrompt.context 钩子；提供 → 注入并记 context/injected） */
export interface PrepareTurnOptions {
  inject?: (projection: ContextProjection) => void | Promise<void>;
}

/** observeEvent 结果（T8.26.2 §3.2）：事件 + 追加状态 + 归约 State/投影 + 降级原因 */
export interface ObserveEventResult {
  event: Event;
  appended: boolean;
  state: ReducedState | null;
  projections: Projections | null;
  degraded: string | null;
}

/** finalizeTurn 输入（T8.26.2 §3.3） */
export interface FinalizeTurnInput {
  session_id: string;
  decision: GovernorDecision;
  working_state: PromptWorkingState;
  /** 供 checkpoint 保存的 schema 合规 State（T1.5 契约；缺省不保存） */
  state?: State;
}

/** finalizeTurn 结果（T8.26.2 §3.3）：decision/made + Experience 候选 + 信号 + checkpoint + maintenance */
export interface FinalizeTurnResult {
  decision_event_id: string;
  experience: Experience | null;
  signals: UtilityCounts;
  signals_degraded: string | null;
  maintenance: { enqueued: boolean; debt: MaintenanceDebt[] };
  checkpoint: Checkpoint | null;
  events_appended: number;
}

/** 认知运行时（装配产物；plugin.ts 的 CognitiveRuntimeLike 结构上满足） */
export class CognitiveRuntime {
  readonly eventStore: EventStore;
  readonly memory: RetrievalBackend;
  readonly snapshotHash: string;
  /** T8.12：注入的 ModelAdapter（无真实 DSH 会话 → null，LLM 路径缺省受限） */
  readonly modelAdapter: ModelAdapter | null;
  private readonly policyDir: string;
  private readonly processesDir: string;
  private readonly checkpointDir: string | undefined;
  private readonly maintenance: MaintenanceScheduler | null;
  private policyPromise: Promise<PolicyBundle> | null = null;
  private processesPromise: Promise<readonly ProcessDef[]> | null = null;

  constructor(opts: CognitiveAssemblyOptions = {}) {
    const root = opts.root ?? join(HERE, 'workspace', '.omb');
    this.eventStore = new EventStore(opts.eventDb ?? join(root, 'events.db'));
    this.memory = new RetrievalBackend(opts.memoryDb ?? join(root, 'memory.db'));
    this.policyDir = opts.policyDir ?? join(HERE, 'kernel', 'policy');
    this.processesDir = opts.processesDir ?? join(HERE, 'kernel', 'processes');
    this.snapshotHash = opts.snapshotHash ?? 'rs:assembly';
    this.modelAdapter = opts.modelAdapter ?? null;
    this.checkpointDir = opts.checkpointDir;
    this.maintenance = opts.maintenance ?? null;
  }

  /** 装配就绪（策略/过程懒加载——机制即数据，改 YAML 即生效）；幂等 */
  async ready(): Promise<{ policy: PolicyBundle; processes: readonly ProcessDef[] }> {
    this.policyPromise ??= loadPolicy(this.policyDir);
    this.processesPromise ??= loadProcesses(this.processesDir);
    return { policy: await this.policyPromise, processes: await this.processesPromise };
  }

  /**
   * prepareTurn（§3.1）：turn 开始认知准备——快照/工作状态/Governor 决策（准备级）/分层检索/
   * ContextCompiler 投影编译；（提供注入接收器时）注入 + context/injected 入链（Model-visible ⟺ logged）。
   */
  async prepareTurn(req: CognitiveRequest, opts: PrepareTurnOptions = {}): Promise<PreparedTurn> {
    const { policy, processes } = await this.ready();
    const snapshot = this.resolveRuntimeSnapshot();
    const working_state = await this.loadWorkingState(req);
    const decision = decide(this.buildGovernorInput(req, processes, policy), policy.governor);
    const retrieved = await retrieve(
      this.memory,
      { scope: 'Project', text: req.goal, limit: 3, budget: 1000 },
      { episode: false },
    );
    const projection = buildContextProjection(policy, req, working_state, retrieved.items);

    let events_appended = 0;
    if (opts.inject !== undefined) {
      await opts.inject(projection);
      await this.eventStore.append(
        makeRuntimeEvent('context/injected', req.session_id, this.snapshotHash, {
          projection_id: projection.id,
          total_tokens: projection.total_tokens,
          views: [...new Set(projection.sections.map((s) => s.view))],
        }, ['prepareTurn']),
      );
      events_appended = 1;
    }

    return {
      snapshot,
      working_state,
      decision,
      retrieval: { items: retrieved.items, channel_used: retrieved.channel_used },
      projection,
      events_appended,
    };
  }

  /**
   * observeEvent（§3.2）：运行中事实入链——EventSchema 校验 → append（幂等）→ reducer 归约（
   * Observation → State；Contradiction 检测）→ 零成本信号。守卫：非法/重复/未注册类型 → 明确降级（不抛）。
   */
  async observeEvent(event: Event): Promise<ObserveEventResult> {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      return { event, appended: false, state: null, projections: null, degraded: `EventSchema: ${parsed.error.message}` };
    }
    const ev = parsed.data;
    let appended = true;
    try {
      await this.eventStore.append(ev);
    } catch (err) {
      if (err instanceof Error && err.message.includes('重复 id')) {
        appended = false; // 幂等：同一事件重复观测 → 不重复追加（§11.3 event_id 幂等键）
      } else {
        throw err; // 非重复类存储错误 fail-loud（非接口漂移场景）
      }
    }
    try {
      const sessionEvents = (await this.eventStore.query({ session_id: ev.session_id })).events;
      const { state, projections } = reduce(sessionEvents);
      return { event: ev, appended, state, projections, degraded: null };
    } catch (err) {
      // reducer 未注册类型/负载问题 → 事件已入链（事实源），归约明确降级
      return {
        event: ev,
        appended,
        state: null,
        projections: null,
        degraded: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * finalizeTurn（§3.3）：turn 收尾——decision/made 入链（reducer 兼容 payload）→ Experience 候选（PCR）→
   * 信号聚合（零成本 utility_counts）→ maintenance 入队（注入时）→ checkpoint 保存（dir + state 齐备时）。
   */
  async finalizeTurn(input: FinalizeTurnInput): Promise<FinalizeTurnResult> {
    const made = makeRuntimeEvent('decision/made', input.session_id, this.snapshotHash, {
      decision_id: makeMutableId('decision'),
      question: input.working_state.goal,
      chosen: input.decision.decision,
      reason: input.decision.reason,
    }, ['finalizeTurn']);
    await this.eventStore.append(made);

    const experience = buildExperienceCandidate(input.session_id, input.decision, input.working_state);

    const { signals, degraded } = await this.aggregateSignals(input.session_id);

    let maintenance: { enqueued: boolean; debt: MaintenanceDebt[] } = { enqueued: false, debt: [] };
    if (this.maintenance !== null) {
      await this.maintenance.enqueue({
        id: `turn-finalize:${input.session_id}`,
        value: 1,
        estimated_cost: 1,
        run: async () => {
          await this.eventStore.compact(Date.now());
        },
      });
      maintenance = { enqueued: true, debt: this.maintenance.debtSnapshot() };
    }

    let checkpoint: Checkpoint | null = null;
    if (this.checkpointDir !== undefined && input.state !== undefined) {
      checkpoint = await saveCheckpoint(input.state, { dir: this.checkpointDir, runtime_snapshot: this.snapshotHash });
    }

    return {
      decision_event_id: made.id,
      experience,
      signals,
      signals_degraded: degraded,
      maintenance,
      checkpoint,
      events_appended: 1,
    };
  }

  /**
   * 最小请求处理链（T8.3 验收核心；T8.26.2 改为三能力组合，行为不变）：
   * prepareTurn（决策/检索/投影，无注入 → 0 事件）→ observeEvent(session/start 入链 + 归约) →
   * 单轮模拟（模型可见 prompt 组装）→ finalizeTurn（decision/made 入链）。
   */
  async handleRequest(req: CognitiveRequest): Promise<CognitiveResponse> {
    const prepared = await this.prepareTurn(req);
    await this.observeEvent(
      makeRuntimeEvent('session/start', req.session_id, this.snapshotHash, { goal: req.goal }, ['handleRequest']),
    );
    const prompt = buildPrompt({
      session_id: req.session_id,
      task_contract: {
        goal: req.goal,
        constraints: req.constraints ?? [],
        success_criteria: req.success_criteria,
      },
      working_state: prepared.working_state,
    });

    const finalized = await this.finalizeTurn({
      session_id: req.session_id,
      decision: prepared.decision,
      working_state: prepared.working_state,
    });

    return {
      decision: prepared.decision,
      retrieval: prepared.retrieval,
      prompt,
      events_appended: 1 + finalized.events_appended,
    };
  }

  /** 关闭存储连接（Windows WAL 收尾先 close；幂等） */
  async close(): Promise<void> {
    await this.eventStore.close();
    await this.memory.close();
  }

  // ---- 内部 ----

  /** 请求级快照身份（T8.26.2 §3.1 step 1） */
  private resolveRuntimeSnapshot(): string {
    return this.snapshotHash;
  }

  /** 工作状态加载（§3.1 step 2）：checkpointDir 配置且存在 checkpoint → 恢复；否则请求携带的当前状态 */
  private async loadWorkingState(req: CognitiveRequest): Promise<PromptWorkingState> {
    if (this.checkpointDir === undefined) {
      return req.working_state;
    }
    try {
      const cp = await latestCheckpoint({ dir: this.checkpointDir });
      if (cp === null) {
        return req.working_state;
      }
      const state = await restoreCheckpoint(cp.id, { dir: this.checkpointDir });
      return toPromptWorkingState(state);
    } catch {
      return req.working_state; // checkpoint 不可用 → 降级到请求态
    }
  }

  /** 信号聚合（零成本）：会话事件 → reducer utility_counts；归约失败 → 全零 + 降级原因 */
  private async aggregateSignals(session_id: string): Promise<{ signals: UtilityCounts; degraded: string | null }> {
    try {
      const sessionEvents = (await this.eventStore.query({ session_id })).events;
      const { projections } = reduce(sessionEvents);
      return { signals: projections.utility_counts, degraded: null };
    } catch (err) {
      return {
        signals: { tool_calls: 0, retrieval_calls: 0, memory_ops: 0, corrections: 0, reads: 0, hits: 0 },
        degraded: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildGovernorInput(
    req: CognitiveRequest,
    processes: readonly ProcessDef[],
    policy: PolicyBundle,
  ): GovernorInput {
    const envelope = policy.budget;
    const es = req.evidence_sufficiency ?? {
      covered_success_conditions: [],
      critical_gaps: [req.goal],
      score: 0,
    };
    return {
      task_contract: { goal: req.goal, success_criteria: req.success_criteria },
      state_snapshot: { snapshot_hash: this.snapshotHash },
      environment: req.environment ?? 'default',
      candidate_processes: processes.map((p) => p.id),
      applicability_results: processes.map((p) => ({
        process_id: p.id,
        applicability: assessApplicability(p, { goal: req.goal, state: req.working_state as WorkingState }),
      })),
      budget: {
        envelope,
        remaining: {
          depth: envelope.depth,
          breadth: envelope.breadth,
          tools: envelope.tools,
          retrieval: envelope.retrieval,
          branches: envelope.branches,
          context: envelope.context,
        },
      },
      risk: 0,
      progress_vector: {
        constraint_reduction: 0,
        hypothesis_reduction: 0,
        hypothesis_discrimination: 0,
        evidence_strengthening: 0,
        goal_completion: 0,
        reproducibility: 0,
        uncertainty_reduction: 0,
      },
      uncertainty_vector: {},
      maintenance_state: { debt: 0 },
      evidence_sufficiency: es,
    };
  }
}

/** 装配入口（组合根）：实例化认知依赖图 */
export function createCognitiveRuntime(opts: CognitiveAssemblyOptions = {}): CognitiveRuntime {
  return new CognitiveRuntime(opts);
}
