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
// M0：注册 /mode（handler 纯逻辑在 substrate/mode-command.ts）；T8.2：/mode 真实 recompose 接线
//（presetIdForLine 映射，失败 → mode-command 明确受限降级会话内状态）；注册 /bench（supervisor/bench.ts）。
// 函数插件契约：apply(ctx, config)——config 为 agent.cordis.yml 行的 config（Cordis Fiber 以第二参传入）。
import { loadVersion, type VersionLine } from '../substrate/snapshot.js';
import { bootStable } from '../substrate/boot.js';
import { modeCommandHandler } from '../substrate/mode-command.js';
import { loadBenchTasks, makeReplayExecutor, runBench, BENCH_REPORTS_DIR } from '../supervisor/bench.js';
import { makeRealExecutor } from '../supervisor/real-executor.js';
import { createCognitiveRuntime } from './assembly.js';
import { createDshModelAdapter, type LlmStreamLike } from './model-adapter.js';
import { buildRequestFromSession, fallbackFinalizeDecision, fallbackWorkingState, lastUserMessageText, projectionToText, recordDegradation } from './loop-hooks.js';
import { initialTraceState, mapLiveToolResult, mapSessionEvent } from './dsh-events.js';
import { reduce } from '../supervisor/state-reducer.js';
import { MaintenanceScheduler } from '../supervisor/maintenance.js';
import { join } from 'node:path';
import type { ContextProjection } from '../kernel/schemas/a.js';
import type { Event } from '../kernel/schemas/m.js';
import type { State } from '../kernel/schemas/s.js';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import type { BenchLine } from '../kernel/schemas/bench.js';
import type { GovernorDecision } from './governor.js';
import type { PromptWorkingState } from './prompt.js';

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

/** DSH CommandInvocation 的最小结构（真实类型含 commandId/agent/rawInput/signal） */
export interface CommandInvocationLike {
  readonly commandId: unknown;
  readonly agent: {
    readonly session?: { readonly events?: ReadonlyArray<{ readonly type?: string }> };
  };
  readonly rawInput: string;
  readonly signal: unknown;
}

/** DSH agentPresets 服务的最小结构（真实类型见 @deepseek-ai/dsh-agent-presets；recompose 空白会话重链） */
export interface AgentPresetsLike {
  recompose?(agentCtx: unknown, id: string): Promise<unknown>;
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
  handleRequest(req: unknown): Promise<{
    decision: { decision: string };
    retrieval: { items: unknown[]; channel_used: string };
    prompt: { system: string; total_tokens: number };
    events_appended: number;
  }>;
  close(): Promise<void>;
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
  /** T8.2：preset recompose 服务（平台提供时 /mode 真实接线；缺失 → 降级会话内状态）——经 get('agentPresets') 读取 */
  agentPresets?: AgentPresetsLike;
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

/**
 * 空白会话检查：会话事件流中尚无 turn/start。
 * 与 DSH api-proxy 的 sessionBlank 同款语义（api-proxy.ts:476：turn = 一次模型循环执行，
 * 无 turn/start 即空白；命令生命周期记录不打开 turn，运行 /mode 本身不会破坏空白）。
 */
function isBlankSession(events: ReadonlyArray<{ readonly type?: string }> | undefined): boolean {
  return !(events ?? []).some((event) => event.type === 'turn/start');
}

/** 版本线 → 子 preset id（recompose 目标命名约定：omb-v2-<line>；初始无对应 preset 时 recompose 明确受限） */
export function presetIdForLine(line: VersionLine): string {
  return `omb-v2-${line}`;
}

/** apply 返回句柄（Cordis 忽略函数插件返回值；装配断言/测试句柄用） */
export interface ApplyResult {
  /** 装配出的认知运行时（未提供装配根 → undefined；仅注册命令） */
  cognitive?: CognitiveRuntimeLike;
}

export function apply(ctx: ContextLike, config: PluginConfig = {}): ApplyResult {
  // 恢复根启动完整性校验（架构 §3/§11.4；T8.1 生产接线补全）：stable 引用/内容损坏 →
  // bootStable 自动沿历史回退到上一完好快照。apply 为同步契约，bootStable 异步 fire-and-forget
  //（先于认知装配发起；回退成功/失败均记录降级，命令仍可用——不阻塞挂载）。
  void bootStable().then((r) => {
    if (r.ok === false) {
      recordDegradation('boot/stable', `启动校验失败：版本线 ${r.line} 无恢复路径（${r.warnings.map((w) => w.kind).join(',')}）`);
    } else if (r.rollback !== undefined) {
      recordDegradation('boot/stable', `启动自动回退：${r.rollback.previous_head.slice(0, 8)} → ${r.rollback.new_head.slice(0, 8)}（worktree ${r.rollback.worktree_status}）`);
    }
  }).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    recordDegradation('boot/stable', `启动校验异常（${detail}）——跳过自动回退`);
  });
  // T8.3：认知系统装配进插件生命周期——经 deps 注入（get('cognitive')，组合根模式）或
  // 组合根缺省装配（runtime/assembly.ts；装配根 = config.cognitiveRoot）。
  // 未提供装配根 → 仅注册命令（认知装配为可选配置面，生产经 agent.cordis.yml config 接线）。
  // 状态存闭包（真实运行时 Guard 禁止写未 provide 的 ctx 属性）。
  let cognitive = readService<CognitiveRuntimeLike>(ctx, 'cognitive');
  let modelAdapter = readService<ModelAdapter>(ctx, 'modelAdapter');
  const systemPrompt = readService<SystemPromptLike>(ctx, 'systemPrompt');
  const agentPresets = readService<AgentPresetsLike>(ctx, 'agentPresets');
  if (cognitive === undefined) {
    const root = config.cognitiveRoot;
    if (root !== undefined) {
      // T8.12：组合根装配 ModelAdapter——显式注入优先；否则 llm 服务 + config.model 齐备时自动装配
      //（真实 DSH 会话经 llm 服务提供；缺失 → 缺省受限，LLM 路径不装配，纯规则阶梯）。
      if (modelAdapter === undefined) {
        const llm = readService<LlmStreamLike>(ctx, 'llm');
        const provider = config.model?.provider;
        const model = config.model?.model;
        if (llm !== undefined && provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
          modelAdapter = createDshModelAdapter(llm, { provider, model });
        }
      }
      cognitive = createCognitiveRuntime({
        root,
        modelAdapter,
        // 生产装配（ChatGPT 修复意见 #3/#4）：持久化检查点目录（finalizeTurn 保存工作状态）+ 维护调度器
        //（turn 收尾入队 + 请求间隙小量子；debt 落盘到认知数据根 .evolution/）
        checkpointDir: join(root, 'checkpoints'),
        maintenance: new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json') }),
      });
    }
  }

  // 当前生效版本线（默认 stable，架构 §11.1）；recompose 失败/缺失时保持会话内状态
  let current: VersionLine = 'stable';

  // 生命周期安全关闭（插件停止/会话结束）：维护调度器停表 + 认知运行时关库
  //（SQLite WAL 收尾先 close；幂等；失败记录降级不抛——生产装配补全）。
  // 守卫：ctx.effect 缺失（测试 fakeCtx）→ 不注册关闭钩子（命令仍可用）。
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
        void rt.close().catch((err) => {
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
      state = reduced.provenance.event.length > 0 ? reduced : undefined;
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
        // 请求间隙维护小量子（生产装配）：下一请求开始前执行 1 个待维护任务
        //（turn 收尾入队 → 本 turn 结束 → 下 turn 准备前按债务/优先级执行；无调度器 → 跳过）
        const m = cognitive?.maintenance;
        if (m !== undefined && m !== null) {
          void m.requestQuantum().catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            recordDegradation('maintenance/quantum', `请求间隙维护执行失败（${detail}）`);
          });
        }
        // goal 来源：插件自身会话追踪（session/event 已观察到的最近人类指令）优先，assembleCtx 事件兜底
        const goal = traces.get(sessionId)?.lastGoal ?? lastUserMessageText(agent?.session?.events);
        const request = buildRequestFromSession(sessionId, goal);
        void (async () => {
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
        for (const ev of mapped.events) {
          void runtime.observeEvent(ev).catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            recordDegradation('session/event', `observeEvent 失败（${detail}）——事件已记录降级`);
          });
        }
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
        void runtime.observeEvent(ev).catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          recordDegradation('tools/result', `observeEvent 失败（${detail}）——工具结果 live 信号降级`);
        });
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
      return modeCommandHandler(invocation.rawInput ?? '', {
        load: async (line) => loadVersion(line),
        currentLine: () => current,
        isBlankSession: async () => isBlankSession(events),
        // T8.2 真实 recompose 接线：平台提供 agentPresets.recompose 才尝试；目标 preset id 按线映射
        recompose: agentPresets?.recompose
          ? async (line) => {
              try {
                const r = await agentPresets!.recompose!(invocation.agent, presetIdForLine(line));
                // 平台返回 {ok:false} 形状（如目标 preset 未安装）→ 明确受限
                if (r !== null && typeof r === 'object' && (r as { ok?: unknown }).ok === false) {
                  const detail = (r as { detail?: unknown }).detail;
                  return { ok: false, detail: detail === undefined ? 'recompose 返回失败' : String(detail) };
                }
                return { ok: true, detail: `已重链到 preset ${presetIdForLine(line)}` };
              } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                return {
                  ok: false,
                  detail: `preset recompose 不可用（${detail}）——平台限制文档化：当前无 ${presetIdForLine(line)} 预设，降级为会话内版本线状态`,
                };
              }
            }
          : undefined,
        onSwitch: async (line) => {
          current = line;
        },
      });
    },
  });

  // T8.2：/bench 命令——触发冻结基准集运行（supervisor/bench.ts runBench；当前版本线）。
  // T8.18：真实执行器接线——modelAdapter（T8.12 装配，需真实 DSH 会话）存在 → 真实 DSH 执行
  //（三线真实分化）；无真实会话 → 降级回放执行器（数字可复现，平台限制文档化）。
  ctx.commands?.register?.({
    name: 'bench',
    description: '运行冻结基准集（当前版本线；真实 DSH 执行或回放降级）',
    recordInput: true,
    handler: async () => {
      try {
        const tasks = await loadBenchTasks();
        const line = current as BenchLine;
        const executor = modelAdapter !== undefined ? makeRealExecutor(modelAdapter) : makeReplayExecutor();
        // 明细落盘（workspace/.omb/bench/<mode>-<line>-<ts>.jsonl）：逐任务输入/输出/验证结果/
        // 失败原因，真实与回放分开记录（T8.18 三线真实分化归因）；mode 仅标记不改变判定。
        const report = await runBench({
          tasks,
          line,
          executor,
          mode: modelAdapter !== undefined ? 'real' : 'replay',
          persistDir: config.benchPersistDir ?? BENCH_REPORTS_DIR,
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

  return { cognitive };
}
