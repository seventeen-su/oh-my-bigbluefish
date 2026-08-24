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
import { bootStable, type BootOptions, type BootResult } from '../substrate/boot.js';
import { modeCommandHandler } from '../substrate/mode-command.js';
import { loadBenchTasks, makeReplayExecutor, runBench, BENCH_REPORTS_DIR } from '../supervisor/bench.js';
import { loadBenchContractsV2, loadBenchFixturesV2, makeReplayExecutorV2, runBenchV2, type BenchExecutorV2 } from '../supervisor/bench-v2.js';
import { makeRealExecutor, makeRealExecutorV2 } from '../supervisor/real-executor.js';
import { makeJudgeV2 } from '../supervisor/judge.js';
import { createCognitiveRuntime } from './assembly.js';
import { registerKernTools, type KernStatusSummary, type ToolsLike } from './kern-tools.js';
import { createDshModelAdapter, type LlmStreamLike } from './model-adapter.js';
import { buildRequestFromSession, fallbackFinalizeDecision, fallbackWorkingState, lastUserMessageText, projectionToText, recordDegradation } from './loop-hooks.js';
import { initialTraceState, mapLiveToolResult, mapSessionEvent } from './dsh-events.js';
import { reduce } from '../supervisor/state-reducer.js';
import { MaintenanceScheduler } from '../supervisor/maintenance.js';
import { writeCompleted, writePending, clearPending } from '../supervisor/activation-log.js';
import { ActivationContractSchema, type ActivationContract } from '../kernel/schemas/m.js';
import { dshEventId, makeDshEvent } from './loop-hooks.js';
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
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
    scope_chain: string[];
    degraded: string | null;
  }>;
  /** S1：State.world/self 引用填充（reduce 产出 State 后 null → 模型引用；StateSchema 校验——
   *  合规路径返回校验结果，事件流直归约的 working 缺省字段（既有诚实空语义）不阻塞接线） */
  materializeState?(state: unknown): unknown;
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
  /** 装配出的认知运行时（未提供装配根 → undefined；仅注册命令） */
  cognitive?: CognitiveRuntimeLike;
}

/**
 * R2 启动竞态修复：bootReady resolve 载荷（受控 promise——认知 gate 与降级记录共用）。
 * bootStable 的认知 gate 子集：最终是否可用（回退后仍不可加载/无恢复路径 → false）、
 * 校验版本线、告警记录、自动回退详情。bootStable 异常 → ok:false 兜底（不 reject）。
 */
export type BootReady = Pick<BootResult, 'ok' | 'line' | 'warnings' | 'rollback'>;

export function apply(ctx: ContextLike, config: PluginConfig = {}): ApplyResult {
  // 分享后自动初始化三线布局与只读 ACL（专项「进程内自动初始化」）：versions.git/stable/latest
  // 均 gitignored、不随仓库分发 → 项目被分享（clone/拷贝）后布局缺失/损坏/ACL 丢失 →
  // 进程内自动初始化或保守修复。锁安全性：git/icacls 均以短生命周期子进程（execFileSync）运行，
  // DSH 进程不持有 versions.git/stable/latest 的文件句柄（正式 worktree 运行只读）→ 无锁冲突；
  // 布局健康时纯 fs 检查、零 git 子进程（零开销）。degraded → 记录降级（不阻塞挂载，命令仍可用）。
  // 顺序：bootstrap 守卫（ensureThreeLineLayout → 跨进程残留清理）→ bootStable（回退校验依赖布局就绪）。
  if (config.bootstrap !== false) {
    const r = ensureThreeLineLayout();
    if (r.status === 'degraded') {
      recordDegradation('layout/bootstrap', r.detail);
    } else if (r.status !== 'ok') {
      console.info(`[omb-v2] 三线布局自动${r.status === 'initialized' ? '初始化' : '修复'}完成：${r.detail}`);
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
  const bootReady: Promise<BootReady> = boot().then((r) => {
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

  if (cognitive === undefined) {
    // 相对路径解析：config 路径相对 preset 根（迁移可移植——组合文件随项目走，绝对路径会指向旧机器）
    const root = resolveConfigPath(config.cognitiveRoot);
    if (root !== undefined) {
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
      cognitive = createCognitiveRuntime({
        root,
        modelAdapter,
        // P1a：按当前版本线加载 policy/processes（lines 物化快照注入；缺失/失败 → 运行时回退仓库默认）
        line: current,
        // 生产装配（ChatGPT 修复意见 #3/#4）：持久化检查点目录（finalizeTurn 保存工作状态）+ 维护调度器
        //（turn 收尾入队 + 请求间隙小量子；debt 落盘到认知数据根 .evolution/）
        checkpointDir: join(root, 'checkpoints'),
        maintenance: new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') }),
        // R6：宿主版本唯一来源注入（提供 → 覆写运行时指纹/事件 provenance 的 dsh_version；缺省 DSH_HOST_VERSION）
        hostVersion: config.hostVersion,
      });
      // P1a：lines 按线加载降级（线快照缺 policy / lines 不可用 → 已回退仓库默认）→ 记录降级（不抛，命令仍可用）
      if (cognitive.lineDegraded !== undefined && cognitive.lineDegraded !== null) {
        recordDegradation('lines/load', cognitive.lineDegraded);
      }
    }
  }

  /**
   * P2/S5：组件↔DSH 工具注册桥（设计 §6 平台集成——ctx.tools.register 少量精炼工具，kern_* 命名，工具数 <10）。
   * 工具集：kern_status（P2 桥机制验证）+ kern_bench/kern_evolve/kern_switch/kern_memory（S5 补齐）——
   * 全部为认知运行时方法（status/benchV2/runEvolutionNow/switchLine/retrieveMemory）的薄封装
   * （runtime/kern-tools.ts registerKernTools 统一注册；守卫：tools 面缺失 → 记录降级不崩，对齐既有守卫风格；
   * 认知运行时未装配 → 不注册（记录——kern_* 依赖运行时状态）。
   * P8（注册皆效应）：工具注册 disposer 集入 DSH 生命周期（ctx.effect）——插件关闭 → 批量注销回滚。
   * ⚠️ Guard 契约（B3 教训）：tools 必须经 ctx.get('tools') 读取（真实宿主对未 inject 的属性读取抛
   * `cannot get property "tools" without inject`）——禁止直接访问 ctx.tools。
   */
  const tools = readService<ToolsLike>(ctx, 'tools');
  if (tools !== undefined && typeof tools.register === 'function') {
    if (cognitive !== undefined) {
      const r = registerKernTools(tools, cognitive);
      if (r.degraded !== null) {
        recordDegradation('kern/tools', r.degraded);
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
      recordDegradation('kern/tools', '认知运行时未装配——kern_* 工具未注册');
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
          environment: { os: 'windows', node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
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
  const pendingFinalize = new Set<string>();
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
  };

  // T8.26.3：systemPrompt.context 钩子——按请求求值 → prepareTurn → 投影注入（Model-visible ⟺ logged）。
  // 守卫（计划 §2 应对策略 2）：systemPrompt.context 缺失 → 记录降级（无认知注入，命令仍可用）；
  // 认知运行时未装配 → 记录降级、不注册（无注入面）。
  // 求值语义：DSH 的 context text 提供器为同步求值，而 prepareTurn 为异步——故采用「缓存 + 异步预热」：
  //   首请求触发 prepareTurn（fire-and-forget，防重入），返回空串（空文本不贡献）；prepareTurn 的 inject
  //   回调把投影文本写入缓存并触发 context/injected 事件入链（投影摘要：id/total_tokens/views）；后续请求
  //   同步返回缓存投影文本——每次注入的文本都有对应 context/injected 事件（Model-visible ⟺ logged）。
  if (systemPrompt?.context !== undefined) {
    if (cognitive !== undefined) {
      const projectionTexts = new Map<string, string>();
      const preparing = new Set<string>();
      const kickPrepare = (assembleCtx: AssembleContextLike): void => {
        const runtime = cognitive;
        if (runtime === undefined) {
          return; // 防御：注册时已守卫运行时存在；并发装配变化时静默降级
        }
        const agent = assembleCtx?.agent;
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return; // 无会话身份 → 无可注入
        }
        if (preparing.has(sessionId)) {
          return; // 防重入：同一会话的并发 assembly 只跑一次 prepare
        }
        preparing.add(sessionId);
        // goal 来源：插件自身会话追踪（session/event 已观察到的最近人类指令）优先，assembleCtx 事件兜底
        const goal = traces.get(sessionId)?.lastGoal ?? lastUserMessageText(agent?.session?.events);
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
      recordDegradation('cognitive-runtime', '认知运行时未装配——无认知投影注入（命令仍可用）');
    }
  } else {
    recordDegradation('systemPrompt.context', '接口缺失（systemPrompt.context 不存在）——无认知投影注入（命令仍可用）');
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
        })();
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

  return { cognitive };
}
