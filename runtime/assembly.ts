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
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { GIT_BIN, defaultLayout } from '../substrate/snapshot.js';
import { ensureLineSnapshot, isVersionLine, type VersionLine, type VersionLayout } from '../substrate/lines.js';
import {
  createSnapshot,
  SnapshotRegistry,
  type ComponentHashes,
  type LineHashInput,
} from '../supervisor/versioning.js';
import { computeComponentHashes, computeDirContentHash } from './snapshot-hash.js';
import { makeMutableId } from '../kernel/schemas/base.js';
import type { ContextProjection } from '../kernel/schemas/a.js';
import { EventSchema, type Event, type Checkpoint, type RuntimeSnapshot } from '../kernel/schemas/m.js';
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

/** 仓库根候选（本文件 src 布局在 <preset>/runtime/ → 上一级即 preset 根；编译布局 <preset>/lib/runtime/ → 多一层） */
const HERE_CANDIDATE = fileURLToPath(new URL('..', import.meta.url));
/** 仓库根：存在性回退（src 布局 HERE_CANDIDATE 即根；编译布局其下无 kernel/policy → 取上级） */
const HERE = existsSync(join(HERE_CANDIDATE, 'kernel', 'policy')) ? HERE_CANDIDATE : dirname(HERE_CANDIDATE);

/** RuntimeSnapshot.id（sha256:<64hex>）→ 运行时快照哈希字符串（rs:<前16hex>，D1⑤ 格式） */
function runtimeHashOf(snapshot: RuntimeSnapshot): string {
  return `rs:${snapshot.id.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/** 全降级占位组件（64-hex 合法；仅结构完整供 registry 构造，不参与生效哈希） */
const DEGRADED_COMPONENTS: ComponentHashes = {
  scheduler: '00'.repeat(32),
  memory: '00'.repeat(32),
  verifier: '00'.repeat(32),
  renderer: '00'.repeat(32),
  capability: '00'.repeat(32),
  philosophy: '00'.repeat(32),
};

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 回退路径 git HEAD（既有实现：defaultLayout().bareRepo rev-parse HEAD）；失败 → 抛错（调用方全降级） */
function gitHeadOfDefaultLayout(): string {
  return execFileSync(GIT_BIN, ['rev-parse', 'HEAD'], {
    cwd: defaultLayout().bareRepo,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/**
 * P1b：快照身份构建（提交级运行时快照，D1⑤：请求运行于「线 stable + commit a81f + 快照 rs:7c91」）。
 * 哈希输入 = 当前版本线 commit（lines 指针 commit，P1a lineSnapshot.commit）+ 实际生效目录内容哈希
 * （policy/processes 文件内容——P1a 注入目录；未注入（回退 repo 默认）则 repo 目录内容）+ 六组件内容哈希。
 * 确定性：同线同 commit 同内容 → 同哈希；不同线 commit → 不同哈希（测试钉住）。
 * 失败降级：lines 不可用时回退既有实现（git HEAD + 内容哈希）；任一步失败 → 抛错（调用方降级 'rs:assembly'，不崩）。
 */
function buildSnapshotIdentity(dirs: LineDirResolution, presetRoot: string): RuntimeSnapshot {
  const dirContentHash = computeDirContentHash(dirs.policyDir, dirs.processesDir);
  const components = computeComponentHashes(presetRoot);
  // 线 commit（lines 指针；P1a 注入目录自然覆盖）→ 哈希 gitRevision；未注入（回退 repo 默认）→ 既有 git HEAD
  const gitRevision = dirs.lineSnapshot !== null ? dirs.lineSnapshot.commit : gitHeadOfDefaultLayout();
  const lineInput: LineHashInput | undefined =
    dirs.lineSnapshot !== null
      ? { line: dirs.lineSnapshot.line, commit: dirs.lineSnapshot.commit, dirContentHash }
      : undefined;
  return createSnapshot({ components, gitRevision, line: lineInput });
}

export interface CognitiveAssemblyOptions {
  /** 用户态目录（缺省 workspace/.omb，架构 §3；memory.db/events.db 落此） */
  root?: string;
  memoryDb?: string;
  eventDb?: string;
  policyDir?: string;
  processesDir?: string;
  /** P1a：当前版本线（缺省 stable，架构 §11.1）——按线加载 policy/processes（lines/ 物化快照注入）；
   *  非法值 → 回退 stable；显式提供 policyDir/processesDir 时忽略（显式目录注入优先）。 */
  line?: VersionLine;
  /** P1a：lines 布局覆盖（测试注入 fixture；缺省真实 preset 布局 defaultLayout()） */
  layout?: VersionLayout;
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

/** P1a：已注入的线快照信息（lines 物化快照；未注入 → null） */
export interface LineSnapshotInfo {
  line: VersionLine;
  commit: string;
  dir: string;
}

/** 按线解析结果（policy/processes 目录 + 快照信息 + 降级原因） */
interface LineDirResolution {
  policyDir: string;
  processesDir: string;
  lineSnapshot: LineSnapshotInfo | null;
  lineDegraded: string | null;
}

/**
 * P1a：按线解析 policy/processes 目录（D1 裁决：运行时按当前版本线从 lines 物化快照加载）。
 * 最佳努力（装配失败不崩）：线快照存在 kernel/policy + kernel/processes → 注入线快照路径；
 * 缺失（旧布局种子无 policy）/ lines 不可用 → 回退仓库默认目录 + 降级原因（不抛）。
 * 显式提供 policyDir/processesDir → 显式目录优先（测试/兼容注入，不走按线加载）。
 */
function resolveLineDirs(opts: CognitiveAssemblyOptions, line: VersionLine): LineDirResolution {
  const defaultPolicyDir = join(HERE, 'kernel', 'policy');
  const defaultProcessesDir = join(HERE, 'kernel', 'processes');
  if (opts.policyDir !== undefined || opts.processesDir !== undefined) {
    return {
      policyDir: opts.policyDir ?? defaultPolicyDir,
      processesDir: opts.processesDir ?? defaultProcessesDir,
      lineSnapshot: null,
      lineDegraded: null,
    };
  }
  try {
    const snap = ensureLineSnapshot(opts.layout ?? defaultLayout(), line);
    const snapPolicyDir = join(snap.dir, 'kernel', 'policy');
    const snapProcessesDir = join(snap.dir, 'kernel', 'processes');
    if (existsSync(snapPolicyDir) && existsSync(snapProcessesDir)) {
      return {
        policyDir: snapPolicyDir,
        processesDir: snapProcessesDir,
        lineSnapshot: { line, commit: snap.commit, dir: snap.dir },
        lineDegraded: null,
      };
    }
    return {
      policyDir: defaultPolicyDir,
      processesDir: defaultProcessesDir,
      lineSnapshot: null,
      lineDegraded: `版本线 ${line} 快照缺少 kernel/policy 或 kernel/processes（${snap.dir}）——回退仓库默认策略/过程`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      policyDir: defaultPolicyDir,
      processesDir: defaultProcessesDir,
      lineSnapshot: null,
      lineDegraded: `lines 按线加载不可用（${detail}）——回退仓库默认策略/过程`,
    };
  }
}

/** 认知运行时（装配产物；plugin.ts 的 CognitiveRuntimeLike 结构上满足） */
export class CognitiveRuntime {
  readonly eventStore: EventStore;
  readonly memory: RetrievalBackend;
  /**
   * P1b：当前（最新）运行时快照哈希（rs:<16hex>；opts.snapshotHash 覆盖注入；全降级 → 'rs:assembly'）。
   * getter 语义：promote（/mode 切换 / rebuildSnapshotForLine）后反映新快照——事件 provenance 用最新快照；
   * 请求级锁定见 prepareTurn（§6.5.7：请求开始解析快照，整个请求只读该快照，晋升只影响后续请求）。
   */
  get snapshotHash(): string {
    if (this.snapshotOverride !== null) {
      return this.snapshotOverride;
    }
    if (this.degraded) {
      return 'rs:assembly';
    }
    return runtimeHashOf(this.registry.currentSnapshot);
  }
  /** T8.12：注入的 ModelAdapter（无真实 DSH 会话 → null，LLM 路径缺省受限） */
  readonly modelAdapter: ModelAdapter | null;
  /** P1b：生效 policy/processes 目录（线快照注入或仓库默认）；rebuildSnapshotForLine 成功后切换（下一请求生效） */
  policyDir: string;
  processesDir: string;
  /** P1b：已注入的线快照（按线加载成功 → 快照信息；否则 null）；rebuildSnapshotForLine 成功后切换 */
  lineSnapshot: LineSnapshotInfo | null;
  /** P1b：lines 按线加载降级原因（线快照缺 policy / lines 不可用 → 回退仓库默认；无降级 → null） */
  lineDegraded: string | null;
  private readonly checkpointDir: string | undefined;
  /** 维护调度器（生产装配注入；插件经此在请求间隙驱动 requestQuantum/停表——公开面） */
  readonly maintenance: MaintenanceScheduler | null;
  private policyPromise: Promise<PolicyBundle> | null = null;
  private processesPromise: Promise<readonly ProcessDef[]> | null = null;
  /** P1b：请求级快照注册表（装配期创建；prepareTurn 绑定 / finalizeTurn 释放 / promote 切换，§6.5.7） */
  private readonly registry: SnapshotRegistry;
  /** P1b：装配选项（rebuildSnapshotForLine 重新解析新线目录用） */
  private readonly assemblyOpts: CognitiveAssemblyOptions;
  /** P1b：snapshotHash 覆盖注入（opts.snapshotHash；兼容既有注入面——provenance 常量，registry 结构照常） */
  private readonly snapshotOverride: string | null;
  /** P1b：快照身份构建全降级（既有契约 'rs:assembly'；装配不因快照计算失败中断） */
  private degraded = false;
  private identityError: string | null = null;

  constructor(opts: CognitiveAssemblyOptions = {}) {
    const root = opts.root ?? join(HERE, 'workspace', '.omb');
    this.eventStore = new EventStore(opts.eventDb ?? join(root, 'events.db'));
    this.memory = new RetrievalBackend(opts.memoryDb ?? join(root, 'memory.db'));
    const line = isVersionLine(opts.line) ? opts.line : 'stable';
    const dirs = resolveLineDirs(opts, line);
    this.policyDir = dirs.policyDir;
    this.processesDir = dirs.processesDir;
    this.lineSnapshot = dirs.lineSnapshot;
    this.lineDegraded = dirs.lineDegraded;
    // P1b：装配期初始快照 = 当前版本线 commit + 实际生效目录内容 + 组件哈希（lines 不可用 → 回退既有实现）；
    // 快照计算失败 → 全降级 'rs:assembly'（registry 以确定性占位快照构造，结构完整不炸）
    this.assemblyOpts = opts;
    this.snapshotOverride = opts.snapshotHash ?? null;
    try {
      const identity = buildSnapshotIdentity(dirs, HERE);
      this.registry = new SnapshotRegistry(identity);
      this.degraded = false;
    } catch (err) {
      this.registry = new SnapshotRegistry(
        createSnapshot({ components: DEGRADED_COMPONENTS, gitRevision: 'degraded' }),
      );
      this.degraded = true;
      this.identityError = errorDetail(err);
    }
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
    // P1b：请求开始解析快照（未绑定 → 绑定当前快照，整个请求锁定 §6.5.7；晋升只影响后续请求）
    const snapshot = this.resolveRuntimeSnapshot(req.session_id);
    const working_state = await this.loadWorkingState(req);
    const decision = decide(this.buildGovernorInput(req, processes, policy, snapshot), policy.governor);
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
        makeRuntimeEvent('context/injected', req.session_id, snapshot, {
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
    // P1b：请求级快照锁定——已绑定（prepareTurn）→ 返回绑定快照（进行中请求不受 promote 影响）；未绑定 → 绑定当前
    const snapshot = this.resolveRuntimeSnapshot(input.session_id);
    const made = makeRuntimeEvent('decision/made', input.session_id, snapshot, {
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
      checkpoint = await saveCheckpoint(input.state, { dir: this.checkpointDir, runtime_snapshot: snapshot });
    }

    // P1b：请求结束 → 释放快照绑定（未绑定请求 end 为空操作——cleanup 路径幂等安全）
    this.registry.end(input.session_id);

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
      makeRuntimeEvent('session/start', req.session_id, prepared.snapshot, { goal: req.goal }, ['handleRequest']),
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

  /**
   * P1b：/mode 切换后重建运行时快照（D1⑤：下一请求生效）：
   * 新线物化（ensureLineSnapshot）→ 新线 commit + 目录内容 + 组件 → registry.promote
   * （进行中请求不受影响，§6.5.7）→ 切换 policy/processes 目录（线快照注入）+ 重置懒加载缓存（下一请求从新线加载）。
   * 失败降级：物化/解析失败 → 当前快照与目录保持，返回降级原因（切换状态仍生效，快照不变）。
   */
  rebuildSnapshotForLine(line: VersionLine): { promoted: boolean; degraded: string | null } {
    if (this.snapshotOverride !== null || this.degraded) {
      return {
        promoted: false,
        degraded: this.degraded
          ? `快照机制已降级（${this.identityError ?? 'rs:assembly'}）——切换后快照未重建`
          : '快照哈希被覆盖注入（opts.snapshotHash）——切换后快照未重建',
      };
    }
    let dirs: LineDirResolution;
    try {
      dirs = resolveLineDirs(this.assemblyOpts, line);
    } catch (err) {
      return { promoted: false, degraded: `新版本线 ${line} 解析失败（${errorDetail(err)}）——当前快照保持` };
    }
    if (dirs.lineSnapshot === null) {
      return { promoted: false, degraded: dirs.lineDegraded ?? `版本线 ${line} 快照未就绪——当前快照保持` };
    }
    try {
      this.registry.promote(buildSnapshotIdentity(dirs, HERE)); // promote 校验非法快照 fail-loud（registry 状态不被污染）
      // 下一请求生效：切换 policy/processes 目录（线快照注入）+ 重置懒加载缓存（ready() 从新线重载）
      this.policyDir = dirs.policyDir;
      this.processesDir = dirs.processesDir;
      this.lineSnapshot = dirs.lineSnapshot;
      this.lineDegraded = dirs.lineDegraded;
      this.policyPromise = null;
      this.processesPromise = null;
      return { promoted: true, degraded: null };
    } catch (err) {
      return { promoted: false, degraded: `快照重建失败（${errorDetail(err)}）——当前快照保持` };
    }
  }

  /** P1b/P1e：外部晋升接口（构建好新快照后 promote → 下一请求生效；进行中请求不受影响，§6.5.7） */
  promoteSnapshot(next: RuntimeSnapshot): void {
    this.registry.promote(next);
  }

  // ---- 内部 ----

  /** 请求级快照解析（P1b §6.5.7）：未绑定 → 绑定当前快照并返回（整个请求锁定）；已绑定 → 原快照。
   *  全降级 / 覆盖注入 → 常量（无绑定语义，兼容既有 'rs:assembly' 契约）。 */
  private resolveRuntimeSnapshot(reqId: string): string {
    if (this.snapshotOverride !== null) {
      return this.snapshotOverride;
    }
    if (this.degraded) {
      return 'rs:assembly';
    }
    const bound = this.registry.resolveSnapshot({ id: reqId }, { current: this.registry.currentSnapshot });
    return runtimeHashOf(bound);
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
    snapshot: string,
  ): GovernorInput {
    const envelope = policy.budget;
    const es = req.evidence_sufficiency ?? {
      covered_success_conditions: [],
      critical_gaps: [req.goal],
      score: 0,
    };
    return {
      task_contract: { goal: req.goal, success_criteria: req.success_criteria },
      state_snapshot: { snapshot_hash: snapshot },
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
