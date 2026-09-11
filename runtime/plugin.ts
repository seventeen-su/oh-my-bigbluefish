// layer 2：Cordis function plugin 入口（DSH preset 挂载；agent.cordis.yml 指向编译产物 lib/runtime/plugin.js）。
// 不 import '@deepseek-ai/cordis'（harness 依赖，preset 内 tsc/vitest 无此包）：
// 用结构化最小接口类型化 ctx，运行时以 ctx.commands?.register?.(...) 守卫。
// 真实 DSH 运行时 Guard（vendor/cordis reflect.ts）：未声明的 ctx 属性读取/写入都会抛错
//（cannot get property "x" without inject / cannot set property "x" without provide）。
// 本插件遵守该契约：宿主服务一律经 ctx.get(name)（免 inject 读取，缺失 → undefined），
// 插件自身状态（认知运行时/ModelAdapter）存 apply 闭包，不写 ctx；测试 fakeCtx 无 get 时
// readService 退化到普通属性读取（行为不变，测试面兼容）。
// 无双 Loop（专项 §1 硬约束）：本插件仅观察/注入/命令注册——不替换、不包装、不重启 DSH Agent Loop；
// 模型调用归 DSH（llm 服务只读装配 ModelAdapter 供 /bench 用，不拦截对话模型路径）。
// M0：注册 /mode（handler 纯逻辑在 substrate/mode-command.ts）；/mode = OMB 内部版本线切换
//（单模式：load 校验 + 空白会话守卫 + onSwitch 记账；不涉及 DSH 预设切换）；注册 /bench（supervisor/bench.ts）。
// 函数插件契约：apply(ctx, config)——config 为 agent.cordis.yml 行的 config（Cordis Fiber 以第二参传入）。
import { cleanupStaleInitialWorktrees, disposeMaterializedInitial, isVersionLine, loadVersion, type VersionLine } from '../substrate/snapshot.js';
import { ensureThreeLineLayout } from '../substrate/bootstrap.js';
// 外核安全状态（已知问题《内核加载失败不得阻塞宿主》/《外核自身也要非阻塞》）：拉起内核前的轻量自检
import { evaluateSafeState, substrateRootOf } from '../substrate/safe-state.js';
// 外核平台提供者（状态面暴露当前平台与能力；排障用）
import { platformProvider } from '../substrate/platform.js';
import { sandboxStatusAsync } from '../substrate/sandbox.js';
import { bootStable, type BootOptions, type BootResult } from '../substrate/boot.js';
import { modeCommandHandler } from '../substrate/mode-command.js';
import { loadBenchTasks, makeReplayExecutor, runBench, BENCH_REPORTS_DIR } from '../supervisor/bench.js';
import { loadBenchContractsV2, loadBenchFixturesV2, makeReplayExecutorV2, runBenchV2, type BenchExecutorV2 } from '../supervisor/bench-v2.js';
import { makeRealExecutor, makeRealExecutorV2 } from '../supervisor/real-executor.js';
import { makeJudgeV2 } from '../supervisor/judge.js';
import { createCognitiveRuntime } from './assembly.js';
import { registerKernTools, type KernRuntimeLike, type KernStatusSummary, type ToolsLike } from './kern-tools.js';
import { createDshModelAdapter, type LlmStreamLike } from './model-adapter.js';
import { buildRequestFromSession, fallbackFinalizeDecision, fallbackWorkingState, lastUserMessageText, projectionToText, recordDegradation } from './loop-hooks.js';
import { initialTraceState, mapLiveToolResult, mapSessionEvent } from './dsh-events.js';
import { reduce } from '../supervisor/state-reducer.js';
import { MaintenanceScheduler, DEFAULT_MAINTENANCE_BATCH, DEFAULT_TICK_INTERVAL_MS } from '../supervisor/maintenance.js';
// S2：验证债务队列（layer 1 JSONL——plugin 装配面显式注入隔离根；与 assembly 缺省同路径语义）
import { VerificationDebt } from '../supervisor/verification-debt.js';
// W3（未接线审计修复 2026-08-25）：dynamicCordisRunner 结构最小面（S9 增强通道——候选验证脚本经动态
// 插件半执行；supervisor 层 1——runtime(2) → supervisor(1) ✓）
import type { DynamicCordisRunnerLike } from '../supervisor/dynamic-runner.js';
// S2：单次结构化 Judge 执行器（空白子代理同模型裁判——装配面注入 spawnJudge）
import { createJudgeExecutor } from './judge-executor.js';
import { writeCompleted, writePending, clearPending } from '../supervisor/activation-log.js';
import { ActivationContractSchema, type ActivationContract } from '../kernel/schemas/m.js';
import { dshEventId, makeDshEvent } from './loop-hooks.js';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ContextProjection } from '../kernel/schemas/a.js';
import type { Event } from '../kernel/schemas/m.js';
import type { State } from '../kernel/schemas/s.js';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import type { BenchFixtureV2, BenchLine } from '../kernel/schemas/bench.js';
import type { GovernorDecision } from './governor.js';
import type { PromptWorkingState } from './prompt.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';
// W5：OMB Runtime Contract（三层结构）——第一层固定契约（OMB_RUNTIME_CONTRACT）+ 第二层动态能力行
//（buildCapabilitiesLine）+ 第三层 skill 路径纯函数（skillSourcePath/skillMirrorPath——镜像接线）。
// 层 DAG 合规：runtime-contract.ts 只依赖 node:path 与类型（runtime(2) → runtime(2) ✓）。
import { buildCapabilitiesLine, OMB_RUNTIME_CONTRACT, skillMirrorPath, skillSourcePath } from './runtime-contract.js';

export const name = 'omb-v2';
export const inject = ['commands'];

/** DSH 插件配置面（agent.cordis.yml 行 config；Cordis 函数插件第二参传入 apply） */
export interface PluginConfig {
  /** 认知装配根（用户态目录，架构 §3 workspace/.omb；缺省装配路径） */
  cognitiveRoot?: string;
  /** T8.12：ModelAdapter 装配的模型路由（provider/model 齐备且 llm 服务存在 → 自动装配） */
  model?: { provider?: string; model?: string };
  /** 基准明细落盘目录（/bench 真实/回放逐任务 JSONL；缺省 BENCH_REPORTS_DIR = <preset>/workspace/.omb/bench） */
  benchPersistDir?: string;
  /**
   * 基准版本选择：缺省 'v2'（契约基准 benchmark-v2-contract——输入工件 + requirement + output_schema +
   * verifier rules 四要素单一权威，fixture 由 reference 生成）；'v1' 切回 legacy 录制基准
   * （benchmark-v1-legacy，kernel/bench-tasks/{tasks,fixtures}/ 原位保留，两版本并存可对比）。
   */
  benchVersion?: 'v2' | 'v1';
  /** 版本激活记录持久化目录（/mode 切换时写入 completed/<id>.json，T8.7 幂等持久化；缺省不落盘） */
  activationLogDir?: string;
  /** 分享后自动初始化三线布局与只读 ACL（专项「进程内自动初始化」；缺省 true；测试与手动控制用 bootstrap: false 关闭） */
  bootstrap?: boolean;
  /** 固定初始版本线（缺省 stable；后备/兼容机制 scripts/deploy-lines.ts 生成的 per-line 预设
   *  （omb-v2-initial/stable/latest）在 agent.cordis.yml 注入本配置固定本线初始版本线） */
  line?: VersionLine;
  /** R2 启动竞态修复：boot 入口注入（最小可测性注入面——测试注入延迟 resolve / 失败 boot；
   *  缺省真实 bootStable）。语义等同 bootStable(opts)：ok:true / ok:false（无恢复路径）/ rollback。 */
  bootStableOverride?: (opts?: BootOptions) => Promise<BootResult>;
  /** R6：宿主 DSH 版本覆写（可选；提供 → 覆写运行时指纹/事件 provenance 的 dsh_version 唯一来源；
   *  缺省 DSH_HOST_VERSION = '0.1.0-rc.7'（kernel/schemas/host-version.ts，当前宿主）。
   *  升级宿主后经本配置更新，无需改码——所有 Event/Memory/Experience/Snapshot 使用同一值）。 */
  hostVersion?: string;
  /** W5：skill 镜像目标 DSH 主目录（可注入覆盖——测试注入 fake，禁止写真实 ~/.dsh；
   *  缺省 process.env.DSH_HOME ?? join(os.homedir(), '.dsh')——DSH skill-filesystem 默认扫描
   *  <dshHome>/skills（includeDefaultRoots 缺省 true），omb-runtime 技能镜像后被原生发现）。 */
  dshHome?: string;
  /**
   * 观测到的宿主版本（可选；宿主暴露自己版本时传入）。与 `hostVersion` 不一致 → 外核进入安全状态
   *（契约可能不匹配：不拉起内核、不改动运行数据）。缺省不比较（无从观测时不臆断）。
   */
  observedHostVersion?: string;
  /** 专项 D：prepareTurn 检索的 Retrieval Episode 采样率（0~1；缺省 0.02 = 2%——确定性哈希采样；   *  高价值任务（open_questions/evidence_gaps 非空）自动提升；kern_memory 显式工具恒记录不受此限；
   *  非法值 → 降级记录 + 使用缺省） */
  episodeSampleRate?: number;
  /**
   * 自迭代开关面（已知问题《开关落在宿主插件配置，不引入界面》）：**不引入任何界面或交互开关**，
   * 直接用宿主编排文件本行 config 作为部署级策略——见 agent.cordis.yml 的 selfIteration 段。
   * 缺省（整段不写）→ 全部启用 = 既有行为不变。
   */
  selfIteration?: {
    /** 链路总开关：是否允许演化与晋升（缺省 true；false → 只记账不演化，状态面注明原因） */
    enabled?: boolean;
    /** 触发门槛：触发信号最高强度低于该值则不演化（缺省 0 = 不设门槛；取值 0~1） */
    minStrength?: number;
    /**
     * 后台模型调用许可（候选生成/语义裁判等后台路径；缺省 auto——由并发档位决定：
     * 并发能力 > 1 才许可，并发 = 1（本地小窗模型）自动禁止后台调用以免阻塞主对话）。
     * 显式 true/false 覆盖自动判定。
     */
    backgroundModelCalls?: boolean | 'auto';
    /** 演化节律：是否随维护定时器运行（缺省 true；false → 仅显式 /evolve now 触发） */
    schedule?: boolean;
  };
  /**
   * 并发能力声明面（已知问题《并发能力未知（无探测面）》）：宿主 llm 服务暴露元数据时自动读取，
   * 否则由本配置声明。缺省不声明 = 未知 → 沿用既有行为（后台调用许可，不擅自收紧）。
   * `maxConcurrentRequests: 1` → 后台模型调用自动禁止（并发 1 时任何后台调用都会阻塞主对话）。
   */
  concurrency?: {
    /** 宿主模型最大并发请求数（1 = 串行；缺省未知） */
    maxConcurrentRequests?: number;
    /** 声明来源（仅观测用；缺省 'config'） */
    source?: string;
  };
}

/** DSH 命令注册的最小结构接口（真实类型见 @deepseek-ai/dsh-commands，不引包） */
export interface CommandsLike {
  register(def: {
    name: string;
    description: string;
    input?: { hint: string };
    recordInput?: boolean;
    handler: (invocation: CommandInvocationLike) => unknown;
  }): unknown;
}

/** DSH CommandInvocation 的最小结构（真实类型含 commandId/agent/rawInput/signal；
 *  agent.ctx = 会话作用域上下文（本插件不再使用——/mode 为 OMB 内部版本线切换，保留以贴近真实结构）） */
export interface CommandInvocationLike {
  readonly commandId: unknown;
  readonly agent: {
    readonly ctx?: unknown;
    readonly session?: { readonly events?: ReadonlyArray<{ readonly type?: string }> };
  };
  readonly rawInput: string;
  readonly signal: unknown;
}

/** 认知运行时最小结构（T8.3 装配；T8.26.2 三能力拆分后含 prepareTurn/observeEvent/finalizeTurn/snapshotHash） */
export interface CognitiveRuntimeLike {
  eventStore: {
    append(e: unknown): Promise<void>;
    query(opts: { session_id?: string }): Promise<{ events: Event[] }>;
  };
  memory: { ingest(m: unknown): Promise<string> };
  snapshotHash: string;
  /** T8.26.3：turn 开始认知准备（prepareTurn §3.1）；inject 提供时注入投影并记 context/injected（Model-visible ⟺ logged） */
  prepareTurn(
    req: unknown,
    opts?: { inject?(projection: ContextProjection): void | Promise<void> },
  ): Promise<{
    decision: GovernorDecision;
    working_state: PromptWorkingState;
    projection: ContextProjection;
    events_appended: number;
  }>;
  /** T8.26.4：运行中事实入链（observeEvent §3.2） */
  observeEvent(e: unknown): Promise<{ appended: boolean; degraded: string | null }>;
  /** T8.26.5：turn 收尾（finalizeTurn §3.3） */
  finalizeTurn(input: unknown): Promise<{ decision_event_id: string; events_appended: number }>;
  /** 维护调度器（生产装配：turn 收尾入队；请求间隙 requestQuantum 小量子；stop 退出停表） */
  maintenance?: {
    requestQuantum(opts?: { signal?: unknown }): Promise<unknown>;
    debtSnapshot(): unknown;
    stop?(): void;
  } | null;
  /** P1a：已注入的线快照（按线加载成功 → 快照信息；否则 null/undefined） */
  lineSnapshot?: { line: string; commit: string; dir: string } | null;
  /** P1a：lines 按线加载降级原因（线快照缺 policy / lines 不可用 → 回退仓库默认；无降级 → null） */
  lineDegraded?: string | null;
  /** P1b：/mode 切换后重建运行时快照（新线物化 → 新快照 → promote → 下一请求生效；失败降级保持当前快照）。
   *  返回 { promoted, degraded }——degraded 非空 = 快照未变（切换状态仍生效，快照不变）。 */
  rebuildSnapshotForLine?(line: string): { promoted: boolean; degraded: string | null };
  /** P1b/P1e：外部晋升接口（构建好新快照后 promote → 下一请求生效；进行中请求不受影响） */
  promoteSnapshot?(next: unknown): void;
  /** P1c/P1d：/evolve now——演化判定 + 候选管线（生成→验证→晋升）+ 维护量子（返回摘要；失败降级不崩） */
  runEvolutionNow?(input: { session_id: string }): Promise<{
    decision: { should_evolve: boolean; strength: number; object_layer: string; budget_estimate: number; triggers: unknown[]; reason: string };
    enqueued: string[];
    candidates?: Array<{
      candidate_id: string;
      target: string;
      signal: string;
      validated: boolean;
      promoted: boolean;
      commit_hash?: string;
      object_id?: string;
      reason?: string;
    }>;
    promoted?: { candidate_id: string; object_id: string; commit_hash: string } | null;
    /** P1e：晋升检查结果（stable ← trusted-latest 显式门禁；/evolve 摘要展示） */
    promotion?: {
      checked: boolean;
      skipped_reason: string | null;
      gate_ok: boolean;
      reasons: string[];
      promoted: boolean;
      activation_id?: string;
      stable_commit?: string;
      error?: string;
      warning?: string;
      events_appended: number;
    };
    quantum: { ran: string[]; skipped: string[] };
    debt: unknown[];
    degraded: string | null;
    events_appended: number;
  }>;
  handleRequest(req: unknown): Promise<{
    decision: { decision: string };
    retrieval: { items: unknown[]; channel_used: string };
    prompt: { system: string; total_tokens: number };
    events_appended: number;
  }>;
  /** P2：kern_status 数据源——认知运行时状态摘要（版本线/快照/lineSnapshot/债务/信号数/组件健康；纯读取） */
  status?(): Promise<KernStatusSummary>;
  /** S5：kern_bench 数据源——v2 契约基准（runBenchV2 接线：无 modelAdapter → 回放；有 → 真实+judge；
   *  失败 ok:false + detail，不崩；input 可选——运行时缺省当前线） */
  benchV2?(input?: { line?: string; persist?: boolean }): Promise<{
    ok: boolean;
    line: string;
    mode: 'real' | 'replay';
    passed: number;
    total: number;
    judge_enabled: boolean;
    judge_run: number;
    judge_degraded: number;
    judge_rate: number;
    persisted: boolean;
    detail?: string;
  }>;
  /** S5：kern_switch 数据源——版本线切换（校验+快照重建+激活事件；无 /mode 空白会话守卫——工具显式调用） */
  switchLine?(input: { line: string; session_id?: string }): Promise<{
    ok: boolean;
    text: string;
    previous_line: string;
    line: string;
    rebuilt: boolean;
    degraded: string | null;
    events_appended: number;
  }>;
  /** S5：kern_memory 数据源——记忆检索查询（retrieve 路由；只读不记录 episode；input 可选——缺省 Project/5 条） */
  retrieveMemory?(input?: {
    text?: string;
    scope?: string;
    kind?: string;
    limit?: number;
    relation?: string;
  }): Promise<{
    ok: boolean;
    items: Array<{ id: string; kind: string; scope: string; prov_class: string; updated: string; value: number; snippet: string }>;
    channel_used: string;
    /** 实际参与召回的通道（双通道融合可观测面：词法 / 向量 / 情景 / 时间） */
    channels_used?: string[];
    scope_chain: string[];
    degraded: string | null;
  }>;
  /** W1（未接线审计修复 2026-08-25）：kern_profile 数据源——画像写入（Profile 记忆 Global 作用域；
   *  upsert 语义：存在更新 payload（replace 覆写/缺省合并追加）/ 不存在新建；失败 → degraded 不抛） */
  upsertProfile?(input: { profile: string; replace?: boolean }): Promise<{
    id: string;
    kind: 'Profile';
    scope: string;
    created: boolean;
    updated: boolean;
    degraded: string | null;
  }>;
  /** S1：State.world/self 引用填充（reduce 产出 State 后 null → 模型引用；StateSchema 校验——
   *  合规路径返回校验结果，事件流直归约的 working 缺省字段（既有诚实空语义）不阻塞接线） */
  materializeState?(state: unknown): unknown;
  /** W5：能力注册表视图（capabilities.list() → 能力名清单；第二层动态能力行数据源——同步只读） */
  capabilities?: { list(): Array<{ name?: string; id?: string }> };
  /** W5：组件注册表视图（components.list() → manifest 名清单；第二层动态能力行数据源补充） */
  components?: { list(): Array<{ manifest_id?: string }> };
  /** W5：语义裁判执行器（null = 未注入 → judge 不可用；available 布尔——动态能力行「语义裁判」段） */
  judgeExecutor?: { available: boolean } | null;
  /** W3：dynamicCordisRunner 增强通道注入面（存在 → 候选验证通道 = runner；缺失 → 受限子进程） */
  dynamicRunner?: DynamicCordisRunnerLike | undefined;
  /**
   * 维护任务重建面（已知问题《债务与"还债的人"不同源》修复）：`id → 执行体工厂`，
   * 供跨重启队列重建（MaintenanceScheduler.restoreTask）。缺失 → 队列不重建，
   * 债务转为人工裁定清单（不静默丢失）。
   */
  maintenanceTaskFactory?(): (id: string) => ((signal?: AbortSignal) => Promise<void>) | null;
  /** R8：/evolve share——发布机制级 Evolution Object（trusted-latest 演化链头 → GitRegistry 本地 registry；
   *  生产默认不自动发布（隐私原则），显式命令始终可用；无对象/失败 → ok:false + 明确文本，不崩） */
  shareEvolutionObject?(input: { session_id: string }): Promise<ShareCommandResultLike>;
  /** R8：/evolve absorb <id>——显式从本地 registry 吸收（本地验证 → share-pipeline absorb 管线 → 共识回传） */
  absorbEvolutionObject?(input: { session_id: string; object_id: string }): Promise<ShareCommandResultLike>;
  close(): Promise<void>;
}

/** R8：共享命令结果最小结构面（/evolve share | absorb；ok:false = 明确 error 文本） */
export interface ShareCommandResultLike {
  ok: boolean;
  text: string;
  object_id?: string;
  registry_dir?: string;
  events_appended: number;
}

/** DSH assembleContextFor 的结构最小面（真实类型见 @deepseek-ai/dsh-system-prompt AssembleContext：{ agent, scope, signal }） */
export interface AssembleContextLike {
  agent?: { session?: { id?: string; events?: ReadonlyArray<{ type?: string; data?: unknown }> } };
  scope?: unknown;
  signal?: unknown;
}

/** DSH systemPrompt 服务的最小结构（真实类型见 @deepseek-ai/dsh-system-prompt SystemPrompt.context；text 支持按请求求值） */
export interface SystemPromptLike {
  context?(def: {
    name: string;
    order: number;
    text: string | ((assembleCtx: AssembleContextLike) => string);
  }): unknown;
}

export interface ContextLike {
  /** Guard 契约：免 inject 服务读取（真实 DSH 上下文恒有；测试 fakeCtx 可缺省，readService 退化到普通属性） */
  get?(name: string): unknown;
  commands?: CommandsLike;
  /** P2：DSH 工具注册面（kern_* 工具桥；真实类型 @deepseek-ai/dsh-tools ToolRuntime.register）——经 get('tools') 读取 */
  tools?: ToolsLike;
  /** T8.3：注入的认知运行时（deps 注入，组合根模式）——经 get('cognitive') 读取；未注入且提供装配根 → 组合根缺省装配 */
  cognitive?: CognitiveRuntimeLike;
  /** T8.12：DSH llm 服务（LlmRuntime.stream 的结构最小接口；真实类型 @deepseek-ai/dsh-llm）——经 get('llm') 读取。
   *  存在 + config.model 齐备 → 组合根装配 ModelAdapter 注入认知运行时；缺失 → 缺省受限（LLM 路径不装配）。 */
  llm?: LlmStreamLike;
  /** T8.12：注入的 ModelAdapter（组合根显式注入优先；未注入且 llm+config.model 齐备 → 自动装配）——经 get('modelAdapter') 读取 */
  modelAdapter?: ModelAdapter;
  /** W3（未接线审计修复 2026-08-25）：宿主 dynamicCordisRunner 服务（S9 增强通道——候选验证脚本经
   *  动态插件半执行；真实类型 cordis-host-runner DynamicCordisRunnerService，结构最小面见
   *  supervisor/dynamic-runner.ts）——经 get('dynamicCordisRunner') 读取。存在且守卫通过 → 候选验证
   *  走 runner 通道（G3-exec 优先）；缺失/部分缺失 → 管线守卫降级受限子进程路径（诚实降级）。 */
  dynamicCordisRunner?: DynamicCordisRunnerLike;
  /** T8.26.3：DSH systemPrompt 服务（context 贡献注册面；真实类型 @deepseek-ai/dsh-system-prompt）——经 get('systemPrompt') 读取 */
  systemPrompt?: SystemPromptLike;
  /** T8.26.4：DSH 事件注册面（session/event 会话事实 + tools/result 工具结果 live；真实类型 Cordis Context.on，mixin accessor） */
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
  /** 生命周期效应注册面（Cordis ctx.effect：回调立即执行，返回值作为清理函数；测试 fakeCtx 可缺省） */
  effect?(callback: () => unknown): unknown;
}

/**
 * 读服务/注入项：真实 DSH 上下文（Guard）经 ctx.get 免 inject 读取；测试 fakeCtx 无 get 时
 * 退化到普通属性读取。未提供 → undefined（不抛）。
 */
function readService<T>(ctx: ContextLike, name: string): T | undefined {
  if (typeof ctx.get === 'function') {
    return ctx.get(name) as T | undefined;
  }
  return (ctx as unknown as Record<string, T | undefined>)[name];
}

/**
 * W5：认知运行时 → 第二层动态能力行视图（同步读取：capabilities/components 名称、judgeExecutor 可用性、
 * dynamicRunner 注入存在性；运行时缺失/字段缺失 → 对应维度未知——buildCapabilitiesLine 兜底「当前无额外能力面」）。
 * 仅存在性/名称读取，零副作用；真实运行时实例结构上满足（CapabilityLike.name / ComponentListEntry.manifest_id）。
 */
function capabilitiesViewOf(rt: CognitiveRuntimeLike | undefined): {
  capabilities?: string[];
  judgeAvailable?: boolean;
  runnerAvailable?: boolean;
} {
  if (rt === undefined) {
    return {};
  }
  const names: string[] = [];
  const caps = rt.capabilities?.list?.();
  if (Array.isArray(caps)) {
    for (const c of caps) {
      if (typeof c?.name === 'string' && c.name.length > 0) {
        names.push(c.name);
      }
    }
  }
  const components = rt.components?.list?.();
  if (Array.isArray(components)) {
    for (const c of components) {
      if (typeof c?.manifest_id === 'string' && c.manifest_id.length > 0) {
        names.push(c.manifest_id);
      }
    }
  }
  const view: { capabilities?: string[]; judgeAvailable?: boolean; runnerAvailable?: boolean } = {};
  if (names.length > 0) {
    view.capabilities = [...new Set(names)];
  }
  if (rt.judgeExecutor !== undefined && rt.judgeExecutor !== null) {
    view.judgeAvailable = rt.judgeExecutor.available === true;
  }
  view.runnerAvailable = rt.dynamicRunner !== undefined;
  return view;
}

/** 插件 preset 根（src 布局 <preset>/runtime/ → 上一级；编译布局 <preset>/lib/runtime/ → 存在性回退取上级） */
const HERE_CANDIDATE = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_ROOT = existsSync(join(HERE_CANDIDATE, 'kernel', 'policy')) ? HERE_CANDIDATE : dirname(HERE_CANDIDATE);

/** 配置路径解析：绝对路径原样；相对路径相对 preset 根（迁移可移植——避免组合配置指向旧机器绝对路径） */
function resolveConfigPath(p: string | undefined): string | undefined {
  if (p === undefined || p.length === 0) {
    return p;
  }
  return isAbsolute(p) ? p : join(PLUGIN_ROOT, p);
}

/**
 * 空白会话检查：会话事件流中尚无 turn/start。
 * 与 DSH api-proxy 的 sessionBlank 同款语义（api-proxy.ts:476：turn = 一次模型循环执行，
 * 无 turn/start 即空白；命令生命周期记录不打开 turn，运行 /mode 本身不会破坏空白）。
 */
function isBlankSession(events: ReadonlyArray<{ readonly type?: string }> | undefined): boolean {
  return !(events ?? []).some((event) => event.type === 'turn/start');
}

/** apply 返回句柄（Cordis 忽略函数插件返回值；装配断言/测试句柄用） */
export interface ApplyResult {
  /** 装配出的认知运行时（未提供装配根／安全状态／装配失败 → undefined；仅注册命令） */
  cognitive?: CognitiveRuntimeLike;
  /** 外核安全状态快照（已知问题《外核自身也要非阻塞》：当前是否安全状态、原因、时间可经状态面查看） */
  safeState?: {
    ok: boolean;
    kind: string;
    reason: string | null;
    at: number;
    platform: string;
    platform_degraded: string | null;
    kernel_loaded: boolean;
    details: Record<string, string>;
  };
  /** 平台能力快照（识别层输出；排障与状态面用）。sandbox_* 字段来自 substrate/sandbox.ts 的
   *  **通道自检**（sandboxStatusAsync）：`sandbox_reachable` 才是「候选验证能不能真的跑起来」的答案——
   *  known issue《Linux 适配不完整》派生条：只看机制类别会把"机制在但自检不过"误报成可用。 */
  platform?: {
    platform: string;
    raw: string;
    read_only: string;
    read_only_available: boolean;
    sandbox: string;
    sandbox_available: boolean;
    /** 受限通道自检结论（true = 授权目录写成功 + 非授权目录写被拒，真实探针跑过） */
    sandbox_reachable: boolean;
    /** 实际通道标识（自检可用时；如 win32-restricted-token / posix-bwrap / posix-node-permission） */
    sandbox_mechanism: string | null;
    sandbox_reason: string | null;
    sandbox_self_test: string | null;
    degraded: string | null;
  };
  /** 内核未加载时的状态面兜底数据源（kern_status 用——保证"能看到为什么没加载"） */
  safeStateRuntime?: KernRuntimeLike;
}

/**
 * R2 启动竞态修复：bootReady resolve 载荷（受控 promise——认知 gate 与降级记录共用）。
 * bootStable 的认知 gate 子集：最终是否可用（回退后仍不可加载/无恢复路径 → false）、
 * 校验版本线、告警记录、自动回退详情。bootStable 异常 → ok:false 兜底（不 reject）。
 */
export type BootReady = Pick<BootResult, 'ok' | 'line' | 'warnings' | 'rollback'>;

/** 从宿主子代理终局结果中取裁判文本（修复 H1）：`SubagentResult.output: ContentBlock[]` 优先，
 *  其次兼容旧形状的 finalText/text 字符串；都取不到时退化为空串（调用方按"不可解析"降级，
 *  不把 `"[object Object]"` 当裁判文本喂给解析器）。 */
function flattenSubagentText(settled: unknown): string {
  if (typeof settled === 'string') {
    return settled;
  }
  const s = settled as
    | { output?: unknown; finalText?: unknown; text?: unknown; result?: { output?: unknown } }
    | null
    | undefined;
  const blocks = s?.output ?? s?.result?.output;
  if (Array.isArray(blocks)) {
    const text = blocks
      .map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter((t) => t.length > 0)
      .join('\n');
    if (text.length > 0) {
      return text;
    }
  }
  if (typeof s?.finalText === 'string' && s.finalText.length > 0) {
    return s.finalText;
  }
  if (typeof s?.text === 'string' && s.text.length > 0) {
    return s.text;
  }
  return '';
}

/** 从宿主服务/环境读取自述版本（缺省 undefined = 无法观测，沿用既有行为）。
 *  目的（第二轮兼容性审查 H2）：让"声明 ≠ 观测"这条安全状态分支在生产中真的可达——否则宿主升级到
 *  0.1.5 时插件照常拉起内核，把旧版本号写进全部事件/记忆/快照 provenance，且无任何提示。
 *  探测点按可用性依次尝试，任一命中即用；全部缺失 → undefined（不臆断、不降级记录，行为不变）。 */
function probeObservedHostVersion(ctx: ContextLike): string | undefined {
  const fromService = (name: string): string | undefined => {
    const svc = readService<{ version?: unknown; dshVersion?: unknown; harnessVersion?: unknown }>(ctx, name);
    for (const v of [svc?.version, svc?.dshVersion, svc?.harnessVersion]) {
      if (typeof v === 'string' && v.length > 0) {
        return v;
      }
    }
    return undefined;
  };
  const fromEnv = process.env.DSH_VERSION ?? process.env.DSH_HOST_VERSION;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  return fromService('dsh') ?? fromService('harness');
}

export function apply(ctx: ContextLike, config: PluginConfig = {}): ApplyResult {  /**
   * 外核安全状态视图（已知问题《外核自身也要非阻塞》：当前是否安全状态、原因、发生时间可经状态面与
   * 日志查看）+ 内核未加载时的状态面兜底数据源。二者都在此就近定义——工具注册与返回值都要用，
   * 且必须在任何使用点之前完成绑定（TDZ）。
   */
  const safeStateView = (): {
    ok: boolean;
    kind: string;
    reason: string | null;
    at: number;
    platform: string;
    platform_degraded: string | null;
    kernel_loaded: boolean;
    details: Record<string, string>;
  } => {
    const st = evaluateSafeState({
      configuredHostVersion: config.hostVersion,
      defaultHostVersion: hostVersion(),
      // 观测版本真探测（第二轮兼容性审查 H2）：此前 observedHostVersion 只从配置读，全仓无任何写入点 →
      // 安全状态的"声明 ≠ 观测"分支恒不可达（0.1.5 到来时会照常拉起内核并把 0.1.3 写进全部 provenance）。
      // 现在按可用性探测宿主自述版本（服务 → 环境变量），**探不到就保持 undefined**（行为与既有完全一致）；
      // 探到且与声明不符 → 走既有 host_version_changed 路径（不拉起内核、只记录原因）。
      observedHostVersion: config.observedHostVersion ?? probeObservedHostVersion(ctx),
      substrateRoot: substrateRootOf(PLUGIN_ROOT),
    });
    return {
      ok: st.ok,
      kind: st.kind,
      reason: st.reason,
      at: st.at,
      platform: st.platform,
      platform_degraded: st.platform_degraded,
      kernel_loaded: kernelLoaded,
      details: st.details,
    };
  };

  /** 内核未加载时的状态面兜底数据源（kern_status 用——保证"能看到为什么没加载"） */
  const safeStateRuntime = (): KernRuntimeLike => ({
    status: async () => ({
      line: current,
      snapshot_hash: 'rs:kernel-not-loaded',
      line_snapshot: null,
      line_degraded: '内核未加载（安全状态或装配失败）——无版本线快照',
      debt: [],
      debt_sources: null,
      debt_pending_manual: [],
      debt_release_audit: [],
      debt_limits: null,
      evolution: null,
      memory_vector: null,
      maintenance_observations: null,
      observations_degraded: null,
      recent_signals: 0,
      signals_degraded: '内核未加载——无信号面',
      components: { registered: [], active: [], suspicious: [], health: [] },
      degraded: '内核未加载（安全状态或装配失败）——详见 safe_state 段',
      safe_state: safeStateView(),
    }),
  });

  /**
   * 外核安全状态（已知问题《外核自身也要非阻塞（安全状态）》）：拉起内核**之前**做一次极轻量自检
   * （平台探测 / 宿主版本契约 / 恢复根可读性）。不通过 → **不拉起内核、不改动运行数据、不执行演化与
   * 维护**，只记录原因与时间；宿主启动与运行完全不受影响（插件"存在但不介入"）。
   * 自检本身抛错也按安全状态处理（绝不外溢到宿主）；命令面照常注册（可查看"内核未加载的原因"）。
   */
  const safeState = evaluateSafeState({
    configuredHostVersion: config.hostVersion,
    defaultHostVersion: hostVersion(),
    observedHostVersion: config.observedHostVersion,
    substrateRoot: substrateRootOf(PLUGIN_ROOT),
  });
  /** 内核是否已成功加载（装配成功才置 true；供安全状态视图报告 kernel_loaded） */
  let kernelLoaded = false;

  /**
   * 会话工作目录（制品发现根，已知问题《制品索引未建立》修复）：从宿主 ctx 守卫式读取。
   * 宿主形态不确定（workspace / cwd / sandbox 各版本不同）→ 逐个试；都不是字符串 → undefined
   *（调用方退回"只用仓库根"的既有行为，不臆造路径）。
   */
  const readWorkspaceRoot = (c: ContextLike): string | undefined => {
    for (const name of ['workspace', 'cwd', 'workingDirectory'] as const) {
      try {
        const v = readService<unknown>(c, name);
        if (typeof v === 'string' && v.length > 0) return v;
        const obj = v as { root?: unknown; path?: unknown; cwd?: unknown } | null | undefined;
        if (obj !== null && obj !== undefined && typeof obj === 'object') {
          for (const k of ['root', 'path', 'cwd'] as const) {
            if (typeof obj[k] === 'string' && (obj[k] as string).length > 0) return obj[k] as string;
          }
        }
      } catch {
        // 未注入/读取抛错 → 试下一个
      }
    }
    return undefined;
  };
  if (!safeState.ok) {
    recordDegradation('substrate/safe-state', `外核进入安全状态：${safeState.reason ?? '未知原因'}（不拉起内核，宿主不受影响）`);
  }
  // 内核装配是否被跳过由 safeState.ok 决定（安全状态 → 跳过；命令与状态面仍可用）

  // 分享后自动初始化三线布局与只读 ACL（专项「进程内自动初始化」）：versions.git/stable/latest
  // 均 gitignored、不随仓库分发 → 项目被分享（clone/拷贝）后布局缺失/损坏/ACL 丢失 →
  // 进程内自动初始化或保守修复。锁安全性：git/icacls 均以短生命周期子进程（execFileSync）运行，
  // DSH 进程不持有 versions.git/stable/latest 的文件句柄（正式 worktree 运行只读）→ 无锁冲突；
  // 布局健康时纯 fs 检查、零 git 子进程（零开销）。degraded → 记录降级（不阻塞挂载，命令仍可用）。
  // 顺序：bootstrap 守卫（ensureThreeLineLayout → 跨进程残留清理）→ bootStable（回退校验依赖布局就绪）。
  // 已知问题《内核加载失败不得阻塞宿主》：整段包裹在守卫内——初始化/修复异常一律降级记录，
  // 绝不外溢（布局不可用时命令面与状态面仍可用；内核装配见下方 try/catch）。
  if (config.bootstrap !== false && safeState.ok) {
    try {
      const r = ensureThreeLineLayout();
      if (r.status === 'degraded') {
        recordDegradation('layout/bootstrap', r.detail);
      } else if (r.status !== 'ok') {
        console.info(`[omb-v2] 三线布局自动${r.status === 'initialized' ? '初始化' : '修复'}完成：${r.detail}`);
      }
    } catch (err) {
      recordDegradation('layout/bootstrap', `三线布局初始化/修复异常（${err instanceof Error ? err.message : String(err)}）——跳过，命令面仍可用`);
    }
    // 跨进程残留清理：%TEMP%\initial-* 物化 worktree（上一进程遗留；本进程尚未物化 → 安全）。
    // 归属 bootstrap 守卫：bootstrap:false 表示「布局由调用方管理」（测试 fakeCtx 多 worker 并行
    // 各自物化 initial worktree）——跳过清理，避免 worker A 物化后 worker B 清理误删 A 在用目录
    // → loadVersion('initial') 瞬态失败（commands.test.ts 已知 flake，专项2/3 两次观测）。
    // 生产默认 bootstrap=true → 清理照常（防跨进程残留累积）。
    try {
      const removed = cleanupStaleInitialWorktrees();
      if (removed > 0) {
        recordDegradation('initial/cleanup', `清理跨进程残留 initial 物化 worktree ${removed} 个`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordDegradation('initial/cleanup', `残留清理异常（${detail}）`);
    }
  } else if (!safeState.ok) {
    recordDegradation('layout/bootstrap', '安全状态：跳过三线布局初始化/修复（不改动运行数据）');
  }
  // R2（P0）启动顺序竞态修复：恢复根启动完整性校验升级为受控 promise（bootReady）。
  // 背景（ChatGPT 评估 #2）：bootStable 异步后台执行期间 CognitiveRuntime 已按（可能损坏的）
  // stable 装配——恢复根最终运行 Vn、认知已按损坏 Vm 装配。修复原则：**恢复完成以前，
  // 认知运行时不得进入可服务状态**。方案：gate（装配结构不动，钩子内部 gate——改动面最小）——
  // 认知服务入口（prepareTurn/observeEvent/finalizeTurn 三钩子 + /mode 认知部分 + /evolve）统一经
  // cognitiveServiceable() 等待 bootReady settle；boot 失败（无恢复路径）→ 认知降级为仅命令模式
  // （一次性认知侧降级记录 'cognitive/boot'），命令仍可用。apply 为同步契约，boot 仍异步后台执行，
  // 但不再 fire-and-forget：bootReady 为受控句柄（resolve 载荷 { ok, line, warnings, rollback? }）。
  const boot = config.bootStableOverride ?? bootStable;
  // 已知问题《内核加载失败不得阻塞宿主》：安全状态下**不拉起内核**——boot 校验也跳过（不改动运行数据），
  // bootReady 直接以"不进入服务"结算（认知 gate 返回 false → 仅命令模式，与既有语义一致）。
  const bootReady: Promise<BootReady> = (safeState.ok
    ? boot()
    : Promise.resolve<BootReady>({ ok: false, line: 'stable', warnings: [], rollback: undefined })
  ).then((r) => {
    if (r.ok === false) {
      recordDegradation('boot/stable', `启动校验失败：版本线 ${r.line} 无恢复路径（${r.warnings.map((w) => w.kind).join(',')}）`);
    } else if (r.rollback !== undefined) {
      recordDegradation('boot/stable', `启动自动回退：${r.rollback.previous_head.slice(0, 8)} → ${r.rollback.new_head.slice(0, 8)}（worktree ${r.rollback.worktree_status}）`);
    }
    return { ok: r.ok, line: r.line, warnings: r.warnings, rollback: r.rollback };
  }).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    recordDegradation('boot/stable', `启动校验异常（${detail}）——跳过自动回退`);
    return { ok: false, line: 'stable', warnings: [], rollback: undefined };
  });

  /**
   * R2 boot gate：恢复完成前认知运行时不得进入可服务状态——认知服务入口统一 await 本 gate。
   * boot settle 前 → 等待（事件/请求暂存，恢复完成后处理）；boot 失败（无恢复路径）→ 返回 false
   *（认知降级为仅命令模式；认知侧降级一次性记录）。命令（/mode 空输入等）不经本 gate——仍可用。
   */
  let bootGateDegraded = false;
  const cognitiveServiceable = async (): Promise<boolean> => {
    const bootState = await bootReady;
    if (bootState.ok) {
      return true;
    }
    if (!bootGateDegraded) {
      bootGateDegraded = true;
      recordDegradation('cognitive/boot', `启动校验失败（版本线 ${bootState.line} 无恢复路径）——认知运行时降级：仅命令模式，不进入服务`);
    }
    return false;
  };
  // T8.3：认知系统装配进插件生命周期——经 deps 注入（get('cognitive')，组合根模式）或
  // 组合根缺省装配（runtime/assembly.ts；装配根 = config.cognitiveRoot）。
  // 未提供装配根 → 仅注册命令（认知装配为可选配置面，生产经 agent.cordis.yml config 接线）。
  // 状态存闭包（真实运行时 Guard 禁止写未 provide 的 ctx 属性）。
  let cognitive = readService<CognitiveRuntimeLike>(ctx, 'cognitive');
  let modelAdapter = readService<ModelAdapter>(ctx, 'modelAdapter');
  const systemPrompt = readService<SystemPromptLike>(ctx, 'systemPrompt');

  // W5：第三层（DSH 原生 skill 渐进层）镜像接线——把仓库内版本化技能 skills/omb-runtime/SKILL.md 镜像到
  // <dshHome>/skills/omb-runtime/SKILL.md（DSH skill-filesystem 默认扫描 <dshHome>/skills；
  // includeDefaultRoots 缺省 true——~/.dsh/skills 在扫描范围内 → 模型 skill 工具目录可见、按需加载、
  // 零固定 token 成本；宿主架构研究结论：渐进层零成本宿主，严格优于全塞固定上下文）。
  // 幂等：目标内容一致 → 跳过；不一致 → 原子写（tmp + rename）；尽力而为：任一步失败 → 降级记录不抛。
  // dshHome 可注入覆盖（config.dshHome 优先——测试注入 fake，禁止写真实 ~/.dsh；其次 $DSH_HOME）。
  // 测试守卫：vitest 环境（VITEST/NODE_ENV=test）不写真实用户态，除非显式注入 config.dshHome。
  const mirrorSkill = async (): Promise<void> => {
    const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const sourcePath = skillSourcePath(PLUGIN_ROOT);
    const targetPath = skillMirrorPath(dshHome);
    let source: string;
    try {
      source = await readFile(sourcePath, 'utf8');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordDegradation('skill/mirror', `技能源读取失败（${detail}）`);
      return;
    }
    try {
      const existing = await readFile(targetPath, 'utf8').catch(() => null);
      if (existing === source) {
        return; // 幂等：内容一致跳过（不重写）
      }
      await mkdir(dirname(targetPath), { recursive: true });
      const tmp = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
      await writeFile(tmp, source, 'utf8');
      await rename(tmp, targetPath); // 原子替换（Windows MoveFileEx REPLACE_EXISTING 语义）
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordDegradation('skill/mirror', `镜像写入失败（${detail}）`);
    }
  };
  const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  if (config.dshHome !== undefined || !isTestEnv) {
    void mirrorSkill();
  }

  // 当前生效版本线（默认 stable，架构 §11.1）；config.line 固定初始版本线（后备/兼容机制
  // deploy-lines 生成的 per-line 预设固定本线用；生产单模式下仅影响启动初值——/mode 运行时切换内部线状态）。
  // 非法值 → 回退 stable 并记录降级（守卫式接入，不阻塞挂载）。
  // 先于认知装配解析：装配按线加载 policy/processes（P1a，D1 裁决——createCognitiveRuntime 注入 line）。
  const configuredLine: unknown = config.line;
  let current: VersionLine;
  if (isVersionLine(configuredLine)) {
    current = configuredLine;
  } else {
    current = 'stable';
    if (configuredLine !== undefined) {
      recordDegradation('config/line', `非法 line 配置 "${String(configuredLine)}"（合法值 initial|stable|latest）——回退 stable`);
    }
  }

  // 专项 D：记忆检索 Episode 采样率解析（agent.cordis.yml config.episodeSampleRate；缺省不配 →
  // undefined → 运行时缺省 0.02；非法值 → 降级记录 + 不传——配置错误显式留痕不静默吞掉）
  let episodeSampleRate: number | undefined;
  if (config.episodeSampleRate !== undefined) {
    const r = config.episodeSampleRate;
    if (typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= 1) {
      episodeSampleRate = r;
    } else {
      recordDegradation('config/episodeSampleRate', `非法 episodeSampleRate 配置 "${String(r)}"（应为 [0,1]）——使用缺省 0.02`);
    }
  }

  /**
   * 并发能力探测或声明（已知问题《并发能力未知（无探测面）》）：先读宿主 llm 服务暴露的元数据
   * （llm.maxConcurrentRequests / llm.concurrency / llm.metadata.maxConcurrentRequests——形状容错），
   * 读不到再由 config.concurrency 声明，都没有 → unknown（沿用既有行为，不擅自收紧）。
   * 运行档位：并发 = 1 → 禁止后台模型调用（任何后台调用都会阻塞主对话）。
   */
  const resolveConcurrency = (): { max_concurrent: number | null; source: 'host' | 'config' | 'unknown'; background_model_calls: boolean } => {
    const readHost = (): number | null => {
      const llm = readService<Record<string, unknown>>(ctx, 'llm');
      if (llm === null || llm === undefined || typeof llm !== 'object') return null;
      const cands: unknown[] = [
        (llm as { maxConcurrentRequests?: unknown }).maxConcurrentRequests,
        (llm as { concurrency?: unknown }).concurrency,
        (llm as { metadata?: { maxConcurrentRequests?: unknown } }).metadata?.maxConcurrentRequests,
      ];
      for (const c of cands) {
        if (typeof c === 'number' && Number.isFinite(c) && c >= 1) return Math.floor(c);
      }
      return null;
    };
    const declared = config.concurrency?.maxConcurrentRequests;
    const valid = typeof declared === 'number' && Number.isFinite(declared) && declared >= 1;
    const host = readHost();
    const max = host ?? (valid ? Math.floor(declared) : null);
    const source: 'host' | 'config' | 'unknown' = host !== null ? 'host' : valid ? 'config' : 'unknown';
    // 缺省语义：未知 → 许可（既有行为不变）；已知并发 1 → 禁止；并发 >1 → 许可
    return { max_concurrent: max, source, background_model_calls: max === null || max > 1 };
  };
  const concurrency = resolveConcurrency();
  // 并发未知（宿主未暴露元数据且未声明）→ **不记降级**：这是常见且完全正常的部署形态
  // （沿用既有行为，不擅自收紧），只是观测面标注为 unknown。显式声明与宿主读取才产生确定档位；
  // 由声明/读取得出「禁止后台调用」时另有显式留痕（见下方 selfIteration/background）。
  // 自迭代开关面解析（config.selfIteration；缺省全启用 = 既有行为不变）：
  // 后台模型调用许可缺省 auto → 由并发档位决定（并发 1 自动禁止）
  const si = config.selfIteration ?? {};
  if (si.enabled !== undefined && typeof si.enabled !== 'boolean') {
    recordDegradation('config/selfIteration', `非法 selfIteration.enabled "${String(si.enabled)}"（应为布尔）——按缺省 true 处理`);
  }
  if (si.minStrength !== undefined && (typeof si.minStrength !== 'number' || !Number.isFinite(si.minStrength) || si.minStrength < 0)) {
    recordDegradation('config/selfIteration', `非法 selfIteration.minStrength "${String(si.minStrength)}"（应为 ≥0 数值）——按缺省 0 处理`);
  }
  const backgroundModelCalls =
    si.backgroundModelCalls === true
      ? true
      : si.backgroundModelCalls === false
        ? false
        : concurrency.background_model_calls; // 'auto' / 缺省
  const selfIteration = {
    enabled: si.enabled !== false,
    minStrength: typeof si.minStrength === 'number' && Number.isFinite(si.minStrength) && si.minStrength >= 0 ? si.minStrength : 0,
    backgroundModelCalls,
    schedule: si.schedule !== false,
  };
  // 后台调用被禁止时的显式留痕（排障时一眼看出「为什么没有候选生成」）
  if (!selfIteration.backgroundModelCalls) {
    recordDegradation(
      'selfIteration/background',
      `后台模型调用已禁止（并发档位 ${concurrency.max_concurrent ?? 'unknown'}，来源 ${concurrency.source}；候选生成/语义裁判不发模型调用，生成阶梯降级为纯规则）`,
    );
  }

  if (cognitive === undefined && safeState.ok) {
    // 相对路径解析：config 路径相对 preset 根（迁移可移植——组合文件随项目走，绝对路径会指向旧机器）
    const root = resolveConfigPath(config.cognitiveRoot);
    if (root !== undefined) {
      // S2（P2.5 搁置解除——用户 2026-08-25 裁决）：空白子代理同模型单次裁判。
      // Guard 契约（B3 教训）：宿主服务必须经 ctx.get 读取（直接 ctx.subagents 对未 inject 的
      // 属性读取抛 `cannot get property "subagents" without inject`）——try/catch → undefined 降级；
      // 存在 → spawnJudge：subagents.start('spawn', { prompt:[{type:'text',text}], toolFilter:[],
      // signal }) 前台等待最终输出（spawn provider 全新会话、纯文本裁判、同模型不增加订阅成本）。
      let subagents: unknown;
      try {
        subagents = readService(ctx, 'subagents');
      } catch {
        subagents = undefined; // B3 教训：未注入 → 诚实降级（judge 不可用）
      }
      let judgeExecutor: ReturnType<typeof createJudgeExecutor> | undefined;
      if (subagents !== undefined && typeof (subagents as { start?: unknown }).start === 'function') {
        // 第二轮审查修复 H1：宿主 SubagentStartRequest 的必填面是
        //   { prompt: ContentBlock[], parent: Agent, signal: AbortSignal }（packages/subagent/subagent/src/types.ts），
        // 返回的是 **run 句柄**：终局结果在 `run.result` → `SubagentResult.output`（ContentBlock[]），
        // 且用完必须 `run.dispose()`。此前实现缺 parent、signal 取自不存在的变量、并把句柄当文本
        // （`String(r)` = "[object Object]"）→ 每次复核必抛 → 被 judge-executor 吞成 null → 视同 UNKNOWN
        // → 白烧两次尝试，而能力行仍报"语义裁判：可用"。
        // parent 来源：宿主只在工具调用上下文里给出 Agent（`exec.agent`）——由下方 tools/result 监听捕获最近一个；
        // 未捕获到之前 `isAvailable()` 为 false → 走"judge 不可用 → 转人工复核"这条既有诚实路径。
        const spawnJudge = async (prompt: string, signal?: AbortSignal): Promise<string> => {
          const parent = agentRef;
          if (parent === undefined) {
            throw new Error('judge: 尚无可用父 Agent（未观察到工具调用）——judge 暂不可用');
          }
          const handle = (await (
            subagents as {
              start: (provider: string, req: Record<string, unknown>) => Promise<unknown>;
            }
          ).start('spawn', {
            prompt: [{ type: 'text', text: prompt }],
            parent,
            signal: signal ?? new AbortController().signal,
            toolFilter: [], // 纯文本裁判：不派发任何工具
          })) as { result?: Promise<unknown>; dispose?: () => Promise<void> } | null | undefined;
          try {
            const settled = handle?.result !== undefined ? await handle.result : handle;
            return flattenSubagentText(settled);
          } finally {
            try {
              await handle?.dispose?.();
            } catch {
              // dispose 失败不覆盖判定结果（子会话残留由宿主回收；不因此判失败）
            }
          }
        };
        judgeExecutor = createJudgeExecutor({ spawnJudge, isAvailable: () => agentRef !== undefined });
      }
      // W3（未接线审计修复 2026-08-25）：宿主 dynamicCordisRunner 服务读取（S9 增强通道——候选验证
      // 脚本经动态插件半执行，G3-exec 优先走 runner 通道）。Guard 契约（B3 教训）：宿主服务必须经
      // ctx.get 读取（直接 ctx.dynamicCordisRunner 对未 inject 的属性读取抛 `cannot get property
      // "dynamicCordisRunner" without inject`）——try/catch → undefined 降级；存在 → 注入
      // createCognitiveRuntime（缺失/部分缺失 → 管线守卫自动降级受限子进程路径——既有行为不变，诚实降级）。
      let dynamicRunner: DynamicCordisRunnerLike | undefined;
      try {
        dynamicRunner = readService<DynamicCordisRunnerLike>(ctx, 'dynamicCordisRunner');
      } catch {
        dynamicRunner = undefined; // B3 教训：未注入 → 诚实降级（候选验证走受限子进程路径）
      }
      // T8.12：组合根装配 ModelAdapter——显式注入优先；否则 llm 服务 + config.model 齐备时自动装配
      //（真实 DSH 会话经 llm 服务提供；缺失 → 缺省受限，LLM 路径不装配，纯规则阶梯）。
      if (modelAdapter === undefined) {
        const llm = readService<LlmStreamLike>(ctx, 'llm');
        const provider = config.model?.provider;
        const model = config.model?.model;
        if (llm !== undefined && provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
          // reasoningEffort 不显式传 → createDshModelAdapter 吃默认 'low'（显式控制推理预算，
          // 防止 llm-deepseek 默认 high 的推理吃光输出预算——真实 /bench maxTokens=4000 被吃光的根因；
          // 基准/生成调用默认 low 即够）。TODO(config): 如需 per-model 推理档位，可从
          // agent.cordis.yml config.model 扩展读取（本处不改配置文件）。
          modelAdapter = createDshModelAdapter(llm, { provider, model });
        }
      }
      // 生产装配维护调度器（已知问题「维护定时器未启动」「单量子名额导致 ROI 饥饿」修复）：
      // ① 构造时显式给出 tick 间隔与批量上限（不再依赖代码缺省），② 构造后立即 start() 启动进程内
      //    定时器——每 tick 在请求间隙批量消费维护队列（收尾压缩/记忆整合/环境检查/演化判定/晋升检查/
      //    候选验证/修复/验证复核）。仅随 DSH 进程存在：关闭 harness 即停（stop() 经 ctx.effect 清理），
      //    队列与债务持久在磁盘，队列空时零开销。
      // ③ 债务阈值 soft/hard/critical 由组合根 ready() 从 policy.evolve.debt_thresholds 注入
      //    （数据即机制——改 evolve.yaml 即生效，与 decideEvolution 的债务门禁同源，两处不再各持一套缺省）。
      // ④ 任务重建面（已知问题《债务与"还债的人"不同源》修复）：队列跨重启持久化（queue.json），
      //    加载时经 restoreTask 按 id 重建执行体 → 债务与"负责还债的任务"同源。装配顺序上运行时在
      //    调度器之后创建 → restoreTask 走闭包延迟取（未就绪时调度器不改动队列、下次调度重试；
      //    见 MaintenanceScheduler.restoreQueueIfNeeded 的就绪语义）。
      const maintenance = new MaintenanceScheduler({
        debtFile: join(root, '.evolution', 'debt.json'),
        tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
        batchSize: DEFAULT_MAINTENANCE_BATCH,
        restoreTask: (id) => maintenanceTaskFactory?.(id) ?? null,
      });
      let maintenanceTaskFactory: ((id: string) => ((signal?: AbortSignal) => Promise<void>) | null) | null = null;
      // 定时器启动：仅在 DSH 运行期生效（进程内 setInterval）；stop() 由下方关闭钩子调用。
      // 启动失败不阻塞装配（认知其余功能照常，降级记录显式留痕）——调度退化为请求间隙单量子。
      try {
        maintenance.start();
      } catch (err) {
        recordDegradation(
          'maintenance/start',
          `维护定时器启动失败（${err instanceof Error ? err.message : String(err)}）——退化为请求间隙单量子`,
        );
      }
      try {
        cognitive = createCognitiveRuntime({
          root,
          modelAdapter,
          // P1a：按当前版本线加载 policy/processes（lines 物化快照注入；缺失/失败 → 运行时回退仓库默认）
          line: current,
          // 专项 D：记忆检索 Episode 采样率（agent.cordis.yml config 可配；缺省不配 → 运行时缺省 0.02；
          // 非法值 → 降级记录 + 不传（运行时缺省）——配置错误显式留痕不静默）
          ...(episodeSampleRate !== undefined ? { episodeSampleRate } : {}),
          // 自迭代开关面（agent.cordis.yml config.selfIteration；缺省全启用）——链路总开关/触发门槛/
          // 后台模型调用许可/演化节律，全部落在部署配置面，不引入界面或交互开关
          selfIteration,
          // 生产装配（ChatGPT 修复意见 #3/#4）：持久化检查点目录（finalizeTurn 保存工作状态）+ 维护调度器
          //（turn 收尾入队 + 请求间隙小量子 + 进程内 tick 批量消费；debt 落盘到认知数据根 .evolution/）
          checkpointDir: join(root, 'checkpoints'),
          maintenance,
          // R6：宿主版本唯一来源注入（提供 → 覆写运行时指纹/事件 provenance 的 dsh_version；缺省 DSH_HOST_VERSION）
          hostVersion: config.hostVersion,
          // S2：验证债务队列（<root>/.evolution/verification/debt.jsonl——与 assembly 缺省构造同路径，
          // 显式注入便于装配面审计）+ 空白子代理单次裁判（subagents 缺失 → 不注入 = judge 不可用，
          // 诚实降级——仅验证债务路径触发、正常任务 0 额外成本）
          verificationDebt: new VerificationDebt({ root: join(root, '.evolution', 'verification') }),
          // 状态面：外核安全状态段（内核未加载的原因可查——已知问题《内核加载失败不得阻塞宿主》）
          safeStateView,
          // 制品发现根集合（已知问题《制品索引未建立》修复）：会话工作目录优先 + 仓库根兜底。
          // ctx.get('workspace')/cwd 形状不确定 → 守卫式读取（缺失 → 只用仓库根，行为不变）
          ...(readWorkspaceRoot(ctx) !== undefined ? { workspaceRoot: readWorkspaceRoot(ctx)! } : {}),
          ...(judgeExecutor !== undefined ? { judgeExecutor } : {}),
          // W3：dynamicCordisRunner 增强通道注入（宿主面存在 → 候选验证脚本经 runner 通道；未注入 → 管线守卫降级受限子进程路径）
          ...(dynamicRunner !== undefined ? { dynamicRunner } : {}),
        });
        kernelLoaded = true;
        // 队列重建面就绪（已知问题《债务与"还债的人"不同源》）：此后调度器再次进入时会把盘上
        // 未完成队列按 id 重建回来（运行时未就绪期间调度器不改动队列——见 restoreQueueIfNeeded）
        maintenanceTaskFactory = (id) => cognitive?.maintenanceTaskFactory?.()(id) ?? null;
      } catch (err) {
        // 已知问题《内核加载失败不得阻塞宿主》：**装配期异常外溢是历史故障根因**（Guard 读取错误、
        // 记忆库缺列两次实测阻塞宿主）。此处兜底：内核不加载 + 记录原因 + 宿主照常启动与运行；
        // 命令面与状态面仍在（可查看"内核未加载的原因"）。不重抛、不改动已写入的运行数据。
        cognitive = undefined;
        // 审查修复 H3：装配失败时维护定时器已 start()（在 createCognitiveRuntime 之前）——此前不会停表，
        // 旧 interval 会在整个进程生命周期里继续 persistDebt/跑任务（旧实例残留）。此处显式停表。
        try {
          maintenance.stop();
        } catch {
          // 停表失败不覆盖装配降级原因（调度器内部幂等）
        }
        recordDegradation(
          'cognitive/assembly',
          `内核装配失败（${err instanceof Error ? err.message : String(err)}）——内核不加载，宿主不受影响；命令面与状态面仍可用`,
        );
      }
      // P1a：lines 按线加载降级（线快照缺 policy / lines 不可用 → 已回退仓库默认）→ 记录降级（不抛，命令仍可用）
      if (cognitive !== undefined && cognitive.lineDegraded !== undefined && cognitive.lineDegraded !== null) {
        recordDegradation('lines/load', cognitive.lineDegraded);
      }
    }
  }

  /**
   * P2/S5/W1：组件↔DSH 工具注册桥（设计 §6 平台集成——ctx.tools.register 少量精炼工具，kern_* 命名，工具数 <10）。
   * 工具集：kern_status（P2 桥机制验证）+ kern_bench/kern_evolve/kern_switch/kern_memory（S5 补齐）+
   * kern_profile（W1 未接线审计修复——画像写入面）——
   * 全部为认知运行时方法（status/benchV2/runEvolutionNow/switchLine/retrieveMemory/upsertProfile）的薄封装
   * （runtime/kern-tools.ts registerKernTools 统一注册；守卫：tools 面缺失 → 记录降级不崩，对齐既有守卫风格；
   * 认知运行时未装配 → 不注册（记录——kern_* 依赖运行时状态）。
   * P8（注册皆效应）：工具注册 disposer 集入 DSH 生命周期（ctx.effect）——插件关闭 → 批量注销回滚。
   * ⚠️ Guard 契约（B3 教训）：tools 必须经 ctx.get('tools') 读取（真实宿主对未 inject 的属性读取抛
   * `cannot get property "tools" without inject`）——禁止直接访问 ctx.tools。
   */
  const tools = readService<ToolsLike>(ctx, 'tools');
  if (tools !== undefined && typeof tools.register === 'function') {
    // 内核已装配 → 完整工具集；内核未加载（安全状态/装配失败）→ **只注册 kern_status**（薄封装到
    // 安全状态兜底数据源），保证"能看到内核为什么没加载"（已知问题《内核加载失败不得阻塞宿主》：
    // 命令面与状态面尽力保留）。工具数不增加（仍 6 个），只是数据源不同。
    const toolRuntime = cognitive !== undefined ? cognitive : safeStateRuntime();
    const r = registerKernTools(tools, toolRuntime, cognitive === undefined ? { only: ['kern_status'] } : {});
    if (r.degraded !== null) {
      recordDegradation('kern/tools', r.degraded);
    }
    if (cognitive === undefined) {
      recordDegradation('kern/tools', '内核未加载——仅注册 kern_status（可查看安全状态与原因）');
    }
    if (typeof ctx.effect === 'function' && r.disposers.length > 0) {
      ctx.effect(() => () => {
        for (const d of r.disposers) {
          try {
            d(); // 真实 DSH register 返回的 disposer（注销幂等；失败忽略）
          } catch {
            // 注销失败幂等忽略（无状态残留）
          }
        }
      });
    }
  } else {
    recordDegradation('ctx.tools', '接口缺失（ctx.tools 不存在）——kern_* 工具未注册（其余功能不受影响）');
  }

  /**
   * 版本线激活记录（T8.7 生产接线）：/mode 切换后调用。
   * - activationLogDir 配置 → completed/<activation_id>.json 幂等落盘（pending 先写，完成清 pending；
   *   M6 ActivationContract schema 校验 fail-loud 不落盘；重启后可恢复）；
   * - 认知装配时 → activation/committed 事件入链（P7 事实源；确定性 id 幂等）。
   * 字段全部来自真实切换数据（predecessor/candidate = 前后版本线 git revision）；
   * 任一步失败 → 降级记录（切换已生效，仅记录缺失）。
   */
  const recordLineActivation = async (
    sessionId: string | undefined,
    previous: VersionLine,
    line: VersionLine,
  ): Promise<void> => {
    try {
      const snap = await loadVersion(line);
      const prevSnap = previous === line ? snap : await loadVersion(previous);
      const now = new Date().toISOString();
      const activationId = dshEventId(['activation', sessionId ?? 'anon', line, snap.git_revision]);
      const contract: ActivationContract = {
        id: activationId,
        ir_version: '2.0',
        schema: 'omb/M6',
        scope: 'Project',
        lifecycle: 'active',
        immutable: false,
        owner: 'kernel',
        created: now,
        updated: now,
        provenance: {
          source: 'mode-command',
          event: activationId,
          actor: 'kernel',
          environment: { os: process.platform, node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
          runtime_snapshot: cognitive?.snapshotHash ?? 'rs:assembly',
          timestamp: now,
          transformation_chain: ['mode/switch'],
          verification: 'replay',
        },
        refs: [],
        predecessor: prevSnap.git_revision,
        candidate: snap.git_revision,
        required_capabilities: [],
        evidence_certificate: 'mode-command',
        compatible_schema: 'omb/IR 2.0',
        activation_scope: 'session',
        rollback_snapshot: prevSnap.git_revision,
      };
      ActivationContractSchema.parse(contract); // M6 schema 校验 fail-loud（不合规不落盘）
      const logDir = resolveConfigPath(config.activationLogDir);
      if (logDir !== undefined) {
        writePending(logDir, {
          activation_id: activationId,
          candidate: snap.git_revision,
          predecessor: prevSnap.git_revision,
          rollback_snapshot: prevSnap.git_revision,
          started_at: Date.now(),
        });
      }
      if (cognitive !== undefined && typeof sessionId === 'string' && sessionId.length > 0) {
        // R2 boot gate：激活事件入链等待 bootReady；boot 失败 → 事件不入链（激活记录落盘路径不受影响）
        if (await cognitiveServiceable()) {
          await cognitive.eventStore.append(makeDshEvent(
            'activation/committed',
            sessionId,
            cognitive.snapshotHash,
            { activation_id: activationId, line, previous_line: previous, git_revision: snap.git_revision },
            'mode',
            undefined,
            activationId,
          ));
        }
      }
      if (logDir !== undefined) {
        writeCompleted(logDir, activationId, contract);
        clearPending(logDir, activationId);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordDegradation('activation', `版本线激活记录失败（${detail}）——切换已生效，记录缺失`);
    }
  };

  // 生命周期安全关闭（插件停止/会话结束）：维护调度器停表 + 认知运行时关库（含组件批量 dispose 回滚——
  // P8 注册皆效应；SQLite WAL 收尾先 close；幂等；失败记录降级不抛——生产装配补全）。
  // 守卫：ctx.effect 缺失（测试 fakeCtx）→ 不注册关闭钩子（命令仍可用）。
  // 清理返回 close promise（Cordis 支持异步清理——测试可 await 确定性断言组件注销）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const rt = cognitive;
      if (rt === undefined) {
        return;
      }
      return () => {
        try {
          rt.maintenance?.stop?.();
        } catch {
          // 停表失败幂等忽略（无状态残留）
        }
        // 本进程 initial 物化 worktree 清理（防跨进程残留累积）
        try {
          disposeMaterializedInitial();
        } catch {
          // 清理失败 → 下次启动 cleanupStaleInitialWorktrees 兜底
        }
        return rt.close().catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          recordDegradation('cognitive/close', `运行时关闭失败（${detail}）`);
        });
      };
    });
  }

  // T8.26.5：turn 收尾共享状态——prepareTurn 决策/工作状态缓存（finalize 输入）与待收尾标记。
  // 收尾触发面（§3.3/§4）：session/flush（耐久检查点）→ finalizeTurn；turn/end（turn 事实关闭）→ 标记待收尾；
  // 无 flush 时退化：下一次 prepareTurn 前惰性收尾（计划 §4 finalizeTurn 守卫行，记录降级路径）。
  const preparedTurns = new Map<string, { decision: GovernorDecision; working_state: PromptWorkingState }>();
  /** 最近观察到的宿主父 Agent（`tools/result` 的 `exec.agent`）——语义裁判 spawn 的必填 parent（审查 H1） */
  let agentRef: unknown;
  const pendingFinalize = new Set<string>();
  /** 在飞收尾（会话 → promise）：宿主每 step 多次 flush 且回调并发启动，收尾必须按会话串行（审查 F1） */
  const finalizing = new Map<string, Promise<void>>();
  // T8.26.4：会话事件追踪（mapper 状态：turn/同 turn 指令 claim/最近 goal——goal 供 prepare 与收尾使用）
  const traces = new Map<string, ReturnType<typeof initialTraceState>>();

  /**
   * turn 收尾（finalizeTurn §3.3）：decision/made 入链（优先最近 prepareTurn 决策，无 → 明确降级决策）+
   * 信号聚合（reducer utility_counts）→ maintenance 入队（注入时）+ checkpoint 保存（dir + 可归约 State 齐备时）。
   * 守卫：无收尾状态（无 prepare 且无待收尾标记）→ 无副作用；finalizeTurn 失败 → 记录降级，保留待收尾状态。
   */
  const finalizePendingTurn = async (sessionId: string, fallbackGoal: string): Promise<void> => {
    const runtime = cognitive;
    if (runtime === undefined) {
      return;
    }
    // 在飞守卫（第二路审查 F1）：宿主 session-checkpoint-policy 在**每次模型请求前 / 每次工具派发前 /
    // 每个 agent step 前**都 flush（`core/session` 用 allSettled 并发启动回调），而 flush handler 是
    // `void finalizePendingTurn(...)`（不 await）。此前只查"成员存在"且清除在多个 await 之后 →
    // 两个触发源可同时通过守卫 → 两次 finalizeTurn：重复 decision/made、债务重复入账（value 翻倍）、
    // 且可能用 preparedTurns 里**下一轮**的 decision/working_state 收尾（错轮次）。
    // 现在：同一会话至多一个收尾在飞，后到者复用同一个 promise。
    const inflight = finalizing.get(sessionId);
    if (inflight !== undefined) {
      return inflight;
    }
    const task = (async (): Promise<void> => {
      // R2 boot gate：恢复完成前认知不进入服务——boot 失败 → 收尾跳过（认知降级为仅命令模式）
      if (!(await cognitiveServiceable())) {
        return;
      }
      if (!pendingFinalize.has(sessionId) && !preparedTurns.has(sessionId)) {
        return; // 无收尾状态（无 prepare/无 turn 结束）→ 不虚构收尾
      }
      const prepared = preparedTurns.get(sessionId);
      const decision = prepared?.decision ?? fallbackFinalizeDecision(runtime.snapshotHash);
      const working = prepared?.working_state ?? fallbackWorkingState(fallbackGoal);
      let state: State | undefined;
      try {
        const sessionEvents = (await runtime.eventStore.query({ session_id: sessionId })).events;
        const reduced = reduce(sessionEvents).state as unknown as State;
        // 空流退化：无任何事件 → provenance.event 为空 → checkpoint M7 schema 校验失败 → 不传 state（checkpoint 跳过）
        if (reduced.provenance.event.length === 0) {
          state = undefined;
        } else if (typeof runtime.materializeState === 'function') {
          // S1：World/Self 运行接线——reduce 产出 State 后填充模型引用（null → 引用；StateSchema 校验，
          // 事件流直归约的 working 缺省字段不阻塞接线）
          state = runtime.materializeState(reduced) as State;
        } else {
          state = reduced; // 兼容：运行时未实现接线 → 事件流直归约状态
        }
      } catch {
        state = undefined; // 不可归约 → 不传 state（checkpoint 跳过，收尾其余照常）
      }
      try {
        await runtime.finalizeTurn({ session_id: sessionId, decision, working_state: working, state });
        pendingFinalize.delete(sessionId);
        preparedTurns.delete(sessionId); // 收尾后清除：双 flush/turn/end 幂等
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordDegradation('finalizeTurn', `收尾失败（${detail}）——保留待收尾状态`);
      }
    })();
    finalizing.set(sessionId, task);
    try {
      await task;
    } finally {
      finalizing.delete(sessionId);
    }
  };

  // S8：投影缓存/防重入/prepare 链状态（context 求值 kick 与 turn/start 预热共用——同一投影管线）。
  const projectionTexts = new Map<string, string>();
  const preparing = new Set<string>();
  // S8：投影管线激活标志——systemPrompt.context 注册成功且认知已装配时，turn/start 预热才触发；
  // 未激活（降级：无 systemPrompt/无认知）→ 不预热（投影缓存无人消费，降级路径行为不变）。
  const projectionActive = systemPrompt?.context !== undefined && cognitive !== undefined;

  /**
   * S8：投影预热链（context 求值 kick 与 turn/start 事件预热共用）。
   * 一拍时序（下一步说明.md 十五节）：DSH systemPrompt.context 为同步求值、prepareTurn 异步 →
   * 首次 context 请求返回空串、下次才用缓存投影（宿主 API 约束折中）。S8 改进：事件驱动预热——
   * DSH 事件流顺序 turn/start → context 求值 → 模型（宿主 agent-loop 实测：turn/start 先于
   * systemPrompt.assemble），session/event 的 turn/start 处理器（事件回调为异步面，不阻塞 DSH
   * 事件派发）提前触发 prepareTurn → context 同步求值时投影通常已就绪，首拍命中率提升；仍可能
   * 未完成（boot pending/检索耗时）→ context 求值返回空串/上次投影（既有缓存兜底，宿主限制文档化）。
   * 防重入：preparing set（turn/start 预热与 context 求值共享——并发只跑一次 prepare）。
   * 守卫：R2 boot gate 含于链内（等待 bootReady；boot 失败 → 本轮无投影）。
   * goal 边界（诚实）：宿主在 context 求值后才将 user/message 入链（agent-loop step() 内 append），
   * turn/start 时最近已观察 goal = 上一 turn 的最近人类指令（首 turn 空）——首拍投影以最近已知 goal
   * 为准；当前指令的投影在 goal 可观察后的下一次 context 求值收敛（既有「每求值即 kick」语义保留）。
   */
  const prepareForTurn = (sessionId: string, events?: ReadonlyArray<{ type?: string; data?: unknown }>): void => {
    const runtime = cognitive;
    if (runtime === undefined) {
      return; // 防御：注册时已守卫运行时存在；并发装配变化时静默降级
    }
    if (preparing.has(sessionId)) {
      return; // 防重入：同一会话的并发预热/求值只跑一次 prepare
    }
    preparing.add(sessionId);
    // goal 来源：插件自身会话追踪（session/event 已观察到的最近人类指令）优先，事件数组兜底
    const goal = traces.get(sessionId)?.lastGoal ?? lastUserMessageText(events);
    const request = buildRequestFromSession(sessionId, goal);
    void (async () => {
      // R2 boot gate：恢复完成前认知不进入服务——等待 bootReady；boot 失败 → 本轮无投影（命令仍可用）
      if (!(await cognitiveServiceable())) {
        return;
      }
      // 请求间隙维护小量子（生产装配）：下一请求开始前执行 1 个待维护任务
      //（turn 收尾入队 → 本 turn 结束 → 下 turn 准备前按债务/优先级执行；无调度器 → 跳过）
      const m = cognitive?.maintenance;
      if (m !== undefined && m !== null) {
        void m.requestQuantum().catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          recordDegradation('maintenance/quantum', `请求间隙维护执行失败（${detail}）`);
        });
      }
      // T8.26.5 惰性收尾（无 flush 触发时的退化路径）：先收尾上一 turn，再准备本 turn
      if (pendingFinalize.has(sessionId)) {
        await finalizePendingTurn(sessionId, goal);
        recordDegradation('finalize/lazy', `turn 收尾经 prepareTurn 惰性路径（无 flush 触发）——session ${sessionId}`);
      }
      const result = await runtime.prepareTurn(request, {
        inject: (projection) => {
          projectionTexts.set(sessionId, projectionToText(projection));
        },
      });
      preparedTurns.set(sessionId, { decision: result.decision, working_state: result.working_state });
      projectionTexts.set(sessionId, projectionToText(result.projection));
    })().catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      recordDegradation('context-provider', `prepareTurn 失败（${detail}）——本轮无投影注入`);
    }).finally(() => {
      preparing.delete(sessionId);
    });
  };

  // T8.26.3：systemPrompt.context 钩子——按请求求值 → prepareTurn → 投影注入（Model-visible ⟺ logged）。
  // 守卫（计划 §2 应对策略 2）：systemPrompt.context 缺失 → 记录降级（无认知注入，命令仍可用）；
  // 认知运行时未装配 → 记录降级、不注册（无注入面）。
  // 求值语义：DSH 的 context text 提供器为同步求值，而 prepareTurn 为异步——故采用「缓存 + 异步预热」：
  //   S8：首个 prepare 由 turn/start 事件预热提前触发（见 prepareForTurn——事件驱动预热，首拍命中率提升）；
  //   context 求值 kick 与预热共享同一 preparing 防重入（预热在飞时静默跳过）；求值同步返回缓存投影文本，
  //   未完成 → 空串/上次投影（首拍余量，宿主同步接口约束文档化——下一步说明.md 十五节）。prepareTurn 的
  //   inject 回调把投影文本写入缓存并触发 context/injected 事件入链（投影摘要：id/total_tokens/views）；
  //   后续请求同步返回缓存投影文本——每次注入的文本都有对应 context/injected 事件（Model-visible ⟺ logged）。
  if (systemPrompt?.context !== undefined) {
    if (cognitive !== undefined) {
      // W5：三层结构接线（宿主架构研究结论）——第一层固定契约（静态常量 section，order 80，零 session 依赖）
      // + 第二层动态能力行（order 85，同步求值自运行时实例：capabilities/components 名称、judgeExecutor
      // 可用性、dynamicRunner 注入）+ 第三层渐进指导（DSH 原生 skill omb-runtime 按需加载——镜像接线见 apply
      // 上部；order 小者在前：contract(80) → capabilities(85) → projection(90)）。
      systemPrompt.context({ name: 'cognitive:contract', order: 80, text: OMB_RUNTIME_CONTRACT });
      // 注：能力行在注册时求值一次（既有契约，测试断言"同步文本"）。运行期可能变化的项（如语义裁判
      // 需捕获父 Agent 才可用）以**行为**保证诚实：不可用时走"转人工复核"，不会假装判定（审查 H1）。
      systemPrompt.context({ name: 'cognitive:capabilities', order: 85, text: buildCapabilitiesLine(capabilitiesViewOf(cognitive)) });
      // S8：context 求值 kick 转交共享预热链（prepareForTurn）——sessionId 提取 + 事件数组兜底（goal 来源）
      const kickPrepare = (assembleCtx: AssembleContextLike): void => {
        const sessionId = assembleCtx?.agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return; // 无会话身份 → 无可注入
        }
        prepareForTurn(sessionId, assembleCtx?.agent?.session?.events);
      };
      systemPrompt.context({
        name: 'cognitive:projection',
        order: 90,
        text: (assembleCtx) => {
          const sessionId = assembleCtx?.agent?.session?.id;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return '';
          }
          kickPrepare(assembleCtx);
          return projectionTexts.get(sessionId) ?? '';
        },
      });
    } else {
      recordDegradation('cognitive-runtime', '认知运行时未装配——无认知契约/能力/投影注入（命令仍可用）');
    }
  } else {
    recordDegradation('systemPrompt.context', '接口缺失（systemPrompt.context 不存在）——无认知契约/能力/投影注入（命令仍可用）');
  }

  // T8.26.4：事件监听——session/event（turn 生命周期 + 工具事实）与 tools/result（live 工具结果）→ observeEvent
  // （EventSchema 校验 → append（幂等）→ state-reducer 增量归约，P7：Event 唯一事实源）。
  // 守卫（计划 §2 应对策略 2）：ctx.on 缺失 → 记录降级（事件不采集，其余功能不受影响）；认知运行时未装配 → 不注册。
  // 双路径幂等：tools/result live 与 session/event tool/result 对同一 callId 产出同一确定性事件 id → observeEvent
  // 重复 id 幂等（只入链一次；live 零延迟信号 + session 耐久事实，先到者胜）。
  // 异步观察 fire-and-forget（append 为同步写，不阻塞 DSH 事件派发；失败记录降级不抛）。
  if (typeof ctx.on === 'function') {
    if (cognitive !== undefined) {
      ctx.on('session/event', (session, dshEvent) => {
        const runtime = cognitive;
        if (runtime === undefined) {
          return; // 防御：注册时已守卫；并发装配变化时静默降级
        }
        const sessionId = (session as { id?: unknown } | undefined)?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return; // 无会话身份 → 无可入链
        }
        const prev = traces.get(sessionId) ?? initialTraceState();
        const mapped = mapSessionEvent(sessionId, dshEvent as never, runtime.snapshotHash, prev);
        traces.set(sessionId, mapped.state);
        // S8：turn/start 预热——事件回调为异步面（不阻塞 DSH 事件派发），提前触发 prepareTurn：
        // DSH 事件流顺序 turn/start → context 求值 → 模型（宿主 agent-loop：turn/start 先于
        // systemPrompt.assemble），预热后 context 同步求值通常命中缓存投影（首拍命中）。
        // 守卫：投影管线未激活（systemPrompt.context 未注册/认知未装配）→ 不预热（缓存无人消费，
        // 降级路径行为不变）；防重入与 boot gate 由 prepareForTurn 承载（preparing set + cognitiveServiceable）。
        if ((dshEvent as { type?: unknown } | undefined)?.type === 'turn/start' && projectionActive) {
          prepareForTurn(sessionId);
        }
        // R2 boot gate：恢复完成前认知不进入服务——观察入链等待 bootReady；boot 失败 → 事件不入链
        void (async () => {
          if (!(await cognitiveServiceable())) {
            return;
          }
          for (const ev of mapped.events) {
            void runtime.observeEvent(ev).catch((err) => {
              const detail = err instanceof Error ? err.message : String(err);
              recordDegradation('session/event', `observeEvent 失败（${detail}）——事件已记录降级`);
            });
          }
        })().catch((err: unknown) => {
          // 审查修复 H5：此前这条 fire-and-forget 链没有 .catch（同文件另三处都有）——`await
          // cognitiveServiceable()` 或映射阶段的异常会变成未处理拒绝（宿主按默认策略会致命，
          // 装了 handler 则完全静默、观测面看不到"事件采集链已死"）。
          const detail = err instanceof Error ? err.message : String(err);
          recordDegradation('session/event', `事件采集链异常（${detail}）——已记录降级`);
        });
        // T8.26.5：turn/end = turn 事实关闭 → 标记待收尾（flush 或下一次 prepareTurn 触发 finalizeTurn）
        if ((dshEvent as { type?: unknown } | undefined)?.type === 'turn/end') {
          pendingFinalize.add(sessionId);
        }
      });
      // T8.26.5：session/flush（耐久检查点）→ finalizeTurn（decision/made + checkpoint + 信号 → MaintenanceQueue）。
      // 守卫：flush 事件缺失时由 prepareTurn 惰性收尾路径承接（见 finalizePendingTurn 调用面）。
      ctx.on('session/flush', (session) => {
        const sessionId = (session as { id?: unknown } | undefined)?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return;
        }
        const goal = traces.get(sessionId)?.lastGoal ?? '';
        void finalizePendingTurn(sessionId, goal).catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          recordDegradation('session/flush', `收尾触发失败（${detail}）`);
        });
      });
      ctx.on('tools/result', (exec, result) => {
        const runtime = cognitive;
        if (runtime === undefined) {
          return;
        }
        // 父 Agent 捕获（第二轮审查 H1）：宿主只在工具调用上下文里给出 Agent（`exec.agent`），
        // 而 subagents.start 的 parent 是必填——就近捕获最近一个，供语义裁判通道使用。
        const agent = (exec as { agent?: unknown } | undefined)?.agent;
        if (agent !== undefined && agent !== null) {
          agentRef = agent;
        }
        const sessionId = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return;
        }
        const ev = mapLiveToolResult(sessionId, exec, result, runtime.snapshotHash);
        // R2 boot gate：恢复完成前认知不进入服务——live 信号入链等待 bootReady；boot 失败 → 不入链
        void (async () => {
          if (!(await cognitiveServiceable())) {
            return;
          }
          await runtime.observeEvent(ev).catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            recordDegradation('tools/result', `observeEvent 失败（${detail}）——工具结果 live 信号降级`);
          });
        })();
      });
    } else {
      recordDegradation('cognitive-runtime', '认知运行时未装配——事件不采集（命令仍可用）');
    }
  } else {
    recordDegradation('ctx.on', '接口缺失（ctx.on 不存在）——事件不采集（其余功能不受影响）');
  }

  ctx.commands?.register?.({
    name: 'mode',
    description: '切换版本线（initial | stable | latest；空白会话才能切换）',
    input: { hint: '<initial|stable|latest>' },
    recordInput: true,
    handler: async (invocation) => {
      const events = invocation.agent.session?.events;
      const sessionId = (invocation.agent.session as { id?: string } | undefined)?.id;
      return modeCommandHandler(invocation.rawInput ?? '', {
        load: async (line) => loadVersion(line),
        currentLine: () => current,
        isBlankSession: async () => isBlankSession(events),
        onSwitch: async (line) => {
          const previous = current;
          current = line;
          // R2 boot gate：恢复完成前认知不进入服务——快照重建等待 bootReady；boot 失败 → 认知部分
          // 跳过（切换本身已生效——命令仍可用）
          if (await cognitiveServiceable()) {
            // P1b：切换后重建运行时快照（新线物化 → 新快照 → registry.promote → 下一请求生效，D1⑤：
            // 请求运行于「线 stable + commit a81f + 快照 rs:7c91」而非模糊的「我现在应该是 stable」）。
            // 失败降级：物化失败 → 记录降级，当前快照保持（切换状态仍生效，快照不变）。
            if (cognitive !== undefined && typeof cognitive.rebuildSnapshotForLine === 'function') {
              try {
                const r = cognitive.rebuildSnapshotForLine(line);
                if (r.degraded !== null && r.degraded !== undefined) {
                  recordDegradation('lines/rebuild', r.degraded);
                }
              } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                recordDegradation('lines/rebuild', `快照重建异常（${detail}）——当前快照保持`);
              }
            }
          }
          // T8.7 生产接线：版本线激活记录——activation/committed 事件入链（认知装配时）+
          // activationLogDir 幂等持久化（配置时；重启后恢复）。字段全部来自真实切换数据；
          // 任一步失败 → 降级记录（切换已生效，仅记录缺失，不影响命令结果）。
          await recordLineActivation(sessionId, previous, line);
        },
      });
    },
  });

  // T8.2：/bench 命令——触发冻结基准集运行（当前版本线）。
  // T2.3：默认 v2 契约基准（benchmark-v2-contract：契约四要素单一权威；`config.benchVersion: 'v1'` 切回
  // legacy 录制基准——v1 全链路原样保留，两版本并存可对比「修复了基准契约」与「模型真的进步」）。
  // T8.18：真实执行器接线——modelAdapter（T8.12 装配，需真实 DSH 会话）存在 → 真实 DSH 执行
  //（三线真实分化）；无真实会话 → 降级回放执行器（数字可复现，平台限制文档化）。
  ctx.commands?.register?.({
    name: 'bench',
    description: '运行基准集（默认 v2 契约基准；config.benchVersion 可切回 v1 legacy）',
    recordInput: true,
    handler: async () => {
      try {
        const line = current as BenchLine;
        const version = config.benchVersion ?? 'v2';
        if (version === 'v2') {
          // v2 契约基准：契约 + fixture（reference 生成）→ 真实执行（renderPromptV2 + parseModelOutputV2）
          // 或回放执行（fixture.output 直通）→ runBenchV2（schema 校验 + verifier rules 判定）。
          const contracts = await loadBenchContractsV2();
          const fixtures = await loadBenchFixturesV2();
          const fixtureById = new Map(fixtures.map((f): [string, BenchFixtureV2] => [f.task_id, f]));
          // makeRealExecutorV2 签名 (task, fixture)；runBenchV2 executor 单参 → 闭包绑定 fixture
          //（runBenchV2 已先行校验契约↔fixture 配对，此处非空断言安全）。
          const realV2 = modelAdapter !== undefined ? makeRealExecutorV2(modelAdapter) : undefined;
          const executor: BenchExecutorV2 =
            realV2 !== undefined ? (task) => realV2(task, fixtureById.get(task.id)!) : makeReplayExecutorV2(fixtures);
          // P4（D6 全任务双判）：真实会话（modelAdapter 存在）→ 注入 LLM judge——与执行同一 modelAdapter
          //（makeJudgeV2：judge 调用复用 generate，reasoningEffort=low / maxTokens=1000 默认合理值；
          // judge 成本单列入 JSONL judge 段与 bench-report）；回放模式无 judge（回放产物无评判意义，
          // 且 judge 成本无意义——文本说明）。
          // 判定纪律：judge 仅旁证、永不作晋升硬信号（架构 §7.1；P1e 晋升门禁保持规则/基准判定——
          // 本专项不改晋升逻辑，见 supervisor/judge.ts 头注释与 P1e）。
          const judge = modelAdapter !== undefined ? makeJudgeV2(modelAdapter) : undefined;
          // 明细落盘（workspace/.omb/bench/<mode>-v2-<line>-<ts>.jsonl）：真实与回放分开记录（T8.18 归因）；
          // mode 仅标记不改变判定。
          const report = await runBenchV2({
            contracts,
            fixtures,
            line,
            executor,
            mode: modelAdapter !== undefined ? 'real' : 'replay',
            persistDir: resolveConfigPath(config.benchPersistDir) ?? BENCH_REPORTS_DIR,
            judge,
          });
          const mode = modelAdapter !== undefined ? '真实执行' : '回放执行（无 DSH 会话，降级）';
          const judgeText = report.judge.enabled
            ? `；judge 对照（D6 全任务双判，仅旁证）：${report.judge.run}/${report.judge.run + report.judge.degraded} 判词（降级 ${report.judge.degraded}，双判一致率 ${(report.judge.rate * 100).toFixed(1)}%）`
            : '；judge 对照：未启用（回放模式无 LLM judge）';
          return {
            kind: 'success',
            text: `v2 契约基准完成：${report.line} ${report.passed}/${report.total} 通过（${report.total} 任务，${mode}${judgeText}；明细已落盘 workspace/.omb/bench）`,
          };
        }
        // v1 legacy 分支（benchVersion === 'v1'；原样保留 v1 全链路：supervisor/bench.ts runBench）
        const tasks = await loadBenchTasks();
        const executor = modelAdapter !== undefined ? makeRealExecutor(modelAdapter) : makeReplayExecutor();
        // 明细落盘（workspace/.omb/bench/<mode>-<line>-<ts>.jsonl）：逐任务输入/输出/验证结果/
        // 失败原因，真实与回放分开记录（T8.18 三线真实分化归因）；mode 仅标记不改变判定。
        const report = await runBench({
          tasks,
          line,
          executor,
          mode: modelAdapter !== undefined ? 'real' : 'replay',
          persistDir: resolveConfigPath(config.benchPersistDir) ?? BENCH_REPORTS_DIR,
        });
        const passed = report.results.filter((r) => r.passed).length;
        const mode = modelAdapter !== undefined ? '真实执行' : '回放执行（无 DSH 会话，降级）';
        return {
          kind: 'success',
          text: `基准完成：${report.line} ${passed}/${report.results.length} 通过（${report.results.length} 任务，${mode}；明细已落盘 workspace/.omb/bench）`,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { kind: 'error', text: `基准运行失败：${detail}` };
      }
    },
  });

  // P1c：/evolve 命令（设计 §6 命令表）——立即执行一次演化判定与维护量子 + R8 显式集体共享。
  // 语法：/evolve now（或空参数）→ 演化判定与维护量子；/evolve share → 发布机制级 Evolution Object
  //      （trusted-latest 演化链头 → 本地 registry，隐私原则：仅机制数据，不发布私人记忆/会话内容）；
  //      /evolve absorb <id> → 显式吸收（本地验证 schema/签名 → share-pipeline absorb 管线 → 共识回传）；
  //      其余参数 → 明确 error 文本（不崩）。
  // 行为（now）：读 signals → evolve.policy 判定（数据化，纯函数）→ 应演化则入队 candidate_validation（债务入账）
  //       + evolution/candidate 事件入链 → 执行一次维护量子 → maintenance/quantum 事件入链 →
  //       返回摘要（判定结果/入队任务/quantum 执行/debt 快照）。
  // 守卫：认知运行时未装配 → error 文本；任一步失败 → error 文本（不崩）。
  // R8 语义：生产默认（evolve.policy share.publish_mechanism_objects=false/auto_discover=false）不影响
  // 显式命令——配置仅控制未来自动路径。
  ctx.commands?.register?.({
    name: 'evolve',
    description: '演化判定与维护量子（now）；显式集体共享（share 发布机制级对象 / absorb <id> 吸收）',
    input: { hint: '<now|share|absorb <id>>' },
    recordInput: true,
    handler: async (invocation) => {
      try {
        const raw = (invocation.rawInput ?? '').trim();
        // R8：/evolve share——发布机制级 Evolution Object（显式命令始终可用，配置不阻塞）
        if (raw === 'share' || raw.startsWith('share ')) {
          if (raw !== 'share') {
            return { kind: 'error', text: `evolve share 不支持子参数："${raw}"（语法：/evolve share）` };
          }
          const runtime = cognitive;
          if (runtime === undefined) {
            return { kind: 'error', text: '认知运行时未装配——/evolve share 不可用' };
          }
          if (typeof runtime.shareEvolutionObject !== 'function') {
            return { kind: 'error', text: '运行时未实现共享发布（shareEvolutionObject 缺失）' };
          }
          // R2 boot gate：恢复完成前认知不进入服务
          if (!(await cognitiveServiceable())) {
            return { kind: 'error', text: '启动恢复未完成/失败——认知运行时降级（仅命令模式），/evolve share 不可用' };
          }
          const sessionId = (invocation.agent.session as { id?: string } | undefined)?.id ?? 'anon';
          const r = await runtime.shareEvolutionObject({ session_id: sessionId });
          return r.ok ? { kind: 'success', text: r.text } : { kind: 'error', text: r.text };
        }
        // R8：/evolve absorb <id>——显式吸收（参数缺失 → 帮助文本）
        if (raw === 'absorb' || raw.startsWith('absorb ')) {
          const id = raw === 'absorb' ? '' : raw.slice('absorb '.length).trim();
          if (id.length === 0) {
            return { kind: 'error', text: 'evolve absorb 需要对象 id（语法：/evolve absorb <id>；id 可从 registry manifest 或 /evolve share 输出获取）' };
          }
          const runtime = cognitive;
          if (runtime === undefined) {
            return { kind: 'error', text: '认知运行时未装配——/evolve absorb 不可用' };
          }
          if (typeof runtime.absorbEvolutionObject !== 'function') {
            return { kind: 'error', text: '运行时未实现共享吸收（absorbEvolutionObject 缺失）' };
          }
          if (!(await cognitiveServiceable())) {
            return { kind: 'error', text: '启动恢复未完成/失败——认知运行时降级（仅命令模式），/evolve absorb 不可用' };
          }
          const sessionId = (invocation.agent.session as { id?: string } | undefined)?.id ?? 'anon';
          const r = await runtime.absorbEvolutionObject({ session_id: sessionId, object_id: id });
          return r.ok ? { kind: 'success', text: r.text } : { kind: 'error', text: r.text };
        }
        if (raw !== '' && raw !== 'now') {
          return { kind: 'error', text: `evolve 命令参数非法："${raw}"（支持空、now、share、absorb <id>）` };
        }
        const runtime = cognitive;
        if (runtime === undefined) {
          return { kind: 'error', text: '认知运行时未装配——/evolve now 不可用' };
        }
        if (typeof runtime.runEvolutionNow !== 'function') {
          return { kind: 'error', text: '运行时未实现演化判定（runEvolutionNow 缺失）' };
        }
        // R2 boot gate：恢复完成前认知不进入服务——等待 bootReady；boot 失败 → /evolve 不可用（仅命令模式）
        if (!(await cognitiveServiceable())) {
          return { kind: 'error', text: '启动恢复未完成/失败——认知运行时降级（仅命令模式），/evolve now 不可用' };
        }
        const sessionId = (invocation.agent.session as { id?: string } | undefined)?.id ?? 'anon';
        const r = await runtime.runEvolutionNow({ session_id: sessionId });
        const d = r.decision;
        const debtText =
          (r.debt as Array<{ task_id: string; value: number }>)
            .map((x) => `${x.task_id}=${x.value}`)
            .join(', ') || '（空）';
        const lines = [
          `演化判定：should_evolve=${String(d.should_evolve)}（strength ${d.strength}，object_layer ${String(d.object_layer)}，budget_estimate ${d.budget_estimate}，${d.reason}）`,
          `入队维护任务：[${r.enqueued.join(', ') || '无'}]`,
          `quantum 执行：ran=[${r.quantum.ran.join(', ') || '无'}]，skipped=[${r.quantum.skipped.join(', ') || '无'}]`,
          `维护债务快照：${debtText}`,
          `事件入链：${r.events_appended}（evolution/candidate + evolution/promoted + activation/committed + maintenance/quantum）`,
        ];
        // P1d：候选管线摘要（候选数/各门结果/晋升 id/commit）
        const candidates = r.candidates ?? [];
        if (candidates.length > 0) {
          lines.push(
            `候选管线：生成 ${candidates.length} 个候选 → ${candidates
              .map((c) => {
                const verdict = c.validated === true ? 'G1+G3 通过' : c.reason !== undefined ? c.reason : '未验证';
                return `${String(c.candidate_id).slice(0, 16)}…(${verdict})${c.promoted === true ? '→晋升' : ''}`;
              })
              .join('，')}`,
          );
        }
        if (r.promoted !== null && r.promoted !== undefined) {
          lines.push(
            `晋升：candidate=${String(r.promoted.candidate_id).slice(0, 16)}… object=${String(r.promoted.object_id).slice(0, 16)}… commit=${String(r.promoted.commit_hash).slice(0, 12)}…`,
          );
        }
        // P1e：晋升检查摘要（stable ← trusted-latest 显式门禁；跳过/通过/失败逐态展示）
        const promo = r.promotion;
        if (promo !== undefined) {
          if (!promo.checked) {
            lines.push(`晋升检查：跳过（${promo.skipped_reason ?? '未知原因'}）`);
          } else if (promo.promoted) {
            lines.push(
              `晋升检查：门禁通过（${promo.reasons.length} 条信号）→ 已晋升 stable=${String(promo.stable_commit ?? '').slice(0, 12)}…（activation=${String(promo.activation_id ?? '').slice(0, 20)}…${promo.warning !== undefined ? `；告警：${promo.warning}` : ''}）`,
            );
          } else if (!promo.gate_ok) {
            lines.push(`晋升检查：门禁未通过——候选保持 trusted-latest（${(promo.reasons ?? []).slice(0, 3).join('；')}）`);
          } else if (promo.error !== undefined) {
            lines.push(`晋升检查：失败（${promo.error}）`);
          }
        }
        if (r.degraded !== null) {
          lines.push(`降级：${r.degraded}`);
        }
        return { kind: 'success', text: lines.join('\n') };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { kind: 'error', text: `演化执行失败：${detail}` };
      }
    },
  });

  /**
   * 状态面：安全状态与平台能力（已知问题《外核自身也要非阻塞》：当前是否处于安全状态、原因、发生时间
   * 可经状态面与日志查看）。内核已装配 → 并入其状态摘要（`safe_state` 段）；内核未装配（安全状态或
   * 装配失败）→ 仍返回本段（命令面与状态面尽力保留）。
   */
  // 受限通道自检（sandboxStatusAsync：平台机制 + 真实探针"授权目录写成功 + 非授权目录写被拒"）——
  // 与候选验证 G3-exec 使用同一判定入口，避免"状态面说可用、门禁处却降级"的口径分叉。
  // 自检异步且带子进程，故不阻塞 apply：先给同步能力面，自检完成后并入（命令面/状态面均已就绪）。
  const platformCaps = platformProvider().caps;
  const platformView: NonNullable<ApplyResult['platform']> = {
    platform: platformCaps.platform,
    raw: platformCaps.raw,
    read_only: platformCaps.read_only,
    read_only_available: platformCaps.read_only_available,
    sandbox: platformCaps.sandbox,
    sandbox_available: platformCaps.sandbox_available,
    sandbox_reachable: false,
    sandbox_mechanism: null,
    sandbox_reason: null,
    sandbox_self_test: null,
    degraded: platformCaps.degraded,
  };
  void sandboxStatusAsync()
    .then((st) => {
      platformView.sandbox_reachable = st.available;
      platformView.sandbox_mechanism = st.mechanism ?? null;
      platformView.sandbox_reason = st.reason ?? null;
      platformView.sandbox_self_test = st.self_test_note ?? null;
    })
    .catch(() => {
      platformView.sandbox_reason = '受限通道自检异常（按不可用处理）';
    });

  return { cognitive, safeState: safeStateView(), platform: platformView, safeStateRuntime: safeStateRuntime() };
}
