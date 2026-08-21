// layer 2：认知系统装配（组合根，架构 §12.2 运行形态 / T8.3 装配进插件生命周期）。
// 把 governor（runtime/governor.ts）、memory（memory/backend-retrieval.ts）、event-store
// （supervisor/event-store.ts）、过程库（kernel/processes）实例化为可用依赖图并注入插件；
// 最小请求处理链：事件入链（session/start）→ Governor 决策 → 记忆检索 → prompt 组装 →
// 决策结果入链（decision/made）。
//
// 层 DAG（CONVENTIONS §4）：runtime(2) → supervisor(1)/memory(2)/kernel(2) 均满足
// "import 目标层 ≤ 源层"（eslint no-cross-layer-import 同款语义，tests/m0/dag-lint.test.ts 钉住）。
// 策略/过程为"机制即数据"（P3）：懒加载（首次请求），改 YAML 即生效。
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeMutableId } from '../kernel/schemas/base.js';
import type { Event } from '../kernel/schemas/m.js';
import { loadPolicy, loadProcesses, type PolicyBundle, type ProcessDef } from '../kernel/policy-loader.js';
import { EventStore } from '../supervisor/event-store.js';
import { RetrievalBackend } from '../memory/backend-retrieval.js';
import { retrieve, type RankedMemory } from '../memory/retrieve.js';
import { assessApplicability, type WorkingState } from './generator-ops.js';
import { decide, type GovernorDecision, type GovernorInput } from './governor.js';
import { buildPrompt, type BuiltPrompt, type PromptWorkingState } from './prompt.js';

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
}

/** 请求（最小链输入）：会话事实 + 任务契约 + 工作状态 */
export interface CognitiveRequest {
  session_id: string;
  goal: string;
  success_criteria: string[];
  constraints?: string[];
  working_state: PromptWorkingState;
  environment?: string;
  /** 证据充分性覆盖（缺省：缺口=[goal]——未覆盖 → 查决策表而非短路 Stop） */
  evidence_sufficiency?: { covered_success_conditions: string[]; critical_gaps: string[]; score: number };
}

/** 请求处理结果（决策 + 检索 + prompt + 入链事件数） */
export interface CognitiveResponse {
  decision: GovernorDecision;
  retrieval: { items: RankedMemory[]; channel_used: string };
  prompt: BuiltPrompt;
  events_appended: number;
}

/** 认知运行时（装配产物；plugin.ts 的 CognitiveRuntimeLike 结构上满足） */
export class CognitiveRuntime {
  readonly eventStore: EventStore;
  readonly memory: RetrievalBackend;
  readonly snapshotHash: string;
  private readonly policyDir: string;
  private readonly processesDir: string;
  private policyPromise: Promise<PolicyBundle> | null = null;
  private processesPromise: Promise<readonly ProcessDef[]> | null = null;

  constructor(opts: CognitiveAssemblyOptions = {}) {
    const root = opts.root ?? join(HERE, 'workspace', '.omb');
    this.eventStore = new EventStore(opts.eventDb ?? join(root, 'events.db'));
    this.memory = new RetrievalBackend(opts.memoryDb ?? join(root, 'memory.db'));
    this.policyDir = opts.policyDir ?? join(HERE, 'kernel', 'policy');
    this.processesDir = opts.processesDir ?? join(HERE, 'kernel', 'processes');
    this.snapshotHash = opts.snapshotHash ?? 'rs:assembly';
  }

  /** 装配就绪（策略/过程懒加载——机制即数据，改 YAML 即生效）；幂等 */
  async ready(): Promise<{ policy: PolicyBundle; processes: readonly ProcessDef[] }> {
    this.policyPromise ??= loadPolicy(this.policyDir);
    this.processesPromise ??= loadProcesses(this.processesDir);
    return { policy: await this.policyPromise, processes: await this.processesPromise };
  }

  /**
   * 最小请求处理链（T8.3 验收核心）：
   * ① 事件入链（session/start，payload=goal）→ ② Governor 决策（表驱动，表外短路 Stop）
   * → ③ 记忆检索（lexical FTS，goal 文本）→ ④ prompt 组装（任务语义静态区 + 工作状态动态尾部）
   * → ⑤ 决策结果入链（decision/made）。
   */
  async handleRequest(req: CognitiveRequest): Promise<CognitiveResponse> {
    const { policy, processes } = await this.ready();

    const start = this.makeEvent('session/start', req, { goal: req.goal });
    await this.eventStore.append(start);

    const input = this.buildGovernorInput(req, processes, policy);
    const decision = decide(input, policy.governor);

    const retrieved = await retrieve(
      this.memory,
      { scope: 'Project', text: req.goal, limit: 3, budget: 1000 },
      { episode: false },
    );

    const prompt = buildPrompt({
      session_id: req.session_id,
      task_contract: {
        goal: req.goal,
        constraints: req.constraints ?? [],
        success_criteria: req.success_criteria,
      },
      working_state: req.working_state,
    });

    const made = this.makeEvent('decision/made', req, {
      decision: decision.decision,
      reason: decision.reason,
    });
    await this.eventStore.append(made);

    return {
      decision,
      retrieval: { items: retrieved.items, channel_used: retrieved.channel_used },
      prompt,
      events_appended: 2,
    };
  }

  /** 关闭存储连接（Windows WAL 收尾先 close；幂等） */
  async close(): Promise<void> {
    await this.eventStore.close();
    await this.memory.close();
  }

  // ---- 内部 ----

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

  /** M3 事件构造（可变对象 uuid id；时间戳实时——事件为运行时事实） */
  private makeEvent(type: Event['type'], req: CognitiveRequest, payload: Record<string, unknown>): Event {
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
        runtime_snapshot: this.snapshotHash,
        timestamp: ts,
        transformation_chain: ['handleRequest'],
        verification: 'assembly-chain',
      },
      refs: [],
      type,
      session_id: req.session_id,
      runtime_snapshot: this.snapshotHash,
      parent_event: null,
      payload,
      timestamp: ts,
    };
  }
}

/** 装配入口（组合根）：实例化认知依赖图 */
export function createCognitiveRuntime(opts: CognitiveAssemblyOptions = {}): CognitiveRuntime {
  return new CognitiveRuntime(opts);
}
